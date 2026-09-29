// Tests for the Cover-replacement correction (2026-09-28, see TEST-ENV.md
// "Staffing correction - Cover replacement stays in force when the cover
// coach is Absent"): once a recurring coach has been replaced for an
// occurrence by a Cover row, that displacement holds even if the cover coach
// is later marked Absent - the cover coach is removed, the replaced coach
// does NOT come back, and the slot is unfilled until another valid
// replacement is added. Covers every resolver copy, player access, the cover
// workflow, and the Needs Attention staffing / compliance / availability /
// conflict rules through the REAL orchestrator against an in-memory Airtable.
// Items 1-10 match the correction brief.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveOccurrenceStaffing as paResolve,
  roleCapabilitiesById as paRoleCapsById,
  roleCapsByRoleName as paRoleCapsByName,
  sessionStaffCapabilitiesForSession,
} from "./player-access.ts";
import { buildStaffingContext, resolveOccurrenceStaffing as ccResolve, resolveRequesterAssignment, rosterForOccurrence } from "./coach-cover-staffing.ts";
import { planSelection } from "./coach-cover-workflow.ts";
import { resolveOccurrenceStaffing as naResolve } from "./needs-attention-staffing.ts";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { AVAILABILITY_TABLES } from "./needs-attention-coach-schedule.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");

