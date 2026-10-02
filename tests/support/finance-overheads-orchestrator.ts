/**
 * Test-suite copy of the canonical finance/finance-overheads-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Overheads / salaries & employment costs - orchestration (Finance Foundation
 * F15; see TEST-ENV.md "Finance Foundation - F15"). Every route authorises
 * through F1's authorizeFinance() first (via F13's readCtx / withLock): View
 * reads, Manage writes, all writes under the shared Finance write lock.
 *
 * Reads (View, never audited):
 *   GET /overhead-categories[?active]            categories + usage + suggestions (never seeded)
 *   GET /overhead-categories/{FOC}               one category: where it is used + its history
 *   GET /overheads[?categoryId&month]            categorised F13 general agreements + employment costs, by category
 *   GET /overheads/{FSA}                         one overhead: F13 agreement, schedule, versions with their categories
 *   GET /employment-costs[?active]               salaried employees: current terms + this month
 *   GET /employment-costs/{FEM}[?from&to]        versions, months (estimated / confirmed / paid), history
 *   GET /overhead-facts[?from&to]                reporting facts: supplier overheads + employment items
 *
 * Writes (Manage, each ONE atomic database call that also writes its audit rows):
 *   POST /overhead-categories, POST /overhead-categories/{FOC}       create / rename / deactivate / reactivate
 *   POST /overheads                              categorise one F13 general agreement version (fixed once made)
 *   POST /overheads/{FSA}/version                a NEW F13 agreement version + its category, in one transaction
 *   POST /employment-costs, POST /employment-costs/{FEM}/version
 *   POST /employment-costs/{FEM}/months/{YYYY-MM}/confirm-estimate | payment
 *
 * Supplier overhead estimates and payments stay on F13's /supplier-instalments
 * routes. Nothing here creates a contractor ledger, runs payroll, allocates
 * salary to sessions, creates a Cash Flow event or builds a Month Report.
 */
import type { FinanceCaller } from "./finance-access.ts";
import {
  type Agreement,
  type AgreementSpec,
  type Instalment,
  agreementStatus,
  agreementView,
  instalmentView,
  m,
  remainingOf,
  stateLabelOf,
  stateOf,
} from "./finance-suppliers.ts";
import { SupplierRefusal, loadHistory } from "./finance-suppliers-repository.ts";
import { type Ctx, type Ok, type SFail, type SupplierDeps, REFUSALS, fail, isFail, now, readCtx, recordNewAgreement, unavailable, withLock } from "./finance-suppliers-orchestrator.ts";
import {
  type EmploymentItem,
  type EmploymentPatch,
  type EmploymentSpec,
  type EmploymentVersion,
  type ItemAction,
  type MonthLine,
  type OverheadAssignment,
  type OverheadCategory,
  EMPLOYMENT_RULE,
  ESTIMATE_LABEL,
  OVERHEAD_CONTRACT,
  OVERHEAD_ENTITY,
  OVERHEAD_EVENTS,
  OVERHEAD_RULE,
  SUGGESTED_CATEGORIES,
  addMonth,
  applyCategoryPatch,
  asInstalment,
  assignmentOf,
  assignmentView,
  auditItem,
  categoryView,
  chainOf,
  employmentStatus,
  employmentVersionView,
  latestOf,
  monthLine,
  monthLineView,
  monthOf,
  monthRange,
  monthsBetween,
  newId,
  overheadAudit,
  planAssign,
  planEmploymentVersion,
  planItemConfirm,
  planItemPayment,
  vatFigures,
} from "./finance-overheads.ts";
import { type OverheadLedger, changeItem, findPeople, loadOverheadLedger, recordAssignment, recordEmploymentVersion, recordOverheadVersion, writeCategory } from "./finance-overheads-repository.ts";
import type { ActionInput } from "./finance-suppliers.ts";

export const OVERHEAD_REFUSALS: Record<string, string> = {
  category_exists: "A category with that name already exists",
  category_changed: "This category was changed by someone else just now - reload and try again",
  category_not_found: "No such overhead category",
  category_inactive: "That category is inactive - reactivate it or choose another",
  category_required: "The version it replaces has no category - choose one (categoryId)",
  not_an_overhead: "A direct cost is attributed to sessions - it is not an overhead",
  already_categorised: "This agreement version already has its category - to recategorise from a later date, make a new agreement version",
  already_versioned: "This employment already has a newer version - change the latest version instead",
  version_must_start_later: "A new version must start after the month the current version starts",
  confirmed_month_after_change: "A month on or after that start is already confirmed or paid - that history is never rewritten",
  employment_changed: "This employment cost was changed by someone else just now - reload and try again",
  employment_exists: "An employment cost for this person already exists - version it instead",
  already_confirmed: "This month's amount is already confirmed",
  already_paid: "This month is already recorded as paid - a payment is never recorded twice",
  month_not_employed: "There is no employment cost in that month",
  partial_payment_not_supported: "Salary items are paid in full only",
  item_changed: "This month was changed by someone else just now - reload and try again",
  snapshot_mismatch: "The change did not add up - nothing was saved",
  agreement_not_found: "No such supplier agreement",
  employment_not_found: "No such employment cost",
  item_not_found: "That month has not been confirmed yet",
  end_before_version_start: "To end the employment, start the new version in (or before) the month it ends",
  version_before_start: "A version cannot start before the employment starts",
  history_is_append_only: "That history is never rewritten - nothing was changed",
};
/** A refusal raised by the database (f13: / f14: / f15:), with F15's own wording first. */
function refused(e: unknown): SFail | null {
  if (e instanceof SupplierRefusal) return fail(409, e.code, OVERHEAD_REFUSALS[e.code] ?? REFUSALS[e.code] ?? "The change was refused by the ledger's rules - nothing was changed");
  return null;
}
async function guarded(run: () => Promise<unknown>): Promise<SFail | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const r = refused(e);
    if (r) return r;
    throw e;
  }
}

