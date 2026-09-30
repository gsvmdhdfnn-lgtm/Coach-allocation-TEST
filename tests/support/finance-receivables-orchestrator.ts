/**
 * Test-suite copy of the canonical finance/finance-receivables-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts.
 */
/**
 * Finance receivables + payments received + client credit - orchestration
 * (Finance Foundation F7; see TEST-ENV.md "Finance Foundation - F7"). Every
 * route authorises through F1's authorizeFinance() first - View reads,
 * Manage writes; no new auth.
 *
 * Reads (View) derive every receivable from stored, immutable history only
 * (the F6 invoice + credit notes, payments, reversals, credit applications,
 * due date moves) - nothing is cached on the invoice, nothing re-runs F4.
 *
 * Writes (Manage) follow the F3-F6 write discipline exactly:
 *   1. authorise (manage)
 *   2. the per-organisation Finance write lock - the SAME lock F3-F6 take,
 *      so a payment, a credit application and a credit note can never
 *      interleave on one invoice, two full payments can never both land and
 *      two applications can never overspend one credit      -> 409 busy
 *   3. load everything UNDER the lock and re-derive the receivable / credit
 *      balance, re-checking every rule                      -> 400 / 404 / 409, nothing written
 *   4. the Airtable writes (only the four F7 tables), each registered with its undo
 *   5. the audit event, in ONE insert
 *   Failure in 4 or 5 undoes this request's writes and returns 503; if the
 *   undo fails the caller gets 500 (never "success").
 *   6. release the lock (always)
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { acquireWriteLock, insertAuditEvents, releaseWriteLock } from "./finance-commercial-repository.ts";
import { formatMinor } from "./finance-money.ts";
import { DraftTxn } from "./finance-invoicing-orchestrator.ts";
import { type CreditNote, type Invoice, isIssued } from "./finance-issue.ts";
import { buildCreditNotes, buildInvoices } from "./finance-issue-mapping.ts";
import { findCreditNoteRows } from "./finance-issue-repository.ts";
import { type IssueDeps, type LoadedInvoice, loadInvoice } from "./finance-issue-orchestrator.ts";
import {
  type ApplicationReversal,
  type ClientCredit,
  type CreditApplication,
  type DueDateChange,
  type NotReceivable,
  type Payment,
  type PaymentRequest,
  type PaymentReversal,
  type Receivable,
  type ReceivableIdPrefix,
  ENTITY_CLIENT_CREDIT,
  ENTITY_INVOICE,
  ENTITY_PAYMENT,
  RECEIVABLES_CONTRACT,
  RECEIVABLE_EVENTS,
  auditCredit,
  auditPayment,
  auditRec,
  creditBalance,
  newReceivableId,
  orderedDueChanges,
  planApplication,
  planApplicationReversal,
  planCreditFromNote,
  planCreditFromOverpayment,
  planDueDateChange,
  planPayment,
  planPaymentReversal,
  planVoid,
  publicApplication,
  publicClientCredit,
  publicDueChange,
  publicPayment,
  publicReceipt,
  publicReceivable,
  receiptFacts,
  receivableAuditEvent,
  receivableOf,
} from "./finance-receivables.ts";
import {
  RECEIVABLE_TABLES,
  applicationCreateFields,
  applicationReversalCreateFields,
  buildApplicationEntries,
  buildClientCredits,
  buildDueChanges,
  buildPaymentEntries,
  clientCreditCreateFields,
  clientCreditStateFields,
  dueChangeCreateFields,
  paymentCreateFields,
  paymentReversalCreateFields,
} from "./finance-receivables-mapping.ts";
import {
  findApplicationRows,
  findClientCreditRows,
  findPaymentRows,
  listApplicationRowsByClient,
  listApplicationRowsForCredit,
  listApplicationRowsForInvoice,
  listClientCreditRowsByClient,
  listClientCreditRowsBySourceInvoice,
  listDueChangeRowsForInvoice,
  listPaymentRowsForInvoice,
  loadOrganisationReceivableRows,
} from "./finance-receivables-repository.ts";

export type ReceivableDeps = IssueDeps;

export type Fail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 503; code: string; error: string; fields?: Record<string, string> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: Fail["httpStatus"], code: string, error: string, fields?: Record<string, string>): Fail => ({ status: "error", httpStatus, code, error, ...(fields ? { fields } : {}) });

const now = (deps: ReceivableDeps) => (deps.clock ?? (() => new Date()))();
const hex = (deps: ReceivableDeps) => (deps.randomHex ?? (() => crypto.randomUUID()))();
const newId = (deps: ReceivableDeps, prefix: ReceivableIdPrefix) => newReceivableId(prefix, hex(deps));
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_receivables_unavailable", "Receivables could not be loaded just now - try again");
const invalidData = (e: unknown) => fail(409, "receivable_data_invalid", `Stored receivable history does not add up (${String((e as Error)?.message ?? e)}) - it must be corrected before use`);

async function guarded<T>(read: () => Promise<T>): Promise<T | Fail> {
  try {
    return await read();
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}
const isFail = (x: unknown): x is Fail => !!x && typeof x === "object" && (x as any).status === "error";

// ---------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------

type History = {
  loaded: LoadedInvoice;
  invoice: Invoice;
  payments: Payment[];
  paymentReversals: PaymentReversal[];
  applications: CreditApplication[];
  applicationReversals: ApplicationReversal[];
  /** Every client credit whose value came from this invoice (credit-note credits + overpayment credits). */
  creditsFrom: ClientCredit[];
  dueChanges: DueDateChange[];
};

