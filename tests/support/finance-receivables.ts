/**
 * Test-suite copy of the canonical finance/finance-receivables.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance receivables + payments received + client credit - PURE (Finance
 * Foundation F7; see TEST-ENV.md "Finance Foundation - F7"). No HTTP,
 * Airtable, Supabase or Deno code.
 *
 * Boundaries (locked):
 *   - Only a GENUINELY ISSUED invoice (F6 isIssued: never "awaiting external
 *     issue") is a receivable. An awaiting invoice has no due date, is never
 *     due / overdue, takes no payment and no client credit.
 *   - F6 owns the invoice: amounts, dates, lines, credit notes. F7 never
 *     patches an invoice row. Everything receivable is DERIVED from immutable
 *     history records:
 *
 *       outstanding = gross
 *                   - credit notes (F6 corrections of this invoice)
 *                   - client credit applied (value held for the client, not cash)
 *                   - cash received (active payments)
 *                   + credit-note value moved to client credit (so it is never counted twice)
 *
 *     A negative result (a credit note issued after the invoice was already
 *     paid) is never shown as a negative balance: outstanding is 0 and the
 *     difference is "credit excess" - value the client already paid for that
 *     Management may explicitly hold as client credit (or refund later, F11).
 *   - Actual Revenue = trusted cash receipts only: an active manual payment
 *     (Xero later, F9) or cash kept as client credit from an overpayment.
 *     Issuing, due dates, overdue, credit notes and client credit applied are
 *     NEVER cash.
 *   - Payments and credit applications are never edited or deleted: a mistake
 *     is corrected by a reversal record (full amount), and the original stays.
 *   - A due date move is its own record (the invoice keeps its frozen due date
 *     as the original); overdue follows the latest move. Overdue never moves a
 *     date by itself.
 *   - Due / overdue are calendar-day facts in the organisation's time zone,
 *     never elapsed milliseconds.
 *   - No reminders, Needs Attention, Xero / Stripe, Cash Flow, Month Report,
 *     PDF or UI here (F8 / F9 / later).
 */
import { type Minor, MAX_MINOR, formatMinor, parseMoney } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { REASON_MAX, auditEvent } from "./finance-commercial.ts";
import { CLIENT_ID_PATTERN, CORRECTION_ID_PATTERN, INVOICE_ID_PATTERN } from "./finance-invoicing.ts";
import { type CreditNote, type Invoice, CURRENCY, isIssued, publicNumbering } from "./finance-issue.ts";

export const RECEIVABLES_CONTRACT = "finance-receivables-v1";
export const ENTITY_PAYMENT = "finance_payment";
export const ENTITY_CLIENT_CREDIT = "finance_client_credit";
export const ENTITY_INVOICE = "finance_invoice";
export const RECEIVABLE_EVENTS = {
  paymentRecorded: "finance_payment.recorded",
  paymentReversed: "finance_payment.reversed",
  dueDateChanged: "finance_invoice.due_date_changed",
  creditCreated: "finance_client_credit.created",
  creditApplied: "finance_client_credit.applied",
  applicationReversed: "finance_client_credit.application_reversed",
  creditVoided: "finance_client_credit.voided",
} as const;

export const PAYMENT_ID_PATTERN = /^FPY-[0-9A-F]{12}$/;
export const PAYMENT_REVERSAL_ID_PATTERN = /^FPR-[0-9A-F]{12}$/;
export const CLIENT_CREDIT_ID_PATTERN = /^FCC-[0-9A-F]{12}$/;
export const APPLICATION_ID_PATTERN = /^FCA-[0-9A-F]{12}$/;
export const APPLICATION_REVERSAL_ID_PATTERN = /^FAR-[0-9A-F]{12}$/;
export const DUE_CHANGE_ID_PATTERN = /^FDD-[0-9A-F]{12}$/;
export { CLIENT_ID_PATTERN, CORRECTION_ID_PATTERN, INVOICE_ID_PATTERN };
export type ReceivableIdPrefix = "FPY" | "FPR" | "FCC" | "FCA" | "FAR" | "FDD";
export function newReceivableId(prefix: ReceivableIdPrefix, randomHex: string): string {
  return `${prefix}-${randomHex.replace(/[^0-9a-f]/gi, "").slice(0, 12).toUpperCase()}`;
}

export const REFERENCE_MAX = 100;
/** The receipts read covers at most a year (Month Report / Cash Flow read their own months). */
export const RECEIPTS_MAX_DAYS = 366;

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