type OCtx = Ctx & { oh: OverheadLedger };
async function withOverheads(deps: SupplierDeps, ctx: Ctx | SFail): Promise<OCtx | SFail> {
  if (isFail(ctx)) return ctx;
  try {
    return { ...ctx, oh: await loadOverheadLedger(deps.grants, ctx.org.organisationId) };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}
const readO = async (deps: SupplierDeps, caller: FinanceCaller) => withOverheads(deps, await readCtx(deps, caller));
const writeO = (deps: SupplierDeps, caller: FinanceCaller, run: (ctx: OCtx) => Promise<Ok | SFail>) =>
  withLock(deps, caller, async (ctx) => {
    const o = await withOverheads(deps, ctx);
    return isFail(o) ? o : run(o);
  });

const head = (ctx: Ctx) => ({ contract: OVERHEAD_CONTRACT, organisation: { organisationId: ctx.org.organisationId, name: ctx.org.name }, access: ctx.access, currency: "GBP" });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const successorOf = (ctx: Ctx, a: Agreement) => ctx.ledger.agreements.find((x) => x.supersedesAgreementId === a.agreementId) ?? null;
const supplierBrief = (ctx: Ctx, id: string) => {
  const s = ctx.ledger.suppliers.find((x) => x.supplierId === id);
  return s ? { supplierId: s.supplierId, name: s.name, type: s.supplierType, vatTreatment: s.vatTreatment } : null;
};
const categoryBrief = (ctx: OCtx, id: string | null) => {
  const c = id ? ctx.oh.categories.find((x) => x.categoryId === id) : undefined;
  return c ? { categoryId: c.categoryId, name: c.name, active: c.active } : null;
};
const paymentsOf = (ctx: Ctx, i: Instalment) => ctx.ledger.payments.filter((p) => p.instalmentId === i.instalmentId);
const lastPaidDate = (ctx: Ctx, i: Instalment) => paymentsOf(ctx, i).map((p) => p.paidDate).sort().at(-1) ?? null;
const contractorOf = (ctx: Ctx, a: Agreement) => {
  const s = ctx.ledger.suppliers.find((x) => x.supplierId === a.supplierId);
  return {
    contractor: s?.supplierType === "contractor",
    /** An hourly contractor: expected monthly hours forecast, one confirmed monthly amount (F13) - no timesheets. */
    hourlyForecast: a.costType === "hourly" ? { hourlyRate: m(a.hourlyRateMinor as number), expectedMonthlyHours: ((a.expectedMonthlyHoursHundredths as number) / 100).toFixed(2), confirmedMonthly: true, timesheetsRequired: false } : null,
  };
};
const generalAgreements = (ctx: Ctx) => ctx.ledger.agreements.filter((a) => a.classification === "general");

/** One employment month as a reporting / overview line. */
function employmentLine(ctx: OCtx, l: MonthLine) {
  const v = monthLineView(ctx.org.organisationId, l);
  return { ...v, employmentId: l.employmentId, person: { ref: l.version.personRef, name: l.version.personName }, category: categoryBrief(ctx, l.version.categoryId) };
}
function employmentLines(ctx: OCtx, months: string[]) {
  const ids = [...new Set(ctx.oh.versions.map((v) => v.employmentId))].sort();
  const out: MonthLine[] = [];
  for (const id of ids) {
    const chain = chainOf(ctx.oh.versions, id);
    for (const month of months) {
      const l = monthLine(chain, ctx.oh.items, month);
      if (l) out.push(l);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
export async function listCategories(deps: SupplierDeps, caller: FinanceCaller, q: { active?: boolean }): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const rows = ctx.oh.categories
    .filter((c) => (q.active === undefined ? true : c.active === q.active))
    .map((c) => ({ ...categoryView(c), usage: { overheadVersions: ctx.oh.assignments.filter((a) => a.categoryId === c.categoryId).length, employmentVersions: ctx.oh.versions.filter((v) => v.categoryId === c.categoryId).length } }));
  const taken = new Set(ctx.oh.categories.map((c) => c.name.toLowerCase()));
  return {
    status: "ok",
    httpStatus: 200,
    body: { ...head(ctx), categories: rows, suggestions: SUGGESTED_CATEGORIES.filter((s) => !taken.has(s.toLowerCase())), note: "Suggestions only - nothing is created until Management adds it." },
  };
}

export async function readCategory(deps: SupplierDeps, caller: FinanceCaller, categoryId: string): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const c = ctx.oh.categories.find((x) => x.categoryId === categoryId);
  if (!c) return fail(404, "category_not_found", `No overhead category ${categoryId}`);
  let history: Record<string, any>[];
  try {
    history = await loadHistory(deps.grants, ctx.org.organisationId, `${ctx.org.organisationId}:${categoryId}`);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      category: categoryView(c),
      overheadVersions: ctx.oh.assignments.filter((a) => a.categoryId === categoryId).map((a) => assignmentView(a, ctx.oh.categories)),
      employmentVersions: ctx.oh.versions.filter((v) => v.categoryId === categoryId).map((v) => ({ employmentId: v.employmentId, versionId: v.versionId, person: v.personName, effectiveFromMonth: v.effectiveFromMonth })),
      history,
    },
  };
}

export async function listOverheads(deps: SupplierDeps, caller: FinanceCaller, q: { categoryId?: string; month?: string }): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const month = q.month ?? monthOf(ctx.today);
  const inMonth = (i: Instalment) => !i.cancelledAt && monthOf(i.dueDate) === month;
  const overhead = (a: Agreement) => {
    const asg = assignmentOf(ctx.oh.assignments, a.agreementId);
    const due = ctx.ledger.instalments.filter((i) => i.agreementId === a.agreementId && inMonth(i));
    return {
      agreement: agreementView(a, successorOf(ctx, a), ctx.today),
      supplier: supplierBrief(ctx, a.supplierId),
      category: asg ? assignmentView(asg, ctx.oh.categories) : null,
      ...contractorOf(ctx, a),
      month: { due: m(sum(due.map((i) => i.amountDueMinor))), estimated: due.some((i) => i.amountState === "estimated"), remaining: m(sum(due.map(remainingOf))), instalments: due.map((i) => ({ instalmentId: i.instalmentId, dueDate: i.dueDate, amountDue: m(i.amountDueMinor), state: stateOf(i), stateLabel: stateLabelOf(i) })) },
      _due: sum(due.map((i) => i.amountDueMinor)),
    };
  };
  const rows = generalAgreements(ctx).map(overhead);
  const people = employmentLines(ctx, [month]);
  const groups = ctx.oh.categories
    .filter((c) => (q.categoryId ? c.categoryId === q.categoryId : true))
    .map((c) => {
      const mine = rows.filter((r) => r.category?.categoryId === c.categoryId);
      const staff = people.filter((l) => l.version.categoryId === c.categoryId);
      const total = sum(mine.map((r) => r._due)) + sum(staff.map((l) => asInstalment(ctx.org.organisationId, l).amountDueMinor));
      return {
        category: categoryView(c),
        monthTotal: m(total),
        overheads: mine.map(({ _due, ...r }) => r),
        /** Employment costs grouped first, each employee behind the total. */
        employment: { total: m(sum(staff.map((l) => asInstalment(ctx.org.organisationId, l).amountDueMinor))), people: staff.map((l) => employmentLine(ctx, l)) },
      };
    });
  const uncategorised = q.categoryId ? [] : rows.filter((r) => !r.category).map(({ _due, ...r }) => r);
  return {
    status: "ok",
    httpStatus: 200,
    body: { ...head(ctx), month, categories: groups, uncategorised, rule: OVERHEAD_RULE, employmentRule: EMPLOYMENT_RULE, note: "Confirm a supplier overhead's estimate or record its payment on its F13 instalment (/supplier-instalments/{id}/confirm-estimate | payment)." },
  };
}