/** An issued-or-awaiting invoice (F6, validated against its lines + credit notes) with all its receivable history (7 reads). */
async function loadHistory(deps: ReceivableDeps, org: OrganisationContext, invoiceId: string): Promise<History | Fail> {
  const [l, r] = await Promise.all([
    loadInvoice(deps, org, invoiceId),
    guarded(() => Promise.all([listPaymentRowsForInvoice(deps.airtable, org.recordId, invoiceId), listApplicationRowsForInvoice(deps.airtable, org.recordId, invoiceId), listClientCreditRowsBySourceInvoice(deps.airtable, org.recordId, invoiceId), listDueChangeRowsForInvoice(deps.airtable, org.recordId, invoiceId)])),
  ]);
  if (isFail(l)) return l;
  if (isFail(r)) return r;
  const p = buildPaymentEntries(r[0], org.recordId);
  if (!p.ok) return fail(409, "receivable_data_invalid", p.error);
  const a = buildApplicationEntries(r[1], org.recordId);
  if (!a.ok) return fail(409, "receivable_data_invalid", a.error);
  const c = buildClientCredits(r[2], org.recordId);
  if (!c.ok) return fail(409, "receivable_data_invalid", c.error);
  const d = buildDueChanges(r[3], org.recordId);
  if (!d.ok) return fail(409, "receivable_data_invalid", d.error);
  return { loaded: l, invoice: l.invoice.value, payments: p.payments, paymentReversals: p.reversals, applications: a.applications, applicationReversals: a.reversals, creditsFrom: c.credits.map((x) => x.value), dueChanges: d.changes };
}

function derive(h: History, asOf: string): Receivable | NotReceivable | Fail {
  try {
    return receivableOf(h.invoice, { notes: h.loaded.notes, payments: h.payments, paymentReversals: h.paymentReversals, applications: h.applications, applicationReversals: h.applicationReversals, creditsFromNotes: h.creditsFrom.filter((c) => c.source === "credit_note"), dueChanges: h.dueChanges }, asOf);
  } catch (e) {
    return invalidData(e);
  }
}

type LoadedCredit = { recordId: string; credit: ClientCredit; applications: CreditApplication[]; reversals: ApplicationReversal[]; balance: ReturnType<typeof creditBalance> };

/** A client credit with its applications (2 reads); the stored remaining value / status must equal its history. */
async function loadCredit(deps: ReceivableDeps, org: OrganisationContext, creditId: string): Promise<LoadedCredit | Fail> {
  const r = await guarded(() => Promise.all([findClientCreditRows(deps.airtable, org.recordId, creditId), listApplicationRowsForCredit(deps.airtable, org.recordId, creditId)]));
  if (isFail(r)) return r;
  const c = buildClientCredits(r[0], org.recordId);
  if (!c.ok) return fail(409, "receivable_data_invalid", c.error);
  if (c.credits.length !== 1) return c.credits.length ? fail(409, "client_credit_ambiguous", "More than one client credit has this id - the data must be corrected first") : fail(404, "client_credit_not_found", `No client credit ${creditId} in your organisation`);
  const a = buildApplicationEntries(r[1], org.recordId);
  if (!a.ok) return fail(409, "receivable_data_invalid", a.error);
  const credit = c.credits[0].value;
  try {
    const balance = creditBalance(credit, a.applications, a.reversals);
    if (balance.remainingMinor !== credit.remainingMinor || balance.status !== credit.status) return fail(409, "receivable_data_invalid", `${creditId} says ${credit.status} / ${formatMinor(credit.remainingMinor)} left but its applications say ${balance.status} / ${formatMinor(balance.remainingMinor)}`);
    return { recordId: c.credits[0].recordId, credit, applications: a.applications, reversals: a.reversals, balance };
  } catch (e) {
    return invalidData(e);
  }
}

/** The evaluation day: the organisation's today, or a later asOf (a projection; a past asOf would need historical balances, so it is refused). */
function asOfDay(deps: ReceivableDeps, org: OrganisationContext, asOf: string | null): string | Fail {
  const today = todayIn(org.timezone, now(deps));
  if (asOf === null) return today;
  if (asOf < today) return fail(400, "invalid_input", `asOf must be today (${today}) or later - it projects due / overdue forward from the payments recorded so far`, { asOf: "must be today or later" });
  return asOf;
}

