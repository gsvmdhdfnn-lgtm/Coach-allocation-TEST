// Unit tests for Coaches Slice 10 (Coach Work Summaries - see TEST-ENV.md).
// Pure rules are exercised directly from coach-work-summaries-rules.ts;
// everything that writes runs through the REAL orchestrator against an
// in-memory Airtable (mocked global fetch, same convention as the Slice
// 7/8/9 tests) plus an in-memory LockClient, so the exact summary / line /
// history writes are asserted field by field. Items are numbered to match
// the Slice 10 brief's required list (1-27), followed by extra rule checks
// and drift checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HISTORY_EVENT_TYPES,
  RECEIPT_DISCLAIMER,
  SUMMARY_STATUSES,
  classifyAllocation,
  isWithinPeriod,
  reconcileLines,
  resolveActor,
  validatePeriod,
  type Actor,
  type AirtableRecord,
  type PlannedLine,
  type StoredLine,
} from "./coach-work-summaries-rules.ts";
import type { LockClient } from "./coach-work-summaries-lock-client.ts";
import { finaliseSummary, listSummaries, prepareSummary, querySummary, readSummary, refreshSummary, reopenSummary, type Deps } from "./coach-work-summaries-orchestrator.ts";
import { RETRY_DELAYS_MS } from "./coach-work-summaries-repository.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// ---------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ALEX = id("CoachAlex"), BEN = id("CoachBen");
const S_EVE = id("SessEve"), S_CAMP = id("SessCamp");
const RATE_ALEX = id("RateAlex");
const O = {
  JUL31: id("OccJul31"), AUG1: id("OccAug01"), AUG12: id("OccAug12"), CPAID: id("OccCPaid"), CPART: id("OccCPart"),
  CUNP: id("OccCUnp"), OVR: id("OccOvr"), AUG31: id("OccAug31"), SEP1: id("OccSep01"), CAMP: id("OccCamp"),
};
const A = {
  JUL31: id("AlJul31"), AUG1: id("AlAug01"), AUG12: id("AlAug12"), CPAID: id("AlCPaid"), CPART: id("AlCPart"),
  CUNP: id("AlCUnp"), OVR: id("AlOvr"), AUG31: id("AlAug31"), SEP1: id("AlSep01"), CAMP: id("AlCamp"), BEN12: id("AlBen12"),
};
const PERIOD = { periodStart: "2026-08-01", periodEnd: "2026-08-31" };
const T0 = new Date("2026-09-27T09:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60000);
const MGR: Actor = { kind: "management", userId: "mgr-uuid-0001", displayName: "Pat Manager" };
const MGR2: Actor = { kind: "management", userId: "mgr-uuid-0002", displayName: "Sam Manager" };
const coachActor = (c: string, name: string): Actor => ({ kind: "coach", userId: `u-${c}`, displayName: name, coachId: c });
const ALEX_A = coachActor(ALEX, "Alex Coach"), BEN_A = coachActor(BEN, "Ben Coach");

const occ = (oid: string, session: string, date: string, status = "Scheduled"): AirtableRecord => ({
  id: oid,
  fields: { "Session": [session], "Date": date, "Start Date & Time": `${date}T16:00:00.000Z`, "Status": status, "Occurrence Name": `${date} 17:00` },
});
const alloc = (aid: string, coach: string, o: string, extra: Record<string, any> = {}): AirtableRecord => ({
  id: aid,
  fields: {
    "Allocation ID": `ALLOC-${aid.slice(5, 12)}`, "Coach": [coach], "Session Occurrence": [o], "Rate Profile": [RATE_ALEX],
    "Rate Type Snapshot": "Evening", "Pay Unit Snapshot": "Per Session", "Paid Units": 1, "Rate Amount Snapshot": 30,
    "Final Coach Cost": 30, "Cost Status": "Confirmed", "Assignment Type": "Scheduled", "Notes": "management-only note", ...extra,
  },
});

function baseWorld(): Record<string, AirtableRecord[]> {
  return {
    "Coaches": [
      { id: ALEX, fields: { "Coach Name": "Alex Coach", "Coach ID": "COACH-ALEX", "Active": true } },
      { id: BEN, fields: { "Coach Name": "Ben Coach", "Coach ID": "COACH-BEN", "Active": true } },
    ],
    "Sessions": [
      { id: S_EVE, fields: { "Session Name": "U10 Tuesday", "Programme": "Evening Academy" } },
      { id: S_CAMP, fields: { "Session Name": "Summer Camp", "Programme": "Camps" } },
    ],
    "Session Occurrences": [
      occ(O.JUL31, S_EVE, "2026-07-31"), occ(O.AUG1, S_EVE, "2026-08-01"), occ(O.AUG12, S_EVE, "2026-08-12"),
      occ(O.CPAID, S_EVE, "2026-08-14", "Cancelled"), occ(O.CPART, S_EVE, "2026-08-15", "Cancelled"), occ(O.CUNP, S_EVE, "2026-08-16", "Postponed"),
      occ(O.OVR, S_EVE, "2026-08-20"), occ(O.AUG31, S_EVE, "2026-08-31", "Completed"), occ(O.SEP1, S_EVE, "2026-09-01"), occ(O.CAMP, S_CAMP, "2026-08-05"),
    ],
    "Coach Rate Profiles": [{ id: RATE_ALEX, fields: { "Coach": [ALEX], "Rate Type": "Evening", "Pay Unit": "Per Session", "Amount": 30, "Active": true } }],
    "Coach Allocations": [
      alloc(A.JUL31, ALEX, O.JUL31), alloc(A.AUG1, ALEX, O.AUG1), alloc(A.AUG12, ALEX, O.AUG12),
      alloc(A.CPAID, ALEX, O.CPAID, { "Coach Outcome": "Paid" }),
      alloc(A.CPART, ALEX, O.CPART, { "Coach Outcome": "Partial", "Cost Override": 15, "Override Reason": "Half session", "Final Coach Cost": 15 }),
      alloc(A.CUNP, ALEX, O.CUNP, { "Coach Outcome": "Unpaid", "Cost Override": 0, "Override Reason": "Cancelled early", "Final Coach Cost": 0 }),
      alloc(A.OVR, ALEX, O.OVR, { "Cost Override": 40, "Override Reason": "Agreed flat fee", "Final Coach Cost": 40 }),
      alloc(A.AUG31, ALEX, O.AUG31), alloc(A.SEP1, ALEX, O.SEP1),
      alloc(A.CAMP, ALEX, O.CAMP, { "Rate Type Snapshot": "Camp", "Pay Unit Snapshot": "Per Day", "Rate Amount Snapshot": 80, "Final Coach Cost": 80, "Cost Status": "Exported" }),
      alloc(A.BEN12, BEN, O.AUG12, { "Rate Amount Snapshot": 25, "Final Coach Cost": 25 }),
    ],
    "Coach Work Summaries": [],
    "Work Summary Lines": [],
    "Work Summary History": [],
  };
}
// Alex's August: 30 (Aug1) + 80 (camp) + 30 (Aug12) + 30 (cancelled Paid) + 15 (Partial) + 0 (Unpaid) + 40 (override) + 30 (Aug31)
const EXPECTED_TOTAL = 255;
const EXPECTED_LINES = 8;

// ---------------------------------------------------------------------
// In-memory Airtable (mocked global fetch) + in-memory lock
// ---------------------------------------------------------------------
let store: Record<string, AirtableRecord[]> = {};
let writes: { method: string; table: string; id?: string; fields?: any }[] = [];
let seq = 0;
let fetchDelayMs = 0;
let fail429 = 0;
let seen429 = 0;
let failOn: { method: string; table: string } | null = null;

function reset() {
  store = baseWorld();
  writes = [];
  fetchDelayMs = 0;
  failOn = null;
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = (async (url: any, init?: any) => {
  const u = new URL(String(url));
  const [, , , rawTable, rid] = u.pathname.split("/");
  const table = decodeURIComponent(rawTable);
  const method = (init?.method || "GET").toUpperCase();
  if (fetchDelayMs) await sleep(fetchDelayMs);
  if (fail429 > 0) {
    fail429--;
    seen429++;
    return new Response('{"errors":[{"error":"RATE_LIMIT_REACHED"}]}', { status: 429 });
  }
  if (failOn && failOn.method === method && failOn.table === table) {
    failOn = null;
    return new Response('{"error":"SIMULATED_FAILURE"}', { status: 500 });
  }
  const rows = store[table];
  const ok = (b: any) => new Response(JSON.stringify(b), { status: 200 });
  if (!rows) return new Response(JSON.stringify({ error: "TABLE_NOT_FOUND" }), { status: 404 });
  if (method === "GET" && !rid) return ok({ records: clone(rows) });
  if (method === "GET") {
    const r = rows.find((x) => x.id === rid);
    return r ? ok(clone(r)) : new Response('{"error":"NOT_FOUND"}', { status: 404 });
  }
  if (method === "POST") {
    const body = JSON.parse(init.body);
    const rec: AirtableRecord = { id: "rec" + ("NEW" + String(++seq).padStart(11, "0")), fields: clone(body.records[0].fields), createdTime: new Date().toISOString() };
    for (const k of Object.keys(rec.fields)) if (rec.fields[k] == null) delete rec.fields[k];
    rows.push(rec);
    writes.push({ method, table, id: rec.id, fields: body.records[0].fields });
    return ok({ records: [clone(rec)] });
  }
  if (method === "PATCH") {
    const r = rows.find((x) => x.id === rid);
    if (!r) return new Response('{"error":"NOT_FOUND"}', { status: 404 });
    const body = JSON.parse(init.body);
    Object.assign(r.fields, clone(body.fields));
    for (const k of Object.keys(r.fields)) if (r.fields[k] == null) delete r.fields[k];
    writes.push({ method, table, id: rid, fields: body.fields });
    return ok(clone(r));
  }
  writes.push({ method, table, id: rid });
  return new Response('{"error":"METHOD_NOT_ALLOWED_IN_MOCK"}', { status: 405 });
}) as any;

function memLock(): LockClient {
  const held = new Map<string, string>();
  let n = 0;
  return {
    async acquire(key) {
      if (held.has(key)) return null;
      const t = `tok-${++n}`;
      held.set(key, t);
      return t;
    },
    async release(key, token) {
      if (held.get(key) !== token) return false;
      held.delete(key);
      return true;
    },
  };
}
const noLock: LockClient = { acquire: async () => "always", release: async () => true };

let deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, lock: memLock() };
const rows = (t: string) => store[t];
const summaryRow = (sid: string) => rows("Coach Work Summaries").find((s) => s.id === sid)!;
const linesFor = (sid: string) => rows("Work Summary Lines").filter((l) => (l.fields["Work Summary"] ?? []).includes(sid));
const lineForAlloc = (sid: string, aid: string) => linesFor(sid).find((l) => l.fields["Coach Allocation"]?.[0] === aid);
const historyFor = (sid: string) => rows("Work Summary History").filter((h) => (h.fields["Work Summary"] ?? []).includes(sid));
const events = (sid: string) => historyFor(sid).map((h) => h.fields["Event Type"]);
const setAlloc = (aid: string, f: Record<string, any>) => Object.assign(rows("Coach Allocations").find((a) => a.id === aid)!.fields, f);

async function prepared(now = at(0)) {
  const out: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, now);
  if (out.status !== "created" && out.status !== "reused") throw new Error("prepare failed: " + JSON.stringify(out));
  return out.summary.summaryId as string;
}
async function finalised(now = at(1)) {
  const sid = await prepared(at(0));
  const out: any = await finaliseSummary(deps, MGR, sid, now);
  if (out.status !== "finalised") throw new Error("finalise failed: " + JSON.stringify(out));
  return sid;
}