export async function readOverhead(deps: SupplierDeps, caller: FinanceCaller, agreementId: string): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const a = ctx.ledger.agreements.find((x) => x.agreementId === agreementId);
  if (!a) return fail(404, "agreement_not_found", `No supplier agreement ${agreementId}`);
  if (a.classification !== "general") return fail(404, "not_an_overhead", "That agreement is a direct cost (attributed to sessions) - it is not an overhead; see /supplier-agreements/{id}");
  let history: Record<string, any>[];
  try {
    history = await loadHistory(deps.grants, ctx.org.organisationId, `${ctx.org.organisationId}:${agreementId}`);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const chain: Agreement[] = [];
  for (let x: Agreement | undefined = a; x; x = x.supersedesAgreementId ? ctx.ledger.agreements.find((y) => y.agreementId === x!.supersedesAgreementId) : undefined) chain.unshift(x);
  for (let x = successorOf(ctx, a); x; x = successorOf(ctx, x)) chain.push(x);
  const asg = assignmentOf(ctx.oh.assignments, agreementId);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      overhead: { agreement: agreementView(a, successorOf(ctx, a), ctx.today), supplier: supplierBrief(ctx, a.supplierId), category: asg ? assignmentView(asg, ctx.oh.categories) : null, ...contractorOf(ctx, a) },
      schedule: ctx.ledger.instalments.filter((i) => i.agreementId === agreementId).map((i) => instalmentView(i, ctx.today, paymentsOf(ctx, i))),
      versions: chain.map((x) => {
        const xa = assignmentOf(ctx.oh.assignments, x.agreementId);
        return { agreementId: x.agreementId, effectiveFrom: x.effectiveFrom, status: agreementStatus(x, successorOf(ctx, x), ctx.today), classification: x.classification, amount: x.amountMinor === null ? null : m(x.amountMinor), category: xa ? { categoryId: xa.categoryId, name: assignmentView(xa, ctx.oh.categories).category, nameAtAssignment: xa.categoryNameAtAssignment } : null };
      }),
      history,
      rule: OVERHEAD_RULE,
    },
  };
}

