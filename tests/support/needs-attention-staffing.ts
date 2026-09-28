/**
 * Test-suite copy of the canonical needs-attention/staffing.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Staffing evaluators for Needs Attention Slice 3 (see TEST-ENV.md "Needs
 * Attention Foundation - Slice 3"): session_no_coach, no_lead_coach,
 * learning_coach_only and session_understaffed.
 *
 * The block between the two COPIED markers below is the Coaches Slice 2/3
 * staffing resolver, extracted VERBATIM from hub-content/player-access.ts
 * (the same block coach-cover/staffing.ts carries): the effective-dated
 * Session Staff rule (sessionStaffAppliesOnDate) and the Occurrence Staff
 * merge (resolveOccurrenceStaffing - valid-row rule, Cover replacement,
 * role precedence). Per the "each Edge Function is self-contained"
 * convention it is copied, not imported; tests/support/needs-attention-staffing.test.ts
 * asserts every chunk still appears byte-for-byte in player-access.ts and
 * that the block is identical to coach-cover's copy, so there is exactly
 * one interpretation of "who staffs this occurrence".
 *
 * Everything below the copied block is built ON that resolver: one shared
 * pass per request analyses every eligible occurrence once, and the four
 * evaluators only read their own findings from it (no per-rule scans).
 * Slice 3.1: after resolving the roster, this layer (NOT the shared
 * resolver) drops assignments that cannot satisfy FUTURE staffing - an
 * inactive or missing Coach record, or a missing/inactive/unrecognised
 * role - before any rule is decided. Unknown roles and missing Coach
 * records are reported as configIssues, never given a meaning.
 */
import type { AirtableRecord, CandidateCase, ConfigIssue, EvaluatorContext, EvaluatorRegistration } from "./needs-attention-engine.ts";

// ===== COPIED FROM hub-content/player-access.ts - DO NOT EDIT HERE =====
export function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sessionStaffAppliesOnDate(row: { fields: Record<string, any> }, dateIso: string): boolean {
  if (row.fields["Active"] !== true) return false;
  const from = row.fields["Effective From"];
  if (from != null && from !== "") {
    if (typeof from !== "string" || !ISO_DATE_ONLY_RE.test(from)) return false;
    if (dateIso < from) return false;
  }
  const until = row.fields["Effective Until"];
  if (until != null && until !== "") {
    if (typeof until !== "string" || !ISO_DATE_ONLY_RE.test(until)) return false;
    if (dateIso > until) return false;
  }
  return true;
}

export function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

export interface CoachRoleCapabilities {
  active: boolean;
  /** Coach Roles' own "Role Name" (singleLineText, display wording only - e.g. "Lead Coach"). Never matched against for access control; see roleKey. */
  roleName: string;
  /** Coach Roles' own "Role Key" (singleLineText, e.g. "lead_coach") - the STABLE identifier this file gates access on, so renaming a role's display "Role Name" in Airtable can never silently change who has player access. */
  roleKey: string;
  canViewPlayers: boolean;
  canAddFeedback: boolean;
  canEditDevelopmentPlans: boolean;
  canRecordAttendance: boolean;
}