function historyBody(h: History, rec: Receivable | NotReceivable) {
  const pr = new Map(h.paymentReversals.map((r) => [r.paymentId, r]));
  const ar = new Map(h.applicationReversals.map((r) => [r.applicationId, r]));
  return {
    receivable: publicReceivable(h.invoice, rec),
    payments: [...h.payments].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.paymentId.localeCompare(b.paymentId)).map((p) => publicPayment(p, pr.get(p.paymentId) ?? null)),
    creditApplications: [...h.applications].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map((a) => publicApplication(a, ar.get(a.applicationId) ?? null)),
    creditNotes: h.loaded.notes.map((n) => ({ creditNoteId: n.creditNoteId, creditDate: n.creditDate, gross: formatMinor(n.grossMinor), countsAsCashReceived: false })),
    clientCreditsFromThisInvoice: h.creditsFrom.map((c) => publicClientCredit(c)),
    dueDateHistory: (() => {
      try {
        return orderedDueChanges(h.invoice, h.dueChanges).map(publicDueChange);
      } catch {
        return h.dueChanges.map(publicDueChange);
      }
    })(),
  };
}

// ---------------------------------------------------------------------
// Reads (View)
// ---------------------------------------------------------------------

async function readAuth(deps: ReceivableDeps, caller: FinanceCaller) {
  const auth = await authorizeFinance(deps, caller, "read");
  return auth.status === "ok" ? auth : fail(auth.httpStatus, auth.code, auth.error);
}

/** GET /invoices/{id}/receivable[?asOf=] - the invoice's receivable state + its payment / credit / due-date history. */
export async function readReceivable(deps: ReceivableDeps, caller: FinanceCaller, invoiceId: string, asOf: string | null): Promise<Ok | Fail> {
  const auth = await readAuth(deps, caller);
  if (isFail(auth)) return auth;
  const org = auth.organisation;
  const day = asOfDay(deps, org, asOf);
  if (isFail(day)) return day;
  const h = await loadHistory(deps, org, invoiceId);
  if (isFail(h)) return h;
  const rec = derive(h, day);
  if (isFail(rec)) return rec;
  return { status: "ok", httpStatus: 200, body: { contract: RECEIVABLES_CONTRACT, organisation: orgBody(org), access: auth.access, ...historyBody(h, rec) } };
}

/** GET /invoices/{id}/payments - payment history (reversed payments shown, never counted as cash). */
export async function listInvoicePayments(deps: ReceivableDeps, caller: FinanceCaller, invoiceId: string): Promise<Ok | Fail> {
  const auth = await readAuth(deps, caller);
  if (isFail(auth)) return auth;
  const org = auth.organisation;
  const h = await loadHistory(deps, org, invoiceId);
  if (isFail(h)) return h;
  const rec = derive(h, todayIn(org.timezone, now(deps)));
  if (isFail(rec)) return rec;
  const b = historyBody(h, rec);
  return { status: "ok", httpStatus: 200, body: { contract: RECEIVABLES_CONTRACT, organisation: orgBody(org), access: auth.access, invoiceId, receivable: rec.receivable, cashReceived: rec.receivable ? formatMinor(rec.cashReceivedMinor) : "0.00", outstanding: rec.receivable ? formatMinor(rec.outstandingMinor) : null, payments: b.payments } };
}

/**
 * GET /receivables[?clientId=][&asOf=] - every issued (receivable) invoice
 * of the organisation with its derived state, and a summary. Invoices still
 * awaiting external issue are not receivables (only counted, never listed).
 * Aged-debt buckets are left to the reader (daysOverdue is given).
 */