function employmentSummary(ctx: OCtx, chain: EmploymentVersion[]) {
  const cur = latestOf(chain);
  const now_ = chain.filter((v) => v.effectiveFromMonth <= monthOf(ctx.today)).at(-1) ?? chain[0];
  const l = monthLine(chain, ctx.oh.items, monthOf(ctx.today));
  return {
    employmentId: cur.employmentId,
    person: { ref: cur.personRef, name: cur.personName },
    status: employmentStatus(chain, ctx.today),
    current: employmentVersionView(now_, ctx.oh.categories),
    latest: employmentVersionView(cur, ctx.oh.categories),
    versions: chain.length,
    thisMonth: l ? monthLineView(ctx.org.organisationId, l) : null,
  };
}

export async function listEmployment(deps: SupplierDeps, caller: FinanceCaller, q: { active?: boolean }): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const ids = [...new Set(ctx.oh.versions.map((v) => v.employmentId))];
  const rows = ids.map((id) => employmentSummary(ctx, chainOf(ctx.oh.versions, id))).filter((r) => (q.active === undefined ? true : (r.status !== "ended") === q.active));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), employmentCosts: rows.sort((a, b) => (a.person.name < b.person.name ? -1 : 1)), rule: EMPLOYMENT_RULE } };
}

export async function readEmployment(deps: SupplierDeps, caller: FinanceCaller, employmentId: string, q: { fromMonth?: string; toMonth?: string }): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const chain = chainOf(ctx.oh.versions, employmentId);
  if (!chain.length) return fail(404, "employment_not_found", `No employment cost ${employmentId}`);
  const range = monthRange(q.fromMonth || q.toMonth ? q : { fromMonth: addMonth(monthOf(ctx.today), -1), toMonth: addMonth(monthOf(ctx.today), 4) }, monthOf(ctx.today));
  if (!range.ok) return fail(400, range.code, range.error);
  let history: Record<string, any>[];
  try {
    history = await loadHistory(deps.grants, ctx.org.organisationId, `${ctx.org.organisationId}:${employmentId}`);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const months = monthsBetween(range.from, range.to)
    .map((mo) => monthLine(chain, ctx.oh.items, mo))
    .filter((l): l is MonthLine => !!l)
    .map((l) => monthLineView(ctx.org.organisationId, l));
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      employment: employmentSummary(ctx, chain),
      versions: chain.map((v) => employmentVersionView(v, ctx.oh.categories)),
      from: range.from,
      to: range.to,
      months,
      actedOn: ctx.oh.items.filter((i) => i.employmentId === employmentId).map((i) => monthLineView(ctx.org.organisationId, monthLine(chain, ctx.oh.items, i.month) as MonthLine)),
      history,
      directSessionCost: { amount: "0.00", source: "F12 Coach Costs", note: "A salaried allocation carries no direct session cost; this salary is never allocated to sessions or programmes." },
      notPayroll: "Not payroll software: no payslips, no employee tax deductions, no payroll execution.",
      rule: EMPLOYMENT_RULE,
    },
  };
}

