/**
 * Overheads / salaries & employment costs - storage (Finance Foundation F15;
 * see TEST-ENV.md "Finance Foundation - F15").
 *
 * Airtable is READ ONLY here: one Coaches lookup by Coach ID (an optional
 * person reference for a salaried employee). Nothing in Coach Allocations or
 * F12 is read or written.
 *
 * Supabase (service role, PostgREST; RLS on, no client grants):
 *   finance_overhead_categories      one row per category (revisioned rename / deactivate; never deleted)
 *   finance_overhead_assignments     append-only; ONE per F13 agreement version, fixed
 *   finance_employment_versions      append-only effective-dated employment-cost versions
 *   finance_employment_items         months Management acted on: confirmed once, then paid once (in full)
 * Every write is ONE database function call (finance_overhead_category_write /
 * finance_overhead_assign / finance_overhead_version_record /
 * finance_employment_version_record / finance_employment_item_change) that
 * writes its finance_audit_events rows in the same transaction. An overhead
 * version runs F13's own finance_supplier_agreement_record inside that call.
 */
import type { AirtableConfig, GrantStoreConfig } from "./repository.ts";
import { airtableFetch, expectOk, tableUrl } from "./finance-commercial-repository.ts";
import { type Agreement, type Allocation, type Instalment } from "./finance-suppliers.ts";
import { SupplierRefusal, agreementRow, allocationRow, instalmentRow } from "./finance-suppliers-repository.ts";
import { type EmploymentItem, type EmploymentVersion, type OverheadAssignment, type OverheadCategory, PERSON_REF_RE } from "./finance-overheads.ts";

export const OVERHEAD_TABLE = {
  categories: "finance_overhead_categories",
  assignments: "finance_overhead_assignments",
  versions: "finance_employment_versions",
  items: "finance_employment_items",
} as const;
export const OVERHEAD_RPC = {
  category: "finance_overhead_category_write",
  assign: "finance_overhead_assign",
  version: "finance_overhead_version_record",
  employment: "finance_employment_version_record",
  item: "finance_employment_item_change",
} as const;

// ---------------------------------------------------------------------
// Airtable (read only)
// ---------------------------------------------------------------------
/** The Coaches rows carrying this Coach ID (0, 1 or - a data problem - more). */
export async function findPeople(config: AirtableConfig, personRef: string): Promise<{ recordId: string; ref: string; name: string | null }[]> {
  if (!PERSON_REF_RE.test(personRef)) throw new Error("Coaches read refused: malformed Coach ID");
  const url = new URL(tableUrl(config, "Coaches"));
  url.searchParams.set("filterByFormula", `{Coach ID}='${personRef}'`);
  for (const f of ["Coach ID", "Coach Name"]) url.searchParams.append("fields[]", f);
  const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), "Airtable read of Coaches");
  return (data.records || [])
    .map((r: any) => ({ recordId: r.id, ref: r.fields?.["Coach ID"], name: typeof r.fields?.["Coach Name"] === "string" && r.fields["Coach Name"].trim() ? r.fields["Coach Name"].trim() : null }))
    .filter((r: { ref: unknown }) => r.ref === personRef);
}

// ---------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------
function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

