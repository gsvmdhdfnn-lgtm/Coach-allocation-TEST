/**
 * Pure validation/calculation logic for Coaches Slice 6 (cancellation and
 * reschedule financial outcomes - see TEST-ENV.md). No Airtable/Supabase/
 * network calls anywhere in this file, same convention as Slice 5's
 * coach-rates.ts - directly unit-testable against plain fixture data.
 *
 * THE CORE PRINCIPLE (non-negotiable, see TEST-ENV.md): these functions
 * record an explicit Management DECISION about what happens financially
 * for one occurrence. They never execute money movement (no Stripe, no
 * credit ledger, no coach payment, no venue settlement) and never infer
 * one outcome family from another - Coach, Parent and Venue outcomes are
 * three independent facts, set and read independently.
 */

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

/** Same convention as coach-rates.ts's roundCurrency - avoids floating-point drift before a currency value is written or compared. */
export function roundCurrency(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Coach Allocations' own singleSelect choices (Coaches Slice 6). */
export const KNOWN_COACH_OUTCOMES = ["Paid", "Unpaid", "Partial"] as const;
export type CoachOutcome = (typeof KNOWN_COACH_OUTCOMES)[number];

/** Occurrence Financial Outcomes' own Parent Outcome choices. */
export const KNOWN_PARENT_OUTCOMES = ["Credit", "Refund", "None"] as const;
export type ParentOutcome = (typeof KNOWN_PARENT_OUTCOMES)[number];

/** Occurrence Financial Outcomes' own Venue Outcome choices. */
export const KNOWN_VENUE_OUTCOMES = ["Paid", "Credit", "None"] as const;
export type VenueOutcome = (typeof KNOWN_VENUE_OUTCOMES)[number];

function isValidAmount(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= 0;
}

export interface DecidedBy {
  userId: string;
  name: string | null;
}

/**
 * The Management-only predicate itself, kept pure and separate from
 * index.ts's HTTP wiring/Supabase Auth lookup so it is directly unit-
 * testable (see TEST-ENV.md - Coach/Parent JWTs must never satisfy
 * this). index.ts's requireManagement() calls this exact function
 * rather than re-implementing the check inline, so a unit test proving
 * a Coach-role or Parent-role caller fails this predicate proves the
 * real deployed authorisation rule, not a parallel reimplementation.
 */
export function isManagementCaller(caller: { role: string; active: boolean } | null): boolean {
  return !!caller && caller.active === true && caller.role === "management";
}

// ---------------------------------------------------------------------
// Coach outcome (lives on the existing Coach Allocation - Slice 5's
// Rate Amount Snapshot/Paid Units/Cost Override/Override Reason/Final
// Coach Cost fields are reused, never duplicated elsewhere).
// ---------------------------------------------------------------------

export interface CoachOutcomeInput {
  allocationId: string;
  outcome: string;
  /** Required when outcome is "Partial" - the explicit Management-agreed amount. Ignored for "Paid" (recalculated from the allocation's own snapshot) and "Unpaid" (always zero). */
  amount?: number | null;
  reason?: string | null;
}

/**
 * Validates shape only - does not check the allocation actually exists
 * (an orchestrator/repository concern needing a real Airtable read).
 * "Partial" requires a valid non-negative amount, per the brief
 * ("Management provides the agreed partial amount") - "Paid"/"Unpaid"
 * do not require one, but a garbage amount supplied anyway still fails
 * closed rather than being silently ignored.
 */
export function validateCoachOutcomeInput(input: CoachOutcomeInput): string | null {
  if (!RECORD_ID_RE.test(input.allocationId || "")) return "allocationId is required and must be a valid Airtable record ID";
  if (!KNOWN_COACH_OUTCOMES.includes(input.outcome as CoachOutcome)) return `outcome must be one of: ${KNOWN_COACH_OUTCOMES.join(", ")}`;
  if (input.outcome === "Partial") {
    if (!isValidAmount(input.amount)) return "amount is required and must be a non-negative number when outcome is Partial";
  } else if (input.amount != null && !isValidAmount(input.amount)) {
    return "amount must be a non-negative number when provided";
  }
  return null;
}

export interface CoachAllocationSnapshot {
  /** The allocation's OWN already-stored Rate Amount Snapshot - never a live Coach Rate Profile read. */
  rateAmountSnapshot: number;
  paidUnits: number;
}

/**
 * Builds the Coach Allocations PATCH fields for one outcome decision.
 * Preserves the historical rate snapshot regardless of outcome - this
 * function never touches Rate Profile/Rate Type Snapshot/Pay Unit
 * Snapshot/Rate Amount Snapshot, only Coach Outcome/Cost Override/
 * Override Reason/Final Coach Cost/the "decided by" audit fields.
 *
 * - Paid: preserves the intended full payable cost, recalculated from
 *   THIS allocation's own stored snapshot (rateAmountSnapshot x
 *   paidUnits) - never from the Coach's current live Rate Profile.
 *   Cost Override is cleared (this is the normal case, not an override).
 * - Unpaid: Final Coach Cost becomes zero, via Cost Override = 0, so
 *   the existing Coach Allocation model represents "no coach cost"
 *   safely without inventing a second cost field.
 * - Partial: Cost Override is the explicit Management-agreed amount;
 *   Final Coach Cost equals it.
 *
 * Override Reason is always set to exactly what was supplied (or
 * cleared to null when omitted) on every call, so an old reason from a
 * previous decision can never linger and look attached to a new one.
 */
export function buildCoachOutcomePatch(input: CoachOutcomeInput, snapshot: CoachAllocationSnapshot, decidedBy: DecidedBy, nowIso: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "Coach Outcome": input.outcome,
    "Override Reason": input.reason ?? null,
    "Coach Outcome Decided By User ID": decidedBy.userId,
    "Coach Outcome Decided By Name Snapshot": decidedBy.name,
    "Coach Outcome Decided At": nowIso,
  };
  if (input.outcome === "Paid") {
    fields["Cost Override"] = null;
    fields["Final Coach Cost"] = roundCurrency(snapshot.rateAmountSnapshot * snapshot.paidUnits);
  } else if (input.outcome === "Unpaid") {
    fields["Cost Override"] = 0;
    fields["Final Coach Cost"] = 0;
  } else {
    fields["Cost Override"] = roundCurrency(input.amount as number);
    fields["Final Coach Cost"] = roundCurrency(input.amount as number);
  }
  return fields;
}

