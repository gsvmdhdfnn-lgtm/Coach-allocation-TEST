/**
 * Suppliers / venues / outgoing agreements + payment schedules - pure logic
 * (Finance Foundation F13; see TEST-ENV.md "Finance Foundation - F13").
 *
 * One reusable supplier structure for venues, contractors / consultants,
 * software / service providers and any other non-Coach supplier. A supplier
 * record answers four questions: what are we getting (agreement), what are we
 * paying (cost + schedule), when (instalments), who (contact) - then shows the
 * payment history.
 *
 *   Supplier  ->  Agreement (effective-dated; a change is a NEW version)
 *             ->  Instalments (the cash schedule: due date, planned amount,
 *                 estimated / confirmed, paid, remaining, cancelled)
 *             ->  Payments (Management-confirmed money out; never bank truth)
 *
 * Two separate calculations, never mixed:
 *   - PROFITABILITY: a direct agreement's total is spread equally across the
 *     ORIGINALLY agreed relevant occurrences (frozen at agreement time). A
 *     later cancellation does not redistribute it; only an explicit new
 *     agreement version changes it.
 *   - CASH TIMING: the instalments' own due dates and amounts.
 *
 * Money is integer pence. Nothing here builds supplier credits (F14),
 * overheads / salaries (F15), Cash Flow or a Month Report. Remaining balance
 * is computed in ONE place (remainingOf) so F14 can later subtract applied
 * credits there.
 */
import { REASON_MAX, auditEvent } from "./finance-commercial.ts";
import { VAT_TREATMENTS, divRoundHalfAwayFromZero, formatMinor, parseMoney } from "./finance-money.ts";

export const SUPPLIER_CONTRACT = "finance-suppliers-v1";

export const SUPPLIER_ID_RE = /^FSU-[0-9A-F]{12}$/;
export const AGREEMENT_ID_RE = /^FSA-[0-9A-F]{12}$/;
export const INSTALMENT_ID_RE = /^FSI-[0-9A-F]{12}$/;
export const PAYMENT_ID_RE = /^FSP-[0-9A-F]{12}$/;
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const SERVICE_ID_RE = /^FSV-[0-9A-F]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

export const MAX_INSTALMENTS = 120;
export const MAX_LINKED_SESSIONS = 20;
export const MAX_ALLOCATED_OCCURRENCES = 500;
export const MAX_FACT_MONTHS = 12;
const MAX_HOURS_HUNDREDTHS = 74_400; // 744 h = a 31-day month

