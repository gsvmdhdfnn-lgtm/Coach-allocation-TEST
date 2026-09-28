// Unit + integration tests for Needs Attention Slice 4 - cover_open, one
// case per cover date (see TEST-ENV.md "Needs Attention Foundation - Slice
// 4"). Request-level behaviour runs through the REAL orchestrator + the
// deployed registry (staffing + cover) against an in-memory Airtable that
// serves records WITH their createdTime (the request-age anchor) and
// REJECTS any write.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { STAFFING_TABLES, localDateIso } from "./needs-attention-staffing.ts";
import { COVER_EVALUATOR, COVER_SOURCES, COVER_TABLES, coverDateEligibility, coverPassStats, deriveGroupStatus } from "./needs-attention-cover.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = id("OrgTest1");
const NOW = new Date("2026-10-01T10:00:00.000Z"); // Thu 1 Oct 2026, 11:00 BST
const H = 3600 * 1000, D = 24 * H;
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const TZ = "Europe/London";

const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach"), ROLE_LEARN = id("RoleLearn");
const roles: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true } },
  { id: ROLE_LEARN, fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } },
];
const C1 = id("CoachOne"), C2 = id("CoachTwo"), C3 = id("CoachThree"), CX = id("CoachInactX");
const COACHES: AirtableRecord[] = [
  { id: C1, fields: { "Coach Name": "Alex One", Active: true } },
  { id: C2, fields: { "Coach Name": "Sam Two", Active: true } },
  { id: C3, fields: { "Coach Name": "Jo Three", Active: true } },
  { id: CX, fields: { "Coach Name": "Inactive X" } },
];

function session(sid: string, o: { lead?: boolean; rsc?: number | null; name?: string } = {}): AirtableRecord {
  const f: Record<string, any> = { "Session Name": o.name ?? `Session ${sid.slice(3, 8)}`, "Session Lifecycle Status": "Active" };
  if (o.lead) f["Requires Lead Coach"] = true;
  if (o.rsc != null) f["Required Staff Count"] = o.rsc;
  return { id: sid, fields: f };
}
function occ(oid: string, sid: string, startMs: number, o: { status?: string; noStart?: boolean } = {}): AirtableRecord {
  const start = at(startMs);
  const f: Record<string, any> = { "Occurrence Name": `Occ ${oid.slice(3, 9)}`, Status: o.status ?? "Scheduled", Session: [sid], Date: localDateIso(new Date(start), TZ) };
  if (!o.noStart) Object.assign(f, { "Start Date & Time": start, "End Date & Time": at(startMs + H) });
  return { id: oid, fields: f };
}
let ssN = 0;
function staff(sid: string, coach: string, role: string): AirtableRecord {
  return { id: id("SS" + String(++ssN).padStart(3, "0")), fields: { Session: [sid], Coach: [coach], Role: [role], Active: true } };
}
/** A cover DATE row (Staff Availability Requests), created `ageMs` before NOW. */
function coverDate(rid: string, occId: string | null, o: { status?: string; group?: string; requester?: string; ageMs?: number; replacement?: string; createdTime?: string | null } = {}): AirtableRecord {
  const f: Record<string, any> = { "Request ID": `COVER-${rid}`, "Request Type": "Cover Request", Coach: [o.requester ?? C1], "Cover Date Status": o.status ?? "Open" };
  if (occId) f["Session Occurrence"] = [occId];
  if (o.group) f["Cover Request Group"] = [o.group];
  if (o.replacement) f["Replacement Coach"] = [o.replacement];
  const createdTime = o.createdTime === null ? undefined : o.createdTime ?? new Date(NOW.getTime() - (o.ageMs ?? H)).toISOString();
  return { id: rid, fields: f, createdTime };
}
function response(rid: string, dateId: string, coach: string, status: "Yes" | "No", active = true): AirtableRecord {
  const f: Record<string, any> = { "Cover Response ID": `COVERRESP-${rid}`, "Cover Request Date": [dateId], Coach: [coach], "Response Status": status };
  if (active) f.Active = true;
  return { id: rid, fields: f };
}
function rule(key: string, ruleId: string, o: { sev?: string; warn?: [number, string]; urg?: [number, string]; sort: number; area?: string; action?: string }): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": key, "Rule ID": ruleId, "Rule Key": key, Category: "Staffing & Cover", "Default Enabled": true, "Default Base Severity": o.sev ?? "Normal",
    "Supports Override": true, "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": o.sort, Active: true,
    "Action Label": o.action ?? "Review Staffing", "Destination Area": o.area ?? "Schedule & Sessions",
  };
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: id("Rule" + ruleId.replace("-", "")), fields: f };
}
// The TEST catalogue's real values (staffing per NA6.4, cover_open per NA1.7/NA2.3).
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1 }),
  rule("learning_coach_only", "ATT-002", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 2 }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5 }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13, action: "Assign Staff" }),
  rule("cover_open", "ATT-041", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sort: 41, area: "Coaches", action: "Resolve Cover" }),
];
const COVER_RULE = RULES[4];

