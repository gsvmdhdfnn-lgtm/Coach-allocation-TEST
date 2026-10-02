/**
 * In-memory world for the Finance F15 (overheads / salaries & employment
 * costs) suite. Extends the shared F13 / F14 world with the four F15 tables,
 * fake finance_overhead_* / finance_employment_* database functions with the
 * same rules, CHECKs and guard triggers as the TEST SQL
 * (finance_f15_overheads_employment), and a read-only Coaches table. The REAL
 * F15 orchestrator, repository and the F13 orchestrator / repository run
 * against it. Installs its fetch layer on import (delegating to the F13 world).
 */
import { isTenantKey } from "./finance-access.ts";
import { CHECK, ID, MGR, ORG, T_, audit, deps, err, json, mgr, reset as resetSuppliers, rpcBody, rpcFn, tick, world } from "./finance-suppliers-world.ts";
import { type ItemAction, parseCategorise, parseCategory, parseEmploymentCreate, parseEmploymentVersion, parseItemAction, parseOverheadVersion } from "./finance-overheads.ts";
import {
  categoriseOverhead,
  createCategory,
  createEmployment,
  employmentItemAction,
  listCategories,
  listEmployment,
  listOverheadFacts,
  listOverheads,
  readCategory,
  readEmployment,
  readOverhead,
  updateCategory,
  versionEmployment,
  versionOverhead,
} from "./finance-overheads-orchestrator.ts";

export * from "./finance-suppliers-world.ts";

export const OH_TABLES = ["finance_overhead_categories", "finance_overhead_assignments", "finance_employment_versions", "finance_employment_items"];
export const COACH_REC = "recCOACHSALARY01";
export function reset() {
  resetSuppliers();
  for (const t of OH_TABLES) world.sb[t] = [];
  world.at.Coaches = [
    { id: COACH_REC, fields: { "Coach ID": "COACH-SAL-1", "Coach Name": "ZZTEST Salaried Coach", Active: true } },
    { id: "recCOACHDUPE0001", fields: { "Coach ID": "COACH-DUP", "Coach Name": "Dupe One" } },
    { id: "recCOACHDUPE0002", fields: { "Coach ID": "COACH-DUP", "Coach Name": "Dupe Two" } },
  ];
}

