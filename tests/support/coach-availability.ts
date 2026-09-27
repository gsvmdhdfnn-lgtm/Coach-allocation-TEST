/**
 * Test-suite copy of the canonical coach-availability/coach-availability.ts,
 * kept in sync by hand exactly like every other deployed copy. No import
 * adjustment needed - this file has no internal imports.
 */
/**
 * Pure coach-availability resolution for Coaches Slice 7 (see TEST-ENV.md).
 * No Airtable/Supabase/network calls - directly unit-testable against plain
 * fixture rows, same convention as coach-rates.ts/financial-outcomes.ts.
 *
 * Answers exactly one question: "has this coach SAID they are available
 * for this UK date and wall-clock interval?" It deliberately does NOT
 * answer "is this coach free" - existing Session Staff/Occurrence Staff
 * commitments are not consulted here (see TEST-ENV.md).
 *
 * Every time comparison is UK local wall-clock minutes-of-day on a UK
 * calendar date. Availability is a local operational schedule, so no UTC
 * instant is ever compared against a recurring window - a BST/GMT change
 * can never shift a window by an hour. Callers holding a real instant
 * (e.g. an occurrence's Start Date & Time) convert it first with
 * ukWallClockFromInstant().
 */

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
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

/** Management-only predicate, kept pure so the deployed rule is directly unit-testable (same convention as Slice 6). */
export function isManagementCaller(caller: { role: string; active: boolean } | null): boolean {
  return !!caller && caller.active === true && caller.role === "management";
}

export function validateAvailabilityQuery(q: Partial<AvailabilityQuery>): string | null {
  if (!RECORD_ID_RE.test(q.coachId || "")) return "coachId is required and must be a valid Airtable record ID";
  if (!isValidIsoDate(q.date)) return "date is required and must be a valid YYYY-MM-DD calendar date";
  const s = parseTimeToMinutes(q.startTime);
  const e = parseTimeToMinutes(q.endTime);
  if (s == null) return "startTime is required and must be HH:MM (00:00-23:59)";
  if (e == null) return "endTime is required and must be HH:MM (00:00-23:59)";
  if (e <= s) return "endTime must be after startTime (a work interval may not cross midnight or be zero-length)";
  return null;
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
