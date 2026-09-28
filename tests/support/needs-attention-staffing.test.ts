// Unit + integration tests for Needs Attention Slice 3 - the four
// occurrence staffing rules (see TEST-ENV.md "Needs Attention Foundation -
// Slice 3"). Pure precedence / eligibility / window logic is tested
// directly from needs-attention-staffing.ts; request-level behaviour runs
// through the REAL orchestrator + deployed registry against an in-memory
// Airtable (mocked global fetch that REJECTS any write), so precedence,
// Occurrence Staff overrides, handovers, cancellations, the 14-day window,
// case keys, severity, payload and read counts are all asserted end to end.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import {
  STAFFING_SOURCES,
  STAFFING_WINDOW_DAYS,
  analyseStaffing,
  localDateIso,
  occurrenceEligibility,
  staffingFindings,
  staffingPassStats,
  windowState,
  type StaffingAnalysis,
} from "./needs-attention-staffing.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");

// ---------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = id("OrgTest1");
const NOW = new Date("2026-10-01T10:00:00.000Z"); // Thu 1 Oct 2026, 11:00 BST
const H = 3600 * 1000, D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const TZ = "Europe/London";

const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach"), ROLE_LEARN = id("RoleLearn"), ROLE_OLD = id("RoleOld");
const roles: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true } },
  { id: ROLE_LEARN, fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } },
  { id: ROLE_OLD, fields: { "Role Name": "Retired Role", "Role Key": "retired_role" } },
];
const C1 = id("CoachOne"), C2 = id("CoachTwo"), C3 = id("CoachThree");

function session(sid: string, o: { lead?: boolean; rsc?: number | null; lifecycle?: string; name?: string } = {}): AirtableRecord {
  const f: Record<string, any> = { "Session Name": o.name ?? `Session ${sid.slice(3, 8)}`, "Session Lifecycle Status": o.lifecycle ?? "Active", Venue: [id("VenueX")] };
  if (o.lead) f["Requires Lead Coach"] = true;
  if (o.rsc != null) f["Required Staff Count"] = o.rsc;
  return { id: sid, fields: f };
}
function occ(oid: string, sid: string, startMs: number, o: { status?: string; replacement?: string; noStart?: boolean; date?: string } = {}): AirtableRecord {
  const start = at(startMs);
  const f: Record<string, any> = { "Occurrence Name": `Occ ${oid.slice(3, 9)}`, Status: o.status ?? "Scheduled", Session: [sid], Date: o.date ?? localDateIso(new Date(start), TZ) };
  if (!o.noStart) Object.assign(f, { "Start Date & Time": start, "End Date & Time": at(startMs + H) });
  if (o.replacement) f["Replacement Occurrence"] = [o.replacement];
  return { id: oid, fields: f };
}
let ssN = 0;
function staff(sid: string, coach: string, role: string, o: { from?: string; until?: string; active?: boolean } = {}): AirtableRecord {
  const f: Record<string, any> = { Session: [sid], Coach: [coach], Role: [role] };
  if (o.active ?? true) f.Active = true;
  if (o.from) f["Effective From"] = o.from;
  if (o.until) f["Effective Until"] = o.until;
  return { id: id("SS" + String(++ssN).padStart(3, "0")), fields: f };
}
function rule(key: string, ruleId: string, o: { sev?: string; warn?: [number, string]; urg?: [number, string]; sort: number }): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": key, "Rule ID": ruleId, "Rule Key": key, Category: "Staffing & Cover", "Default Enabled": true, "Default Base Severity": o.sev ?? "Normal",
    "Supports Override": true, "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": o.sort, Active: true,
    "Action Label": key === "session_no_coach" ? "Assign Staff" : "Review Staffing", "Destination Area": "Schedule & Sessions",
  };
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: id("Rule" + ruleId.replace("-", "")), fields: f };
}
// The TEST catalogue's real values for the four staffing rules.
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1 }),
  rule("learning_coach_only", "ATT-002", { sev: "Warning", urg: [48, "Hours Before"], sort: 2 }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5 }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13 }),
];

