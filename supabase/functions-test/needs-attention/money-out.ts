/**
 * Money Out evaluators for Needs Attention (Finance Foundation F16; see
 * TEST-ENV.md "Finance Foundation - F16"). Five rules over ONE shared pass:
 *
 *   outgoing_payment_due_today  (ATT-049)  Confirmed, money still owed, due today
 *   outgoing_payment_overdue    (ATT-050)  Confirmed, money still owed, due before today
 *   outgoing_estimate_due_soon  (ATT-051)  still Estimated, due within the reminder window
 *   outgoing_estimate_due_today (ATT-052)  still Estimated on its due date ("Amount still estimated")
 *   outgoing_estimate_overdue   (ATT-053)  still Estimated after its due date ("Estimate overdue")
 *
 * Sources (only those with a real payable -> paid lifecycle):
 *  - F13 / F14 supplier / venue instalments. Remaining payable is F13's own
 *    remainingOf() (amount due - cash paid - supplier credit applied) and the
 *    state is F13's own stateOf() - both imported from ../finance, never
 *    re-decided here. Cancelled or settled instalments raise nothing.
 *  - F15 employment-cost months. The month line (computed estimate, or the
 *    item Management confirmed / paid) is F15's own monthLine(), and its state
 *    / remaining are F13's lifecycle via F15's asInstalment() - imported too.
 *  - NOT F12 Coach Months: F12 records no Paid fact (paymentState
 *    not_tracked), so a coach-payment case could never resolve truthfully.
 *    Excluded on purpose (TEST-ENV.md FIN16.3).
 *
 * One source raises at most ONE case at a time: Estimated sources only ever
 * reach the three estimate rules (soon -> today -> overdue, mutually
 * exclusive by date), Confirmed / Partially Paid sources only the two
 * payment rules (today / overdue). Paid, settled or cancelled: nothing.
 *
 * "Today" is the organisation's own calendar day; days are whole calendar
 * days (F7's daysBetween), never elapsed milliseconds. The estimate reminder
 * window is the organisation's Finance Setting "Estimate Reminder Days"
 * (F2), else the Finance baseline (3 days).
 *
 * Read-only and bounded: four Supabase Finance tables (organisation-scoped,
 * paged, GET only - repository.ts) and Finance Settings, each loaded once
 * per request by the engine and shared by all five rules; no per-source
 * read, no Finance API call, no write. A malformed row of this organisation
 * fails the whole pass loudly (complete:false + evaluator_error), as in F8a.
 *
 * Access: the F8a Finance capability filter applies unchanged (catalogue
 * module module_finance): no Finance grant = no Money Out source is read and
 * no case, count or amount is shown; Finance View reads; only Finance Manage
 * may snooze (exception) a case. Snoozing never changes a due date, state,
 * amount or payment - it only hides that exact case until it expires.
 */
import type { CandidateCase, EvaluatorContext, EvaluatorRegistration } from "./needs-attention.ts";
import { FinanceDataError, daysBetween, isIsoDate, pounds } from "./finance.ts";
import { localMidnightIso } from "./work-summaries.ts";
import { FINANCE_SOURCES } from "./repository.ts";
import { type EmploymentItem, type EmploymentVersion, MONTH_RE, asInstalment, chainOf, monthLine, monthOf, monthsBetween } from "../finance/finance-overheads.ts";
import { type Instalment, type Supplier, remainingOf, stateOf } from "../finance/finance-suppliers.ts";
import { SETTINGS_TABLE, STORED as SETTINGS_FIELDS, estimateReminderDaysOf, fromStoredRow } from "../finance/finance-settings.ts";
import { todayIn } from "../finance/finance-commercial.ts";

