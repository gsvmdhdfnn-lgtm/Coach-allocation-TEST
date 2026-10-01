/**
 * Test-suite copy of the canonical finance/finance-coach-costs-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts.
 */
/**
 * Coach cost READ + Finance Coach Month finalisation - orchestration (Finance
 * Foundation F12; see TEST-ENV.md "Finance Foundation - F12"). Every route
 * authorises through F1's authorizeFinance() first: View reads, Manage writes.
 *
 * Reads (View, never audited):
 *   GET /coach-costs?month=                  every coach's month: state, total, items, payment date + by programme
 *   GET /coach-costs/{coach}?from&to         one coach, month by month
 *   GET /coach-costs/{coach}/{month}         drill-down: items, override detail, blockers, Work Summary
 *                                            coverage, Finance month, corrections, drift, payment timing
 *   GET /coach-summaries?month&state         stored Finance Coach Months
 *   GET /coach-summaries/{FCM}               one stored month + its frozen items + corrections + status
 *   GET /coach-cost-facts?from&to            reporting facts (per work item + per correction) for later reports
 *
 * Writes (Manage, under the shared Finance write lock, each ONE atomic
 * database call that also writes its audit row):
 *   POST /coach-costs/{coach}/{month}/finalise   freeze the month (refused while anything blocks)
 *   POST /coach-summaries/{FCM}/corrections      explicit additive correction (never a rewrite)
 *
 * Airtable is read only. No coach payment, coach invoice, Cash Flow event or
 * Work Summary change is ever made here.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { type CommercialDeps } from "./finance-commercial-orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import { fromStoredRow } from "./finance-settings.ts";
import { loadSettingsRows } from "./finance-settings-repository.ts";
import {
  type Blocker,
  type Correction,
  type CostWorld,
  type FinanceMonth,
  type FrozenItem,
  type MonthState,
  type Worker,
  type WorkItem,
  COACH_COST_CONTRACT,
  COST_EVENTS,
  ENTITY,
  byProgramme,
  correctionView,
  costAudit,
  expectedPaymentDate,
  finaliseBlockers,
  freezeItem,
  frozenItemView,
  liveItemView,
  m,
  monthBounds,
  monthOf,
  monthRange,
  monthStatus,
  monthView,
  monthsBetween,
  newId,
  paymentView,
  sha256Hex,
  snapshotText,
  statusView,
  workItemsOf,
  workerByRef,
  workersOf,
} from "./finance-coach-costs.ts";
import { type MonthLedger, CostRefusal, correctMonth, finaliseMonth, loadCostWorld, loadMonthLedger } from "./finance-coach-costs-repository.ts";

export interface CostDeps extends CommercialDeps {
  coachCosts?: { random?: () => string };
}
export type CFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: CFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): CFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is CFail => !!x && typeof x === "object" && (x as any).status === "error";

const now = (deps: CostDeps) => (deps.clock ?? (() => new Date()))();
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "coach_costs_unavailable", "Coach costs could not be loaded just now - try again");

const REFUSALS: Record<string, string> = {
  already_finalised: "This coach's month is already finalised - change it only with an explicit correction",
  month_changed: "This month was corrected by someone else just now - reload and try again",
  corrected_total_negative: "That correction would take the month's total below 0.00",
  snapshot_mismatch: "The month snapshot did not add up - nothing was finalised",
  month_not_found: "No such Finance Coach Month",
};
function refusalFail(e: unknown): CFail | null {
  if (e instanceof CostRefusal) return fail(409, e.code, REFUSALS[e.code] ?? "The change was refused by the ledger's rules - nothing was changed");
  return null;
}

type Ctx = { org: OrganisationContext; access: string; today: string; paymentDay: number | null; ledger: MonthLedger };

async function paymentDayOf(deps: CostDeps, org: OrganisationContext): Promise<number | null> {
  const rows = await loadSettingsRows(deps.airtable, org.recordId);
  if (rows.length !== 1) return null;
  const p = fromStoredRow(rows[0]);
  return p.ok ? p.state.settings.coachPaymentDayOfFollowingMonth : null;
}

async function load(deps: CostDeps, org: OrganisationContext, access: string): Promise<Ctx | CFail> {
  try {
    const [paymentDay, ledger] = await Promise.all([paymentDayOf(deps, org), loadMonthLedger(deps.grants, org.organisationId)]);
    return { org, access, today: todayIn(org.timezone, now(deps)), paymentDay, ledger };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}
async function world(deps: CostDeps, from: string, to: string): Promise<CostWorld | CFail> {
  try {
    return await loadCostWorld(deps.airtable, from, to);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}
async function readCtx(deps: CostDeps, caller: FinanceCaller): Promise<Ctx | CFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  return load(deps, auth.organisation, auth.access);
}
async function withLock(deps: CostDeps, caller: FinanceCaller, run: (ctx: Ctx) => Promise<Ok | CFail>): Promise<Ok | CFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "coach_costs_unavailable", "The change could not be made just now - try again");
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
    return fail(503, "coach_costs_unavailable", "The change could not be completed just now - nothing was changed; try again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

const head = (ctx: Ctx) => ({ contract: COACH_COST_CONTRACT, organisation: { organisationId: ctx.org.organisationId, name: ctx.org.name }, access: ctx.access, currency: "GBP" });
const coachOf = (w: Worker) => ({ coachId: w.ref, name: w.name, active: w.active });

// ---------------------------------------------------------------------
// One worker + one month
// ---------------------------------------------------------------------
interface MonthReport {
  workMonth: string;
  items: WorkItem[];
  financeMonth: FinanceMonth | null;
  frozen: FrozenItem[];
  corrections: Correction[];
  status: ReturnType<typeof monthStatus>;
  blockers: Blocker[];
  payment: ReturnType<typeof paymentView>;
}
function report(ctx: Ctx, w: CostWorld, worker: Worker, workMonth: string): MonthReport {
  const b = monthBounds(workMonth);
  const items = workItemsOf(w, worker.recordId, b.from, b.to, ctx.today);
  const fm = ctx.ledger.months.find((x) => x.workerRecordId === worker.recordId && x.workMonth === workMonth) ?? null;
  const frozen = fm ? ctx.ledger.items.filter((i) => i.month_id === fm.monthId) : [];
  const corrections = fm ? ctx.ledger.corrections.filter((c) => c.monthId === fm.monthId) : [];
  const status = monthStatus(fm, frozen, corrections, items);
  const pay = fm ? { ok: true as const, date: fm.expectedPaymentDate, day: fm.paymentDay } : expectedPaymentDate(workMonth, ctx.paymentDay);
  const itemBlockers = items.flatMap((i) => i.blockers.map((bl) => ({ code: bl.code, detail: `${i.workDate} ${i.sessionName}: ${bl.detail}`, allocation: i.allocationLabel })));
  return {
    workMonth,
    items,
    financeMonth: fm,
    frozen,
    corrections,
    status,
    blockers: [...finaliseBlockers(items, workMonth, ctx.today, ctx.paymentDay), ...itemBlockers],
    payment: paymentView(workMonth, pay.ok ? pay.day : ctx.paymentDay, pay.ok ? pay.date : null),
  };
}
/** The amount a month reports: the corrected total once finalised, else the live total of priced items. */
const reportedTotal = (r: MonthReport) => (r.status.correctedTotalMinor ?? r.status.liveTotalMinor);

