/**
 * Shared pure utilities for the Session Occurrence generator and (later)
 * recurring-edit propagation - see TEST-ENV.md, Slice 2. Deliberately
 * side-effect-free: no Airtable/Supabase/network calls anywhere in this
 * file, so every function here is directly unit-testable and safely
 * reusable by both the generator (Slice 2) and propagation (Slice 6)
 * without either owning the other's concerns.
 *
 * All calendar-date arithmetic below is done via Date.UTC(...) rather
 * than the local Date constructor, on purpose: this file may run inside
 * a Deno Edge Function or a test runner in any OS timezone, and
 * `new Date(y, m, d)` silently uses whatever timezone the process
 * happens to be in. Every "calendar date" here is a plain "YYYY-MM-DD"
 * string; it is only ever turned into a Date object at UTC midnight, so
 * date-only comparisons never drift by a day depending on where this
 * code happens to run.
 */

/** Airtable's REST API returns a singleSelect as the plain option-name string, never an {id,name,color} object - handled defensively both ways, same convention as parent-hub/player-access.ts. */
export function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** "Monday" (any case) -> 1, matching Date.UTC's getUTCDay() convention (Sunday=0). Returns null for anything unrecognised - callers must fail closed, never guess a day. */
export function weekdayIndexFromName(name: any): number | null {
  const key = String(selectName(name) || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, key) ? WEEKDAY_INDEX[key] : null;
}

