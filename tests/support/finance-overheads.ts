/**
 * Test-suite copy of the canonical finance/finance-overheads.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Overheads / salaries & employment costs - pure logic (Finance Foundation
 * F15; see TEST-ENV.md "Finance Foundation - F15").
 *
 * Ownership (locked):
 *   - An OVERHEAD is an F13 general supplier agreement version plus an F15
 *     overhead category. F13 stays the only source of its amount, schedule,
 *     estimate confirmation, payment, effective-date versioning and payee.
 *     F15 never builds a second overhead or contractor ledger: non-Coach
 *     contractors stay F13 suppliers and are only categorised / read here.
 *   - SALARIED EMPLOYEES are F15's own effective-dated employment-cost ledger.
 *     Each month is one item: salary + Management-entered employer pension
 *     estimate + Management-entered employer NI / PAYE estimate. It moves
 *     Estimated -> Confirmed (actual or Use Estimate) -> Paid using F13's own
 *     lifecycle functions (planChange / stateOf / remainingOf). Full payment
 *     only. This is NOT payroll software: no payslips, no employee deductions,
 *     no NI / PAYE calculation, no payroll execution.
 *   - Salary is never allocated to sessions or programmes. A salaried coach's
 *     direct session cost stays 0.00 in F12 (Cost Basis "Salaried").
 *
 * Categories are Management-configurable (create / rename / deactivate). The
 * baseline list is a SUGGESTION only - nothing is seeded. A category
 * assignment is fixed for its agreement / employment version; recategorising
 * from a later date is a new version, so history is never rewritten.
 *
 * Money is integer pence. Nothing here creates a Cash Flow event or a Month
 * Report; it only exposes the facts those later slices will read.
 */
import { auditEvent } from "./finance-commercial.ts";
import { divRoundHalfAwayFromZero } from "./finance-money.ts";
import {
  type ActionInput,
  type Agreement,
  type Instalment,
  AGREEMENT_FIELDS,
  AGREEMENT_ID_RE,
  type AgreementSpec,
  type Invalid,
  isRealDate,
  jsonObject,
  m,
  monthBounds,
  money,
  parseAction,
  parseAgreement,
  planChange,
  remainingOf,
  stateLabelOf,
  stateOf,
  text,
} from "./finance-suppliers.ts";

export const OVERHEAD_CONTRACT = "finance-overheads-v1";

export const CATEGORY_ID_RE = /^FOC-[0-9A-F]{12}$/;
export const ASSIGNMENT_ID_RE = /^FOA-[0-9A-F]{12}$/;
export const EMPLOYMENT_ID_RE = /^FEM-[0-9A-F]{12}$/;
export const EMPLOYMENT_VERSION_ID_RE = /^FEV-[0-9A-F]{12}$/;
export const EMPLOYMENT_ITEM_ID_RE = /^FEI-[0-9A-F]{12}$/;
/** The person's Hub id (Coaches.Coach ID) - the same reference F12 uses. */
export const PERSON_REF_RE = /^COACH-[A-Za-z0-9-]{1,48}$/;
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";
export const CATEGORY_NAME_MAX = 100;
export const MAX_RANGE_MONTHS = 12;

/** Shown to Management as suggestions only. Never seeded, never required, never hard-coded into reporting. */
export const SUGGESTED_CATEGORIES = [
  "Salaries & Employment Costs",
  "Admin / Contractors",
  "Consultancy",
  "Software",
  "Vehicles",
  "Insurance",
  "Marketing",
  "Donations",
  "Accounting / Legal",
  "Other",
] as const;

export const OVERHEAD_EVENTS = {
  categoryCreated: "finance_overhead_category.created",
  categoryUpdated: "finance_overhead_category.updated",
  categorised: "finance_overhead.categorised",
  versioned: "finance_overhead.versioned",
  employmentCreated: "finance_employment_cost.created",
  employmentVersioned: "finance_employment_cost.versioned",
  itemConfirmed: "finance_employment_item.estimate_confirmed",
  itemPaid: "finance_employment_item.paid",
} as const;
export const OVERHEAD_ENTITY = {
  category: "finance_overhead_category",
  assignment: "finance_overhead_assignment",
  employment: "finance_employment_cost",
  item: "finance_employment_item",
} as const;

export const ESTIMATE_LABEL = "Management-entered estimate (not calculated - the Hub is not payroll software)";
export const OVERHEAD_RULE =
  "An overhead is an F13 general supplier agreement plus an F15 category: F13 owns its amount, schedule, estimate confirmation, payment and versions. Recategorising from a later date is a new agreement version - history is never rewritten.";
