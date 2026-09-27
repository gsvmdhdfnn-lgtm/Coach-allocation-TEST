/**
 * Test-suite copy of the canonical coach-availability/orchestrator.ts, kept
 * in sync by hand exactly like every other deployed copy. Only import path
 * adjusted: repository.ts becomes coach-availability-repository.ts.
 */
/**
 * Composition layer for Coaches Slice 7 (see TEST-ENV.md). Validates the
 * query, confirms the coach exists, loads that coach's recurring rows and
 * exceptions, and hands them to the pure resolver unchanged. Every actual
 * availability decision lives in coach-availability.ts.
 */
import {
  resolveAvailability,
  ukWallClockFromInstant,
  validateAvailabilityQuery,
  type AvailabilityQuery,
  type AvailabilityResult,
} from "./coach-availability.ts";
import {
  type AirtableConfig,
  fetchAvailabilityExceptionsForCoach,
  fetchCoachById,
  fetchRecurringAvailabilityForCoach,
} from "./coach-availability-repository.ts";

export type ResolveCoachAvailabilityResult =
  | { status: "validation_error"; error: string }
  | { status: "coach_not_found" }
  | { status: "resolved"; result: AvailabilityResult };

export interface RawAvailabilityInput {
  coachId?: string | null;
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Alternative to date/startTime/endTime: real instants, converted to Europe/London wall-clock. */
  startAt?: string | null;
  endAt?: string | null;
}

/**
 * Accepts either a UK date + wall-clock times, or a pair of real instants
 * (e.g. an occurrence's Start/End Date & Time). Instants are converted to
 * Europe/London wall-clock before anything is compared; both must land on
 * the same UK calendar date. Supplying both forms at once is rejected
 * rather than silently preferring one.
 */
export function normaliseAvailabilityInput(raw: RawAvailabilityInput): { query: AvailabilityQuery } | { error: string } {
  const hasWallClock = !!(raw.date || raw.startTime || raw.endTime);
  const hasInstants = !!(raw.startAt || raw.endAt);
  if (hasWallClock && hasInstants) return { error: "Supply either date/startTime/endTime or startAt/endAt, not both" };

  let query: AvailabilityQuery;
  if (hasInstants) {
    const s = ukWallClockFromInstant(raw.startAt);
    const e = ukWallClockFromInstant(raw.endAt);
    if (!s || !e) return { error: "startAt and endAt must both be valid ISO 8601 instants" };
    if (s.date !== e.date) return { error: `startAt and endAt fall on different Europe/London dates (${s.date} / ${e.date}) - a work interval may not cross midnight` };
    query = { coachId: raw.coachId || "", date: s.date, startTime: s.time, endTime: e.time };
  } else {
    query = { coachId: raw.coachId || "", date: raw.date || "", startTime: raw.startTime || "", endTime: raw.endTime || "" };
  }
  const error = validateAvailabilityQuery(query);
  return error ? { error } : { query };
}

export async function resolveCoachAvailability(deps: { airtable: AirtableConfig }, raw: RawAvailabilityInput): Promise<ResolveCoachAvailabilityResult> {
  const normalised = normaliseAvailabilityInput(raw);
  if ("error" in normalised) return { status: "validation_error", error: normalised.error };
  const { query } = normalised;

  const coach = await fetchCoachById(deps.airtable, query.coachId);
  if (!coach) return { status: "coach_not_found" };

  const [recurring, exceptions] = await Promise.all([
    fetchRecurringAvailabilityForCoach(deps.airtable, query.coachId),
    fetchAvailabilityExceptionsForCoach(deps.airtable, query.coachId),
  ]);

  return { status: "resolved", result: resolveAvailability(query, recurring, exceptions) };
}
