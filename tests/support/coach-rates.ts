/**
 * Test-suite copy of the canonical coach-rates.ts, kept in sync by hand
 * exactly like every other deployed copy - imported directly by
 * tests/support/coach-allocations.test.ts (run via
 * tests/e2e/coachallocationstest.js, which shells out to it with
 * `node --experimental-strip-types`) to unit-test the resolver/cost
 * logic itself, independent of any HTTP mock.
 *
 * Pure rate-resolution and cost-calculation logic for Coaches Slice 5 (see
 * TEST-ENV.md). No Airtable/Supabase/network calls anywhere in this file -
 * same "portable pure(ish) logic, thin runtime-specific wiring kept
 * elsewhere" convention as session-occurrences/schedule-utils.ts and
 * hub-content/player-access.ts's resolver functions. Every function here
 * is directly unit-testable against plain fixture data.
 *
 * THE CORE PRINCIPLE (non-negotiable, see TEST-ENV.md): a Coach Rate
 * Profile's Amount can change over time, but once a Coach Allocation has
 * been created, its own snapshot fields (Rate Type Snapshot, Pay Unit
 * Snapshot, Rate Amount Snapshot, Final Coach Cost) are fixed at creation
 * time and NEVER re-derived from the Coach's current Rate Profile. Nothing
 * in this file - or anywhere in this Edge Function - re-reads a Rate
 * Profile's live Amount to answer a question about an existing allocation.
 */

/** Airtable's REST API returns a singleSelect as the plain option-name string, never an {id,name,color} object - handled defensively both ways, same convention as every other resolver in this codebase. */
export function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

export function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CoachRateProfileRecord {
  id: string;
  fields: Record<string, any>;
}

/**
 * THE one shared rule for "does this Coach Rate Profile apply on this
 * work date" - the SAME inclusive-date-range principle as Session Staff's
 * sessionStaffAppliesOnDate() (hub-content/player-access.ts, Coaches
 * Slice 2), deliberately not re-invented: `Active` is an independent
 * administrative enable/disable flag, checked first and absolute; then
 * `Effective From`/`Effective Until` decide whether an ENABLED row
 * applies on THIS particular date - both inclusive, both optional (blank
 * From = applies from the start of time; blank Until = applies
 * indefinitely; both blank = applies whenever Active). Fails closed on
 * malformed data: a non-blank Effective From/Until that isn't a valid
 * "YYYY-MM-DD" string excludes the whole row rather than being treated as
 * absent.
 */
export function rateProfileAppliesOnDate(row: CoachRateProfileRecord, dateIso: string): boolean {
  if (row.fields["Active"] !== true) return false;
  const from = row.fields["Effective From"];
  if (from != null && from !== "") {
    if (typeof from !== "string" || !ISO_DATE_ONLY_RE.test(from)) return false;
    if (dateIso < from) return false;
  }
  const until = row.fields["Effective Until"];
  if (until != null && until !== "") {
    if (typeof until !== "string" || !ISO_DATE_ONLY_RE.test(until)) return false;
    if (dateIso > until) return false;
  }
  return true;
}

export type RateResolution =
  | { status: "resolved"; profile: CoachRateProfileRecord }
  /** No Active, date-applicable Rate Profile of this Rate Type exists for this Coach - fails closed, never guesses. */
  | { status: "missing" }
  /**
   * More than one Active, date-applicable Rate Profile of the SAME Rate
   * Type exists for this Coach on this date, and Coach Rate Profiles has
   * no explicit precedence field (no "Priority"/"Preferred" concept in
   * the real TEST schema, confirmed by a fresh re-read before writing
   * this file) - so this is reported as an ambiguity rather than silently
   * picking one, exactly per the Slice 5 brief.
   */
  | { status: "ambiguous"; candidates: CoachRateProfileRecord[] };

