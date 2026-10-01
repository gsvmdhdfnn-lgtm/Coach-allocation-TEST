/**
 * Needs Attention Foundation - Slice 9 freeze tests (see TEST-ENV.md "Needs
 * Attention Foundation - FINAL (Slice 9)"). Cross-family checks that the
 * per-slice suites cannot make on their own:
 *
 *   CAT  the REAL TEST catalogue (needs-attention-catalogue.snapshot.json)
 *        against the code-side registry, flags and anchors;
 *   COV  one busy organisation in which all 14 active rules fire at once;
 *   CON  the frozen v1 response / case contract;
 *   ID   case identity: deterministic, label-free, order- and rename-proof;
 *   PRE  precedence and intentional coexistence across rule families;
 *   G    module / Settings gating and "gated off = not read";
 *   SEC  organisation isolation and role checks;
 *   EXC  exact-case exceptions across every family;
 *   PERF reads and shared passes at a synthetic busy-organisation scale.
 *
 * Everything runs through the real orchestrator against an in-memory
 * Airtable (GET for every table; POST / PATCH only on Needs Attention
 * Exceptions - any other write throws).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCaseKey, type AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, revokeException, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { staffingPassStats } from "./needs-attention-staffing.ts";
import { coverPassStats } from "./needs-attention-cover.ts";
import { compliancePassStats } from "./needs-attention-compliance.ts";
import { availabilityPassStats, conflictPassStats } from "./needs-attention-coach-schedule.ts";
import { coachOutcomePassStats, workSummaryPassStats } from "./needs-attention-work-summaries.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";

const R: [string, string][] = [];
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name]);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra ? `  -- ${extra}` : ""}`);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.snapshot.json"), "utf8"));
const OLD_FIXTURE = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8"));
const RULES: AirtableRecord[] = SNAPSHOT.records;
const ruleRow = (k: string) => RULES.find((r) => r.fields["Rule Key"] === k)!;

const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = id("OrgTestA");
const ORG_B = id("OrgTestB");
const NOW = new Date("2026-10-01T10:00:00.000Z"); // Thu 1 Oct 2026, 11:00 BST
const H = 3600 * 1000;
const TZ = "Europe/London";

// ---------------------------------------------------------------------
// The busy organisation: every active rule fires at least once.
// ---------------------------------------------------------------------
const ROLE_LEAD = { id: id("RoleLead"), fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true } };
const ROLE_COACH = { id: id("RoleCoach"), fields: { "Role Name": "Coach", "Role Key": "coach", Active: true } };
const ROLE_LEARN = { id: id("RoleLearn"), fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } };
const coach = (tag: string, name: string) => ({ id: id(tag), fields: { "Coach Name": name, "Coach ID": `C-${tag}`, Active: true } as Record<string, any> });
const LC = coach("CoachLara", "Lara Lead"), C1 = coach("CoachCody", "Cody Coach"), L1 = coach("CoachLily", "Lily Learner"), L2 = coach("CoachLeo", "Leo Learner");
const session = (tag: string, name: string, f: Record<string, any> = {}) => ({ id: id(tag), fields: { "Session Name": name, "Session Lifecycle Status": "Active", ...f } as Record<string, any> });
const S1 = session("SessEmpty", "Empty Session"), S2 = session("SessLead", "Lead Needed", { "Requires Lead Coach": true }), S3 = session("SessLearn", "Learning Only");
const S4 = session("SessShort", "Short Staffed", { "Requires Lead Coach": true, "Required Staff Count": 3 }), S5 = session("SessCover", "Covered Session", { "Requires Lead Coach": true, "Required Staff Count": 1 });
const S6 = session("SessClash", "Clash Session"), S7 = session("SessPast", "Past Session");
const occ = (tag: string, s: any, date: string, startZ: string, endZ: string, status = "Scheduled") => ({
  id: id(tag),
  fields: { "Occurrence Name": `${s.fields["Session Name"]} ${date}`, Date: date, "Start Date & Time": `${date}T${startZ}:00.000Z`, "End Date & Time": `${date}T${endZ}:00.000Z`, Status: status, Session: [s.id] } as Record<string, any>,
});
const O1 = occ("OccEmpty", S1, "2026-10-03", "16:00", "17:00"), O2 = occ("OccLead", S2, "2026-10-04", "16:00", "17:00"), O3 = occ("OccLearn", S3, "2026-10-05", "16:00", "17:00");
const O4 = occ("OccShort", S4, "2026-10-03", "09:00", "10:00"), O5 = occ("OccCover", S5, "2026-10-06", "16:00", "17:00"), O6 = occ("OccClash", S6, "2026-10-03", "09:30", "10:30");
const O7 = occ("OccPast", S7, "2026-09-20", "16:00", "17:00", "Cancelled");
const staff = (tag: string, s: any, c: any, role: any) => ({ id: id(tag), fields: { Session: [s.id], Coach: [c.id], Role: [role.id], Active: true } });
const SESSION_STAFF = [staff("SsLead", S2, L1, ROLE_LEARN), staff("SsLearn", S3, L2, ROLE_LEARN), staff("SsShort", S4, C1, ROLE_COACH), staff("SsCover", S5, LC, ROLE_LEAD), staff("SsClash", S6, C1, ROLE_COACH)];
const COVER_DATE = { id: id("CoverDate1"), createdTime: "2026-09-28T10:00:00.000Z", fields: { "Cover Date Status": "Open", "Session Occurrence": [O5.id], Coach: [LC.id], "Request ID": "CR-0001" } };
const REQ_DBS = { id: id("ReqDbs"), fields: { Active: true, Required: true, "Document Type": "Enhanced DBS", "Review Lead Days": 30 } };
const verified = { "Verified By User ID": "user-mgmt-1", "Verified At": "2026-01-01T00:00:00.000Z" };
const doc = (tag: string, c: any, f: Record<string, any>) => ({ id: id(tag), fields: { Coach: [c.id], "Document Type": "Enhanced DBS", Active: true, "Issue Date": "2025-01-01", ...f } });
const DOCS = [
  doc("DocLara", LC, { "Expiry / Review Date": "2027-06-01", ...verified }),
  doc("DocLeo", L2, { "Expiry / Review Date": "2027-06-01", ...verified }),
  doc("DocCody", C1, { "Expiry / Review Date": "2026-09-01", ...verified }), // Expired
  doc("DocLily", L1, { "Expiry / Review Date": "2027-06-01" }), // not verified -> Needs Review
];
const AVAIL = [{ id: id("AvCodySat"), fields: { Coach: [C1.id], "Day of Week": "Saturday", Active: true } }]; // Available unticked, no times = unavailable all day
const ALLOC = { id: id("AllocLara"), fields: { "Allocation ID": "AL-0001", Coach: [LC.id], "Session Occurrence": [O7.id], "Cost Status": "Confirmed", "Final Coach Cost": 30 } };
const WS = (tag: string, c: any, start: string, end: string, status: string, f: Record<string, any> = {}) => ({ id: id(tag), fields: { "Work Summary ID": `WS-${tag}`, Coach: [c.id], "Period Start": start, "Period End": end, Status: status, Active: true, ...f } });
const WQ = WS("SumQuery", C1, "2026-08-01", "2026-08-07", "Queried", { "Queried At": "2026-09-27T09:00:00.000Z", "Query / Reopen Note": "Hours look wrong" });
const WR = WS("SumReady", L2, "2026-08-01", "2026-08-07", "Needs review");
const WB = WS("SumBlock", LC, "2026-09-01", "2026-09-30", "Not ready");

const ORG_ROW = (rid: string, orgId: string) => ({ id: rid, fields: { "Organisation ID": orgId, Active: true, Timezone: TZ, "Organisation Name": `Org ${orgId}` } });

function busyTables(): Record<string, AirtableRecord[]> {
  return {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: [],
    [CONFIG_TABLES.exceptions]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: { "Feature Key": "module_coaches", Enabled: true } }, { id: id("FeatSched"), fields: { "Feature Key": "module_schedule", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [ORG_ROW(ORG, "ORG-TEST-001")],
    Sessions: [S1, S2, S3, S4, S5, S6, S7],
    "Session Occurrences": [O1, O2, O3, O4, O5, O6, O7],
    "Session Staff": SESSION_STAFF,
    "Occurrence Staff": [],
    "Coach Roles": [ROLE_LEAD, ROLE_COACH, ROLE_LEARN],
    Coaches: [LC, C1, L1, L2],
    "Staff Availability Requests": [COVER_DATE],
    "Cover Responses": [],
    "Coach Documents": DOCS,
    "Coach Document Requirements": [REQ_DBS],
    "Coach Availability": AVAIL,
    "Coach Availability Exceptions": [],
    "Coach Work Summaries": [WQ, WR, WB],
    "Coach Allocations": [ALLOC],
    // Present in the base but never a Needs Attention source.
    "Occurrence Financial Outcomes": [{ id: id("OfoX"), fields: { "Session Occurrence": [O7.id] } }],
    "Work Summary Lines": [],
    Players: [{ id: id("PlayerX"), fields: { Name: "Pat Player" } }],
  };
}

// ---------------------------------------------------------------------
// In-memory Airtable. Writes allowed ONLY on Needs Attention Exceptions.
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
  if (method === "GET") return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields, createdTime: r.createdTime ?? "2026-09-01T00:00:00.000Z" })) }), { status: 200 });
  if (table !== EXC || (method !== "POST" && method !== "PATCH")) throw new Error(`Illegal write ${method} ${table}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const clean = (f: Record<string, any>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== false && v !== null && v !== ""));
  if (method === "POST") {
    const rec = { id: id("Exc" + String(++recN).padStart(4, "0")), fields: clean(body.fields), createdTime: NOW.toISOString() };
    tables[EXC] = [...(tables[EXC] ?? []), rec];
    return new Response(JSON.stringify(rec), { status: 200 });
  }
  const recId = parts[4];
  const row = (tables[EXC] ?? []).find((r) => r.id === recId);
  if (!row) return new Response("{}", { status: 404 });
  row.fields = clean({ ...row.fields, ...body.fields });
  return new Response(JSON.stringify(row), { status: 200 });
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

const MGMT: Caller = { userId: "user-mgmt-1", role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Morgan Manager", email: "manager@test.invalid" };
const MGMT_B: Caller = { ...MGMT, userId: "user-mgmt-b", organisationId: "ORG-TEST-002", email: "manager.b@test.invalid" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "secret-token-value" }, registry: IMPLEMENTED_EVALUATORS, lock: fakeLock };
const run = async (query: any = {}, now = NOW, caller = MGMT): Promise<any> => { const o: any = await getCases(deps, caller, query, now); return o.status === "ok" ? o.body : o; };
const create = (body: any, now = NOW, caller = MGMT) => createException(deps, caller, body, now, { maxAttempts: 3, retryDelayMs: 1 }) as Promise<any>;
const revoke = (body: any, now = NOW, caller = MGMT) => revokeException(deps, caller, body, now, { maxAttempts: 3, retryDelayMs: 1 }) as Promise<any>;
const reads = () => requests.filter((r) => r.method === "GET").map((r) => r.table);
const writes = () => requests.filter((r) => r.method !== "GET");
const setting = (ruleKey: string, f: Record<string, any>, org = ORG) => ({ id: id("Set" + ruleKey.replace(/_/g, "").slice(0, 9)), fields: { "Setting ID": `NAS-${ruleKey}`, Organisation: [org], Rule: [ruleRow(ruleKey).id], ...f } });
const reset = (mut?: (t: Record<string, AirtableRecord[]>) => void) => {
  tables = busyTables();
  mut?.(tables);
  requests = [];
};
const byRule = (b: any, k: string) => b.cases.filter((c: any) => c.ruleKey === k);
const keysOf = (b: any) => b.cases.map((c: any) => c.caseKey);
const sorted = (a: string[]) => [...a].sort();
const sameSet = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const ACTIVE_RULES = [
  "no_lead_coach", "learning_coach_only", "session_understaffed", "session_no_coach", "coach_compliance_expiry", "coach_schedule_conflict", "assigned_coach_unavailable",
  "non_compliant_coach_assigned", "cover_open", "compliance_verification_pending", "coach_outcome_pending", "work_summary_queried", "work_summary_ready_to_finalise", "work_summary_blocked",
];
/** Finance F8a: the one Finance rule with a live evaluator (module_finance; Default Enabled off; never runs in this world - no module_finance row). */
const FINANCE_ACTIVE_RULES = ["invoice_overdue", "invoice_draft_blocked"];
const ALL_ACTIVE_RULES = [...ACTIVE_RULES, ...FINANCE_ACTIVE_RULES];
const OVERRIDEABLE = new Set(["no_lead_coach", "learning_coach_only", "session_understaffed", "session_no_coach", "coach_compliance_expiry", "coach_schedule_conflict", "assigned_coach_unavailable"]);
const EXPECTED_COUNTS: Record<string, number> = {
  session_no_coach: 1, no_lead_coach: 2, learning_coach_only: 1, session_understaffed: 1, cover_open: 1, coach_compliance_expiry: 1, compliance_verification_pending: 1,
  non_compliant_coach_assigned: 3, assigned_coach_unavailable: 2, coach_schedule_conflict: 1, coach_outcome_pending: 1, work_summary_queried: 1, work_summary_ready_to_finalise: 1, work_summary_blocked: 1,
};
const ROUTES: Record<string, string> = {
  session_no_coach: "schedule/occurrence-staffing", no_lead_coach: "schedule/occurrence-staffing", learning_coach_only: "schedule/occurrence-staffing", session_understaffed: "schedule/occurrence-staffing",
  assigned_coach_unavailable: "schedule/occurrence-staffing", coach_schedule_conflict: "coaches/schedule-conflict", cover_open: "coaches/cover-request-date",
  coach_compliance_expiry: "coaches/compliance", compliance_verification_pending: "coaches/compliance", non_compliant_coach_assigned: "coaches/compliance",
  coach_outcome_pending: "coaches/occurrence-financial-outcome", work_summary_queried: "coaches/work-summary", work_summary_ready_to_finalise: "coaches/work-summary", work_summary_blocked: "coaches/work-summary",
};
const KEY_SHAPES: Record<string, RegExp> = {
  session_no_coach: /^session_no_coach\|occurrence:rec\w{14}$/,
  no_lead_coach: /^no_lead_coach\|occurrence:rec\w{14}$/,
  learning_coach_only: /^learning_coach_only\|occurrence:rec\w{14}$/,
  session_understaffed: /^session_understaffed\|occurrence:rec\w{14}$/,
  cover_open: /^cover_open\|coverdate:rec\w{14}$/,
  coach_compliance_expiry: /^coach_compliance_expiry\|coach:rec\w{14}\|requirement:rec\w{14}$/,
  compliance_verification_pending: /^compliance_verification_pending\|coach:rec\w{14}\|requirement:rec\w{14}$/,
  non_compliant_coach_assigned: /^non_compliant_coach_assigned\|occurrence:rec\w{14}\|coach:rec\w{14}$/,
  assigned_coach_unavailable: /^assigned_coach_unavailable\|occurrence:rec\w{14}\|coach:rec\w{14}$/,
  coach_schedule_conflict: /^coach_schedule_conflict\|coach:rec\w{14}\|occurrence:rec\w{14}\|occurrence:rec\w{14}$/,
  coach_outcome_pending: /^coach_outcome_pending\|occurrence:rec\w{14}\|coach:rec\w{14}$/,
  work_summary_queried: /^work_summary_queried\|summary:rec\w{14}$/,
  work_summary_ready_to_finalise: /^work_summary_ready_to_finalise\|summary:rec\w{14}$/,
  work_summary_blocked: /^work_summary_blocked\|summary:rec\w{14}$/,
};
const CASE_FIELDS = ["caseKey", "ruleId", "ruleKey", "ruleName", "category", "module", "severity", "severityReason", "title", "detail", "actionLabel", "destination", "targetIds", "relatedIds", "context", "anchorTime", "exceptionAllowed"];
const EXCLUSIVE_SOURCES: [string, string[], string[]][] = [
  ["cover", ["cover_open"], ["Staff Availability Requests", "Cover Responses"]],
  ["compliance", ["coach_compliance_expiry", "compliance_verification_pending", "non_compliant_coach_assigned"], ["Coach Documents", "Coach Document Requirements"]],
  ["availability", ["assigned_coach_unavailable"], ["Coach Availability", "Coach Availability Exceptions"]],
  ["work summaries + coach outcome", ["coach_outcome_pending", "work_summary_queried", "work_summary_ready_to_finalise", "work_summary_blocked"], ["Coach Work Summaries", "Coach Allocations"]],
];