// ----- fake F15 database functions (same rules as finance_f15_overheads_employment) -----
const no15: (code: string) => never = (code) => {
  throw new Refused15(`f15:${code}`);
};
export class Refused15 extends Error {}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const firstOf = (m: string) => `${m}-01`;
const lastOf = (m: string) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  return `${m}-${String(d).padStart(2, "0")}`;
};
function checkCategory(c: any) {
  CHECK(/^FOC-[0-9A-F]{12}$/.test(c.category_id) && typeof c.name === "string" && c.name.length >= 1 && c.name.length <= 100 && c.name === c.name.trim() && typeof c.active === "boolean" && c.revision >= 1, "finance_overhead_categories");
}
function checkVersion(v: any) {
  CHECK(/^FEV-[0-9A-F]{12}$/.test(v.version_id) && /^FEM-[0-9A-F]{12}$/.test(v.employment_id) && String(v.person_name ?? "").trim() && v.annual_salary_minor > 0 && v.pay_day >= 1 && v.pay_day <= 31, "finance_employment_versions");
  CHECK(v.person_ref === null || /^COACH-[A-Za-z0-9-]{1,48}$/.test(v.person_ref), "finance_employment_versions person_ref");
  CHECK(v.end_date === null || v.end_date >= v.start_date, "finance_employment_versions dates");
  CHECK(MONTH.test(v.effective_from_month) && v.effective_from_month >= v.start_date.slice(0, 7), "finance_employment_versions month");
  CHECK((v.supersedes_version_id === null) === (v.effective_from_month === v.start_date.slice(0, 7)), "finance_employment_versions first");
  CHECK(v.end_date === null || v.supersedes_version_id === null || v.end_date >= firstOf(v.effective_from_month), "finance_employment_versions end");
  CHECK((v.pension_estimate_minor === null || v.pension_estimate_minor > 0) && (v.ni_paye_estimate_minor === null || v.ni_paye_estimate_minor > 0), "finance_employment_versions estimates");
}
function checkItem(i: any) {
  CHECK(/^FEI-[0-9A-F]{12}$/.test(i.item_id) && MONTH.test(i.month) && i.salary_minor > 0 && i.pension_estimate_minor >= 0 && i.ni_paye_estimate_minor >= 0 && i.amount_due_minor > 0, "finance_employment_items");
  CHECK(i.estimate_total_minor === i.salary_minor + i.pension_estimate_minor + i.ni_paye_estimate_minor, "finance_employment_items total");
  CHECK(!i.used_estimate || i.amount_due_minor === i.estimate_total_minor, "finance_employment_items use estimate");
  CHECK(i.expected_payment_date.slice(0, 7) === i.month, "finance_employment_items pay date");
  CHECK(i.paid_minor === 0 || i.paid_minor === i.amount_due_minor, "finance_employment_items full payment");
  CHECK((i.paid_minor === 0) === (i.paid_date === null) && (i.paid_date === null) === (i.paid_at === null) && (i.paid_at === null) === (i.paid_by === null), "finance_employment_items paid fields");
  CHECK(i.paid_minor > 0 || (i.payment_method === null && i.payment_reference === null && i.payment_note === null), "finance_employment_items payment fields");
}
function insertAssignment(p: any) {
  const org = p.organisation_id;
  const ag = T_("finance_supplier_agreements").find((x) => x.organisation_id === org && x.agreement_id === p.agreement_id);
  if (!ag) no15("agreement_not_found");
  if (ag.classification !== "general") no15("not_an_overhead");
  const c = T_("finance_overhead_categories").find((x) => x.organisation_id === org && x.category_id === p.category_id);
  if (!c) no15("category_not_found");
  if (!c.active) no15("category_inactive");
  if (c.name !== p.category_name_at_assignment) no15("snapshot_mismatch");
  if (T_("finance_overhead_assignments").some((x) => x.organisation_id === org && x.agreement_id === p.agreement_id)) no15("already_categorised");
  CHECK(/^FOA-[0-9A-F]{12}$/.test(p.assignment_id), "finance_overhead_assignments");
  T_("finance_overhead_assignments").push({ ...p });
}
export function ohRpcBody(fn: string, a: any): unknown {
  if (fn === "finance_overhead_category_write") {
    const c = a.p_category;
    checkCategory(c);
    const rows = T_("finance_overhead_categories");
    if (rows.some((x) => x.organisation_id === c.organisation_id && x.category_id !== c.category_id && x.name.toLowerCase() === c.name.toLowerCase())) throw new Error('duplicate key value violates unique constraint "finance_overhead_categories_name_unique"');
    if (a.p_expected_revision === null) {
      if (rows.some((x) => x.organisation_id === c.organisation_id && x.category_id === c.category_id)) throw new Error("categories pkey");
      rows.push({ ...c });
    } else {
      const k = rows.findIndex((x) => x.organisation_id === c.organisation_id && x.category_id === c.category_id);
      if (k < 0) no15("category_not_found");
      if (rows[k].revision !== a.p_expected_revision) no15("category_changed");
      if (c.created_at !== rows[k].created_at || c.created_by !== rows[k].created_by || c.revision !== rows[k].revision + 1) no15("history_is_append_only");
      rows[k] = { ...c };
    }
    audit(a.p_events);
    return { category_id: c.category_id };
  }
  if (fn === "finance_overhead_assign") {
    insertAssignment(a.p_assignment);
    audit(a.p_events);
    return { assignment_id: a.p_assignment.assignment_id };
  }
  if (fn === "finance_overhead_version_record") {
    const ag = a.p_agreement;
    const org = ag.organisation_id;
    if (ag.supersedes_agreement_id === null || ag.classification !== "general") no15("not_an_overhead");
    if (!T_("finance_supplier_agreements").some((x) => x.organisation_id === org && x.agreement_id === ag.supersedes_agreement_id && x.classification === "general")) no15("not_an_overhead");
    if (a.p_assignment.organisation_id !== org || a.p_assignment.agreement_id !== ag.agreement_id) no15("snapshot_mismatch");
    const v = rpcBody("finance_supplier_agreement_record", { p_agreement: ag, p_allocations: a.p_allocations, p_instalments: a.p_instalments, p_cancel: a.p_cancel, p_events: a.p_events }) as Record<string, unknown>;
    insertAssignment(a.p_assignment);
    return { ...v, assignment_id: a.p_assignment.assignment_id };
  }
  if (fn === "finance_employment_version_record") {
    const v = a.p_version;
    const org = v.organisation_id;
    const vers = T_("finance_employment_versions");
    const cat = T_("finance_overhead_categories").find((x) => x.organisation_id === org && x.category_id === v.category_id);
    if (!cat) no15("category_not_found");
    if (v.supersedes_version_id === null) {
      if (!cat.active) no15("category_inactive");
      if (vers.some((x) => x.organisation_id === org && x.employment_id === v.employment_id)) no15("employment_exists");
      if (v.person_ref !== null && vers.some((x) => x.organisation_id === org && x.person_ref === v.person_ref)) no15("employment_exists");
    } else {
      const p = vers.find((x) => x.organisation_id === org && x.version_id === v.supersedes_version_id);
      if (!p || p.employment_id !== v.employment_id) no15("employment_not_found");
      if (vers.some((x) => x.organisation_id === org && x.supersedes_version_id === v.supersedes_version_id)) no15("already_versioned");
      if (v.effective_from_month <= p.effective_from_month) no15("version_must_start_later");
      if (p.category_id !== v.category_id && !cat.active) no15("category_inactive");
      if (v.start_date !== p.start_date || v.person_ref !== p.person_ref) no15("snapshot_mismatch");
      if (T_("finance_employment_items").some((x) => x.organisation_id === org && x.employment_id === v.employment_id && x.month >= v.effective_from_month)) no15("confirmed_month_after_change");
      if (v.end_date !== null && v.end_date < firstOf(v.effective_from_month)) no15("end_before_version_start");
    }
    checkVersion(v);
    if (vers.some((x) => x.organisation_id === org && x.version_id === v.version_id)) throw new Error("versions pkey");
    if (vers.some((x) => x.organisation_id === org && x.employment_id === v.employment_id && x.effective_from_month === v.effective_from_month)) throw new Error("versions month unique");
    vers.push({ ...v });
    audit(a.p_events);
    return { employment_id: v.employment_id, version_id: v.version_id };
  }
  if (fn === "finance_employment_item_change") {
    const it = a.p_item;
    const org = it.organisation_id;
    const items = T_("finance_employment_items");
    if (a.p_kind === "confirm") {
      const ver = T_("finance_employment_versions").find((x) => x.organisation_id === org && x.version_id === it.version_id);
      if (!ver || ver.employment_id !== it.employment_id) no15("employment_not_found");
      const gov = T_("finance_employment_versions")
        .filter((x) => x.organisation_id === org && x.employment_id === it.employment_id && x.effective_from_month <= it.month)
        .sort((x, y) => (x.effective_from_month < y.effective_from_month ? 1 : -1))[0];
      if (!gov) no15("month_not_employed");
      if (gov.version_id !== ver.version_id) no15("employment_changed");
      if (ver.start_date > lastOf(it.month) || (ver.end_date !== null && ver.end_date < firstOf(it.month))) no15("month_not_employed");
      const salary = Math.round(ver.annual_salary_minor / 12);
      const payDay = Math.min(ver.pay_day, Number(lastOf(it.month).slice(8, 10)));
      if (it.salary_minor !== salary || it.pension_estimate_minor !== (ver.pension_estimate_minor ?? 0) || it.ni_paye_estimate_minor !== (ver.ni_paye_estimate_minor ?? 0) || it.expected_payment_date !== `${it.month}-${String(payDay).padStart(2, "0")}` || it.paid_minor !== 0 || it.paid_date !== null) no15("snapshot_mismatch");
      if (items.some((x) => x.organisation_id === org && x.employment_id === it.employment_id && x.month === it.month)) no15("already_confirmed");
      checkItem(it);
      items.push({ ...it });
    } else if (a.p_kind === "payment") {
      const k = items.findIndex((x) => x.organisation_id === org && x.item_id === it.item_id);
      if (k < 0) no15("item_not_found");
      const old = items[k];
      if (old.paid_minor !== a.p_expected.paid_minor) no15("item_changed");
      if (old.paid_minor === old.amount_due_minor) no15("already_paid");
      if (it.paid_minor !== old.amount_due_minor) no15("partial_payment_not_supported");
      if (it.paid_date === null) no15("snapshot_mismatch");
      const n = { ...old, paid_minor: old.amount_due_minor, paid_date: it.paid_date, payment_method: it.payment_method, payment_reference: it.payment_reference, payment_note: it.payment_note, paid_at: it.paid_at, paid_by: it.paid_by };
      checkItem(n);
      items[k] = n;
    } else no15("unknown_change");
    audit(a.p_events);
    return { item_id: it.item_id, kind: a.p_kind };
  }
  throw new Error(`unknown rpc ${fn}`);
}
export function ohRpcFn(fn: string, a: any): unknown {
  const snap = JSON.stringify({ sb: world.sb, audit: world.audit });
  try {
    return ohRpcBody(fn, a);
  } catch (e) {
    const s = JSON.parse(snap);
    world.sb = s.sb;
    world.audit = s.audit;
    throw e;
  }
}
void rpcFn;

