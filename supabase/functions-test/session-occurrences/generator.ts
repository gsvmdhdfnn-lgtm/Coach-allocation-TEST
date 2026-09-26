/**
 * Pure Session Occurrence generator - Slice 2 of the occurrence-generator
 * build (see TEST-ENV.md). Answers exactly one question:
 *
 *   "Given a Session, its Session Dates, its existing occurrences, and
 *    today's date, which NEW dated occurrence shells should exist?"
 *
 * Deliberately narrow. This module does NOT:
 *  - modify any field on an existing occurrence
 *  - cancel, postpone or reschedule anything
 *  - crystallise Venue/Capacity onto a frozen occurrence
 *  - propagate a recurring Session edit onto already-generated occurrences
 *  - read or reason about Occurrence Staff, cover, or Session History
 *  - make any Airtable/Supabase/network call
 *
 * All of the above belong to recurring-edit propagation (Slice 6) and the
 * repository/orchestration layer (Slice 3+), never to this file. The only
 * thing this module ever produces is a list of BRAND NEW rows to create;
 * an existing row, once it exists, is never touched by anything here.
 *
 * Shares its date/time/key primitives with schedule-utils.ts so Slice 6's
 * propagation logic reuses exactly the same freeze-safe, BST/GMT-safe,
 * collision-safe building blocks rather than re-deriving its own.
 */
import {
  addDaysIso,
  buildUkDateTimeIso,
  computeOccurrenceKey,
  firstDateOnOrAfterWeekday,
  isoDateGte,
  isoDateLt,
  isoDateUTC,
  parseHHMM,
  parseIsoDateUTC,
  selectName,
  weekdayIndexFromName,
} from "./schedule-utils.ts";

/** Minimum forward window, regardless of how few occurrences that produces for a rare pattern. */
const WINDOW_WEEKS = 12;
/** Minimum occurrence count, regardless of how soon that's reached for a frequent pattern. The actual window used is whichever of the two reaches further - see planRecurringDates(). */
const MIN_OCCURRENCE_COUNT = 10;
/** Defensive backstop only (~10 years of weekly cursor advances) - prevents a true infinite loop against pathological data (e.g. every week excluded, no End Date set). Never expected to bind in real use. */
const MAX_RECURRING_ITERATIONS = 520;

export interface SessionRecord {
  id: string;
  fields: Record<string, any>;
}
export interface SessionDateRecord {
  id: string;
  fields: Record<string, any>;
}
export interface ExistingOccurrenceRecord {
  id: string;
  fields: Record<string, any>;
}

/** A brand-new occurrence row to create. Never carries a Venue or Capacity Override - both are left for Airtable's own fallback-to-Session-default to resolve at read time, per the ratified snapshot model. */
export interface OccurrenceShell {
  occurrenceKey: string;
  sessionRecordId: string;
  date: string; // "YYYY-MM-DD"
  startDateTime: string; // ISO8601 UTC instant
  endDateTime: string; // ISO8601 UTC instant
  status: "Scheduled";
}

export interface GenerationInput {
  session: SessionRecord;
  /** All Session Dates rows for THIS session only (both Included and Excluded) - the caller/repository layer is responsible for scoping this, not this function. */
  sessionDates: SessionDateRecord[];
  /** All existing Session Occurrences rows for THIS session only - same scoping responsibility as sessionDates. */
  existingOccurrences: ExistingOccurrenceRecord[];
  /** Reference "now" instant. Only its calendar date (UK/UTC calendar date) is used - this function never creates a shell dated before today. */
  today: Date;
}

export interface GenerationResult {
  toCreate: OccurrenceShell[];
}

function sessionLifecycleStatus(session: SessionRecord): string {
  return selectName(session.fields["Session Lifecycle Status"]);
}

function schedulePattern(session: SessionRecord): string {
  return selectName(session.fields["Schedule Pattern"]);
}

function existingOccurrenceKeys(existingOccurrences: ExistingOccurrenceRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const o of existingOccurrences) {
    const key = o.fields["Occurrence Key"];
    if (typeof key === "string" && key) keys.add(key);
  }
  return keys;
}

/** Builds one shell for a session+date, using the Session's own Default Start/End Time. Returns null if either time is unparseable - fails closed rather than writing a broken shell. */
function buildShell(session: SessionRecord, dateIso: string): OccurrenceShell | null {
  const start = parseHHMM(session.fields["Default Start Time"]);
  const end = parseHHMM(session.fields["Default End Time"]);
  if (!start || !end) return null;
  return {
    occurrenceKey: computeOccurrenceKey(session.id, dateIso),
    sessionRecordId: session.id,
    date: dateIso,
    startDateTime: buildUkDateTimeIso(dateIso, start),
    endDateTime: buildUkDateTimeIso(dateIso, end),
    status: "Scheduled",
  };
}

/**
 * Recurring: one candidate per matching weekday, from max(Start Date,
 * today) forward, skipping Excluded Session Dates and stopping at End
 * Date if set. Never backfills a gap before today - this function is
 * always forward-looking only, regardless of how old the Session's own
 * Start Date is or how long it's been since the generator last ran.
 *
 * The window is whichever of "12 weeks ahead" or "the next 10
 * occurrences" reaches further into the future - implemented as: keep
 * extending until BOTH the count floor and the time floor are satisfied,
 * which is exactly "reach whichever boundary is later."
 */