function summaryRow(worker: Worker, r: MonthReport) {
  return {
    coach: coachOf(worker),
    workMonth: r.workMonth,
    state: r.status.state,
    total: m(reportedTotal(r)),
    finalisedTotal: r.status.finalisedTotalMinor === null ? null : m(r.status.finalisedTotalMinor),
    workItems: r.financeMonth ? r.financeMonth.itemCount : r.items.length,
    readyToFinalise: !r.financeMonth && r.blockers.length === 0,
    blockers: r.financeMonth ? 0 : r.blockers.length,
    correctionsExist: r.corrections.length > 0,
    correctionRequired: r.status.correctionRequired,
    payment: r.payment,
    monthId: r.financeMonth?.monthId ?? null,
  };
}
function detail(worker: Worker, r: MonthReport) {
  return {
    coach: coachOf(worker),
    workMonth: r.workMonth,
    status: statusView(r.status),
    payment: r.payment,
    /** Live allocations (Coaches' historical cost records) for this month. */
    workItems: r.items.map(liveItemView),
    blockers: r.financeMonth ? [] : r.blockers,
    readyToFinalise: !r.financeMonth && r.blockers.length === 0,
    finance: r.financeMonth
      ? { ...monthView(r.financeMonth), frozenItems: r.frozen.map(frozenItemView), corrections: r.corrections.map(correctionView) }
      : null,
    byProgramme: byProgramme(r.financeMonth ? r.frozen.map((f) => ({ financeServiceId: f.finance_service_id, programmeLabel: f.programme_label, amountMinor: f.final_cost_minor })) : r.items.map((i) => ({ financeServiceId: i.financeServiceId, programmeLabel: i.programmeLabel, amountMinor: i.finalCostMinor }))),
    note: "A Work Summary is the coach-facing statement; this is Finance's record. Coverage means the allocation is on a Finalised Work Summary with the same amount - it does not mean the coach viewed it.",
  };
}