export async function listReceivables(deps: ReceivableDeps, caller: FinanceCaller, clientId: string | null, asOf: string | null): Promise<Ok | Fail> {
  const auth = await readAuth(deps, caller);
  if (isFail(auth)) return auth;
  const org = auth.organisation;
  const day = asOfDay(deps, org, asOf);
  if (isFail(day)) return day;
  const r = await guarded(() => loadOrganisationReceivableRows(deps.airtable, org.recordId));
  if (isFail(r)) return r;
  const iv = buildInvoices(r.invoices, org.recordId);
  if (!iv.ok) return fail(409, "invoice_data_invalid", iv.error);
  const ns = buildCreditNotes(r.notes, org.recordId);
  if (!ns.ok) return fail(409, "invoice_data_invalid", ns.error);
  const ps = buildPaymentEntries(r.payments, org.recordId);
  if (!ps.ok) return fail(409, "receivable_data_invalid", ps.error);
  const cs = buildClientCredits(r.credits, org.recordId);
  if (!cs.ok) return fail(409, "receivable_data_invalid", cs.error);
  const as = buildApplicationEntries(r.applications, org.recordId);
  if (!as.ok) return fail(409, "receivable_data_invalid", as.error);
  const ds = buildDueChanges(r.dueChanges, org.recordId);
  if (!ds.ok) return fail(409, "receivable_data_invalid", ds.error);
  const group = <T extends { invoiceId: string }>(xs: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.invoiceId, [...(m.get(x.invoiceId) ?? []), x]);
    return (id: string) => m.get(id) ?? [];
  };
  const notes = group<CreditNote>(ns.notes.map((n) => n.value));
  const pays = group(ps.payments);
  const prevs = group(ps.reversals);
  const apps = group(as.applications);
  const arevs = group(as.reversals);
  const dues = group(ds.changes);
  const creditsFrom = group(cs.credits.map((c) => ({ ...c.value, invoiceId: c.value.sourceInvoiceId })));
  const invoices = iv.invoices.map((x) => x.value).filter((i) => clientId === null || i.clientId === clientId);
  const rows: Receivable[] = [];
  let awaiting = 0;
  const byId = new Map(invoices.map((i) => [i.invoiceId, i]));
  for (const inv of invoices) {
    if (!isIssued(inv)) {
      awaiting++;
      continue;
    }
    try {
      const rec = receivableOf(inv, { notes: notes(inv.invoiceId), payments: pays(inv.invoiceId), paymentReversals: prevs(inv.invoiceId), applications: apps(inv.invoiceId), applicationReversals: arevs(inv.invoiceId), creditsFromNotes: creditsFrom(inv.invoiceId).filter((c) => c.source === "credit_note"), dueChanges: dues(inv.invoiceId) }, day);
      if (rec.receivable) rows.push(rec);
    } catch (e) {
      return invalidData(e);
    }
  }
  rows.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.invoiceId.localeCompare(b.invoiceId));
  const total = (pick: (x: Receivable) => boolean, v: (x: Receivable) => number = (x) => x.outstandingMinor) => formatMinor(rows.filter(pick).reduce((a, x) => a + v(x), 0));
  const counts: Record<string, number> = {};
  for (const x of rows) counts[x.state] = (counts[x.state] ?? 0) + 1;
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: RECEIVABLES_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      clientId,
      asOf: day,
      summary: {
        currency: "GBP",
        invoiceCount: rows.length,
        outstanding: total(() => true),
        overdue: total((x) => x.dueState === "overdue"),
        dueToday: total((x) => x.dueState === "due_today"),
        notDue: total((x) => x.dueState === "not_due"),
        cashReceived: total(() => true, (x) => x.cashReceivedMinor),
        clientCreditApplied: total(() => true, (x) => x.creditAppliedMinor),
        creditExcess: total(() => true, (x) => x.creditExcessMinor),
        byState: counts,
        notReceivable: { awaitingExternalIssue: awaiting },
      },
      receivables: rows.map((rec) => publicReceivable(byId.get(rec.invoiceId) as Invoice, rec)),
    },
  };
}

function creditBody(l: LoadedCredit) {
  return publicClientCredit(l.credit, l.applications, l.reversals);
}

/** GET /client-credits/{id}. */
export async function readClientCredit(deps: ReceivableDeps, caller: FinanceCaller, creditId: string): Promise<Ok | Fail> {
  const auth = await readAuth(deps, caller);
  if (isFail(auth)) return auth;
  const l = await loadCredit(deps, auth.organisation, creditId);
  if (isFail(l)) return l;
  return { status: "ok", httpStatus: 200, body: { contract: RECEIVABLES_CONTRACT, organisation: orgBody(auth.organisation), access: auth.access, clientCredit: creditBody(l) } };
}

/** GET /clients/{id}/credits - the client's credits (visible on the Client; never applied automatically). */
export async function listClientCredits(deps: ReceivableDeps, caller: FinanceCaller, clientId: string): Promise<Ok | Fail> {
  const auth = await readAuth(deps, caller);
  if (isFail(auth)) return auth;
  const org = auth.organisation;
  const r = await guarded(() => Promise.all([listClientCreditRowsByClient(deps.airtable, org.recordId, clientId), listApplicationRowsByClient(deps.airtable, org.recordId, clientId)]));
  if (isFail(r)) return r;
  const cs = buildClientCredits(r[0], org.recordId);
  if (!cs.ok) return fail(409, "receivable_data_invalid", cs.error);
  const as = buildApplicationEntries(r[1], org.recordId);
  if (!as.ok) return fail(409, "receivable_data_invalid", as.error);
  const out = [];
  let available = 0;
  for (const { value: c } of cs.credits.sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt))) {
    const apps = as.applications.filter((a) => a.creditId === c.creditId);
    const revs = as.reversals.filter((x) => x.creditId === c.creditId);
    try {
      const b = creditBalance(c, apps, revs);
      if (b.remainingMinor !== c.remainingMinor || b.status !== c.status) return fail(409, "receivable_data_invalid", `${c.creditId} does not match its applications`);
    } catch (e) {
      return invalidData(e);
    }
    if (c.status === "available") available += c.remainingMinor;
    out.push(publicClientCredit(c, apps, revs));
  }
  return { status: "ok", httpStatus: 200, body: { contract: RECEIVABLES_CONTRACT, organisation: orgBody(org), access: auth.access, clientId, available: formatMinor(available), currency: "GBP", appliedAutomatically: false, credits: out } };
}

