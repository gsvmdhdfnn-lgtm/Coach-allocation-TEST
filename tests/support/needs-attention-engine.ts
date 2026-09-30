/**
 * Test-suite copy of the canonical needs-attention/needs-attention.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Needs Attention Slice 2 - the pure engine (see TEST-ENV.md "Needs
 * Attention Foundation - Slice 2"). No I/O here: catalogue parsing,
 * organisation resolution, module gating, Settings inheritance, severity,
 * case identity, exception matching, summary aggregation and payload
 * shaping are all plain functions so every rule of the engine is directly
 * unit-testable. Airtable access lives in repository.ts; composition in
 * orchestrator.ts; the code-side evaluator registry in registry.ts.
 *
 * Principles (locked in Slice 1 / pre-Slice-2):
 *  - Cases are DERIVED on every read. Nothing here persists a case.
 *  - No Settings row = the Rule's defaults. A blank Settings value
 *    inherits that one Rule default (field-by-field).
 *  - A rule runs only when: catalogue row Active, Evaluation Status =
 *    Active, a code-side evaluator is registered for it, its Required
 *    Module is enabled in Feature Controls (missing row = OFF), and the
 *    effective Enabled is true. Existing in Airtable is never enough.
 *  - Case identity = (Organisation, Rule, Case Key). The Case Key is an
 *    org-free business key; the organisation is a separate mandatory scope.
 *  - Final severity = highest of base / Warning escalation / Urgent
 *    escalation / Locked Minimum / an evaluator's fixed state severity.
 *    Threshold boundaries are inclusive. The engine knows nothing about
 *    any particular rule's timing: evaluators supply the anchors.
 */

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

export const SEVERITIES = ["Normal", "Warning", "Urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type HomeState = "Clear" | Severity;
export const TIMINGS = ["Hours Before", "Days Before", "Hours Overdue", "Days Overdue"] as const;
export type Timing = (typeof TIMINGS)[number];
export const EVALUATION_STATUSES = ["Active", "Planned", "Retired"] as const;

export const ENGINE_VERSION = "needs-attention-slice-8";
export const RULE_KEY_RE = /^[a-z][a-z0-9_]*$/;
export const SUBJECT_TYPE_RE = /^[a-z][a-z0-9_]*$/;
/** A subject id may be a record id or an ISO date - never a label: no '|', no whitespace. */
export const SUBJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------
// Field helpers (Airtable REST returns fields by name; checkboxes are
// absent when false; selects are plain strings; links are id arrays)
// ---------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object" && typeof (v as any).name === "string" && (v as any).name.trim()) return (v as any).name.trim();
  return null;
}
function bool(v: unknown): boolean {
  return v === true;
}
function nonNegInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}
function links(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}
function severityOrNull(v: unknown): Severity | null {
  const s = str(v);
  return s && (SEVERITIES as readonly string[]).includes(s) ? (s as Severity) : null;
}
function timingOrNull(v: unknown): Timing | null {
  const s = str(v);
  return s && (TIMINGS as readonly string[]).includes(s) ? (s as Timing) : null;
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}
export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(b) > severityRank(a) ? b : a;
}

// ---------------------------------------------------------------------
// Config issues (surfaced in the payload so Management sees bad config)
// ---------------------------------------------------------------------

export interface ConfigIssue {
  code: string;
  detail: string;
  ruleKey?: string;
  recordId?: string;
}

// ---------------------------------------------------------------------
// Catalogue (Needs Attention Rules)
// ---------------------------------------------------------------------

export interface ThresholdDef {
  value: number | null;
  timing: Timing | null;
}

export interface RuleDef {
  recordId: string;
  ruleId: string | null;
  ruleKey: string | null;
  name: string;
  category: string | null;
  defaultEnabled: boolean;
  defaultBaseSeverity: Severity | null;
  supportsWarning: boolean;
  defaultWarning: ThresholdDef;
  supportsUrgent: boolean;
  defaultUrgent: ThresholdDef;
  supportsOverride: boolean;
  lockedMinimum: Severity | null;
  actionLabel: string | null;
  destinationArea: string | null;
  clientCustomisable: boolean;
  requiredModule: string | null;
  evaluationStatus: string | null;
  sortOrder: number | null;
  active: boolean;
}

