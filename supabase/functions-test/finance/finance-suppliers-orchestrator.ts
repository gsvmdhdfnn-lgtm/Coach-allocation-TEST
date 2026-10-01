/**
 * Suppliers / agreements / instalments - orchestration (Finance Foundation
 * F13; see TEST-ENV.md "Finance Foundation - F13"). Every route authorises
 * through F1's authorizeFinance() first: View reads, Manage writes.
 *
 * Reads (View, never audited):
 *   GET /suppliers[?type&active]                 suppliers + what / how much / when summary
 *   GET /suppliers/{FSU}                         agreement -> schedule -> contact -> payment history
 *   GET /supplier-agreements[?supplierId]        agreements (all versions)
 *   GET /supplier-agreements/{FSA}               one agreement: schedule, versions, direct-cost allocation
 *   GET /supplier-instalments[?supplierId&state&from&to]
 *   GET /supplier-instalments/{FSI}              one instalment + payments + its audit history
 *   GET /supplier-cost-facts[?from&to]           profitability facts and cash-timing facts, kept separate
 *
 * Writes (Manage, under the shared Finance write lock, each ONE atomic
 * database call that also writes its audit rows):
 *   POST /suppliers, POST /suppliers/{FSU}
 *   POST /supplier-agreements, POST /supplier-agreements/{FSA}/version
 *   POST /supplier-instalments/{FSI}/confirm-estimate | move | split | payment | cancel
 *
 * Airtable is read only. Nothing here pays a supplier, talks to a bank,
 * creates an overhead or a Cash Flow event. Supplier credits (F14) are created
 * and applied only by finance-supplier-credits-orchestrator.ts; the reads here
 * show them beside - never inside - the F13 figures (gross + adjustment = net).
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { type CommercialDeps } from "./finance-commercial-orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import {
  type ActionInput,
  type Agreement,
  type AgreementSpec,
  type Allocation,
  type Instalment,
  type InstalmentAction,
  type InstalmentState,
  type Supplier,
  type SupplierPatch,
  type SupplierType,
  ENTITY,
  EVENTS,
  MAX_ALLOCATED_OCCURRENCES,
  SUPPLIER_CONTRACT,
  agreementStatus,
  agreementView,
  allocateDirectCost,
  allocationSuperseded,
  applySupplierPatch,
  auditInstalment,
  byFinanceService,
  factMonths,
  generateSchedule,
  instalmentView,
  isOverdue,
  m,
  newId,
  paymentView,
  planChange,
  profitabilityView,
  remainingOf,
  stateOf,
  supplierAudit,
  supplierView,
  type SupplierQuery,
} from "./finance-suppliers.ts";
import {
  type SupplierLedger,
  SupplierRefusal,
  changeInstalment,
  loadHistory,
  loadLinkedWork,
  loadOccurrenceStatuses,
  loadSupplierLedger,
  recordAgreement,
  venueExists,
  writeSupplier,
} from "./finance-suppliers-repository.ts";
import { adjustmentRows, applicationView, costFigures, creditRemainingOf, creditView, netByFinanceService } from "./finance-supplier-credits.ts";

export interface SupplierDeps extends CommercialDeps {
  suppliers?: { random?: () => string };
}
export type SFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
export const fail = (httpStatus: SFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): SFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
export const isFail = (x: unknown): x is SFail => !!x && typeof x === "object" && (x as any).status === "error";

export const now = (deps: SupplierDeps) => (deps.clock ?? (() => new Date()))();
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
export const unavailable = () => fail(503, "suppliers_unavailable", "Suppliers could not be loaded just now - try again");

export const REFUSALS: Record<string, string> = {
  supplier_changed: "This supplier was changed by someone else just now - reload and try again",
  agreement_changed: "This agreement's schedule changed just now - reload and try again",
  agreement_already_versioned: "This agreement already has a newer version - change the latest version instead",
  version_must_start_later: "A new version must start after the version it replaces",
  profitability_history_conflict: "The version it replaces already attributes sessions that have taken place on or after this start date - that profitability history is never rewritten (start the new version after them)",
  paid_instalment_after_change: "Money has already been paid against an instalment due on or after the new version's start - that history is never rewritten",
  credited_instalment_after_change: "A supplier credit is applied to an instalment due on or after the new version's start - unapply it first (credit history is never rewritten)",
  instalment_has_credit: "A supplier credit is applied to this instalment - unapply it first",
  instalment_changed: "This instalment was changed by someone else just now - reload and try again",
  instalment_cancelled: "This instalment was cancelled - it can no longer change",
  instalment_paid: "This instalment is settled - paid history is never rewritten",
  already_confirmed: "This amount is already confirmed",
  amount_still_estimated: "Confirm the amount first - an estimate is never paid as-is",
  overpayment: "That payment is more than the remaining balance",
  instalment_partially_paid: "Money has already been paid against this instalment - it cannot be cancelled",
  split_mismatch: "The parts must add up exactly to the remaining balance",
  snapshot_mismatch: "The change did not add up - nothing was saved",
  credit_changed: "This credit was changed by someone else just now - reload and try again",
  credit_voided: "This credit was voided - it cannot be applied",
  credit_has_applications: "This credit has been applied - it can never simply be voided once used",
  already_voided: "This credit is already voided",
  already_unapplied: "That application was already unapplied",
  application_not_found: "No such application on this credit",
  wrong_supplier: "A credit can only be applied to an instalment of the same supplier",
  instalment_estimated: "Confirm the instalment amount first - a credit is only applied to a confirmed amount",
  instalment_settled: "That instalment is settled - applied credit there is frozen history",
  over_credit: "That is more than this credit has remaining",
  over_instalment: "That is more than remains on the instalment",
  already_applied_to_instalment: "This credit is already applied to that instalment - unapply it first to change the amount",
  duplicate_credit: "A credit with this source and reference is already recorded for this supplier",
  credit_not_found: "No such supplier credit",
  agreement_not_for_supplier: "That agreement belongs to a different supplier",
  agreement_has_no_sessions: "That agreement has no agreed sessions to attribute a credit to",
  session_not_in_agreement: "Some sessions are not among the agreement's agreed sessions",
  credit_date_in_future: "creditDate cannot be in the future",
};
export function refusalFail(e: unknown): SFail | null {
  if (e instanceof SupplierRefusal) return fail(409, e.code, REFUSALS[e.code] ?? "The change was refused by the ledger's rules - nothing was changed");
  return null;
}

export type Ctx = { org: OrganisationContext; access: string; today: string; ledger: SupplierLedger };
async function load(deps: SupplierDeps, org: OrganisationContext, access: string): Promise<Ctx | SFail> {
  try {
    return { org, access, today: todayIn(org.timezone, now(deps)), ledger: await loadSupplierLedger(deps.grants, org.organisationId) };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}
export async function readCtx(deps: SupplierDeps, caller: FinanceCaller): Promise<Ctx | SFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  return load(deps, auth.organisation, auth.access);
}
export async function withLock(deps: SupplierDeps, caller: FinanceCaller, run: (ctx: Ctx) => Promise<Ok | SFail>): Promise<Ok | SFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "suppliers_unavailable", "The change could not be made just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    const ctx = await load(deps, org, auth.access);
    if (isFail(ctx)) return ctx;
    return await run(ctx);
  } catch (e) {
    const rf = refusalFail(e);
    if (rf) return rf;
    console.error(e);
    return fail(503, "suppliers_unavailable", "The change could not be completed just now - nothing was changed; try again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}
export const head = (ctx: Ctx) => ({ contract: SUPPLIER_CONTRACT, organisation: { organisationId: ctx.org.organisationId, name: ctx.org.name }, access: ctx.access, currency: "GBP" });
const successorOf = (ctx: Ctx, a: Agreement) => ctx.ledger.agreements.find((x) => x.supersedesAgreementId === a.agreementId) ?? null;
const paymentsOf = (ctx: Ctx, i: Instalment) => ctx.ledger.payments.filter((p) => p.instalmentId === i.instalmentId);
const sumMinor = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function money(ctx: Ctx, instalments: Instalment[], supplierId: string) {
  const open = instalments.filter((i) => remainingOf(i) > 0);
  const next = open.find((i) => i.dueDate >= ctx.today) ?? null;
  const credits = ctx.ledger.credits.filter((c) => c.supplierId === supplierId);
  return {
    outstandingConfirmed: m(sumMinor(open.filter((i) => i.amountState === "confirmed").map(remainingOf))),
    outstandingEstimated: m(sumMinor(open.filter((i) => i.amountState === "estimated").map(remainingOf))),
    /** Cash actually paid - credit applied is never counted as cash. */
    paidToDate: m(sumMinor(instalments.map((i) => i.paidMinor))),
    creditApplied: m(sumMinor(instalments.map((i) => i.creditedMinor))),
    /** Supplier credit recorded but not yet applied (applied only when Management chooses). */
    availableCredit: m(sumMinor(credits.map((c) => creditRemainingOf(c, ctx.ledger.applications)))),
    overdue: { count: open.filter((i) => isOverdue(i, ctx.today)).length, amount: m(sumMinor(open.filter((i) => isOverdue(i, ctx.today)).map(remainingOf))) },
    nextDue: next ? { instalmentId: next.instalmentId, dueDate: next.dueDate, amount: m(remainingOf(next)), estimated: next.amountState === "estimated" } : null,
  };
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
export async function listSuppliers(deps: SupplierDeps, caller: FinanceCaller, q: { type?: SupplierType; active?: boolean }): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const rows = ctx.ledger.suppliers
    .filter((s) => (q.type ? s.supplierType === q.type : true) && (q.active === undefined ? true : s.active === q.active))
    .map((s) => {
      const agreements = ctx.ledger.agreements.filter((a) => a.supplierId === s.supplierId);
      const current = agreements.filter((a) => ["active", "upcoming"].includes(agreementStatus(a, successorOf(ctx, a), ctx.today)));
      return { ...supplierView(s), whatWeGet: current.map((a) => a.name), agreements: { current: current.length, total: agreements.length }, money: money(ctx, ctx.ledger.instalments.filter((i) => i.supplierId === s.supplierId), s.supplierId) };
    });
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), suppliers: rows } };
}

