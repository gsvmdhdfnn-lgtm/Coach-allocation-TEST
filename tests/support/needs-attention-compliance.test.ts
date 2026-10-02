// Unit + integration tests for Needs Attention Slice 6 - the three
// compliance rules (see TEST-ENV.md "Needs Attention Foundation - Slice 6"):
// coach_compliance_expiry (ATT-011), compliance_verification_pending
// (ATT-042, "Compliance needs Management review") and
// non_compliant_coach_assigned (ATT-031). Request-level behaviour runs
// through the REAL orchestrator + the deployed registry against an
// in-memory Airtable that REJECTS every write except exception rows.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { localDateIso, staffingPassStats } from "./needs-attention-staffing.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import {
  ASSIGNMENT_SOURCES,
  COMPLIANCE_EVALUATORS,
  COMPLIANCE_SOURCES,
  COMPLIANCE_STATUSES,
  EXPIRY_STATE_SEVERITY,
  coachLevelRule,
  compliancePassStats,
  isBlockingStatus,
  reasonText,
  runCompliancePass,
} from "./needs-attention-compliance.ts";

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
const at = (ms: number, now = NOW) => new Date(now.getTime() + ms).toISOString();
const TZ = "Europe/London";
const TODAY = "2026-10-01";
const day = (n: number, from = TODAY) => {
  const [y, m, d] = from.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const ROLE_LEAD = id("RoleLead"), ROLE_COACH = id("RoleCoach"), ROLE_LEARN = id("RoleLearn");
const roles: AirtableRecord[] = [
  { id: ROLE_LEAD, fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true } },
  { id: ROLE_COACH, fields: { "Role Name": "Coach", "Role Key": "coach", Active: true } },
  { id: ROLE_LEARN, fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } },
];
const coach = (tag: string, name: string, active = true): AirtableRecord => ({ id: id(tag), fields: active ? { "Coach Name": name, Active: true } : { "Coach Name": name } });

// Requirements: Enhanced DBS (30 lead days, TWO rows - the key uses the lowest id) and First Aid (14).
const REQ_DBS_A = id("ReqDbsA"), REQ_DBS_B = id("ReqDbsB"), REQ_FA = id("ReqFirstAid");
const REQS: AirtableRecord[] = [
  { id: REQ_DBS_B, fields: { "Document Type": "Enhanced DBS", Required: true, Active: true, "Review Lead Days": 30 } },
  { id: REQ_DBS_A, fields: { "Document Type": "Enhanced DBS", Required: true, Active: true, "Review Lead Days": 30 } },
  { id: REQ_FA, fields: { "Document Type": "First Aid", Required: true, Active: true, "Review Lead Days": 14 } },
  { id: id("ReqOffIgn"), fields: { "Document Type": "School Induction", Required: true, Active: false } },
  { id: id("ReqOptIgn"), fields: { "Document Type": "Safeguarding Certificate", Active: true } },
];
const SECRET_URL = "https://secret.example.invalid/dbs-scan-8841.pdf";
const SECRET_FILE = "passport-and-dbs-8841.pdf";
function doc(tag: string, coachId: string, type: string, o: { issue?: string | null; expiry?: string | null; verified?: boolean | "half"; status?: string; active?: boolean; attachment?: boolean } = {}): AirtableRecord {
  const f: Record<string, any> = { "Document ID": `DOC-${tag}`, Coach: [coachId], "Document Type": type };
  if (o.active !== false) f.Active = true;
  if (o.issue !== null) f["Issue Date"] = o.issue ?? day(-100);
  if (o.expiry !== null) f["Expiry / Review Date"] = o.expiry ?? day(300);
  if (o.verified === true || o.verified === undefined) Object.assign(f, { "Verified By User ID": "u-mgmt", "Verified By Name Snapshot": "Morgan", "Verified At": "2026-09-01T09:00:00.000Z" });
  if (o.verified === "half") f["Verified By User ID"] = "u-mgmt";
  if (o.status) f.Status = o.status;
  if (o.attachment) f.Attachment = [{ id: "attX", url: SECRET_URL, filename: SECRET_FILE, size: 1234, type: "application/pdf" }];
  return { id: id(tag), fields: f };
}

function session(sid: string, name: string): AirtableRecord {
  return { id: sid, fields: { "Session Name": name, "Session Lifecycle Status": "Active" } };
}
function occ(oid: string, sid: string, startMs: number, o: { status?: string; now?: Date } = {}): AirtableRecord {
  const start = at(startMs, o.now);
  return { id: oid, fields: { "Occurrence Name": `Occ ${oid.slice(3, 9)}`, Status: o.status ?? "Scheduled", Session: [sid], Date: localDateIso(new Date(start), TZ), "Start Date & Time": start, "End Date & Time": at(startMs + H, o.now) } };
}
let ssN = 0;
function staff(sid: string, coachId: string, role: string, extra: Record<string, any> = {}): AirtableRecord {
  return { id: id("SS" + String(++ssN).padStart(3, "0")), fields: { Session: [sid], Coach: [coachId], Role: [role], Active: true, ...extra } };
}
function occStaff(tag: string, occId: string, coachId: string, extra: Record<string, any> = {}): AirtableRecord {
  return { id: id(tag), fields: { "Session Occurrence": [occId], Coach: [coachId], "Assignment Type": "Additional", "Planned Role Snapshot": "Coach", ...extra } };
}