export function parseRule(rec: AirtableRecord): RuleDef {
  const f = rec.fields || {};
  const sortOrder = typeof f["Sort Order"] === "number" && Number.isFinite(f["Sort Order"]) ? f["Sort Order"] : null;
  return {
    recordId: rec.id,
    ruleId: str(f["Rule ID"]),
    ruleKey: str(f["Rule Key"]),
    name: str(f["Rule Name"]) ?? str(f["Rule Key"]) ?? rec.id,
    category: str(f["Category"]),
    defaultEnabled: bool(f["Default Enabled"]),
    defaultBaseSeverity: severityOrNull(f["Default Base Severity"]),
    supportsWarning: bool(f["Supports Warning Threshold"]),
    defaultWarning: { value: nonNegInt(f["Default Warning Threshold"]), timing: timingOrNull(f["Default Warning Timing"]) },
    supportsUrgent: bool(f["Supports Urgent Threshold"]),
    defaultUrgent: { value: nonNegInt(f["Default Urgent Threshold"]), timing: timingOrNull(f["Default Urgent Timing"]) },
    supportsOverride: bool(f["Supports Override"]),
    lockedMinimum: severityOrNull(f["Locked Minimum Severity"]),
    actionLabel: str(f["Action Label"]),
    destinationArea: str(f["Destination Area"]),
    clientCustomisable: bool(f["Client Customisable"]),
    requiredModule: str(f["Required Module"]),
    evaluationStatus: str(f["Evaluation Status"]),
    sortOrder,
    active: bool(f["Active"]),
  };
}

export interface Catalogue {
  rules: RuleDef[];
  /** Only rules with a valid, unique Rule Key. Ambiguous keys are excluded entirely (never guessed). */
  byKey: Map<string, RuleDef>;
  issues: ConfigIssue[];
}

export function buildCatalogue(records: AirtableRecord[]): Catalogue {
  const rules = records.map(parseRule);
  const issues: ConfigIssue[] = [];
  const byKeyAll = new Map<string, RuleDef[]>();
  for (const r of rules) {
    if (!r.ruleKey || !RULE_KEY_RE.test(r.ruleKey)) {
      issues.push({ code: "rule_key_invalid", detail: `Rule row has a missing or invalid Rule Key (${JSON.stringify(r.ruleKey)})`, recordId: r.recordId });
      continue;
    }
    const list = byKeyAll.get(r.ruleKey) ?? [];
    list.push(r);
    byKeyAll.set(r.ruleKey, list);
  }
  const byKey = new Map<string, RuleDef>();
  for (const [k, list] of byKeyAll) {
    if (list.length > 1) issues.push({ code: "rule_key_duplicate", detail: `${list.length} catalogue rows share Rule Key ${k}; none of them is evaluated`, ruleKey: k });
    else byKey.set(k, list[0]);
  }
  const byId = new Map<string, number>();
  for (const r of rules) if (r.ruleId) byId.set(r.ruleId, (byId.get(r.ruleId) ?? 0) + 1);
  for (const [id, n] of byId) if (n > 1) issues.push({ code: "rule_id_duplicate", detail: `${n} catalogue rows share Rule ID ${id}` });
  return { rules, byKey, issues };
}

// ---------------------------------------------------------------------
// Organisation resolution (exactly one Active match, else fail closed)
// ---------------------------------------------------------------------

export interface OrganisationContext {
  recordId: string;
  organisationId: string;
  name: string | null;
  timezone: string;
}

export type OrganisationResolution =
  | { ok: true; organisation: OrganisationContext }
  | { ok: false; code: "organisation_not_found" | "organisation_ambiguous"; error: string };

/**
 * `profileOrganisationId` comes ONLY from the authenticated caller's
 * Supabase profile - never from the request. Exact string match on the
 * Airtable "Organisation ID" of an Active Organisation & Branding row; no
 * aliases, no case-folding, no fallback to "the only row".
 */