let tables: Record<string, AirtableRecord[]> = {};
let requests: string[] = [];
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected write ${init?.method} ${url}`);
  const table = decodeURIComponent(new URL(url).pathname.split("/")[3]);
  requests.push(table);
  return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields })) }), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;

function world(o: { sessions: AirtableRecord[]; occurrences: AirtableRecord[]; sessionStaff?: AirtableRecord[]; occurrenceStaff?: AirtableRecord[]; moduleOn?: boolean; settings?: AirtableRecord[] }) {
  tables = {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: o.settings ?? [],
    [CONFIG_TABLES.exceptions]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: o.moduleOn === false ? { "Feature Key": "module_coaches" } : { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: ORG, fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    "Sessions": o.sessions,
    "Session Occurrences": o.occurrences,
    "Session Staff": o.sessionStaff ?? [],
    "Occurrence Staff": o.occurrenceStaff ?? [],
    "Coach Roles": roles,
  };
  requests = [];
}
const MGMT: Caller = { userId: "u", role: "management", active: true, organisationId: "ORG-TEST-001" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS };
const run = (query: any = {}, now = NOW) => getCases(deps, MGMT, query, now) as Promise<any>;
const keysFor = (body: any, occId: string) => body.cases.filter((c: any) => c.targetIds.occurrenceId === occId).map((c: any) => c.ruleKey).sort();

function analysis(o: Partial<StaffingAnalysis>): StaffingAnalysis {
  return { occurrenceId: "recO", occurrenceName: null, sessionId: "recS", sessionName: null, dateIso: null, startIso: null, endIso: null, venueId: null, requiresLeadCoach: false, requiredStaffCount: null, staff: [], total: 0, leadCount: 0, coachCount: 0, learningCount: 0, unknownRoleCount: 0, qualifying: 0, ...o };
}

async function main() {
  // ===== Pure precedence (the locked table) =====
  const F = (o: Partial<StaffingAnalysis>) => staffingFindings(analysis({ ...o, total: o.total ?? (o.leadCount ?? 0) + (o.coachCount ?? 0) + (o.learningCount ?? 0) + (o.unknownRoleCount ?? 0), qualifying: (o.leadCount ?? 0) + (o.coachCount ?? 0) })).join(",");
  ck("P1. Zero staff -> session_no_coach ONLY (even with Lead required + Required Staff Count)", F({ requiresLeadCoach: true, requiredStaffCount: 3 }) === "session_no_coach");
  ck("P2. Learning Coach only + Lead required -> no_lead_coach ONLY (not learning_coach_only, not understaffed)", F({ learningCount: 1, requiresLeadCoach: true, requiredStaffCount: 2 }) === "no_lead_coach");
  ck("P3. Learning Coach only + Lead NOT required -> learning_coach_only ONLY (not understaffed)", F({ learningCount: 2, requiredStaffCount: 2 }) === "learning_coach_only");
  ck("P4. Coach present, Lead required, no Lead, below Required Staff Count -> BOTH no_lead_coach + session_understaffed", F({ coachCount: 1, requiresLeadCoach: true, requiredStaffCount: 2 }) === "no_lead_coach,session_understaffed");
  ck("P5. Coach present, Lead required, no Lead, count met -> no_lead_coach only", F({ coachCount: 2, requiresLeadCoach: true, requiredStaffCount: 2 }) === "no_lead_coach");
  ck("P6. Lead required and a Lead Coach present -> no no_lead_coach", F({ leadCount: 1, coachCount: 1, requiresLeadCoach: true, requiredStaffCount: 2 }) === "");
  ck("P7. Lead NOT required, Coach only -> never no_lead_coach", F({ coachCount: 2 }) === "");
  ck("P8. Understaffed: Required 2, one Coach -> session_understaffed", F({ coachCount: 1, requiredStaffCount: 2 }) === "session_understaffed");
  ck("P9. Learning Coach does not count: Required 2, Coach + Learning Coach -> still understaffed", F({ coachCount: 1, learningCount: 1, requiredStaffCount: 2 }) === "session_understaffed");
  ck("P10. Blank Required Staff Count -> never session_understaffed (not inferred)", F({ coachCount: 1, requiredStaffCount: null }) === "");
  ck("P11. Overstaffed (Required 1, three counting) -> nothing", F({ leadCount: 1, coachCount: 2, requiredStaffCount: 1 }) === "");
  ck("P12. Exactly at Required Staff Count -> nothing", F({ leadCount: 1, coachCount: 1, requiredStaffCount: 2 }) === "");
  ck("P13. Unrecognised-role-only roster, Lead not required -> learning_coach_only (no counting staff; fail-safe, documented)", F({ unknownRoleCount: 1, requiredStaffCount: 2 }) === "learning_coach_only");
  ck("P14. Unrecognised-role-only roster, Lead required -> no_lead_coach only", F({ unknownRoleCount: 1, requiresLeadCoach: true }) === "no_lead_coach");

  // ===== Role counting from the real resolver output =====
  {
    const caps = (key: string, name: string, active = true) => ({ active, roleName: name, roleKey: key, canViewPlayers: false, canAddFeedback: false, canEditDevelopmentPlans: false, canRecordAttendance: false });
    const a = analyseStaffing(occ(id("OccX"), id("SessX"), 2 * D), session(id("SessX"), { lead: true, rsc: 2 }), [
      { coachId: C1, roleCaps: caps("lead_coach", "Lead Coach"), fromOccurrenceStaff: false },
      { coachId: C2, roleCaps: caps("learning_coach", "Learning Coach"), fromOccurrenceStaff: false },
      { coachId: C3, roleCaps: caps("coach", "Coach", false), fromOccurrenceStaff: true },
      { coachId: id("CoachFour"), roleCaps: null, fromOccurrenceStaff: true },
    ]);
    ck("R1. Counting: Lead + Coach only; Learning Coach, inactive role and unresolved role never count", a.total === 4 && a.leadCount === 1 && a.learningCount === 1 && a.coachCount === 0 && a.unknownRoleCount === 2 && a.qualifying === 1);
    const s0 = analyseStaffing(occ(id("OccY"), id("SessY"), 2 * D), session(id("SessY"), { rsc: 0 }), []);
    const sBad = analyseStaffing(occ(id("OccY"), id("SessY"), 2 * D), { id: id("SessY"), fields: { "Required Staff Count": 1.5, "Session Lifecycle Status": "Active" } }, []);
    ck("R2. Required Staff Count: 0 is a real value; blank / fractional / negative = not specified", s0.requiredStaffCount === 0 && sBad.requiredStaffCount === null && analyseStaffing(occ(id("OccY"), id("SessY"), 2 * D), session(id("SessY")), []).requiredStaffCount === null);
  }

  // ===== 14-day window (Europe/London) =====
  {
    const o = (ms: number) => occ(id("OccW"), id("SessW"), ms);
    ck("W1. Starts in 1 hour -> in window", windowState(o(H), NOW, TZ) === "in_window");
    ck("W2. Starts EXACTLY 14 x 24h from now -> in window (inclusive)", windowState(o(STAFFING_WINDOW_DAYS * D), NOW, TZ) === "in_window");
    ck("W3. Starts 14 days + 1 ms from now -> beyond window (not evaluated)", windowState(o(STAFFING_WINDOW_DAYS * D + 1), NOW, TZ) === "beyond_window");
    ck("W4. Starts exactly now / already started -> past (not an upcoming staffing issue)", windowState(o(0), NOW, TZ) === "past_or_started" && windowState(o(-H), NOW, TZ) === "past_or_started");
    const late = new Date("2026-10-24T23:30:00.000Z"); // 00:30 BST on Sun 25 Oct
    ck("W5. Local date uses Europe/London (23:30Z on 24 Oct is already 25 Oct in the UK)", localDateIso(late, TZ) === "2026-10-25");
    const dated = (d: string) => ({ fields: { Date: d } });
    ck("W6. Date-only occurrence: today..today+14 (UK calendar) in; yesterday past; today+15 beyond", windowState(dated("2026-10-25"), late, TZ) === "in_window" && windowState(dated("2026-11-08"), late, TZ) === "in_window" && windowState(dated("2026-10-24"), late, TZ) === "past_or_started" && windowState(dated("2026-11-09"), late, TZ) === "beyond_window");
    ck("W7. No Start and no usable Date -> undated (not evaluated)", windowState({ fields: {} }, NOW, TZ) === "undated");
  }

  // ===== Occurrence eligibility (real Schedule model) =====
  {
    const S = session(id("SessE"));
    const e = (o: AirtableRecord, s: AirtableRecord | null = S) => occurrenceEligibility(o, s, NOW, TZ);
    ck("E1. Scheduled, Active session, in window -> eligible", e(occ(id("OccE1"), S.id, D)) === null);
    ck("E2. Cancelled / Postponed / Completed -> never eligible", e(occ(id("OccE2"), S.id, D, { status: "Cancelled" })) === "status_not_scheduled" && e(occ(id("OccE3"), S.id, D, { status: "Postponed" })) === "status_not_scheduled" && e(occ(id("OccE4"), S.id, D, { status: "Completed" })) === "status_not_scheduled");
    ck("E3. Occurrence with an outgoing Replacement Occurrence link is superseded", e(occ(id("OccE5"), S.id, D, { replacement: id("OccE6") })) === "superseded_by_replacement");
    ck("E4. Session not Active (Draft/Inactive) or missing -> not eligible", e(occ(id("OccE7"), S.id, D), session(S.id, { lifecycle: "Inactive" })) === "session_not_active" && e(occ(id("OccE8"), S.id, D), null) === "session_missing");
  }

  // ===== End-to-end scenarios through the orchestrator =====
  const S = {
    zero: session(id("SZero"), { lead: true, rsc: 2, name: "Zero" }),
    lcLead: session(id("SLcLead"), { lead: true, rsc: 2 }),
    lcNoLead: session(id("SLcNo"), { rsc: 2 }),
    coachLead: session(id("SCoLead"), { lead: true, rsc: 2 }),
    full: session(id("SFull"), { lead: true, rsc: 2 }),
    under: session(id("SUnder"), { rsc: 2 }),
    coLc: session(id("SCoLc"), { rsc: 2 }),
    blank: session(id("SBlank")),
    over: session(id("SOver"), { rsc: 1 }),
  };
  const O = {
    zero: occ(id("OZero"), S.zero.id, 5 * D), lcLead: occ(id("OLcLead"), S.lcLead.id, 5 * D), lcNoLead: occ(id("OLcNo"), S.lcNoLead.id, 5 * D),
    coachLead: occ(id("OCoLead"), S.coachLead.id, 5 * D), full: occ(id("OFull"), S.full.id, 5 * D), under: occ(id("OUnder"), S.under.id, 5 * D),
    coLc: occ(id("OCoLc"), S.coLc.id, 5 * D), blank: occ(id("OBlank"), S.blank.id, 5 * D), over: occ(id("OOver"), S.over.id, 5 * D),
  };
  const SS = [
    staff(S.lcLead.id, C1, ROLE_LEARN), staff(S.lcNoLead.id, C1, ROLE_LEARN), staff(S.coachLead.id, C2, ROLE_COACH),
    staff(S.full.id, C1, ROLE_LEAD), staff(S.full.id, C2, ROLE_COACH), staff(S.under.id, C2, ROLE_COACH),
    staff(S.coLc.id, C2, ROLE_COACH), staff(S.coLc.id, C1, ROLE_LEARN), staff(S.blank.id, C2, ROLE_COACH),
    staff(S.over.id, C1, ROLE_LEAD), staff(S.over.id, C2, ROLE_COACH), staff(S.over.id, C3, ROLE_COACH),
  ];
  world({ sessions: Object.values(S), occurrences: Object.values(O), sessionStaff: SS });
  const before = staffingPassStats.passes;
  const r = await run({ debug: true });
  const b = r.body;
  ck("S1. Zero staff -> only session_no_coach", keysFor(b, O.zero.id).join(",") === "session_no_coach");
  ck("S2. Lead required + Learning Coach only -> only no_lead_coach", keysFor(b, O.lcLead.id).join(",") === "no_lead_coach");
  ck("S3. Lead not required + Learning Coach only -> only learning_coach_only", keysFor(b, O.lcNoLead.id).join(",") === "learning_coach_only");
  ck("S4. Coach present, Lead required, no Lead, understaffed -> both no_lead_coach + session_understaffed", keysFor(b, O.coachLead.id).join(",") === "no_lead_coach,session_understaffed");
  ck("S5. Fully staffed -> no staffing case", keysFor(b, O.full.id).length === 0);
  ck("S6. Required 2 with one Coach -> session_understaffed", keysFor(b, O.under.id).join(",") === "session_understaffed");
  ck("S7. Required 2 with Coach + Learning Coach -> still session_understaffed", keysFor(b, O.coLc.id).join(",") === "session_understaffed");
  ck("S8. Blank Required Staff Count -> no understaffed case", keysFor(b, O.blank.id).length === 0);
  ck("S9. Overstaffed -> no case", keysFor(b, O.over.id).length === 0);
  ck("S10. Exactly 7 cases in total (1+1+1+2+1+1), all distinct (rule, occurrence) keys - no duplicates", b.cases.length === 7 && new Set(b.cases.map((c: any) => c.caseKey)).size === 7);
  ck("S11. ONE shared staffing pass for the four rules in one request", staffingPassStats.passes - before === 1, String(staffingPassStats.passes - before));
  ck("S12. Each staffing table listed exactly once; 10 list operations total (5 config + 5 staffing)", STAFFING_SOURCES.every((t) => b.diagnostics.reads.lists[t] === 1) && Object.keys(b.diagnostics.reads.lists).length === 10 && requests.length === 10);
  ck("S13. The four staffing rules were evaluated; engine complete, no config issues", b.diagnostics.evaluated.length === 4 && b.complete === true && b.configIssues.length === 0);
  const zeroCase = b.cases.find((c: any) => c.caseKey === `session_no_coach|occurrence:${O.zero.id}`);
  ck("S14. Case Key format: <rule>|occurrence:<Session Occurrence record id>", !!zeroCase && b.cases.every((c: any) => c.caseKey === `${c.ruleKey}|occurrence:${c.targetIds.occurrenceId}`));
  const r2 = await run();
  ck("S15. Case Keys are stable across requests", JSON.stringify(r2.body.cases.map((c: any) => c.caseKey).sort()) === JSON.stringify(b.cases.map((c: any) => c.caseKey).sort()));
  ck("S16. Payload: session/occurrence ids, venue, name, local time, staffing summary, required count, requiresLeadCoach, route", zeroCase.targetIds.sessionId === S.zero.id && zeroCase.targetIds.venueId === id("VenueX") && zeroCase.context.sessionName === "Zero" && zeroCase.context.startLocal === "Tue 6 Oct 2026, 11:00" && zeroCase.context.staffingSummary === "no staff" && zeroCase.context.requiredStaffCount === 2 && zeroCase.context.requiresLeadCoach === true && zeroCase.destination.area === "Schedule & Sessions" && zeroCase.destination.route === "schedule/occurrence-staffing" && zeroCase.destination.params.occurrenceId === O.zero.id && zeroCase.actionLabel === "Assign Staff");
  const under = b.cases.find((c: any) => c.caseKey === `session_understaffed|occurrence:${O.coLc.id}`);
  ck("S17. Understaffed detail explains counting vs required and lists staff by role", /Counting staff \(Lead Coach \+ Coach\) is 1, below the Required Staff Count of 2/.test(under.detail) && under.context.staffingSummary === "1 Coach, 1 Learning Coach" && under.context.countingStaff === 1 && under.relatedIds.coachIds.length === 2);
  ck("S18. No player data in any staffing case", !JSON.stringify(b.cases).match(/[Pp]layer/));

  // ===== Severity from the catalogue (generic engine, anchor = occurrence start) =====
  {
    const sev = (startMs: number, sess: AirtableRecord) => {
      const o = occ(id("OSev" + startMs), sess.id, startMs);
      return o;
    };
    const nl = session(id("SSevNl"), { lead: true });
    const nz = session(id("SSevNz"));
    const occs = [sev(20 * H, nl), sev(50 * H, nl), sev(5 * D, nl), sev(47 * H, nz), sev(49 * H, nz)];
    world({ sessions: [nl, nz], occurrences: occs, sessionStaff: [staff(nl.id, C2, ROLE_COACH)] });
    const s = (await run()).body.cases;
    const g = (o: AirtableRecord, rk: string) => s.find((c: any) => c.caseKey === `${rk}|occurrence:${o.id}`)?.severity;
    ck("V1. no_lead_coach: 20h out -> Urgent (24h before); 50h -> Warning (72h before); 5 days -> Normal", g(occs[0], "no_lead_coach") === "Urgent" && g(occs[1], "no_lead_coach") === "Warning" && g(occs[2], "no_lead_coach") === "Normal");
    ck("V2. session_no_coach: base Warning; 47h out -> Urgent (48h before); 49h -> Warning", g(occs[3], "session_no_coach") === "Urgent" && g(occs[4], "session_no_coach") === "Warning");
    ck("V3. Summary reflects the highest severity (Urgent)", (await run({ view: "summary" })).body.summary.state === "Urgent");
  }

  // ===== Occurrence Staff override (one occurrence only) =====
  {
    const s = session(id("SOvr"), { lead: true, rsc: 1, name: "Override" });
    const ssA = staff(s.id, C1, ROLE_LEAD);
    const oA = occ(id("OOvrA"), s.id, 3 * D), oB = occ(id("OOvrB"), s.id, 10 * D);
    const cover: AirtableRecord = { id: id("OSCover"), fields: { "Session Occurrence": [oA.id], Coach: [C2], "Assignment Type": "Cover", "Session Staff Source": [ssA.id], "Planned Role Snapshot": "Coach", Attendance: "Planned" } };
    world({ sessions: [s], occurrences: [oA, oB], sessionStaff: [ssA], occurrenceStaff: [cover] });
    const snapshot = JSON.stringify(tables["Session Staff"]);
    const o = (await run()).body;
    ck("O1. Cover replacement (Lead Coach -> Coach) on ONE occurrence -> no_lead_coach for that occurrence only", keysFor(o, oA.id).join(",") === "no_lead_coach" && keysFor(o, oB.id).length === 0);
    ck("O2. Recurring Session Staff untouched (no writes possible; data identical after evaluation)", JSON.stringify(tables["Session Staff"]) === snapshot);
    const absent: AirtableRecord = { id: id("OSAbsent"), fields: { "Session Occurrence": [oB.id], Coach: [C1], "Assignment Type": "Planned", Attendance: "Absent" } };
    const additional: AirtableRecord = { id: id("OSAdd"), fields: { "Session Occurrence": [oB.id], Coach: [C3], "Assignment Type": "Additional", "Planned Role Snapshot": "Learning Coach" } };
    world({ sessions: [s], occurrences: [oA, oB], sessionStaff: [ssA], occurrenceStaff: [absent, additional] });
    const o2 = (await run()).body;
    ck("O3. Existing resolver semantics reused verbatim: an Absent row is ignored (no row-level removal) and an Additional row adds staff", keysFor(o2, oB.id).length === 0 && keysFor(o2, oA.id).length === 0);
  }

  // ===== Effective-dated Session Staff handover =====
  {
    const s = session(id("SHand"), { lead: true, name: "Handover" });
    const d4 = localDateIso(new Date(NOW.getTime() + 4 * D), TZ), d5 = localDateIso(new Date(NOW.getTime() + 5 * D), TZ);
    const oLast = occ(id("OHandLast"), s.id, 4 * D), oFirst = occ(id("OHandFirst"), s.id, 5 * D);
    world({ sessions: [s], occurrences: [oLast, oFirst], sessionStaff: [staff(s.id, C1, ROLE_LEAD, { until: d4 }), staff(s.id, C2, ROLE_COACH, { from: d5 })] });
    const h = (await run()).body;
    ck("H1. Handover: Lead Coach row applies THROUGH its Effective Until (inclusive) -> no case on that date", keysFor(h, oLast.id).length === 0);
    ck("H2. ...from the next day only the Coach applies -> no_lead_coach", keysFor(h, oFirst.id).join(",") === "no_lead_coach");
    world({ sessions: [s], occurrences: [oLast], sessionStaff: [staff(s.id, C1, ROLE_LEAD, { active: false })] });
    ck("H3. An inactive Session Staff row never applies -> zero staff -> session_no_coach", keysFor((await run()).body, oLast.id).join(",") === "session_no_coach");
  }

  // ===== Cancelled / postponed / replacement / window / inactive session =====
  {
    const s = session(id("SSched"), { lead: true, rsc: 1 });
    const cancelled = occ(id("OCanc"), s.id, 2 * D, { status: "Cancelled" });
    const postponed = occ(id("OPost"), s.id, 3 * D, { status: "Postponed" });
    const replacement = occ(id("ORepl"), s.id, 6 * D);
    const original = occ(id("OOrig"), s.id, 4 * D, { status: "Postponed", replacement: replacement.id });
    const moved = occ(id("OMoved"), s.id, 7 * D, { replacement: id("OElsewhere") });
    const past = occ(id("OPast"), s.id, -2 * H);
    const beyond = occ(id("OBeyond"), s.id, 15 * D);
    const edge = occ(id("OEdge"), s.id, 14 * D);
    const inactive = session(id("SInact"), { lifecycle: "Inactive" });
    const inactiveOcc = occ(id("OInact"), inactive.id, 2 * D);
    world({ sessions: [s, inactive], occurrences: [cancelled, postponed, original, replacement, moved, past, beyond, edge, inactiveOcc] });
    const c = await run({ debug: true });
    const ids = new Set(c.body.cases.map((x: any) => x.targetIds.occurrenceId));
    ck("C1. Cancelled occurrence (zero staff) raises nothing", !ids.has(cancelled.id));
    ck("C2. Postponed occurrence raises nothing", !ids.has(postponed.id));
    ck("C3. Superseded original (has Replacement Occurrence link) raises nothing, even if Scheduled", !ids.has(original.id) && !ids.has(moved.id));
    ck("C4. The replacement occurrence is evaluated normally (zero staff -> session_no_coach)", keysFor(c.body, replacement.id).join(",") === "session_no_coach");
    ck("C5. Past / already-started occurrence raises nothing", !ids.has(past.id));
    ck("C6. Occurrence beyond 14 days raises nothing; exactly 14 days out IS evaluated", !ids.has(beyond.id) && keysFor(c.body, edge.id).join(",") === "session_no_coach");
    ck("C7. Occurrence of an Inactive Session raises nothing", !ids.has(inactiveOcc.id));
    ck("C8. Exactly 2 cases (replacement + 14-day edge)", c.body.cases.length === 2);
  }

  // ===== Gating still protects domain reads =====
  {
    world({ sessions: [S.zero], occurrences: [O.zero], moduleOn: false });
    const passes = staffingPassStats.passes;
    const g = await run({ debug: true });
    ck("G1. module_coaches OFF -> staffing rules skipped (module_off), NO staffing table read, no staffing pass", g.body.cases.length === 0 && g.body.diagnostics.skipped.filter((x: any) => x.reason === "module_off").length === 4 && STAFFING_SOURCES.every((t) => !requests.includes(t)) && staffingPassStats.passes === passes);
    const setOff = { id: id("SetOff"), fields: { Organisation: [ORG], Rule: [RULES[3].id] } }; // session_no_coach disabled by Settings
    world({ sessions: [S.zero, S.lcLead], occurrences: [O.zero, O.lcLead], sessionStaff: [SS[0]], settings: [setOff] });
    const g2 = await run();
    ck("G2. Settings disable session_no_coach -> zero-staff occurrence yields NOTHING (precedence is not re-routed to other rules)", keysFor(g2.body, O.zero.id).length === 0 && keysFor(g2.body, O.lcLead.id).join(",") === "no_lead_coach");
    world({ sessions: [S.zero, S.coachLead], occurrences: [O.zero, O.coachLead], sessionStaff: [SS[2]] });
    const passes2 = staffingPassStats.passes;
    const lk = await run({ caseKey: `session_understaffed|occurrence:${O.coachLead.id}` });
    ck("G3. caseKey lookup evaluates only that rule (still via the shared pass) and finds the case", lk.body.exists === true && lk.body.case.ruleKey === "session_understaffed" && staffingPassStats.passes - passes2 === 1);
  }

  // ===== Drift =====
  {
    const na = readFileSync(join(FUNCS, "needs-attention/staffing.ts"), "utf8");
    const cc = readFileSync(join(FUNCS, "coach-cover/staffing.ts"), "utf8");
    const pa = readFileSync(join(FUNCS, "hub-content/player-access.ts"), "utf8");
    const blockOf = (s: string) => s.slice(s.indexOf("DO NOT EDIT HERE =====\n") + 23, s.indexOf("// ===== END COPIED BLOCK ====="));
    const block = blockOf(na);
    const chunks = block.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
    const missing = chunks.filter((c) => !pa.includes(c));
    ck("DR1. Every chunk of needs-attention/staffing.ts's copied resolver appears verbatim in hub-content/player-access.ts", chunks.length >= 10 && missing.length === 0, missing.map((m) => m.slice(0, 60)).join(" | "));
    ck("DR2. The copied resolver block is byte-identical to coach-cover/staffing.ts's copy (one interpretation of staffing)", block === blockOf(cc) && block.length > 3000);
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const reg = IMPLEMENTED_EVALUATORS.map((e) => `${e.ruleKey}=${e.ruleId}`).sort().join(",");
    ck("DR3. Registry = the four staffing rules with the TEST catalogue's exact Rule IDs, all Active in the catalogue", reg === "learning_coach_only=ATT-002,no_lead_coach=ATT-001,session_no_coach=ATT-013,session_understaffed=ATT-005" && IMPLEMENTED_EVALUATORS.every((e) => fixture.find((f) => f.ruleKey === e.ruleKey)?.ruleId === e.ruleId && fixture.find((f) => f.ruleKey === e.ruleKey)?.evaluationStatus === "Active"));
    ck("DR4. All four declare the identical shared source list (so each table loads once)", IMPLEMENTED_EVALUATORS.every((e) => e.sources === STAFFING_SOURCES) && STAFFING_SOURCES.join(",") === "Session Occurrences,Sessions,Session Staff,Occurrence Staff,Coach Roles");
    ck("DR5. No Volunteer role introduced; window is the fixed 14-day default (no Settings field)", !/volunteer/i.test(na.replace(/\/\*[\s\S]*?\*\//g, "")) && STAFFING_WINDOW_DAYS === 14);
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
