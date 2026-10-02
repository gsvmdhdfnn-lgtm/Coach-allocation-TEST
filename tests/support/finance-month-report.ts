/**
 * Test-suite copy of the canonical finance/finance-month-report.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Month Report + Finance Overview - pure reporting engine (Finance Foundation
 * F18; see TEST-ENV.md "Finance Foundation - F18"). No I/O: the orchestrator
 * loads each source once and hands its OWN slice's normalised values in here.
 *
 * Three deliberately separate concepts (locked, F18 decisions D1-D12):
 *   1. ECONOMIC MONTH - which month a revenue / cost belongs to in management
 *      reporting: the session (occurrence) date for revenue, coach work and
 *      venue profitability shares; the credit date for supplier credits; the
 *      instalment due month for supplier overheads; the employment month for
 *      salaries. A credit note corrects its original line's month.
 *   2. ACTUAL / EXPECTED STATE - whether the value has reached the locked level
 *      of certainty (revenue: a trusted receipt; coach: a finalised Coach Month;
 *      venue: a confirmed share whose date has passed; overheads: confirmed).
 *   3. CASH DATE - when money moved. F17 (Cash Flow) only; NEVER used here for
 *      attribution. A receipt changes a line's state, never its month.
 *
 * Partial receipts (D1): an invoice's trusted settlement (active cash payments
 * + active client credit applied - F7 only ever creates client credit from cash
 * the client already paid) is capped at its post-credit value and spread over
 * its remaining (not credited) lines in proportion to each line's gross,
 * penny-exact (largest remainder; ties by line id). The same proportion is
 * applied to the line's VAT / net. Actual + Expected = the line's value.
 *
 * Totals are always computed from the facts themselves; programme / category
 * sums are computed separately and checked against them (no balancing line).
 */
import { divRoundHalfAwayFromZero, formatMinor } from "./finance-money.ts";

export const MONTH_REPORT_CONTRACT = "finance-month-report-v1";
export const OVERVIEW_CONTRACT = "finance-overview-v1";
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const REPORT_MODES = ["actual", "expected"] as const;
export type ReportMode = (typeof REPORT_MODES)[number];
export type FactState = "actual" | "expected";
export const UPCOMING_WINDOW_DAYS = 14;

/** Thrown when stored source data cannot produce a truthful report (fails loudly, never forced). */
export class MonthReportDataError extends Error {}

const m = (minor: number) => formatMinor(minor);
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const byStr = <T,>(f: (x: T) => string) => (a: T, b: T) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);