export const EMPLOYMENT_RULE =
  "Salaried employment cost is a business overhead: it is never allocated to sessions or programmes, and a salaried coach's direct session cost stays 0.00 (F12). Employer pension and NI / PAYE are Management-entered monthly estimates. Not payroll software: no payslips, deductions or payroll runs.";

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------
export interface OverheadCategory {
  organisationId: string;
  categoryId: string;
  name: string;
  active: boolean;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
/** One F13 agreement version -> one category. Fixed once made. */
export interface OverheadAssignment {
  organisationId: string;
  assignmentId: string;
  agreementId: string;
  categoryId: string;
  /** The category's name when it was assigned - a later rename stays traceable. */
  categoryNameAtAssignment: string;
  reason: string | null;
  assignedAt: string;
  assignedBy: string;
}
export interface EmploymentVersion {
  organisationId: string;
  versionId: string;
  employmentId: string;
  supersedesVersionId: string | null;
  personRef: string | null;
  personName: string;
  categoryId: string;
  annualSalaryMinor: number;
  payDay: number;
  startDate: string;
  endDate: string | null;
  /** First month (YYYY-MM) this version applies to. Earlier months keep the earlier version. */
  effectiveFromMonth: string;
  pensionEstimateMinor: number | null;
  niPayeEstimateMinor: number | null;
  notes: string | null;
  reason: string | null;
  createdAt: string;
  createdBy: string;
}
/** A month that Management has acted on (confirmed, then maybe paid). Months not acted on are computed, never stored. */
export interface EmploymentItem {
  organisationId: string;
  itemId: string;
  employmentId: string;
  month: string;
  versionId: string;
  salaryMinor: number;
  pensionEstimateMinor: number;
  niPayeEstimateMinor: number;
  estimateTotalMinor: number;
  amountDueMinor: number;
  usedEstimate: boolean;
  expectedPaymentDate: string;
  confirmedAt: string;
  confirmedBy: string;
  confirmReason: string | null;
  paidMinor: number;
  paidDate: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  paymentNote: string | null;
  paidAt: string | null;
  paidBy: string | null;
}

export type Refusal = { ok: false; httpStatus: 400 | 404 | 409; code: string; error: string };
const refuse = (httpStatus: 400 | 404 | 409, code: string, error: string): Refusal => ({ ok: false, httpStatus, code, error });

export function newId(prefix: "FOC" | "FOA" | "FEM" | "FEV" | "FEI", random: () => string = () => crypto.randomUUID()): string {
  return `${prefix}-${random().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

// ---------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------
export const monthOf = (date: string) => date.slice(0, 7);
const monthIdx = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
export function addMonth(month: string, n: number): string {
  const i = monthIdx(month) + n;
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = monthIdx(from); k <= monthIdx(to); k++) out.push(addMonth(from, k - monthIdx(from)));
  return out;
}
/** The normal pay date for a month: the pay day, or the month's last day when the month is shorter. */
export function payDateOf(month: string, payDay: number): string {
  const last = Number(monthBounds(month).to.slice(8, 10));
  return `${month}-${String(Math.min(payDay, last)).padStart(2, "0")}`;
}
/** Annual salary / 12, half away from zero, in pence. */
export const monthlySalaryOf = (annualMinor: number) => Number(divRoundHalfAwayFromZero(BigInt(annualMinor), 12n));

// ---------------------------------------------------------------------
// Employment chain
// ---------------------------------------------------------------------
/** Versions of one employment, oldest first (each starts later than the one it replaces). */
export function chainOf(versions: EmploymentVersion[], employmentId: string): EmploymentVersion[] {
  return versions.filter((v) => v.employmentId === employmentId).sort((a, b) => (a.effectiveFromMonth < b.effectiveFromMonth ? -1 : a.effectiveFromMonth > b.effectiveFromMonth ? 1 : 0));
}
export const latestOf = (chain: EmploymentVersion[]) => chain.find((v) => !chain.some((x) => x.supersedesVersionId === v.versionId)) ?? chain[chain.length - 1];
/** The version that governs a month: the latest one starting on or before it. */
export function versionFor(chain: EmploymentVersion[], month: string): EmploymentVersion | null {
  let hit: EmploymentVersion | null = null;
  for (const v of chain) if (v.effectiveFromMonth <= month) hit = v;
  return hit;
}
export function employedIn(v: EmploymentVersion, month: string): boolean {
  const b = monthBounds(month);
  return v.startDate <= b.to && (v.endDate === null || v.endDate >= b.from);
}
/** True when employment starts or ends part-way through the month (the estimate is still a full month - confirm the actual). */
export function partMonthOf(v: EmploymentVersion, month: string): boolean {
  const b = monthBounds(month);
  return v.startDate > b.from || (v.endDate !== null && v.endDate < b.to);
}
export function employmentStatus(chain: EmploymentVersion[], today: string): "upcoming" | "active" | "ended" {
  const v = versionFor(chain, monthOf(today)) ?? chain[0];
  if (v.startDate > today) return "upcoming";
  return v.endDate !== null && v.endDate < today ? "ended" : "active";
}

/** One month of one employment: the computed estimate, or the item Management has acted on. */
export interface MonthLine {
  employmentId: string;
  month: string;
  version: EmploymentVersion;
  item: EmploymentItem | null;
  salaryMinor: number;
  pensionEstimateMinor: number;
  niPayeEstimateMinor: number;
  estimateTotalMinor: number;
  expectedPaymentDate: string;
  partMonth: boolean;
}
export function monthLine(chain: EmploymentVersion[], items: EmploymentItem[], month: string): MonthLine | null {
  const employmentId = chain[0]?.employmentId;
  const item = items.find((i) => i.employmentId === employmentId && i.month === month) ?? null;
  if (item) {
    const v = chain.find((x) => x.versionId === item.versionId) as EmploymentVersion;
    return { employmentId, month, version: v, item, salaryMinor: item.salaryMinor, pensionEstimateMinor: item.pensionEstimateMinor, niPayeEstimateMinor: item.niPayeEstimateMinor, estimateTotalMinor: item.estimateTotalMinor, expectedPaymentDate: item.expectedPaymentDate, partMonth: partMonthOf(v, month) };
  }
  const v = versionFor(chain, month);
  if (!v || !employedIn(v, month)) return null;
  const salary = monthlySalaryOf(v.annualSalaryMinor);
  const pension = v.pensionEstimateMinor ?? 0;
  const ni = v.niPayeEstimateMinor ?? 0;
  return { employmentId, month, version: v, item: null, salaryMinor: salary, pensionEstimateMinor: pension, niPayeEstimateMinor: ni, estimateTotalMinor: salary + pension + ni, expectedPaymentDate: payDateOf(month, v.payDay), partMonth: partMonthOf(v, month) };
}

/**
 * F13's instalment shape for a month line, so the SAME lifecycle functions
 * (planChange / stateOf / remainingOf / stateLabelOf) decide Estimated ->
 * Confirmed -> Paid. No credit, split, move or cancel exists for a salary item.
 */
export function asInstalment(organisationId: string, l: MonthLine): Instalment {
  return {
    organisationId,
    instalmentId: l.item?.itemId ?? "unconfirmed",
    agreementId: l.version.versionId,
    supplierId: l.employmentId,
    sequence: 1,
    originalDueDate: l.expectedPaymentDate,
    dueDate: l.expectedPaymentDate,
    plannedMinor: l.estimateTotalMinor,
    amountDueMinor: l.item ? l.item.amountDueMinor : l.estimateTotalMinor,
    amountState: l.item ? "confirmed" : "estimated",
    paidMinor: l.item ? l.item.paidMinor : 0,
    creditedMinor: 0,
    splitFromInstalmentId: null,
    note: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    createdAt: l.item?.confirmedAt ?? "",
    createdBy: l.item?.confirmedBy ?? "",
  };
}
export function monthLineView(organisationId: string, l: MonthLine) {
  const i = asInstalment(organisationId, l);
  const state = stateOf(i);
  return {
    month: l.month,
    itemId: l.item?.itemId ?? null,
    versionId: l.version.versionId,
    expectedPaymentDate: l.expectedPaymentDate,
    partMonth: l.partMonth,
    salary: m(l.salaryMinor),
    employerPensionEstimate: m(l.pensionEstimateMinor),
    employerNiPayeEstimate: m(l.niPayeEstimateMinor),
    estimateTotal: m(l.estimateTotalMinor),
    estimatesAre: ESTIMATE_LABEL,
    state,
    stateLabel: stateLabelOf(i),
    amountDue: m(i.amountDueMinor),
    amountIsEstimate: state === "estimated",
    usedEstimate: l.item?.usedEstimate ?? null,
    paid: m(i.paidMinor),
    remaining: m(remainingOf(i)),
    paidDate: l.item?.paidDate ?? null,
    confirmed: l.item ? { at: l.item.confirmedAt, by: l.item.confirmedBy, reason: l.item.confirmReason } : null,
    payment: l.item?.paidAt ? { paidDate: l.item.paidDate, amount: m(l.item.paidMinor), method: l.item.paymentMethod, reference: l.item.paymentReference, note: l.item.paymentNote, recordedAt: l.item.paidAt, recordedBy: l.item.paidBy, source: "management_confirmed" } : null,
  };
}

// ---------------------------------------------------------------------
// Planning employment changes (the database re-checks the same rules)
// ---------------------------------------------------------------------
export interface EmploymentSpec {
  personRef: string | null;
  name: string | null;
  categoryId: string;
  annualSalaryMinor: number;
  payDay: number;
  startDate: string;
  endDate: string | null;
  pensionEstimateMinor: number | null;
  niPayeEstimateMinor: number | null;
  notes: string | null;
  reason: string | null;
}
export type EmploymentPatch = Partial<Pick<EmploymentVersion, "personName" | "categoryId" | "annualSalaryMinor" | "payDay" | "endDate" | "pensionEstimateMinor" | "niPayeEstimateMinor" | "notes">>;
const VERSION_KEYS: (keyof EmploymentPatch)[] = ["personName", "categoryId", "annualSalaryMinor", "payDay", "endDate", "pensionEstimateMinor", "niPayeEstimateMinor", "notes"];

/** A new version from a chosen month. Months before it keep the earlier version; a confirmed / paid month is never rewritten. */
export function planEmploymentVersion(
  chain: EmploymentVersion[],
  items: EmploymentItem[],
  input: { effectiveFromMonth: string; patch: EmploymentPatch; reason: string },
  ctx: { versionId: string; actor: string; at: string },
): { ok: true; version: EmploymentVersion; changed: string[] } | Refusal {
  const prev = latestOf(chain);
  if (input.effectiveFromMonth <= prev.effectiveFromMonth) return refuse(409, "version_must_start_later", `A new version must start after ${prev.effectiveFromMonth}, the month the current version starts`);
  if (input.effectiveFromMonth < monthOf(prev.startDate)) return refuse(409, "version_before_start", "A version cannot start before the employment starts");
  const touched = items.filter((i) => i.employmentId === prev.employmentId && i.month >= input.effectiveFromMonth).map((i) => i.month);
  if (touched.length) return refuse(409, "confirmed_month_after_change", `Month(s) ${touched.join(", ")} are already confirmed or paid - that history is never rewritten (start the new version after them)`);
  const next: EmploymentVersion = { ...prev, ...input.patch, versionId: ctx.versionId, supersedesVersionId: prev.versionId, effectiveFromMonth: input.effectiveFromMonth, reason: input.reason, createdAt: ctx.at, createdBy: ctx.actor };
  if (next.endDate !== null && next.endDate < next.startDate) return refuse(400, "invalid_input", "endDate must be on or after the start date");
  if (next.endDate !== null && next.endDate < `${input.effectiveFromMonth}-01`) return refuse(409, "end_before_version_start", "To end the employment, start the new version in (or before) the month it ends");
  const changed = VERSION_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
  if (!changed.length) return refuse(409, "nothing_to_change", "Nothing would change");
  return { ok: true, version: next, changed };
}

/** Confirm a month's amount (actual, or Use Estimate). It is NOT paid - Paid is a separate action. */
export function planItemConfirm(organisationId: string, l: MonthLine | null, input: Extract<ActionInput, { action: "confirm-estimate" }>, ctx: { itemId: string; actor: string; at: string; today: string }): { ok: true; item: EmploymentItem } | Refusal {
  if (!l) return refuse(409, "month_not_employed", "There is no employment cost in that month (before the start or after the end date)");
  if (l.item) return refuse(409, "already_confirmed", "This month's amount is already confirmed");
  const plan = planChange(asInstalment(organisationId, l), input, { today: ctx.today, actor: ctx.actor, at: ctx.at, newId: () => "unused" });
  if (!plan.ok) return plan;
  return {
    ok: true,
    item: {
      organisationId,
      itemId: ctx.itemId,
      employmentId: l.employmentId,
      month: l.month,
      versionId: l.version.versionId,
      salaryMinor: l.salaryMinor,
      pensionEstimateMinor: l.pensionEstimateMinor,
      niPayeEstimateMinor: l.niPayeEstimateMinor,
      estimateTotalMinor: l.estimateTotalMinor,
      amountDueMinor: plan.next.amountDueMinor,
      usedEstimate: input.useEstimate,
      expectedPaymentDate: l.expectedPaymentDate,
      confirmedAt: ctx.at,
      confirmedBy: ctx.actor,
      confirmReason: input.reason,
      paidMinor: 0,
      paidDate: null,
      paymentMethod: null,
      paymentReference: null,
      paymentNote: null,
      paidAt: null,
      paidBy: null,
    },
  };
}

/** Record that the month was paid - in full only (v1). Management-confirmed; never a bank reconciliation. */
export function planItemPayment(organisationId: string, l: MonthLine | null, input: Extract<ActionInput, { action: "payment" }>, ctx: { actor: string; at: string; today: string }): { ok: true; item: EmploymentItem } | Refusal {
  if (!l) return refuse(409, "month_not_employed", "There is no employment cost in that month (before the start or after the end date)");
  const i = asInstalment(organisationId, l);
  if (l.item && remainingOf(i) === 0) return refuse(409, "already_paid", "This month is already recorded as paid - a payment is never recorded twice");
  if (l.item && input.amountMinor !== remainingOf(i)) return refuse(409, "partial_payment_not_supported", `Salary items are paid in full only: the confirmed amount is ${m(remainingOf(i))}`);
  const plan = planChange(i, input, { today: ctx.today, actor: ctx.actor, at: ctx.at, newId: () => "unused" });
  if (!plan.ok) return plan;
  if (plan.kind !== "payment") return refuse(409, "snapshot_mismatch", "The change did not add up - nothing was saved");
  const item = l.item as EmploymentItem;
  return { ok: true, item: { ...item, paidMinor: plan.next.paidMinor, paidDate: input.paidDate, paymentMethod: input.method, paymentReference: input.reference, paymentNote: input.note, paidAt: ctx.at, paidBy: ctx.actor } };
}

// ---------------------------------------------------------------------
// Categories and assignments
// ---------------------------------------------------------------------
export function applyCategoryPatch(c: OverheadCategory, all: OverheadCategory[], patch: { name?: string; active?: boolean }): { ok: true; category: OverheadCategory; changed: string[] } | Refusal {
  const next = { ...c, ...patch };
  const changed = (["name", "active"] as const).filter((k) => next[k] !== c[k]);
  if (!changed.length) return refuse(409, "nothing_to_change", "Nothing would change");
  if (patch.name !== undefined && all.some((x) => x.categoryId !== c.categoryId && x.name.toLowerCase() === next.name.toLowerCase())) return refuse(409, "category_exists", `A category called "${next.name}" already exists`);
  return { ok: true, category: next, changed };
}
/** Categorise one F13 agreement version: general only, once only, active category only. */
export function planAssign(agreement: Agreement | undefined, assignments: OverheadAssignment[], category: OverheadCategory | undefined): { ok: true } | Refusal {
  if (!agreement) return refuse(404, "agreement_not_found", "No such supplier agreement");
  if (agreement.classification !== "general") return refuse(409, "not_an_overhead", "A direct cost exists because sessions are delivered - it is attributed to them, not an overhead");
  if (assignments.some((a) => a.agreementId === agreement.agreementId)) return refuse(409, "already_categorised", "This agreement version already has its category - to recategorise from a later date, make a new agreement version");
  if (!category) return refuse(404, "category_not_found", "No such overhead category");
  if (!category.active) return refuse(409, "category_inactive", "That category is inactive - reactivate it or choose another");
  return { ok: true };
}
export const assignmentOf = (assignments: OverheadAssignment[], agreementId: string) => assignments.find((a) => a.agreementId === agreementId) ?? null;

// ---------------------------------------------------------------------
// VAT on reporting facts - only what is actually known
// ---------------------------------------------------------------------
export function vatFigures(treatment: string | null, amountMinor: number) {
  if (treatment === "no_vat" || treatment === "not_applicable") return { vatTreatment: treatment, vatKnown: true, gross: m(amountMinor), vat: m(0), net: m(amountMinor) };
  if (treatment === "vat_included") return { vatTreatment: treatment, vatKnown: false, gross: m(amountMinor), vat: null, net: null };
  if (treatment === "plus_vat") return { vatTreatment: treatment, vatKnown: false, gross: null, vat: null, net: m(amountMinor) };
  return { vatTreatment: null, vatKnown: false, gross: null, vat: null, net: null };
}

// ---------------------------------------------------------------------
// Views and audit
// ---------------------------------------------------------------------
export function categoryView(c: OverheadCategory) {
  return { categoryId: c.categoryId, name: c.name, active: c.active, revision: c.revision, createdAt: c.createdAt, updatedAt: c.updatedAt };
}
export function assignmentView(a: OverheadAssignment, categories: OverheadCategory[]) {
  const c = categories.find((x) => x.categoryId === a.categoryId);
  return { assignmentId: a.assignmentId, agreementId: a.agreementId, categoryId: a.categoryId, category: c?.name ?? a.categoryNameAtAssignment, categoryNameAtAssignment: a.categoryNameAtAssignment, categoryActive: c?.active ?? null, reason: a.reason, assignedAt: a.assignedAt, assignedBy: a.assignedBy, fixed: true };
}
export function employmentVersionView(v: EmploymentVersion, categories: OverheadCategory[]) {
  const c = categories.find((x) => x.categoryId === v.categoryId);
  return {
    versionId: v.versionId,
    employmentId: v.employmentId,
    supersedes: v.supersedesVersionId,
    effectiveFromMonth: v.effectiveFromMonth,
    person: { ref: v.personRef, name: v.personName },
    category: { categoryId: v.categoryId, name: c?.name ?? null },
    annualSalary: m(v.annualSalaryMinor),
    monthlySalary: m(monthlySalaryOf(v.annualSalaryMinor)),
    payDay: v.payDay,
    startDate: v.startDate,
    endDate: v.endDate,
    employerPensionMonthlyEstimate: v.pensionEstimateMinor === null ? null : m(v.pensionEstimateMinor),
    employerNiPayeMonthlyEstimate: v.niPayeEstimateMinor === null ? null : m(v.niPayeEstimateMinor),
    estimatesAre: ESTIMATE_LABEL,
    notes: v.notes,
    reason: v.reason,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  };
}
export function auditItem(i: EmploymentItem) {
  return { itemId: i.itemId, month: i.month, versionId: i.versionId, estimateTotal: m(i.estimateTotalMinor), amountDue: m(i.amountDueMinor), usedEstimate: i.usedEstimate, paid: m(i.paidMinor), paidDate: i.paidDate, state: i.paidMinor === i.amountDueMinor ? "paid" : "confirmed" };
}
export function overheadAudit(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: OVERHEAD_CONTRACT } };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
export const ITEM_ACTIONS = ["confirm-estimate", "payment"] as const;
export type ItemAction = (typeof ITEM_ACTIONS)[number];
export type OverheadRoute =
  | { name: "categories.list"; params: Record<string, never> }
  | { name: "categories.create"; params: Record<string, never> }
  | { name: "categories.one"; params: { categoryId: string } }
  | { name: "categories.update"; params: { categoryId: string } }
  | { name: "overheads.list"; params: Record<string, never> }
  | { name: "overheads.categorise"; params: Record<string, never> }
  | { name: "overheads.one"; params: { agreementId: string } }
  | { name: "overheads.version"; params: { agreementId: string } }
  | { name: "employment.list"; params: Record<string, never> }
  | { name: "employment.create"; params: Record<string, never> }
  | { name: "employment.one"; params: { employmentId: string } }
  | { name: "employment.version"; params: { employmentId: string } }
  | { name: "employment.item"; params: { employmentId: string; month: string; action: ItemAction } }
  | { name: "facts"; params: Record<string, never> };
export type OverheadMatch = { status: "match"; route: OverheadRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;
const ROOTS = ["overhead-categories", "overheads", "employment-costs", "overhead-facts"];

/**
 * F15 owns these paths only. Estimate confirmation and payment of a supplier
 * overhead stay on F13's /supplier-instalments routes - there is deliberately
 * no overhead payment, contractor, payroll, Cash Flow or Month Report route.
 */
export function matchOverheadRoute(path: string, method: string): OverheadMatch {
  const seg = path.split("/");
  if (!ROOTS.includes(seg[0])) return null;
  const pick = (byMethod: Partial<Record<string, OverheadRoute>>): OverheadMatch => {
    const r = byMethod[method];
    return r ? { status: "match", route: r } : { status: "method", allowed: Object.keys(byMethod) };
  };
  if (seg[0] === "overhead-categories") {
    if (seg.length === 1) return pick({ GET: { name: "categories.list", params: {} }, POST: { name: "categories.create", params: {} } });
    if (seg.length === 2 && CATEGORY_ID_RE.test(seg[1])) return pick({ GET: { name: "categories.one", params: { categoryId: seg[1] } }, POST: { name: "categories.update", params: { categoryId: seg[1] } } });
  }
  if (seg[0] === "overheads") {
    if (seg.length === 1) return pick({ GET: { name: "overheads.list", params: {} }, POST: { name: "overheads.categorise", params: {} } });
    if (AGREEMENT_ID_RE.test(seg[1] ?? "")) {
      if (seg.length === 2) return pick({ GET: { name: "overheads.one", params: { agreementId: seg[1] } } });
      if (seg.length === 3 && seg[2] === "version") return pick({ POST: { name: "overheads.version", params: { agreementId: seg[1] } } });
    }
  }
  if (seg[0] === "employment-costs") {
    if (seg.length === 1) return pick({ GET: { name: "employment.list", params: {} }, POST: { name: "employment.create", params: {} } });
    if (EMPLOYMENT_ID_RE.test(seg[1] ?? "")) {
      if (seg.length === 2) return pick({ GET: { name: "employment.one", params: { employmentId: seg[1] } } });
      if (seg.length === 3 && seg[2] === "version") return pick({ POST: { name: "employment.version", params: { employmentId: seg[1] } } });
      if (seg.length === 5 && seg[2] === "months" && MONTH_RE.test(seg[3]) && (ITEM_ACTIONS as readonly string[]).includes(seg[4]))
        return pick({ POST: { name: "employment.item", params: { employmentId: seg[1], month: seg[3], action: seg[4] as ItemAction } } });
    }
  }
  if (seg[0] === "overhead-facts" && seg.length === 1) return pick({ GET: { name: "facts", params: {} } });
  return { status: "not_found" };
}

// ---------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

export type OverheadQuery = { ok: true; active?: boolean; categoryId?: string; month?: string; fromMonth?: string; toMonth?: string };
export function parseOverheadQuery(route: OverheadRoute["name"] | "write", q: URLSearchParams, isTenantKey: (k: string) => boolean): OverheadQuery | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const allowed: Partial<Record<OverheadRoute["name"], string[]>> = {
    "categories.list": ["active"],
    "overheads.list": ["categoryId", "month"],
    "employment.list": ["active"],
    "employment.one": ["from", "to"],
    facts: ["from", "to"],
  };
  const ok = route === "write" ? [] : allowed[route] ?? [];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(bad)].join(", ")}`);
  if (new Set(keys).size !== keys.length) return invalid("unexpected_parameter", "A query parameter is repeated");
  const out: OverheadQuery = { ok: true };
  const active = q.get("active");
  if (active !== null) {
    if (active !== "true" && active !== "false") return invalid("invalid_query", "active must be true or false");
    out.active = active === "true";
  }
  const cid = q.get("categoryId");
  if (cid !== null) {
    if (!CATEGORY_ID_RE.test(cid)) return invalid("invalid_query", "categoryId must be a category id (FOC-...)");
    out.categoryId = cid;
  }
  const month = q.get("month");
  if (month !== null) {
    if (!MONTH_RE.test(month)) return invalid("invalid_query", "month must be a month YYYY-MM");
    out.month = month;
  }
  for (const k of ["from", "to"] as const) {
    const v = q.get(k);
    if (v === null) continue;
    if (!MONTH_RE.test(v)) return invalid("invalid_query", `${k} must be a month YYYY-MM`);
    if (k === "from") out.fromMonth = v;
    else out.toMonth = v;
  }
  return out;
}
/** A month range: default the 3 months ending `defaultTo`; at most 12. */
export function monthRange(q: { fromMonth?: string; toMonth?: string }, defaultTo: string): { ok: true; from: string; to: string } | Invalid {
  const to = q.toMonth ?? (q.fromMonth ? addMonth(q.fromMonth, 2) : defaultTo);
  const from = q.fromMonth ?? addMonth(to, -2);
  if (from > to) return invalid("invalid_query", "from must be on or before to");
  if (monthIdx(to) - monthIdx(from) + 1 > MAX_RANGE_MONTHS) return invalid("invalid_query", `The range may be at most ${MAX_RANGE_MONTHS} months`);
  return { ok: true, from, to };
}