export async function readSupplier(deps: SupplierDeps, caller: FinanceCaller, supplierId: string): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const s = ctx.ledger.suppliers.find((x) => x.supplierId === supplierId);
  if (!s) return fail(404, "supplier_not_found", `No supplier ${supplierId}`);
  const agreements = ctx.ledger.agreements.filter((a) => a.supplierId === supplierId);
  const instalments = ctx.ledger.instalments.filter((i) => i.supplierId === supplierId);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      supplier: supplierView(s),
      /** The four plain questions, in order. */
      whatWeAreGetting: agreements.map((a) => agreementView(a, successorOf(ctx, a), ctx.today)),
      whatWeArePaying: money(ctx, instalments, supplierId),
      whenWeArePaying: instalments.filter((i) => remainingOf(i) > 0).map((i) => instalmentView(i, ctx.today)),
      whoWeAreDealingWith: supplierView(s).contact,
      paymentHistory: ctx.ledger.payments.filter((p) => p.supplierId === supplierId).map(paymentView),
      schedule: instalments.map((i) => instalmentView(i, ctx.today)),
      credits: ctx.ledger.credits.filter((c) => c.supplierId === supplierId).map((c) => creditView(c, ctx.ledger.applications, ctx.ledger.creditSessions)),
      cost: costFigures(instalments, ctx.ledger.credits.filter((c) => c.supplierId === supplierId)),
    },
  };
}

