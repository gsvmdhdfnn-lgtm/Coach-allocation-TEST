// Unit + integration tests for Needs Attention Slice 7 - assigned_coach_unavailable
// (ATT-014) and coach_schedule_conflict (ATT-012) (see TEST-ENV.md "Needs
// Attention Foundation - Slice 7"). Request-level behaviour runs through the
// REAL orchestrator + the deployed registry against an in-memory Airtable
// that rejects every write except exception rows.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { staffingPassStats } from "./needs-attention-staffing.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import {
  AVAILABILITY_TABLES,
  COACH_SCHEDULE_EVALUATORS,
  CONFLICT_SOURCES,
  UNAVAILABLE_SOURCES,
  availabilityPassStats,
  conflictPassStats,
  intervalsOverlap,
  occurrenceInterval,
  occurrenceWallClock,
  resolveAvailability,
} from "./needs-attention-coach-schedule.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");

// ---------------------------------------------------------------------
// Fixtures - NOW = Thu 1 Oct 2026 11:00 BST. Mon 5 Oct is the main day.
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = id("OrgTest1");
const NOW = new Date("2026-10-01T10:00:00.000Z");
const TZ = "Europe/London";
const MON = "2026-10-05", TUE = "2026-10-06";
/** UK wall-clock "HH:MM" on a BST date -> UTC ISO instant (BST = UTC+1 throughout these fixtures). */
const bst = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 1, m)).toISOString();
};

const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach"), ROLE_LEARN = id("RoleLearn");
const roles: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true } },
  { id: ROLE_LEARN, fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } },
];
const coach = (tag: string, name: string, active = true): AirtableRecord => ({ id: id(tag), fields: active ? { "Coach Name": name, Active: true } : { "Coach Name": name } });
const ALEX = coach("CoachAlex", "Alex Clash"), SAM = coach("CoachSam", "Sam Hours"), JO = coach("CoachJo", "Jo Override"), KIM = coach("CoachKim", "Kim Muddle"), IVY = coach("CoachIvy", "Ivy Inactive", false);
const COACHES = [ALEX, SAM, JO, KIM, IVY];

function session(sid: string, name: string, o: { lifecycle?: string } = {}): AirtableRecord {
  return { id: sid, fields: { "Session Name": name, "Session Lifecycle Status": o.lifecycle ?? "Active", "Required Staff Count": 1 } };
}
function occ(oid: string, sid: string, date: string, from: string | null, to: string | null, o: { status?: string; replacement?: string } = {}): AirtableRecord {
  const f: Record<string, any> = { "Occurrence Name": `Occ ${oid.slice(3, 10)}`, Status: o.status ?? "Scheduled", Session: [sid], Date: date };
  if (from) f["Start Date & Time"] = bst(date, from);
  if (to) f["End Date & Time"] = bst(date, to);
  if (o.replacement) f["Replacement Occurrence"] = [o.replacement];
  return { id: oid, fields: f };
}
let ssN = 0;
function staff(sid: string, coachId: string, role = ROLE_COACH, extra: Record<string, any> = {}): AirtableRecord {
  return { id: id("SS" + String(++ssN).padStart(3, "0")), fields: { Session: [sid], Coach: [coachId], Role: [role], Active: true, ...extra } };
}
function occStaff(tag: string, occId: string, coachId: string, extra: Record<string, any> = {}): AirtableRecord {
  return { id: id(tag), fields: { "Session Occurrence": [occId], Coach: [coachId], "Assignment Type": "Additional", "Planned Role Snapshot": "Coach", ...extra } };
}
function weekly(tag: string, coachId: string, day: string, o: { available?: boolean; from?: string; to?: string } = {}): AirtableRecord {
  const f: Record<string, any> = { Coach: [coachId], "Day of Week": day, Active: true };
  if (o.available !== false) f.Available = true;
  if (o.from) f["Start Time"] = o.from;
  if (o.to) f["End Time"] = o.to;
  return { id: id(tag), fields: f };
}
function dated(tag: string, coachId: string, type: string, date: string, o: { end?: string; from?: string; to?: string; active?: boolean } = {}): AirtableRecord {
  const f: Record<string, any> = { Coach: [coachId], "Availability Type": type, "Start Date": date };
  if (o.active !== false) f.Active = true;
  if (o.end) f["End Date"] = o.end;
  if (o.from) f["Start Time"] = o.from;
  if (o.to) f["End Time"] = o.to;
  return { id: id(tag), fields: f };
}