function planRecurringDates(session: SessionRecord, excludedDates: Set<string>, todayIso: string): string[] {
  const weekdayIndex = weekdayIndexFromName(session.fields["Default Day"]);
  if (weekdayIndex == null) return [];

  const startDateField = session.fields["Start Date"];
  const endDateField = session.fields["End Date"];
  const parsedStart = parseIsoDateUTC(startDateField);
  const effectiveStart = parsedStart && isoDateGte(isoDateUTC(parsedStart), todayIso) ? isoDateUTC(parsedStart) : todayIso;
  const endBound = parseIsoDateUTC(endDateField) ? isoDateUTC(parseIsoDateUTC(endDateField)!) : null;

  const twelveWeeksOutIso = addDaysIso(todayIso, WINDOW_WEEKS * 7);

  let cursor = firstDateOnOrAfterWeekday(effectiveStart, weekdayIndex);
  const dates: string[] = [];
  for (let i = 0; i < MAX_RECURRING_ITERATIONS; i++) {
    if (endBound && isoDateLt(endBound, cursor)) break;
    const reachedCount = dates.length >= MIN_OCCURRENCE_COUNT;
    const reachedWindow = dates.length > 0 && isoDateGte(dates[dates.length - 1], twelveWeeksOutIso);
    if (reachedCount && reachedWindow) break;
    if (!excludedDates.has(cursor)) dates.push(cursor);
    cursor = addDaysIso(cursor, 7);
  }
  return dates;
}

/**
 * Selected Dates: every future (>= today) Included row, unconditionally -
 * no 12-week/10-occurrence windowing applied. Decision, not an oversight:
 * Selected Dates is a finite, explicit list Management has already
 * chosen, unlike Recurring's open-ended weekly projection that genuinely
 * needs a horizon to avoid generating forever. Withholding a deliberately
 * planned far-future date until a rolling window "catches up" to it would
 * be confusing, not safer. Flagged in the Slice 2 report for confirmation.
 */
function planSelectedDates(session: SessionRecord, sessionDates: SessionDateRecord[], todayIso: string): string[] {
  const dates: string[] = [];
  for (const row of sessionDates) {
    if (selectName(row.fields["Date Type"]) !== "Included") continue;
    const parsed = parseIsoDateUTC(row.fields["Date"]);
    if (!parsed) continue;
    const dateIso = isoDateUTC(parsed);
    if (isoDateGte(dateIso, todayIso)) dates.push(dateIso);
  }
  return [...new Set(dates)].sort();
}

/**
 * One-off: exactly one date, taken from the Session's own Start Date
 * field. Flagged decision, not a silent assumption: the current schema
 * has no dedicated "one-off date" field, and Session Dates was scoped in
 * the ratified design specifically for Selected Dates/Excluded Dates, not
 * One-off. Reusing Start Date (which already means "the date this Session
 * operates from," and for a One-off is the same day it runs) avoids
 * inventing a new field and avoids overloading Session Dates with a
 * purpose it wasn't given. See Slice 2 report for the alternative
 * considered (a Session Dates row) if you'd prefer that instead.
 */
function planOneOffDate(session: SessionRecord, todayIso: string): string[] {
  const parsed = parseIsoDateUTC(session.fields["Start Date"]);
  if (!parsed) return [];
  const dateIso = isoDateUTC(parsed);
  return isoDateGte(dateIso, todayIso) ? [dateIso] : [];
}

/**
 * Top-level entry point. Dispatches on Session Lifecycle Status and
 * Schedule Pattern, builds candidate shells for whichever pattern
 * applies, then filters out any whose Occurrence Key already exists
 * among existingOccurrences - the entire idempotency mechanism, applied
 * uniformly regardless of pattern. A reschedule-created replacement's key
 * (shaped "{session}:{date}:R:{originId}") never equals a standard key
 * ("{session}:{date}"), so it can never suppress or be confused with the
 * standard slot for that same session/date, by construction - no special
 * case needed here to keep the two apart.
 */
export function planGeneration(input: GenerationInput): GenerationResult {
  const { session, sessionDates, existingOccurrences, today } = input;

  if (sessionLifecycleStatus(session) !== "Active") return { toCreate: [] };

  const todayIso = isoDateUTC(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())));
  const pattern = schedulePattern(session);

  let candidateDates: string[];
  if (pattern === "Recurring") {
    const excludedDates = new Set(
      sessionDates
        .filter((r) => selectName(r.fields["Date Type"]) === "Excluded")
        .map((r) => parseIsoDateUTC(r.fields["Date"]))
        .filter((d): d is Date => !!d)
        .map((d) => isoDateUTC(d))
    );
    candidateDates = planRecurringDates(session, excludedDates, todayIso);
  } else if (pattern === "Selected Dates") {
    candidateDates = planSelectedDates(session, sessionDates, todayIso);
  } else if (pattern === "One-off") {
    candidateDates = planOneOffDate(session, todayIso);
  } else {
    candidateDates = [];
  }

  const existingKeys = existingOccurrenceKeys(existingOccurrences);
  const toCreate: OccurrenceShell[] = [];
  for (const dateIso of candidateDates) {
    const key = computeOccurrenceKey(session.id, dateIso);
    if (existingKeys.has(key)) continue;
    const shell = buildShell(session, dateIso);
    if (shell) toCreate.push(shell);
  }

  return { toCreate };
}
