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
 *
 * Slice 9 addition (Session History, see TEST-ENV.md): after the
 * occurrence-level plan is applied and the Session's own new default
 * fields are written - i.e. only once everything this call set out to do
 * has genuinely succeeded - writes one Session History row per
 * structural dimension that ACTUALLY changed, still inside the same
 * lock, before releasing it. "Actually changed" is deliberately decided
 * here by comparing the incoming requested value against the Session's
 * own CURRENT field value (read at the very top of this call), never by
 * trusting that a key being present in `changes` means something real
 * changed: a field a caller re-submits unchanged (a naive save-everything
 * UI, or a genuine retry of an already-applied edit) is therefore
 * excluded from the occurrence-level plan, from the Session field write,
 * AND from History - all three, for free, from the same one comparison -
 * which is what keeps a retry of an already-applied edit from writing
 * a duplicate History row without needing any explicit request/change ID
 * or event-sourcing machinery.
 */
import { planRecurringEdit, type RecurringEditPlan } from "./propagation.ts";
import {
  fetchExistingOccurrencesForSession,
  fetchSession,
  fetchVenueNames,
  createHistoryEntries,
  type AirtableConfig,
  type HistoryCaller,
  type HistoryEntryToCreate,
} from "./repository.ts";
import { applyOccurrenceFieldUpdates, updateSessionFields } from "./propagation-repository.ts";
import { parseHHMM, weekdayIndexFromName, selectName } from "./schedule-utils.ts";
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