/** Guard triggers: the API never writes the F15 tables directly; a direct UPDATE / DELETE is refused like the SQL guards. */
export const directWrite = (table: string): { ok: false; message: string } => ({ ok: false, message: OH_TABLES.includes(table) ? "f15:history_is_append_only" : "not an F15 table" });

export const fetchLog: string[] = [];
/** Test switches: Coaches answers every row (a loose formula), and one F15 table read leaks another organisation's rows. */
export const fake = { coachesIgnoreFormula: false, leakTable: null as string | null, lastCoachesUrl: "" };
const base = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  fetchLog.push(`${method} ${url.replace(/\?.*$/, "")}`);
  const m = /\/rpc\/(finance_overhead_[a-z_]+|finance_employment_[a-z_]+)$/.exec(url);
  if (m) {
    await tick();
    world.rpcCalls++;
    try {
      return json(ohRpcFn(m[1], init.body ? JSON.parse(init.body) : undefined));
    } catch (e) {
      if (e instanceof Refused15 || /^f1[34]:/.test(String((e as Error).message))) return json({ code: "P0001", message: (e as Error).message }, 400);
      return json({ message: String(e) }, 400);
    }
  }
  if (url.startsWith("https://api.airtable.com/") && decodeURIComponent(new URL(url).pathname).endsWith("/Coaches")) {
    await tick();
    if (method !== "GET") {
      world.airtableWrites++;
      return json({ error: "F15 must not write Airtable" }, 418);
    }
    world.airtableReads.push("Coaches");
    fake.lastCoachesUrl = new URL(url).searchParams.get("filterByFormula") ?? "";
    const f = new URL(url).searchParams.get("filterByFormula") ?? "";
    const ref = /\{Coach ID\}='([^']+)'/.exec(f)?.[1];
    return json({ records: (world.at.Coaches ?? []).filter((r) => (ref && !fake.coachesIgnoreFormula ? r.fields["Coach ID"] === ref : true)) });
  }
  if (fake.leakTable && url.includes(`/rest/v1/${fake.leakTable}?`) && method === "GET") {
    await tick();
    return json(T_(fake.leakTable));
  }
  return base(input, init);
}) as typeof fetch;