async function main() {
  // ===================================================================
  // CAT - the real TEST catalogue against the code
  // ===================================================================
  {
    const rows = RULES.map((r) => r.fields);
    const reg = new Map(IMPLEMENTED_EVALUATORS.map((e) => [e.ruleKey, e]));
    ck("CAT1. Snapshot = the live TEST catalogue: 40 rows (F8a + ATT-047 / ATT-048), unique Rule Keys and Rule IDs", rows.length === 40 && new Set(rows.map((f) => f["Rule Key"])).size === 40 && new Set(rows.map((f) => f["Rule ID"])).size === 40);
    const oldOk = OLD_FIXTURE.rules.every((o: any) => {
      const f = rows.find((x) => x["Rule Key"] === o.ruleKey);
      return f && f["Rule ID"] === o.ruleId && f["Evaluation Status"] === o.evaluationStatus && f["Required Module"] === o.requiredModule && !!f["Default Enabled"] === o.defaultEnabled && !!f.Active === o.active;
    });
    ck("CAT2. The older 6-field catalogue fixture used by the per-slice suites agrees with the full snapshot", oldOk && OLD_FIXTURE.rules.length === 40);
    const activeStatus = rows.filter((f) => f["Evaluation Status"] === "Active").map((f) => f["Rule Key"]);
    ck("CAT3. Registry = exactly the 14 frozen active rules + the F8a invoice_overdue + F8b invoice_draft_blocked rules, each Rule ID matching its catalogue row", IMPLEMENTED_EVALUATORS.length === 16 && sameSet([...reg.keys()], ALL_ACTIVE_RULES) && IMPLEMENTED_EVALUATORS.every((e) => ruleRow(e.ruleKey).fields["Rule ID"] === e.ruleId));
    ck("CAT4. Active means a live evaluator exists: the 16 Evaluation Status = Active rows are exactly the 16 registered evaluators (no Active row lacks one)", activeStatus.length === 16 && sameSet(activeStatus, [...reg.keys()]) && activeStatus.every((k) => reg.has(k)));
    ck("CAT5. No Planned / Retired row has an evaluator (24 Planned rows stay dormant)", rows.filter((f) => f["Evaluation Status"] !== "Active").every((f) => !reg.has(f["Rule Key"])) && rows.filter((f) => f["Evaluation Status"] === "Planned").length === 24 && rows.filter((f) => f["Evaluation Status"] === "Retired").length === 0 && reg.has("invoice_draft_blocked"));
    const vm = ruleRow("venue_missing").fields;
    ck("CAT13. venue_missing (ATT-018) is Planned (deferred to the Venue foundation), unregistered, and otherwise unchanged (module_schedule, Normal, 7 Days / 48 Hours Before, overrideable)", vm["Evaluation Status"] === "Planned" && !reg.has("venue_missing") && vm["Rule ID"] === "ATT-018" && vm["Required Module"] === "module_schedule" && vm["Default Base Severity"] === "Normal" && vm["Default Warning Threshold"] === 7 && vm["Default Warning Timing"] === "Days Before" && vm["Default Urgent Threshold"] === 48 && vm["Default Urgent Timing"] === "Hours Before" && vm["Supports Override"] === true);
    ck("CAT6. Every registered rule: Active, Default Enabled, module_coaches, Destination Area set, Action Label set", ACTIVE_RULES.every((k) => { const f = ruleRow(k).fields; return f.Active === true && f["Default Enabled"] === true && f["Required Module"] === "module_coaches" && !!f["Destination Area"] && !!f["Action Label"]; }));
    ck("CAT7. Supports Override frozen: 7 overrideable (staffing x4, expiry, unavailable, conflict); 7 not (cover ATT-041, ATT-031, ATT-042, ATT-043..046)", ACTIVE_RULES.every((k) => (ruleRow(k).fields["Supports Override"] === true) === OVERRIDEABLE.has(k)));
    const beforeRules = ACTIVE_RULES.filter((k) => [ruleRow(k).fields["Default Warning Timing"], ruleRow(k).fields["Default Urgent Timing"]].some((t) => typeof t === "string" && t.endsWith("Before")));
    const overdueRules = ACTIVE_RULES.filter((k) => [ruleRow(k).fields["Default Warning Timing"], ruleRow(k).fields["Default Urgent Timing"]].some((t) => typeof t === "string" && t.endsWith("Overdue")));
    reset();
    const b = await run({ debug: true });
    const anchoredOk = (rule: string, want: "event" | "since") => byRule(b, rule).every((c: any) => !/no (event|outstanding-since) anchor/.test(c.severityReason) && !!c.anchorTime) && byRule(b, rule).length > 0;
    ck("CAT8. Every rule with a '... Before' threshold supplies an event anchor on every case (no 'no event anchor')", beforeRules.length === 8 && beforeRules.every((k) => anchoredOk(k, "event")), beforeRules.join(","));
    ck("CAT9. Every rule with a '... Overdue' threshold supplies an outstanding-since anchor on every case", overdueRules.length === 5 && overdueRules.every((k) => anchoredOk(k, "since")), overdueRules.join(","));
    ck("CAT10. Rules with no thresholds (ATT-011, ATT-042) raise state severity only; ATT-031 keeps its locked minimum Warning", byRule(b, "coach_compliance_expiry")[0]?.severity === "Urgent" && /state Urgent/.test(byRule(b, "coach_compliance_expiry")[0].severityReason) && byRule(b, "non_compliant_coach_assigned").every((c: any) => c.severity !== "Normal"));
    ck("CAT11. Destination: area = catalogue Destination Area; route = the frozen placeholder route per rule", b.cases.every((c: any) => c.destination.area === ruleRow(c.ruleKey).fields["Destination Area"] && c.destination.route === ROUTES[c.ruleKey]));
    ck("CAT12. actionLabel / ruleName / category / module come from the catalogue row, never from code", b.cases.every((c: any) => { const f = ruleRow(c.ruleKey).fields; return c.actionLabel === f["Action Label"] && c.ruleName === f["Rule Name"] && c.category === f.Category && c.module === f["Required Module"] && c.ruleId === f["Rule ID"]; }));
  }

  // ===================================================================
  // COV - the busy organisation
  // ===================================================================
  reset();
  const full = await run({ debug: true });
  {
    const counts = Object.fromEntries(ACTIVE_RULES.map((k) => [k, byRule(full, k).length]));
    ck("COV1. All 14 active rules fire in one request with the exact expected counts (18 cases)", JSON.stringify(counts) === JSON.stringify(Object.fromEntries(ACTIVE_RULES.map((k) => [k, EXPECTED_COUNTS[k]]))) && full.cases.length === 18, JSON.stringify(counts));
    ck("COV2. complete = true, no config issues, 14 evaluated, 26 skipped - 24 planned (incl. venue_missing) + invoice_overdue and invoice_draft_blocked module_off (no module_finance row here), none not_implemented; Finance access never looked up", full.complete === true && full.configIssues.length === 0 && full.diagnostics.evaluated.length === 14 && full.diagnostics.skipped.length === 26 && full.diagnostics.skipped.filter((s: any) => s.reason === "planned").length === 24 && full.diagnostics.skipped.find((s: any) => s.ruleKey === "invoice_overdue")?.reason === "module_off" && full.diagnostics.skipped.find((s: any) => s.ruleKey === "invoice_draft_blocked")?.reason === "module_off" && full.diagnostics.skipped.some((s: any) => s.ruleKey === "venue_missing") && full.diagnostics.financeAccess === "not_checked");
  }

  // ===================================================================
  // CON - the frozen v1 contract
  // ===================================================================
  {
    const plain = await (reset(), run());
    ck("CON1. GET /cases top level = engine, organisation, generatedAt, complete, summary, cases, configIssues (diagnostics only with debug)", sameSet(Object.keys(plain), ["engine", "organisation", "generatedAt", "complete", "summary", "cases", "configIssues"]) && sameSet(Object.keys(full), ["engine", "organisation", "generatedAt", "complete", "summary", "cases", "configIssues", "diagnostics"]));
    ck("CON2. debug diagnostics = rulesInCatalogue, evaluated, skipped, sourcesLoaded, financeAccess (F8a), reads, suppressedCases", sameSet(Object.keys(full.diagnostics), ["rulesInCatalogue", "evaluated", "skipped", "sourcesLoaded", "financeAccess", "reads", "suppressedCases"]));
    ck("CON3. engine version string + organisation view = { organisationId, name, timezone } (no Airtable record id)", plain.engine === "needs-attention-slice-8" && sameSet(Object.keys(plain.organisation), ["organisationId", "name", "timezone"]) && !JSON.stringify(plain.organisation).includes(ORG) && plain.generatedAt === NOW.toISOString());
    const shapeOk = (c: any) =>
      sameSet(Object.keys(c), CASE_FIELDS) &&
      typeof c.caseKey === "string" && typeof c.ruleKey === "string" && typeof c.ruleId === "string" && typeof c.ruleName === "string" &&
      ["Normal", "Warning", "Urgent"].includes(c.severity) && typeof c.severityReason === "string" && typeof c.title === "string" && typeof c.detail === "string" && c.detail.length > 0 &&
      typeof c.actionLabel === "string" && typeof c.exceptionAllowed === "boolean" && (c.anchorTime === null || typeof c.anchorTime === "string") &&
      sameSet(Object.keys(c.destination), ["area", "route", "params"]) && Object.values(c.destination.params).every((v) => typeof v === "string") &&
      Object.values(c.targetIds).every((v) => typeof v === "string") && Object.values(c.relatedIds).every((v) => Array.isArray(v) && (v as any[]).every((x) => typeof x === "string")) &&
      Object.values(c.context).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    ck("CON4. Every case has exactly the 17 frozen fields with frozen types (context scalar-only; params/targetIds strings; relatedIds string arrays)", plain.cases.every(shapeOk), JSON.stringify(plain.cases.find((c: any) => !shapeOk(c))?.caseKey));
    ck("CON5. Navigation: every case has a non-empty route and params naming the record(s) to open; targetIds hold at least one record id", plain.cases.every((c: any) => !!c.destination.route && Object.keys(c.destination.params).length > 0 && Object.values(c.targetIds).some((v: any) => /^rec\w{14}$/.test(v))));
    const sev = (s: string) => ["Normal", "Warning", "Urgent"].indexOf(s);
    const ordered = plain.cases.every((c: any, i: number) => i === 0 || (() => { const p = plain.cases[i - 1]; return sev(p.severity) > sev(c.severity) || (p.severity === c.severity && (ruleRow(p.ruleKey).fields["Sort Order"] ?? 999) <= (ruleRow(c.ruleKey).fields["Sort Order"] ?? 999)); })());
    ck("CON6. Ordering frozen: severity (Urgent first), then catalogue Sort Order", ordered);
    const s = plain.summary;
    ck("CON7. summary = { state, total, counts{Normal,Warning,Urgent}, suppressed }; state = highest severity; totals add up", sameSet(Object.keys(s), ["state", "total", "counts", "suppressed"]) && sameSet(Object.keys(s.counts), ["Normal", "Warning", "Urgent"]) && s.total === plain.cases.length && s.counts.Normal + s.counts.Warning + s.counts.Urgent === s.total && s.state === "Urgent" && s.suppressed === 0);
    reset();
    const sv = await run({ view: "summary" });
    ck("CON8. view=summary returns engine, organisation, generatedAt, complete, summary only (no cases, no configIssues)", sameSet(Object.keys(sv), ["engine", "organisation", "generatedAt", "complete", "summary"]) && JSON.stringify(sv.summary) === JSON.stringify(s));
    const target = plain.cases.find((c: any) => c.ruleKey === "coach_schedule_conflict");
    reset();
    const lk = await run({ caseKey: target.caseKey });
    ck("CON9. caseKey lookup = engine, organisation, generatedAt, complete, caseKey, exists, suppressed, case, rule{ruleKey,ruleId,evaluated,skipReason}, configIssues", sameSet(Object.keys(lk), ["engine", "organisation", "generatedAt", "complete", "caseKey", "exists", "suppressed", "case", "rule", "configIssues"]) && sameSet(Object.keys(lk.rule), ["ruleKey", "ruleId", "evaluated", "skipReason"]));
    ck("CON10. The looked-up case is byte-identical to the same case in the full queue", lk.exists === true && lk.suppressed === false && JSON.stringify(lk.case) === JSON.stringify(target));
    reset();
    const miss = await run({ caseKey: "coach_schedule_conflict|coach:recNoSuchCoach0000|occurrence:recA00000000000000|occurrence:recB00000000000000" });
    const unknown = await (reset(), run({ caseKey: "no_such_rule|occurrence:recA00000000000000" }));
    ck("CON11. Lookup of a non-existent case -> exists false, case null; unknown rule -> rule.skipReason 'unknown_rule' (never an error)", miss.exists === false && miss.case === null && unknown.exists === false && unknown.rule.skipReason === "unknown_rule" && unknown.rule.evaluated === false);
    const bad = await (reset(), getCases(deps, MGMT, { caseKey: "not a key" }, NOW) as any);
    const both = await (reset(), getCases(deps, MGMT, { caseKey: target.caseKey, view: "summary" }, NOW) as any);
    const badView = await (reset(), getCases(deps, MGMT, { view: "everything" }, NOW) as any);
    ck("CON12. Malformed caseKey / caseKey+summary / unknown view -> 400 with a stable code", bad.httpStatus === 400 && bad.code === "invalid_case_key" && both.httpStatus === 400 && both.code === "invalid_query" && badView.httpStatus === 400 && badView.code === "invalid_view");
  }

  // ===================================================================
  // ID - identity
  // ===================================================================
  {
    const keys: string[] = keysOf(full);
    ck("ID1. Every key parses; its rule segment is the case's ruleKey; every subject id is an Airtable record id", full.cases.every((c: any) => { const p = parseCaseKey(c.caseKey); return !!p && p.ruleKey === c.ruleKey && p.subjects.every((s) => /^rec\w{14}$/.test(s.id)); }));
    ck("ID2. Keys are unique within the organisation", new Set(keys).size === keys.length);
    ck("ID3. Key shape frozen per rule (subject types and order)", full.cases.every((c: any) => KEY_SHAPES[c.ruleKey].test(c.caseKey)), full.cases.find((c: any) => !KEY_SHAPES[c.ruleKey].test(c.caseKey))?.caseKey);
    const names = ["Lara Lead", "Cody Coach", "Lily Learner", "Leo Learner", "Empty Session", "Short Staffed", "Clash Session", "Covered Session", "CR-0001", "WS-Sum", "AL-0001", "Hours look wrong", "Lead Coach", "Enhanced DBS", " "];
    ck("ID4. No key contains a name, label or human-readable reference", keys.every((k) => names.every((n) => !k.includes(n))));
    reset((t) => {
      for (const c of t.Coaches) c.fields = { ...c.fields, "Coach Name": `Renamed ${c.id.slice(-4)}`, "Coach ID": "X" };
      for (const s of t.Sessions) s.fields = { ...s.fields, "Session Name": `Renamed ${s.id.slice(-4)}` };
      for (const o of t["Session Occurrences"]) o.fields = { ...o.fields, "Occurrence Name": "Renamed" };
      t["Staff Availability Requests"] = t["Staff Availability Requests"].map((r) => ({ ...r, fields: { ...r.fields, "Request ID": "CR-9999" } }));
      t["Coach Work Summaries"] = t["Coach Work Summaries"].map((r) => ({ ...r, fields: { ...r.fields, "Work Summary ID": "WS-RENAMED", "Query / Reopen Note": "different" } }));
      t["Coach Allocations"] = t["Coach Allocations"].map((r) => ({ ...r, fields: { ...r.fields, "Allocation ID": "AL-9999" } }));
    });
    const renamed = await run();
    ck("ID5. Renaming every coach / session / occurrence / request / summary / allocation label changes titles but not one key", sameSet(keysOf(renamed), keys) && renamed.cases.some((c: any) => c.title.includes("Renamed")));
    reset((t) => { for (const k of Object.keys(t)) t[k] = [...t[k]].reverse(); });
    const shuffled = await run();
    ck("ID6. Reversing the row order of every table gives the same keys in the same order (deterministic, incl. conflict pair order)", JSON.stringify(keysOf(shuffled)) === JSON.stringify(keysOf(await (reset(), run()))));
    reset();
    const later = await run({}, new Date(NOW.getTime() + 2 * H));
    ck("ID7. Two hours later, same underlying problems -> same keys (severity may move, identity does not)", sameSet(keysOf(later), keys));
    reset((t) => { t[CONFIG_TABLES.organisations] = [ORG_ROW(ORG, "ORG-TEST-001"), ORG_ROW(ORG_B, "ORG-TEST-002")]; });
    const orgB = await run({}, NOW, MGMT_B);
    ck("ID8. Keys are organisation-free; the organisation is a separate scope (org B evaluating the same base gets the same keys, scoped to itself)", orgB.organisation.organisationId === "ORG-TEST-002" && sameSet(keysOf(orgB), keys) && keys.every((k) => !k.includes("ORG") && !k.includes(ORG)));
  }

  // ===================================================================
  // PRE - precedence and coexistence
  // ===================================================================
  {
    const at = (occId: string) => full.cases.filter((c: any) => c.targetIds.occurrenceId === occId || (c.relatedIds.occurrenceIds ?? []).includes(occId)).map((c: any) => c.ruleKey);
    const staffingOn = (occId: string) => at(occId).filter((k: string) => ["session_no_coach", "no_lead_coach", "learning_coach_only", "session_understaffed"].includes(k)).sort();
    ck("PRE1. Zero valid staff -> session_no_coach ONLY", JSON.stringify(staffingOn(O1.id)) === JSON.stringify(["session_no_coach"]));
    ck("PRE2. Learning-only + Lead required -> no_lead_coach ONLY (not learning_coach_only, not session_no_coach)", JSON.stringify(staffingOn(O2.id)) === JSON.stringify(["no_lead_coach"]));
    ck("PRE3. Learning-only + Lead NOT required -> learning_coach_only ONLY", JSON.stringify(staffingOn(O3.id)) === JSON.stringify(["learning_coach_only"]));
    ck("PRE4. Lead missing AND below Required Staff Count -> no_lead_coach + session_understaffed (both)", JSON.stringify(staffingOn(O4.id)) === JSON.stringify(["no_lead_coach", "session_understaffed"]));
    ck("PRE5. Cover stays separate from staffing: open cover on a fully staffed occurrence -> cover_open and no staffing case", JSON.stringify(at(O5.id)) === JSON.stringify(["cover_open"]));
    const codyO4 = full.cases.filter((c: any) => c.targetIds.coachId === C1.id && (c.targetIds.occurrenceId === O4.id || (c.relatedIds.occurrenceIds ?? []).includes(O4.id))).map((c: any) => c.ruleKey).sort();
    ck("PRE6. Genuinely separate problems coexist for one coach/occurrence: non-compliant (ATT-031), unavailable (ATT-014), conflict (ATT-012)", JSON.stringify(codyO4) === JSON.stringify(["assigned_coach_unavailable", "coach_schedule_conflict", "non_compliant_coach_assigned"]));
    ck("PRE7. Coach-level expiry (ATT-011) coexists with assignment-level non-compliance (ATT-031) for the same document", byRule(full, "coach_compliance_expiry").some((c: any) => c.targetIds.coachId === C1.id) && byRule(full, "non_compliant_coach_assigned").filter((c: any) => c.targetIds.coachId === C1.id).length === 2);
    const perSummary = [WQ, WR, WB].map((s) => full.cases.filter((c: any) => c.targetIds.summaryId === s.id).map((c: any) => c.ruleKey));
    ck("PRE8. Each Work Summary has at most ONE of queried / ready / blocked", perSummary.every((l) => l.length === 1) && JSON.stringify(perSummary.map((l) => l[0])) === JSON.stringify(["work_summary_queried", "work_summary_ready_to_finalise", "work_summary_blocked"]));
    ck("PRE9. Intentional coexistence: the undecided coach outcome raises coach_outcome_pending AND blocks the coach's Work Summary (two different actions)", byRule(full, "coach_outcome_pending")[0]?.targetIds.coachId === LC.id && byRule(full, "work_summary_blocked")[0]?.context.pendingCoachOutcomeUndecided === 1);
    ck("PRE10. Cancelled / past occurrences never raise staffing, availability, conflict or assignment cases", at(O7.id).every((k: string) => k === "coach_outcome_pending"));
  }

  // ===================================================================
  // G - gating
  // ===================================================================
  {
    const CONFIG = Object.values(CONFIG_TABLES);
    reset((t) => { t[CONFIG_TABLES.features] = [{ id: id("FeatCoach"), fields: { "Feature Key": "module_coaches" } }]; });
    const off = await run({ debug: true });
    ck("G1. module_coaches OFF -> all 14 rules skipped module_off (+ invoice_overdue / invoice_draft_blocked: no module_finance row), nothing evaluated, Clear, NO config noise", off.diagnostics.evaluated.length === 0 && off.diagnostics.skipped.filter((s: any) => s.reason === "module_off").length === 16 && off.summary.state === "Clear" && off.configIssues.length === 0);
    ck("G2. ... and ONLY the 5 config tables are read (no domain table at all)", sameSet(reads(), CONFIG));
    reset((t) => { t[CONFIG_TABLES.features] = []; });
    const missing = await run({ debug: true });
    ck("G3. Missing Feature Controls row = module OFF (fail closed), same 5 reads, no config issue", missing.diagnostics.skipped.filter((s: any) => s.reason === "module_off").length === 16 && sameSet(reads(), CONFIG) && missing.configIssues.length === 0);
    reset((t) => { t[CONFIG_TABLES.features] = [{ id: id("FeatC1"), fields: { "Feature Key": "module_coaches", Enabled: true } }, { id: id("FeatC2"), fields: { "Feature Key": "module_coaches" } }]; });
    const conflicting = await run({ debug: true });
    ck("G4. Conflicting Feature Controls rows -> module OFF (fail closed)", conflicting.diagnostics.skipped.filter((s: any) => s.reason === "module_off" && /conflicting/.test(s.detail)).length === 14 && sameSet(reads(), CONFIG));
    for (const [family, rules, tablesOnly] of EXCLUSIVE_SOURCES) {
      reset((t) => { t[CONFIG_TABLES.settings] = rules.map((k) => ({ ...setting(k, {}), id: id("Set" + k.replace(/_/g, "").slice(0, 10)) })); });
      const b = await run({ debug: true });
      const read = reads();
      ck(`G5. Settings disable ${family} -> those rules settings_disabled, their exclusive tables (${tablesOnly.join(", ")}) NOT read, other rules unaffected`, rules.every((k) => b.diagnostics.skipped.some((s: any) => s.ruleKey === k && s.reason === "settings_disabled")) && tablesOnly.every((t) => !read.includes(t)) && b.cases.every((c: any) => !rules.includes(c.ruleKey)) && b.diagnostics.evaluated.length === 14 - rules.length);
    }
    reset((t) => { t[CONFIG_TABLES.settings] = ACTIVE_RULES.map((k) => ({ ...setting(k, {}), id: id("Set" + k.replace(/_/g, "").slice(0, 10)) })); });
    const allOff = await run({ debug: true });
    ck("G6. Every active rule disabled via Settings -> 5 config reads only, Clear, no config issues", sameSet(reads(), CONFIG) && allOff.summary.state === "Clear" && allOff.configIssues.length === 0, JSON.stringify([reads(), allOff.configIssues]));
    reset();
    await run();
    const counts = reads().reduce((m: Record<string, number>, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
    ck("G7. Full request: 19 tables, each read exactly once; never Occurrence Financial Outcomes, Work Summary Lines, Players or any other table", Object.keys(counts).length === 19 && Object.values(counts).every((n) => n === 1) && !counts["Occurrence Financial Outcomes"] && !counts["Work Summary Lines"] && !counts.Players);
    reset();
    await run({ caseKey: keysOf(full).find((k: string) => k.startsWith("cover_open"))! });
    ck("G8. A single-rule lookup reads only config + that rule's sources (cover_open: 5 + 5)", reads().length === 10 && reads().includes("Staff Availability Requests") && !reads().includes("Coach Documents"));
  }

  // ===================================================================
  // SEC - roles and organisation isolation
  // ===================================================================
  {
    const denied = async (c: Caller) => {
      reset();
      const g = (await getCases(deps, c, {}, NOW)) as any;
      const x = await create({ caseKey: keysOf(full)[0], reason: "x" }, NOW, c);
      const r = await revoke({ exceptionId: "NAEX-1", reason: "x" }, NOW, c);
      return g.httpStatus === 403 && x.httpStatus === 403 && r.httpStatus === 403 && requests.length === 0;
    };
    ck("SEC1. Coach, parent, pending and inactive Management callers -> 403 on read, create and revoke, before any Airtable request", (await denied({ ...MGMT, role: "coach" })) && (await denied({ ...MGMT, role: "parent" })) && (await denied({ ...MGMT, role: "pending" })) && (await denied({ ...MGMT, active: false })));
    reset();
    const noOrg = (await getCases(deps, { ...MGMT, organisationId: "ORG-UNKNOWN" }, {}, NOW)) as any;
    reset();
    const caseOrg = (await getCases(deps, { ...MGMT, organisationId: "org-test-001" }, {}, NOW)) as any;
    reset();
    const nullOrg = (await getCases(deps, { ...MGMT, organisationId: null }, {}, NOW)) as any;
    ck("SEC2. Organisation comes only from the profile: unknown / case-changed / missing organisation -> 409, no domain reads", noOrg.httpStatus === 409 && caseOrg.httpStatus === 409 && nullOrg.httpStatus === 409 && !reads().some((t) => !Object.values(CONFIG_TABLES).includes(t as any)));
    reset((t) => { t[CONFIG_TABLES.organisations] = [ORG_ROW(ORG, "ORG-TEST-001"), ORG_ROW(id("OrgDup"), "ORG-TEST-001")]; });
    const amb = (await run()) as any;
    reset((t) => { t[CONFIG_TABLES.organisations] = [{ ...ORG_ROW(ORG, "ORG-TEST-001"), fields: { ...ORG_ROW(ORG, "ORG-TEST-001").fields, Active: false } }]; });
    const inact = (await run()) as any;
    ck("SEC3. Two active organisations with the same ID -> 409 organisation_ambiguous; inactive organisation -> 409 (fail closed)", amb.httpStatus === 409 && amb.code === "organisation_ambiguous" && inact.httpStatus === 409);
    const noLead = keysOf(full).find((k: string) => k.startsWith("session_no_coach"))!;
    reset((t) => {
      t[CONFIG_TABLES.organisations] = [ORG_ROW(ORG, "ORG-TEST-001"), ORG_ROW(ORG_B, "ORG-TEST-002")];
      t[CONFIG_TABLES.settings] = [setting("session_no_coach", {}, ORG_B)];
      t[EXC] = [{ id: id("ExcOrgB"), fields: { "Exception ID": "NAEX-B", Organisation: [ORG_B], Rule: [ruleRow("session_no_coach").id], "Case Key": noLead, Active: true, Reason: "org B only" } }];
    });
    const a = await run({ debug: true });
    ck("SEC4. Org B's Settings row and org B's exception for the SAME case key never touch org A (case visible, rule enabled)", a.cases.some((c: any) => c.caseKey === noLead) && a.summary.suppressed === 0);
    const rA = await revoke({ exceptionId: "NAEX-B", reason: "cross-org" });
    ck("SEC5. Org A cannot revoke org B's exception (404, nothing written)", rA.httpStatus === 404 && writes().length === 0);
    reset((t) => {
      t[CONFIG_TABLES.organisations] = [ORG_ROW(ORG, "ORG-TEST-001"), ORG_ROW(ORG_B, "ORG-TEST-002")];
      t[EXC] = [{ id: id("ExcBoth"), fields: { "Exception ID": "NAEX-BOTH", Organisation: [ORG, ORG_B], Rule: [ruleRow("session_no_coach").id], "Case Key": noLead, Active: true } }];
    });
    const both = await run();
    const rBoth = await revoke({ exceptionId: "NAEX-BOTH", reason: "x" });
    ck("SEC6. An exception linked to two organisations suppresses nothing and cannot be revoked by either (fail safe)", both.cases.some((c: any) => c.caseKey === noLead) && rBoth.httpStatus === 404);
    reset();
    const tenantBody = await create({ caseKey: noLead, reason: "x", organisationId: "ORG-TEST-002" });
    const extraBody = await create({ caseKey: noLead, reason: "x", ruleId: "ATT-013" });
    const tenantRevoke = await revoke({ exceptionId: "NAEX-1", reason: "x", organisation: "ORG-TEST-002" });
    ck("SEC7. Tenant-looking or extra body keys -> 400 (tenant_param_rejected / unexpected_field), nothing written", tenantBody.httpStatus === 400 && tenantBody.code === "tenant_param_rejected" && extraBody.httpStatus === 400 && extraBody.code === "unexpected_field" && tenantRevoke.httpStatus === 400 && writes().length === 0);
    reset();
    const ghost = await create({ caseKey: "session_no_coach|occurrence:recGhostOccur00000", reason: "x" });
    const ghost2 = await create({ caseKey: `session_no_coach|occurrence:${O5.id}`, reason: "staffed occurrence" });
    ck("SEC8. A record id that raises no case (unknown id, or a real but healthy occurrence) cannot create an exception: 404, nothing written", ghost.httpStatus === 404 && ghost.code === "case_not_found" && ghost2.httpStatus === 404 && writes().length === 0);
    reset((t) => { t["Coach Roles"] = [ROLE_LEAD, ROLE_COACH]; t.Coaches = [...t.Coaches, { id: id("CoachGone"), fields: { "Coach Name": "gone@example.com" } }]; });
    const noisy = await run({ debug: true });
    const blob = JSON.stringify(noisy);
    ck("SEC9. Config issues / diagnostics leak no token, base id, email or profile user id", noisy.configIssues.length > 0 && !blob.includes("secret-token-value") && !blob.includes("appTESTTESTTEST01") && !blob.includes("manager@test.invalid") && !blob.includes("user-mgmt-1") && noisy.configIssues.every((i: any) => !/@/.test(i.detail)));
  }

  // ===================================================================
  // EXC - exact-case exceptions across every family
  // ===================================================================
  {
    const firstPerRule = ACTIVE_RULES.map((k) => byRule(full, k)[0].caseKey);
    reset();
    const outcomes: Record<string, number> = {};
    for (const key of firstPerRule) outcomes[parseCaseKey(key)!.ruleKey] = (await create({ caseKey: key, reason: `freeze test ${key}` })).httpStatus;
    ck("EXC1. Every active family: overrideable -> 201, non-overrideable -> 403 override_not_supported", ACTIVE_RULES.every((k) => outcomes[k] === (OVERRIDEABLE.has(k) ? 201 : 403)), JSON.stringify(outcomes));
    ck("EXC2. Exactly 7 rows written, all to Needs Attention Exceptions (never a 403 write)", writes().length === 7 && writes().every((w) => w.table === EXC && w.method === "POST"));
    const after = await run({ debug: true });
    const suppressedKeys = after.diagnostics.suppressedCases.map((s: any) => s.caseKey);
    ck("EXC3. Exact case only: the 7 excepted cases are suppressed; sibling cases of the same rules stay visible", sameSet(suppressedKeys, firstPerRule.filter((k) => OVERRIDEABLE.has(parseCaseKey(k)!.ruleKey))) && after.cases.length === 11 && byRule(after, "no_lead_coach").length === 1 && byRule(after, "assigned_coach_unavailable").length === 1);
    const dup = await create({ caseKey: firstPerRule[0], reason: "again" });
    ck("EXC4. Duplicate while one is in force -> 409 exception_exists, no new row", dup.httpStatus === 409 && dup.code === "exception_exists" && tables[EXC].length === 7);
    const row = tables[EXC][0];
    const before = { ...row.fields };
    const rv = await revoke({ exceptionId: row.fields["Exception ID"], reason: "back on" });
    ck("EXC5. Revoke -> case visible again; approval snapshot untouched; revoke audit fields set", rv.httpStatus === 200 && rv.body.case.visibleAgain === true && ["Approved By User ID", "Approved By Name Snapshot", "Approved At", "Reason", "Case Key"].every((f) => row.fields[f] === before[f]) && !!row.fields["Revoked At"] && row.fields["Revoked By User ID"] === "user-mgmt-1" && row.fields.Active === undefined);
    const again = await revoke({ exceptionId: row.fields["Exception ID"], reason: "twice" });
    ck("EXC6. Revoking twice -> 409 already_revoked", again.httpStatus === 409 && again.code === "already_revoked");
    const snKey = firstPerRule[ACTIVE_RULES.indexOf("session_no_coach")];
    reset((t) => { t[EXC] = [{ id: id("ExcExpiring"), fields: { "Exception ID": "NAEX-EXP", Organisation: [ORG], Rule: [ruleRow("session_no_coach").id], "Case Key": snKey, Active: true, "Effective Until": new Date(NOW.getTime() + H).toISOString() } }]; });
    const inForce = await run();
    const expired = await run({}, new Date(NOW.getTime() + H));
    ck("EXC7. Effective Until: suppresses while in the future; at/after the instant the case is visible again (read-time expiry)", !keysOf(inForce).includes(snKey) && keysOf(expired).includes(snKey));
    reset((t) => {
      t[EXC] = [{ id: id("ExcAllowOff"), fields: { "Exception ID": "NAEX-OFF", Organisation: [ORG], Rule: [ruleRow("session_no_coach").id], "Case Key": snKey, Active: true } }];
      t[CONFIG_TABLES.settings] = [setting("session_no_coach", { Enabled: true })]; // Allow Override unticked
    });
    const offB = await run();
    const offCreate = await create({ caseKey: keysOf(full).find((k: string) => k.startsWith("coach_schedule_conflict"))!, reason: "other rule still fine" });
    ck("EXC8. Allow Override OFF in Settings -> the existing exception stops suppressing (case visible, exceptionAllowed false)", keysOf(offB).includes(snKey) && offB.cases.find((c: any) => c.caseKey === snKey).exceptionAllowed === false && offCreate.httpStatus === 201);
    reset((t) => { t[EXC] = [{ id: id("ExcAllowOff"), fields: { "Exception ID": "NAEX-OFF", Organisation: [ORG], Rule: [ruleRow("session_no_coach").id], "Case Key": snKey, Active: true } }]; t[CONFIG_TABLES.settings] = [setting("session_no_coach", { Enabled: true })]; });
    const blocked = await create({ caseKey: snKey, reason: "try" });
    reset((t) => { t[CONFIG_TABLES.settings] = [setting("session_no_coach", { Enabled: true })]; });
    const fresh = await create({ caseKey: snKey, reason: "try" });
    ck("EXC9. Allow Override OFF: a create with the old Active row still present -> 409 exception_exists (duplicate guard, no new row); with no row -> 403 override_disabled_by_settings", blocked.httpStatus === 409 && blocked.code === "exception_exists" && fresh.httpStatus === 403 && fresh.code === "override_disabled_by_settings" && writes().length === 0);
    reset((t) => { t[EXC] = [{ id: id("ExcWrongRule"), fields: { "Exception ID": "NAEX-WR", Organisation: [ORG], Rule: [ruleRow("no_lead_coach").id], "Case Key": snKey, Active: true } }]; });
    const wrongRule = await run();
    ck("EXC10. A row whose Rule link disagrees with its Case Key rule suppresses nothing (no broad scope)", keysOf(wrongRule).includes(snKey) && wrongRule.summary.suppressed === 0);
  }

  // ===================================================================
  // PERF - reads and shared passes at synthetic scale (in memory)
  // ===================================================================
  {
    const big = busyTables();
    const COACHES = Array.from({ length: 40 }, (_, i) => coach(`PerfC${String(i).padStart(3, "0")}`, `Perf Coach ${i}`));
    const SESS = Array.from({ length: 30 }, (_, i) => session(`PerfS${String(i).padStart(3, "0")}`, `Perf Session ${i}`, { "Requires Lead Coach": i % 3 === 0, "Required Staff Count": 2 }));
    const OCCS = SESS.flatMap((s, i) => [0, 1, 2, 3, 4, 5].map((d) => occ(`PerfO${String(i).padStart(3, "0")}${d}`, s, `2026-10-0${2 + d}`, `${String(8 + (i % 10)).padStart(2, "0")}:00`, `${String(9 + (i % 10)).padStart(2, "0")}:00`)));
    const SS = SESS.flatMap((s, i) => [staff(`PerfSa${String(i).padStart(3, "0")}`, s, COACHES[i % 40], ROLE_COACH), staff(`PerfSb${String(i).padStart(3, "0")}`, s, COACHES[(i + 7) % 40], i % 2 ? ROLE_LEAD : ROLE_LEARN)]);
    const DOCS2 = COACHES.map((c, i) => doc(`PerfD${String(i).padStart(3, "0")}`, c, { "Expiry / Review Date": i % 5 === 0 ? "2026-09-15" : "2027-06-01", ...(i % 7 === 0 ? {} : verified) }));
    const ALLOCS = OCCS.slice(0, 120).map((o, i) => ({ id: id(`PerfA${String(i).padStart(4, "0")}`), fields: { Coach: [COACHES[i % 40].id], "Session Occurrence": [o.id], "Cost Status": i % 4 ? "Confirmed" : "Draft", "Final Coach Cost": 30 } }));
    const SUMS = COACHES.map((c, i) => WS(`PerfW${String(i).padStart(3, "0")}`, c, "2026-09-01", "2026-09-30", i % 3 ? "Not ready" : "Needs review"));
    const COVERS = OCCS.filter((_, i) => i % 12 === 0).map((o, i) => ({ id: id(`PerfCv${String(i).padStart(3, "0")}`), createdTime: "2026-09-29T10:00:00.000Z", fields: { "Cover Date Status": "Open", "Session Occurrence": [o.id], Coach: [COACHES[i].id] } }));
    const AV = COACHES.filter((_, i) => i % 4 === 0).map((c, i) => ({ id: id(`PerfAv${String(i).padStart(3, "0")}`), fields: { Coach: [c.id], "Day of Week": "Saturday", Active: true } }));
    big.Coaches.push(...COACHES); big.Sessions.push(...SESS); big["Session Occurrences"].push(...OCCS); big["Session Staff"].push(...SS);
    big["Coach Documents"].push(...DOCS2); big["Coach Allocations"].push(...ALLOCS); big["Coach Work Summaries"].push(...SUMS); big["Staff Availability Requests"].push(...COVERS); big["Coach Availability"].push(...AV);
    tables = big;
    requests = [];
    for (const s of [staffingPassStats, coverPassStats, compliancePassStats, availabilityPassStats, conflictPassStats, workSummaryPassStats, coachOutcomePassStats]) s.passes = 0;
    const t0 = performance.now();
    const b = await run({ debug: true });
    const ms = performance.now() - t0;
    const counts = reads().reduce((m: Record<string, number>, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
    const passes = [staffingPassStats, coverPassStats, compliancePassStats, availabilityPassStats, conflictPassStats, workSummaryPassStats, coachOutcomePassStats].map((s) => s.passes);
    console.log(`      synthetic scale: ${big["Session Occurrences"].length} occurrences, ${big.Coaches.length} coaches, ${big["Session Staff"].length} staff rows, ${big["Coach Allocations"].length} allocations, ${big["Coach Work Summaries"].length} summaries -> ${b.cases.length} cases in ${ms.toFixed(0)} ms (in-memory evaluation)`);
    ck("PERF1. Busy organisation (187 occurrences, 44 coaches, 65 staff rows, 121 allocations, 43 summaries, 341 cases): still 19 list reads, each table once", Object.keys(counts).length === 19 && Object.values(counts).every((n) => n === 1) && b.complete === true);
    ck("PERF2. Every shared pass runs exactly once per request (no per-rule / per-record re-scans)", passes.every((p) => p === 1), passes.join(","));
    ck("PERF3. In-memory evaluation of the busy organisation stays well under 1 s (evaluation is not the bottleneck; Airtable I/O is)", ms < 1000, `${ms.toFixed(0)} ms`);
  }

  const fails = R.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${R.length - fails}/${R.length} checks passed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