export async function listOverheadFacts(deps: SupplierDeps, caller: FinanceCaller, q: { fromMonth?: string; toMonth?: string }): Promise<Ok | SFail> {
  const ctx = await readO(deps, caller);
  if (isFail(ctx)) return ctx;
  const range = monthRange(q, monthOf(ctx.today));
  if (!range.ok) return fail(400, range.code, range.error);
  const inRange = (d: string) => monthOf(d) >= range.from && monthOf(d) <= range.to;
  const org = ctx.org.organisationId;
  const general = new Map(generalAgreements(ctx).map((a) => [a.agreementId, a]));
  const supplierRows = ctx.ledger.instalments
    .filter((i) => !i.cancelledAt && general.has(i.agreementId) && inRange(i.dueDate))
    .map((i) => {
      const a = general.get(i.agreementId) as Agreement;
      const asg = assignmentOf(ctx.oh.assignments, a.agreementId);
      const s = supplierBrief(ctx, a.supplierId);
      const st = stateOf(i);
      return {
        sourceType: "supplier_agreement",
        organisationId: org,
        category: asg ? categoryBrief(ctx, asg.categoryId) : null,
        payee: s,
        person: null,
        period: monthOf(i.dueDate),
        expectedPaymentDate: i.dueDate,
        amount: m(i.amountDueMinor),
        ...vatFigures(s?.vatTreatment ?? null, i.amountDueMinor),
        state: st,
        stateLabel: stateLabelOf(i),
        estimated: i.amountState === "estimated",
        cashPaid: m(i.paidMinor),
        creditApplied: m(i.creditedMinor),
        remaining: m(remainingOf(i)),
        paidDate: st === "paid" && i.paidMinor > 0 ? lastPaidDate(ctx, i) : null,
        ...contractorOf(ctx, a),
        source: { agreementId: a.agreementId, instalmentId: i.instalmentId },
      };
    });
  const creditRows = ctx.ledger.credits
    .filter((c) => !c.voidedAt && c.agreementId && general.has(c.agreementId) && inRange(c.creditDate))
    .map((c) => {
      const asg = assignmentOf(ctx.oh.assignments, c.agreementId as string);
      const s = supplierBrief(ctx, c.supplierId);
      return { sourceType: "supplier_credit", organisationId: org, category: asg ? categoryBrief(ctx, asg.categoryId) : null, payee: s, person: null, period: monthOf(c.creditDate), date: c.creditDate, amount: m(-c.amountMinor), ...vatFigures(s?.vatTreatment ?? null, -c.amountMinor), state: "cost_adjustment", source: { agreementId: c.agreementId, creditId: c.creditId } };
    });
  const people = employmentLines(ctx, monthsBetween(range.from, range.to)).map((l) => {
    const i = asInstalment(org, l);
    const st = stateOf(i);
    return {
      sourceType: "employment",
      organisationId: org,
      category: categoryBrief(ctx, l.version.categoryId),
      payee: null,
      person: { employmentId: l.employmentId, ref: l.version.personRef, name: l.version.personName },
      period: l.month,
      expectedPaymentDate: l.expectedPaymentDate,
      amount: m(i.amountDueMinor),
      ...vatFigures("not_applicable", i.amountDueMinor),
      state: st,
      stateLabel: stateLabelOf(i),
      estimated: st === "estimated",
      components: { salary: m(l.salaryMinor), employerPensionEstimate: m(l.pensionEstimateMinor), employerNiPayeEstimate: m(l.niPayeEstimateMinor), estimateTotal: m(l.estimateTotalMinor), estimatesAre: ESTIMATE_LABEL },
      partMonth: l.partMonth,
      remaining: m(remainingOf(i)),
      paidDate: l.item?.paidDate ?? null,
      source: { employmentId: l.employmentId, versionId: l.version.versionId, itemId: l.item?.itemId ?? null },
    };
  });
  const facts = [...supplierRows, ...creditRows, ...people];
  const minor = (s: string | null) => (s === null ? 0 : Math.round(Number(s) * 100));
  const keys = [...new Set(facts.map((f) => f.category?.categoryId ?? "uncategorised"))].sort();
  const byCategory = keys.map((k) => {
    const rows = facts.filter((f) => (f.category?.categoryId ?? "uncategorised") === k);
    return {
      categoryId: k === "uncategorised" ? null : k,
      category: rows[0].category?.name ?? null,
      amount: m(sum(rows.map((r) => minor(r.amount)))),
      estimated: m(sum(rows.filter((r) => r.state === "estimated").map((r) => minor(r.amount)))),
      rows: rows.length,
    };
  });
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      from: range.from,
      to: range.to,
      facts,
      byCategory,
      rule: "Overhead facts: F13 general supplier agreements (by instalment due date, with F14 credits as separate cost adjustments) and F15 employment months (by pay month). VAT is shown only where known; employment costs carry no VAT. Nothing here is a Cash Flow event or a Month Report.",
    },
  };
}

// ---------------------------------------------------------------------
// Writes - categories
// ---------------------------------------------------------------------
export function createCategory(deps: SupplierDeps, caller: FinanceCaller, input: { name?: string; reason: string | null }): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const name = input.name as string;
    if (ctx.oh.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) return fail(409, "category_exists", `A category called "${name}" already exists`);
    const at = now(deps).toISOString();
    const c: OverheadCategory = { organisationId: ctx.org.organisationId, categoryId: newId("FOC", deps.suppliers?.random), name, active: true, revision: 1, createdAt: at, createdBy: caller.userId, updatedAt: at, updatedBy: caller.userId };
    const r = await guarded(() =>
      writeCategory(deps.grants, c, null, [
        overheadAudit({ organisationId: c.organisationId, actorUserId: caller.userId, eventType: OVERHEAD_EVENTS.categoryCreated, entityType: OVERHEAD_ENTITY.category, recordId: `${c.organisationId}:${c.categoryId}`, before: null, after: categoryView(c), reason: input.reason, route: "POST /overhead-categories" }),
      ]),
    );
    if (r) return r;
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), category: categoryView(c) } };
  });
}

