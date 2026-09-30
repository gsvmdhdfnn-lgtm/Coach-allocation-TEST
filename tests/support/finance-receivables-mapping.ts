/**
 * Test-suite copy of the canonical finance/finance-receivables-mapping.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance receivables + payments + client credit - storage mapping, PURE
 * (Finance Foundation F7; see TEST-ENV.md "Finance Foundation - F7").
 * Translates the transitional TEST Airtable rows of "Finance Payments",
 * "Finance Client Credits", "Finance Client Credit Applications" and
 * "Finance Invoice Due Date Changes" to/from the domain in finance-receivables.ts.
 *
 *   - A payment row, a payment reversal row, an application row, an
 *     application reversal row and a due date change row are created once
 *     and never edited or deleted (history).
 *   - A client credit row is created once; afterwards ONLY its remaining
 *     value / status / void fields and revision are patched
 *     (clientCreditStateFields), and the remaining value is re-checked
 *     against its applications on every read.
 *   - The invoice row is never touched by F7.
 *
 * Every row is validated on read; anything that does not validate is
 * INVALID data (409) - never skipped, repaired or guessed.
 */
import { type Minor, MAX_MINOR } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { REASON_MAX } from "./finance-commercial.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { CURRENCY } from "./finance-issue.ts";
import {
  type ApplicationReversal,
  type ClientCredit,
  type ClientCreditSource,
  type ClientCreditStatus,
  type CreditApplication,
  type DueDateChange,
  type Payment,
  type PaymentMethod,
  type PaymentReversal,
  type PaymentSource,
  APPLICATION_ID_PATTERN,
  APPLICATION_REVERSAL_ID_PATTERN,
  CLIENT_CREDIT_ID_PATTERN,
  CLIENT_ID_PATTERN,
  CORRECTION_ID_PATTERN,
  DUE_CHANGE_ID_PATTERN,
  INVOICE_ID_PATTERN,
  PAYMENT_ID_PATTERN,
  PAYMENT_REVERSAL_ID_PATTERN,
  REFERENCE_MAX,
} from "./finance-receivables.ts";

export const RECEIVABLE_TABLES = {
  payments: "Finance Payments",
  credits: "Finance Client Credits",
  applications: "Finance Client Credit Applications",
  dueChanges: "Finance Invoice Due Date Changes",
} as const;

export const FR = {
  org: "Organisation",
  payment: {
    id: "Payment Entry ID",
    type: "Entry Type",
    reverses: "Reverses Payment ID",
    invoiceId: "Invoice ID",
    clientId: "Client ID",
    clientName: "Client Name",
    amount: "Amount (Minor Units)",
    currency: "Currency",
    receivedDate: "Received Date",
    method: "Method",
    reference: "Reference",
    source: "Source",
    extProvider: "External Provider",
    extId: "External Payment ID",
    reason: "Reason",
    recordedBy: "Recorded By User ID",
    recordedAt: "Recorded At",
  },
  credit: {
    id: "Client Credit ID",
    clientId: "Client ID",
    clientName: "Client Name",
    source: "Source",
    sourceInvoiceId: "Source Invoice ID",
    sourceCreditNoteId: "Source Credit Note ID",
    sourcePaymentId: "Source Payment ID",
    receivedDate: "Received Date",
    original: "Original (Minor Units)",
    remaining: "Remaining (Minor Units)",
    currency: "Currency",
    status: "Status",
    reason: "Reason",
    voidReason: "Void Reason",
    voidedBy: "Voided By User ID",
    voidedAt: "Voided At",
    createdBy: "Created By User ID",
    createdAt: "Created At",
    revision: "Revision",
    changedBy: "Last Changed By User ID",
    changedAt: "Last Changed At",
  },
  application: {
    id: "Application Entry ID",
    type: "Entry Type",
    reverses: "Reverses Application ID",
    creditId: "Client Credit ID",
    invoiceId: "Invoice ID",
    clientId: "Client ID",
    amount: "Amount (Minor Units)",
    currency: "Currency",
    reason: "Reason",
    recordedBy: "Recorded By User ID",
    recordedAt: "Recorded At",
  },
  due: {
    id: "Due Date Change ID",
    invoiceId: "Invoice ID",
    previous: "Previous Due Date",
    next: "New Due Date",
    reason: "Reason",
    changedBy: "Changed By User ID",
    changedAt: "Changed At",
  },
} as const;