/** GET /receipts?from=&to= - trusted cash receipts (the Actual Revenue fact). No Month Report / Cash Flow maths. */
export async function listReceipts(deps: ReceivableDeps, caller: FinanceCaller, from: string, to: string): Promise<Ok | Fail> {
  const auth = await readAuth(deps, caller);
  if (isFail(auth)) return auth;
  const org = auth.organisation;
  const r = await guarded(() => loadOrganisationReceivableRows(deps.airtable, org.recordId));
  if (isFail(r)) return r;
  const ps = buildPaymentEntries(r.payments, org.recordId);
  if (!ps.ok) return fail(409, "receivable_data_invalid", ps.error);
  const cs = buildClientCredits(r.credits, org.recordId);
  if (!cs.ok) return fail(409, "receivable_data_invalid", cs.error);
  const f = receiptFacts(ps.payments, ps.reversals, cs.credits.map((c) => c.value), from, to);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: RECEIVABLES_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      period: { from, to },
      rule: "Cash actually received through a trusted receipt (a manual payment, or cash kept as client credit from an overpayment). Issued / due / overdue invoices, credit notes and client credit applied are never receipts.",
      totals: { currency: "GBP", cashReceived: formatMinor(f.receipts.reduce((a, x) => a + x.amountMinor, 0)), count: f.receipts.length },
      receipts: f.receipts.map(publicReceipt),
      reversedPayments: f.reversed.map((x) => ({ paymentId: x.paymentId, invoiceId: x.invoiceId, amount: formatMinor(x.amountMinor), receivedDate: x.receivedDate, reversedAt: x.reversedAt, reason: x.reason, countsAsCashReceived: false })),
    },
  };
}

// ---------------------------------------------------------------------
// Writes (Manage)
// ---------------------------------------------------------------------

type AuditRow = ReturnType<typeof receivableAuditEvent>;
type Ctx = {
  org: OrganisationContext;
  at: string;
  today: string;
  userId: string;
  ev: (eventType: string, entityType: string, recordId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null, context?: Record<string, unknown>) => AuditRow;
};
type Plan = { httpStatus: 200 | 201; run: (txn: DraftTxn) => Promise<{ events: AuditRow[]; body: () => Record<string, unknown> }> } | Fail;

async function underLock(deps: ReceivableDeps, caller: FinanceCaller, route: string, plan: (ctx: Ctx) => Promise<Plan>): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_receivables_unavailable", "The change could not be saved just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    const atDate = now(deps);
    const ctx: Ctx = {
      org,
      at: atDate.toISOString(),
      today: todayIn(org.timezone, atDate),
      userId: caller.userId,
      ev: (eventType, entityType, recordId, before, after, reason, context = {}) => receivableAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, entityType, recordId, before, after, reason, route, context }),
    };
    const p = await plan(ctx);
    if ("status" in p) return p;
    const txn = new DraftTxn(deps);
    let result;
    try {
      result = await p.run(txn);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_receivables_unaudited", "The change was partly saved and could not be undone - contact support before changing this again");
      return fail(503, "finance_receivables_unavailable", "The change could not be saved just now - nothing was changed");
    }
    try {
      await insertAuditEvents(deps.grants, result.events);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_receivables_unaudited", "The change was saved but could not be audited or undone - contact support before changing this again");
      return fail(503, "finance_audit_unavailable", "The change could not be saved just now (it could not be recorded) - nothing was changed");
    }
    return { status: "ok", httpStatus: p.httpStatus, body: { contract: RECEIVABLES_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, ...result.body() } };
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

const refused = (p: { httpStatus: 404 | 409; code: string; error: string }) => fail(p.httpStatus, p.code, p.error);
const T = RECEIVABLE_TABLES;
const invCtx = (i: Invoice) => ({ invoiceId: i.invoiceId, clientId: i.clientId, officialNumber: i.hubInvoiceNumber ?? i.externalInvoiceNumber });
/** The receivable after this write, derived again from the history plus the new records (what the next read will show). */
function after(h: History, add: Partial<Pick<History, "payments" | "paymentReversals" | "applications" | "applicationReversals" | "creditsFrom" | "dueChanges">>, day: string) {
  const n: History = { ...h, payments: [...h.payments, ...(add.payments ?? [])], paymentReversals: [...h.paymentReversals, ...(add.paymentReversals ?? [])], applications: [...h.applications, ...(add.applications ?? [])], applicationReversals: [...h.applicationReversals, ...(add.applicationReversals ?? [])], creditsFrom: [...h.creditsFrom, ...(add.creditsFrom ?? [])], dueChanges: [...h.dueChanges, ...(add.dueChanges ?? [])] };
  const rec = derive(n, day);
  if (isFail(rec) || !rec.receivable) throw new Error("the receivable did not re-derive after the write");
  return { h: n, rec };
}