export function resolveOrganisation(profileOrganisationId: string | null | undefined, orgRecords: AirtableRecord[]): OrganisationResolution {
  const wanted = typeof profileOrganisationId === "string" ? profileOrganisationId.trim() : "";
  if (!wanted) return { ok: false, code: "organisation_not_found", error: "Your profile has no organisation" };
  const matches = orgRecords.filter((r) => r.fields?.["Active"] === true && str(r.fields?.["Organisation ID"]) === wanted);
  if (matches.length === 0) return { ok: false, code: "organisation_not_found", error: `No active organisation matches ${wanted}` };
  if (matches.length > 1) return { ok: false, code: "organisation_ambiguous", error: `${matches.length} active organisations match ${wanted}` };
  const r = matches[0];
  return {
    ok: true,
    organisation: { recordId: r.id, organisationId: wanted, name: str(r.fields["Organisation Name"]), timezone: str(r.fields["Timezone"]) ?? "Europe/London" },
  };
}

// ---------------------------------------------------------------------
// Module registry (Feature Controls; missing row = module OFF)
// ---------------------------------------------------------------------

export interface ModuleState {
  key: string | null;
  active: boolean;
  reason: "enabled" | "disabled" | "missing" | "conflicting" | "no_module";
}

export function moduleState(featureRecords: AirtableRecord[], key: string | null): ModuleState {
  if (!key) return { key, active: false, reason: "no_module" };
  const rows = featureRecords.filter((r) => str(r.fields?.["Feature Key"]) === key);
  if (rows.length === 0) return { key, active: false, reason: "missing" };
  const on = rows.filter((r) => r.fields["Enabled"] === true).length;
  if (on === rows.length) return { key, active: true, reason: "enabled" };
  if (on === 0) return { key, active: false, reason: "disabled" };
  return { key, active: false, reason: "conflicting" };
}

// ---------------------------------------------------------------------
// Settings (per-organisation overrides) and inheritance
// ---------------------------------------------------------------------

export interface SettingRow {
  recordId: string;
  settingId: string | null;
  organisationIds: string[];
  ruleIds: string[];
  enabled: boolean;
  baseSeverity: Severity | null;
  warningThreshold: number | null;
  warningTiming: Timing | null;
  urgentThreshold: number | null;
  urgentTiming: Timing | null;
  allowOverride: boolean;
}

export function parseSetting(rec: AirtableRecord): SettingRow {
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    settingId: str(f["Setting ID"]),
    organisationIds: links(f["Organisation"]),
    ruleIds: links(f["Rule"]),
    enabled: bool(f["Enabled"]),
    baseSeverity: severityOrNull(f["Base Severity"]),
    warningThreshold: nonNegInt(f["Warning Threshold"]),
    warningTiming: timingOrNull(f["Warning Timing"]),
    urgentThreshold: nonNegInt(f["Urgent Threshold"]),
    urgentTiming: timingOrNull(f["Urgent Timing"]),
    allowOverride: bool(f["Allow Override"]),
  };
}

/**
 * The organisation's Settings, keyed by Rule record id. Only rows linked
 * to exactly this one organisation and exactly one rule are considered.
 * Two rows for the same rule are a conflict: BOTH are ignored (the rule
 * falls back to its defaults) and the conflict is reported.
 */
export function settingsForOrganisation(records: AirtableRecord[], organisationRecordId: string): { byRuleRecordId: Map<string, SettingRow>; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const grouped = new Map<string, SettingRow[]>();
  for (const rec of records) {
    const s = parseSetting(rec);
    if (!s.organisationIds.includes(organisationRecordId)) continue;
    if (s.organisationIds.length !== 1 || s.ruleIds.length !== 1) {
      issues.push({ code: "settings_row_invalid", detail: "Settings row must link exactly one Organisation and one Rule; ignored", recordId: s.recordId });
      continue;
    }
    const list = grouped.get(s.ruleIds[0]) ?? [];
    list.push(s);
    grouped.set(s.ruleIds[0], list);
  }
  const byRuleRecordId = new Map<string, SettingRow>();
  for (const [ruleRecordId, list] of grouped) {
    if (list.length > 1) issues.push({ code: "settings_conflict", detail: `${list.length} Settings rows for one rule; all ignored, Rule defaults apply`, recordId: ruleRecordId });
    else byRuleRecordId.set(ruleRecordId, list[0]);
  }
  return { byRuleRecordId, issues };
}

export interface EffectiveConfig {
  enabled: boolean;
  enabledSource: "default" | "settings";
  baseSeverity: Severity;
  warning: ThresholdDef | null;
  urgent: ThresholdDef | null;
  lockedMinimum: Severity | null;
  overrideAllowed: boolean;
  settingsApplied: boolean;
  settingsIgnoredReason: string | null;
}