// ---------------------------------------------------------------------
// Parent outcome and Venue outcome (Occurrence Financial Outcomes -
// one row per Session Occurrence, created only on first decision).
// Deliberately identical shape/validation for both families - they are
// independent facts about the same occurrence, never inferred from one
// another or from Coach outcome.
// ---------------------------------------------------------------------

export interface OccurrenceOutcomeInput {
  occurrenceId: string;
  outcome: string;
  amount?: number | null;
  reason?: string | null;
}

export function validateParentOutcomeInput(input: OccurrenceOutcomeInput): string | null {
  if (!RECORD_ID_RE.test(input.occurrenceId || "")) return "occurrenceId is required and must be a valid Airtable record ID";
  if (!KNOWN_PARENT_OUTCOMES.includes(input.outcome as ParentOutcome)) return `outcome must be one of: ${KNOWN_PARENT_OUTCOMES.join(", ")}`;
  if (input.amount != null && !isValidAmount(input.amount)) return "amount must be a non-negative number when provided";
  return null;
}

export function validateVenueOutcomeInput(input: OccurrenceOutcomeInput): string | null {
  if (!RECORD_ID_RE.test(input.occurrenceId || "")) return "occurrenceId is required and must be a valid Airtable record ID";
  if (!KNOWN_VENUE_OUTCOMES.includes(input.outcome as VenueOutcome)) return `outcome must be one of: ${KNOWN_VENUE_OUTCOMES.join(", ")}`;
  if (input.amount != null && !isValidAmount(input.amount)) return "amount must be a non-negative number when provided";
  return null;
}

/**
 * Builds ONLY the Parent Outcome fields of the Occurrence Financial
 * Outcomes PATCH - never touches any Venue Outcome field, so a Parent
 * decision can never accidentally clear or overwrite an independently
 * recorded Venue decision on the same row (or vice versa via
 * buildVenueOutcomePatch).
 */
export function buildParentOutcomePatch(input: OccurrenceOutcomeInput, decidedBy: DecidedBy, nowIso: string): Record<string, unknown> {
  return {
    "Parent Outcome": input.outcome,
    "Parent Outcome Amount": input.amount ?? null,
    "Parent Outcome Reason": input.reason ?? null,
    "Parent Outcome Decided By User ID": decidedBy.userId,
    "Parent Outcome Decided By Name Snapshot": decidedBy.name,
    "Parent Outcome Decided At": nowIso,
  };
}

export function buildVenueOutcomePatch(input: OccurrenceOutcomeInput, decidedBy: DecidedBy, nowIso: string): Record<string, unknown> {
  return {
    "Venue Outcome": input.outcome,
    "Venue Outcome Amount": input.amount ?? null,
    "Venue Outcome Reason": input.reason ?? null,
    "Venue Outcome Decided By User ID": decidedBy.userId,
    "Venue Outcome Decided By Name Snapshot": decidedBy.name,
    "Venue Outcome Decided At": nowIso,
  };
}