function rule(key: string, ruleId: string, o: { sev?: string; warn?: [number, string]; urg?: [number, string]; sort: number; override?: boolean; locked?: string; area?: string; action?: string }): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": key, "Rule ID": ruleId, "Rule Key": key, Category: "Staffing & Cover", "Default Enabled": true, "Default Base Severity": o.sev ?? "Normal",
    "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": o.sort, Active: true,
    "Action Label": o.action ?? "Review Staffing", "Destination Area": o.area ?? "Schedule & Sessions",
  };
  if (o.override !== false) f["Supports Override"] = true;
  if (o.locked) f["Locked Minimum Severity"] = o.locked;
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: id("Rule" + ruleId.replace("-", "")), fields: f };
}
// The TEST catalogue's real values (live rows recGSsP4HwYKP9aKY ATT-012, reckIH3YJVQ8f0uYn ATT-014).
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1 }),
  rule("learning_coach_only", "ATT-002", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 2 }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5 }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13, action: "Assign Staff" }),
  rule("cover_open", "ATT-041", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sort: 41, area: "Coaches", action: "Resolve Cover" }),
  rule("coach_compliance_expiry", "ATT-011", { sev: "Warning", sort: 11, area: "Coaches", action: "Review Compliance" }),
  rule("compliance_verification_pending", "ATT-042", { sev: "Normal", sort: 42, override: false, area: "Coaches", action: "Review Compliance" }),
  rule("non_compliant_coach_assigned", "ATT-031", { sev: "Warning", urg: [48, "Hours Before"], locked: "Warning", sort: 31, override: false, area: "Coaches", action: "Review Compliance" }),
  rule("coach_schedule_conflict", "ATT-012", { sev: "Warning", urg: [48, "Hours Before"], sort: 12, action: "Review Conflict" }),
  rule("assigned_coach_unavailable", "ATT-014", { sev: "Warning", urg: [48, "Hours Before"], sort: 14 }),
  // Slice 8 rules (real TEST values: rec00IKBwihcKHx2M, rechnmv1LKwdbKWBY, rec61LC0S5eige37U, recrHin89iSvwLDbw); no work summaries / allocations here, so they raise nothing.
  rule("coach_outcome_pending", "ATT-043", { warn: [48, "Hours Overdue"], sort: 43, override: false, area: "Coaches", action: "Record Coach Outcome" }),
  rule("work_summary_queried", "ATT-044", { warn: [3, "Days Overdue"], sort: 44, override: false, area: "Coaches", action: "Review Query" }),
  rule("work_summary_ready_to_finalise", "ATT-045", { warn: [3, "Days Overdue"], sort: 45, override: false, area: "Coaches", action: "Finalise Summary" }),
  rule("work_summary_blocked", "ATT-046", { warn: [3, "Days Overdue"], sort: 46, override: false, area: "Coaches", action: "Resolve Pending Items" }),
  // Finance F8a rule (real TEST values, live row recC80hmlglLibk7I): module_finance, Default Enabled off - it never runs here.
  { id: id("RuleATT047"), fields: { "Rule Name": "Invoice overdue", "Rule ID": "ATT-047", "Rule Key": "invoice_overdue", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 47, Active: true, "Action Label": "Review Receivable", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT048"), fields: { "Rule Name": "Invoice draft blocked", "Rule ID": "ATT-048", "Rule Key": "invoice_draft_blocked", Category: "Finance & Billing", "Default Base Severity": "Normal", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 48, Active: true, "Action Label": "Review Invoice Draft", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT049"), fields: { "Rule Name": "Outgoing payment due today", "Rule ID": "ATT-049", "Rule Key": "outgoing_payment_due_today", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 49, Active: true, "Action Label": "Review Outgoing Payment", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT050"), fields: { "Rule Name": "Outgoing payment overdue", "Rule ID": "ATT-050", "Rule Key": "outgoing_payment_overdue", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 50, Active: true, "Action Label": "Review Outgoing Payment", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT051"), fields: { "Rule Name": "Estimated cost due soon", "Rule ID": "ATT-051", "Rule Key": "outgoing_estimate_due_soon", Category: "Finance & Billing", "Default Base Severity": "Normal", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 51, Active: true, "Action Label": "Confirm Cost", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT052"), fields: { "Rule Name": "Amount still estimated", "Rule ID": "ATT-052", "Rule Key": "outgoing_estimate_due_today", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 52, Active: true, "Action Label": "Confirm Cost", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT053"), fields: { "Rule Name": "Estimate overdue", "Rule ID": "ATT-053", "Rule Key": "outgoing_estimate_overdue", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 53, Active: true, "Action Label": "Confirm Cost", "Destination Area": "Finance", "Supports Override": true } },
{ id: id("RuleATT054"), fields: { "Rule Name": "Projected cash below safety threshold", "Rule ID": "ATT-054", "Rule Key": "cash_balance_below_threshold", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 54, Active: true, "Action Label": "Review Cash Flow", "Destination Area": "Finance", "Supports Override": true } },
];
const ruleRec = (k: string) => RULES.find((r) => r.fields["Rule Key"] === k)!;

