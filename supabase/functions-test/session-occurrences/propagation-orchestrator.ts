/**
 * The one shared per-Session propagation orchestration path - Slice 6
 * (see TEST-ENV.md). Mirrors orchestrator.ts's own shape and discipline
 * (acquire the per-Session lock, do the real work, always release in a
 * `finally`) but for recurring-edit propagation rather than generation.
 * Reuses the exact SAME LockClient/lock RPCs as generation - there is
 * only ever one lock per Session, shared by every write path that
 * touches that Session's occurrences, so generation and propagation can
 * never race each other for the same Session.
 *
 * Sequencing matters here in a way generateForSession() never had to
 * worry about: the OLD Session fields (needed to know what to
 * crystallise/cancel) must be read BEFORE the new values are written, or
 * "old" and "new" would be the same thing - and the occurrence-level
 * plan built from them must be fully APPLIED before the Session's own
 * fields change too, so a failure partway through never leaves the
 * Session already reflecting its new default while history hasn't been
 * crystallised yet (see propagateForSession()'s own comment for why that
 * matters). So this function always: reads, plans, applies the
 * occurrence-level plan, and only then writes the Session's own new
 * default fields - all inside the same lock, so nothing else can
 * generate or propagate for this Session in between.
 *
 * Never invokes the generator itself, even when the plan reports
 * backfillNeeded - per the ratified design, propagation only ever
 * REPORTS that new shells are needed; a separate, explicit call to
 * generateForSession() is how they actually get created. Keeping that a
 * distinct step (never auto-chained here) is what "propagation must not
 * itself create the new weekday rows" means in practice.
 */
import { planRecurringEdit, type RecurringEditPlan } from "./propagation.ts";
import {
  fetchExistingOccurrencesForSession,
  fetchSession,
  type AirtableConfig,
} from "./repository.ts";
import { applyOccurrenceFieldUpdates, updateSessionFields } from "./propagation-repository.ts";
import { parseHHMM, weekdayIndexFromName } from "./schedule-utils.ts";
import type { LockClient } from "./lock-client.ts";

export interface PropagationDeps {
  airtable: AirtableConfig;
  lock: LockClient;
}

export interface PropagateTimeChange {
  /** "HH:MM" - written verbatim to the Session's own Default Start/End Time fields, and parsed for the planner. */
  newStartTime: string;
  newEndTime: string;
}
export interface PropagateVenueChange {
  newVenueRecordIds: string[];
}
export interface PropagateCapacityChange {
  newCapacity: number | null;
}
export interface PropagateDayOfWeekChange {
  newDayName: string;
  effectiveFromDateIso?: string;
}
export interface PropagateEndDateChange {
  newEndDateIso: string;
}

export interface PropagateChanges {
  time?: PropagateTimeChange;
  venue?: PropagateVenueChange;
  capacity?: PropagateCapacityChange;
  dayOfWeek?: PropagateDayOfWeekChange;
  endDate?: PropagateEndDateChange;
}

export type PropagationOutcome =
  | { status: "skipped_locked" }
  | {
      status: "applied";
      plan: {
        updated: number;
        cancelled: number;
        crystallised: number;
        skippedOverrides: number;
        manualReview: number;
        backfillNeeded: boolean;
      };
      detail: RecurringEditPlan;
    };

function buildSessionFieldWrites(changes: PropagateChanges): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (changes.time) {
    fields["Default Start Time"] = changes.time.newStartTime;
    fields["Default End Time"] = changes.time.newEndTime;
  }
  if (changes.venue) {
    fields["Venue"] = changes.venue.newVenueRecordIds;
  }
  if (changes.capacity) {
    fields["Default Capacity"] = changes.capacity.newCapacity;
  }
  if (changes.dayOfWeek) {
    fields["Default Day"] = changes.dayOfWeek.newDayName;
  }
  if (changes.endDate) {
    fields["End Date"] = changes.endDate.newEndDateIso;
  }
  return fields;
}

