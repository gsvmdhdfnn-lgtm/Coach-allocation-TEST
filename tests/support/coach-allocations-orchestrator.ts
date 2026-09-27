/**
 * Test-suite copy of the canonical orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy. Import path below is adjusted
 * to this directory's own file name (coach-allocations-repository.ts,
 * not repository.ts) - the only intentional divergence from the
 * canonical file; everything else is kept identical.
 *
 * Composition layer for Coaches Slice 5 (see TEST-ENV.md) - the one place
 * validation, rate resolution, idempotency, cost calculation and the
 * actual Airtable create are wired together into
 * createCoachAllocationForOccurrence(), the exact function name the
 * Slice 5 brief asks for. Deliberately thin: every real decision (does
 * this Rate Profile apply, what does it cost, is this a duplicate) is
 * made by coach-rates.ts/repository.ts, imported unchanged - this file
 * only sequences those calls and turns their results into one outcome
 * shape a caller (index.ts's HTTP route, or a test) can switch on.
 *
 * Staffing-vs-financial-allocation boundary (see TEST-ENV.md): this
 * function is never called automatically from any Session Staff/
 * Occurrence Staff write path in this codebase. Creating a paid
 * allocation for a piece of work is always an explicit, separate call -
 * "who is operationally assigned" (staffing) and "the financial record
 * for that work" (allocation) are related but distinct facts, and Slice 5
 * does not wire one into the other.
 */
import {
  resolveCoachRateProfile,
  resolveFinalCost,
  validateCreateAllocationInput,
  type CreateAllocationInput,
} from "./coach-rates.ts";
import {
  type AirtableConfig,
  buildAllocationCreatePayload,
  coachExists,
  createAllocation,
  fetchAllocationsForCoachAndOccurrence,
  fetchRateProfilesForCoach,
  sessionOccurrenceExists,
} from "./coach-allocations-repository.ts";

export type CreateAllocationOutcome =
  | { status: "validation_error"; error: string }
  | { status: "coach_not_found" }
  | { status: "occurrence_not_found" }
  /** Idempotent short-circuit (Coaches Slice 5 - "Allocation idempotency"): a Coach Allocation already exists for this exact (Coach, Session Occurrence) pair, so nothing new was created. */
  | { status: "existing"; recordId: string }
  | { status: "rate_missing" }
  | { status: "rate_ambiguous"; candidateRecordIds: string[] }
  | {
      status: "created";
      recordId: string;
      rateProfileRecordId: string;
      rateAmountSnapshot: number;
      standardCost: number;
      finalCoachCost: number;
      overridden: boolean;
    };

export async function createCoachAllocationForOccurrence(
  deps: { airtable: AirtableConfig },
  input: CreateAllocationInput
): Promise<CreateAllocationOutcome> {
  const validationError = validateCreateAllocationInput(input);
  if (validationError) return { status: "validation_error", error: validationError };

  const [coachOk, occurrenceOk] = await Promise.all([
    coachExists(deps.airtable, input.coachId),
    sessionOccurrenceExists(deps.airtable, input.sessionOccurrenceId),
  ]);
  if (!coachOk) return { status: "coach_not_found" };
  if (!occurrenceOk) return { status: "occurrence_not_found" };

  const existing = await fetchAllocationsForCoachAndOccurrence(deps.airtable, input.coachId, input.sessionOccurrenceId);
  if (existing.length > 0) return { status: "existing", recordId: existing[0].id };

  const rateProfileRows = await fetchRateProfilesForCoach(deps.airtable, input.coachId);
  const resolution = resolveCoachRateProfile(input.coachId, input.workDateIso, input.rateType, rateProfileRows);
  if (resolution.status === "missing") return { status: "rate_missing" };
  if (resolution.status === "ambiguous") {
    return { status: "rate_ambiguous", candidateRecordIds: resolution.candidates.map((c) => c.id) };
  }

  const rateProfile = resolution.profile;
  const rateAmount = rateProfile.fields["Amount"];
  if (typeof rateAmount !== "number" || !isFinite(rateAmount)) {
    // The resolved Rate Profile itself has no usable Amount - fail closed
    // rather than silently treat a blank/malformed Amount as £0. This is
    // a data problem on the Rate Profile row, not something to guess past.
    return { status: "validation_error", error: `Resolved Rate Profile ${rateProfile.id} has no valid numeric Amount` };
  }

  const costResult = resolveFinalCost({
    rateAmount,
    paidUnits: input.paidUnits,
    costOverride: input.costOverride ?? null,
  });

  const payload = buildAllocationCreatePayload(input, rateProfile, costResult);
  const recordId = await createAllocation(deps.airtable, payload);

  return {
    status: "created",
    recordId,
    rateProfileRecordId: rateProfile.id,
    rateAmountSnapshot: rateAmount,
    standardCost: costResult.standardCost,
    finalCoachCost: costResult.finalCoachCost,
    overridden: costResult.overridden,
  };
}