// ---------------------------------------------------------------------
// In-memory Airtable: GET lists; POST allowed ONLY on the Exceptions table.
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: { method: string; table: string }[] = [];
let recN = 0;
const EXC = CONFIG_TABLES.exceptions;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const table = decodeURIComponent(new URL(url).pathname.split("/")[3]);
  requests.push({ method, table });
  if (method === "GET") return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields, createdTime: r.createdTime })) }), { status: 200 });
  if (table !== EXC || method !== "POST") throw new Error(`Illegal write ${method} ${table}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const fields = Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== false && v !== null && v !== ""));
  const rec = { id: id("Exc" + String(++recN).padStart(4, "0")), fields, createdTime: NOW.toISOString() };
  tables[EXC] = [...(tables[EXC] ?? []), rec];
  return new Response(JSON.stringify(rec), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;
let tokN = 0;
const held = new Map<string, string>();
const fakeLock: LockClient = {
  async acquire(key) {
    if (held.has(key)) return null;
    const t = `${String(++tokN).padStart(8, "0")}-aaaa-4000-8000-000000000000`;
    held.set(key, t);
    return t;
  },
  async release(key, token) {
    if (held.get(key) !== token) return false;
    held.delete(key);
    return true;
  },
};

interface World { sessions?: AirtableRecord[]; occurrences?: AirtableRecord[]; sessionStaff?: AirtableRecord[]; occurrenceStaff?: AirtableRecord[]; weekly?: AirtableRecord[]; dated?: AirtableRecord[]; moduleOn?: boolean; settings?: AirtableRecord[] }
function world(o: World) {
  tables = {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: o.settings ?? [],
    [EXC]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: o.moduleOn === false ? { "Feature Key": "module_coaches" } : { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: ORG, fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    "Sessions": o.sessions ?? [],
    "Session Occurrences": o.occurrences ?? [],
    "Session Staff": o.sessionStaff ?? [],
    "Occurrence Staff": o.occurrenceStaff ?? [],
    "Coach Roles": roles,
    "Coaches": COACHES,
    "Staff Availability Requests": [],
    "Cover Responses": [],
    "Coach Documents": [],
    "Coach Document Requirements": [],
    [AVAILABILITY_TABLES.recurring]: o.weekly ?? [],
    [AVAILABILITY_TABLES.exceptions]: o.dated ?? [],
    "Coach Work Summaries": [],
    "Coach Allocations": [],
  };
  requests = [];
}
function setting(ruleKey: string, f: Record<string, any>): AirtableRecord {
  return { id: id("Set" + ruleKey.replace(/_/g, "").slice(0, 8)), fields: { "Setting ID": `NAS-${ruleKey}`, Organisation: [ORG], Rule: [ruleRec(ruleKey).id], ...f } };
}
const MGMT: Caller = { userId: "user-mgmt-1", role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Morgan Manager", email: "manager@test.invalid" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS, lock: fakeLock };
const run = (query: any = {}, now = NOW) => getCases(deps, MGMT, query, now) as Promise<any>;
const create = (body: any, now = NOW) => createException(deps, MGMT, body, now, { maxAttempts: 3, retryDelayMs: 1 }) as Promise<any>;
const byRule = (b: any, k: string) => b.cases.filter((c: any) => c.ruleKey === k);
const find = (b: any, key: string) => b.cases.find((c: any) => c.caseKey === key);
const kUn = (o: string, c: string) => `assigned_coach_unavailable|occurrence:${o}|coach:${c}`;
const kCf = (c: string, a: string, b: string) => `coach_schedule_conflict|coach:${c}|occurrence:${a < b ? a : b}|occurrence:${a < b ? b : a}`;
const reads = () => requests.filter((r) => r.method === "GET").map((r) => r.table);

// Main Monday world.
const S1 = session(id("SessJun"), "Mon Juniors"), S2 = session(id("SessSen"), "Mon Seniors"), S3 = session(id("SessOth"), "Mon Other"), S4 = session(id("SessKim"), "Kim Session");
const OA = occ(id("OccAAAA"), S1.id, MON, "16:00", "17:00");
const OB = occ(id("OccBBBB"), S2.id, MON, "16:45", "17:45");
const OC = occ(id("OccCCCC"), S3.id, MON, "17:00", "18:00"); // back-to-back with OA
const OD = occ(id("OccDDDD"), S3.id, TUE, "16:00", "17:00");
const OK = occ(id("OccKKKK"), S4.id, MON, "10:00", "11:00");
const ALEX_S1 = staff(S1.id, ALEX.id, ROLE_LEAD);
const SS_MAIN = [
  ALEX_S1, staff(S2.id, ALEX.id, ROLE_COACH), // Alex: OA + OB overlap
  staff(S1.id, JO.id), staff(S3.id, JO.id), // Jo: OA + OC back-to-back, OD Tuesday
  staff(S2.id, SAM.id), // Sam: OB only
  staff(S2.id, IVY.id), // Ivy: inactive
  staff(S4.id, KIM.id), // Kim: OK only
];
const AV_MAIN = {
  weekly: [
    weekly("WAlexMon", ALEX.id, "Monday", { from: "15:00", to: "19:00" }),
    weekly("WJoMonNo", JO.id, "Monday", { available: false }), // Jo recurring NOT available Monday...
    weekly("WSamMon", SAM.id, "Monday", { from: "17:00", to: "19:00" }), // Sam's hours start at 17:00
    weekly("WIvyMonNo", IVY.id, "Monday", { available: false }),
  ],
  dated: [
    dated("DAlexOff", ALEX.id, "Unavailable", MON), // ...Alex recurring Available but dated whole-day Unavailable
    dated("DJoOn", JO.id, "Available All Day", MON), // ...Jo overridden by a dated Available All Day
    dated("DKimOff", KIM.id, "Unavailable", MON), // Kim: contradictory exceptions -> ambiguous
    dated("DKimOn", KIM.id, "Available All Day", MON),
  ],
};
const mainWorld = (extra: Partial<World> = {}) => world({ sessions: [S1, S2, S3, S4], occurrences: [OA, OB, OC, OD, OK], sessionStaff: SS_MAIN, ...AV_MAIN, ...extra });

async function main() {
  // ===== Pure: resolver precedence (the copied block), wall clock, overlap =====
  {
    const q = (date: string, s: string, e: string, c = ALEX.id) => ({ coachId: c, date, startTime: s, endTime: e });
    const w = [weekly("PWMon", ALEX.id, "Monday", { from: "15:00", to: "19:00" })];
    ck("AV1. Recurring Available + dated Unavailable exception -> unavailable (exception wins)", resolveAvailability(q(MON, "16:00", "17:00"), w, [dated("PDOff", ALEX.id, "Unavailable", MON)]).status === "unavailable");
    ck("AV2. Recurring Unavailable + dated Available All Day -> available", resolveAvailability(q(MON, "16:00", "17:00"), [weekly("PWNo", ALEX.id, "Monday", { available: false })], [dated("PDOn", ALEX.id, "Available All Day", MON)]).status === "available");
    ck("AV3. No usable availability fact for that day -> unknown", resolveAvailability(q(TUE, "16:00", "17:00"), w, []).status === "unknown");
    ck("AV4. Contradictory dated facts -> ambiguous; malformed -> ambiguous", resolveAvailability(q(MON, "16:00", "17:00"), w, [dated("PX1", ALEX.id, "Unavailable", MON), dated("PX2", ALEX.id, "Available All Day", MON)]).status === "ambiguous" && resolveAvailability(q(MON, "16:00", "17:00"), [weekly("PBad", ALEX.id, "Monday", { from: "9", to: "x" })], []).status === "ambiguous");
    ck("AV5. Work partly outside the supplied hours -> unavailable (outside_recurring_windows); a timed Unavailable elsewhere in the day does not block", resolveAvailability(q(MON, "18:30", "19:30"), w, []).reason === "outside_recurring_windows" && resolveAvailability(q(MON, "16:00", "17:00"), w, [dated("PDent", ALEX.id, "Unavailable", MON, { from: "10:00", to: "11:00" })]).status === "available");
    const wc = occurrenceWallClock(bst(MON, "16:00"), bst(MON, "17:00"));
    ck("WC1. Occurrence instants -> Europe/London wall clock (BST): 15:00Z = 16:00", wc?.date === MON && wc.startTime === "16:00" && wc.endTime === "17:00");
    ck("WC2. Missing / reversed / cross-midnight times -> not evaluable (null), never invented", occurrenceWallClock(null, bst(MON, "17:00")) === null && occurrenceWallClock(bst(MON, "17:00"), bst(MON, "16:00")) === null && occurrenceWallClock(bst(MON, "23:00"), bst(TUE, "01:00")) === null);
    ck("OV1. Half-open overlap: 16:00-17:00 vs 16:45-17:45 overlaps; vs 17:00-18:00 (back-to-back) does not; containment overlaps; disjoint does not", intervalsOverlap(16, 17, 16.75, 17.75) && !intervalsOverlap(16, 17, 17, 18) && intervalsOverlap(16, 18, 16.5, 17) && !intervalsOverlap(10, 11, 16, 17));
    ck("OV2. occurrenceInterval refuses missing / zero-length / reversed times", occurrenceInterval(null, bst(MON, "17:00")) === null && occurrenceInterval(bst(MON, "17:00"), bst(MON, "17:00")) === null && occurrenceInterval(bst(MON, "18:00"), bst(MON, "17:00")) === null && !!occurrenceInterval(bst(MON, "16:00"), bst(MON, "17:00")));
  }

  // ===== Main world: availability + conflicts together =====
  {
    mainWorld();
    staffingPassStats.passes = 0; availabilityPassStats.passes = 0; conflictPassStats.passes = 0;
    const b = (await run({ debug: true })).body;
    const un = byRule(b, "assigned_coach_unavailable"), cf = byRule(b, "coach_schedule_conflict");
    ck("U1. Recurring Available + dated Unavailable -> case for Alex on BOTH his Monday occurrences (exception_unavailable)", find(b, kUn(OA.id, ALEX.id))?.context.availabilityReason === "exception_unavailable" && !!find(b, kUn(OB.id, ALEX.id)));
    ck("U2. Work outside the hours the coach supplied -> case (Sam 16:45-17:45 vs 17:00-19:00: outside_recurring_windows)", find(b, kUn(OB.id, SAM.id))?.context.availabilityReason === "outside_recurring_windows" && find(b, kUn(OB.id, SAM.id)).context.availabilitySource === "recurring");
    ck("U3. Recurring Unavailable + dated Available All Day -> available -> no case (Jo on OA and OC)", !find(b, kUn(OA.id, JO.id)) && !find(b, kUn(OC.id, JO.id)));
    ck("U4. Unknown (nothing supplied for Tuesday) -> no case (Jo on OD)", !find(b, kUn(OD.id, JO.id)));
    ck("U5. Ambiguous (contradictory dated facts) -> NO case, surfaced as config issue availability_ambiguous", !find(b, kUn(OK.id, KIM.id)) && b.configIssues.some((i: any) => i.code === "availability_ambiguous" && i.recordId === OK.id && /Coach Availability Exceptions/.test(i.detail)));
    ck("U6. Inactive coach explicitly unavailable -> no case", !un.some((c: any) => c.targetIds.coachId === IVY.id));
    ck("U7. Exactly the expected unavailable cases: Alex x OA, Alex x OB, Sam x OB", un.map((c: any) => c.caseKey).sort().join(",") === [kUn(OA.id, ALEX.id), kUn(OB.id, ALEX.id), kUn(OB.id, SAM.id)].sort().join(","));
    const u = find(b, kUn(OA.id, ALEX.id));
    ck("U8. Payload: coach, role, session/occurrence, date/start/end, availability state/reason/source/record, requested window, action, destination", u.context.coachName === "Alex Clash" && u.context.coachRole === "Lead Coach" && u.context.sessionName === "Mon Juniors" && u.context.occurrenceId === OA.id && u.context.date === MON && u.context.start === OA.fields["Start Date & Time"] && u.context.end === OA.fields["End Date & Time"] && u.context.availabilityStatus === "unavailable" && u.context.availabilityRecordId === id("DAlexOff") && u.context.requestedWindow === "16:00-17:00" && u.actionLabel === "Review Staffing" && u.destination.area === "Schedule & Sessions" && u.destination.route === "schedule/occurrence-staffing" && u.destination.params.coachId === ALEX.id);
    ck("U9. Severity: base Warning, 4+ days out -> Warning (no state escalation)", un.every((c: any) => c.severity === "Warning" && c.severityReason === "base Warning"));

    const c = find(b, kCf(ALEX.id, OA.id, OB.id));
    ck("C1. True overlap (16:00-17:00 vs 16:45-17:45), same coach on both -> ONE conflict case", !!c && cf.filter((x: any) => x.context.coachId === ALEX.id).length === 1);
    ck("C2. Back-to-back (Jo OA 16:00-17:00 then OC 17:00-18:00) -> no conflict", !cf.some((x: any) => x.context.coachId === JO.id));
    ck("C3. Different coaches on overlapping occurrences (Sam only on OB, Jo on OA) -> no conflict for them", !cf.some((x: any) => x.context.coachId === SAM.id));
    ck("C4. Key = coach + occurrence ids sorted ascending; exactly one conflict case overall", c?.caseKey === `coach_schedule_conflict|coach:${ALEX.id}|occurrence:${[OA.id, OB.id].sort()[0]}|occurrence:${[OA.id, OB.id].sort()[1]}` && cf.length === 1);
    ck("C5. Payload: both occurrences, sessions, times, roles, overlap window 16:45-17:00 (15 min), anchor = earlier start", c.context.sessionNameA && c.context.sessionNameB && [c.context.roleA, c.context.roleB].sort().join(",") === "Coach,Lead Coach" && c.context.overlapMinutes === 15 && c.context.overlapStart === bst(MON, "16:45") && c.context.overlapEnd === bst(MON, "17:00") && c.anchorTime === OA.fields["Start Date & Time"] && /16:45-17:00 \(15 min\)/.test(c.detail) && c.actionLabel === "Review Conflict" && c.destination.route === "coaches/schedule-conflict");
    ck("I1. Interaction: Alex has BOTH unavailable cases AND the conflict case - neither suppresses the other", !!c && !!find(b, kUn(OA.id, ALEX.id)) && !!find(b, kUn(OB.id, ALEX.id)));
    ck("R1. Reads: 19 lists, each once (+ Coach Availability, Coach Availability Exceptions, + Slice 8 Coach Work Summaries, Coach Allocations); one staffing, one availability, one conflict pass", Object.keys(b.diagnostics.reads.lists).length === 19 && Object.values(b.diagnostics.reads.lists).every((n: any) => n === 1) && staffingPassStats.passes === 1 && availabilityPassStats.passes === 1 && conflictPassStats.passes === 1);
    ck("R2. Queue complete; the only config issue is Kim's ambiguous availability", b.complete === true && b.configIssues.length === 1 && b.configIssues[0].code === "availability_ambiguous", JSON.stringify(b.configIssues));
    ck("P1. No player data or availability internals beyond ids / reason codes in the payload", !/player/i.test(JSON.stringify(b.cases.filter((x: any) => x.ruleKey === "assigned_coach_unavailable" || x.ruleKey === "coach_schedule_conflict"))));

    // Dated exception flipped to Available -> the unavailable cases disappear; conflict stays.
    mainWorld({ dated: AV_MAIN.dated.map((d) => (d.id === id("DAlexOff") ? { ...d, fields: { ...d.fields, "Availability Type": "Available All Day" } } : d)) });
    const flip = (await run()).body;
    ck("U10. Change Alex's dated exception to Available All Day -> both his unavailable cases disappear; his conflict remains", !find(flip, kUn(OA.id, ALEX.id)) && !find(flip, kUn(OB.id, ALEX.id)) && !!find(flip, kCf(ALEX.id, OA.id, OB.id)));
    // Inactive exception row is ignored.
    mainWorld({ dated: AV_MAIN.dated.map((d) => (d.id === id("DAlexOff") ? { ...d, fields: { ...d.fields, Active: undefined } } : d)) });
    ck("U11. An inactive (Active off) exception row is ignored -> recurring Available applies -> no Alex case", !find((await run()).body, kUn(OA.id, ALEX.id)));

    // Identity is independent of source row order.
    world({ sessions: [S4, S3, S2, S1], occurrences: [OK, OD, OC, OB, OA], sessionStaff: [...SS_MAIN].reverse(), weekly: [...AV_MAIN.weekly].reverse(), dated: [...AV_MAIN.dated].reverse() });
    const rev = (await run()).body;
    const keys = (x: any) => x.cases.filter((c: any) => c.ruleKey === "coach_schedule_conflict" || c.ruleKey === "assigned_coach_unavailable").map((c: any) => c.caseKey).sort().join(",");
    ck("K1. Deterministic identity: reversing every source table's order yields the same case keys (no mirror A/B vs B/A)", keys(rev) === keys(b));
  }

  // ===== Occurrence Staff (dated staffing) =====
  {
    const coverSam = occStaff("OSCoverA", OA.id, SAM.id, { "Assignment Type": "Cover", "Session Staff Source": [ALEX_S1.id], "Planned Role Snapshot": "Lead Coach" });
    mainWorld({ occurrenceStaff: [coverSam] });
    const b = (await run()).body;
    ck("O1. Cover replacement on OA (Sam replaces Alex): no unavailable case against Alex for OA; Sam evaluated instead (outside his hours)", !find(b, kUn(OA.id, ALEX.id)) && !!find(b, kUn(OB.id, ALEX.id)) && find(b, kUn(OA.id, SAM.id))?.context.assignedVia === "Occurrence Staff");
    ck("O2. The replacement removes Alex's conflict and creates Sam's (OA + OB)", !find(b, kCf(ALEX.id, OA.id, OB.id)) && !!find(b, kCf(SAM.id, OA.id, OB.id)));
    mainWorld({ occurrenceStaff: [occStaff("OSAddB", OB.id, JO.id)] });
    const b2 = (await run()).body;
    ck("O3. Occurrence Staff addition creates conflicts: Jo added to OB now clashes with her OA and her OC (but OA/OC stay back-to-back, no case)", !!find(b2, kCf(JO.id, OA.id, OB.id)) && !!find(b2, kCf(JO.id, OB.id, OC.id)) && !find(b2, kCf(JO.id, OA.id, OC.id)));
    mainWorld({ occurrenceStaff: [occStaff("OSAbsB", OB.id, JO.id, { Attendance: "Absent" })] });
    ck("O4. An Absent Occurrence Staff row is not an assignment (shared resolver rule) -> no conflict for Jo on OB", !byRule((await run()).body, "coach_schedule_conflict").some((x: any) => x.context.coachId === JO.id));
  }

  // ===== Eligibility (Slice 3 filter applies to BOTH occurrences) =====
  {
    const SX = session(id("SessX"), "Extra"), SD = session(id("SessDraft"), "Draft Session", { lifecycle: "Draft" });
    const OXc = occ(id("OccXCan"), SX.id, MON, "16:30", "17:30", { status: "Cancelled" });
    const OXp = occ(id("OccXPost"), SX.id, MON, "16:30", "17:30", { status: "Postponed" });
    const OXr = occ(id("OccXRepl"), SX.id, MON, "16:30", "17:30", { replacement: id("OccElse") });
    const OXd = occ(id("OccXDraft"), SD.id, MON, "16:30", "17:30");
    const OFar = occ(id("OccFar"), SX.id, "2026-10-20", "16:00", "17:00");
    const OFar2 = occ(id("OccFar2"), SD.id, "2026-10-20", "16:30", "17:30");
    world({
      sessions: [S1, SX, SD], occurrences: [OA, OXc, OXp, OXr, OXd, OFar, OFar2],
      sessionStaff: [staff(S1.id, ALEX.id), staff(SX.id, ALEX.id), staff(SD.id, ALEX.id)],
      dated: [dated("DAlexFar", ALEX.id, "Unavailable", "2026-10-20")],
    });
    const b = (await run()).body;
    ck("E1. Cancelled / Postponed / superseded / inactive-session occurrences overlapping OA -> no conflict (both must be eligible)", byRule(b, "coach_schedule_conflict").length === 0);
    ck("E2. Out-of-window (20 days) occurrence with an Unavailable exception -> no unavailable case", byRule(b, "assigned_coach_unavailable").length === 0);
  }

  // ===== Triple overlap: unique deterministic pairs =====
  {
    const T1 = session(id("SessT1"), "T1"), T2 = session(id("SessT2"), "T2"), T3 = session(id("SessT3"), "T3");
    const P = occ(id("OccPPPP"), T1.id, MON, "16:00", "17:00"), Q = occ(id("OccQQQQ"), T2.id, MON, "16:30", "17:30"), Rr = occ(id("OccRRRR"), T3.id, MON, "16:45", "18:00");
    world({ sessions: [T1, T2, T3], occurrences: [Rr, P, Q], sessionStaff: [staff(T1.id, ALEX.id), staff(T2.id, ALEX.id), staff(T3.id, ALEX.id)] });
    const b = (await run()).body;
    const cf = byRule(b, "coach_schedule_conflict").map((c: any) => c.caseKey).sort();
    ck("T1. Triple overlap -> exactly the 3 unique pairs (P/Q, P/R, Q/R), no duplicates, no collapse", cf.join(",") === [kCf(ALEX.id, P.id, Q.id), kCf(ALEX.id, P.id, Rr.id), kCf(ALEX.id, Q.id, Rr.id)].sort().join(",") && new Set(cf).size === 3);
  }

  // ===== Key order is by record id, not by start time =====
  {
    const TZs = session(id("SessZ"), "Z"), TYs = session(id("SessY"), "Y");
    const Z = occ(id("OccZZZZ"), TZs.id, MON, "16:00", "17:00"), Y = occ(id("OccYYYY"), TYs.id, MON, "16:30", "17:30");
    world({ sessions: [TZs, TYs], occurrences: [Z, Y], sessionStaff: [staff(TZs.id, ALEX.id), staff(TYs.id, ALEX.id)] });
    const c = byRule((await run()).body, "coach_schedule_conflict");
    ck("K2. Pair key orders occurrence ids ascending even when the lower id starts LATER (…|occurrence:Y|occurrence:Z); anchor still the earlier start", c.length === 1 && c[0].caseKey === `coach_schedule_conflict|coach:${ALEX.id}|occurrence:${Y.id}|occurrence:${Z.id}` && c[0].anchorTime === Z.fields["Start Date & Time"]);
  }

  // ===== Untimed occurrences: never invent timing =====
  {
    const OU = occ(id("OccUntim"), S2.id, MON, null, null);
    world({ sessions: [S1, S2], occurrences: [OA, OU], sessionStaff: [staff(S1.id, ALEX.id), staff(S2.id, ALEX.id)], dated: [dated("DAlexOffU", ALEX.id, "Unavailable", MON)] });
    const b = (await run()).body;
    ck("N1. Untimed occurrence: no conflict and no unavailable case for it; config issues conflict_not_evaluable + availability_not_evaluable", byRule(b, "coach_schedule_conflict").length === 0 && !find(b, kUn(OU.id, ALEX.id)) && !!find(b, kUn(OA.id, ALEX.id)) && b.configIssues.some((i: any) => i.code === "conflict_not_evaluable" && i.recordId === OU.id) && b.configIssues.some((i: any) => i.code === "availability_not_evaluable" && i.recordId === OU.id));
  }

  // ===== Severity: Urgent within 48h of the (earlier) occurrence =====
  {
    const FRI = "2026-10-02";
    const F1 = occ(id("OccF1111"), S1.id, FRI, "09:00", "10:00"), F2 = occ(id("OccF2222"), S2.id, FRI, "09:30", "10:30");
    world({ sessions: [S1, S2], occurrences: [F1, F2], sessionStaff: [staff(S1.id, ALEX.id), staff(S2.id, ALEX.id)], dated: [dated("DAlexFri", ALEX.id, "Unavailable", FRI)] });
    const b = (await run()).body;
    ck("V1. Within 48h: unavailable and conflict cases escalate to Urgent via the catalogue threshold (anchored on the occurrence / earlier start)", find(b, kUn(F1.id, ALEX.id))?.severity === "Urgent" && /Urgent threshold reached \(48h before event\)/.test(find(b, kUn(F1.id, ALEX.id)).severityReason) && find(b, kCf(ALEX.id, F1.id, F2.id))?.severity === "Urgent");
    const exact = new Date(Date.parse(F1.fields["Start Date & Time"]) - 48 * 3600 * 1000);
    const just = new Date(exact.getTime() - 1);
    ck("V2. Exactly 48h before -> Urgent (inclusive); 48h + 1ms -> Warning", find((await run({}, exact)).body, kUn(F1.id, ALEX.id))?.severity === "Urgent" && find((await run({}, just)).body, kUn(F1.id, ALEX.id))?.severity === "Warning");
  }

  // ===== Staffing unaffected =====
  {
    const S5 = session(id("SessEmpty"), "Only Inactive Staff"), O5 = occ(id("OccEEEE"), S5.id, MON, "12:00", "13:00");
    const staffingWorld = (extra: Partial<World> = {}) => mainWorld({ sessions: [S1, S2, S3, S4, S5], occurrences: [OA, OB, OC, OD, OK, O5], sessionStaff: [...SS_MAIN, staff(S5.id, IVY.id)], ...extra });
    staffingWorld();
    const on = (await run()).body;
    staffingWorld({ settings: [setting("assigned_coach_unavailable", {}), { ...setting("coach_schedule_conflict", {}), id: id("SetCfOff") }] });
    const off = (await run()).body;
    const staffingKeys = (x: any) => x.cases.filter((c: any) => ["session_no_coach", "no_lead_coach", "learning_coach_only", "session_understaffed"].includes(c.ruleKey)).map((c: any) => `${c.caseKey}/${c.severity}`).sort().join(",");
    ck("S1. Staffing cases are identical with the Slice 7 rules on or off (Ivy still ignored for staffing, not for anything new)", staffingKeys(on) === staffingKeys(off) && staffingKeys(on).length > 0);
  }

  // ===== Gating =====
  {
    mainWorld({ moduleOn: false });
    const off = (await run({ debug: true })).body;
    ck("G1. module_coaches off -> no case and NO availability / domain table read (config tables only)", off.cases.length === 0 && reads().every((t) => Object.values(CONFIG_TABLES).includes(t as any)));
    mainWorld({ settings: [setting("assigned_coach_unavailable", {})] });
    const d = (await run()).body;
    ck("G2. assigned_coach_unavailable disabled -> availability tables NOT read; conflicts still evaluated", !reads().includes("Coach Availability") && !reads().includes("Coach Availability Exceptions") && byRule(d, "coach_schedule_conflict").length === 1 && byRule(d, "assigned_coach_unavailable").length === 0);
    mainWorld();
    const lk = (await run({ caseKey: kCf(ALEX.id, OA.id, OB.id) })).body;
    ck("G3. caseKey lookup of a conflict case reads 5 config + 6 staffing tables only (no availability tables)", lk.exists === true && reads().length === 11 && !reads().includes("Coach Availability"));
    ck("G4. Sources: ATT-014 = staffing + 2 availability tables; ATT-012 = staffing only", UNAVAILABLE_SOURCES.length === 8 && UNAVAILABLE_SOURCES.includes("Coach Availability Exceptions") && CONFLICT_SOURCES.length === 6 && !CONFLICT_SOURCES.includes("Coach Availability"));
  }

  // ===== Exceptions (both rules support override in the catalogue) =====
  {
    mainWorld();
    const ok = await create({ caseKey: kCf(ALEX.id, OA.id, OB.id), reason: "Alex splits the session with the assistant; agreed" });
    ck("X1. Exact-case exception on a conflict -> 201, suppressed; Coach + Session Occurrence links server-derived", ok.httpStatus === 201 && ok.body.case.suppressed === true && JSON.stringify(tables[EXC][0].fields.Coach) === JSON.stringify([ALEX.id]));
    const after = (await run()).body;
    ck("X2. Suppressed conflict leaves the queue; Alex's unavailable cases stay (different case identity)", !find(after, kCf(ALEX.id, OA.id, OB.id)) && after.summary.suppressed === 1 && !!find(after, kUn(OA.id, ALEX.id)));
    const u = await create({ caseKey: kUn(OB.id, SAM.id), reason: "Sam confirmed he can arrive early this once" });
    ck("X3. Exact-case exception on an unavailable case -> 201 (Supports Override = Yes)", u.httpStatus === 201 && !find((await run()).body, kUn(OB.id, SAM.id)));
    mainWorld({ settings: [{ ...setting("coach_schedule_conflict", { Enabled: true }), id: id("SetNoOv") }] });
    const no = await create({ caseKey: kCf(ALEX.id, OA.id, OB.id), reason: "x" });
    ck("X4. Organisation Allow Override off -> 403 override_disabled_by_settings", no.httpStatus === 403 && no.code === "override_disabled_by_settings");
  }

  // ===== Drift / purity =====
  {
    const na = readFileSync(join(FUNCS, "needs-attention", "coach-schedule.ts"), "utf8");
    const canon = readFileSync(join(FUNCS, "coach-availability", "coach-availability.ts"), "utf8");
    const coverCopy = readFileSync(join(FUNCS, "coach-cover", "coach-availability.ts"), "utf8");
    const block = na.slice(na.indexOf("DO NOT EDIT HERE =====\n") + 23, na.indexOf("// ===== END COPIED BLOCK ====="));
    const chunks = block.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
    const missing = chunks.filter((c) => !canon.includes(c));
    ck("DR1. Every chunk of the copied availability block appears verbatim in coach-availability/coach-availability.ts", chunks.length >= 15 && missing.length === 0 && ["resolveAvailability", "interpretRecurring", "interpretException", "ukWallClockFromInstant", "windowsOverlap"].every((f) => block.includes(`function ${f}(`)), missing.map((m) => m.slice(0, 60)).join(" | "));
    ck("DR2. ...and verbatim in coach-cover's copy (cover suitability resolves availability identically)", chunks.every((c) => coverCopy.includes(c)));
    const cs = readFileSync(join(FUNCS, "coach-cover", "staffing.ts"), "utf8");
    ck("DR3. Conflict overlap rule is coach-cover's half-open rule", cs.includes("o.startMs < target.endMs && target.startMs < o.endMs") && na.includes("return aStart < bEnd && bStart < aEnd;"));
    const code = na.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("DR4. coach-schedule.ts is pure: no fetch, no Deno, no writes", !/fetch\(|Deno\.|method:/.test(code));
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const rowOf = (k: string) => fixture.find((r) => r.ruleKey === k);
    ck("DR5. Registrations match the TEST catalogue (ATT-014 / ATT-012), Active, module_coaches, and are deployed", COACH_SCHEDULE_EVALUATORS.length === 2 && COACH_SCHEDULE_EVALUATORS.every((e) => rowOf(e.ruleKey)?.ruleId === e.ruleId && rowOf(e.ruleKey)?.evaluationStatus === "Active" && rowOf(e.ruleKey)?.requiredModule === "module_coaches" && IMPLEMENTED_EVALUATORS.includes(e)));
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
