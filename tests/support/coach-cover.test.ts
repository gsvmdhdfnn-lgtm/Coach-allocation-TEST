// Unit tests for Coaches Slice 9 (cover workflow - see TEST-ENV.md). Pure
// rules are exercised directly from coach-cover-workflow.ts; everything
// that writes runs through the REAL orchestrator against an in-memory
// Airtable (mocked global fetch, same convention as the Slice 7/8 tests)
// plus an in-memory LockClient, so the exact Occurrence Staff / request /
// response writes are asserted field by field. Items are numbered to match
// the Slice 9 brief's required list (1-27), followed by drift checks.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dayOfWeekForDate } from "./coach-availability.ts";
import { summarizeCompliance } from "./coach-compliance.ts";
import {
  FUTURE_NOTIFICATION_EVENTS,
  deriveGroupStatus,
  determineRateType,
  evaluateSuitability,
  parseCreateRequestBody,
  planCancel,
  previewRate,
  resolveActor,
  unfilledSignal,
  type Actor,
  type AirtableRecord,
  type SuitabilityInput,
} from "./coach-cover-workflow.ts";
import type { LockClient } from "./coach-cover-lock-client.ts";
import { cancelCoverDate, createCoverRequest, detailForManagement, listForCoach, listForManagement, respondToCover, selectCover, type Deps } from "./coach-cover-orchestrator.ts";
import { buildStaffingContext, rosterForOccurrence } from "./coach-cover-staffing.ts";
import { RETRY_DELAYS_MS, loadWorld } from "./coach-cover-repository.ts";

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
const DANNY = id("CoachDanny"), JOE = id("CoachJoe"), TOM = id("CoachTom"), LEARNER = id("CoachLearner");
const BUSY = id("CoachBusy"), NOCOMP = id("CoachNoComp"), UNAV = id("CoachUnav"), AMBIG = id("CoachAmbig");
const UNKNOWN = id("CoachUnknown"), SOON = id("CoachSoon"), EXPIRED = id("CoachExpired"), UNVERIFIED = id("CoachUnverif");
const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach"), ROLE_LEARN = id("RoleLearn");
const S1 = id("SessMain"), S2 = id("SessOther"), S3 = id("SessPool");
const O1 = id("Occ1012"), O2 = id("Occ1019"), O3 = id("Occ1026"), OB = id("OccBusy1012"), OPAST = id("OccPast");
const SS_DANNY = id("SSDanny");
const MON1 = "2026-10-12", MON2 = "2026-10-19", MON3 = "2026-10-26";
const NOW = new Date("2026-10-01T09:00:00.000Z");
const MGR: Actor = { kind: "management", userId: "mgr-uuid-0001", displayName: "Pat Manager" };
const MGR2: Actor = { kind: "management", userId: "mgr-uuid-0002", displayName: "Sam Manager" };
const coach = (coachId: string, name = "Coach"): Actor => ({ kind: "coach", userId: `u-${coachId}`, displayName: name, coachId });

/** Europe/London wall-clock -> instant (BST until 2026-10-25). */
function ukIso(date: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const offset = date < "2026-10-25" ? 1 : 0;
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h - offset, m)).toISOString();
}
const occ = (oid: string, session: string, date: string, start = "17:00", end = "18:00", status = "Scheduled"): AirtableRecord => ({
  id: oid,
  fields: { "Session": [session], "Date": date, "Start Date & Time": ukIso(date, start), "End Date & Time": ukIso(date, end), "Status": status, "Occurrence Name": `${date} ${start}` },
});
const ss = (sid: string, session: string, c: string, role: string, extra: Record<string, any> = {}): AirtableRecord => ({
  id: sid,
  fields: { "Session": [session], "Coach": [c], "Role": [role], "Active": true, "Session Staff ID": sid, ...extra },
});
const VERIFIED = { "Verified By User ID": "prior-mgr", "Verified By Name Snapshot": "Prior Manager", "Verified At": "2026-09-01T10:00:00.000Z" };
const dbs = (c: string, extra: Record<string, any> = { ...VERIFIED, "Expiry / Review Date": "2027-06-30" }): AirtableRecord => ({
  id: id("Doc" + c.slice(8, 16)),
  fields: { "Coach": [c], "Document Type": "Enhanced DBS", "Active": true, ...extra },
});
const monAvail = (c: string, extra: Record<string, any> = {}): AirtableRecord => ({
  id: id("Av" + c.slice(8, 17)),
  fields: { "Coach": [c], "Day of Week": "Monday", "Available": true, "Active": true, "Start Time": "16:00", "End Time": "21:00", ...extra },
});