function resolveWorker(w: CostWorld, ref: string): Worker | CFail {
  const r = workerByRef(workersOf(w.workers), ref);
  return r.ok ? r.worker : fail(r.httpStatus, r.code, r.error);
}

// ---------------------------------------------------------------------
// Reads (View)
// ---------------------------------------------------------------------
export async function readCostMonth(deps: CostDeps, caller: FinanceCaller, q: { month?: string }): Promise<Ok | CFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const month = q.month ?? monthOf(ctx.today);
  const b = monthBounds(month);
  const w = await world(deps, b.from, b.to);
  if (isFail(w)) return w;
  const workers = workersOf(w.workers);
  const withWork = new Set(w.allocations.flatMap((a) => (Array.isArray(a.fields["Coach"]) ? a.fields["Coach"] : [])));
  for (const fm of ctx.ledger.months) if (fm.workMonth === month) withWork.add(fm.workerRecordId);
  const rows: ReturnType<typeof summaryRow>[] = [];
  let totalMinor = 0;
  const programmeItems: { financeServiceId: string | null; programmeLabel: string | null; amountMinor: number | null }[] = [];
  for (const worker of workers.filter((x) => withWork.has(x.recordId)).sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const r = report(ctx, w, worker, month);
    if (!r.items.length && !r.financeMonth) continue;
    rows.push(summaryRow(worker, r));
    totalMinor += reportedTotal(r);
    if (r.financeMonth) programmeItems.push(...r.frozen.map((f) => ({ financeServiceId: f.finance_service_id, programmeLabel: f.programme_label, amountMinor: f.final_cost_minor })));
    else programmeItems.push(...r.items.map((i) => ({ financeServiceId: i.financeServiceId, programmeLabel: i.programmeLabel, amountMinor: i.finalCostMinor })));
  }
  const corrections = ctx.ledger.corrections.filter((c) => ctx.ledger.months.some((fm) => fm.monthId === c.monthId && fm.workMonth === month));
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      workMonth: month,
      byCoach: rows,
      byProgramme: byProgramme(programmeItems),
      /** Corrections are kept apart: they belong to a coach month, not to a programme. */
      corrections: m(corrections.reduce((s, c) => s + c.amountMinor, 0)),
      total: m(totalMinor),
      rule: "Historical cost from each allocation's own frozen rate / units / Final Coach Cost - never the current rate. Recorded in the month the work happened; payment timing is separate.",
    },
  };
}