async function main() {
  // ===== 1. Create a summary for one coach + period =====
  reset();
  const p1: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(0));
  const s1 = p1.summary;
  const row1 = summaryRow(s1.summaryId);
  ck("1. Management prepares a summary for a coach + period (created, production fields)", p1.status === "created" && row1.fields["Coach"][0] === ALEX && row1.fields["Period Start"] === "2026-08-01" && row1.fields["Period End"] === "2026-08-31" && row1.fields["Status"] === "Needs review" && row1.fields["Active"] === true && row1.fields["Work Summary ID"] === "WS-COACH-ALEX-20260801-20260831" && row1.fields["Summary Date"] === "2026-09-27");
  const previewAllocs = s1.lines.map((l: any) => l.allocationId);

  // ===== 2. Only that coach's allocations =====
  ck("2. Only that coach's allocations are included (Ben's same-day allocation is not)", !previewAllocs.includes(A.BEN12) && previewAllocs.length === EXPECTED_LINES);
  // ===== 3. Out-of-period excluded =====
  ck("3. Allocations outside the period are excluded (31 Jul, 1 Sep)", !previewAllocs.includes(A.JUL31) && !previewAllocs.includes(A.SEP1));
  // ===== 4/5. Boundaries inclusive =====
  ck("4. Period Start is inclusive (1 Aug work included)", previewAllocs.includes(A.AUG1) && isWithinPeriod("2026-08-01", { start: "2026-08-01", end: "2026-08-31" }));
  ck("5. Period End is inclusive (31 Aug work included)", previewAllocs.includes(A.AUG31) && isWithinPeriod("2026-08-31", { start: "2026-08-01", end: "2026-08-31" }));
  ck("1b. Draft summary writes no Lines (lines are frozen only at finalisation); preview total shown", rows("Work Summary Lines").length === 0 && s1.linesSource === "preview" && row1.fields["Grand Total"] === EXPECTED_TOTAL);
  ck("1c. Reaching Needs review writes one 'Needs Review' History event", JSON.stringify(events(s1.summaryId)) === JSON.stringify(["Needs Review"]));

  // ===== 6/7. Finalise creates correct Lines + Grand Total =====
  const f1: any = await finaliseSummary(deps, MGR, s1.summaryId, at(1));
  const sid = s1.summaryId;
  const ls = linesFor(sid);
  const l12 = lineForAlloc(sid, A.AUG12)!;
  ck(
    "6. Finalisation creates one frozen Line per eligible allocation with the production snapshot fields",
    f1.status === "finalised" && ls.length === EXPECTED_LINES &&
      l12.fields["Work Summary Line ID"] === `WSL-WS-COACH-ALEX-20260801-20260831-ALLOC-${A.AUG12.slice(5, 12)}` &&
      l12.fields["Work Date Snapshot"] === "2026-08-12" && l12.fields["Session Name Snapshot"] === "U10 Tuesday" && l12.fields["Group Label Snapshot"] === "Evening Academy" &&
      l12.fields["Rate Type Snapshot"] === "Evening" && l12.fields["Paid Units Snapshot"] === 1 && l12.fields["Rate Amount Snapshot"] === 30 && l12.fields["Final Cost Snapshot"] === 30 &&
      l12.fields["Coach Allocation"][0] === A.AUG12,
    JSON.stringify(l12?.fields)
  );
  const lineOrders = ls.map((l) => l.fields["Line Sort Order"]).sort((a, b) => a - b);
  const camp = lineForAlloc(sid, A.CAMP)!;
  ck("6b. Group/Line sort orders are deterministic (Camps group 1, Evening Academy group 2; lines 1..N)", camp.fields["Group Sort Order"] === 1 && camp.fields["Line Sort Order"] === 1 && l12.fields["Group Sort Order"] === 2 && JSON.stringify(lineOrders) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]));
  const sumLines = ls.reduce((a, l) => a + l.fields["Final Cost Snapshot"], 0);
  ck("7. Grand Total = sum of the Lines' Final Cost Snapshots", summaryRow(sid).fields["Grand Total"] === sumLines && sumLines === EXPECTED_TOTAL, `${summaryRow(sid).fields["Grand Total"]} vs ${sumLines}`);

  // ===== 10-13. Slice 5 override + Slice 6 outcomes survive into the summary =====
  const ovr = lineForAlloc(sid, A.OVR)!;
  ck("10. Slice 5 override: line keeps Rate Amount Snapshot £30 while Final Cost Snapshot = £40", ovr.fields["Rate Amount Snapshot"] === 30 && ovr.fields["Final Cost Snapshot"] === 40);
  const paid = lineForAlloc(sid, A.CPAID)!;
  ck("11. Cancelled + Coach Outcome Paid -> £30 line, described as cancelled", paid.fields["Final Cost Snapshot"] === 30 && paid.fields["Session Name Snapshot"] === "U10 Tuesday - Cancelled (Coach outcome: Paid)");
  const part = lineForAlloc(sid, A.CPART)!;
  ck("12. Cancelled + Partial -> £15 line (rate snapshot £30 kept)", part.fields["Final Cost Snapshot"] === 15 && part.fields["Rate Amount Snapshot"] === 30 && /Partial/.test(part.fields["Session Name Snapshot"]));
  const unp = lineForAlloc(sid, A.CUNP)!;
  ck("13. Postponed + Unpaid -> included as a visible £0 line (documented rule, not dropped)", !!unp && unp.fields["Final Cost Snapshot"] === 0 && /Postponed \(Coach outcome: Unpaid\)/.test(unp.fields["Session Name Snapshot"]));

  // ===== 19/20/22. Management finalises; By/At recorded; history =====
  const srow = summaryRow(sid);
  ck("19. Management finalises (Status Finalised, frozen)", srow.fields["Status"] === "Finalised" && f1.summary.frozen === true && f1.summary.linesSource === "frozen");
  ck("20. Finalised By User ID / Name Snapshot / At recorded", srow.fields["Finalised By User ID"] === MGR.userId && srow.fields["Finalised By Name Snapshot"] === "Pat Manager" && srow.fields["Finalised At"] === at(1).toISOString());
  const finEv = historyFor(sid).find((h) => h.fields["Event Type"] === "Finalised")!;
  ck("22. Finalisation writes a 'Finalised' History event (who/when/total)", !!finEv && finEv.fields["Changed By User ID"] === MGR.userId && finEv.fields["Changed At"] === at(1).toISOString() && /Grand Total £255\.00 across 8 line/.test(finEv.fields["Reason / Note"]));

  // ===== 27. Stable under repeated reads / retries =====
  const w0 = writes.length;
  const r1: any = await readSummary(deps, MGR, sid, at(2));
  const r2: any = await readSummary(deps, MGR, sid, at(3));
  const again: any = await finaliseSummary(deps, MGR, sid, at(4));
  ck("27. Finalised summary is stable: repeated reads identical, repeated finalise is a no-op (0 writes)", JSON.stringify(r1) === JSON.stringify(r2) && again.status === "already_finalised" && writes.length === w0 && summaryRow(sid).fields["Finalised At"] === at(1).toISOString());

  // ===== 8. Rate Profile change does not alter finalised lines =====
  rows("Coach Rate Profiles")[0].fields["Amount"] = 50;
  const r8: any = await readSummary(deps, MGR, sid, at(5));
  ck("8. Rate Profile change (£30 -> £50) does not alter the finalised summary", JSON.stringify(r8.summary.lines) === JSON.stringify(r1.summary.lines) && r8.summary.grandTotal === EXPECTED_TOTAL && writes.length === w0);

  // ===== 9. Allocation change does not silently alter the finalised summary =====
  setAlloc(A.AUG12, { "Final Coach Cost": 35, "Cost Override": 35, "Override Reason": "late correction" });
  const r9: any = await readSummary(deps, MGR, sid, at(6));
  const l9 = r9.summary.lines.find((l: any) => l.allocationId === A.AUG12);
  const drift = r9.summary.management.drift;
  ck("9. Allocation change does not alter the finalised line/Grand Total, and is surfaced to Management as drift", l9.finalCost === 30 && r9.summary.grandTotal === EXPECTED_TOTAL && writes.length === w0 && drift.length === 1 && drift[0].allocationId === A.AUG12 && drift[0].kind === "changed" && drift[0].currentFinalCost === 35);

  // ===== 14/15/16. Permissions =====
  const c14: any = await readSummary(deps, ALEX_A, sid, at(7));
  ck("14. Coach reads own summary + lines (no allocation/record ids, no Management block)", c14.status === "ok" && c14.summary.lines.length === EXPECTED_LINES && c14.summary.lines.every((l: any) => !("allocationId" in l) && !("recordId" in l)) && !c14.summary.management && c14.summary.history.every((h: any) => !("changedByUserId" in h)));
  const c15: any = await readSummary(deps, BEN_A, sid, at(7));
  const list15: any = await listSummaries(deps, BEN_A);
  const listAlex: any = await listSummaries(deps, ALEX_A);
  const listMgr: any = await listSummaries(deps, MGR);
  ck("15. Coach cannot read another coach's summary (404, and absent from their list)", c15.status === "rejected" && c15.httpStatus === 404 && list15.summaries.length === 0 && listAlex.summaries.length === 1 && listMgr.summaries.length === 1);
  const parent = resolveActor({ role: "parent", active: true, userId: "p1", displayName: "Parent", airtablePersonId: id("Parent1") });
  const inactiveCoach = resolveActor({ role: "coach", active: false, userId: "c9", displayName: "X", airtablePersonId: ALEX });
  const idx = readFileSync(join(CANON, "index.ts"), "utf8");
  ck("16. Parent (and inactive coach) cannot access work summaries at all (actor null -> 403 on every route)", parent === null && inactiveCoach === null && idx.includes("if (!actor) return { ok: false, response: jsonResponse({ error: \"Work summaries are available to Management and active Coaches only\" }, 403) };"));

  // ===== 17/21. Coach queries own summary =====
  const w17 = writes.length;
  const q: any = await querySummary(deps, ALEX_A, { summaryId: sid, note: "The 12 Aug session was 2 hours, not 1" }, at(8));
  const sq = summaryRow(sid);
  const qWrites = writes.slice(w17);
  ck("17. Coach queries own summary: Status Queried, Query / Reopen Note + Queried At set, no value/rate/line changed", q.status === "queried" && sq.fields["Status"] === "Queried" && sq.fields["Query / Reopen Note"] === "The 12 Aug session was 2 hours, not 1" && sq.fields["Queried At"] === at(8).toISOString() && sq.fields["Grand Total"] === EXPECTED_TOTAL && qWrites.every((w) => w.table !== "Work Summary Lines" && w.table !== "Coach Allocations") && qWrites.filter((w) => w.table === "Coach Work Summaries").every((w) => Object.keys(w.fields).sort().join("|") === "Queried At|Query / Reopen Note|Status"));
  const qEv = historyFor(sid).find((h) => h.fields["Event Type"] === "Queried")!;
  ck("21. Query writes a 'Queried' History event (coach as changer, note kept)", !!qEv && qEv.fields["Changed By User ID"] === ALEX_A.userId && qEv.fields["Changed By Name Snapshot"] === "Alex Coach" && qEv.fields["Reason / Note"] === "The 12 Aug session was 2 hours, not 1");
  const otherQ: any = await querySummary(deps, BEN_A, { summaryId: sid, note: "not mine" }, at(8));
  const dupQ: any = await querySummary(deps, ALEX_A, { summaryId: sid, note: "again" }, at(8));
  ck("17b. Another coach cannot query it (404); a second open query is refused (409)", otherQ.httpStatus === 404 && dupQ.httpStatus === 409 && dupQ.code === "already_queried");
  const qFrozen: any = await readSummary(deps, ALEX_A, sid, at(8));
  ck("17c. A queried FINALISED summary stays frozen (coach still sees the frozen lines)", qFrozen.summary.frozen === true && qFrozen.summary.lines.find((l: any) => l.workDate === "2026-08-12").finalCost === 30);

  // ===== 18. Coach cannot finalise (or prepare/refresh/reopen) =====
  const cf: any = await finaliseSummary(deps, ALEX_A, sid, at(9));
  const cp: any = await prepareSummary(deps, ALEX_A, { coachId: ALEX, ...PERIOD }, at(9));
  const cr: any = await reopenSummary(deps, ALEX_A, { summaryId: sid, reason: "x" }, at(9));
  const crf: any = await refreshSummary(deps, ALEX_A, sid, at(9));
  ck("18. Coach cannot finalise / prepare / reopen / refresh (403) - also route-gated to Management", [cf, cp, cr, crf].every((o) => o.status === "rejected" && o.httpStatus === 403) && /finalise: \{ method: "POST", who: "management" \}/.test(idx) && /reopen: \{ method: "POST", who: "management" \}/.test(idx) && /query: \{ method: "POST", who: "coach" \}/.test(idx));
  const mq: any = await querySummary(deps, MGR, { summaryId: sid, note: "x" }, at(9));
  ck("18b. Management cannot raise a coach query (403)", mq.httpStatus === 403);

  // ===== 23. Management reopen =====
  const finAtBefore = summaryRow(sid).fields["Finalised At"];
  const linesBefore = linesFor(sid).map((l) => l.id).sort();
  const ro: any = await reopenSummary(deps, MGR2, { summaryId: sid, reason: "Coach query upheld - 12 Aug was 2 hours" }, at(10));
  const sr = summaryRow(sid);
  const roEv = historyFor(sid).find((h) => h.fields["Event Type"] === "Reopened")!;
  ck(
    "23. Reopen records Reopened By/At + reason, writes a 'Reopened' event, keeps prior Finalised By/At and the frozen lines",
    ro.status === "reopened" && sr.fields["Status"] === "Needs review" && sr.fields["Reopened By User ID"] === MGR2.userId && sr.fields["Reopened By Name Snapshot"] === "Sam Manager" && sr.fields["Reopened At"] === at(10).toISOString() &&
      sr.fields["Query / Reopen Note"] === "Coach query upheld - 12 Aug was 2 hours" && sr.fields["Finalised At"] === finAtBefore && sr.fields["Finalised By User ID"] === MGR.userId &&
      JSON.stringify(linesFor(sid).map((l) => l.id).sort()) === JSON.stringify(linesBefore) && !!roEv && /Previous finalisation: Grand Total £255\.00 across 8 line/.test(roEv.fields["Reason / Note"]) && roEv.fields["Changed By User ID"] === MGR2.userId
  );
  const reRo: any = await reopenSummary(deps, MGR, { summaryId: sid, reason: "again" }, at(10));
  ck("23b. Reopening an already-open summary is refused (409 not_finalised)", reRo.httpStatus === 409 && reRo.code === "not_finalised");
  const openView: any = await readSummary(deps, MGR, sid, at(10));
  ck("23c. Reopened summary shows a live preview (12 Aug now £35) while prior frozen lines stay stored", openView.summary.linesSource === "preview" && openView.summary.lines.find((l: any) => l.allocationId === A.AUG12).finalCost === 35 && openView.summary.management.storedLines.find((l: any) => l.allocationId === A.AUG12).finalCost === 30);

  // ===== 24. Re-finalisation preserves the audit trail =====
  setAlloc(A.AUG12, { "Paid Units": 2, "Final Coach Cost": 60, "Cost Override": null, "Override Reason": null });
  const rf: any = await finaliseSummary(deps, MGR, sid, at(11));
  const l24 = lineForAlloc(sid, A.AUG12)!;
  const ev24 = events(sid);
  const refEv = historyFor(sid).find((h) => h.fields["Event Type"] === "Re-finalised")!;
  ck(
    "24. Re-finalisation: 'Re-finalised' event appended, earlier events untouched, same line record updated in place (no duplicate), Grand Total re-summed",
    rf.status === "finalised" && rf.eventType === "Re-finalised" && JSON.stringify(ev24) === JSON.stringify(["Needs Review", "Finalised", "Queried", "Reopened", "Re-finalised"]) &&
      l24.id === linesBefore.find((x) => x === l24.id) && l24.fields["Final Cost Snapshot"] === 60 && l24.fields["Paid Units Snapshot"] === 2 && linesFor(sid).length === EXPECTED_LINES &&
      summaryRow(sid).fields["Grand Total"] === EXPECTED_TOTAL + 30 && summaryRow(sid).fields["Finalised At"] === at(11).toISOString() &&
      /Changed WSL-.*final £30\.00 -> £60\.00/.test(refEv.fields["Reason / Note"]) && historyFor(sid).find((h) => h.fields["Event Type"] === "Finalised")!.fields["Changed At"] === at(1).toISOString(),
    JSON.stringify(ev24)
  );

  // ===== 25. Duplicate summary creation prevented / reused =====
  reset();
  const d1 = await prepared(at(0));
  const d2: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(1));
  const ov: any = await prepareSummary(deps, MGR, { coachId: ALEX, periodStart: "2026-08-15", periodEnd: "2026-09-14" }, at(1));
  const benOk: any = await prepareSummary(deps, MGR, { coachId: BEN, ...PERIOD }, at(1));
  ck("25. Same coach + exact period reuses the active summary; an overlapping period is refused (409); another coach is independent", d2.status === "reused" && d2.summary.summaryId === d1 && ov.httpStatus === 409 && ov.code === "overlapping_summary" && ov.conflictingSummaryId === d1 && benOk.status === "created" && rows("Coach Work Summaries").length === 2);
  reset();
  fetchDelayMs = 3;
  const conc: any[] = await Promise.all([1, 2, 3].map(() => prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(0))));
  fetchDelayMs = 0;
  ck("25b. Three concurrent prepares -> exactly one summary (per-coach lock), the others reuse it", rows("Coach Work Summaries").length === 1 && conc.filter((c) => c.status === "created").length === 1 && conc.filter((c) => c.status === "reused").length === 2 && events(conc[0].summary.summaryId).length === 1);
  reset();
  fetchDelayMs = 3;
  await Promise.all([1, 2].map(() => prepareSummary({ ...deps, lock: noLock }, MGR, { coachId: ALEX, ...PERIOD }, at(0))));
  fetchDelayMs = 0;
  ck("25c. Negative control: without the lock, concurrent prepares DO duplicate (so the lock is what prevents it)", rows("Coach Work Summaries").length === 2);

  // ===== 26. Duplicate line creation prevented =====
  reset();
  const dl = await prepared(at(0));
  failOn = { method: "POST", table: "Work Summary History" };
  let crashed = false;
  try {
    await finaliseSummary(deps, MGR, dl, at(1));
  } catch {
    crashed = true;
  }
  const afterCrash = linesFor(dl).length;
  const retry: any = await finaliseSummary(deps, MGR, dl, at(2));
  ck("26. Finalise retried after a mid-way failure: no duplicate lines, missing History row repaired once", crashed && afterCrash === EXPECTED_LINES && retry.status === "already_finalised" && linesFor(dl).length === EXPECTED_LINES && events(dl).filter((e) => e === "Finalised").length === 1);
  reset();
  const dl2 = await prepared(at(0));
  failOn = { method: "PATCH", table: "Coach Work Summaries" };
  try {
    await finaliseSummary(deps, MGR, dl2, at(1));
  } catch {
    /* expected */
  }
  const retry2: any = await finaliseSummary(deps, MGR, dl2, at(2));
  const allocIds = linesFor(dl2).map((l) => l.fields["Coach Allocation"][0]);
  ck("26b. Crash after lines but before the summary was marked Finalised: retry reuses the existing lines (one per allocation)", retry2.status === "finalised" && retry2.lineChanges.created === 0 && retry2.lineChanges.unchanged === EXPECTED_LINES && new Set(allocIds).size === allocIds.length && allocIds.length === EXPECTED_LINES);
  reset();
  const dl3 = await prepared(at(0));
  fetchDelayMs = 2;
  const cf2: any[] = await Promise.all([finaliseSummary(deps, MGR, dl3, at(1)), finaliseSummary(deps, MGR2, dl3, at(1))]);
  fetchDelayMs = 0;
  ck("26c. Two concurrent finalisations -> one set of lines, one Finalised event", linesFor(dl3).length === EXPECTED_LINES && cf2.filter((c) => c.status === "finalised").length === 1 && cf2.filter((c) => c.status === "already_finalised").length === 1 && events(dl3).filter((e) => e === "Finalised").length === 1);
  const pl = (aid: string, fc: number): PlannedLine => ({ allocationId: aid, lineId: `L-${aid}`, groupLabel: "G", groupSortOrder: 1, lineSortOrder: 1, workDate: "2026-08-01", sessionName: "S", rateType: "Evening", paidUnits: 1, rateAmount: 30, finalCost: fc });
  const st = (rid: string, aid: string, fc: number): StoredLine => ({ recordId: rid, ...pl(aid, fc) });
  const rc = reconcileLines([pl("a1", 30), pl("a2", 40)], [st("r1", "a1", 30), st("r1b", "a1", 30), st("r3", "a3", 10), st("r2", "a2", 35)]);
  ck("26d. reconcileLines: one line per allocation - duplicate + no-longer-eligible lines detached, changed line updated, none created twice", rc.create.length === 0 && rc.unchanged.length === 1 && rc.update.length === 1 && rc.update[0].recordId === "r2" && rc.detach.map((d) => d.recordId).sort().join(",") === "r1b,r3");

  // ===== Extra rule checks =====
  reset();
  setAlloc(A.AUG12, { "Cost Status": "Draft" });
  const nr: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(0));
  const nrf: any = await finaliseSummary(deps, MGR, nr.summary.summaryId, at(1));
  ck("E1. Draft Cost Status is pending (not dropped): summary Not ready, finalise refused with the item listed", nr.summary.status === "Not ready" && nr.summary.pending.length === 1 && nr.summary.pending[0].reason === "cost_not_confirmed" && nrf.httpStatus === 409 && nrf.code === "pending_items" && nrf.pending[0].allocationId === A.AUG12 && linesFor(nr.summary.summaryId).length === 0 && events(nr.summary.summaryId).length === 0);
  setAlloc(A.AUG12, { "Cost Status": "Confirmed" });
  const rr: any = await refreshSummary(deps, MGR, nr.summary.summaryId, at(2));
  ck("E2. Refresh after fixing it: Not ready -> Needs review with a 'Needs Review' event", rr.status === "refreshed" && summaryRow(nr.summary.summaryId).fields["Status"] === "Needs review" && JSON.stringify(events(nr.summary.summaryId)) === JSON.stringify(["Needs Review"]));
  reset();
  setAlloc(A.CPAID, { "Coach Outcome": null });
  const und: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(0));
  ck("E3. Cancelled occurrence without a Slice 6 Coach Outcome is pending (never silently paid or dropped)", und.summary.status === "Not ready" && und.summary.pending.some((p: any) => p.allocationId === A.CPAID && p.reason === "coach_outcome_undecided"));
  reset();
  const cur: any = await prepareSummary(deps, MGR, { coachId: ALEX, periodStart: "2026-09-01", periodEnd: "2026-09-30" }, at(0));
  const curF: any = await finaliseSummary(deps, MGR, cur.summary.summaryId, at(1));
  ck("E4. A period that has not ended yet is Not ready and cannot be finalised (period_not_ended)", cur.summary.status === "Not ready" && curF.httpStatus === 409 && curF.code === "period_not_ended");
  const odd: any = await prepareSummary(deps, MGR, { coachId: BEN, periodStart: "2026-08-10", periodEnd: "2026-08-12" }, at(0));
  ck("E5. Periods are explicit (not hard-coded months): a 3-day period works", odd.status === "created" && odd.summary.lines.length === 1 && odd.summary.lines[0].allocationId === A.BEN12);
  ck("E6. Period validation rejects bad dates / reversed ranges / > 366 days", "error" in validatePeriod("2026-02-30", "2026-03-01") && "error" in validatePeriod("2026-08-31", "2026-08-01") && "error" in validatePeriod("2025-01-01", "2026-12-31") && "period" in validatePeriod("2026-08-01", "2026-08-31"));
  const cls = classifyAllocation({ allocation: alloc(id("X1"), ALEX, O.AUG12, { "Created": "2026-10-05T10:00:00.000Z" }), occurrence: occ(O.AUG12, S_EVE, "2026-08-12"), session: null }, ALEX, { start: "2026-08-01", end: "2026-08-31" }, "2026-09-27");
  ck("E7. Work date (occurrence Date) decides the period, not the allocation's created timestamp", cls.kind === "eligible");
  reset();
  store["Coach Allocations"].push(alloc(id("AlNoOcc"), ALEX, id("OccMissing")));
  const ud: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(0));
  ck("E8. An allocation with no dated occurrence is surfaced to Management (undated), not silently ignored, and does not block", ud.summary.status === "Needs review" && ud.summary.management.undatedAllocations.length === 1);
  reset();
  const rsid = await finalised();
  const rv: any = await readSummary(deps, ALEX_A, rsid, at(2));
  const rcp = rv.summary.receipt;
  ck("E9. Receipt shape: disclaimer, period, groups with date/description/rate type/units/rate/final, subtotals, Grand Total", rcp.disclaimer === RECEIPT_DISCLAIMER && /not an invoice, payslip or payment/.test(rcp.disclaimer) && rcp.period.start === "2026-08-01" && rcp.groups.length === 2 && rcp.groups[0].label === "Camps" && rcp.groups[0].subtotal === 80 && rcp.groups[1].subtotal === 175 && rcp.grandTotal === EXPECTED_TOTAL && JSON.stringify(Object.keys(rcp.groups[1].items[0])) === JSON.stringify(["date", "description", "rateType", "paidUnits", "rateAmount", "finalAmount"]));
  const rfz: any = await refreshSummary(deps, MGR, rsid, at(3));
  ck("E10. Refreshing a finalised summary is refused (409 summary_finalised) - reopen first", rfz.httpStatus === 409 && rfz.code === "summary_finalised");
  reset();
  const draftQ = await prepared(at(0));
  const dq: any = await querySummary(deps, ALEX_A, { summaryId: draftQ, note: "Missing camp day?" }, at(1));
  const dqr: any = await refreshSummary(deps, MGR, draftQ, at(2));
  const dqf: any = await finaliseSummary(deps, MGR, draftQ, at(3));
  const dqEv = historyFor(draftQ).find((h) => h.fields["Event Type"] === "Finalised")!;
  ck("E11. Query on a Needs review summary: refresh keeps it Queried; Management finalising resolves it ('Finalised', note cites the query)", dq.status === "queried" && dqr.summary.status === "Queried" && dqf.status === "finalised" && dqf.eventType === "Finalised" && /Resolves query: Missing camp day\?/.test(dqEv.fields["Reason / Note"]));
  reset();
  setAlloc(A.AUG12, { "Cost Status": "Draft" });
  const nrq = await prepared(at(0));
  const nq: any = await querySummary(deps, ALEX_A, { summaryId: nrq, note: "?" }, at(1));
  const blank: any = await querySummary(deps, ALEX_A, { summaryId: nrq, note: "   " }, at(1));
  ck("E12. Query needs a note and a summary ready for review (Not ready -> 409, blank -> 400)", nq.httpStatus === 409 && nq.code === "not_ready" && blank.httpStatus === 400);
  ck("E13. Production Status / Event Type choices used exactly", JSON.stringify(SUMMARY_STATUSES) === JSON.stringify(["Not ready", "Needs review", "Finalised", "Queried"]) && JSON.stringify(HISTORY_EVENT_TYPES) === JSON.stringify(["Needs Review", "Finalised", "Queried", "Reopened", "Re-finalised"]));
  reset();
  const saved = RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1, 1, 1, 1, 1);
  fail429 = 3;
  seen429 = 0;
  const r429: any = await prepareSummary(deps, MGR, { coachId: ALEX, ...PERIOD }, at(0));
  RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, ...saved);
  ck("E14. Airtable 429s are retried with backoff (no 500, one summary)", r429.status === "created" && seen429 === 3 && rows("Coach Work Summaries").length === 1);
  const allWrites = writes.map((w) => w.table);
  ck("E15. Nothing is ever deleted, and allocations / rate profiles are never written by this function", !writes.some((w) => w.method === "DELETE") && !allWrites.includes("Coach Allocations") && !allWrites.includes("Coach Rate Profiles"));

  // ===== drift checks =====
  const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
  const sub = (s: string) => s.replace(/"\.\/work-summaries\.ts"/g, '"./coach-work-summaries-rules.ts"').replace(/"\.\/repository\.ts"/g, '"./coach-work-summaries-repository.ts"').replace(/"\.\/lock-client\.ts"/g, '"./coach-work-summaries-lock-client.ts"');
  for (const [src, dst] of [["work-summaries", "coach-work-summaries-rules"], ["repository", "coach-work-summaries-repository"], ["lock-client", "coach-work-summaries-lock-client"], ["orchestrator", "coach-work-summaries-orchestrator"]]) {
    const mirror = readFileSync(join(HERE, `${dst}.ts`), "utf8").split("\n").slice(5).join("\n");
    ck(`D1. tests/support/${dst}.ts == canonical coach-work-summaries/${src}.ts (only import paths adjusted)`, mirror === sub(canon(`${src}.ts`)));
  }
  const lockSrc = canon("lock-client.ts");
  ck("D2. Lock client calls the service-role-only work_summary lock RPCs", lockSrc.includes('"acquire_work_summary_lock", { p_coach_record_id: key }') && lockSrc.includes('"release_work_summary_lock", { p_coach_record_id: key, p_lock_token: lockToken }'));
  ck("D3. index.ts carries the TEST deployment guard for both production bases", idx.includes("apprptFotQuVL1mhs") && idx.includes("app6ex6UHY2RRO2Ak") && idx.includes("TEST function refusing to start"));
  const allSrc = ["index.ts", "orchestrator.ts", "work-summaries.ts", "repository.ts", "lock-client.ts"].map(canon).join("\n");
  ck("D4. No payment / invoice / Stripe / Xero / email integration anywhere in the function", !/stripe|xero|sendgrid|resend\.com|nodemailer|api\.stripe|invoice\s*\(/i.test(allSrc.replace(/not an invoice|NOT an invoice|invoices, exports|pays, invoices|invoice, payslip|Stripe\/Xero\/banking|invoices, emails/g, "")));

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");
const CANON = join(FUNCS, "coach-work-summaries");

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