/**
 * Inheritance (locked): no Settings row -> Rule defaults. A row on a
 * Client Customisable rule overrides field by field; a blank value
 * inherits that Rule default. Enabled and Allow Override are checkboxes,
 * so on an existing row they are always explicit. Thresholds exist only
 * when the rule supports them. Allow Override can only narrow the Rule's
 * Supports Override. Locked Minimum always comes from the Rule.
 */
export function resolveEffectiveConfig(rule: RuleDef, setting: SettingRow | undefined): EffectiveConfig {
  const useSetting = !!setting && rule.clientCustomisable;
  const s = useSetting ? setting! : null;
  const pick = <T>(override: T | null | undefined, fallback: T | null): T | null => (override != null ? override : fallback);
  const warning = rule.supportsWarning ? { value: pick(s?.warningThreshold, rule.defaultWarning.value), timing: pick(s?.warningTiming, rule.defaultWarning.timing) } : null;
  const urgent = rule.supportsUrgent ? { value: pick(s?.urgentThreshold, rule.defaultUrgent.value), timing: pick(s?.urgentTiming, rule.defaultUrgent.timing) } : null;
  return {
    enabled: s ? s.enabled : rule.defaultEnabled,
    enabledSource: s ? "settings" : "default",
    baseSeverity: pick(s?.baseSeverity, rule.defaultBaseSeverity) ?? "Normal",
    warning,
    urgent,
    lockedMinimum: rule.lockedMinimum,
    overrideAllowed: rule.supportsOverride && (s ? s.allowOverride : true),
    settingsApplied: !!s,
    settingsIgnoredReason: setting && !rule.clientCustomisable ? "rule_not_client_customisable" : null,
  };
}

// ---------------------------------------------------------------------
// Severity (generic; rule-specific meaning arrives via anchors)
// ---------------------------------------------------------------------

export interface Anchors {
  /** "... Before" thresholds measure time remaining until this instant (e.g. occurrence start). */
  event?: string | null;
  /** "... Overdue" thresholds measure time elapsed since this instant (e.g. request raised). */
  outstandingSince?: string | null;
}

function parseInstant(v: string | null | undefined): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export type ThresholdCheck = { reached: boolean; detail: string };

/** Inclusive: exactly at the boundary counts as reached. Days are fixed 24h spans. */
export function thresholdReached(th: ThresholdDef | null, anchors: Anchors | undefined, now: Date): ThresholdCheck {
  if (!th || th.value == null || !th.timing) return { reached: false, detail: "no threshold" };
  const span = th.value * (th.timing.startsWith("Hours") ? HOUR_MS : DAY_MS);
  const unit = th.timing.startsWith("Hours") ? "h" : "d";
  if (th.timing.endsWith("Before")) {
    const ev = parseInstant(anchors?.event);
    if (ev == null) return { reached: false, detail: `${th.value}${unit} before: no event anchor` };
    return { reached: ev - now.getTime() <= span, detail: `${th.value}${unit} before event` };
  }
  const since = parseInstant(anchors?.outstandingSince);
  if (since == null) return { reached: false, detail: `${th.value}${unit} overdue: no outstanding-since anchor` };
  return { reached: now.getTime() - since >= span, detail: `${th.value}${unit} overdue` };
}

export interface SeverityResult {
  severity: Severity;
  reason: string;
}

export function computeSeverity(
  cfg: Pick<EffectiveConfig, "baseSeverity" | "warning" | "urgent" | "lockedMinimum">,
  anchors: Anchors | undefined,
  now: Date,
  stateSeverity?: Severity | null
): SeverityResult {
  let sev: Severity = cfg.baseSeverity;
  const parts: string[] = [`base ${cfg.baseSeverity}`];
  const w = thresholdReached(cfg.warning, anchors, now);
  if (w.reached) {
    sev = maxSeverity(sev, "Warning");
    parts.push(`Warning threshold reached (${w.detail})`);
  }
  const u = thresholdReached(cfg.urgent, anchors, now);
  if (u.reached) {
    sev = maxSeverity(sev, "Urgent");
    parts.push(`Urgent threshold reached (${u.detail})`);
  }
  if (stateSeverity) {
    sev = maxSeverity(sev, stateSeverity);
    parts.push(`state ${stateSeverity}`);
  }
  if (cfg.lockedMinimum && severityRank(cfg.lockedMinimum) > severityRank(sev)) {
    sev = cfg.lockedMinimum;
    parts.push(`locked minimum ${cfg.lockedMinimum}`);
  }
  return { severity: sev, reason: parts.join("; ") };
}