export async function readWorkerMonths(deps: CostDeps, caller: FinanceCaller, ref: string, q: { from?: string; to?: string }): Promise<Ok | CFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const range = monthRange(q.from, q.to, monthOf(ctx.today));
  if (!range.ok) return fail(400, range.code, range.error);
  const w = await world(deps, monthBounds(range.from).from, monthBounds(range.to).to);
  if (isFail(w)) return w;
  const worker = resolveWorker(w, ref);
  if (isFail(worker)) return worker;
  const months = monthsBetween(range.from, range.to).map((mo) => summaryRow(worker, report(ctx, w, worker, mo)));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), coach: coachOf(worker), from: range.from, to: range.to, months } };
}

export async function readWorkerMonth(deps: CostDeps, caller: FinanceCaller, ref: string, month: string): Promise<Ok | CFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const b = monthBounds(month);
  const w = await world(deps, b.from, b.to);
  if (isFail(w)) return w;
  const worker = resolveWorker(w, ref);
  if (isFail(worker)) return worker;
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), ...detail(worker, report(ctx, w, worker, month)) } };
}

function storedMonthBody(ctx: Ctx, fm: FinanceMonth, live: WorkItem[] | null) {
  const frozen = ctx.ledger.items.filter((i) => i.month_id === fm.monthId);
  const corrections = ctx.ledger.corrections.filter((c) => c.monthId === fm.monthId);
  const status = live ? statusView(monthStatus(fm, frozen, corrections, live)) : null;
  return { ...monthView(fm), status, frozenItems: frozen.map(frozenItemView), corrections: corrections.map(correctionView) };
}

export async function listFinanceMonths(deps: CostDeps, caller: FinanceCaller, q: { month?: string; state?: MonthState }): Promise<Ok | CFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  let months = ctx.ledger.months;
  if (q.month) months = months.filter((fm) => fm.workMonth === q.month);
  let rows: Record<string, unknown>[];
  if (q.state) {
    // State is live (Correction Required depends on today's allocations): read each month's window.
    rows = [];
    for (const fm of months) {
      const b = monthBounds(fm.workMonth);
      const w = await world(deps, b.from, b.to);
      if (isFail(w)) return w;
      const worker = workersOf(w.workers).find((x) => x.recordId === fm.workerRecordId);
      const live = worker ? workItemsOf(w, worker.recordId, b.from, b.to, ctx.today) : [];
      const body = storedMonthBody(ctx, fm, live);
      if (body.status?.state === q.state) rows.push(body);
    }
  } else rows = months.map((fm) => storedMonthBody(ctx, fm, null));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), months: rows, note: rows.length && !q.state ? "Pass ?state= for each month's live state (Correction Required is derived from today's allocations)" : undefined } };
}

export async function readFinanceMonth(deps: CostDeps, caller: FinanceCaller, monthId: string): Promise<Ok | CFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const fm = ctx.ledger.months.find((x) => x.monthId === monthId);
  if (!fm) return fail(404, "month_not_found", `No Finance Coach Month ${monthId}`);
  const b = monthBounds(fm.workMonth);
  const w = await world(deps, b.from, b.to);
  if (isFail(w)) return w;
  const live = workItemsOf(w, fm.workerRecordId, b.from, b.to, ctx.today);
  const frozen = ctx.ledger.items.filter((i) => i.month_id === fm.monthId);
  const integrity = (await sha256Hex(snapshotText(fm.workerRecordId, fm.workMonth, fm.finalisedTotalMinor, frozen))) === fm.snapshotHash;
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), ...storedMonthBody(ctx, fm, live), integrityVerified: integrity } };
}