export const SUPPLIER_TYPES = ["venue", "contractor", "software_service", "other"] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];
export const SUPPLIER_TYPE_LABELS: Record<SupplierType, string> = {
  venue: "Venue",
  contractor: "Contractor / Consultant",
  software_service: "Software / Service",
  other: "Other Supplier",
};
export const COST_TYPES = ["fixed", "hourly", "one_off", "scheduled", "custom_dates"] as const;
export type CostType = (typeof COST_TYPES)[number];
export const COST_TYPE_LABELS: Record<CostType, string> = {
  fixed: "Fixed amount per period",
  hourly: "Hourly / variable (expected hours, confirmed monthly)",
  one_off: "One-off",
  scheduled: "Scheduled future payment",
  custom_dates: "Custom-date schedule",
};
export const FREQUENCIES = ["monthly", "quarterly", "annually", "custom_dates"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
const FREQUENCY_MONTHS: Record<"monthly" | "quarterly" | "annually", number> = { monthly: 1, quarterly: 3, annually: 12 };
export const CLASSIFICATIONS = ["direct", "general"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  direct: "Direct cost (exists because sessions / a programme are delivered)",
  general: "General cost (not attributed to sessions)",
};
export const PAYMENT_METHODS = ["bank_transfer", "card", "direct_debit", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const INSTALMENT_STATES = ["estimated", "confirmed", "partially_paid", "paid", "cancelled"] as const;
export type InstalmentState = (typeof INSTALMENT_STATES)[number];
export const INSTALMENT_STATE_LABELS: Record<InstalmentState, string> = {
  estimated: "Estimated",
  confirmed: "Confirmed",
  partially_paid: "Partially Paid",
  paid: "Paid",
  cancelled: "Cancelled",
};
/** Occurrence statuses that were never "agreed relevant sessions" when the agreement was made. */
export const EXCLUDED_OCCURRENCE_STATUSES = ["Cancelled", "Postponed"] as const;

export const EVENTS = {
  supplierCreated: "finance_supplier.created",
  supplierUpdated: "finance_supplier.updated",
  agreementCreated: "finance_supplier_agreement.created",
  agreementVersioned: "finance_supplier_agreement.versioned",
  instalmentCreated: "finance_supplier_instalment.created",
  estimateConfirmed: "finance_supplier_instalment.estimate_confirmed",
  moved: "finance_supplier_instalment.moved",
  split: "finance_supplier_instalment.split",
  partiallyPaid: "finance_supplier_instalment.partially_paid",
  paid: "finance_supplier_instalment.paid",
  cancelled: "finance_supplier_instalment.cancelled",
} as const;
export const ENTITY = { supplier: "finance_supplier", agreement: "finance_supplier_agreement", instalment: "finance_supplier_instalment" } as const;

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------
export interface Supplier {
  organisationId: string;
  supplierId: string;
  name: string;
  supplierType: SupplierType;
  active: boolean;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  vatTreatment: string | null;
  notes: string | null;
  venueRecordId: string | null;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
export interface Agreement {
  organisationId: string;
  agreementId: string;
  supplierId: string;
  supersedesAgreementId: string | null;
  name: string;
  description: string | null;
  costType: CostType;
  frequency: Frequency | null;
  classification: Classification;
  effectiveFrom: string;
  effectiveUntil: string | null;
  amountMinor: number | null;
  hourlyRateMinor: number | null;
  expectedMonthlyHoursHundredths: number | null;
  amountIsEstimate: boolean;
  instalmentCount: number;
  totalPlannedMinor: number;
  linkSessionIds: string[];
  linkFinanceServiceId: string | null;
  linkState: "linked" | "unresolved" | "not_applicable";
  allocationCount: number;
  sourceDocumentRef: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: string;
}
export interface Allocation {
  organisationId: string;
  agreementId: string;
  occurrenceRecordId: string;
  occurrenceRef: string | null;
  occurrenceDate: string;
  statusAtAgreement: string | null;
  sessionRecordId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  financeServiceId: string | null;
  programmeLabel: string | null;
  allocatedMinor: number;
}
export interface Instalment {
  organisationId: string;
  instalmentId: string;
  agreementId: string;
  supplierId: string;
  sequence: number;
  originalDueDate: string;
  dueDate: string;
  plannedMinor: number;
  amountDueMinor: number;
  amountState: "estimated" | "confirmed";
  paidMinor: number;
  splitFromInstalmentId: string | null;
  note: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  createdAt: string;
  createdBy: string;
}
export interface Payment {
  organisationId: string;
  paymentId: string;
  instalmentId: string;
  agreementId: string;
  supplierId: string;
  amountMinor: number;
  paidDate: string;
  method: PaymentMethod | null;
  reference: string | null;
  note: string | null;
  remainingAfterMinor: number;
  recordedAt: string;
  recordedBy: string;
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
export const m = (minor: number) => formatMinor(minor);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export function newId(prefix: "FSU" | "FSA" | "FSI" | "FSP", random: () => string = () => crypto.randomUUID()): string {
  return `${prefix}-${random().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}
export function isRealDate(v: unknown): v is string {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
/** date + n months, keeping the ANCHOR day where the month has it (31 Jan + 1 -> 28/29 Feb, + 2 -> 31 Mar). */
export function addMonthsAnchored(anchor: string, n: number): string {
  const y = Number(anchor.slice(0, 4));
  const mo = Number(anchor.slice(5, 7));
  const d = Number(anchor.slice(8, 10));
  const idx = y * 12 + (mo - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, daysIn(ny, nm))).padStart(2, "0")}`;
}
export function monthBounds(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  return { from: `${month}-01`, to: `${month}-${String(daysIn(y, mo)).padStart(2, "0")}` };
}
function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}
/** Hours with at most 2 decimals, as hundredths (e.g. "12.5" -> 1250). */
export function hoursToHundredths(v: unknown): number | null {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : null;
  if (s === null || !/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [a, b = ""] = s.split(".");
  const h = Number(a) * 100 + Number(b.padEnd(2, "0"));
  return h > 0 && h <= MAX_HOURS_HUNDREDTHS ? h : null;
}
const hoursText = (h: number) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;
/** rate x hours, half away from zero, in pence. */
export function hourlyEstimate(rateMinor: number, hoursHundredths: number): number {
  return Number(divRoundHalfAwayFromZero(BigInt(rateMinor) * BigInt(hoursHundredths), 100n));
}

// ---------------------------------------------------------------------
// Instalment state - the only place remaining balance is computed.
// ---------------------------------------------------------------------
/** What is still owed on an instalment. F14 will subtract applied supplier credits HERE. */
export function remainingOf(i: Instalment): number {
  return i.cancelledAt ? 0 : i.amountDueMinor - i.paidMinor;
}
export function stateOf(i: Instalment): InstalmentState {
  if (i.cancelledAt) return "cancelled";
  if (i.amountState === "estimated") return "estimated";
  if (i.paidMinor === 0) return "confirmed";
  return remainingOf(i) === 0 ? "paid" : "partially_paid";
}
export const isOverdue = (i: Instalment, today: string) => remainingOf(i) > 0 && i.dueDate < today;

// ---------------------------------------------------------------------
// Schedule generation (cash timing)
// ---------------------------------------------------------------------
export interface CustomInstalmentInput {
  dueDate: string;
  amountMinor: number;
  estimated: boolean;
  note: string | null;
}
export interface AgreementSpec {
  name: string;
  description: string | null;
  costType: CostType;
  frequency: Frequency | null;
  classification: Classification;
  effectiveFrom: string;
  effectiveUntil: string | null;
  amountMinor: number | null;
  hourlyRateMinor: number | null;
  expectedMonthlyHoursHundredths: number | null;
  amountIsEstimate: boolean;
  firstDueDate: string | null;
  instalmentCount: number | null;
  customInstalments: CustomInstalmentInput[];
  sessionIds: string[];
  financeServiceId: string | null;
  sourceDocumentRef: string | null;
  reason: string | null;
}
export interface PlannedInstalment {
  sequence: number;
  dueDate: string;
  plannedMinor: number;
  estimated: boolean;
  note: string | null;
}
export type Refusal = { ok: false; httpStatus: 400 | 404 | 409; code: string; error: string };
const refuse = (httpStatus: 400 | 404 | 409, code: string, error: string): Refusal => ({ ok: false, httpStatus, code, error });

/** The cash schedule an agreement creates. `today` only matters for a "scheduled" (future) payment. */
export function generateSchedule(s: AgreementSpec, today: string): { ok: true; instalments: PlannedInstalment[] } | Refusal {
  if (s.costType === "custom_dates") {
    const rows = [...s.customInstalments].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
    return { ok: true, instalments: rows.map((r, k) => ({ sequence: k + 1, dueDate: r.dueDate, plannedMinor: r.amountMinor, estimated: r.estimated, note: r.note })) };
  }
  if (s.costType === "one_off" || s.costType === "scheduled") {
    if (s.costType === "scheduled" && (s.firstDueDate as string) <= today) return refuse(400, "invalid_input", "A scheduled future payment must be due after today (use one-off for a payment due now)");
    return { ok: true, instalments: [{ sequence: 1, dueDate: s.firstDueDate as string, plannedMinor: s.amountMinor as number, estimated: s.amountIsEstimate, note: null }] };
  }
  const step = FREQUENCY_MONTHS[s.frequency as "monthly" | "quarterly" | "annually"];
  const perPeriod = s.costType === "hourly" ? hourlyEstimate(s.hourlyRateMinor as number, s.expectedMonthlyHoursHundredths as number) : (s.amountMinor as number);
  if (perPeriod <= 0) return refuse(400, "invalid_input", "The expected amount per period works out at 0.00");
  const estimated = s.costType === "hourly" ? true : s.amountIsEstimate;
  const out: PlannedInstalment[] = [];
  for (let k = 0; ; k++) {
    const due = addMonthsAnchored(s.firstDueDate as string, k * step);
    if (s.instalmentCount !== null ? k >= s.instalmentCount : due > (s.effectiveUntil as string)) break;
    if (out.length >= MAX_INSTALMENTS) return refuse(400, "invalid_input", `An agreement may create at most ${MAX_INSTALMENTS} instalments - shorten it or use a later version`);
    out.push({ sequence: k + 1, dueDate: due, plannedMinor: perPeriod, estimated, note: null });
  }
  if (!out.length) return refuse(400, "invalid_input", "The schedule has no instalment: the first due date is after the agreement ends");
  return { ok: true, instalments: out };
}

// ---------------------------------------------------------------------
// Profitability (direct cost) - frozen at agreement time
// ---------------------------------------------------------------------
/** Equal split in pence; the leftover pennies go to the earliest occurrences, so the parts always add up exactly. */
export function spreadEvenly(totalMinor: number, n: number): number[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || !Number.isSafeInteger(n) || n <= 0) throw new Error("spreadEvenly: bad input");
  const base = Math.floor(totalMinor / n);
  const rest = totalMinor - base * n;
  return Array.from({ length: n }, (_, k) => base + (k < rest ? 1 : 0));
}
export interface SessionRow {
  recordId: string;
  sessionId: string | null;
  name: string | null;
  programme: string | null;
  financeServiceId: string | null;
}
export interface OccurrenceRow {
  recordId: string;
  ref: string | null;
  date: string | null;
  status: string | null;
  sessionRecordId: string | null;
}
/**
 * The originally agreed relevant occurrences: the linked sessions' occurrences
 * dated inside the agreement period that were not already cancelled /
 * postponed when the agreement was made. Frozen with their share.
 */
export function allocateDirectCost(
  organisationId: string,
  agreementId: string,
  totalMinor: number,
  from: string,
  until: string,
  sessions: SessionRow[],
  occurrences: OccurrenceRow[],
): Allocation[] {
  const byId = new Map(sessions.map((s) => [s.recordId, s]));
  const relevant = occurrences
    .filter((o) => !!o.date && !!o.sessionRecordId && byId.has(o.sessionRecordId) && (o.date as string) >= from && (o.date as string) <= until)
    .filter((o) => !(EXCLUDED_OCCURRENCE_STATUSES as readonly string[]).includes(o.status ?? ""))
    .sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : a.recordId < b.recordId ? -1 : 1));
  if (!relevant.length) return [];
  const shares = spreadEvenly(totalMinor, relevant.length);
  return relevant.map((o, k) => {
    const s = byId.get(o.sessionRecordId as string) as SessionRow;
    return {
      organisationId,
      agreementId,
      occurrenceRecordId: o.recordId,
      occurrenceRef: o.ref,
      occurrenceDate: o.date as string,
      statusAtAgreement: o.status,
      sessionRecordId: s.recordId,
      sessionId: s.sessionId,
      sessionName: s.name,
      financeServiceId: s.financeServiceId,
      programmeLabel: s.programme,
      allocatedMinor: shares[k],
    };
  });
}
/** An allocation row stops counting from the day a later version of its agreement takes over. */
export const allocationSuperseded = (a: Allocation, successor: Agreement | null) => !!successor && a.occurrenceDate >= successor.effectiveFrom;

// ---------------------------------------------------------------------
// Agreement read helpers
// ---------------------------------------------------------------------
/** Effective end: its own end, or the day before its successor starts (whichever is earlier). */
export function effectiveEnd(a: Agreement, successor: Agreement | null): string | null {
  const bySuccessor = successor ? new Date(Date.parse(`${successor.effectiveFrom}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : null;
  if (bySuccessor && (!a.effectiveUntil || bySuccessor < a.effectiveUntil)) return bySuccessor;
  return a.effectiveUntil;
}
export function agreementStatus(a: Agreement, successor: Agreement | null, today: string): "upcoming" | "active" | "ended" | "superseded" {
  if (successor && successor.effectiveFrom <= today) return "superseded";
  if (a.effectiveFrom > today) return "upcoming";
  const end = effectiveEnd(a, successor);
  return end && end < today ? "ended" : "active";
}

// ---------------------------------------------------------------------
// Views (technical ids only under `technical`)
// ---------------------------------------------------------------------
export function supplierView(s: Supplier) {
  return {
    supplierId: s.supplierId,
    name: s.name,
    type: s.supplierType,
    typeLabel: SUPPLIER_TYPE_LABELS[s.supplierType],
    active: s.active,
    contact: { name: s.contactName, email: s.contactEmail, phone: s.contactPhone },
    vatTreatment: s.vatTreatment,
    notes: s.notes,
    revision: s.revision,
    updatedAt: s.updatedAt,
    technical: { venueRecordId: s.venueRecordId },
  };
}
export function instalmentView(i: Instalment, today: string, payments: Payment[] = []) {
  const state = stateOf(i);
  return {
    instalmentId: i.instalmentId,
    agreementId: i.agreementId,
    supplierId: i.supplierId,
    sequence: i.sequence,
    dueDate: i.dueDate,
    originalDueDate: i.originalDueDate,
    moved: i.dueDate !== i.originalDueDate,
    state,
    stateLabel: INSTALMENT_STATE_LABELS[state],
    /** The amount first planned when the instalment was created - kept forever. */
    plannedAmount: m(i.plannedMinor),
    /** What is owed now: the estimate while Estimated, otherwise the confirmed amount. */
    amountDue: m(i.amountDueMinor),
    amountIsEstimate: i.amountState === "estimated",
    paid: m(i.paidMinor),
    remaining: m(remainingOf(i)),
    overdue: isOverdue(i, today),
    note: i.note,
    splitFrom: i.splitFromInstalmentId,
    cancelled: i.cancelledAt ? { at: i.cancelledAt, by: i.cancelledBy, reason: i.cancelReason } : null,
    payments: payments.map(paymentView),
  };
}
export function paymentView(p: Payment) {
  return {
    paymentId: p.paymentId,
    amount: m(p.amountMinor),
    paidDate: p.paidDate,
    method: p.method,
    reference: p.reference,
    note: p.note,
    remainingAfter: m(p.remainingAfterMinor),
    recordedAt: p.recordedAt,
    recordedBy: p.recordedBy,
    /** Management-confirmed money out - not a bank reconciliation. */
    source: "management_confirmed",
  };
}
export function agreementView(a: Agreement, successor: Agreement | null, today: string) {
  return {
    agreementId: a.agreementId,
    supplierId: a.supplierId,
    name: a.name,
    description: a.description,
    costType: a.costType,
    costTypeLabel: COST_TYPE_LABELS[a.costType],
    frequency: a.frequency,
    classification: a.classification,
    classificationLabel: CLASSIFICATION_LABELS[a.classification],
    effectiveFrom: a.effectiveFrom,
    effectiveUntil: a.effectiveUntil,
    effectiveEnd: effectiveEnd(a, successor),
    status: agreementStatus(a, successor, today),
    amount: a.amountMinor === null ? null : m(a.amountMinor),
    hourly: a.hourlyRateMinor === null ? null : { rate: m(a.hourlyRateMinor), expectedMonthlyHours: hoursText(a.expectedMonthlyHoursHundredths as number) },
    amountIsEstimate: a.amountIsEstimate,
    instalmentCount: a.instalmentCount,
    totalPlanned: m(a.totalPlannedMinor),
    link: { sessionIds: a.linkSessionIds, financeServiceId: a.linkFinanceServiceId, state: a.linkState },
    sourceDocumentRef: a.sourceDocumentRef,
    reason: a.reason,
    versions: { supersedes: a.supersedesAgreementId, supersededBy: successor?.agreementId ?? null },
    createdAt: a.createdAt,
    createdBy: a.createdBy,
  };
}
/** Direct-cost (profitability) view of one agreement, with each occurrence's CURRENT schedule status for information. */
export function profitabilityView(a: Agreement, allocations: Allocation[], successor: Agreement | null, currentStatus: Map<string, string | null>) {
  if (a.classification === "general") return { state: "not_applicable", note: "A general cost is not attributed to sessions or programmes", items: [], byFinanceService: [], allocatedTotal: m(0) };
  if (a.linkState === "unresolved") return { state: "unresolved", note: "No agreed session / Finance Service could be resolved - the cost is not attributed (never guessed from venue name, programme, amount or coach)", items: [], byFinanceService: [], allocatedTotal: m(0) };
  const items = allocations.map((x) => {
    const now = currentStatus.has(x.occurrenceRecordId) ? currentStatus.get(x.occurrenceRecordId) ?? null : null;
    const superseded = allocationSuperseded(x, successor);
    return {
      date: x.occurrenceDate,
      session: x.sessionName,
      sessionId: x.sessionId,
      financeServiceId: x.financeServiceId,
      programme: x.programmeLabel,
      allocated: m(x.allocatedMinor),
      statusAtAgreement: x.statusAtAgreement,
      statusNow: now,
      cancelledSinceAgreement: !!now && (EXCLUDED_OCCURRENCE_STATUSES as readonly string[]).includes(now) && !(EXCLUDED_OCCURRENCE_STATUSES as readonly string[]).includes(x.statusAtAgreement ?? ""),
      superseded,
      counts: !superseded,
      technical: { occurrenceRecordId: x.occurrenceRecordId, occurrenceId: x.occurrenceRef },
    };
  });
  const counting = allocations.filter((x) => !allocationSuperseded(x, successor));
  return {
    state: "linked",
    note: "Spread equally across the originally agreed sessions. A later cancellation does not redistribute the cost; only a new agreement version changes it.",
    allocatedTotal: m(sum(counting.map((x) => x.allocatedMinor))),
    perSession: m(allocations.length ? allocations[0].allocatedMinor : 0),
    items,
    byFinanceService: byFinanceService(counting.map((x) => ({ financeServiceId: x.financeServiceId, label: x.programmeLabel, amountMinor: x.allocatedMinor }))),
  };
}
export function byFinanceService(rows: { financeServiceId: string | null; label: string | null; amountMinor: number }[]) {
  const g = new Map<string, { financeServiceId: string | null; labels: Set<string>; totalMinor: number; count: number }>();
  for (const r of rows) {
    const key = r.financeServiceId ?? "unresolved";
    const x = g.get(key) ?? { financeServiceId: r.financeServiceId, labels: new Set<string>(), totalMinor: 0, count: 0 };
    if (r.label) x.labels.add(r.label);
    x.totalMinor += r.amountMinor;
    x.count++;
    g.set(key, x);
  }
  return [...g.values()]
    .sort((a, b) => (a.financeServiceId === null ? 1 : b.financeServiceId === null ? -1 : a.financeServiceId < b.financeServiceId ? -1 : 1))
    .map((x) => ({ financeServiceId: x.financeServiceId, resolved: x.financeServiceId !== null, labels: [...x.labels].sort(), total: m(x.totalMinor), occurrences: x.count }));
}

export function supplierAudit(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: SUPPLIER_CONTRACT } };
}
export function auditInstalment(i: Instalment) {
  return { instalmentId: i.instalmentId, agreementId: i.agreementId, dueDate: i.dueDate, amountDue: m(i.amountDueMinor), amountState: i.amountState, paid: m(i.paidMinor), remaining: m(remainingOf(i)), state: stateOf(i) };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
export type SupplierRoute =
  | { name: "suppliers.list"; params: Record<string, never> }
  | { name: "suppliers.create"; params: Record<string, never> }
  | { name: "suppliers.one"; params: { supplierId: string } }
  | { name: "suppliers.update"; params: { supplierId: string } }
  | { name: "agreements.list"; params: Record<string, never> }
  | { name: "agreements.create"; params: Record<string, never> }
  | { name: "agreements.one"; params: { agreementId: string } }
  | { name: "agreements.version"; params: { agreementId: string } }
  | { name: "instalments.list"; params: Record<string, never> }
  | { name: "instalments.one"; params: { instalmentId: string } }
  | { name: "instalments.action"; params: { instalmentId: string; action: InstalmentAction } }
  | { name: "facts"; params: Record<string, never> };
export const INSTALMENT_ACTIONS = ["confirm-estimate", "move", "split", "payment", "cancel"] as const;
export type InstalmentAction = (typeof INSTALMENT_ACTIONS)[number];
export type SupplierMatch = { status: "match"; route: SupplierRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;
const ROOTS = ["suppliers", "supplier-agreements", "supplier-instalments", "supplier-cost-facts"];

/** F13 owns these paths. There is deliberately no supplier-credit, Cash Flow, overhead or bank route. */
export function matchSupplierRoute(path: string, method: string): SupplierMatch {
  const seg = path.split("/");
  if (!ROOTS.includes(seg[0])) return null;
  const pick = (byMethod: Partial<Record<string, SupplierRoute>>): SupplierMatch => {
    const r = byMethod[method];
    return r ? { status: "match", route: r } : { status: "method", allowed: Object.keys(byMethod) };
  };
  if (seg[0] === "suppliers") {
    if (seg.length === 1) return pick({ GET: { name: "suppliers.list", params: {} }, POST: { name: "suppliers.create", params: {} } });
    if (seg.length === 2 && SUPPLIER_ID_RE.test(seg[1])) return pick({ GET: { name: "suppliers.one", params: { supplierId: seg[1] } }, POST: { name: "suppliers.update", params: { supplierId: seg[1] } } });
  }
  if (seg[0] === "supplier-agreements") {
    if (seg.length === 1) return pick({ GET: { name: "agreements.list", params: {} }, POST: { name: "agreements.create", params: {} } });
    if (AGREEMENT_ID_RE.test(seg[1] ?? "")) {
      if (seg.length === 2) return pick({ GET: { name: "agreements.one", params: { agreementId: seg[1] } } });
      if (seg.length === 3 && seg[2] === "version") return pick({ POST: { name: "agreements.version", params: { agreementId: seg[1] } } });
    }
  }
  if (seg[0] === "supplier-instalments") {
    if (seg.length === 1) return pick({ GET: { name: "instalments.list", params: {} } });
    if (INSTALMENT_ID_RE.test(seg[1] ?? "")) {
      if (seg.length === 2) return pick({ GET: { name: "instalments.one", params: { instalmentId: seg[1] } } });
      if (seg.length === 3 && (INSTALMENT_ACTIONS as readonly string[]).includes(seg[2])) return pick({ POST: { name: "instalments.action", params: { instalmentId: seg[1], action: seg[2] as InstalmentAction } } });
    }
  }
  if (seg[0] === "supplier-cost-facts" && seg.length === 1) return pick({ GET: { name: "facts", params: {} } });
  return { status: "not_found" };
}

// ---------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------
export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

export type SupplierQuery = { ok: true; supplierId?: string; type?: SupplierType; active?: boolean; state?: InstalmentState; from?: string; to?: string; fromMonth?: string; toMonth?: string };
export function parseSupplierQuery(route: SupplierRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): SupplierQuery | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const allowed: Partial<Record<SupplierRoute["name"], string[]>> = {
    "suppliers.list": ["type", "active"],
    "agreements.list": ["supplierId"],
    "instalments.list": ["supplierId", "state", "from", "to"],
    facts: ["from", "to"],
  };
  const ok = allowed[route] ?? [];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(bad)].join(", ")}`);
  if (new Set(keys).size !== keys.length) return invalid("unexpected_parameter", "A query parameter is repeated");
  const out: SupplierQuery = { ok: true };
  const sid = q.get("supplierId");
  if (sid !== null) {
    if (!SUPPLIER_ID_RE.test(sid)) return invalid("invalid_query", "supplierId must be a supplier id (FSU-...)");
    out.supplierId = sid;
  }
  const type = q.get("type");
  if (type !== null) {
    if (!(SUPPLIER_TYPES as readonly string[]).includes(type)) return invalid("invalid_query", `type must be one of ${SUPPLIER_TYPES.join(", ")}`);
    out.type = type as SupplierType;
  }
  const active = q.get("active");
  if (active !== null) {
    if (active !== "true" && active !== "false") return invalid("invalid_query", "active must be true or false");
    out.active = active === "true";
  }
  const state = q.get("state");
  if (state !== null) {
    if (!(INSTALMENT_STATES as readonly string[]).includes(state)) return invalid("invalid_query", `state must be one of ${INSTALMENT_STATES.join(", ")}`);
    out.state = state as InstalmentState;
  }
  for (const k of ["from", "to"] as const) {
    const v = q.get(k);
    if (v === null) continue;
    if (route === "facts") {
      if (!MONTH_RE.test(v)) return invalid("invalid_query", `${k} must be a month YYYY-MM`);
      if (k === "from") out.fromMonth = v;
      else out.toMonth = v;
    } else {
      if (!isRealDate(v)) return invalid("invalid_query", `${k} must be a date YYYY-MM-DD`);
      out[k] = v;
    }
  }
  if (out.from && out.to && out.from > out.to) return invalid("invalid_query", "from must be on or before to");
  if (out.fromMonth && out.toMonth) {
    if (out.fromMonth > out.toMonth) return invalid("invalid_query", "from must be on or before to");
    if (monthIndex(out.toMonth) - monthIndex(out.fromMonth) + 1 > MAX_FACT_MONTHS) return invalid("invalid_query", `The range may be at most ${MAX_FACT_MONTHS} months`);
  }
  return out;
}
/** Default fact range: the 3 months ending this month; at most 12. */
export function factMonths(q: SupplierQuery, currentMonth: string): { from: string; to: string } | Invalid {
  const to = q.toMonth ?? currentMonth;
  const shift = (month: string, n: number) => {
    const idx = monthIndex(month) + n;
    return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
  };
  const from = q.fromMonth ?? shift(to, -2);
  if (from > to) return invalid("invalid_query", "from must be on or before to");
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_FACT_MONTHS) return invalid("invalid_query", `The range may be at most ${MAX_FACT_MONTHS} months`);
  return { from: monthBounds(from).from, to: monthBounds(to).to };
}

function jsonObject(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean): { ok: true; body: Record<string, unknown> } | Invalid {
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
type T = { ok: true; value: string | null } | { ok: false; error: string };
function text(v: unknown, required: boolean, max = REASON_MAX): T {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if (CONTROL_RE.test(t.replace(/\n/g, ""))) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}
function money(v: unknown, f: Record<string, string>, key: string, required: boolean): number | null {
  if (v === undefined || v === null) {
    if (required) f[key] = "is required";
    return null;
  }
  const p = parseMoney(v);
  if (!p.ok) {
    f[key] = p.error;
    return null;
  }
  if (p.minor <= 0) {
    f[key] = "must be more than 0.00";
    return null;
  }
  return p.minor;
}
function date(v: unknown, f: Record<string, string>, key: string, required: boolean): string | null {
  if (v === undefined || v === null) {
    if (required) f[key] = "is required";
    return null;
  }
  if (!isRealDate(v)) {
    f[key] = "must be a real date YYYY-MM-DD";
    return null;
  }
  return v;
}

// --- suppliers
export const SUPPLIER_FIELDS = ["name", "type", "active", "contactName", "contactEmail", "contactPhone", "vatTreatment", "notes", "venueRecordId"] as const;
export type SupplierPatch = Partial<Pick<Supplier, "name" | "supplierType" | "active" | "contactName" | "contactEmail" | "contactPhone" | "vatTreatment" | "notes" | "venueRecordId">>;
function supplierPatch(body: Record<string, unknown>, creating: boolean): { ok: true; patch: SupplierPatch; reason: string | null } | Invalid {
  const f: Record<string, string> = {};
  const patch: SupplierPatch = {};
  const t = (k: string, max: number) => {
    if (!(k in body)) return undefined;
    const r = text(body[k], k === "name", max);
    if (!r.ok) f[k] = r.error;
    return r.ok ? r.value : undefined;
  };
  const name = t("name", 200);
  if (name !== undefined) patch.name = name as string;
  else if (creating) f.name = "is required";
  if ("type" in body) {
    if (!(SUPPLIER_TYPES as readonly unknown[]).includes(body.type)) f.type = `must be one of ${SUPPLIER_TYPES.join(", ")}`;
    else patch.supplierType = body.type as SupplierType;
  } else if (creating) f.type = "is required";
  if ("active" in body) {
    if (typeof body.active !== "boolean") f.active = "must be true or false";
    else patch.active = body.active;
  }
  const cn = t("contactName", 200);
  if (cn !== undefined) patch.contactName = cn;
  if ("contactEmail" in body) {
    const r = text(body.contactEmail, false, 320);
    if (!r.ok) f.contactEmail = r.error;
    else if (r.value !== null && !EMAIL_RE.test(r.value)) f.contactEmail = "must be an email address";
    else patch.contactEmail = r.value;
  }
  const ph = t("contactPhone", 50);
  if (ph !== undefined) patch.contactPhone = ph;
  if ("vatTreatment" in body) {
    if (body.vatTreatment !== null && !(VAT_TREATMENTS as readonly unknown[]).includes(body.vatTreatment)) f.vatTreatment = `must be one of ${VAT_TREATMENTS.join(", ")} or null`;
    else patch.vatTreatment = body.vatTreatment as string | null;
  }
  const notes = t("notes", 2000);
  if (notes !== undefined) patch.notes = notes;
  if ("venueRecordId" in body) {
    if (body.venueRecordId !== null && (typeof body.venueRecordId !== "string" || !RECORD_ID_RE.test(body.venueRecordId))) f.venueRecordId = "must be a Venues record id (rec...) or null";
    else patch.venueRecordId = body.venueRecordId as string | null;
  }
  const reason = text(body.reason, false);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  if (!creating && !Object.keys(patch).length) return invalid("invalid_input", "Nothing to change");
  return { ok: true, patch, reason: (reason as { value: string | null }).value };
}
export function parseSupplierCreate(raw: string, isTenantKey: (k: string) => boolean) {
  const b = jsonObject(raw, [...SUPPLIER_FIELDS, "reason"], isTenantKey);
  return b.ok ? supplierPatch(b.body, true) : b;
}
export function parseSupplierUpdate(raw: string, isTenantKey: (k: string) => boolean) {
  const b = jsonObject(raw, [...SUPPLIER_FIELDS, "reason"], isTenantKey);
  return b.ok ? supplierPatch(b.body, false) : b;
}
/** A supplier after a patch, or a refusal when the combination is impossible. */
export function applySupplierPatch(s: Supplier, patch: SupplierPatch): { ok: true; supplier: Supplier } | Refusal {
  const next = { ...s, ...patch };
  if (next.venueRecordId && next.supplierType !== "venue") return refuse(400, "invalid_input", "Only a Venue supplier can be linked to a Venues record");
  return { ok: true, supplier: next };
}

// --- agreements
export const AGREEMENT_FIELDS = [
  "name",
  "description",
  "costType",
  "frequency",
  "classification",
  "effectiveFrom",
  "effectiveUntil",
  "amount",
  "hourlyRate",
  "expectedMonthlyHours",
  "amountIsEstimate",
  "firstDueDate",
  "instalmentCount",
  "instalments",
  "sessionIds",
  "financeServiceId",
  "sourceDocumentRef",
  "reason",
] as const;
export function parseAgreement(raw: string, isTenantKey: (k: string) => boolean, version: boolean): { ok: true; supplierId: string | null; spec: AgreementSpec } | Invalid {
  const b = jsonObject(raw, version ? AGREEMENT_FIELDS : ["supplierId", ...AGREEMENT_FIELDS], isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  let supplierId: string | null = null;
  if (!version) {
    if (typeof x.supplierId !== "string" || !SUPPLIER_ID_RE.test(x.supplierId)) f.supplierId = "is required (FSU-...)";
    else supplierId = x.supplierId;
  }
  const name = text(x.name, true, 200);
  if (!name.ok) f.name = name.error;
  const description = text(x.description, false, 2000);
  if (!description.ok) f.description = description.error;
  const costType = (COST_TYPES as readonly unknown[]).includes(x.costType) ? (x.costType as CostType) : null;
  if (!costType) f.costType = `must be one of ${COST_TYPES.join(", ")}`;
  const classification = (CLASSIFICATIONS as readonly unknown[]).includes(x.classification) ? (x.classification as Classification) : null;
  if (!classification) f.classification = `must be one of ${CLASSIFICATIONS.join(", ")}`;
  const effectiveFrom = date(x.effectiveFrom, f, "effectiveFrom", true);
  const effectiveUntil = date(x.effectiveUntil, f, "effectiveUntil", false);
  if (effectiveFrom && effectiveUntil && effectiveUntil < effectiveFrom) f.effectiveUntil = "must be on or after effectiveFrom";
  let frequency: Frequency | null = null;
  if (x.frequency !== undefined && x.frequency !== null) {
    if (!(FREQUENCIES as readonly unknown[]).includes(x.frequency)) f.frequency = `must be one of ${FREQUENCIES.join(", ")}`;
    else frequency = x.frequency as Frequency;
  }
  if (x.amountIsEstimate !== undefined && typeof x.amountIsEstimate !== "boolean") f.amountIsEstimate = "must be true or false";
  const amountIsEstimate = x.amountIsEstimate === true;
  let amountMinor: number | null = null;
  let hourlyRateMinor: number | null = null;
  let hours: number | null = null;
  let firstDueDate: string | null = null;
  let instalmentCount: number | null = null;
  const custom: CustomInstalmentInput[] = [];
  const notFor = (keys: string[], why: string) => keys.forEach((k) => x[k] !== undefined && x[k] !== null && (f[k] = why));
  if (costType === "fixed" || costType === "hourly") {
    if (costType === "fixed") {
      amountMinor = money(x.amount, f, "amount", true);
      if (!frequency || frequency === "custom_dates") f.frequency = "must be monthly, quarterly or annually";
      notFor(["hourlyRate", "expectedMonthlyHours"], "is only for an hourly cost");
    } else {
      if (frequency && frequency !== "monthly") f.frequency = "an hourly cost is confirmed monthly";
      frequency = "monthly";
      hourlyRateMinor = money(x.hourlyRate, f, "hourlyRate", true);
      hours = hoursToHundredths(x.expectedMonthlyHours);
      if (hours === null) f.expectedMonthlyHours = "is required: hours per month, more than 0, at most 2 decimals";
      notFor(["amount"], "an hourly cost uses hourlyRate x expectedMonthlyHours");
      if (x.amountIsEstimate === false) f.amountIsEstimate = "an hourly cost is always an estimate until the actual month is confirmed";
    }
    firstDueDate = date(x.firstDueDate, f, "firstDueDate", true);
    if (x.instalmentCount !== undefined && x.instalmentCount !== null) {
      if (!Number.isSafeInteger(x.instalmentCount) || (x.instalmentCount as number) < 1 || (x.instalmentCount as number) > MAX_INSTALMENTS) f.instalmentCount = `must be a whole number 1-${MAX_INSTALMENTS}`;
      else instalmentCount = x.instalmentCount as number;
    } else if (!effectiveUntil) f.effectiveUntil = "is required for a recurring cost unless instalmentCount is given";
    notFor(["instalments"], "is only for a custom-date schedule");
  } else if (costType === "one_off" || costType === "scheduled") {
    if (frequency) f.frequency = "a single payment has no frequency";
    amountMinor = money(x.amount, f, "amount", true);
    firstDueDate = date(x.firstDueDate, f, "firstDueDate", true);
    notFor(["hourlyRate", "expectedMonthlyHours", "instalmentCount", "instalments"], "is not used for a single payment");
  } else if (costType === "custom_dates") {
    if (frequency && frequency !== "custom_dates") f.frequency = "a custom-date schedule has frequency custom_dates";
    frequency = "custom_dates";
    notFor(["amount", "hourlyRate", "expectedMonthlyHours", "firstDueDate", "instalmentCount"], "a custom-date schedule lists its instalments instead");
    if (!Array.isArray(x.instalments) || !x.instalments.length || x.instalments.length > MAX_INSTALMENTS) f.instalments = `is required: 1-${MAX_INSTALMENTS} rows of { dueDate, amount, estimated?, note? }`;
    else
      x.instalments.forEach((row: unknown, k: number) => {
        const key = `instalments[${k}]`;
        if (!row || typeof row !== "object" || Array.isArray(row)) return (f[key] = "must be an object");
        const r = row as Record<string, unknown>;
        const extra = Object.keys(r).filter((kk) => !["dueDate", "amount", "estimated", "note"].includes(kk));
        if (extra.length) return (f[key] = `unexpected field(s): ${extra.join(", ")}`);
        const d = date(r.dueDate, f, `${key}.dueDate`, true);
        const a = money(r.amount, f, `${key}.amount`, true);
        if (r.estimated !== undefined && typeof r.estimated !== "boolean") f[`${key}.estimated`] = "must be true or false";
        const n = text(r.note, false);
        if (!n.ok) f[`${key}.note`] = n.error;
        if (d && a) custom.push({ dueDate: d, amountMinor: a, estimated: r.estimated === true || (r.estimated === undefined && amountIsEstimate), note: n.ok ? n.value : null });
      });
  }
  // Links (direct cost only) - stable ids, never names or labels.
  let sessionIds: string[] = [];
  let financeServiceId: string | null = null;
  if (x.sessionIds !== undefined && x.sessionIds !== null) {
    if (!Array.isArray(x.sessionIds) || x.sessionIds.length > MAX_LINKED_SESSIONS || x.sessionIds.some((s) => typeof s !== "string" || !SESSION_ID_RE.test(s))) f.sessionIds = `must be up to ${MAX_LINKED_SESSIONS} Session IDs`;
    else sessionIds = [...new Set(x.sessionIds as string[])];
  }
  if (x.financeServiceId !== undefined && x.financeServiceId !== null) {
    if (typeof x.financeServiceId !== "string" || !SERVICE_ID_RE.test(x.financeServiceId)) f.financeServiceId = "must be a Finance Service ID (FSV-...)";
    else financeServiceId = x.financeServiceId;
  }
  if (classification === "general" && (sessionIds.length || financeServiceId)) f.classification = "a general cost is not linked to sessions or a Finance Service";
  if (classification === "direct") {
    if (sessionIds.length && financeServiceId) f.sessionIds = "give sessionIds OR financeServiceId, not both";
    else if (!sessionIds.length && !financeServiceId) f.sessionIds = "a direct cost needs sessionIds or a financeServiceId";
    if (!effectiveUntil) f.effectiveUntil = "is required for a direct cost (it bounds the agreed sessions)";
  }
  const sourceDocumentRef = text(x.sourceDocumentRef, false);
  if (!sourceDocumentRef.ok) f.sourceDocumentRef = sourceDocumentRef.error;
  const reason = text(x.reason, version);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  return {
    ok: true,
    supplierId,
    spec: {
      name: (name as { value: string }).value,
      description: description.ok ? description.value : null,
      costType: costType as CostType,
      frequency: costType === "one_off" || costType === "scheduled" ? null : frequency,
      classification: classification as Classification,
      effectiveFrom: effectiveFrom as string,
      effectiveUntil,
      amountMinor,
      hourlyRateMinor,
      expectedMonthlyHoursHundredths: hours,
      amountIsEstimate: costType === "hourly" ? true : costType === "custom_dates" ? custom.some((c) => c.estimated) : amountIsEstimate,
      firstDueDate,
      instalmentCount,
      customInstalments: custom,
      sessionIds,
      financeServiceId,
      sourceDocumentRef: sourceDocumentRef.ok ? sourceDocumentRef.value : null,
      reason: (reason as { value: string | null }).value,
    },
  };
}

// --- instalment actions
export type ActionInput =
  | { action: "confirm-estimate"; amountMinor: number | null; useEstimate: boolean; reason: string | null }
  | { action: "move"; dueDate: string; reason: string }
  | { action: "split"; parts: { dueDate: string; amountMinor: number }[]; reason: string }
  | { action: "payment"; amountMinor: number; paidDate: string; method: PaymentMethod | null; reference: string | null; note: string | null }
  | { action: "cancel"; reason: string };
export function parseAction(action: InstalmentAction, raw: string, isTenantKey: (k: string) => boolean): { ok: true; input: ActionInput } | Invalid {
  const allowed: Record<InstalmentAction, string[]> = {
    "confirm-estimate": ["amount", "useEstimate", "reason"],
    move: ["dueDate", "reason"],
    split: ["parts", "reason"],
    payment: ["amount", "paidDate", "method", "reference", "note"],
    cancel: ["reason"],
  };
  const b = jsonObject(raw, allowed[action], isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  const done = (input: ActionInput): { ok: true; input: ActionInput } | Invalid => (Object.keys(f).length ? invalid("invalid_input", "Some fields are not valid - nothing was changed", f) : { ok: true, input });
  if (action === "confirm-estimate") {
    const useEstimate = x.useEstimate === true;
    if (x.useEstimate !== undefined && typeof x.useEstimate !== "boolean") f.useEstimate = "must be true or false";
    const amount = x.amount === undefined || x.amount === null ? null : money(x.amount, f, "amount", true);
    if (useEstimate && (x.amount !== undefined && x.amount !== null)) f.amount = "give the actual amount OR useEstimate, not both";
    if (!useEstimate && (x.amount === undefined || x.amount === null)) f.amount = "give the actual amount, or useEstimate: true";
    const r = text(x.reason, false);
    if (!r.ok) f.reason = r.error;
    return done({ action, amountMinor: amount, useEstimate, reason: r.ok ? r.value : null });
  }
  if (action === "move") {
    const d = date(x.dueDate, f, "dueDate", true);
    const r = text(x.reason, true);
    if (!r.ok) f.reason = r.error;
    return done({ action, dueDate: d as string, reason: (r.ok ? r.value : "") as string });
  }
  if (action === "split") {
    const parts: { dueDate: string; amountMinor: number }[] = [];
    if (!Array.isArray(x.parts) || x.parts.length < 2 || x.parts.length > 24) f.parts = "is required: 2-24 rows of { dueDate, amount }";
    else
      x.parts.forEach((p: unknown, k: number) => {
        if (!p || typeof p !== "object" || Array.isArray(p)) return (f[`parts[${k}]`] = "must be an object");
        const r = p as Record<string, unknown>;
        const extra = Object.keys(r).filter((kk) => !["dueDate", "amount"].includes(kk));
        if (extra.length) return (f[`parts[${k}]`] = `unexpected field(s): ${extra.join(", ")}`);
        const d = date(r.dueDate, f, `parts[${k}].dueDate`, true);
        const a = money(r.amount, f, `parts[${k}].amount`, true);
        if (d && a) parts.push({ dueDate: d, amountMinor: a });
      });
    const r = text(x.reason, true);
    if (!r.ok) f.reason = r.error;
    return done({ action, parts, reason: (r.ok ? r.value : "") as string });
  }
  if (action === "payment") {
    const a = money(x.amount, f, "amount", true);
    const d = date(x.paidDate, f, "paidDate", true);
    let method: PaymentMethod | null = null;
    if (x.method !== undefined && x.method !== null) {
      if (!(PAYMENT_METHODS as readonly unknown[]).includes(x.method)) f.method = `must be one of ${PAYMENT_METHODS.join(", ")}`;
      else method = x.method as PaymentMethod;
    }
    const ref = text(x.reference, false, 200);
    if (!ref.ok) f.reference = ref.error;
    const note = text(x.note, false);
    if (!note.ok) f.note = note.error;
    return done({ action, amountMinor: a as number, paidDate: d as string, method, reference: ref.ok ? ref.value : null, note: note.ok ? note.value : null });
  }
  const r = text(x.reason, true);
  if (!r.ok) f.reason = r.error;
  return done({ action: "cancel", reason: (r.ok ? r.value : "") as string });
}

// ---------------------------------------------------------------------
// Planning one instalment change (the database re-checks the same rules)
// ---------------------------------------------------------------------
export type ChangePlan =
  | { ok: true; kind: "confirm_estimate"; next: Instalment }
  | { ok: true; kind: "move"; next: Instalment }
  | { ok: true; kind: "split"; next: Instalment; children: Instalment[] }
  | { ok: true; kind: "payment"; next: Instalment; payment: Payment }
  | { ok: true; kind: "cancel"; next: Instalment };
export function planChange(i: Instalment, input: ActionInput, ctx: { today: string; actor: string; at: string; newId: (p: "FSI" | "FSP") => string }): ChangePlan | Refusal {
  const remaining = remainingOf(i);
  if (i.cancelledAt) return refuse(409, "instalment_cancelled", "This instalment was cancelled - it can no longer change");
  if (remaining === 0) return refuse(409, "instalment_paid", "This instalment is fully paid - paid history is never rewritten (use a correction later)");
  if (input.action === "confirm-estimate") {
    if (i.amountState !== "estimated") return refuse(409, "already_confirmed", "This amount is already confirmed");
    const amount = input.useEstimate ? i.amountDueMinor : (input.amountMinor as number);
    return { ok: true, kind: "confirm_estimate", next: { ...i, amountState: "confirmed", amountDueMinor: amount } };
  }
  if (input.action === "move") {
    if (input.dueDate === i.dueDate) return refuse(409, "nothing_to_change", "The instalment is already due on that date");
    return { ok: true, kind: "move", next: { ...i, dueDate: input.dueDate } };
  }
  if (input.action === "split") {
    const total = sum(input.parts.map((p) => p.amountMinor));
    if (total !== remaining) return refuse(409, "split_mismatch", `The parts must add up to the remaining ${m(remaining)} (they add up to ${m(total)})`);
    const [first, ...rest] = input.parts;
    const children = rest.map((p) => ({
      ...i,
      instalmentId: ctx.newId("FSI"),
      originalDueDate: p.dueDate,
      dueDate: p.dueDate,
      plannedMinor: p.amountMinor,
      amountDueMinor: p.amountMinor,
      paidMinor: 0,
      splitFromInstalmentId: i.instalmentId,
      note: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      createdAt: ctx.at,
      createdBy: ctx.actor,
    }));
    return { ok: true, kind: "split", next: { ...i, amountDueMinor: i.paidMinor + first.amountMinor, dueDate: first.dueDate }, children };
  }
  if (input.action === "payment") {
    if (i.amountState === "estimated") return refuse(409, "amount_still_estimated", "Confirm the amount first (enter the actual amount or Use Estimate) - an estimate is never paid as-is");
    if (input.amountMinor > remaining) return refuse(409, "overpayment", `Only ${m(remaining)} remains on this instalment - ${m(input.amountMinor)} would overpay it`);
    if (input.paidDate > ctx.today) return refuse(400, "invalid_input", "paidDate cannot be in the future");
    const next = { ...i, paidMinor: i.paidMinor + input.amountMinor };
    return {
      ok: true,
      kind: "payment",
      next,
      payment: {
        organisationId: i.organisationId,
        paymentId: ctx.newId("FSP"),
        instalmentId: i.instalmentId,
        agreementId: i.agreementId,
        supplierId: i.supplierId,
        amountMinor: input.amountMinor,
        paidDate: input.paidDate,
        method: input.method,
        reference: input.reference,
        note: input.note,
        remainingAfterMinor: remainingOf(next),
        recordedAt: ctx.at,
        recordedBy: ctx.actor,
      },
    };
  }
  if (i.paidMinor > 0) return refuse(409, "instalment_partially_paid", "Money has already been paid against this instalment - it cannot be cancelled (split or correct it instead)");
  return { ok: true, kind: "cancel", next: { ...i, cancelledAt: ctx.at, cancelledBy: ctx.actor, cancelReason: input.reason } };
}