// ---------------------------------------------------------------------
// Case identity (Organisation + Rule + Case Key)
// ---------------------------------------------------------------------

export interface CaseSubject {
  type: string;
  id: string;
}

/** `ruleKey|type:id[|type:id...]` - segment order is the rule's documented order; the engine never reorders. */
export function buildCaseKey(ruleKey: string, subjects: CaseSubject[]): string {
  if (!RULE_KEY_RE.test(ruleKey)) throw new Error(`Invalid rule key for case key: ${ruleKey}`);
  if (!subjects.length) throw new Error(`Case key for ${ruleKey} needs at least one subject`);
  for (const s of subjects) {
    if (!SUBJECT_TYPE_RE.test(s.type)) throw new Error(`Invalid case subject type: ${s.type}`);
    if (!SUBJECT_ID_RE.test(s.id)) throw new Error(`Invalid case subject id: ${s.id}`);
  }
  return [ruleKey, ...subjects.map((s) => `${s.type}:${s.id}`)].join("|");
}

export function parseCaseKey(key: unknown): { ruleKey: string; subjects: CaseSubject[] } | null {
  if (typeof key !== "string" || key.length > 500) return null;
  const parts = key.split("|");
  const ruleKey = parts.shift()!;
  if (!RULE_KEY_RE.test(ruleKey) || parts.length === 0) return null;
  const subjects: CaseSubject[] = [];
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i <= 0) return null;
    const s = { type: p.slice(0, i), id: p.slice(i + 1) };
    if (!SUBJECT_TYPE_RE.test(s.type) || !SUBJECT_ID_RE.test(s.id)) return null;
    subjects.push(s);
  }
  return { ruleKey, subjects };
}

/** The organisation-scoped identity used for any map/dedupe/cache. Never compare bare Case Keys across organisations. */
export function scopedCaseIdentity(organisationRecordId: string, ruleKey: string, caseKey: string): string {
  return `${organisationRecordId}#${ruleKey}#${caseKey}`;
}

// ---------------------------------------------------------------------
// Exceptions (read-only matching)
// ---------------------------------------------------------------------

export interface ExceptionRow {
  recordId: string;
  exceptionId: string | null;
  organisationIds: string[];
  ruleIds: string[];
  caseKey: string | null;
  active: boolean;
  effectiveUntil: string | null;
  reason: string | null;
  approvedByUserId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedByName: string | null;
  revokeReason: string | null;
}

export function parseException(rec: AirtableRecord): ExceptionRow {
  const f = rec.fields || {};
  return {
    recordId: rec.id,
    exceptionId: str(f["Exception ID"]),
    organisationIds: links(f["Organisation"]),
    ruleIds: links(f["Rule"]),
    caseKey: typeof f["Case Key"] === "string" ? f["Case Key"] : null,
    active: bool(f["Active"]),
    effectiveUntil: str(f["Effective Until"]),
    reason: str(f["Reason"]),
    approvedByUserId: str(f["Approved By User ID"]),
    approvedByName: str(f["Approved By Name Snapshot"]),
    approvedAt: str(f["Approved At"]),
    revokedAt: str(f["Revoked At"]),
    revokedByUserId: str(f["Revoked By User ID"]),
    revokedByName: str(f["Revoked By Name Snapshot"]),
    revokeReason: str(f["Revoke Reason"]),
  };
}

/**
 * An exception suppresses a case only if ALL hold: same organisation
 * (exactly that one link), same rule (exactly that one link, and the
 * Case Key's rule segment equals the rule's key), exact Case Key string,
 * Active, Effective Until blank or strictly in the future, and the
 * effective config allows override. Anything unreadable fails safe:
 * the case stays visible.
 */