export async function listCostFacts(deps: CostDeps, caller: FinanceCaller, q: { from?: string; to?: string }): Promise<Ok | CFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const range = monthRange(q.from, q.to, monthOf(ctx.today));
  if (!range.ok) return fail(400, range.code, range.error);
  const w = await world(deps, monthBounds(range.from).from, monthBounds(range.to).to);
  if (isFail(w)) return w;
  const workers = workersOf(w.workers);
  const facts: Record<string, unknown>[] = [];
  for (const worker of workers) {
    for (const mo of monthsBetween(range.from, range.to)) {
      const r = report(ctx, w, worker, mo);
      const base = { organisationId: ctx.org.organisationId, coach: { coachId: worker.ref, name: worker.name }, workMonth: mo, state: r.status.state, monthId: r.financeMonth?.monthId ?? null };
      if (r.financeMonth) {
        for (const f of r.frozen) facts.push({ ...base, type: "coach_cost", source: "finance_month_snapshot", workDate: f.work_date, occurrenceId: f.occurrence_ref, session: f.session_name, programme: { financeServiceId: f.finance_service_id, label: f.programme_label, resolved: !!f.finance_service_id }, costBasis: f.cost_basis, historicalCost: m(f.final_cost_minor), costResolved: true });
        for (const c of r.corrections) facts.push({ ...base, type: "coach_cost_correction", source: "finance_correction", correctionId: c.correctionId, amount: m(c.amountMinor), createdAt: c.createdAt, reason: c.reason });
      } else {
        for (const i of r.items) facts.push({ ...base, type: "coach_cost", source: "live_allocation", workDate: i.workDate, occurrenceId: i.occurrenceRef, session: i.sessionName, programme: { financeServiceId: i.financeServiceId, label: i.programmeLabel, resolved: !!i.financeServiceId }, costBasis: i.costBasis, historicalCost: i.finalCostMinor === null ? null : m(i.finalCostMinor), costResolved: i.blockers.every((b) => !["missing_historical_rate", "missing_final_cost", "invalid_final_cost", "invalid_units", "invalid_cost_basis", "cost_mismatch", "no_cost_basis_with_cost", "paid_zero_rate", "override_unexplained"].includes(b.code)) });
      }
    }
  }
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), from: range.from, to: range.to, facts, rule: "Cost is recorded in the work month (profitability). Payment timing is a separate fact (expected payment date) for later Cash Flow; nothing here is a cash event.", businessCost: true } };
}

// ---------------------------------------------------------------------
// Writes (Manage)
// ---------------------------------------------------------------------
export function finaliseWorkerMonth(deps: CostDeps, caller: FinanceCaller, ref: string, month: string, reason: string | null): Promise<Ok | CFail> {
  return withLock(deps, caller, async (ctx) => {
    const b = monthBounds(month);
    const w = await world(deps, b.from, b.to);
    if (isFail(w)) return w;
    const worker = resolveWorker(w, ref);
    if (isFail(worker)) return worker;
    const r = report(ctx, w, worker, month);
    if (r.financeMonth) return fail(409, "already_finalised", `${worker.name}'s ${month} is already finalised (${r.financeMonth.monthId}) - change it only with an explicit correction`, { monthId: r.financeMonth.monthId });
    if (r.blockers.length) return fail(409, "finalisation_blocked", "This month cannot be finalised yet - resolve the blockers first", { blockers: r.blockers, blockerCodes: [...new Set(r.blockers.map((x) => x.code))] });
    const pay = expectedPaymentDate(month, ctx.paymentDay);
    if (!pay.ok) return fail(409, "finalisation_blocked", "Coach Payment Day is not configured", { blockerCodes: ["payment_day_not_configured"] });
    const frozen = r.items.map(freezeItem);
    const total = frozen.reduce((s, f) => s + f.final_cost_minor, 0);
    const fm: FinanceMonth = {
      organisationId: ctx.org.organisationId,
      monthId: newId("FCM", deps.coachCosts?.random),
      workerRecordId: worker.recordId,
      workerRef: worker.ref,
      workerName: worker.name,
      workMonth: month,
      finalisedTotalMinor: total,
      itemCount: frozen.length,
      paymentDay: pay.day,
      expectedPaymentDate: pay.date,
      snapshotHash: await sha256Hex(snapshotText(worker.recordId, month, total, frozen)),
      finalisedAt: now(deps).toISOString(),
      finalisedBy: caller.userId,
      reason,
    };
    await finaliseMonth(deps.grants, fm, frozen, [
      costAudit({
        organisationId: fm.organisationId,
        actorUserId: caller.userId,
        eventType: COST_EVENTS.monthFinalised,
        entityType: ENTITY.month,
        recordId: `${fm.organisationId}:${fm.monthId}`,
        before: null,
        after: { monthId: fm.monthId, coachId: fm.workerRef, workMonth: month, finalisedTotal: m(total), workItems: frozen.length, expectedPaymentDate: fm.expectedPaymentDate, snapshotSha256: fm.snapshotHash },
        reason,
        route: "POST /coach-costs/{coach}/{month}/finalise",
      }),
    ]);
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), finalised: { ...monthView(fm), frozenItems: frozen.map(frozenItemView), corrections: [] }, note: "Frozen for Finance reporting and payment timing. Later changes are explicit corrections; nothing is paid by finalising." } };
  });
}

