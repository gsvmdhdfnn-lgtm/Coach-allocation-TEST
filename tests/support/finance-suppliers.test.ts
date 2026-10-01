/**
 * Finance Foundation F13 - suppliers / venues / outgoing agreements + payment schedules.
 * Run: node --experimental-strip-types tests/support/finance-suppliers.test.ts
 *
 *   SA  supplier / agreement (create, venue agreement, effective-date history, no rewrite, custom amounts)  brief 1-5
 *   VP  venue profitability (equal spread, cancellation keeps it, explicit change, unresolved link)       brief 6-9
 *   PS  payment schedule (monthly, quarterly, annual, custom dates, estimate, Use Estimate != Paid)       brief 10-15
 *   PM  partial / move / split (partial, remaining, move, split, no duplicate, overpay, concurrency)       brief 16-22
 *   CH  cancel / history (cancel unpaid, paid never rewritten, agreement change keeps paid)                brief 23-25
 *   CT  contractor (non-Coach contractor, expected monthly hours, confirmed actual)                        brief 26-28
 *   AC  access (View, Manage, no grant, coach / parent, module off, tenant)                                brief 29-34
 *   AU  audit (writes exact, reads none, refusals none)                                                    brief 35-36
 *   Z   code / drift checks against the canonical files (no credit / Cash Flow route, pure, mirrors)
 *
 * The REAL F13 orchestrator + repository run against an in-memory world:
 * fake Airtable (Sessions, Session Occurrences, Venues, Feature Controls,
 * Organisation & Branding), fake PostgREST + fake finance_supplier_* database
 * functions with the same rules, CHECKs and guard triggers as the TEST SQL.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import {
  type InstalmentAction,
  EVENTS,
  hourlyEstimate,
  hoursToHundredths,
  matchSupplierRoute,
  parseAction,
  parseAgreement,
  parseSupplierCreate,
  parseSupplierQuery,
  parseSupplierUpdate,
  spreadEvenly,
  addMonthsAnchored,
  generateSchedule,
  planChange,
} from "./finance-suppliers.ts";
import {
  type SupplierDeps,
  changeInstalmentAction,
  createAgreement,
  createSupplier,
  listAgreements,
  listCostFacts,
  listInstalments,
  listSuppliers,
  readAgreement,
  readInstalment,
  readSupplier,
  updateSupplier,
  versionAgreement,
} from "./finance-suppliers-orchestrator.ts";
import { SupplierRefusal, changeInstalment, loadSupplierLedger } from "./finance-suppliers-repository.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

const ORG = "ORG-TEST-001";
const ORG_REC = "recYXqi1DTZ8ZECPQ";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const VIEWER = "aaaaaaaa-e0d4-4257-8121-5f16781e97ba";
const NOGRANT = "bbbbbbbb-e0d4-4257-8121-5f16781e97ba";
const g = (level: unknown): FinanceGrantRow => ({ organisation_id: ORG, access_level: level, revoked_at: null });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
const viewer = { userId: VIEWER, role: "management", active: true, organisationId: ORG };
const nogrant = { userId: NOGRANT, role: "management", active: true, organisationId: ORG };
const coach = { userId: MGR, role: "coach", active: true, organisationId: ORG };
const parent = { userId: MGR, role: "parent", active: true, organisationId: ORG };
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };

const rid = (p: string) => `rec${p.padEnd(14, "0").slice(0, 14)}`;
const VENUE_REC = rid("VenueA");
const SA = rid("SessVenA"), SB = rid("SessVenB"), SN = rid("SessNoSvc"), SE = rid("SessEmpty"), SD1 = rid("SessDup1"), SD2 = rid("SessDup2");

type Row = { id: string; fields: Record<string, any> };
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  at: Record<string, Row[]>;
  sb: Record<string, Record<string, any>[]>;
  audit: any[];
  lockHeld: string | null;
  airtableWrites: number;
  airtableReads: string[];
  rpcCalls: number;
}
let world: World;
const NOW = new Date("2026-10-15T12:00:00.000Z");
let seq = 0;
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

const occ = (key: string, date: string, session: string, status: string) => ({ id: rid(key), fields: { "Occurrence ID": `OCC-${key}:${date}`, Date: date, Status: status, Session: [session] } });
const A_DATES = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03"];

function reset() {
  seq = 0;
  const occA = A_DATES.map((d, k) => occ(`OccA${k}`, d, SA, d < "2026-10-15" ? "Completed" : "Scheduled"));
  occA.push(occ("OccAX", "2026-12-10", SA, "Cancelled"), occ("OccAP", "2026-12-17", SA, "Postponed"), occ("OccAL", "2027-01-07", SA, "Scheduled"));
  const occB = ["2026-11-02", "2026-11-09", "2026-11-16"].map((d, k) => occ(`OccB${k}`, d, SB, "Scheduled"));
  const occN = ["2026-10-05", "2026-10-12"].map((d, k) => occ(`OccN${k}`, d, SN, "Completed"));
  const occD = [occ("OccD0", "2026-11-03", SD1, "Scheduled"), occ("OccD1", "2026-11-04", SD2, "Scheduled")];
  const session = (id: string, sid: string, name: string, programme: string | null, fsv: string | null, occs: Row[]) => ({ id, fields: { "Session ID": sid, "Session Name": name, Programme: programme, "Finance Service ID": fsv, "Session Occurrences": occs.map((o) => o.id) } });
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [] },
    moduleOn: true,
    at: {
      "Organisation & Branding": [ORG_ROW],
      Sessions: [
        session(SA, "ZZ-VENUE-A", "ZZTEST Venue A Academy", "Academy", "FSV-AAAAAAAAAAAA", occA),
        session(SB, "ZZ-VENUE-B", "ZZTEST Venue B After School", "After School", "FSV-BBBBBBBBBBBB", occB),
        session(SN, "ZZ-NOSVC", "ZZTEST No Service", "Camps", null, occN),
        session(SE, "ZZ-EMPTY", "ZZTEST Empty", "Holiday", "FSV-CCCCCCCCCCCC", []),
        session(SD1, "ZZ-DUP", "ZZTEST Dup 1", "Academy", "FSV-DDDDDDDDDDDD", [occD[0]]),
        session(SD2, "ZZ-DUP", "ZZTEST Dup 2", "Academy", "FSV-DDDDDDDDDDDD", [occD[1]]),
      ],
      "Session Occurrences": [...occA, ...occB, ...occN, ...occD],
      Venues: [{ id: VENUE_REC, fields: { "Venue Name": "ZZTEST Venue Hall", "Venue ID": "VEN-ZZ-A" } }],
    },
    sb: { finance_suppliers: [], finance_supplier_agreements: [], finance_supplier_allocations: [], finance_supplier_instalments: [], finance_supplier_payments: [] },
    audit: [],
    lockHeld: null,
    airtableWrites: 0,
    airtableReads: [],
    rpcCalls: 0,
  };
}
const AT = (t: string) => world.at[t];
const T_ = (t: string) => world.sb[t];

// ----- fake finance_supplier_* database functions (same rules as the TEST SQL) -----
class Refused extends Error {}
const no: (code: string) => never = (code) => {
  throw new Refused(`f13:${code}`);
};
const CHECK = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`${what} check violation`);
};
const ID = { FSU: /^FSU-[0-9A-F]{12}$/, FSA: /^FSA-[0-9A-F]{12}$/, FSI: /^FSI-[0-9A-F]{12}$/, FSP: /^FSP-[0-9A-F]{12}$/ };
const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
function audit(events: any[]) {
  if (!Array.isArray(events) || !events.length) no("audit_missing");
  for (const e of events) CHECK(/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(e.event_type) && /^[a-z][a-z_]*$/.test(e.entity_type), "audit");
  world.audit.push(...events.map((e) => ({ ...e, id: ++seq, occurred_at: NOW.toISOString() })));
}
function checkSupplier(s: any) {
  CHECK(ID.FSU.test(s.supplier_id) && String(s.name ?? "").trim() && ["venue", "contractor", "software_service", "other"].includes(s.supplier_type) && s.revision >= 1, "finance_suppliers");
  CHECK(s.venue_record_id === null || s.supplier_type === "venue", "finance_suppliers venue");
  CHECK(s.vat_treatment === null || ["plus_vat", "vat_included", "no_vat"].includes(s.vat_treatment), "finance_suppliers vat");
}
function checkAgreement(a: any) {
  CHECK(ID.FSA.test(a.agreement_id) && ["fixed", "hourly", "one_off", "scheduled", "custom_dates"].includes(a.cost_type) && ["direct", "general"].includes(a.classification), "agreements");
  CHECK(a.classification === "direct" || a.link_state === "not_applicable", "agreements link/classification");
  CHECK(a.link_state !== "linked" || a.allocation_count > 0, "agreements linked/allocation");
  CHECK((a.cost_type === "custom_dates") === (a.frequency === "custom_dates"), "agreements custom/frequency");
  CHECK(a.cost_type !== "hourly" || (a.hourly_rate_minor !== null && a.expected_monthly_hours_hundredths !== null && a.frequency === "monthly"), "agreements hourly");
  CHECK(a.instalment_count >= 1 && a.instalment_count <= 120 && a.total_planned_minor > 0 && (a.amount_minor === null || a.amount_minor > 0), "agreements amounts");
  CHECK(a.effective_until === null || a.effective_until >= a.effective_from, "agreements dates");
}
function checkInstalment(i: any) {
  CHECK(ID.FSI.test(i.instalment_id) && i.planned_minor > 0 && i.amount_due_minor > 0 && i.paid_minor >= 0 && [i.planned_minor, i.amount_due_minor, i.paid_minor].every(isInt), "instalments");
  CHECK(i.paid_minor <= i.amount_due_minor, "instalments paid<=due");
  CHECK(i.amount_state === "confirmed" || i.paid_minor === 0, "instalments estimate unpaid");
  CHECK((i.cancelled_at === null) === (i.cancel_reason === null) && (i.cancelled_at === null) === (i.cancelled_by === null), "instalments cancel fields");
  CHECK(i.cancelled_at === null || i.paid_minor === 0, "instalments cancel unpaid");
}
/** finance_supplier_instalment_guard + CHECKs. */
function updateInstalment(org: string, id: string, patch: Record<string, any>) {
  const rows = T_("finance_supplier_instalments");
  const k = rows.findIndex((x) => x.organisation_id === org && x.instalment_id === id);
  const old = rows[k];
  const n = { ...old, ...patch };
  for (const f of ["organisation_id", "instalment_id", "agreement_id", "supplier_id", "sequence", "original_due_date", "planned_minor", "created_at", "created_by", "split_from_instalment_id"]) if (n[f] !== old[f]) no("history_is_append_only");
  if (old.cancelled_at !== null || (old.amount_state === "confirmed" && old.paid_minor === old.amount_due_minor)) no("history_is_append_only");
  if (n.paid_minor < old.paid_minor || (old.amount_state === "confirmed" && n.amount_state === "estimated")) no("history_is_append_only");
  if (n.amount_due_minor > old.amount_due_minor && !(old.amount_state === "estimated" && n.amount_state === "confirmed")) no("history_is_append_only");
  if (n.amount_due_minor !== old.amount_due_minor && n.paid_minor !== old.paid_minor) no("history_is_append_only");
  checkInstalment(n);
  rows[k] = n;
}
function insertInstalments(rows: any[]) {
  for (const i of rows) {
    checkInstalment(i);
    if (T_("finance_supplier_instalments").some((x) => x.organisation_id === i.organisation_id && x.instalment_id === i.instalment_id)) throw new Error("instalments pkey");
    T_("finance_supplier_instalments").push({ ...i });
  }
}
function rpcBody(fn: string, a: any): unknown {
  if (fn === "finance_supplier_write") {
    const s = a.p_supplier;
    checkSupplier(s);
    const rows = T_("finance_suppliers");
    if (a.p_expected_revision === null) {
      if (rows.some((x) => x.organisation_id === s.organisation_id && x.supplier_id === s.supplier_id)) throw new Error("suppliers pkey");
      rows.push({ ...s });
    } else {
      const k = rows.findIndex((x) => x.organisation_id === s.organisation_id && x.supplier_id === s.supplier_id);
      if (k < 0) no("supplier_not_found");
      if (rows[k].revision !== a.p_expected_revision) no("supplier_changed");
      if (s.created_at !== rows[k].created_at || s.created_by !== rows[k].created_by || s.revision !== rows[k].revision + 1) no("history_is_append_only");
      rows[k] = { ...s };
    }
    audit(a.p_events);
    return { supplier_id: s.supplier_id };
  }
  if (fn === "finance_supplier_agreement_record") {
    const ag = a.p_agreement;
    const org = ag.organisation_id;
    const prev = ag.supersedes_agreement_id;
    if (!T_("finance_suppliers").some((x) => x.organisation_id === org && x.supplier_id === ag.supplier_id)) no("supplier_not_found");
    const inst = T_("finance_supplier_instalments");
    if (prev !== null) {
      const p = T_("finance_supplier_agreements").find((x) => x.organisation_id === org && x.agreement_id === prev && x.supplier_id === ag.supplier_id);
      if (!p) no("agreement_not_found");
      if (T_("finance_supplier_agreements").some((x) => x.organisation_id === org && x.supersedes_agreement_id === prev)) no("agreement_already_versioned");
      if (ag.effective_from <= p.effective_from) no("version_must_start_later");
      const after = inst.filter((i) => i.organisation_id === org && i.agreement_id === prev && i.due_date >= ag.effective_from);
      if (after.some((i) => i.paid_minor > 0)) no("paid_instalment_after_change");
      const open = after.filter((i) => i.cancelled_at === null);
      if (open.length !== a.p_cancel.length || a.p_cancel.some((c: any) => !open.some((i) => i.instalment_id === c.instalment_id && i.paid_minor === 0))) no("agreement_changed");
    } else if (a.p_cancel.length !== 0) no("snapshot_mismatch");
    checkAgreement(ag);
    T_("finance_supplier_agreements").push({ ...ag });
    for (const x of a.p_allocations) {
      CHECK(/^rec[A-Za-z0-9]{14}$/.test(x.occurrence_record_id) && isInt(x.allocated_minor) && x.allocated_minor >= 0, "allocations");
      if (T_("finance_supplier_allocations").some((y) => y.agreement_id === x.agreement_id && y.occurrence_record_id === x.occurrence_record_id)) throw new Error("allocations pkey");
      T_("finance_supplier_allocations").push({ ...x });
    }
    insertInstalments(a.p_instalments);
    for (const c of a.p_cancel) updateInstalment(org, c.instalment_id, { cancelled_at: c.cancelled_at, cancelled_by: c.cancelled_by, cancel_reason: c.cancel_reason });
    const mine = inst.filter((i) => i.organisation_id === org && i.agreement_id === ag.agreement_id);
    const al = T_("finance_supplier_allocations").filter((x) => x.organisation_id === org && x.agreement_id === ag.agreement_id);
    const total = mine.reduce((s, i) => s + i.planned_minor, 0);
    if (total !== ag.total_planned_minor || mine.length !== ag.instalment_count || al.length !== ag.allocation_count || (al.length > 0 && al.reduce((s, x) => s + x.allocated_minor, 0) !== total) || mine.some((i) => i.supplier_id !== ag.supplier_id || i.paid_minor !== 0 || i.cancelled_at !== null)) no("snapshot_mismatch");
    audit(a.p_events);
    return { agreement_id: ag.agreement_id, total_planned_minor: total, instalment_count: mine.length, cancelled: a.p_cancel.length };
  }
  if (fn === "finance_supplier_instalment_change") {
    const org = a.p_org;
    const v = T_("finance_supplier_instalments").find((x) => x.organisation_id === org && x.instalment_id === a.p_instalment_id);
    if (!v) no("instalment_not_found");
    const e = a.p_expected;
    if (v.paid_minor !== e.paid_minor || v.amount_due_minor !== e.amount_due_minor || v.due_date !== e.due_date || v.amount_state !== e.amount_state || (v.cancelled_at !== null) !== e.cancelled) no("instalment_changed");
    if (v.cancelled_at !== null) no("instalment_cancelled");
    const remaining = v.amount_due_minor - v.paid_minor;
    if (remaining === 0) no("instalment_paid");
    const ch = a.p_change;
    if (a.p_kind === "confirm_estimate") {
      if (v.amount_state !== "estimated") no("already_confirmed");
      updateInstalment(org, v.instalment_id, { amount_state: "confirmed", amount_due_minor: ch.amount_due_minor });
    } else if (a.p_kind === "move") {
      updateInstalment(org, v.instalment_id, { due_date: ch.due_date });
    } else if (a.p_kind === "split") {
      const kids = a.p_new_instalments;
      const sumKids = kids.reduce((s: number, x: any) => s + x.amount_due_minor, 0);
      if (!kids.length || ch.amount_due_minor - v.paid_minor <= 0 || ch.amount_due_minor + sumKids !== v.amount_due_minor) no("split_mismatch");
      updateInstalment(org, v.instalment_id, { amount_due_minor: ch.amount_due_minor, due_date: ch.due_date });
      insertInstalments(kids);
      if (kids.some((n: any) => n.split_from_instalment_id !== v.instalment_id || n.agreement_id !== v.agreement_id || n.amount_state !== v.amount_state || n.paid_minor !== 0)) no("split_mismatch");
    } else if (a.p_kind === "payment") {
      if (v.amount_state !== "confirmed") no("amount_still_estimated");
      const amt = a.p_payment.amount_minor;
      if (amt <= 0 || amt > remaining) no("overpayment");
      if (a.p_payment.remaining_after_minor !== remaining - amt || a.p_payment.instalment_id !== v.instalment_id) no("snapshot_mismatch");
      updateInstalment(org, v.instalment_id, { paid_minor: v.paid_minor + amt });
      CHECK(ID.FSP.test(a.p_payment.payment_id) && a.p_payment.remaining_after_minor >= 0, "payments");
      T_("finance_supplier_payments").push({ ...a.p_payment });
    } else if (a.p_kind === "cancel") {
      if (v.paid_minor !== 0) no("instalment_partially_paid");
      updateInstalment(org, v.instalment_id, { cancelled_at: ch.cancelled_at, cancelled_by: ch.cancelled_by, cancel_reason: ch.cancel_reason });
    } else no("unknown_change");
    audit(a.p_events);
    return { instalment_id: v.instalment_id, kind: a.p_kind };
  }
  throw new Error(`unknown rpc ${fn}`);
}
function rpcFn(fn: string, a: any): unknown {
  const snap = JSON.stringify({ sb: world.sb, audit: world.audit });
  try {
    return rpcBody(fn, a);
  } catch (e) {
    const s = JSON.parse(snap);
    world.sb = s.sb;
    world.audit = s.audit;
    throw e;
  }
}
function postgrest(url: string, method: string): Response {
  const u = new URL(url);
  const table = u.pathname.split("/").pop() as string;
  const rows = table === "finance_audit_events" ? world.audit : world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  // Append-only triggers / RLS: the API never writes these tables directly.
  if (method === "PATCH" || method === "DELETE") return json({ code: "P0001", message: "f13:history_is_append_only" }, 400);
  if (method !== "GET") return json({ message: "F13 writes only through its database functions" }, 403);
  const fs: [string, string][] = [];
  let order: string | null = null;
  for (const [k, v] of u.searchParams) {
    if (k === "order") order = v;
    else if (k !== "select") fs.push([k, v.replace(/^eq\./, "")]);
  }
  let out = rows.filter((r) => fs.every(([k, v]) => String(r[k] ?? "") === v)).map((r) => JSON.parse(JSON.stringify(r)));
  if (order) {
    const keys = order.split(",").map((s) => s.split(".")[0]);
    out = out.sort((x, y) => {
      for (const k of keys) {
        if (x[k] < y[k]) return -1;
        if (x[k] > y[k]) return 1;
      }
      return 0;
    });
  }
  return json(out);
}
function airtable(url: string, method: string): Response {
  if (method !== "GET") {
    world.airtableWrites++;
    return json({ error: "F13 must not write Airtable" }, 418);
  }
  const u = new URL(url);
  const t = decodeURIComponent(u.pathname.split("/").pop() as string);
  world.airtableReads.push(t);
  if (t === "Feature Controls") return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
  let rows = (world.at[t] ?? []).map((r) => JSON.parse(JSON.stringify(r)));
  const f = u.searchParams.get("filterByFormula");
  if (f) {
    const ids = [...f.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]{14})'/g)].map((x) => x[1]);
    const sids = [...f.matchAll(/\{Session ID\}='([^']+)'/g)].map((x) => x[1]);
    const fsv = [...f.matchAll(/\{Finance Service ID\}='([^']+)'/g)].map((x) => x[1]);
    if (ids.length) rows = rows.filter((r) => ids.includes(r.id));
    if (sids.length) rows = rows.filter((r) => sids.includes(r.fields["Session ID"]));
    if (fsv.length) rows = rows.filter((r) => fsv.includes(r.fields["Finance Service ID"]));
  }
  for (const r of rows) for (const k of Object.keys(r.fields)) if (r.fields[k] === null || (Array.isArray(r.fields[k]) && !r.fields[k].length)) delete r.fields[k];
  return json({ records: rows });
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick();
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (url.includes("/rest/v1/finance_access_grants")) {
    const mm = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(mm ? world.grants[mm[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockHeld) return json(null);
    world.lockHeld = `lock-${++seq}`;
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  const rpcMatch = /\/rpc\/(finance_supplier_[a-z_]+)$/.exec(url);
  if (rpcMatch) {
    world.rpcCalls++;
    try {
      return json(rpcFn(rpcMatch[1], body));
    } catch (e) {
      if (e instanceof Refused) return json({ code: "P0001", message: e.message }, 400);
      return json({ message: String(e) }, 400);
    }
  }
  if (url.includes("/rest/v1/")) return postgrest(url, method);
  if (url.startsWith("https://api.airtable.com/")) return airtable(url, method);
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

let rnd = 0;
const deps: SupplierDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  suppliers: { random: () => (++rnd).toString(16).toUpperCase().padStart(12, "A") + "0000" },
};

// ----- request helpers (parse exactly as index.ts does, then orchestrate) -----
const err = (p: any) => Promise.resolve({ status: "error", ...p } as any);
const supplierNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseSupplierCreate(JSON.stringify(body), isTenantKey);
  return p.ok ? createSupplier(deps, caller, p) : err(p);
};
const supplierEdit = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseSupplierUpdate(JSON.stringify(body), isTenantKey);
  return p.ok ? updateSupplier(deps, caller, id, p) : err(p);
};
const agreementNew = (body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseAgreement(JSON.stringify(body), isTenantKey, false);
  return p.ok ? createAgreement(deps, caller, p.supplierId as string, p.spec) : err(p);
};
const agreementVersion = (id: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseAgreement(JSON.stringify(body), isTenantKey, true);
  return p.ok ? versionAgreement(deps, caller, id, p.spec) : err(p);
};
const act = (id: string, action: InstalmentAction, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parseAction(action, JSON.stringify(body), isTenantKey);
  return p.ok ? changeInstalmentAction(deps, caller, id, action, p.input) : err(p);
};
const pay = (id: string, amount: string, paidDate = "2026-10-15", extra: Record<string, unknown> = {}) => act(id, "payment", { amount, paidDate, method: "bank_transfer", ...extra });
const agreement = (id: string, caller: any = mgr) => readAgreement(deps, caller, id) as Promise<any>;
const instalment = (id: string, caller: any = mgr) => readInstalment(deps, caller, id) as Promise<any>;
const dbInst = (id: string) => T_("finance_supplier_instalments").find((x) => x.instalment_id === id) as Record<string, any>;
const dbAgreement = (id: string) => T_("finance_supplier_agreements").find((x) => x.agreement_id === id) as Record<string, any>;
const evTypes = (from: number) => world.audit.slice(from).map((e) => e.event_type);
const snapshot = () => JSON.stringify({ sb: world.sb, audit: world.audit });
const VENUE_BODY = (supplierId: string) => ({
  supplierId,
  name: "ZZTEST Hall hire autumn term",
  description: "Main hall Thursday evenings",
  costType: "custom_dates",
  classification: "direct",
  effectiveFrom: "2026-10-01",
  effectiveUntil: "2026-12-31",
  instalments: [
    { dueDate: "2026-11-20", amount: "500.00", note: "Second half" },
    { dueDate: "2026-10-20", amount: "500.00", note: "First half" },
  ],
  sessionIds: ["ZZ-VENUE-A"],
  sourceDocumentRef: "ZZTEST hall contract 2026-09-12.pdf",
});