export interface PropagateOptions {
  /** Present iff this edit should be audited to Session History - omitted by any caller that isn't a genuine Management structural edit (there is none today; every real caller supplies this). */
  caller?: HistoryCaller;
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

/** True iff two Venue link arrays name the same set of records, order-independent. */
function sameVenueSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function countByReason(entries: { reason: string }[], substr: string): number {
  return entries.filter((e) => e.reason.includes(substr)).length;
}

function joinClauses(clauses: string[]): string {
  return clauses.length > 0 ? clauses.join("; ") + "." : "No existing occurrences affected.";
}

/** "16" -> "16", null -> "(none)" - shared Old/New Value formatting for Capacity. */
function formatCapacity(capacity: number | null): string {
  return capacity == null ? "(none)" : String(capacity);
}

/** "" -> "(none)" - shared Old/New Value formatting for a possibly-blank date. */
function formatDateOrNone(dateIso: string | null | undefined): string {
  return dateIso ? dateIso : "(none)";
}

/**
 * Builds this call's History entries from what the plan+writes ABOVE
 * this point in propagateForSession() actually did - never from what was
 * merely requested. Only ever called after the occurrence-level plan and
 * the Session's own new fields have both already been written
 * successfully; if either throws first, this is never reached and no
 * History row is written - satisfying "do not leave a success History
 * entry if propagation failed halfway" by construction (there is no
 * separate rollback to get wrong).
 */
async function buildPropagationHistoryEntries(
  airtable: AirtableConfig,
  effective: EffectiveChanges,
  plan: RecurringEditPlan,
  oldStartDateIso: string | null
): Promise<Omit<HistoryEntryToCreate, "changedByUserId" | "changedByNameSnapshot" | "changedAt">[]> {
  const entries: Omit<HistoryEntryToCreate, "changedByUserId" | "changedByNameSnapshot" | "changedAt">[] = [];

  if (effective.dayOfWeek) {
    const cancelled = countByReason(plan.toCancel, "recurring day changed");
    entries.push({
      changeType: "Day",
      oldValue: effective.dayOfWeek.oldDayName,
      newValue: effective.dayOfWeek.newDayName,
      changeSummary:
        cancelled > 0
          ? `${cancelled} future occurrence(s) cancelled for the old day; new day's occurrences will be generated by the next trigger or scheduled top-up.`
          : `No future occurrences needed cancelling for the old day; new day's occurrences will be generated by the next trigger or scheduled top-up.`,
    });
  }

  if (effective.time) {
    const updated = plan.toUpdate.length;
    entries.push({
      changeType: "Time",
      oldValue: `${effective.time.oldStart} – ${effective.time.oldEnd}`,
      newValue: `${effective.time.newStart} – ${effective.time.newEnd}`,
      changeSummary:
        updated > 0
          ? `${updated} future occurrence(s) updated to the new time.`
          : `No future occurrences needed updating (all were frozen, overridden, or non-Standard).`,
    });
  }

  if (effective.venue) {
    const crystallised = countByReason(plan.toCrystallise, "effective Venue");
    const skipped = countByReason(plan.skippedOverrides, "explicit Venue");
    const manualReview = countByReason(plan.manualReview, "no Venue of its own");
    const names = await fetchVenueNames(airtable, [...new Set([...effective.venue.oldIds, ...effective.venue.newIds])]);
    const clauses: string[] = [];
    if (crystallised > 0) clauses.push(`${crystallised} historical occurrence(s) crystallised with the previous venue`);
    if (skipped > 0) clauses.push(`${skipped} occurrence(s) already had their own explicit venue`);
    if (manualReview > 0) clauses.push(`${manualReview} occurrence(s) need manual review (no venue to crystallise)`);
    entries.push({
      changeType: "Venue",
      oldValue: effective.venue.oldIds.length ? effective.venue.oldIds.map((id) => names[id] ?? id).join("; ") : "(none)",
      newValue: effective.venue.newIds.length ? effective.venue.newIds.map((id) => names[id] ?? id).join("; ") : "(none)",
      changeSummary: joinClauses(clauses),
    });
  }

  if (effective.capacity) {
    const crystallised = countByReason(plan.toCrystallise, "effective Capacity Override");
    const skipped = countByReason(plan.skippedOverrides, "explicit Capacity Override");
    const manualReview = countByReason(plan.manualReview, "no Capacity Override of its own");
    const clauses: string[] = [];
    if (crystallised > 0) clauses.push(`${crystallised} historical occurrence(s) crystallised with the previous capacity`);
    if (skipped > 0) clauses.push(`${skipped} occurrence(s) already had their own explicit capacity`);
    if (manualReview > 0) clauses.push(`${manualReview} occurrence(s) need manual review (no capacity to crystallise)`);
    entries.push({
      changeType: "Capacity",
      oldValue: formatCapacity(effective.capacity.oldCapacity),
      newValue: formatCapacity(effective.capacity.newCapacity),
      changeSummary: joinClauses(clauses),
    });
  }

  if (effective.endDate) {
    const cancelled = countByReason(plan.toCancel, "Operating End Date");
    const manualReview = countByReason(plan.manualReview, "Operating End Date");
    const clauses: string[] = [];
    if (cancelled > 0) clauses.push(`${cancelled} occurrence(s) cancelled beyond the new End Date`);
    if (manualReview > 0) clauses.push(`${manualReview} occurrence(s) beyond the new End Date need manual review (non-standard)`);
    entries.push({
      changeType: "Operating Dates",
      oldValue: `Start ${formatDateOrNone(oldStartDateIso)}, End ${formatDateOrNone(effective.endDate.oldEndIso)}`,
      newValue: `Start ${formatDateOrNone(oldStartDateIso)}, End ${formatDateOrNone(effective.endDate.newEndIso)}`,
      changeSummary: joinClauses(clauses),
    });
  }

  return entries;
}

interface EffectiveChanges {
  time?: { oldStart: string; oldEnd: string; newStart: string; newEnd: string };
  venue?: { oldIds: string[]; newIds: string[] };
  capacity?: { oldCapacity: number | null; newCapacity: number | null };
  dayOfWeek?: { oldDayName: string; newDayName: string };
  endDate?: { oldEndIso: string | null; newEndIso: string };
}

function buildSessionFieldWrites(effective: EffectiveChanges, changes: PropagateChanges): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (effective.time) {
    fields["Default Start Time"] = changes.time!.newStartTime;
    fields["Default End Time"] = changes.time!.newEndTime;
  }
  if (effective.venue) {
    fields["Venue"] = changes.venue!.newVenueRecordIds;
  }
  if (effective.capacity) {
    fields["Default Capacity"] = changes.capacity!.newCapacity;
  }
  if (effective.dayOfWeek) {
    fields["Default Day"] = changes.dayOfWeek!.newDayName;
  }
  if (effective.endDate) {
    fields["End Date"] = changes.endDate!.newEndDateIso;
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
 *
 * Every `changes.*` key is compared against the Session's own CURRENT
 * field value before it is planned, written, or audited at all (see
 * `EffectiveChanges` above) - a key present in `changes` whose value
 * already matches the Session's current field is treated as no change
 * happened, full stop. History is then built (Slice 9) from exactly
 * that same `effective` set plus the plan's own real counts, so it can
 * never claim more happened than the plan+writes above it actually did.
 */
export async function propagateForSession(
  deps: PropagationDeps,
  sessionRecordId: string,
  changes: PropagateChanges,
  now: Date = new Date(),
  options: PropagateOptions = {}
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
    const effective: EffectiveChanges = {};

    if (changes.time) {
      const newStartTime = parseHHMM(changes.time.newStartTime);
      const newEndTime = parseHHMM(changes.time.newEndTime);
      if (!newStartTime || !newEndTime) {
        throw new Error(`Invalid time format: expected "HH:MM", got start="${changes.time.newStartTime}" end="${changes.time.newEndTime}"`);
      }
      const oldStart = typeof oldSession.fields["Default Start Time"] === "string" ? oldSession.fields["Default Start Time"] : "";
      const oldEnd = typeof oldSession.fields["Default End Time"] === "string" ? oldSession.fields["Default End Time"] : "";
      if (oldStart !== changes.time.newStartTime || oldEnd !== changes.time.newEndTime) {
        planInput.timeChange = { newStartTime, newEndTime };
        effective.time = { oldStart, oldEnd, newStart: changes.time.newStartTime, newEnd: changes.time.newEndTime };
      }
    }

    if (changes.venue) {
      const oldVenue = oldSession.fields["Venue"];
      const oldVenueIds: string[] = Array.isArray(oldVenue) ? oldVenue : [];
      if (!sameVenueSet(oldVenueIds, changes.venue.newVenueRecordIds)) {
        planInput.venueChange = { oldVenueRecordIds: oldVenueIds };
        effective.venue = { oldIds: oldVenueIds, newIds: changes.venue.newVenueRecordIds };
      }
    }

    if (changes.capacity) {
      const oldCapacityRaw = oldSession.fields["Default Capacity"];
      const oldCapacity = typeof oldCapacityRaw === "number" && !isNaN(oldCapacityRaw) ? oldCapacityRaw : null;
      if (oldCapacity !== changes.capacity.newCapacity) {
        planInput.capacityChange = { oldCapacity };
        effective.capacity = { oldCapacity, newCapacity: changes.capacity.newCapacity };
      }
    }

    if (changes.dayOfWeek) {
      const oldDayName = selectName(oldSession.fields["Default Day"]);
      const oldWeekdayIndex = weekdayIndexFromName(oldDayName);
      if (oldWeekdayIndex == null) {
        throw new Error(`Cannot plan a day-of-week change: the Session's current Default Day ("${oldSession.fields["Default Day"]}") is not a recognised weekday`);
      }
      if (oldDayName.toLowerCase() !== changes.dayOfWeek.newDayName.toLowerCase()) {
        planInput.dayOfWeekChange = {
          oldWeekdayIndex,
          effectiveFromDateIso: changes.dayOfWeek.effectiveFromDateIso,
        };
        effective.dayOfWeek = { oldDayName, newDayName: changes.dayOfWeek.newDayName };
      }
    }

    if (changes.endDate) {
      const oldEndIso = typeof oldSession.fields["End Date"] === "string" ? oldSession.fields["End Date"] : null;
      if (oldEndIso !== changes.endDate.newEndDateIso) {
        planInput.endDateChange = { newEndDateIso: changes.endDate.newEndDateIso };
        effective.endDate = { oldEndIso, newEndIso: changes.endDate.newEndDateIso };
      }
    }

    const plan = planRecurringEdit(planInput);

    const [updateResult, cancelResult, crystalliseResult] = await Promise.all([
      applyOccurrenceFieldUpdates(deps.airtable, plan.toUpdate),
      applyOccurrenceFieldUpdates(deps.airtable, plan.toCancel),
      applyOccurrenceFieldUpdates(deps.airtable, plan.toCrystallise),
    ]);

    const sessionFieldWrites = buildSessionFieldWrites(effective, changes);
    if (Object.keys(sessionFieldWrites).length > 0) {
      await updateSessionFields(deps.airtable, sessionRecordId, sessionFieldWrites);
    }

    if (options.caller && Object.keys(effective).length > 0) {
      const oldStartDateIso = typeof oldSession.fields["Start Date"] === "string" ? oldSession.fields["Start Date"] : null;
      const historyEntries = await buildPropagationHistoryEntries(deps.airtable, effective, plan, oldStartDateIso);
      if (historyEntries.length > 0) {
        await createHistoryEntries(
          deps.airtable,
          sessionRecordId,
          historyEntries.map((entry) => ({
            ...entry,
            changedByUserId: options.caller!.userId,
            changedByNameSnapshot: options.caller!.displayName || options.caller!.userId,
            changedAt: now.toISOString(),
          }))
        );
      }
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