function rule(key: string, ruleId: string, o: { sev?: string; warn?: [number, string]; urg?: [number, string]; sort: number; override?: boolean; locked?: string; area?: string; action?: string }): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": key, "Rule ID": ruleId, "Rule Key": key, Category: "Coaches", "Default Enabled": true, "Default Base Severity": o.sev ?? "Normal",
    "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": o.sort, Active: true,
    "Action Label": o.action ?? "Review Staffing", "Destination Area": o.area ?? "Schedule & Sessions",
  };
  if (o.override !== false) f["Supports Override"] = true;
  if (o.locked) f["Locked Minimum Severity"] = o.locked;
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: id("Rule" + ruleId.replace("-", "")), fields: f };
}
// The TEST catalogue's real values (staffing NA6.4, cover NA1.7, compliance NA1.8 / live rows recoah2OWYf03q2pJ, rec0vxRVy1m7W3EdI, recUZydYGcj82QbMK).
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1 }),
  rule("learning_coach_only", "ATT-002", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 2 }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5 }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13, action: "Assign Staff" }),
  rule("cover_open", "ATT-041", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sort: 41, area: "Coaches", action: "Resolve Cover" }),
  rule("coach_compliance_expiry", "ATT-011", { sev: "Warning", sort: 11, override: true, area: "Coaches", action: "Review Compliance" }),
  rule("compliance_verification_pending", "ATT-042", { sev: "Normal", sort: 42, override: false, area: "Coaches", action: "Review Compliance" }),
  rule("non_compliant_coach_assigned", "ATT-031", { sev: "Warning", urg: [48, "Hours Before"], locked: "Warning", sort: 31, override: false, area: "Coaches", action: "Review Compliance" }),
  // Slice 7 rules (real TEST values); with no availability rows they raise nothing here.
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
];
const ruleRec = (k: string) => RULES.find((r) => r.fields["Rule Key"] === k)!;

// ---------------------------------------------------------------------
// In-memory Airtable: GET lists; POST/PATCH allowed ONLY on the Exceptions table.
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: { method: string; table: string }[] = [];
let recN = 0;
const EXC = CONFIG_TABLES.exceptions;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const parts = new URL(url).pathname.split("/");
  const table = decodeURIComponent(parts[3]);
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