const PAYMENT_TYPE = { payment: "Payment", reversal: "Reversal" } as const;
const APPLICATION_TYPE = { application: "Application", reversal: "Reversal" } as const;
const METHOD: Record<PaymentMethod, string> = { bank_transfer: "Bank transfer", card: "Card", cheque: "Cheque", cash: "Cash", other: "Other" };
const SOURCE: Record<PaymentSource, string> = { manual: "Manual", xero: "Xero" };
const CREDIT_SOURCE: Record<ClientCreditSource, string> = { credit_note: "Credit note", overpayment: "Overpayment" };
const CREDIT_STATUS: Record<ClientCreditStatus, string> = { available: "Available", used: "Used", void: "Void" };

const nameOf = (v: unknown) => (v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : v);
function reverse<T extends string>(map: Record<T, string>, label: unknown): T | undefined {
  const name = nameOf(label);
  return (Object.keys(map) as T[]).find((k) => map[k] === name);
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const amount = (v: unknown): Minor | undefined => int(v, 1, MAX_MINOR);
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const at = (v: unknown): string | null => {
  const s = str(v);
  return s && ISO_AT.test(s) ? s : null;
};

type Parsed<T> = { ok: true; recordId: string; value: T } | { ok: false; problem: string };
export type PaymentEntry = { kind: "payment"; value: Payment } | { kind: "reversal"; value: PaymentReversal };
export type ApplicationEntry = { kind: "application"; value: CreditApplication } | { kind: "reversal"; value: ApplicationReversal };

export function paymentEntryFromRow(r: Row): Parsed<PaymentEntry> {
  const f = r.fields ?? {};
  const x = FR.payment;
  const id = str(f[x.id]);
  const type = nameOf(f[x.type]);
  const okId = id && ((type === PAYMENT_TYPE.payment && PAYMENT_ID_PATTERN.test(id)) || (type === PAYMENT_TYPE.reversal && PAYMENT_REVERSAL_ID_PATTERN.test(id)));
  if (!okId) return { ok: false, problem: `payment row ${r.id}: bad Payment Entry ID / Entry Type` };
  const bad = (why: string): Parsed<PaymentEntry> => ({ ok: false, problem: `payment entry ${id}: ${why}` });
  if (links(f[FR.org]).length !== 1) return bad("must link exactly one organisation");
  const invoiceId = str(f[x.invoiceId]);
  const clientId = str(f[x.clientId]);
  if (!invoiceId || !INVOICE_ID_PATTERN.test(invoiceId) || !clientId || !CLIENT_ID_PATTERN.test(clientId)) return bad("invalid invoice / client references");
  const amt = amount(f[x.amount]);
  if (amt === undefined) return bad("invalid Amount");
  if (str(f[x.currency]) !== CURRENCY) return bad("invalid Currency");
  const recordedBy = str(f[x.recordedBy]);
  const recordedAt = at(f[x.recordedAt]);
  if (!recordedBy || !recordedAt) return bad("missing recorded metadata");
  const reason = str(f[x.reason]);
  if (reason && reason.length > REASON_MAX) return bad("invalid Reason");
  if (type === PAYMENT_TYPE.reversal) {
    const reverses = str(f[x.reverses]);
    if (!reverses || !PAYMENT_ID_PATTERN.test(reverses) || !reason) return bad("a reversal needs the payment it reverses and a reason");
    for (const k of [x.receivedDate, x.method, x.reference, x.source, x.extProvider, x.extId]) if (f[k] !== undefined && f[k] !== null && f[k] !== "") return bad(`a reversal carries no ${k}`);
    return { ok: true, recordId: r.id, value: { kind: "reversal", value: { reversalId: id, paymentId: reverses, invoiceId, clientId, amountMinor: amt, reason, recordedBy, recordedAt } } };
  }
  if (str(f[x.reverses])) return bad("a payment cannot reverse another payment");
  const clientName = str(f[x.clientName]);
  const received = f[x.receivedDate];
  if (!clientName || !isIsoDate(received)) return bad("invalid client name / Received Date");
  const methodRaw = f[x.method];
  const method = methodRaw === undefined || methodRaw === null ? null : reverse(METHOD, methodRaw) ?? undefined;
  if (method === undefined) return bad("invalid Method");
  const reference = str(f[x.reference]);
  if (reference && reference.length > REFERENCE_MAX) return bad("invalid Reference");
  const source = reverse(SOURCE, f[x.source]);
  if (!source) return bad("invalid Source");
  const extProvider = str(f[x.extProvider]);
  const extId = str(f[x.extId]);
  // Manual payments carry no provider ids; a provider payment (F9) carries both.
  if (source === "manual" ? extProvider !== null || extId !== null : extProvider === null || extId === null) return bad("external provider fields do not match Source");
  return {
    ok: true,
    recordId: r.id,
    value: { kind: "payment", value: { paymentId: id, invoiceId, clientId, clientName, amountMinor: amt, currency: CURRENCY, receivedDate: received as string, method, reference, source, externalProvider: extProvider, externalPaymentId: extId, reason, recordedBy, recordedAt } },
  };
}

export function clientCreditFromRow(r: Row): Parsed<ClientCredit> {
  const f = r.fields ?? {};
  const x = FR.credit;
  const id = str(f[x.id]);
  if (!id || !CLIENT_CREDIT_ID_PATTERN.test(id)) return { ok: false, problem: `client credit row ${r.id}: bad Client Credit ID` };
  const bad = (why: string): Parsed<ClientCredit> => ({ ok: false, problem: `client credit ${id}: ${why}` });
  if (links(f[FR.org]).length !== 1) return bad("must link exactly one organisation");
  const clientId = str(f[x.clientId]);
  const clientName = str(f[x.clientName]);
  if (!clientId || !CLIENT_ID_PATTERN.test(clientId) || !clientName) return bad("invalid client references");
  const source = reverse(CREDIT_SOURCE, f[x.source]);
  if (!source) return bad("invalid Source");
  const sourceInvoiceId = str(f[x.sourceInvoiceId]);
  const sourceCreditNoteId = str(f[x.sourceCreditNoteId]);
  const sourcePaymentId = str(f[x.sourcePaymentId]);
  const receivedRaw = f[x.receivedDate] ?? null;
  if (!sourceInvoiceId || !INVOICE_ID_PATTERN.test(sourceInvoiceId)) return bad("invalid Source Invoice ID");
  if (source === "credit_note") {
    if (!sourceCreditNoteId || !CORRECTION_ID_PATTERN.test(sourceCreditNoteId) || sourcePaymentId !== null || receivedRaw !== null) return bad("a credit-note credit names its credit note and carries no payment / received date");
  } else if (!sourcePaymentId || !PAYMENT_ID_PATTERN.test(sourcePaymentId) || sourceCreditNoteId !== null || !isIsoDate(receivedRaw)) return bad("an overpayment credit names its payment and the date the cash arrived");
  const original = amount(f[x.original]);
  const remaining = int(f[x.remaining] ?? 0, 0, MAX_MINOR);
  if (original === undefined || remaining === undefined || remaining > original) return bad("invalid Original / Remaining");
  if (str(f[x.currency]) !== CURRENCY) return bad("invalid Currency");
  const status = reverse(CREDIT_STATUS, f[x.status]);
  if (!status) return bad("invalid Status");
  const voidReason = str(f[x.voidReason]);
  const voidedBy = str(f[x.voidedBy]);
  const voidedAt = at(f[x.voidedAt]);
  if (status === "void" ? !voidReason || !voidedBy || !voidedAt : voidReason !== null || voidedBy !== null || f[x.voidedAt] !== undefined && f[x.voidedAt] !== null) return bad("void fields do not match Status");
  if (status === "used" && remaining !== 0) return bad("a used credit has nothing remaining");
  if (status === "available" && remaining === 0) return bad("an available credit has something remaining");
  const reason = str(f[x.reason]);
  const createdBy = str(f[x.createdBy]);
  const createdAt = at(f[x.createdAt]);
  const changedBy = str(f[x.changedBy]);
  const changedAt = at(f[x.changedAt]);
  const revision = int(f[x.revision], 1, Number.MAX_SAFE_INTEGER);
  if (!reason || reason.length > REASON_MAX || !createdBy || !createdAt || !changedBy || !changedAt || revision === undefined) return bad("invalid reason / created / revision metadata");
  return {
    ok: true,
    recordId: r.id,
    value: { creditId: id, clientId, clientName, source, sourceInvoiceId, sourceCreditNoteId, sourcePaymentId, receivedDate: receivedRaw as string | null, originalMinor: original, remainingMinor: remaining, currency: CURRENCY, status, reason, voidReason, voidedBy, voidedAt, createdBy, createdAt, revision, updatedBy: changedBy, updatedAt: changedAt },
  };
}

export function applicationEntryFromRow(r: Row): Parsed<ApplicationEntry> {
  const f = r.fields ?? {};
  const x = FR.application;
  const id = str(f[x.id]);
  const type = nameOf(f[x.type]);
  const okId = id && ((type === APPLICATION_TYPE.application && APPLICATION_ID_PATTERN.test(id)) || (type === APPLICATION_TYPE.reversal && APPLICATION_REVERSAL_ID_PATTERN.test(id)));
  if (!okId) return { ok: false, problem: `credit application row ${r.id}: bad Application Entry ID / Entry Type` };
  const bad = (why: string): Parsed<ApplicationEntry> => ({ ok: false, problem: `credit application entry ${id}: ${why}` });
  if (links(f[FR.org]).length !== 1) return bad("must link exactly one organisation");
  const creditId = str(f[x.creditId]);
  const invoiceId = str(f[x.invoiceId]);
  const clientId = str(f[x.clientId]);
  if (!creditId || !CLIENT_CREDIT_ID_PATTERN.test(creditId) || !invoiceId || !INVOICE_ID_PATTERN.test(invoiceId) || !clientId || !CLIENT_ID_PATTERN.test(clientId)) return bad("invalid credit / invoice / client references");
  const amt = amount(f[x.amount]);
  if (amt === undefined) return bad("invalid Amount");
  if (str(f[x.currency]) !== CURRENCY) return bad("invalid Currency");
  const reason = str(f[x.reason]);
  if (reason && reason.length > REASON_MAX) return bad("invalid Reason");
  const recordedBy = str(f[x.recordedBy]);
  const recordedAt = at(f[x.recordedAt]);
  if (!recordedBy || !recordedAt) return bad("missing recorded metadata");
  if (type === APPLICATION_TYPE.reversal) {
    const reverses = str(f[x.reverses]);
    if (!reverses || !APPLICATION_ID_PATTERN.test(reverses) || !reason) return bad("a reversal needs the application it reverses and a reason");
    return { ok: true, recordId: r.id, value: { kind: "reversal", value: { reversalId: id, applicationId: reverses, creditId, invoiceId, clientId, amountMinor: amt, reason, recordedBy, recordedAt } } };
  }
  if (str(f[x.reverses])) return bad("an application cannot reverse another application");
  return { ok: true, recordId: r.id, value: { kind: "application", value: { applicationId: id, creditId, invoiceId, clientId, amountMinor: amt, reason, recordedBy, recordedAt } } };
}

export function dueChangeFromRow(r: Row): Parsed<DueDateChange> {
  const f = r.fields ?? {};
  const x = FR.due;
  const id = str(f[x.id]);
  if (!id || !DUE_CHANGE_ID_PATTERN.test(id)) return { ok: false, problem: `due date change row ${r.id}: bad Due Date Change ID` };
  const bad = (why: string): Parsed<DueDateChange> => ({ ok: false, problem: `due date change ${id}: ${why}` });
  if (links(f[FR.org]).length !== 1) return bad("must link exactly one organisation");
  const invoiceId = str(f[x.invoiceId]);
  if (!invoiceId || !INVOICE_ID_PATTERN.test(invoiceId)) return bad("invalid Invoice ID");
  const prev = f[x.previous];
  const next = f[x.next];
  if (!isIsoDate(prev) || !isIsoDate(next) || prev === next) return bad("invalid Previous / New Due Date");
  const reason = str(f[x.reason]);
  const changedBy = str(f[x.changedBy]);
  const changedAt = at(f[x.changedAt]);
  if (!reason || reason.length > REASON_MAX || !changedBy || !changedAt) return bad("missing reason / changed metadata");
  return { ok: true, recordId: r.id, value: { changeId: id, invoiceId, previousDueDate: prev as string, newDueDate: next as string, reason, changedBy, changedAt } };
}

type Built<T> = { ok: true; items: { recordId: string; value: T }[] } | { ok: false; error: string };

function buildAll<T>(rows: Row[], orgRec: string, parse: (r: Row) => Parsed<T>, idOf: (t: T) => string, what: string): Built<T> {
  const problems: string[] = [];
  const out: { recordId: string; value: T }[] = [];
  for (const r of rows) {
    const org = links(r.fields?.[FR.org]);
    if (org.length !== 1 || org[0] !== orgRec) {
      problems.push(`row ${r.id} does not belong to this organisation`);
      continue;
    }
    const p = parse(r);
    if (p.ok) out.push({ recordId: p.recordId, value: p.value });
    else problems.push(p.problem);
  }
  const ids = out.map((o) => idOf(o.value));
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) problems.push(`duplicate id ${d}`);
  if (problems.length) return { ok: false, error: `Stored ${what} are not valid (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; +${problems.length - 3} more` : ""}) - they must be corrected before use` };
  return { ok: true, items: out };
}

export function buildPaymentEntries(rows: Row[], orgRec: string): { ok: true; payments: Payment[]; reversals: PaymentReversal[] } | { ok: false; error: string } {
  const b = buildAll(rows, orgRec, paymentEntryFromRow, (e) => (e.kind === "payment" ? e.value.paymentId : e.value.reversalId), "payments");
  if (!b.ok) return b;
  return { ok: true, payments: b.items.flatMap((i) => (i.value.kind === "payment" ? [i.value.value] : [])), reversals: b.items.flatMap((i) => (i.value.kind === "reversal" ? [i.value.value] : [])) };
}
export function buildClientCredits(rows: Row[], orgRec: string): { ok: true; credits: { recordId: string; value: ClientCredit }[] } | { ok: false; error: string } {
  const b = buildAll(rows, orgRec, clientCreditFromRow, (c) => c.creditId, "client credits");
  return b.ok ? { ok: true, credits: b.items } : b;
}
export function buildApplicationEntries(rows: Row[], orgRec: string): { ok: true; applications: CreditApplication[]; reversals: ApplicationReversal[] } | { ok: false; error: string } {
  const b = buildAll(rows, orgRec, applicationEntryFromRow, (e) => (e.kind === "application" ? e.value.applicationId : e.value.reversalId), "client credit applications");
  if (!b.ok) return b;
  return { ok: true, applications: b.items.flatMap((i) => (i.value.kind === "application" ? [i.value.value] : [])), reversals: b.items.flatMap((i) => (i.value.kind === "reversal" ? [i.value.value] : [])) };
}
export function buildDueChanges(rows: Row[], orgRec: string): { ok: true; changes: DueDateChange[] } | { ok: false; error: string } {
  const b = buildAll(rows, orgRec, dueChangeFromRow, (c) => c.changeId, "due date changes");
  return b.ok ? { ok: true, changes: b.items.map((i) => i.value) } : b;
}

// ----- domain -> Airtable fields -----

export function paymentCreateFields(p: Payment, orgRecordId: string): Record<string, unknown> {
  const x = FR.payment;
  return {
    [FR.org]: [orgRecordId],
    [x.id]: p.paymentId,
    [x.type]: PAYMENT_TYPE.payment,
    [x.invoiceId]: p.invoiceId,
    [x.clientId]: p.clientId,
    [x.clientName]: p.clientName,
    [x.amount]: p.amountMinor,
    [x.currency]: p.currency,
    [x.receivedDate]: p.receivedDate,
    [x.method]: p.method ? METHOD[p.method] : null,
    [x.reference]: p.reference,
    [x.source]: SOURCE[p.source],
    [x.extProvider]: p.externalProvider,
    [x.extId]: p.externalPaymentId,
    [x.reason]: p.reason,
    [x.recordedBy]: p.recordedBy,
    [x.recordedAt]: p.recordedAt,
  };
}

export function paymentReversalCreateFields(r: PaymentReversal, orgRecordId: string): Record<string, unknown> {
  const x = FR.payment;
  return {
    [FR.org]: [orgRecordId],
    [x.id]: r.reversalId,
    [x.type]: PAYMENT_TYPE.reversal,
    [x.reverses]: r.paymentId,
    [x.invoiceId]: r.invoiceId,
    [x.clientId]: r.clientId,
    [x.amount]: r.amountMinor,
    [x.currency]: CURRENCY,
    [x.reason]: r.reason,
    [x.recordedBy]: r.recordedBy,
    [x.recordedAt]: r.recordedAt,
  };
}

export function clientCreditCreateFields(c: ClientCredit, orgRecordId: string): Record<string, unknown> {
  const x = FR.credit;
  return {
    [FR.org]: [orgRecordId],
    [x.id]: c.creditId,
    [x.clientId]: c.clientId,
    [x.clientName]: c.clientName,
    [x.source]: CREDIT_SOURCE[c.source],
    [x.sourceInvoiceId]: c.sourceInvoiceId,
    [x.sourceCreditNoteId]: c.sourceCreditNoteId,
    [x.sourcePaymentId]: c.sourcePaymentId,
    [x.receivedDate]: c.receivedDate,
    [x.original]: c.originalMinor,
    [x.currency]: c.currency,
    [x.reason]: c.reason,
    [x.createdBy]: c.createdBy,
    [x.createdAt]: c.createdAt,
    ...clientCreditStateFields(c),
  };
}

/** The ONLY patch ever made to a client credit row: remaining value, status, void fields, revision. The undo writes the previous values back. */
export function clientCreditStateFields(c: ClientCredit): Record<string, unknown> {
  const x = FR.credit;
  return { [x.remaining]: c.remainingMinor, [x.status]: CREDIT_STATUS[c.status], [x.voidReason]: c.voidReason, [x.voidedBy]: c.voidedBy, [x.voidedAt]: c.voidedAt, [x.revision]: c.revision, [x.changedBy]: c.updatedBy, [x.changedAt]: c.updatedAt };
}

export function applicationCreateFields(a: CreditApplication, orgRecordId: string): Record<string, unknown> {
  const x = FR.application;
  return { [FR.org]: [orgRecordId], [x.id]: a.applicationId, [x.type]: APPLICATION_TYPE.application, [x.creditId]: a.creditId, [x.invoiceId]: a.invoiceId, [x.clientId]: a.clientId, [x.amount]: a.amountMinor, [x.currency]: CURRENCY, [x.reason]: a.reason, [x.recordedBy]: a.recordedBy, [x.recordedAt]: a.recordedAt };
}

export function applicationReversalCreateFields(r: ApplicationReversal, orgRecordId: string): Record<string, unknown> {
  const x = FR.application;
  return { [FR.org]: [orgRecordId], [x.id]: r.reversalId, [x.type]: APPLICATION_TYPE.reversal, [x.reverses]: r.applicationId, [x.creditId]: r.creditId, [x.invoiceId]: r.invoiceId, [x.clientId]: r.clientId, [x.amount]: r.amountMinor, [x.currency]: CURRENCY, [x.reason]: r.reason, [x.recordedBy]: r.recordedBy, [x.recordedAt]: r.recordedAt };
}

export function dueChangeCreateFields(c: DueDateChange, orgRecordId: string): Record<string, unknown> {
  const x = FR.due;
  return { [FR.org]: [orgRecordId], [x.id]: c.changeId, [x.invoiceId]: c.invoiceId, [x.previous]: c.previousDueDate, [x.next]: c.newDueDate, [x.reason]: c.reason, [x.changedBy]: c.changedBy, [x.changedAt]: c.changedAt };
}