/**
 * Given Coach + work date + intended Rate Type, resolve the correct Rate
 * Profile - the exact boundary the Slice 5 brief asks for. Deliberately
 * does NOT try to infer Rate Type from the Session/Occurrence itself:
 * Sessions' own "Category" field is free text (its real TEST values
 * include things like "Evening" and "Trials" used for public-facing
 * categorisation, not a controlled vocabulary guaranteed to align with
 * Rate Type's Day/Evening/Camp/Additional-Plus choices), so treating it
 * as a reliable source would be inventing an accounting rule the schema
 * doesn't actually back. Rate Type stays an explicit caller-supplied
 * parameter this slice - see TEST-ENV.md ("Rate selection boundary").
 */
export function resolveCoachRateProfile(
  coachId: string,
  dateIso: string,
  rateType: string,
  rateProfileRows: CoachRateProfileRecord[]
): RateResolution {
  const candidates = rateProfileRows.filter((row) => {
    const rowCoachId = firstLink(row.fields, "Coach");
    if (rowCoachId !== coachId) return false;
    if (selectName(row.fields["Rate Type"]) !== rateType) return false;
    return rateProfileAppliesOnDate(row, dateIso);
  });
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "resolved", profile: candidates[0] };
}

/** The four Rate Type choices as they actually exist in TEST (Coach Rate Profiles' own singleSelect). */
export const KNOWN_RATE_TYPES = ["Day", "Evening", "Camp", "Additional / Plus"] as const;
export type RateType = (typeof KNOWN_RATE_TYPES)[number];

/** The three Pay Unit choices as they actually exist in TEST (Coach Rate Profiles' own singleSelect). */
export const KNOWN_PAY_UNITS = ["Per Hour", "Per Session", "Per Day"] as const;
export type PayUnit = (typeof KNOWN_PAY_UNITS)[number];

/** The three Assignment Type choices on Coach Allocations itself (distinct from Occurrence Staff's own Assignment Type choices - Planned/Cover/Additional/Temporary Role - a different field on a different table). */
export const KNOWN_ALLOCATION_ASSIGNMENT_TYPES = ["Scheduled", "Cover", "Additional"] as const;
export type AllocationAssignmentType = (typeof KNOWN_ALLOCATION_ASSIGNMENT_TYPES)[number];

export const KNOWN_COST_STATUSES = ["Draft", "Confirmed", "Exported"] as const;
export type CostStatus = (typeof KNOWN_COST_STATUSES)[number];

/**
 * Avoids floating-point drift (e.g. 25 * 1.1 producing 27.500000000000004)
 * before a currency value is ever written to Airtable or compared in a
 * test - standard round-to-2-decimal-places, applied everywhere a cost is
 * computed in this file.
 */