/** Parses a plain "YYYY-MM-DD" string into a UTC-midnight Date. Returns null for anything malformed/blank - callers must fail closed. */
export function parseIsoDateUTC(dateIso: any): Date | null {
  const s = String(dateIso || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** UTC-midnight Date -> "YYYY-MM-DD". */
export function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Adds N whole days to a "YYYY-MM-DD" string, returning a new "YYYY-MM-DD" string. Negative n moves backward. */
export function addDaysIso(dateIso: string, days: number): string {
  const d = parseIsoDateUTC(dateIso);
  if (!d) throw new Error(`addDaysIso: invalid date "${dateIso}"`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDateUTC(d);
}

/** True if a <= b, comparing as plain ISO date strings (safe: "YYYY-MM-DD" sorts lexicographically the same as chronologically). */
export function isoDateLte(a: string, b: string): boolean {
  return a <= b;
}
export function isoDateLt(a: string, b: string): boolean {
  return a < b;
}
export function isoDateGte(a: string, b: string): boolean {
  return a >= b;
}

/** The earliest date >= fromDateIso that falls on the given UTC weekday index (0=Sunday..6=Saturday). If fromDateIso itself matches, it is returned unchanged. */
export function firstDateOnOrAfterWeekday(fromDateIso: string, weekdayIndex: number): string {
  const from = parseIsoDateUTC(fromDateIso);
  if (!from) throw new Error(`firstDateOnOrAfterWeekday: invalid date "${fromDateIso}"`);
  const diff = (weekdayIndex - from.getUTCDay() + 7) % 7;
  return addDaysIso(fromDateIso, diff);
}

/** Parses "17:00" / "9:30" etc into {h,m}. Returns null for anything unparseable - callers must fail closed rather than guess a time. */
export function parseHHMM(raw: any): { h: number; m: number } | null {
  const s = String(raw || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/**
 * The IANA UTC offset (in minutes) Europe/London actually uses at a given
 * instant - +60 during BST, 0 during GMT. Computed via the standard
 * double-format trick (format the instant as Europe/London wall-clock
 * text, re-parse those same digits as if they were UTC, and the
 * difference between the two is the zone's offset) rather than hand-
 * rolled BST date rules, so it is correct for both the well-known
 * summer/winter case and the exact transition weekends without this
 * file needing to know when the UK's clocks actually change.
 */
export function ukOffsetMinutesAt(instant: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) parts[p.type] = p.value;
  // Intl can render midnight as "24" in some environments; normalise to 0.
  const hour = parts.hour === "24" ? 0 : +parts.hour;
  const asUtcMs = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour, +parts.minute, +parts.second);
  return Math.round((asUtcMs - instant.getTime()) / 60000);
}

/**
 * Builds the correct UTC instant, as an ISO8601 string, for a UK local
 * wall-clock time ("17:00") on a given calendar date ("2026-07-15") -
 * BST/GMT-safe. This is the one place Start/End Date & Time get
 * constructed from a Session's Default Start/End Time, so every
 * occurrence's stored instant is correct regardless of which side of a
 * clock change its date falls on.
 *
 * Not exact within the ~1 hour either side of the UK's actual spring-
 * forward/autumn-back transition instant (a wall-clock time can be
 * genuinely ambiguous or non-existent for the hour surrounding that
 * moment) - real coaching sessions run at ordinary daytime hours, so
 * this is a known, accepted limitation rather than a gap this file
 * tries to resolve. See Slice 2 report for detail.
 */
export function buildUkDateTimeIso(dateIso: string, hhmm: { h: number; m: number }): string {
  const date = parseIsoDateUTC(dateIso);
  if (!date) throw new Error(`buildUkDateTimeIso: invalid date "${dateIso}"`);
  // Step 1: a naive guess - treat the wanted local wall-clock time as if it were already UTC.
  const naiveUtcMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hhmm.h, hhmm.m, 0);
  // Step 2: find out what offset Europe/London actually has at (approximately) that instant.
  const offsetMinutes = ukOffsetMinutesAt(new Date(naiveUtcMs));
  // Step 3: correct the guess - local time = UTC + offset, so UTC = local - offset.
  const correctUtcMs = naiveUtcMs - offsetMinutes * 60000;
  return new Date(correctUtcMs).toISOString();
}

/** Deterministic idempotency key for a generator-owned "standard slot" - the one row the routine generation pass is responsible for creating/topping up for this Session on this date. Never used for a reschedule-created replacement (see generator.ts's own comment) - those use a distinctly different, non-colliding shape so the two families of keys can never be confused. */
export function computeOccurrenceKey(sessionRecordId: string, dateIso: string): string {
  return `${sessionRecordId}:${dateIso}`;
}

/**
 * Deterministic idempotency key for a reschedule-created replacement
 * occurrence, at ITS OWN landing date - Slice 3's repository layer uses
 * this to derive a key for existing "From field: Replacement Occurrence"
 * rows that pre-date the Occurrence Key field. Deliberately shaped so it
 * can never string-match the standard key ({session}:{date}) for that
 * same date, even when a replacement lands back on a date that would
 * otherwise be a standard recurring slot for the same Session.
 */
export function computeReplacementOccurrenceKey(sessionRecordId: string, dateIso: string, originOccurrenceRecordId: string): string {
  return `${computeOccurrenceKey(sessionRecordId, dateIso)}:R:${originOccurrenceRecordId}`;
}

/**
 * Whole-occurrence freeze test - Slice 6 (see TEST-ENV.md). An occurrence
 * is frozen (must never be changed by normal recurring propagation) iff
 * its Start Date & Time is already <= now, OR its Status is Completed,
 * Cancelled or Postponed - regardless of Confirmation State/Register
 * State, which never affect freezing. A past Scheduled occurrence freezes
 * automatically from the time check alone, even if nothing ever set it to
 * Completed - this function never trusts Status to reflect the passage of
 * time on its own.
 *
 * Compares real instants, not calendar dates - an occurrence starting
 * later today is not frozen yet; one that has already started (even by a
 * minute) is. Callers pass the real "now" instant, not a UTC-midnight
 * calendar date (contrast with the generator's todayIso, which only ever
 * needs calendar-date granularity).
 */
export function isFrozen(occ: { fields: Record<string, any> }, now: Date): boolean {
  const status = selectName(occ.fields["Status"]);
  if (status === "Completed" || status === "Cancelled" || status === "Postponed") return true;
  const startIso = occ.fields["Start Date & Time"];
  if (typeof startIso === "string" && startIso) {
    const start = new Date(startIso);
    if (!isNaN(start.getTime()) && start.getTime() <= now.getTime()) return true;
  }
  return false;
}