export async function listAgreements(deps: SupplierDeps, caller: FinanceCaller, q: { supplierId?: string }): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const rows = ctx.ledger.agreements.filter((a) => (q.supplierId ? a.supplierId === q.supplierId : true)).map((a) => agreementView(a, successorOf(ctx, a), ctx.today));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), agreements: rows } };
}

export async function readAgreement(deps: SupplierDeps, caller: FinanceCaller, agreementId: string): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const a = ctx.ledger.agreements.find((x) => x.agreementId === agreementId);
  if (!a) return fail(404, "agreement_not_found", `No agreement ${agreementId}`);
  const successor = successorOf(ctx, a);
  const allocations = ctx.ledger.allocations.filter((x) => x.agreementId === agreementId);
  let statuses = new Map<string, string | null>();
  try {
    statuses = await loadOccurrenceStatuses(deps.airtable, allocations.map((x) => x.occurrenceRecordId));
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const chain: string[] = [];
  for (let x: Agreement | undefined = a; x; x = x.supersedesAgreementId ? ctx.ledger.agreements.find((y) => y.agreementId === x!.supersedesAgreementId) : undefined) chain.unshift(x.agreementId);
  for (let x = successor; x; x = successorOf(ctx, x)) chain.push(x.agreementId);
  const supplier = ctx.ledger.suppliers.find((s) => s.supplierId === a.supplierId);
  const profitability = profitabilityView(a, allocations, successor, statuses);
  const credits = ctx.ledger.credits.filter((c) => c.agreementId === agreementId);
  const grossMinor = sumMinor(allocations.filter((x) => !allocationSuperseded(x, successor)).map((x) => x.allocatedMinor));
  const adjustmentMinor = sumMinor(credits.filter((c) => !c.voidedAt).map((c) => c.amountMinor));
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      agreement: agreementView(a, successor, ctx.today),
      supplier: supplier ? { supplierId: supplier.supplierId, name: supplier.name, type: supplier.supplierType } : null,
      versionChain: chain,
      schedule: ctx.ledger.instalments.filter((i) => i.agreementId === agreementId).map((i) => instalmentView(i, ctx.today, paymentsOf(ctx, i))),
      profitability,
      /** F14: supplier credits attributed to this agreement - beside the frozen shares above, never inside them. */
      creditAdjustments: {
        gross: m(grossMinor),
        creditAdjustment: m(adjustmentMinor),
        net: m(grossMinor - adjustmentMinor),
        byFinanceService: a.classification === "direct" && a.linkState === "linked" ? netByFinanceService(allocations.filter((x) => !allocationSuperseded(x, successor)).map((x) => ({ financeServiceId: x.financeServiceId, label: x.programmeLabel, amountMinor: x.allocatedMinor })), credits.flatMap((c) => adjustmentRows(c, ctx.ledger.creditSessions))) : [],
        credits: credits.map((c) => creditView(c, ctx.ledger.applications, ctx.ledger.creditSessions)),
        note: "Gross original cost (the frozen shares, never rewritten) - separate supplier credit adjustment = net real cost.",
      },
      rule: "Profitability (spread across the originally agreed sessions) and cash timing (the instalments) are separate. A cancellation never redistributes the cost.",
    },
  };
}