// ---------------------------------------------------------------------
// Months (calendar arithmetic only)
// ---------------------------------------------------------------------
export const monthOfDate = (date: string) => date.slice(0, 7);
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}
export const previousMonth = (month: string) => addMonths(month, -1);
export function monthEnd(month: string): string {
  const [y, mo] = month.split("-").map(Number);
  const d = new Date(Date.UTC(2000, 0, 1));
  d.setUTCFullYear(y, mo, 0);
  return `${month}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Inputs (each from its owning slice, already validated there)
// ---------------------------------------------------------------------
/** F6 / F7: one invoice, with its F7 settlement (issued invoices only carry a settlement). */
export interface InvoiceInput {
  invoiceId: string;
  officialNumber: string | null;
  clientId: string;
  clientName: string;
  /** F6 isIssued: a genuinely Issued invoice (an awaiting-external-issue one is not, so nothing on it is ever Actual). */
  issued: boolean;
  grossMinor: number;
  creditNotesMinor: number;
  cashReceivedMinor: number;
  creditAppliedMinor: number;
}
/** F6: one invoice line (every line of every invoice touching the report window). */
export interface InvoiceLineInput {
  invoiceId: string;
  lineId: string;
  occurrenceId: string;
  occurrenceDate: string;
  sessionId: string | null;
  sessionName: string | null;
  serviceId: string;
  serviceName: string;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  /** Whole-line credit note that corrected this line (F6), else null. */
  creditNote: { creditNoteId: string; creditDate: string } | null;
}
/** F5: one Included line on a live draft (Draft / Ready for issue). */
export interface DraftLineInput {
  draftId: string;
  lineId: string;
  clientId: string | null;
  clientName: string | null;
  occurrenceId: string;
  occurrenceDate: string;
  sessionId: string | null;
  sessionName: string | null;
  serviceId: string;
  serviceName: string;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
}
/** F4: one occurrence's billing resolution (client-paid services' sessions). */
export interface BillingInput {
  occurrenceId: string;
  occurrenceDate: string;
  sessionId: string | null;
  sessionName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  clientId: string | null;
  clientName: string | null;
  billingMethod: "hub" | "manual" | null;
  outcome: string;
  eligibilityStatus: string | null;
  deferral: string | null;
  detail: string | null;
  expected: { netMinor: number; vatMinor: number; grossMinor: number } | null;
}
/** F12: a frozen item / correction of a finalised Coach Month, or a live item of an open month. */
export interface CoachInput {
  kind: "frozen_item" | "correction" | "live_item";
  workMonth: string;
  workDate: string | null;
  coach: { ref: string | null; name: string };
  monthId: string | null;
  monthState: string | null;
  correctionId: string | null;
  allocation: string | null;
  occurrenceId: string | null;
  sessionName: string | null;
  serviceId: string | null;
  programmeLabel: string | null;
  costBasis: string | null;
  /** null = the live item's cost cannot be priced yet (unresolved, never 0.00). */
  amountMinor: number | null;
}
/** F13: one frozen profitability share of a linked direct agreement (not superseded). */
export interface DirectShareInput {
  agreementId: string;
  agreementName: string;
  supplierId: string;
  supplierName: string;
  supplierType: string;
  occurrenceDate: string;
  occurrenceRef: string | null;
  sessionId: string | null;
  sessionName: string | null;
  serviceId: string | null;
  programmeLabel: string | null;
  amountMinor: number;
  /** The agreement amount is still an estimate (F13 amountIsEstimate). */
  estimated: boolean;
}
/** F14: one live (not voided) supplier credit, with its frozen attribution rows. */
export interface SupplierCreditInput {
  creditId: string;
  supplierId: string;
  supplierName: string;
  supplierType: string;
  agreementId: string | null;
  agreementName: string | null;
  /** The agreement's F13 classification; null = supplier-wide credit (no agreement). */
  classification: "direct" | "general" | null;
  category: { categoryId: string; name: string } | null;
  creditDate: string;
  scope: string;
  amountMinor: number;
  rows: { serviceId: string | null; programmeLabel: string | null; amountMinor: number; sessionId: string | null; sessionDate: string | null }[];
}
/** F13 / F15: one non-cancelled instalment of a general (overhead) agreement. */
export interface OverheadInstalmentInput {
  agreementId: string;
  agreementName: string;
  instalmentId: string;
  supplierId: string;
  supplierName: string;
  vatTreatment: string | null;
  category: { categoryId: string; name: string } | null;
  dueDate: string;
  amountMinor: number;
  /** F13 stateOf: estimated / confirmed / partially_paid / paid. */
  state: string;
}
/** F15: one employed month (computed line or acted-on item). */
export interface EmploymentInput {
  employmentId: string;
  versionId: string;
  itemId: string | null;
  person: { ref: string | null; name: string };
  category: { categoryId: string; name: string } | null;
  month: string;
  amountMinor: number;
  /** F13 stateOf over F15's asInstalment: estimated / confirmed / paid. */
  state: string;
  estimateLabel: string | null;
}
/** Occurrences in the window whose session has no Finance Service ID (revenue cannot be expected, never guessed). */
export interface UnlinkedOccurrence {
  occurrenceId: string;
  date: string;
  sessionName: string | null;
}
export interface UnresolvedDirectAgreement {
  agreementId: string;
  agreementName: string;
  supplierName: string;
  totalMinor: number;
}
/** Parent / Stripe revenue (D2): never in report totals; an informational excluded amount where F10 can read it. */
export interface ParentRevenueInput {
  status: "excluded" | "not_connected" | "unavailable";
  grossMinor: number | null;
  receipts: number | null;
  detail: string | null;
}
export interface MonthReportInputs {
  organisationId: string;
  today: string;
  month: string;
  invoices: InvoiceInput[];
  invoiceLines: InvoiceLineInput[];
  draftLines: DraftLineInput[];
  billing: BillingInput[];
  unlinkedOccurrences: UnlinkedOccurrence[];
  coach: CoachInput[];
  directShares: DirectShareInput[];
  unresolvedDirectAgreements: UnresolvedDirectAgreement[];
  supplierCredits: SupplierCreditInput[];
  overheadInstalments: OverheadInstalmentInput[];
  employment: EmploymentInput[];
  /** F3 service names (stable Finance Service ID -> display label). */
  serviceLabels: Record<string, string>;
  /** F12 Coach Months whose live work differs from the finalised snapshot (F12 Correction Required). */
  coachMonthsNeedingCorrection: { monthId: string; coach: string; workMonth: string }[];
  parentRevenue: ParentRevenueInput;
}

// ---------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------
export type RevenueLayer = "invoice" | "draft" | "expected_billing";
export interface RevenueFact {
  side: "revenue";
  key: string;
  month: string;
  state: FactState;
  layer: RevenueLayer;
  serviceId: string;
  occurrenceId: string;
  date: string;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  source: Record<string, unknown>;
}
export type DirectKind = "coach" | "venue" | "other_direct";
export interface DirectFact {
  side: "direct";
  key: string;
  month: string;
  state: FactState;
  kind: DirectKind;
  /** true = a supplier credit adjustment (amountMinor is the positive credit; it REDUCES cost). */
  adjustment: boolean;
  serviceId: string | null;
  label: string | null;
  date: string;
  amountMinor: number;
  source: Record<string, unknown>;
}
export interface OverheadFact {
  side: "overhead";
  key: string;
  month: string;
  state: FactState;
  kind: "supplier_overhead" | "employment" | "supplier_credit";
  adjustment: boolean;
  category: { categoryId: string; name: string } | null;
  /** Why an uncategorised fact has no category (null when categorised). */
  uncategorisedReason: string | null;
  date: string;
  amountMinor: number;
  source: Record<string, unknown>;
}
export type Fact = RevenueFact | DirectFact | OverheadFact;
const signed = (f: DirectFact | OverheadFact) => (f.adjustment ? -f.amountMinor : f.amountMinor);

/** Penny-exact proportional split of `total` over `weights` (largest remainder; ties by id ascending). total <= sum(weights). */
export function allocateProportionally(total: number, weights: readonly { id: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const W = sum(weights.map((w) => w.weight));
  if (total < 0 || !Number.isSafeInteger(total)) throw new MonthReportDataError("allocation total must be a whole, non-negative number of pence");
  if (W <= 0 || total === 0) {
    for (const w of weights) out.set(w.id, 0);
    return out;
  }
  if (total > W) throw new MonthReportDataError("allocation exceeds the value it is spread over");
  const rows = weights.map((w) => {
    const num = BigInt(total) * BigInt(w.weight);
    const base = num / BigInt(W);
    return { id: w.id, base: Number(base), rem: num - base * BigInt(W) };
  });
  let left = total - sum(rows.map((r) => r.base));
  rows.sort((a, b) => (a.rem === b.rem ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  for (const r of rows) {
    out.set(r.id, r.base + (left > 0 ? 1 : 0));
    if (left > 0) left--;
  }
  return out;
}

/** The same proportion of a line's VAT / net as `portionGross` is of its gross (VAT rounded half away from zero; net = remainder). */
export function proportionOfLine(line: { netMinor: number; vatMinor: number; grossMinor: number }, portionGross: number): { netMinor: number; vatMinor: number; grossMinor: number } {
  if (line.grossMinor === 0 || portionGross === 0) return { netMinor: 0, vatMinor: 0, grossMinor: 0 };
  if (portionGross === line.grossMinor) return { netMinor: line.netMinor, vatMinor: line.vatMinor, grossMinor: line.grossMinor };
  const vat = Number(divRoundHalfAwayFromZero(BigInt(line.vatMinor) * BigInt(portionGross), BigInt(line.grossMinor)));
  const net = line.netMinor + line.vatMinor === line.grossMinor ? portionGross - vat : Number(divRoundHalfAwayFromZero(BigInt(line.netMinor) * BigInt(portionGross), BigInt(line.grossMinor)));
  return { netMinor: net, vatMinor: vat, grossMinor: portionGross };
}

export interface RevenueNotes {
  corrections: { invoiceId: string; officialNumber: string | null; lineId: string; occurrenceId: string; occurrenceDate: string; serviceId: string; creditNoteId: string; creditDate: string; netMinor: number; vatMinor: number; grossMinor: number }[];
  excluded: { occurrenceId: string; occurrenceDate: string; serviceId: string | null; outcome: string; reason: string }[];
  unresolved: { occurrenceId: string; occurrenceDate: string; serviceId: string | null; outcome: string; detail: string | null; expectedGrossMinor: number | null }[];
  manualBilling: { occurrenceId: string; occurrenceDate: string; serviceId: string; grossMinor: number }[];
}

/**
 * Revenue facts: ONE economic item per occurrence (D10 precedence: issued /
 * awaiting-issue invoice line > Included draft line > F4 expected billing).
 * A credited invoice line is a revenue correction in its ORIGINAL month (D12):
 * it contributes 0, and the occurrence is not revived from a lower layer.
 */
export function revenueFacts(inp: Pick<MonthReportInputs, "invoices" | "invoiceLines" | "draftLines" | "billing">): { facts: RevenueFact[]; notes: RevenueNotes } {
  const facts: RevenueFact[] = [];
  const notes: RevenueNotes = { corrections: [], excluded: [], unresolved: [], manualBilling: [] };
  const invoices = new Map(inp.invoices.map((i) => [i.invoiceId, i]));
  const byInvoice = new Map<string, InvoiceLineInput[]>();
  for (const l of inp.invoiceLines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);
  const claimed = new Set<string>();
  const liveInvoiceOcc = new Map<string, string>();
  for (const [invoiceId, lines] of [...byInvoice.entries()].sort(byStr(([k]) => k))) {
    const inv = invoices.get(invoiceId);
    if (!inv) throw new MonthReportDataError(`invoice line(s) of ${invoiceId} have no invoice`);
    const live = lines.filter((l) => !l.creditNote).sort(byStr((l) => l.lineId));
    for (const l of lines) claimed.add(l.occurrenceId);
    for (const l of lines.filter((x) => x.creditNote)) {
      notes.corrections.push({ invoiceId, officialNumber: inv.officialNumber, lineId: l.lineId, occurrenceId: l.occurrenceId, occurrenceDate: l.occurrenceDate, serviceId: l.serviceId, creditNoteId: l.creditNote!.creditNoteId, creditDate: l.creditNote!.creditDate, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor });
    }
    for (const l of live) {
      const prior = liveInvoiceOcc.get(l.occurrenceId);
      if (prior) throw new MonthReportDataError(`occurrence ${l.occurrenceId} is on two live invoice lines (${prior}, ${l.lineId}) - the invoice data must be corrected first`);
      liveInvoiceOcc.set(l.occurrenceId, l.lineId);
    }
    const value = sum(live.map((l) => l.grossMinor));
    let actualByLine = new Map<string, number>();
    if (inv.issued) {
      if (value !== inv.grossMinor - inv.creditNotesMinor) throw new MonthReportDataError(`${invoiceId}: its uncredited lines (${m(value)}) do not equal the invoice less its credit notes (${m(inv.grossMinor - inv.creditNotesMinor)})`);
      const supported = Math.min(inv.cashReceivedMinor + inv.creditAppliedMinor, value);
      actualByLine = allocateProportionally(supported, live.map((l) => ({ id: l.lineId, weight: l.grossMinor })));
    }
    for (const l of live) {
      const a = proportionOfLine(l, actualByLine.get(l.lineId) ?? 0);
      const e = { netMinor: l.netMinor - a.netMinor, vatMinor: l.vatMinor - a.vatMinor, grossMinor: l.grossMinor - a.grossMinor };
      const source = { type: "invoice_line", invoiceId, officialNumber: inv.officialNumber, invoiceIssued: inv.issued, lineId: l.lineId, clientId: inv.clientId, client: inv.clientName, sessionId: l.sessionId, session: l.sessionName, lineGross: m(l.grossMinor) };
      const base = { side: "revenue" as const, month: monthOfDate(l.occurrenceDate), layer: "invoice" as const, serviceId: l.serviceId, occurrenceId: l.occurrenceId, date: l.occurrenceDate };
      if (a.grossMinor !== 0 || (l.grossMinor === 0 && inv.issued)) facts.push({ ...base, key: `rev:${l.lineId}:actual`, state: "actual", ...a, source: { ...source, portion: "received" } });
      if (e.grossMinor !== 0) facts.push({ ...base, key: `rev:${l.lineId}:expected`, state: "expected", ...e, source: { ...source, portion: inv.issued ? "not yet received" : "awaiting external issue" } });
    }
  }
  const draftByOcc = new Map<string, DraftLineInput>();
  for (const d of [...inp.draftLines].sort(byStr((x) => x.lineId))) {
    if (claimed.has(d.occurrenceId)) continue;
    if (draftByOcc.has(d.occurrenceId)) throw new MonthReportDataError(`occurrence ${d.occurrenceId} is Included on two draft lines (${draftByOcc.get(d.occurrenceId)!.lineId}, ${d.lineId}) - the drafts must be corrected first`);
    draftByOcc.set(d.occurrenceId, d);
  }
  for (const d of draftByOcc.values()) {
    claimed.add(d.occurrenceId);
    facts.push({ side: "revenue", key: `rev:${d.lineId}:draft`, month: monthOfDate(d.occurrenceDate), state: "expected", layer: "draft", serviceId: d.serviceId, occurrenceId: d.occurrenceId, date: d.occurrenceDate, netMinor: d.netMinor, vatMinor: d.vatMinor, grossMinor: d.grossMinor, source: { type: "draft_line", draftId: d.draftId, lineId: d.lineId, clientId: d.clientId, client: d.clientName, sessionId: d.sessionId, session: d.sessionName } });
  }
  const EXPECTED_STATUSES = new Set(["not_yet_delivered", "awaiting_confirmation"]);
  const EXCLUDED: Record<string, string> = {
    not_billable: "Marked not billable (F4)",
    commercially_inactive: "Service not commercially active on the date (F4)",
    deferred_revenue_model: "Not reportable from F4 (parent-paid / subscription / other charge)",
  };
  for (const b of [...inp.billing].sort(byStr((x) => x.occurrenceId))) {
    if (claimed.has(b.occurrenceId)) continue;
    claimed.add(b.occurrenceId);
    const base = { occurrenceId: b.occurrenceId, occurrenceDate: b.occurrenceDate, serviceId: b.serviceId };
    if (b.outcome === "eligible" || (b.outcome === "not_eligible" && b.eligibilityStatus !== null && EXPECTED_STATUSES.has(b.eligibilityStatus))) {
      if (!b.expected || !b.serviceId) {
        notes.unresolved.push({ ...base, outcome: b.outcome, detail: "no trustworthy expected value", expectedGrossMinor: null });
        continue;
      }
      const why = b.outcome === "eligible" ? "delivered, not yet invoiced" : b.eligibilityStatus === "awaiting_confirmation" ? "delivered, awaiting confirmation" : "scheduled, not yet delivered";
      facts.push({ side: "revenue", key: `rev:${b.occurrenceId}:billing`, month: monthOfDate(b.occurrenceDate), state: "expected", layer: "expected_billing", serviceId: b.serviceId, occurrenceId: b.occurrenceId, date: b.occurrenceDate, ...b.expected, source: { type: "expected_billing", outcome: b.outcome, eligibility: b.eligibilityStatus, why, manualBilling: b.billingMethod === "manual", clientId: b.clientId, client: b.clientName, sessionId: b.sessionId, session: b.sessionName } });
      if (b.billingMethod === "manual") notes.manualBilling.push({ occurrenceId: b.occurrenceId, occurrenceDate: b.occurrenceDate, serviceId: b.serviceId, grossMinor: b.expected.grossMinor });
      continue;
    }
    if (b.outcome === "not_eligible" && (b.eligibilityStatus === "cancelled" || b.eligibilityStatus === "postponed")) {
      notes.excluded.push({ ...base, outcome: b.outcome, reason: `Session ${b.eligibilityStatus}` });
      continue;
    }
    if (EXCLUDED[b.outcome]) {
      notes.excluded.push({ ...base, outcome: b.outcome, reason: b.outcome === "deferred_revenue_model" && b.deferral ? `${EXCLUDED[b.outcome]}: ${b.deferral}` : EXCLUDED[b.outcome] });
      continue;
    }
    notes.unresolved.push({ ...base, outcome: b.outcome, detail: b.detail ?? b.eligibilityStatus, expectedGrossMinor: b.expected ? b.expected.grossMinor : null });
  }
  return { facts, notes };
}

export interface CostNotes {
  unpricedCoachItems: { coach: string; workDate: string | null; session: string | null; workMonth: string }[];
}
/** Direct cost + overhead facts (D3-D6, F14 credit rule). */
export function costFacts(inp: Pick<MonthReportInputs, "today" | "coach" | "directShares" | "supplierCredits" | "overheadInstalments" | "employment">): { facts: (DirectFact | OverheadFact)[]; notes: CostNotes } {
  const facts: (DirectFact | OverheadFact)[] = [];
  const notes: CostNotes = { unpricedCoachItems: [] };
  for (const c of inp.coach) {
    if (c.amountMinor === null) {
      notes.unpricedCoachItems.push({ coach: c.coach.name, workDate: c.workDate, session: c.sessionName, workMonth: c.workMonth });
      continue;
    }
    const isCorrection = c.kind === "correction";
    facts.push({
      side: "direct",
      key: isCorrection ? `coach:${c.correctionId}` : `coach:${c.monthId ?? "open"}:${c.allocation}`,
      month: c.workMonth,
      state: c.kind === "live_item" ? "expected" : "actual",
      kind: "coach",
      adjustment: false,
      serviceId: isCorrection ? null : c.serviceId,
      label: isCorrection ? null : c.programmeLabel,
      date: c.workDate ?? `${c.workMonth}-01`,
      amountMinor: c.amountMinor,
      source: { type: isCorrection ? "coach_correction" : c.kind === "live_item" ? "coach_live_allocation" : "coach_finalised_item", coach: c.coach, monthId: c.monthId, monthState: c.monthState, correctionId: c.correctionId, allocation: c.allocation, occurrenceId: c.occurrenceId, session: c.sessionName, costBasis: c.costBasis, ...(isCorrection ? { unattributedReason: "F12 corrections stay with the Coach Month, not a programme" } : {}) },
    });
  }
  for (const s of inp.directShares) {
    const happened = s.occurrenceDate <= inp.today;
    facts.push({
      side: "direct",
      key: `share:${s.agreementId}:${s.occurrenceRef ?? s.occurrenceDate}:${s.sessionId ?? ""}`,
      month: monthOfDate(s.occurrenceDate),
      state: happened && !s.estimated ? "actual" : "expected",
      kind: s.supplierType === "venue" ? "venue" : "other_direct",
      adjustment: false,
      serviceId: s.serviceId,
      label: s.programmeLabel,
      date: s.occurrenceDate,
      amountMinor: s.amountMinor,
      source: { type: "supplier_profitability_share", supplierId: s.supplierId, supplier: s.supplierName, agreementId: s.agreementId, agreement: s.agreementName, occurrence: s.occurrenceRef, sessionId: s.sessionId, session: s.sessionName, estimated: s.estimated, why: s.estimated ? "agreement amount still estimated" : happened ? "frozen share, date has passed" : "frozen share, date still to come" },
    });
  }
  for (const c of inp.supplierCredits) {
    const month = monthOfDate(c.creditDate);
    const src = { type: "supplier_credit", creditId: c.creditId, supplierId: c.supplierId, supplier: c.supplierName, agreementId: c.agreementId, agreement: c.agreementName, scope: c.scope, creditDate: c.creditDate, credit: m(c.amountMinor), note: "Cost adjustment (credit) - the original gross cost is unchanged" };
    if (c.classification === "direct") {
      const kind: DirectKind = c.supplierType === "venue" ? "venue" : "other_direct";
      const rows = c.rows.filter((r) => r.amountMinor !== 0);
      const rest = c.amountMinor - sum(rows.map((r) => r.amountMinor));
      rows.forEach((r, k) => facts.push({ side: "direct", key: `credit:${c.creditId}:${k}`, month, state: "actual", kind, adjustment: true, serviceId: r.serviceId, label: r.programmeLabel, date: c.creditDate, amountMinor: r.amountMinor, source: { ...src, attributedSession: r.sessionId, attributedSessionDate: r.sessionDate } }));
      if (rest !== 0) facts.push({ side: "direct", key: `credit:${c.creditId}:rest`, month, state: "actual", kind, adjustment: true, serviceId: null, label: null, date: c.creditDate, amountMinor: rest, source: { ...src, unattributedReason: c.scope === "supplier" ? "supplier-only credit: no session attribution" : "credit not fully attributed to sessions" } });
      continue;
    }
    facts.push({
      side: "overhead",
      key: `credit:${c.creditId}`,
      month,
      state: "actual",
      kind: "supplier_credit",
      adjustment: true,
      category: c.classification === "general" ? c.category : null,
      uncategorisedReason: c.classification === null ? "supplier-wide credit (no agreement) cannot be categorised" : c.category ? null : "overhead agreement not categorised",
      date: c.creditDate,
      amountMinor: c.amountMinor,
      source: src,
    });
  }
  for (const i of inp.overheadInstalments) {
    facts.push({
      side: "overhead",
      key: `oh:${i.instalmentId}`,
      month: monthOfDate(i.dueDate),
      state: i.state === "estimated" ? "expected" : "actual",
      kind: "supplier_overhead",
      adjustment: false,
      category: i.category,
      uncategorisedReason: i.category ? null : "overhead agreement not categorised",
      date: i.dueDate,
      amountMinor: i.amountMinor,
      source: { type: "supplier_overhead_instalment", supplierId: i.supplierId, supplier: i.supplierName, agreementId: i.agreementId, agreement: i.agreementName, instalmentId: i.instalmentId, instalmentState: i.state, vatTreatment: i.vatTreatment, vatNote: "Recorded amount; no input-VAT recovery is modelled" },
    });
  }
  for (const e of inp.employment) {
    facts.push({
      side: "overhead",
      key: `emp:${e.employmentId}:${e.month}`,
      month: e.month,
      state: e.state === "estimated" ? "expected" : "actual",
      kind: "employment",
      adjustment: false,
      category: e.category,
      uncategorisedReason: e.category ? null : "employment category missing",
      date: `${e.month}-01`,
      amountMinor: e.amountMinor,
      source: { type: "employment_month", employmentId: e.employmentId, versionId: e.versionId, itemId: e.itemId, person: e.person, month: e.month, monthState: e.state, estimateLabel: e.state === "estimated" ? e.estimateLabel : null, note: "Salary is an overhead - never allocated to programmes" },
    });
  }
  return { facts, notes };
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------
export function stateLabel(states: readonly FactState[]): "Actual" | "Expected" | "Mixed" | "None" {
  const a = states.includes("actual");
  const e = states.includes("expected");
  return a && e ? "Mixed" : a ? "Actual" : e ? "Expected" : "None";
}
/** profit / revenue as a percentage with 2 dp (half away from zero); null (with why) when revenue is not positive. */
export function marginOf(numeratorMinor: number, revenueMinor: number): { percent: string | null; reason: string | null } {
  if (revenueMinor === 0) return { percent: null, reason: "no_net_revenue" };
  if (revenueMinor < 0) return { percent: null, reason: "net_revenue_negative" };
  const h = divRoundHalfAwayFromZero(BigInt(numeratorMinor) * 10000n, BigInt(revenueMinor));
  return { percent: hundredths(h), reason: null };
}
const hundredths = (h: bigint) => {
  const neg = h < 0n;
  const a = neg ? -h : h;
  return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
};
const pctToHundredths = (p: string) => BigInt(Math.round(Number(p) * 100));

interface RevTotals {
  grossMinor: number;
  vatMinor: number;
  netMinor: number;
}
const revTotals = (fs: readonly RevenueFact[]): RevTotals => ({ grossMinor: sum(fs.map((f) => f.grossMinor)), vatMinor: sum(fs.map((f) => f.vatMinor)), netMinor: sum(fs.map((f) => f.netMinor)) });
const revView = (t: RevTotals) => ({ gross: m(t.grossMinor), vat: m(t.vatMinor), net: m(t.netMinor) });
const costSplit = (fs: readonly (DirectFact | OverheadFact)[]) => {
  const gross = sum(fs.filter((f) => !f.adjustment).map((f) => f.amountMinor));
  const adj = sum(fs.filter((f) => f.adjustment).map((f) => f.amountMinor));
  return { grossMinor: gross, creditAdjustmentMinor: adj, netMinor: gross - adj };
};
const splitView = (s: ReturnType<typeof costSplit>) => ({ gross: m(s.grossMinor), creditAdjustment: m(s.creditAdjustmentMinor), net: m(s.netMinor) });

const revenueDetail = (f: RevenueFact) => ({ state: f.state, layer: f.layer, occurrenceId: f.occurrenceId, date: f.date, gross: m(f.grossMinor), vat: m(f.vatMinor), net: m(f.netMinor), source: f.source });
const costDetail = (f: DirectFact | OverheadFact) => ({ state: f.state, date: f.date, amount: m(f.amountMinor), effect: f.adjustment ? "credit_adjustment" : "cost", ...(f.side === "overhead" ? { category: f.category } : {}), source: f.source });

function programmeBlock(revenue: RevenueFact[], direct: DirectFact[]) {
  const rt = revTotals(revenue);
  const coach = direct.filter((f) => f.kind === "coach");
  const venue = costSplit(direct.filter((f) => f.kind === "venue"));
  const other = costSplit(direct.filter((f) => f.kind === "other_direct"));
  const coachMinor = sum(coach.map(signed));
  const directMinor = coachMinor + venue.netMinor + other.netMinor;
  const contribution = rt.netMinor - directMinor;
  return {
    totals: { rt, directMinor, contribution },
    view: {
      state: stateLabel([...revenue, ...direct].map((f) => f.state)),
      revenue: revView(rt),
      directCosts: { coach: m(coachMinor), venue: splitView(venue), otherDirect: splitView(other), total: m(directMinor) },
      contribution: m(contribution),
      margin: marginOf(contribution, rt.netMinor),
      detail: {
        revenueSources: revenue.sort(byStr((f) => `${f.date}|${f.key}`)).map(revenueDetail),
        coachCosts: coach.sort(byStr((f) => `${f.date}|${f.key}`)).map(costDetail),
        venueCosts: direct.filter((f) => f.kind === "venue").sort(byStr((f) => `${f.date}|${f.key}`)).map(costDetail),
        otherDirectCosts: direct.filter((f) => f.kind === "other_direct").sort(byStr((f) => `${f.date}|${f.key}`)).map(costDetail),
      },
    },
  };
}

export interface MonthFigures {
  month: string;
  mode: ReportMode;
  grossRevenueMinor: number;
  vatMinor: number;
  netRevenueMinor: number;
  directCostsMinor: number;
  contributionMinor: number;
  overheadsMinor: number;
  profitMinor: number;
}

/** One month in one mode: totals from the facts, programme / category views and the reconciliation proof. */
export function aggregateMonth(facts: readonly Fact[], month: string, mode: ReportMode, serviceLabels: Record<string, string>) {
  const sel = facts.filter((f) => f.month === month && (mode === "expected" || f.state === "actual"));
  const revenue = sel.filter((f): f is RevenueFact => f.side === "revenue");
  const direct = sel.filter((f): f is DirectFact => f.side === "direct");
  const overhead = sel.filter((f): f is OverheadFact => f.side === "overhead");
  // overall - from the facts
  const rt = revTotals(revenue);
  const directMinor = sum(direct.map(signed));
  const overheadsMinor = sum(overhead.map(signed));
  const contribution = rt.netMinor - directMinor;
  const profit = contribution - overheadsMinor;
  // programmes - grouped by stable Finance Service ID (never a name)
  const ids = [...new Set([...revenue.map((f) => f.serviceId), ...direct.map((f) => f.serviceId)].filter((x): x is string => x !== null))].sort();
  const programmes = ids.map((id) => {
    const p = programmeBlock(revenue.filter((f) => f.serviceId === id), direct.filter((f) => f.serviceId === id));
    const labels = [...new Set([...direct.filter((f) => f.serviceId === id).map((f) => f.label)].filter((x): x is string => !!x))].sort();
    return { totals: p.totals, view: { financeServiceId: id, label: serviceLabels[id] ?? labels[0] ?? id, otherLabels: labels.filter((l) => l !== serviceLabels[id]), resolved: true, ...p.view } };
  });
  const un = programmeBlock([], direct.filter((f) => f.serviceId === null));
  const unattributed = { financeServiceId: null, label: "Unattributed", resolved: false, reason: "No stable Finance Service ID on the source - shown here, never guessed from names", ...un.view };
  // overheads - grouped by category id
  const catIds = [...new Set(overhead.filter((f) => f.category).map((f) => f.category!.categoryId))].sort();
  const categories = catIds.map((id) => {
    const fs = overhead.filter((f) => f.category?.categoryId === id);
    const s = costSplit(fs);
    return { minor: s.netMinor, view: { categoryId: id, name: fs[0].category!.name, state: stateLabel(fs.map((f) => f.state)), ...splitView(s), items: fs.sort(byStr((f) => `${f.date}|${f.key}`)).map(costDetail) } };
  });
  const unc = overhead.filter((f) => !f.category);
  const uncSplit = costSplit(unc);
  const uncategorised = { categoryId: null, name: "Uncategorised", state: stateLabel(unc.map((f) => f.state)), reasons: [...new Set(unc.map((f) => f.uncategorisedReason).filter((x): x is string => !!x))].sort(), ...splitView(uncSplit), items: unc.sort(byStr((f) => `${f.date}|${f.key}`)).map(costDetail) };
  // reconciliation - every equation recomputed from the grouped views
  const progNet = sum(programmes.map((p) => p.totals.rt.netMinor)) + un.totals.rt.netMinor;
  const progGross = sum(programmes.map((p) => p.totals.rt.grossMinor)) + un.totals.rt.grossMinor;
  const progVat = sum(programmes.map((p) => p.totals.rt.vatMinor)) + un.totals.rt.vatMinor;
  const progDirect = sum(programmes.map((p) => p.totals.directMinor)) + un.totals.directMinor;
  const catTotal = sum(categories.map((c) => c.minor)) + uncSplit.netMinor;
  const eq = (name: string, left: number, right: number) => ({ equation: name, left: m(left), right: m(right), holds: left === right });
  const equations = [
    eq("sum programme Net Revenue + unattributed Net Revenue = overall Net Revenue", progNet, rt.netMinor),
    eq("sum programme Gross Revenue + unattributed = overall Gross Revenue", progGross, rt.grossMinor),
    eq("sum programme VAT + unattributed = overall VAT", progVat, rt.vatMinor),
    eq("Gross Revenue - VAT = Net Revenue", rt.grossMinor - rt.vatMinor, rt.netMinor),
    eq("sum programme Direct Costs + unattributed Direct Costs = overall Direct Costs", progDirect, directMinor),
    eq("sum overhead categories + uncategorised = overall Overheads", catTotal, overheadsMinor),
    eq("Net Revenue - Direct Costs = Programme Contribution", rt.netMinor - directMinor, contribution),
    eq("Net Revenue - Direct Costs - Overheads = Final Business Profit", rt.netMinor - directMinor - overheadsMinor, profit),
  ];
  const figures: MonthFigures = { month, mode, grossRevenueMinor: rt.grossMinor, vatMinor: rt.vatMinor, netRevenueMinor: rt.netMinor, directCostsMinor: directMinor, contributionMinor: contribution, overheadsMinor, profitMinor: profit };
  return {
    figures,
    state: stateLabel(sel.map((f) => f.state)),
    overall: {
      grossRevenue: m(rt.grossMinor),
      vat: m(rt.vatMinor),
      netRevenue: m(rt.netMinor),
      directCosts: m(directMinor),
      programmeContribution: m(contribution),
      overheads: m(overheadsMinor),
      finalBusinessProfit: m(profit),
      finalMargin: marginOf(profit, rt.netMinor),
    },
    programmes: programmes.map((p) => p.view),
    unattributed,
    overheads: { total: m(overheadsMinor), categories: categories.map((c) => c.view), uncategorised },
    reconciliation: { equations, allHold: equations.every((e) => e.holds), rule: "Every total is summed from the facts; programme and category sums are summed separately and checked - there is no balancing line" },
    factCounts: { revenue: revenue.length, directCosts: direct.length, overheads: overhead.length },
  };
}

/** Previous-month comparison for the key metrics only (no narrative). */
export function comparisonOf(cur: MonthFigures, prev: MonthFigures) {
  const money = (c: number, p: number) => ({
    current: m(c),
    previous: m(p),
    change: m(c - p),
    changePercent: p === 0 ? null : hundredths(divRoundHalfAwayFromZero(BigInt(c - p) * 10000n, BigInt(Math.abs(p)))),
    changePercentReason: p === 0 ? "previous_month_zero" : null,
  });
  const cm = marginOf(cur.profitMinor, cur.netRevenueMinor);
  const pm = marginOf(prev.profitMinor, prev.netRevenueMinor);
  return {
    previousMonth: prev.month,
    mode: cur.mode,
    netRevenue: money(cur.netRevenueMinor, prev.netRevenueMinor),
    finalBusinessProfit: money(cur.profitMinor, prev.profitMinor),
    finalMargin: {
      current: cm.percent,
      previous: pm.percent,
      changePercentagePoints: cm.percent !== null && pm.percent !== null ? hundredths(pctToHundredths(cm.percent) - pctToHundredths(pm.percent)) : null,
      reason: cm.percent === null ? `current_${cm.reason}` : pm.percent === null ? `previous_${pm.reason}` : null,
    },
    narrative: null,
  };
}

// ---------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------
export interface CompletenessItem {
  code: string;
  severity: "incomplete" | "info";
  message: string;
  count?: number;
  amount?: string;
  detail?: unknown;
}
function completenessOf(inp: MonthReportInputs, month: string, mode: ReportMode, rev: RevenueNotes, cost: CostNotes, facts: readonly Fact[]) {
  const inMonth = <T extends { occurrenceDate?: string; date?: string; workMonth?: string }>(x: T) => (x.workMonth ?? monthOfDate(x.occurrenceDate ?? x.date ?? "")) === month;
  const items: CompletenessItem[] = [];
  const pr = inp.parentRevenue;
  if (pr.status === "not_connected") items.push({ code: "parent_stripe_revenue_not_included", severity: "info", message: "Parent / Stripe revenue: Not included in report totals (no subscription / charge to Finance Service or VAT mapping yet). Stripe is not connected, so no excluded amount can be shown." });
  else if (pr.status === "unavailable") items.push({ code: "parent_stripe_revenue_not_included", severity: "incomplete", message: "Parent / Stripe revenue: Not included in report totals, and Stripe could not be read just now to show the excluded amount", detail: pr.detail });
  else if ((pr.grossMinor ?? 0) > 0) items.push({ code: "parent_stripe_revenue_excluded", severity: "incomplete", message: "Parent / Stripe revenue: Not included in report totals (no subscription / charge to Finance Service or VAT mapping yet). The amount shown is Stripe succeeded charges by charge date - informational only", count: pr.receipts ?? 0, amount: m(pr.grossMinor ?? 0) });
  else items.push({ code: "parent_stripe_revenue_not_included", severity: "info", message: "Parent / Stripe revenue: Not included in report totals; Stripe shows no succeeded charges in this month", count: 0, amount: "0.00" });
  const un = rev.unresolved.filter(inMonth);
  if (un.length) items.push({ code: "revenue_unresolved", severity: mode === "expected" ? "incomplete" : "info", message: "Client-paid sessions whose revenue cannot be resolved (missing terms / service, unresolved delivery, configuration) - not in any figure, never guessed", count: un.length, detail: un.map((u) => ({ occurrenceId: u.occurrenceId, date: u.occurrenceDate, serviceId: u.serviceId, outcome: u.outcome, detail: u.detail, expectedGross: u.expectedGrossMinor === null ? null : m(u.expectedGrossMinor) })) });
  const unlinked = inp.unlinkedOccurrences.filter((o) => monthOfDate(o.date) === month);
  if (unlinked.length) items.push({ code: "sessions_without_finance_service", severity: "info", message: "Sessions in this month whose Session has no Finance Service ID - no client revenue can be expected for them (parent-paid sessions are expected here)", count: unlinked.length });
  const mb = rev.manualBilling.filter(inMonth);
  if (mb.length) items.push({ code: "manual_billing_expected_only", severity: "info", message: "Manual Billing work stays Expected: there is no trusted receipt linkage that could make it Actual", count: mb.length, amount: m(sum(mb.map((x) => x.grossMinor))) });
  const ex = rev.excluded.filter(inMonth);
  if (ex.length) items.push({ code: "revenue_excluded_by_rule", severity: "info", message: "Sessions excluded by the F4 rules (cancelled / postponed / not billable / inactive / not reportable model)", count: ex.length, detail: ex.map((x) => ({ occurrenceId: x.occurrenceId, date: x.occurrenceDate, reason: x.reason })) });
  const cor = rev.corrections.filter(inMonth);
  if (cor.length) items.push({ code: "revenue_corrections", severity: "info", message: "Credit notes corrected revenue in this (original) month - a revenue correction, never an overhead", count: cor.length, amount: m(sum(cor.map((c) => c.grossMinor))) });
  const unpriced = cost.unpricedCoachItems.filter(inMonth);
  if (unpriced.length) items.push({ code: "coach_cost_unpriced", severity: mode === "expected" ? "incomplete" : "info", message: "Open Coach Month work items whose cost cannot be priced yet - not in Expected Direct Costs, never 0.00", count: unpriced.length });
  const drift = inp.coachMonthsNeedingCorrection.filter((x) => x.workMonth === month);
  if (drift.length) items.push({ code: "coach_month_correction_required", severity: "info", message: "Finalised Coach Months whose live work now differs - the report uses the finalised snapshot + corrections (F12)", count: drift.length, detail: drift });
  if (inp.unresolvedDirectAgreements.length) items.push({ code: "direct_agreements_unresolved", severity: mode === "expected" ? "incomplete" : "info", message: "Direct supplier agreements with no resolved sessions - no profitability share in any month", count: inp.unresolvedDirectAgreements.length, detail: inp.unresolvedDirectAgreements.map((a) => ({ agreementId: a.agreementId, agreement: a.agreementName, supplier: a.supplierName, total: m(a.totalMinor) })) });
  const sel = facts.filter((f) => f.month === month && (mode === "expected" || f.state === "actual"));
  const unRev = sel.filter((f) => f.side === "direct" && (f as DirectFact).serviceId === null);
  if (unRev.length) items.push({ code: "direct_cost_unattributed", severity: "info", message: "Direct costs without a stable Finance Service ID are shown as Unattributed (never guessed)", count: unRev.length });
  const unc = sel.filter((f) => f.side === "overhead" && !(f as OverheadFact).category);
  if (unc.length) items.push({ code: "overhead_uncategorised", severity: "info", message: "Overheads / credits without a category are shown as Uncategorised", count: unc.length });
  const negSupplier = sel.filter((f) => (f.side === "direct" || f.side === "overhead") && (f as DirectFact).adjustment).length;
  if (negSupplier) items.push({ code: "supplier_credit_adjustments", severity: "info", message: "Supplier credits are cost adjustments dated when recorded; a month can show negative net supplier cost - that is a credit, not an error", count: negSupplier });
  items.push({ code: "cost_vat_basis", severity: "info", message: "Costs are reported at their recorded amount with the known VAT treatment; no input-VAT recovery is modelled (F18 v1)" });
  return { complete: !items.some((i) => i.severity === "incomplete"), mode, items };
}

// ---------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------
export function buildFacts(inp: MonthReportInputs) {
  const r = revenueFacts(inp);
  const c = costFacts(inp);
  return { facts: [...r.facts, ...c.facts] as Fact[], revenueNotes: r.notes, costNotes: c.notes };
}

export function buildMonthReport(inp: MonthReportInputs, mode: ReportMode, meta: { generatedAt: string; organisationName: string | null }) {
  const { facts, revenueNotes, costNotes } = buildFacts(inp);
  const prev = previousMonth(inp.month);
  const cur = aggregateMonth(facts, inp.month, mode, inp.serviceLabels);
  const pre = aggregateMonth(facts, prev, mode, inp.serviceLabels);
  const completeness = completenessOf(inp, inp.month, mode, revenueNotes, costNotes, facts);
  if (!cur.reconciliation.allHold) completeness.items.push({ code: "reconciliation_failed", severity: "incomplete", message: "The report does not reconcile - see reconciliation.equations" });
  const modeLabel = mode === "actual" ? "Actual" : "Expected + Actual";
  return {
    month: inp.month,
    mode,
    modeLabel,
    state: cur.state,
    previousMonth: prev,
    generatedAt: meta.generatedAt,
    basis: {
      economicMonth: "Revenue and direct costs belong to the session (occurrence / work) date's month; supplier overheads to the instalment due month; salaries to the employment month; supplier credits to the credit date; credit notes to the original line's month",
      actual: "Revenue: the trusted-receipt portion of an issued invoice line. Coach: finalised Coach Months + corrections. Venue / direct supplier: a confirmed share whose date has passed. Overheads: Confirmed / Partially Paid / Paid. Employment: Confirmed / Paid. Supplier credits: Actual in their credit month",
      expected: mode === "expected" ? "Adds unpaid invoice portions, draft lines, F4 expected billing (delivered / scheduled client-paid sessions, Manual Billing), open-month coach cost, estimated or future venue shares, estimated overheads and employment - one item per occurrence (invoice > draft > F4)" : "Not shown (Actual only)",
      cashDates: "Never used for reporting attribution - a receipt changes a line's state, never its month (Cash Flow owns cash timing)",
    },
    overall: cur.overall,
    comparison: comparisonOf(cur.figures, pre.figures),
    programmes: cur.programmes,
    unattributed: cur.unattributed,
    overheads: cur.overheads,
    revenueCorrections: revenueNotes.corrections
      .filter((c) => monthOfDate(c.occurrenceDate) === inp.month)
      .map((c) => ({ invoiceId: c.invoiceId, officialNumber: c.officialNumber, lineId: c.lineId, occurrenceId: c.occurrenceId, occurrenceDate: c.occurrenceDate, financeServiceId: c.serviceId, creditNoteId: c.creditNoteId, creditDate: c.creditDate, gross: m(c.grossMinor), vat: m(c.vatMinor), net: m(c.netMinor), treatment: "Revenue correction in the original month (not an overhead)" })),
    reconciliation: cur.reconciliation,
    completeness,
    excluded: {
      parentStripeRevenue: { includedInTotals: false, label: "Parent / Stripe revenue: Not included in report totals", status: inp.parentRevenue.status, grossReceived: inp.parentRevenue.grossMinor === null ? null : m(inp.parentRevenue.grossMinor), receipts: inp.parentRevenue.receipts, reason: "No safe subscription / charge to Finance Service mapping and no authoritative VAT mapping yet (Stripe remains the payment authority)" },
    },
    exportMetadata: {
      title: `Month Report - ${inp.month}`,
      month: inp.month,
      stateLabel: modeLabel,
      organisation: { organisationId: inp.organisationId, name: meta.organisationName },
      sections: ["business summary", "programme breakdown", "overhead breakdown"],
      managementNotes: { supported: false, note: "Management Notes have no storage model yet - future Month Report / export work" },
      footer: "Prepared from Hub finance records",
      exportedAt: null,
      pdf: { generated: false, note: "Month Report PDF generation is later reporting / UI work (F22 is invoice PDF)" },
    },
    _figures: { current: cur.figures, previous: pre.figures },
  };
}

// ---------------------------------------------------------------------
// Upcoming Payments (D8) - existing source truth only, never a new ledger
// ---------------------------------------------------------------------
export interface UpcomingInputs {
  today: string;
  instalments: { instalmentId: string; agreementId: string; supplierId: string; supplierName: string; dueDate: string; state: string; remainingMinor: number; cancelled: boolean }[];
  employment: { employmentId: string; month: string; person: string; expectedPaymentDate: string; state: string; amountDueMinor: number; paidMinor: number }[];
  coachMonths: { monthId: string; coach: string; workMonth: string; expectedPaymentDate: string; amountMinor: number }[];
}
export function upcomingPayments(u: UpcomingInputs) {
  const to = addDays(u.today, UPCOMING_WINDOW_DAYS - 1);
  type Item = { sourceType: string; sourceId: string; payee: string; dueDate: string; amountMinor: number; overdue: boolean; state: string; route: string };
  const items: Item[] = [];
  for (const i of u.instalments) {
    if (i.cancelled || (i.state !== "confirmed" && i.state !== "partially_paid") || i.remainingMinor <= 0 || i.dueDate > to) continue;
    items.push({ sourceType: "supplier_instalment", sourceId: i.instalmentId, payee: i.supplierName, dueDate: i.dueDate, amountMinor: i.remainingMinor, overdue: i.dueDate < u.today, state: i.state, route: `GET /finance/supplier-instalments/${i.instalmentId}` });
  }
  for (const e of u.employment) {
    if (e.state !== "confirmed" || e.paidMinor > 0 || e.expectedPaymentDate > to) continue;
    items.push({ sourceType: "employment_month", sourceId: `${e.employmentId}/${e.month}`, payee: e.person, dueDate: e.expectedPaymentDate, amountMinor: e.amountDueMinor, overdue: e.expectedPaymentDate < u.today, state: e.state, route: `GET /finance/employment-costs/${e.employmentId}` });
  }
  for (const c of u.coachMonths) {
    // F12 has no Paid lifecycle: a past Coach Month is never "overdue", only today / future finalised months are listed.
    if (c.expectedPaymentDate < u.today || c.expectedPaymentDate > to) continue;
    items.push({ sourceType: "coach_month", sourceId: c.monthId, payee: c.coach, dueDate: c.expectedPaymentDate, amountMinor: c.amountMinor, overdue: false, state: "finalised", route: `GET /finance/coach-summaries/${c.monthId}` });
  }
  items.sort(byStr((x) => `${x.dueDate}|${x.sourceType}|${x.sourceId}`));
  const view = (xs: Item[]) => ({ count: xs.length, total: m(sum(xs.map((x) => x.amountMinor))) });
  const overdue = items.filter((x) => x.overdue);
  const upcoming = items.filter((x) => !x.overdue);
  return {
    window: { from: u.today, to, days: UPCOMING_WINDOW_DAYS, rule: "Confirmed outgoing overdue + due from today through today + 13 days" },
    overdue: view(overdue),
    upcoming: view(upcoming),
    total: view(items),
    items: items.slice(0, 20).map((x) => ({ ...x, amount: m(x.amountMinor), amountMinor: undefined })),
    moreItems: Math.max(0, items.length - 20),
    notIncluded: "Estimated supplier / employment costs stay estimate-review work and Cash Flow forecast items; open Coach Months are not confirmed payments; past Coach Months are never called overdue (no F12 Paid lifecycle)",
  };
}

// ---------------------------------------------------------------------
// Routes + query (GET only; the organisation is never chosen in the request)
// ---------------------------------------------------------------------
export type MonthReportRoute = { name: "month.report" } | { name: "finance.overview" };
export type MonthReportMatch = { status: "ok"; route: MonthReportRoute } | { status: "method"; allowed: string[] };
export function matchMonthReportRoute(path: string, method: string): MonthReportMatch | null {
  const table: Record<string, MonthReportRoute> = { "month-report": { name: "month.report" }, "overview": { name: "finance.overview" } };
  const hit = table[path];
  if (!hit) return null;
  return method === "GET" ? { status: "ok", route: hit } : { status: "method", allowed: ["GET"] };
}
export type MRInvalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const mrInvalid = (code: string, error: string, fields?: Record<string, string>): MRInvalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
export function parseMonthReportQuery(route: MonthReportRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true; month?: string; mode: ReportMode } | MRInvalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return mrInvalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const allowed = route === "month.report" ? ["month", "mode"] : ["month"];
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return mrInvalid("unexpected_query", `Unexpected query parameter(s): ${[...new Set(extra)].join(", ")}${route === "finance.overview" && extra.includes("mode") ? " - Finance Overview is Actual only" : ""}`);
  if (keys.length !== new Set(keys).size) return mrInvalid("invalid_query", "Each query parameter may be given once");
  const fields: Record<string, string> = {};
  const month = q.get("month") ?? undefined;
  if (month !== undefined) {
    const mm = MONTH_RE.exec(month);
    if (!mm || Number(mm[1]) < 2000 || Number(mm[1]) > 2100) fields.month = "must be a calendar month YYYY-MM (2000-2100)";
  }
  const mode = (q.get("mode") ?? "actual") as ReportMode;
  if (!(REPORT_MODES as readonly string[]).includes(mode)) fields.mode = `must be one of ${REPORT_MODES.join(", ")}`;
  if (Object.keys(fields).length) return mrInvalid("invalid_query", "Invalid query", fields);
  return { ok: true, month, mode };
}
