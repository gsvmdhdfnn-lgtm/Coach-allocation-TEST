/**
 * Test-suite copy of the canonical propagation.ts, kept in sync by hand
 * exactly like every other file in this directory - see
 * tests/e2e/propagationtest.js, which imports this file directly (via
 * `node --experimental-strip-types`) to unit-test the planner itself,
 * independent of any HTTP mock or real Airtable call.
 *
 * Pure recurring-edit propagation planner - Slice 6 (see TEST-ENV.md).
 * Answers exactly one question:
 *
 *   "Given a Session's existing occurrences and a set of changes just
 *    made to that Session's recurring defaults, what should happen to
 *    the already-generated FUTURE occurrences?"
 *
 * The generator (generator.ts) answers a different question - "which
 * dated occurrence shells should exist?" - and never touches an existing
 * row. This file is the mirror image: it never creates a row, only
 * plans changes to rows that already exist. Reuses the generator's own
 * freeze-safe, BST/GMT-safe, collision-safe primitives from
 * schedule-utils.ts rather than re-deriving them.
 *
 * Deliberately narrow, same discipline as generator.ts:
 *  - no Airtable/Supabase/network call anywhere in this file
 *  - never reads Occurrence Staff, cover, or Session History
 *  - never writes anything itself - only PLANS what should be written;
 *    the repository/orchestration layer (propagation-repository.ts /
 *    propagation-orchestrator.ts) is responsible for turning a plan into
 *    real Airtable PATCH calls
 *  - whole-occurrence freeze (isFrozen()) is absolute: nothing in this
 *    file ever plans a change to a frozen occurrence, for any change
 *    type, with the sole exception of Venue/Capacity crystallisation -
 *    which exists specifically FOR frozen occurrences, to protect their
 *    historical record from a Session-default change, never to alter
 *    what they actually mean.
 */
import {
  buildUkDateTimeIso,
  isFrozen,
  isoDateLte,
  isoDateLt,
  parseIsoDateUTC,
  selectName,
} from "./schedule-utils.ts";
import type { ExistingOccurrenceRecord } from "./session-generator.ts";

/** One field-level write this plan calls for. `reason` is a human-readable audit trail line - not written to Airtable itself, but intended for logging/Session History use by the caller. */
export interface OccurrenceFieldUpdate {
  occurrenceRecordId: string;
  fields: Record<string, unknown>;
  reason: string;
}

/** A row this plan deliberately did NOT touch, and why - either because it already carries its own explicit value (no crystallisation needed) or because it's ambiguous and needs a human decision rather than a guess. */
export interface SkippedRow {
  occurrenceRecordId: string;
  reason: string;
}

export interface RecurringEditPlan {
  /** Field updates to already-generated future occurrences - currently only ever a Time change (new Start/End Date & Time). */
  toUpdate: OccurrenceFieldUpdate[];
  /** Occurrences to cancel (Status -> "Cancelled"), never delete - day-of-week and Operating End Date changes only. */
  toCancel: OccurrenceFieldUpdate[];
  /** Historical crystallisation writes onto frozen, fallback-dependent occurrences, ahead of a Venue/Capacity default change. */
  toCrystallise: OccurrenceFieldUpdate[];
  /** Rows that already carry their own explicit value, so crystallisation was correctly skipped - reported for transparency, not acted on. */
  skippedOverrides: SkippedRow[];
  /** Rows this plan deliberately did not resolve automatically - reported instead of guessed. */
  manualReview: SkippedRow[];
  /** True iff a day-of-week change was planned - the generator must be invoked separately (as its own step) to create the new weekday's shells. This plan never creates rows itself. */
  backfillNeeded: boolean;
}

export interface TimeChangeInput {
  newStartTime: { h: number; m: number };
  newEndTime: { h: number; m: number };
}
export interface VenueChangeInput {
  /** The Session's Venue link value BEFORE this edit - [] if it had none. Only the OLD value is needed: future occurrences inherit the new default automatically at read time via the existing blank-Venue fallback, so there is nothing to write for them. */
  oldVenueRecordIds: string[];
}
export interface CapacityChangeInput {
  /** The Session's Default Capacity BEFORE this edit - null if it had none. Same reasoning as VenueChangeInput: only the OLD value is ever needed. */
  oldCapacity: number | null;
}
export interface DayOfWeekChangeInput {
  /** The Session's Default Day BEFORE this edit, as a weekday index (0=Sunday..6=Saturday, matching schedule-utils' own convention). Only the OLD day is needed: it identifies which existing rows are now wrong; the NEW day only matters to the generator's next run, which this planner never invokes. */
  oldWeekdayIndex: number;
  /** Calendar date ("YYYY-MM-DD") this change takes effect from - defaults to todayIso if omitted. Rows dated before this are left untouched regardless of weekday. */
  effectiveFromDateIso?: string;
}
export interface EndDateChangeInput {
  /** The Session's new (shortened) End Date, "YYYY-MM-DD". */
  newEndDateIso: string;
}