export function updateCategory(deps: SupplierDeps, caller: FinanceCaller, categoryId: string, input: { name?: string; active?: boolean; reason: string | null }): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const before = ctx.oh.categories.find((x) => x.categoryId === categoryId);
    if (!before) return fail(404, "category_not_found", `No overhead category ${categoryId}`);
    const plan = applyCategoryPatch(before, ctx.oh.categories, { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.active !== undefined ? { active: input.active } : {}) });
    if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    const c: OverheadCategory = { ...plan.category, revision: before.revision + 1, updatedAt: now(deps).toISOString(), updatedBy: caller.userId };
    const r = await guarded(() =>
      writeCategory(deps.grants, c, before.revision, [
        overheadAudit({ organisationId: c.organisationId, actorUserId: caller.userId, eventType: OVERHEAD_EVENTS.categoryUpdated, entityType: OVERHEAD_ENTITY.category, recordId: `${c.organisationId}:${c.categoryId}`, before: categoryView(before), after: { ...categoryView(c), changed: plan.changed }, reason: input.reason, route: "POST /overhead-categories/{id}" }),
      ]),
    );
    if (r) return r;
    return { status: "ok", httpStatus: 200, body: { ...head(ctx), category: categoryView(c), changed: plan.changed, note: plan.changed.includes("active") && !c.active ? "Deactivated - existing categorisations keep it; it cannot be chosen for anything new." : undefined } };
  });
}

// ---------------------------------------------------------------------
// Writes - overheads (F13 general agreements + a category)
// ---------------------------------------------------------------------
const newAssignment = (deps: SupplierDeps, caller: FinanceCaller, org: string, agreementId: string, c: OverheadCategory, reason: string | null): OverheadAssignment => ({
  organisationId: org,
  assignmentId: newId("FOA", deps.suppliers?.random),
  agreementId,
  categoryId: c.categoryId,
  categoryNameAtAssignment: c.name,
  reason,
  assignedAt: now(deps).toISOString(),
  assignedBy: caller.userId,
});

export function categoriseOverhead(deps: SupplierDeps, caller: FinanceCaller, input: { agreementId: string; categoryId: string; reason: string | null }): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const a = ctx.ledger.agreements.find((x) => x.agreementId === input.agreementId);
    const c = ctx.oh.categories.find((x) => x.categoryId === input.categoryId);
    const plan = planAssign(a, ctx.oh.assignments, c);
    if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    const org = ctx.org.organisationId;
    const asg = newAssignment(deps, caller, org, input.agreementId, c as OverheadCategory, input.reason);
    const r = await guarded(() =>
      recordAssignment(deps.grants, asg, [
        overheadAudit({ organisationId: org, actorUserId: caller.userId, eventType: OVERHEAD_EVENTS.categorised, entityType: OVERHEAD_ENTITY.assignment, recordId: `${org}:${input.agreementId}`, before: null, after: assignmentView(asg, ctx.oh.categories), reason: input.reason, route: "POST /overheads" }),
      ]),
    );
    if (r) return r;
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), overhead: { agreement: agreementView(a as Agreement, successorOf(ctx, a as Agreement), ctx.today), supplier: supplierBrief(ctx, (a as Agreement).supplierId), category: assignmentView(asg, ctx.oh.categories), ...contractorOf(ctx, a as Agreement) }, note: "Categorised. F13 still owns the amount, schedule, estimates and payments." } };
  });
}

export function versionOverhead(deps: SupplierDeps, caller: FinanceCaller, agreementId: string, input: { categoryId: string | null; spec: AgreementSpec }): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const prev = ctx.ledger.agreements.find((x) => x.agreementId === agreementId);
    if (!prev) return fail(404, "agreement_not_found", `No supplier agreement ${agreementId}`);
    if (prev.classification !== "general") return fail(409, "not_an_overhead", OVERHEAD_REFUSALS.not_an_overhead);
    const prevAsg = assignmentOf(ctx.oh.assignments, agreementId);
    const categoryId = input.categoryId ?? prevAsg?.categoryId ?? null;
    if (!categoryId) return fail(409, "category_required", OVERHEAD_REFUSALS.category_required);
    const c = ctx.oh.categories.find((x) => x.categoryId === categoryId);
    if (!c) return fail(404, "category_not_found", OVERHEAD_REFUSALS.category_not_found);
    if (!c.active) return fail(409, "category_inactive", OVERHEAD_REFUSALS.category_inactive);
    const org = ctx.org.organisationId;
    const supplier = ctx.ledger.suppliers.find((s) => s.supplierId === prev.supplierId);
    if (!supplier) return fail(404, "supplier_not_found", "No supplier for that agreement");
    let asg: OverheadAssignment | null = null;
    let refusal: SFail | null = null;
    const res = await recordNewAgreement(deps, caller, ctx, supplier, input.spec, prev, async (a, allocations, instalments, cancel, events) => {
      asg = newAssignment(deps, caller, org, a.agreementId, c, input.spec.reason);
      const ev = overheadAudit({
        organisationId: org,
        actorUserId: caller.userId,
        eventType: OVERHEAD_EVENTS.versioned,
        entityType: OVERHEAD_ENTITY.assignment,
        recordId: `${org}:${a.agreementId}`,
        before: { agreementId, category: prevAsg ? assignmentView(prevAsg, ctx.oh.categories) : null },
        after: { agreementId: a.agreementId, effectiveFrom: a.effectiveFrom, category: assignmentView(asg, ctx.oh.categories), recategorised: prevAsg ? prevAsg.categoryId !== c.categoryId : true },
        reason: input.spec.reason,
        route: "POST /overheads/{id}/version",
      });
      refusal = await guarded(() => recordOverheadVersion(deps.grants, a, allocations, instalments, cancel, asg as OverheadAssignment, [...events, ev]));
    });
    if (refusal) return refusal;
    if (isFail(res)) return res;
    return { ...res, body: { ...res.body, contract: OVERHEAD_CONTRACT, category: assignmentView(asg as unknown as OverheadAssignment, ctx.oh.categories), previousCategory: prevAsg ? assignmentView(prevAsg, ctx.oh.categories) : null, rule: OVERHEAD_RULE } };
  });
}