/** POST /invoices/{id}/payments - record cash received (Mark as Received). */
export function recordPayment(deps: ReceivableDeps, caller: FinanceCaller, invoiceId: string, req: PaymentRequest): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /invoices/${invoiceId}/payments`, async (c) => {
    const h = await loadHistory(deps, c.org, invoiceId);
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const p = planPayment({ invoice: h.invoice, rec, req, paymentId: newId(deps, "FPY"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    const next = after(h, { payments: [p.payment] }, c.today);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.payments, [paymentCreateFields(p.payment, c.org.recordId)]);
        const events = [c.ev(RECEIVABLE_EVENTS.paymentRecorded, ENTITY_PAYMENT, p.payment.paymentId, { receivable: auditRec(rec as Receivable) }, { payment: auditPayment(p.payment), receivable: auditRec(next.rec) }, req.reason, { ...invCtx(h.invoice), settleRemaining: req.settleRemaining, outstandingMinorBefore: p.outstandingBefore, outstandingMinorAfter: p.outstandingAfter })];
        return { events, body: () => ({ payment: publicPayment(p.payment), ...historyBody(next.h, next.rec) }) };
      },
    };
  });
}

/** POST /payments/{id}/reverse - cancel a payment recorded in error (full amount; the record stays). */
export function reversePayment(deps: ReceivableDeps, caller: FinanceCaller, paymentId: string, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /payments/${paymentId}/reverse`, async (c) => {
    const pr = await guarded(() => findPaymentRows(deps.airtable, c.org.recordId, paymentId));
    if (isFail(pr)) return pr;
    const pe = buildPaymentEntries(pr, c.org.recordId);
    if (!pe.ok) return fail(409, "receivable_data_invalid", pe.error);
    if (pe.payments.length !== 1) return pe.payments.length ? fail(409, "payment_ambiguous", "More than one payment has this id - the data must be corrected first") : fail(404, "payment_not_found", `No payment ${paymentId} in your organisation`);
    const h = await loadHistory(deps, c.org, pe.payments[0].invoiceId);
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const p = planPaymentReversal({ invoice: h.invoice, rec, paymentId, payments: h.payments, overpaymentCredits: h.creditsFrom.filter((x) => x.source === "overpayment"), reason, reversalId: newId(deps, "FPR"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    const next = after(h, { paymentReversals: [p.reversal] }, c.today);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.payments, [paymentReversalCreateFields(p.reversal, c.org.recordId)]);
        const events = [c.ev(RECEIVABLE_EVENTS.paymentReversed, ENTITY_PAYMENT, paymentId, { payment: auditPayment(p.payment), status: "active", receivable: auditRec(rec as Receivable) }, { reversalId: p.reversal.reversalId, status: "reversed", receivable: auditRec(next.rec) }, reason, { ...invCtx(h.invoice), outstandingMinorBefore: p.outstandingBefore, outstandingMinorAfter: p.outstandingAfter })];
        return { events, body: () => ({ reversal: { reversalId: p.reversal.reversalId, paymentId, amount: formatMinor(p.reversal.amountMinor) }, ...historyBody(next.h, next.rec) }) };
      },
    };
  });
}