export interface RecurringEditInput {
  /** All existing Session Occurrences rows for this Session - same scoping responsibility as the generator's own existingOccurrences: the caller/repository layer must pre-filter to this Session only. */
  existingOccurrences: ExistingOccurrenceRecord[];
  /** Real "now" instant - used both for isFrozen() and as the calendar-date floor for "future". Deliberately a full instant, not a UTC-midnight date, so isFrozen()'s later-today-is-still-eligible case works correctly. */
  now: Date;
  timeChange?: TimeChangeInput;
  venueChange?: VenueChangeInput;
  capacityChange?: CapacityChangeInput;
  dayOfWeekChange?: DayOfWeekChangeInput;
  endDateChange?: EndDateChangeInput;
}

function todayIsoFrom(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Schedule Change State "Standard" or blank both count as standard - matches every existing hand-seeded/generator-created row: Changed/Rescheduled rows are always an explicit, deliberate exception and must never be treated as standard by any propagation path. */
function isStandard(occ: ExistingOccurrenceRecord): boolean {
  const state = selectName(occ.fields["Schedule Change State"]);
  return state === "" || state === "Standard";
}

function isScheduled(occ: ExistingOccurrenceRecord): boolean {
  return selectName(occ.fields["Status"]) === "Scheduled";
}

function isTimeOverridden(occ: ExistingOccurrenceRecord): boolean {
  return occ.fields["Time Overridden"] === true;
}

function hasExplicitVenue(occ: ExistingOccurrenceRecord): boolean {
  const v = occ.fields["Venue"];
  return Array.isArray(v) && v.length > 0;
}

function hasExplicitCapacity(occ: ExistingOccurrenceRecord): boolean {
  const c = occ.fields["Capacity Override"];
  return typeof c === "number" && !isNaN(c);
}

function occDateIso(occ: ExistingOccurrenceRecord): string {
  return typeof occ.fields["Date"] === "string" ? occ.fields["Date"] : "";
}

/**
 * Time change: a PERMANENT recurring edit to the Session's own Default
 * Start/End Time. Only future, Scheduled, Standard, non-frozen, non-
 * Time-Overridden occurrences get a new Start/End Date & Time - each
 * recomputed BST/GMT-safe for that occurrence's OWN date via the same
 * buildUkDateTimeIso() the generator itself uses. Schedule Change State
 * is never written here - these occurrences remain Standard, exactly as
 * the ratified design requires.
 *
 * Time Overridden = true occurrences (a prior one-off time change, or a
 * reschedule replacement) are never touched, regardless of Schedule
 * Change State - this is the field that exists specifically to make that
 * guarantee, and a later permanent Session time change must never
 * overwrite it.
 */
function planTimeChange(
  occurrences: ExistingOccurrenceRecord[],
  change: TimeChangeInput,
  now: Date
): OccurrenceFieldUpdate[] {
  const toUpdate: OccurrenceFieldUpdate[] = [];
  for (const occ of occurrences) {
    if (isFrozen(occ, now)) continue;
    if (!isScheduled(occ)) continue;
    if (!isStandard(occ)) continue;
    if (isTimeOverridden(occ)) continue;
    const dateIso = occDateIso(occ);
    if (!dateIso || !parseIsoDateUTC(dateIso)) continue;
    toUpdate.push({
      occurrenceRecordId: occ.id,
      fields: {
        "Start Date & Time": buildUkDateTimeIso(dateIso, change.newStartTime),
        "End Date & Time": buildUkDateTimeIso(dateIso, change.newEndTime),
      },
      reason: "Permanent recurring time change - Session's Default Start/End Time updated",
    });
  }
  return toUpdate;
}

/**
 * Shared shape for Venue and Capacity crystallisation - identical rule,
 * different field. Only ever considers FROZEN occurrences: a future one
 * inherits the new Session default automatically at read time (blank
 * Venue/Capacity Override always falls back to the Session's current
 * default), so there is nothing to write for it - writing anything would
 * in fact be wrong, since "explicit override" and "inherits default" are
 * mutually exclusive by the field's own convention.
 *
 * A frozen occurrence with its OWN explicit value is already immune to
 * the Session default changing - reported in skippedOverrides, not
 * touched. A frozen occurrence with a blank value was relying on
 * fallback, so its historical record must be crystallised with the OLD
 * effective value before the default changes, or it would appear (at
 * read time, after the change) to have taken place at the NEW
 * Venue/Capacity - rewriting history that already happened.
 *
 * If the OLD effective value was itself blank (the Session never had a
 * default to begin with), there is no value to crystallise: writing
 * blank onto blank changes nothing, and the fallback would still resolve
 * to the NEW default once it exists. That case can't be resolved
 * automatically by this mechanism - flagged as manualReview rather than
 * silently doing nothing and calling it handled.
 */
function planFallbackCrystallisation(
  occurrences: ExistingOccurrenceRecord[],
  now: Date,
  fieldName: "Venue" | "Capacity Override",
  hasExplicit: (occ: ExistingOccurrenceRecord) => boolean,
  oldEffectiveValue: unknown,
  oldValueIsBlank: boolean,
  fieldLabel: string
): { toCrystallise: OccurrenceFieldUpdate[]; skippedOverrides: SkippedRow[]; manualReview: SkippedRow[] } {
  const toCrystallise: OccurrenceFieldUpdate[] = [];
  const skippedOverrides: SkippedRow[] = [];
  const manualReview: SkippedRow[] = [];

  for (const occ of occurrences) {
    if (!isFrozen(occ, now)) continue;
    if (hasExplicit(occ)) {
      skippedOverrides.push({
        occurrenceRecordId: occ.id,
        reason: `Already has its own explicit ${fieldLabel} - not dependent on the Session default, no crystallisation needed`,
      });
      continue;
    }
    if (oldValueIsBlank) {
      manualReview.push({
        occurrenceRecordId: occ.id,
        reason: `Frozen occurrence has no ${fieldLabel} of its own, and the Session had no old default ${fieldLabel} to crystallise onto it - it will incorrectly inherit the new default via fallback unless a value is set manually`,
      });
      continue;
    }
    toCrystallise.push({
      occurrenceRecordId: occ.id,
      fields: { [fieldName]: oldEffectiveValue },
      reason: `Crystallising the old effective ${fieldLabel} onto this frozen occurrence before the Session default changes, so its historical record does not silently inherit the new default`,
    });
  }
  return { toCrystallise, skippedOverrides, manualReview };
}

/**
 * Day-of-week change: cancels (never deletes) future, Scheduled,
 * Standard, non-frozen occurrences dated on the OLD weekday, from the
 * effective date forward. Cancelled/Postponed/Rescheduled rows are
 * already explicit exceptions and are simply not eligible - excluded by
 * the same isStandard()/isScheduled() checks used everywhere else, no
 * special case needed. Never creates the new weekday's rows itself -
 * that is the generator's job, run as a separate step once
 * backfillNeeded is seen.
 */
function planDayOfWeekChange(
  occurrences: ExistingOccurrenceRecord[],
  change: DayOfWeekChangeInput,
  now: Date
): OccurrenceFieldUpdate[] {
  const toCancel: OccurrenceFieldUpdate[] = [];
  const effectiveFrom = change.effectiveFromDateIso || todayIsoFrom(now);
  for (const occ of occurrences) {
    if (isFrozen(occ, now)) continue;
    if (!isScheduled(occ)) continue;
    if (!isStandard(occ)) continue;
    const dateIso = occDateIso(occ);
    const parsed = parseIsoDateUTC(dateIso);
    if (!parsed) continue;
    if (isoDateLt(dateIso, effectiveFrom)) continue;
    if (parsed.getUTCDay() !== change.oldWeekdayIndex) continue;
    toCancel.push({
      occurrenceRecordId: occ.id,
      fields: { Status: "Cancelled", "Schedule Change State": "Changed" },
      reason: `Session's recurring day changed away from this occurrence's weekday, effective ${effectiveFrom} - cancelled, not deleted`,
    });
  }
  return toCancel;
}

/**
 * Operating End Date shortened: cancels (never deletes) future,
 * Scheduled, Standard, non-frozen occurrences now dated beyond the new
 * End Date. A non-Standard row beyond the new End Date (an explicit
 * one-off override or a reschedule) is deliberately NOT auto-cancelled -
 * whether it should still run is a real judgement call this planner
 * will not guess, so it is reported via manualReview instead.
 */
function planEndDateChange(
  occurrences: ExistingOccurrenceRecord[],
  change: EndDateChangeInput,
  now: Date
): { toCancel: OccurrenceFieldUpdate[]; manualReview: SkippedRow[] } {
  const toCancel: OccurrenceFieldUpdate[] = [];
  const manualReview: SkippedRow[] = [];
  for (const occ of occurrences) {
    if (isFrozen(occ, now)) continue;
    if (!isScheduled(occ)) continue;
    const dateIso = occDateIso(occ);
    if (!dateIso || !parseIsoDateUTC(dateIso)) continue;
    if (isoDateLte(dateIso, change.newEndDateIso)) continue;
    if (!isStandard(occ)) {
      manualReview.push({
        occurrenceRecordId: occ.id,
        reason: `Dated beyond the new Operating End Date (${change.newEndDateIso}) but carries a non-Standard Schedule Change State - not auto-cancelled, needs a manual decision`,
      });
      continue;
    }
    toCancel.push({
      occurrenceRecordId: occ.id,
      fields: { Status: "Cancelled", "Schedule Change State": "Changed" },
      reason: `Dated beyond the shortened Operating End Date (${change.newEndDateIso})`,
    });
  }
  return { toCancel, manualReview };
}

/** Merges multiple entries for the same occurrence into one, combining reasons and fields rather than emitting a duplicate write - used for toCancel (day-change and End-Date-change can both target the same row) and toCrystallise (Venue and Capacity crystallisation can both target the same frozen row). Airtable's batch update API rejects a request naming the same record twice, so this isn't just tidiness - a duplicate would fail the real write. */
function dedupeByOccurrence(entries: OccurrenceFieldUpdate[]): OccurrenceFieldUpdate[] {
  const byId = new Map<string, OccurrenceFieldUpdate>();
  for (const entry of entries) {
    const existing = byId.get(entry.occurrenceRecordId);
    if (!existing) {
      byId.set(entry.occurrenceRecordId, { ...entry });
    } else {
      existing.fields = { ...existing.fields, ...entry.fields };
      existing.reason = `${existing.reason}; ${entry.reason}`;
    }
  }
  return [...byId.values()];
}

/**
 * Top-level entry point. Each change-type key present on the input is
 * planned independently against the SAME occurrence list, then the
 * results are combined. Every sub-planner already excludes frozen rows
 * (except crystallisation, which exists only for them) and non-Standard
 * rows (except where explicitly handling one, e.g. End Date's
 * manualReview case) - so Time/Venue/Capacity/Day/EndDate changes can be
 * requested together in one call without interfering with each other, by
 * construction rather than by extra cross-checks.
 *
 * One real interaction DOES need an explicit tie-break: a row that a Day-
 * of-week or End Date change is cancelling this same call must never
 * also appear in toUpdate from a simultaneous Time change - it is being
 * retired, not kept running at a new time. Cancellation always wins;
 * toUpdate is filtered against the final toCancel set before returning.
 */
export function planRecurringEdit(input: RecurringEditInput): RecurringEditPlan {
  const { existingOccurrences, now } = input;

  let toUpdate: OccurrenceFieldUpdate[] = [];
  let toCancel: OccurrenceFieldUpdate[] = [];
  let toCrystallise: OccurrenceFieldUpdate[] = [];
  const skippedOverrides: SkippedRow[] = [];
  const manualReview: SkippedRow[] = [];
  let backfillNeeded = false;

  if (input.timeChange) {
    toUpdate.push(...planTimeChange(existingOccurrences, input.timeChange, now));
  }

  if (input.venueChange) {
    const result = planFallbackCrystallisation(
      existingOccurrences,
      now,
      "Venue",
      hasExplicitVenue,
      input.venueChange.oldVenueRecordIds,
      input.venueChange.oldVenueRecordIds.length === 0,
      "Venue"
    );
    toCrystallise.push(...result.toCrystallise);
    skippedOverrides.push(...result.skippedOverrides);
    manualReview.push(...result.manualReview);
  }

  if (input.capacityChange) {
    const result = planFallbackCrystallisation(
      existingOccurrences,
      now,
      "Capacity Override",
      hasExplicitCapacity,
      input.capacityChange.oldCapacity,
      input.capacityChange.oldCapacity == null,
      "Capacity Override"
    );
    toCrystallise.push(...result.toCrystallise);
    skippedOverrides.push(...result.skippedOverrides);
    manualReview.push(...result.manualReview);
  }

  if (input.dayOfWeekChange) {
    toCancel.push(...planDayOfWeekChange(existingOccurrences, input.dayOfWeekChange, now));
    backfillNeeded = true;
  }

  if (input.endDateChange) {
    const result = planEndDateChange(existingOccurrences, input.endDateChange, now);
    toCancel.push(...result.toCancel);
    manualReview.push(...result.manualReview);
  }

  toCancel = dedupeByOccurrence(toCancel);
  if (toCancel.length > 0) {
    const cancelledIds = new Set(toCancel.map((c) => c.occurrenceRecordId));
    toUpdate = toUpdate.filter((u) => !cancelledIds.has(u.occurrenceRecordId));
  }
  // A row eligible for BOTH Venue and Capacity crystallisation in the same
  // call would otherwise appear as two separate entries against the same
  // occurrence - merge them into one write, same as toCancel above (and
  // for the same underlying reason: Airtable's batch update API rejects a
  // request that names the same record twice).
  toCrystallise = dedupeByOccurrence(toCrystallise);

  return { toUpdate, toCancel, toCrystallise, skippedOverrides, manualReview, backfillNeeded };
}
