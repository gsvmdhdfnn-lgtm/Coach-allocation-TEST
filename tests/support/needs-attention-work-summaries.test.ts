// Unit + integration tests for Needs Attention Slice 8 - coach_outcome_pending
// (ATT-043) and the three Work Summary rules work_summary_queried (ATT-044),
// work_summary_ready_to_finalise (ATT-045) and work_summary_blocked (ATT-046)
// (see TEST-ENV.md "Needs Attention Foundation - Slice 8"). Request-level
// behaviour runs through the REAL orchestrator + the deployed registry against
// an in-memory Airtable that REJECTS every write except exception rows.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import { localDateIso } from "./needs-attention-staffing.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import {
  COACH_OUTCOME_SOURCES,
  WORK_SUMMARY_EVALUATORS,
  WORK_SUMMARY_SOURCES,
  coachOutcomePassStats,
  effectiveStatus,
  localDateOf,
  localMidnightIso,
  needsCoachOutcome,
  runWorkSummaryPass,
  summaryRuleFor,
  workSummaryCase,
  workSummaryPassStats,
} from "./needs-attention-work-summaries.ts";

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
const TZ = "Europe/London";
const TODAY = "2026-10-01";
const day = (n: number, from = TODAY) => {
  const [y, m, d] = from.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const coach = (tag: string, name: string, active = true): AirtableRecord => ({ id: id(tag), fields: active ? { "Coach Name": name, "Coach ID": `C-${tag}`, Active: true } : { "Coach Name": name, "Coach ID": `C-${tag}` } });
const CW = coach("CoachWendy", "Wendy Query"), CR = coach("CoachRita", "Rita Ready"), CB = coach("CoachBob", "Bob Blocked"), CI = coach("CoachIvan", "Ivan Inprog");
const CF = coach("CoachFin", "Fin Final"), CS = coach("CoachStale", "Stan Stale"), CO = coach("CoachOwen", "Owen Outcome"), CX = coach("CoachXena", "Xena Gone", false), CM = coach("CoachMia", "Mia Multi");
const COACHES = [CW, CR, CB, CI, CF, CS, CO, CX, CM];

const SES = { id: id("SessWS1"), fields: { "Session Name": "U10 Tuesday", "Session Lifecycle Status": "Active", Programme: "Academy" } };
function occ(tag: string, date: string, o: { status?: string; change?: string; replacement?: string; untimed?: boolean } = {}): AirtableRecord {
  const f: Record<string, any> = { "Occurrence Name": `U10 ${date}`, Status: o.status ?? "Scheduled", Session: [SES.id], Date: date };
  if (!o.untimed) Object.assign(f, { "Start Date & Time": `${date}T16:00:00.000Z`, "End Date & Time": `${date}T17:00:00.000Z` });
  if (o.change) f["Schedule Change State"] = o.change;
  if (o.replacement) f["Replacement Occurrence"] = [o.replacement];
  return { id: id(tag), fields: f };
}
// September (the summary period) + October.
const O05 = occ("Occ0905", "2026-09-05", { status: "Completed" });
const O10 = occ("Occ0910", "2026-09-10");
const O15 = occ("Occ0915", "2026-09-15");
const O20C = occ("Occ0920C", "2026-09-20", { status: "Cancelled" });
const O25N = occ("Occ0925N", "2026-10-02"); // the replacement for the postponed 22nd
const O22P = occ("Occ0922P", "2026-09-22", { status: "Postponed", change: "Rescheduled", replacement: O25N.id });
const O28R = occ("Occ0928R", "2026-09-28", { change: "Rescheduled" }); // moved but still runs (Scheduled)
const O27U = occ("Occ0927U", "2026-09-27", { status: "Cancelled", untimed: true });
const O06F = occ("Occ1006F", "2026-10-06", { status: "Cancelled" }); // future cancellation
const O29X = occ("Occ0929X", "2026-09-29", { status: "Cancelled" });
const OCCS = [O05, O10, O15, O20C, O25N, O22P, O28R, O27U, O06F, O29X];

let allocN = 0;
function alloc(coachIds: string | string[], occId: string, o: { cost?: string; final?: number | null; outcome?: string; label?: string } = {}): AirtableRecord {
  const n = ++allocN;
  const f: Record<string, any> = {
    "Allocation ID": o.label ?? `AL-${String(n).padStart(3, "0")}`,
    Coach: Array.isArray(coachIds) ? coachIds : [coachIds],
    "Session Occurrence": [occId],
    "Cost Status": o.cost ?? "Confirmed",
    "Rate Type Snapshot": "Evening",
    "Paid Units": 1,
    "Rate Amount Snapshot": 30,
  };
  if (o.final !== null) f["Final Coach Cost"] = o.final ?? 30;
  if (o.outcome) f["Coach Outcome"] = o.outcome;
  return { id: id("Alloc" + String(n).padStart(3, "0")), fields: f };
}

function summary(tag: string, coachId: string, status: string, o: { start?: string; end?: string; active?: boolean; queriedAt?: string; note?: string; finalisedAt?: string; reopenedAt?: string; noPeriod?: boolean } = {}): AirtableRecord {
  const f: Record<string, any> = { "Work Summary ID": `WS-${tag}`, Coach: [coachId], Status: status };
  if (!o.noPeriod) Object.assign(f, { "Period Start": o.start ?? "2026-09-01", "Period End": o.end ?? "2026-09-30" });
  if (o.active !== false) f.Active = true;
  if (o.queriedAt) f["Queried At"] = o.queriedAt;
  if (o.note) f["Query / Reopen Note"] = o.note;
  if (o.finalisedAt) f["Finalised At"] = o.finalisedAt;
  if (o.reopenedAt) f["Reopened At"] = o.reopenedAt;
  return { id: id(tag), fields: f };
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
// The TEST catalogue's real values (NA1.7 / live rows; Slice 8 rows rec00IKBwihcKHx2M, rechnmv1LKwdbKWBY, rec61LC0S5eige37U, recrHin89iSvwLDbw).
const RULES = [
  rule("no_lead_coach", "ATT-001", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 1 }),
  rule("learning_coach_only", "ATT-002", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 2 }),
  rule("session_understaffed", "ATT-005", { warn: [72, "Hours Before"], urg: [24, "Hours Before"], sort: 5 }),
  rule("session_no_coach", "ATT-013", { sev: "Warning", urg: [48, "Hours Before"], sort: 13, action: "Assign Staff" }),
  rule("cover_open", "ATT-041", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sort: 41, override: false, area: "Coaches", action: "Resolve Cover" }),
  rule("coach_compliance_expiry", "ATT-011", { sev: "Warning", sort: 11, area: "Coaches", action: "Review Compliance" }),
  rule("compliance_verification_pending", "ATT-042", { sort: 42, override: false, area: "Coaches", action: "Review Compliance" }),
  rule("non_compliant_coach_assigned", "ATT-031", { sev: "Warning", urg: [48, "Hours Before"], locked: "Warning", sort: 31, override: false, area: "Coaches", action: "Review Compliance" }),
  rule("coach_schedule_conflict", "ATT-012", { sev: "Warning", urg: [48, "Hours Before"], sort: 12, action: "Review Conflict" }),
  rule("assigned_coach_unavailable", "ATT-014", { sev: "Warning", urg: [48, "Hours Before"], sort: 14 }),
  rule("coach_outcome_pending", "ATT-043", { warn: [48, "Hours Overdue"], sort: 43, override: false, area: "Coaches", action: "Record Coach Outcome" }),
  rule("work_summary_queried", "ATT-044", { warn: [3, "Days Overdue"], sort: 44, override: false, area: "Coaches", action: "Review Query" }),
  rule("work_summary_ready_to_finalise", "ATT-045", { warn: [3, "Days Overdue"], sort: 45, override: false, area: "Coaches", action: "Finalise Summary" }),
  rule("work_summary_blocked", "ATT-046", { warn: [3, "Days Overdue"], sort: 46, override: false, area: "Coaches", action: "Resolve Pending Items" }),
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