/** POST /invoices/{id}/due-date - move the due date deliberately (reason required; the original stays on the invoice). */
export function changeDueDate(deps: ReceivableDeps, caller: FinanceCaller, invoiceId: string, dueDate: string, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /invoices/${invoiceId}/due-date`, async (c) => {
    const h = await loadHistory(deps, c.org, invoiceId);
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const p = planDueDateChange({ invoice: h.invoice, rec, newDueDate: dueDate, reason, changeId: newId(deps, "FDD"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    const next = after(h, { dueChanges: [p.change] }, c.today);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.dueChanges, [dueChangeCreateFields(p.change, c.org.recordId)]);
        const events = [c.ev(RECEIVABLE_EVENTS.dueDateChanged, ENTITY_INVOICE, invoiceId, { dueDate: p.change.previousDueDate, dueState: (rec as Receivable).dueState }, { dueDate: p.change.newDueDate, dueState: next.rec.dueState, changeId: p.change.changeId }, reason, { ...invCtx(h.invoice), originalDueDate: h.invoice.dueDate, invoiceDate: h.invoice.invoiceDate, paymentTermsDays: h.invoice.paymentTermsDays })];
        return { events, body: () => ({ dueDateChange: publicDueChange(p.change), ...historyBody(next.h, next.rec) }) };
      },
    };
  });
}

/** POST /credit-notes/{id}/client-credit - keep value from a correction the client had already paid, for future use. */
export function creditFromCreditNote(deps: ReceivableDeps, caller: FinanceCaller, creditNoteId: string, amountMinor: number, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /credit-notes/${creditNoteId}/client-credit`, async (c) => {
    const nr = await guarded(() => findCreditNoteRows(deps.airtable, c.org.recordId, creditNoteId));
    if (isFail(nr)) return nr;
    const n = buildCreditNotes(nr, c.org.recordId);
    if (!n.ok) return fail(409, "invoice_data_invalid", n.error);
    if (n.notes.length !== 1) return n.notes.length ? fail(409, "credit_note_ambiguous", "More than one credit note has this id") : fail(404, "credit_note_not_found", `No credit note ${creditNoteId} in your organisation`);
    const note = n.notes[0].value;
    const h = await loadHistory(deps, c.org, note.invoiceId);
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const p = planCreditFromNote({ invoice: h.invoice, rec, note, creditsFromNote: h.creditsFrom.filter((x) => x.sourceCreditNoteId === creditNoteId), amountMinor, reason, creditId: newId(deps, "FCC"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    const next = after(h, { creditsFrom: [p.credit] }, c.today);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.credits, [clientCreditCreateFields(p.credit, c.org.recordId)]);
        const events = [c.ev(RECEIVABLE_EVENTS.creditCreated, ENTITY_CLIENT_CREDIT, p.credit.creditId, null, { credit: auditCredit(p.credit), sourceInvoiceReceivable: auditRec(next.rec) }, reason, { ...invCtx(h.invoice), creditNoteId, sourceInvoiceReceivableBefore: auditRec(rec as Receivable), availableMinorBefore: p.availableBefore, cashMoved: false })];
        return { events, body: () => ({ clientCredit: publicClientCredit(p.credit), sourceInvoice: publicReceivable(h.invoice, next.rec) }) };
      },
    };
  });
}

/** POST /payments/{id}/overpayment-credit - keep cash the client paid beyond the invoice as client credit. */
export function creditFromOverpayment(deps: ReceivableDeps, caller: FinanceCaller, paymentId: string, amountMinor: number, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /payments/${paymentId}/overpayment-credit`, async (c) => {
    const pr = await guarded(() => findPaymentRows(deps.airtable, c.org.recordId, paymentId));
    if (isFail(pr)) return pr;
    const pe = buildPaymentEntries(pr, c.org.recordId);
    if (!pe.ok) return fail(409, "receivable_data_invalid", pe.error);
    if (pe.payments.length !== 1) return pe.payments.length ? fail(409, "payment_ambiguous", "More than one payment has this id - the data must be corrected first") : fail(404, "payment_not_found", `No payment ${paymentId} in your organisation`);
    const h = await loadHistory(deps, c.org, pe.payments[0].invoiceId);
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const payment = h.payments.find((x) => x.paymentId === paymentId) as Payment;
    const p = planCreditFromOverpayment({ invoice: h.invoice, rec, payment, amountMinor, reason, creditId: newId(deps, "FCC"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.credits, [clientCreditCreateFields(p.credit, c.org.recordId)]);
        const events = [c.ev(RECEIVABLE_EVENTS.creditCreated, ENTITY_CLIENT_CREDIT, p.credit.creditId, null, { credit: auditCredit(p.credit) }, reason, { ...invCtx(h.invoice), paymentId, cashReceivedMinor: p.credit.originalMinor, receivedDate: p.credit.receivedDate })];
        return { events, body: () => ({ clientCredit: publicClientCredit(p.credit), sourceInvoice: publicReceivable(h.invoice, rec) }) };
      },
    };
  });
}

/** POST /client-credits/{id}/applications - apply client credit to one of the same client's issued invoices. Not cash. */
export function applyClientCredit(deps: ReceivableDeps, caller: FinanceCaller, creditId: string, invoiceId: string, amountMinor: number, reason: string | null): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /client-credits/${creditId}/applications`, async (c) => {
    const [l, h] = await Promise.all([loadCredit(deps, c.org, creditId), loadHistory(deps, c.org, invoiceId)]);
    if (isFail(l)) return l;
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const p = planApplication({ credit: l.credit, balance: l.balance, invoice: h.invoice, rec, amountMinor, reason, applicationId: newId(deps, "FCA"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    const next = after(h, { applications: [p.application] }, c.today);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.applications, [applicationCreateFields(p.application, c.org.recordId)]);
        await txn.patch(T.credits, [{ id: l.recordId, fields: clientCreditStateFields(p.creditAfter), restore: clientCreditStateFields(l.credit) }]);
        const events = [c.ev(RECEIVABLE_EVENTS.creditApplied, ENTITY_CLIENT_CREDIT, creditId, { credit: auditCredit(l.credit), invoiceReceivable: auditRec(rec as Receivable) }, { credit: auditCredit(p.creditAfter), applicationId: p.application.applicationId, amountMinor, invoiceReceivable: auditRec(next.rec) }, reason, { ...invCtx(h.invoice), outstandingMinorBefore: p.outstandingBefore, outstandingMinorAfter: p.outstandingAfter, cashReceived: false })];
        return { events, body: () => ({ application: publicApplication(p.application), clientCredit: publicClientCredit(p.creditAfter, [...l.applications, p.application], l.reversals), invoice: publicReceivable(h.invoice, next.rec) }) };
      },
    };
  });
}