export async function listInstalments(deps: SupplierDeps, caller: FinanceCaller, q: { supplierId?: string; state?: InstalmentState; from?: string; to?: string }): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const rows = ctx.ledger.instalments
    .filter((i) => (q.supplierId ? i.supplierId === q.supplierId : true) && (q.state ? stateOf(i) === q.state : true) && (q.from ? i.dueDate >= q.from : true) && (q.to ? i.dueDate <= q.to : true))
    .map((i) => instalmentView(i, ctx.today, paymentsOf(ctx, i)));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), instalments: rows } };
}

export async function readInstalment(deps: SupplierDeps, caller: FinanceCaller, instalmentId: string): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const i = ctx.ledger.instalments.find((x) => x.instalmentId === instalmentId);
  if (!i) return fail(404, "instalment_not_found", `No instalment ${instalmentId}`);
  let history: Record<string, any>[];
  try {
    history = await loadHistory(deps.grants, ctx.org.organisationId, `${ctx.org.organisationId}:${instalmentId}`);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const a = ctx.ledger.agreements.find((x) => x.agreementId === i.agreementId);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      instalment: instalmentView(i, ctx.today, paymentsOf(ctx, i)),
      agreement: a ? { agreementId: a.agreementId, name: a.name } : null,
      children: ctx.ledger.instalments.filter((x) => x.splitFromInstalmentId === instalmentId).map((x) => x.instalmentId),
      creditApplications: ctx.ledger.applications.filter((x) => x.instalmentId === instalmentId).map(applicationView),
      history,
    },
  };
}