export function roleCapabilitiesById(coachRoleRows: any[]): Record<string, CoachRoleCapabilities> {
  const map: Record<string, CoachRoleCapabilities> = {};
  for (const r of coachRoleRows) {
    map[r.id] = {
      active: r.fields["Active"] === true,
      roleName: String(r.fields["Role Name"] || ""),
      roleKey: String(r.fields["Role Key"] || ""),
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

export function roleCapsByRoleName(coachRoleRows: any[]): Record<string, CoachRoleCapabilities> {
  const map: Record<string, CoachRoleCapabilities> = {};
  for (const r of coachRoleRows) {
    const name = String(r.fields["Role Name"] || "");
    if (!name) continue;
    map[name] = {
      active: r.fields["Active"] === true,
      roleName: name,
      roleKey: String(r.fields["Role Key"] || ""),
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

function isUsableOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {
  if (!firstLink(row.fields, "Coach")) return false;
  if (selectName(row.fields["Attendance"]) === "Absent") return false;
  return true;
}

function resolveOccurrenceRoleCaps(
  row: { fields: Record<string, any> },
  sourceRow: any | null,
  roleCapsByName: Record<string, CoachRoleCapabilities>,
  roleCapsById: Record<string, CoachRoleCapabilities>
): CoachRoleCapabilities | null {
  const actual = String(row.fields["Actual Role Snapshot"] || "").trim();
  if (actual) return roleCapsByName[actual] ?? null;
  const planned = String(row.fields["Planned Role Snapshot"] || "").trim();
  if (planned) return roleCapsByName[planned] ?? null;
  if (sourceRow) {
    const roleId = firstLink(sourceRow.fields, "Role");
    if (roleId) return roleCapsById[roleId] ?? null;
  }
  return null;
}

export interface ResolvedOccurrenceCoach {
  coachId: string;
  roleCaps: CoachRoleCapabilities | null;
  /** True when this coach's entry came from (or was role-overridden by) an Occurrence Staff row, rather than being pure Session Staff. */
  fromOccurrenceStaff: boolean;
}

export function resolveOccurrenceStaffing(
  dateIso: string,
  sessionStaffRowsForSession: any[],
  occurrenceStaffRowsForOccurrence: any[],
  roleCapsById: Record<string, CoachRoleCapabilities>,
  roleCapsByNameMap: Record<string, CoachRoleCapabilities>,
  sessionStaffById: Record<string, any>
): ResolvedOccurrenceCoach[] {
  const roster = new Map<string, ResolvedOccurrenceCoach>();

  for (const row of sessionStaffRowsForSession) {
    if (!sessionStaffAppliesOnDate(row, dateIso)) continue;
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;
    const roleId = firstLink(row.fields, "Role");
    const caps = roleId ? roleCapsById[roleId] ?? null : null;
    roster.set(coachId, { coachId, roleCaps: caps, fromOccurrenceStaff: false });
  }

  for (const row of occurrenceStaffRowsForOccurrence) {
    if (!isUsableOccurrenceStaffRow(row)) continue;
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;

    const assignmentType = selectName(row.fields["Assignment Type"]);
    const sourceId = firstLink(row.fields, "Session Staff Source");
    const sourceRow = sourceId ? sessionStaffById[sourceId] ?? null : null;

    if (assignmentType === "Cover" && sourceRow) {
      const sourceCoachId = firstLink(sourceRow.fields, "Coach");
      if (sourceCoachId && sourceCoachId !== coachId) roster.delete(sourceCoachId);
    }

    const caps = resolveOccurrenceRoleCaps(row, sourceRow, roleCapsByNameMap, roleCapsById);
    roster.set(coachId, { coachId, roleCaps: caps, fromOccurrenceStaff: true });
  }

  return [...roster.values()];
}
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Needs Attention staffing analysis (Slice 3). Built ON the copied
// resolver above - it never re-implements who is on a roster.
// ---------------------------------------------------------------------

export const STAFFING_TABLES = {
  occurrences: "Session Occurrences",
  sessions: "Sessions",
  sessionStaff: "Session Staff",
  occurrenceStaff: "Occurrence Staff",
  coachRoles: "Coach Roles",
  /** Read once per request for the Coach record's Active flag (Slice 3.1: inactive coaches never satisfy future staffing). */
  coaches: "Coaches",
} as const;
/** Every staffing evaluator declares the same sources, so the engine loads each table once and shares it. */
export const STAFFING_SOURCES: readonly string[] = Object.values(STAFFING_TABLES);

/** Fixed evaluator default (NA1.9): upcoming occurrences starting within the next 14 days. Not a Settings field. */
export const STAFFING_WINDOW_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const STAFFING_RULE_KEYS = ["session_no_coach", "no_lead_coach", "learning_coach_only", "session_understaffed"] as const;
export type StaffingRuleKey = (typeof STAFFING_RULE_KEYS)[number];

/** Calendar date (YYYY-MM-DD) of an instant in the organisation's timezone. */
export function localDateIso(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export type WindowState = "in_window" | "past_or_started" | "beyond_window" | "undated";

/**
 * The 14-day inclusion rule (Europe/London via the organisation timezone):
 *  - with a usable Start Date & Time: included iff now < start <= now + 14 x 24h
 *    (already started = past; exactly 14 days ahead = included);
 *  - without one (Date only): included iff todayLocal <= Date <= todayLocal + 14.
 */
export function windowState(occ: { fields: Record<string, any> }, now: Date, timeZone: string): WindowState {
  const startRaw = occ.fields["Start Date & Time"];
  const start = typeof startRaw === "string" && startRaw ? Date.parse(startRaw) : NaN;
  if (!Number.isNaN(start)) {
    if (start <= now.getTime()) return "past_or_started";
    return start - now.getTime() <= STAFFING_WINDOW_DAYS * DAY_MS ? "in_window" : "beyond_window";
  }
  const date = occ.fields["Date"];
  if (typeof date !== "string" || !ISO_DATE_RE.test(date)) return "undated";
  const today = localDateIso(now, timeZone);
  if (date < today) return "past_or_started";
  return date <= addDaysIso(today, STAFFING_WINDOW_DAYS) ? "in_window" : "beyond_window";
}

export type Ineligibility = "status_not_scheduled" | "superseded_by_replacement" | "session_missing" | "session_not_active" | WindowState;

/**
 * Is this occurrence expected to run and inside the window? Uses the real
 * Schedule model only: Status must be Scheduled (Cancelled / Postponed /
 * Completed never alert); an occurrence with an outgoing Replacement
 * Occurrence link is superseded (its replacement is evaluated on its own
 * merits); the Session must exist with Session Lifecycle Status Active
 * (the generator's own rule for sessions that run).
 */
export function occurrenceEligibility(occ: AirtableRecord, session: AirtableRecord | null, now: Date, timeZone: string): Ineligibility | null {
  if (selectName(occ.fields["Status"]) !== "Scheduled") return "status_not_scheduled";
  if (firstLink(occ.fields, "Replacement Occurrence")) return "superseded_by_replacement";
  if (!session) return "session_missing";
  if (selectName(session.fields["Session Lifecycle Status"]) !== "Active") return "session_not_active";
  const w = windowState(occ, now, timeZone);
  return w === "in_window" ? null : w;
}

/**
 * Why a resolved assignment does or does not count for FUTURE staffing:
 *  - valid            active Coach record + recognised active role (Lead Coach / Coach / Learning Coach)
 *  - inactive_coach   Coach record Active is not ticked - ignored (source data untouched)
 *  - coach_not_found  linked Coach record is not in the Coaches table - ignored + config issue
 *  - unknown_role     role missing, inactive or not one of the three recognised keys - ignored + config issue
 * Checked in that order (an inactive coach is ignored before its role is looked at).
 */
export type StaffStatus = "valid" | "inactive_coach" | "coach_not_found" | "unknown_role";

export interface StaffMember {
  coachId: string;
  roleKey: string | null;
  roleName: string | null;
  fromOccurrenceStaff: boolean;
  status: StaffStatus;
}

export interface StaffingAnalysis {
  occurrenceId: string;
  occurrenceName: string | null;
  sessionId: string;
  sessionName: string | null;
  dateIso: string | null;
  startIso: string | null;
  endIso: string | null;
  venueId: string | null;
  requiresLeadCoach: boolean;
  /** null = not specified (blank / not a whole number >= 0) - never inferred. */
  requiredStaffCount: number | null;
  /** Every resolved assignment, valid or not (valid ones first-class; the rest explain what was ignored). */
  staff: StaffMember[];
  /** Resolved assignments before validity filtering. */
  rosterCount: number;
  /** VALID staff (active coach + recognised role). "Zero staff" means total === 0. */
  total: number;
  leadCount: number;
  coachCount: number;
  learningCount: number;
  /** Ignored: active coach but missing / inactive / unrecognised role (config issue). */
  unknownRoleCount: number;
  /** Ignored: Coach record not Active. */
  inactiveCoachCount: number;
  /** Ignored: Coach record not found (config issue). */
  missingCoachCount: number;
  /** Counting staff = valid Lead Coach + valid Coach. */
  qualifying: number;
}

type RoleBucket = "lead" | "coach" | "learning" | "unknown";

function roleBucket(caps: CoachRoleCapabilities | null): RoleBucket {
  if (!caps || !caps.active) return "unknown";
  if (caps.roleKey === "lead_coach") return "lead";
  if (caps.roleKey === "coach") return "coach";
  if (caps.roleKey === "learning_coach") return "learning";
  return "unknown";
}

function requiredCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * @param coachById the Coaches table indexed by record id (Active flag). A coach
 *   id absent from it is `coach_not_found`.
 */
export function analyseStaffing(occ: AirtableRecord, session: AirtableRecord, roster: ResolvedOccurrenceCoach[], coachById: ReadonlyMap<string, AirtableRecord>): StaffingAnalysis {
  const n = { lead: 0, coach: 0, learning: 0, unknown: 0, inactive: 0, missing: 0 };
  const staff: StaffMember[] = roster.map((r) => {
    const coach = coachById.get(r.coachId);
    let status: StaffStatus;
    if (!coach) {
      status = "coach_not_found";
      n.missing++;
    } else if (coach.fields["Active"] !== true) {
      status = "inactive_coach";
      n.inactive++;
    } else {
      const bucket = roleBucket(r.roleCaps);
      n[bucket]++;
      status = bucket === "unknown" ? "unknown_role" : "valid";
    }
    return { coachId: r.coachId, roleKey: r.roleCaps?.roleKey || null, roleName: r.roleCaps?.roleName || null, fromOccurrenceStaff: r.fromOccurrenceStaff, status };
  });
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    occurrenceId: occ.id,
    occurrenceName: str(occ.fields["Occurrence Name"]),
    sessionId: session.id,
    sessionName: str(session.fields["Session Name"]),
    dateIso: str(occ.fields["Date"]),
    startIso: str(occ.fields["Start Date & Time"]),
    endIso: str(occ.fields["End Date & Time"]),
    venueId: firstLink(occ.fields, "Venue") || firstLink(session.fields, "Venue") || null,
    requiresLeadCoach: session.fields["Requires Lead Coach"] === true,
    requiredStaffCount: requiredCount(session.fields["Required Staff Count"]),
    staff,
    rosterCount: roster.length,
    total: n.lead + n.coach + n.learning,
    leadCount: n.lead,
    coachCount: n.coach,
    learningCount: n.learning,
    unknownRoleCount: n.unknown,
    inactiveCoachCount: n.inactive,
    missingCoachCount: n.missing,
    qualifying: n.lead + n.coach,
  };
}

/**
 * The LOCKED precedence (NA2.2 / NA3.3), decided once per occurrence on VALID
 * staff only (inactive coaches, missing Coach records and unknown roles have
 * already been removed - they never count and never stand in for a role):
 *  - 0 valid staff                   -> session_no_coach ONLY
 *  - Lead required and no Lead Coach -> no_lead_coach (incl. Learning-Coach-only)
 *  - valid staff are all Learning Coaches and Lead NOT required -> learning_coach_only
 *  - counting >= 1 and counting < Required Staff Count (when specified) -> session_understaffed
 *    (so it can co-exist with no_lead_coach, and never fires with 0 counting staff)
 * Overstaffing never raises anything. The result does not depend on which
 * rules are enabled - each evaluator only reads its own finding.
 */
export function staffingFindings(a: StaffingAnalysis): StaffingRuleKey[] {
  if (a.total === 0) return ["session_no_coach"];
  const out: StaffingRuleKey[] = [];
  if (a.requiresLeadCoach && a.leadCount === 0) out.push("no_lead_coach");
  if (a.qualifying === 0 && a.learningCount > 0 && !a.requiresLeadCoach) out.push("learning_coach_only");
  if (a.qualifying >= 1 && a.requiredStaffCount != null && a.qualifying < a.requiredStaffCount) out.push("session_understaffed");
  return out;
}

/** Config issues for assignments that were ignored because the data is wrong (not merely inactive). */
export function staffingIssues(a: StaffingAnalysis, timeZone: string): ConfigIssue[] {
  const where = `${a.sessionName ?? a.sessionId} on ${formatLocal(a.startIso, a.dateIso, timeZone)} (occurrence ${a.occurrenceId})`;
  const out: ConfigIssue[] = [];
  for (const m of a.staff) {
    if (m.status === "unknown_role") {
      const role = m.roleName || m.roleKey
        ? `role "${m.roleName || m.roleKey}", which is inactive or not a recognised staffing role`
        : "a missing or unresolvable role (no Role link, or a role snapshot that matches no Coach Roles row)";
      out.push({
        code: "staffing_role_unrecognised",
        recordId: a.occurrenceId,
        detail: `${where}: coach ${m.coachId} is assigned with ${role}. Recognised staffing roles are Lead Coach / Coach / Learning Coach. The assignment is ignored for staffing - it is not counted and not treated as a Learning Coach.`,
      });
    } else if (m.status === "coach_not_found") {
      out.push({
        code: "staffing_coach_not_found",
        recordId: a.occurrenceId,
        detail: `${where}: assigned coach ${m.coachId} has no Coaches record. The assignment is ignored for staffing.`,
      });
    }
  }
  return out;
}

export interface StaffingPass {
  analyses: StaffingAnalysis[];
  findings: Map<string, StaffingRuleKey[]>;
  skipped: Record<string, number>;
  /** Data problems found on eligible occurrences (unknown roles, missing Coach records). */
  issues: ConfigIssue[];
}

/** Diagnostics: how many full staffing passes have run (tests assert one per request). */
export const staffingPassStats = { passes: 0 };

/** One pass over the loaded tables: index once, resolve each eligible occurrence's roster once. */
export function runStaffingPass(sources: Readonly<Record<string, readonly AirtableRecord[]>>, now: Date, timeZone: string): StaffingPass {
  staffingPassStats.passes++;
  const T = STAFFING_TABLES;
  const occurrences = sources[T.occurrences] ?? [];
  const sessionById = new Map((sources[T.sessions] ?? []).map((s) => [s.id, s]));
  const sessionStaffRows = [...(sources[T.sessionStaff] ?? [])];
  const occurrenceStaffRows = sources[T.occurrenceStaff] ?? [];
  const coachRoleRows = [...(sources[T.coachRoles] ?? [])];
  const roleCapsById = roleCapabilitiesById(coachRoleRows);
  const roleCapsByNameMap = roleCapsByRoleName(coachRoleRows);
  const coachById = new Map((sources[T.coaches] ?? []).map((c) => [c.id, c]));
  const sessionStaffById: Record<string, any> = {};
  const staffBySession = new Map<string, any[]>();
  for (const r of sessionStaffRows) {
    sessionStaffById[r.id] = r;
    const sid = firstLink(r.fields, "Session");
    if (sid) staffBySession.set(sid, [...(staffBySession.get(sid) ?? []), r]);
  }
  const occStaffByOcc = new Map<string, any[]>();
  for (const r of occurrenceStaffRows) {
    const oid = firstLink(r.fields, "Session Occurrence");
    if (oid) occStaffByOcc.set(oid, [...(occStaffByOcc.get(oid) ?? []), r]);
  }

  const analyses: StaffingAnalysis[] = [];
  const findings = new Map<string, StaffingRuleKey[]>();
  const skipped: Record<string, number> = {};
  const issues: ConfigIssue[] = [];
  for (const occ of occurrences) {
    const session = sessionById.get(firstLink(occ.fields, "Session")) ?? null;
    const why = occurrenceEligibility(occ, session, now, timeZone);
    if (why) {
      skipped[why] = (skipped[why] ?? 0) + 1;
      continue;
    }
    const dateIso = typeof occ.fields["Date"] === "string" && ISO_DATE_RE.test(occ.fields["Date"]) ? occ.fields["Date"] : localDateIso(new Date(occ.fields["Start Date & Time"]), timeZone);
    const roster = resolveOccurrenceStaffing(dateIso, staffBySession.get(session!.id) ?? [], occStaffByOcc.get(occ.id) ?? [], roleCapsById, roleCapsByNameMap, sessionStaffById);
    const a = analyseStaffing(occ, session!, roster, coachById);
    analyses.push(a);
    findings.set(a.occurrenceId, staffingFindings(a));
    issues.push(...staffingIssues(a, timeZone));
  }
  return { analyses, findings, skipped, issues };
}

// One shared pass per request: every staffing evaluator receives the SAME
// loaded arrays from the engine, so the pass is memoised on the
// occurrences array identity (+ now + timezone). Nothing survives beyond
// the request's own arrays (WeakMap).
const passCache = new WeakMap<object, { key: string; pass: StaffingPass }>();

export function sharedStaffingPass(ctx: EvaluatorContext): StaffingPass {
  const occ = ctx.sources[STAFFING_TABLES.occurrences] ?? [];
  const key = `${ctx.now.getTime()}|${ctx.organisation.timezone}|${STAFFING_SOURCES.map((t) => (ctx.sources[t] ?? []).length).join(",")}`;
  const hit = passCache.get(occ);
  if (hit && hit.key === key) return hit.pass;
  const pass = runStaffingPass(ctx.sources, ctx.now, ctx.organisation.timezone);
  passCache.set(occ, { key, pass });
  return pass;
}

// ---------------------------------------------------------------------
// Case shaping (display-ready; no player data)
// ---------------------------------------------------------------------

const RULE_TITLES: Record<StaffingRuleKey, string> = {
  session_no_coach: "No staff assigned",
  no_lead_coach: "No Lead Coach",
  learning_coach_only: "No Lead Coach or Coach assigned",
  session_understaffed: "Understaffed",
};

export function staffingSummary(a: StaffingAnalysis): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => n && parts.push(`${n} ${n === 1 ? one : many}`);
  add(a.leadCount, "Lead Coach", "Lead Coaches");
  add(a.coachCount, "Coach", "Coaches");
  add(a.learningCount, "Learning Coach", "Learning Coaches");
  const valid = parts.length ? parts.join(", ") : a.rosterCount ? "no valid staff" : "no staff";
  const ignored: string[] = [];
  const ign = (n: number, one: string, many: string) => n && ignored.push(`${n} ${n === 1 ? one : many}`);
  ign(a.inactiveCoachCount, "inactive coach", "inactive coaches");
  ign(a.unknownRoleCount, "with an unrecognised role", "with unrecognised roles");
  ign(a.missingCoachCount, "unknown coach record", "unknown coach records");
  return ignored.length ? `${valid} (ignored: ${ignored.join(", ")})` : valid;
}

export function formatLocal(iso: string | null, dateIso: string | null, timeZone: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isNaN(t)) {
    // Assembled from parts so the text is identical on every runtime/ICU version: "Tue 6 Oct 2026, 11:00".
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
    const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
    return `${p("weekday")} ${p("day")} ${p("month")} ${p("year")}, ${p("hour")}:${p("minute")}`;
  }
  return dateIso ?? "date unknown";
}

export function staffingCase(rule: StaffingRuleKey, a: StaffingAnalysis, timeZone: string): CandidateCase {
  const when = formatLocal(a.startIso, a.dateIso, timeZone);
  const reasons: Record<StaffingRuleKey, string> = {
    session_no_coach: a.rosterCount ? "No valid staff are assigned for this occurrence." : "No staff are assigned for this occurrence.",
    no_lead_coach: "This session requires a Lead Coach, but none is assigned for this occurrence.",
    learning_coach_only: "Only Learning Coaches are assigned - no Lead Coach or Coach.",
    session_understaffed: `Counting staff (Lead Coach + Coach) is ${a.qualifying}, below the Required Staff Count of ${a.requiredStaffCount}.`,
  };
  return {
    subjects: [{ type: "occurrence", id: a.occurrenceId }],
    title: `${RULE_TITLES[rule]} - ${a.sessionName ?? "Session"}`,
    detail: `${when} - ${reasons[rule]} Staff: ${staffingSummary(a)}.`,
    anchors: { event: a.startIso },
    anchorTime: a.startIso ?? a.dateIso,
    destination: { route: "schedule/occurrence-staffing", params: { occurrenceId: a.occurrenceId, sessionId: a.sessionId } },
    targetIds: { occurrenceId: a.occurrenceId, sessionId: a.sessionId, ...(a.venueId ? { venueId: a.venueId } : {}) },
    relatedIds: {
      coachIds: a.staff.filter((s) => s.status === "valid").map((s) => s.coachId),
      ...(a.staff.some((s) => s.status !== "valid") ? { ignoredCoachIds: a.staff.filter((s) => s.status !== "valid").map((s) => s.coachId) } : {}),
    },
    context: {
      sessionName: a.sessionName,
      occurrenceName: a.occurrenceName,
      date: a.dateIso,
      start: a.startIso,
      end: a.endIso,
      startLocal: when,
      staffingSummary: staffingSummary(a),
      totalStaff: a.total,
      assignedStaff: a.rosterCount,
      inactiveCoachesIgnored: a.inactiveCoachCount,
      unknownCoachRecords: a.missingCoachCount,
      leadCoaches: a.leadCount,
      coaches: a.coachCount,
      learningCoaches: a.learningCount,
      unrecognisedRoles: a.unknownRoleCount,
      countingStaff: a.qualifying,
      requiredStaffCount: a.requiredStaffCount,
      requiresLeadCoach: a.requiresLeadCoach,
    },
  };
}

function staffingEvaluator(rule: StaffingRuleKey, ruleId: string): EvaluatorRegistration {
  return {
    ruleKey: rule,
    ruleId,
    sources: STAFFING_SOURCES,
    evaluate(ctx: EvaluatorContext): CandidateCase[] {
      const pass = sharedStaffingPass(ctx);
      for (const issue of pass.issues) ctx.reportIssue?.(issue);
      const out: CandidateCase[] = [];
      for (const a of pass.analyses) if (pass.findings.get(a.occurrenceId)!.includes(rule)) out.push(staffingCase(rule, a, ctx.organisation.timezone));
      return out;
    },
  };
}

/** The four Slice 3 registrations - Rule IDs must match the TEST catalogue (drift-tested). */
export const STAFFING_EVALUATORS: readonly EvaluatorRegistration[] = [
  staffingEvaluator("session_no_coach", "ATT-013"),
  staffingEvaluator("no_lead_coach", "ATT-001"),
  staffingEvaluator("learning_coach_only", "ATT-002"),
  staffingEvaluator("session_understaffed", "ATT-005"),
];