// ---------------------------------------------------------------------
// Writes - salaried employment costs
// ---------------------------------------------------------------------
const empAudit = (org: string, caller: FinanceCaller, eventType: string, entityType: string, recordId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null, route: string) =>
  overheadAudit({ organisationId: org, actorUserId: caller.userId, eventType, entityType, recordId: `${org}:${recordId}`, before, after, reason, route });

export function createEmployment(deps: SupplierDeps, caller: FinanceCaller, spec: EmploymentSpec): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const c = ctx.oh.categories.find((x) => x.categoryId === spec.categoryId);
    if (!c) return fail(404, "category_not_found", OVERHEAD_REFUSALS.category_not_found);
    if (!c.active) return fail(409, "category_inactive", OVERHEAD_REFUSALS.category_inactive);
    let name = spec.name;
    if (spec.personRef) {
      let people;
      try {
        people = await findPeople(deps.airtable, spec.personRef);
      } catch (e) {
        console.error(e);
        return unavailable();
      }
      if (people.length === 0) return fail(404, "person_not_found", `No coach / person with Coach ID ${spec.personRef}`);
      if (people.length > 1) return fail(409, "person_ambiguous", `More than one Coaches record has Coach ID ${spec.personRef} - fix the duplicate first`);
      name = name ?? people[0].name;
      if (!name) return fail(400, "invalid_input", "That person has no name on record - give name");
      if (ctx.oh.versions.some((v) => v.personRef === spec.personRef)) return fail(409, "employment_exists", OVERHEAD_REFUSALS.employment_exists);
    } else if (ctx.oh.versions.some((v) => v.personRef === null && v.personName.toLowerCase() === (name as string).toLowerCase())) return fail(409, "employment_exists", OVERHEAD_REFUSALS.employment_exists);
    const org = ctx.org.organisationId;
    const v: EmploymentVersion = {
      organisationId: org,
      versionId: newId("FEV", deps.suppliers?.random),
      employmentId: newId("FEM", deps.suppliers?.random),
      supersedesVersionId: null,
      personRef: spec.personRef,
      personName: name as string,
      categoryId: spec.categoryId,
      annualSalaryMinor: spec.annualSalaryMinor,
      payDay: spec.payDay,
      startDate: spec.startDate,
      endDate: spec.endDate,
      effectiveFromMonth: monthOf(spec.startDate),
      pensionEstimateMinor: spec.pensionEstimateMinor,
      niPayeEstimateMinor: spec.niPayeEstimateMinor,
      notes: spec.notes,
      reason: spec.reason,
      createdAt: now(deps).toISOString(),
      createdBy: caller.userId,
    };
    const view = employmentVersionView(v, ctx.oh.categories);
    const r = await guarded(() => recordEmploymentVersion(deps.grants, v, [empAudit(org, caller, OVERHEAD_EVENTS.employmentCreated, OVERHEAD_ENTITY.employment, v.employmentId, null, view, spec.reason, "POST /employment-costs")]));
    if (r) return r;
    const chain = [v];
    const months = monthsBetween(monthOf(ctx.today), addMonth(monthOf(ctx.today), 2)).map((mo) => monthLine(chain, [], mo)).filter((l): l is MonthLine => !!l);
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), employment: view, nextMonths: months.map((l) => monthLineView(org, l)), rule: EMPLOYMENT_RULE } };
  });
}

