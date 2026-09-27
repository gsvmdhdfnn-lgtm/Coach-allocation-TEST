/**
 * Test-suite copy of the canonical orchestrator.ts (occurrence-financial-
 * outcomes), kept in sync by hand exactly like every other deployed
 * copy. Import paths below are adjusted to this directory's own file
 * names (financial-outcomes.ts is unchanged; repository.ts becomes
 * occurrence-financial-outcomes-repository.ts; lock-client.ts becomes
 * occurrence-financial-outcomes-lock-client.ts) - everything else is
 * kept identical.
 *
 * Composition layer for Coaches Slice 6 (see TEST-ENV.md) - the one place
 * validation, existence checks, the Parent/Venue upsert boundary, and the
 * actual Airtable read/update calls are wired together. Deliberately
 * thin: every real decision (is this input valid, what fields does this
 * outcome imply) is made by financial-outcomes.ts/repository.ts, imported
 * unchanged - this file only sequences those calls and turns their
 * results into one outcome shape a caller (index.ts's HTTP routes, or a
 * test) can switch on.
 *
 * Three entry points, one per independent fact family - never a single
 * "setOutcome" that could blur Coach/Parent/Venue together:
 * setCoachOutcome, setParentOutcome, setVenueOutcome. Plus one combined
 * read, readFinancialOutcomes, for convenience only (it does not merge
 * or infer between families - it just reports what each already holds).
 */
import {
  buildCoachOutcomePatch,
  buildParentOutcomePatch,
  buildVenueOutcomePatch,
  validateCoachOutcomeInput,
  validateParentOutcomeInput,
  validateVenueOutcomeInput,
  type CoachOutcomeInput,
  type DecidedBy,
  type OccurrenceOutcomeInput,
} from "./financial-outcomes.ts";
import {
  type AirtableConfig,
  fetchAllocationById,
  fetchAllocationsForOccurrence,
  fetchOutcomeRowForOccurrence,
  fetchSessionOccurrenceById,
  createOutcomeRow,
  updateAllocation,
  updateOutcomeRow,
} from "./occurrence-financial-outcomes-repository.ts";
import type { LockClient } from "./occurrence-financial-outcomes-lock-client.ts";

export type SetCoachOutcomeResult =
  | { status: "validation_error"; error: string }
  | { status: "allocation_not_found" }
  | { status: "updated"; recordId: string; finalCoachCost: number; costOverride: number | null };

export async function setCoachOutcome(deps: { airtable: AirtableConfig }, input: CoachOutcomeInput, decidedBy: DecidedBy, nowIso: string = new Date().toISOString()): Promise<SetCoachOutcomeResult> {
  const validationError = validateCoachOutcomeInput(input);
  if (validationError) return { status: "validation_error", error: validationError };

  const allocation = await fetchAllocationById(deps.airtable, input.allocationId);
  if (!allocation) return { status: "allocation_not_found" };

  const rateAmountSnapshot = allocation.fields["Rate Amount Snapshot"];
  const paidUnits = allocation.fields["Paid Units"];
  if (typeof rateAmountSnapshot !== "number" || !isFinite(rateAmountSnapshot) || typeof paidUnits !== "number" || !isFinite(paidUnits)) {
    return { status: "validation_error", error: `Coach Allocation ${input.allocationId} has no valid Rate Amount Snapshot/Paid Units to recalculate a Paid outcome from` };
  }

  const patch = buildCoachOutcomePatch(input, { rateAmountSnapshot, paidUnits }, decidedBy, nowIso);
  await updateAllocation(deps.airtable, input.allocationId, patch);

  return {
    status: "updated",
    recordId: input.allocationId,
    finalCoachCost: patch["Final Coach Cost"] as number,
    costOverride: (patch["Cost Override"] as number | null) ?? null,
  };
}

export type SetOccurrenceOutcomeResult =
  | { status: "validation_error"; error: string }
  | { status: "occurrence_not_found" }
  | { status: "lock_unavailable" }
  | { status: "created"; recordId: string }
  | { status: "updated"; recordId: string };

const DEFAULT_LOCK_MAX_ATTEMPTS = 25;
const DEFAULT_LOCK_RETRY_DELAY_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LockRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Coaches Slice 6 hardening (see TEST-ENV.md - "Occurrence Financial
 * Outcome concurrency"). Serializes the ENTIRE upsert-or-update sequence
 * below per occurrence, so two genuinely concurrent Parent/Venue writes
 * for the SAME occurrence can never both see "no existing row" and both
 * create one - the exact race real TEST verification hit when this
 * session fired two writes in parallel instead of sequentially.
 *
 * `acquire()` returns immediately (null on contention, same as the
 * existing generation-lock pattern this mirrors) - this function is the
 * caller's own choice to keep retrying for a short, bounded budget
 * (~1s by default) rather than either blocking forever or dropping a
 * legitimate concurrent Management request outright. A lock that is
 * never released (e.g. a crashed invocation) self-heals after 5 minutes
 * at the Postgres level (see acquire_occurrence_outcome_lock) - this
 * loop's own budget is about tolerating brief contention between two
 * live requests, not about outliving a stuck lock.
 */
async function withOccurrenceLock<T>(
  lock: LockClient,
  occurrenceId: string,
  fn: () => Promise<T>,
  opts: LockRetryOptions = {}
): Promise<T | { status: "lock_unavailable" }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_LOCK_MAX_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

  let token: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    token = await lock.acquire(occurrenceId);
    if (token) break;
    if (attempt < maxAttempts - 1) await sleep(retryDelayMs);
  }
  if (!token) {
    return { status: "lock_unavailable" };
  }
  try {
    return await fn();
  } finally {
    await lock.release(occurrenceId, token);
  }
}

