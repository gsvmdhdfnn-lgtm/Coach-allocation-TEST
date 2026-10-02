/**
 * Test-suite copy of the canonical needs-attention/finance.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client|work-summaries|finance.ts become needs-attention-*.ts.
 */
/**
 * Finance evaluators for Needs Attention (Finance Foundation F8a; see
 * TEST-ENV.md "Finance Foundation - F8a"):
 *
 *   invoice_overdue (ATT-047): a genuinely Issued client invoice still has
 *   money outstanding after its (latest) due date.
 *
 * Source of truth is the Finance F6 / F7 domain. This file never re-decides
 * it:
 *  - The receivable (outstanding, settlement, due state, calendar-day
 *    overdue) is F7's own pure receivableOf(), COPIED VERBATIM below from
 *    finance/finance-receivables.ts together with the F6 isIssued() boundary
 *    and the F2 isIsoDate() it needs (drift-tested chunk by chunk). An
 *    invoice awaiting external issue (Xero) is never a receivable, so it can
 *    never be overdue here.
 *  - "Today" is the organisation's calendar day in its own time zone, the
 *    same day F7 uses for GET /finance/receivables.
 *  - Rows are read with the Finance table / field names (drift-tested
 *    against the F6 / F7 mapping constants). Only rows linked to exactly
 *    this organisation are used; a malformed row of this organisation fails
 *    the whole pass loudly (F7 refuses such data with 409 too) - nothing is
 *    guessed, skipped silently or repaired.
 *  - Read-only. Six Finance tables, each listed once per request by the
 *    engine; no per-invoice reads, no Finance API calls, no writes.
 *
 * Finance access (F8a, locked): Finance cases are visible only to a caller
 * holding Finance View or Manage (F1 grants), and only Manage may approve /
 * revoke an exception on one. The F1 resolver is COPIED VERBATIM below from
 * finance/finance-access.ts; restrictFinanceRules() removes Finance rules
 * from the plan BEFORE any Finance source is loaded.
 */
import type { CandidateCase, EvaluatorContext, EvaluatorRegistration, Plan, PlanEntry, RuleDef } from "./needs-attention-engine.ts";
import { localDateIso } from "./needs-attention-staffing.ts";
import { localMidnightIso } from "./needs-attention-work-summaries.ts";

// Stand-ins for the F2 / F6 types the copied F7 block names. Only the fields
// the receivable derivation reads are carried; everything else stays Finance's.
type Minor = number;
const CURRENCY = "GBP";
export interface Invoice {
  invoiceId: string;
  clientId: string;
  clientName: string;
  status: InvoiceStatus;
  numberAuthority: "hub" | "xero";
  hubInvoiceNumber: string | null;
  externalInvoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  grossMinor: Minor;
}
export interface CreditNote {
  creditNoteId: string;
  invoiceId: string;
  grossMinor: Minor;
}

// ===== COPIED FROM finance/finance-effective-dating.ts - DO NOT EDIT HERE =====
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, "2026-1-1"). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATE_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-issue.ts - DO NOT EDIT HERE =====
/**
 * Lifecycle: Hub authority      Ready -> issued (-> partially_credited -> credited)
 *            Xero authority     Ready -> awaiting_external_issue -> [F9: Xero confirms] -> issued (-> ...)
 * An awaiting_external_issue invoice is a frozen, claimed, immutable package that
 * has NOT been issued: no issue date, no due date, no official number, not a
 * receivable, and it cannot be credited / corrected through the issued-invoice path.
 */