export async function listCostFacts(deps: SupplierDeps, caller: FinanceCaller, q: SupplierQuery): Promise<Ok | SFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const range = factMonths(q, ctx.today.slice(0, 7));
  if ("ok" in range && range.ok === false) return fail(400, range.code, range.error);
  const { from, to } = range as { from: string; to: string };
  const inRange = (d: string) => d >= from && d <= to;
  const supplierName = new Map(ctx.ledger.suppliers.map((s) => [s.supplierId, s.name]));
  const profitability: Record<string, unknown>[] = [];
  const byService: { financeServiceId: string | null; label: string | null; amountMinor: number }[] = [];
  const unresolved: Record<string, unknown>[] = [];
  for (const a of ctx.ledger.agreements.filter((x) => x.classification === "direct")) {
    const successor = successorOf(ctx, a);
    if (a.linkState === "unresolved") {
      unresolved.push({ agreementId: a.agreementId, supplier: supplierName.get(a.supplierId) ?? null, name: a.name, total: m(a.totalPlannedMinor), link: { sessionIds: a.linkSessionIds, financeServiceId: a.linkFinanceServiceId } });
      continue;
    }
    for (const x of ctx.ledger.allocations.filter((y) => y.agreementId === a.agreementId && inRange(y.occurrenceDate) && !allocationSuperseded(y, successor))) {
      byService.push({ financeServiceId: x.financeServiceId, label: x.programmeLabel, amountMinor: x.allocatedMinor });
      profitability.push({ type: "supplier_direct_cost", source: "agreement_allocation", supplierId: a.supplierId, supplier: supplierName.get(a.supplierId) ?? null, agreementId: a.agreementId, date: x.occurrenceDate, sessionId: x.sessionId, programme: { financeServiceId: x.financeServiceId, label: x.programmeLabel, resolved: !!x.financeServiceId }, amount: m(x.allocatedMinor), estimated: a.amountIsEstimate });
    }
  }
  const cash = ctx.ledger.instalments
    .filter((i) => !i.cancelledAt && inRange(i.dueDate))
    .map((i) => ({ type: "supplier_payment_due", source: "instalment", supplierId: i.supplierId, supplier: supplierName.get(i.supplierId) ?? null, agreementId: i.agreementId, instalmentId: i.instalmentId, dueDate: i.dueDate, amountDue: m(i.amountDueMinor), estimated: i.amountState === "estimated", paid: m(i.paidMinor), creditApplied: m(i.creditedMinor), remaining: m(remainingOf(i)), state: stateOf(i) }));
  const paid = ctx.ledger.payments.filter((p) => inRange(p.paidDate)).map((p) => ({ type: "supplier_payment_made", source: "management_confirmed", supplierId: p.supplierId, supplier: supplierName.get(p.supplierId) ?? null, instalmentId: p.instalmentId, paidDate: p.paidDate, amount: m(p.amountMinor) }));
  // F14: one credit = one cost correction, dated when it was recorded (creditDate); its attribution is kept alongside.
  const creditsInRange = ctx.ledger.credits.filter((c) => !c.voidedAt && inRange(c.creditDate));
  const adjustments = creditsInRange.flatMap((c) => adjustmentRows(c, ctx.ledger.creditSessions));
  const creditAdjustments = creditsInRange.map((c) => ({
    type: "supplier_credit_adjustment",
    source: "supplier_credit",
    supplierId: c.supplierId,
    supplier: supplierName.get(c.supplierId) ?? null,
    creditId: c.creditId,
    agreementId: c.agreementId,
    date: c.creditDate,
    scope: c.scope,
    amount: m(-c.amountMinor),
    attribution: adjustmentRows(c, ctx.ledger.creditSessions).map((r) => ({ financeServiceId: r.financeServiceId, programme: r.label, sessionId: r.sessionId, sessionDate: r.sessionDate, amount: m(-r.amountMinor) })),
  }));
  const liveDue = ctx.ledger.instalments.filter((i) => !i.cancelledAt && inRange(i.dueDate));
  const suppliersInFacts = [...new Set([...liveDue.map((i) => i.supplierId), ...creditsInRange.map((c) => c.supplierId)])].sort();
  const supplierCost = suppliersInFacts.map((sid) => ({ supplierId: sid, supplier: supplierName.get(sid) ?? null, ...costFigures(liveDue.filter((i) => i.supplierId === sid), creditsInRange.filter((c) => c.supplierId === sid)) }));
  const applied = ctx.ledger.applications
    .filter((x) => inRange(x.appliedAt.slice(0, 10)))
    .map((x) => ({ type: "supplier_credit_applied", source: "management_applied", cash: false, supplierId: x.supplierId, supplier: supplierName.get(x.supplierId) ?? null, creditId: x.creditId, instalmentId: x.instalmentId, appliedDate: x.appliedAt.slice(0, 10), amount: m(x.amountMinor), active: !x.unappliedAt }));
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      from,
      to,
      profitability,
      byFinanceService: byFinanceService(byService),
      creditAdjustments,
      byFinanceServiceNet: netByFinanceService(byService, adjustments),
      supplierCost: {
        suppliers: supplierCost,
        total: costFigures(liveDue, creditsInRange),
        note: "gross = instalment amounts due in the range; creditAdjustment = supplier credits recorded in the range; net = gross - creditAdjustment. cashPaid + creditApplied + remainingPayable = amountDue.",
      },
      unresolvedDirectAgreements: unresolved,
      cashTiming: { due: cash, paid, creditApplied: applied },
      rule: "Profitability facts follow the originally agreed sessions; cash facts follow the instalment dates. They are reported separately and never mixed. A supplier credit is a separate cost adjustment (dated when recorded) and applying it is never cash. Nothing here is a Cash Flow event.",
    },
  };
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------
export function createSupplier(deps: SupplierDeps, caller: FinanceCaller, input: { patch: SupplierPatch & { name?: string; supplierType?: SupplierType }; reason: string | null }): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const at = now(deps).toISOString();
    const base: Supplier = {
      organisationId: ctx.org.organisationId,
      supplierId: newId("FSU", deps.suppliers?.random),
      name: "",
      supplierType: "other",
      active: true,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
      vatTreatment: null,
      notes: null,
      venueRecordId: null,
      revision: 1,
      createdAt: at,
      createdBy: caller.userId,
      updatedAt: at,
      updatedBy: caller.userId,
    };
    const applied = applySupplierPatch(base, input.patch);
    if (!applied.ok) return fail(applied.httpStatus, applied.code, applied.error);
    const s = applied.supplier;
    if (ctx.ledger.suppliers.some((x) => x.name.toLowerCase() === s.name.toLowerCase() && x.supplierType === s.supplierType)) return fail(409, "supplier_exists", `A ${s.supplierType} supplier called "${s.name}" already exists`);
    if (s.venueRecordId && !(await venueExists(deps.airtable, s.venueRecordId))) return fail(404, "venue_not_found", "No Venues record with that id");
    await writeSupplier(deps.grants, s, null, [
      supplierAudit({ organisationId: s.organisationId, actorUserId: caller.userId, eventType: EVENTS.supplierCreated, entityType: ENTITY.supplier, recordId: `${s.organisationId}:${s.supplierId}`, before: null, after: supplierView(s), reason: input.reason, route: "POST /suppliers" }),
    ]);
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), supplier: supplierView(s) } };
  });
}