function baseWorld(): Record<string, AirtableRecord[]> {
  const candidates = [JOE, TOM, LEARNER, BUSY, NOCOMP, UNAV, AMBIG, UNKNOWN, SOON, EXPIRED, UNVERIFIED];
  const names: Record<string, string> = { [DANNY]: "Danny", [JOE]: "Joe", [TOM]: "Tom", [LEARNER]: "Lena Learner", [BUSY]: "Bea Busy", [NOCOMP]: "Nia NoDoc", [UNAV]: "Uma Unavailable", [AMBIG]: "Ari Ambiguous", [UNKNOWN]: "Una Unknown", [SOON]: "Sol Soon", [EXPIRED]: "Eve Expired", [UNVERIFIED]: "Ula Unverified" };
  return {
    "Coaches": [DANNY, ...candidates].map((c) => ({ id: c, fields: { "Coach Name": names[c], "Active": true } })),
    "Sessions": [S1, S2, S3].map((s) => ({ id: s, fields: { "Requires Lead Coach": false, "Required Staff Count": 1 } })),
    "Session Occurrences": [occ(O1, S1, MON1), occ(O2, S1, MON2), occ(O3, S1, MON3), occ(OB, S2, MON1, "17:30", "18:30"), occ(OPAST, S1, "2026-09-28")],
    "Session Staff": [
      ss(SS_DANNY, S1, DANNY, ROLE_COACH),
      ss(id("SSBusy"), S2, BUSY, ROLE_COACH),
      ...[JOE, TOM, NOCOMP, UNAV, AMBIG, UNKNOWN, SOON, EXPIRED, UNVERIFIED].map((c) => ss(id("SSPool" + c.slice(8, 15)), S3, c, ROLE_COACH)),
      ss(id("SSPoolLearn"), S3, LEARNER, ROLE_LEARN),
    ],
    "Occurrence Staff": [],
    "Coach Roles": [
      { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", "Active": true, "Can View Players": true } },
      { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", "Active": true, "Can View Players": true } },
      { id: ROLE_LEARN, fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", "Active": true, "Can View Players": false } },
    ],
    "Coach Availability": [
      ...[JOE, TOM, LEARNER, BUSY, NOCOMP, SOON, EXPIRED, UNVERIFIED, UNAV].map((c) => monAvail(c)),
      monAvail(AMBIG, { "Day of Week": null }), // blank weekday -> ambiguous (Slice 7 rule 16e)
    ],
    "Coach Availability Exceptions": [
      { id: id("ExUnav"), fields: { "Coach": [UNAV], "Active": true, "Availability Type": "Unavailable", "Start Date": MON1, "End Date": MON1 } },
    ],
    "Coach Documents": [
      ...[JOE, TOM, LEARNER, BUSY, UNAV, AMBIG, UNKNOWN].map((c) => dbs(c)),
      dbs(SOON, { ...VERIFIED, "Expiry / Review Date": "2026-10-30" }),
      dbs(EXPIRED, { ...VERIFIED, "Expiry / Review Date": "2026-10-05" }),
      dbs(UNVERIFIED, { "Expiry / Review Date": "2027-06-30" }),
    ],
    "Coach Document Requirements": [{ id: id("ReqDBS"), fields: { "Document Type": "Enhanced DBS", "Required": true, "Active": true, "Review Lead Days": 30 } }],
    "Coach Rate Profiles": [
      { id: id("RateJoe"), fields: { "Coach": [JOE], "Rate Type": "Evening", "Pay Unit": "Per Hour", "Amount": 20, "Active": true, "Effective From": "2026-01-01" } },
      { id: id("RateTom"), fields: { "Coach": [TOM], "Rate Type": "Evening", "Pay Unit": "Per Session", "Amount": 45, "Active": true } },
      { id: id("RateAmbA"), fields: { "Coach": [SOON], "Rate Type": "Evening", "Pay Unit": "Per Session", "Amount": 30, "Active": true } },
      { id: id("RateAmbB"), fields: { "Coach": [SOON], "Rate Type": "Evening", "Pay Unit": "Per Session", "Amount": 35, "Active": true } },
    ],
    "Coach Allocations": [{ id: id("AllocDanny"), fields: { "Coach": [DANNY], "Session Occurrence": [O1], "Rate Type Snapshot": "Evening" } }],
    "Cover Request Groups": [],
    "Staff Availability Requests": [],
    "Cover Responses": [],
  };
}

// ---------------------------------------------------------------------
// In-memory Airtable (mocked global fetch) + in-memory lock
// ---------------------------------------------------------------------
let store: Record<string, AirtableRecord[]> = {};
let writes: { method: string; table: string; id?: string; fields?: any }[] = [];
let seq = 0;
let clockMs = NOW.getTime();
let fetchDelayMs = 0;
let fail429 = 0;
let seen429 = 0;
const tablesRead: string[] = [];

function reset() {
  store = baseWorld();
  writes = [];
  clockMs = NOW.getTime();
  fetchDelayMs = 0;
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
  if (method === "GET" && !rid) tablesRead.push(table);
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
    const rec: AirtableRecord = { id: "rec" + ("NEW" + String(++seq).padStart(11, "0")), fields: clone(body.records[0].fields), createdTime: new Date(clockMs).toISOString() };
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
/** Negative control only: a "lock" that never excludes anyone. */
const noLock: LockClient = { acquire: async () => "always", release: async () => true };

let deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, lock: memLock() };
const tableRows = (t: string) => store[t];
const rd = (rid: string) => store["Staff Availability Requests"].find((r) => r.id === rid)!;
const roster = (occId: string) => {
  const ctx = buildStaffingContext(store["Session Staff"], store["Occurrence Staff"], store["Coach Roles"]);
  const o = store["Session Occurrences"].find((x) => x.id === occId)!;
  return rosterForOccurrence(ctx, { id: o.id, sessionId: o.fields["Session"][0], dateIso: o.fields["Date"] }).map((r) => r.coachId).sort();
};

async function makeRequest(occurrenceIds: string[], by: Actor = coach(DANNY, "Danny")) {
  const parsed = parseCreateRequestBody({ occurrenceIds, reason: "Illness", handoverNote: "Cones in the shed", coachId: by.kind === "management" ? DANNY : undefined }, by);
  if ("error" in parsed) throw new Error(parsed.error);
  const out = await createCoverRequest(deps, by, parsed.input, NOW);
  if (out.status !== "created") throw new Error("create failed: " + JSON.stringify(out));
  return out;
}
async function accept(dateId: string, c: string, answer = "Accept") {
  return respondToCover(deps, coach(c), { requestDateId: dateId, response: answer, note: null }, NOW);
}
const responseOf = (dateId: string, c: string) => store["Cover Responses"].find((r) => r.fields["Cover Request Date"]?.[0] === dateId && r.fields["Coach"]?.[0] === c)!;

async function main() {
  // ===== 1. Coach requests cover for own assignment =====
  reset();
  {
    const out = await makeRequest([O1]);
    const date = rd(out.dates[0].requestDateId);
    const group = store["Cover Request Groups"][0];
    ck(
      "1. Danny (Session Staff on O1) requests cover: one Group (Open, Coach Hub, Illness) + one date (Open, Cover Request, linked to O1 and the group)",
      out.dates.length === 1 && group.fields["Status"] === "Open" && group.fields["Requested Via"] === "Coach Hub" && group.fields["Reason"] === "Illness" &&
        date.fields["Cover Date Status"] === "Open" && date.fields["Request Type"] === "Cover Request" && date.fields["Session Occurrence"][0] === O1 &&
        date.fields["Cover Request Group"][0] === group.id && date.fields["Coach"][0] === DANNY,
      JSON.stringify(date.fields)
    );
    const dup = await createCoverRequest(deps, coach(DANNY), { occurrenceIds: [O1], reason: "Illness", handoverNote: null, coachNote: null, coachId: DANNY }, NOW);
    ck("1b. A second Open request for the same coach+occurrence is refused (no duplicate Open date)", dup.status === "rejected" && dup.code === "invalid_dates" && store["Staff Availability Requests"].length === 1);
    const past = await createCoverRequest(deps, coach(DANNY), { occurrenceIds: [OPAST], reason: "Illness", handoverNote: null, coachNote: null, coachId: DANNY }, NOW);
    ck("1c. Cover cannot be requested for a past occurrence", past.status === "rejected" && /past/.test(JSON.stringify(past)));
    const viaMgr = await createCoverRequest(deps, MGR, { occurrenceIds: [O2], reason: "Emergency", handoverNote: null, coachNote: null, coachId: DANNY }, NOW);
    ck("1d. Management may create a request on Danny's behalf (Requested Via = Management Hub)", viaMgr.status === "created" && store["Cover Request Groups"][1].fields["Requested Via"] === "Management Hub");
  }

  // ===== 2. Coach cannot request cover for unrelated assignment =====
  reset();
  {
    const other = parseCreateRequestBody({ occurrenceIds: [O1], reason: "Illness", coachId: DANNY }, coach(JOE));
    ck("2a. Joe naming Danny as coachId is refused at parse time (403)", "error" in other && other.httpStatus === 403);
    const before = writes.length;
    const out = await createCoverRequest(deps, coach(JOE), { occurrenceIds: [O1], reason: "Illness", handoverNote: null, coachNote: null, coachId: JOE }, NOW);
    ck("2b. Joe (not staffing O1) cannot request cover for it - rejected, nothing written", out.status === "rejected" && out.code === "invalid_dates" && writes.length === before && /not assigned/.test(JSON.stringify(out)));
    const mixed = await createCoverRequest(deps, coach(DANNY), { occurrenceIds: [O1, OB], reason: "Illness", handoverNote: null, coachNote: null, coachId: DANNY }, NOW);
    ck("2c. One invalid date (OB, Busy's session) rejects the WHOLE request - all-or-nothing, nothing written", mixed.status === "rejected" && writes.length === before);
  }

  // ===== 3. Multi-date group creates independent date statuses =====
  reset();
  let multi: Awaited<ReturnType<typeof makeRequest>>;
  {
    multi = await makeRequest([O1, O2, O3]);
    const ids = multi.dates.map((d) => d.requestDateId);
    ck("3a. One group, three separate date records, each Open", store["Cover Request Groups"].length === 1 && new Set(ids).size === 3 && ids.every((i) => rd(i).fields["Cover Date Status"] === "Open"));
    await accept(ids[0], JOE);
    const f = await selectCover(deps, MGR, { requestDateId: ids[0], responseId: responseOf(ids[0], JOE).id, confirmWarnings: false, rateType: null }, NOW);
    const c = await cancelCoverDate(deps, coach(DANNY), { requestDateId: ids[2], note: "Feeling better" }, NOW);
    ck(
      "3b. Dates resolve independently: 12 Oct Filled (Joe), 19 Oct still Open, 26 Oct Cancelled; group derives Partially Filled",
      f.status === "filled" && c.status === "cancelled" && rd(ids[0]).fields["Cover Date Status"] === "Filled" && rd(ids[1]).fields["Cover Date Status"] === "Open" &&
        rd(ids[2]).fields["Cover Date Status"] === "Cancelled" && store["Cover Request Groups"][0].fields["Status"] === "Partially Filled",
      `${rd(ids[0]).fields["Cover Date Status"]}/${rd(ids[1]).fields["Cover Date Status"]}/${rd(ids[2]).fields["Cover Date Status"]}/${store["Cover Request Groups"][0].fields["Status"]}`
    );
    ck(
      "3c. Group status derivation table",
      deriveGroupStatus(["Open", "Open"]) === "Open" && deriveGroupStatus(["Filled", "Open"]) === "Partially Filled" && deriveGroupStatus(["Filled", "Cancelled"]) === "Filled" &&
        deriveGroupStatus(["Cancelled", "Cancelled"]) === "Cancelled" && deriveGroupStatus(["Cancelled", "Resolved Without Cover"]) === "Resolved Without Cover"
    );
  }

  // ===== 4-6, 14-15: responses =====
  reset();
  const single = await makeRequest([O1]);
  const D1 = single.dates[0].requestDateId;
  {
    const a = await accept(D1, JOE);
    const r = responseOf(D1, JOE);
    ck(
      "4. Available, compliant, unclashed Joe can Accept: Response Status Yes, suitability 'suitable', not an assignment (no Occurrence Staff written)",
      a.status === "created" && r.fields["Response Status"] === "Yes" && a.suitability.status === "suitable" && store["Occurrence Staff"].length === 0 && rd(D1).fields["Cover Date Status"] === "Open",
      JSON.stringify(a)
    );
    const d = await accept(D1, TOM, "Decline");
    ck("5. Tom can Decline: Response Status No", d.status === "created" && responseOf(D1, TOM).fields["Response Status"] === "No");
    const again = await accept(D1, TOM, "Accept");
    ck("5b. Changing mind updates Tom's OWN response in place (still one row for Tom)", again.status === "updated" && store["Cover Responses"].filter((x) => x.fields["Coach"][0] === TOM).length === 1 && responseOf(D1, TOM).fields["Response Status"] === "Yes");
    ck("6. Multiple coaches can Accept the same date - Joe and Tom both Yes, date still Open", responseOf(D1, JOE).fields["Response Status"] === "Yes" && responseOf(D1, TOM).fields["Response Status"] === "Yes" && rd(D1).fields["Cover Date Status"] === "Open");
    ck(
      "14. Rate snapshot resolved where deterministic: Joe Evening Per Hour GBP20 x 1h = GBP20; Tom Evening Per Session GBP45 (Rate Type from Danny's own Coach Allocation)",
      responseOf(D1, JOE).fields["Normal Rate Snapshot"] === 20 && responseOf(D1, JOE).fields["Expected Cost Snapshot"] === 20 &&
        responseOf(D1, TOM).fields["Normal Rate Snapshot"] === 45 && responseOf(D1, TOM).fields["Expected Cost Snapshot"] === 45 &&
        JSON.parse(responseOf(D1, JOE).fields["Eligibility / Suitability Summary"]).rate.rateTypeSource === "requester_allocation",
      JSON.stringify(responseOf(D1, JOE).fields)
    );
    const selfResp = await accept(D1, DANNY);
    ck("4b. The requester cannot respond to their own request", selfResp.status === "rejected" && selfResp.code === "is_requester");
    const mgrResp = await respondToCover(deps, MGR, { requestDateId: D1, response: "Accept", note: null }, NOW);
    ck("4c. Management cannot respond as a coach", mgrResp.status === "rejected" && mgrResp.httpStatus === 403);
  }

  // ===== 15. Missing / ambiguous rate surfaced, not guessed =====
  {
    await accept(D1, UNKNOWN);
    const u = responseOf(D1, UNKNOWN);
    const snap = JSON.parse(u.fields["Eligibility / Suitability Summary"]);
    ck("15a. No Rate Profile for the candidate -> snapshots left EMPTY and rate marked requires_management_review/no_rate_profile", u.fields["Normal Rate Snapshot"] === undefined && u.fields["Expected Cost Snapshot"] === undefined && snap.rate.status === "requires_management_review" && snap.rate.reason === "no_rate_profile");
    const amb = previewRate(SOON, MON1, { rateType: "Evening", source: "management" }, store["Coach Rate Profiles"], 1);
    ck("15b. Two overlapping Rate Profiles -> requires_management_review/ambiguous_rate_profile, never one picked", amb.status === "requires_management_review" && amb.reason === "ambiguous_rate_profile");
    const noType = determineRateType(null, []);
    ck("15c. Requester has no Coach Allocation and Management gave no Rate Type -> no_rate_type (never inferred from the Session)", noType.rateType === null && noType.reason === "no_rate_type");
    const conflict = determineRateType(null, [{ id: "a", fields: { "Rate Type Snapshot": "Evening" } }, { id: "b", fields: { "Rate Type Snapshot": "Day" } }]);
    ck("15d. Requester allocations disagreeing on Rate Type -> ambiguous_rate_type", conflict.rateType === null && conflict.reason === "ambiguous_rate_type");
    const bad = determineRateType("Weekend", []);
    ck("15e. Unknown explicit Rate Type rejected, not coerced", bad.rateType === null && bad.reason === "invalid_rate_type");
    const noDur = previewRate(JOE, MON1, { rateType: "Evening", source: "management" }, store["Coach Rate Profiles"], null);
    ck("15f. Per Hour rate with no usable duration -> requires_management_review/duration_unknown", noDur.status === "requires_management_review" && noDur.reason === "duration_unknown");
  }

  // ===== 7-13: suitability =====
  const findings = async (c: string) => {
    const r = await accept(D1, c);
    if (r.status === "rejected" || r.status === "lock_unavailable") throw new Error(JSON.stringify(r));
    return r.suitability;
  };
  const codes = (xs: { code: string }[]) => xs.map((x) => x.code);
  {
    const s = await findings(UNAV);
    ck("7a. Unavailable (whole-day Unavailable exception) -> unsuitable with availability_unavailable", s.status === "unsuitable" && codes(s.blockers).includes("availability_unavailable"), JSON.stringify(s));
    const sel = await selectCover(deps, MGR, { requestDateId: D1, responseId: responseOf(D1, UNAV).id, confirmWarnings: true, rateType: null }, NOW);
    ck("7b. ...and Management cannot select them even with confirmWarnings (409 candidate_unsuitable); date stays Open", sel.status === "rejected" && sel.code === "candidate_unsuitable" && rd(D1).fields["Cover Date Status"] === "Open");
  }
  {
    const s = await findings(UNKNOWN);
    ck("8a. No availability supplied -> needs_management_review (availability_unknown), never 'suitable'", s.status === "needs_management_review" && codes(s.warnings).includes("availability_unknown"), JSON.stringify(s));
    const sel = await selectCover(deps, MGR, { requestDateId: D1, responseId: responseOf(D1, UNKNOWN).id, confirmWarnings: false, rateType: null }, NOW);
    ck("8b. Selecting an unknown-availability coach without explicit confirmWarnings -> 409 warnings_require_confirmation", sel.status === "rejected" && sel.code === "warnings_require_confirmation" && rd(D1).fields["Cover Date Status"] === "Open");
  }
  {
    const s = await findings(AMBIG);
    ck("9. Ambiguous availability (blank weekday row) fails safe -> unsuitable/availability_ambiguous", s.status === "unsuitable" && codes(s.blockers).includes("availability_ambiguous"), JSON.stringify(s));
  }
  {
    const s = await findings(BUSY);
    const clash = s.blockers.find((b) => b.code === "overlapping_assignment");
    ck("10a. Busy is Session Staff on OB (17:30-18:30 same Monday) -> overlapping_assignment blocker naming OB", s.status === "unsuitable" && !!clash && clash.detail.includes(OB), JSON.stringify(s));
    const base: SuitabilityInput = {
      candidateCoachId: JOE, candidateActive: true, requesterCoachId: DANNY, targetRosterCoachIds: [DANNY],
      availability: { status: "available" } as any, compliance: summarizeCompliance(JOE, store["Coach Documents"], store["Coach Document Requirements"], MON1),
      requiredRole: { rank: 2, roleName: "Coach" }, candidateRole: { rank: 2, roleName: "Coach" }, overlap: { clashes: [], uncertain: [] }, requiresLeadCoach: false, otherLeadCoachesRemaining: 0,
    };
    const unc = evaluateSuitability({ ...base, overlap: { clashes: [], uncertain: [{ id: "recSameDayNoTime1" }] } });
    ck("10b. A same-day assignment with unusable times is not ignored -> overlap_uncertain warning", unc.status === "needs_management_review" && codes(unc.warnings).includes("overlap_uncertain"));
    const ne = evaluateSuitability({ ...base, overlap: null, availability: null });
    ck("10c. Target occurrence without usable times -> availability/overlap not evaluable warnings (never 'suitable')", ne.status === "needs_management_review" && codes(ne.warnings).includes("overlap_not_evaluable") && codes(ne.warnings).includes("availability_not_evaluable"));
    ck("10d. Clean baseline really is suitable (controls for 10b/10c)", evaluateSuitability(base).status === "suitable");

    // ===== 11. compliance blocks =====
    const miss = await findings(NOCOMP);
    const exp = await findings(EXPIRED);
    const unv = await findings(UNVERIFIED);
    ck(
      "11. Required Enhanced DBS Missing / Expired-by-the-cover-date / unverified (Needs Review) each -> unsuitable/compliance_blocking",
      [miss, exp, unv].every((x) => x.status === "unsuitable" && codes(x.blockers).includes("compliance_blocking")) &&
        miss.blockers.some((b) => /Missing/.test(b.detail)) && exp.blockers.some((b) => /Expired/.test(b.detail)) && unv.blockers.some((b) => /Needs Review/.test(b.detail)),
      JSON.stringify([miss.blockers, exp.blockers, unv.blockers])
    );

    // ===== 12. Review Soon =====
    const soon = await findings(SOON);
    ck("12. Review Soon (DBS review 30 Oct, lead 30 days, cover 12 Oct) stays usable: suitable, with compliance_review_soon as INFO only", soon.status === "suitable" && codes(soon.info).includes("compliance_review_soon") && soon.blockers.length === 0 && soon.warnings.length === 0, JSON.stringify(soon));

    // ===== 13. roles =====
    const learn = await findings(LEARNER);
    ck("13a. Learning Coach cannot replace Danny's Coach role -> unsuitable/role_insufficient", learn.status === "unsuitable" && codes(learn.blockers).includes("role_insufficient"), JSON.stringify(learn));
    const lead = { ...base, requiredRole: { rank: 3, roleName: "Lead Coach" }, candidateRole: { rank: 1, roleName: "Learning Coach" } };
    ck("13b. Learning Coach can never replace a Lead Coach", evaluateSuitability(lead).status === "unsuitable" && codes(evaluateSuitability(lead).blockers).includes("role_insufficient"));
    const coachForLeadReq = { ...base, requiredRole: { rank: 3, roleName: "Lead Coach" }, candidateRole: { rank: 2, roleName: "Coach" }, requiresLeadCoach: true, otherLeadCoachesRemaining: 0 };
    ck("13c. Session Requires Lead Coach and no other Lead would remain -> a Coach replacing the Lead is blocked (lead_coach_required)", codes(evaluateSuitability(coachForLeadReq).blockers).includes("lead_coach_required"));
    const coachForLeadOk = { ...coachForLeadReq, otherLeadCoachesRemaining: 1 };
    ck("13d. ...with another Lead remaining it is a visible role_downgrade warning, never silent", evaluateSuitability(coachForLeadOk).status === "needs_management_review" && codes(evaluateSuitability(coachForLeadOk).warnings).includes("role_downgrade"));
    const noRole = { ...base, candidateRole: null };
    ck("13e. Candidate with no current recurring role -> role_capability_unknown warning (capability never assumed)", codes(evaluateSuitability(noRole).warnings).includes("role_capability_unknown"));
    const inactive = evaluateSuitability({ ...base, candidateActive: false });
    ck("13f. Inactive Coach record -> coach_inactive blocker", codes(inactive.blockers).includes("coach_inactive"));
  }

  // ===== 16-20: final selection =====
  {
    const ssBefore = clone(store["Session Staff"]);
    const tomBefore = clone(responseOf(D1, TOM));
    const w0 = writes.length;
    const sel = await selectCover(deps, MGR, { requestDateId: D1, responseId: responseOf(D1, JOE).id, confirmWarnings: false, rateType: null }, NOW);
    const date = rd(D1);
    ck(
      "16. Management selects Joe: date Filled, Replacement Coach Joe, Decision By Pat Manager (user id + name) and Decision At recorded",
      sel.status === "filled" && date.fields["Cover Date Status"] === "Filled" && date.fields["Replacement Coach"][0] === JOE &&
        date.fields["Decision By User ID"] === MGR.userId && date.fields["Decision By Name Snapshot"] === "Pat Manager" && date.fields["Decision At"] === NOW.toISOString(),
      JSON.stringify(sel)
    );
    const os = store["Occurrence Staff"];
    const cover = os[0];
    ck(
      "17. Exactly one Occurrence Staff row: Cover, Coach Joe, O1 only, Session Staff Source = Danny's Session Staff row, Planned Role Coach, Management Confirmed by Pat; linked back on the date",
      os.length === 1 && cover.fields["Occurrence Staff ID"] === `COVER-${D1}` && cover.fields["Assignment Type"] === "Cover" && cover.fields["Coach"][0] === JOE &&
        cover.fields["Session Occurrence"][0] === O1 && cover.fields["Session Staff Source"][0] === SS_DANNY && cover.fields["Planned Role Snapshot"] === "Coach" &&
        cover.fields["Management Confirmed"] === true && cover.fields["Confirmed By User ID"] === MGR.userId && date.fields["Occurrence Staff"][0] === cover.id,
      JSON.stringify(cover.fields)
    );
    ck(
      "18. O1 now resolves to Joe and NOT Danny (Slice 3 Cover semantics) - and Session Staff was never written",
      JSON.stringify(roster(O1)) === JSON.stringify([JOE]) && JSON.stringify(store["Session Staff"]) === JSON.stringify(ssBefore) && !writes.slice(w0).some((w) => w.table === "Session Staff"),
      JSON.stringify(roster(O1))
    );
    ck("19. The following occurrence (19 Oct) still resolves to Danny only", JSON.stringify(roster(O2)) === JSON.stringify([DANNY]) && JSON.stringify(roster(O3)) === JSON.stringify([DANNY]));
    ck(
      "20. Tom's unselected Accept is preserved exactly as it was (Yes, Active, untouched - no response writes during selection)",
      JSON.stringify(responseOf(D1, TOM)) === JSON.stringify(tomBefore) && !writes.slice(w0).some((w) => w.table === "Cover Responses")
    );
    ck("20b. Group derives Filled after its only date is filled", store["Cover Request Groups"][0].fields["Status"] === "Filled");

    // ===== 24. duplicate final selection =====
    const w1 = writes.length;
    const dup = await selectCover(deps, MGR, { requestDateId: D1, responseId: responseOf(D1, JOE).id, confirmWarnings: false, rateType: null }, NOW);
    ck("24a. Repeating the same selection is idempotent: already_filled, no writes, still one Occurrence Staff row", dup.status === "already_filled" && writes.length === w1 && store["Occurrence Staff"].length === 1);
    const other = await selectCover(deps, MGR2, { requestDateId: D1, responseId: responseOf(D1, TOM).id, confirmWarnings: false, rateType: null }, NOW);
    ck("24b. Selecting a DIFFERENT coach for a Filled date -> 409 already_filled_by_other, nothing written", other.status === "rejected" && other.code === "already_filled_by_other" && writes.length === w1);
    const late = await accept(D1, SOON);
    ck("24c. No new responses once Filled (409 date_not_open)", late.status === "rejected" && late.code === "date_not_open");

    // ===== 22. filled request cannot be cancelled into inconsistency =====
    const cc = await cancelCoverDate(deps, coach(DANNY), { requestDateId: D1, note: null }, NOW);
    const mc = await cancelCoverDate(deps, MGR, { requestDateId: D1, note: null }, NOW);
    ck(
      "22. Cancelling a Filled date (by Danny or Management) -> 409 filled_requires_deliberate_unassignment; date stays Filled, cover row stays; nothing ever DELETEd",
      cc.status === "rejected" && cc.code === "filled_requires_deliberate_unassignment" && mc.status === "rejected" && mc.code === "filled_requires_deliberate_unassignment" &&
        rd(D1).fields["Cover Date Status"] === "Filled" && store["Occurrence Staff"].length === 1 && !writes.some((w) => w.method === "DELETE")
    );
  }

  // ===== 24d. recovery: a cover row left by a failed earlier attempt is reused, not duplicated =====
  reset();
  {
    const out = await makeRequest([O1]);
    const d = out.dates[0].requestDateId;
    await accept(d, JOE);
    store["Occurrence Staff"].push({ id: id("OSLeftover"), fields: { "Occurrence Staff ID": `COVER-${d}`, "Session Occurrence": [O1], "Coach": [JOE], "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY] } });
    const sel = await selectCover(deps, MGR, { requestDateId: d, responseId: responseOf(d, JOE).id, confirmWarnings: false, rateType: null }, NOW);
    ck("24d. Retry after a partial failure reuses the deterministic COVER-{date} row (PATCH, no second row)", sel.status === "filled" && sel.occurrenceStaffId === id("OSLeftover") && store["Occurrence Staff"].length === 1, JSON.stringify(sel));
  }

  // ===== 17b. requester staffed only via Occurrence Staff =====
  reset();
  {
    store["Occurrence Staff"].push({ id: id("OSExtraDanny"), fields: { "Occurrence Staff ID": "EXTRA", "Session Occurrence": [OB], "Coach": [DANNY], "Assignment Type": "Additional", "Attendance": "Planned" } });
    const out = await makeRequest([OB]);
    const d = out.dates[0].requestDateId;
    await accept(d, JOE);
    const sel = await selectCover(deps, MGR, { requestDateId: d, responseId: responseOf(d, JOE).id, confirmWarnings: true, rateType: "Evening" }, NOW);
    const extra = store["Occurrence Staff"].find((r) => r.id === id("OSExtraDanny"))!;
    ck(
      "17b. Danny staffed OB only via an Additional Occurrence Staff row: that row is marked Absent (kept, not deleted) and OB resolves to Busy + Joe, not Danny",
      sel.status === "filled" && extra.fields["Attendance"] === "Absent" && JSON.stringify(roster(OB)) === JSON.stringify([BUSY, JOE].sort()),
      JSON.stringify(sel) + JSON.stringify(roster(OB))
    );
  }

  // ===== 21. requester can cancel open request =====
  reset();
  {
    const out = await makeRequest([O1, O2]);
    const [a, b] = out.dates.map((d) => d.requestDateId);
    const joeTry = await cancelCoverDate(deps, coach(JOE), { requestDateId: a, note: null }, NOW);
    ck("21a. Another coach cannot cancel Danny's request (403 not_own_request)", joeTry.status === "rejected" && joeTry.code === "not_own_request");
    const c = await cancelCoverDate(deps, coach(DANNY), { requestDateId: a, note: "Recovered" }, NOW);
    ck(
      "21b. Danny cancels his own Open date: Cancelled with Decision By/At, note appended to Coach Note, record kept; other date untouched",
      c.status === "cancelled" && rd(a).fields["Cover Date Status"] === "Cancelled" && rd(a).fields["Decision By User ID"] === `u-${DANNY}` && /Recovered/.test(rd(a).fields["Coach Note"]) &&
        store["Staff Availability Requests"].length === 2 && rd(b).fields["Cover Date Status"] === "Open" && store["Cover Request Groups"][0].fields["Status"] === "Open"
    );
    const again = await cancelCoverDate(deps, coach(DANNY), { requestDateId: a, note: null }, NOW);
    ck("21c. Cancelling again is a harmless already_cancelled", again.status === "already_cancelled");
    const m = await cancelCoverDate(deps, MGR, { requestDateId: b, note: "Session merged" }, NOW);
    ck("21d. Management can cancel; note goes to Management Note; group derives Cancelled", m.status === "cancelled" && /Session merged/.test(rd(b).fields["Management Note"]) && store["Cover Request Groups"][0].fields["Status"] === "Cancelled");
    const late = await accept(a, JOE);
    ck("21e. A cancelled date accepts no responses", late.status === "rejected" && late.code === "date_not_open");
  }

  // ===== 23. 24h boundary =====
  {
    const created = "2026-10-01T09:00:00.000Z";
    const t = Date.parse(created);
    const before = unfilledSignal("Open", created, new Date(t + 24 * 3600_000 - 1));
    const at = unfilledSignal("Open", created, new Date(t + 24 * 3600_000));
    const filled = unfilledSignal("Filled", created, new Date(t + 48 * 3600_000));
    const cancelled = unfilledSignal("Cancelled", created, new Date(t + 48 * 3600_000));
    ck("23a. Open for 23:59:59.999 -> false; exactly 24h -> true; Filled/Cancelled never flagged", !before.unfilledOver24h && at.unfilledOver24h && at.openForMinutes === 1440 && !filled.unfilledOver24h && !cancelled.unfilledOver24h);
    ck("23b. Missing/invalid createdTime never raises the signal", !unfilledSignal("Open", undefined, NOW).unfilledOver24h && !unfilledSignal("Open", "nonsense", NOW).unfilledOver24h);
    const skew = unfilledSignal("Open", created, new Date(t - 500));
    ck("23b2. A just-created record whose second-precision createdTime is fractionally ahead of our clock reads 0 minutes, never negative", skew.openForMinutes === 0 && !skew.unfilledOver24h);
    reset();
    const out = await makeRequest([O1, O2]);
    const [a] = out.dates.map((d) => d.requestDateId);
    await cancelCoverDate(deps, MGR, { requestDateId: out.dates[1].requestDateId, note: null }, NOW);
    const l1 = await listForManagement(deps, { status: null, asOf: new Date(NOW.getTime() + 24 * 3600_000 - 1000) });
    const l2 = await listForManagement(deps, { status: null, asOf: new Date(NOW.getTime() + 24 * 3600_000) });
    const f = (l: any, x: string) => l.dates.find((d: any) => d.requestDateId === x);
    ck(
      "23c. Management list derives the signal from the record's own createdTime: 1s before 24h -> not flagged; at 24h -> the Open date flagged, the Cancelled one not",
      f(l1, a).unfilledOver24h === false && f(l2, a).unfilledOver24h === true && l2.unfilledOver24hCount === 1 && f(l2, out.dates[1].requestDateId).unfilledOver24h === false
    );
  }

  // ===== 25. concurrency =====
  reset();
  {
    const out = await makeRequest([O1]);
    const d = out.dates[0].requestDateId;
    await accept(d, JOE);
    await accept(d, TOM);
    deps = { ...deps, lock: memLock() };
    fetchDelayMs = 3;
    const [x, y] = await Promise.all([
      selectCover(deps, MGR, { requestDateId: d, responseId: responseOf(d, JOE).id, confirmWarnings: false, rateType: null }, NOW, { maxAttempts: 400, retryDelayMs: 5 }),
      selectCover(deps, MGR2, { requestDateId: d, responseId: responseOf(d, TOM).id, confirmWarnings: false, rateType: null }, NOW, { maxAttempts: 400, retryDelayMs: 5 }),
    ]);
    fetchDelayMs = 0;
    const statuses = [x.status, y.status].sort();
    const loser = x.status === "filled" ? y : x;
    const winner = x.status === "filled" ? x : y;
    const covers = store["Occurrence Staff"].filter((r) => r.fields["Assignment Type"] === "Cover" && r.fields["Session Occurrence"][0] === O1);
    ck(
      "25a. Two managers select Joe and Tom for the same date concurrently: exactly one 'filled', the other a safe 409 already_filled_by_other; one Cover row; date's Replacement Coach = that row's coach = O1's only coach",
      JSON.stringify(statuses) === JSON.stringify(["filled", "rejected"]) && (loser as any).code === "already_filled_by_other" && covers.length === 1 &&
        rd(d).fields["Replacement Coach"][0] === covers[0].fields["Coach"][0] && (winner as any).replacementCoachId === covers[0].fields["Coach"][0] &&
        JSON.stringify(roster(O1)) === JSON.stringify([covers[0].fields["Coach"][0]]),
      JSON.stringify([x, y].map((z: any) => [z.status, z.code]))
    );
    // Negative control: same race with a lock that excludes nobody.
    reset();
    const out2 = await makeRequest([O1]);
    const d2 = out2.dates[0].requestDateId;
    await accept(d2, JOE);
    await accept(d2, TOM);
    fetchDelayMs = 3;
    const unlocked: Deps = { ...deps, lock: noLock };
    await Promise.all([
      selectCover(unlocked, MGR, { requestDateId: d2, responseId: responseOf(d2, JOE).id, confirmWarnings: false, rateType: null }, NOW),
      selectCover(unlocked, MGR2, { requestDateId: d2, responseId: responseOf(d2, TOM).id, confirmWarnings: false, rateType: null }, NOW),
    ]);
    fetchDelayMs = 0;
    ck("25b. Control: WITHOUT the lock the same race writes two cover rows - so the per-date lock is what makes 25a safe", store["Occurrence Staff"].length === 2, String(store["Occurrence Staff"].length));
    deps = { ...deps, lock: memLock() };
    const busy = memLock();
    await busy.acquire(d2);
    const blocked = await selectCover({ ...deps, lock: busy }, MGR, { requestDateId: d2, responseId: responseOf(d2, JOE).id, confirmWarnings: false, rateType: null }, NOW, { maxAttempts: 3, retryDelayMs: 1 });
    ck("25c. A lock held elsewhere past the retry budget -> lock_unavailable, nothing written", blocked.status === "lock_unavailable");
  }

  // ===== 26. Coach cannot finalise / alter others =====
  reset();
  {
    const out = await makeRequest([O1]);
    const d = out.dates[0].requestDateId;
    await accept(d, JOE);
    const joeResp = clone(responseOf(d, JOE));
    const w = writes.length;
    const self = await selectCover(deps, coach(JOE), { requestDateId: d, responseId: responseOf(d, JOE).id, confirmWarnings: true, rateType: null }, NOW);
    const req = await selectCover(deps, coach(DANNY), { requestDateId: d, responseId: responseOf(d, JOE).id, confirmWarnings: true, rateType: null }, NOW);
    ck("26a. A coach (Joe for himself, or the requester Danny) cannot finalise - 403 management_only, nothing written", self.status === "rejected" && self.httpStatus === 403 && req.status === "rejected" && req.httpStatus === 403 && writes.length === w && store["Occurrence Staff"].length === 0);
    await accept(d, TOM, "Decline");
    ck("26b. Tom responding only ever writes Tom's own response - Joe's is untouched", JSON.stringify(responseOf(d, JOE)) === JSON.stringify(joeResp));
    const mine = await listForCoach(deps, { kind: "coach", userId: "u-tom", displayName: "Tom", coachId: TOM }, NOW);
    const listed = JSON.stringify(mine);
    ck(
      "26c. Coach view shows Tom only his own response + suitability - never other coaches' responses, rates or Management notes",
      mine.availableToRespond.length === 1 && mine.availableToRespond[0].myResponse!.status === "No" && !listed.includes(JOE) && !/Rate|Cost|managementNote/i.test(listed),
      listed.slice(0, 300)
    );
    const dm = await listForCoach(deps, { kind: "coach", userId: "u-danny", displayName: "Danny", coachId: DANNY }, NOW);
    ck("26d. Danny sees his own request (with accept/decline counts), not his own date as respondable", dm.requestedByMe.length === 1 && dm.requestedByMe[0].acceptedCount === 1 && dm.availableToRespond.length === 0);
    const detail = await detailForManagement(deps, { requestDateId: d, rateType: null }, NOW);
    ck("26e. Management detail shows every response with fresh suitability + rate preview and the current roster", !!detail && detail.responses.length === 2 && detail.responses.every((r) => r.current != null) && detail.currentRoster.length === 1 && detail.currentRoster[0].coachId === DANNY);
  }

  // ===== 27. Parent has no access =====
  {
    const base = { active: true, userId: "u1", displayName: "X", airtablePersonId: id("Somebody") };
    ck(
      "27. resolveActor: parent -> null (403 on every route); inactive coach -> null; coach without a valid Coaches link -> null; management/coach resolve",
      resolveActor({ ...base, role: "parent" }) === null && resolveActor({ ...base, role: "coach", active: false }) === null &&
        resolveActor({ ...base, role: "coach", airtablePersonId: null }) === null && resolveActor({ ...base, role: "management" })?.kind === "management" &&
        (resolveActor({ ...base, role: "coach" }) as any)?.coachId === id("Somebody")
    );
    const idx = readFileSync(join(CANON, "index.ts"), "utf8");
    ck("27b. index.ts gates EVERY route through resolveActor before any work, and management-only routes on actor.kind", /const auth = await requireActor\(req\);/.test(idx) && /spec\.who === "management" && actor\.kind !== "management"/.test(idx) && /select: \{ method: "POST", who: "management" \}/.test(idx));
  }

  // ===== Airtable rate limiting =====
  reset();
  {
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1, 1, 1, 1, 1);
    fail429 = 3;
    seen429 = 0;
    const out = await makeRequest([O1]);
    ck("R1. Airtable 429s are retried with backoff: three rate-limited reads, then the request still succeeds exactly once", seen429 === 3 && out.dates.length === 1 && store["Staff Availability Requests"].length === 1);
    fail429 = 1000;
    const before = writes.length;
    let threw = false;
    try {
      await createCoverRequest(deps, coach(DANNY), { occurrenceIds: [O2], reason: "Illness", handoverNote: null, coachNote: null, coachId: DANNY }, NOW);
    } catch {
      threw = true;
    }
    fail429 = 0;
    ck("R2. A read that stays rate-limited past the backoff fails loudly (500) BEFORE any write - nothing half-created", threw && writes.length === before);
    tablesRead.length = 0;
    await cancelCoverDate(deps, MGR, { requestDateId: out.dates[0].requestDateId, note: null }, NOW);
    const cancelReads = [...new Set(tablesRead)].sort();
    ck("R3. Operations read only the tables they need (cancel: requests + groups) to keep Airtable load low", JSON.stringify(cancelReads) === JSON.stringify(["Cover Request Groups", "Staff Availability Requests"]), JSON.stringify(cancelReads));
    const w = await loadWorld(deps.airtable, ["coaches"]);
    ck("R4. loadWorld(only) returns empty arrays for tables it did not read", w.coaches.length > 0 && w.responses.length === 0 && w.occurrences.length === 0);
  }

  // ===== misc contracts =====
  ck("N1. Future notification events documented in code (no sending in this slice)", JSON.stringify(FUTURE_NOTIFICATION_EVENTS) === JSON.stringify(["cover_requested", "cover_response_received", "cover_confirmed", "cover_cancelled", "cover_unfilled_escalation"]));
  ck("N2. Mondays in fixtures really are Mondays", [MON1, MON2, MON3].every((d) => dayOfWeekForDate(d) === "Monday"));
  ck("N3. planCancel never touches a Resolved Without Cover date", planCancel(MGR, { id: "x", fields: { "Cover Date Status": "Resolved Without Cover" } }, null, NOW).action === "reject");

  // ===== drift checks =====
  const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
  for (const [mod, orig] of [["coach-availability.ts", "coach-availability/coach-availability.ts"], ["coach-compliance.ts", "coach-compliance/coach-compliance.ts"], ["coach-rates.ts", "coach-allocations/coach-rates.ts"]]) {
    ck(`D1. coach-cover/${mod} is byte-identical to canonical ${orig}`, canon(mod) === readFileSync(join(FUNCS, orig), "utf8"));
  }
  const staffing = canon("staffing.ts");
  const block = staffing.slice(staffing.indexOf("DO NOT EDIT HERE =====\n") + 23, staffing.indexOf("// ===== END COPIED BLOCK ====="));
  const pa = readFileSync(join(FUNCS, "hub-content/player-access.ts"), "utf8");
  const chunks = block.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
  const missing = chunks.filter((c) => !pa.includes(c));
  ck("D2. Every chunk of staffing.ts's copied block appears verbatim in hub-content/player-access.ts", chunks.length >= 10 && missing.length === 0, missing.map((m) => m.slice(0, 60)).join(" | "));
  const sub = (s: string) =>
    s.replace(/"\.\/staffing\.ts"/g, '"./coach-cover-staffing.ts"').replace(/"\.\/cover-workflow\.ts"/g, '"./coach-cover-workflow.ts"').replace(/"\.\/repository\.ts"/g, '"./coach-cover-repository.ts"').replace(/"\.\/lock-client\.ts"/g, '"./coach-cover-lock-client.ts"');
  for (const [src, dst] of [["staffing", "coach-cover-staffing"], ["cover-workflow", "coach-cover-workflow"], ["repository", "coach-cover-repository"], ["lock-client", "coach-cover-lock-client"], ["orchestrator", "coach-cover-orchestrator"]]) {
    const mirror = readFileSync(join(HERE, `${dst}.ts`), "utf8").split("\n").slice(5).join("\n");
    ck(`D3. tests/support/${dst}.ts == canonical coach-cover/${src}.ts (only import paths adjusted)`, mirror === sub(canon(`${src}.ts`)));
  }
  const lockSrc = canon("lock-client.ts");
  ck("D4. Lock client calls the service-role-only cover_date lock RPCs", lockSrc.includes('"acquire_cover_date_lock", { p_cover_date_record_id: key }') && lockSrc.includes('"release_cover_date_lock", { p_cover_date_record_id: key, p_lock_token: lockToken }'));

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");
const CANON = join(FUNCS, "coach-cover");

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