// ---------------------------------------------------------------------
// Fixtures - NOW = Thu 1 Oct 2026 11:00 BST. Mon 5 Oct is the covered
// occurrence (OA); Mon 12 Oct (OB) is the untouched other date; OX is a
// different session overlapping OA.
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const NOW = new Date("2026-10-01T10:00:00.000Z");
const TZ = "Europe/London";
const MON = "2026-10-05", MON2 = "2026-10-12";
const bst = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 1, m)).toISOString();
};
const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach");
const ROLES: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Edit Development Plans": true, "Can Record Attendance": true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Record Attendance": true } },
];
const DANNY = id("CoachDanny"), SAM = id("CoachSam"), JOE = id("CoachJoe"), PAT = id("CoachPat");
const COACHES: AirtableRecord[] = [
  { id: DANNY, fields: { "Coach Name": "Danny Regular", Active: true } },
  { id: SAM, fields: { "Coach Name": "Sam Cover", Active: true } },
  { id: JOE, fields: { "Coach Name": "Joe Second Cover", Active: true } },
  { id: PAT, fields: { "Coach Name": "Pat Other", Active: true } },
];
const S = id("SessMain"), SX = id("SessOther");
const SESSIONS: AirtableRecord[] = [
  { id: S, fields: { "Session Name": "Mon Main", "Session Lifecycle Status": "Active", "Requires Lead Coach": true, "Required Staff Count": 1 } },
  { id: SX, fields: { "Session Name": "Mon Other", "Session Lifecycle Status": "Active", "Required Staff Count": 1 } },
];
const occ = (oid: string, sid: string, date: string, from: string, to: string): AirtableRecord => ({
  id: oid,
  fields: { "Occurrence Name": `Occ ${oid.slice(3, 9)}`, Status: "Scheduled", Session: [sid], Date: date, "Start Date & Time": bst(date, from), "End Date & Time": bst(date, to) },
});
const OA = occ(id("OccA05"), S, MON, "16:00", "17:00"); // the covered occurrence
const OB = occ(id("OccB12"), S, MON2, "16:00", "17:00"); // same session, other date
const OX = occ(id("OccX05"), SX, MON, "16:30", "17:30"); // other session, overlaps OA
const OCCS = [OA, OB, OX];
// Danny is the ONLY recurring coach on the main session (so a vacated slot is genuinely empty).
const SS_DANNY = { id: id("SSDanny"), fields: { Session: [S], Coach: [DANNY], Role: [ROLE_LEAD], Active: true, "Effective From": "2026-09-01" } };
const SS_DANNY_X = { id: id("SSDannyX"), fields: { Session: [SX], Coach: [DANNY], Role: [ROLE_COACH], Active: true } };
const SS_SAM_X = { id: id("SSSamX"), fields: { Session: [SX], Coach: [SAM], Role: [ROLE_COACH], Active: true } };
const SS_JOE_X = { id: id("SSJoeX"), fields: { Session: [SX], Coach: [JOE], Role: [ROLE_COACH], Active: true } };
const osRow = (tag: string, occId: string, coachId: string, f: Record<string, any>) => ({ id: id(tag), fields: { "Session Occurrence": [occId], Coach: [coachId], ...f } });
const COVER_SAM = osRow("OSCovSam", OA.id, SAM, { "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], "Planned Role Snapshot": "Lead Coach", Attendance: "Planned" });
// The edge case: the Cover row ITSELF later set to Absent.
const COVER_SAM_ABSENT = osRow("OSCovSamAbs", OA.id, SAM, { "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], "Planned Role Snapshot": "Lead Coach", Attendance: "Absent" });
// The two-row form: Sam's Cover row stays Planned and a separate Absent row is added for Sam.
const ABSENT_SAM = osRow("OSAbsSam", OA.id, SAM, { "Assignment Type": "Planned", Attendance: "Absent" });
const COVER_JOE = osRow("OSCovJoe", OA.id, JOE, { "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], "Planned Role Snapshot": "Lead Coach", Attendance: "Planned" });

const capsById = paRoleCapsById(ROLES);
const capsByName = paRoleCapsByName(ROLES);
const ssMain = [SS_DANNY];
const ssById: Record<string, any> = Object.fromEntries([SS_DANNY, SS_DANNY_X, SS_SAM_X, SS_JOE_X].map((r) => [r.id, r]));
const ids = (roster: { coachId: string }[]) => roster.map((r) => r.coachId).sort().join(",");
const pa = (os: any[], date = MON) => paResolve(date, ssMain, os, capsById, capsByName, ssById);

// ===== 1-5. The canonical resolver =====
{
  ck("0. Baseline: recurring Danny resolves normally with no Occurrence Staff", ids(pa([])) === DANNY);
  ck("1. Recurring coach replaced by a Cover row -> Danny removed, Sam (Lead) staffs the occurrence", ids(pa([COVER_SAM])) === SAM && pa([COVER_SAM])[0].roleCaps?.roleKey === "lead_coach");
  const cAbs = pa([COVER_SAM_ABSENT]);
  ck("2. Cover coach then marked Absent (the Cover row itself) -> Danny STAYS removed; Sam removed too", !cAbs.some((r) => r.coachId === DANNY) && !cAbs.some((r) => r.coachId === SAM), ids(cAbs));
  ck("2b. Two-row form (Cover row Planned + separate Absent row for Sam) gives the same result", ids(pa([COVER_SAM, ABSENT_SAM])) === "" && ids(pa([ABSENT_SAM, COVER_SAM])) === "");
  ck("3. Nobody else assigned -> the resolved roster is empty (zero staff)", cAbs.length === 0);
  const refill = pa([COVER_SAM_ABSENT, COVER_JOE]);
  ck("4. Another valid Cover fills the slot: Joe (Lead) only - Danny and Sam absent from the roster", ids(refill) === JOE && refill[0].roleCaps?.roleKey === "lead_coach", ids(refill));
  ck("4b. Order independent: the second cover listed first gives the same roster", ids(pa([COVER_JOE, COVER_SAM_ABSENT])) === JOE && ids(pa([COVER_JOE, COVER_SAM, ABSENT_SAM])) === JOE);
  ck("5. Other dates unchanged: the same session on 12 Oct (no Occurrence Staff) still resolves Danny", ids(pa([], MON2)) === DANNY);
  const ctx5 = buildStaffingContext([SS_DANNY, SS_DANNY_X], [COVER_SAM_ABSENT], ROLES);
  ck("5b. Per occurrence only: with the absent-cover row on OA, OB still resolves Danny and OX (other session) still has Danny", ids(rosterForOccurrence(ctx5, { id: OB.id, sessionId: S, dateIso: MON2 })) === DANNY && rosterForOccurrence(ctx5, { id: OX.id, sessionId: SX, dateIso: MON }).some((r) => r.coachId === DANNY));
  // Every resolver copy agrees on every scenario.
  const scenarios: any[][] = [[], [COVER_SAM], [COVER_SAM_ABSENT], [COVER_SAM, ABSENT_SAM], [COVER_SAM_ABSENT, COVER_JOE], [COVER_JOE, COVER_SAM_ABSENT], [osRow("OSCovNoSrc", OA.id, SAM, { "Assignment Type": "Cover", Attendance: "Absent" })]];
  const same = scenarios.every((os) => {
    const a = JSON.stringify(paResolve(MON, ssMain, os, capsById, capsByName, ssById));
    return a === JSON.stringify(ccResolve(MON, ssMain, os, capsById, capsByName, ssById)) && a === JSON.stringify(naResolve(MON, ssMain, os, capsById, capsByName, ssById));
  });
  ck("10a. hub-content, coach-cover and needs-attention resolvers give identical rosters for every cover/absent scenario", same);
}

// ===== 9. Unaffected existing cover behaviour (resolver) =====
{
  const noSource = osRow("OSCovSamNoSrc", OA.id, SAM, { "Assignment Type": "Cover", "Planned Role Snapshot": "Coach" });
  ck("9a. A Cover row with no resolvable Session Staff Source still ADDS its coach and removes nobody (unchanged)", ids(pa([noSource])) === [DANNY, SAM].sort().join(","));
  ck("9b. ...and an Absent Cover row with no resolvable source removes nobody else (Danny stays; only Sam is absent)", ids(pa([{ ...noSource, fields: { ...noSource.fields, Attendance: "Absent" } }])) === DANNY);
  const selfCover = osRow("OSCovDannySelf", OA.id, DANNY, { "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], "Planned Role Snapshot": "Coach" });
  ck("9c. A Cover row naming the same coach as its source is a same-coach role override, not a removal (unchanged)", ids(pa([selfCover])) === DANNY && pa([selfCover])[0].roleCaps?.roleKey === "coach");
  ck("9d. Additional / Temporary Role rows are unaffected: an Additional coach is added alongside Danny", ids(pa([osRow("OSAddPat", OA.id, PAT, { "Assignment Type": "Additional", "Planned Role Snapshot": "Coach" })])) === [DANNY, PAT].sort().join(","));
  ck("9e. An Absent NON-Cover row for another coach never displaces Danny", ids(pa([osRow("OSAbsPatPlanned", OA.id, PAT, { "Assignment Type": "Planned", "Session Staff Source": [SS_DANNY.id], Attendance: "Absent" })])) === DANNY);
  ck("9f. A Cover row with no linked Coach is ignored entirely (never a wildcard removal)", ids(pa([{ id: id("OSCovNoCoach"), fields: { "Session Occurrence": [OA.id], "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], Attendance: "Absent" } }])) === DANNY);
}

// ===== 8. Player access =====
{
  const ssBySessionAndCoach = { [S]: { [DANNY]: [SS_DANNY] } };
  const ctx = (os: any[]) => ({ occurrenceStaffRows: os, sessionStaffRowsForSession: ssMain, sessionStaffById: ssById, roleCapsByNameMap: capsByName });
  ck("8a. Before cover: Danny has Lead access on OA", sessionStaffCapabilitiesForSession(S, DANNY, MON, ssBySessionAndCoach, capsById, ctx([]))?.roleKey === "lead_coach");
  ck("8b. Absent cover coach gets NO player access for the occurrence", sessionStaffCapabilitiesForSession(S, SAM, MON, ssBySessionAndCoach, capsById, ctx([COVER_SAM_ABSENT])) === null);
  ck("8c. ...and the replaced recurring coach does not regain access through his recurring row", sessionStaffCapabilitiesForSession(S, DANNY, MON, ssBySessionAndCoach, capsById, ctx([COVER_SAM_ABSENT])) === null);
  ck("8d. A second valid cover gets exactly its Occurrence Staff role (Lead); Danny and Sam still none", sessionStaffCapabilitiesForSession(S, JOE, MON, ssBySessionAndCoach, capsById, ctx([COVER_SAM_ABSENT, COVER_JOE]))?.roleKey === "lead_coach" && sessionStaffCapabilitiesForSession(S, DANNY, MON, ssBySessionAndCoach, capsById, ctx([COVER_SAM_ABSENT, COVER_JOE])) === null && sessionStaffCapabilitiesForSession(S, SAM, MON, ssBySessionAndCoach, capsById, ctx([COVER_SAM_ABSENT, COVER_JOE])) === null);
  ck("8e. Other date: Danny's access on 12 Oct is exactly as before", sessionStaffCapabilitiesForSession(S, DANNY, MON2, ssBySessionAndCoach, capsById, ctx([]))?.roleKey === "lead_coach");
}

// ===== 9. Cover workflow (coach-cover) =====
{
  const ref = { id: OA.id, sessionId: S, dateIso: MON };
  const ctxAbsCover = buildStaffingContext([SS_DANNY], [COVER_SAM_ABSENT], ROLES);
  ck("9g. Danny stays replaced in the cover workflow too: he is not on the roster and is not a requester for OA", !rosterForOccurrence(ctxAbsCover, ref).some((r) => r.coachId === DANNY) && resolveRequesterAssignment(ctxAbsCover, ref, DANNY) === null);
  ck("9h. The absent cover coach is not a requester either (not working, no recurring slot)", resolveRequesterAssignment(ctxAbsCover, ref, SAM) === null);
  // Existing path: the COVER coach (Sam, working) asks for cover and Joe is selected.
  const ctxCover = buildStaffingContext([SS_DANNY], [COVER_SAM], ROLES);
  const asg = resolveRequesterAssignment(ctxCover, ref, SAM);
  ck("9i. A working cover coach is still a requester: source = Danny's Session Staff row, Lead role, own Cover row to neutralise", !!asg && asg.sessionStaffSourceId === SS_DANNY.id && asg.roleCaps?.roleKey === "lead_coach" && asg.requesterOccurrenceStaffIds.join(",") === COVER_SAM.id, JSON.stringify(asg));
  const rd = { id: id("CRDateSam"), fields: { "Cover Date Status": "Open", Coach: [SAM], "Session Occurrence": [OA.id] } };
  const resp = { id: id("CRespJoe"), fields: { Coach: [JOE], "Cover Request Date": [rd.id], Active: true, "Response Status": "Yes" } };
  const plan: any = planSelection({
    actor: { kind: "management", userId: "mgr-1", displayName: "Morgan Manager" }, requestDate: rd, response: resp, occurrence: ref, staffing: ctxCover,
    requesterAssignment: asg, suitability: { status: "suitable", blockers: [], warnings: [], info: [] }, confirmWarnings: false, now: NOW,
  } as any);
  ck("9j. Selecting Joe fills: new Cover row citing Danny's Session Staff row, Sam's Cover row patched Absent", plan.action === "fill" && plan.occurrenceStaffFields["Session Staff Source"]?.[0] === SS_DANNY.id && plan.requesterOccurrenceStaffPatches.length === 1 && plan.requesterOccurrenceStaffPatches[0].id === COVER_SAM.id && plan.requesterOccurrenceStaffPatches[0].fields.Attendance === "Absent", JSON.stringify(plan).slice(0, 240));
  const after = rosterForOccurrence(buildStaffingContext([SS_DANNY], [{ ...COVER_SAM, fields: { ...COVER_SAM.fields, Attendance: "Absent" } }, { id: id("OSCovJoeW"), fields: plan.occurrenceStaffFields }], ROLES), ref);
  ck("9k. Post-fill roster = Joe only (Danny does not come back when Sam's Cover row is set Absent)", ids(after) === JOE, ids(after));
  const ctxNormal = buildStaffingContext([SS_DANNY], [], ROLES);
  const asgNormal = resolveRequesterAssignment(ctxNormal, ref, DANNY);
  ck("9l. Normal recurring requester (no Occurrence Staff) resolves exactly as before", !!asgNormal && asgNormal.sessionStaffSourceId === SS_DANNY.id && asgNormal.roleCaps?.roleKey === "lead_coach" && asgNormal.requesterOccurrenceStaffIds.length === 0);
}

// ---------------------------------------------------------------------
// Needs Attention engine (REAL orchestrator, in-memory Airtable, reads only).
// ---------------------------------------------------------------------
function rule(key: string, ruleId: string, o: { sev?: string; urg?: [number, string]; warn?: [number, string]; sort: number; override?: boolean; locked?: string }): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": key, "Rule ID": ruleId, "Rule Key": key, Category: "Staffing & Cover", "Default Enabled": true, "Default Base Severity": o.sev ?? "Normal",
    "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": o.sort, Active: true, "Action Label": "Review", "Destination Area": "Schedule & Sessions",
  };
  if (o.override !== false) f["Supports Override"] = true;
  if (o.locked) f["Locked Minimum Severity"] = o.locked;
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: id("Rule" + ruleId.replace("-", "")), fields: f };
}
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1 }),
  rule("learning_coach_only", "ATT-002", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 2 }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5 }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13 }),
  rule("cover_open", "ATT-041", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sort: 41 }),
  rule("coach_compliance_expiry", "ATT-011", { sev: "Warning", sort: 11 }),
  rule("compliance_verification_pending", "ATT-042", { sev: "Normal", sort: 42, override: false }),
  rule("non_compliant_coach_assigned", "ATT-031", { sev: "Warning", urg: [48, "Hours Before"], locked: "Warning", sort: 31, override: false }),
  rule("coach_schedule_conflict", "ATT-012", { sev: "Warning", urg: [48, "Hours Before"], sort: 12 }),
  rule("assigned_coach_unavailable", "ATT-014", { sev: "Warning", urg: [48, "Hours Before"], sort: 14 }),
];
let tables: Record<string, AirtableRecord[]> = {};
let writeAttempts = 0;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const table = decodeURIComponent(new URL(url).pathname.split("/")[3]);
  if (method !== "GET") { writeAttempts++; throw new Error(`Illegal write ${method} ${table}`); }
  return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields })) }), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;