async function read(svc: GrantStoreConfig, table: string, organisationId: string, order: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${rest(svc, table)}?organisation_id=${eq(organisationId)}&select=*&order=${order}`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`${table} read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} read returned an unexpected shape`);
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error(`${table} read returned another organisation's row`);
  return rows;
}
const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what}: not an integer`);
  return n;
};
const intOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : int(v, what));
const dateOf = (v: unknown) => String(v).slice(0, 10);
const iso = (v: unknown) => new Date(String(v)).toISOString();

export const categoryFromRow = (r: Record<string, any>): OverheadCategory => ({
  organisationId: r.organisation_id,
  categoryId: r.category_id,
  name: r.name,
  active: r.active === true,
  revision: int(r.revision, "revision"),
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
  updatedAt: iso(r.updated_at),
  updatedBy: r.updated_by,
});
export const categoryRow = (c: OverheadCategory) => ({
  organisation_id: c.organisationId,
  category_id: c.categoryId,
  name: c.name,
  active: c.active,
  revision: c.revision,
  created_at: c.createdAt,
  created_by: c.createdBy,
  updated_at: c.updatedAt,
  updated_by: c.updatedBy,
});
export const assignmentFromRow = (r: Record<string, any>): OverheadAssignment => ({
  organisationId: r.organisation_id,
  assignmentId: r.assignment_id,
  agreementId: r.agreement_id,
  categoryId: r.category_id,
  categoryNameAtAssignment: r.category_name_at_assignment,
  reason: r.reason ?? null,
  assignedAt: iso(r.assigned_at),
  assignedBy: r.assigned_by,
});
export const assignmentRow = (a: OverheadAssignment) => ({
  organisation_id: a.organisationId,
  assignment_id: a.assignmentId,
  agreement_id: a.agreementId,
  category_id: a.categoryId,
  category_name_at_assignment: a.categoryNameAtAssignment,
  reason: a.reason,
  assigned_at: a.assignedAt,
  assigned_by: a.assignedBy,
});
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
export const versionRow = (v: EmploymentVersion) => ({
  organisation_id: v.organisationId,
  version_id: v.versionId,
  employment_id: v.employmentId,
  supersedes_version_id: v.supersedesVersionId,
  person_ref: v.personRef,
  person_name: v.personName,
  category_id: v.categoryId,
  annual_salary_minor: v.annualSalaryMinor,
  pay_day: v.payDay,
  start_date: v.startDate,
  end_date: v.endDate,
  effective_from_month: v.effectiveFromMonth,
  pension_estimate_minor: v.pensionEstimateMinor,
  ni_paye_estimate_minor: v.niPayeEstimateMinor,
  notes: v.notes,
  reason: v.reason,
  created_at: v.createdAt,
  created_by: v.createdBy,
});
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
export const itemRow = (i: EmploymentItem) => ({
  organisation_id: i.organisationId,
  item_id: i.itemId,
  employment_id: i.employmentId,
  month: i.month,
  version_id: i.versionId,
  salary_minor: i.salaryMinor,
  pension_estimate_minor: i.pensionEstimateMinor,
  ni_paye_estimate_minor: i.niPayeEstimateMinor,
  estimate_total_minor: i.estimateTotalMinor,
  amount_due_minor: i.amountDueMinor,
  used_estimate: i.usedEstimate,
  expected_payment_date: i.expectedPaymentDate,
  confirmed_at: i.confirmedAt,
  confirmed_by: i.confirmedBy,
  confirm_reason: i.confirmReason,
  paid_minor: i.paidMinor,
  paid_date: i.paidDate,
  payment_method: i.paymentMethod,
  payment_reference: i.paymentReference,
  payment_note: i.paymentNote,
  paid_at: i.paidAt,
  paid_by: i.paidBy,
});

export interface OverheadLedger {
  categories: OverheadCategory[];
  assignments: OverheadAssignment[];
  versions: EmploymentVersion[];
  items: EmploymentItem[];
}
export async function loadOverheadLedger(svc: GrantStoreConfig, organisationId: string): Promise<OverheadLedger> {
  const [c, a, v, i] = await Promise.all([
    read(svc, OVERHEAD_TABLE.categories, organisationId, "name.asc,category_id.asc"),
    read(svc, OVERHEAD_TABLE.assignments, organisationId, "assigned_at.asc,assignment_id.asc"),
    read(svc, OVERHEAD_TABLE.versions, organisationId, "employment_id.asc,effective_from_month.asc,version_id.asc"),
    read(svc, OVERHEAD_TABLE.items, organisationId, "employment_id.asc,month.asc,item_id.asc"),
  ]);
  return { categories: c.map(categoryFromRow), assignments: a.map(assignmentFromRow), versions: v.map(versionFromRow), items: i.map(itemFromRow) };
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(rest(svc, `rpc/${fn}`), { method: "POST", headers: headers(svc), body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* keep the raw text */
    }
    const mm = /f1[345]:([a-z_]+)/.exec(String(msg));
    if (mm) throw new SupplierRefusal(mm[1]);
    if (/one_successor/i.test(String(msg))) throw new SupplierRefusal("already_versioned");
    if (/one_per_agreement/i.test(String(msg))) throw new SupplierRefusal("already_categorised");
    if (/one_per_month/i.test(String(msg))) throw new SupplierRefusal("already_confirmed");
    if (/name_unique/i.test(String(msg))) throw new SupplierRefusal("category_exists");
    throw new Error(`${fn} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}
export type Events = Record<string, unknown>[];
export const writeCategory = (svc: GrantStoreConfig, c: OverheadCategory, expectedRevision: number | null, events: Events) =>
  rpc(svc, OVERHEAD_RPC.category, { p_category: categoryRow(c), p_expected_revision: expectedRevision, p_events: events });
export const recordAssignment = (svc: GrantStoreConfig, a: OverheadAssignment, events: Events) => rpc(svc, OVERHEAD_RPC.assign, { p_assignment: assignmentRow(a), p_events: events });
/** F13's agreement record (schedule, cancelled predecessor instalments, F13 audit) + the new version's category, in ONE transaction. */
export const recordOverheadVersion = (svc: GrantStoreConfig, a: Agreement, allocations: Allocation[], instalments: Instalment[], cancel: Instalment[], assignment: OverheadAssignment, events: Events) =>
  rpc(svc, OVERHEAD_RPC.version, {
    p_agreement: agreementRow(a),
    p_allocations: allocations.map(allocationRow),
    p_instalments: instalments.map(instalmentRow),
    p_cancel: cancel.map((c) => ({ instalment_id: c.instalmentId, cancelled_at: c.cancelledAt, cancelled_by: c.cancelledBy, cancel_reason: c.cancelReason })),
    p_assignment: assignmentRow(assignment),
    p_events: events,
  });
export const recordEmploymentVersion = (svc: GrantStoreConfig, v: EmploymentVersion, events: Events) => rpc(svc, OVERHEAD_RPC.employment, { p_version: versionRow(v), p_events: events });
/** confirm: inserts the month (once); payment: marks it paid in full (once). p_expected is the state the API decided on. */
export const changeItem = (svc: GrantStoreConfig, kind: "confirm" | "payment", item: EmploymentItem, expected: { paidMinor: number } | null, events: Events) =>
  rpc(svc, OVERHEAD_RPC.item, { p_kind: kind, p_item: itemRow(item), p_expected: expected ? { paid_minor: expected.paidMinor } : null, p_events: events });