export function updateSupplier(deps: SupplierDeps, caller: FinanceCaller, supplierId: string, input: { patch: SupplierPatch; reason: string | null }): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const before = ctx.ledger.suppliers.find((x) => x.supplierId === supplierId);
    if (!before) return fail(404, "supplier_not_found", `No supplier ${supplierId}`);
    const applied = applySupplierPatch(before, input.patch);
    if (!applied.ok) return fail(applied.httpStatus, applied.code, applied.error);
    const s: Supplier = { ...applied.supplier, revision: before.revision + 1, updatedAt: now(deps).toISOString(), updatedBy: caller.userId };
    const changed = Object.keys(input.patch).filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify((s as any)[k]));
    if (!changed.length) return fail(409, "nothing_to_change", "Nothing would change");
    if (s.venueRecordId && s.venueRecordId !== before.venueRecordId && !(await venueExists(deps.airtable, s.venueRecordId))) return fail(404, "venue_not_found", "No Venues record with that id");
    await writeSupplier(deps.grants, s, before.revision, [
      supplierAudit({ organisationId: s.organisationId, actorUserId: caller.userId, eventType: EVENTS.supplierUpdated, entityType: ENTITY.supplier, recordId: `${s.organisationId}:${s.supplierId}`, before: supplierView(before), after: { ...supplierView(s), changed }, reason: input.reason, route: "POST /suppliers/{id}" }),
    ]);
    return { status: "ok", httpStatus: 200, body: { ...head(ctx), supplier: supplierView(s), changed } };
  });
}