/**
 * Acquires the per-Session lock, reads the Session's CURRENT (about-to-
 * become-old) fields and existing occurrences, plans the occurrence-
 * level consequences against those OLD values, applies that plan, and
 * ONLY THEN writes the Session's own new default fields - always
 * releasing the lock in a `finally`, even if any step throws. Returns
 * skipped_locked, never a partial write, when the lock can't be
 * acquired - exactly generateForSession()'s own contract.
 *
 * This order is deliberate, not incidental: crystallisation exists
 * specifically to protect history BEFORE the Session default it depends
 * on changes. Writing the Session's new fields first and applying the
 * occurrence plan second would leave a real window - if the occurrence
 * writes then failed partway (a real failure mode: Airtable's batch API
 * can reject an otherwise-valid request, e.g. a duplicate record in the
 * same call) - where the Session already reflects its NEW default but
 * frozen fallback-dependent occurrences haven't been crystallised with
 * the OLD one yet. A retry after such a failure would then read the
 * Session's already-changed value as if it were still "old" and
 * crystallise the WRONG value onto history. Applying the occurrence
 * plan first means a failure there leaves the Session's own defaults
 * untouched, so a retry re-reads the true old values and is safe to
 * repeat.
 */
export async function propagateForSession(
  deps: PropagationDeps,
  sessionRecordId: string,
  changes: PropagateChanges,
  now: Date = new Date()
): Promise<PropagationOutcome> {
  const lockToken = await deps.lock.acquire(sessionRecordId);
  if (!lockToken) {
    return { status: "skipped_locked" };
  }

  try {
    const [oldSession, existingOccurrences] = await Promise.all([
      fetchSession(deps.airtable, sessionRecordId),
      fetchExistingOccurrencesForSession(deps.airtable, sessionRecordId),
    ]);

    const planInput: Parameters<typeof planRecurringEdit>[0] = {
      existingOccurrences,
      now,
    };

    if (changes.time) {
      const newStartTime = parseHHMM(changes.time.newStartTime);
      const newEndTime = parseHHMM(changes.time.newEndTime);
      if (!newStartTime || !newEndTime) {
        throw new Error(`Invalid time format: expected "HH:MM", got start="${changes.time.newStartTime}" end="${changes.time.newEndTime}"`);
      }
      planInput.timeChange = { newStartTime, newEndTime };
    }

    if (changes.venue) {
      const oldVenue = oldSession.fields["Venue"];
      planInput.venueChange = {
        oldVenueRecordIds: Array.isArray(oldVenue) ? oldVenue : [],
      };
    }

    if (changes.capacity) {
      const oldCapacity = oldSession.fields["Default Capacity"];
      planInput.capacityChange = {
        oldCapacity: typeof oldCapacity === "number" && !isNaN(oldCapacity) ? oldCapacity : null,
      };
    }

    if (changes.dayOfWeek) {
      const oldWeekdayIndex = weekdayIndexFromName(oldSession.fields["Default Day"]);
      if (oldWeekdayIndex == null) {
        throw new Error(`Cannot plan a day-of-week change: the Session's current Default Day ("${oldSession.fields["Default Day"]}") is not a recognised weekday`);
      }
      planInput.dayOfWeekChange = {
        oldWeekdayIndex,
        effectiveFromDateIso: changes.dayOfWeek.effectiveFromDateIso,
      };
    }

    if (changes.endDate) {
      planInput.endDateChange = { newEndDateIso: changes.endDate.newEndDateIso };
    }

    const plan = planRecurringEdit(planInput);

    const [updateResult, cancelResult, crystalliseResult] = await Promise.all([
      applyOccurrenceFieldUpdates(deps.airtable, plan.toUpdate),
      applyOccurrenceFieldUpdates(deps.airtable, plan.toCancel),
      applyOccurrenceFieldUpdates(deps.airtable, plan.toCrystallise),
    ]);

    const sessionFieldWrites = buildSessionFieldWrites(changes);
    if (Object.keys(sessionFieldWrites).length > 0) {
      await updateSessionFields(deps.airtable, sessionRecordId, sessionFieldWrites);
    }

    return {
      status: "applied",
      plan: {
        updated: updateResult.updated,
        cancelled: cancelResult.updated,
        crystallised: crystalliseResult.updated,
        skippedOverrides: plan.skippedOverrides.length,
        manualReview: plan.manualReview.length,
        backfillNeeded: plan.backfillNeeded,
      },
      detail: plan,
    };
  } finally {
    await deps.lock.release(sessionRecordId, lockToken);
  }
}