const noLock: LockClient = { async acquire() { return "00000000-aaaa-4000-8000-000000000000"; }, async release() { return true; } };
const REQ_DBS = id("ReqDbs");
const unavailableMon = (tag: string, coachId: string) => ({ id: id(tag), fields: { Coach: [coachId], "Availability Type": "Unavailable", "Start Date": MON, Active: true } });
// Danny, Sam and Joe are all Unavailable on 5 Oct, all have no DBS (ATT-031), and all also work OX (overlapping OA):
// so whoever the resolver puts on OA raises ATT-014 / ATT-031 / ATT-012 on OA - and nobody else does.
function world(os: AirtableRecord[]) {
  tables = {
    [CONFIG_TABLES.rules]: RULES, [CONFIG_TABLES.settings]: [], [CONFIG_TABLES.exceptions]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: id("OrgTest"), fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    Sessions: SESSIONS, "Session Occurrences": OCCS, "Session Staff": [SS_DANNY, SS_DANNY_X, SS_SAM_X, SS_JOE_X], "Occurrence Staff": os,
    "Coach Roles": ROLES, Coaches: COACHES, "Staff Availability Requests": [], "Cover Responses": [],
    "Coach Documents": [], "Coach Document Requirements": [{ id: REQ_DBS, fields: { "Document Type": "Enhanced DBS", Required: true, Active: true, "Review Lead Days": 30 } }],
    [AVAILABILITY_TABLES.recurring]: [], [AVAILABILITY_TABLES.exceptions]: [unavailableMon("DAbsDanny", DANNY), unavailableMon("DAbsSam", SAM), unavailableMon("DAbsJoe", JOE)],
  };
}
const MGMT: Caller = { userId: "user-mgmt-1", role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Morgan Manager", email: "manager@test.invalid" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS, lock: noLock };
const keys = async () => ((await getCases(deps, MGMT, {}, NOW)) as any).body.cases.map((c: any) => c.caseKey as string);
const has = (k: string[], s: string) => k.includes(s);
const cf = (c: string, a: string, b: string) => `coach_schedule_conflict|coach:${c}|occurrence:${a < b ? a : b}|occurrence:${a < b ? b : a}`;
const un = (o: string, c: string) => `assigned_coach_unavailable|occurrence:${o}|coach:${c}`;
const nc = (o: string, c: string) => `non_compliant_coach_assigned|occurrence:${o}|coach:${c}`;
const onOA = (k: string[], coach: string) => k.filter((x) => x.includes(`occurrence:${OA.id}`) && x.includes(`coach:${coach}`));
const staffingOA = (k: string[]) => k.filter((x) => x.includes(`occurrence:${OA.id}`) && /^(no_lead_coach|session_understaffed|session_no_coach|learning_coach_only)\|/.test(x)).sort();

{
  world([]);
  const before = await keys();
  ck("NA0. Before cover: OA fully staffed by Danny (no staffing case); Danny raises ATT-014, ATT-031 on OA and ATT-012 OA/OX", staffingOA(before).length === 0 && has(before, un(OA.id, DANNY)) && has(before, nc(OA.id, DANNY)) && has(before, cf(DANNY, OA.id, OX.id)), before.join(" "));

  world([COVER_SAM]);
  const covered = await keys();
  ck("NA1. Cover in place: OA staffed by Sam (no staffing case); OA cases move from Danny to Sam", staffingOA(covered).length === 0 && onOA(covered, DANNY).length === 0 && has(covered, un(OA.id, SAM)) && has(covered, nc(OA.id, SAM)) && has(covered, cf(SAM, OA.id, OX.id)), covered.join(" "));

  world([COVER_SAM_ABSENT]);
  const vacated = await keys();
  ck("6. Staffing reflects the now-empty slot: session_no_coach on OA (and only that - zero valid staff)", staffingOA(vacated).join(",") === `session_no_coach|occurrence:${OA.id}`, staffingOA(vacated).join(","));
  ck("7a. Compliance does not treat Danny as restored: no ATT-031 for Danny (or absent Sam) on OA", !has(vacated, nc(OA.id, DANNY)) && !has(vacated, nc(OA.id, SAM)));
  ck("7b. Availability does not treat Danny as restored: no ATT-014 for Danny (or absent Sam) on OA", !has(vacated, un(OA.id, DANNY)) && !has(vacated, un(OA.id, SAM)));
  ck("7c. Conflicts do not treat Danny as restored: no OA/OX conflict for Danny or Sam", !has(vacated, cf(DANNY, OA.id, OX.id)) && !has(vacated, cf(SAM, OA.id, OX.id)));
  ck("7d. Danny's and Sam's own other work is untouched: OX cases remain (ATT-014 Danny/Sam x OX)", has(vacated, un(OX.id, DANNY)) && has(vacated, un(OX.id, SAM)));
  ck("5c. Other date unchanged: OB still staffed by Danny (no staffing case on OB; ATT-031 Danny x OB stays)", !vacated.some((k) => k.includes(OB.id) && /^(session_no_coach|no_lead_coach)/.test(k)) && has(vacated, nc(OB.id, DANNY)));

  world([COVER_SAM, ABSENT_SAM]);
  ck("6b. Two-row form (Cover Planned + separate Absent row) gives the identical case set", JSON.stringify((await keys()).sort()) === JSON.stringify([...vacated].sort()));

  world([COVER_SAM_ABSENT, COVER_JOE]);
  const refilled = await keys();
  ck("4c. Second valid cover resolves the staffing case (no session_no_coach / no_lead_coach on OA)", staffingOA(refilled).length === 0, staffingOA(refilled).join(","));
  ck("7e. ...and compliance / availability / conflicts now key off Joe on OA - never Danny or Sam", has(refilled, un(OA.id, JOE)) && has(refilled, nc(OA.id, JOE)) && has(refilled, cf(JOE, OA.id, OX.id)) && onOA(refilled, DANNY).length === 0 && onOA(refilled, SAM).length === 0);
  ck("NA2. Session Staff is never mutated: zero write attempts across every evaluation", writeAttempts === 0 && SS_DANNY.fields.Active === true);
}

// ===== 10. Drift =====
{
  const canonical = readFileSync(join(FUNCS, "hub-content/player-access.ts"), "utf8");
  const mirror = readFileSync(join(HERE, "player-access.ts"), "utf8").split("\n").slice(6).join("\n");
  ck("10b. tests/support/player-access.ts == canonical hub-content/player-access.ts (after its 6-line header)", mirror === canonical);
  const norm = (s: string) => s.split("\n").filter((l) => l.trim() !== "").join("\n");
  // The corrected overlay order: displacement first, THEN the usability gate - and never the old order.
  const newOrder = norm('      if (sourceCoachId && sourceCoachId !== coachId) roster.delete(sourceCoachId);\n    }\n\n    if (!isUsableOccurrenceStaffRow(row)) continue;');
  const oldOrder = norm('  for (const row of occurrenceStaffRowsForOccurrence) {\n    if (!isUsableOccurrenceStaffRow(row)) continue;');
  const files = ["hub-content/player-access.ts", "coach-cover/staffing.ts", "needs-attention/staffing.ts", "parent-hub/index.ts"];
  const bad = files.filter((f) => { const s = norm(readFileSync(join(FUNCS, f), "utf8")); return !s.includes(newOrder) || s.includes(oldOrder); });
  const sc = norm(readFileSync(join(HERE, "session-coaches.test.ts"), "utf8"));
  ck("10c. All four resolver implementations (and the parent-display test copy) displace BEFORE the usability gate; none keeps the old order", bad.length === 0 && sc.includes(newOrder) && !sc.includes(oldOrder), bad.join(","));
  // The full overlay loop is byte-identical across the three capability resolvers.
  const loop = (s: string) => { const i = s.indexOf("  for (const row of occurrenceStaffRowsForOccurrence) {\n    const coachId"); return s.slice(i, s.indexOf("\n  }\n", i)); };
  const loops = files.slice(0, 3).map((f) => loop(readFileSync(join(FUNCS, f), "utf8")));
  ck("10d. The Occurrence Staff overlay loop is byte-identical in hub-content, coach-cover and needs-attention", loops[0].length > 200 && loops.every((l) => l === loops[0]));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
process.exit(failed ? 1 : 0);