// ----- request helpers (parse exactly as index.ts does, then orchestrate) -----
export const catNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseCategory(JSON.stringify(body), isTenantKey, true);
  return p.ok ? createCategory(deps, caller, p) : err(p);
};
export const catEdit = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseCategory(JSON.stringify(body), isTenantKey, false);
  return p.ok ? updateCategory(deps, caller, id, p) : err(p);
};
export const categorise = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseCategorise(JSON.stringify(body), isTenantKey);
  return p.ok ? categoriseOverhead(deps, caller, p) : err(p);
};
export const overheadVersion = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseOverheadVersion(JSON.stringify(body), isTenantKey);
  return p.ok ? versionOverhead(deps, caller, id, p) : err(p);
};
export const empNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseEmploymentCreate(JSON.stringify(body), isTenantKey);
  return p.ok ? createEmployment(deps, caller, p.spec) : err(p);
};
export const empVersion = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseEmploymentVersion(JSON.stringify(body), isTenantKey);
  return p.ok ? versionEmployment(deps, caller, id, p) : err(p);
};
export const monthAct = (id: string, month: string, action: ItemAction, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseItemAction(action, JSON.stringify(body), isTenantKey);
  return p.ok ? employmentItemAction(deps, caller, id, month, action, p.input) : err(p);
};
export const cats = (q: { active?: boolean } = {}, caller: any = mgr) => listCategories(deps, caller, q) as Promise<any>;
export const cat = (id: string, caller: any = mgr) => readCategory(deps, caller, id) as Promise<any>;
export const overheads = (q: { categoryId?: string; month?: string } = {}, caller: any = mgr) => listOverheads(deps, caller, q) as Promise<any>;
export const overhead = (id: string, caller: any = mgr) => readOverhead(deps, caller, id) as Promise<any>;
export const emps = (q: { active?: boolean } = {}, caller: any = mgr) => listEmployment(deps, caller, q) as Promise<any>;
export const emp = (id: string, q: { fromMonth?: string; toMonth?: string } = {}, caller: any = mgr) => readEmployment(deps, caller, id, q) as Promise<any>;
export const facts = (q: { fromMonth?: string; toMonth?: string } = {}, caller: any = mgr) => listOverheadFacts(deps, caller, q) as Promise<any>;
export { ORG, MGR, ID };