interface World { summaries?: AirtableRecord[]; allocations?: AirtableRecord[]; occurrences?: AirtableRecord[]; coaches?: AirtableRecord[]; moduleOn?: boolean; settings?: AirtableRecord[]; sessions?: AirtableRecord[]; outcomes?: AirtableRecord[] }
function world(o: World) {
  tables = {
    [CONFIG_TABLES.rules]: RULES,
    [CONFIG_TABLES.settings]: o.settings ?? [],
    [EXC]: [],
    [CONFIG_TABLES.features]: [{ id: id("FeatCoach"), fields: o.moduleOn === false ? { "Feature Key": "module_coaches" } : { "Feature Key": "module_coaches", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [{ id: ORG, fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: TZ, "Organisation Name": "Test Org" } }],
    "Sessions": o.sessions ?? [SES],
    "Session Occurrences": o.occurrences ?? OCCS,
    "Session Staff": [],
    "Occurrence Staff": [],
    "Coach Roles": [],
    "Coaches": o.coaches ?? COACHES,
    "Staff Availability Requests": [],
    "Cover Responses": [],
    "Coach Documents": [],
    "Coach Document Requirements": [],
    "Coach Availability": [],
    "Coach Availability Exceptions": [],
    "Coach Work Summaries": o.summaries ?? [],
    "Coach Allocations": o.allocations ?? [],
    // Parent / Venue outcomes: present in the base, never read by any Slice 8 rule.
    "Occurrence Financial Outcomes": o.outcomes ?? [],
    "Work Summary Lines": [],
    "Work Summary History": [],
  };
  requests = [];
}
function setting(ruleKey: string, f: Record<string, any>, n = 0): AirtableRecord {
  return { id: id("Set" + ruleKey.replace(/_/g, "").slice(0, 8) + n), fields: { "Setting ID": `NAS-${ruleKey}`, Organisation: [ORG], Rule: [ruleRec(ruleKey).id], ...f } };
}
const MGMT: Caller = { userId: "user-mgmt-1", role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Morgan Manager", email: "manager@test.invalid" };
const deps: Deps = { airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry: IMPLEMENTED_EVALUATORS, lock: fakeLock };
const run = (query: any = {}, now = NOW) => getCases(deps, MGMT, query, now) as Promise<any>;
const create = (body: any, now = NOW) => createException(deps, MGMT, body, now, { maxAttempts: 3, retryDelayMs: 1 }) as Promise<any>;
const byRule = (b: any, k: string) => b.cases.filter((c: any) => c.ruleKey === k);
const find = (b: any, key: string) => b.cases.find((c: any) => c.caseKey === key);
const kQ = (s: AirtableRecord) => `work_summary_queried|summary:${s.id}`;
const kR = (s: AirtableRecord) => `work_summary_ready_to_finalise|summary:${s.id}`;
const kB = (s: AirtableRecord) => `work_summary_blocked|summary:${s.id}`;
const kO = (o: AirtableRecord, c: AirtableRecord) => `coach_outcome_pending|occurrence:${o.id}|coach:${c.id}`;
const SUMMARY_RULES = ["work_summary_queried", "work_summary_ready_to_finalise", "work_summary_blocked"];
const summaryCases = (b: any) => b.cases.filter((c: any) => SUMMARY_RULES.includes(c.ruleKey));
const reads = () => requests.filter((r) => r.method === "GET").map((r) => r.table);
const writes = () => requests.filter((r) => r.method !== "GET");

async function main() {
  // ===== Pure mapping (the NA2.6 contract) =====
  {
    const P = { start: "2026-09-01", end: "2026-09-30" };
    const Open = { start: "2026-09-15", end: "2026-10-15" };
    ck("M1. effectiveStatus: Finalised and Queried are never recomputed (applyRefresh never moves them)", effectiveStatus("Finalised", 3, P, TODAY) === "Finalised" && effectiveStatus("Queried", 3, P, TODAY) === "Queried" && effectiveStatus("Queried", 0, Open, TODAY) === "Queried");
    ck("M2. effectiveStatus: stored Not ready / Needs review -> openStatusFor(pending, period, today), whatever was stored", effectiveStatus("Not ready", 0, P, TODAY) === "Needs review" && effectiveStatus("Needs review", 1, P, TODAY) === "Not ready" && effectiveStatus("Needs review", 0, Open, TODAY) === "Not ready" && effectiveStatus("Not ready", 0, { start: "2026-09-01", end: TODAY }, TODAY) === "Not ready");
    ck("M3. summaryRuleFor: Queried -> queried; Needs review -> ready; Not ready + period ended -> blocked; Not ready in progress / Finalised -> nothing", summaryRuleFor("Queried", Open, TODAY) === "work_summary_queried" && summaryRuleFor("Needs review", P, TODAY) === "work_summary_ready_to_finalise" && summaryRuleFor("Not ready", P, TODAY) === "work_summary_blocked" && summaryRuleFor("Not ready", Open, TODAY) === null && summaryRuleFor("Not ready", { start: "2026-09-01", end: TODAY }, TODAY) === null && summaryRuleFor("Finalised", P, TODAY) === null);
    const a = (fields: Record<string, any>) => ({ id: id("AX"), fields });
    const o = (status: string) => ({ id: id("OX"), fields: { Status: status } });
    ck("M4. needsCoachOutcome: Cancelled / Postponed without a recognised outcome only", needsCoachOutcome(a({}), o("Cancelled")) && needsCoachOutcome(a({ "Coach Outcome": "Maybe" }), o("Postponed")) && !needsCoachOutcome(a({ "Coach Outcome": "Paid" }), o("Cancelled")) && !needsCoachOutcome(a({ "Coach Outcome": "Partial" }), o("Postponed")) && !needsCoachOutcome(a({ "Coach Outcome": "Unpaid" }), o("Cancelled")) && !needsCoachOutcome(a({}), o("Scheduled")) && !needsCoachOutcome(a({}), o("Completed")) && !needsCoachOutcome(a({}), o("")));
    ck("M5. localMidnightIso is DST-correct (BST midnight = 23:00Z the day before; GMT midnight = 00:00Z)", localMidnightIso("2026-10-01", TZ) === "2026-09-30T23:00:00.000Z" && localMidnightIso("2026-10-26", TZ) === "2026-10-26T00:00:00.000Z" && localMidnightIso("2026-10-25", TZ) === "2026-10-24T23:00:00.000Z" && localMidnightIso("bad", TZ) === null);
    ck("M6. localDateOf reads the query time in the organisation timezone (23:30Z in BST is the next local day; GMT is unchanged; junk -> null)", localDateOf("2026-09-27T23:30:00.000Z", TZ) === "2026-09-28" && localDateOf("2026-11-27T23:30:00.000Z", TZ) === "2026-11-27" && localDateOf("nope", TZ) === null && localDateOf(null, TZ) === null);
  }

  // ===== Main world =====
  allocN = 0;
  // Wendy: queried summary (2 confirmed, worked allocations).
  const WQ = summary("SumWendy", CW.id, "Queried", { queriedAt: "2026-09-27T09:00:00.000Z", note: "The 10 Sep session was 90 minutes, not 60." });
  const aW = [alloc(CW.id, O05.id), alloc(CW.id, O10.id)];
  // Rita: stored Needs review, all resolved (incl. a decided cancellation and a worked rescheduled date).
  const WR = summary("SumRita", CR.id, "Needs review");
  const aR = [alloc(CR.id, O10.id), alloc(CR.id, O20C.id, { outcome: "Unpaid", final: 0 }), alloc(CR.id, O28R.id), alloc(CR.id, O06F.id, { outcome: "Paid" })];
  // Bob: stored Not ready, period ended, blockers: Draft cost + undecided cancellation + invalid cost.
  const WB = summary("SumBob", CB.id, "Not ready");
  const aB = [alloc(CB.id, O10.id), alloc(CB.id, O15.id, { cost: "Draft" }), alloc(CB.id, O20C.id), alloc(CB.id, O05.id, { final: null })];
  // Ivan: period still open (15 Sep - 15 Oct) with pending items -> no case.
  const WI = summary("SumIvan", CI.id, "Not ready", { start: "2026-09-15", end: "2026-10-15" });
  const aI = [alloc(CI.id, O15.id, { cost: "Draft" }), alloc(CI.id, O25N.id)];
  // Fin: finalised (even with a now-undecided allocation) -> no summary case.
  const WF = summary("SumFin", CF.id, "Finalised", { finalisedAt: "2026-09-30T20:00:00.000Z" });
  const aF = [alloc(CF.id, O10.id)];
  // Stan: stale stored "Not ready" but everything is resolved and the period ended -> ready.
  const WS = summary("SumStan", CS.id, "Not ready");
  const aS = [alloc(CS.id, O10.id), alloc(CS.id, O15.id)];
  // Owen: cancelled / postponed allocations for coach_outcome_pending (no summary).
  const aO = [
    alloc(CO.id, O20C.id), // Cancelled, no outcome -> case
    alloc(CO.id, O22P.id, { outcome: "Maybe" }), // Postponed, unrecognised outcome -> case
    alloc(CO.id, O28R.id), // Rescheduled but Scheduled -> no case
    alloc(CO.id, O06F.id), // future cancellation -> case (Normal)
    alloc(CO.id, O27U.id), // cancelled, untimed -> case anchored on the date
  ];
  // Inactive summary + invalid summary; inactive coach's undecided cancellation.
  const WX = summary("SumXOff", CB.id, "Queried", { active: false, start: "2026-08-01", end: "2026-08-31" });
  const WV = summary("SumInvalid", CI.id, "Needs review", { noPeriod: true });
  const aX = [alloc(CX.id, O29X.id)];
  // Allocation with no coach on a cancelled occurrence; one allocation linking two coaches.
  const aNoCoach = { id: id("AllocNoCoach"), fields: { "Allocation ID": "AL-NC", "Session Occurrence": [O29X.id], "Cost Status": "Confirmed", "Final Coach Cost": 30 } };
  const aMulti = alloc([CO.id, CM.id], O29X.id);
  // An undated allocation for Rita (no occurrence) - reported, never blocks.
  const aUndated = { id: id("AllocUndated"), fields: { "Allocation ID": "AL-UD", Coach: [CR.id], "Cost Status": "Confirmed", "Final Coach Cost": 30 } };
  const SUMMARIES = [WQ, WR, WB, WI, WF, WS, WX, WV];
  const ALLOCS = [...aW, ...aR, ...aB, ...aI, ...aF, ...aS, ...aO, ...aX, aNoCoach, aMulti, aUndated];
  // A Parent/Venue outcome row for an occurrence whose coach outcome IS decided - must never matter.
  const OFO = [{ id: id("OFOrow1"), fields: { "Outcome ID": "OUTCOME-1", "Session Occurrence": [O20C.id] } }];
  const mainWorld = (extra: Partial<World> = {}) => world({ summaries: SUMMARIES, allocations: ALLOCS, outcomes: OFO, ...extra });

  {
    mainWorld();
    workSummaryPassStats.passes = 0; coachOutcomePassStats.passes = 0;
    const b = (await run({ debug: true })).body;

    // --- work_summary_queried ---
    const q = find(b, kQ(WQ));
    ck("Q1. Queried summary -> work_summary_queried (one case, keyed on the summary record id)", !!q && byRule(b, "work_summary_queried").length === 1);
    ck("Q2. Queried payload: summary, coach, period, stored/effective status, query note + time, pending counts, action, destination", q?.context.summaryId === WQ.id && q.context.coachName === "Wendy Query" && q.context.periodStart === "2026-09-01" && q.context.periodEnd === "2026-09-30" && q.context.effectiveStatus === "Queried" && q.context.storedStatus === "Queried" && q.context.queriedAt === "2026-09-27T09:00:00.000Z" && /90 minutes/.test(q.context.queryNote) && q.context.pendingCount === 0 && q.context.canFinaliseNow === true && q.actionLabel === "Review Query" && q.destination.area === "Coaches" && q.destination.route === "coaches/work-summary" && q.destination.params.summaryId === WQ.id && q.targetIds.summaryId === WQ.id && q.targetIds.coachId === CW.id);
    ck("Q3. Queried severity anchored on Queried At: 4 days ago > 3 Days Overdue -> Warning", q?.severity === "Warning" && /Warning threshold reached \(3d overdue\)/.test(q.severityReason) && q.anchorTime === "2026-09-27T09:00:00.000Z");
    ck("Q8. Queried text: query date shown in the organisation timezone and the quoted note is closed with a full stop", /queried the work summary for 1 Sep 2026 - 30 Sep 2026 on 27 Sep 2026: "The 10 Sep session was 90 minutes, not 60\."\. Review the query/.test(q?.detail ?? ""));
    {
      // Late-evening query (23:30Z = 00:30 BST next day): the text shows the organisation-local date, not the UTC one.
      const passesBefore = workSummaryPassStats.passes;
      const late = summary("SumLate", CW.id, "Queried", { start: "2026-08-01", end: "2026-08-07", queriedAt: "2026-09-27T23:30:00.000Z", note: "Late query" });
      const pass = runWorkSummaryPass({ "Coach Work Summaries": [late], "Coach Allocations": [], "Session Occurrences": OCCS, Sessions: [SES], Coaches: COACHES }, NOW, TZ);
      workSummaryPassStats.passes = passesBefore;
      const a = pass.analyses[0];
      ck("Q9. Query date uses the organisation timezone: Queried At 27 Sep 23:30Z reads 'on 28 Sep 2026' (anchor still the exact instant)", a?.queriedOn === "2026-09-28" && / on 28 Sep 2026: "Late query"\./.test(workSummaryCase(a).detail) && workSummaryCase(a).anchors?.outstandingSince === "2026-09-27T23:30:00.000Z");
    }

    // --- work_summary_ready_to_finalise ---
    const r = find(b, kR(WR));
    ck("R1. Stored Needs review, all work resolved, period ended -> work_summary_ready_to_finalise", !!r && r.context.effectiveStatus === "Needs review" && r.context.storedStatusStale === false && r.context.pendingCount === 0);
    ck("R2. Ready counts only this coach's in-period work: decided cancellation (Unpaid) + Rescheduled-but-run date + normal date = 3 eligible; October work and the undated allocation are outside / non-blocking", r?.context.eligibleCount === 3 && r.context.undatedCount === 1 && r.relatedIds.undatedAllocationIds[0] === aUndated.id);
    const st = find(b, kR(WS));
    ck("R3. STALE stored 'Not ready' but everything resolved and period ended -> recomputed Needs review -> ready case (stored status flagged stale, never trusted)", !!st && st.context.storedStatus === "Not ready" && st.context.effectiveStatus === "Needs review" && st.context.storedStatusStale === true && /out of date/.test(st.detail) && !find(b, kB(WS)));
    ck("R4. Ready severity anchored on Period End (midnight after 30 Sep, London): 11h later -> Normal", r?.severity === "Normal" && r.anchorTime === "2026-09-30T23:00:00.000Z" && r.context.periodEndedAt === "2026-09-30T23:00:00.000Z");
    ck("R5. Ready payload: action Finalise Summary, destination exact summary, no financial totals", r?.actionLabel === "Finalise Summary" && r.destination.params.summaryId === WR.id && !("grandTotal" in r.context) && !/£/.test(JSON.stringify(r)));
    {
      // Pure pass: one summary with nothing in its period, one with exactly one resolved item.
      const z = summary("SumZero", CR.id, "Needs review", { start: "2026-08-01", end: "2026-08-07" });
      const one = summary("SumOne", CR.id, "Needs review", { start: "2026-09-05", end: "2026-09-05" });
      const passesBefore = workSummaryPassStats.passes;
      const pass = runWorkSummaryPass({ "Coach Work Summaries": [z, one], "Coach Allocations": [alloc(CR.id, O05.id)], "Session Occurrences": OCCS, Sessions: [SES], Coaches: COACHES }, NOW, TZ);
      workSummaryPassStats.passes = passesBefore; // keep RD1's one-pass-per-request count about the real request
      const txt = (sid: string) => { const a = pass.analyses.find((x) => x.summaryId === sid); return a ? workSummaryCase(a).detail : ""; };
      ck("R10. Ready wording counts resolved work correctly: 3 -> 'all 3 items of work are resolved', 2 -> 'all 2 items', 1 -> 'its 1 item of work is resolved', 0 -> 'nothing is pending' (never 'all 0 items' / 'all 1 item ... are')", /all 3 items of work are resolved\./.test(r?.detail ?? "") && /all 2 items of work are resolved\./.test(st?.detail ?? "") && /has ended and its 1 item of work is resolved\./.test(txt(one.id)) && /has ended and nothing is pending\./.test(txt(z.id)) && !/all [01] item/.test(JSON.stringify(b.cases) + txt(one.id) + txt(z.id)));
    }

    // --- work_summary_blocked ---
    const bl = find(b, kB(WB));
    ck("B1. Period ended + unresolved allocations -> work_summary_blocked with the pending breakdown from the domain classifier", !!bl && bl.context.pendingCount === 3 && bl.context.pendingCostNotConfirmed === 1 && bl.context.pendingCoachOutcomeUndecided === 1 && bl.context.pendingInvalidFinalCost === 1 && bl.context.effectiveStatus === "Not ready" && bl.relatedIds.pendingAllocationIds.length === 3 && /3 items still pending \(1 cost not confirmed, 1 missing or invalid final cost, 1 coach outcome not decided\)/.test(bl.detail));
    ck("B2. Period still in progress (ends 15 Oct) with pending items -> NO blocked case (and no other summary case)", !b.cases.some((c: any) => c.targetIds.summaryId === WI.id));
    ck("B3. Blocked payload: action Resolve Pending Items, exact summary destination, anchored on Period End", bl?.actionLabel === "Resolve Pending Items" && bl.destination.params.summaryId === WB.id && bl.anchorTime === "2026-09-30T23:00:00.000Z" && bl.severity === "Normal");

    // --- exclusions ---
    ck("X1. Finalised summary -> no case (even though the domain would now find drift)", !b.cases.some((c: any) => c.targetIds.summaryId === WF.id));
    ck("X2. Inactive summary -> no case (even stored Queried)", !b.cases.some((c: any) => c.targetIds.summaryId === WX.id));
    ck("X3. Invalid active summary (no period) -> configIssue work_summary_invalid, no case", !b.cases.some((c: any) => c.targetIds.summaryId === WV.id) && b.configIssues.some((i: any) => i.code === "work_summary_invalid" && i.recordId === WV.id));

    // --- coach_outcome_pending ---
    const oc = find(b, kO(O20C, CO));
    ck("O1. Cancelled occurrence, coach allocation with no Coach Outcome -> coach_outcome_pending|occurrence:<id>|coach:<id>", !!oc && oc.relatedIds.allocationIds.length === 1 && oc.context.occurrenceStatus === "Cancelled" && oc.context.currentCoachOutcome === null);
    ck("O2. Payload: occurrence, session, coach, date, change state, current outcome, amount already in domain truth, action, destination", oc?.context.sessionName === "U10 Tuesday" && oc.context.sessionId === SES.id && oc.context.coachName === "Owen Outcome" && oc.context.date === "2026-09-20" && oc.context.start === "2026-09-20T16:00:00.000Z" && oc.context.finalCoachCost === 30 && oc.context.costStatus === "Confirmed" && oc.context.outcomeOptions === "Paid, Partial, Unpaid" && oc.actionLabel === "Record Coach Outcome" && oc.destination.route === "coaches/occurrence-financial-outcome" && oc.destination.params.occurrenceId === O20C.id && oc.destination.params.coachId === CO.id && oc.destination.params.allocationId === oc.context.allocationId);
    ck("O3. Severity: occurrence started > 48h ago -> Warning (anchor = occurrence start)", oc?.severity === "Warning" && oc.anchorTime === "2026-09-20T16:00:00.000Z");
    const op = find(b, kO(O22P, CO));
    ck("O4. Postponed (with a replacement occurrence) and an UNRECOGNISED stored outcome -> case, current outcome shown, replacement noted", !!op && op.context.occurrenceStatus === "Postponed" && op.context.currentCoachOutcome === "Maybe" && op.context.replacementOccurrenceId === O25N.id && op.context.scheduleChangeState === "Rescheduled" && /not recognised/.test(op.detail));
    ck("O5. Rescheduled Schedule Change State with Status Scheduled -> NO coach outcome case (the domain requires an outcome only for Cancelled/Postponed)", !find(b, kO(O28R, CO)));
    const of = find(b, kO(O06F, CO));
    ck("O6. Future cancellation -> case now, Normal (48h overdue is measured from the occurrence start)", of?.severity === "Normal" && of.anchorTime === "2026-10-06T16:00:00.000Z");
    const ou = find(b, kO(O27U, CO));
    ck("O7. Untimed cancelled occurrence -> anchored on 00:00 London of its date", ou?.anchorTime === "2026-09-26T23:00:00.000Z" && ou.severity === "Warning");
    ck("O8. Decided outcomes (Rita's Unpaid / Paid) -> no case", !find(b, kO(O20C, CR)) && !find(b, kO(O06F, CR)));
    ck("O9. Inactive coach's undecided cancellation -> case still raised (the decision is still owed; coachActive=false)", find(b, kO(O29X, CX))?.context.coachActive === false);
    ck("O10. Allocation linking two coaches -> one case per coach + configIssue; no-coach allocation -> configIssue, no case", !!find(b, kO(O29X, CO)) && !!find(b, kO(O29X, CM)) && b.configIssues.some((i: any) => i.code === "coach_outcome_allocation_multiple_coaches" && i.recordId === aMulti.id) && b.configIssues.some((i: any) => i.code === "coach_outcome_allocation_no_coach" && i.recordId === aNoCoach.id));
    ck("O11. Bob's undecided cancellation shows up BOTH as coach_outcome_pending (the decision) and in his blocked summary (the effect) - distinct keys, not contradictory", !!find(b, kO(O20C, CB)) && !!bl);
    ck("O12. Exactly the expected coach outcome cases", byRule(b, "coach_outcome_pending").map((c: any) => c.caseKey).sort().join(",") === [kO(O20C, CO), kO(O22P, CO), kO(O06F, CO), kO(O27U, CO), kO(O20C, CB), kO(O29X, CX), kO(O29X, CO), kO(O29X, CM)].sort().join(","));

    // --- identity / duplicates ---
    const perSummary = new Map<string, number>();
    for (const c of summaryCases(b)) perSummary.set(c.targetIds.summaryId, (perSummary.get(c.targetIds.summaryId) ?? 0) + 1);
    ck("I1. One summary -> at most ONE summary case (no contradictory queried/ready/blocked pairs)", [...perSummary.values()].every((n) => n === 1) && summaryCases(b).length === 4);
    ck("I2. Exactly the expected summary cases: Wendy queried, Rita + Stan ready, Bob blocked", summaryCases(b).map((c: any) => c.caseKey).sort().join(",") === [kQ(WQ), kR(WR), kR(WS), kB(WB)].sort().join(","));
    ck("I3. Slice 8 case keys are record-id based (no names / titles) and every key in the queue is unique", [...byRule(b, "coach_outcome_pending"), ...summaryCases(b)].every((c: any) => /^(work_summary_(queried|ready_to_finalise|blocked)\|summary:rec\w{14}|coach_outcome_pending\|occurrence:rec\w{14}\|coach:rec\w{14})$/.test(c.caseKey)) && new Set(b.cases.map((c: any) => c.caseKey)).size === b.cases.length);
    ck("P1. Context values are scalars only; no Parent / Venue outcome data anywhere", b.cases.every((c: any) => Object.values(c.context).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) && !/Parent Outcome|Venue Outcome|OUTCOME-1|parentOutcome|venueOutcome/.test(JSON.stringify(b)));

    // --- reads / purity ---
    ck("RD1. One request: every table listed once (19 lists), ONE Work Summary pass + ONE coach-outcome pass", Object.keys(b.diagnostics.reads.lists).length === 19 && Object.values(b.diagnostics.reads.lists).every((n: any) => n === 1) && workSummaryPassStats.passes === 1 && coachOutcomePassStats.passes === 1);
    ck("RD2. Occurrence Financial Outcomes, Work Summary Lines and Work Summary History are never read", !reads().includes("Occurrence Financial Outcomes") && !reads().includes("Work Summary Lines") && !reads().includes("Work Summary History"));
    ck("RD3. Read-only: zero write requests; the stored Work Summary rows are unchanged objects", writes().length === 0 && WS.fields.Status === "Not ready" && WB.fields.Status === "Not ready");
    ck("RD4. The four Slice 8 rules are evaluated and the queue is complete", ["coach_outcome_pending", ...SUMMARY_RULES].every((k) => b.diagnostics.evaluated.some((e: any) => e.ruleKey === k)) && b.complete === true);

    // Determinism.
    mainWorld();
    const again = (await run({}, new Date(NOW.getTime() + 60000))).body;
    ck("I4. Re-evaluation is deterministic: identical case keys and order a minute later", again.cases.map((c: any) => c.caseKey).join(",") === b.cases.map((c: any) => c.caseKey).join(","));
  }

  // ===== Lifecycle transitions (each change is a new read of the same world) =====
  {
    const upd = (rec: AirtableRecord, f: Record<string, any>) => ({ ...rec, fields: { ...rec.fields, ...f } });
    const swap = (list: AirtableRecord[], rec: AirtableRecord) => list.map((x) => (x.id === rec.id ? rec : x));
    // Query finalised -> Finalised: case disappears.
    mainWorld({ summaries: swap(SUMMARIES, upd(WQ, { Status: "Finalised", "Finalised At": "2026-10-01T09:00:00.000Z" })) });
    const fin = (await run()).body;
    ck("Q4. Management finalises the queried summary -> work_summary_queried clears (and no other summary case replaces it)", !find(fin, kQ(WQ)) && !fin.cases.some((c: any) => c.targetIds.summaryId === WQ.id));
    // Query on a FINALISED summary, then reopened (-> Needs review via openStatusFor): queried clears, ready appears.
    const frozenQuery = upd(WQ, { Status: "Queried", "Finalised At": "2026-09-30T20:00:00.000Z" });
    mainWorld({ summaries: swap(SUMMARIES, frozenQuery) });
    const fq = (await run()).body;
    ck("Q5. A query raised on a FINALISED summary -> queried case, frozen=true, previouslyFinalised=true", find(fq, kQ(WQ))?.context.frozen === true && find(fq, kQ(WQ)).context.previouslyFinalised === true);
    mainWorld({ summaries: swap(SUMMARIES, upd(frozenQuery, { Status: "Needs review", "Reopened At": "2026-10-01T09:30:00.000Z" })) });
    const ro = (await run()).body;
    ck("Q6. Management reopens it -> queried case clears; the reopened summary is ready to finalise again (one case, new rule)", !find(ro, kQ(WQ)) && !!find(ro, kR(WQ)) && ro.cases.filter((c: any) => c.targetIds.summaryId === WQ.id).length === 1);
    // Queried with pending items: queried wins, no blocked.
    mainWorld({ allocations: [...ALLOCS, alloc(CW.id, O15.id, { cost: "Draft" })] });
    const qp = (await run()).body;
    ck("Q7. Queried summary WITH pending items -> only the queried case (precedence), pending shown in it", !!find(qp, kQ(WQ)) && !find(qp, kB(WQ)) && find(qp, kQ(WQ)).context.pendingCount === 1 && find(qp, kQ(WQ)).context.canFinaliseNow === false);

    // Ready -> finalised: clears.
    mainWorld({ summaries: swap(SUMMARIES, upd(WR, { Status: "Finalised", "Finalised At": "2026-10-01T09:00:00.000Z" })) });
    ck("R6. Ready summary finalised -> ready case clears", !find((await run()).body, kR(WR)));
    // Stale in the other direction: stored Needs review, but a new Draft allocation appears -> blocked, not ready.
    mainWorld({ allocations: [...ALLOCS, alloc(CR.id, O15.id, { cost: "Draft" })] });
    const sd = (await run()).body;
    ck("R7. STALE stored 'Needs review' but a new pending item exists -> recomputed Not ready -> BLOCKED (never a stale ready case)", !find(sd, kR(WR)) && find(sd, kB(WR))?.context.storedStatusStale === true && find(sd, kB(WR)).context.pendingCostNotConfirmed === 1);
    // Period ends TODAY -> not ready yet (period.end >= today), no case.
    mainWorld({ summaries: swap(SUMMARIES, upd(WS, { "Period End": TODAY })) });
    ck("R8. Period ends today (not over yet) with everything resolved -> no ready case (never inferred from the calendar alone)", !(await run()).body.cases.some((c: any) => c.targetIds.summaryId === WS.id));
    // Ready severity boundary: exactly 3 days after the period ended -> Warning (inclusive).
    mainWorld();
    const edge = (await run({}, new Date("2026-10-03T23:00:00.000Z"))).body;
    const early = (await run({}, new Date("2026-10-03T22:59:59.000Z"))).body;
    ck("R9. Ready: exactly 3 days after Period End -> Warning (inclusive); 1s earlier -> Normal", find(edge, kR(WR))?.severity === "Warning" && find(early, kR(WR))?.severity === "Normal");

    // Blocked -> resolve blockers -> clears (becomes ready).
    const fixed = ALLOCS.map((a) => (aB.some((x) => x.id === a.id) ? { ...a, fields: { ...a.fields, "Cost Status": "Confirmed", "Final Coach Cost": 30, "Coach Outcome": a.fields["Session Occurrence"][0] === O20C.id ? "Paid" : a.fields["Coach Outcome"] } } : a));
    mainWorld({ allocations: fixed });
    const fx = (await run()).body;
    ck("B4. Resolving Bob's blockers (confirm cost, valid cost, decide outcome) -> blocked clears; the summary is ready to finalise", !find(fx, kB(WB)) && !!find(fx, kR(WB)) && !find(fx, kO(O20C, CB)));
    const partial = ALLOCS.map((a) => (a.id === aB[1].id ? { ...a, fields: { ...a.fields, "Cost Status": "Confirmed" } } : a));
    mainWorld({ allocations: partial });
    ck("B5. Resolving only one blocker -> still blocked with the smaller pending count", find((await run()).body, kB(WB))?.context.pendingCount === 2);

    // Coach outcome decided -> clears.
    for (const outcome of ["Paid", "Partial", "Unpaid"]) {
      mainWorld({ allocations: ALLOCS.map((a) => (a.id === aO[0].id ? { ...a, fields: { ...a.fields, "Coach Outcome": outcome } } : a)) });
      ck(`O13. Coach Outcome set to ${outcome} -> the coach_outcome_pending case clears`, !find((await run()).body, kO(O20C, CO)));
    }
    // Parent/Venue-only missing outcome: cancelled occurrence, coach outcome decided, no parent/venue row -> nothing.
    mainWorld({ summaries: [], allocations: [alloc(CO.id, O20C.id, { outcome: "Paid" })], outcomes: [] });
    const pv = (await run({ debug: true })).body;
    ck("O14. Parent / Venue outcome missing but the coach outcome decided -> NO coach_outcome_pending (Finance boundary)", byRule(pv, "coach_outcome_pending").length === 0 && !reads().includes("Occurrence Financial Outcomes"));
    // Duplicate allocations for one coach + occurrence -> one case + issue.
    mainWorld({ summaries: [], allocations: [alloc(CO.id, O20C.id), alloc(CO.id, O20C.id)] });
    const dup = (await run()).body;
    ck("O15. Two undecided allocations for one coach + occurrence -> ONE case listing both + configIssue coach_outcome_duplicate_allocations", byRule(dup, "coach_outcome_pending").length === 1 && find(dup, kO(O20C, CO)).relatedIds.allocationIds.length === 2 && find(dup, kO(O20C, CO)).context.allocationId === null && dup.configIssues.some((i: any) => i.code === "coach_outcome_duplicate_allocations"));
    // Occurrence exactly 48h ago -> Warning (inclusive); 1 ms later start -> Normal.
    const O48 = { id: id("Occ48h"), fields: { Status: "Cancelled", Session: [SES.id], Date: "2026-09-29", "Start Date & Time": new Date(NOW.getTime() - 48 * H).toISOString() } };
    const O48p = { id: id("Occ48hp"), fields: { Status: "Cancelled", Session: [SES.id], Date: "2026-09-29", "Start Date & Time": new Date(NOW.getTime() - 48 * H + 1).toISOString() } };
    mainWorld({ summaries: [], occurrences: [O48, O48p], allocations: [alloc(CO.id, O48.id), alloc(CO.id, O48p.id)] });
    const b48 = (await run()).body;
    ck("O16. Coach outcome Warning boundary is inclusive: exactly 48h after start -> Warning; 48h - 1ms -> Normal", find(b48, kO(O48, CO))?.severity === "Warning" && find(b48, kO(O48p, CO))?.severity === "Normal");
  }

  // ===== Module gating + Settings + caseKey lookup =====
  {
    mainWorld({ moduleOn: false });
    const off = (await run({ debug: true })).body;
    ck("G1. module_coaches off -> no Slice 8 case and NO domain read at all (config tables only)", off.cases.length === 0 && reads().every((t) => Object.values(CONFIG_TABLES).includes(t as any)) && !reads().includes("Coach Work Summaries") && !reads().includes("Coach Allocations"));
    const dis = (k: string, n: number) => setting(k, {}, n);
    const allOff = ["coach_outcome_pending", ...SUMMARY_RULES].map((k, i) => dis(k, i));
    mainWorld({ settings: allOff });
    const d4 = (await run({ debug: true })).body;
    ck("G2. All four Slice 8 rules disabled by Settings -> neither Coach Work Summaries nor Coach Allocations is read (other rules still run)", !reads().includes("Coach Work Summaries") && !reads().includes("Coach Allocations") && reads().includes("Session Staff") && d4.cases.every((c: any) => ![...SUMMARY_RULES, "coach_outcome_pending"].includes(c.ruleKey)));
    mainWorld({ settings: SUMMARY_RULES.map((k, i) => dis(k, i)) });
    const d3 = (await run({ debug: true })).body;
    ck("G3. Only the three summary rules disabled -> Coach Work Summaries NOT read; coach outcome cases still raised from Coach Allocations", !reads().includes("Coach Work Summaries") && reads().includes("Coach Allocations") && summaryCases(d3).length === 0 && byRule(d3, "coach_outcome_pending").length === 8);
    mainWorld({ settings: [dis("coach_outcome_pending", 0)] });
    const d1 = (await run()).body;
    ck("G4. Only coach_outcome_pending disabled -> its cases vanish; summary cases unaffected", byRule(d1, "coach_outcome_pending").length === 0 && summaryCases(d1).length === 4);
    mainWorld();
    const lk = (await run({ caseKey: kB(WB) })).body;
    ck("G5. caseKey lookup of a blocked case evaluates only that rule: 5 config + the 5 Work Summary sources, nothing else", lk.exists === true && reads().length === 10 && reads().includes("Coach Work Summaries") && !reads().includes("Session Staff"));
    mainWorld();
    const lk2 = (await run({ caseKey: kO(O20C, CO) })).body;
    ck("G6. caseKey lookup of a coach outcome case reads 5 config + 4 sources (no Work Summary table)", lk2.exists === true && reads().length === 9 && !reads().includes("Coach Work Summaries"));
  }

  // ===== Exceptions (Supports Override as configured: off for all four) =====
  {
    mainWorld();
    for (const [k, key] of [["coach_outcome_pending", kO(O20C, CO)], ["work_summary_queried", kQ(WQ)], ["work_summary_ready_to_finalise", kR(WR)], ["work_summary_blocked", kB(WB)]] as const) {
      const res = await create({ caseKey: key, reason: "try" });
      ck(`E1. ${k} does not support override -> 403 override_not_supported, nothing written`, res.httpStatus === 403 && res.code === "override_not_supported" && (tables[EXC] ?? []).length === 0);
    }
    const b = (await run()).body;
    ck("E2. exceptionAllowed=false on every Slice 8 case (mirrors the catalogue)", [...byRule(b, "coach_outcome_pending"), ...summaryCases(b)].every((c: any) => c.exceptionAllowed === false));
    // A supported exact-case override still works in the same queue (session_no_coach on a future unstaffed occurrence).
    const OFut = { id: id("OccFuture"), fields: { "Occurrence Name": "Future", Status: "Scheduled", Session: [SES.id], Date: localDateIso(new Date(NOW.getTime() + 3 * D), TZ), "Start Date & Time": new Date(NOW.getTime() + 3 * D).toISOString(), "End Date & Time": new Date(NOW.getTime() + 3 * D + H).toISOString() } };
    mainWorld({ occurrences: [...OCCS, OFut] });
    const nk = `session_no_coach|occurrence:${OFut.id}`;
    const ok = await create({ caseKey: nk, reason: "Holiday week - agreed no staff needed" });
    const after = (await run()).body;
    ck("E3. A supported exact-case override still works alongside (session_no_coach -> 201, suppressed) while Slice 8 cases stay visible", ok.httpStatus === 201 && ok.body.case.suppressed === true && !find(after, nk) && after.summary.suppressed === 1 && !!find(after, kB(WB)));
  }

  // ===== Drift / boundaries =====
  {
    const na = readFileSync(join(FUNCS, "needs-attention", "work-summaries.ts"), "utf8");
    const canonWs = readFileSync(join(FUNCS, "coach-work-summaries", "work-summaries.ts"), "utf8");
    const canonOrch = readFileSync(join(FUNCS, "coach-work-summaries", "orchestrator.ts"), "utf8");
    const blocks = na.split("DO NOT EDIT HERE =====\n").slice(1).map((s) => s.slice(0, s.indexOf("// ===== END COPIED BLOCK =====")));
    const chunks = (s: string) => s.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
    const miss1 = chunks(blocks[0] ?? "").filter((c) => !canonWs.includes(c));
    ck("DR1. Every chunk of the copied Work Summary block appears verbatim in coach-work-summaries/work-summaries.ts (one interpretation of Work Summary status)", blocks.length === 2 && chunks(blocks[0]).length >= 20 && miss1.length === 0 && ["classifyAllocation", "openStatusFor", "summaryStatus", "isFrozen", "isActive", "summaryPeriod", "ukToday"].every((f) => blocks[0].includes(`export function ${f}(`)), miss1.map((m) => m.slice(0, 60)).join(" | "));
    ck("DR2. The copied classification loop (Evaluation + evaluate) is verbatim from coach-work-summaries/orchestrator.ts", canonOrch.includes(blocks[1].trim()) && /function evaluate\(world: World, coachId: string, period: Period, today: string\): Evaluation/.test(blocks[1]));
    ck("DR3. effectiveStatus mirrors applyRefresh: the domain line still reads `prev === \"Queried\" ? \"Queried\" : openStatusFor(ev.pending.length, period, today)`", canonOrch.includes('const next = prev === "Queried" ? "Queried" : openStatusFor(ev.pending.length, period, today);') && canonOrch.includes('if (period.end >= today) return reject(409, "period_not_ended"') && canonOrch.includes("if (ev.pending.length) return reject(409, \"pending_items\""));
    const outcomeLines = ["const needsOutcome = !!occStatus && (OUTCOME_REQUIRED_STATUSES as readonly string[]).includes(occStatus);", "if (needsOutcome && !(outcome && (COACH_OUTCOMES as readonly string[]).includes(outcome))) return pending(\"coach_outcome_undecided\");"];
    ck("DR4. needsCoachOutcome is classifyAllocation's own outcome test (same constants, same two lines)", canonWs.includes(outcomeLines[0]) && canonWs.includes(outcomeLines[1]) && na.includes(outcomeLines[0]) && na.includes("return needsOutcome && !(outcome && (COACH_OUTCOMES as readonly string[]).includes(outcome));") && canonWs.includes('export const OUTCOME_REQUIRED_STATUSES = ["Cancelled", "Postponed"] as const;'));
    const code = na.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("DR5. work-summaries.ts is pure and read-only: no fetch, no Deno, no writes", !/fetch\(|Deno\.|method:|patchRecord|createRecord/.test(code));
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const rowOf = (k: string) => fixture.find((r) => r.ruleKey === k);
    ck("DR6. The four registrations match the TEST catalogue Rule IDs (ATT-043..046), Active, module_coaches, and are in the deployed registry", WORK_SUMMARY_EVALUATORS.length === 4 && WORK_SUMMARY_EVALUATORS.every((e) => rowOf(e.ruleKey)?.ruleId === e.ruleId && rowOf(e.ruleKey)?.evaluationStatus === "Active" && rowOf(e.ruleKey)?.requiredModule === "module_coaches" && IMPLEMENTED_EVALUATORS.includes(e)));
    ck("DR7. Sources: summary rules = Coach Work Summaries + Coach Allocations + Session Occurrences + Sessions + Coaches; coach outcome = the same minus Coach Work Summaries; never Occurrence Financial Outcomes / Lines / History", WORK_SUMMARY_SOURCES.join(",") === "Coach Work Summaries,Coach Allocations,Session Occurrences,Sessions,Coaches" && COACH_OUTCOME_SOURCES.join(",") === "Coach Allocations,Session Occurrences,Sessions,Coaches" && ![...WORK_SUMMARY_SOURCES, ...COACH_OUTCOME_SOURCES].some((t) => /Financial|Lines|History/.test(t)));
    ck("DR8. Finance boundary: no session_change_followup / coach_cost_exception / invoicing rule registered, and ATT-007 / ATT-016 remain unseeded", !IMPLEMENTED_EVALUATORS.some((e) => ["session_change_followup", "coach_cost_exception", "invoicing_period_ready", "payment_revenue_mismatch"].includes(e.ruleKey)) && !rowOf("session_change_followup") && !rowOf("coach_cost_exception") && rowOf("invoicing_period_ready")?.evaluationStatus === "Planned");
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
