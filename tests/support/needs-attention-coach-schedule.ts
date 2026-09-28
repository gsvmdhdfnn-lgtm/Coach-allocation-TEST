/**
 * Test-suite copy of the canonical needs-attention/coach-schedule.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Coach schedule evaluators for Needs Attention Slice 7 (see TEST-ENV.md
 * "Needs Attention Foundation - Slice 7"): assigned_coach_unavailable
 * (ATT-014) and coach_schedule_conflict (ATT-012).
 *
 * Source of truth for availability is the Coaches Slice 7 availability
 * domain. The block between the two COPIED markers is extracted VERBATIM
 * from coach-availability/coach-availability.ts (row interpretation, the
 * exception > recurring precedence and resolveAvailability); tests assert
 * every chunk still appears byte-for-byte there and in coach-cover's copy,
 * so there is exactly one interpretation of "has this coach said they are
 * available for this time". Availability is not "free": commitments are
 * never consulted by the resolver - clashing work is ATT-012's job.
 *
 *   ATT-014: one case per eligible occurrence x resolved ACTIVE coach whose
 *     availability for the occurrence's UK date and wall-clock times
 *     resolves to "unavailable" (any reason: an Unavailable exception, a
 *     recurring Available = false window, or work outside the hours the
 *     coach supplied for that date). "unknown" (nothing supplied) never
 *     raises a case. "ambiguous" (malformed / contradictory availability
 *     rows) never raises a case either - it is surfaced as the config
 *     issue availability_ambiguous (locked Slice 7 decision).
 *   ATT-012: one case per coach per unordered pair of eligible occurrences
 *     the coach is resolved onto whose [start, end) intervals overlap
 *     (half-open: back-to-back is not a conflict - the coach-cover rule).
 *     BOTH occurrences must pass the Slice 3 eligibility filter (locked
 *     Slice 7 decision). Key: occurrence ids sorted ascending.
 *
 * Who is assigned comes ONLY from the shared staffing pass (staffing.ts):
 * effective-dated Session Staff + that date's Occurrence Staff (cover
 * replacements, additions, Absent rows) on eligible occurrences within the
 * 14-day window. Inactive coaches and missing Coach records are excluded;
 * an active coach whose role is unrecognised is still physically assigned,
 * so is still checked (same as Slice 6). Occurrences without usable
 * Start/End Date & Time are never given invented timing: they raise no
 * case and are reported as config issues.
 *
 * One shared availability pass and one shared conflict pass per request
 * (memoised); availability rows are grouped by coach once. No per-coach or
 * per-occurrence queries.
 */
import type { AirtableRecord, CandidateCase, ConfigIssue, EvaluatorContext, EvaluatorRegistration } from "./needs-attention-engine.ts";
import { STAFFING_SOURCES, formatLocal, sharedStaffingPass, type StaffMember, type StaffingAnalysis, type StaffingPass } from "./needs-attention-staffing.ts";

// ===== COPIED FROM coach-availability/coach-availability.ts - DO NOT EDIT HERE =====
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTES_PER_DAY = 24 * 60;

export type AvailabilityStatus = "available" | "unavailable" | "unknown" | "ambiguous";

export const KNOWN_EXCEPTION_TYPES = ["Unavailable", "Available All Day", "Different Hours"] as const;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface AvailabilityRecord {
  id: string;
  fields: Record<string, any>;
}

export interface AvailabilityQuery {
  coachId: string;
  /** UK calendar date, "YYYY-MM-DD". */
  date: string;
  /** UK wall-clock "HH:MM". */
  startTime: string;
  endTime: string;
}

export interface Window {
  start: string;
  end: string;
}

export interface AvailabilityProblem {
  recordId: string;
  table: "Coach Availability" | "Coach Availability Exceptions";
  issue: string;
}

export interface AvailabilityResult {
  status: AvailabilityStatus;
  reason: string;
  coachId: string;
  date: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  /** Which layer decided the answer. */
  source: "exception" | "recurring" | "none";
  /** The record/window that decided an "available" (or a window-based "unavailable") answer, when there is exactly one. */
  matchedRecordId: string | null;
  matchedWindow: Window | null;
  /** Every applicable row that was considered, for Management/developer diagnosis. */
  consideredExceptions: Array<{ id: string; type: string; startDate: string | null; endDate: string | null; window: Window | null }>;
  consideredRecurring: Array<{ id: string; available: boolean; window: Window | null }>;
  problems: AvailabilityProblem[];
}

function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

function linkIds(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x?.id)).filter((x): x is string => typeof x === "string");
}