/**
 * Shared upsert sequence for Parent/Venue (identical shape, different
 * validator/patch-builder/field family) - looks up the one-row-per-
 * occurrence boundary itself; never called with a family name string, so
 * there is no way for a caller to accidentally mix the two families up.
 * Always called through withOccurrenceLock() below, never directly, so
 * this function itself does not need to know about locking at all.
 */
async function upsertOccurrenceOutcome(
  deps: { airtable: AirtableConfig },
  occurrenceId: string,
  patch: Record<string, unknown>
): Promise<SetOccurrenceOutcomeResult> {
  const occurrence = await fetchSessionOccurrenceById(deps.airtable, occurrenceId);
  if (!occurrence) return { status: "occurrence_not_found" };

  const existing = await fetchOutcomeRowForOccurrence(deps.airtable, occurrenceId);
  if (existing) {
    await updateOutcomeRow(deps.airtable, existing.id, patch);
    return { status: "updated", recordId: existing.id };
  }
  const recordId = await createOutcomeRow(deps.airtable, occurrenceId, patch);
  return { status: "created", recordId };
}

export async function setParentOutcome(
  deps: { airtable: AirtableConfig; lock: LockClient },
  input: OccurrenceOutcomeInput,
  decidedBy: DecidedBy,
  nowIso: string = new Date().toISOString(),
  lockOpts?: LockRetryOptions
): Promise<SetOccurrenceOutcomeResult> {
  const validationError = validateParentOutcomeInput(input);
  if (validationError) return { status: "validation_error", error: validationError };
  const patch = buildParentOutcomePatch(input, decidedBy, nowIso);
  return withOccurrenceLock(deps.lock, input.occurrenceId, () => upsertOccurrenceOutcome(deps, input.occurrenceId, patch), lockOpts);
}

export async function setVenueOutcome(
  deps: { airtable: AirtableConfig; lock: LockClient },
  input: OccurrenceOutcomeInput,
  decidedBy: DecidedBy,
  nowIso: string = new Date().toISOString(),
  lockOpts?: LockRetryOptions
): Promise<SetOccurrenceOutcomeResult> {
  const validationError = validateVenueOutcomeInput(input);
  if (validationError) return { status: "validation_error", error: validationError };
  const patch = buildVenueOutcomePatch(input, decidedBy, nowIso);
  return withOccurrenceLock(deps.lock, input.occurrenceId, () => upsertOccurrenceOutcome(deps, input.occurrenceId, patch), lockOpts);
}

export interface FinancialOutcomesView {
  occurrenceId: string;
  occurrenceStatus: string | null;
  coachAllocations: Array<{
    allocationId: string;
    coachOutcome: string | null;
    rateAmountSnapshot: unknown;
    paidUnits: unknown;
    costOverride: unknown;
    overrideReason: unknown;
    finalCoachCost: unknown;
  }>;
  parentOutcome: { outcome: string; amount: unknown; reason: unknown } | null;
  venueOutcome: { outcome: string; amount: unknown; reason: unknown } | null;
}

/**
 * Read-only, combined for caller convenience - reads exactly what is
 * stored in each of the (up to) three places this slice writes, never
 * recomputing or inferring one family from another. Returns null for
 * the whole view only when the occurrence itself does not exist;
 * missing Parent/Venue rows or zero Coach Allocations are normal,
 * reported as empty/null, not an error.
 */
export async function readFinancialOutcomes(deps: { airtable: AirtableConfig }, occurrenceId: string): Promise<FinancialOutcomesView | null> {
  const occurrence = await fetchSessionOccurrenceById(deps.airtable, occurrenceId);
  if (!occurrence) return null;

  const [allocations, outcomeRow] = await Promise.all([
    fetchAllocationsForOccurrence(deps.airtable, occurrenceId),
    fetchOutcomeRowForOccurrence(deps.airtable, occurrenceId),
  ]);

  return {
    occurrenceId,
    occurrenceStatus: occurrence.fields["Status"] ?? null,
    coachAllocations: allocations.map((a) => ({
      allocationId: a.id,
      coachOutcome: a.fields["Coach Outcome"] ?? null,
      rateAmountSnapshot: a.fields["Rate Amount Snapshot"] ?? null,
      paidUnits: a.fields["Paid Units"] ?? null,
      costOverride: a.fields["Cost Override"] ?? null,
      overrideReason: a.fields["Override Reason"] ?? null,
      finalCoachCost: a.fields["Final Coach Cost"] ?? null,
    })),
    parentOutcome: outcomeRow && outcomeRow.fields["Parent Outcome"] != null
      ? { outcome: outcomeRow.fields["Parent Outcome"], amount: outcomeRow.fields["Parent Outcome Amount"] ?? null, reason: outcomeRow.fields["Parent Outcome Reason"] ?? null }
      : null,
    venueOutcome: outcomeRow && outcomeRow.fields["Venue Outcome"] != null
      ? { outcome: outcomeRow.fields["Venue Outcome"], amount: outcomeRow.fields["Venue Outcome Amount"] ?? null, reason: outcomeRow.fields["Venue Outcome Reason"] ?? null }
      : null,
  };
}