interface World { coaches: AirtableRecord[]; docs?: AirtableRecord[]; reqs?: AirtableRecord[]; sessions?: AirtableRecord[]; occurrences?: AirtableRecord[]; sessionStaff?: AirtableRecord[]; occurrenceStaff?: AirtableRecord[]; moduleOn?: boolean; settings?: AirtableRecord[]; exceptions?: AirtableRecord[] }
function world(o: World) {
  tables = {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: o.settings ?? [],
    [EXC]: o.exceptions ?? [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: o.moduleOn === false ? { "Feature Key": "module_coaches" } : { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: ORG, fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    "Sessions": o.sessions ?? [],
    "Session Occurrences": o.occurrences ?? [],
    "Session Staff": o.sessionStaff ?? [],
    "Occurrence Staff": o.occurrenceStaff ?? [],
    "Coach Roles": roles,
    "Coaches": o.coaches,
    "Staff Availability Requests": [],
    "Cover Responses": [],
    "Coach Documents": o.docs ?? [],
    "Coach Document Requirements": o.reqs ?? REQS,
    "Coach Availability": [],
    "Coach Availability Exceptions": [],
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
const kExp = (c: string, r: string) => `coach_compliance_expiry|coach:${c}|requirement:${r}`;
const kRev = (c: string, r: string) => `compliance_verification_pending|coach:${c}|requirement:${r}`;
const kAsg = (o: string, c: string) => `non_compliant_coach_assigned|occurrence:${o}|coach:${c}`;
const reads = () => requests.filter((r) => r.method === "GET").map((r) => r.table);

async function main() {
  // ===== Pure mapping: every resolved status goes to exactly one place =====
  {
    const item = (status: string, required = true) => ({ status, required } as any);
    ck("M1. Review Soon / Expired -> coach_compliance_expiry; Needs Review -> compliance_verification_pending; Current / Missing -> no coach-level rule", coachLevelRule(item("Review Soon")) === "coach_compliance_expiry" && coachLevelRule(item("Expired")) === "coach_compliance_expiry" && coachLevelRule(item("Needs Review")) === "compliance_verification_pending" && coachLevelRule(item("Current")) === null && coachLevelRule(item("Missing")) === null);
    ck("M2. A NOT-required item never raises a coach-level case, whatever its status", COMPLIANCE_STATUSES.every((s) => coachLevelRule(item(s, false)) === null));
    ck("M3. The domain's status list is exactly the five known statuses (no Rejected, no non-expiring state)", COMPLIANCE_STATUSES.join(",") === "Current,Review Soon,Needs Review,Expired,Missing");
    ck("M4. Assignment blocking set = Missing / Expired / Needs Review (Review Soon and Current do not block)", isBlockingStatus("Missing") && isBlockingStatus("Expired") && isBlockingStatus("Needs Review") && !isBlockingStatus("Review Soon") && !isBlockingStatus("Current"));
    ck("M5. Fixed state severities: Review Soon = Warning, Expired = Urgent (nothing else)", EXPIRY_STATE_SEVERITY["Review Soon"] === "Warning" && EXPIRY_STATE_SEVERITY.Expired === "Urgent" && Object.keys(EXPIRY_STATE_SEVERITY).length === 2);
    ck("M6. Every resolver reason has Management-facing wording (unknown codes fall back to the code, never crash)", ["no_active_record", "conflicting_active_records", "invalid_requirement_config", "malformed_dates", "issue_date_after_expiry", "incomplete_verification", "not_verified", "manual_review_flag", "missing_expiry_date"].every((r) => reasonText({ reason: r, record: null, conflictingRecordIds: ["a", "b"] }) !== r) && reasonText({ reason: "future_reason", record: null, conflictingRecordIds: [] }) === "future_reason");
  }

  // ===== Coach-level world: expiry / review soon / verification pending =====
  const CA = coach("CoachAlex", "Alex Soon"), CB = coach("CoachBea", "Bea Expired"), CC = coach("CoachCal", "Cal Missing"), CD = coach("CoachDee", "Dee Conflict");
  const CE = coach("CoachEve", "Eve Reasons"), CF = coach("CoachFin", "Fin Flags"), CG = coach("CoachGus", "Gus Current"), CX = coach("CoachInact", "Ivy Inactive", false);
  const COACHES = [CA, CB, CC, CD, CE, CF, CG, CX];
  const DOCS: AirtableRecord[] = [
    doc("DAlexDbs", CA.id, "Enhanced DBS", { expiry: day(200) }),
    doc("DAlexFa", CA.id, "First Aid", { expiry: day(10), attachment: true }), // Review Soon (10 <= 14)
    doc("DBeaDbs", CB.id, "Enhanced DBS", { expiry: day(-1), attachment: true }), // Expired yesterday
    doc("DBeaFa", CB.id, "First Aid", { verified: false }), // not_verified
    doc("DCalFa", CC.id, "First Aid", { expiry: day(0) }), // expires TODAY -> still valid, Review Soon; DBS Missing
    doc("DDeeDbs1", CD.id, "Enhanced DBS"), doc("DDeeDbs2", CD.id, "Enhanced DBS"), // conflicting_active_records
    doc("DDeeFa", CD.id, "First Aid", { expiry: day(15) }), // 15 > 14 -> Current
    doc("DEveDbs", CE.id, "Enhanced DBS", { verified: "half" }), // incomplete_verification
    doc("DEveFa", CE.id, "First Aid", { expiry: null }), // missing_expiry_date (verified, no expiry - never invented)
    doc("DFinDbs", CF.id, "Enhanced DBS", { status: "Needs Review" }), // manual_review_flag
    doc("DFinFa", CF.id, "First Aid", { issue: day(20), expiry: day(10) }), // issue_date_after_expiry
    doc("DGusDbs", CG.id, "Enhanced DBS", { expiry: day(31) }), // 31 > 30 -> Current
    doc("DGusFa", CG.id, "First Aid", { expiry: day(14) }), // exactly 14 -> Review Soon (inclusive)
    doc("DGusOld", CG.id, "Enhanced DBS", { expiry: day(-400), active: false }), // history - never current, never a case
    doc("DIvyDbs", CX.id, "Enhanced DBS", { expiry: day(-5) }), // inactive coach - no case
  ];
  const REQ_DBS = REQ_DBS_A < REQ_DBS_B ? REQ_DBS_A : REQ_DBS_B;
  {
    world({ coaches: COACHES, docs: DOCS });
    compliancePassStats.passes = 0;
    const res = await run({ debug: true });
    const b = res.body;
    const exp = byRule(b, "coach_compliance_expiry"), rev = byRule(b, "compliance_verification_pending");

    const aFa = find(b, kExp(CA.id, REQ_FA));
    ck("X1. Review Soon (expiry in 10 days, Review Lead Days 14) -> coach_compliance_expiry, Warning", aFa?.severity === "Warning" && aFa.context.complianceStatus === "Review Soon" && aFa.context.reviewReason === "within_review_lead_days" && aFa.context.daysUntilExpiry === 10);
    ck("X2. Review Soon severity comes only from base + fixed state (no thresholds, no second timing system on Review Lead Days)", aFa?.severityReason === "base Warning; state Warning");
    const bDbs = find(b, kExp(CB.id, REQ_DBS));
    ck("X3. Expired (expiry yesterday) -> coach_compliance_expiry, Urgent via fixed state severity", bDbs?.severity === "Urgent" && bDbs.context.complianceStatus === "Expired" && /state Urgent/.test(bDbs.severityReason) && bDbs.context.daysUntilExpiry === -1);
    const cFa = find(b, kExp(CC.id, REQ_FA));
    ck("X4. Expiry date = today is still valid (valid THROUGH the date): Review Soon, not Expired", cFa?.context.complianceStatus === "Review Soon" && cFa.severity === "Warning" && /today/.test(cFa.detail));
    ck("X5. Review Lead Days boundary inclusive: exactly 14 days -> Review Soon; 15 days (and DBS 31 > 30) -> nothing", !!find(b, kExp(CG.id, REQ_FA)) && !find(b, kExp(CD.id, REQ_FA)) && !find(b, kExp(CG.id, REQ_DBS)));
    ck("X6. Current items raise nothing in any rule (Alex's in-date DBS)", !b.cases.some((c: any) => c.targetIds.coachId === CA.id && c.targetIds.requirementId === REQ_DBS));
    ck("X7. Missing on a coach with no assignment raises NO case (no coach-level Missing rule - locked decision)", !b.cases.some((c: any) => c.targetIds.coachId === CC.id && c.targetIds.requirementId === REQ_DBS));
    ck("X8. Inactive coach: no case in any rule, even with an expired document", !b.cases.some((c: any) => c.targetIds.coachId === CX.id));
    ck("X9. Historical (inactive) document rows never raise a case (Gus's expired old DBS)", !b.cases.some((c: any) => c.targetIds.documentId === id("DGusOld")));
    ck("X10. Exactly the expected expiry cases: Alex FA, Bea DBS, Cal FA, Gus FA", exp.map((c: any) => c.caseKey).sort().join(",") === [kExp(CA.id, REQ_FA), kExp(CB.id, REQ_DBS), kExp(CC.id, REQ_FA), kExp(CG.id, REQ_FA)].sort().join(","));

    const rv = (c: AirtableRecord, r: string) => find(b, kRev(c.id, r));
    ck("V1. Submitted, not verified -> compliance_verification_pending, Normal, reason not_verified, verification not_verified", rv(CB, REQ_FA)?.severity === "Normal" && rv(CB, REQ_FA).context.reviewReason === "not_verified" && rv(CB, REQ_FA).context.verificationState === "not_verified" && /awaiting Management verification/.test(rv(CB, REQ_FA).detail));
    ck("V2. Two active records for one type -> compliance_verification_pending (conflicting_active_records): no single document, both listed", rv(CD, REQ_DBS)?.context.reviewReason === "conflicting_active_records" && rv(CD, REQ_DBS).context.documentId === null && rv(CD, REQ_DBS).relatedIds.conflictingDocumentIds.length === 2 && rv(CD, REQ_DBS).context.conflictingRecords === 2);
    ck("V3. Half-written verification -> compliance_verification_pending (incomplete_verification), verification incomplete", rv(CE, REQ_DBS)?.context.reviewReason === "incomplete_verification" && rv(CE, REQ_DBS).context.verificationState === "incomplete");
    ck("V4. Verified but no Expiry / Review Date -> compliance_verification_pending (missing_expiry_date) - no non-expiring semantics, no invented expiry", rv(CE, REQ_FA)?.context.reviewReason === "missing_expiry_date" && rv(CE, REQ_FA).context.expiryDate === null && rv(CE, REQ_FA).context.verificationState === "verified");
    ck("V5. Stored Status 'Needs Review' -> compliance_verification_pending (manual_review_flag)", rv(CF, REQ_DBS)?.context.reviewReason === "manual_review_flag");
    ck("V6. Issue Date after expiry -> compliance_verification_pending (issue_date_after_expiry)", rv(CF, REQ_FA)?.context.reviewReason === "issue_date_after_expiry");
    ck("V7. Missing document never raises compliance_verification_pending (nothing submitted)", !rv(CC, REQ_DBS));
    ck("V8. Exactly the expected review cases (6), each Normal, rule name 'Compliance needs Management review'", rev.length === 6 && rev.every((c: any) => c.severity === "Normal" && c.ruleName === "compliance_verification_pending" && c.ruleId === "ATT-042"));
    ck("V9. An item has one status, so never both coach-level rules for the same coach + requirement", b.cases.filter((c: any) => c.ruleKey !== "non_compliant_coach_assigned").every((c: any) => !b.cases.some((o: any) => o !== c && o.ruleKey !== c.ruleKey && o.ruleKey !== "non_compliant_coach_assigned" && o.targetIds.coachId === c.targetIds.coachId && o.targetIds.requirementId === c.targetIds.requirementId)));

    ck("I1. Case keys: coach_compliance_expiry|coach:<id>|requirement:<id> and compliance_verification_pending|coach:<id>|requirement:<id>", exp.every((c: any) => /^coach_compliance_expiry\|coach:rec\w{14}\|requirement:rec\w{14}$/.test(c.caseKey)) && rev.every((c: any) => /^compliance_verification_pending\|coach:rec\w{14}\|requirement:rec\w{14}$/.test(c.caseKey)));
    ck("I2. Two requirement rows for one type -> ONE case keyed on the lowest requirement id; both ids in relatedIds", bDbs?.targetIds.requirementId === REQ_DBS && bDbs.relatedIds.requirementIds.join(",") === [REQ_DBS_A, REQ_DBS_B].sort().join(",") && b.cases.filter((c: any) => c.targetIds.coachId === CB.id && c.ruleKey === "coach_compliance_expiry").length === 1);
    ck("I3. No duplicate case keys anywhere and no case_key_* config issues", new Set(b.cases.map((c: any) => c.caseKey)).size === b.cases.length && !b.configIssues.some((i: any) => /^case_key/.test(i.code)));

    const blob = JSON.stringify(b);
    ck("P1. No attachment data anywhere in the payload (no URL, filename, 'Attachment' or presence flag)", !blob.includes(SECRET_URL) && !blob.includes(SECRET_FILE) && !blob.includes("secret.example") && !/attachment/i.test(blob));
    ck("P2. Coach-level payload: coach, requirement, document, status, reason, dates, verification, action, destination, severity", aFa.targetIds.coachId === CA.id && aFa.targetIds.requirementId === REQ_FA && aFa.targetIds.documentId === id("DAlexFa") && aFa.context.coachName === "Alex Soon" && aFa.context.documentType === "First Aid" && aFa.context.expiryDate === day(10) && aFa.context.issueDate === day(-100) && aFa.context.verifiedAt === "2026-09-01T09:00:00.000Z" && aFa.actionLabel === "Review Compliance" && aFa.destination.area === "Coaches" && aFa.destination.route === "coaches/compliance" && aFa.destination.params.coachId === CA.id && aFa.context.complianceAsOf === TODAY);
    ck("P3. Context values are scalars only (no nested objects / arrays)", b.cases.every((c: any) => Object.values(c.context).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))));
    ck("R1. One request: each table listed once (19 lists: 5 config + 6 staffing + 2 cover + 2 compliance + 2 availability + 2 Slice 8), one compliance pass", Object.keys(b.diagnostics.reads.lists).length === 19 && Object.values(b.diagnostics.reads.lists).every((n: any) => n === 1) && reads().filter((t) => t === "Coach Documents").length === 1 && compliancePassStats.passes === 1);
    ck("R2. No config issues for clean data, queue complete", b.complete === true && b.configIssues.length === 0, JSON.stringify(b.configIssues));

    // Verification resolves the review case naturally (no "mark reviewed").
    const verify = (r: AirtableRecord) => ({ ...r, fields: { ...r.fields, "Verified By User ID": "u-mgmt", "Verified By Name Snapshot": "Morgan", "Verified At": "2026-10-01T09:30:00.000Z" } });
    world({ coaches: COACHES, docs: DOCS.map((d) => (d.id === id("DBeaFa") ? verify(d) : d)) });
    const after = (await run()).body;
    ck("V10. Management verifies Bea's First Aid -> its review case disappears on the next read (verified + in date = Current)", !find(after, kRev(CB.id, REQ_FA)) && after.cases.length === b.cases.length - 1);
    // A coach replacing a verified document (supersede): same key, new document id.
    const superseded = DOCS.map((d) => (d.id === id("DAlexFa") ? { ...d, fields: { ...d.fields, Active: undefined } } : d)).concat([doc("DAlexFa2", CA.id, "First Aid", { expiry: day(700), verified: false })]);
    world({ coaches: COACHES, docs: superseded });
    const sup = (await run()).body;
    ck("I4. Supersede (old verified row inactive, new unverified row active) -> expiry case gone, review case appears with a stable coach+requirement key (not a document key)", !find(sup, kExp(CA.id, REQ_FA)) && find(sup, kRev(CA.id, REQ_FA))?.targetIds.documentId === id("DAlexFa2"));
    world({ coaches: COACHES, docs: DOCS });
    const again = (await run({}, new Date(NOW.getTime() + 5 * 60000))).body;
    ck("I5. Re-evaluation is deterministic: identical case keys and order a few minutes later", again.cases.map((c: any) => c.caseKey).join(",") === b.cases.map((c: any) => c.caseKey).join(","));

    // Europe/London date, not UTC: 23:30Z on 1 Oct is 00:30 BST on 2 Oct.
    const late = new Date("2026-10-01T23:30:00.000Z");
    world({ coaches: [CC], docs: [doc("DCalFa", CC.id, "First Aid", { expiry: day(0) })] });
    const tz = (await run({}, late)).body;
    ck("X11. Compliance 'today' is the Europe/London date (00:30 BST on 2 Oct): a document expiring 1 Oct is Expired -> Urgent", find(tz, kExp(CC.id, REQ_FA))?.severity === "Urgent" && find(tz, kExp(CC.id, REQ_FA)).context.complianceAsOf === "2026-10-02");
  }

  // ===== Configuration issues (reported, never forced into a rule) =====
  {
    const badReqs = [...REQS.filter((r) => r.id !== REQ_FA), { id: REQ_FA, fields: { "Document Type": "First Aid", Required: true, Active: true, "Review Lead Days": 2.5 } }, { id: id("ReqSchool"), fields: { "Document Type": "School Induction", Required: true, Active: true, "Client / School": [id("School1")] } }];
    world({ coaches: [CA, CB], reqs: badReqs, docs: [...DOCS.filter((d) => [CA.id, CB.id].includes(d.fields.Coach[0])), doc("DAlexOdd", CA.id, "Passport")] });
    const b = (await run()).body;
    ck("CI1. Unusable requirement config -> configIssue compliance_requirement_invalid + review case (invalid_requirement_config) per affected coach", b.configIssues.some((i: any) => i.code === "compliance_requirement_invalid" && i.recordId === REQ_FA) && find(b, kRev(CA.id, REQ_FA))?.context.reviewReason === "invalid_requirement_config");
    ck("CI2. School-scoped requirement rows are reported (not evaluated), never widened into an org-wide requirement", b.configIssues.some((i: any) => i.code === "compliance_school_requirements_not_evaluated") && !b.cases.some((c: any) => c.context.documentType === "School Induction"));
    ck("CI3. Active document with an unrecognised type -> configIssue compliance_document_invalid, no case", b.configIssues.some((i: any) => i.code === "compliance_document_invalid" && i.recordId === id("DAlexOdd")) && !b.cases.some((c: any) => c.targetIds.documentId === id("DAlexOdd")));
    ck("CI4. Config issues never mark the queue incomplete; each reported once despite three compliance rules sharing the pass", b.complete === true && b.configIssues.filter((i: any) => i.code === "compliance_document_invalid").length === 1);
    world({ coaches: [CA, CB], reqs: badReqs, docs: DOCS.filter((d) => [CA.id, CB.id].includes(d.fields.Coach[0])), settings: [setting("non_compliant_coach_assigned", {})] });
    const solo = (await run()).body;
    ck("CI6. Coach-level rules report compliance config issues themselves (assignment rule disabled)", solo.configIssues.some((i: any) => i.code === "compliance_requirement_invalid" && i.recordId === REQ_FA) && byRule(solo, "non_compliant_coach_assigned").length === 0);
    world({ coaches: [CA], reqs: [], docs: DOCS.filter((d) => d.fields.Coach[0] === CA.id) });
    const none = (await run()).body;
    ck("CI5. No requirements configured -> no compliance cases at all (documents alone require nothing)", byRule(none, "coach_compliance_expiry").length === 0 && byRule(none, "compliance_verification_pending").length === 0);
  }

  // ===== Assignment rule: non_compliant_coach_assigned =====
  const S1 = session(id("SessAsg1"), "Assign One"), S2 = session(id("SessAsg2"), "Assign Two");
  const O3d = occ(id("OccAsg3d"), S1.id, 3 * D), O12d = occ(id("OccAsg12d"), S1.id, 12 * D), O48 = occ(id("OccAsg48"), S2.id, 48 * H), O48p = occ(id("OccAsg48p"), S2.id, 48 * H + 1);
  const O15 = occ(id("OccAsg15d"), S2.id, 15 * D), OCan = occ(id("OccAsgCan"), S2.id, 2 * D, { status: "Cancelled" }), OPast = occ(id("OccAsgPast"), S2.id, -H);
  const asgWorld = (extra: Partial<World> = {}) => world({
    coaches: COACHES, docs: DOCS, sessions: [S1, S2],
    occurrences: [O3d, O12d, O48, O48p, O15, OCan, OPast],
    sessionStaff: [
      staff(S1.id, CB.id, ROLE_LEAD), // Bea: DBS Expired + FA Needs Review -> blocked on every S1 occurrence
      staff(S1.id, CA.id, ROLE_COACH), // Alex: FA Review Soon today, EXPIRED by day 12
      staff(S2.id, CC.id, ROLE_COACH), // Cal: DBS Missing
      staff(S2.id, CX.id, ROLE_COACH), // Ivy: inactive -> excluded
      staff(S2.id, CG.id, ROLE_COACH, { "Effective Until": day(1) }), // Gus: ended before S2's dates -> not assigned
    ],
    ...extra,
  });
  {
    asgWorld();
    staffingPassStats.passes = 0; compliancePassStats.passes = 0;
    const b = (await run({ debug: true })).body;
    const asg = byRule(b, "non_compliant_coach_assigned");
    const bea3 = find(b, kAsg(O3d.id, CB.id));
    ck("A1. Assigned coach with Expired DBS + unverified First Aid -> ONE case for occurrence x coach listing both failing requirements", !!bea3 && bea3.context.failingRequirements === 2 && bea3.context.expired === 1 && bea3.context.needsReview === 1 && bea3.relatedIds.failingRequirementIds.sort().join(",") === [REQ_DBS, REQ_FA].sort().join(",") && /Enhanced DBS: Expired; First Aid: Needs Review|First Aid: Needs Review; Enhanced DBS: Expired/.test(bea3.detail));
    ck("A2. 3 days out -> Warning (catalogue base + locked minimum); Missing/Expired are NOT made Urgent outside 48h", bea3?.severity === "Warning" && !/state/.test(bea3.severityReason));
    ck("A3. Occurrence EXACTLY 48h away -> Urgent (inclusive, anchored on occurrence start); 48h + 1ms -> Warning", find(b, kAsg(O48.id, CC.id))?.severity === "Urgent" && /Urgent threshold reached \(48h before event\)/.test(find(b, kAsg(O48.id, CC.id)).severityReason) && find(b, kAsg(O48p.id, CC.id))?.severity === "Warning");
    ck("A4. Missing required document on an ASSIGNED coach -> assignment case (the only place Missing surfaces)", find(b, kAsg(O48.id, CC.id))?.context.missing === 1);
    ck("A5. Compliance is resolved as of the OCCURRENCE date (like coach-cover): Alex's First Aid (Review Soon today) blocks the day-12 session only", !find(b, kAsg(O3d.id, CA.id)) && find(b, kAsg(O12d.id, CA.id))?.context.expired === 1 && find(b, kAsg(O12d.id, CA.id)).context.complianceAsOf === O12d.fields.Date);
    ck("A6. Inactive coach on the roster -> excluded (no case)", !asg.some((c: any) => c.targetIds.coachId === CX.id));
    ck("A7. Session Staff effective dates respected: an assignment that ended before the date -> not assigned, no case", !asg.some((c: any) => c.targetIds.coachId === CG.id));
    ck("A8. Outside the 14-day window, Cancelled or already started -> no case", !asg.some((c: any) => [O15.id, OCan.id, OPast.id].includes(c.targetIds.occurrenceId)));
    ck("A9. Exactly the expected assignment cases: Bea x (3d, 12d), Alex x 12d, Cal x (48h, 48h+1ms)", asg.map((c: any) => c.caseKey).sort().join(",") === [kAsg(O3d.id, CB.id), kAsg(O12d.id, CB.id), kAsg(O12d.id, CA.id), kAsg(O48.id, CC.id), kAsg(O48p.id, CC.id)].sort().join(","));
    ck("A10. Payload: coach, role, session, occurrence, date/start, failing requirements + documents, action, destination; no attachment data", bea3.context.coachName === "Bea Expired" && bea3.context.coachRole === "Lead Coach" && bea3.context.sessionName === "Assign One" && bea3.context.occurrenceId === O3d.id && bea3.context.date === O3d.fields.Date && bea3.context.start === O3d.fields["Start Date & Time"] && bea3.relatedIds.failingDocumentIds.includes(id("DBeaDbs")) && bea3.targetIds.sessionId === S1.id && bea3.actionLabel === "Review Compliance" && bea3.destination.route === "coaches/compliance" && bea3.destination.params.occurrenceId === O3d.id && !JSON.stringify(bea3).includes("secret.example"));
    ck("I6. Assignment key = non_compliant_coach_assigned|occurrence:<id>|coach:<id> (one case per assignment, not per requirement)", asg.every((c: any) => /^non_compliant_coach_assigned\|occurrence:rec\w{14}\|coach:rec\w{14}$/.test(c.caseKey)));
    ck("O1. Overlap: Bea has an expiry case (DBS), a review case (First Aid) AND assignment cases - distinct keys coexist, no duplicates", !!find(b, kExp(CB.id, REQ_DBS)) && !!find(b, kRev(CB.id, REQ_FA)) && !!bea3 && new Set(b.cases.map((c: any) => c.caseKey)).size === b.cases.length);
    ck("O2. Staffing rules keep working alongside (S1 occurrences still evaluated by the staffing engine)", b.diagnostics.evaluated.some((e: any) => e.ruleKey === "no_lead_coach") && b.diagnostics.evaluated.some((e: any) => e.ruleKey === "non_compliant_coach_assigned"));
    ck("R3. Shared passes: ONE staffing pass and ONE compliance pass per request; every table listed once", staffingPassStats.passes === 1 && compliancePassStats.passes === 1 && Object.values(b.diagnostics.reads.lists).every((n: any) => n === 1) && Object.keys(b.diagnostics.reads.lists).length === 19);

    // Cover replacement: Bea covered by Gus (compliant) on the 3-day occurrence via Occurrence Staff.
    const beaRow = staff(S1.id, CB.id, ROLE_LEAD);
    asgWorld({ sessionStaff: [beaRow], occurrenceStaff: [occStaff("OSCover1", O3d.id, CG.id, { "Assignment Type": "Cover", "Session Staff Source": [beaRow.id], "Planned Role Snapshot": "Lead Coach" })] });
    const cov = (await run()).body;
    ck("A11. Cover replacement via Occurrence Staff: the covered (non-compliant) coach is off that occurrence -> no case; still flagged on her other date", !find(cov, kAsg(O3d.id, CB.id)) && !!find(cov, kAsg(O12d.id, CB.id)) && !find(cov, kAsg(O3d.id, CG.id)));
    // Added via Occurrence Staff only (not on Session Staff).
    asgWorld({ sessionStaff: [], occurrenceStaff: [occStaff("OSAdd1", O3d.id, CC.id)] });
    const add = (await run()).body;
    ck("A12. Coach added only via Occurrence Staff is assigned -> case (assignedVia Occurrence Staff)", find(add, kAsg(O3d.id, CC.id))?.context.assignedVia === "Occurrence Staff");
    // Absent Occurrence Staff row is not an assignment.
    asgWorld({ sessionStaff: [], occurrenceStaff: [occStaff("OSAbs1", O3d.id, CC.id, { Attendance: "Absent" })] });
    ck("A13. Occurrence Staff row marked Absent -> not assigned -> no case", byRule((await run()).body, "non_compliant_coach_assigned").length === 0);
    // Locked minimum survives a Settings attempt to lower it.
    asgWorld({ settings: [setting("non_compliant_coach_assigned", { Enabled: true, "Base Severity": "Normal" })] });
    const lk = (await run()).body;
    ck("A14. Settings base severity Normal cannot lower the locked minimum: still Warning (and Urgent within 48h)", find(lk, kAsg(O3d.id, CB.id))?.severity === "Warning" && /locked minimum Warning/.test(find(lk, kAsg(O3d.id, CB.id)).severityReason) && find(lk, kAsg(O48.id, CC.id))?.severity === "Urgent");
    // A fully compliant coach is never flagged.
    asgWorld({ sessionStaff: [staff(S1.id, CG.id, ROLE_LEAD)] });
    ck("A15. Compliant coach (only Review Soon, which does not block) assigned -> no assignment case", byRule((await run()).body, "non_compliant_coach_assigned").length === 0);
    // Active coach with an unrecognised role is still physically assigned.
    asgWorld({ sessionStaff: [staff(S1.id, CB.id, id("RoleGhost"))] });
    const ghost = (await run()).body;
    ck("A16. Active coach with an unrecognised role is still checked (case raised; the staffing configIssue is reported once)", !!find(ghost, kAsg(O3d.id, CB.id)) && ghost.configIssues.filter((i: any) => i.code === "staffing_role_unrecognised" && i.recordId === O3d.id).length === 1);
  }

  // ===== Module gating + Settings =====
  {
    asgWorld({ moduleOn: false });
    const off = (await run({ debug: true })).body;
    ck("G1. module_coaches off -> no compliance case and NO compliance / domain table read (config tables only)", off.cases.length === 0 && !reads().includes("Coach Documents") && !reads().includes("Coach Document Requirements") && reads().every((t) => Object.values(CONFIG_TABLES).includes(t as any)));
    const dis = (k: string) => setting(k, {});
    asgWorld({ settings: [dis("coach_compliance_expiry"), dis("compliance_verification_pending"), dis("non_compliant_coach_assigned")].map((s, i) => ({ ...s, id: id("SetDis" + i) })) });
    const d3 = (await run({ debug: true })).body;
    ck("G2. All three compliance rules disabled by Settings -> no compliance case, compliance tables NOT read (staffing still runs)", byRule(d3, "coach_compliance_expiry").length + byRule(d3, "compliance_verification_pending").length + byRule(d3, "non_compliant_coach_assigned").length === 0 && !reads().includes("Coach Documents") && !reads().includes("Coach Document Requirements") && reads().includes("Session Staff"));
    asgWorld({ settings: [dis("compliance_verification_pending")] });
    const d1 = (await run()).body;
    ck("G3. Only compliance_verification_pending disabled -> its cases vanish; expiry + assignment cases unaffected", byRule(d1, "compliance_verification_pending").length === 0 && byRule(d1, "coach_compliance_expiry").length > 0 && byRule(d1, "non_compliant_coach_assigned").length > 0);
    asgWorld();
    const lkp = (await run({ caseKey: kExp(CB.id, REQ_DBS) })).body;
    ck("G4. caseKey lookup of an expiry case evaluates only that rule: 5 config + 3 compliance tables, no staffing-only table", lkp.exists === true && reads().length === 8 && !reads().includes("Session Staff") && !reads().includes("Session Occurrences"));
  }

  // ===== Exceptions (Supports Override as configured in the catalogue) =====
  {
    asgWorld();
    const ok = await create({ caseKey: kExp(CB.id, REQ_DBS), reason: "Renewal submitted to DBS service; agreed interim" });
    const row = (tables[EXC] ?? [])[0];
    ck("E1. coach_compliance_expiry supports override: exception created (201), linked to the coach, case suppressed", ok.httpStatus === 201 && ok.body.case.suppressed === true && JSON.stringify(row?.fields.Coach) === JSON.stringify([CB.id]) && row?.fields["Case Key"] === kExp(CB.id, REQ_DBS));
    const after = (await run()).body;
    ck("E2. Suppressed expiry case leaves the active queue; the NON-overrideable assignment case for the same coach stays visible", !find(after, kExp(CB.id, REQ_DBS)) && after.summary.suppressed === 1 && !!find(after, kAsg(O3d.id, CB.id)));
    const n = (tables[EXC] ?? []).length;
    const rv = await create({ caseKey: kRev(CB.id, REQ_FA), reason: "try" });
    ck("E3. compliance_verification_pending does not support override -> 403 override_not_supported, nothing written", rv.httpStatus === 403 && rv.code === "override_not_supported" && (tables[EXC] ?? []).length === n);
    const as = await create({ caseKey: kAsg(O3d.id, CB.id), reason: "try" });
    ck("E4. non_compliant_coach_assigned does not support override -> 403 override_not_supported, nothing written", as.httpStatus === 403 && as.code === "override_not_supported" && (tables[EXC] ?? []).length === n);
    ck("E5. exceptionAllowed flag on cases mirrors the catalogue (011 yes, 042 / 031 no)", find(after, kExp(CC.id, REQ_FA))?.exceptionAllowed === true && find(after, kRev(CB.id, REQ_FA))?.exceptionAllowed === false && find(after, kAsg(O3d.id, CB.id))?.exceptionAllowed === false);
  }

  // ===== Pure pass + drift / boundaries =====
  {
    const pass = runCompliancePass({ "Coach Documents": DOCS, "Coach Document Requirements": REQS, Coaches: COACHES }, NOW);
    ck("U1. Pure pass: inactive coaches skipped, only REQUIRED items of active coaches, as of the London date", pass.skipped.inactive_coach === 1 && pass.activeCoachIds.length === 7 && pass.items.every((i) => i.item.required) && pass.asOfDate === TODAY && pass.items.length === 14);
    ck("U2. Sources: coach-level rules read Coach Documents / Coach Document Requirements / Coaches; the assignment rule adds the staffing tables", COMPLIANCE_SOURCES.join(",") === "Coach Documents,Coach Document Requirements,Coaches" && ASSIGNMENT_SOURCES.length === 8 && ASSIGNMENT_SOURCES.includes("Occurrence Staff"));

    const na = readFileSync(join(FUNCS, "needs-attention", "compliance.ts"), "utf8");
    const canon = readFileSync(join(FUNCS, "coach-compliance", "coach-compliance.ts"), "utf8");
    const coverCopy = readFileSync(join(FUNCS, "coach-cover", "coach-compliance.ts"), "utf8");
    const block = na.slice(na.indexOf("DO NOT EDIT HERE =====\n") + 23, na.indexOf("// ===== END COPIED BLOCK ====="));
    const chunks = block.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
    const missing = chunks.filter((c) => !canon.includes(c));
    ck("DR1. Every chunk of the copied compliance block appears verbatim in coach-compliance/coach-compliance.ts (one interpretation of compliance)", chunks.length >= 20 && missing.length === 0 && ["summarizeCompliance", "resolveDocumentType", "resolveRequirements", "readVerification", "ukToday"].every((f) => block.includes(`function ${f}(`)), missing.map((m) => m.slice(0, 60)).join(" | "));
    ck("DR2. ...and verbatim in coach-cover's copy (the cover suitability check resolves compliance identically)", chunks.every((c) => coverCopy.includes(c)));
    const cw = readFileSync(join(FUNCS, "coach-cover", "cover-workflow.ts"), "utf8");
    ck("DR3. Assignment blocking set is the exact line coach-cover's evaluateSuitability uses", cw.includes('const BLOCKING_COMPLIANCE = new Set(["Missing", "Expired", "Needs Review"]);') && na.includes('const BLOCKING_COMPLIANCE = new Set(["Missing", "Expired", "Needs Review"]);'));
    const code = na.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("DR4. compliance.ts is pure: no fetch, no Deno, no writes", !/fetch\(|Deno\.|method:/.test(code));
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const rowOf = (k: string) => fixture.find((r) => r.ruleKey === k);
    ck("DR5. The three registrations match the TEST catalogue Rule IDs (ATT-011 / ATT-042 / ATT-031), Active, module_coaches, and are in the deployed registry", COMPLIANCE_EVALUATORS.every((e) => rowOf(e.ruleKey)?.ruleId === e.ruleId && rowOf(e.ruleKey)?.evaluationStatus === "Active" && rowOf(e.ruleKey)?.requiredModule === "module_coaches" && IMPLEMENTED_EVALUATORS.includes(e)) && COMPLIANCE_EVALUATORS.length === 3);
    ck("SG1. Safeguarding boundary: safeguarding_action_open is still Planned and NOT registered", rowOf("safeguarding_action_open")?.evaluationStatus === "Planned" && !IMPLEMENTED_EVALUATORS.some((e) => e.ruleKey === "safeguarding_action_open"));
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