/** "17:00"/"9:30" -> minutes since midnight. null for blank/garbled/out-of-range - callers fail closed. */
export function parseTimeToMinutes(raw: any): number | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function isBlank(v: any): boolean {
  return v == null || String(v).trim() === "";
}

/** Strict "YYYY-MM-DD" that is also a real calendar date (rejects 2026-02-30). */
export function isValidIsoDate(s: any): s is string {
  const m = DATE_RE.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Day name for a plain calendar date - computed at UTC midnight so the host's own timezone can never shift it. */
export function dayOfWeekForDate(dateIso: string): string {
  const m = DATE_RE.exec(dateIso)!;
  return DAY_NAMES[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

/**
 * Converts a real instant to its Europe/London calendar date and wall-clock
 * "HH:MM" - the single BST/GMT-aware step, via Intl rather than hand-rolled
 * clock-change rules. Returns null for an unparseable instant.
 */
export function ukWallClockFromInstant(instantIso: any): { date: string; time: string } | null {
  if (typeof instantIso !== "string" || !instantIso.trim()) return null;
  const d = new Date(instantIso);
  if (isNaN(d.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(d)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

/** Interval containment: work fits entirely inside the window. Boundary equality counts as inside. */
export function windowContains(winStart: number, winEnd: number, workStart: number, workEnd: number): boolean {
  return winStart <= workStart && workEnd <= winEnd;
}

/** Overlap of half-open intervals - an unavailable window ending exactly when work starts does not block it. */
export function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function fmt(min: number): string {
  if (min === MINUTES_PER_DAY) return "24:00";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------
// Row interpretation. Each row is classified once into either a clean,
// usable shape or a problem. Malformed rows are never silently dropped
// when they could apply to the query - see resolveAvailability().
// ---------------------------------------------------------------------

type RecurringRow =
  | { ok: true; id: string; day: string; available: boolean; start: number; end: number; allDay: boolean }
  | { ok: false; id: string; day: string | null; issue: string };

function interpretRecurring(r: AvailabilityRecord): RecurringRow {
  const day = selectName(r.fields["Day of Week"]);
  const dayOk = (DAY_NAMES as readonly string[]).includes(day);
  const available = r.fields["Available"] === true;
  const rawStart = r.fields["Start Time"];
  const rawEnd = r.fields["End Time"];
  if (!dayOk) return { ok: false, id: r.id, day: null, issue: "Day of Week is blank or unrecognised" };

  // An explicit "not available" row with no times is a whole-day
  // declaration - the conservative reading. A positive row with no times
  // is never assumed to mean "all day"; it is incomplete.
  if (!available && isBlank(rawStart) && isBlank(rawEnd)) {
    return { ok: true, id: r.id, day, available: false, start: 0, end: MINUTES_PER_DAY, allDay: true };
  }
  const start = parseTimeToMinutes(rawStart);
  const end = parseTimeToMinutes(rawEnd);
  if (start == null || end == null) return { ok: false, id: r.id, day, issue: `Start Time/End Time missing or not HH:MM ("${rawStart ?? ""}"-"${rawEnd ?? ""}")` };
  if (end <= start) return { ok: false, id: r.id, day, issue: `End Time ${fmt(end)} is not after Start Time ${fmt(start)}` };
  return { ok: true, id: r.id, day, available, start, end, allDay: false };
}

type ExceptionRow =
  | { ok: true; id: string; type: string; startDate: string; endDate: string; start: number; end: number; allDay: boolean }
  | { ok: false; id: string; startDate: string | null; endDate: string | null; issue: string };

function interpretException(r: AvailabilityRecord): ExceptionRow {
  const type = selectName(r.fields["Availability Type"]);
  const rawStartDate = r.fields["Start Date"];
  const rawEndDate = r.fields["End Date"];
  const startDate = isValidIsoDate(rawStartDate) ? rawStartDate : null;
  // A blank End Date means a single-day exception (the narrower reading);
  // a present-but-garbled End Date is malformed, never guessed.
  const endDate = isBlank(rawEndDate) ? startDate : isValidIsoDate(rawEndDate) ? rawEndDate : null;

  if (!startDate) return { ok: false, id: r.id, startDate: null, endDate: null, issue: "Start Date is blank or not a valid date" };
  if (!endDate) return { ok: false, id: r.id, startDate, endDate: null, issue: "End Date is not a valid date" };
  if (endDate < startDate) return { ok: false, id: r.id, startDate: null, endDate: null, issue: `End Date ${endDate} is before Start Date ${startDate}` };
  if (!(KNOWN_EXCEPTION_TYPES as readonly string[]).includes(type)) {
    return { ok: false, id: r.id, startDate, endDate, issue: "Availability Type is blank or unrecognised" };
  }

  const rawStart = r.fields["Start Time"];
  const rawEnd = r.fields["End Time"];
  const bothBlank = isBlank(rawStart) && isBlank(rawEnd);

  if (type === "Available All Day") {
    if (!bothBlank) return { ok: false, id: r.id, startDate, endDate, issue: "Available All Day exception also carries Start/End Time - contradictory" };
    return { ok: true, id: r.id, type, startDate, endDate, start: 0, end: MINUTES_PER_DAY, allDay: true };
  }
  if (type === "Unavailable" && bothBlank) {
    return { ok: true, id: r.id, type, startDate, endDate, start: 0, end: MINUTES_PER_DAY, allDay: true };
  }
  const start = parseTimeToMinutes(rawStart);
  const end = parseTimeToMinutes(rawEnd);
  if (start == null || end == null) return { ok: false, id: r.id, startDate, endDate, issue: `${type} exception needs both Start Time and End Time as HH:MM` };
  if (end <= start) return { ok: false, id: r.id, startDate, endDate, issue: `End Time ${fmt(end)} is not after Start Time ${fmt(start)}` };
  return { ok: true, id: r.id, type, startDate, endDate, start, end, allDay: false };
}

function isActiveForCoach(r: AvailabilityRecord, coachId: string): boolean {
  return r.fields["Active"] === true && linkIds(r.fields["Coach"]).includes(coachId);
}

/**
 * The single resolution entry point. Precedence, top to bottom:
 *
 * 1. Exceptions covering the date (inclusive Start/End Date) are consulted
 *    first. Any malformed exception that could cover the date, or any
 *    conflict between covering exceptions, returns "ambiguous" - never a
 *    guess, never "latest wins".
 * 2. Positive exceptions (Available All Day / Different Hours) replace
 *    the recurring pattern for that date entirely. Several non-overlapping
 *    Different Hours rows are separate windows (never merged).
 * 3. An Unavailable exception: whole-day -> unavailable; timed -> blocks
 *    only its own window, and the rest of the day falls through to the
 *    recurring pattern (a 10:00-11:00 dentist appointment does not erase
 *    the coach's evening availability).
 * 4. Recurring rows for that weekday. An Available=false window
 *    overlapping the work always wins; otherwise the work must fit
 *    entirely inside ONE Available=true window (windows are never merged).
 *    If the coach supplied positive windows that day and none contains
 *    the work -> unavailable. If nothing positive was supplied for that
 *    day at all -> unknown, never silently unavailable.
 */
export function resolveAvailability(
  query: AvailabilityQuery,
  recurringRecords: AvailabilityRecord[],
  exceptionRecords: AvailabilityRecord[]
): AvailabilityResult {
  const workStart = parseTimeToMinutes(query.startTime)!;
  const workEnd = parseTimeToMinutes(query.endTime)!;
  const dayOfWeek = dayOfWeekForDate(query.date);
  const problems: AvailabilityProblem[] = [];

  const base = {
    coachId: query.coachId,
    date: query.date,
    dayOfWeek,
    startTime: fmt(workStart),
    endTime: fmt(workEnd),
  };

  // ---- Exceptions ----------------------------------------------------
  const exceptions = exceptionRecords.filter((r) => isActiveForCoach(r, query.coachId)).map(interpretException);
  const covering: Extract<ExceptionRow, { ok: true }>[] = [];
  for (const ex of exceptions) {
    if (ex.ok) {
      if (ex.startDate <= query.date && query.date <= ex.endDate) covering.push(ex);
      continue;
    }
    // A malformed exception whose dates are readable only matters inside
    // its own range; one whose placement is unknowable could cover any
    // date, so it is treated as covering this one (fail closed).
    const placementKnown = ex.startDate != null && ex.endDate != null;
    if (!placementKnown || (ex.startDate! <= query.date && query.date <= ex.endDate!)) {
      problems.push({ recordId: ex.id, table: "Coach Availability Exceptions", issue: ex.issue });
    }
  }

  const consideredExceptions = covering.map((e) => ({
    id: e.id,
    type: e.type,
    startDate: e.startDate,
    endDate: e.endDate,
    window: e.allDay ? null : { start: fmt(e.start), end: fmt(e.end) },
  }));

  const result = (partial: Omit<AvailabilityResult, keyof typeof base | "consideredExceptions" | "consideredRecurring" | "problems"> & { consideredRecurring?: AvailabilityResult["consideredRecurring"] }): AvailabilityResult => ({
    ...base,
    consideredExceptions,
    consideredRecurring: partial.consideredRecurring ?? [],
    problems,
    status: partial.status,
    reason: partial.reason,
    source: partial.source,
    matchedRecordId: partial.matchedRecordId,
    matchedWindow: partial.matchedWindow,
  });

  if (problems.length) {
    return result({ status: "ambiguous", reason: "malformed_exception", source: "exception", matchedRecordId: null, matchedWindow: null });
  }

  const positives = covering.filter((e) => e.type !== "Unavailable");
  const negatives = covering.filter((e) => e.type === "Unavailable");

  // Genuine contradictions only: an Unavailable window overlapping a
  // positive window in time, or two positive windows that overlap without
  // being identical (e.g. Available All Day + Different Hours, or 09-12 vs
  // 11-14 - most likely a correction left in place). Non-overlapping
  // Different Hours rows are separate valid windows; identical duplicates
  // and a timed Unavailable outside every positive window are consistent.
  const conflicting = new Set<typeof covering[number]>();
  for (const n of negatives) {
    for (const p of positives) {
      if (windowsOverlap(n.start, n.end, p.start, p.end)) conflicting.add(n).add(p);
    }
  }
  for (let i = 0; i < positives.length; i++) {
    for (let j = i + 1; j < positives.length; j++) {
      const a = positives[i], b = positives[j];
      const identical = a.start === b.start && a.end === b.end;
      if (!identical && windowsOverlap(a.start, a.end, b.start, b.end)) conflicting.add(a).add(b);
    }
  }
  if (conflicting.size) {
    for (const e of covering.filter((c) => conflicting.has(c))) {
      problems.push({ recordId: e.id, table: "Coach Availability Exceptions", issue: `conflicts with another exception covering ${query.date} (${e.type}${e.allDay ? "" : ` ${fmt(e.start)}-${fmt(e.end)}`})` });
    }
    return result({ status: "ambiguous", reason: "conflicting_exceptions", source: "exception", matchedRecordId: null, matchedWindow: null });
  }

  if (positives.length) {
    // Each positive exception is its own window - never merged, same rule as recurring windows.
    const containing = positives.find((p) => windowContains(p.start, p.end, workStart, workEnd));
    if (containing) {
      return result({ status: "available", reason: containing.allDay ? "exception_available_all_day" : "within_exception_hours", source: "exception", matchedRecordId: containing.id, matchedWindow: { start: fmt(containing.start), end: fmt(containing.end) } });
    }
    const only = positives.length === 1 ? positives[0] : null;
    return result({ status: "unavailable", reason: "outside_exception_hours", source: "exception", matchedRecordId: only?.id ?? null, matchedWindow: only ? { start: fmt(only.start), end: fmt(only.end) } : null });
  }

  const blocking = negatives.find((n) => windowsOverlap(n.start, n.end, workStart, workEnd));
  if (blocking) {
    return result({
      status: "unavailable",
      reason: "exception_unavailable",
      source: "exception",
      matchedRecordId: blocking.id,
      matchedWindow: blocking.allDay ? null : { start: fmt(blocking.start), end: fmt(blocking.end) },
    });
  }

  // ---- Recurring -----------------------------------------------------
  const recurring = recurringRecords.filter((r) => isActiveForCoach(r, query.coachId)).map(interpretRecurring);
  const sameDay: Extract<RecurringRow, { ok: true }>[] = [];
  for (const row of recurring) {
    if (row.ok) {
      if (row.day === dayOfWeek) sameDay.push(row);
      continue;
    }
    // Unknown weekday -> could be this day; known weekday -> only matters on that day.
    if (row.day == null || row.day === dayOfWeek) {
      problems.push({ recordId: row.id, table: "Coach Availability", issue: row.issue });
    }
  }
  const consideredRecurring = sameDay.map((r) => ({ id: r.id, available: r.available, window: r.allDay ? null : { start: fmt(r.start), end: fmt(r.end) } }));

  if (problems.length) {
    return result({ status: "ambiguous", reason: "malformed_recurring_availability", source: "recurring", matchedRecordId: null, matchedWindow: null, consideredRecurring });
  }

  const declaredUnavailable = sameDay.find((r) => !r.available && windowsOverlap(r.start, r.end, workStart, workEnd));
  if (declaredUnavailable) {
    return result({
      status: "unavailable",
      reason: "declared_unavailable_recurring",
      source: "recurring",
      matchedRecordId: declaredUnavailable.id,
      matchedWindow: declaredUnavailable.allDay ? null : { start: fmt(declaredUnavailable.start), end: fmt(declaredUnavailable.end) },
      consideredRecurring,
    });
  }

  const positiveWindows = sameDay.filter((r) => r.available);
  const containing = positiveWindows.find((r) => windowContains(r.start, r.end, workStart, workEnd));
  if (containing) {
    return result({ status: "available", reason: "within_recurring_window", source: "recurring", matchedRecordId: containing.id, matchedWindow: { start: fmt(containing.start), end: fmt(containing.end) }, consideredRecurring });
  }
  if (positiveWindows.length) {
    return result({ status: "unavailable", reason: "outside_recurring_windows", source: "recurring", matchedRecordId: null, matchedWindow: null, consideredRecurring });
  }
  return result({ status: "unknown", reason: "no_availability_supplied", source: "none", matchedRecordId: null, matchedWindow: null, consideredRecurring });
}
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Needs Attention coach-schedule analysis (Slice 7). Built ON the copied
// resolver and the shared staffing pass - it never re-derives either.
// ---------------------------------------------------------------------

export const AVAILABILITY_TABLES = {
  recurring: "Coach Availability",
  exceptions: "Coach Availability Exceptions",
} as const;
/** ATT-014 needs the staffing tables plus the two availability tables; the engine loads the union once each. */
export const UNAVAILABLE_SOURCES: readonly string[] = [...STAFFING_SOURCES, ...Object.values(AVAILABILITY_TABLES)];
/** ATT-012 needs only the staffing tables (conflicts are about commitments, not availability). */
export const CONFLICT_SOURCES: readonly string[] = STAFFING_SOURCES;

/** Resolved assignments that count for coach-level cases: an Active Coach record (role recognised or not). */
function countsAsAssigned(m: StaffMember): boolean {
  return m.status === "valid" || m.status === "unknown_role";
}

const SCHEDULE_ROUTE_UNAVAILABLE = "schedule/occurrence-staffing"; // placeholder UI route - see TEST-ENV.md
const SCHEDULE_ROUTE_CONFLICT = "coaches/schedule-conflict"; // placeholder UI route - see TEST-ENV.md

// ---------------------------------------------------------------------
// ATT-014 assigned_coach_unavailable
// ---------------------------------------------------------------------

export interface UnavailableFinding {
  analysis: StaffingAnalysis;
  member: StaffMember;
  availability: AvailabilityResult;
}

export interface AvailabilityPass {
  findings: UnavailableFinding[];
  /** How each evaluated assignment resolved (diagnostics + tests). */
  statusCounts: Record<string, number>;
  issues: ConfigIssue[];
}

export const availabilityPassStats = { passes: 0, resolutions: 0 };

/**
 * The occurrence's UK date + wall-clock interval, derived from its real
 * Start/End Date & Time exactly like coach-cover's availabilityFor(): both
 * instants must parse, fall on the same UK date, and end after start.
 * Anything else is not evaluable - never an invented time.
 */
export function occurrenceWallClock(startIso: string | null, endIso: string | null): { date: string; startTime: string; endTime: string } | null {
  const s = ukWallClockFromInstant(startIso);
  const e = ukWallClockFromInstant(endIso);
  if (!s || !e || s.date !== e.date || e.time <= s.time) return null;
  return { date: s.date, startTime: s.time, endTime: e.time };
}

function groupByCoach(rows: readonly AirtableRecord[]): Map<string, AvailabilityRecord[]> {
  const out = new Map<string, AvailabilityRecord[]>();
  for (const r of rows) for (const c of new Set(linkIds(r.fields["Coach"]))) out.set(c, [...(out.get(c) ?? []), r]);
  return out;
}

export function runAvailabilityPass(staffing: StaffingPass, sources: Readonly<Record<string, readonly AirtableRecord[]>>, timeZone: string): AvailabilityPass {
  availabilityPassStats.passes++;
  const recurringByCoach = groupByCoach(sources[AVAILABILITY_TABLES.recurring] ?? []);
  const exceptionsByCoach = groupByCoach(sources[AVAILABILITY_TABLES.exceptions] ?? []);
  const findings: UnavailableFinding[] = [];
  const statusCounts: Record<string, number> = {};
  const issues: ConfigIssue[] = [];
  for (const a of staffing.analyses) {
    const assigned = a.staff.filter(countsAsAssigned);
    if (!assigned.length) continue;
    const wall = occurrenceWallClock(a.startIso, a.endIso);
    if (!wall) {
      statusCounts.not_evaluable = (statusCounts.not_evaluable ?? 0) + assigned.length;
      issues.push({
        code: "availability_not_evaluable",
        recordId: a.occurrenceId,
        detail: `${a.sessionName ?? a.sessionId} on ${formatLocal(a.startIso, a.dateIso, timeZone)} (occurrence ${a.occurrenceId}): no usable Start/End Date & Time on one UK date, so assigned coaches' availability cannot be checked. No time is invented.`,
      });
      continue;
    }
    for (const m of assigned) {
      availabilityPassStats.resolutions++;
      const res = resolveAvailability({ coachId: m.coachId, date: wall.date, startTime: wall.startTime, endTime: wall.endTime }, recurringByCoach.get(m.coachId) ?? [], exceptionsByCoach.get(m.coachId) ?? []);
      statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
      if (res.status === "unavailable") findings.push({ analysis: a, member: m, availability: res });
      else if (res.status === "ambiguous") {
        const rows = res.problems.map((p) => `${p.table} ${p.recordId}: ${p.issue}`).join("; ");
        issues.push({
          code: "availability_ambiguous",
          recordId: a.occurrenceId,
          detail: `Coach ${m.coachId} on occurrence ${a.occurrenceId} (${wall.date} ${wall.startTime}-${wall.endTime}): availability is ambiguous (${res.reason})${rows ? ` - ${rows}` : ""}. No unavailable case is raised; fix the availability rows.`,
        });
      }
    }
  }
  return { findings, statusCounts, issues };
}

const availabilityCache = new WeakMap<object, { key: string; pass: AvailabilityPass }>();

export function sharedAvailabilityPass(ctx: EvaluatorContext): AvailabilityPass {
  const staffing = sharedStaffingPass(ctx);
  const recurring = ctx.sources[AVAILABILITY_TABLES.recurring] ?? [];
  const key = `${(ctx.sources[AVAILABILITY_TABLES.exceptions] ?? []).length}|${recurring.length}`;
  const hit = availabilityCache.get(staffing);
  if (hit && hit.key === key) return hit.pass;
  const pass = runAvailabilityPass(staffing, ctx.sources, ctx.organisation.timezone);
  availabilityCache.set(staffing, { key, pass });
  return pass;
}

function coachNameOf(sources: Readonly<Record<string, readonly AirtableRecord[]>>, coachId: string): string | null {
  const c = (sources["Coaches"] ?? []).find((r) => r.id === coachId);
  const n = c?.fields["Coach Name"];
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

const AVAILABILITY_REASON_TEXT: Record<string, string> = {
  exception_unavailable: "an Unavailable exception covers this time",
  outside_exception_hours: "the session is outside the hours the coach gave for this date",
  declared_unavailable_recurring: "the coach's weekly availability marks this time as not available",
  outside_recurring_windows: "the session is outside the weekly hours the coach supplied for this day",
};

export function unavailableCase(f: UnavailableFinding, coachName: string | null, timeZone: string): CandidateCase {
  const a = f.analysis;
  const r = f.availability;
  const when = formatLocal(a.startIso, a.dateIso, timeZone);
  const who = coachName ?? "A coach";
  const why = AVAILABILITY_REASON_TEXT[r.reason] ?? r.reason;
  return {
    subjects: [
      { type: "occurrence", id: a.occurrenceId },
      { type: "coach", id: f.member.coachId },
    ],
    title: `Assigned coach unavailable - ${who} - ${a.sessionName ?? "Session"}`,
    detail: `${when} - ${who} is assigned${f.member.roleName ? ` as ${f.member.roleName}` : ""} but is unavailable: ${why}.`,
    anchors: { event: a.startIso },
    anchorTime: a.startIso ?? a.dateIso,
    destination: { route: SCHEDULE_ROUTE_UNAVAILABLE, params: { occurrenceId: a.occurrenceId, sessionId: a.sessionId, coachId: f.member.coachId } },
    targetIds: { occurrenceId: a.occurrenceId, sessionId: a.sessionId, coachId: f.member.coachId },
    relatedIds: r.matchedRecordId ? { availabilityRecordIds: [r.matchedRecordId] } : {},
    context: {
      coachId: f.member.coachId,
      coachName,
      coachRole: f.member.roleName,
      assignedVia: f.member.fromOccurrenceStaff ? "Occurrence Staff" : "Session Staff",
      sessionId: a.sessionId,
      sessionName: a.sessionName,
      occurrenceId: a.occurrenceId,
      occurrenceName: a.occurrenceName,
      date: a.dateIso,
      start: a.startIso,
      end: a.endIso,
      startLocal: when,
      availabilityStatus: r.status,
      availabilityReason: r.reason,
      availabilityReasonText: why,
      availabilitySource: r.source,
      availabilityRecordId: r.matchedRecordId,
      availabilityWindow: r.matchedWindow ? `${r.matchedWindow.start}-${r.matchedWindow.end}` : null,
      requestedWindow: `${r.startTime}-${r.endTime}`,
      availabilityDate: r.date,
    },
  };
}

export const UNAVAILABLE_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "assigned_coach_unavailable",
  ruleId: "ATT-014",
  sources: UNAVAILABLE_SOURCES,
  evaluate(ctx: EvaluatorContext): CandidateCase[] {
    const staffing = sharedStaffingPass(ctx);
    for (const issue of staffing.issues) ctx.reportIssue?.(issue);
    const pass = sharedAvailabilityPass(ctx);
    for (const issue of pass.issues) ctx.reportIssue?.(issue);
    return pass.findings.map((f) => unavailableCase(f, coachNameOf(ctx.sources, f.member.coachId), ctx.organisation.timezone));
  },
};

// ---------------------------------------------------------------------
// ATT-012 coach_schedule_conflict
// ---------------------------------------------------------------------

interface TimedAssignment {
  analysis: StaffingAnalysis;
  member: StaffMember;
  startMs: number;
  endMs: number;
}

export interface ConflictFinding {
  coachId: string;
  /** Sorted by occurrence record id (ascending) - the key order. */
  first: TimedAssignment;
  second: TimedAssignment;
  overlapStartMs: number;
  overlapEndMs: number;
}

export interface ConflictPass {
  findings: ConflictFinding[];
  issues: ConfigIssue[];
}

export const conflictPassStats = { passes: 0 };

/** Usable real instants: both parse and end is after start. Otherwise null - timing is never invented. */
export function occurrenceInterval(startIso: string | null, endIso: string | null): { startMs: number; endMs: number } | null {
  const s = startIso ? Date.parse(startIso) : NaN;
  const e = endIso ? Date.parse(endIso) : NaN;
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return { startMs: s, endMs: e };
}

/** Half-open [start, end) overlap - the coach-cover rule: back-to-back (end === start) is NOT a conflict. */
export function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Every eligible occurrence in the staffing pass is already Slice-3
 * eligible, so BOTH members of a pair are eligible by construction.
 * One finding per coach per unordered pair; pairs are formed only between
 * DIFFERENT occurrences the same coach is resolved onto.
 */
export function runConflictPass(staffing: StaffingPass, timeZone: string): ConflictPass {
  conflictPassStats.passes++;
  const timedByCoach = new Map<string, TimedAssignment[]>();
  const untimedByCoach = new Map<string, StaffingAnalysis[]>();
  const datesByCoach = new Map<string, Set<string>>();
  for (const a of staffing.analyses) {
    const iv = occurrenceInterval(a.startIso, a.endIso);
    for (const m of a.staff) {
      if (!countsAsAssigned(m)) continue;
      if (a.dateIso) datesByCoach.set(m.coachId, (datesByCoach.get(m.coachId) ?? new Set()).add(a.dateIso));
      if (iv) timedByCoach.set(m.coachId, [...(timedByCoach.get(m.coachId) ?? []), { analysis: a, member: m, ...iv }]);
      else untimedByCoach.set(m.coachId, [...(untimedByCoach.get(m.coachId) ?? []), a]);
    }
  }
  const findings: ConflictFinding[] = [];
  const issues: ConfigIssue[] = [];
  for (const coachId of [...timedByCoach.keys()].sort()) {
    const list = [...timedByCoach.get(coachId)!].sort((x, y) => (x.analysis.occurrenceId < y.analysis.occurrenceId ? -1 : 1));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i], y = list[j];
        if (x.analysis.occurrenceId === y.analysis.occurrenceId) continue;
        if (!intervalsOverlap(x.startMs, x.endMs, y.startMs, y.endMs)) continue;
        findings.push({ coachId, first: x, second: y, overlapStartMs: Math.max(x.startMs, y.startMs), overlapEndMs: Math.min(x.endMs, y.endMs) });
      }
    }
  }
  // An untimed occurrence can only be checked against the same coach's other work on that UK date: report it, never guess.
  for (const [coachId, list] of untimedByCoach) {
    for (const a of list) {
      const sameDay = staffing.analyses.some((o) => o.occurrenceId !== a.occurrenceId && o.dateIso === a.dateIso && o.staff.some((m) => m.coachId === coachId && countsAsAssigned(m)));
      if (!sameDay) continue;
      issues.push({
        code: "conflict_not_evaluable",
        recordId: a.occurrenceId,
        detail: `Coach ${coachId} is on occurrence ${a.occurrenceId} (${a.sessionName ?? a.sessionId}, ${formatLocal(a.startIso, a.dateIso, timeZone)}) and on other work the same day, but this occurrence has no usable Start/End Date & Time, so a clash cannot be ruled out. No case is raised.`,
      });
    }
  }
  return { findings, issues };
}

const conflictCache = new WeakMap<object, ConflictPass>();

export function sharedConflictPass(ctx: EvaluatorContext): ConflictPass {
  const staffing = sharedStaffingPass(ctx);
  const hit = conflictCache.get(staffing);
  if (hit) return hit;
  const pass = runConflictPass(staffing, ctx.organisation.timezone);
  conflictCache.set(staffing, pass);
  return pass;
}

function hhmm(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("hour")}:${p("minute")}`;
}

export function conflictCase(f: ConflictFinding, coachName: string | null, timeZone: string): CandidateCase {
  const A = f.first.analysis, B = f.second.analysis;
  const who = coachName ?? "A coach";
  const earlier = f.first.startMs <= f.second.startMs ? f.first : f.second;
  const describe = (t: TimedAssignment) => `${t.analysis.sessionName ?? "Session"} ${formatLocal(t.analysis.startIso, t.analysis.dateIso, timeZone)}-${hhmm(t.endMs, timeZone)}${t.member.roleName ? ` (${t.member.roleName})` : ""}`;
  const overlapMinutes = Math.round((f.overlapEndMs - f.overlapStartMs) / 60000);
  return {
    subjects: [
      { type: "coach", id: f.coachId },
      { type: "occurrence", id: A.occurrenceId },
      { type: "occurrence", id: B.occurrenceId },
    ],
    title: `Coach scheduling conflict - ${who}`,
    detail: `${who} is assigned to two overlapping sessions: ${describe(f.first)} and ${describe(f.second)}. They overlap ${hhmm(f.overlapStartMs, timeZone)}-${hhmm(f.overlapEndMs, timeZone)} (${overlapMinutes} min).`,
    anchors: { event: earlier.analysis.startIso },
    anchorTime: earlier.analysis.startIso,
    destination: { route: SCHEDULE_ROUTE_CONFLICT, params: { coachId: f.coachId, occurrenceIdA: A.occurrenceId, occurrenceIdB: B.occurrenceId } },
    targetIds: { coachId: f.coachId, occurrenceId: earlier.analysis.occurrenceId, sessionId: earlier.analysis.sessionId },
    relatedIds: { occurrenceIds: [A.occurrenceId, B.occurrenceId], sessionIds: [...new Set([A.sessionId, B.sessionId])] },
    context: {
      coachId: f.coachId,
      coachName,
      occurrenceIdA: A.occurrenceId,
      occurrenceNameA: A.occurrenceName,
      sessionIdA: A.sessionId,
      sessionNameA: A.sessionName,
      startA: A.startIso,
      endA: A.endIso,
      roleA: f.first.member.roleName,
      occurrenceIdB: B.occurrenceId,
      occurrenceNameB: B.occurrenceName,
      sessionIdB: B.sessionId,
      sessionNameB: B.sessionName,
      startB: B.startIso,
      endB: B.endIso,
      roleB: f.second.member.roleName,
      overlapStart: new Date(f.overlapStartMs).toISOString(),
      overlapEnd: new Date(f.overlapEndMs).toISOString(),
      overlapMinutes,
    },
  };
}

export const CONFLICT_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "coach_schedule_conflict",
  ruleId: "ATT-012",
  sources: CONFLICT_SOURCES,
  evaluate(ctx: EvaluatorContext): CandidateCase[] {
    const staffing = sharedStaffingPass(ctx);
    for (const issue of staffing.issues) ctx.reportIssue?.(issue);
    const pass = sharedConflictPass(ctx);
    for (const issue of pass.issues) ctx.reportIssue?.(issue);
    return pass.findings.map((f) => conflictCase(f, coachNameOf(ctx.sources, f.coachId), ctx.organisation.timezone));
  },
};

/** The two Slice 7 registrations - Rule IDs must match the TEST catalogue (drift-tested). */
export const COACH_SCHEDULE_EVALUATORS: readonly EvaluatorRegistration[] = [UNAVAILABLE_EVALUATOR, CONFLICT_EVALUATOR];