/** POST /client-credit-applications/{id}/reverse - unapply (reason required; the application record stays). */
export function reverseApplication(deps: ReceivableDeps, caller: FinanceCaller, applicationId: string, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /client-credit-applications/${applicationId}/reverse`, async (c) => {
    const ar = await guarded(() => findApplicationRows(deps.airtable, c.org.recordId, applicationId));
    if (isFail(ar)) return ar;
    const ae = buildApplicationEntries(ar, c.org.recordId);
    if (!ae.ok) return fail(409, "receivable_data_invalid", ae.error);
    if (ae.applications.length !== 1) return ae.applications.length ? fail(409, "application_ambiguous", "More than one credit application has this id") : fail(404, "application_not_found", `No client credit application ${applicationId} in your organisation`);
    const app = ae.applications[0];
    const [l, h] = await Promise.all([loadCredit(deps, c.org, app.creditId), loadHistory(deps, c.org, app.invoiceId)]);
    if (isFail(l)) return l;
    if (isFail(h)) return h;
    const rec = derive(h, c.today);
    if (isFail(rec)) return rec;
    const p = planApplicationReversal({ credit: l.credit, balance: l.balance, application: app, invoice: h.invoice, rec, reason, reversalId: newId(deps, "FAR"), meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    const next = after(h, { applicationReversals: [p.reversal] }, c.today);
    return {
      httpStatus: 201,
      run: async (txn) => {
        await txn.create(T.applications, [applicationReversalCreateFields(p.reversal, c.org.recordId)]);
        await txn.patch(T.credits, [{ id: l.recordId, fields: clientCreditStateFields(p.creditAfter), restore: clientCreditStateFields(l.credit) }]);
        const events = [c.ev(RECEIVABLE_EVENTS.applicationReversed, ENTITY_CLIENT_CREDIT, l.credit.creditId, { credit: auditCredit(l.credit), applicationId, invoiceReceivable: auditRec(rec as Receivable) }, { credit: auditCredit(p.creditAfter), reversalId: p.reversal.reversalId, invoiceReceivable: auditRec(next.rec) }, reason, { ...invCtx(h.invoice), outstandingMinorBefore: p.outstandingBefore, outstandingMinorAfter: p.outstandingAfter })];
        return { events, body: () => ({ reversal: { reversalId: p.reversal.reversalId, applicationId, amount: formatMinor(p.reversal.amountMinor) }, clientCredit: publicClientCredit(p.creditAfter, l.applications, [...l.reversals, p.reversal]), invoice: publicReceivable(h.invoice, next.rec) }) };
      },
    };
  });
}

/** POST /client-credits/{id}/void - void a client credit created in error (only while none of it is applied). */
export function voidClientCredit(deps: ReceivableDeps, caller: FinanceCaller, creditId: string, reason: string): Promise<Ok | Fail> {
  return underLock(deps, caller, `POST /client-credits/${creditId}/void`, async (c) => {
    const l = await loadCredit(deps, c.org, creditId);
    if (isFail(l)) return l;
    const p = planVoid({ credit: l.credit, balance: l.balance, reason, meta: { userId: c.userId, at: c.at, today: c.today } });
    if (!p.ok) return refused(p);
    return {
      httpStatus: 200,
      run: async (txn) => {
        await txn.patch(T.credits, [{ id: l.recordId, fields: clientCreditStateFields(p.creditAfter), restore: clientCreditStateFields(l.credit) }]);
        const events = [c.ev(RECEIVABLE_EVENTS.creditVoided, ENTITY_CLIENT_CREDIT, creditId, { credit: auditCredit(l.credit) }, { credit: auditCredit(p.creditAfter) }, reason, { clientId: l.credit.clientId, sourceInvoiceId: l.credit.sourceInvoiceId, source: l.credit.source })];
        return { events, body: () => ({ clientCredit: publicClientCredit(p.creditAfter, l.applications, l.reversals) }) };
      },
    };
  });
}
