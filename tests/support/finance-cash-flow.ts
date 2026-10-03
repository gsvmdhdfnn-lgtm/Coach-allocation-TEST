/**
 * Test-suite copy of the canonical finance/finance-cash-flow.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Cash Position / Cash Flow forecast - PURE (Finance Foundation F17; see
 * TEST-ENV.md "Finance Foundation - F17"). No HTTP, Airtable, Supabase or
 * Deno code: the Finance orchestrator and the Needs Attention cash-risk rule
 * (ATT-054) both normalise their loaded rows into the inputs below and call
 * buildCashFlow(), so the same truth gives the same timeline everywhere.
 *
 * Answers: what is expected to hit the bank, when, and what is the projected
 * balance after each movement - ONE timeline; Money In / Money Out are only
 * filters of it. It is derived on every read from existing Finance truth:
 * never a second ledger, never stored, never a reconciliation.
 *
 * Locked rules (F17 audit decisions):
 *   - Starting point: the latest Management-entered bank balance (latest
 *     as-at date, then latest entry). It is "Management-entered", never
 *     "bank verified". Actual cash facts dated AFTER its as-at date are
 *     applied; anything on / before it is assumed to be in that balance.
 *   - Cash dates, never profitability dates: F7 due dates, F13 instalment
 *     due dates, F15 expected pay dates, F12 expected payment dates.
 *   - States: Actual (recorded paid / received after the balance date),
 *     Confirmed (amount + date known), Estimated (amount still an estimate),
 *     Overdue (date passed, no actual fact). An estimate that is overdue is
 *     Overdue with amountIsEstimate = true.
 *   - Overdue OUT is still owed: it stays visible with its real due date and
 *     days overdue, and counts as a requirement TODAY in the projection.
 *     Overdue IN has not arrived: visible + totalled, never in the balance.
 *     No source date is ever rewritten.
 *   - Supplier credit (F14) and client credit (F7) are never cash: they only
 *     reduce what is still owed. Partial payments leave only the remainder.
 *   - Coach Months (F12, no Paid lifecycle): finalised + payment date today or
 *     later = Confirmed OUT; open month + future payment date = Estimated OUT
 *     (live allocation cost, may change until finalised); payment date passed
 *     = "Payment not tracked" - visible, never Overdue, never projected.
 *   - Not included (documented, never guessed): Stripe (no bank payout
 *     timing), pre-invoice expected revenue (no cash date), invoices awaiting
 *     issue in Xero (no due date), F11 Refund Due (no cash date until F21),
 *     VAT / PAYE liabilities (no structured source).
 *   - Ordering: cash date, OUT before IN (the cautious same-day low), source
 *     type, source id, key - never storage order. On TODAY only, Actual
 *     movements (already happened, already in today's position) come first,
 *     then today's forecasts in that same order (D1, approved 2026-10-02).
 *     No date is rewritten and no Actual moves to another date.
 */
import { MAX_MINOR, formatMinor, parseMoney } from "./finance-money.ts";
import { type CostWorld, type Correction, type FinanceMonth, type WorkItem, F as COST_FIELDS, addMonths, expectedPaymentDate, monthBounds, monthOf as costMonthOf, monthsBetween as costMonthsBetween, workItemsOf, workersOf } from "./finance-coach-costs.ts";
import { type EmploymentItem, type EmploymentVersion, asInstalment, chainOf, monthLine, monthOf, monthsBetween } from "./finance-overheads.ts";
import { type Instalment, type Payment as SupplierPayment, type Supplier, remainingOf, stateOf } from "./finance-suppliers.ts";

export const CASH_FLOW_CONTRACT = "finance-cash-flow-v1";
export const BALANCE_ENTITY = "finance_bank_balance";
export const BALANCE_EVENT = "finance_bank_balance.recorded";
export const BALANCE_ID_PATTERN = /^FBB-[0-9A-F]{12}$/;
export const BALANCE_LABEL = "Management-entered bank balance";
export const BALANCE_VERIFICATION = "Entered by Management - not bank verified and not reconciled";
export const NOTE_MAX = 500;
/** Payment-not-tracked coach months are listed when their expected payment date is within this many calendar months before today. */
export const NOT_TRACKED_LOOKBACK_MONTHS = 3;
export const RANGES = ["30d", "3m"] as const;
export type CashRange = (typeof RANGES)[number];
export const VIEWS = ["position", "money-in", "money-out"] as const;
export type CashView = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<CashView, string> = { position: "Cash Position", "money-in": "Money In", "money-out": "Money Out" };