let tables: Record<string, AirtableRecord[]> = {};
let requests: string[] = [];
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected write ${init?.method} ${url}`);
  const table = decodeURIComponent(new URL(url).pathname.split("/")[3]);
  requests.push(table);
  return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields, createdTime: r.createdTime })) }), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;

function world(o: { sessions?: AirtableRecord[]; occurrences?: AirtableRecord[]; sessionStaff?: AirtableRecord[]; occurrenceStaff?: AirtableRecord[]; dates?: AirtableRecord[]; responses?: AirtableRecord[]; moduleOn?: boolean; settings?: AirtableRecord[] }) {
  tables = {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: o.settings ?? [],
    [CONFIG_TABLES.exceptions]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: o.moduleOn === false ? { "Feature Key": "module_coaches" } : { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: ORG, fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    "Sessions": o.sessions ?? [],
    "Session Occurrences": o.occurrences ?? [],
    "Session Staff": o.sessionStaff ?? [],
    "Occurrence Staff": o.occurrenceStaff ?? [],
    "Coach Roles": roles,
    "Coaches": COACHES,
    "Staff Availability Requests": o.dates ?? [],
    "Cover Responses": o.responses ?? [],
  };
  requests = [];
}
const MGMT: Caller = { userId: "u", role: "management", active: true, organisationId: "ORG-TEST-001" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS };
const run = (query: any = {}, now = NOW) => getCases(deps, MGMT, query, now) as Promise<any>;
const coverCases = (b: any) => b.cases.filter((c: any) => c.ruleKey === "cover_open");
const coverFor = (b: any, rid: string) => b.cases.find((c: any) => c.caseKey === `cover_open|coverdate:${rid}`);
const keysForOcc = (b: any, occId: string) => b.cases.filter((c: any) => c.targetIds.occurrenceId === occId).map((c: any) => c.ruleKey).sort();

async function main() {
  // ===== Eligibility (the workflow's own "Open", plus the catalogue's occurrence conditions) =====
  {
    const S = session(id("SEl"));
    const o = occ(id("OEl"), S.id, 3 * D);
    const e = (rd: AirtableRecord, oc: AirtableRecord | null = o) => coverDateEligibility(rd, oc, NOW, TZ);
    ck("E1. Open cover date for a future Scheduled occurrence -> eligible", e(coverDate(id("RdE1"), o.id)) === null);
    ck("E2. Filled / Cancelled / Resolved Without Cover / blank status -> not_open (resolved in the workflow)", ["Filled", "Cancelled", "Resolved Without Cover", ""].every((s) => e(coverDate(id("RdE2"), o.id, { status: s })) === "not_open"));
    ck("E3. Occurrence Cancelled or Postponed -> occurrence_not_running", e(coverDate(id("RdE3"), o.id), occ(o.id, S.id, 3 * D, { status: "Cancelled" })) === "occurrence_not_running" && e(coverDate(id("RdE3"), o.id), occ(o.id, S.id, 3 * D, { status: "Postponed" })) === "occurrence_not_running");
    ck("E4. Occurrence already started (start <= now) or date-only in the past -> occurrence_started", e(coverDate(id("RdE4"), o.id), occ(o.id, S.id, 0)) === "occurrence_started" && e(coverDate(id("RdE4"), o.id), occ(o.id, S.id, -2 * D, { noStart: true })) === "occurrence_started");
    ck("E5. Missing occurrence does NOT hide an Open date (fail visible)", e(coverDate(id("RdE5"), id("OGone")), null) === null);
    ck("E6. The copied deriveGroupStatus matches the workflow's semantics", deriveGroupStatus(["Filled", "Open", "Cancelled"]) === "Partially Filled" && deriveGroupStatus(["Cancelled", "Cancelled"]) === "Cancelled" && deriveGroupStatus(["Cancelled", "Resolved Without Cover"]) === "Resolved Without Cover" && deriveGroupStatus(["Open"]) === "Open");
  }

  // ===== Severity: Normal / 48h-unresolved Warning / 24h-before-session Urgent =====
  {
    const S = session(id("SSev"), { name: "Sev" });
    const ss = staff(S.id, C1, ROLE_COACH);
    const o = (tag: string, ms: number, noStart = false) => occ(id(tag), S.id, ms, { noStart });
    const O = { fresh: o("OSvFresh", 5 * D), w48: o("OSvW48", 5 * D), w48m: o("OSvW48m", 5 * D), wOld: o("OSvWOld", 5 * D), u24: o("OSvU24", 24 * H), u24p: o("OSvU24p", 24 * H + 1), uIn: o("OSvUIn", 2 * H), both: o("OSvBoth", 2 * H), untimed: o("OSvUnt", D + 2 * H, true) };
    const RD = {
      fresh: coverDate(id("RdFresh"), O.fresh.id, { ageMs: H }),
      w48: coverDate(id("RdW48"), O.w48.id, { ageMs: 48 * H }),
      w48m: coverDate(id("RdW48m"), O.w48m.id, { ageMs: 48 * H - 1 }),
      wOld: coverDate(id("RdWOld"), O.wOld.id, { ageMs: 100 * H }),
      u24: coverDate(id("RdU24"), O.u24.id, { ageMs: H }),
      u24p: coverDate(id("RdU24p"), O.u24p.id, { ageMs: H }),
      uIn: coverDate(id("RdUIn"), O.uIn.id, { ageMs: H }),
      both: coverDate(id("RdBoth"), O.both.id, { ageMs: 72 * H }),
      untimed: coverDate(id("RdUnt"), O.untimed.id, { ageMs: H }),
    };
    world({ sessions: [S], occurrences: Object.values(O), sessionStaff: [ss], dates: Object.values(RD) });
    const b = (await run()).body;
    const sev = (rd: AirtableRecord) => coverFor(b, rd.id)?.severity ?? "none";
    ck("V1. Fresh open cover date (1h old, session in 5 days) -> Normal", sev(RD.fresh) === "Normal" && /^base Normal$/.test(coverFor(b, RD.fresh.id).severityReason));
    ck("V2. Unresolved for EXACTLY 48h -> Warning (inclusive)", sev(RD.w48) === "Warning" && /Warning threshold reached \(48h overdue\)/.test(coverFor(b, RD.w48.id).severityReason));
    ck("V3. 48h - 1ms -> still Normal", sev(RD.w48m) === "Normal");
    ck("V4. Unresolved well over 48h (100h) -> Warning", sev(RD.wOld) === "Warning");
    ck("V5. Occurrence starts EXACTLY 24h from now -> Urgent (inclusive, anchored on session start, not request age)", sev(RD.u24) === "Urgent" && /Urgent threshold reached \(24h before event\)/.test(coverFor(b, RD.u24.id).severityReason));
    ck("V6. Occurrence 24h + 1ms away -> NOT Urgent (fresh request -> Normal)", sev(RD.u24p) === "Normal");
    ck("V7. Occurrence inside 24h (2h away) -> Urgent", sev(RD.uIn) === "Urgent");
    const both = coverFor(b, RD.both.id);
    ck("V8. Both apply (72h unresolved + session in 2h) -> Urgent wins; both reasons recorded", both?.severity === "Urgent" && /Warning threshold reached/.test(both.severityReason) && /Urgent threshold reached/.test(both.severityReason));
    ck("V9. Untimed occurrence (no Start Date & Time) is still a case but never escalates on session time; reported as a config issue", sev(RD.untimed) === "Normal" && b.configIssues.some((i: any) => i.code === "cover_occurrence_untimed" && i.recordId === RD.untimed.id));
    ck("V10. Exactly one case per open date; 9 cover cases, no duplicates", coverCases(b).length === 9 && new Set(coverCases(b).map((c: any) => c.caseKey)).size === 9);
    const later = (await run({}, new Date(NOW.getTime() + 47 * H))).body;
    ck("V11. Same date re-evaluated 47h later: the 1h-old request is now 48h old -> Warning; its session (5d out) still not Urgent", coverFor(later, RD.fresh.id)?.severity === "Warning");
  }

  // ===== Lifecycle: resolved states disappear; responses alone never resolve =====
  {
    const S = session(id("SLife"), { name: "Life" });
    const o = (tag: string) => occ(id(tag), S.id, 4 * D);
    const O = { acc: o("OLfAcc"), fill: o("OLfFill"), canc: o("OLfCanc"), rwc: o("OLfRwc"), inact: o("OLfInact") };
    const RD = {
      acc: coverDate(id("RdLfAcc"), O.acc.id),
      fill: coverDate(id("RdLfFill"), O.fill.id, { status: "Filled", replacement: C2 }),
      canc: coverDate(id("RdLfCanc"), O.canc.id, { status: "Cancelled" }),
      rwc: coverDate(id("RdLfRwc"), O.rwc.id, { status: "Resolved Without Cover" }),
      inact: coverDate(id("RdLfInact"), O.inact.id),
    };
    const resp = [response(id("RespAcc1"), RD.acc.id, C2, "Yes"), response(id("RespAcc2"), RD.acc.id, C3, "No"), response(id("RespOld"), RD.inact.id, C2, "Yes", false)];
    world({ sessions: [S], occurrences: Object.values(O), sessionStaff: [staff(S.id, C1, ROLE_COACH)], dates: Object.values(RD), responses: resp });
    const b = (await run()).body;
    const acc = coverFor(b, RD.acc.id);
    ck("L1. A coach Accepting (Response Status Yes) does NOT resolve the date - case stays open, showing 1 accepted / 1 declined", !!acc && acc.context.acceptedResponses === 1 && acc.context.declinedResponses === 1 && acc.relatedIds.acceptedCoachIds.join(",") === C2 && /1 coach accepted - choose the cover coach/.test(acc.detail));
    ck("L2. Management selected the final cover (Cover Date Status Filled) -> no case", !coverFor(b, RD.fill.id));
    ck("L3. Date Cancelled -> no case", !coverFor(b, RD.canc.id));
    ck("L4. Resolved Without Cover -> no case", !coverFor(b, RD.rwc.id));
    ck("L5. An inactive (withdrawn) response is ignored - still 'No coach has accepted yet'", coverFor(b, RD.inact.id)?.context.acceptedResponses === 0 && /No coach has accepted yet/.test(coverFor(b, RD.inact.id).detail));
    ck("L6. Exactly 2 cover cases remain (the accepted-but-unselected date + the withdrawn-response date)", coverCases(b).length === 2);
  }

  // ===== Multi-date request: independent per-date cases, grouped by parent =====
  {
    const S = session(id("SMulti"), { name: "Multi" });
    const G = id("GrpMulti");
    const O = { a: occ(id("OMa"), S.id, 3 * D), b: occ(id("OMb"), S.id, 10 * D), c: occ(id("OMc"), S.id, 17 * D), d: occ(id("OMd"), S.id, 24 * D) };
    const RD = {
      a: coverDate(id("RdMa"), O.a.id, { group: G, status: "Filled", replacement: C2 }),
      b: coverDate(id("RdMb"), O.b.id, { group: G }),
      c: coverDate(id("RdMc"), O.c.id, { group: G, status: "Cancelled" }),
      d: coverDate(id("RdMd"), O.d.id, { group: G }),
    };
    world({ sessions: [S], occurrences: Object.values(O), sessionStaff: [staff(S.id, C1, ROLE_COACH)], dates: Object.values(RD) });
    const b = (await run()).body;
    const cb = coverFor(b, RD.b.id), cd = coverFor(b, RD.d.id);
    ck("M1. Date A (Coach 1 selected, Filled) -> no case", !coverFor(b, RD.a.id));
    ck("M2. Date B (unresolved) -> exactly one cover_open case", !!cb && coverCases(b).filter((c: any) => c.targetIds.requestDateId === RD.b.id).length === 1);
    ck("M3. Date C (cancelled) -> no case", !coverFor(b, RD.c.id));
    ck("M4. Date D (unresolved, 24 days out - cover has no look-ahead window) -> its own case", !!cd);
    ck("M5. Sibling dates carry the SAME parent group id for UI grouping, with derived group status 'Partially Filled'", cb.context.coverRequestGroupId === G && cd.context.coverRequestGroupId === G && cb.targetIds.coverRequestGroupId === G && cb.context.groupStatus === "Partially Filled");
    ck("M6. Grouping metadata: 3 siblings each, 1 other open sibling, sibling ids listed (excluding self)", cb.context.siblingDates === 3 && cb.context.siblingOpenDates === 1 && cb.relatedIds.siblingRequestDateIds.includes(RD.d.id) && !cb.relatedIds.siblingRequestDateIds.includes(RD.b.id) && /Part of a 4-date request \(1 other date still open\)/.test(cb.detail));
    ck("M7. Not one giant case: 2 cases for a 4-date request with mixed outcomes, distinct keys", coverCases(b).length === 2 && cb.caseKey !== cd.caseKey);
    // Resolve date B too (Management selected): only D remains.
    world({ sessions: [S], occurrences: Object.values(O), sessionStaff: [staff(S.id, C1, ROLE_COACH)], dates: [RD.a, { ...RD.b, fields: { ...RD.b.fields, "Cover Date Status": "Filled", "Replacement Coach": [C3] } }, RD.c, RD.d] });
    const b2 = (await run()).body;
    ck("M8. Filling one more date removes only that date's case; D keeps the SAME Case Key", coverCases(b2).length === 1 && coverFor(b2, RD.d.id)?.caseKey === cd.caseKey);
  }

  // ===== Identity =====
  {
    const S = session(id("SId"));
    const O1 = occ(id("OId1"), S.id, 3 * D), O2 = occ(id("OId2"), S.id, 4 * D);
    const RD1 = coverDate(id("RdId1"), O1.id, { group: id("GrpId") }), RD2 = coverDate(id("RdId2"), O2.id, { group: id("GrpId") });
    world({ sessions: [S], occurrences: [O1, O2], dates: [RD1, RD2] });
    const k1 = coverCases((await run()).body).map((c: any) => c.caseKey).sort();
    const k2 = coverCases((await run({}, new Date(NOW.getTime() + 5 * H))).body).map((c: any) => c.caseKey).sort();
    ck("K1. Case Key = cover_open|coverdate:<Staff Availability Requests record id> (the dedicated per-date record)", k1.join(",") === [`cover_open|coverdate:${RD1.id}`, `cover_open|coverdate:${RD2.id}`].sort().join(","));
    ck("K2. Keys are deterministic and stable across requests / time while unresolved; no names or titles in the key", JSON.stringify(k1) === JSON.stringify(k2) && k1.every((k: string) => !/\s/.test(k)));
    const lk = await run({ caseKey: `cover_open|coverdate:${RD1.id}` });
    ck("K3. caseKey lookup finds the exact date's case", lk.body.exists === true && lk.body.case.targetIds.requestDateId === RD1.id);
  }

  // ===== Payload =====
  {
    const S = session(id("SPay"), { name: "Friday Juniors" });
    const O = occ(id("OPay"), S.id, 3 * D);
    const RD = coverDate(id("RdPay"), O.id, { group: id("GrpPay"), ageMs: 5 * H, requester: C1 });
    world({ sessions: [S], occurrences: [O], sessionStaff: [staff(S.id, C1, ROLE_COACH)], dates: [RD], responses: [response(id("RespPay"), RD.id, C2, "Yes")] });
    const c = coverFor((await run()).body, RD.id);
    ck("P1. Payload: request/group/date ids, occurrence + session ids/names, local time, requester, request time, unresolved duration, response state", c.targetIds.requestDateId === RD.id && c.targetIds.occurrenceId === O.id && c.targetIds.sessionId === S.id && c.context.coverRequestGroupId === id("GrpPay") && c.context.requestId === `COVER-${RD.id}` && c.context.sessionName === "Friday Juniors" && c.context.startLocal === "Sun 4 Oct 2026, 11:00" && c.context.requesterCoachId === C1 && c.context.requesterName === "Alex One" && c.context.requestedAt === RD.createdTime && c.context.openForHours === 5 && c.context.openForMinutes === 300 && c.context.acceptedResponses === 1 && c.context.selectedCoachId === null && c.context.coverDateStatus === "Open");
    ck("P2. Catalogue action/destination: 'Resolve Cover', area Coaches, route to the exact cover date (no fake NA resolution screen)", c.actionLabel === "Resolve Cover" && c.destination.area === "Coaches" && c.destination.route === "coaches/cover-request-date" && c.destination.params.requestDateId === RD.id && c.destination.params.groupId === id("GrpPay") && c.destination.params.occurrenceId === O.id);
    ck("P3. Title/detail readable; no cover reason, notes or player data exposed", c.title === "Cover needed - Friday Juniors" && /Alex One requested cover 5h ago; not yet filled/.test(c.detail) && !/Illness|reason|Handover|[Pp]layer/.test(JSON.stringify(c)));
    ck("P4. Severity fields present (severity + severityReason) and anchorTime = occurrence start", c.severity === "Normal" && typeof c.severityReason === "string" && c.anchorTime === O.fields["Start Date & Time"]);
  }

  // ===== Missing occurrence / request time (fail visible) =====
  {
    const RD = coverDate(id("RdGhost"), id("OGhost"));
    const RD2 = coverDate(id("RdNoCt"), null, { createdTime: null });
    world({ dates: [RD, RD2] });
    const b = (await run()).body;
    ck("F1. Open date whose occurrence cannot be read is still shown (Normal) + cover_occurrence_missing issue", coverFor(b, RD.id)?.severity === "Normal" && b.configIssues.some((i: any) => i.code === "cover_occurrence_missing" && i.recordId === RD.id));
    ck("F2. Open date with no created time -> case shown, cover_request_time_unknown issue (Warning cannot apply); queue stays complete", !!coverFor(b, RD2.id) && b.configIssues.some((i: any) => i.code === "cover_request_time_unknown" && i.recordId === RD2.id) && b.complete === true);
  }

  // ===== Reads, sharing and gating =====
  {
    const S = session(id("SRd"));
    const O = occ(id("ORd"), S.id, 3 * D);
    world({ sessions: [S], occurrences: [O], sessionStaff: [staff(S.id, C1, ROLE_COACH)], dates: [coverDate(id("RdRd"), O.id)] });
    const before = coverPassStats.passes;
    const b = (await run({ debug: true })).body;
    const lists = b.diagnostics.reads.lists;
    ck("R1. Full request (4 staffing + cover): 13 list operations - 5 config + 6 staffing + 2 cover-only - each table exactly once", Object.keys(lists).length === 13 && Object.values(lists).every((n: any) => n === 1) && requests.length === 13);
    ck("R2. Shared tables (Session Occurrences, Sessions, Coaches) read ONCE for staffing + cover together", ["Session Occurrences", "Sessions", "Coaches"].every((t) => requests.filter((r) => r === t).length === 1));
    ck("R3. One cover pass per request", coverPassStats.passes - before === 1);
    ck("R4. Cover sources reuse the staffing table names exactly (so the engine shares them)", COVER_TABLES.occurrences === STAFFING_TABLES.occurrences && COVER_TABLES.sessions === STAFFING_TABLES.sessions && COVER_TABLES.coaches === STAFFING_TABLES.coaches && COVER_EVALUATOR.sources === COVER_SOURCES);

    world({ sessions: [S], occurrences: [O], dates: [coverDate(id("RdRd"), O.id)], moduleOn: false });
    const p2 = coverPassStats.passes;
    const off = (await run({ debug: true })).body;
    ck("G1. module_coaches OFF -> cover_open skipped (module_off), NO cover table read at all, no cover pass", coverCases(off).length === 0 && off.diagnostics.skipped.some((x: any) => x.ruleKey === "cover_open" && x.reason === "module_off") && !requests.includes("Staff Availability Requests") && !requests.includes("Cover Responses") && coverPassStats.passes === p2);
    const setOff = { id: id("SetCovOff"), fields: { Organisation: [ORG], Rule: [COVER_RULE.id] } };
    world({ sessions: [S], occurrences: [O], dates: [coverDate(id("RdRd"), O.id)], settings: [setOff] });
    const dis = (await run({ debug: true })).body;
    ck("G2. cover_open disabled by Settings -> no cover case, cover-only tables NOT read (staffing still runs on its own tables)", coverCases(dis).length === 0 && !requests.includes("Staff Availability Requests") && !requests.includes("Cover Responses") && dis.diagnostics.evaluated.length === 4);
    world({ sessions: [S], occurrences: [O], sessionStaff: [staff(S.id, C1, ROLE_COACH)], dates: [coverDate(id("RdRd"), O.id)] });
    const lk = await run({ caseKey: `cover_open|coverdate:${id("RdRd")}`, debug: true });
    ck("G3. caseKey lookup of cover_open evaluates only cover: finds the case, reads 5 config + 5 cover sources, staffing-only tables NOT read", lk.body.exists === true && requests.length === 10 && !requests.includes("Session Staff") && !requests.includes("Occurrence Staff") && !requests.includes("Coach Roles"));
  }

  // ===== Interaction with staffing rules (separate tasks, both resolve from source truth) =====
  {
    // The requester is an INACTIVE coach, so the occurrence has no valid staff AND a cover request is open.
    const S = session(id("SMix"), { rsc: 1, name: "Mix" });
    const O = occ(id("OMix"), S.id, 3 * D);
    const ssX = staff(S.id, CX, ROLE_COACH);
    const RD = coverDate(id("RdMix"), O.id, { requester: CX });
    world({ sessions: [S], occurrences: [O], sessionStaff: [ssX], dates: [RD], responses: [response(id("RespMix"), RD.id, C2, "Yes")] });
    const b = (await run()).body;
    ck("I1. Unstaffed occurrence + open cover -> BOTH session_no_coach and cover_open (neither suppresses the other)", keysForOcc(b, O.id).join(",") === "cover_open,session_no_coach");
    // Management selects C2: the workflow writes Occurrence Staff (Cover, source = requester's Session Staff row, requester's role) and marks the date Filled.
    const coverRow: AirtableRecord = { id: id("OSCovMix"), fields: { "Occurrence Staff ID": `COVER-${RD.id}`, "Session Occurrence": [O.id], Coach: [C2], "Assignment Type": "Cover", "Planned Role Snapshot": "Coach", Attendance: "Planned", "Session Staff Source": [ssX.id], "Management Confirmed": true } };
    const filled = { ...RD, fields: { ...RD.fields, "Cover Date Status": "Filled", "Replacement Coach": [C2], "Occurrence Staff": [coverRow.id] } };
    world({ sessions: [S], occurrences: [O], sessionStaff: [ssX], occurrenceStaff: [coverRow], dates: [filled], responses: [response(id("RespMix"), RD.id, C2, "Yes")] });
    const b2 = (await run()).body;
    ck("I2. After final selection: the Filled date AND the valid Cover Occurrence Staff row clear BOTH cases naturally", keysForOcc(b2, O.id).length === 0 && b2.cases.length === 0);
    const S2 = session(id("SMix2"), { rsc: 1 });
    const O2 = occ(id("OMix2"), S2.id, 3 * D);
    world({ sessions: [S2], occurrences: [O2], sessionStaff: [staff(S2.id, C1, ROLE_COACH)], dates: [coverDate(id("RdMix2"), O2.id)] });
    ck("I3. Validly staffed occurrence with an open cover request -> cover_open only (the requester still staffs it until cover is chosen)", keysForOcc((await run()).body, O2.id).join(",") === "cover_open");
    const setOff = { id: id("SetCovOff2"), fields: { Organisation: [ORG], Rule: [COVER_RULE.id] } };
    world({ sessions: [S], occurrences: [O], sessionStaff: [ssX], dates: [RD], settings: [setOff] });
    ck("I4. Disabling cover_open never changes the staffing result (session_no_coach still raised)", keysForOcc((await run()).body, O.id).join(",") === "session_no_coach");
  }

  // ===== Drift / reuse =====
  {
    const na = readFileSync(join(FUNCS, "needs-attention/cover.ts"), "utf8");
    const cw = readFileSync(join(FUNCS, "coach-cover/cover-workflow.ts"), "utf8");
    const block = na.slice(na.indexOf("DO NOT EDIT HERE =====\n") + 23, na.indexOf("// ===== END COPIED BLOCK ====="));
    const chunks = block.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
    const missing = chunks.filter((c) => !cw.includes(c));
    ck("CV1. The copied cover status block appears verbatim in coach-cover/cover-workflow.ts (one interpretation of cover statuses)", chunks.length >= 2 && missing.length === 0 && block.includes("deriveGroupStatus") && block.includes("COVER_DATE_STATUSES"), missing.map((m) => m.slice(0, 60)).join(" | "));
    const code = na.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("CV2. Needs Attention does NOT call coach-cover's unfilledSignal() (its own 24h legacy flag); severity is the catalogue model via the engine", !/unfilledSignal/.test(code) && /outstandingSince: a\.requestedAt/.test(code) && /event: a\.startIso/.test(code));
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const row = fixture.find((f) => f.ruleKey === "cover_open");
    ck("CV3. cover_open registered with the TEST catalogue's Rule ID (ATT-041), Active, module_coaches", COVER_EVALUATOR.ruleId === row?.ruleId && row?.evaluationStatus === "Active" && row?.requiredModule === "module_coaches" && IMPLEMENTED_EVALUATORS.includes(COVER_EVALUATOR));
    ck("CV4. The coach-cover function itself is unchanged by this slice (still exports unfilledSignal with its 24h rule)", /export function unfilledSignal/.test(cw) && /UNFILLED_ESCALATION_MS = DAY_MS/.test(cw));
    ck("CV5. Read-only: cover.ts contains no write path", !/method:\s*"(POST|PATCH|PUT|DELETE)"|fetch\(/.test(code));
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