export function correctFinanceMonth(deps: CostDeps, caller: FinanceCaller, monthId: string, input: { amountMinor: number; reason: string; allocationRecordId: string | null }): Promise<Ok | CFail> {
  return withLock(deps, caller, async (ctx) => {
    const fm = ctx.ledger.months.find((x) => x.monthId === monthId);
    if (!fm) return fail(404, "month_not_found", `No Finance Coach Month ${monthId}`);
    const corrections = ctx.ledger.corrections.filter((c) => c.monthId === monthId);
    const current = fm.finalisedTotalMinor + corrections.reduce((s, c) => s + c.amountMinor, 0);
    const resulting = current + input.amountMinor;
    if (resulting < 0) return fail(409, "corrected_total_negative", `The corrected total is ${m(current)} - a correction of ${m(input.amountMinor)} would take it below 0.00`);
    if (input.allocationRecordId) {
      const frozen = ctx.ledger.items.some((i) => i.month_id === monthId && i.allocation_record_id === input.allocationRecordId);
      let live = false;
      if (!frozen) {
        const b = monthBounds(fm.workMonth);
        const w = await world(deps, b.from, b.to);
        if (isFail(w)) return w;
        live = workItemsOf(w, fm.workerRecordId, b.from, b.to, ctx.today).some((i) => i.allocationRecordId === input.allocationRecordId);
      }
      if (!frozen && !live) return fail(409, "allocation_not_in_month", "That allocation is not part of this coach's month");
    }
    const c: Correction = {
      organisationId: ctx.org.organisationId,
      correctionId: newId("FCX", deps.coachCosts?.random),
      monthId,
      amountMinor: input.amountMinor,
      allocationRecordId: input.allocationRecordId,
      reason: input.reason,
      resultingTotalMinor: resulting,
      createdAt: now(deps).toISOString(),
      createdBy: caller.userId,
    };
    await correctMonth(deps.grants, c, current, [
      costAudit({
        organisationId: c.organisationId,
        actorUserId: caller.userId,
        eventType: COST_EVENTS.correctionCreated,
        entityType: ENTITY.correction,
        recordId: `${c.organisationId}:${c.correctionId}`,
        before: { monthId, correctedTotal: m(current) },
        after: { correctionId: c.correctionId, monthId, coachId: fm.workerRef, workMonth: fm.workMonth, amount: m(c.amountMinor), originalFinalisedTotal: m(fm.finalisedTotalMinor), correctedTotal: m(resulting), allocationRecordId: c.allocationRecordId },
        reason: c.reason,
        route: "POST /coach-summaries/{id}/corrections",
      }),
    ]);
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), correction: correctionView(c), month: { monthId, workMonth: fm.workMonth, coach: { coachId: fm.workerRef, name: fm.workerName }, originalFinalisedTotal: m(fm.finalisedTotalMinor), correctedTotal: m(resulting) } } };
  });
}