export type Direction = "in" | "out";
export type CashState = "actual" | "confirmed" | "estimated" | "overdue";
export const STATE_LABELS: Record<CashState, string> = { actual: "Actual", confirmed: "Confirmed", estimated: "Estimated", overdue: "Overdue" };
export const SOURCE_TYPES = ["receivable", "client_receipt", "supplier_instalment", "supplier_payment", "employment_cost", "employment_payment", "coach_month"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_LABELS: Record<SourceType, string> = {
  receivable: "Client invoice",
  client_receipt: "Client payment received",
  supplier_instalment: "Supplier / venue payment",
  supplier_payment: "Supplier / venue payment made",
  employment_cost: "Employment cost",
  employment_payment: "Employment cost paid",
  coach_month: "Coach Month",
};

export const NOT_INCLUDED = {
  stripe: { label: "Stripe forecast: Not included", reason: "Stripe bank payout timing is not currently available." },
  preInvoiceRevenue: { label: "Expected revenue before invoicing: Not included", reason: "No billing schedule gives an invoice or cash date before an invoice is issued, so no truthful cash date exists." },
  awaitingIssue: { label: "Invoices awaiting issue in Xero: Not included", reason: "They have no due date until they are genuinely issued." },
  noDueDate: { label: "Invoices without a due date: Not included", reason: "No due date is recorded, so no cash date can be used." },
  refundDue: { label: "Parent card refunds (F11 / F21): Not in the bank projection", reason: "A card refund is paid from the Stripe balance and reaches the bank through Stripe payouts, whose timing is not integrated yet. Refund Due, pending and succeeded Stripe refunds are shown for information only and never change the projected bank balance." },
  taxLiabilities: { label: "VAT / PAYE liabilities: Not included", reason: "No structured liability with an amount and payment date exists. Employer NI / PAYE estimates entered on an employment cost are inside that month's employment cost on its pay date - not the real HMRC payment date." },
  clientCredit: { label: "Client credit", reason: "Client credit is not cash: it only reduces what an invoice still owes." },
  supplierCredit: { label: "Supplier credit", reason: "Supplier credit is not cash: it only reduces what is still owed on an instalment; it never creates money in." },
} as const;
export const COACH_NOT_TRACKED_EXPLANATION =
  "F12 does not currently track whether a Coach Month was paid. After its expected payment date Cash Flow cannot know whether the cash has left the bank, so it is shown here and left out of the projection - it is not Overdue.";

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** The same day-of-month `n` calendar months later; a shorter month uses its last day (31 Jan + 1 = 28/29 Feb). */
export function addCalendarMonths(d: string, n: number): string {
  const target = addMonths(d.slice(0, 7), n);
  const last = Number(monthBounds(target).to.slice(8, 10));
  return `${target}-${String(Math.min(Number(d.slice(8, 10)), last)).padStart(2, "0")}`;
}
/**
 * The forward range, organisation-local and inclusive:
 *   30d: today .. today + 29 calendar days (30 days);
 *   3m:  today .. the day BEFORE the corresponding date three calendar months later
 *        (2026-10-02 -> 2027-01-01; 2026-11-30 -> 2027-02-27).
 */
export function rangeEnd(today: string, range: CashRange): string {
  return range === "30d" ? addDays(today, 29) : addDays(addCalendarMonths(today, 3), -1);
}

// ---------------------------------------------------------------------
// Bank balance (Management-entered, append-only history)
// ---------------------------------------------------------------------
export interface BankBalance {
  organisationId: string;
  balanceId: string;
  sequence: number;
  amountMinor: number;
  asAtDate: string;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
}
/** The projection starting point: latest as-at date, then the latest entry (highest sequence). Never storage order. */
export function latestBalance(balances: readonly BankBalance[]): BankBalance | null {
  let best: BankBalance | null = null;
  for (const b of balances) if (!best || b.asAtDate > best.asAtDate || (b.asAtDate === best.asAtDate && b.sequence > best.sequence)) best = b;
  return best;
}
export function balanceView(b: BankBalance, latest: BankBalance | null) {
  return {
    balanceId: b.balanceId,
    sequence: b.sequence,
    amount: formatMinor(b.amountMinor),
    asAtDate: b.asAtDate,
    note: b.note,
    recordedAt: b.recordedAt,
    recordedBy: b.recordedBy,
    label: BALANCE_LABEL,
    verification: BALANCE_VERIFICATION,
    isProjectionStart: latest !== null && latest.balanceId === b.balanceId,
  };
}
export function newBalanceId(random: () => string = () => crypto.randomUUID()): string {
  return `FBB-${random().replace(/[^0-9a-f]/gi, "").slice(0, 12).toUpperCase()}`;
}
export interface BalanceRequest {
  amountMinor: number;
  asAtDate: string;
  note: string | null;
}
export type Refusal = { ok: false; httpStatus: 400 | 404 | 409; code: string; error: string };
/** The next history row; the as-at date may not be after the organisation's today. The database re-checks the sequence (append-only, one latest). */
export function planBalance(input: { req: BalanceRequest; history: readonly BankBalance[]; today: string; organisationId: string; balanceId: string; actorUserId: string; at: string }): { ok: true; balance: BankBalance; previous: BankBalance | null } | Refusal {
  const { req } = input;
  if (req.asAtDate > input.today) return { ok: false, httpStatus: 409, code: "as_at_in_future", error: `The as-at date cannot be after today (${input.today}) - record what the bank shows now` };
  const maxSeq = input.history.reduce((a, b) => Math.max(a, b.sequence), 0);
  return {
    ok: true,
    previous: latestBalance(input.history),
    balance: { organisationId: input.organisationId, balanceId: input.balanceId, sequence: maxSeq + 1, amountMinor: req.amountMinor, asAtDate: req.asAtDate, note: req.note, recordedAt: input.at, recordedBy: input.actorUserId },
  };
}
export function balanceAuditEvent(b: BankBalance, previous: BankBalance | null) {
  return {
    organisation_id: b.organisationId,
    actor_user_id: b.recordedBy,
    event_type: BALANCE_EVENT,
    entity_type: BALANCE_ENTITY,
    record_id: b.balanceId,
    before: previous ? { balanceId: previous.balanceId, sequence: previous.sequence, amountMinor: previous.amountMinor, asAtDate: previous.asAtDate } : null,
    after: { balanceId: b.balanceId, sequence: b.sequence, amountMinor: b.amountMinor, asAtDate: b.asAtDate, note: b.note, label: BALANCE_LABEL },
    reason: b.note,
    context: { source: "finance-api", route: "POST /cash-flow/balance", contract: CASH_FLOW_CONTRACT },
  };
}

// ---------------------------------------------------------------------
// Inputs (each side normalises its own rows into these)
// ---------------------------------------------------------------------
/** An issued invoice's F7 receivable (receivableOf) - outstanding already nets credit notes, client credit applied and cash received. */
export interface ReceivableInput {
  invoiceId: string;
  clientId: string;
  clientName: string;
  officialNumber: string | null;
  grossMinor: number;
  outstandingMinor: number;
  cashReceivedMinor: number;
  creditAppliedMinor: number;
  creditNotesMinor: number;
  dueDate: string | null;
  originalDueDate: string | null;
}
/** Minimal F7 shapes the receipt rule needs (structural: F7's own and Needs Attention's copies both fit). */
export interface ReceiptPayment {
  paymentId: string;
  invoiceId: string;
  clientId: string;
  clientName: string;
  amountMinor: number;
  receivedDate: string;
  recordedAt: string;
}
export interface ReceiptReversal {
  paymentId: string;
}
export interface ReceiptCredit {
  creditId: string;
  clientId: string;
  clientName: string;
  source: string;
  status: string;
  sourceInvoiceId: string;
  receivedDate: string | null;
  originalMinor: number;
  createdAt: string;
}
export interface CashReceipt {
  kind: "invoice_payment" | "overpayment_credit";
  receiptId: string;
  invoiceId: string;
  clientId: string;
  clientName: string;
  amountMinor: number;
  receivedDate: string;
}
/** Trusted cash receipts (F7's rule): every active (not reversed) payment, plus cash kept as client credit from an overpayment (not void). Credit notes and credit applied are never receipts. */
export function cashReceipts(payments: readonly ReceiptPayment[], reversals: readonly ReceiptReversal[], credits: readonly ReceiptCredit[]): CashReceipt[] {
  const reversed = new Set(reversals.map((r) => r.paymentId));
  const out: CashReceipt[] = [];
  for (const p of payments) if (!reversed.has(p.paymentId)) out.push({ kind: "invoice_payment", receiptId: p.paymentId, invoiceId: p.invoiceId, clientId: p.clientId, clientName: p.clientName, amountMinor: p.amountMinor, receivedDate: p.receivedDate });
  for (const c of credits) {
    if (c.source !== "overpayment" || c.status === "void" || !c.receivedDate) continue;
    out.push({ kind: "overpayment_credit", receiptId: c.creditId, invoiceId: c.sourceInvoiceId, clientId: c.clientId, clientName: c.clientName, amountMinor: c.originalMinor, receivedDate: c.receivedDate });
  }
  return out;
}

/** One coach's Finance Coach Month or open (live) month, already reduced to what Cash Flow needs. */
export interface CoachMonthInput {
  workerRecordId: string;
  workerRef: string | null;
  workerName: string;
  workMonth: string;
  /** FCM- id once finalised; null while the month is open. */
  monthId: string | null;
  finalised: boolean;
  amountMinor: number;
  /** Open months: live items with no usable cost yet (the estimate may rise). */
  unpricedItems: number;
  itemCount: number;
  /** Null when the Coach payment day is not configured (open months only). */
  expectedPaymentDate: string | null;
}

export interface CashFlowInputs {
  organisationId: string;
  today: string;
  range: CashRange;
  balance: BankBalance | null;
  thresholdMinor: number | null;
  receivables: readonly ReceivableInput[];
  receipts: readonly CashReceipt[];
  awaitingIssue: { count: number; grossMinor: number };
  suppliers: readonly Pick<Supplier, "supplierId" | "name" | "supplierType">[];
  instalments: readonly Instalment[];
  supplierPayments: readonly SupplierPayment[];
  employmentVersions: readonly EmploymentVersion[];
  employmentItems: readonly EmploymentItem[];
  coachMonths: readonly CoachMonthInput[];
  coachPaymentDayConfigured: boolean;
}

// ---------------------------------------------------------------------
// Coach Months (F12): finalised months + open months, same code everywhere
// ---------------------------------------------------------------------
/** Work months whose payment month can fall in [today - lookback, range end]: payment is in the month after the work. */
export function coachWorkMonths(today: string, end: string): string[] {
  return costMonthsBetween(addMonths(costMonthOf(today), -(NOT_TRACKED_LOOKBACK_MONTHS + 1)), addMonths(costMonthOf(end), -1));
}
/**
 * Every coach month Cash Flow considers: stored Finance Coach Months
 * (finalised total + corrections) and, for work months without one, the open
 * month's live allocation cost (F12's own workItemsOf - frozen allocation
 * values only). `world` must cover the work months' dates.
 */
export function coachMonthInputs(world: CostWorld, ledger: { months: readonly FinanceMonth[]; corrections: readonly Correction[] }, workMonths: readonly string[], today: string, paymentDay: number | null): CoachMonthInput[] {
  const out: CoachMonthInput[] = [];
  const workers = workersOf(world.workers);
  const byRecord = new Map(workers.map((w) => [w.recordId, w]));
  for (const fm of ledger.months) {
    const corrections = ledger.corrections.filter((c) => c.monthId === fm.monthId).reduce((a, c) => a + c.amountMinor, 0);
    const w = byRecord.get(fm.workerRecordId);
    out.push({
      workerRecordId: fm.workerRecordId,
      workerRef: fm.workerRef || w?.ref || null,
      workerName: fm.workerName ?? w?.name ?? fm.workerRef,
      workMonth: fm.workMonth,
      monthId: fm.monthId,
      finalised: true,
      amountMinor: fm.finalisedTotalMinor + corrections,
      unpricedItems: 0,
      itemCount: fm.itemCount,
      expectedPaymentDate: fm.expectedPaymentDate,
    });
  }
  const finalised = new Set(ledger.months.map((fm) => `${fm.workerRecordId}|${fm.workMonth}`));
  const linked = new Set<string>();
  for (const a of world.allocations) for (const id of Array.isArray(a.fields[COST_FIELDS.allocation.worker]) ? a.fields[COST_FIELDS.allocation.worker] : []) if (typeof id === "string") linked.add(id);
  for (const w of workers.filter((x) => linked.has(x.recordId)).sort((x, y) => (x.recordId < y.recordId ? -1 : 1))) {
    for (const month of workMonths) {
      if (finalised.has(`${w.recordId}|${month}`)) continue;
      const b = monthBounds(month);
      const items: WorkItem[] = workItemsOf(world, w.recordId, b.from, b.to, today);
      if (!items.length) continue;
      const pay = expectedPaymentDate(month, paymentDay);
      out.push({
        workerRecordId: w.recordId,
        workerRef: w.ref || null,
        workerName: w.name,
        workMonth: month,
        monthId: null,
        finalised: false,
        amountMinor: items.reduce((a, i) => a + (i.finalCostMinor ?? 0), 0),
        unpricedItems: items.filter((i) => i.finalCostMinor === null).length,
        itemCount: items.length,
        expectedPaymentDate: pay.ok ? pay.date : null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// The canonical timeline
// ---------------------------------------------------------------------
export interface CashEvent {
  key: string;
  direction: Direction;
  sourceType: SourceType;
  sourceId: string;
  label: string;
  counterparty: string;
  state: CashState;
  amountIsEstimate: boolean;
  amountMinor: number;
  /** The date the projection uses (overdue OUT: today). */
  cashDate: string;
  /** The source's own real date (never rewritten). */
  dueDate: string;
  originalDueDate: string | null;
  daysOverdue: number | null;
  included: boolean;
  notIncludedReason: string | null;
  balanceAfterMinor: number | null;
  api: string | null;
  destination: { route: string; params: Record<string, string> } | null;
  context: Record<string, unknown>;
}
export interface NotTrackedCoachMonth {
  workerRecordId: string;
  workerRef: string | null;
  coach: string;
  workMonth: string;
  monthId: string | null;
  finalised: boolean;
  amountMinor: number;
  expectedPaymentDate: string;
  api: string | null;
}
export interface CashFlow {
  organisationId: string;
  today: string;
  range: CashRange;
  rangeStart: string;
  rangeEnd: string;
  balance: BankBalance | null;
  balanceTodayMinor: number | null;
  projectedEndMinor: number | null;
  projectedLowMinor: number | null;
  projectedLowDate: string | null;
  thresholdMinor: number | null;
  thresholdBreached: boolean | null;
  firstBreachDate: string | null;
  events: CashEvent[];
  paymentNotTracked: NotTrackedCoachMonth[];
  notTrackedOlder: number;
  awaitingIssue: { count: number; grossMinor: number };
  noDueDate: { count: number; outstandingMinor: number };
  coachPaymentDayMissing: number;
}

const DIR_ORDER: Record<Direction, number> = { out: 0, in: 1 };
type Ordered = Pick<CashEvent, "cashDate" | "direction" | "sourceType" | "sourceId" | "key"> & { state?: CashState };
/**
 * Cash date, then OUT before IN, then source type, source id, key - total and deterministic.
 * With `today`: on that date only, Actual movements sort before every forecast (D1).
 */
export function compareEvents(a: Ordered, b: Ordered, today?: string): number {
  if (a.cashDate !== b.cashDate) return a.cashDate < b.cashDate ? -1 : 1;
  if (today !== undefined && a.cashDate === today && (a.state === "actual") !== (b.state === "actual")) return a.state === "actual" ? -1 : 1;
  if (a.direction !== b.direction) return DIR_ORDER[a.direction] - DIR_ORDER[b.direction];
  if (a.sourceType !== b.sourceType) return a.sourceType < b.sourceType ? -1 : 1;
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export class CashFlowDataError extends Error {}
const bad = (what: string): never => {
  throw new CashFlowDataError(what);
};
const minorOk = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= MAX_MINOR;

/**
 * Build the one timeline. Throws CashFlowDataError on data that does not add
 * up (never guesses). Events beyond the range end are not listed; overdue
 * items are listed whatever their date.
 */
export function buildCashFlow(x: CashFlowInputs): CashFlow {
  const today = x.today;
  const end = rangeEnd(today, x.range);
  const asAt = x.balance?.asAtDate ?? null;
  const events: CashEvent[] = [];
  const keys = new Set<string>();
  const push = (e: CashEvent) => {
    if (keys.has(e.key)) bad(`duplicate cash event ${e.key}`);
    if (!minorOk(e.amountMinor) || e.amountMinor <= 0) bad(`cash event ${e.key} has an invalid amount`);
    keys.add(e.key);
    events.push(e);
  };
  /** A forecast (not yet paid / received) item: overdue / confirmed / estimated; null when it is beyond the range. */
  const forecast = (direction: Direction, dueDate: string, estimated: boolean): Pick<CashEvent, "state" | "cashDate" | "daysOverdue" | "included" | "notIncludedReason"> | null => {
    if (dueDate < today) {
      const daysOverdue = daysBetween(dueDate, today);
      return direction === "out"
        ? { state: "overdue", cashDate: today, daysOverdue, included: true, notIncludedReason: null }
        : { state: "overdue", cashDate: dueDate, daysOverdue, included: false, notIncludedReason: "Overdue incoming money has not arrived - it is never counted as available cash" };
    }
    if (dueDate > end) return null;
    return { state: estimated ? "estimated" : "confirmed", cashDate: dueDate, daysOverdue: null, included: true, notIncludedReason: null };
  };
  const actual = (date: string) => asAt !== null && date > asAt;

  // ----- Money In: F7 issued receivables (outstanding only) -----
  let noDueCount = 0;
  let noDueMinor = 0;
  for (const r of x.receivables) {
    if (!minorOk(r.outstandingMinor) || r.outstandingMinor < 0) bad(`receivable ${r.invoiceId} has an invalid outstanding amount`);
    if (r.outstandingMinor === 0) continue; // fully received / credited: nothing further expected
    if (!r.dueDate || !isDate(r.dueDate)) {
      noDueCount++;
      noDueMinor += r.outstandingMinor;
      continue;
    }
    const f = forecast("in", r.dueDate, false);
    if (!f) continue;
    push({
      key: `in:receivable:${r.invoiceId}`,
      direction: "in",
      sourceType: "receivable",
      sourceId: r.invoiceId,
      label: `Invoice ${r.officialNumber ?? r.invoiceId}`,
      counterparty: r.clientName,
      amountIsEstimate: false,
      amountMinor: r.outstandingMinor,
      dueDate: r.dueDate,
      originalDueDate: r.originalDueDate,
      balanceAfterMinor: null,
      api: `GET /finance/invoices/${r.invoiceId}/receivable`,
      destination: { route: "finance/invoice", params: { invoiceId: r.invoiceId, clientId: r.clientId } },
      context: {
        clientId: r.clientId,
        officialNumber: r.officialNumber,
        gross: formatMinor(r.grossMinor),
        cashReceived: formatMinor(r.cashReceivedMinor),
        clientCreditApplied: formatMinor(r.creditAppliedMinor),
        creditNotes: formatMinor(r.creditNotesMinor),
        outstanding: formatMinor(r.outstandingMinor),
        dueDateMoved: r.originalDueDate !== null && r.originalDueDate !== r.dueDate,
      },
      ...f,
    });
  }
  // ----- Money In: actual receipts after the balance date -----
  for (const rc of x.receipts) {
    if (!isDate(rc.receivedDate)) bad(`receipt ${rc.receiptId} has an invalid date`);
    if (!actual(rc.receivedDate)) continue;
    push({
      key: `in:client_receipt:${rc.receiptId}`,
      direction: "in",
      sourceType: "client_receipt",
      sourceId: rc.receiptId,
      label: rc.kind === "invoice_payment" ? `Payment received for ${rc.invoiceId}` : `Overpayment kept as client credit (${rc.invoiceId})`,
      counterparty: rc.clientName,
      state: "actual",
      amountIsEstimate: false,
      amountMinor: rc.amountMinor,
      cashDate: rc.receivedDate,
      dueDate: rc.receivedDate,
      originalDueDate: null,
      daysOverdue: null,
      included: true,
      notIncludedReason: null,
      balanceAfterMinor: null,
      api: `GET /finance/invoices/${rc.invoiceId}/payments`,
      destination: { route: "finance/invoice", params: { invoiceId: rc.invoiceId, clientId: rc.clientId } },
      context: { kind: rc.kind, invoiceId: rc.invoiceId, clientId: rc.clientId, note: rc.kind === "overpayment_credit" ? "Cash received beyond the invoice and kept as client credit - the cash arrived; the credit itself is not cash" : null },
    });
  }

  // ----- Money Out: F13 / F14 supplier instalments (remaining = due - cash paid - credit applied) -----
  const supplierById = new Map(x.suppliers.map((s) => [s.supplierId, s]));
  for (const i of x.instalments) {
    if (i.cancelledAt) continue;
    if (!isDate(i.dueDate)) bad(`instalment ${i.instalmentId} has an invalid due date`);
    const remaining = remainingOf(i);
    if (remaining < 0) bad(`instalment ${i.instalmentId} has paid / credited more than is due`);
    if (remaining === 0) continue;
    const s = supplierById.get(i.supplierId) ?? bad(`instalment ${i.instalmentId} has an unknown supplier`);
    const estimated = i.amountState === "estimated";
    const f = forecast("out", i.dueDate, estimated);
    if (!f) continue;
    push({
      key: `out:supplier_instalment:${i.instalmentId}`,
      direction: "out",
      sourceType: "supplier_instalment",
      sourceId: i.instalmentId,
      label: `${s.name} payment`,
      counterparty: s.name,
      amountIsEstimate: estimated,
      amountMinor: remaining,
      dueDate: i.dueDate,
      originalDueDate: i.originalDueDate,
      balanceAfterMinor: null,
      api: `GET /finance/supplier-instalments/${i.instalmentId}`,
      destination: { route: "finance/supplier-instalment", params: { instalmentId: i.instalmentId, supplierId: i.supplierId, agreementId: i.agreementId } },
      context: {
        supplierId: i.supplierId,
        supplierType: s.supplierType,
        agreementId: i.agreementId,
        instalmentState: stateOf(i),
        amountDue: formatMinor(i.amountDueMinor),
        cashPaid: formatMinor(i.paidMinor),
        supplierCreditApplied: formatMinor(i.creditedMinor),
        remaining: formatMinor(remaining),
        dueDateMoved: i.dueDate !== i.originalDueDate,
      },
      ...f,
    });
  }
  for (const p of x.supplierPayments) {
    if (!isDate(p.paidDate)) bad(`supplier payment ${p.paymentId} has an invalid date`);
    if (!actual(p.paidDate)) continue;
    const s = supplierById.get(p.supplierId) ?? bad(`supplier payment ${p.paymentId} has an unknown supplier`);
    push({
      key: `out:supplier_payment:${p.paymentId}`,
      direction: "out",
      sourceType: "supplier_payment",
      sourceId: p.paymentId,
      label: `${s.name} payment made`,
      counterparty: s.name,
      state: "actual",
      amountIsEstimate: false,
      amountMinor: p.amountMinor,
      cashDate: p.paidDate,
      dueDate: p.paidDate,
      originalDueDate: null,
      daysOverdue: null,
      included: true,
      notIncludedReason: null,
      balanceAfterMinor: null,
      api: `GET /finance/supplier-instalments/${p.instalmentId}`,
      destination: { route: "finance/supplier-instalment", params: { instalmentId: p.instalmentId, supplierId: p.supplierId, agreementId: p.agreementId } },
      context: { instalmentId: p.instalmentId, supplierId: p.supplierId, note: "Management-recorded payment (not bank verified)" },
    });
  }

  // ----- Money Out: F15 employment months (estimate -> confirmed -> paid, one event per month) -----
  const employmentIds = [...new Set(x.employmentVersions.map((v) => v.employmentId))].sort();
  const lastMonth = monthOf(end);
  for (const employmentId of employmentIds) {
    const chain = chainOf(x.employmentVersions as EmploymentVersion[], employmentId);
    const firstMonth = monthOf(chain.map((v) => v.startDate).sort()[0]);
    const itemMonths = x.employmentItems.filter((it) => it.employmentId === employmentId).map((it) => it.month);
    const last = [lastMonth, ...itemMonths].sort().pop() as string;
    if (firstMonth > last) continue;
    for (const month of monthsBetween(firstMonth, last)) {
      const l = monthLine(chain, x.employmentItems as EmploymentItem[], month);
      if (!l) continue;
      const inst = asInstalment(x.organisationId, l);
      const remaining = remainingOf(inst);
      if (remaining < 0) bad(`employment ${employmentId} ${month} paid more than is due`);
      const name = l.version.personName;
      const api = `GET /finance/employment-costs/${employmentId}?from=${month}&to=${month}`;
      const destination = { route: "finance/employment-cost", params: { employmentId, month } };
      if (l.item && l.item.paidMinor > 0 && l.item.paidDate && actual(l.item.paidDate)) {
        push({
          key: `out:employment_payment:${l.item.itemId}`,
          direction: "out",
          sourceType: "employment_payment",
          sourceId: l.item.itemId,
          label: `${name} - ${month} employment cost paid`,
          counterparty: name,
          state: "actual",
          amountIsEstimate: false,
          amountMinor: l.item.paidMinor,
          cashDate: l.item.paidDate,
          dueDate: l.item.paidDate,
          originalDueDate: null,
          daysOverdue: null,
          included: true,
          notIncludedReason: null,
          balanceAfterMinor: null,
          api,
          destination,
          context: { employmentId, month, itemId: l.item.itemId, note: "Management-recorded payment (not bank verified)" },
        });
      }
      if (remaining === 0) continue;
      const estimated = inst.amountState === "estimated";
      const f = forecast("out", l.expectedPaymentDate, estimated);
      if (!f) continue;
      push({
        key: `out:employment_cost:${employmentId}|month:${month}`,
        direction: "out",
        sourceType: "employment_cost",
        sourceId: `${employmentId}|${month}`,
        label: `${name} - ${month} employment cost`,
        counterparty: name,
        amountIsEstimate: estimated,
        amountMinor: remaining,
        dueDate: l.expectedPaymentDate,
        originalDueDate: l.expectedPaymentDate,
        balanceAfterMinor: null,
        api,
        destination,
        context: {
          employmentId,
          month,
          itemId: l.item?.itemId ?? null,
          employmentState: stateOf(inst),
          partMonth: l.partMonth,
          niPayeEstimateIncluded: formatMinor(l.niPayeEstimateMinor),
          note: "Employer NI / PAYE estimates are inside this month's cost on its pay date - not the real HMRC payment date",
        },
        ...f,
      });
    }
  }

  // ----- Money Out: F12 Coach Months (no Paid lifecycle) -----
  const lookbackStart = addCalendarMonths(today, -NOT_TRACKED_LOOKBACK_MONTHS);
  const paymentNotTracked: NotTrackedCoachMonth[] = [];
  let notTrackedOlder = 0;
  let coachPaymentDayMissing = 0;
  for (const c of x.coachMonths) {
    if (!minorOk(c.amountMinor) || c.amountMinor < 0) bad(`coach month ${c.monthId ?? `${c.workerRecordId} ${c.workMonth}`} has an invalid amount`);
    if (c.amountMinor === 0) continue; // Salaried / Volunteer work only, or nothing priced yet - no cash movement
    if (c.expectedPaymentDate === null) {
      coachPaymentDayMissing++;
      continue;
    }
    if (!isDate(c.expectedPaymentDate)) bad(`coach month ${c.monthId ?? c.workMonth} has an invalid payment date`);
    const api = c.monthId ? `GET /finance/coach-summaries/${c.monthId}` : c.workerRef ? `GET /finance/coach-costs/${c.workerRef}/${c.workMonth}` : null;
    if (c.expectedPaymentDate < today) {
      if (c.expectedPaymentDate < lookbackStart) {
        notTrackedOlder++;
        continue;
      }
      paymentNotTracked.push({ workerRecordId: c.workerRecordId, workerRef: c.workerRef, coach: c.workerName, workMonth: c.workMonth, monthId: c.monthId, finalised: c.finalised, amountMinor: c.amountMinor, expectedPaymentDate: c.expectedPaymentDate, api });
      continue;
    }
    if (c.expectedPaymentDate > end) continue;
    push({
      key: `out:coach_month:${c.workerRecordId}|month:${c.workMonth}`,
      direction: "out",
      sourceType: "coach_month",
      sourceId: c.monthId ?? `${c.workerRef ?? c.workerRecordId}|${c.workMonth}`,
      label: `${c.workerName} - ${c.workMonth} coach costs`,
      counterparty: c.workerName,
      state: c.finalised ? "confirmed" : "estimated",
      amountIsEstimate: !c.finalised,
      amountMinor: c.amountMinor,
      cashDate: c.expectedPaymentDate,
      dueDate: c.expectedPaymentDate,
      originalDueDate: c.expectedPaymentDate,
      daysOverdue: null,
      included: true,
      notIncludedReason: null,
      balanceAfterMinor: null,
      api,
      destination: c.monthId ? { route: "finance/coach-month", params: { monthId: c.monthId } } : c.workerRef ? { route: "finance/coach-costs", params: { coachId: c.workerRef, month: c.workMonth } } : null,
      context: {
        workMonth: c.workMonth,
        monthId: c.monthId,
        finalised: c.finalised,
        itemCount: c.itemCount,
        unpricedItems: c.unpricedItems,
        note: c.finalised ? "Finalised Coach Month total (with corrections)" : "Open month: live allocation cost - the amount may change until the month is finalised",
      },
    });
  }

  // ----- order once, project once -----
  events.sort((a, b) => compareEvents(a, b, today));
  let running: number | null = x.balance ? x.balance.amountMinor : null;
  for (const e of events) {
    if (running !== null && e.included) running += e.direction === "in" ? e.amountMinor : -e.amountMinor;
    e.balanceAfterMinor = e.included ? running : null;
  }
  let balanceToday: number | null = null;
  let low: number | null = null;
  let lowDate: string | null = null;
  let firstBreach: string | null = null;
  const t = x.thresholdMinor;
  if (x.balance) {
    balanceToday = x.balance.amountMinor + events.filter((e) => e.state === "actual").reduce((a, e) => a + (e.direction === "in" ? e.amountMinor : -e.amountMinor), 0);
    low = balanceToday;
    lowDate = today;
    if (t !== null && balanceToday < t) firstBreach = today;
    for (const e of events) {
      if (!e.included || e.state === "actual") continue;
      const b = e.balanceAfterMinor as number;
      if (b < low) ((low = b), (lowDate = e.cashDate));
      if (t !== null && firstBreach === null && b < t) firstBreach = e.cashDate;
    }
  }
  return {
    organisationId: x.organisationId,
    today,
    range: x.range,
    rangeStart: today,
    rangeEnd: end,
    balance: x.balance,
    balanceTodayMinor: balanceToday,
    projectedEndMinor: running,
    projectedLowMinor: low,
    projectedLowDate: lowDate,
    thresholdMinor: t,
    thresholdBreached: t === null || low === null ? null : low < t,
    firstBreachDate: firstBreach,
    events,
    paymentNotTracked: paymentNotTracked.sort((a, b) => (a.expectedPaymentDate !== b.expectedPaymentDate ? (a.expectedPaymentDate < b.expectedPaymentDate ? -1 : 1) : a.workerRecordId < b.workerRecordId ? -1 : a.workerRecordId > b.workerRecordId ? 1 : a.workMonth < b.workMonth ? -1 : 1)),
    notTrackedOlder,
    awaitingIssue: x.awaitingIssue,
    noDueDate: { count: noDueCount, outstandingMinor: noDueMinor },
    coachPaymentDayMissing,
  };
}

// ---------------------------------------------------------------------
// Totals + views (filters of the ONE timeline)
// ---------------------------------------------------------------------
export interface Totals {
  actualIn: number;
  actualOut: number;
  expectedIn: number;
  expectedOut: number;
  estimatedIn: number;
  estimatedOut: number;
  overdueIn: number;
  overdueOut: number;
  includedIn: number;
  includedOut: number;
  events: number;
}
export function totalsOf(events: readonly CashEvent[]): Totals {
  const t: Totals = { actualIn: 0, actualOut: 0, expectedIn: 0, expectedOut: 0, estimatedIn: 0, estimatedOut: 0, overdueIn: 0, overdueOut: 0, includedIn: 0, includedOut: 0, events: events.length };
  for (const e of events) {
    const inn = e.direction === "in";
    if (e.state === "actual") inn ? (t.actualIn += e.amountMinor) : (t.actualOut += e.amountMinor);
    else if (e.state === "overdue") inn ? (t.overdueIn += e.amountMinor) : (t.overdueOut += e.amountMinor);
    else {
      inn ? (t.expectedIn += e.amountMinor) : (t.expectedOut += e.amountMinor);
      if (e.state === "estimated") inn ? (t.estimatedIn += e.amountMinor) : (t.estimatedOut += e.amountMinor);
    }
    if (e.included) inn ? (t.includedIn += e.amountMinor) : (t.includedOut += e.amountMinor);
  }
  return t;
}
export const viewFilter = (view: CashView) => (e: Pick<CashEvent, "direction">) => view === "position" || (view === "money-in" ? e.direction === "in" : e.direction === "out");

const m = (x: number | null) => (x === null ? null : formatMinor(x));
export function eventView(e: CashEvent) {
  return {
    key: e.key,
    direction: e.direction,
    sourceType: e.sourceType,
    sourceTypeLabel: SOURCE_LABELS[e.sourceType],
    sourceId: e.sourceId,
    label: e.label,
    counterparty: e.counterparty,
    state: e.state,
    stateLabel: e.state === "overdue" && e.amountIsEstimate ? "Overdue (estimated amount)" : STATE_LABELS[e.state],
    amountIsEstimate: e.amountIsEstimate,
    amount: formatMinor(e.amountMinor),
    cashDate: e.cashDate,
    dueDate: e.dueDate,
    originalDueDate: e.originalDueDate,
    daysOverdue: e.daysOverdue,
    includedInProjection: e.included,
    notIncludedReason: e.notIncludedReason,
    projectedBalanceAfter: m(e.balanceAfterMinor),
    source: { type: e.sourceType, id: e.sourceId, api: e.api, destination: e.destination },
    context: e.context,
  };
}
export function totalsView(t: Totals) {
  return {
    actualIn: m(t.actualIn),
    actualOut: m(t.actualOut),
    expectedIn: m(t.expectedIn),
    expectedOut: m(t.expectedOut),
    estimatedIn: m(t.estimatedIn),
    estimatedOut: m(t.estimatedOut),
    overdueIn: m(t.overdueIn),
    overdueOut: m(t.overdueOut),
    includedIn: m(t.includedIn),
    includedOut: m(t.includedOut),
    netIncluded: m(t.includedIn - t.includedOut),
    events: t.events,
  };
}
export function summaryView(cf: CashFlow) {
  const t = cf.thresholdMinor;
  return {
    balanceRecorded: cf.balance !== null,
    currentBalance: cf.balance ? formatMinor(cf.balance.amountMinor) : null,
    balanceAsAt: cf.balance?.asAtDate ?? null,
    balanceLabel: BALANCE_LABEL,
    balanceVerification: BALANCE_VERIFICATION,
    balanceId: cf.balance?.balanceId ?? null,
    balanceToday: m(cf.balanceTodayMinor),
    projectedEndBalance: m(cf.projectedEndMinor),
    projectedLow: m(cf.projectedLowMinor),
    projectedLowDate: cf.projectedLowDate,
    safetyThreshold: m(t),
    thresholdBreached: cf.thresholdBreached,
    firstBreachDate: cf.firstBreachDate,
    belowThresholdBy: t !== null && cf.projectedLowMinor !== null && cf.projectedLowMinor < t ? formatMinor(t - cf.projectedLowMinor) : null,
    headroomAboveThreshold: t !== null && cf.projectedLowMinor !== null && cf.projectedLowMinor >= t ? formatMinor(cf.projectedLowMinor - t) : null,
    message: cf.balance === null ? "Record the current bank balance to see a projected balance" : t === null ? "No cash safety threshold is set - no cash-risk warning is given" : cf.thresholdBreached ? `The projected balance falls below the cash safety threshold on ${cf.firstBreachDate}` : "The projected balance stays at or above the cash safety threshold",
    forecastNote: "A forecast from recorded Finance facts - not a bank guarantee",
  };
}
export function notIncludedView(cf: CashFlow) {
  return {
    stripe: { included: false, ...NOT_INCLUDED.stripe },
    preInvoiceRevenue: { included: false, ...NOT_INCLUDED.preInvoiceRevenue },
    awaitingIssue: { included: false, ...NOT_INCLUDED.awaitingIssue, count: cf.awaitingIssue.count, gross: formatMinor(cf.awaitingIssue.grossMinor) },
    noDueDate: { included: false, ...NOT_INCLUDED.noDueDate, count: cf.noDueDate.count, outstanding: formatMinor(cf.noDueDate.outstandingMinor) },
    refundDue: { included: false, ...NOT_INCLUDED.refundDue },
    taxLiabilities: { included: false, ...NOT_INCLUDED.taxLiabilities },
    clientCredit: { cash: false, ...NOT_INCLUDED.clientCredit },
    supplierCredit: { cash: false, ...NOT_INCLUDED.supplierCredit },
    coachPaymentDayMissing: cf.coachPaymentDayMissing
      ? { included: false, count: cf.coachPaymentDayMissing, reason: "The Coach payment day is not set in Finance Settings, so these open Coach Months have no payment date" }
      : null,
  };
}
export function notTrackedView(cf: CashFlow) {
  return {
    label: "Payment not tracked",
    explanation: COACH_NOT_TRACKED_EXPLANATION,
    affectsProjection: false,
    lookback: `Expected payment dates from ${addCalendarMonths(cf.today, -NOT_TRACKED_LOOKBACK_MONTHS)} to yesterday`,
    olderNotListed: cf.notTrackedOlder,
    total: formatMinor(cf.paymentNotTracked.reduce((a, c) => a + c.amountMinor, 0)),
    months: cf.paymentNotTracked.map((c) => ({
      coach: c.coach,
      coachId: c.workerRef,
      workMonth: c.workMonth,
      monthId: c.monthId,
      finalised: c.finalised,
      amount: formatMinor(c.amountMinor),
      expectedPaymentDate: c.expectedPaymentDate,
      source: { type: "coach_month", id: c.monthId ?? `${c.workerRef ?? c.workerRecordId}|${c.workMonth}`, api: c.api },
    })),
  };
}
/** The read body for one view: the same timeline, filtered; totals reconcile with the other views. */
export function cashFlowView(cf: CashFlow, view: CashView) {
  const keep = viewFilter(view);
  const shown = cf.events.filter(keep);
  const all = totalsOf(cf.events);
  const ins = totalsOf(cf.events.filter(viewFilter("money-in")));
  const outs = totalsOf(cf.events.filter(viewFilter("money-out")));
  return {
    view,
    viewLabel: VIEW_LABELS[view],
    range: cf.range,
    rangeStart: cf.rangeStart,
    rangeEnd: cf.rangeEnd,
    today: cf.today,
    summary: summaryView(cf),
    totals: totalsView(totalsOf(shown)),
    reconciliation: {
      positionEvents: all.events,
      moneyInEvents: ins.events,
      moneyOutEvents: outs.events,
      reconciles: all.events === ins.events + outs.events && all.includedIn === ins.includedIn && all.includedOut === outs.includedOut,
      rule: "Money In and Money Out are filters of the one Cash Position timeline; the projected balance after each event is always the combined balance",
    },
    timeline: shown.map(eventView),
    paymentNotTracked: view === "money-in" ? null : notTrackedView(cf),
    notIncluded: notIncludedView(cf),
    ordering: "Cash date, then money out before money in on the same date (the cautious same-day low), then source type, then source id. Today only: cash that has already moved (Actual) comes first, then today's remaining forecasts in that order",
    overdueRule: "Overdue money out is still owed: it keeps its real due date and counts as needed today. Overdue money in has not arrived: it is shown and totalled but never added to the projected balance.",
  };
}

// ---------------------------------------------------------------------
// Request parsing + routes
// ---------------------------------------------------------------------
export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const TENANT = "The organisation is taken from your profile and cannot be chosen in the request";
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;

export type CashFlowRoute = { name: "cash.read" } | { name: "balance.history" } | { name: "balance.record" };
export type CashFlowMatch = { status: "ok"; route: CashFlowRoute } | { status: "method"; allowed: string[] };
/** F17 owns only cash-flow, cash-flow/balance-history and cash-flow/balance; null for everything else. */
export function matchCashFlowRoute(path: string, method: string): CashFlowMatch | null {
  const table: Record<string, [CashFlowRoute, string]> = {
    "cash-flow": [{ name: "cash.read" }, "GET"],
    "cash-flow/balance-history": [{ name: "balance.history" }, "GET"],
    "cash-flow/balance": [{ name: "balance.record" }, "POST"],
  };
  const hit = table[path];
  if (!hit) return null;
  return method === hit[1] ? { status: "ok", route: hit[0] } : { status: "method", allowed: [hit[1]] };
}
export function parseCashQuery(route: CashFlowRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true; range: CashRange; view: CashView } | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT);
  const allowed = route === "cash.read" ? ["range", "view"] : [];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return invalid("unexpected_query", `Unexpected query parameter(s): ${[...new Set(extra)].join(", ")}`);
  if (keys.length !== new Set(keys).size) return invalid("invalid_query", "Each query parameter may be given once");
  const range = (q.get("range") ?? "30d") as CashRange;
  const view = (q.get("view") ?? "position") as CashView;
  const fields: Record<string, string> = {};
  if (!(RANGES as readonly string[]).includes(range)) fields.range = `must be one of ${RANGES.join(", ")}`;
  if (!(VIEWS as readonly string[]).includes(view)) fields.view = `must be one of ${VIEWS.join(", ")}`;
  if (Object.keys(fields).length) return invalid("invalid_query", "Invalid query", fields);
  return { ok: true, range, view };
}
export function parseBalance(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: BalanceRequest } | Invalid {
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", 'Body must be a JSON object: { amount: "1234.56", asAtDate: "YYYY-MM-DD", note?: "..." }');
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT);
  const extra = keys.filter((k) => !["amount", "asAtDate", "note"].includes(k));
  if (extra.length) return invalid("unexpected_field", `Unexpected field(s): ${extra.join(", ")}`);
  const fields: Record<string, string> = {};
  const money = parseMoney(b.amount);
  if (!money.ok) fields.amount = money.error;
  if (!isDate(b.asAtDate)) fields.asAtDate = "must be a real date YYYY-MM-DD";
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== "string") fields.note = "must be text";
    else {
      const s = b.note.trim();
      if (s.length > NOTE_MAX) fields.note = `must be at most ${NOTE_MAX} characters`;
      else if (CONTROL_RE.test(s)) fields.note = "contains control characters";
      else note = s || null;
    }
  }
  if (Object.keys(fields).length || !money.ok) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, req: { amountMinor: money.minor, asAtDate: b.asAtDate as string, note } };
}
