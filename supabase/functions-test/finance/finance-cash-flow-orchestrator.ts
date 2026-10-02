/**
 * Cash Position / Cash Flow forecast - orchestration (Finance Foundation F17;
 * see TEST-ENV.md "Finance Foundation - F17"). Every route authorises through
 * F1's authorizeFinance() first: View reads, Manage writes.
 *
 * Reads (View, never audited):
 *   GET /cash-flow[?range=30d|3m&view=position|money-in|money-out]
 *       ONE timeline built from F7 / F12 / F13 / F14 / F15 truth, filtered by view
 *   GET /cash-flow/balance-history
 *       the append-only Management-entered bank balances
 * Write (Manage, under the shared Finance write lock, ONE atomic database call
 * that also writes its audit row):
 *   POST /cash-flow/balance   { amount, asAtDate, note? }
 *
 * The cash safety threshold is an F2 Finance Setting (POST /settings,
 * cashSafetyThresholdMinor) - audited there. Each source is loaded once per
 * request through its owning slice's repository; nothing here writes a
 * source, creates a stored forecast event, reconciles a bank or calls Stripe.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { type CommercialDeps } from "./finance-commercial-orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import { fromStoredRow } from "./finance-settings.ts";
import { loadSettingsRows } from "./finance-settings-repository.ts";
import { buildCreditNotes, buildInvoices } from "./finance-issue-mapping.ts";
import { type CreditNote, isIssued, publicNumbering } from "./finance-issue.ts";
import { buildApplicationEntries, buildClientCredits, buildDueChanges, buildPaymentEntries } from "./finance-receivables-mapping.ts";
import { receivableOf } from "./finance-receivables.ts";
import { loadOrganisationReceivableRows } from "./finance-receivables-repository.ts";
import { loadSupplierLedger } from "./finance-suppliers-repository.ts";
import { loadOverheadLedger } from "./finance-overheads-repository.ts";
import { monthBounds } from "./finance-coach-costs.ts";
import { loadCostWorld, loadMonthLedger } from "./finance-coach-costs-repository.ts";
import {
  type BalanceRequest,
  type CashRange,
  type CashView,
  type ReceivableInput,
  CASH_FLOW_CONTRACT,
  CashFlowDataError,
  balanceAuditEvent,
  balanceView,
  buildCashFlow,
  cashFlowView,
  cashReceipts,
  coachMonthInputs,
  coachWorkMonths,
  latestBalance,
  newBalanceId,
  planBalance,
  rangeEnd,
} from "./finance-cash-flow.ts";
import { BalanceRefusal, loadBalances, recordBalance } from "./finance-cash-flow-repository.ts";

export interface CashFlowDeps extends CommercialDeps {
  cashFlow?: { random?: () => string };
}
export type CFFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: CFFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): CFFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is CFFail => !!x && typeof x === "object" && (x as any).status === "error";
const now = (deps: CashFlowDeps) => (deps.clock ?? (() => new Date()))();
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "cash_flow_unavailable", "Cash Flow could not be loaded just now - try again");
const head = (org: OrganisationContext, access: string) => ({ contract: CASH_FLOW_CONTRACT, organisation: { organisationId: org.organisationId, name: org.name }, access, currency: "GBP" });

export const BALANCE_REFUSALS: Record<string, string> = {
  balance_changed: "Someone else recorded a bank balance just now - reload and try again",
  audit_missing: "The change could not be audited - nothing was saved",
  history_is_append_only: "Balance history is never rewritten - nothing was changed",
};

/** F2 Finance Settings: none = no threshold / no payment day; more than one or unreadable = refused (never a guess). */
async function settingsOf(deps: CashFlowDeps, org: OrganisationContext): Promise<{ thresholdMinor: number | null; paymentDay: number | null } | CFFail> {
  const rows = await loadSettingsRows(deps.airtable, org.recordId);
  if (rows.length > 1) return fail(409, "finance_settings_invalid", "More than one Finance Settings record exists for the organisation - fix that first");
  if (rows.length === 0) return { thresholdMinor: null, paymentDay: null };
  const p = fromStoredRow(rows[0]);
  if (!p.ok) return fail(409, "finance_settings_invalid", `Stored Finance Settings are not valid (${p.problems.join(", ")})`);
  return { thresholdMinor: p.state.settings.cashSafetyThresholdMinor, paymentDay: p.state.settings.coachPaymentDayOfFollowingMonth };
}

