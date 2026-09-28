// Tests for the Staffing Absent correction (2026-09-28, see TEST-ENV.md
// "Staffing correction - Occurrence Staff Absent"): an Occurrence Staff row
// with Attendance = Absent removes THAT coach from THAT occurrence's resolved
// roster, whether or not cover has been found. Covers every resolver copy
// (hub-content player-access, coach-cover, needs-attention), player access,
// the cover workflow's requester logic, and the Needs Attention staffing /
// compliance / availability / conflict rules through the REAL orchestrator
// against an in-memory Airtable. Items 1-10 match the correction brief.
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
import { checkRequestDate, planSelection } from "./coach-cover-workflow.ts";
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
// Fixtures - NOW = Thu 1 Oct 2026 11:00 BST. Mon 5 Oct is the absence date;
// Mon 12 Oct is the untouched "other date".
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
const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach"), ROLE_LEARN = id("RoleLearn");
const ROLES: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Edit Development Plans": true, "Can Record Attendance": true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Record Attendance": true } },
  { id: ROLE_LEARN, fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } },
];
const DANNY = id("CoachDanny"), SAM = id("CoachSam"), JOE = id("CoachJoe"), LEO = id("CoachLeo");
const COACHES: AirtableRecord[] = [
  { id: DANNY, fields: { "Coach Name": "Danny Regular", Active: true } },
  { id: SAM, fields: { "Coach Name": "Sam Second", Active: true } },
  { id: JOE, fields: { "Coach Name": "Joe Cover", Active: true } },
  { id: LEO, fields: { "Coach Name": "Leo Learner", Active: true } },
];
const S = id("SessMain"), SX = id("SessOther");
const SESSIONS: AirtableRecord[] = [
  { id: S, fields: { "Session Name": "Mon Main", "Session Lifecycle Status": "Active", "Requires Lead Coach": true, "Required Staff Count": 2 } },
  { id: SX, fields: { "Session Name": "Mon Other", "Session Lifecycle Status": "Active", "Required Staff Count": 1 } },
];
const occ = (oid: string, sid: string, date: string, from: string, to: string): AirtableRecord => ({
  id: oid,
  fields: { "Occurrence Name": `Occ ${oid.slice(3, 9)}`, Status: "Scheduled", Session: [sid], Date: date, "Start Date & Time": bst(date, from), "End Date & Time": bst(date, to) },
});
const OA = occ(id("OccA05"), S, MON, "16:00", "17:00"); // the absence occurrence
const OB = occ(id("OccB12"), S, MON2, "16:00", "17:00"); // same session, other date
const OX = occ(id("OccX05"), SX, MON, "16:30", "17:30"); // other session, overlaps OA
const OCCS = [OA, OB, OX];
const SS_DANNY = { id: id("SSDanny"), fields: { Session: [S], Coach: [DANNY], Role: [ROLE_LEAD], Active: true, "Effective From": "2026-09-01" } };
const SS_SAM = { id: id("SSSam"), fields: { Session: [S], Coach: [SAM], Role: [ROLE_COACH], Active: true, "Effective From": "2026-09-01" } };
const SS_DANNY_X = { id: id("SSDannyX"), fields: { Session: [SX], Coach: [DANNY], Role: [ROLE_COACH], Active: true } };
const SS_JOE_X = { id: id("SSJoeX"), fields: { Session: [SX], Coach: [JOE], Role: [ROLE_COACH], Active: true } };
const osRow = (tag: string, occId: string, coachId: string, f: Record<string, any>) => ({ id: id(tag), fields: { "Session Occurrence": [occId], Coach: [coachId], ...f } });
const ABSENT_DANNY = osRow("OSAbsDanny", OA.id, DANNY, { "Assignment Type": "Planned", Attendance: "Absent" });
const COVER_JOE = osRow("OSCovJoe", OA.id, JOE, { "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], "Planned Role Snapshot": "Lead Coach", Attendance: "Planned" });

const capsById = paRoleCapsById(ROLES);
const capsByName = paRoleCapsByName(ROLES);
const ssMain = [SS_DANNY, SS_SAM];
const ssById: Record<string, any> = Object.fromEntries([SS_DANNY, SS_SAM, SS_DANNY_X, SS_JOE_X].map((r) => [r.id, r]));
const ids = (roster: { coachId: string }[]) => roster.map((r) => r.coachId).sort().join(",");
const pa = (os: any[], date = MON) => paResolve(date, ssMain, os, capsById, capsByName, ssById);

// ===== 1-4. The canonical resolver =====
{
  ck("0. Baseline: recurring Danny (Lead) + Sam resolve normally with no Occurrence Staff", ids(pa([])) === [DANNY, SAM].sort().join(","));
  const r1 = pa([ABSENT_DANNY]);
  ck("1. Session Staff Coach + Absent row + NO cover -> removed from the resolved roster (Sam only)", ids(r1) === SAM, ids(r1));
  const r3 = pa([ABSENT_DANNY, COVER_JOE]);
  ck("3. Absent + Cover replacement -> the replacement resolves as working and Danny does not", ids(r3) === [JOE, SAM].sort().join(",") && r3.find((r) => r.coachId === JOE)?.roleCaps?.roleKey === "lead_coach", ids(r3));
  ck("3b. Order independent: Cover row listed before the Absent row gives the same roster", ids(pa([COVER_JOE, ABSENT_DANNY])) === ids(r3));
  ck("4. Other dates/occurrences unchanged: the same session on another date (no Occurrence Staff rows) still resolves Danny + Sam", ids(pa([], MON2)) === [DANNY, SAM].sort().join(","));
  const addThenAbsent = pa([osRow("OSAddLeo", OA.id, LEO, { "Assignment Type": "Additional", "Planned Role Snapshot": "Coach" }), osRow("OSAbsLeo", OA.id, LEO, { "Assignment Type": "Additional", Attendance: "Absent" })]);
  ck("A1. Absent wins over another row for the same coach on the same occurrence (fail-closed)", !addThenAbsent.some((r) => r.coachId === LEO));
  ck("A2. An Absent row for someone not on the roster changes nothing else", ids(pa([osRow("OSAbsX", OA.id, LEO, { Attendance: "Absent" })])) === [DANNY, SAM].sort().join(","));
  ck("A3. An Absent row with no linked Coach is ignored (never a wildcard removal)", ids(pa([{ id: id("OSNoCoach"), fields: { "Session Occurrence": [OA.id], Attendance: "Absent" } }])) === [DANNY, SAM].sort().join(","));
  ck("A4. Planned / Present attendance does not remove anyone", ids(pa([osRow("OSPres", OA.id, DANNY, { Attendance: "Present" })])) === [DANNY, SAM].sort().join(","));
  ck("A5. Cover WITHOUT an Absent row still replaces Danny exactly as before (existing Cover rule unchanged)", ids(pa([COVER_JOE])) === [JOE, SAM].sort().join(","));
  // Every copy of the resolver agrees on every scenario.
  const scenarios: any[][] = [[], [ABSENT_DANNY], [ABSENT_DANNY, COVER_JOE], [COVER_JOE], [COVER_JOE, ABSENT_DANNY], [osRow("OSAbsSam", OA.id, SAM, { Attendance: "Absent" }), osRow("OSAddLeo2", OA.id, LEO, { "Assignment Type": "Additional", "Actual Role Snapshot": "Coach" })]];
  const same = scenarios.every((os) => {
    const a = JSON.stringify(paResolve(MON, ssMain, os, capsById, capsByName, ssById));
    return a === JSON.stringify(ccResolve(MON, ssMain, os, capsById, capsByName, ssById)) && a === JSON.stringify(naResolve(MON, ssMain, os, capsById, capsByName, ssById));
  });
  ck("A6. hub-content, coach-cover and needs-attention resolvers give identical rosters for every scenario", same);
}

// ===== 9. Player access =====
{
  const ssBySessionAndCoach = { [S]: { [DANNY]: [SS_DANNY], [SAM]: [SS_SAM] } };
  const ctx = (os: any[]) => ({ occurrenceStaffRows: os, sessionStaffRowsForSession: ssMain, sessionStaffById: ssById, roleCapsByNameMap: capsByName });
  ck("9a. Before absence: Danny has Lead access on the occurrence", sessionStaffCapabilitiesForSession(S, DANNY, MON, ssBySessionAndCoach, capsById, ctx([]))?.roleKey === "lead_coach");
  ck("9b. Absent, no cover: Danny has NO occurrence-specific access through his recurring row", sessionStaffCapabilitiesForSession(S, DANNY, MON, ssBySessionAndCoach, capsById, ctx([ABSENT_DANNY])) === null);
  ck("9c. Absent + cover: Danny still has none; the confirmed cover coach gets exactly their Occurrence Staff role (Lead)", sessionStaffCapabilitiesForSession(S, DANNY, MON, ssBySessionAndCoach, capsById, ctx([ABSENT_DANNY, COVER_JOE])) === null && sessionStaffCapabilitiesForSession(S, JOE, MON, ssBySessionAndCoach, capsById, ctx([ABSENT_DANNY, COVER_JOE]))?.roleKey === "lead_coach");
  const learnerCover = osRow("OSCovLeo", OA.id, LEO, { "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY.id], "Planned Role Snapshot": "Learning Coach" });
  ck("9d. No broadening: a Learning Coach cover resolves on the roster but gets no player access", sessionStaffCapabilitiesForSession(S, LEO, MON, ssBySessionAndCoach, capsById, ctx([ABSENT_DANNY, learnerCover])) === null);
  ck("9e. Other coaches on the occurrence are unaffected (Sam keeps Coach access)", sessionStaffCapabilitiesForSession(S, SAM, MON, ssBySessionAndCoach, capsById, ctx([ABSENT_DANNY]))?.roleKey === "coach");
  ck("9f. Unaffected date: Danny's access on another date is exactly as before", sessionStaffCapabilitiesForSession(S, DANNY, MON2, ssBySessionAndCoach, capsById, ctx([]))?.roleKey === "lead_coach" && sessionStaffCapabilitiesForSession(S, DANNY, MON2, ssBySessionAndCoach, capsById)?.roleKey === "lead_coach");
}

// ===== 10. Cover workflow =====
{
  const ref = { id: OA.id, sessionId: S, dateIso: MON };
  const ctxAbsent = buildStaffingContext([SS_DANNY, SS_SAM], [ABSENT_DANNY], ROLES);
  ck("10a. Absent Danny is off the cover roster for the occurrence", !rosterForOccurrence(ctxAbsent, ref).some((r) => r.coachId === DANNY));
  const asg = resolveRequesterAssignment(ctxAbsent, ref, DANNY);
  ck("10b. ...but an absent recurring coach (no cover yet) is still the requester whose slot cover replaces: Session Staff source + Lead role, exactly as before", !!asg && asg.sessionStaffSourceId === SS_DANNY.id && asg.roleCaps?.roleKey === "lead_coach" && asg.requesterOccurrenceStaffIds.length === 0, JSON.stringify(asg));
  const oaRec = OA;
  ck("10c. A cover request can still be raised for an already-absent coach", checkRequestDate(oaRec, ref, asg, false, "2026-10-01").ok === true);
  const rd = { id: id("CRDateA"), fields: { "Cover Date Status": "Open", Coach: [DANNY], "Session Occurrence": [OA.id] } };
  const resp = { id: id("CRespJoe"), fields: { Coach: [JOE], "Cover Request Date": [rd.id], Active: true, "Response Status": "Yes" } };
  const plan: any = planSelection({
    actor: { kind: "management", userId: "mgr-1", displayName: "Morgan Manager" }, requestDate: rd, response: resp, occurrence: ref, staffing: ctxAbsent,
    requesterAssignment: asg, suitability: { status: "suitable", blockers: [], warnings: [], info: [] }, confirmWarnings: false, now: NOW,
  } as any);
  ck("10d. Management can still select cover for an absent coach: plan = fill with a Cover row citing Danny's Session Staff row", plan.action === "fill" && plan.occurrenceStaffFields["Assignment Type"] === "Cover" && plan.occurrenceStaffFields["Session Staff Source"]?.[0] === SS_DANNY.id && plan.occurrenceStaffFields["Planned Role Snapshot"] === "Lead Coach", JSON.stringify(plan).slice(0, 200));
  const ctxFilled = buildStaffingContext([SS_DANNY, SS_SAM], [ABSENT_DANNY, COVER_JOE], ROLES);
  ck("10e. After cover is written: roster = Joe + Sam, and Danny is no longer a requester (already replaced -> null, as before)", ids(rosterForOccurrence(ctxFilled, ref)) === [JOE, SAM].sort().join(",") && resolveRequesterAssignment(ctxFilled, ref, DANNY) === null);
  const ctxNormal = buildStaffingContext([SS_DANNY, SS_SAM], [], ROLES);
  const asgNormal = resolveRequesterAssignment(ctxNormal, ref, DANNY);
  ck("10f. Normal (not absent) requester is resolved exactly as before", JSON.stringify(asgNormal) === JSON.stringify(asg));
  const addOnly = osRow("OSAddLeoAbs", OA.id, LEO, { "Assignment Type": "Additional", "Planned Role Snapshot": "Coach", Attendance: "Absent" });
  ck("10g. A coach added only by Occurrence Staff and marked Absent is not a requester (no recurring slot) - unchanged", resolveRequesterAssignment(buildStaffingContext([SS_DANNY, SS_SAM], [addOnly], ROLES), ref, LEO) === null);
  const ctxX = buildStaffingContext([SS_DANNY, SS_SAM, SS_DANNY_X], [ABSENT_DANNY], ROLES);
  ck("10h. Other occurrences: Danny still staffs OX (the absence is per occurrence)", rosterForOccurrence(ctxX, { id: OX.id, sessionId: SX, dateIso: MON }).some((r) => r.coachId === DANNY));
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
function world(os: AirtableRecord[], extraSS: AirtableRecord[] = [], dated: AirtableRecord[] = [unavailableMon("DAbsDanny", DANNY)]) {
  tables = {
    [CONFIG_TABLES.rules]: RULES, [CONFIG_TABLES.settings]: [], [CONFIG_TABLES.exceptions]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: id("OrgTest"), fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    Sessions: SESSIONS, "Session Occurrences": OCCS, "Session Staff": [SS_DANNY, SS_SAM, SS_DANNY_X, ...extraSS], "Occurrence Staff": os,
    "Coach Roles": ROLES, Coaches: COACHES, "Staff Availability Requests": [], "Cover Responses": [],
    "Coach Documents": [], "Coach Document Requirements": [{ id: REQ_DBS, fields: { "Document Type": "Enhanced DBS", Required: true, Active: true, "Review Lead Days": 30 } }],
    [AVAILABILITY_TABLES.recurring]: [], [AVAILABILITY_TABLES.exceptions]: dated,
  };
}
const MGMT: Caller = { userId: "user-mgmt-1", role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Morgan Manager", email: "manager@test.invalid" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS, lock: noLock };
const keys = async () => ((await getCases(deps, MGMT, {}, NOW)) as any).body.cases.map((c: any) => c.caseKey as string);
const has = (k: string[], s: string) => k.includes(s);
const cf = (c: string, a: string, b: string) => `coach_schedule_conflict|coach:${c}|occurrence:${a < b ? a : b}|occurrence:${a < b ? b : a}`;
const un = (o: string, c: string) => `assigned_coach_unavailable|occurrence:${o}|coach:${c}`;
const nc = (o: string, c: string) => `non_compliant_coach_assigned|occurrence:${o}|coach:${c}`;

{
  world([]);
  const before = await keys();
  ck("NA0. Before absence: OA fully staffed (no staffing case); Danny raises ATT-014 on OA+OX, ATT-012 OA/OX, ATT-031 on OA", !before.some((k) => k.includes(`occurrence:${OA.id}`) && /^(no_lead_coach|session_understaffed|session_no_coach|learning_coach_only)/.test(k)) && has(before, un(OA.id, DANNY)) && has(before, un(OX.id, DANNY)) && has(before, cf(DANNY, OA.id, OX.id)) && has(before, nc(OA.id, DANNY)), before.join(" "));

  world([ABSENT_DANNY]);
  const absent = await keys();
  ck("2. Lead Coach + Absent -> no longer satisfies the Lead requirement (no_lead_coach on OA)", has(absent, `no_lead_coach|occurrence:${OA.id}`), absent.join(" "));
  ck("5. Required Staff Count reflects the absence (2 required, Sam only -> session_understaffed on OA)", has(absent, `session_understaffed|occurrence:${OA.id}`));
  ck("6. Compliance-on-assignment no longer treats Danny as assigned to OA (ATT-031 Danny x OA gone; Sam x OA stays)", !has(absent, nc(OA.id, DANNY)) && has(absent, nc(OA.id, SAM)));
  ck("7. Availability no longer raises against absent Danny on OA (ATT-014 Danny x OA gone; Danny x OX stays)", !has(absent, un(OA.id, DANNY)) && has(absent, un(OX.id, DANNY)));
  ck("8. Schedule conflict no longer includes absent Danny (OA/OX conflict gone)", !has(absent, cf(DANNY, OA.id, OX.id)));
  ck("4b. Other dates unchanged: OB (same session, 12 Oct) still has Danny - no staffing case, ATT-031 Danny x OB stays", !absent.some((k) => k.startsWith("no_lead_coach") && k.includes(OB.id)) && has(absent, nc(OB.id, DANNY)));

  world([ABSENT_DANNY, COVER_JOE], [SS_JOE_X], [unavailableMon("DAbsDanny", DANNY), unavailableMon("DAbsJoe", JOE)]);
  const covered = await keys();
  ck("3c/10i. Absent + Cover: Joe (Lead) satisfies the Lead requirement and the staff count on OA", !has(covered, `no_lead_coach|occurrence:${OA.id}`) && !has(covered, `session_understaffed|occurrence:${OA.id}`), covered.join(" "));
  ck("NA1. Compliance / availability / conflicts use the replacement: ATT-031 Joe x OA, ATT-014 Joe x OA, ATT-012 Joe OA/OX appear; none for Danny on OA", has(covered, nc(OA.id, JOE)) && has(covered, un(OA.id, JOE)) && has(covered, cf(JOE, OA.id, OX.id)) && !has(covered, nc(OA.id, DANNY)) && !has(covered, un(OA.id, DANNY)) && !has(covered, cf(DANNY, OA.id, OX.id)));
  const ssSnapshot = JSON.stringify(tables["Session Staff"]);
  await keys();
  ck("NA2. Session Staff is never mutated: zero write attempts across every evaluation and the rows are identical afterwards", writeAttempts === 0 && JSON.stringify(tables["Session Staff"]) === ssSnapshot && SS_DANNY.fields.Active === true);
}

// ===== Drift =====
{
  const canonical = readFileSync(join(FUNCS, "hub-content/player-access.ts"), "utf8");
  const mirror = readFileSync(join(HERE, "player-access.ts"), "utf8").split("\n").slice(6).join("\n");
  ck("DR1. tests/support/player-access.ts == canonical hub-content/player-access.ts (after its 6-line header)", mirror === canonical);
  const absentFn = 'function isAbsentOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {\n  return !!firstLink(row.fields, "Coach") && selectName(row.fields["Attendance"]) === "Absent";\n}';
  const removal = '  for (const row of occurrenceStaffRowsForOccurrence) {\n    if (isAbsentOccurrenceStaffRow(row)) roster.delete(firstLink(row.fields, "Coach"));\n  }';
  const files = ["hub-content/player-access.ts", "coach-cover/staffing.ts", "needs-attention/staffing.ts", "parent-hub/index.ts"];
  const missing = files.filter((f) => { const s = readFileSync(join(FUNCS, f), "utf8"); return !s.includes(absentFn) || !s.includes(removal); });
  ck("DR2. All four resolver implementations (hub-content, coach-cover, needs-attention, parent-hub) carry the identical Absent rule and removal step", missing.length === 0, missing.join(","));
  const ph = readFileSync(join(FUNCS, "parent-hub/index.ts"), "utf8");
  const sc = readFileSync(join(HERE, "session-coaches.test.ts"), "utf8");
  const fnBody = (s: string) => { const i = s.indexOf("function resolveOccurrenceRoster("); const j = s.indexOf("\n}\n", i); return s.slice(i, j).split("\n").filter((l) => l.trim() !== "").join("\n"); };
  ck("DR3. session-coaches.test.ts's copy of parent-hub's resolveOccurrenceRoster() matches parent-hub/index.ts (blank lines ignored)", fnBody(ph) === fnBody(sc) && fnBody(ph).includes("isAbsentOccurrenceStaffRow"));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
process.exit(failed ? 1 : 0);