export function matchException(
  exceptions: ExceptionRow[],
  ctx: { organisationRecordId: string; rule: RuleDef; caseKey: string; overrideAllowed: boolean; now: Date }
): ExceptionRow | null {
  if (!ctx.overrideAllowed || !ctx.rule.ruleKey) return null;
  for (const e of exceptions) {
    if (!e.active) continue;
    if (e.organisationIds.length !== 1 || e.organisationIds[0] !== ctx.organisationRecordId) continue;
    if (e.ruleIds.length !== 1 || e.ruleIds[0] !== ctx.rule.recordId) continue;
    if (e.caseKey !== ctx.caseKey) continue;
    if (parseCaseKey(e.caseKey)?.ruleKey !== ctx.rule.ruleKey) continue;
    if (e.effectiveUntil != null) {
      const until = parseInstant(e.effectiveUntil);
      if (until == null || until <= ctx.now.getTime()) continue;
    }
    return e;
  }
  return null;
}

// ---------------------------------------------------------------------
// Evaluator contract + registry validation
// ---------------------------------------------------------------------

export interface CandidateCase {
  subjects: CaseSubject[];
  title?: string | null;
  detail?: string | null;
  anchors?: Anchors;
  /** The instant shown to users / used for ordering (usually the event anchor). */
  anchorTime?: string | null;
  /** A fixed, state-based severity (e.g. an Expired document is Urgent). Never lowers anything. */
  stateSeverity?: Severity | null;
  destination?: { route?: string | null; params?: Record<string, string> };
  targetIds?: Record<string, string>;
  relatedIds?: Record<string, string[]>;
  /** Display-ready, rule-specific facts (names, dates, counts) so the UI needs no follow-up lookups. Scalars only; never player data. */
  context?: Record<string, string | number | boolean | null>;
}

export interface EvaluatorContext {
  now: Date;
  organisation: OrganisationContext;
  /** Domain tables this evaluator declared in `sources`, loaded once per request and shared across evaluators. */
  sources: Readonly<Record<string, readonly AirtableRecord[]>>;
  /**
   * Report a data/configuration problem found while evaluating (e.g. a staff
   * assignment with an unrecognised role). Surfaced in `configIssues`; the
   * orchestrator de-duplicates identical reports (evaluators that share one
   * analysis pass may each report the same issue). Never creates a case.
   */
  reportIssue?: (issue: ConfigIssue) => void;
}

export interface EvaluatorRegistration {
  ruleKey: string;
  ruleId: string;
  /** Airtable table names this evaluator reads. Loaded only if the rule actually runs. */
  sources: readonly string[];
  evaluate(ctx: EvaluatorContext): CandidateCase[];
}

export interface RegistryIssue {
  code: "duplicate_registration" | "invalid_rule_key" | "missing_catalogue_row" | "rule_id_mismatch";
  ruleKey: string;
  detail: string;
}

/** Drift check: registrations vs the catalogue. Catalogue rules WITHOUT an evaluator are fine (added progressively). */
export function validateRegistry(registrations: readonly EvaluatorRegistration[], catalogue: readonly { ruleKey: string | null; ruleId: string | null }[]): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const seen = new Map<string, number>();
  for (const r of registrations) seen.set(r.ruleKey, (seen.get(r.ruleKey) ?? 0) + 1);
  for (const [k, n] of seen) if (n > 1) issues.push({ code: "duplicate_registration", ruleKey: k, detail: `${n} evaluators registered for ${k}` });
  for (const r of registrations) {
    if (!RULE_KEY_RE.test(r.ruleKey)) {
      issues.push({ code: "invalid_rule_key", ruleKey: r.ruleKey, detail: "Evaluator rule key is not a valid snake_case key" });
      continue;
    }
    const row = catalogue.filter((c) => c.ruleKey === r.ruleKey);
    if (row.length === 0) issues.push({ code: "missing_catalogue_row", ruleKey: r.ruleKey, detail: `No catalogue row for evaluator ${r.ruleKey}` });
    else if (row.length === 1 && row[0].ruleId !== r.ruleId) issues.push({ code: "rule_id_mismatch", ruleKey: r.ruleKey, detail: `Evaluator says ${r.ruleId}, catalogue says ${row[0].ruleId}` });
  }
  return issues;
}

// ---------------------------------------------------------------------
// Planning (which rules run, and which sources they need)
// ---------------------------------------------------------------------