export function roundCurrency(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Final Coach Cost = Rate Amount Snapshot x Paid Units, for the normal
 * undisputed case - Pay Unit itself doesn't change the arithmetic, only
 * what Paid Units is understood to MEAN when a human enters it (see
 * PAY_UNIT_INTERPRETATION below): Per Hour -> Paid Units is hours worked;
 * Per Session -> Paid Units is normally 1; Per Day -> Paid Units is
 * normally 1. This file never enforces "must be 1" for Per Session/Per
 * Day - Management may legitimately need e.g. 2 sessions covered in one
 * allocation - it only documents the normal expectation; enforcing a
 * stricter rule would be inventing an accounting policy the brief
 * explicitly says to avoid.
 */
export const PAY_UNIT_INTERPRETATION: Record<PayUnit, string> = {
  "Per Hour": "Paid Units represents the number of hours worked.",
  "Per Session": "Paid Units is normally 1 (one session's worth of work).",
  "Per Day": "Paid Units is normally 1 (one day's worth of work).",
};

export function calculateStandardCost(rateAmount: number, paidUnits: number): number {
  return roundCurrency(rateAmount * paidUnits);
}

export interface ResolveFinalCostInput {
  rateAmount: number;
  paidUnits: number;
  /** Present (non-null) means Management is paying a different amount for this specific piece of work - see the Cost Override section below. */
  costOverride?: number | null;
}

export interface ResolveFinalCostResult {
  /** What the normal Rate Amount Snapshot x Paid Units calculation gives - preserved for visibility even when an override applies, since the schema has no dedicated field to store it in (see TEST-ENV.md). */
  standardCost: number;
  /** What actually applies - the override when one is set, otherwise the standard calculation. This is the only value ever written to Final Coach Cost. */
  finalCoachCost: number;
  overridden: boolean;
}

/**
 * Cost Override support (see TEST-ENV.md - "Management sometimes pays a
 * coach a different amount for a specific piece of work, e.g. covering as
 * a favour for a fixed £40"). An override NEVER touches the Rate Profile
 * snapshot fields (Rate Profile link, Rate Type Snapshot, Pay Unit
 * Snapshot, Rate Amount Snapshot all stay exactly what the resolved Rate
 * Profile gave) - only Final Coach Cost changes. The Coach's normal Rate
 * Profile itself is never edited because of a one-off deal.
 */
export function resolveFinalCost(input: ResolveFinalCostInput): ResolveFinalCostResult {
  const standardCost = calculateStandardCost(input.rateAmount, input.paidUnits);
  if (input.costOverride != null) {
    return { standardCost, finalCoachCost: roundCurrency(input.costOverride), overridden: true };
  }
  return { standardCost, finalCoachCost: standardCost, overridden: false };
}

export interface CreateAllocationInput {
  coachId: string;
  sessionOccurrenceId: string;
  workDateIso: string;
  rateType: string;
  assignmentType: string;
  paidUnits: number;
  costOverride?: number | null;
  overrideReason?: string | null;
  costStatus?: string;
  notes?: string | null;
}

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * HTTP-boundary-style validation, kept here (not in index.ts) since it's
 * pure and needs no request/Response types - the same "validate before
 * anything touches Airtable" discipline as session-occurrences/index.ts's
 * own validators. Returns a human-readable error string, or null if the
 * input is well-formed. Does NOT check whether the Coach/Session
 * Occurrence records actually exist, or whether the Rate Type resolves to
 * a real Rate Profile - those are repository/orchestrator-level concerns
 * that need a real Airtable read.
 *
 * The Override Reason requirement is enforced here, not left to Airtable:
 * "require/store an Override Reason where the schema supports it" (the
 * brief) - Override Reason exists as a real field, so a Cost Override
 * with no reason fails closed rather than being silently accepted.
 */
export function validateCreateAllocationInput(input: CreateAllocationInput): string | null {
  if (!RECORD_ID_RE.test(input.coachId || "")) return "coachId is required and must be a valid Airtable record ID";
  if (!RECORD_ID_RE.test(input.sessionOccurrenceId || "")) return "sessionOccurrenceId is required and must be a valid Airtable record ID";
  if (!ISO_DATE_RE.test(input.workDateIso || "")) return 'workDateIso is required and must be "YYYY-MM-DD"';
  if (!KNOWN_RATE_TYPES.includes(input.rateType as RateType)) return `rateType must be one of: ${KNOWN_RATE_TYPES.join(", ")}`;
  if (!KNOWN_ALLOCATION_ASSIGNMENT_TYPES.includes(input.assignmentType as AllocationAssignmentType)) {
    return `assignmentType must be one of: ${KNOWN_ALLOCATION_ASSIGNMENT_TYPES.join(", ")}`;
  }
  if (typeof input.paidUnits !== "number" || !isFinite(input.paidUnits) || input.paidUnits <= 0) {
    return "paidUnits must be a positive number";
  }
  if (input.costOverride != null) {
    if (typeof input.costOverride !== "number" || !isFinite(input.costOverride)) {
      return "costOverride must be a number when provided";
    }
    if (!input.overrideReason || !input.overrideReason.trim()) {
      return "overrideReason is required when costOverride is set";
    }
  }
  if (input.costStatus != null && !KNOWN_COST_STATUSES.includes(input.costStatus as CostStatus)) {
    return `costStatus must be one of: ${KNOWN_COST_STATUSES.join(", ")}`;
  }
  return null;
}