/** Create (predecessor null) or version an agreement: schedule + frozen allocation + audit in one database call. */
async function recordNewAgreement(deps: SupplierDeps, caller: FinanceCaller, ctx: Ctx, supplier: Supplier, spec: AgreementSpec, predecessor: Agreement | null): Promise<Ok | SFail> {
  const org = ctx.org.organisationId;
  if (predecessor) {
    if (successorOf(ctx, predecessor)) return fail(409, "agreement_already_versioned", REFUSALS.agreement_already_versioned);
    if (spec.effectiveFrom <= predecessor.effectiveFrom) return fail(409, "version_must_start_later", REFUSALS.version_must_start_later);
    // A version may start in the past (e.g. entering an existing real agreement), but never re-attributes
    // a session that has already happened: the predecessor's frozen share for it stays the fact.
    const pastShares = ctx.ledger.allocations.filter((x) => x.agreementId === predecessor.agreementId && x.occurrenceDate >= spec.effectiveFrom && x.occurrenceDate < ctx.today);
    if (pastShares.length) return fail(409, "profitability_history_conflict", REFUSALS.profitability_history_conflict, { occurrenceDates: pastShares.map((x) => x.occurrenceDate) });
  }
  const schedule = generateSchedule(spec, ctx.today);
  if (!schedule.ok) return fail(schedule.httpStatus, schedule.code, schedule.error);
  const total = sumMinor(schedule.instalments.map((x) => x.plannedMinor));
  const at = now(deps).toISOString();
  const agreementId = newId("FSA", deps.suppliers?.random);
  let allocations: Allocation[] = [];
  let linkState: Agreement["linkState"] = "not_applicable";
  if (spec.classification === "direct") {
    let work;
    try {
      work = await loadLinkedWork(deps.airtable, spec.financeServiceId ? { financeServiceId: spec.financeServiceId } : { sessionIds: spec.sessionIds });
    } catch (e) {
      console.error(e);
      return unavailable();
    }
    allocations = work.unmatchedSessionIds.length ? [] : allocateDirectCost(org, agreementId, total, spec.effectiveFrom, spec.effectiveUntil as string, work.sessions, work.occurrences);
    if (allocations.length > MAX_ALLOCATED_OCCURRENCES) return fail(409, "too_many_occurrences", `An agreement may cover at most ${MAX_ALLOCATED_OCCURRENCES} occurrences - shorten it`);
    linkState = allocations.length ? "linked" : "unresolved";
  }
  const instalments: Instalment[] = schedule.instalments.map((p) => ({
    organisationId: org,
    instalmentId: newId("FSI", deps.suppliers?.random),
    agreementId,
    supplierId: supplier.supplierId,
    sequence: p.sequence,
    originalDueDate: p.dueDate,
    dueDate: p.dueDate,
    plannedMinor: p.plannedMinor,
    amountDueMinor: p.plannedMinor,
    amountState: p.estimated ? "estimated" : "confirmed",
    paidMinor: 0,
    creditedMinor: 0,
    splitFromInstalmentId: null,
    note: p.note,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    createdAt: at,
    createdBy: caller.userId,
  }));
  let cancel: Instalment[] = [];
  if (predecessor) {
    const after = ctx.ledger.instalments.filter((i) => i.agreementId === predecessor.agreementId && i.dueDate >= spec.effectiveFrom && !i.cancelledAt);
    if (after.some((i) => i.paidMinor > 0)) return fail(409, "paid_instalment_after_change", REFUSALS.paid_instalment_after_change, { instalmentIds: after.filter((i) => i.paidMinor > 0).map((i) => i.instalmentId) });
    if (after.some((i) => i.creditedMinor > 0)) return fail(409, "credited_instalment_after_change", REFUSALS.credited_instalment_after_change, { instalmentIds: after.filter((i) => i.creditedMinor > 0).map((i) => i.instalmentId) });
    cancel = after.map((i) => ({ ...i, cancelledAt: at, cancelledBy: caller.userId, cancelReason: `Superseded by ${agreementId} from ${spec.effectiveFrom}` }));
  }
  const a: Agreement = {
    organisationId: org,
    agreementId,
    supplierId: supplier.supplierId,
    supersedesAgreementId: predecessor?.agreementId ?? null,
    name: spec.name,
    description: spec.description,
    costType: spec.costType,
    frequency: spec.frequency,
    classification: spec.classification,
    effectiveFrom: spec.effectiveFrom,
    effectiveUntil: spec.effectiveUntil,
    amountMinor: spec.amountMinor,
    hourlyRateMinor: spec.hourlyRateMinor,
    expectedMonthlyHoursHundredths: spec.expectedMonthlyHoursHundredths,
    amountIsEstimate: instalments.some((i) => i.amountState === "estimated"),
    instalmentCount: instalments.length,
    totalPlannedMinor: total,
    linkSessionIds: spec.sessionIds,
    linkFinanceServiceId: spec.financeServiceId,
    linkState,
    allocationCount: allocations.length,
    sourceDocumentRef: spec.sourceDocumentRef,
    reason: spec.reason,
    createdAt: at,
    createdBy: caller.userId,
  };
  const r = predecessor ? "POST /supplier-agreements/{id}/version" : "POST /supplier-agreements";
  const audit = (eventType: string, entityType: string, recordId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null) =>
    supplierAudit({ organisationId: org, actorUserId: caller.userId, eventType, entityType, recordId: `${org}:${recordId}`, before, after, reason, route: r });
  const view = agreementView(a, null, ctx.today);
  const events = [
    audit(predecessor ? EVENTS.agreementVersioned : EVENTS.agreementCreated, ENTITY.agreement, agreementId, predecessor ? { supersedes: predecessor.agreementId, totalPlanned: m(predecessor.totalPlannedMinor) } : null, { ...view, allocatedOccurrences: allocations.length, cancelledPredecessorInstalments: cancel.map((c) => c.instalmentId) }, spec.reason),
    ...instalments.map((i) => audit(EVENTS.instalmentCreated, ENTITY.instalment, i.instalmentId, null, auditInstalment(i), null)),
    ...cancel.map((c) => audit(EVENTS.cancelled, ENTITY.instalment, c.instalmentId, auditInstalment({ ...c, cancelledAt: null }), auditInstalment(c), c.cancelReason)),
  ];
  await recordAgreement(deps.grants, a, allocations, instalments, cancel, events);
  return {
    status: "ok",
    httpStatus: 201,
    body: {
      ...head(ctx),
      agreement: view,
      schedule: instalments.map((i) => instalmentView(i, ctx.today)),
      profitability: profitabilityView(a, allocations, null, new Map(allocations.map((x) => [x.occurrenceRecordId, x.statusAtAgreement]))),
      cancelledPredecessorInstalments: cancel.map((c) => c.instalmentId),
    },
  };
}