// --- categories
export function parseCategory(raw: string, isTenantKey: (k: string) => boolean, creating: boolean): { ok: true; name?: string; active?: boolean; reason: string | null } | Invalid {
  const b = jsonObject(raw, creating ? ["name", "reason"] : ["name", "active", "reason"], isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  let name: string | undefined;
  if ("name" in x || creating) {
    const t = text(x.name, true, CATEGORY_NAME_MAX);
    if (!t.ok) f.name = t.error;
    else name = t.value as string;
  }
  let active: boolean | undefined;
  if ("active" in x) {
    if (typeof x.active !== "boolean") f.active = "must be true or false";
    else active = x.active;
  }
  const reason = text(x.reason, false);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  if (!creating && name === undefined && active === undefined) return invalid("invalid_input", "Nothing to change (give name and / or active)");
  return { ok: true, ...(name !== undefined ? { name } : {}), ...(active !== undefined ? { active } : {}), reason: (reason as { value: string | null }).value };
}

// --- overheads
export function parseCategorise(raw: string, isTenantKey: (k: string) => boolean): { ok: true; agreementId: string; categoryId: string; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["agreementId", "categoryId", "reason"], isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  if (typeof x.agreementId !== "string" || !AGREEMENT_ID_RE.test(x.agreementId)) f.agreementId = "is required: an F13 supplier agreement id (FSA-...)";
  if (typeof x.categoryId !== "string" || !CATEGORY_ID_RE.test(x.categoryId)) f.categoryId = "is required: an overhead category id (FOC-...)";
  const reason = text(x.reason, false);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  return { ok: true, agreementId: x.agreementId as string, categoryId: x.categoryId as string, reason: (reason as { value: string | null }).value };
}
/** An overhead version: F13's own version body (parsed by F13) plus an optional categoryId. */
export function parseOverheadVersion(raw: string, isTenantKey: (k: string) => boolean): { ok: true; categoryId: string | null; spec: AgreementSpec } | Invalid {
  const b = jsonObject(raw, [...AGREEMENT_FIELDS, "categoryId"], isTenantKey);
  if (!b.ok) return b;
  const { categoryId, ...rest } = b.body;
  if (categoryId !== undefined && categoryId !== null && (typeof categoryId !== "string" || !CATEGORY_ID_RE.test(categoryId))) return invalid("invalid_input", "Some fields are not valid - nothing was saved", { categoryId: "must be an overhead category id (FOC-...)" });
  const p = parseAgreement(JSON.stringify(rest), isTenantKey, true);
  if (!p.ok) return p;
  if (p.spec.classification !== "general") return invalid("invalid_input", "Some fields are not valid - nothing was saved", { classification: "an overhead version is a general cost (a direct cost is versioned on the F13 supplier-agreement route)" });
  return { ok: true, categoryId: (categoryId as string | undefined) ?? null, spec: p.spec };
}

// --- employment
const EMPLOYMENT_FIELDS = ["personRef", "name", "categoryId", "annualSalary", "payDay", "startDate", "endDate", "employerPensionMonthlyEstimate", "employerNiPayeMonthlyEstimate", "notes", "reason"] as const;
const VERSION_FIELDS = ["effectiveFromMonth", "name", "categoryId", "annualSalary", "payDay", "endDate", "employerPensionMonthlyEstimate", "employerNiPayeMonthlyEstimate", "notes", "reason"] as const;
function payDayOf(v: unknown, f: Record<string, string>): number | undefined {
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 31) {
    f.payDay = "must be a day of the month 1-31 (a shorter month pays on its last day)";
    return undefined;
  }
  return v as number;
}
function estimate(v: unknown, f: Record<string, string>, key: string): number | null | undefined {
  if (v === null) return null;
  const n = money(v, f, key, true);
  return n === null ? undefined : n;
}
export function parseEmploymentCreate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; spec: EmploymentSpec } | Invalid {
  const b = jsonObject(raw, EMPLOYMENT_FIELDS, isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  let personRef: string | null = null;
  if (x.personRef !== undefined && x.personRef !== null) {
    if (typeof x.personRef !== "string" || !PERSON_REF_RE.test(x.personRef)) f.personRef = "must be a Coach ID (COACH-...) or omitted";
    else personRef = x.personRef;
  }
  const name = text(x.name, personRef === null, 200);
  if (!name.ok) f.name = personRef === null && name.error === "is required" ? "is required when there is no personRef" : name.error;
  if (typeof x.categoryId !== "string" || !CATEGORY_ID_RE.test(x.categoryId)) f.categoryId = "is required: an overhead category id (FOC-...)";
  const salary = money(x.annualSalary, f, "annualSalary", true);
  const payDay = payDayOf(x.payDay, f);
  const start = isRealDate(x.startDate) ? x.startDate : null;
  if (!start) f.startDate = "is required: a real date YYYY-MM-DD";
  let end: string | null = null;
  if (x.endDate !== undefined && x.endDate !== null) {
    if (!isRealDate(x.endDate)) f.endDate = "must be a real date YYYY-MM-DD";
    else if (start && x.endDate < start) f.endDate = "must be on or after startDate";
    else end = x.endDate;
  }
  const pension = x.employerPensionMonthlyEstimate === undefined ? null : estimate(x.employerPensionMonthlyEstimate, f, "employerPensionMonthlyEstimate");
  const ni = x.employerNiPayeMonthlyEstimate === undefined ? null : estimate(x.employerNiPayeMonthlyEstimate, f, "employerNiPayeMonthlyEstimate");
  const notes = text(x.notes, false, 2000);
  if (!notes.ok) f.notes = notes.error;
  const reason = text(x.reason, false);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  return {
    ok: true,
    spec: {
      personRef,
      name: (name as { value: string | null }).value,
      categoryId: x.categoryId as string,
      annualSalaryMinor: salary as number,
      payDay: payDay as number,
      startDate: start as string,
      endDate: end,
      pensionEstimateMinor: pension ?? null,
      niPayeEstimateMinor: ni ?? null,
      notes: (notes as { value: string | null }).value,
      reason: (reason as { value: string | null }).value,
    },
  };
}
export function parseEmploymentVersion(raw: string, isTenantKey: (k: string) => boolean): { ok: true; effectiveFromMonth: string; patch: EmploymentPatch; reason: string } | Invalid {
  const b = jsonObject(raw, VERSION_FIELDS, isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  const f: Record<string, string> = {};
  const patch: EmploymentPatch = {};
  if (typeof x.effectiveFromMonth !== "string" || !MONTH_RE.test(x.effectiveFromMonth)) f.effectiveFromMonth = "is required: the first month YYYY-MM the change applies to";
  if ("name" in x) {
    const t = text(x.name, true, 200);
    if (!t.ok) f.name = t.error;
    else patch.personName = t.value as string;
  }
  if ("categoryId" in x) {
    if (typeof x.categoryId !== "string" || !CATEGORY_ID_RE.test(x.categoryId)) f.categoryId = "must be an overhead category id (FOC-...)";
    else patch.categoryId = x.categoryId;
  }
  if ("annualSalary" in x) {
    const s = money(x.annualSalary, f, "annualSalary", true);
    if (s !== null) patch.annualSalaryMinor = s;
  }
  if ("payDay" in x) {
    const d = payDayOf(x.payDay, f);
    if (d !== undefined) patch.payDay = d;
  }
  if ("endDate" in x) {
    if (x.endDate !== null && !isRealDate(x.endDate)) f.endDate = "must be a real date YYYY-MM-DD or null";
    else patch.endDate = x.endDate as string | null;
  }
  if ("employerPensionMonthlyEstimate" in x) {
    const e = estimate(x.employerPensionMonthlyEstimate, f, "employerPensionMonthlyEstimate");
    if (e !== undefined) patch.pensionEstimateMinor = e;
  }
  if ("employerNiPayeMonthlyEstimate" in x) {
    const e = estimate(x.employerNiPayeMonthlyEstimate, f, "employerNiPayeMonthlyEstimate");
    if (e !== undefined) patch.niPayeEstimateMinor = e;
  }
  if ("notes" in x) {
    const t = text(x.notes, false, 2000);
    if (!t.ok) f.notes = t.error;
    else patch.notes = t.value;
  }
  const reason = text(x.reason, true);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  if (!Object.keys(patch).length) return invalid("invalid_input", "Nothing to change - give at least one changed field");
  return { ok: true, effectiveFromMonth: x.effectiveFromMonth as string, patch, reason: (reason as { value: string }).value };
}
/** Month actions reuse F13's own parsing: confirm-estimate { amount | useEstimate, reason? } and payment { amount, paidDate, method?, reference?, note? }. */
export function parseItemAction(action: ItemAction, raw: string, isTenantKey: (k: string) => boolean) {
  return parseAction(action, raw, isTenantKey);
}