export type SkipReason =
  | "inactive"
  | "retired"
  | "planned"
  | "invalid_status"
  | "not_implemented"
  | "registry_mismatch"
  | "module_off"
  | "disabled"
  | "settings_disabled"
  /** F8a: a Finance (module_finance) rule, and the caller holds neither Finance View nor Manage. Applied before any source is loaded. */
  | "finance_access_required";

export interface PlanEntry {
  rule: RuleDef;
  config: EffectiveConfig;
  module: ModuleState;
  evaluator: EvaluatorRegistration | null;
  run: boolean;
  skipReason: SkipReason | null;
  skipDetail: string | null;
}

export interface Plan {
  entries: PlanEntry[];
  sourcesToLoad: string[];
  issues: ConfigIssue[];
}

export function planEvaluation(input: {
  catalogue: Catalogue;
  settings: Map<string, SettingRow>;
  featureRecords: AirtableRecord[];
  registry: readonly EvaluatorRegistration[];
  onlyRuleKey?: string | null;
}): Plan {
  const issues: ConfigIssue[] = [];
  const regIssues = validateRegistry(input.registry, input.catalogue.rules);
  for (const i of regIssues) issues.push({ code: `registry_${i.code}`, detail: i.detail, ruleKey: i.ruleKey });
  const badKeys = new Set(regIssues.filter((i) => i.code === "duplicate_registration" || i.code === "rule_id_mismatch").map((i) => i.ruleKey));
  const evaluators = new Map(input.registry.map((r) => [r.ruleKey, r]));

  const entries: PlanEntry[] = [];
  for (const rule of input.catalogue.byKey.values()) {
    if (input.onlyRuleKey && rule.ruleKey !== input.onlyRuleKey) continue;
    const config = resolveEffectiveConfig(rule, input.settings.get(rule.recordId));
    const module = moduleState(input.featureRecords, rule.requiredModule);
    const evaluator = evaluators.get(rule.ruleKey!) ?? null;
    let skip: [SkipReason, string] | null = null;
    if (!rule.active) skip = ["inactive", "Catalogue row is not Active"];
    else if (rule.evaluationStatus === "Retired") skip = ["retired", "Evaluation Status is Retired"];
    else if (rule.evaluationStatus === "Planned") skip = ["planned", "Evaluation Status is Planned"];
    else if (rule.evaluationStatus !== "Active") skip = ["invalid_status", `Evaluation Status is ${JSON.stringify(rule.evaluationStatus)}`];
    else if (!evaluator) skip = ["not_implemented", "No code-side evaluator is registered for this rule yet"];
    else if (badKeys.has(rule.ruleKey!)) skip = ["registry_mismatch", "Evaluator registration conflicts with the catalogue"];
    else if (!module.active) skip = ["module_off", `Required Module ${rule.requiredModule ?? "(none)"} is ${module.reason}`];
    else if (!config.enabled) skip = config.enabledSource === "settings" ? ["settings_disabled", "Disabled by this organisation's Settings"] : ["disabled", "Default Enabled is off and no Settings row enables it"];
    entries.push({ rule, config, module, evaluator, run: !skip, skipReason: skip ? skip[0] : null, skipDetail: skip ? skip[1] : null });
  }
  const sources = new Set<string>();
  for (const e of entries) if (e.run) for (const s of e.evaluator!.sources) sources.add(s);
  return { entries, sourcesToLoad: [...sources].sort(), issues };
}

// ---------------------------------------------------------------------
// Materialising cases (identity, severity, exceptions)
// ---------------------------------------------------------------------

export interface NeedsAttentionCase {
  caseKey: string;
  ruleId: string | null;
  ruleKey: string;
  ruleName: string;
  category: string | null;
  module: string | null;
  severity: Severity;
  severityReason: string;
  title: string;
  detail: string;
  actionLabel: string | null;
  destination: { area: string | null; route: string | null; params: Record<string, string> };
  targetIds: Record<string, string>;
  relatedIds: Record<string, string[]>;
  context: Record<string, string | number | boolean | null>;
  anchorTime: string | null;
  exceptionAllowed: boolean;
}

export interface SuppressedCase {
  case: NeedsAttentionCase;
  exceptionRecordId: string;
  exceptionId: string | null;
  effectiveUntil: string | null;
}