export function createAgreement(deps: SupplierDeps, caller: FinanceCaller, supplierId: string, spec: AgreementSpec): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const s = ctx.ledger.suppliers.find((x) => x.supplierId === supplierId);
    if (!s) return fail(404, "supplier_not_found", `No supplier ${supplierId}`);
    if (!s.active) return fail(409, "supplier_inactive", "This supplier is inactive - reactivate it first");
    return recordNewAgreement(deps, caller, ctx, s, spec, null);
  });
}
export function versionAgreement(deps: SupplierDeps, caller: FinanceCaller, agreementId: string, spec: AgreementSpec): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const prev = ctx.ledger.agreements.find((x) => x.agreementId === agreementId);
    if (!prev) return fail(404, "agreement_not_found", `No agreement ${agreementId}`);
    const s = ctx.ledger.suppliers.find((x) => x.supplierId === prev.supplierId) as Supplier;
    return recordNewAgreement(deps, caller, ctx, s, spec, prev);
  });
}

export function changeInstalmentAction(deps: SupplierDeps, caller: FinanceCaller, instalmentId: string, action: InstalmentAction, input: ActionInput): Promise<Ok | SFail> {
  return withLock(deps, caller, async (ctx) => {
    const i = ctx.ledger.instalments.find((x) => x.instalmentId === instalmentId);
    if (!i) return fail(404, "instalment_not_found", `No instalment ${instalmentId}`);
    const at = now(deps).toISOString();
    const plan = planChange(i, input, { today: ctx.today, actor: caller.userId, at, newId: (p) => newId(p, deps.suppliers?.random) });
    if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    const org = ctx.org.organisationId;
    const audit = (eventType: string, inst: Instalment, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null) =>
      supplierAudit({ organisationId: org, actorUserId: caller.userId, eventType, entityType: ENTITY.instalment, recordId: `${org}:${inst.instalmentId}`, before, after, reason, route: `POST /supplier-instalments/{id}/${action}` });
    const reason = "reason" in input ? input.reason : null;
    let change: Record<string, unknown> = {};
    let children: Instalment[] = [];
    let payment = null;
    let events: Record<string, unknown>[];
    if (plan.kind === "confirm_estimate") {
      change = { amount_due_minor: plan.next.amountDueMinor };
      const useEstimate = input.action === "confirm-estimate" && input.useEstimate;
      events = [audit(EVENTS.estimateConfirmed, i, auditInstalment(i), { ...auditInstalment(plan.next), estimate: m(i.amountDueMinor), confirmed: m(plan.next.amountDueMinor), usedEstimate: useEstimate, paidStateUnchanged: true }, reason)];
    } else if (plan.kind === "move") {
      change = { due_date: plan.next.dueDate };
      events = [audit(EVENTS.moved, i, auditInstalment(i), { ...auditInstalment(plan.next), from: i.dueDate, to: plan.next.dueDate }, reason)];
    } else if (plan.kind === "split") {
      change = { amount_due_minor: plan.next.amountDueMinor, due_date: plan.next.dueDate };
      children = plan.children;
      events = [
        audit(EVENTS.split, i, auditInstalment(i), { ...auditInstalment(plan.next), children: children.map((c) => ({ instalmentId: c.instalmentId, dueDate: c.dueDate, amount: m(c.amountDueMinor) })) }, reason),
        ...children.map((c) => audit(EVENTS.instalmentCreated, c, null, { ...auditInstalment(c), splitFrom: i.instalmentId }, reason)),
      ];
    } else if (plan.kind === "payment") {
      payment = plan.payment;
      const full = remainingOf(plan.next) === 0;
      events = [audit(full ? EVENTS.paid : EVENTS.partiallyPaid, i, auditInstalment(i), { ...auditInstalment(plan.next), payment: paymentView(plan.payment) }, null)];
    } else {
      change = { cancelled_at: plan.next.cancelledAt, cancelled_by: plan.next.cancelledBy, cancel_reason: plan.next.cancelReason };
      events = [audit(EVENTS.cancelled, i, auditInstalment(i), auditInstalment(plan.next), reason)];
    }
    await changeInstalment(deps.grants, i, plan.kind, change, children, payment, events);
    return {
      status: "ok",
      httpStatus: plan.kind === "payment" || plan.kind === "split" ? 201 : 200,
      body: {
        ...head(ctx),
        instalment: instalmentView(plan.next, ctx.today, [...paymentsOf(ctx, i), ...(payment ? [payment] : [])]),
        ...(children.length ? { newInstalments: children.map((c) => instalmentView(c, ctx.today)) } : {}),
        ...(payment ? { payment: paymentView(payment) } : {}),
        note: plan.kind === "confirm_estimate" ? "The amount due is now confirmed. Nothing has been paid - Paid is a separate action." : undefined,
      },
    };
  });
}
