// Unit tests for Needs Attention Slice 2 (core engine + read-only API -
// see TEST-ENV.md "Needs Attention Foundation - Slice 2"). Pure rules are
// exercised directly from needs-attention-engine.ts; request-level
// behaviour runs through the REAL orchestrator against an in-memory
// Airtable (mocked global fetch, same convention as the Coaches tests)
// that counts every request per table. Only SYNTHETIC evaluators are
// used - no real Schedule/Coaches rule exists in Slice 2 - and the
// deployed registry is checked to be empty and drift-free.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCaseKey,
  buildCatalogue,
  computeSeverity,
  matchException,
  moduleState,
  parseCaseKey,
  parseException,
  parseRule,
  planEvaluation,
  resolveEffectiveConfig,
  resolveOrganisation,
  scopedCaseIdentity,
  settingsForOrganisation,
  summarise,
  validateRegistry,
  type AirtableRecord,
  type CandidateCase,
  type EvaluatorRegistration,
  type Severity,
} from "./needs-attention-engine.ts";
import { getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";

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
const ORG = id("OrgTest1"), ORG2 = id("OrgOther");
const NOW = new Date("2026-10-01T12:00:00.000Z");
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();
const H = 3600 * 1000, D = 24 * H;

type RuleOpts = Partial<{
  id: string; ruleId: string; name: string; category: string; enabled: boolean; sev: Severity; lock: Severity;
  warn: [number, string]; urg: [number, string]; override: boolean; custom: boolean; module: string; status: string; active: boolean; sort: number; dest: string; action: string;
}>;
function rule(key: string, o: RuleOpts = {}): AirtableRecord {
  const f: Record<string, any> = {
    "Rule Name": o.name ?? `Rule ${key}`,
    "Rule ID": o.ruleId ?? `ATT-9${key.length}${key.charCodeAt(0)}`,
    "Rule Key": key,
    "Category": o.category ?? "Staffing & Cover",
    "Default Base Severity": o.sev ?? "Normal",
    "Action Label": o.action ?? "Review",
    "Destination Area": o.dest ?? "Coaches",
    "Required Module": o.module ?? "module_alpha",
    "Evaluation Status": o.status ?? "Active",
    "Sort Order": o.sort ?? 1,
  };
  if (o.enabled ?? true) f["Default Enabled"] = true;
  if (o.active ?? true) f["Active"] = true;
  if (o.override ?? true) f["Supports Override"] = true;
  if (o.custom ?? true) f["Client Customisable"] = true;
  if (o.lock) f["Locked Minimum Severity"] = o.lock;
  if (o.warn) Object.assign(f, { "Supports Warning Threshold": true, "Default Warning Threshold": o.warn[0], "Default Warning Timing": o.warn[1] });
  if (o.urg) Object.assign(f, { "Supports Urgent Threshold": true, "Default Urgent Threshold": o.urg[0], "Default Urgent Timing": o.urg[1] });
  return { id: o.id ?? id("Rule" + key.replace(/_/g, "")), fields: f };
}
const feature = (key: string, enabled: boolean): AirtableRecord => ({ id: id("Feat" + key.slice(7)), fields: enabled ? { "Feature Key": key, "Enabled": true } : { "Feature Key": key } });
const orgRow = (rid: string, orgId: string, active = true): AirtableRecord => ({ id: rid, fields: { "Organisation ID": orgId, "Organisation Name": `Org ${orgId}`, "Timezone": "Europe/London", ...(active ? { Active: true } : {}) } });
function setting(ruleRid: string, fields: Record<string, any>, orgs = [ORG]): AirtableRecord {
  return { id: id("Set" + ruleRid.slice(3, 9) + Object.keys(fields).length + orgs.length), fields: { "Organisation": orgs, "Rule": [ruleRid], ...fields } };
}
function exception(ruleRid: string, caseKey: string, fields: Record<string, any> = {}, orgs = [ORG]): AirtableRecord {
  return { id: id("Exc" + caseKey.replace(/[^A-Za-z0-9]/g, "").slice(-8)), fields: { "Exception ID": "NAE-1", "Organisation": orgs, "Rule": [ruleRid], "Case Key": caseKey, "Active": true, ...fields } };
}

let evalCalls: Record<string, number> = {};
function synEval(ruleKey: string, ruleId: string, sources: string[], make: (ctx: any) => CandidateCase[]): EvaluatorRegistration {
  return { ruleKey, ruleId, sources, evaluate: (ctx) => { evalCalls[ruleKey] = (evalCalls[ruleKey] ?? 0) + 1; return make(ctx); } };
}
const one = (ids: string[], extra: Partial<CandidateCase> = {}): CandidateCase[] => ids.map((x) => ({ subjects: [{ type: "occurrence", id: x }], title: `Case ${x}`, detail: "synthetic", ...extra }));

// ---------------------------------------------------------------------
// In-memory Airtable (mocked global fetch) with per-table request counts
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: string[] = [];
let failTable: string | null = null;
const PAGE = 3;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected write ${init?.method} ${url}`);
  const table = decodeURIComponent(u.pathname.split("/")[3]);
  requests.push(table);
  if (table === failTable) return new Response("boom", { status: 500 });
  const rows = tables[table] ?? [];
  const start = Number(u.searchParams.get("offset") || 0);
  const body: any = { records: rows.slice(start, start + PAGE).map((r) => ({ id: r.id, fields: r.fields, createdTime: "2026-09-01T00:00:00.000Z" })) };
  if (start + PAGE < rows.length) body.offset = String(start + PAGE);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};
RETRY_DELAYS_MS.length = 0;

const MGMT: Caller = { userId: "u-mgr", role: "management", active: true, organisationId: "ORG-TEST-001" };
function world(opts: { rules: AirtableRecord[]; settings?: AirtableRecord[]; exceptions?: AirtableRecord[]; features?: AirtableRecord[]; orgs?: AirtableRecord[]; extra?: Record<string, AirtableRecord[]> }) {
  tables = {
    [CONFIG_TABLES.rules]: opts.rules,
    [CONFIG_TABLES.settings]: opts.settings ?? [],
    [CONFIG_TABLES.exceptions]: opts.exceptions ?? [],
    [CONFIG_TABLES.features]: opts.features ?? [feature("module_alpha", true), feature("module_beta", true)],
    [CONFIG_TABLES.organisations]: opts.orgs ?? [orgRow(ORG, "ORG-TEST-001")],
    ...(opts.extra ?? {}),
  };
  requests = [];
  evalCalls = {};
}
const deps = (registry: EvaluatorRegistration[]): Deps => ({ airtable: { baseId: "appTESTTESTTEST01", token: "t" }, registry });
async function run(registry: EvaluatorRegistration[], query: any = {}, caller: Caller = MGMT, now = NOW) {
  return getCases(deps(registry), caller, query, now) as Promise<any>;
}
const count = (t: string) => requests.filter((r) => r === t).length;

async function main() {
  // ===== Defaults / Settings inheritance =====
  {
    const A = rule("syn_alpha", { ruleId: "ATT-901" });
    const B = rule("syn_beta", { ruleId: "ATT-902", enabled: false });
    const reg = [synEval("syn_alpha", "ATT-901", [], () => one(["recA0000000000001"])), synEval("syn_beta", "ATT-902", [], () => one(["recB0000000000001"]))];
    world({ rules: [A, B] });
    const r1 = await run(reg, { debug: true });
    ck("1. Default Enabled = Yes with NO Settings row -> the rule is evaluated", r1.status === "ok" && evalCalls.syn_alpha === 1 && r1.body.cases.length === 1 && r1.body.cases[0].ruleKey === "syn_alpha");
    const skB = r1.body.diagnostics.skipped.find((s: any) => s.ruleKey === "syn_beta");
    ck("2. Default Enabled = No (no Settings row) -> not evaluated, reason 'disabled'", !evalCalls.syn_beta && skB?.reason === "disabled");

    world({ rules: [A, B], settings: [setting(A.id, { "Setting ID": "S1" })] });
    const r3 = await run(reg, { debug: true });
    ck("3. A Settings row with Enabled unchecked disables a default-on rule (reason 'settings_disabled')", !evalCalls.syn_alpha && r3.body.diagnostics.skipped.find((s: any) => s.ruleKey === "syn_alpha")?.reason === "settings_disabled");

    world({ rules: [A, B], settings: [setting(B.id, { "Enabled": true })] });
    const r4 = await run(reg);
    ck("4. Settings Enabled = Yes turns ON a default-off Client Customisable rule", evalCalls.syn_beta === 1 && r4.body.cases.some((c: any) => c.ruleKey === "syn_beta"));

    const Bfixed = rule("syn_beta", { ruleId: "ATT-902", enabled: false, custom: false });
    world({ rules: [A, Bfixed], settings: [setting(Bfixed.id, { "Enabled": true, "Base Severity": "Urgent" })] });
    const r5 = await run(reg, { debug: true });
    const cfg5 = resolveEffectiveConfig(parseRule(Bfixed), settingsForOrganisation([setting(Bfixed.id, { "Enabled": true })], ORG).byRuleRecordId.get(Bfixed.id));
    ck("5. Settings on a NON-customisable rule are ignored: defaults apply, reason recorded", !evalCalls.syn_beta && r5.body.diagnostics.skipped.find((s: any) => s.ruleKey === "syn_beta")?.reason === "disabled" && cfg5.settingsIgnoredReason === "rule_not_client_customisable" && cfg5.enabledSource === "default");

    const W = parseRule(rule("syn_w", { warn: [48, "Hours Overdue"], urg: [24, "Hours Before"], sev: "Normal" }));
    const s6 = settingsForOrganisation([setting(W.recordId, { "Enabled": true, "Base Severity": "Warning", "Urgent Threshold": 6 })], ORG).byRuleRecordId.get(W.recordId);
    const c6 = resolveEffectiveConfig(W, s6);
    ck("6. Blank Settings values inherit Rule defaults field-by-field (warning 48h Overdue kept; urgent 6 + default timing Hours Before)", c6.baseSeverity === "Warning" && c6.warning?.value === 48 && c6.warning?.timing === "Hours Overdue" && c6.urgent?.value === 6 && c6.urgent?.timing === "Hours Before" && c6.settingsApplied);

    world({ rules: [A], settings: [setting(A.id, {}, [ORG2])] });
    await run(reg);
    ck("7. A Settings row belonging to ANOTHER organisation is ignored (rule stays default-on)", evalCalls.syn_alpha === 1);

    const sc = settingsForOrganisation([setting(A.id, { "Enabled": true }), { ...setting(A.id, {}), id: id("SetDup") }], ORG);
    ck("8. Two Settings rows for one rule = conflict: both ignored (defaults apply) and reported", sc.byRuleRecordId.size === 0 && sc.issues.some((i) => i.code === "settings_conflict"));

    const O = parseRule(rule("syn_o", { override: true }));
    const N = parseRule(rule("syn_n", { override: false }));
    const s9 = settingsForOrganisation([setting(O.recordId, { "Enabled": true })], ORG).byRuleRecordId.get(O.recordId);
    const s9b = settingsForOrganisation([setting(N.recordId, { "Enabled": true, "Allow Override": true })], ORG).byRuleRecordId.get(N.recordId);
    ck("9. Allow Override narrows only: row without it disables override; row with it cannot widen a no-override rule", resolveEffectiveConfig(O, undefined).overrideAllowed === true && resolveEffectiveConfig(O, s9).overrideAllowed === false && resolveEffectiveConfig(N, s9b).overrideAllowed === false);

    const inval = settingsForOrganisation([{ id: id("SetBad"), fields: { Organisation: [ORG, ORG2], Rule: [A.id], Enabled: true } }], ORG);
    ck("10. A Settings row linked to two organisations is invalid and ignored (reported)", inval.byRuleRecordId.size === 0 && inval.issues.some((i) => i.code === "settings_row_invalid"));
  }

  // ===== Modules =====
  {
    const A = rule("syn_alpha", { ruleId: "ATT-901", module: "module_alpha" });
    const reg = [synEval("syn_alpha", "ATT-901", ["Domain A"], () => one(["recA0000000000001"]))];
    world({ rules: [A], features: [feature("module_alpha", false)], extra: { "Domain A": [{ id: id("DomA1"), fields: {} }] } });
    const m1 = await run(reg, { debug: true });
    ck("11. Module disabled -> rule not evaluated (reason module_off) and its domain source is NOT read", !evalCalls.syn_alpha && m1.body.diagnostics.skipped[0].reason === "module_off" && count("Domain A") === 0 && m1.body.summary.state === "Clear");
    world({ rules: [A], features: [], extra: { "Domain A": [] } });
    const m2 = await run(reg, { debug: true });
    ck("12. Missing module row = module OFF (fail closed)", !evalCalls.syn_alpha && /missing/.test(m2.body.diagnostics.skipped[0].detail) && count("Domain A") === 0);
    world({ rules: [A], extra: { "Domain A": [] } });
    await run(reg);
    ck("13. Module enabled -> rule evaluated and its source read once", evalCalls.syn_alpha === 1 && count("Domain A") === 1);
    ck("14. Conflicting module rows (one on, one off) -> module OFF", moduleState([feature("module_x", true), { ...feature("module_x", false), id: id("FeatX2") }], "module_x").active === false);
  }

  // ===== Evaluation Status / catalogue =====
  {
    const mk = (k: string, o: RuleOpts) => rule(k, { ruleId: `ATT-${k.length}${k.charCodeAt(4)}`, ...o });
    const rows = [mk("syn_act", {}), mk("syn_plan", { status: "Planned" }), mk("syn_ret", { status: "Retired" }), mk("syn_off", { active: false }), mk("syn_bad", { status: "Draft" }), mk("syn_noev", {})];
    const reg = ["syn_act", "syn_plan", "syn_ret", "syn_off", "syn_bad"].map((k) => synEval(k, parseRule(rows.find((r) => r.fields["Rule Key"] === k)!).ruleId!, [], () => one(["recS0000000000001"])));
    world({ rules: rows });
    const s = await run(reg, { debug: true });
    const why = (k: string) => s.body.diagnostics.skipped.find((x: any) => x.ruleKey === k)?.reason;
    ck("15. Active + registered evaluator + module on + enabled -> evaluated", evalCalls.syn_act === 1);
    ck("16. Planned never evaluates (even with an evaluator, module on, default on)", !evalCalls.syn_plan && why("syn_plan") === "planned");
    ck("17. Retired never evaluates", !evalCalls.syn_ret && why("syn_ret") === "retired");
    ck("18. Inactive catalogue row never evaluates", !evalCalls.syn_off && why("syn_off") === "inactive");
    ck("19. Unknown Evaluation Status never evaluates", !evalCalls.syn_bad && why("syn_bad") === "invalid_status");
    ck("20. Active rule with NO registered evaluator is skipped as not_implemented (existing in Airtable is not enough)", why("syn_noev") === "not_implemented");
    const dup = buildCatalogue([rule("syn_dup", { id: id("D1") }), rule("syn_dup", { id: id("D2") }), { id: id("NoKey"), fields: { "Rule Name": "x" } }]);
    ck("21. Duplicate Rule Keys are excluded entirely and reported; a row without a key is reported", dup.byKey.size === 0 && dup.issues.some((i) => i.code === "rule_key_duplicate") && dup.issues.some((i) => i.code === "rule_key_invalid"));
  }

  // ===== Registry drift =====
  {
    const cat = [{ ruleKey: "syn_a", ruleId: "ATT-801" }, { ruleKey: "syn_b", ruleId: "ATT-802" }];
    const noop = () => [];
    const iss = validateRegistry([
      { ruleKey: "syn_a", ruleId: "ATT-801", sources: [], evaluate: noop },
      { ruleKey: "syn_a", ruleId: "ATT-801", sources: [], evaluate: noop },
      { ruleKey: "syn_missing", ruleId: "ATT-899", sources: [], evaluate: noop },
      { ruleKey: "syn_b", ruleId: "ATT-999", sources: [], evaluate: noop },
    ], cat);
    ck("22. Drift: duplicate registration detected", iss.some((i) => i.code === "duplicate_registration" && i.ruleKey === "syn_a"));
    ck("23. Drift: evaluator without a catalogue row detected", iss.some((i) => i.code === "missing_catalogue_row" && i.ruleKey === "syn_missing"));
    ck("24. Drift: evaluator pointing at the wrong Rule ID detected", iss.some((i) => i.code === "rule_id_mismatch" && i.ruleKey === "syn_b"));
    ck("25. Drift: catalogue rules without an evaluator are NOT an issue (added progressively)", validateRegistry([], cat).length === 0);
    const B = rule("syn_b", { ruleId: "ATT-802" });
    world({ rules: [B] });
    const rr = await run([synEval("syn_b", "ATT-999", [], () => one(["recB0000000000001"]))], { debug: true });
    ck("26. Runtime: a registration whose Rule ID disagrees with the catalogue is skipped (registry_mismatch) and reported", !evalCalls.syn_b && rr.body.diagnostics.skipped[0].reason === "registry_mismatch" && rr.body.configIssues.some((i: any) => i.code === "registry_rule_id_mismatch"));
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    ck("27. Deployed registry = exactly the four Slice 3 staffing rules + the Slice 4 cover_open rule + the three Slice 6 compliance rules + the two Slice 7 coach-schedule rules + the four Slice 8 coach outcome / work summary rules + the Finance F8a invoice_overdue rule + the F8b invoice_draft_blocked rule + the five F16 Money Out rules + the F17 cash_balance_below_threshold rule (nothing else registered)", IMPLEMENTED_EVALUATORS.map((e) => e.ruleKey).sort().join(",") === "assigned_coach_unavailable,cash_balance_below_threshold,coach_compliance_expiry,coach_outcome_pending,coach_schedule_conflict,compliance_verification_pending,cover_open,invoice_draft_blocked,invoice_overdue,learning_coach_only,no_lead_coach,non_compliant_coach_assigned,outgoing_estimate_due_soon,outgoing_estimate_due_today,outgoing_estimate_overdue,outgoing_payment_due_today,outgoing_payment_overdue,session_no_coach,session_understaffed,work_summary_blocked,work_summary_queried,work_summary_ready_to_finalise");
    ck("28. Deployed registry validates cleanly against the TEST catalogue fixture (46 rules after F17, unique keys/IDs)", validateRegistry(IMPLEMENTED_EVALUATORS, fixture).length === 0 && fixture.length === 46 && new Set(fixture.map((r) => r.ruleKey)).size === 46 && new Set(fixture.map((r) => r.ruleId)).size === 46);
  }

  // ===== Severity =====
  {
    const base = (o: Partial<{ baseSeverity: Severity; warning: any; urgent: any; lockedMinimum: Severity | null }>) => ({ baseSeverity: "Normal" as Severity, warning: null, urgent: null, lockedMinimum: null, ...o });
    const W48 = { value: 48, timing: "Hours Overdue" }, U24 = { value: 24, timing: "Hours Before" };
    ck("29. Normal base with no thresholds -> Normal", computeSeverity(base({}), {}, NOW).severity === "Normal");
    ck("30. Warning threshold (48h overdue) reached EXACTLY at the boundary -> Warning (inclusive)", computeSeverity(base({ warning: W48 }), { outstandingSince: iso(-48 * H) }, NOW).severity === "Warning");
    ck("31. ...1 ms short of the Warning boundary -> still Normal", computeSeverity(base({ warning: W48 }), { outstandingSince: iso(-48 * H + 1) }, NOW).severity === "Normal");
    ck("32. Urgent threshold (24h before) reached EXACTLY at the boundary -> Urgent (inclusive)", computeSeverity(base({ urgent: U24 }), { event: iso(24 * H) }, NOW).severity === "Urgent");
    ck("33. ...1 ms outside the Urgent window -> not Urgent", computeSeverity(base({ urgent: U24 }), { event: iso(24 * H + 1) }, NOW).severity === "Normal");
    const both = computeSeverity(base({ warning: W48, urgent: U24 }), { outstandingSince: iso(-72 * H), event: iso(2 * H) }, NOW);
    ck("34. Warning and Urgent both reached -> Urgent wins (reason lists both)", both.severity === "Urgent" && /Warning threshold/.test(both.reason) && /Urgent threshold/.test(both.reason));
    ck("35. Locked Minimum Warning lifts a Normal case to Warning", computeSeverity(base({ lockedMinimum: "Warning" }), {}, NOW).severity === "Warning");
    ck("36. Locked Minimum Urgent lifts to Urgent", computeSeverity(base({ lockedMinimum: "Urgent" }), {}, NOW).severity === "Urgent");
    ck("37. Missing anchor -> that threshold cannot escalate (no guessing)", computeSeverity(base({ warning: W48, urgent: U24 }), {}, NOW).severity === "Normal");
    ck("38. Days units are 24h spans (2 Days Before, event in exactly 48h -> Warning)", computeSeverity(base({ warning: { value: 2, timing: "Days Before" } }), { event: iso(48 * H) }, NOW).severity === "Warning");
    ck("39. Evaluator state severity (e.g. Expired = Urgent) is honoured but never lowers", computeSeverity(base({ baseSeverity: "Warning" }), {}, NOW, "Urgent").severity === "Urgent" && computeSeverity(base({ baseSeverity: "Urgent" }), {}, NOW, "Normal").severity === "Urgent");
    const L = parseRule(rule("syn_l", { sev: "Warning", lock: "Warning" }));
    const low = resolveEffectiveConfig(L, settingsForOrganisation([setting(L.recordId, { "Enabled": true, "Base Severity": "Normal" })], ORG).byRuleRecordId.get(L.recordId));
    ck("40. Settings cannot push severity below the Locked Minimum (Normal override -> Warning)", computeSeverity(low, {}, NOW).severity === "Warning");
    const noSup = parseRule(rule("syn_ns", {}));
    const cfgNs = resolveEffectiveConfig(noSup, settingsForOrganisation([setting(noSup.recordId, { "Enabled": true, "Warning Threshold": 1, "Warning Timing": "Hours Overdue" })], ORG).byRuleRecordId.get(noSup.recordId));
    ck("41. A Settings threshold on a rule that does not support it is ignored", cfgNs.warning === null && computeSeverity(cfgNs, { outstandingSince: iso(-5 * D) }, NOW).severity === "Normal");

    // end-to-end through the orchestrator with rule defaults
    const C = rule("syn_cover", { ruleId: "ATT-941", warn: [48, "Hours Overdue"], urg: [24, "Hours Before"] });
    world({ rules: [C] });
    const out = await run([synEval("syn_cover", "ATT-941", [], () => [
      { subjects: [{ type: "coverdate", id: "recCD000000000001" }], anchors: { outstandingSince: iso(-1 * H), event: iso(5 * D) } },
      { subjects: [{ type: "coverdate", id: "recCD000000000002" }], anchors: { outstandingSince: iso(-49 * H), event: iso(5 * D) } },
      { subjects: [{ type: "coverdate", id: "recCD000000000003" }], anchors: { outstandingSince: iso(-49 * H), event: iso(3 * H) } },
    ])]);
    const sevOf = (k: string) => out.body.cases.find((c: any) => c.caseKey.endsWith(k))?.severity;
    ck("42. Orchestrator applies catalogue thresholds per case (Normal / Warning / Urgent) with Urgent winning", sevOf("0001") === "Normal" && sevOf("0002") === "Warning" && sevOf("0003") === "Urgent");
  }

  // ===== Exceptions =====
  {
    const A = rule("syn_alpha", { ruleId: "ATT-901" });
    const X = rule("syn_other", { ruleId: "ATT-903" });
    const KEY = "syn_alpha|occurrence:recA0000000000001";
    const reg = [synEval("syn_alpha", "ATT-901", [], () => one(["recA0000000000001", "recA0000000000002"]))];
    const runWith = async (exc: AirtableRecord[], extra: Partial<{ rules: AirtableRecord[]; settings: AirtableRecord[] }> = {}) => {
      world({ rules: extra.rules ?? [A, X], exceptions: exc, settings: extra.settings });
      return run(reg, { debug: true });
    };
    const e1 = await runWith([exception(A.id, KEY)]);
    ck("43. Exact exception (org + rule + Case Key + Active) suppresses that case only", e1.body.cases.length === 1 && e1.body.summary.suppressed === 1 && e1.body.diagnostics.suppressedCases[0].caseKey === KEY);
    ck("44. Exception for another organisation does not suppress", (await runWith([exception(A.id, KEY, {}, [ORG2])])).body.summary.suppressed === 0);
    ck("45. Exception linked to another rule does not suppress", (await runWith([exception(X.id, KEY)])).body.summary.suppressed === 0);
    ck("46. Exception with a different Case Key does not suppress", (await runWith([exception(A.id, "syn_alpha|occurrence:recA0000000000009")])).body.summary.suppressed === 0);
    ck("47. Expired exception (Effective Until in the past) does not suppress", (await runWith([exception(A.id, KEY, { "Effective Until": iso(-1) })])).body.summary.suppressed === 0);
    ck("48. Exception expiring exactly NOW no longer suppresses (until must be strictly in the future)", (await runWith([exception(A.id, KEY, { "Effective Until": NOW.toISOString() })])).body.summary.suppressed === 0);
    ck("49. Exception with a future Effective Until suppresses", (await runWith([exception(A.id, KEY, { "Effective Until": iso(D) })])).body.summary.suppressed === 1);
    const inactive = exception(A.id, KEY);
    delete inactive.fields["Active"];
    ck("50. Inactive exception does not suppress", (await runWith([inactive])).body.summary.suppressed === 0);
    const Anov = rule("syn_alpha", { ruleId: "ATT-901", override: false });
    const e51 = await runWith([exception(Anov.id, KEY)], { rules: [Anov, X] });
    ck("51. Rule that does not Support Override cannot be suppressed (exceptionAllowed=false)", e51.body.summary.suppressed === 0 && e51.body.cases.every((c: any) => c.exceptionAllowed === false));
    ck("52. Organisation Settings row without Allow Override blocks suppression", (await runWith([exception(A.id, KEY)], { settings: [setting(A.id, { "Enabled": true })] })).body.summary.suppressed === 0);
    ck("53. Exception whose Case Key rule segment differs from its Rule is never matched", matchException([parseException(exception(A.id, "syn_other|occurrence:recA0000000000001"))], { organisationRecordId: ORG, rule: parseRule(A), caseKey: "syn_other|occurrence:recA0000000000001", overrideAllowed: true, now: NOW }) === null);
    ck("54. Unparseable Effective Until fails safe (case stays visible)", (await runWith([exception(A.id, KEY, { "Effective Until": "not-a-date" })])).body.summary.suppressed === 0);
  }

  // ===== Summary =====
  {
    const s0 = summarise([]);
    ck("55. Zero cases -> Clear", s0.state === "Clear" && s0.total === 0 && s0.counts.Normal === 0 && s0.counts.Warning === 0 && s0.counts.Urgent === 0);
    ck("56. Only Normal -> Normal", summarise([{ severity: "Normal" }, { severity: "Normal" }]).state === "Normal");
    const s2 = summarise([{ severity: "Normal" }, { severity: "Warning" }, { severity: "Warning" }], 3);
    ck("57. Any Warning, no Urgent -> Warning; counts and suppressed correct", s2.state === "Warning" && s2.total === 3 && s2.counts.Normal === 1 && s2.counts.Warning === 2 && s2.counts.Urgent === 0 && s2.suppressed === 3);
    ck("58. Any Urgent -> Urgent", summarise([{ severity: "Normal" }, { severity: "Urgent" }, { severity: "Warning" }]).state === "Urgent");
  }

  // ===== Identity =====
  {
    const k1 = buildCaseKey("no_lead_coach", [{ type: "occurrence", id: "recABC00000000001" }]);
    const k2 = buildCaseKey("no_lead_coach", [{ type: "occurrence", id: "recABC00000000001" }]);
    ck("59. Case Keys are deterministic and follow ruleKey|type:id", k1 === k2 && k1 === "no_lead_coach|occurrence:recABC00000000001");
    const multi = buildCaseKey("coach_compliance_expiry", [{ type: "coach", id: "rec456" }, { type: "requirement", id: "rec789" }]);
    const p = parseCaseKey(multi);
    ck("60. Multi-subject keys keep segment order and round-trip through parseCaseKey", multi === "coach_compliance_expiry|coach:rec456|requirement:rec789" && p?.ruleKey === "coach_compliance_expiry" && p?.subjects.length === 2 && p.subjects[1].type === "requirement");
    let threw = 0;
    for (const bad of [[{ type: "coach", id: "First Aid" }], [{ type: "coach", id: "a|b" }], [{ type: "Coach", id: "rec1" }], []]) {
      try { buildCaseKey("x_rule", bad as any); } catch { threw++; }
    }
    ck("61. Labels / separators / bad types / empty subjects are rejected in Case Keys", threw === 4 && parseCaseKey("x_rule|coach:First Aid") === null && parseCaseKey("x_rule") === null && parseCaseKey("Bad|a:b") === null);
    ck("62. Same Case Key in two organisations yields different scoped identities (no collision)", scopedCaseIdentity(ORG, "no_lead_coach", k1) !== scopedCaseIdentity(ORG2, "no_lead_coach", k1));
    const A = rule("syn_alpha", { ruleId: "ATT-901" });
    world({ rules: [A] });
    const d = await run([synEval("syn_alpha", "ATT-901", [], () => [...one(["recA0000000000001"]), ...one(["recA0000000000001"]), { subjects: [{ type: "occurrence", id: "bad id" }] }])]);
    ck("63. Duplicate candidate keys are deduplicated and invalid ones dropped, both reported", d.body.cases.length === 1 && d.body.configIssues.some((i: any) => i.code === "case_key_duplicate") && d.body.configIssues.some((i: any) => i.code === "case_key_invalid"));
  }

  // ===== Organisation resolution / security =====
  {
    const orgs = [orgRow(ORG, "ORG-TEST-001")];
    ck("64. Caller ORG-TEST-001 resolves to exactly one active organisation", (() => { const r = resolveOrganisation("ORG-TEST-001", orgs); return r.ok && r.organisation.recordId === ORG; })());
    ck("65. The old ID ORG-JOSHEVANS is NOT accepted (no aliases)", resolveOrganisation("ORG-JOSHEVANS", orgs).ok === false);
    ck("66. An inactive matching row does not count", resolveOrganisation("ORG-TEST-001", [orgRow(ORG, "ORG-TEST-001", false)]).ok === false);
    const A = rule("syn_alpha", { ruleId: "ATT-901" });
    const reg = [synEval("syn_alpha", "ATT-901", ["Domain A"], () => one(["recA0000000000001"]))];
    world({ rules: [A], orgs: [orgRow(ORG, "ORG-OTHER")], extra: { "Domain A": [] } });
    const nf = await run(reg);
    ck("67. No matching organisation -> 409 organisation_not_found; nothing evaluated, no domain read", nf.status === "rejected" && nf.httpStatus === 409 && nf.code === "organisation_not_found" && !evalCalls.syn_alpha && count("Domain A") === 0);
    world({ rules: [A], orgs: [orgRow(ORG, "ORG-TEST-001"), orgRow(ORG2, "ORG-TEST-001")], extra: { "Domain A": [] } });
    const amb = await run(reg);
    ck("68. Two active matching organisations -> 409 organisation_ambiguous; nothing evaluated", amb.status === "rejected" && amb.code === "organisation_ambiguous" && !evalCalls.syn_alpha);
    world({ rules: [A], orgs });
    const empty = await run(reg, {}, { ...MGMT, organisationId: null });
    ck("69. Profile without an organisation -> fail closed", empty.status === "rejected" && empty.code === "organisation_not_found");
    world({ rules: [A], orgs });
    const coach = await run(reg, {}, { ...MGMT, role: "coach" });
    const parent = await run(reg, {}, { ...MGMT, role: "parent" });
    const inactiveMgr = await run(reg, {}, { ...MGMT, active: false });
    ck("70. Coach / Parent / inactive Management -> 403 before ANY Airtable read", coach.httpStatus === 403 && parent.httpStatus === 403 && inactiveMgr.httpStatus === 403 && requests.length === 0);
  }

  // ===== API payload contract =====
  {
    const A = rule("syn_alpha", { ruleId: "ATT-901", name: "Synthetic Alpha", category: "Staffing & Cover", dest: "Schedule & Sessions", action: "Review Staffing", sort: 5, warn: [48, "Hours Overdue"] });
    const B = rule("syn_beta", { ruleId: "ATT-902", sort: 2, sev: "Urgent" });
    const reg = [
      synEval("syn_alpha", "ATT-901", ["Domain A"], () => [
        { subjects: [{ type: "occurrence", id: "recA0000000000002" }], title: "Later", detail: "d2", anchors: { event: iso(3 * D), outstandingSince: iso(-1 * H) }, destination: { route: "/schedule/occurrence", params: { occurrenceId: "recA0000000000002" } }, targetIds: { occurrenceId: "recA0000000000002" }, relatedIds: { coachIds: ["recC0000000000001"] } },
        { subjects: [{ type: "occurrence", id: "recA0000000000001" }], title: "Sooner", detail: "d1", anchors: { event: iso(1 * D), outstandingSince: iso(-50 * H) } },
        { subjects: [{ type: "occurrence", id: "recA0000000000003" }], title: "Normal soon", detail: "d3", anchors: { event: iso(2 * H), outstandingSince: iso(-1 * H) } },
      ]),
      synEval("syn_beta", "ATT-902", ["Domain A"], () => one(["recB0000000000001"])),
    ];
    world({ rules: [A, B], extra: { "Domain A": [{ id: id("DomA1"), fields: {} }] } });
    const full = await run(reg);
    const b = full.body;
    ck("71. Full payload: engine, organisation (ORG-TEST-001), generatedAt, complete, summary, cases, configIssues", b.engine === "needs-attention-slice-8" && b.organisation.organisationId === "ORG-TEST-001" && b.generatedAt === NOW.toISOString() && b.complete === true && b.summary && Array.isArray(b.cases) && Array.isArray(b.configIssues) && !("diagnostics" in b));
    const c0 = b.cases.find((c: any) => c.caseKey === "syn_alpha|occurrence:recA0000000000002");
    const REQUIRED = ["caseKey", "ruleId", "ruleKey", "ruleName", "category", "module", "severity", "severityReason", "title", "detail", "actionLabel", "destination", "targetIds", "relatedIds", "context", "anchorTime", "exceptionAllowed"];
    ck("72. Every case carries the full display contract (no client-side joins needed)", b.cases.every((c: any) => REQUIRED.every((k) => k in c)) && c0.ruleName === "Synthetic Alpha" && c0.actionLabel === "Review Staffing" && c0.destination.area === "Schedule & Sessions" && c0.destination.route === "/schedule/occurrence" && c0.destination.params.occurrenceId === "recA0000000000002" && c0.targetIds.occurrenceId === "recA0000000000002" && c0.relatedIds.coachIds[0] === "recC0000000000001" && c0.anchorTime === iso(3 * D) && c0.module === "module_alpha");
    ck("73. Ordering: Urgent first, then rule Sort Order, then earliest anchor, then Case Key", b.cases.map((c: any) => c.caseKey).join(",") === ["syn_beta|occurrence:recB0000000000001", "syn_alpha|occurrence:recA0000000000001", "syn_alpha|occurrence:recA0000000000003", "syn_alpha|occurrence:recA0000000000002"].join(","), b.cases.map((c: any) => c.caseKey + ":" + c.severity).join(","));
    ck("74. Summary state/counts match the cases", b.summary.state === "Urgent" && b.summary.total === 4 && b.summary.counts.Urgent === 1 && b.summary.counts.Warning === 1 && b.summary.counts.Normal === 2);
    world({ rules: [A, B], extra: { "Domain A": [] } });
    const sm = await run(reg, { view: "summary" });
    ck("75. view=summary returns summary only (no cases list)", sm.status === "ok" && sm.body.summary && !("cases" in sm.body) && !("configIssues" in sm.body));
    world({ rules: [A, B], extra: { "Domain A": [] } });
    const lk = await run(reg, { caseKey: "syn_alpha|occurrence:recA0000000000001" });
    ck("76. caseKey lookup -> exists:true with the full case, and only that rule is evaluated", lk.body.exists === true && lk.body.case?.caseKey === "syn_alpha|occurrence:recA0000000000001" && lk.body.rule.evaluated === true && evalCalls.syn_alpha === 1 && !evalCalls.syn_beta);
    world({ rules: [A, B], extra: { "Domain A": [] } });
    const lk2 = await run(reg, { caseKey: "syn_alpha|occurrence:recNOPE00000000001" });
    ck("77. caseKey lookup for a case that does not exist -> exists:false", lk2.body.exists === false && lk2.body.case === null);
    world({ rules: [A, B], exceptions: [exception(A.id, "syn_alpha|occurrence:recA0000000000001")], extra: { "Domain A": [] } });
    const lk3 = await run(reg, { caseKey: "syn_alpha|occurrence:recA0000000000001" });
    ck("78. caseKey lookup of a suppressed case -> exists:false, suppressed:true", lk3.body.exists === false && lk3.body.suppressed === true);
    world({ rules: [A, B] });
    const lk4 = await run(reg, { caseKey: "unknown_rule|occurrence:recX" });
    ck("79. caseKey for a rule not in the catalogue -> exists:false, skipReason unknown_rule", lk4.status === "ok" && lk4.body.exists === false && lk4.body.rule.skipReason === "unknown_rule");
    const badKey = await run(reg, { caseKey: "not a key" });
    const badView = await run(reg, { view: "everything" });
    ck("80. Invalid caseKey / view -> 400 without evaluating", badKey.httpStatus === 400 && badKey.code === "invalid_case_key" && badView.httpStatus === 400);
    world({ rules: [A, B], extra: { "Domain A": [] } });
    const boom = await run([reg[0], synEval("syn_beta", "ATT-902", ["Domain A"], () => { throw new Error("synthetic failure"); })]);
    ck("81. An evaluator that throws marks the queue incomplete and is reported; other rules' cases still returned", boom.body.complete === false && boom.body.configIssues.some((i: any) => i.code === "evaluator_error" && i.ruleKey === "syn_beta") && boom.body.cases.length === 3);
    world({ rules: [A, B], extra: { "Domain A": [] } });
    const dup = { code: "synthetic_data_issue", recordId: "recA0000000000009", detail: "shared finding" };
    const rep = await run([
      synEval("syn_alpha", "ATT-901", ["Domain A"], (ctx) => { ctx.reportIssue(dup); ctx.reportIssue({ ...dup }); ctx.reportIssue({ ...dup, recordId: "recA0000000000008" }); return one(["recA0000000000001"]); }),
      synEval("syn_beta", "ATT-902", ["Domain A"], (ctx) => { ctx.reportIssue({ ...dup }); return []; }),
    ]);
    const synIssues = rep.body.configIssues.filter((i: any) => i.code === "synthetic_data_issue");
    ck("81a. Evaluator-reported issues surface in configIssues; identical reports (even from two evaluators) appear ONCE, distinct records separately", synIssues.length === 2 && synIssues.filter((i: any) => i.recordId === "recA0000000000009").length === 1);
    ck("81b. A reported issue never creates a case and never marks the queue incomplete", rep.body.cases.length === 1 && rep.body.complete === true);
    world({ rules: [A, B], extra: { "Domain A": [] } });
    const dbg = await run(reg, { debug: true });
    ck("82. debug=1 adds diagnostics (evaluated, skipped, sources, reads) only when asked", dbg.body.diagnostics && Array.isArray(dbg.body.diagnostics.evaluated) && dbg.body.diagnostics.reads.lists["Needs Attention Rules"] === 1);
  }

  // ===== Live-TEST-equivalent: real catalogue shape + deployed (empty) registry =====
  {
    const fixture = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.fixture.json"), "utf8")).rules as any[];
    const rows = fixture.map((r, i) => rule(r.ruleKey, { id: id("Live" + String(i).padStart(3, "0")), ruleId: r.ruleId, status: r.evaluationStatus, module: r.requiredModule, enabled: r.defaultEnabled, active: r.active }));
    const feats = [["module_schedule", true], ["module_coaches", true], ["module_players_parents", true], ["module_development", true], ["module_finance", false], ["module_communications", false], ["module_system", true], ["module_safeguarding", false]].map(([k, e]) => feature(k as string, e as boolean));
    world({ rules: rows, features: feats });
    const live = await run([...IMPLEMENTED_EVALUATORS], { debug: true });
    const reasons: Record<string, number> = {};
    for (const s of live.body.diagnostics.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    ck("83. TEST catalogue + deployed registry + empty schedule -> Clear, 0 cases, complete, no config issues", live.body.summary.state === "Clear" && live.body.cases.length === 0 && live.body.complete === true && live.body.configIssues.length === 0);
    ck("84. ...the 4 staffing rules + cover_open + the 3 compliance rules + the 2 coach-schedule rules + the 4 Slice 8 rules are evaluated; the other 32 are skipped: 24 planned (venue_missing is Planned, deferred to the Venue foundation) + the 8 Finance rules (invoice_overdue, invoice_draft_blocked, the five F16 Money Out rules and the F17 cash_balance_below_threshold rule) module_off here (no module_finance row); nothing is not_implemented", live.body.diagnostics.evaluated.length === 14 && live.body.diagnostics.skipped.length === 32 && !reasons.not_implemented && reasons.planned === 24 && reasons.module_off === 8 && live.body.diagnostics.skipped.find((x: any) => x.ruleKey === "venue_missing")?.reason === "planned" && live.body.diagnostics.skipped.find((x: any) => x.ruleKey === "invoice_overdue")?.reason === "module_off", JSON.stringify(reasons));
    const nonConfig = requests.filter((t) => !Object.values(CONFIG_TABLES).includes(t as any));
    ck("85. ...reads = 5 config + 6 staffing (incl. Coaches) + 2 cover-only tables (Staff Availability Requests, Cover Responses) + 2 compliance-only tables (Coach Documents, Coach Document Requirements) + 2 availability tables (Coach Availability, Coach Availability Exceptions) + 2 Slice 8 tables (Coach Work Summaries, Coach Allocations), each listed exactly once - shared occurrence/session/coach tables are NOT read twice", nonConfig.length === 14 && nonConfig.includes("Coach Work Summaries") && nonConfig.includes("Coach Allocations") && !nonConfig.includes("Occurrence Financial Outcomes") && !nonConfig.includes("Work Summary Lines") && !nonConfig.includes("Work Summary History") && nonConfig.includes("Coach Availability") && nonConfig.includes("Coach Availability Exceptions") && nonConfig.includes("Coaches") && nonConfig.includes("Staff Availability Requests") && nonConfig.includes("Cover Responses") && nonConfig.includes("Coach Documents") && nonConfig.includes("Coach Document Requirements") && Object.keys(live.body.diagnostics.reads.lists).length === 19 && Object.values(live.body.diagnostics.reads.lists).every((n: any) => n === 1));
  }

  // ===== Performance / read model =====
  {
    const A = rule("syn_alpha", { ruleId: "ATT-901", module: "module_alpha" });
    const B = rule("syn_beta", { ruleId: "ATT-902", module: "module_alpha" });
    const C = rule("syn_gamma", { ruleId: "ATT-903", module: "module_beta" });
    const many = Array.from({ length: 7 }, (_, i) => rule(`syn_filler_${i}`, { id: id("Fill" + i), ruleId: `ATT-95${i}`, status: "Planned" }));
    const reg = [
      synEval("syn_alpha", "ATT-901", ["Shared Source", "Only A"], () => one(["recA0000000000001"])),
      synEval("syn_beta", "ATT-902", ["Shared Source"], () => one(["recB0000000000001"])),
      synEval("syn_gamma", "ATT-903", ["Gamma Source"], () => one(["recG0000000000001"])),
    ];
    const shared = Array.from({ length: 7 }, (_, i) => ({ id: id("Sh" + i), fields: {} }));
    world({ rules: [A, B, C, ...many], features: [feature("module_alpha", true), feature("module_beta", false)], extra: { "Shared Source": shared, "Only A": [], "Gamma Source": [] } });
    const p = await run(reg, { debug: true });
    const reads = p.body.diagnostics.reads;
    ck("86. Each config table is listed exactly once per request (Rules paged: 10 rows / page size 3 = 4 page requests, 1 list)", Object.values(CONFIG_TABLES).every((t) => reads.lists[t] === 1) && reads.pages["Needs Attention Rules"] === 4 && count("Needs Attention Rules") === 4);
    ck("87. A source shared by two evaluators is listed once (not once per rule)", reads.lists["Shared Source"] === 1 && reads.pages["Shared Source"] === 3 && evalCalls.syn_alpha === 1 && evalCalls.syn_beta === 1);
    ck("88. A module-off evaluator's source is never read", !evalCalls.syn_gamma && count("Gamma Source") === 0 && !reads.lists["Gamma Source"]);
    ck("89. Total list operations = 5 config + distinct runnable sources (no per-rule queries)", Object.keys(reads.lists).length === 7 && p.body.diagnostics.sourcesLoaded.join(",") === "Only A,Shared Source");
    world({ rules: [A], extra: { "Shared Source": [] } });
    failTable = "Needs Attention Exceptions";
    let threw = false;
    try { await run(reg); } catch { threw = true; }
    failTable = null;
    ck("90. A config read failure aborts the request (error, never a silent partial 'Clear')", threw);
  }

  // ===== Code / deployment drift checks =====
  {
    const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
    const sub = (s: string) => s.replace(/"\.\/needs-attention\.ts"/g, '"./needs-attention-engine.ts"').replace(/"\.\/repository\.ts"/g, '"./needs-attention-repository.ts"').replace(/"\.\/registry\.ts"/g, '"./needs-attention-registry.ts"').replace(/"\.\/staffing\.ts"/g, '"./needs-attention-staffing.ts"').replace(/"\.\/cover\.ts"/g, '"./needs-attention-cover.ts"').replace(/"\.\/compliance\.ts"/g, '"./needs-attention-compliance.ts"').replace(/"\.\/coach-schedule\.ts"/g, '"./needs-attention-coach-schedule.ts"').replace(/"\.\/exceptions\.ts"/g, '"./needs-attention-exceptions.ts"').replace(/"\.\/lock-client\.ts"/g, '"./needs-attention-lock-client.ts"').replace(/"\.\/work-summaries\.ts"/g, '"./needs-attention-work-summaries.ts"').replace(/"\.\/finance\.ts"/g, '"./needs-attention-finance.ts"').replace(/"\.\/finance-drafts\.ts"/g, '"./needs-attention-finance-drafts.ts"').replace(/"\.\/money-out\.ts"/g, '"./needs-attention-money-out.ts"').replace(/"\.\/cash-flow\.ts"/g, '"./needs-attention-cash-flow.ts"').replace(/"\.\.\/finance\//g, '"./');
    for (const [src, dst] of [["needs-attention", "needs-attention-engine"], ["repository", "needs-attention-repository"], ["registry", "needs-attention-registry"], ["orchestrator", "needs-attention-orchestrator"], ["staffing", "needs-attention-staffing"], ["cover", "needs-attention-cover"], ["compliance", "needs-attention-compliance"], ["coach-schedule", "needs-attention-coach-schedule"], ["exceptions", "needs-attention-exceptions"], ["lock-client", "needs-attention-lock-client"], ["work-summaries", "needs-attention-work-summaries"], ["finance", "needs-attention-finance"], ["finance-drafts", "needs-attention-finance-drafts"], ["money-out", "needs-attention-money-out"], ["cash-flow", "needs-attention-cash-flow"]]) {
      const mirror = readFileSync(join(HERE, `${dst}.ts`), "utf8").split("\n").slice(5).join("\n");
      ck(`D1. tests/support/${dst}.ts == canonical needs-attention/${src}.ts (only import paths adjusted)`, mirror === sub(canon(`${src}.ts`)));
    }
    const idx = canon("index.ts");
    ck("D2. index.ts carries the TEST deployment guard for both production bases", idx.includes("apprptFotQuVL1mhs") && idx.includes("app6ex6UHY2RRO2Ak") && idx.includes("TEST function refusing to start"));
    ck("D3. index.ts: GET only on /cases, POST only on /exceptions and /exceptions/revoke, Management-only, tenant parameters rejected", /cases: "GET", exceptions: "POST", "exceptions\/revoke": "POST"/.test(idx) && /req\.method !== method/.test(idx) && /caller\.role !== "management"/.test(idx) && idx.includes("tenant_param_rejected") && idx.includes('"organisation"'));
    const all = ["index.ts", "orchestrator.ts", "needs-attention.ts", "repository.ts", "registry.ts", "staffing.ts", "cover.ts", "compliance.ts", "coach-schedule.ts", "exceptions.ts", "lock-client.ts", "work-summaries.ts", "finance.ts", "finance-drafts.ts", "money-out.ts"].map(canon).join("\n");
    const notRepo = ["index.ts", "orchestrator.ts", "needs-attention.ts", "registry.ts", "staffing.ts", "cover.ts", "compliance.ts", "coach-schedule.ts", "exceptions.ts", "work-summaries.ts", "finance.ts", "finance-drafts.ts", "money-out.ts"].map(canon).join("\n");
    const repo = canon("repository.ts");
    ck("D4. Writes are confined to ONE table: only repository.ts issues Airtable writes, and its writer is hard-wired to Needs Attention Exceptions (POST create / PATCH one record); no DELETE anywhere; no Supabase table writes", !/method:\s*"(POST|PATCH|PUT|DELETE)"|method,|"DELETE"/.test(notRepo) && /tableUrl\(config, CONFIG_TABLES\.exceptions\)/.test(repo) && (repo.match(/writeException\(config, "(POST|PATCH)"/g) ?? []).length === 2 && (repo.match(/method:\s*"(POST|PATCH|PUT|DELETE)"\s*[,}]/g) ?? []).length === 0 && !/DELETE/.test(all) && !/\.(insert|update|upsert|delete)\(/.test(all.replace(/roster\.delete\(/g, "")));
    ck("D4b. The service-role key is used only by the lock client (RPC to the two needs_attention_exception_lock functions), (F8a) the caller's own Finance grant GET (loadFinanceGrants, filtered by user_id) and (F16) the allowlisted organisation-scoped Finance source GETs (loadFinanceSource)", /SUPABASE_SERVICE_ROLE_KEY/.test(idx) && (idx.match(/SUPABASE_SERVICE_ROLE_KEY/g) ?? []).length === 5 && /financeStore: \{ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY \}/.test(idx) && !/method:/.test(repo.slice(repo.indexOf("export async function loadFinanceSource"))) && /url\.searchParams\.set\("organisation_id", `eq\.\$\{organisationId\}`\)/.test(repo) && /loadFinanceGrants\(\{ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY \}, caller\.userId\)/.test(idx) && /acquire_needs_attention_exception_lock/.test(canon("lock-client.ts")) && /release_needs_attention_exception_lock/.test(canon("lock-client.ts")) && !/SERVICE_ROLE/.test(notRepo.replace(idx, "")) && /url\.searchParams\.set\("user_id", `eq\.\$\{userId\}`\)/.test(repo) && !/method:/.test(repo.slice(repo.indexOf("export async function loadFinanceGrants"))));
    ck("D5. Organisation comes from the profile only (orchestrator/exceptions never read a tenant from the query or body)", !/searchParams|query\.organisation|body\.organisation/.test(canon("orchestrator.ts") + canon("exceptions.ts")) && idx.includes('.select("role, active, organisation_id, display_name")'));
    const regCode = [canon("registry.ts"), canon("staffing.ts"), canon("cover.ts"), canon("compliance.ts"), canon("coach-schedule.ts"), canon("work-summaries.ts"), canon("finance.ts")].map((c) => c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).join("\n");
    ck("D6. No later-slice rule is implemented (no venue / safeguarding evaluator, and of the Finance rules only F8a invoice_overdue - ATT-024/025/026/034/048 stay unimplemented; cover_open is Slice 4, the three compliance rules are Slice 6, the two coach-schedule rules are Slice 7, the coach outcome + three work summary rules are Slice 8)", !/venue_missing|safeguarding_action_open|invoicing_period_ready|finance_sync_failed|payment_revenue_mismatch|session_billing_setup_missing|invoice_draft_blocked|invoice_due_today|session_change_followup|coach_cost_exception/.test(regCode) && /ruleKey: "invoice_overdue",\s*ruleId: "ATT-047"/.test(regCode) && /ruleKey: "coach_outcome_pending",\s*ruleId: "ATT-043"/.test(regCode) && /summaryEvaluator\("work_summary_queried", "ATT-044"\)/.test(regCode) && /summaryEvaluator\("work_summary_ready_to_finalise", "ATT-045"\)/.test(regCode) && /summaryEvaluator\("work_summary_blocked", "ATT-046"\)/.test(regCode) && /ruleKey: "assigned_coach_unavailable",\s*ruleId: "ATT-014"/.test(regCode) && /ruleKey: "coach_schedule_conflict",\s*ruleId: "ATT-012"/.test(regCode) && /ruleKey: "cover_open"/.test(regCode) && /coachLevelEvaluator\("coach_compliance_expiry", "ATT-011"\)/.test(regCode) && /coachLevelEvaluator\("compliance_verification_pending", "ATT-042"\)/.test(regCode) && /ruleKey: "non_compliant_coach_assigned"/.test(regCode));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");
const CANON = join(FUNCS, "needs-attention");

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
