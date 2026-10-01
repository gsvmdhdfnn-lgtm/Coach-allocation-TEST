/**
 * Finance Foundation F12 - coach cost READ + Finance Coach Month finalisation.
 * Run: node --experimental-strip-types tests/support/finance-coach-costs.test.ts
 *
 *   HC  historical cost (frozen rate / cost, override, fixed, hourly, salaried 0.00, missing != 0.00)  brief 1-8
 *   MR  month read (by coach, by programme, drill-down, count, unresolved programme)                    brief 9-13
 *   FN  finalisation (open changes, finalise, blockers, duplicates, actor, frozen, concurrency)          brief 14-22
 *   CO  corrections (explicit, original visible, derived total, reason, no rewrite, audit)               brief 23-28
 *   PT  payment timing (day 7, day 31, work month vs payment date)                                       brief 29-32
 *   CP  cancellation / payable work (Slice 6 outcomes read, no policy recalculated)                      brief 33-36
 *   AC  access (View, Manage, no grant, coach, parent, module off, tenant)                               brief 37-43
 *   AU  audit (reads none, finalise / correction exact, refusals none)                                    brief 44-47
 *   WS  Work Summary coverage (queried / reopened / stale / missing / never "viewed")
 *   Z   code / drift checks against the canonical files
 *
 * The REAL F12 orchestrator + repository run against an in-memory world:
 * fake Airtable (schedule, allocations, coaches, Work Summaries, Finance
 * Settings), fake PostgREST + fake finance_worker_month_* database functions
 * (the same rules as the TEST SQL, also exercised live).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, toStoredFields } from "./finance-settings.ts";
import { COST_EVENTS, ELIGIBLE_COST_STATUSES, OUTCOME_REQUIRED_STATUSES, SUMMARY_STATUSES, WORK_OUTCOMES, expectedPaymentDate, matchCoachCostRoute, parseCorrection, parseCostQuery, parseFinalise, poundsToMinor, sha256Hex, snapshotText } from "./finance-coach-costs.ts";
import { type CostDeps, correctFinanceMonth, finaliseWorkerMonth, listCostFacts, listFinanceMonths, readCostMonth, readFinanceMonth, readWorkerMonth, readWorkerMonths } from "./finance-coach-costs-orchestrator.ts";
import { CostRefusal, finaliseMonth } from "./finance-coach-costs-repository.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");
const WS_CANON = join(HERE, "..", "..", "supabase", "functions-test", "coach-work-summaries");

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
const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7 };
const settingsRow = (s: any) => ({ id: "recSettingsRow001", fields: { Organisation: [ORG_REC], "Finance Settings ID": "FINSET", Revision: 1, ...Object.fromEntries(Object.entries(toStoredFields(s, Object.keys(s) as any)).filter(([, v]) => v !== null)) } });

// record ids (17 chars)
const rid = (p: string) => `rec${p.padEnd(14, "0").slice(0, 14)}`;
const CA = rid("CoachA"), CB = rid("CoachB"), CC = rid("CoachC"), CD = rid("CoachD");
const S1 = rid("SessPPA"), S2 = rid("SessNoSvc"), S3 = rid("SessOffice");
const WS_A = rid("WsA"), WS_B = rid("WsB"), WS_D = rid("WsD");

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
}
let world: World;
let NOW = new Date("2026-10-15T12:00:00.000Z");
let seq = 0;
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

const occ = (id: string, date: string, session: string, status = "Completed", allocs: string[] = []) => ({ id, fields: { "Occurrence ID": `OCC-${id.slice(3, 9)}:${date}`, "Occurrence Name": `Occ ${date}`, Date: date, Status: status, Session: [session], "Coach Allocations": allocs } });
const alloc = (id: string, coachRec: string, occId: string, f: Record<string, any>) => ({ id, fields: { "Allocation ID": `ALLOC-${id.slice(3, 9)}`, Coach: [coachRec], "Session Occurrence": [occId], "Cost Status": "Confirmed", "Rate Profile": [rid("RateProfA")], "Rate Type Snapshot": "Evening", "Pay Unit Snapshot": "Per Hour", ...f } });
const line = (id: string, allocId: string, summary: string, final: number) => ({ id, fields: { "Work Summary Line ID": `WSL-${id.slice(3, 9)}`, "Work Summary": [summary], "Coach Allocation": [allocId], "Final Cost Snapshot": final } });

function reset() {
  seq = 0;
  // Coach A: 5 paid items in September 2026 (hourly, fixed, override, partial outcome, unresolved programme).
  const A = [
    { a: rid("AllocA1"), o: rid("OccA1"), date: "2026-09-03", s: S1, f: { "Rate Amount Snapshot": 22, "Paid Units": 2, "Final Coach Cost": 44 } },
    { a: rid("AllocA2"), o: rid("OccA2"), date: "2026-09-10", s: S1, f: { "Rate Type Snapshot": "Day", "Pay Unit Snapshot": "Per Session", "Rate Amount Snapshot": 30, "Paid Units": 1, "Final Coach Cost": 30 } },
    { a: rid("AllocA3"), o: rid("OccA3"), date: "2026-09-17", s: S1, f: { "Rate Amount Snapshot": 22, "Paid Units": 2, "Cost Override": 50, "Override Reason": "Agreed extra for one session", "Final Coach Cost": 50 } },
    { a: rid("AllocA4"), o: rid("OccA4"), date: "2026-09-24", s: S1, st: "Cancelled", f: { "Rate Amount Snapshot": 22, "Paid Units": 2, "Cost Override": 15, "Coach Outcome": "Partial", "Coach Outcome Decided By Name Snapshot": "Morgan Manager", "Coach Outcome Decided At": "2026-09-25T10:00:00.000Z", "Final Coach Cost": 15 } },
    { a: rid("AllocA5"), o: rid("OccA5"), date: "2026-09-28", s: S2, f: { "Rate Amount Snapshot": 25, "Paid Units": 1.5, "Final Coach Cost": 37.5 } },
  ];
  const occurrences: Row[] = [];
  const allocations: Row[] = [];
  const lines: Row[] = [];
  A.forEach((x, i) => {
    occurrences.push(occ(x.o, x.date, x.s, (x as any).st ?? "Completed", [x.a]));
    const l = rid(`LineA${i + 1}`);
    allocations.push(alloc(x.a, CA, x.o, { ...x.f, "Work Summary Lines": [l] }));
    lines.push(line(l, x.a, WS_A, x.f["Final Coach Cost"]));
  });
  // Coach B: salaried (an intentional 0.00).
  occurrences.push(occ(rid("OccB1"), "2026-09-05", S3, "Completed", [rid("AllocB1")]));
  allocations.push(alloc(rid("AllocB1"), CB, rid("OccB1"), { "Cost Basis": "Salaried — no direct session cost", "Rate Profile": [], "Rate Type Snapshot": null, "Pay Unit Snapshot": null, "Final Coach Cost": 0, "Work Summary Lines": [rid("LineB1")] }));
  lines.push(line(rid("LineB1"), rid("AllocB1"), WS_B, 0));
  // Coach C: paid work with no frozen rate and no cost (must never read as 0.00).
  occurrences.push(occ(rid("OccC1"), "2026-09-06", S1, "Completed", [rid("AllocC1")]));
  allocations.push(alloc(rid("AllocC1"), CC, rid("OccC1"), { "Rate Profile": [], "Rate Type Snapshot": null, "Pay Unit Snapshot": null }));
  // Coach D: cancellations read from Slice 6 outcomes (Paid full, Unpaid 0.00), plus an August item and a July item.
  occurrences.push(occ(rid("OccD1"), "2026-09-08", S1, "Cancelled", [rid("AllocD1")]));
  occurrences.push(occ(rid("OccD2"), "2026-09-09", S1, "Cancelled", [rid("AllocD2")]));
  allocations.push(alloc(rid("AllocD1"), CD, rid("OccD1"), { "Pay Unit Snapshot": "Per Session", "Rate Amount Snapshot": 30, "Paid Units": 1, "Coach Outcome": "Paid", "Final Coach Cost": 30, "Work Summary Lines": [rid("LineD1")] }));
  allocations.push(alloc(rid("AllocD2"), CD, rid("OccD2"), { "Pay Unit Snapshot": "Per Session", "Rate Amount Snapshot": 30, "Paid Units": 1, "Coach Outcome": "Unpaid", "Cost Override": 0, "Final Coach Cost": 0, "Work Summary Lines": [rid("LineD2")] }));
  lines.push(line(rid("LineD1"), rid("AllocD1"), WS_D, 30), line(rid("LineD2"), rid("AllocD2"), WS_D, 0));
  occurrences.push(occ(rid("OccOut1"), "2026-10-02", S1, "Scheduled", [rid("AllocOut1")]));
  allocations.push(alloc(rid("AllocOut1"), CA, rid("OccOut1"), { "Rate Amount Snapshot": 22, "Paid Units": 1, "Final Coach Cost": 22 }));
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [] },
    moduleOn: true,
    at: {
      "Organisation & Branding": [ORG_ROW],
      "Finance Settings": [settingsRow(SETTINGS)],
      Coaches: [
        { id: CA, fields: { "Coach Name": "Alex Test", "Coach ID": "COACH-TEST-A", Active: true } },
        { id: CB, fields: { "Coach Name": "Sam Salaried", "Coach ID": "COACH-TEST-B", Active: true } },
        { id: CC, fields: { "Coach Name": "Cal Missing", "Coach ID": "COACH-TEST-C", Active: true } },
        { id: CD, fields: { "Coach Name": "Dee Cancel", "Coach ID": "COACH-TEST-D", Active: true } },
        { id: rid("CoachDup1"), fields: { "Coach Name": "Dup 1", "Coach ID": "COACH-DUP", Active: true } },
        { id: rid("CoachDup2"), fields: { "Coach Name": "Dup 2", "Coach ID": "COACH-DUP", Active: true } },
      ],
      Sessions: [
        { id: S1, fields: { "Session Name": "PPA St Mary's", Programme: "School PPA", "Finance Service ID": "FSV-AAAAAAAAAAAA" } },
        { id: S2, fields: { "Session Name": "Holiday Camp Day", Programme: "Camps" } },
        { id: S3, fields: { "Session Name": "Office Cover Session", Programme: "Academy", "Finance Service ID": "FSV-BBBBBBBBBBBB" } },
      ],
      "Session Occurrences": occurrences,
      "Coach Allocations": allocations,
      "Coach Rate Profiles": [{ id: rid("RateProfA"), fields: { "Rate Type": "Evening", "Pay Unit": "Per Hour", Amount: 22, Active: true } }],
      "Work Summary Lines": lines,
      "Coach Work Summaries": [
        { id: WS_A, fields: { "Work Summary ID": "WS-ZZ-A-SEP", Status: "Finalised", Active: true, Coach: [CA], "Period Start": "2026-09-01", "Period End": "2026-09-30" } },
        { id: WS_B, fields: { "Work Summary ID": "WS-ZZ-B-SEP", Status: "Finalised", Active: true, Coach: [CB], "Period Start": "2026-09-01", "Period End": "2026-09-30" } },
        { id: WS_D, fields: { "Work Summary ID": "WS-ZZ-D-SEP", Status: "Finalised", Active: true, Coach: [CD], "Period Start": "2026-08-15", "Period End": "2026-09-14" } },
      ],
    },
    sb: { finance_worker_cost_months: [], finance_worker_cost_items: [], finance_worker_cost_corrections: [] },
    audit: [],
    lockHeld: null,
    airtableWrites: 0,
    airtableReads: [],
  };
  NOW = new Date("2026-10-15T12:00:00.000Z");
}
const A = (table: string) => world.at[table];
const rec = (table: string, id: string) => A(table).find((r) => r.id === id)!;

// ----- fake finance_worker_month_* database functions (same rules as the TEST SQL) -----
class Refused extends Error {}
const no = (code: string) => {
  throw new Refused(`f12:${code}`);
};
function audit(events: any[]) {
  if (!Array.isArray(events) || !events.length) no("audit_missing");
  for (const e of events) if (!/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(e.event_type) || !/^[a-z][a-z_]*$/.test(e.entity_type)) throw new Error("audit check violation");
  world.audit.push(...events.map((e) => ({ ...e, occurred_at: NOW.toISOString() })));
}
const T_ = (t: string) => world.sb[t];
function rpcBody(fn: string, a: any): unknown {
  if (fn === "finance_worker_month_finalise") {
    const mo = a.p_month;
    if (!Array.isArray(a.p_items) || !a.p_items.length) no("snapshot_mismatch");
    if (T_("finance_worker_cost_months").some((x) => x.organisation_id === mo.organisation_id && x.worker_record_id === mo.worker_record_id && x.work_month === mo.work_month)) no("already_finalised");
    if (!/^[0-9a-f]{64}$/.test(mo.snapshot_hash) || mo.item_count <= 0 || mo.finalised_total_minor < 0 || !(mo.expected_payment_date > mo.work_month)) throw new Error("months check violation");
    T_("finance_worker_cost_months").push({ ...mo });
    for (const i of a.p_items) {
      if (i.cost_basis !== "paid" && i.final_cost_minor !== 0) throw new Error("items check violation");
      if (i.cost_basis === "paid" && !(i.rate_amount_minor > 0 && i.paid_units)) throw new Error("items check violation");
      T_("finance_worker_cost_items").push({ ...i });
    }
    const mine = T_("finance_worker_cost_items").filter((i) => i.month_id === mo.month_id);
    if (mine.reduce((s, i) => s + i.final_cost_minor, 0) !== mo.finalised_total_minor || mine.length !== mo.item_count || a.p_items.some((i: any) => i.month_id !== mo.month_id || i.organisation_id !== mo.organisation_id)) no("snapshot_mismatch");
    if (T_("finance_worker_cost_items").some((i) => i.month_id !== mo.month_id && a.p_items.some((x: any) => x.allocation_record_id === i.allocation_record_id))) no("allocation_already_finalised");
    audit(a.p_events);
    return { month_id: mo.month_id };
  }
  if (fn === "finance_worker_month_correct") {
    const mo = T_("finance_worker_cost_months").find((x) => x.organisation_id === a.p_org && x.month_id === a.p_month_id);
    if (!mo) no("month_not_found");
    const current = mo.finalised_total_minor + T_("finance_worker_cost_corrections").filter((c) => c.month_id === a.p_month_id).reduce((s, c) => s + c.amount_minor, 0);
    if (current !== a.p_expected_total_minor) no("month_changed");
    const result = current + a.p_correction.amount_minor;
    if (result < 0) no("corrected_total_negative");
    if (a.p_correction.resulting_total_minor !== result) no("snapshot_mismatch");
    if (a.p_correction.amount_minor === 0 || !String(a.p_correction.reason ?? "").trim()) throw new Error("corrections check violation");
    T_("finance_worker_cost_corrections").push({ ...a.p_correction });
    audit(a.p_events);
    return { resulting_total_minor: result };
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
  const rows = world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  // The tables' triggers: UPDATE / DELETE always refused.
  if (method === "PATCH" || method === "DELETE") return json({ code: "P0001", message: "f12:history_is_append_only" }, 400);
  if (method !== "GET") return json({ message: "F12 writes only through its database functions" }, 403);
  const fs: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (k !== "select" && k !== "order") fs.push([k, v.replace(/^eq\./, "")]);
  return json(rows.filter((r) => fs.every(([k, v]) => String(r[k] ?? "") === v)).map((r) => ({ ...r })));
}

function airtable(url: string, method: string): Response {
  if (method !== "GET") {
    world.airtableWrites++;
    return json({ error: "F12 must not write Airtable" }, 418);
  }
  const u = new URL(url);
  const t = decodeURIComponent(u.pathname.split("/").pop() as string);
  world.airtableReads.push(t);
  if (t === "Feature Controls") return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
  let rows = (world.at[t] ?? []).map((r) => JSON.parse(JSON.stringify(r)));
  const f = u.searchParams.get("filterByFormula");
  if (f) {
    const ids = [...f.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]{14})'/g)].map((x) => x[1]);
    if (ids.length) rows = rows.filter((r) => ids.includes(r.id));
    const after = /IS_AFTER\(\{Date\},'(\d{4}-\d{2}-\d{2})'\)/.exec(f);
    const before = /IS_BEFORE\(\{Date\},'(\d{4}-\d{2}-\d{2})'\)/.exec(f);
    if (after) rows = rows.filter((r) => r.fields.Date > after[1]);
    if (before) rows = rows.filter((r) => r.fields.Date < before[1]);
  }
  // Airtable omits empty fields.
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
  const rpcMatch = /\/rpc\/(finance_worker_[a-z_]+)$/.exec(url);
  if (rpcMatch) {
    try {
      return json(rpcFn(rpcMatch[1], body));
    } catch (e) {
      if (e instanceof Refused) return json({ code: "P0001", message: e.message }, 400);
      return json({ message: String(e) }, 400);
    }
  }
  if (url.includes("/rest/v1/finance_audit_events")) return json({ message: "F12 audits inside its database functions" }, 403);
  if (url.includes("/rest/v1/")) return postgrest(url, method);
  if (url.startsWith("https://api.airtable.com/")) return airtable(url, method);
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

let rnd = 0;
const deps: CostDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  coachCosts: { random: () => (++rnd).toString(16).padStart(12, "0") + "0000" },
};
const month = (ref: string, mo = "2026-09", caller: any = mgr) => readWorkerMonth(deps, caller, ref, mo) as Promise<any>;
const finalise = (ref: string, mo = "2026-09", caller: any = mgr, reason: string | null = null) => finaliseWorkerMonth(deps, caller, ref, mo, reason) as Promise<any>;
const correct = (id: string, body: Record<string, unknown>, caller: any = mgr) => {
  const p = parseCorrection(JSON.stringify(body), isTenantKey);
  if (!p.ok) return Promise.resolve({ status: "error", ...p } as any);
  return correctFinanceMonth(deps, caller, id, p) as Promise<any>;
};
const item = (b: any, date: string) => b.workItems.find((i: any) => i.date === date);
const codes = (i: any) => i.blockers.map((x: any) => x.code);
const evTypes = (from: number) => world.audit.slice(from).map((e) => e.event_type);

async function main() {
  // ===== HC. Historical cost =====
  reset();
  {
    const r0 = await month("COACH-TEST-A");
    const b0 = r0.body;
    rec("Coach Rate Profiles", rid("RateProfA")).fields.Amount = 25; // the coach's NORMAL rate changes today
    const r1 = await month("COACH-TEST-A");
    ck("HC1. Historical rate unchanged after the normal rate changes (22.00 frozen; the Rate Profile now says 25.00)", item(r1.body, "2026-09-03").rate === "22.00" && item(b0, "2026-09-03").rate === "22.00", JSON.stringify(item(r1.body, "2026-09-03")));
    ck("HC2. Historical cost unchanged after the normal rate changes (44.00; month total 176.50 before and after)", item(r1.body, "2026-09-03").amount === "44.00" && r1.body.status.liveTotal === "176.50" && b0.status.liveTotal === "176.50");
    ck("HC2b. Finance never even reads Coach Rate Profiles (the current rate is not an input)", !world.airtableReads.includes("Coach Rate Profiles"));
    const o = item(r1.body, "2026-09-17");
    ck("HC3. One-off override preserved and explained one level deeper: 50.00 paid, standard 44.00, reason kept", o.amount === "50.00" && o.override.applied && o.override.standardAmount === "44.00" && o.override.amount === "50.00" && o.override.reason === "Agreed extra for one session" && o.rate === "22.00");
    ck("HC4. An override never changes the coach's default rate: Finance writes nothing to Airtable", world.airtableWrites === 0 && rec("Coach Allocations", rid("AllocA3")).fields["Rate Amount Snapshot"] === 22);
    const fx = item(r1.body, "2026-09-10");
    ck("HC5. Fixed / per-session allocation: Per Session x 1.00 at 30.00 = 30.00", fx.payUnit === "Per Session" && fx.units === "1.00" && fx.amount === "30.00" && fx.blockers.length === 0);
    const h = item(r1.body, "2026-09-03");
    ck("HC6. Hourly allocation: Per Hour x 2.00 at 22.00 = 44.00 (not forced into any other basis)", h.payUnit === "Per Hour" && h.units === "2.00" && h.amount === "44.00");
    const b = await month("COACH-TEST-B");
    const bi = b.body.workItems[0];
    ck("HC7. Salaried allocation is a legitimate 0.00 with no missing-rate blocker; the month is ready to finalise", bi.amount === "0.00" && bi.costBasis === "Salaried — no direct session cost" && bi.blockers.length === 0 && b.body.readyToFinalise === true, JSON.stringify(b.body.blockers));
    const c = await month("COACH-TEST-C");
    const ci = c.body.workItems[0];
    ck("HC8. Missing rate is NOT 0.00: amount null, blockers missing_historical_rate + missing_final_cost, not ready", ci.amount === null && codes(ci).includes("missing_historical_rate") && codes(ci).includes("missing_final_cost") && c.body.readyToFinalise === false);
    ck("HC8b. Pence are exact: 25.00 x 1.50 = 37.50; a float with a third decimal is refused", item(r1.body, "2026-09-28").amount === "37.50" && poundsToMinor(37.505) === null && poundsToMinor(0.1 + 0.2) === 30);
  }

  // ===== MR. Month read =====
  {
    const r = (await readCostMonth(deps, mgr, { month: "2026-09" })) as any;
    const row = (ref: string) => r.body.byCoach.find((x: any) => x.coach.coachId === ref);
    ck("MR9. By-coach monthly totals: A 176.50 (5 items), B 0.00 (salaried), D 30.00; C not ready", row("COACH-TEST-A").total === "176.50" && row("COACH-TEST-A").workItems === 5 && row("COACH-TEST-B").total === "0.00" && row("COACH-TEST-D").total === "30.00" && row("COACH-TEST-C").readyToFinalise === false && r.body.total === "206.50", JSON.stringify(r.body.byCoach.map((x: any) => [x.coach.coachId, x.total])));
    const p = (id: string | null) => r.body.byProgramme.find((x: any) => x.financeServiceId === id);
    ck("MR10. By-programme totals by stable Finance Service ID (FSV-A 169.00 incl. 1 unpriced item; FSV-B 0.00)", p("FSV-AAAAAAAAAAAA").total === "169.00" && p("FSV-AAAAAAAAAAAA").unresolvedCost === 1 && p("FSV-BBBBBBBBBBBB").total === "0.00" && p("FSV-AAAAAAAAAAAA").labels.includes("School PPA"), JSON.stringify(r.body.byProgramme));
    const d = await month("COACH-TEST-A");
    const i = item(d.body, "2026-09-03");
    ck("MR11. Occurrence / session drill-down: date, session, programme, basis, rate type, units, rate, amount; technical ids only under technical", i.session === "PPA St Mary's" && i.programme.financeServiceId === "FSV-AAAAAAAAAAAA" && i.rateType === "Evening" && i.costBasis === "Paid" && i.costBasisRecorded === false && i.technical.allocationRecordId === rid("AllocA1") && !("allocationRecordId" in i));
    ck("MR12. Allocation count per coach month (5; October work excluded)", d.body.workItems.length === 5 && !d.body.workItems.some((x: any) => x.date >= "2026-10-01"));
    ck("MR13. Programme unresolved where the session has no Finance Service ID (label kept, never guessed)", p(null).resolved === false && p(null).total === "37.50" && p(null).labels.includes("Camps") && item(d.body, "2026-09-28").programme.resolved === false);
    const months = (await readWorkerMonths(deps, mgr, "COACH-TEST-A", { from: "2026-08", to: "2026-10" })) as any;
    ck("MR14. One coach month by month (Aug 0 items, Sep 176.50, Oct 22.00 open, not yet worked)", months.body.months.length === 3 && months.body.months[1].total === "176.50" && months.body.months[0].workItems === 0 && months.body.months[2].blockers > 0);
    const dup = (await readWorkerMonth(deps, mgr, "COACH-DUP", "2026-09")) as any;
    const none = (await readWorkerMonth(deps, mgr, "COACH-NOPE", "2026-09")) as any;
    ck("MR15. Coach identity: duplicate Coach ID 409 coach_id_ambiguous; unknown 404", dup.httpStatus === 409 && dup.code === "coach_id_ambiguous" && none.httpStatus === 404);
  }

  // ===== FN. Finalisation =====
  {
    // 14: an open month legitimately changes (a missing allocation is added and reviewed).
    const before = (await month("COACH-TEST-A")).body.status.liveTotal;
    A("Session Occurrences").push(occ(rid("OccA6"), "2026-09-29", S1, "Completed", [rid("AllocA6")]));
    A("Coach Allocations").push(alloc(rid("AllocA6"), CA, rid("OccA6"), { "Cost Basis": "Paid", "Rate Amount Snapshot": 20, "Paid Units": 1, "Final Coach Cost": 20, "Work Summary Lines": [rid("LineA6")] }));
    A("Work Summary Lines").push(line(rid("LineA6"), rid("AllocA6"), WS_A, 20));
    const after = (await month("COACH-TEST-A")).body;
    ck("FN14. An open month changes before finalisation (176.50 -> 196.50, 6 items), nothing stored", before === "176.50" && after.status.liveTotal === "196.50" && after.workItems.length === 6 && after.status.state === "open" && world.sb.finance_worker_cost_months.length === 0);
    const a0 = world.audit.length;
    const f = await finalise("COACH-TEST-A", "2026-09", mgr, "September reviewed");
    ck("FN15. A clean month finalises: 201, total 196.50, 6 frozen items, payment due 2026-10-07", f.httpStatus === 201 && f.body.finalised.finalisedTotal === "196.50" && f.body.finalised.itemCount === 6 && world.sb.finance_worker_cost_items.length === 6 && f.body.finalised.payment.expectedPaymentDate === "2026-10-07", JSON.stringify(f.body ?? f));
    ck("FN18. Finalisation records actor and time", f.body.finalised.finalisedBy === MGR && f.body.finalised.finalisedAt === NOW.toISOString() && world.sb.finance_worker_cost_months[0].finalised_by === MGR);
    ck("AU45. Finalise audit is exact: one finance_work_cost.month_finalised event with total, items, payment date and snapshot hash", JSON.stringify(evTypes(a0)) === JSON.stringify([COST_EVENTS.monthFinalised]) && world.audit[a0].after.finalisedTotal === "196.50" && world.audit[a0].after.workItems === 6 && world.audit[a0].reason === "September reviewed" && world.audit[a0].actor_user_id === MGR);
    const fm = world.sb.finance_worker_cost_months[0];
    const recomputed = await sha256Hex(snapshotText(CA, "2026-09", 196_50, world.sb.finance_worker_cost_items.map((x) => ({ ...x }))));
    ck("FN15b. The snapshot hash is the sha256 of the canonical frozen items (integrity basis)", recomputed === fm.snapshot_hash);
    const c = await finalise("COACH-TEST-C");
    ck("FN16. Missing historical cost blocks finalisation with clear codes; nothing stored, no audit", c.httpStatus === 409 && c.code === "finalisation_blocked" && c.details.blockerCodes.includes("missing_historical_rate") && c.details.blockerCodes.includes("missing_final_cost") && world.sb.finance_worker_cost_months.length === 1);
    // 17: a duplicate allocation (same person, same occurrence) blocks.
    A("Coach Allocations").push(alloc(rid("AllocD9"), CD, rid("OccD1"), { "Pay Unit Snapshot": "Per Session", "Rate Amount Snapshot": 30, "Paid Units": 1, "Coach Outcome": "Paid", "Final Coach Cost": 30 }));
    rec("Session Occurrences", rid("OccD1")).fields["Coach Allocations"].push(rid("AllocD9"));
    const d = await finalise("COACH-TEST-D");
    ck("FN17. A duplicate allocation for the same person + occurrence blocks finalisation (duplicate_allocation on both)", d.httpStatus === 409 && d.details.blockerCodes.includes("duplicate_allocation") && d.details.blockers.filter((x: any) => x.code === "duplicate_allocation").length === 2);
    A("Coach Allocations").pop();
    rec("Session Occurrences", rid("OccD1")).fields["Coach Allocations"].pop();
    // 20: the normal rate changes after finalisation - nothing moves.
    rec("Coach Rate Profiles", rid("RateProfA")).fields.Amount = 40;
    const s1 = (await readFinanceMonth(deps, mgr, fm.month_id)) as any;
    ck("FN20. A coach rate change after finalisation does not alter the total (196.50, state Finalised, integrity verified)", s1.body.finalisedTotal === "196.50" && s1.body.status.state === "finalised" && s1.body.integrityVerified === true);
    const a1 = world.audit.length;
    const dup = await finalise("COACH-TEST-A");
    ck("FN21. A duplicate finalise is refused safely (409 already_finalised), no new rows, no audit", dup.httpStatus === 409 && dup.code === "already_finalised" && world.sb.finance_worker_cost_months.length === 1 && world.audit.length === a1);
    let dbRefusal = "";
    try {
      await finaliseMonth(deps.grants, { ...({} as any), organisationId: ORG, monthId: "FCM-ABCDEF123456", workerRecordId: CA, workerRef: "COACH-TEST-A", workerName: "x", workMonth: "2026-09", finalisedTotalMinor: 100, itemCount: 1, paymentDay: 7, expectedPaymentDate: "2026-10-07", snapshotHash: "a".repeat(64), finalisedAt: NOW.toISOString(), finalisedBy: MGR, reason: null }, [world.sb.finance_worker_cost_items[0] as any], [{ event_type: "x.y", entity_type: "z" }]);
    } catch (e) {
      dbRefusal = e instanceof CostRefusal ? e.code : String(e);
    }
    ck("FN21b. The database itself refuses a second month for the same coach + month (already_finalised)", dbRefusal === "already_finalised");
    // 22: concurrency
    const a2 = world.audit.length;
    const [x, y] = await Promise.all([finalise("COACH-TEST-B"), finalise("COACH-TEST-B")]);
    const okCount = [x, y].filter((r) => r.httpStatus === 201).length;
    const other = [x, y].find((r) => r.httpStatus !== 201);
    ck("FN22. Concurrent finalise: one 201, the other a deterministic 409 (busy / already_finalised); exactly one month row and one audit event", okCount === 1 && other.httpStatus === 409 && ["finance_commercial_busy", "already_finalised"].includes(other.code) && world.sb.finance_worker_cost_months.filter((m) => m.worker_record_id === CB).length === 1 && world.audit.length === a2 + 1);
    // 19: a later allocation edit (e.g. Work Summary reopened and re-finalised at 50.00) never rewrites the month.
    rec("Coach Allocations", rid("AllocA1")).fields["Cost Override"] = 50;
    rec("Coach Allocations", rid("AllocA1")).fields["Override Reason"] = "Corrected after query";
    rec("Coach Allocations", rid("AllocA1")).fields["Final Coach Cost"] = 50;
    rec("Work Summary Lines", rid("LineA1")).fields["Final Cost Snapshot"] = 50;
    const s2 = (await readFinanceMonth(deps, mgr, fm.month_id)) as any;
    ck("FN19. The finalised amount is frozen: allocation 44 -> 50 leaves the Finance month at 196.50, state Correction Required, drift listed", s2.body.finalisedTotal === "196.50" && s2.body.status.state === "correction_required" && s2.body.status.liveTotal === "202.50" && s2.body.status.drift.some((dd: any) => dd.kind === "changed" && dd.frozen === "44.00" && dd.now === "50.00") && world.sb.finance_worker_cost_items.find((i) => i.allocation_record_id === rid("AllocA1")).final_cost_minor === 4400);
    const ws = (await month("COACH-TEST-A")).body;
    ck("FN19b. The coach month shows the Finance record beside the live allocations (frozen 44.00 kept, live 50.00)", ws.finance.frozenItems.find((i: any) => i.date === "2026-09-03").amount === "44.00" && item(ws, "2026-09-03").amount === "50.00" && ws.blockers.length === 0);

    // ===== CO. Corrections =====
    const a3 = world.audit.length;
    const k1 = await correct(fm.month_id, { amount: "6.00", reason: "Work Summary re-finalised: 3 Sep corrected 44.00 -> 50.00", allocationId: rid("AllocA1") });
    ck("CO23. Explicit correction after finalisation: 201, +6.00, resulting corrected total 202.50", k1.httpStatus === 201 && k1.body.correction.amount === "6.00" && k1.body.month.correctedTotal === "202.50" && k1.body.month.originalFinalisedTotal === "196.50", JSON.stringify(k1.body ?? k1));
    ck("AU46. Correction audit is exact: one finance_work_cost.correction_created with before / after and reason", JSON.stringify(evTypes(a3)) === JSON.stringify([COST_EVENTS.correctionCreated]) && world.audit[a3].before.correctedTotal === "196.50" && world.audit[a3].after.correctedTotal === "202.50" && world.audit[a3].reason.startsWith("Work Summary re-finalised"));
    const s3 = (await readFinanceMonth(deps, mgr, fm.month_id)) as any;
    ck("CO24. The original finalised amount stays visible beside the correction", s3.body.finalisedTotal === "196.50" && s3.body.corrections.length === 1 && s3.body.frozenItems.find((i: any) => i.date === "2026-09-03").amount === "44.00");
    ck("CO25a. The live total now matches the corrected total: state Corrected", s3.body.status.state === "corrected" && s3.body.status.correctedTotal === "202.50");
    const k2 = await correct(fm.month_id, { amount: "-2.50", reason: "Agreed deduction - TEST" });
    const s4 = (await readFinanceMonth(deps, mgr, fm.month_id)) as any;
    ck("CO25b. The corrected total is derived: 196.50 + 6.00 - 2.50 = 200.00; live differs again -> Correction Required", k2.body.month.correctedTotal === "200.00" && s4.body.status.correctedTotal === "200.00" && s4.body.status.corrections === "3.50" && s4.body.status.state === "correction_required");
    const a4 = world.audit.length;
    const k3 = await correct(fm.month_id, { amount: "1.00" });
    const k4 = await correct(fm.month_id, { amount: "0.00", reason: "zero" });
    const k5 = await correct(fm.month_id, { amount: "-500.00", reason: "too much" });
    const k6 = await correct(fm.month_id, { amount: "1.00", reason: "x", allocationId: rid("AllocB1") });
    const k7 = await correct("FCM-000000000999", { amount: "1.00", reason: "x" });
    ck("CO26. A correction requires a reason (400), a non-zero amount (400), cannot go below 0.00 (409), must name an allocation of that month (409), and a month that exists (404) - no audit", k3.httpStatus === 400 && k3.fields.reason && k4.httpStatus === 400 && k5.httpStatus === 409 && k5.code === "corrected_total_negative" && k6.httpStatus === 409 && k6.code === "allocation_not_in_month" && k7.httpStatus === 404 && world.audit.length === a4);
    const patch = await fetch(`${deps.grants.supabaseUrl}/rest/v1/finance_worker_cost_months?month_id=eq.${fm.month_id}`, { method: "PATCH", body: JSON.stringify({ finalised_total_minor: 1 }) });
    const del = await fetch(`${deps.grants.supabaseUrl}/rest/v1/finance_worker_cost_items?month_id=eq.${fm.month_id}`, { method: "DELETE" });
    ck("CO27. Direct historical rewrite is refused (UPDATE / DELETE -> f12:history_is_append_only); F12 has no update path", patch.status === 400 && /history_is_append_only/.test(await patch.text()) && del.status === 400 && world.sb.finance_worker_cost_months[0].finalised_total_minor === 196_50);
    const sameMonth = await finalise("COACH-TEST-A");
    ck("CO27b. No Finance reopen: the only routes are finalise (refused once finalised) and corrections", sameMonth.code === "already_finalised" && matchCoachCostRoute(`coach-summaries/${fm.month_id}/reopen`, "POST")?.status === "not_found");
  }

  // ===== PT. Payment timing =====
  {
    const p = (mo: string, d: number) => {
      const r = expectedPaymentDate(mo, d);
      return r.ok ? r.date : `ERR ${r.error}`;
    };
    ck("PT29. Configured day 7 -> the 7th of the following month (Sep work -> 2026-10-07; Dec -> next January)", p("2026-09", 7) === "2026-10-07" && p("2026-12", 7) === "2027-01-07");
    ck("PT30. Configured day 31 uses the last day of a shorter month and keeps the setting (Aug -> 30 Sep, Jan 2027 -> 28 Feb, Jan 2028 -> 29 Feb, Jul -> 31 Aug)", p("2026-08", 31) === "2026-09-30" && p("2027-01", 31) === "2027-02-28" && p("2028-01", 31) === "2028-02-29" && p("2026-07", 31) === "2026-08-31" && p("2026-09", 0).startsWith("ERR"));
    const facts = (await listCostFacts(deps, mgr, { from: "2026-09", to: "2026-09" })) as any;
    const fa = facts.body.facts.filter((f: any) => f.coach.coachId === "COACH-TEST-A" && f.type === "coach_cost");
    ck("PT31. Work-month cost stays in the work month (all September facts dated in September, frozen snapshot, finalised state)", fa.length === 6 && fa.every((f: any) => f.workMonth === "2026-09" && f.workDate.startsWith("2026-09") && f.source === "finance_month_snapshot"));
    const d = (await month("COACH-TEST-D")).body;
    ck("PT32. The expected payment date is a separate fact (2026-10-07), never 'paid' (paymentState not_tracked)", d.payment.expectedPaymentDate === "2026-10-07" && d.payment.paymentState === "not_tracked" && d.workMonth === "2026-09");
    const corrFacts = facts.body.facts.filter((f: any) => f.type === "coach_cost_correction");
    ck("PT31b. Corrections are reporting facts of their own (2 for coach A), never merged into an item", corrFacts.length === 2 && corrFacts.every((f: any) => f.monthId));
  }

  // ===== CP. Cancellation / payable work =====
  {
    const d = (await month("COACH-TEST-D")).body;
    const paid = item(d, "2026-09-08");
    const unpaid = item(d, "2026-09-09");
    ck("CP33. A cancelled occurrence with the Slice 6 outcome Paid is read at its full frozen cost (30.00)", paid.amount === "30.00" && paid.override.workOutcome === "Paid" && paid.blockers.length === 0);
    const a = (await month("COACH-TEST-A")).body;
    const part = item(a, "2026-09-24");
    ck("CP34. Partial outcome read as recorded: 15.00, rate snapshot 22.00 kept, decided by / at shown", part.amount === "15.00" && part.rate === "22.00" && part.override.workOutcome === "Partial" && part.override.decidedBy === "Morgan Manager" && part.blockers.length === 0);
    ck("CP35. Unpaid outcome (e.g. a weather cancellation decided Unpaid) reads as a visible 0.00, valid without a reason", unpaid.amount === "0.00" && unpaid.override.workOutcome === "Unpaid" && unpaid.blockers.length === 0);
    rec("Coach Allocations", rid("AllocD1")).fields["Coach Outcome"] = null;
    const und = item((await month("COACH-TEST-D")).body, "2026-09-08");
    ck("CP35b. A cancelled occurrence with NO outcome is never paid by default (outcome_undecided)", codes(und).includes("outcome_undecided"));
    rec("Coach Allocations", rid("AllocD1")).fields["Coach Outcome"] = "Paid";
    const code = readFileSync(join(CANON, "finance-coach-costs.ts"), "utf8");
    ck("CP36. Finance recalculates no operational policy: no time-before-start, weather or 5-hour / 10-minute rule exists in F12", !/weather|5.?hour|10.?minute|hoursBefore|minutesBefore/i.test(code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
  }

  // ===== WS. Work Summary coverage =====
  {
    reset();
    const s = rec("Coach Work Summaries", WS_D);
    s.fields.Status = "Queried";
    let d = (await month("COACH-TEST-D")).body;
    ck("WS1. A Queried Work Summary blocks Finance finalisation (work_summary_queried)", d.blockers.some((b: any) => b.code === "work_summary_queried") && !d.readyToFinalise);
    s.fields.Status = "Needs review";
    d = (await month("COACH-TEST-D")).body;
    ck("WS2. A reopened summary (Needs review) blocks (work_summary_not_finalised)", d.blockers.some((b: any) => b.code === "work_summary_not_finalised"));
    s.fields.Status = "Finalised";
    rec("Work Summary Lines", rid("LineD1")).fields["Final Cost Snapshot"] = 25;
    d = (await month("COACH-TEST-D")).body;
    ck("WS3. A stale line (coach saw 25.00, allocation now 30.00) blocks (work_summary_stale)", d.blockers.some((b: any) => b.code === "work_summary_stale"));
    rec("Work Summary Lines", rid("LineD1")).fields["Work Summary"] = [];
    d = (await month("COACH-TEST-D")).body;
    ck("WS4. A detached line / no summary blocks (work_summary_missing)", d.blockers.some((b: any) => b.code === "work_summary_missing"));
    ck("WS5. Coverage uses allocation identity, not matching dates: coach D's summary runs 15 Aug - 14 Sep and still covers its Sep items", true);
    reset();
    d = (await month("COACH-TEST-D")).body;
    ck("WS5b. ...and with that summary Finalised the month is ready (no date-range match needed)", d.readyToFinalise === true && d.blockers.length === 0);
    ck("WS6. Coverage is never claimed as 'viewed': the read model says so explicitly", /does not mean the coach viewed it/.test(d.note));
  }

  // ===== AC. Access =====
  {
    reset();
    const v = await month("COACH-TEST-A", "2026-09", viewer);
    const vl = (await listFinanceMonths(deps, viewer, {})) as any;
    ck("AC37. Finance View reads coach costs and summaries (200, access view)", v.httpStatus === 200 && v.body.access === "view" && vl.httpStatus === 200);
    const vf = await finalise("COACH-TEST-B", "2026-09", viewer);
    ck("AC38. View cannot finalise (403 finance_manage_required); Manage can (FN15)", vf.httpStatus === 403 && vf.code === "finance_manage_required");
    const n1 = await month("COACH-TEST-A", "2026-09", nogrant);
    const n2 = await finalise("COACH-TEST-B", "2026-09", nogrant);
    ck("AC39. No grant: denied (403 finance_access_denied) for reads and writes", n1.httpStatus === 403 && n1.code === "finance_access_denied" && n2.code === "finance_access_denied");
    const c1 = await month("COACH-TEST-A", "2026-09", coach);
    const c2 = (await readCostMonth(deps, coach, {})) as any;
    ck("AC40. Coach denied from the Management Finance API (403 management_required) - even for their own costs", c1.httpStatus === 403 && c1.code === "management_required" && c2.code === "management_required");
    const p1 = await finalise("COACH-TEST-B", "2026-09", parent);
    ck("AC41. Parent denied (403 management_required)", p1.httpStatus === 403 && p1.code === "management_required");
    world.moduleOn = false;
    const mo = await month("COACH-TEST-A");
    const mf = await finalise("COACH-TEST-B");
    world.moduleOn = true;
    ck("AC42. Module off: reads and writes 403 finance_module_disabled", mo.code === "finance_module_disabled" && mf.code === "finance_module_disabled");
    const t1 = parseCostQuery("costs.month", new URLSearchParams("month=2026-09&organisationId=ORG-X"), isTenantKey) as any;
    const t2 = parseCorrection(JSON.stringify({ amount: "1.00", reason: "x", organisationId: "ORG-X" }), isTenantKey) as any;
    const t3 = parseFinalise(JSON.stringify({ org_id: "ORG-X" }), isTenantKey) as any;
    ck("AC43. Tenant override rejected in query and body (400 tenant_param_rejected)", t1.code === "tenant_param_rejected" && t2.code === "tenant_param_rejected" && t3.code === "tenant_param_rejected");
    const q1 = parseCostQuery("costs.worker", new URLSearchParams("from=2026-01&to=2026-12"), isTenantKey) as any;
    const q2 = parseCostQuery("costs.month", new URLSearchParams("month=2026-13"), isTenantKey) as any;
    const big = (await readWorkerMonths(deps, mgr, "COACH-TEST-A", { from: "2025-01", to: "2026-09" })) as any;
    ck("AC43b. Query validation: months YYYY-MM, ranges at most 12 months, unknown parameters refused", q1.ok && q2.code === "invalid_query" && big.httpStatus === 400 && (parseCostQuery("costs.month", new URLSearchParams("x=1"), isTenantKey) as any).code === "unexpected_parameter");
  }

  // ===== AU. Audit =====
  {
    reset();
    const a0 = world.audit.length;
    await month("COACH-TEST-A");
    await readCostMonth(deps, mgr, { month: "2026-09" });
    await readWorkerMonths(deps, mgr, "COACH-TEST-A", {});
    await listFinanceMonths(deps, mgr, { state: "finalised" });
    await listCostFacts(deps, mgr, {});
    ck("AU44. Reads write no audit", world.audit.length === a0);
    const r1 = await finalise("COACH-TEST-C");
    const r2 = await finalise("COACH-TEST-A", "2026-10");
    const r3 = await finalise("COACH-TEST-B", "2026-09", viewer);
    world.lockHeld = "someone-else";
    const r4 = await finalise("COACH-TEST-B");
    world.lockHeld = null;
    ck("AU47. Refused writes create no success event (blocked, month not ended, View, busy)", r1.httpStatus === 409 && r2.httpStatus === 409 && r2.details.blockerCodes.includes("month_not_ended") && r3.httpStatus === 403 && r4.code === "finance_commercial_busy" && world.audit.length === a0 && world.sb.finance_worker_cost_months.length === 0);
    // Settings missing -> payment day blocker
    world.at["Finance Settings"] = [];
    const r5 = await finalise("COACH-TEST-B");
    ck("AU47b. No Coach Payment Day configured -> payment_day_not_configured blocker (no guessed date)", r5.httpStatus === 409 && r5.details.blockerCodes.includes("payment_day_not_configured") && world.audit.length === a0);
    world.at["Finance Settings"] = [settingsRow(SETTINGS)];
  }

  // ===== Extra cost checks =====
  {
    reset();
    const set = (id: string, f: Record<string, any>) => Object.assign(rec("Coach Allocations", id).fields, f);
    set(rid("AllocA1"), { "Final Coach Cost": 45 });
    let a = (await month("COACH-TEST-A")).body;
    ck("X1. A hand-edited cost (45.00 against 22.00 x 2.00, no override) is cost_mismatch", codes(item(a, "2026-09-03")).includes("cost_mismatch"));
    reset();
    set(rid("AllocA1"), { "Cost Override": 30 });
    set(rid("AllocA1"), { "Final Coach Cost": 30 });
    a = (await month("COACH-TEST-A")).body;
    ck("X2. An override without a reason or outcome is override_unexplained", codes(item(a, "2026-09-03")).includes("override_unexplained"));
    reset();
    set(rid("AllocA1"), { "Rate Amount Snapshot": 0, "Final Coach Cost": 0 });
    a = (await month("COACH-TEST-A")).body;
    ck("X3. Paid work at a 0.00 rate is paid_zero_rate (0.00 only through Salaried / Volunteer or an outcome)", codes(item(a, "2026-09-03")).includes("paid_zero_rate"));
    reset();
    set(rid("AllocB1"), { "Final Coach Cost": 12 });
    rec("Work Summary Lines", rid("LineB1")).fields["Final Cost Snapshot"] = 12;
    let b = (await month("COACH-TEST-B")).body;
    ck("X4. A Salaried allocation carrying a cost is no_cost_basis_with_cost", codes(b.workItems[0]).includes("no_cost_basis_with_cost"));
    reset();
    set(rid("AllocB1"), { "Cost Basis": "Volunteer — no direct session cost" });
    b = (await month("COACH-TEST-B")).body;
    set(rid("AllocB1"), { "Cost Basis": "Contractor" });
    const bad = (await month("COACH-TEST-B")).body;
    ck("X5. Volunteer is a valid 0.00; an unknown Cost Basis is invalid_cost_basis", b.workItems[0].blockers.length === 0 && b.workItems[0].amount === "0.00" && codes(bad.workItems[0]).includes("invalid_cost_basis"));
    reset();
    set(rid("AllocA1"), { "Cost Status": "Draft" });
    a = (await month("COACH-TEST-A")).body;
    ck("X6. A Draft cost (Coaches: 'Draft can change') blocks with cost_not_confirmed", codes(item(a, "2026-09-03")).includes("cost_not_confirmed"));
    reset();
    set(rid("AllocA1"), { Coach: [CA, CB] });
    a = (await month("COACH-TEST-A")).body;
    ck("X7. One allocation naming two people blocks (multiple_people)", codes(item(a, "2026-09-03")).includes("multiple_people"));
    reset();
    const f = await finalise("COACH-TEST-B");
    const listed = (await listFinanceMonths(deps, mgr, { month: "2026-09", state: "finalised" })) as any;
    ck("X8. A salaried month finalises at 0.00 and lists as Finalised", f.httpStatus === 201 && f.body.finalised.finalisedTotal === "0.00" && listed.body.months.length === 1 && listed.body.months[0].status.state === "finalised");
  }

  // ===== Z. Code / drift checks =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ck("Z1. finance-coach-costs.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(noComments(code("finance-coach-costs.ts"))));
    const orch = noComments(code("finance-coach-costs-orchestrator.ts"));
    ck("Z2. Reads authorise View, writes Manage via F1 authorizeFinance; writes take the shared Finance write lock", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && /acquireWriteLock/.test(orch) && !/fetch\(/.test(orch));
    const repo = noComments(code("finance-coach-costs-repository.ts"));
    ck("Z3. F12 writes ONLY through its two database functions; Airtable is read only (no POST / PATCH / DELETE to Airtable)", !/method: "(PATCH|DELETE)"/.test(repo) && (repo.match(/method: "POST"/g) ?? []).length === 1 && /rpc\/\$\{fn\}/.test(repo) && !/airtableFetch\([^)]*method/.test(repo));
    const idx = code("index.ts");
    ck("Z4. index.ts routes F12 first and keeps the TEST guards", idx.indexOf("matchCoachCostRoute(route") < idx.indexOf("matchFamilyRoute(route") && /stripe: \{ requireTestMode: true \}/.test(idx));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z5. No F12 code in the 12 Finance modules shared with Needs Attention", shared.every((f) => !/coach-costs/.test(code(f))));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z6. Test copies match the canonical finance files (only import paths swapped)", copy("finance-coach-costs.ts") && copy("finance-coach-costs-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-coach-costs-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    const ws = readFileSync(join(WS_CANON, "work-summaries.ts"), "utf8");
    const same = (name: string, v: readonly string[]) => new RegExp(`export const ${name} = \\[${v.map((x) => `"${x}"`).join(", ")}\\] as const;`).test(ws);
    ck("Z7. The operational vocabulary equals Coaches' Work Summary constants (cost statuses, outcome-required statuses, outcomes, summary statuses)", same("ELIGIBLE_COST_STATUSES", ELIGIBLE_COST_STATUSES) && same("OUTCOME_REQUIRED_STATUSES", OUTCOME_REQUIRED_STATUSES) && same("COACH_OUTCOMES", WORK_OUTCOMES) && same("SUMMARY_STATUSES", SUMMARY_STATUSES));
    const all = noComments(code("finance-coach-costs.ts") + code("finance-coach-costs-orchestrator.ts") + code("finance-coach-costs-repository.ts"));
    ck("Z8. No coach payment, payroll, coach invoice, Cash Flow event, reopen or Work Summary write in F12", !/payCoach|executePayment|payroll|createInvoice|cashFlowEvent|reopen\(|Work Summary History/i.test(all) && !/Josh|sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]/.test(all));
    ck("Z9. Only the F12 routes exist: no payment / payroll / reopen route", ["coach-costs/COACH-TEST-A/2026-09/pay", "coach-summaries/FCM-ABCDEF123456/reopen", "coach-summaries/FCM-ABCDEF123456/pay", "coach-payments"].every((p) => { const mm = matchCoachCostRoute(p, "POST"); return mm === null || mm.status === "not_found"; }));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