// ===== COPIED FROM finance/finance-suppliers-repository.ts - DO NOT EDIT HERE =====
const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what}: not an integer`);
  return n;
};
const intOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : int(v, what));
const dateOf = (v: unknown) => String(v).slice(0, 10);
const iso = (v: unknown) => new Date(String(v)).toISOString();

export const supplierFromRow = (r: Record<string, any>): Supplier => ({
  organisationId: r.organisation_id,
  supplierId: r.supplier_id,
  name: r.name,
  supplierType: r.supplier_type,
  active: r.active === true,
  contactName: r.contact_name ?? null,
  contactEmail: r.contact_email ?? null,
  contactPhone: r.contact_phone ?? null,
  vatTreatment: r.vat_treatment ?? null,
  notes: r.notes ?? null,
  venueRecordId: r.venue_record_id ?? null,
  revision: int(r.revision, "revision"),
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
  updatedAt: iso(r.updated_at),
  updatedBy: r.updated_by,
});
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-suppliers-repository.ts - DO NOT EDIT HERE =====
export const instalmentFromRow = (r: Record<string, any>): Instalment => ({
  organisationId: r.organisation_id,
  instalmentId: r.instalment_id,
  agreementId: r.agreement_id,
  supplierId: r.supplier_id,
  sequence: int(r.sequence, "sequence"),
  originalDueDate: dateOf(r.original_due_date),
  dueDate: dateOf(r.due_date),
  plannedMinor: int(r.planned_minor, "planned_minor"),
  amountDueMinor: int(r.amount_due_minor, "amount_due_minor"),
  amountState: r.amount_state,
  paidMinor: int(r.paid_minor, "paid_minor"),
  creditedMinor: int(r.credited_minor ?? 0, "credited_minor"),
  splitFromInstalmentId: r.split_from_instalment_id ?? null,
  note: r.note ?? null,
  cancelledAt: r.cancelled_at ? iso(r.cancelled_at) : null,
  cancelledBy: r.cancelled_by ?? null,
  cancelReason: r.cancel_reason ?? null,
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
});
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-overheads-repository.ts - DO NOT EDIT HERE =====
export const versionFromRow = (r: Record<string, any>): EmploymentVersion => ({
  organisationId: r.organisation_id,
  versionId: r.version_id,
  employmentId: r.employment_id,
  supersedesVersionId: r.supersedes_version_id ?? null,
  personRef: r.person_ref ?? null,
  personName: r.person_name,
  categoryId: r.category_id,
  annualSalaryMinor: int(r.annual_salary_minor, "annual_salary_minor"),
  payDay: int(r.pay_day, "pay_day"),
  startDate: dateOf(r.start_date),
  endDate: r.end_date ? dateOf(r.end_date) : null,
  effectiveFromMonth: r.effective_from_month,
  pensionEstimateMinor: intOrNull(r.pension_estimate_minor, "pension_estimate_minor"),
  niPayeEstimateMinor: intOrNull(r.ni_paye_estimate_minor, "ni_paye_estimate_minor"),
  notes: r.notes ?? null,
  reason: r.reason ?? null,
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
});
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-overheads-repository.ts - DO NOT EDIT HERE =====
export const itemFromRow = (r: Record<string, any>): EmploymentItem => ({
  organisationId: r.organisation_id,
  itemId: r.item_id,
  employmentId: r.employment_id,
  month: r.month,
  versionId: r.version_id,
  salaryMinor: int(r.salary_minor, "salary_minor"),
  pensionEstimateMinor: int(r.pension_estimate_minor, "pension_estimate_minor"),
  niPayeEstimateMinor: int(r.ni_paye_estimate_minor, "ni_paye_estimate_minor"),
  estimateTotalMinor: int(r.estimate_total_minor, "estimate_total_minor"),
  amountDueMinor: int(r.amount_due_minor, "amount_due_minor"),
  usedEstimate: r.used_estimate === true,
  expectedPaymentDate: dateOf(r.expected_payment_date),
  confirmedAt: iso(r.confirmed_at),
  confirmedBy: r.confirmed_by,
  confirmReason: r.confirm_reason ?? null,
  paidMinor: int(r.paid_minor, "paid_minor"),
  paidDate: r.paid_date ? dateOf(r.paid_date) : null,
  paymentMethod: r.payment_method ?? null,
  paymentReference: r.payment_reference ?? null,
  paymentNote: r.payment_note ?? null,
  paidAt: r.paid_at ? iso(r.paid_at) : null,
  paidBy: r.paid_by ?? null,
});
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Rules, sources, buckets
// ---------------------------------------------------------------------

export const MONEY_OUT_RULES = {
  payment_due_today: { ruleKey: "outgoing_payment_due_today", ruleId: "ATT-049" },
  payment_overdue: { ruleKey: "outgoing_payment_overdue", ruleId: "ATT-050" },
  estimate_due_soon: { ruleKey: "outgoing_estimate_due_soon", ruleId: "ATT-051" },
  estimate_due_today: { ruleKey: "outgoing_estimate_due_today", ruleId: "ATT-052" },
  estimate_overdue: { ruleKey: "outgoing_estimate_overdue", ruleId: "ATT-053" },
} as const;
export type Bucket = keyof typeof MONEY_OUT_RULES;

export const MONEY_OUT_TABLES = {
  suppliers: "supabase:finance_suppliers",
  instalments: "supabase:finance_supplier_instalments",
  versions: "supabase:finance_employment_versions",
  items: "supabase:finance_employment_items",
} as const;

/** Exactly what every Money Out rule reads (each loaded once per request by the engine, shared by all five rules). */
export const MONEY_OUT_SOURCES: readonly string[] = [MONEY_OUT_TABLES.suppliers, MONEY_OUT_TABLES.instalments, MONEY_OUT_TABLES.versions, MONEY_OUT_TABLES.items, SETTINGS_TABLE];
for (const s of MONEY_OUT_SOURCES) if (s.startsWith("supabase:") && !FINANCE_SOURCES[s]) throw new Error(`Money Out source ${s} is not an allowlisted Finance read`);

export type SourceType = "supplier_instalment" | "employment_cost";
export const SOURCE_LABELS: Record<SourceType, string> = { supplier_instalment: "Supplier / venue payment", employment_cost: "Employment cost" };

/**
 * Which case (if any) one outgoing obligation raises today. `state` is F13's
 * stateOf, `remainingMinor` F13's remainingOf. Mutually exclusive by
 * construction: one bucket or none.
 */
export function bucketOf(state: string, remainingMinor: number, dueDate: string, today: string, reminderDays: number): { bucket: Bucket; daysUntilDue: number } | null {
  if (state === "cancelled" || state === "paid" || remainingMinor <= 0) return null;
  const d = daysBetween(today, dueDate); // > 0: due in d days; 0: due today; < 0: -d days overdue
  if (state === "estimated") {
    if (d < 0) return { bucket: "estimate_overdue", daysUntilDue: d };
    if (d === 0) return { bucket: "estimate_due_today", daysUntilDue: 0 };
    return d <= reminderDays ? { bucket: "estimate_due_soon", daysUntilDue: d } : null;
  }
  if (state !== "confirmed" && state !== "partially_paid") throw new FinanceDataError(`unknown outgoing state ${state}`);
  if (d < 0) return { bucket: "payment_overdue", daysUntilDue: d };
  return d === 0 ? { bucket: "payment_due_today", daysUntilDue: 0 } : null;
}

export interface MoneyOutItem {
  sourceType: SourceType;
  bucket: Bucket;
  /** Case Key subjects (documented order): supplier_instalment:<FSI-> | employment_cost:<FEM->|month:<YYYY-MM>. */
  subjects: { type: string; id: string }[];
  payeeName: string;
  supplierId: string | null;
  supplierType: string | null;
  agreementId: string | null;
  instalmentId: string | null;
  employmentId: string | null;
  month: string | null;
  itemId: string | null;
  state: string;
  amountDueMinor: number;
  cashPaidMinor: number;
  creditAppliedMinor: number;
  remainingMinor: number;
  dueDate: string;
  originalDueDate: string;
  daysUntilDue: number;
  partMonth: boolean;
}

export interface MoneyOutPass {
  today: string;
  reminderDays: number;
  reminderSource: "organisation_setting" | "finance_baseline";
  instalments: number;
  employmentMonths: number;
  items: MoneyOutItem[];
}

// ---------------------------------------------------------------------
// Strict readers (this organisation's rows only)
// ---------------------------------------------------------------------

const RE = {
  supplier: /^FSU-[0-9A-F]{12}$/,
  agreement: /^FSA-[0-9A-F]{12}$/,
  instalment: /^FSI-[0-9A-F]{12}$/,
  employment: /^FEM-[0-9A-F]{12}$/,
  version: /^FEV-[0-9A-F]{12}$/,
  item: /^FEI-[0-9A-F]{12}$/,
};

type Raw = Record<string, any>;

function rows(ctx: EvaluatorContext, source: string, organisationId: string): Raw[] {
  const out = (ctx.sources[source] ?? []) as unknown as Raw[];
  for (const r of out) if (!r || r.organisation_id !== organisationId) throw new FinanceDataError(`${source}: a row of another organisation was returned`);
  return out;
}

function strict<T>(source: string, r: Raw, map: (r: Raw) => T): T {
  try {
    return map(r);
  } catch (e) {
    throw new FinanceDataError(`${source}: unreadable row (${e instanceof Error ? e.message : String(e)})`);
  }
}

function dupes(ids: string[], what: string) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new FinanceDataError(`duplicate ${what} ${id}`);
    seen.add(id);
  }
}

const addDays = (d: string, n: number) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------
// One Money Out pass per request: all five evaluators receive the SAME
// loaded arrays from the engine, so the pass is memoised on the instalments
// array identity (+ now + organisation + timezone + row counts). Nothing
// survives beyond the request's own arrays (WeakMap) - this is not a cache.
// ---------------------------------------------------------------------

const passCache = new WeakMap<object, { key: string; pass: MoneyOutPass }>();
let passRuns = 0;
/** Test hook: how many Money Out passes actually ran (memoisation proof). */
export function moneyOutPassStats() {
  return { runs: passRuns };
}

export function runMoneyOutPass(ctx: EvaluatorContext): MoneyOutPass {
  const anchor = ctx.sources[MONEY_OUT_TABLES.instalments] ?? [];
  const memoKey = `${ctx.now.getTime()}|${ctx.organisation.organisationId}|${ctx.organisation.recordId}|${ctx.organisation.timezone}|${MONEY_OUT_SOURCES.map((t) => (ctx.sources[t] ?? []).length).join(",")}`;
  const hit = passCache.get(anchor);
  if (hit && hit.key === memoKey) return hit.pass;
  passRuns++;
  const orgId = ctx.organisation.organisationId;
  const orgRecord = ctx.organisation.recordId;
  const today = todayIn(ctx.organisation.timezone, ctx.now);

  // Finance Settings (F2): none = the baseline; several or unreadable = a data error.
  const settingsRows = ((ctx.sources[SETTINGS_TABLE] ?? []) as unknown as { id: string; fields: Raw }[]).filter((r) => Array.isArray(r.fields?.[SETTINGS_FIELDS.organisation]) && r.fields[SETTINGS_FIELDS.organisation].includes(orgRecord));
  if (settingsRows.length > 1) throw new FinanceDataError("More than one Finance Settings record exists for the organisation");
  let own: number | null = null;
  if (settingsRows.length === 1) {
    const p = fromStoredRow(settingsRows[0] as any);
    if (!p.ok) throw new FinanceDataError(`Stored Finance Settings are not valid (${p.problems.join(", ")})`);
    own = p.state.settings.estimateReminderDays;
  }
  const reminderDays = estimateReminderDaysOf({ estimateReminderDays: own });
  const horizon = addDays(today, reminderDays);

  // F13 suppliers + open (not cancelled) instalments.
  const suppliers = rows(ctx, MONEY_OUT_TABLES.suppliers, orgId).map((r) => strict(MONEY_OUT_TABLES.suppliers, r, supplierFromRow));
  for (const s of suppliers) if (!RE.supplier.test(s.supplierId) || typeof s.name !== "string" || !s.name.trim()) throw new FinanceDataError(`${MONEY_OUT_TABLES.suppliers}: invalid supplier ${s.supplierId}`);
  dupes(suppliers.map((s) => s.supplierId), "supplier");
  const supplierById = new Map(suppliers.map((s) => [s.supplierId, s]));
  const instalments = rows(ctx, MONEY_OUT_TABLES.instalments, orgId).map((r) => strict(MONEY_OUT_TABLES.instalments, r, instalmentFromRow));
  dupes(instalments.map((i) => i.instalmentId), "instalment");

  const items: MoneyOutItem[] = [];
  for (const i of instalments) {
    const t = MONEY_OUT_TABLES.instalments;
    if (!RE.instalment.test(i.instalmentId) || !RE.agreement.test(i.agreementId) || !supplierById.has(i.supplierId)) throw new FinanceDataError(`${t}: ${i.instalmentId} has an invalid id / agreement / supplier`);
    if (!isIsoDate(i.dueDate) || !isIsoDate(i.originalDueDate)) throw new FinanceDataError(`${t}: ${i.instalmentId} has an invalid due date`);
    if (i.amountState !== "estimated" && i.amountState !== "confirmed") throw new FinanceDataError(`${t}: ${i.instalmentId} has an invalid amount state`);
    if (i.cancelledAt) continue; // the query excludes them; never a case either way
    const remaining = remainingOf(i);
    if (remaining < 0 || i.paidMinor < 0 || i.creditedMinor < 0) throw new FinanceDataError(`${t}: ${i.instalmentId} has paid / credited more than is due`);
    if (i.dueDate > horizon) continue;
    const b = bucketOf(stateOf(i), remaining, i.dueDate, today, reminderDays);
    if (!b) continue;
    const s = supplierById.get(i.supplierId)!;
    items.push({
      sourceType: "supplier_instalment",
      bucket: b.bucket,
      subjects: [{ type: "supplier_instalment", id: i.instalmentId }],
      payeeName: s.name,
      supplierId: s.supplierId,
      supplierType: s.supplierType,
      agreementId: i.agreementId,
      instalmentId: i.instalmentId,
      employmentId: null,
      month: null,
      itemId: null,
      state: stateOf(i),
      amountDueMinor: i.amountDueMinor,
      cashPaidMinor: i.paidMinor,
      creditAppliedMinor: i.creditedMinor,
      remainingMinor: remaining,
      dueDate: i.dueDate,
      originalDueDate: i.originalDueDate,
      daysUntilDue: b.daysUntilDue,
      partMonth: false,
    });
  }

  // F15 employment months: computed estimates + confirmed / paid items, F15's own monthLine().
  const versions = rows(ctx, MONEY_OUT_TABLES.versions, orgId).map((r) => strict(MONEY_OUT_TABLES.versions, r, versionFromRow));
  const empItems = rows(ctx, MONEY_OUT_TABLES.items, orgId).map((r) => strict(MONEY_OUT_TABLES.items, r, itemFromRow));
  dupes(versions.map((v) => v.versionId), "employment version");
  dupes(empItems.map((x) => x.itemId), "employment item");
  dupes(empItems.map((x) => `${x.employmentId} ${x.month}`), "employment month");
  for (const v of versions) {
    if (!RE.version.test(v.versionId) || !RE.employment.test(v.employmentId) || !MONTH_RE.test(v.effectiveFromMonth) || !isIsoDate(v.startDate) || (v.endDate !== null && !isIsoDate(v.endDate)) || typeof v.personName !== "string" || !v.personName.trim() || v.payDay < 1 || v.payDay > 31) {
      throw new FinanceDataError(`${MONEY_OUT_TABLES.versions}: invalid employment version ${v.versionId}`);
    }
  }
  const versionById = new Map(versions.map((v) => [v.versionId, v]));
  for (const x of empItems) {
    const v = versionById.get(x.versionId);
    if (!RE.item.test(x.itemId) || !MONTH_RE.test(x.month) || !v || v.employmentId !== x.employmentId || !isIsoDate(x.expectedPaymentDate)) throw new FinanceDataError(`${MONEY_OUT_TABLES.items}: invalid employment item ${x.itemId}`);
  }
  let employmentMonths = 0;
  const employmentIds = [...new Set(versions.map((v) => v.employmentId))].sort();
  const lastMonth = monthOf(horizon);
  for (const employmentId of employmentIds) {
    const chain = chainOf(versions, employmentId);
    const firstMonth = monthOf(chain.map((v) => v.startDate).sort()[0]);
    if (firstMonth > lastMonth) continue;
    for (const month of monthsBetween(firstMonth, lastMonth)) {
      const l = monthLine(chain, empItems, month);
      if (!l) continue;
      employmentMonths++;
      if (l.expectedPaymentDate > horizon) continue;
      const inst: Instalment = asInstalment(orgId, l);
      const state = stateOf(inst);
      const remaining = remainingOf(inst);
      if (remaining < 0) throw new FinanceDataError(`${MONEY_OUT_TABLES.items}: ${l.item?.itemId ?? employmentId} paid more than is due`);
      const b = bucketOf(state, remaining, l.expectedPaymentDate, today, reminderDays);
      if (!b) continue;
      items.push({
        sourceType: "employment_cost",
        bucket: b.bucket,
        subjects: [
          { type: "employment_cost", id: employmentId },
          { type: "month", id: month },
        ],
        payeeName: l.version.personName,
        supplierId: null,
        supplierType: null,
        agreementId: null,
        instalmentId: null,
        employmentId,
        month,
        itemId: l.item?.itemId ?? null,
        state,
        amountDueMinor: inst.amountDueMinor,
        cashPaidMinor: inst.paidMinor,
        creditAppliedMinor: 0,
        remainingMinor: remaining,
        dueDate: l.expectedPaymentDate,
        originalDueDate: l.expectedPaymentDate,
        daysUntilDue: b.daysUntilDue,
        partMonth: l.partMonth,
      });
    }
  }

  const out: MoneyOutPass = { today, reminderDays, reminderSource: own === null ? "finance_baseline" : "organisation_setting", instalments: instalments.length, employmentMonths, items };
  passCache.set(anchor, { key: memoKey, pass: out });
  return out;
}

// ---------------------------------------------------------------------
// Case shaping
// ---------------------------------------------------------------------

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The action that resolves the case, in the source's own words (the catalogue Action Label is the rule-level label). */
export function sourceActionOf(item: Pick<MoneyOutItem, "sourceType" | "bucket">): string {
  if (item.bucket.startsWith("estimate_")) return "Confirm Cost";
  return item.sourceType === "supplier_instalment" ? "Review Supplier Payment" : "Review Employment Cost";
}

export function moneyOutCase(item: MoneyOutItem, pass: Pick<MoneyOutPass, "today" | "reminderDays" | "reminderSource">, timeZone: string): CandidateCase {
  const who = item.sourceType === "supplier_instalment" ? item.payeeName : `${item.payeeName} - ${monthLabel(item.month!)} employment cost`;
  const overdue = item.daysUntilDue < 0 ? -item.daysUntilDue : 0;
  const titles: Record<Bucket, string> = {
    payment_due_today: `Payment due today - ${who}`,
    payment_overdue: `Payment overdue - ${who}`,
    estimate_due_soon: `Estimated cost due in ${plural(item.daysUntilDue, "day")} - ${who}`,
    estimate_due_today: `Amount still estimated - ${who}`,
    estimate_overdue: `Estimate overdue - ${who}`,
  };
  const settledParts = [item.cashPaidMinor > 0 ? `cash paid £${pounds(item.cashPaidMinor)}` : null, item.creditAppliedMinor > 0 ? `supplier credit applied £${pounds(item.creditAppliedMinor)}` : null].filter(Boolean);
  const detail = item.bucket.startsWith("estimate_")
    ? `Estimated £${pounds(item.remainingMinor)}, due ${item.dueDate}${overdue ? ` (${plural(overdue, "day")} ago)` : item.daysUntilDue > 0 ? ` (in ${plural(item.daysUntilDue, "day")})` : " (today)"} - enter the actual amount or Use Estimate${item.partMonth ? "; part month (the estimate is a full month)" : ""}`
    : `£${pounds(item.remainingMinor)} still to pay (of £${pounds(item.amountDueMinor)}), due ${item.dueDate}${overdue ? `, ${plural(overdue, "day")} overdue` : ", due today"}${settledParts.length ? ` (${settledParts.join(", ")})` : ""}`;
  const dueStart = localMidnightIso(item.dueDate, timeZone);
  return {
    subjects: item.subjects,
    title: titles[item.bucket],
    detail,
    anchors: { event: dueStart, outstandingSince: overdue ? localMidnightIso(addDays(item.dueDate, 1), timeZone) : null },
    anchorTime: dueStart,
    destination:
      item.sourceType === "supplier_instalment"
        ? { route: "finance/supplier-instalment", params: { instalmentId: item.instalmentId!, supplierId: item.supplierId!, agreementId: item.agreementId! } }
        : { route: "finance/employment-cost", params: { employmentId: item.employmentId!, month: item.month! } },
    targetIds:
      item.sourceType === "supplier_instalment" ? { instalmentId: item.instalmentId!, supplierId: item.supplierId!, agreementId: item.agreementId! } : { employmentId: item.employmentId!, month: item.month! },
    context: {
      sourceType: item.sourceType,
      sourceLabel: SOURCE_LABELS[item.sourceType],
      sourceAction: sourceActionOf(item),
      payeeName: item.payeeName,
      supplierId: item.supplierId,
      supplierType: item.supplierType,
      agreementId: item.agreementId,
      instalmentId: item.instalmentId,
      employmentId: item.employmentId,
      month: item.month,
      itemId: item.itemId,
      state: item.state,
      estimated: item.state === "estimated",
      currency: "GBP",
      amountDue: pounds(item.amountDueMinor),
      cashPaid: pounds(item.cashPaidMinor),
      creditApplied: pounds(item.creditAppliedMinor),
      remaining: pounds(item.remainingMinor),
      dueDate: item.dueDate,
      originalDueDate: item.originalDueDate,
      dueDateMoved: item.dueDate !== item.originalDueDate,
      daysOverdue: overdue || null,
      daysUntilDue: item.daysUntilDue > 0 ? item.daysUntilDue : null,
      partMonth: item.partMonth,
      reminderDays: pass.reminderDays,
      reminderSource: pass.reminderSource,
      asOf: pass.today,
      sourceApi: item.sourceType === "supplier_instalment" ? `GET /finance/supplier-instalments/${item.instalmentId}` : `GET /finance/employment-costs/${item.employmentId}?from=${item.month}&to=${item.month}`,
    },
  };
}

function evaluator(bucket: Bucket): EvaluatorRegistration {
  const { ruleKey, ruleId } = MONEY_OUT_RULES[bucket];
  return {
    ruleKey,
    ruleId,
    sources: MONEY_OUT_SOURCES,
    evaluate(ctx) {
      const pass = runMoneyOutPass(ctx);
      return pass.items.filter((i) => i.bucket === bucket).map((i) => moneyOutCase(i, pass, ctx.organisation.timezone));
    },
  };
}

export const MONEY_OUT_EVALUATORS: readonly EvaluatorRegistration[] = (Object.keys(MONEY_OUT_RULES) as Bucket[]).map(evaluator);