export const INVOICE_STATUSES = ["awaiting_external_issue", "issued", "partially_credited", "credited"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = { awaiting_external_issue: "Awaiting external issue", issued: "Issued", partially_credited: "Partially credited", credited: "Credited" };
/** Genuinely issued (a receivable for F7): every status except awaiting_external_issue. */
export const isIssued = (i: Pick<Invoice, "status">): boolean => i.status !== "awaiting_external_issue";
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-receivables.ts - DO NOT EDIT HERE =====
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
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-access.ts - DO NOT EDIT HERE =====
export const FINANCE_MODULE_KEY = "module_finance";
export const FINANCE_CONTRACT = "finance-access-v1";

export const FINANCE_ACCESS_LEVELS = ["view", "manage"] as const;
export type FinanceLevel = (typeof FINANCE_ACCESS_LEVELS)[number];
export type FinanceAccess = "none" | FinanceLevel;
/** What a route requires: `read` is satisfied by view or manage, `manage` only by manage. */
export type FinanceRequirement = "read" | "manage";

export interface FinanceCaller {
  userId: string;
  role: string | null;
  active: boolean;
  organisationId: string | null;
}

/** A row of public.finance_access_grants, as read by the repository (only the columns the policy needs). */
export interface FinanceGrantRow {
  organisation_id: unknown;
  access_level: unknown;
  revoked_at: unknown;
}

export type AccessReason =
  | "granted"
  | "not_management"
  | "inactive_profile"
  | "no_profile_organisation"
  | "no_grant"
  | "grant_invalid"
  | "grant_ambiguous";

export interface AccessResolution {
  access: FinanceAccess;
  reason: AccessReason;
}

/** Only an active Management profile may use Finance at all. */
export function isFinanceEligible(caller: FinanceCaller): { ok: true } | { ok: false; reason: "not_management" | "inactive_profile" } {
  if (caller.role !== "management") return { ok: false, reason: "not_management" };
  if (caller.active !== true) return { ok: false, reason: "inactive_profile" };
  return { ok: true };
}

/**
 * The caller's Finance access in their OWN profile organisation.
 * `grants` must be the caller's rows only (the repository filters by
 * user id); this function still ignores revoked rows and other
 * organisations' rows, and fails closed on anything unexpected.
 */
export function resolveFinanceAccess(caller: FinanceCaller, grants: readonly FinanceGrantRow[]): AccessResolution {
  const eligible = isFinanceEligible(caller);
  if (!eligible.ok) return { access: "none", reason: eligible.reason };
  const org = typeof caller.organisationId === "string" ? caller.organisationId.trim() : "";
  if (!org) return { access: "none", reason: "no_profile_organisation" };
  const current = grants.filter((g) => g && g.revoked_at == null && typeof g.organisation_id === "string" && g.organisation_id.trim() === org);
  if (current.length === 0) return { access: "none", reason: "no_grant" };
  if (current.length > 1) return { access: "none", reason: "grant_ambiguous" };
  const level = current[0].access_level;
  if (typeof level !== "string" || !(FINANCE_ACCESS_LEVELS as readonly string[]).includes(level)) return { access: "none", reason: "grant_invalid" };
  return { access: level as FinanceLevel, reason: "granted" };
}
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Finance tables / fields (the F6 / F7 mapping names; drift-tested)
// ---------------------------------------------------------------------

export const FINANCE_TABLES = {
  invoices: "Finance Invoices",
  creditNotes: "Finance Credit Notes",
  payments: "Finance Payments",
  credits: "Finance Client Credits",
  applications: "Finance Client Credit Applications",
  dueChanges: "Finance Invoice Due Date Changes",
} as const;

/** Exactly the Finance tables invoice_overdue reads (each listed once per request by the engine). */
export const INVOICE_OVERDUE_SOURCES: readonly string[] = [
  FINANCE_TABLES.invoices,
  FINANCE_TABLES.creditNotes,
  FINANCE_TABLES.payments,
  FINANCE_TABLES.credits,
  FINANCE_TABLES.applications,
  FINANCE_TABLES.dueChanges,
];

export const FF = {
  org: "Organisation",
  invoice: {
    id: "Invoice ID",
    clientId: "Client ID",
    clientName: "Client Name",
    date: "Invoice Date",
    due: "Due Date",
    gross: "Gross (Minor Units)",
    status: "Status",
    numberAuthority: "Invoice Number Authority",
    hubNumber: "Hub Invoice Number",
    extNumber: "External Invoice Number",
  },
  credit: { id: "Credit Note ID", invoiceId: "Invoice ID", gross: "Gross (Minor Units)" },
  payment: {
    id: "Payment Entry ID",
    type: "Entry Type",
    reverses: "Reverses Payment ID",
    invoiceId: "Invoice ID",
    clientId: "Client ID",
    clientName: "Client Name",
    amount: "Amount (Minor Units)",
    receivedDate: "Received Date",
    source: "Source",
    recordedAt: "Recorded At",
  },
  clientCredit: {
    id: "Client Credit ID",
    clientId: "Client ID",
    source: "Source",
    sourceInvoiceId: "Source Invoice ID",
    sourceCreditNoteId: "Source Credit Note ID",
    original: "Original (Minor Units)",
    status: "Status",
    // F17 Cash Flow: who the receipt is from, and when cash kept from an overpayment arrived.
    clientName: "Client Name",
    sourcePaymentId: "Source Payment ID",
    receivedDate: "Received Date",
  },
  application: {
    id: "Application Entry ID",
    type: "Entry Type",
    reverses: "Reverses Application ID",
    creditId: "Client Credit ID",
    invoiceId: "Invoice ID",
    clientId: "Client ID",
    amount: "Amount (Minor Units)",
    recordedAt: "Recorded At",
  },
  due: { id: "Due Date Change ID", invoiceId: "Invoice ID", previous: "Previous Due Date", next: "New Due Date", changedAt: "Changed At" },
} as const;

/** Stored (Airtable) labels -> domain values, as the F6 / F7 mappings write them. */
const INVOICE_STATUS_STORED: Record<string, InvoiceStatus> = { "Awaiting external issue": "awaiting_external_issue", Issued: "issued", "Partially credited": "partially_credited", Credited: "credited" };
const NUMBER_AUTHORITY_STORED: Record<string, "hub" | "xero"> = { Hub: "hub", Xero: "xero" };
const PAYMENT_SOURCE_STORED: Record<string, PaymentSource> = { Manual: "manual", Xero: "xero" };
const CREDIT_SOURCE_STORED: Record<string, ClientCreditSource> = { "Credit note": "credit_note", Overpayment: "overpayment" };
const CREDIT_STATUS_STORED: Record<string, ClientCreditStatus> = { Available: "available", Used: "used", Void: "void" };

const RE = {
  invoice: /^FIV-[0-9A-F]{12}$/,
  client: /^FCL-[0-9A-F]{12}$/,
  creditNote: /^FCN-[0-9A-F]{12}$/,
  payment: /^FPY-[0-9A-F]{12}$/,
  paymentReversal: /^FPR-[0-9A-F]{12}$/,
  credit: /^FCC-[0-9A-F]{12}$/,
  application: /^FCA-[0-9A-F]{12}$/,
  applicationReversal: /^FAR-[0-9A-F]{12}$/,
  due: /^FDD-[0-9A-F]{12}$/,
};
const MAX_STORED_MINOR = 1e11;

// ---------------------------------------------------------------------
// Strict readers (this organisation's rows only)
// ---------------------------------------------------------------------

type Row = { id: string; fields: Record<string, any> };

/** Thrown for any unreadable Finance row of this organisation; the engine reports it as an incomplete evaluation. */
export class FinanceDataError extends Error {}

function text(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object" && typeof (v as any).name === "string" && (v as any).name.trim()) return (v as any).name.trim();
  return null;
}
function minor(v: unknown, min: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= MAX_STORED_MINOR ? v : null;
}
function isoOrNull(v: unknown): string | null | undefined {
  if (v == null || v === "") return null;
  return isIsoDate(v) ? v : undefined;
}

/** Rows linked to this organisation. A row linked to it AND another organisation is invalid (never shared). Other organisations' rows are invisible. */
function ownRows(rows: readonly Row[] | undefined, orgRecordId: string, table: string): Row[] {
  const out: Row[] = [];
  for (const r of rows ?? []) {
    const orgs = Array.isArray(r.fields?.[FF.org]) ? r.fields[FF.org] : [];
    if (!orgs.includes(orgRecordId)) continue;
    if (orgs.length !== 1) throw new FinanceDataError(`${table} row ${r.id} is linked to more than one organisation`);
    out.push(r);
  }
  return out;
}

function bad(table: string, r: Row, why: string): never {
  throw new FinanceDataError(`${table} row ${r.id}: ${why}`);
}

export function readInvoice(r: Row): Invoice {
  const f = r.fields, x = FF.invoice, t = FINANCE_TABLES.invoices;
  const invoiceId = text(f[x.id]);
  if (!invoiceId || !RE.invoice.test(invoiceId)) bad(t, r, "bad Invoice ID");
  const clientId = text(f[x.clientId]), clientName = text(f[x.clientName]);
  if (!clientId || !RE.client.test(clientId) || !clientName) bad(t, r, `${invoiceId}: invalid client`);
  const status = INVOICE_STATUS_STORED[text(f[x.status]) ?? ""];
  const numberAuthority = NUMBER_AUTHORITY_STORED[text(f[x.numberAuthority]) ?? ""];
  if (!status || !numberAuthority) bad(t, r, `${invoiceId}: invalid Status / Invoice Number Authority`);
  const grossMinor = minor(f[x.gross] ?? 0, 0);
  if (grossMinor === null) bad(t, r, `${invoiceId}: invalid Gross`);
  const invoiceDate = isoOrNull(f[x.date]), dueDate = isoOrNull(f[x.due]);
  if (invoiceDate === undefined || dueDate === undefined) bad(t, r, `${invoiceId}: invalid dates`);
  if (isIssued({ status })) {
    if (!invoiceDate || !dueDate || dueDate < invoiceDate) bad(t, r, `${invoiceId}: an issued invoice needs its invoice date and due date`);
  } else if (invoiceDate || dueDate) bad(t, r, `${invoiceId}: an invoice awaiting external issue carries no invoice / due date`);
  return { invoiceId, clientId, clientName, status, numberAuthority, hubInvoiceNumber: text(f[x.hubNumber]), externalInvoiceNumber: text(f[x.extNumber]), invoiceDate, dueDate, grossMinor };
}

export function readCreditNote(r: Row): CreditNote {
  const f = r.fields, x = FF.credit, t = FINANCE_TABLES.creditNotes;
  const creditNoteId = text(f[x.id]), invoiceId = text(f[x.invoiceId]);
  if (!creditNoteId || !RE.creditNote.test(creditNoteId) || !invoiceId || !RE.invoice.test(invoiceId)) bad(t, r, "bad Credit Note / Invoice ID");
  const grossMinor = minor(f[x.gross] ?? 0, 0);
  if (grossMinor === null) bad(t, r, `${creditNoteId}: invalid Gross`);
  return { creditNoteId, invoiceId, grossMinor };
}

export function readPaymentEntry(r: Row): { kind: "payment"; value: Payment } | { kind: "reversal"; value: PaymentReversal } {
  const f = r.fields, x = FF.payment, t = FINANCE_TABLES.payments;
  const id = text(f[x.id]), type = text(f[x.type]);
  const invoiceId = text(f[x.invoiceId]), clientId = text(f[x.clientId]);
  const amountMinor = minor(f[x.amount], 1);
  const recordedAt = text(f[x.recordedAt]) ?? "";
  if (!id || !invoiceId || !RE.invoice.test(invoiceId) || !clientId || !RE.client.test(clientId) || amountMinor === null) bad(t, r, "invalid id / invoice / client / amount");
  if (type === "Reversal") {
    const paymentId = text(f[x.reverses]);
    if (!RE.paymentReversal.test(id) || !paymentId || !RE.payment.test(paymentId)) bad(t, r, `${id}: a reversal needs the payment it reverses`);
    return { kind: "reversal", value: { reversalId: id, paymentId, invoiceId, clientId, amountMinor, reason: "", recordedBy: "", recordedAt } };
  }
  if (type !== "Payment" || !RE.payment.test(id)) bad(t, r, `${id}: bad Entry Type`);
  const receivedDate = f[x.receivedDate];
  const source = PAYMENT_SOURCE_STORED[text(f[x.source]) ?? ""];
  if (!isIsoDate(receivedDate) || !source) bad(t, r, `${id}: invalid Received Date / Source`);
  return {
    kind: "payment",
    value: { paymentId: id, invoiceId, clientId, clientName: text(f[x.clientName]) ?? "", amountMinor, currency: CURRENCY, receivedDate, method: null, reference: null, source, externalProvider: null, externalPaymentId: null, reason: null, recordedBy: "", recordedAt },
  };
}

export function readClientCredit(r: Row): ClientCredit {
  const f = r.fields, x = FF.clientCredit, t = FINANCE_TABLES.credits;
  const creditId = text(f[x.id]), clientId = text(f[x.clientId]), sourceInvoiceId = text(f[x.sourceInvoiceId]);
  const source = CREDIT_SOURCE_STORED[text(f[x.source]) ?? ""];
  const status = CREDIT_STATUS_STORED[text(f[x.status]) ?? ""];
  const originalMinor = minor(f[x.original], 1);
  const sourceCreditNoteId = text(f[x.sourceCreditNoteId]);
  if (!creditId || !RE.credit.test(creditId) || !clientId || !RE.client.test(clientId) || !sourceInvoiceId || !RE.invoice.test(sourceInvoiceId) || !source || !status || originalMinor === null) bad(t, r, "invalid client credit");
  if (source === "credit_note" && (!sourceCreditNoteId || !RE.creditNote.test(sourceCreditNoteId))) bad(t, r, `${creditId}: a credit-note credit names its credit note`);
  const receivedDate = f[x.receivedDate];
  if (source === "overpayment" && !isIsoDate(receivedDate)) bad(t, r, `${creditId}: cash kept from an overpayment needs its Received Date`);
  return {
    creditId, clientId, clientName: text(f[x.clientName]) ?? "", source, sourceInvoiceId, sourceCreditNoteId: source === "credit_note" ? sourceCreditNoteId : null, sourcePaymentId: source === "overpayment" ? text(f[x.sourcePaymentId]) : null, receivedDate: source === "overpayment" ? (receivedDate as string) : null,
    originalMinor, remainingMinor: 0, currency: CURRENCY, status, reason: "", voidReason: null, voidedBy: null, voidedAt: null, createdBy: "", createdAt: "", revision: 1, updatedBy: "", updatedAt: "",
  };
}

export function readApplicationEntry(r: Row): { kind: "application"; value: CreditApplication } | { kind: "reversal"; value: ApplicationReversal } {
  const f = r.fields, x = FF.application, t = FINANCE_TABLES.applications;
  const id = text(f[x.id]), type = text(f[x.type]);
  const creditId = text(f[x.creditId]), invoiceId = text(f[x.invoiceId]), clientId = text(f[x.clientId]);
  const amountMinor = minor(f[x.amount], 1);
  const recordedAt = text(f[x.recordedAt]) ?? "";
  if (!id || !creditId || !RE.credit.test(creditId) || !invoiceId || !RE.invoice.test(invoiceId) || !clientId || !RE.client.test(clientId) || amountMinor === null) bad(t, r, "invalid credit / invoice / client / amount");
  if (type === "Reversal") {
    const applicationId = text(f[x.reverses]);
    if (!RE.applicationReversal.test(id) || !applicationId || !RE.application.test(applicationId)) bad(t, r, `${id}: a reversal needs the application it reverses`);
    return { kind: "reversal", value: { reversalId: id, applicationId, creditId, invoiceId, clientId, amountMinor, reason: "", recordedBy: "", recordedAt } };
  }
  if (type !== "Application" || !RE.application.test(id)) bad(t, r, `${id}: bad Entry Type`);
  return { kind: "application", value: { applicationId: id, creditId, invoiceId, clientId, amountMinor, reason: null, recordedBy: "", recordedAt } };
}

export function readDueChange(r: Row): DueDateChange {
  const f = r.fields, x = FF.due, t = FINANCE_TABLES.dueChanges;
  const changeId = text(f[x.id]), invoiceId = text(f[x.invoiceId]), changedAt = text(f[x.changedAt]);
  const previousDueDate = f[x.previous], newDueDate = f[x.next];
  if (!changeId || !RE.due.test(changeId) || !invoiceId || !RE.invoice.test(invoiceId) || !changedAt || !isIsoDate(previousDueDate) || !isIsoDate(newDueDate) || previousDueDate === newDueDate) bad(t, r, "invalid due date change");
  return { changeId, invoiceId, previousDueDate, newDueDate, reason: "", changedBy: "", changedAt };
}

// ---------------------------------------------------------------------
// One receivable pass per request (memoised on the shared sources object)
// ---------------------------------------------------------------------

export interface OverdueItem {
  invoice: Invoice;
  rec: Receivable;
}

export interface ReceivablePass {
  today: string;
  invoices: number;
  awaitingExternalIssue: number;
  overdue: OverdueItem[];
  /** F17: every issued invoice's receivable (any state) + the history Cash Flow needs (receipts after the balance date). */
  receivables: OverdueItem[];
  awaitingExternalIssueGrossMinor: number;
  payments: Payment[];
  paymentReversals: PaymentReversal[];
  credits: ClientCredit[];
}

const passCache = new WeakMap<object, ReceivablePass>();
let passRuns = 0;
/** Test hook: how many receivable passes actually ran (memoisation proof). */
export function receivablePassStats() {
  return { runs: passRuns };
}

function dupes(ids: string[], what: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new FinanceDataError(`duplicate ${what} ${id}`);
    seen.add(id);
  }
}