async function main() {
  reset();
  // ===== SA. Supplier / agreement =====
  const a0 = world.audit.length;
  const s1 = await supplierNew({ name: "ZZTEST Venue Hall", type: "venue", contactName: "Pat Booking", contactEmail: "bookings@zz.test", contactPhone: "0100 000000", vatTreatment: "vat_included", notes: "Key from caretaker", venueRecordId: VENUE_REC });
  const VEN = s1.body?.supplier?.supplierId as string;
  ck("SA1. Create supplier: 201, FSU id, Venue type label, contact + VAT treatment + venue link stored, revision 1", s1.httpStatus === 201 && /^FSU-[0-9A-F]{12}$/.test(VEN) && s1.body.supplier.typeLabel === "Venue" && s1.body.supplier.contact.email === "bookings@zz.test" && s1.body.supplier.vatTreatment === "vat_included" && s1.body.supplier.technical.venueRecordId === VENUE_REC && s1.body.supplier.revision === 1, JSON.stringify(s1));
  ck("SA1b. ...one finance_supplier.created audit row, no Airtable write", evTypes(a0).join() === EVENTS.supplierCreated && world.audit[a0].record_id === `${ORG}:${VEN}` && world.airtableWrites === 0);
  const dup = await supplierNew({ name: "zztest venue hall", type: "venue" });
  const badVenue = await supplierNew({ name: "ZZTEST Other Hall", type: "venue", venueRecordId: rid("NoSuchVenue") });
  const notVenue = await supplierNew({ name: "ZZTEST Contractor X", type: "contractor", venueRecordId: VENUE_REC });
  const badType = await supplierNew({ name: "ZZTEST Thing", type: "landlord" });
  ck("SA1c. Supplier refusals: same name + type 409 supplier_exists; unknown Venues record 404; venue link on a non-venue 400; unknown type 400", dup.code === "supplier_exists" && badVenue.code === "venue_not_found" && notVenue.httpStatus === 400 && badType.code === "invalid_input" && evTypes(a0).length === 1);
  const up = await supplierEdit(VEN, { contactPhone: "0100 111111", reason: "New booking line" });
  const same = await supplierEdit(VEN, { contactPhone: "0100 111111" });
  ck("SA1d. Supplier update: revision 2, changed fields listed, finance_supplier.updated audited with before/after; no-op 409 nothing_to_change", up.httpStatus === 200 && up.body.supplier.revision === 2 && up.body.changed.join() === "contactPhone" && same.code === "nothing_to_change" && world.audit.at(-1).event_type === EVENTS.supplierUpdated && world.audit.at(-1).before.contact.phone === "0100 000000" && world.audit.at(-1).reason === "New booking line");

  const a1 = world.audit.length;
  const v1 = await agreementNew(VENUE_BODY(VEN));
  const V1 = v1.body?.agreement?.agreementId as string;
  const v1Sched = v1.body?.schedule ?? [];
  ck("SA2. Create venue agreement: 201, FSA id, direct, custom-date schedule sorted by date (2 x 500.00), total 1000.00, source document kept", v1.httpStatus === 201 && /^FSA-[0-9A-F]{12}$/.test(V1) && v1.body.agreement.classification === "direct" && v1Sched.length === 2 && v1Sched[0].dueDate === "2026-10-20" && v1Sched[1].dueDate === "2026-11-20" && v1Sched.every((i: any) => i.amountDue === "500.00" && i.state === "confirmed") && v1.body.agreement.totalPlanned === "1000.00" && v1.body.agreement.sourceDocumentRef === "ZZTEST hall contract 2026-09-12.pdf", JSON.stringify(v1));
  ck("SA2b. ...audited: agreement.created + one instalment.created per instalment (3 rows)", evTypes(a1).join() === [EVENTS.agreementCreated, EVENTS.instalmentCreated, EVENTS.instalmentCreated].join());
  const I1 = v1Sched[0].instalmentId as string;
  const I2 = v1Sched[1].instalmentId as string;
  const custom = await agreementNew({ supplierId: VEN, name: "ZZTEST Pitch deposits", costType: "custom_dates", classification: "general", effectiveFrom: "2026-10-01", instalments: [{ dueDate: "2026-10-31", amount: "250.00" }, { dueDate: "2026-12-31", amount: "400.00" }, { dueDate: "2027-02-28", amount: "350.50", estimated: true }] });
  const cs = custom.body?.schedule ?? [];
  ck("SA5. Custom-date agreement supports DIFFERENT amounts on different dates (250.00 / 400.00 / 350.50 estimated)", custom.httpStatus === 201 && cs.map((i: any) => i.amountDue).join() === "250.00,400.00,350.50" && cs.map((i: any) => i.state).join() === "confirmed,confirmed,estimated" && custom.body.agreement.amountIsEstimate === true && custom.body.agreement.frequency === "custom_dates" && custom.body.agreement.link.state === "not_applicable", JSON.stringify(cs));

  // ===== VP. Venue profitability =====
  {
    const r = await agreement(V1);
    const p = r.body.profitability;
    ck("VP6. Agreement cost spreads equally across the ORIGINAL relevant sessions: 10 x 100.00 (Cancelled 10 Dec, Postponed 17 Dec and the Jan date outside the term excluded)", p.state === "linked" && p.items.length === 10 && p.items.every((x: any) => x.allocated === "100.00") && p.allocatedTotal === "1000.00" && p.items.map((x: any) => x.date).join() === A_DATES.join() && p.byFinanceService.length === 1 && p.byFinanceService[0].financeServiceId === "FSV-AAAAAAAAAAAA" && p.byFinanceService[0].total === "1000.00", JSON.stringify(p));
    ck("VP6b. Profitability (per session) and cash timing (2 x 500.00 instalments) are separate in the read model", r.body.schedule.length === 2 && r.body.schedule.every((i: any) => i.amountDue === "500.00") && /separate/.test(r.body.rule));
    const o = AT("Session Occurrences").find((x) => x.fields.Date === "2026-10-22" && x.fields.Session[0] === SA) as Row;
    o.fields.Status = "Cancelled";
    const r2 = await agreement(V1);
    const p2 = r2.body.profitability;
    const c = p2.items.find((x: any) => x.date === "2026-10-22");
    ck("VP7. A later cancelled occurrence does NOT redistribute: still 10 x 100.00 = 1000.00, the cancelled one marked cancelledSinceAgreement and still counted", p2.items.length === 10 && p2.items.every((x: any) => x.allocated === "100.00") && p2.allocatedTotal === "1000.00" && c.statusNow === "Cancelled" && c.statusAtAgreement === "Scheduled" && c.cancelledSinceAgreement === true && c.counts === true);
    ck("VP7b. ...the frozen allocation rows are unchanged in storage (Finance writes nothing to Airtable)", T_("finance_supplier_allocations").filter((x) => x.agreement_id === V1).every((x) => x.allocated_minor === 10000) && world.airtableWrites === 0);
    const f = (await listCostFacts(deps, mgr, { ok: true, fromMonth: "2026-10", toMonth: "2026-10" })) as any;
    ck("VP7c. Facts (October): profitability = 5 originally agreed Oct sessions x 100.00 incl. the cancelled one; cash = the 500.00 due 20 Oct - reported separately", f.body.profitability.length === 5 && f.body.byFinanceService[0].total === "500.00" && f.body.cashTiming.due.filter((x: any) => x.agreementId === V1).map((x: any) => `${x.instalmentId}:${x.amountDue}`).join() === `${I1}:500.00` && /never mixed/.test(f.body.rule), JSON.stringify(f.body.byFinanceService));
  }

  // ===== PM. Partial / move / split =====
  {
    const a2 = world.audit.length;
    const p1 = await pay(I1, "300.00", "2026-10-15", { reference: "BACS ZZ-001", note: "First part" });
    const i = p1.body?.instalment;
    ck("PM16. Partial payment 300.00 of 500.00: 201, state Partially Paid, paid 300.00", p1.httpStatus === 201 && i.state === "partially_paid" && i.stateLabel === "Partially Paid" && i.paid === "300.00", JSON.stringify(p1));
    ck("PM17. Remaining balance 200.00; original obligation preserved (planned 500.00, amount due 500.00, original due date 20 Oct)", i.remaining === "200.00" && i.plannedAmount === "500.00" && i.amountDue === "500.00" && i.originalDueDate === "2026-10-20");
    ck("PM17b. Payment record: amount, date, method, reference, actor, remaining after; Management-confirmed (not bank truth)", p1.body.payment.amount === "300.00" && p1.body.payment.paidDate === "2026-10-15" && p1.body.payment.method === "bank_transfer" && p1.body.payment.reference === "BACS ZZ-001" && p1.body.payment.recordedBy === MGR && p1.body.payment.remainingAfter === "200.00" && p1.body.payment.source === "management_confirmed");
    ck("PM17c. ...audited once as finance_supplier_instalment.partially_paid", evTypes(a2).join() === EVENTS.partiallyPaid);
    const mv = await act(I1, "move", { dueDate: "2026-11-01", reason: "Remaining 200.00 agreed for 1 Nov" });
    ck("PM18. Remaining balance moved to a new date: due 1 Nov, original due date kept, paid 300.00 / remaining 200.00 unchanged, moved flag", mv.httpStatus === 200 && mv.body.instalment.dueDate === "2026-11-01" && mv.body.instalment.originalDueDate === "2026-10-20" && mv.body.instalment.moved === true && mv.body.instalment.paid === "300.00" && mv.body.instalment.remaining === "200.00" && world.audit.at(-1).event_type === EVENTS.moved && world.audit.at(-1).reason === "Remaining 200.00 agreed for 1 Nov");
    ck("PM20. No duplicate payment created by the move: still exactly one payment row of 300.00", T_("finance_supplier_payments").filter((x) => x.instalment_id === I1).length === 1);
    const before = snapshot();
    const over = await pay(I1, "250.00");
    const future = await pay(I1, "10.00", "2026-10-16");
    const moveSame = await act(I1, "move", { dueDate: "2026-11-01", reason: "x" });
    const noReason = await act(I1, "move", { dueDate: "2026-11-02" });
    ck("PM21. Overpayment refused (409 overpayment: 250.00 > 200.00 remaining); future paid date 400; same-date move 409; move needs a reason - nothing changed", over.httpStatus === 409 && over.code === "overpayment" && future.httpStatus === 400 && moveSame.code === "nothing_to_change" && noReason.code === "invalid_input" && snapshot() === before);
    const [c1, c2] = await Promise.all([pay(I1, "200.00"), pay(I1, "200.00")]);
    const ok = [c1, c2].filter((x) => x.httpStatus === 201);
    const busy = [c1, c2].filter((x) => x.code === "finance_commercial_busy");
    ck("PM22. Concurrent payments: exactly one succeeds, the other is 409 finance_commercial_busy (shared Finance write lock); paid 500.00, never 700.00", ok.length === 1 && busy.length === 1 && dbInst(I1).paid_minor === 50000 && T_("finance_supplier_payments").filter((x) => x.instalment_id === I1).length === 2);
    const again = await pay(I1, "200.00");
    ck("PM22b. The retried duplicate is refused (409 instalment_paid) - state Paid, remaining 0.00", again.code === "instalment_paid" && ok[0].body.instalment.state === "paid" && ok[0].body.instalment.remaining === "0.00" && world.audit.at(-1).event_type === EVENTS.paid);
    // Database-level protection even if two API calls both passed planning.
    const ledger = await loadSupplierLedger(deps.grants, ORG);
    const fresh = ledger.instalments.find((x) => x.instalmentId === I2)!;
    const stale = { ...fresh, paidMinor: 0, amountDueMinor: 40000 };
    let dbStale = "";
    let dbOver = "";
    const payRow = (amount: number, remainingAfter: number) => ({ organisationId: ORG, paymentId: "FSP-0000000000AA", instalmentId: I2, agreementId: V1, supplierId: VEN, amountMinor: amount, paidDate: "2026-10-15", method: null, reference: null, note: null, remainingAfterMinor: remainingAfter, recordedAt: NOW.toISOString(), recordedBy: MGR });
    const ev = [{ organisation_id: ORG, actor_user_id: MGR, event_type: "finance_supplier_instalment.paid", entity_type: "finance_supplier_instalment", record_id: `${ORG}:${I2}`, before: null, after: {}, reason: null, context: {} }];
    try {
      await changeInstalment(deps.grants, stale, "payment", {}, [], payRow(40000, 0), ev);
    } catch (e) {
      dbStale = e instanceof SupplierRefusal ? e.code : String(e);
    }
    try {
      await changeInstalment(deps.grants, fresh, "payment", {}, [], payRow(60000, -10000), ev);
    } catch (e) {
      dbOver = e instanceof SupplierRefusal ? e.code : String(e);
    }
    ck("PM22c. The database function re-checks too: a stale expected state is f13:instalment_changed; an overpaying payment is f13:overpayment (no row, no audit)", dbStale === "instalment_changed" && dbOver === "overpayment" && T_("finance_supplier_payments").filter((x) => x.instalment_id === I2).length === 0);
    const a3 = world.audit.length;
    const bad = await act(I2, "split", { parts: [{ dueDate: "2026-11-10", amount: "200.00" }, { dueDate: "2026-11-20", amount: "200.00" }], reason: "Venue asked to split" });
    const sp = await act(I2, "split", { parts: [{ dueDate: "2026-11-10", amount: "200.00" }, { dueDate: "2026-11-19", amount: "300.00" }], reason: "Venue asked to split" });
    const kid = sp.body?.newInstalments?.[0];
    ck("PM19. Future instalment split: parts must add up (400.00 != 500.00 -> 409 split_mismatch); 200.00 stays on the original (due 10 Nov), 300.00 becomes a child due 19 Nov", bad.code === "split_mismatch" && sp.httpStatus === 201 && sp.body.instalment.amountDue === "200.00" && sp.body.instalment.dueDate === "2026-11-10" && sp.body.instalment.plannedAmount === "500.00" && kid.amountDue === "300.00" && kid.dueDate === "2026-11-19" && kid.splitFrom === I2, JSON.stringify(sp));
    ck("PM19b. ...audited: instalment.split + instalment.created for the child; total due on the agreement still 1000.00", evTypes(a3).join() === [EVENTS.split, EVENTS.instalmentCreated].join() && T_("finance_supplier_instalments").filter((x) => x.agreement_id === V1 && x.cancelled_at === null).reduce((s, x) => s + x.amount_due_minor, 0) === 100000);
    const r = await instalment(I1);
    ck("PM20b. Instalment history (from the audit trail): created -> partially_paid -> moved -> paid; payments listed with their dates", r.body.history.map((h: any) => h.event).join() === [EVENTS.instalmentCreated, EVENTS.partiallyPaid, EVENTS.moved, EVENTS.paid].join() && r.body.instalment.payments.length === 2 && r.body.instalment.payments.every((p: any) => p.paidDate === "2026-10-15"));
    (globalThis as any).__ids = { kid: kid.instalmentId };
  }
  const KID = (globalThis as any).__ids.kid as string;

  // ===== SA3/4, VP8, CH25. Explicit agreement change (new version) =====
  {
    const v1Row = JSON.stringify(dbAgreement(V1));
    const v1Alloc = JSON.stringify(T_("finance_supplier_allocations").filter((x) => x.agreement_id === V1));
    const i1Row = JSON.stringify(dbInst(I1));
    const before = snapshot();
    const past = await agreementVersion(V1, { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-10-10", amount: "1.00", firstDueDate: "2026-10-20", reason: "x" });
    const early = await agreementVersion(V1, { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-09-01", amount: "1.00", firstDueDate: "2026-10-20", reason: "x" });
    const noReason = await agreementVersion(V1, { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-11-19", amount: "1.00", firstDueDate: "2026-11-20" });
    ck("VP8a. A change is explicit: a version needs a reason (400), must start after the old one (409 version_must_start_later) and today or later (409 version_cannot_start_in_past)", noReason.httpStatus === 400 && early.code === "version_must_start_later" && past.code === "version_cannot_start_in_past" && snapshot() === before);
    const a4 = world.audit.length;
    const v2 = await agreementVersion(V1, { name: "ZZTEST Hall hire from 19 Nov (new rate)", costType: "custom_dates", classification: "direct", effectiveFrom: "2026-11-19", effectiveUntil: "2026-12-31", instalments: [{ dueDate: "2026-11-25", amount: "600.00" }], sessionIds: ["ZZ-VENUE-A"], reason: "Venue changed the rate from 19 Nov", sourceDocumentRef: "ZZTEST hall contract v2.pdf" });
    const V2 = v2.body?.agreement?.agreementId as string;
    ck("VP8. Changed agreement handled explicitly: new version 201 (supersedes V1), 3 remaining sessions x 200.00; V1's unpaid instalment due ON the new start date (the 300.00 child due 19 Nov) cancelled with the version as reason", v2.httpStatus === 201 && v2.body.agreement.versions.supersedes === V1 && v2.body.profitability.items.length === 3 && v2.body.profitability.items.every((x: any) => x.allocated === "200.00") && v2.body.cancelledPredecessorInstalments.join() === KID && dbInst(KID).cancel_reason === `Superseded by ${V2} from 2026-11-19`, JSON.stringify(v2));
    ck("VP8b. ...audited: agreement.versioned + instalment.created + instalment.cancelled (supersede) - nothing silent", evTypes(a4).join() === [EVENTS.agreementVersioned, EVENTS.instalmentCreated, EVENTS.cancelled].join() && world.audit[a4].reason === "Venue changed the rate from 19 Nov" && world.audit[a4].after.cancelledPredecessorInstalments[0] === KID);
    ck("SA4. A later agreement does NOT rewrite the old one: V1's stored row and frozen allocation rows are byte-identical", JSON.stringify(dbAgreement(V1)) === v1Row && JSON.stringify(T_("finance_supplier_allocations").filter((x) => x.agreement_id === V1)) === v1Alloc);
    ck("CH25. Agreement changes do not rewrite paid instalments: V1's paid 500.00 instalment and its 2 payments are unchanged; the 200.00 part due 10 Nov (before the change) stays open", JSON.stringify(dbInst(I1)) === i1Row && T_("finance_supplier_payments").filter((x) => x.instalment_id === I1).length === 2 && dbInst(I2).cancelled_at === null && dbInst(I2).amount_due_minor === 20000);
    const r1 = await agreement(V1);
    const r2 = await agreement(V2);
    ck("SA3. Effective-date history preserved: V1 effective 1 Oct, ends 18 Nov (day before V2), versions linked both ways; chain V1 -> V2 from either end", r1.body.agreement.effectiveFrom === "2026-10-01" && r1.body.agreement.effectiveUntil === "2026-12-31" && r1.body.agreement.effectiveEnd === "2026-11-18" && r1.body.agreement.versions.supersededBy === V2 && r1.body.agreement.status === "active" && r2.body.agreement.status === "upcoming" && r1.body.versionChain.join() === `${V1},${V2}` && r2.body.versionChain.join() === `${V1},${V2}`);
    const p1 = r1.body.profitability;
    ck("VP8c. V1 profitability: its 3 sessions from 19 Nov (incl. the session ON the start date) are superseded (kept, not counted) -> 7 x 100.00 = 700.00, matching V1's remaining cash (500.00 paid + 200.00 open)", p1.items.filter((x: any) => x.superseded).map((x: any) => x.date).join() === "2026-11-19,2026-11-26,2026-12-03" && p1.allocatedTotal === "700.00" && p1.items.length === 10);
    const calls = world.rpcCalls;
    const again = await agreementVersion(V1, { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-12-01", amount: "1.00", firstDueDate: "2026-12-01", reason: "x" });
    ck("VP8d. An agreement versions once (chain never forks): 409 agreement_already_versioned, refused before any database write (the unique index is the second guard)", again.code === "agreement_already_versioned" && world.rpcCalls === calls);
    const f = (await listCostFacts(deps, mgr, { ok: true, fromMonth: "2026-11", toMonth: "2026-12" })) as any;
    const prof = f.body.profitability as any[];
    ck("VP8e. Nov-Dec facts: V1 counts 5 & 12 Nov (2 x 100.00), V2 counts 19 Nov / 26 Nov / 3 Dec (3 x 200.00) = 800.00; cash by due date: 500.00 (moved to 1 Nov, paid) + 200.00 due 10 Nov + 600.00 due 25 Nov (the cancelled 300.00 is not cash; payments made 15 Oct are outside the range)", prof.length === 5 && f.body.byFinanceService[0].total === "800.00" && f.body.cashTiming.due.filter((x: any) => [V1, V2].includes(x.agreementId)).map((x: any) => `${x.dueDate}:${x.amountDue}`).join() === "2026-11-01:500.00,2026-11-10:200.00,2026-11-25:600.00" && f.body.cashTiming.paid.length === 0, JSON.stringify(f.body.cashTiming.due));
    (globalThis as any).__ids.V2 = V2;
  }

  // ===== VP9. Links =====
  {
    const s2 = await supplierNew({ name: "ZZTEST School Hall B", type: "venue" });
    const VB = s2.body.supplier.supplierId as string;
    const base = (x: Record<string, unknown>) => ({ supplierId: VB, name: "ZZTEST link", costType: "one_off", classification: "direct", effectiveFrom: "2026-10-01", effectiveUntil: "2026-12-31", amount: "100.00", firstDueDate: "2026-12-01", ...x });
    const missing = await agreementNew(base({ sessionIds: ["ZZ-MISSING"] }));
    const empty = await agreementNew(base({ financeServiceId: "FSV-CCCCCCCCCCCC" }));
    const dupId = await agreementNew(base({ sessionIds: ["ZZ-DUP"] }));
    const partial = await agreementNew(base({ sessionIds: ["ZZ-VENUE-B", "ZZ-MISSING"] }));
    ck("VP9. Missing session / service link stays UNRESOLVED (unknown Session ID, Finance Service with no sessions, ambiguous Session ID, and one bad id among good ones) - nothing allocated or guessed", [missing, empty, dupId, partial].every((r) => r.httpStatus === 201 && r.body.agreement.link.state === "unresolved" && r.body.profitability.state === "unresolved" && r.body.profitability.items.length === 0), JSON.stringify(missing.body?.agreement?.link));
    const byFsv = await agreementNew(base({ financeServiceId: "FSV-BBBBBBBBBBBB" }));
    const pb = byFsv.body.profitability;
    ck("VP9b. Linked by stable Finance Service ID: 3 sessions, 100.00 spread 33.34 / 33.33 / 33.33 (exact pence, earliest gets the spare penny), programme After School", byFsv.body.agreement.link.state === "linked" && pb.items.map((x: any) => x.allocated).join() === "33.34,33.33,33.33" && pb.items.every((x: any) => x.programme === "After School" && x.financeServiceId === "FSV-BBBBBBBBBBBB"));
    const noSvc = await agreementNew(base({ sessionIds: ["ZZ-NOSVC"] }));
    ck("VP9c. A linked session with no Finance Service ID is shown as an unresolved programme (resolved: false), never mapped by label", noSvc.body.profitability.byFinanceService.length === 1 && noSvc.body.profitability.byFinanceService[0].resolved === false && noSvc.body.profitability.byFinanceService[0].financeServiceId === null);
    const f = (await listCostFacts(deps, mgr, { ok: true, fromMonth: "2026-10", toMonth: "2026-12" })) as any;
    ck("VP9d. Facts list the 4 unresolved direct agreements separately (never attributed)", f.body.unresolvedDirectAgreements.length === 4 && f.body.unresolvedDirectAgreements.every((u: any) => u.total === "100.00"));
    const gen = await agreementNew({ ...base({ sessionIds: ["ZZ-VENUE-B"] }), classification: "general" });
    const both = await agreementNew(base({ sessionIds: ["ZZ-VENUE-B"], financeServiceId: "FSV-BBBBBBBBBBBB" }));
    const noUntil = await agreementNew({ ...base({ sessionIds: ["ZZ-VENUE-B"] }), effectiveUntil: undefined });
    const noLink = await agreementNew(base({}));
    ck("VP9e. Link validation: a general cost cannot be linked; sessionIds OR financeServiceId (not both, not neither); a direct cost needs effectiveUntil", [gen, both, noUntil, noLink].every((r) => r.httpStatus === 400 && r.code === "invalid_input"));
  }

  // ===== PS. Payment schedules =====
  const sw = await supplierNew({ name: "ZZTEST Booking Software", type: "software_service", contactEmail: "billing@sw.test", vatTreatment: "plus_vat" });
  const SW = sw.body.supplier.supplierId as string;
  {
    const mo = await agreementNew({ supplierId: SW, name: "ZZTEST booking licence", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2027-01-01", amount: "120.00", firstDueDate: "2027-01-31", instalmentCount: 3 });
    ck("PS10. Monthly schedule: 120.00 x 3 from 31 Jan keeps the anchor day (31 Jan, 28 Feb, 31 Mar)", mo.httpStatus === 201 && mo.body.schedule.map((i: any) => `${i.dueDate}:${i.amountDue}`).join() === "2027-01-31:120.00,2027-02-28:120.00,2027-03-31:120.00" && mo.body.agreement.totalPlanned === "360.00" && mo.body.agreement.status === "upcoming", JSON.stringify(mo));
    const q = await agreementNew({ supplierId: SW, name: "ZZTEST support plan", costType: "fixed", frequency: "quarterly", classification: "general", effectiveFrom: "2026-11-01", effectiveUntil: "2027-10-31", amount: "300.00", firstDueDate: "2026-11-01" });
    ck("PS11. Quarterly schedule: 300.00 every 3 months until the agreement ends (1 Nov, 1 Feb, 1 May, 1 Aug)", q.body.schedule.map((i: any) => i.dueDate).join() === "2026-11-01,2027-02-01,2027-05-01,2027-08-01" && q.body.schedule.every((i: any) => i.amountDue === "300.00"));
    const y = await agreementNew({ supplierId: SW, name: "ZZTEST domain + hosting", costType: "fixed", frequency: "annually", classification: "general", effectiveFrom: "2026-12-01", amount: "1200.00", firstDueDate: "2026-12-01", instalmentCount: 2 });
    ck("PS12. Annual schedule: 1200.00 on 1 Dec 2026 and 1 Dec 2027", y.body.schedule.map((i: any) => `${i.dueDate}:${i.amountDue}`).join() === "2026-12-01:1200.00,2027-12-01:1200.00");
    ck("PS13. Custom dates: dates and amounts exactly as given (SA2 / SA5), not forced onto a frequency", addMonthsAnchored("2024-01-31", 1) === "2024-02-29" && addMonthsAnchored("2026-11-30", 3) === "2027-02-28");
    const tooMany = await agreementNew({ supplierId: SW, name: "x", costType: "fixed", frequency: "monthly", classification: "general", effectiveFrom: "2026-11-01", effectiveUntil: "2040-12-31", amount: "1.00", firstDueDate: "2026-11-01" });
    const schedPast = await agreementNew({ supplierId: SW, name: "x", costType: "scheduled", classification: "general", effectiveFrom: "2026-10-01", amount: "50.00", firstDueDate: "2026-10-15" });
    const sched = await agreementNew({ supplierId: SW, name: "ZZTEST data migration", costType: "scheduled", classification: "general", effectiveFrom: "2026-10-01", amount: "750.00", firstDueDate: "2027-03-01" });
    const freqOneOff = await agreementNew({ supplierId: SW, name: "x", costType: "one_off", frequency: "monthly", classification: "general", effectiveFrom: "2026-10-01", amount: "1.00", firstDueDate: "2026-10-20" });
    const floatMoney = await agreementNew({ supplierId: SW, name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-10-01", amount: 12.5, firstDueDate: "2026-10-20" });
    const thirdDp = await agreementNew({ supplierId: SW, name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-10-01", amount: "12.345", firstDueDate: "2026-10-20" });
    ck("PS13b. Schedule limits: >120 instalments 400; scheduled future payment must be after today (400) - 750.00 on 1 Mar is fine; one-off has no frequency; money is a 2dp string (12.5 number / 12.345 refused)", tooMany.httpStatus === 400 && schedPast.httpStatus === 400 && sched.httpStatus === 201 && sched.body.schedule.length === 1 && freqOneOff.httpStatus === 400 && floatMoney.httpStatus === 400 && thirdDp.httpStatus === 400);
    (globalThis as any).__ids.Q = q.body.schedule.map((i: any) => i.instalmentId);
    (globalThis as any).__ids.QA = q.body.agreement.agreementId;
    (globalThis as any).__ids.Y = y.body.schedule.map((i: any) => i.instalmentId);
  }
  const ids = (globalThis as any).__ids;
  {
    const ot = await supplierNew({ name: "ZZTEST Kit Supplier", type: "other" });
    const OT = ot.body.supplier.supplierId as string;
    const est = await agreementNew({ supplierId: OT, name: "ZZTEST cones + bibs", costType: "one_off", classification: "direct", effectiveFrom: "2026-10-01", effectiveUntil: "2026-10-31", amount: "80.00", amountIsEstimate: true, firstDueDate: "2026-10-30", sessionIds: ["ZZ-NOSVC"] });
    const E = est.body.schedule[0].instalmentId as string;
    ck("PS14. Estimated amount: stored, clearly marked Estimated (state estimated, amountIsEstimate), never shown as confirmed/paid", est.httpStatus === 201 && est.body.schedule[0].state === "estimated" && est.body.schedule[0].stateLabel === "Estimated" && est.body.schedule[0].amountIsEstimate === true && est.body.schedule[0].paid === "0.00" && est.body.agreement.amountIsEstimate === true);
    const before = snapshot();
    const payEst = await pay(E, "80.00");
    ck("PS14b. An estimate is never paid as-is: payment refused 409 amount_still_estimated (nothing changed)", payEst.code === "amount_still_estimated" && snapshot() === before);
    const a5 = world.audit.length;
    const both = await act(E, "confirm-estimate", { useEstimate: true, amount: "80.00" });
    const ue = await act(E, "confirm-estimate", { useEstimate: true });
    ck("PS15. Use Estimate confirms the amount due (80.00, state Confirmed) but does NOT mark Paid: paid 0.00, remaining 80.00, no payment row", both.httpStatus === 400 && ue.httpStatus === 200 && ue.body.instalment.state === "confirmed" && ue.body.instalment.amountDue === "80.00" && ue.body.instalment.paid === "0.00" && ue.body.instalment.remaining === "80.00" && !ue.body.payment && T_("finance_supplier_payments").every((x) => x.instalment_id !== E) && /Nothing has been paid/.test(ue.body.note));
    ck("PS15b. ...audited as estimate_confirmed (usedEstimate true, paidStateUnchanged true); confirming twice is 409 already_confirmed", evTypes(a5).join() === EVENTS.estimateConfirmed && world.audit[a5].after.usedEstimate === true && world.audit[a5].after.paidStateUnchanged === true && (await act(E, "confirm-estimate", { useEstimate: true })).code === "already_confirmed");
    const pd = await pay(E, "80.00", "2026-10-14", { method: "card" });
    ck("PS15c. Paid is the separate later action: 80.00 paid by card on 14 Oct -> state Paid", pd.httpStatus === 201 && pd.body.instalment.state === "paid" && pd.body.payment.method === "card");
  }

  // ===== PM19c. Split after a partial payment / CH. cancel + history =====
  {
    const [Q1, Q2, Q3] = ids.Q as string[];
    const s = await act(Q1, "split", { parts: [{ dueDate: "2026-11-01", amount: "100.00" }, { dueDate: "2026-12-01", amount: "200.00" }], reason: "Spread the first quarter" });
    await pay(Q1, "40.00", "2026-10-15");
    const s2 = await act(Q1, "split", { parts: [{ dueDate: "2026-11-15", amount: "30.00" }, { dueDate: "2026-11-30", amount: "30.00" }], reason: "Spread the rest" });
    ck("PM19c. Split the REMAINING amount after a partial payment: 100.00 due, 40.00 paid -> original 70.00 (40.00 paid + 30.00 due 15 Nov), child 30.00 due 30 Nov", s.httpStatus === 201 && s2.httpStatus === 201 && s2.body.instalment.amountDue === "70.00" && s2.body.instalment.paid === "40.00" && s2.body.instalment.remaining === "30.00" && s2.body.newInstalments[0].amountDue === "30.00" && s2.body.newInstalments[0].splitFrom === Q1);
    const [Y1, Y2] = ids.Y as string[];
    const a6 = world.audit.length;
    const cn = await act(Y2, "cancel", { reason: "Not renewing hosting in 2027" });
    ck("CH23. Unpaid future instalment cancelled: state Cancelled, remaining 0.00, reason + actor kept; audited once as instalment.cancelled", cn.httpStatus === 200 && cn.body.instalment.state === "cancelled" && cn.body.instalment.remaining === "0.00" && cn.body.instalment.cancelled.reason === "Not renewing hosting in 2027" && cn.body.instalment.cancelled.by === MGR && evTypes(a6).join() === EVENTS.cancelled);
    const before = snapshot();
    const r1 = await act(Y2, "cancel", { reason: "again" });
    const r2 = await pay(Y2, "1.00");
    const r3 = await act(Y2, "move", { dueDate: "2028-01-01", reason: "x" });
    const r4 = await act(Y1, "cancel", {});
    ck("CH23b. A cancelled instalment never changes again (cancel / pay / move -> 409 instalment_cancelled); cancel needs a reason (400)", [r1, r2, r3].every((r) => r.code === "instalment_cancelled") && r4.code === "invalid_input" && snapshot() === before);
    const p1 = await act(I1, "cancel", { reason: "x" });
    const p2 = await act(I1, "move", { dueDate: "2026-12-01", reason: "x" });
    const p3 = await act(I1, "split", { parts: [{ dueDate: "2026-12-01", amount: "1.00" }, { dueDate: "2026-12-02", amount: "1.00" }], reason: "x" });
    const p4 = await act(Q1, "cancel", { reason: "x" });
    const patch = await fetch(`${deps.grants.supabaseUrl}/rest/v1/finance_supplier_payments?payment_id=eq.x`, { method: "DELETE" });
    ck("CH24. Paid history is never silently cancelled / rewritten: paid -> 409 instalment_paid for cancel / move / split; partially paid -> 409 instalment_partially_paid; payment rows are append-only", [p1, p2, p3].every((r) => r.code === "instalment_paid") && p4.code === "instalment_partially_paid" && patch.status === 400 && snapshot() === before);
    let guard = "";
    try {
      rpcFn("finance_supplier_instalment_change", { p_org: ORG, p_instalment_id: Y2, p_kind: "move", p_expected: { paid_minor: 0, amount_due_minor: 120000, due_date: "2027-12-01", amount_state: "confirmed", cancelled: true }, p_change: { due_date: "2028-01-01" }, p_new_instalments: [], p_payment: null, p_events: [{}] });
    } catch (e) {
      guard = String((e as Error).message);
    }
    let trig = "";
    try {
      updateInstalment(ORG, I1, { paid_minor: 0 });
    } catch (e) {
      trig = String((e as Error).message);
    }
    ck("CH24b. The database refuses it independently (f13:instalment_cancelled from the function, f13:history_is_append_only from the guard trigger)", guard === "f13:instalment_cancelled" && trig === "f13:history_is_append_only");
    // CH25b: a version cannot cancel an instalment that already has money against it.
    await pay(Q2, "10.00", "2026-10-15", { note: "Early part payment" });
    const b2 = snapshot();
    const refused = await agreementVersion(ids.QA, { name: "ZZTEST support plan v2", costType: "fixed", frequency: "quarterly", classification: "general", effectiveFrom: "2027-01-01", effectiveUntil: "2027-10-31", amount: "350.00", firstDueDate: "2027-05-01", reason: "Price rise" });
    ck("CH25b. A new version that would cancel a partly-paid instalment is refused (409 paid_instalment_after_change, ids listed) - nothing written", refused.code === "paid_instalment_after_change" && refused.details.instalmentIds.join() === Q2 && snapshot() === b2);
    const okv = await agreementVersion(ids.QA, { name: "ZZTEST support plan v2", costType: "fixed", frequency: "quarterly", classification: "general", effectiveFrom: "2027-03-01", effectiveUntil: "2027-10-31", amount: "350.00", firstDueDate: "2027-05-01", reason: "Price rise" });
    ck("CH25c. ...a version from 1 Mar keeps the partly-paid Feb instalment (10.00 paid) and cancels only the unpaid May / Aug ones", okv.httpStatus === 201 && okv.body.cancelledPredecessorInstalments.length === 2 && !okv.body.cancelledPredecessorInstalments.includes(Q2) && okv.body.cancelledPredecessorInstalments.includes(Q3) && dbInst(Q2).paid_minor === 1000 && dbInst(Q2).cancelled_at === null && okv.body.schedule.map((i: any) => i.amountDue).join() === "350.00,350.00");
  }

  // ===== CT. Contractor =====
  {
    const c = await supplierNew({ name: "ZZTEST Safeguarding Consultant", type: "contractor", contactName: "Sam Consult" });
    const CS = c.body.supplier.supplierId as string;
    const h = await agreementNew({ supplierId: CS, name: "ZZTEST safeguarding advice", costType: "hourly", classification: "general", effectiveFrom: "2026-10-01", hourlyRate: "25.00", expectedMonthlyHours: "12.5", firstDueDate: "2026-10-31", instalmentCount: 3 });
    ck("CT26. Non-Coach contractor supported as a supplier (type Contractor / Consultant) with a general hourly agreement - no Coach Costs involvement", c.httpStatus === 201 && c.body.supplier.typeLabel === "Contractor / Consultant" && h.httpStatus === 201 && h.body.agreement.costType === "hourly" && h.body.agreement.frequency === "monthly");
    ck("CT27. Expected monthly hours forecast: 25.00 x 12.50 h = 312.50 per month, Estimated (3 months); half-away rounding in pence (25.01 x 12.50 = 312.63)", h.body.schedule.length === 3 && h.body.schedule.every((i: any) => i.amountDue === "312.50" && i.state === "estimated") && h.body.agreement.hourly.rate === "25.00" && h.body.agreement.hourly.expectedMonthlyHours === "12.50" && hourlyEstimate(2501, 1250) === 31263 && hoursToHundredths("12.555") === null && hoursToHundredths("0") === null);
    const H1 = h.body.schedule[0].instalmentId as string;
    const cf = await act(H1, "confirm-estimate", { amount: "287.50", reason: "October actual: 11.5 h" });
    ck("CT28. Confirmed actual monthly cost: ONE amount (287.50) replaces the estimate; the 312.50 forecast stays visible as planned; no timesheet", cf.httpStatus === 200 && cf.body.instalment.amountDue === "287.50" && cf.body.instalment.plannedAmount === "312.50" && cf.body.instalment.state === "confirmed" && world.audit.at(-1).after.estimate === "312.50" && world.audit.at(-1).after.confirmed === "287.50" && world.audit.at(-1).after.usedEstimate === false);
    const sup = (await readSupplier(deps, mgr, CS)) as any;
    ck("CT28b. Supplier view answers the four questions: getting (agreement), paying (287.50 confirmed + 625.00 estimated outstanding), when (3 open instalments), who (contact)", sup.body.whatWeAreGetting.length === 1 && sup.body.whatWeArePaying.outstandingConfirmed === "287.50" && sup.body.whatWeArePaying.outstandingEstimated === "625.00" && sup.body.whenWeArePaying.length === 3 && sup.body.whoWeAreDealingWith.name === "Sam Consult" && sup.body.whatWeArePaying.nextDue.dueDate === "2026-10-31");
    const bad1 = await agreementNew({ supplierId: CS, name: "x", costType: "hourly", classification: "general", effectiveFrom: "2026-10-01", hourlyRate: "25.00", expectedMonthlyHours: "10", firstDueDate: "2026-10-31", instalmentCount: 1, amountIsEstimate: false });
    const bad2 = await agreementNew({ supplierId: CS, name: "x", costType: "hourly", frequency: "quarterly", classification: "general", effectiveFrom: "2026-10-01", hourlyRate: "25.00", expectedMonthlyHours: "10", firstDueDate: "2026-10-31", instalmentCount: 1 });
    const bad3 = await agreementNew({ supplierId: CS, name: "x", costType: "hourly", classification: "general", effectiveFrom: "2026-10-01", hourlyRate: "25.00", expectedMonthlyHours: "10", amount: "250.00", firstDueDate: "2026-10-31", instalmentCount: 1 });
    ck("CT28c. Hourly is always an estimate until confirmed, monthly only, rate x hours (no fixed amount) - each refused 400", [bad1, bad2, bad3].every((r) => r.httpStatus === 400));
    const inactive = await supplierEdit(CS, { active: false, reason: "Engagement ended" });
    const blocked = await agreementNew({ supplierId: CS, name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-10-01", amount: "1.00", firstDueDate: "2026-10-20" });
    ck("CT28d. An inactive supplier keeps its history but takes no new agreement (409 supplier_inactive)", inactive.httpStatus === 200 && blocked.code === "supplier_inactive" && (await readSupplier(deps, mgr, CS) as any).body.schedule.length === 3);
  }

  // ===== Reads =====
  {
    const ls = (await listSuppliers(deps, mgr, { type: "venue" })) as any;
    const all = (await listSuppliers(deps, mgr, {})) as any;
    const ven = ls.body.suppliers.find((x: any) => x.supplierId === VEN);
    ck("RD1. Supplier list filters by type and summarises money: Venue Hall paid to date 500.00, outstanding confirmed 1450.00 (200.00 + 600.00 + 250.00 + 400.00), estimated 350.50", ls.body.suppliers.every((x: any) => x.type === "venue") && all.body.suppliers.length === 5 && ven.money.paidToDate === "500.00" && ven.money.outstandingConfirmed === "1450.00" && ven.money.outstandingEstimated === "350.50" && ven.whatWeGet.length >= 2, JSON.stringify(ven?.money));
    const li = (await listInstalments(deps, mgr, { state: "estimated" })) as any;
    const lr = (await listInstalments(deps, mgr, { supplierId: VEN, from: "2026-11-01", to: "2026-11-30" })) as any;
    ck("RD2. Instalment list filters by state (estimated) and supplier + due-date range", li.body.instalments.length > 0 && li.body.instalments.every((x: any) => x.state === "estimated") && lr.body.instalments.every((x: any) => x.supplierId === VEN && x.dueDate >= "2026-11-01" && x.dueDate <= "2026-11-30") && lr.body.instalments.length === 4);
    const la = (await listAgreements(deps, mgr, { supplierId: VEN })) as any;
    ck("RD3. Agreement list keeps every version (V1 and V2 both listed)", la.body.agreements.filter((x: any) => [V1, ids.V2].includes(x.agreementId)).length === 2);
    const sup = (await readSupplier(deps, mgr, VEN)) as any;
    ck("RD4. Supplier record explains agreement -> schedule -> contact -> payment history (2 payments 300.00 + 200.00)", sup.body.paymentHistory.length === 2 && sup.body.paymentHistory.map((p: any) => p.amount).sort().join() === "200.00,300.00" && sup.body.whoWeAreDealingWith.email === "bookings@zz.test" && sup.body.schedule.length >= 4);
    const nf = (await readSupplier(deps, mgr, "FSU-000000000000")) as any;
    const na = (await readAgreement(deps, mgr, "FSA-000000000000")) as any;
    const ni = (await readInstalment(deps, mgr, "FSI-000000000000")) as any;
    const nx = await act("FSI-000000000000", "cancel", { reason: "x" });
    const nv = await agreementVersion("FSA-000000000000", { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-12-01", amount: "1.00", firstDueDate: "2026-12-01", reason: "x" });
    ck("RD5. Unknown ids are 404 (supplier / agreement / instalment, reads and writes)", nf.httpStatus === 404 && na.httpStatus === 404 && ni.httpStatus === 404 && nx.httpStatus === 404 && nv.httpStatus === 404);
    ck("RD6. Integer pence everywhere in storage (every *_minor value a safe integer)", Object.values(world.sb).every((rows) => rows.every((r) => Object.entries(r).every(([k, v]) => !k.endsWith("_minor") || v === null || isInt(v)))));
  }

  // ===== AC. Access =====
  {
    const reads = [
      listSuppliers(deps, viewer, {}),
      readSupplier(deps, viewer, VEN),
      listAgreements(deps, viewer, {}),
      readAgreement(deps, viewer, V1),
      listInstalments(deps, viewer, {}),
      readInstalment(deps, viewer, I1),
      listCostFacts(deps, viewer, { ok: true }),
    ];
    const rs = (await Promise.all(reads)) as any[];
    ck("AC29. Finance View reads suppliers, agreements, schedules, payments, history and facts (all 200, access view)", rs.every((r) => r.httpStatus === 200 && r.body.access === "view"));
    const before = snapshot();
    const w = [
      await supplierNew({ name: "ZZTEST View Try", type: "other" }, viewer),
      await supplierEdit(VEN, { notes: "x" }, viewer),
      await agreementNew({ supplierId: VEN, name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-10-01", amount: "1.00", firstDueDate: "2026-10-20" }, viewer),
      await agreementVersion(ids.V2, { name: "x", costType: "one_off", classification: "general", effectiveFrom: "2026-12-01", amount: "1.00", firstDueDate: "2026-12-01", reason: "x" }, viewer),
      await act(I2, "payment", { amount: "1.00", paidDate: "2026-10-15" }, viewer),
      await act(I2, "move", { dueDate: "2026-11-11", reason: "x" }, viewer),
      await act(I2, "split", { parts: [{ dueDate: "2026-11-11", amount: "100.00" }, { dueDate: "2026-11-12", amount: "100.00" }], reason: "x" }, viewer),
      await act(I2, "cancel", { reason: "x" }, viewer),
    ];
    ck("AC30. Finance View cannot write (8 write routes -> 403 finance_manage_required, nothing changed); Manage writes (all of the above)", w.every((r) => r.httpStatus === 403 && r.code === "finance_manage_required") && snapshot() === before);
    const n1 = (await listSuppliers(deps, nogrant, {})) as any;
    const n2 = await act(I2, "cancel", { reason: "x" }, nogrant);
    ck("AC31. No grant: denied for reads and writes (403 finance_access_denied)", n1.code === "finance_access_denied" && n2.code === "finance_access_denied");
    const c1 = (await readSupplier(deps, coach, VEN)) as any;
    const c2 = await supplierNew({ name: "ZZTEST coach", type: "other" }, coach);
    const p1 = (await listInstalments(deps, parent, {})) as any;
    const p2 = await act(I2, "cancel", { reason: "x" }, parent);
    ck("AC32. Coach and Parent denied from the Management Finance API (403 management_required)", c1.code === "management_required" && c2.code === "management_required" && p1.code === "management_required" && p2.code === "management_required");
    world.moduleOn = false;
    const m1 = (await listCostFacts(deps, mgr, { ok: true })) as any;
    const m2 = await supplierNew({ name: "ZZTEST off", type: "other" });
    world.moduleOn = true;
    ck("AC33. module_finance off: reads and writes 403 finance_module_disabled", m1.code === "finance_module_disabled" && m2.code === "finance_module_disabled");
    const t1 = parseSupplierQuery("instalments.list", new URLSearchParams("organisationId=ORG-X"), isTenantKey) as any;
    const t2 = parseSupplierCreate(JSON.stringify({ name: "x", type: "other", org_id: "ORG-X" }), isTenantKey) as any;
    const t3 = parseAgreement(JSON.stringify({ supplierId: VEN, organisation_id: "ORG-X" }), isTenantKey, false) as any;
    const t4 = parseAction("payment", JSON.stringify({ amount: "1.00", paidDate: "2026-10-15", organisationId: "ORG-X" }), isTenantKey) as any;
    ck("AC34. Tenant override rejected in query and every body (400 tenant_param_rejected)", [t1, t2, t3, t4].every((t) => t.code === "tenant_param_rejected"));
    const q1 = parseSupplierQuery("facts", new URLSearchParams("from=2026-01&to=2027-06"), isTenantKey) as any;
    const q2 = parseSupplierQuery("suppliers.create", new URLSearchParams("type=venue"), isTenantKey) as any;
    const q3 = parseSupplierQuery("instalments.list", new URLSearchParams("state=overdue"), isTenantKey) as any;
    const q4 = parseAction("payment", JSON.stringify({ amount: "1.00", paidDate: "2026-10-15", credit: "1.00" }), isTenantKey) as any;
    ck("AC34b. Query / body validation: facts range at most 12 months; writes take no query parameters; unknown state / field refused", q1.code === "invalid_query" && q2.code === "unexpected_parameter" && q3.code === "invalid_query" && q4.code === "unexpected_field");
  }

  // ===== AU. Audit =====
  {
    const a7 = world.audit.length;
    await listSuppliers(deps, mgr, {});
    await readSupplier(deps, mgr, VEN);
    await listAgreements(deps, mgr, {});
    await readAgreement(deps, mgr, V1);
    await listInstalments(deps, mgr, {});
    await readInstalment(deps, mgr, I1);
    await listCostFacts(deps, mgr, { ok: true });
    ck("AU36. Reads write no audit (7 read routes)", world.audit.length === a7);
    world.lockHeld = "someone-else";
    const busy = await act(I2, "cancel", { reason: "x" });
    world.lockHeld = null;
    ck("AU36b. Refused writes create no audit (busy lock here; every refusal above was checked with an unchanged snapshot)", busy.code === "finance_commercial_busy" && world.audit.length === a7);
    const kinds = new Set(world.audit.map((e) => e.event_type));
    const all = Object.values(EVENTS);
    ck("AU35. Successful writes audited: every one of the 11 F13 event types occurred (supplier created/updated, agreement created/versioned, instalment created / estimate confirmed / moved / split / partially paid / paid / cancelled)", all.every((e) => kinds.has(e)), JSON.stringify(all.filter((e) => !kinds.has(e))));
    const f13 = world.audit;
    ck("AU35b. Every audit row: actor, entity, ORG:id record id, contract finance-suppliers-v1, route; no secrets", f13.every((e) => e.actor_user_id === MGR && e.organisation_id === ORG && new RegExp(`^${ORG}:FS[UAI]-[0-9A-F]{12}$`).test(e.record_id) && e.context.contract === "finance-suppliers-v1" && /^POST \//.test(e.context.route) && !/service-role|pat-test|sk_live|rk_live/.test(JSON.stringify(e))));
    const inst = T_("finance_supplier_instalments").length;
    const created = f13.filter((e) => e.event_type === EVENTS.instalmentCreated).length;
    const pays = T_("finance_supplier_payments").length;
    const payEvents = f13.filter((e) => e.event_type === EVENTS.paid || e.event_type === EVENTS.partiallyPaid).length;
    ck("AU35c. Exact: one instalment.created per stored instalment (incl. split children) and one paid / partially_paid per stored payment", created === inst && payEvents === pays, `${created}/${inst} ${payEvents}/${pays}`);
  }

  // ===== Pure helpers =====
  {
    const base = { organisationId: ORG, instalmentId: "FSI-AAAAAAAAAAAA", agreementId: "FSA-AAAAAAAAAAAA", supplierId: "FSU-AAAAAAAAAAAA", sequence: 1, originalDueDate: "2026-11-01", dueDate: "2026-11-01", plannedMinor: 50000, amountDueMinor: 50000, amountState: "confirmed" as const, paidMinor: 30000, splitFromInstalmentId: null, note: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdAt: NOW.toISOString(), createdBy: MGR };
    const ctx = { today: "2026-10-15", actor: MGR, at: NOW.toISOString(), newId: (p: "FSI" | "FSP") => `${p}-BBBBBBBBBBBB` };
    const payIn = (amountMinor: number) => ({ action: "payment" as const, amountMinor, paidDate: "2026-10-15", method: null, reference: null, note: null });
    const est = planChange({ ...base, amountState: "estimated", paidMinor: 0 }, payIn(100), ctx) as any;
    const over = planChange(base, payIn(25000), ctx) as any;
    const fits = planChange(base, payIn(20000), ctx) as any;
    const cancel = planChange(base, { action: "cancel", reason: "x" }, ctx) as any;
    ck("X2. planChange refuses on its own (before the database re-checks): estimate payment, overpayment against the REMAINING (250.00 > 200.00), cancelling a partly-paid instalment; 200.00 exactly fits", est.code === "amount_still_estimated" && over.code === "overpayment" && fits.ok && fits.payment.remainingAfterMinor === 0 && cancel.code === "instalment_partially_paid");
    const spec = { name: "x", description: null, costType: "hourly" as const, frequency: "monthly" as const, classification: "general" as const, effectiveFrom: "2026-10-01", effectiveUntil: null, amountMinor: null, hourlyRateMinor: 2500, expectedMonthlyHoursHundredths: 1000, amountIsEstimate: false, firstDueDate: "2026-10-31", instalmentCount: 2, customInstalments: [], sessionIds: [], financeServiceId: null, sourceDocumentRef: null, reason: null };
    const gs = generateSchedule(spec, "2026-10-15") as any;
    ck("X3. An hourly schedule is always Estimated even if a caller passes amountIsEstimate false (250.00 x 2)", gs.ok && gs.instalments.every((i: any) => i.estimated === true && i.plannedMinor === 25000));
  }
  ck("X1. spreadEvenly is exact and deterministic (1000.00 / 3 = 333.34 + 333.33 + 333.33)", spreadEvenly(100000, 3).join() === "33334,33333,33333" && spreadEvenly(1, 3).join() === "1,0,0");

  // ===== Z. Code / drift checks =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const pure = noComments(code("finance-suppliers.ts"));
    ck("Z1. finance-suppliers.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(pure));
    const orch = noComments(code("finance-suppliers-orchestrator.ts"));
    ck("Z2. Reads authorise View, writes Manage via F1 authorizeFinance; writes take the shared Finance write lock (commercial:{org})", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && /acquireWriteLock/.test(orch) && /`commercial:\$\{o\.organisationId\}`/.test(orch) && !/fetch\(/.test(orch));
    const repo = noComments(code("finance-suppliers-repository.ts"));
    ck("Z3. F13 writes ONLY through its three database functions; Airtable is read only", !/method: "(PATCH|DELETE|PUT)"/.test(repo) && (repo.match(/method: "POST"/g) ?? []).length === 1 && /rest\(svc, `rpc\/\$\{fn\}`\)/.test(repo) && !/airtableFetch\([^)]*method/.test(repo));
    const idx = code("index.ts");
    ck("Z4. index.ts routes F13 first and keeps the TEST guards", idx.indexOf("matchSupplierRoute(route") > 0 && idx.indexOf("matchSupplierRoute(route") < idx.indexOf("matchCoachCostRoute(route") && /stripe: \{ requireTestMode: true \}/.test(idx));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z5. No F13 code in the 12 Finance modules shared with Needs Attention", shared.every((f) => !/supplier/i.test(code(f))));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z6. Test copies match the canonical finance files (only import paths swapped)", copy("finance-suppliers.ts") && copy("finance-suppliers-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-suppliers-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    const noStrings = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`\\]|\\.)*`/g, "``");
    const allCode = noStrings(pure + orch + repo);
    ck("Z7. No supplier credit, Cash Flow, overhead / salary, Month Report or bank code in F13 (F14 / F15 / later)", !/credit|cash ?flow|cashflow|overhead|salar|month ?report|reconcil|bank_feed/i.test(allCode) && !/sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]/.test(allCode));
    const NOT = ["supplier-credits", "suppliers/FSU-AAAAAAAAAAAA/credits", "supplier-instalments/FSI-AAAAAAAAAAAA/apply-credit", "supplier-instalments/FSI-AAAAAAAAAAAA/unapply-credit", "supplier-instalments/FSI-AAAAAAAAAAAA/delete", "supplier-cash-flow", "cash-flow", "supplier-overheads", "supplier-agreements/FSA-AAAAAAAAAAAA/edit"];
    ck("Z8. Only the F13 routes exist: no supplier-credit / Cash Flow / delete / edit-in-place route; an agreement is never POSTed in place", NOT.every((p) => { const mm = matchSupplierRoute(p, "POST"); return mm === null || mm.status === "not_found"; }) && matchSupplierRoute("supplier-agreements/FSA-AAAAAAAAAAAA", "POST")?.status === "method" && matchSupplierRoute("supplier-instalments", "POST")?.status === "method");
    ck("Z9. Remaining balance is computed in ONE place (remainingOf) - where F14 will subtract applied credits", (pure.match(/amountDueMinor - i\.paidMinor/g) ?? []).length === 1 && !/amountDueMinor -/.test(orch));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