/** F7 receivables (receivableOf per issued invoice) + trusted receipts, from the organisation's rows (exported for the Needs Attention parity tests). */
export function receivablesOf(r: Awaited<ReturnType<typeof loadOrganisationReceivableRows>>, orgRec: string, today: string) {
  const iv = buildInvoices(r.invoices, orgRec);
  if (!iv.ok) throw new CashFlowDataError(iv.error);
  const ns = buildCreditNotes(r.notes, orgRec);
  if (!ns.ok) throw new CashFlowDataError(ns.error);
  const ps = buildPaymentEntries(r.payments, orgRec);
  if (!ps.ok) throw new CashFlowDataError(ps.error);
  const cs = buildClientCredits(r.credits, orgRec);
  if (!cs.ok) throw new CashFlowDataError(cs.error);
  const as = buildApplicationEntries(r.applications, orgRec);
  if (!as.ok) throw new CashFlowDataError(as.error);
  const ds = buildDueChanges(r.dueChanges, orgRec);
  if (!ds.ok) throw new CashFlowDataError(ds.error);
  const group = <T,>(xs: readonly T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return (id: string) => m.get(id) ?? [];
  };
  const credits = cs.credits.map((c) => c.value);
  const notes = group<CreditNote>(ns.notes.map((n) => n.value), (n) => n.invoiceId);
  const pays = group(ps.payments, (p) => p.invoiceId);
  const prevs = group(ps.reversals, (p) => p.invoiceId);
  const apps = group(as.applications, (a) => a.invoiceId);
  const arevs = group(as.reversals, (a) => a.invoiceId);
  const dues = group(ds.changes, (d) => d.invoiceId);
  const fromNotes = group(credits.filter((c) => c.source === "credit_note"), (c) => c.sourceInvoiceId);
  const receivables: ReceivableInput[] = [];
  let awaitingCount = 0;
  let awaitingGross = 0;
  for (const s of iv.invoices) {
    const inv = s.value;
    if (!isIssued(inv)) {
      awaitingCount++;
      awaitingGross += inv.grossMinor;
      continue;
    }
    let rec;
    try {
      rec = receivableOf(inv, { notes: notes(inv.invoiceId), payments: pays(inv.invoiceId), paymentReversals: prevs(inv.invoiceId), applications: apps(inv.invoiceId), applicationReversals: arevs(inv.invoiceId), creditsFromNotes: fromNotes(inv.invoiceId), dueChanges: dues(inv.invoiceId) }, today);
    } catch (e) {
      throw new CashFlowDataError(`Stored receivable history does not add up (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!rec.receivable) continue;
    receivables.push({
      invoiceId: inv.invoiceId,
      clientId: inv.clientId,
      clientName: inv.clientName,
      officialNumber: publicNumbering(inv).officialNumber,
      grossMinor: rec.grossMinor,
      outstandingMinor: rec.outstandingMinor,
      cashReceivedMinor: rec.cashReceivedMinor,
      creditAppliedMinor: rec.creditAppliedMinor,
      creditNotesMinor: rec.creditNotesMinor,
      dueDate: rec.dueDate,
      originalDueDate: rec.originalDueDate,
    });
  }
  return { receivables, receipts: cashReceipts(ps.payments, ps.reversals, credits), awaitingIssue: { count: awaitingCount, grossMinor: awaitingGross } };
}

// ---------------------------------------------------------------------
// Reads (View)
// ---------------------------------------------------------------------
export async function readCashFlow(deps: CashFlowDeps, caller: FinanceCaller, q: { range: CashRange; view: CashView }): Promise<Ok | CFFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const today = todayIn(org.timezone, now(deps));
  const end = rangeEnd(today, q.range);
  const workMonths = coachWorkMonths(today, end);
  let loaded;
  try {
    const [settings, rec, suppliers, overheads, months, world, balances] = await Promise.all([
      settingsOf(deps, org),
      loadOrganisationReceivableRows(deps.airtable, org.recordId),
      loadSupplierLedger(deps.grants, org.organisationId),
      loadOverheadLedger(deps.grants, org.organisationId),
      loadMonthLedger(deps.grants, org.organisationId),
      loadCostWorld(deps.airtable, monthBounds(workMonths[0]).from, monthBounds(workMonths[workMonths.length - 1]).to),
      loadBalances(deps.grants, org.organisationId),
    ]);
    loaded = { settings, rec, suppliers, overheads, months, world, balances };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (isFail(loaded.settings)) return loaded.settings;
  try {
    const r = receivablesOf(loaded.rec, org.recordId, today);
    const cf = buildCashFlow({
      organisationId: org.organisationId,
      today,
      range: q.range,
      balance: latestBalance(loaded.balances),
      thresholdMinor: loaded.settings.thresholdMinor,
      receivables: r.receivables,
      receipts: r.receipts,
      awaitingIssue: r.awaitingIssue,
      suppliers: loaded.suppliers.suppliers,
      instalments: loaded.suppliers.instalments,
      supplierPayments: loaded.suppliers.payments,
      employmentVersions: loaded.overheads.versions,
      employmentItems: loaded.overheads.items,
      coachMonths: coachMonthInputs(loaded.world, loaded.months, workMonths, today, loaded.settings.paymentDay),
      coachPaymentDayConfigured: loaded.settings.paymentDay !== null,
    });
    return { status: "ok", httpStatus: 200, body: { ...head(org, auth.access), ...cashFlowView(cf, q.view) } };
  } catch (e) {
    if (e instanceof CashFlowDataError) return fail(409, "cash_flow_data_invalid", `Cash Flow cannot be built from the stored Finance data: ${e.message}`);
    throw e;
  }
}

export async function readBalanceHistory(deps: CashFlowDeps, caller: FinanceCaller): Promise<Ok | CFFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  let history;
  try {
    history = await loadBalances(deps.grants, auth.organisation.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const latest = latestBalance(history);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(auth.organisation, auth.access),
      current: latest ? balanceView(latest, latest) : null,
      history: history.map((b) => balanceView(b, latest)),
      rule: "Append-only: a new balance never overwrites an earlier one. The projection starts from the latest as-at date (then the latest entry). Management-entered - not bank verified, not reconciled.",
    },
  };
}

// ---------------------------------------------------------------------
// Write (Manage)
// ---------------------------------------------------------------------
export async function recordBankBalance(deps: CashFlowDeps, caller: FinanceCaller, req: BalanceRequest): Promise<Ok | CFFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "cash_flow_unavailable", "The balance could not be recorded just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    const history = await loadBalances(deps.grants, org.organisationId);
    const at = now(deps);
    const plan = planBalance({ req, history, today: todayIn(org.timezone, at), organisationId: org.organisationId, balanceId: newBalanceId(deps.cashFlow?.random), actorUserId: caller.userId, at: at.toISOString() });
    if (!plan.ok) return fail(plan.httpStatus as 409, plan.code, plan.error);
    const expected = history.reduce((a, b) => Math.max(a, b.sequence), 0);
    await recordBalance(deps.grants, plan.balance, expected, [balanceAuditEvent(plan.balance, plan.previous)]);
    const all = [...history, plan.balance];
    const latest = latestBalance(all);
    return {
      status: "ok",
      httpStatus: 201,
      body: {
        ...head(org, auth.access),
        balance: balanceView(plan.balance, latest),
        current: latest ? balanceView(latest, latest) : null,
        historyCount: all.length,
        note: latest?.balanceId === plan.balance.balanceId ? "This balance is now the Cash Flow starting point" : "Recorded in the history; an entry with a later as-at date remains the Cash Flow starting point",
      },
    };
  } catch (e) {
    if (e instanceof BalanceRefusal) return fail(409, e.code, BALANCE_REFUSALS[e.code] ?? "The balance was refused by the ledger's rules - nothing was saved");
    console.error(e);
    return fail(503, "cash_flow_unavailable", "The balance could not be recorded just now - nothing was saved; try again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}