export function versionEmployment(deps: SupplierDeps, caller: FinanceCaller, employmentId: string, input: { effectiveFromMonth: string; patch: EmploymentPatch; reason: string }): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const chain = chainOf(ctx.oh.versions, employmentId);
    if (!chain.length) return fail(404, "employment_not_found", `No employment cost ${employmentId}`);
    const prev = latestOf(chain);
    if (input.patch.categoryId !== undefined && input.patch.categoryId !== prev.categoryId) {
      const c = ctx.oh.categories.find((x) => x.categoryId === input.patch.categoryId);
      if (!c) return fail(404, "category_not_found", OVERHEAD_REFUSALS.category_not_found);
      if (!c.active) return fail(409, "category_inactive", OVERHEAD_REFUSALS.category_inactive);
    }
    const plan = planEmploymentVersion(chain, ctx.oh.items, input, { versionId: newId("FEV", deps.suppliers?.random), actor: caller.userId, at: now(deps).toISOString() });
    if (!plan.ok) return fail(plan.httpStatus, plan.code, plan.error);
    const org = ctx.org.organisationId;
    const r = await guarded(() =>
      recordEmploymentVersion(deps.grants, plan.version, [
        empAudit(org, caller, OVERHEAD_EVENTS.employmentVersioned, OVERHEAD_ENTITY.employment, employmentId, employmentVersionView(prev, ctx.oh.categories), { ...employmentVersionView(plan.version, ctx.oh.categories), changed: plan.changed }, input.reason, "POST /employment-costs/{id}/version"),
      ]),
    );
    if (r) return r;
    const next = [...chain, plan.version];
    const before = monthLine(chain, ctx.oh.items, addMonth(input.effectiveFromMonth, -1));
    return {
      status: "ok",
      httpStatus: 201,
      body: {
        ...head(ctx),
        version: employmentVersionView(plan.version, ctx.oh.categories),
        changed: plan.changed,
        monthBefore: before ? monthLineView(org, before) : null,
        firstMonth: (() => {
          const l = monthLine(next, ctx.oh.items, input.effectiveFromMonth);
          return l ? monthLineView(org, l) : null;
        })(),
        note: `Applies from ${input.effectiveFromMonth}. Earlier months keep the earlier terms - nothing before it was rewritten.`,
      },
    };
  });
}

export function employmentItemAction(deps: SupplierDeps, caller: FinanceCaller, employmentId: string, month: string, action: ItemAction, input: ActionInput): Promise<Ok | SFail> {
  return writeO(deps, caller, async (ctx) => {
    const chain = chainOf(ctx.oh.versions, employmentId);
    if (!chain.length) return fail(404, "employment_not_found", `No employment cost ${employmentId}`);
    const org = ctx.org.organisationId;
    const l = monthLine(chain, ctx.oh.items, month);
    const at = now(deps).toISOString();
    const route = `POST /employment-costs/{id}/months/{month}/${action}`;
    const recordId = `${employmentId}:${month}`;
    if (input.action === "confirm-estimate") {
      const plan = planItemConfirm(org, l, input, { itemId: newId("FEI", deps.suppliers?.random), actor: caller.userId, at, today: ctx.today });
      if (!plan.ok) return fail(plan.httpStatus, plan.code, OVERHEAD_REFUSALS[plan.code] ?? plan.error);
      const line = l as MonthLine;
      const r = await guarded(() =>
        changeItem(deps.grants, "confirm", plan.item, null, [
          empAudit(org, caller, OVERHEAD_EVENTS.itemConfirmed, OVERHEAD_ENTITY.item, recordId, { month, state: "estimated", estimateTotal: m(line.estimateTotalMinor) }, { ...auditItem(plan.item), estimate: m(line.estimateTotalMinor), confirmed: m(plan.item.amountDueMinor), usedEstimate: input.useEstimate, paidStateUnchanged: true }, input.reason, route),
        ]),
      );
      if (r) return r;
      const after = monthLine(chain, [...ctx.oh.items, plan.item], month) as MonthLine;
      return { status: "ok", httpStatus: 200, body: { ...head(ctx), month: monthLineView(org, after), note: "The amount due is now confirmed. Nothing has been paid - Paid is a separate action." } };
    }
    if (input.action !== "payment") return fail(404, "not_found", "Unknown action");
    const plan = planItemPayment(org, l, input, { actor: caller.userId, at, today: ctx.today });
    if (!plan.ok) return fail(plan.httpStatus, plan.code, OVERHEAD_REFUSALS[plan.code] ?? plan.error);
    const before = (l as MonthLine).item as EmploymentItem;
    const r = await guarded(() =>
      changeItem(deps.grants, "payment", plan.item, { paidMinor: before.paidMinor }, [
        empAudit(org, caller, OVERHEAD_EVENTS.itemPaid, OVERHEAD_ENTITY.item, recordId, auditItem(before), { ...auditItem(plan.item), payment: { amount: m(plan.item.paidMinor), paidDate: plan.item.paidDate, method: plan.item.paymentMethod, reference: plan.item.paymentReference, source: "management_confirmed" } }, null, route),
      ]),
    );
    if (r) return r;
    const after = monthLine(chain, ctx.oh.items.map((i) => (i.itemId === plan.item.itemId ? plan.item : i)), month) as MonthLine;
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), month: monthLineView(org, after), note: "Recorded as paid in full (Management-confirmed - not a bank reconciliation)." } };
  });
}