export function runReceivablePass(ctx: EvaluatorContext): ReceivablePass {
  const cached = passCache.get(ctx.sources);
  if (cached) return cached;
  passRuns++;
  const org = ctx.organisation.recordId;
  const today = localDateIso(ctx.now, ctx.organisation.timezone);
  const src = (t: string) => ownRows(ctx.sources[t] as Row[] | undefined, org, t);
  const invoices = src(FINANCE_TABLES.invoices).map(readInvoice);
  const notes = src(FINANCE_TABLES.creditNotes).map(readCreditNote);
  const paymentRows = src(FINANCE_TABLES.payments).map(readPaymentEntry);
  const credits = src(FINANCE_TABLES.credits).map(readClientCredit);
  const applicationRows = src(FINANCE_TABLES.applications).map(readApplicationEntry);
  const dueChanges = src(FINANCE_TABLES.dueChanges).map(readDueChange);
  dupes(invoices.map((i) => i.invoiceId), "invoice");
  dupes(notes.map((n) => n.creditNoteId), "credit note");
  dupes(paymentRows.map((p) => (p.kind === "payment" ? p.value.paymentId : p.value.reversalId)), "payment entry");
  dupes(credits.map((c) => c.creditId), "client credit");
  dupes(applicationRows.map((a) => (a.kind === "application" ? a.value.applicationId : a.value.reversalId)), "credit application entry");
  dupes(dueChanges.map((d) => d.changeId), "due date change");

  const by = <T>(xs: readonly T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return (k: string) => m.get(k) ?? [];
  };
  const payments = paymentRows.flatMap((p) => (p.kind === "payment" ? [p.value] : []));
  const paymentReversals = paymentRows.flatMap((p) => (p.kind === "reversal" ? [p.value] : []));
  const applications = applicationRows.flatMap((a) => (a.kind === "application" ? [a.value] : []));
  const applicationReversals = applicationRows.flatMap((a) => (a.kind === "reversal" ? [a.value] : []));
  const notesOf = by(notes, (n) => n.invoiceId);
  const paymentsOf = by(payments, (p) => p.invoiceId);
  const paymentReversalsOf = by(paymentReversals, (r) => r.invoiceId);
  const applicationsOf = by(applications, (a) => a.invoiceId);
  const applicationReversalsOf = by(applicationReversals, (r) => r.invoiceId);
  const noteCreditsOf = by(credits.filter((c) => c.source === "credit_note"), (c) => c.sourceInvoiceId);
  const dueChangesOf = by(dueChanges, (d) => d.invoiceId);

  let awaitingExternalIssue = 0;
  let awaitingExternalIssueGrossMinor = 0;
  const overdue: OverdueItem[] = [];
  const receivables: OverdueItem[] = [];
  for (const invoice of invoices) {
    let rec: Receivable | NotReceivable;
    try {
      rec = receivableOf(
        invoice,
        {
          notes: notesOf(invoice.invoiceId),
          payments: paymentsOf(invoice.invoiceId),
          paymentReversals: paymentReversalsOf(invoice.invoiceId),
          applications: applicationsOf(invoice.invoiceId),
          applicationReversals: applicationReversalsOf(invoice.invoiceId),
          creditsFromNotes: noteCreditsOf(invoice.invoiceId),
          dueChanges: dueChangesOf(invoice.invoiceId),
        },
        today
      );
    } catch (e) {
      throw new FinanceDataError(`Stored receivable history does not add up (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!rec.receivable) {
      awaitingExternalIssue++;
      awaitingExternalIssueGrossMinor += invoice.grossMinor;
      continue;
    }
    receivables.push({ invoice, rec });
    if (rec.dueState === "overdue" && rec.outstandingMinor > 0) overdue.push({ invoice, rec });
  }
  const out = { today, invoices: invoices.length, awaitingExternalIssue, overdue, receivables, awaitingExternalIssueGrossMinor, payments, paymentReversals, credits };
  passCache.set(ctx.sources, out);
  return out;
}

// ---------------------------------------------------------------------
// invoice_overdue (ATT-047)
// ---------------------------------------------------------------------

/** Pence -> "12.34" (never negative here: outstanding is floored at 0 by receivableOf). */
export function pounds(m: number): string {
  return `${Math.floor(m / 100)}.${String(m % 100).padStart(2, "0")}`;
}

export function officialNumber(i: Invoice): string | null {
  return i.numberAuthority === "hub" ? i.hubInvoiceNumber : i.externalInvoiceNumber;
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function overdueCase(item: OverdueItem, timeZone: string): CandidateCase {
  const { invoice: i, rec: r } = item;
  const number = officialNumber(i);
  const label = number ?? i.invoiceId;
  const days = r.daysOverdue!;
  return {
    subjects: [{ type: "invoice", id: i.invoiceId }],
    title: `Invoice ${label} overdue - ${i.clientName}`,
    detail: `£${pounds(r.outstandingMinor)} outstanding (of £${pounds(r.grossMinor)}), due ${r.dueDate}, ${days} day${days === 1 ? "" : "s"} overdue${r.dueDateMoved ? ` (due date moved from ${r.originalDueDate})` : ""}`,
    anchors: { outstandingSince: localMidnightIso(nextDay(r.dueDate!), timeZone) },
    anchorTime: localMidnightIso(r.dueDate!, timeZone),
    destination: { route: "finance/invoice-receivable", params: { invoiceId: i.invoiceId } },
    targetIds: { invoiceId: i.invoiceId, clientId: i.clientId },
    context: {
      invoiceId: i.invoiceId,
      invoiceNumber: number,
      clientId: i.clientId,
      clientName: i.clientName,
      currency: CURRENCY,
      outstanding: pounds(r.outstandingMinor),
      gross: pounds(r.grossMinor),
      cashReceived: pounds(r.cashReceivedMinor),
      clientCreditApplied: pounds(r.creditAppliedMinor),
      creditNotes: pounds(r.creditNotesMinor),
      settlement: r.settlement,
      invoiceDate: r.invoiceDate,
      dueDate: r.dueDate,
      originalDueDate: r.originalDueDate,
      dueDateMoved: r.dueDateMoved,
      daysOverdue: days,
      asOf: r.asOf,
      sourceApi: `GET /finance/invoices/${i.invoiceId}/receivable`,
    },
  };
}

export const INVOICE_OVERDUE_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "invoice_overdue",
  ruleId: "ATT-047",
  sources: INVOICE_OVERDUE_SOURCES,
  evaluate(ctx) {
    const pass = runReceivablePass(ctx);
    return pass.overdue.map((item) => overdueCase(item, ctx.organisation.timezone));
  },
};

export const FINANCE_EVALUATORS: readonly EvaluatorRegistration[] = [INVOICE_OVERDUE_EVALUATOR];

// ---------------------------------------------------------------------
// Finance capability filter (F8a, locked)
// ---------------------------------------------------------------------

/** A rule is a Finance rule when the catalogue gates it on module_finance. */
export function isFinanceRule(rule: Pick<RuleDef, "requiredModule">): boolean {
  return rule.requiredModule === FINANCE_MODULE_KEY;
}

/** True when some Finance rule would run - only then is the caller's Finance grant looked up at all. */
export function needsFinanceAccess(plan: Plan): boolean {
  return plan.entries.some((e) => e.run && isFinanceRule(e.rule));
}

/**
 * Without Finance View or Manage, every Finance rule is skipped
 * (finance_access_required) and removed from the sources to load, so no
 * Finance table is read and no Finance case, count or detail can appear.
 */
export function restrictFinanceRules(plan: Plan, access: FinanceAccess): Plan {
  if (access === "view" || access === "manage") return plan;
  const entries: PlanEntry[] = plan.entries.map((e) =>
    e.run && isFinanceRule(e.rule) ? { ...e, run: false, skipReason: "finance_access_required", skipDetail: "Finance cases are shown only to Finance View / Manage" } : e
  );
  const sources = new Set<string>();
  for (const e of entries) if (e.run) for (const s of e.evaluator!.sources) sources.add(s);
  return { ...plan, entries, sourcesToLoad: [...sources].sort() };
}

/** Exceptions (snooze) on a Finance case are Finance Manage only. */
export function canManageFinanceExceptions(access: FinanceAccess | null): boolean {
  return access === "manage";
}