export const PAYMENT_METHODS = ["bank_transfer", "card", "cheque", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { bank_transfer: "Bank transfer", card: "Card", cheque: "Cheque", cash: "Cash", other: "Other" };
/** Who recorded that the money arrived: Management by hand (F7), or the accounting connection later (F9). */
export const PAYMENT_SOURCES = ["manual", "xero"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
export const PAYMENT_SOURCE_LABELS: Record<PaymentSource, string> = { manual: "Recorded by Management", xero: "Recorded from Xero" };

/** Cash received against one issued invoice. Never edited; a mistake is reversed. */
export interface Payment {
  paymentId: string;
  invoiceId: string;
  clientId: string;
  clientName: string;
  amountMinor: Minor;
  currency: typeof CURRENCY;
  receivedDate: string;
  method: PaymentMethod | null;
  reference: string | null;
  source: PaymentSource;
  externalProvider: string | null;
  externalPaymentId: string | null;
  reason: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Cancels a payment recorded in error (always its full amount). Not a refund - no money moves. */
export interface PaymentReversal {
  reversalId: string;
  paymentId: string;
  invoiceId: string;
  clientId: string;
  amountMinor: Minor;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export const CLIENT_CREDIT_SOURCES = ["credit_note", "overpayment"] as const;
export type ClientCreditSource = (typeof CLIENT_CREDIT_SOURCES)[number];
export const CLIENT_CREDIT_SOURCE_LABELS: Record<ClientCreditSource, string> = {
  credit_note: "Kept from an invoice correction (credit note) the client had already paid",
  overpayment: "Kept from a client overpayment",
};
export const CLIENT_CREDIT_STATUSES = ["available", "used", "void"] as const;
export type ClientCreditStatus = (typeof CLIENT_CREDIT_STATUSES)[number];
export const CLIENT_CREDIT_STATUS_LABELS: Record<ClientCreditStatus, string> = { available: "Available", used: "Used", void: "Void" };

/** Value held for a client to use against a later invoice. Never applied automatically. */
export interface ClientCredit {
  creditId: string;
  clientId: string;
  clientName: string;
  source: ClientCreditSource;
  /** The invoice the value came from (the corrected invoice, or the invoice the overpayment arrived with). */
  sourceInvoiceId: string;
  sourceCreditNoteId: string | null;
  sourcePaymentId: string | null;
  /** Overpayment only: the day the extra cash arrived (= its payment's received date). */
  receivedDate: string | null;
  originalMinor: Minor;
  remainingMinor: Minor;
  currency: typeof CURRENCY;
  status: ClientCreditStatus;
  reason: string;
  voidReason: string | null;
  voidedBy: string | null;
  voidedAt: string | null;
  createdBy: string;
  createdAt: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

/** Client credit used against an issued invoice. Reduces what is owed; NOT cash received. */
export interface CreditApplication {
  applicationId: string;
  creditId: string;
  invoiceId: string;
  clientId: string;
  amountMinor: Minor;
  reason: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Undoes an application (full amount): the credit gets the value back, the invoice owes it again. */
export interface ApplicationReversal {
  reversalId: string;
  applicationId: string;
  creditId: string;
  invoiceId: string;
  clientId: string;
  amountMinor: Minor;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

/** A deliberate due date move. The invoice keeps its frozen due date (the original). */
export interface DueDateChange {
  changeId: string;
  invoiceId: string;
  previousDueDate: string;
  newDueDate: string;
  reason: string;
  changedBy: string;
  changedAt: string;
}

// ---------------------------------------------------------------------
// Calendar days (never elapsed milliseconds)
// ---------------------------------------------------------------------

/** Whole calendar days from `a` to `b` (b - a); both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  if (!isIsoDate(a) || !isIsoDate(b)) throw new Error("daysBetween needs two real dates");
  const ms = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

// ---------------------------------------------------------------------
// Receivable state (derived)
// ---------------------------------------------------------------------

export type Settlement = "unpaid" | "partially_paid" | "paid" | "nothing_due";
export const SETTLEMENT_LABELS: Record<Settlement, string> = { unpaid: "Unpaid", partially_paid: "Partially paid", paid: "Paid", nothing_due: "Nothing due (credited in full)" };
export type DueState = "not_due" | "due_today" | "overdue" | "settled" | "no_due_date";
export const DUE_STATE_LABELS: Record<DueState, string> = { not_due: "Not due yet", due_today: "Due today", overdue: "Overdue", settled: "Settled", no_due_date: "No due date recorded" };
export type ReceivableState = "not_due" | "due_today" | "overdue" | "partially_paid" | "paid" | "nothing_due" | "no_due_date";
export const RECEIVABLE_STATE_LABELS: Record<ReceivableState, string> = { not_due: "Not due", due_today: "Due today", overdue: "Overdue", partially_paid: "Partially paid", paid: "Paid", nothing_due: "Nothing due", no_due_date: "No due date recorded" };

export interface ReceivableHistory {
  notes: readonly CreditNote[];
  payments: readonly Payment[];
  paymentReversals: readonly PaymentReversal[];
  /** Applications of any client credit TO this invoice (+ their reversals). */
  applications: readonly CreditApplication[];
  applicationReversals: readonly ApplicationReversal[];
  /** Client credits whose value came FROM this invoice's credit notes (any status; void ones do not count). */
  creditsFromNotes: readonly ClientCredit[];
  dueChanges: readonly DueDateChange[];
}

export type NotReceivable = { receivable: false; reason: "awaiting_external_issue"; message: string };

export interface Receivable {
  receivable: true;
  invoiceId: string;
  clientId: string;
  grossMinor: Minor;
  creditNotesMinor: Minor;
  creditAppliedMinor: Minor;
  cashReceivedMinor: Minor;
  /** Credit-note value already held as client credit (added back: it no longer reduces THIS invoice). */
  convertedToCreditMinor: Minor;
  outstandingMinor: Minor;
  /** Value this invoice holds beyond what was owed (a credit note after payment) - never a negative balance. */
  creditExcessMinor: Minor;
  settlement: Settlement;
  dueState: DueState;
  state: ReceivableState;
  invoiceDate: string | null;
  dueDate: string | null;
  originalDueDate: string | null;
  dueDateMoved: boolean;
  daysOverdue: number | null;
  daysUntilDue: number | null;
  lastPaymentDate: string | null;
  paymentCount: number;
  asOf: string;
  activePayments: Payment[];
  activeApplications: CreditApplication[];
  reversedPaymentIds: Set<string>;
  reversedApplicationIds: Set<string>;
}

const sum = (xs: readonly { amountMinor: Minor }[]) => xs.reduce((a, x) => a + x.amountMinor, 0);

/** The due-date moves in order, checked as a chain from the invoice's frozen due date. Throws on broken history. */
export function orderedDueChanges(invoice: Invoice, changes: readonly DueDateChange[]): DueDateChange[] {
  const out = [...changes].sort((a, b) => a.changedAt.localeCompare(b.changedAt) || a.changeId.localeCompare(b.changeId));
  let current = invoice.dueDate;
  for (const c of out) {
    if (c.invoiceId !== invoice.invoiceId) throw new Error(`due date change ${c.changeId} is not for ${invoice.invoiceId}`);
    if (c.previousDueDate !== current) throw new Error(`due date change ${c.changeId} does not follow the invoice's due date history`);
    current = c.newDueDate;
  }
  return out;
}

/** Reversal ids by original id, checked (same invoice, same amount, one reversal each). Throws on broken history. */
function reversedIds<T extends { amountMinor: Minor; invoiceId: string }>(originals: readonly T[], idOf: (t: T) => string, reversals: readonly { amountMinor: Minor; invoiceId: string; reversalId: string }[], targetOf: (r: any) => string, what: string): Set<string> {
  const byId = new Map(originals.map((o) => [idOf(o), o]));
  const seen = new Set<string>();
  for (const r of reversals) {
    const o = byId.get(targetOf(r));
    if (!o) throw new Error(`${what} reversal ${r.reversalId} reverses an unknown ${what}`);
    if (o.invoiceId !== r.invoiceId || o.amountMinor !== r.amountMinor) throw new Error(`${what} reversal ${r.reversalId} does not match the ${what} it reverses`);
    if (seen.has(targetOf(r))) throw new Error(`${what} ${targetOf(r)} is reversed twice`);
    seen.add(targetOf(r));
  }
  return seen;
}

/**
 * The receivable for one invoice on `asOf` (the organisation's calendar day),
 * derived only from its immutable history. Throws when the stored history
 * does not add up (the orchestrator reports it as invalid data, 409).
 */
export function receivableOf(invoice: Invoice, h: ReceivableHistory, asOf: string): Receivable | NotReceivable {
  if (!isIssued(invoice)) return { receivable: false, reason: "awaiting_external_issue", message: `${invoice.invoiceId} is awaiting external issue in Xero - it is not issued yet, so it is not a receivable (no due date, never overdue, no payments)` };
  for (const x of [...h.notes, ...h.payments, ...h.applications, ...h.paymentReversals, ...h.applicationReversals, ...h.dueChanges]) {
    if (x.invoiceId !== invoice.invoiceId) throw new Error(`a history record is not for ${invoice.invoiceId}`);
  }
  for (const p of h.payments) if (p.clientId !== invoice.clientId || p.amountMinor <= 0) throw new Error(`payment ${p.paymentId} does not match ${invoice.invoiceId}`);
  for (const a of h.applications) if (a.clientId !== invoice.clientId || a.amountMinor <= 0) throw new Error(`credit application ${a.applicationId} does not match ${invoice.invoiceId}`);
  const reversedPaymentIds = reversedIds(h.payments, (p) => p.paymentId, h.paymentReversals, (r) => r.paymentId, "payment");
  const reversedApplicationIds = reversedIds(h.applications, (a) => a.applicationId, h.applicationReversals, (r) => r.applicationId, "credit application");
  const activePayments = h.payments.filter((p) => !reversedPaymentIds.has(p.paymentId));
  const activeApplications = h.applications.filter((a) => !reversedApplicationIds.has(a.applicationId));
  const cash = sum(activePayments);
  const applied = sum(activeApplications);
  const notes = h.notes.reduce((a, n) => a + n.grossMinor, 0);
  const noteIds = new Set(h.notes.map((n) => n.creditNoteId));
  for (const c of h.creditsFromNotes) if (c.source !== "credit_note" || c.sourceInvoiceId !== invoice.invoiceId || !c.sourceCreditNoteId || !noteIds.has(c.sourceCreditNoteId)) throw new Error(`client credit ${c.creditId} does not come from a credit note of ${invoice.invoiceId}`);
  const counted = h.creditsFromNotes.filter((c) => c.status !== "void");
  for (const n of h.notes) if (sum(counted.filter((c) => c.sourceCreditNoteId === n.creditNoteId).map((c) => ({ amountMinor: c.originalMinor }))) > n.grossMinor) throw new Error(`more client credit was taken from ${n.creditNoteId} than it is worth`);
  const converted = counted.reduce((a, c) => a + c.originalMinor, 0);
  // Cash and credit applied are only ever recorded up to what was outstanding, so together they never exceed the invoice.
  if (cash + applied > invoice.grossMinor || notes > invoice.grossMinor) throw new Error(`${invoice.invoiceId}: payments and credit applied exceed the invoice`);
  const net = invoice.grossMinor - notes - applied - cash + converted;
  const outstanding = Math.max(0, net);
  const excess = Math.max(0, -net);
  const settled = cash + applied;
  const settlement: Settlement = outstanding > 0 ? (settled > 0 ? "partially_paid" : "unpaid") : settled > 0 ? "paid" : "nothing_due";
  const moves = orderedDueChanges(invoice, h.dueChanges);
  const dueDate = moves.length ? moves[moves.length - 1].newDueDate : invoice.dueDate;
  let dueState: DueState;
  let daysOverdue: number | null = null;
  let daysUntilDue: number | null = null;
  if (outstanding === 0) dueState = "settled";
  else if (!dueDate) dueState = "no_due_date";
  else {
    const d = daysBetween(dueDate, asOf);
    if (d < 0) {
      dueState = "not_due";
      daysUntilDue = -d;
    } else if (d === 0) {
      dueState = "due_today";
      daysUntilDue = 0;
    } else {
      dueState = "overdue";
      daysOverdue = d;
    }
  }
  const state: ReceivableState = outstanding === 0 ? (settlement === "paid" ? "paid" : "nothing_due") : dueState === "no_due_date" ? "no_due_date" : dueState === "overdue" || dueState === "due_today" ? dueState : settlement === "partially_paid" ? "partially_paid" : "not_due";
  const lastPaymentDate = activePayments.reduce<string | null>((a, p) => (a === null || p.receivedDate > a ? p.receivedDate : a), null);
  return {
    receivable: true,
    invoiceId: invoice.invoiceId,
    clientId: invoice.clientId,
    grossMinor: invoice.grossMinor,
    creditNotesMinor: notes,
    creditAppliedMinor: applied,
    cashReceivedMinor: cash,
    convertedToCreditMinor: converted,
    outstandingMinor: outstanding,
    creditExcessMinor: excess,
    settlement,
    dueState,
    state,
    invoiceDate: invoice.invoiceDate,
    dueDate,
    originalDueDate: invoice.dueDate,
    dueDateMoved: moves.length > 0,
    daysOverdue,
    daysUntilDue,
    lastPaymentDate,
    paymentCount: activePayments.length,
    asOf,
    activePayments,
    activeApplications,
    reversedPaymentIds,
    reversedApplicationIds,
  };
}

/** A client credit's remaining value + status from its applications; throws on broken history. */
export function creditBalance(credit: ClientCredit, applications: readonly CreditApplication[], reversals: readonly ApplicationReversal[]): { remainingMinor: Minor; status: ClientCreditStatus; activeApplications: CreditApplication[]; reversedIds: Set<string> } {
  for (const a of applications) if (a.creditId !== credit.creditId || a.clientId !== credit.clientId || a.amountMinor <= 0) throw new Error(`credit application ${a.applicationId} does not match ${credit.creditId}`);
  const byId = new Map(applications.map((a) => [a.applicationId, a]));
  const reversedIds = new Set<string>();
  for (const r of reversals) {
    const a = byId.get(r.applicationId);
    if (!a || a.amountMinor !== r.amountMinor || a.invoiceId !== r.invoiceId || r.creditId !== credit.creditId) throw new Error(`credit application reversal ${r.reversalId} does not match ${credit.creditId}`);
    if (reversedIds.has(r.applicationId)) throw new Error(`credit application ${r.applicationId} is reversed twice`);
    reversedIds.add(r.applicationId);
  }
  const active = applications.filter((a) => !reversedIds.has(a.applicationId));
  const used = sum(active);
  if (used > credit.originalMinor) throw new Error(`${credit.creditId} is applied beyond its value`);
  const remaining = credit.originalMinor - used;
  if (credit.status === "void" && active.length) throw new Error(`${credit.creditId} is void but still applied`);
  const status: ClientCreditStatus = credit.status === "void" ? "void" : remaining === 0 ? "used" : "available";
  return { remainingMinor: remaining, status, activeApplications: active, reversedIds };
}

// ---------------------------------------------------------------------
// Write plans (pure; the orchestrator runs them under the Finance write lock)
// ---------------------------------------------------------------------

export type Refusal = { ok: false; httpStatus: 404 | 409; code: string; error: string };
const refuse = (httpStatus: 404 | 409, code: string, error: string): Refusal => ({ ok: false, httpStatus, code, error });
type Meta = { userId: string; at: string; today: string };
const notReceivable = (i: Invoice): Refusal => refuse(409, "invoice_not_issued", `${i.invoiceId} is awaiting external issue in Xero - it has not been issued, so it is not a receivable yet; nothing was changed`);
const gbp = (m: Minor) => `£${formatMinor(m)}`;

export interface PaymentRequest {
  amountMinor: Minor | null;
  settleRemaining: boolean;
  receivedDate: string;
  method: PaymentMethod | null;
  reference: string | null;
  reason: string | null;
}

/** Record cash received: only on an issued invoice, never above what is outstanding, never dated in the future. */
export function planPayment(input: { invoice: Invoice; rec: Receivable | NotReceivable; req: PaymentRequest; paymentId: string; meta: Meta }): { ok: true; payment: Payment; outstandingBefore: Minor; outstandingAfter: Minor } | Refusal {
  const { invoice, rec, req, meta } = input;
  if (!rec.receivable) return notReceivable(invoice);
  if (rec.outstandingMinor === 0) return refuse(409, "invoice_settled", `${invoice.invoiceId} has nothing outstanding - no payment can be recorded against it${rec.creditExcessMinor > 0 ? ` (it holds ${gbp(rec.creditExcessMinor)} the client already paid beyond its corrected value - that can be kept as client credit)` : ""}`);
  if (req.receivedDate > meta.today) return refuse(409, "received_date_in_future", `The received date ${req.receivedDate} is in the future - record a payment once the money has arrived; nothing was recorded`);
  const amount = req.settleRemaining ? rec.outstandingMinor : (req.amountMinor as Minor);
  if (amount > rec.outstandingMinor) return refuse(409, "payment_exceeds_outstanding", `${gbp(amount)} is more than the ${gbp(rec.outstandingMinor)} outstanding on ${invoice.invoiceId} - record the payment up to the outstanding amount, then keep any extra as client credit (overpayment); nothing was recorded`);
  const payment: Payment = {
    paymentId: input.paymentId,
    invoiceId: invoice.invoiceId,
    clientId: invoice.clientId,
    clientName: invoice.clientName,
    amountMinor: amount,
    currency: CURRENCY,
    receivedDate: req.receivedDate,
    method: req.method,
    reference: req.reference,
    source: "manual",
    externalProvider: null,
    externalPaymentId: null,
    reason: req.reason,
    recordedBy: meta.userId,
    recordedAt: meta.at,
  };
  return { ok: true, payment, outstandingBefore: rec.outstandingMinor, outstandingAfter: rec.outstandingMinor - amount };
}

/** Cancel a payment recorded in error (its full amount). Refused while cash kept from it is held as client credit. */
export function planPaymentReversal(input: { invoice: Invoice; rec: Receivable | NotReceivable; paymentId: string; payments: readonly Payment[]; overpaymentCredits: readonly ClientCredit[]; reason: string; reversalId: string; meta: Meta }): { ok: true; payment: Payment; reversal: PaymentReversal; outstandingBefore: Minor; outstandingAfter: Minor } | Refusal {
  const { invoice, rec } = input;
  const payment = input.payments.find((p) => p.paymentId === input.paymentId);
  if (!payment) return refuse(404, "payment_not_found", `No payment ${input.paymentId} in your organisation`);
  if (!rec.receivable) return notReceivable(invoice);
  if (rec.reversedPaymentIds.has(payment.paymentId)) return refuse(409, "payment_already_reversed", `${payment.paymentId} is already reversed - nothing was changed`);
  if (payment.source !== "manual") return refuse(409, "payment_not_manual", `${payment.paymentId} came from ${payment.source} - it can only be corrected there`);
  const held = input.overpaymentCredits.filter((c) => c.sourcePaymentId === payment.paymentId && c.status !== "void");
  if (held.length) return refuse(409, "payment_has_client_credit", `Extra cash from ${payment.paymentId} is held as client credit ${held.map((c) => c.creditId).join(", ")} - void that credit first; nothing was changed`);
  const reversal: PaymentReversal = { reversalId: input.reversalId, paymentId: payment.paymentId, invoiceId: invoice.invoiceId, clientId: invoice.clientId, amountMinor: payment.amountMinor, reason: input.reason, recordedBy: input.meta.userId, recordedAt: input.meta.at };
  const after = receivableAfter(rec, { cash: -payment.amountMinor });
  return { ok: true, payment, reversal, outstandingBefore: rec.outstandingMinor, outstandingAfter: after };
}

/** outstanding after a change to cash / applied / converted (same formula as receivableOf). */
function receivableAfter(rec: Receivable, d: { cash?: number; applied?: number; converted?: number }): Minor {
  const net = rec.grossMinor - rec.creditNotesMinor - (rec.creditAppliedMinor + (d.applied ?? 0)) - (rec.cashReceivedMinor + (d.cash ?? 0)) + (rec.convertedToCreditMinor + (d.converted ?? 0));
  return Math.max(0, net);
}

/** Move the due date deliberately (reason required). The original stays on the invoice; payment terms and issue date never change. */
export function planDueDateChange(input: { invoice: Invoice; rec: Receivable | NotReceivable; newDueDate: string; reason: string; changeId: string; meta: Meta }): { ok: true; change: DueDateChange } | Refusal {
  const { invoice, rec } = input;
  if (!rec.receivable) return notReceivable(invoice);
  if (rec.outstandingMinor === 0) return refuse(409, "invoice_settled", `${invoice.invoiceId} has nothing outstanding - its due date no longer matters; nothing was changed`);
  if (!rec.dueDate || !rec.invoiceDate) return refuse(409, "no_due_date", `${invoice.invoiceId} has no due date recorded - nothing was changed`);
  if (input.newDueDate < rec.invoiceDate) return refuse(409, "due_date_before_invoice_date", `The due date cannot be before the invoice date (${rec.invoiceDate}) - nothing was changed`);
  if (input.newDueDate === rec.dueDate) return refuse(409, "due_date_unchanged", `${invoice.invoiceId} is already due on ${rec.dueDate} - nothing was changed`);
  return { ok: true, change: { changeId: input.changeId, invoiceId: invoice.invoiceId, previousDueDate: rec.dueDate, newDueDate: input.newDueDate, reason: input.reason, changedBy: input.meta.userId, changedAt: input.meta.at } };
}

function newCredit(base: Omit<ClientCredit, "remainingMinor" | "currency" | "status" | "voidReason" | "voidedBy" | "voidedAt" | "revision" | "updatedBy" | "updatedAt">): ClientCredit {
  return { ...base, remainingMinor: base.originalMinor, currency: CURRENCY, status: "available", voidReason: null, voidedBy: null, voidedAt: null, revision: 1, updatedBy: base.createdBy, updatedAt: base.createdAt };
}

/**
 * Keep value from a correction for the client's future use: only the part of
 * a credit note the invoice no longer needs (the client had already paid it -
 * "credit excess"), and never more than the credit note itself. The credit
 * note stays linked to its invoice; no cash moves.
 */
export function planCreditFromNote(input: { invoice: Invoice; rec: Receivable | NotReceivable; note: CreditNote; creditsFromNote: readonly ClientCredit[]; amountMinor: Minor; reason: string; creditId: string; meta: Meta }): { ok: true; credit: ClientCredit; availableBefore: Minor } | Refusal {
  const { invoice, rec, note } = input;
  if (!rec.receivable) return notReceivable(invoice);
  const taken = input.creditsFromNote.filter((c) => c.status !== "void").reduce((a, c) => a + c.originalMinor, 0);
  const available = Math.min(note.grossMinor - taken, rec.creditExcessMinor);
  if (available <= 0) return refuse(409, "no_credit_available", `Nothing from ${note.creditNoteId} can be kept as client credit: ${taken >= note.grossMinor ? "all of it is already client credit" : `it only reduced what ${invoice.invoiceId} still owed (the client has not paid beyond the corrected value)`}; nothing was created`);
  if (input.amountMinor > available) return refuse(409, "credit_exceeds_available", `At most ${gbp(available)} from ${note.creditNoteId} can be kept as client credit - nothing was created`);
  const credit = newCredit({ creditId: input.creditId, clientId: invoice.clientId, clientName: invoice.clientName, source: "credit_note", sourceInvoiceId: invoice.invoiceId, sourceCreditNoteId: note.creditNoteId, sourcePaymentId: null, receivedDate: null, originalMinor: input.amountMinor, reason: input.reason, createdBy: input.meta.userId, createdAt: input.meta.at });
  return { ok: true, credit, availableBefore: available };
}

/**
 * Keep cash the client paid beyond an invoice as client credit. The invoice
 * payment was recorded up to what was outstanding (so the invoice now owes
 * nothing); the extra is this credit, dated when that payment arrived.
 */
export function planCreditFromOverpayment(input: { invoice: Invoice; rec: Receivable | NotReceivable; payment: Payment; amountMinor: Minor; reason: string; creditId: string; meta: Meta }): { ok: true; credit: ClientCredit } | Refusal {
  const { invoice, rec, payment } = input;
  if (!rec.receivable) return notReceivable(invoice);
  if (rec.reversedPaymentIds.has(payment.paymentId)) return refuse(409, "payment_reversed", `${payment.paymentId} was reversed - no client credit can come from it; nothing was created`);
  if (rec.outstandingMinor > 0) return refuse(409, "invoice_not_settled", `${invoice.invoiceId} still has ${gbp(rec.outstandingMinor)} outstanding - record the extra money against the invoice first; only cash beyond what the invoice owes becomes client credit; nothing was created`);
  const credit = newCredit({ creditId: input.creditId, clientId: invoice.clientId, clientName: invoice.clientName, source: "overpayment", sourceInvoiceId: invoice.invoiceId, sourceCreditNoteId: null, sourcePaymentId: payment.paymentId, receivedDate: payment.receivedDate, originalMinor: input.amountMinor, reason: input.reason, createdBy: input.meta.userId, createdAt: input.meta.at });
  return { ok: true, credit };
}

/** Use client credit against one of the SAME client's issued invoices - never above the credit left or the invoice outstanding. Not cash. */
export function planApplication(input: { credit: ClientCredit; balance: ReturnType<typeof creditBalance>; invoice: Invoice; rec: Receivable | NotReceivable; amountMinor: Minor; reason: string | null; applicationId: string; meta: Meta }): { ok: true; application: CreditApplication; creditAfter: ClientCredit; outstandingBefore: Minor; outstandingAfter: Minor } | Refusal {
  const { credit, balance, invoice, rec, amountMinor } = input;
  if (balance.status === "void") return refuse(409, "client_credit_void", `${credit.creditId} is void - it cannot be applied`);
  if (invoice.clientId !== credit.clientId) return refuse(409, "client_mismatch", `${credit.creditId} belongs to ${credit.clientName} - it can only be applied to that client's invoices; ${invoice.invoiceId} is ${invoice.clientName}'s`);
  if (!rec.receivable) return notReceivable(invoice);
  if (balance.remainingMinor === 0) return refuse(409, "client_credit_used", `${credit.creditId} has no value left - nothing was applied`);
  if (amountMinor > balance.remainingMinor) return refuse(409, "credit_exceeds_remaining", `${gbp(amountMinor)} is more than the ${gbp(balance.remainingMinor)} left on ${credit.creditId} - nothing was applied`);
  if (rec.outstandingMinor === 0) return refuse(409, "invoice_settled", `${invoice.invoiceId} has nothing outstanding - nothing was applied`);
  if (amountMinor > rec.outstandingMinor) return refuse(409, "credit_exceeds_outstanding", `${gbp(amountMinor)} is more than the ${gbp(rec.outstandingMinor)} outstanding on ${invoice.invoiceId} - nothing was applied`);
  const application: CreditApplication = { applicationId: input.applicationId, creditId: credit.creditId, invoiceId: invoice.invoiceId, clientId: invoice.clientId, amountMinor, reason: input.reason, recordedBy: input.meta.userId, recordedAt: input.meta.at };
  const remaining = balance.remainingMinor - amountMinor;
  const creditAfter: ClientCredit = { ...credit, remainingMinor: remaining, status: remaining === 0 ? "used" : "available", revision: credit.revision + 1, updatedBy: input.meta.userId, updatedAt: input.meta.at };
  return { ok: true, application, creditAfter, outstandingBefore: rec.outstandingMinor, outstandingAfter: rec.outstandingMinor - amountMinor };
}

/** Unapply (full amount, reason required): the credit gets the value back and the invoice owes it again. The application record stays. */
export function planApplicationReversal(input: { credit: ClientCredit; balance: ReturnType<typeof creditBalance>; application: CreditApplication; invoice: Invoice; rec: Receivable | NotReceivable; reason: string; reversalId: string; meta: Meta }): { ok: true; reversal: ApplicationReversal; creditAfter: ClientCredit; outstandingBefore: Minor; outstandingAfter: Minor } | Refusal {
  const { credit, balance, application, invoice, rec } = input;
  if (balance.reversedIds.has(application.applicationId)) return refuse(409, "application_already_reversed", `${application.applicationId} is already reversed - nothing was changed`);
  if (!rec.receivable) return notReceivable(invoice);
  const reversal: ApplicationReversal = { reversalId: input.reversalId, applicationId: application.applicationId, creditId: credit.creditId, invoiceId: application.invoiceId, clientId: application.clientId, amountMinor: application.amountMinor, reason: input.reason, recordedBy: input.meta.userId, recordedAt: input.meta.at };
  const remaining = balance.remainingMinor + application.amountMinor;
  const creditAfter: ClientCredit = { ...credit, remainingMinor: remaining, status: "available", revision: credit.revision + 1, updatedBy: input.meta.userId, updatedAt: input.meta.at };
  return { ok: true, reversal, creditAfter, outstandingBefore: rec.outstandingMinor, outstandingAfter: receivableAfter(rec, { applied: -application.amountMinor }) };
}

/** Void a client credit created in error - only while none of it is applied. The record stays (status Void). */
export function planVoid(input: { credit: ClientCredit; balance: ReturnType<typeof creditBalance>; reason: string; meta: Meta }): { ok: true; creditAfter: ClientCredit } | Refusal {
  const { credit, balance } = input;
  if (balance.status === "void") return refuse(409, "client_credit_void", `${credit.creditId} is already void - nothing was changed`);
  if (balance.activeApplications.length) return refuse(409, "client_credit_in_use", `${credit.creditId} is applied to ${balance.activeApplications.map((a) => a.invoiceId).join(", ")} - unapply it first; nothing was changed`);
  return { ok: true, creditAfter: { ...credit, status: "void", voidReason: input.reason, voidedBy: input.meta.userId, voidedAt: input.meta.at, revision: credit.revision + 1, updatedBy: input.meta.userId, updatedAt: input.meta.at } };
}

// ---------------------------------------------------------------------
// Cash receipts (the trusted Actual Revenue fact; no Month Report / Cash Flow maths)
// ---------------------------------------------------------------------

export interface ReceiptFact {
  kind: "invoice_payment" | "overpayment_credit";
  receiptId: string;
  invoiceId: string;
  clientId: string;
  clientName: string;
  amountMinor: Minor;
  receivedDate: string;
  source: PaymentSource;
  method: PaymentMethod | null;
  reference: string | null;
  recordedAt: string;
}

/**
 * Trusted cash receipts received in [from, to]: every active (not reversed)
 * invoice payment, plus cash kept as client credit from an overpayment (not
 * void). Credit notes, client credit applied, issuing and due dates are never
 * receipts. Reversed payments are listed apart (recorded in error - not a refund).
 */
export function receiptFacts(payments: readonly Payment[], reversals: readonly PaymentReversal[], credits: readonly ClientCredit[], from: string, to: string): { receipts: ReceiptFact[]; reversed: { paymentId: string; invoiceId: string; amountMinor: Minor; receivedDate: string; reversedAt: string; reason: string }[] } {
  const rev = new Map(reversals.map((r) => [r.paymentId, r]));
  const inRange = (d: string) => d >= from && d <= to;
  const byPayment = new Map(payments.map((p) => [p.paymentId, p]));
  const receipts: ReceiptFact[] = [];
  const reversed = [];
  for (const p of payments) {
    if (!inRange(p.receivedDate)) continue;
    const r = rev.get(p.paymentId);
    if (r) reversed.push({ paymentId: p.paymentId, invoiceId: p.invoiceId, amountMinor: p.amountMinor, receivedDate: p.receivedDate, reversedAt: r.recordedAt, reason: r.reason });
    else receipts.push({ kind: "invoice_payment", receiptId: p.paymentId, invoiceId: p.invoiceId, clientId: p.clientId, clientName: p.clientName, amountMinor: p.amountMinor, receivedDate: p.receivedDate, source: p.source, method: p.method, reference: p.reference, recordedAt: p.recordedAt });
  }
  for (const c of credits) {
    if (c.source !== "overpayment" || c.status === "void" || !c.receivedDate || !inRange(c.receivedDate)) continue;
    const p = c.sourcePaymentId ? byPayment.get(c.sourcePaymentId) : undefined;
    receipts.push({ kind: "overpayment_credit", receiptId: c.creditId, invoiceId: c.sourceInvoiceId, clientId: c.clientId, clientName: c.clientName, amountMinor: c.originalMinor, receivedDate: c.receivedDate, source: p?.source ?? "manual", method: p?.method ?? null, reference: p?.reference ?? null, recordedAt: c.createdAt });
  }
  receipts.sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.recordedAt.localeCompare(b.recordedAt) || a.receiptId.localeCompare(b.receiptId));
  return { receipts, reversed };
}

// ---------------------------------------------------------------------
// Public bodies
// ---------------------------------------------------------------------

const m = (x: Minor) => formatMinor(x);

export function publicReceivable(invoice: Invoice, rec: Receivable | NotReceivable) {
  const base = { invoiceId: invoice.invoiceId, reference: invoice.invoiceId, officialNumber: publicNumbering(invoice).officialNumber, client: { clientId: invoice.clientId, name: invoice.clientName }, invoiceStatus: invoice.status };
  if (!rec.receivable) return { ...base, receivable: false, reason: rec.reason, message: rec.message };
  return {
    ...base,
    receivable: true,
    invoiceDate: rec.invoiceDate,
    dueDate: rec.dueDate,
    originalDueDate: rec.originalDueDate,
    dueDateMoved: rec.dueDateMoved,
    currency: CURRENCY,
    amounts: {
      gross: m(rec.grossMinor),
      creditNotes: m(rec.creditNotesMinor),
      creditNotesKeptAsClientCredit: m(rec.convertedToCreditMinor),
      clientCreditApplied: m(rec.creditAppliedMinor),
      cashReceived: m(rec.cashReceivedMinor),
      outstanding: m(rec.outstandingMinor),
      creditExcess: m(rec.creditExcessMinor),
    },
    settlement: rec.settlement,
    settlementLabel: SETTLEMENT_LABELS[rec.settlement],
    dueState: rec.dueState,
    dueStateLabel: DUE_STATE_LABELS[rec.dueState],
    state: rec.state,
    stateLabel: RECEIVABLE_STATE_LABELS[rec.state],
    daysOverdue: rec.daysOverdue,
    daysUntilDue: rec.daysUntilDue,
    lastPaymentDate: rec.lastPaymentDate,
    paymentCount: rec.paymentCount,
    asOf: rec.asOf,
  };
}

export function publicPayment(p: Payment, reversal: PaymentReversal | null = null) {
  return {
    paymentId: p.paymentId,
    reference: p.paymentId,
    invoiceId: p.invoiceId,
    client: { clientId: p.clientId, name: p.clientName },
    amount: m(p.amountMinor),
    currency: p.currency,
    receivedDate: p.receivedDate,
    method: p.method,
    methodLabel: p.method ? PAYMENT_METHOD_LABELS[p.method] : null,
    paymentReference: p.reference,
    source: p.source,
    sourceLabel: PAYMENT_SOURCE_LABELS[p.source],
    external: { provider: p.externalProvider, paymentId: p.externalPaymentId },
    reason: p.reason,
    recordedBy: p.recordedBy,
    recordedAt: p.recordedAt,
    status: reversal ? "reversed" : "active",
    reversal: reversal ? { reversalId: reversal.reversalId, reason: reversal.reason, recordedBy: reversal.recordedBy, recordedAt: reversal.recordedAt } : null,
    /** Cash counts only while the payment stands. */
    countsAsCashReceived: !reversal,
  };
}

export function publicApplication(a: CreditApplication, reversal: ApplicationReversal | null = null) {
  return {
    applicationId: a.applicationId,
    creditId: a.creditId,
    invoiceId: a.invoiceId,
    clientId: a.clientId,
    amount: m(a.amountMinor),
    reason: a.reason,
    recordedBy: a.recordedBy,
    recordedAt: a.recordedAt,
    status: reversal ? "reversed" : "active",
    reversal: reversal ? { reversalId: reversal.reversalId, reason: reversal.reason, recordedBy: reversal.recordedBy, recordedAt: reversal.recordedAt } : null,
    countsAsCashReceived: false,
  };
}

export function publicClientCredit(c: ClientCredit, applications: readonly CreditApplication[] = [], reversals: readonly ApplicationReversal[] = []) {
  const rev = new Map(reversals.map((r) => [r.applicationId, r]));
  return {
    creditId: c.creditId,
    reference: c.creditId,
    client: { clientId: c.clientId, name: c.clientName },
    source: c.source,
    sourceLabel: CLIENT_CREDIT_SOURCE_LABELS[c.source],
    sourceInvoiceId: c.sourceInvoiceId,
    sourceCreditNoteId: c.sourceCreditNoteId,
    sourcePaymentId: c.sourcePaymentId,
    receivedDate: c.receivedDate,
    currency: c.currency,
    original: m(c.originalMinor),
    remaining: m(c.remainingMinor),
    status: c.status,
    statusLabel: CLIENT_CREDIT_STATUS_LABELS[c.status],
    reason: c.reason,
    void: c.status === "void" ? { reason: c.voidReason, voidedBy: c.voidedBy, voidedAt: c.voidedAt } : null,
    /** Only cash kept from an overpayment was ever cash received (on its received date); credit-note value never was. */
    wasCashReceived: c.source === "overpayment",
    appliedAutomatically: false,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    revision: c.revision,
    updatedAt: c.updatedAt,
    applications: applications.map((a) => publicApplication(a, rev.get(a.applicationId) ?? null)),
  };
}

export function publicDueChange(c: DueDateChange) {
  return { changeId: c.changeId, invoiceId: c.invoiceId, previousDueDate: c.previousDueDate, newDueDate: c.newDueDate, reason: c.reason, changedBy: c.changedBy, changedAt: c.changedAt };
}

export function publicReceipt(r: ReceiptFact) {
  return { kind: r.kind, receiptId: r.receiptId, invoiceId: r.invoiceId, client: { clientId: r.clientId, name: r.clientName }, amount: m(r.amountMinor), currency: CURRENCY, receivedDate: r.receivedDate, source: r.source, method: r.method, reference: r.reference, recordedAt: r.recordedAt };
}

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

export const auditPayment = (p: Payment) => ({ paymentId: p.paymentId, invoiceId: p.invoiceId, clientId: p.clientId, amountMinor: p.amountMinor, receivedDate: p.receivedDate, method: p.method, reference: p.reference, source: p.source });
export const auditCredit = (c: ClientCredit) => ({ creditId: c.creditId, clientId: c.clientId, source: c.source, sourceInvoiceId: c.sourceInvoiceId, sourceCreditNoteId: c.sourceCreditNoteId, sourcePaymentId: c.sourcePaymentId, receivedDate: c.receivedDate, originalMinor: c.originalMinor, remainingMinor: c.remainingMinor, status: c.status, revision: c.revision });
export const auditRec = (r: Receivable) => ({ outstandingMinor: r.outstandingMinor, cashReceivedMinor: r.cashReceivedMinor, creditAppliedMinor: r.creditAppliedMinor, creditNotesMinor: r.creditNotesMinor, convertedToCreditMinor: r.convertedToCreditMinor, creditExcessMinor: r.creditExcessMinor, settlement: r.settlement, dueDate: r.dueDate });

export function receivableAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: RECEIVABLES_CONTRACT } };
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

function jsonObject(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean): { ok: true; body: Record<string, unknown> } | Invalid {
  if (!raw.trim()) return invalid("invalid_body", "Body must be a JSON object");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")}`);
  return { ok: true, body: body as Record<string, unknown> };
}

function textOf(v: unknown, max: number, required: boolean): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if (CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

/** A positive amount as a decimal string ("600" / "600.00"), at most two decimal places. */
function amountOf(v: unknown): { ok: true; minor: Minor } | { ok: false; error: string } {
  const p = parseMoney(v);
  if (!p.ok) return { ok: false, error: p.error };
  if (p.minor <= 0) return { ok: false, error: "must be more than 0" };
  if (p.minor > MAX_MINOR) return { ok: false, error: "is too large" };
  return { ok: true, minor: p.minor };
}

const dateOf = (v: unknown): string | null => (isIsoDate(v) ? (v as string) : null);
type Out<T> = ({ ok: true } & T) | Invalid;
function done<T>(fields: Record<string, string>, what: string, value: () => T): Out<T> {
  if (Object.keys(fields).length) return invalid("invalid_input", `Some fields are not valid - nothing was ${what}`, fields);
  return { ok: true, ...value() } as Out<T>;
}

/**
 * POST /invoices/{id}/payments { amount | settleRemaining: true, receivedDate, method?, reference?, reason? }.
 * Exactly one of amount (decimal string) or settleRemaining (the whole outstanding balance, explicitly).
 * receivedDate is required - never assumed to be today.
 */
export function parsePayment(raw: string, isTenantKey: (k: string) => boolean): Out<{ req: PaymentRequest }> {
  const b = jsonObject(raw, ["amount", "settleRemaining", "receivedDate", "method", "reference", "reason"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const body = b.body;
  const settle = body.settleRemaining;
  if (settle !== undefined && typeof settle !== "boolean") f.settleRemaining = "must be true or left out";
  let amountMinor: Minor | null = null;
  if (settle === true) {
    if (body.amount !== undefined && body.amount !== null) f.amount = "leave out when settleRemaining is true";
  } else if (body.amount === undefined || body.amount === null) f.amount = "is required (or send settleRemaining: true to record the whole outstanding balance)";
  else {
    const a = amountOf(body.amount);
    if (a.ok) amountMinor = a.minor;
    else f.amount = a.error;
  }
  const receivedDate = dateOf(body.receivedDate);
  if (!receivedDate) f.receivedDate = "is required - the real date the money arrived, YYYY-MM-DD";
  let method: PaymentMethod | null = null;
  if (body.method !== undefined && body.method !== null) {
    if ((PAYMENT_METHODS as readonly unknown[]).includes(body.method)) method = body.method as PaymentMethod;
    else f.method = `must be one of ${PAYMENT_METHODS.join(", ")}`;
  }
  const ref = textOf(body.reference, REFERENCE_MAX, false);
  if (!ref.ok) f.reference = ref.error;
  const reason = textOf(body.reason, REASON_MAX, false);
  if (!reason.ok) f.reason = reason.error;
  return done(f, "recorded", () => ({ req: { amountMinor, settleRemaining: settle === true, receivedDate: receivedDate as string, method, reference: (ref as any).value, reason: (reason as any).value } }));
}

/** { reason } - required (reversals, void). */
export function parseRequiredReason(raw: string, isTenantKey: (k: string) => boolean, what: string): Out<{ reason: string }> {
  const b = jsonObject(raw, ["reason"], isTenantKey);
  if (!b.ok) return b;
  const r = textOf(b.body.reason, REASON_MAX, true);
  return done(r.ok ? {} : { reason: r.error }, what, () => ({ reason: (r as any).value as string }));
}

/** POST /invoices/{id}/due-date { dueDate, reason }. */
export function parseDueDateChange(raw: string, isTenantKey: (k: string) => boolean): Out<{ dueDate: string; reason: string }> {
  const b = jsonObject(raw, ["dueDate", "reason"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const dueDate = dateOf(b.body.dueDate);
  if (!dueDate) f.dueDate = "must be a real date YYYY-MM-DD";
  const r = textOf(b.body.reason, REASON_MAX, true);
  if (!r.ok) f.reason = r.error;
  return done(f, "changed", () => ({ dueDate: dueDate as string, reason: (r as any).value as string }));
}

/** { amount, reason } - client credit from a credit note / an overpayment. */
export function parseCreditCreate(raw: string, isTenantKey: (k: string) => boolean): Out<{ amountMinor: Minor; reason: string }> {
  const b = jsonObject(raw, ["amount", "reason"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const a = amountOf(b.body.amount);
  if (!a.ok) f.amount = a.error;
  const r = textOf(b.body.reason, REASON_MAX, true);
  if (!r.ok) f.reason = r.error;
  return done(f, "created", () => ({ amountMinor: (a as any).minor as Minor, reason: (r as any).value as string }));
}

/** POST /client-credits/{id}/applications { invoiceId, amount, reason? }. */
export function parseApplication(raw: string, isTenantKey: (k: string) => boolean): Out<{ invoiceId: string; amountMinor: Minor; reason: string | null }> {
  const b = jsonObject(raw, ["invoiceId", "amount", "reason"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const inv = b.body.invoiceId;
  if (typeof inv !== "string" || !INVOICE_ID_PATTERN.test(inv)) f.invoiceId = "must be a FIV- invoice id";
  const a = amountOf(b.body.amount);
  if (!a.ok) f.amount = a.error;
  const r = textOf(b.body.reason, REASON_MAX, false);
  if (!r.ok) f.reason = r.error;
  return done(f, "applied", () => ({ invoiceId: inv as string, amountMinor: (a as any).minor as Minor, reason: (r as any).value }));
}

function queryKeys(params: URLSearchParams, allowed: readonly string[], isTenantKey: (k: string) => boolean): Invalid | null {
  const keys = [...params.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${bad.join(", ")}`);
  const twice = allowed.filter((k) => params.getAll(k).length > 1);
  if (twice.length) return invalid("unexpected_parameter", `${twice.join(", ")} may be given once`);
  return null;
}

/** GET /receivables[?clientId=FCL-..][&asOf=YYYY-MM-DD]; GET /invoices/{id}/receivable[?asOf=]. asOf (today or later) projects due / overdue. */
export function checkReceivablesQuery(params: URLSearchParams, allowClient: boolean, isTenantKey: (k: string) => boolean): Out<{ clientId: string | null; asOf: string | null }> {
  const bad = queryKeys(params, allowClient ? ["clientId", "asOf"] : ["asOf"], isTenantKey);
  if (bad) return bad;
  const f: Record<string, string> = {};
  const clientId = params.get("clientId");
  if (clientId !== null && !CLIENT_ID_PATTERN.test(clientId)) f.clientId = "must be a FCL- client id";
  const asOf = params.get("asOf");
  if (asOf !== null && !isIsoDate(asOf)) f.asOf = "must be a real date YYYY-MM-DD";
  return done(f, "read", () => ({ clientId, asOf }));
}

/** GET /receipts?from=YYYY-MM-DD&to=YYYY-MM-DD (<= 366 days). */
export function checkReceiptsQuery(params: URLSearchParams, isTenantKey: (k: string) => boolean): Out<{ from: string; to: string }> {
  const bad = queryKeys(params, ["from", "to"], isTenantKey);
  if (bad) return bad;
  const from = params.get("from");
  const to = params.get("to");
  const f: Record<string, string> = {};
  if (!isIsoDate(from)) f.from = "is required, a real date YYYY-MM-DD";
  if (!isIsoDate(to)) f.to = "is required, a real date YYYY-MM-DD";
  if (!f.from && !f.to) {
    if ((to as string) < (from as string)) f.to = "must be on or after from";
    else if (daysBetween(from as string, to as string) + 1 > RECEIPTS_MAX_DAYS) f.to = `the range may cover at most ${RECEIPTS_MAX_DAYS} days`;
  }
  return done(f, "read", () => ({ from: from as string, to: to as string }));
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

export type ReceivablesRoute =
  | { name: "receivables.list" | "receipts.list"; params: Record<string, never> }
  | { name: "invoice.receivable" | "invoice.payments" | "invoice.payment_create" | "invoice.due_date"; params: { invoiceId: string } }
  | { name: "payment.reverse" | "payment.overpayment_credit"; params: { paymentId: string } }
  | { name: "credit_note.client_credit"; params: { creditNoteId: string } }
  | { name: "client.credits"; params: { clientId: string } }
  | { name: "client_credit.read" | "client_credit.apply" | "client_credit.void"; params: { creditId: string } }
  | { name: "application.reverse"; params: { applicationId: string } };

type Match = { status: "match"; route: ReceivablesRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/**
 * Matches the F7 paths. Returns null for every path it does not own
 * (other invoices / credit-notes / clients paths stay F6's / F3's), so it is
 * dispatched first. A malformed id on an F7-only prefix is 404. There is
 * deliberately no reminder / send / Xero / Stripe / cash-flow route.
 */
export function matchReceivablesRoute(path: string, method: string): Match {
  const seg = path.split("/");
  const m = (allowed: string[], route: ReceivablesRoute): Match => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg.length === 1 && seg[0] === "receivables") return m(["GET"], { name: "receivables.list", params: {} });
  if (seg.length === 1 && seg[0] === "receipts") return m(["GET"], { name: "receipts.list", params: {} });
  if (seg[0] === "invoices" && seg.length === 3 && INVOICE_ID_PATTERN.test(seg[1])) {
    const invoiceId = seg[1];
    if (seg[2] === "receivable") return m(["GET"], { name: "invoice.receivable", params: { invoiceId } });
    if (seg[2] === "payments") return m(["GET", "POST"], { name: method === "POST" ? "invoice.payment_create" : "invoice.payments", params: { invoiceId } });
    if (seg[2] === "due-date") return m(["POST"], { name: "invoice.due_date", params: { invoiceId } });
    return null;
  }
  if (seg[0] === "credit-notes" && seg.length === 3 && seg[2] === "client-credit") return CORRECTION_ID_PATTERN.test(seg[1]) ? m(["POST"], { name: "credit_note.client_credit", params: { creditNoteId: seg[1] } }) : { status: "not_found" };
  if (seg[0] === "clients" && seg.length === 3 && seg[2] === "credits") return CLIENT_ID_PATTERN.test(seg[1]) ? m(["GET"], { name: "client.credits", params: { clientId: seg[1] } }) : { status: "not_found" };
  if (seg[0] === "payments") {
    if (seg.length !== 3 || !PAYMENT_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    if (seg[2] === "reverse") return m(["POST"], { name: "payment.reverse", params: { paymentId: seg[1] } });
    if (seg[2] === "overpayment-credit") return m(["POST"], { name: "payment.overpayment_credit", params: { paymentId: seg[1] } });
    return { status: "not_found" };
  }
  if (seg[0] === "client-credits") {
    if (seg.length < 2 || !CLIENT_CREDIT_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    const creditId = seg[1];
    if (seg.length === 2) return m(["GET"], { name: "client_credit.read", params: { creditId } });
    if (seg.length === 3 && seg[2] === "applications") return m(["POST"], { name: "client_credit.apply", params: { creditId } });
    if (seg.length === 3 && seg[2] === "void") return m(["POST"], { name: "client_credit.void", params: { creditId } });
    return { status: "not_found" };
  }
  if (seg[0] === "client-credit-applications") {
    if (seg.length === 3 && APPLICATION_ID_PATTERN.test(seg[1]) && seg[2] === "reverse") return m(["POST"], { name: "application.reverse", params: { applicationId: seg[1] } });
    return { status: "not_found" };
  }
  return null;
}