export function materialiseCases(
  entry: PlanEntry,
  candidates: CandidateCase[],
  ctx: { organisation: OrganisationContext; exceptions: ExceptionRow[]; now: Date }
): { active: NeedsAttentionCase[]; suppressed: SuppressedCase[]; issues: ConfigIssue[] } {
  const rule = entry.rule;
  const ruleKey = rule.ruleKey!;
  const active: NeedsAttentionCase[] = [];
  const suppressed: SuppressedCase[] = [];
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    let caseKey: string;
    try {
      caseKey = buildCaseKey(ruleKey, c.subjects || []);
    } catch (e) {
      issues.push({ code: "case_key_invalid", detail: e instanceof Error ? e.message : String(e), ruleKey });
      continue;
    }
    const scoped = scopedCaseIdentity(ctx.organisation.recordId, ruleKey, caseKey);
    if (seen.has(scoped)) {
      issues.push({ code: "case_key_duplicate", detail: `Evaluator produced ${caseKey} more than once; first kept`, ruleKey });
      continue;
    }
    seen.add(scoped);
    const sev = computeSeverity(entry.config, c.anchors, ctx.now, c.stateSeverity ?? null);
    const nac: NeedsAttentionCase = {
      caseKey,
      ruleId: rule.ruleId,
      ruleKey,
      ruleName: rule.name,
      category: rule.category,
      module: rule.requiredModule,
      severity: sev.severity,
      severityReason: sev.reason,
      title: (c.title && c.title.trim()) || rule.name,
      detail: (c.detail && c.detail.trim()) || "",
      actionLabel: rule.actionLabel,
      destination: { area: rule.destinationArea, route: c.destination?.route ?? null, params: { ...(c.destination?.params ?? {}) } },
      targetIds: { ...(c.targetIds ?? {}) },
      relatedIds: { ...(c.relatedIds ?? {}) },
      context: { ...(c.context ?? {}) },
      anchorTime: c.anchorTime ?? c.anchors?.event ?? c.anchors?.outstandingSince ?? null,
      exceptionAllowed: entry.config.overrideAllowed,
    };
    const ex = matchException(ctx.exceptions, { organisationRecordId: ctx.organisation.recordId, rule, caseKey, overrideAllowed: entry.config.overrideAllowed, now: ctx.now });
    if (ex) suppressed.push({ case: nac, exceptionRecordId: ex.recordId, exceptionId: ex.exceptionId, effectiveUntil: ex.effectiveUntil });
    else active.push(nac);
  }
  return { active, suppressed, issues };
}

// ---------------------------------------------------------------------
// Summary, ordering and payloads
// ---------------------------------------------------------------------

export interface Summary {
  state: HomeState;
  total: number;
  counts: Record<Severity, number>;
  suppressed: number;
}

export function summarise(cases: readonly { severity: Severity }[], suppressedCount = 0): Summary {
  const counts: Record<Severity, number> = { Normal: 0, Warning: 0, Urgent: 0 };
  let state: HomeState = "Clear";
  for (const c of cases) {
    counts[c.severity]++;
    state = state === "Clear" ? c.severity : maxSeverity(state, c.severity);
  }
  return { state, total: cases.length, counts, suppressed: suppressedCount };
}

/** Severity (Urgent first), then rule Sort Order, then anchor time (earliest first, none last), then Case Key. */
export function sortCases(cases: NeedsAttentionCase[], sortOrderByRuleKey: Map<string, number | null>): NeedsAttentionCase[] {
  const so = (k: string) => sortOrderByRuleKey.get(k) ?? Number.MAX_SAFE_INTEGER;
  const at = (v: string | null) => (v ? Date.parse(v) : NaN);
  return [...cases].sort((a, b) => {
    const s = severityRank(b.severity) - severityRank(a.severity);
    if (s) return s;
    const r = so(a.ruleKey) - so(b.ruleKey);
    if (r) return r;
    const ta = at(a.anchorTime), tb = at(b.anchorTime);
    if (!Number.isNaN(ta) || !Number.isNaN(tb)) {
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      if (ta !== tb) return ta - tb;
    }
    return a.caseKey < b.caseKey ? -1 : a.caseKey > b.caseKey ? 1 : 0;
  });
}

export function organisationView(o: OrganisationContext) {
  return { organisationId: o.organisationId, name: o.name, timezone: o.timezone };
}
