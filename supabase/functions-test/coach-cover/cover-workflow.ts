/**
 * Pure cover-workflow rules for Coaches Slice 9 (see TEST-ENV.md). No
 * Airtable/Supabase/network calls - every decision about who may do what,
 * which state transitions are legal, how suitable a candidate is, and what
 * exactly gets written is made here and is directly unit-testable. The
 * orchestrator only loads rows, calls these functions, and executes the
 * returned plans.
 *
 * Lifecycle, per cover DATE (Staff Availability Requests row):
 *   Open --(Management selects an accepted response)--> Filled
 *   Open --(requester or Management cancels)---------> Cancelled
 *   Filled / Cancelled are terminal here: a Filled date is never cancelled
 *   or deleted by this workflow (un-assigning needs a deliberate Management
 *   action that is out of scope), and nothing is ever deleted.
 * The group (Cover Request Groups row) status is always DERIVED from its
 * dates' statuses.
 */
import type { AvailabilityResult } from "./coach-availability.ts";
import type { ComplianceSummary } from "./coach-compliance.ts";
import { resolveCoachRateProfile, roundCurrency, KNOWN_RATE_TYPES, type CoachRateProfileRecord } from "./coach-rates.ts";
import {
  firstLink,
  resolveOccurrenceStaffing,
  selectName,
  type CoachRoleCapabilities,
  type RequesterAssignment,
  type StaffingContext,
  type OccurrenceRef,
  occurrenceStaffForOccurrence,
} from "./staffing.ts";

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const COVER_REASONS = ["Illness", "Personal commitment", "Holiday", "Work clash", "Emergency", "Other"] as const;
export const COVER_DATE_STATUSES = ["Open", "Filled", "Cancelled", "Resolved Without Cover"] as const;
export const GROUP_STATUSES = ["Open", "Partially Filled", "Filled", "Cancelled", "Resolved Without Cover"] as const;
/** Accept/Decline map onto the real Response Status choices "Yes"/"No". "Invited"/"Withdrawn" are not written by this slice. */
export const RESPONSE_STATUS = { Accept: "Yes", Decline: "No" } as const;
export const MAX_DATES_PER_REQUEST = 20;
export const UNFILLED_ESCALATION_MS = DAY_MS;

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

export function isValidRecordId(id: any): id is string {
  return RECORD_ID_RE.test(String(id ?? ""));
}

function linkIds(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x?.id)).filter((x): x is string => typeof x === "string");
}

// ---------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------

export type Actor =
  | { kind: "management"; userId: string; displayName: string | null }
  | { kind: "coach"; userId: string; displayName: string | null; coachId: string };

/** From the authenticated profile only. Parents, inactive profiles and coaches without a valid Coaches link get null (403). */
export function resolveActor(caller: { role: string; active: boolean; userId: string; displayName: string | null; airtablePersonId: string | null } | null): Actor | null {
  if (!caller || caller.active !== true) return null;
  if (caller.role === "management") return { kind: "management", userId: caller.userId, displayName: caller.displayName };
  if (caller.role === "coach" && isValidRecordId(caller.airtablePersonId)) {
    return { kind: "coach", userId: caller.userId, displayName: caller.displayName, coachId: caller.airtablePersonId };
  }
  return null;
}

// ---------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------

export interface CreateRequestInput {
  occurrenceIds: string[];
  reason: string;
  handoverNote: string | null;
  coachNote: string | null;
  /** Management only: the coach the request is for. A coach always requests for themselves. */
  coachId: string | null;
}

export function parseCreateRequestBody(body: any, actor: Actor): { input: CreateRequestInput } | { error: string; httpStatus: 400 | 403 } {
  if (!body || typeof body !== "object") return { error: "Invalid JSON body", httpStatus: 400 };
  const ids = body.occurrenceIds;
  if (!Array.isArray(ids) || ids.length === 0) return { error: "occurrenceIds must be a non-empty array of Session Occurrence record IDs", httpStatus: 400 };
  if (ids.length > MAX_DATES_PER_REQUEST) return { error: `At most ${MAX_DATES_PER_REQUEST} dates per request`, httpStatus: 400 };
  if (!ids.every(isValidRecordId)) return { error: "Every occurrenceId must be a valid Airtable record ID", httpStatus: 400 };
  if (new Set(ids).size !== ids.length) return { error: "occurrenceIds contains duplicates", httpStatus: 400 };
  if (!(COVER_REASONS as readonly string[]).includes(body.reason)) return { error: `reason must be one of: ${COVER_REASONS.join(", ")}`, httpStatus: 400 };
  for (const k of ["handoverNote", "coachNote"]) {
    if (body[k] != null && (typeof body[k] !== "string" || body[k].length > 5000)) return { error: `${k} must be a string of at most 5000 characters`, httpStatus: 400 };
  }
  let coachId: string | null = null;
  if (actor.kind === "coach") {
    if (body.coachId != null && body.coachId !== actor.coachId) return { error: "A coach can only request cover for their own assignments", httpStatus: 403 };
    coachId = actor.coachId;
  } else {
    if (!isValidRecordId(body.coachId)) return { error: "coachId is required when Management creates a cover request", httpStatus: 400 };
    coachId = body.coachId;
  }
  return { input: { occurrenceIds: ids, reason: body.reason, handoverNote: body.handoverNote ?? null, coachNote: body.coachNote ?? null, coachId } };
}

export interface RequestDateCheck {
  occurrenceId: string;
  ok: boolean;
  error?: string;
  assignment?: RequesterAssignment;
}

/**
 * One requested date is valid only if the occurrence exists, is Scheduled,
 * is today or later (UK), the coach is GENUINELY staffing it right now
 * (Session Staff or current Occurrence Staff truth, via the Slice 3
 * resolver), and there is no already-Open request by that coach for it.
 */
export function checkRequestDate(
  occurrence: AirtableRecord | null,
  occurrenceRef: OccurrenceRef | null,
  assignment: RequesterAssignment | null,
  openRequestExists: boolean,
  todayUk: string
): RequestDateCheck {
  const id = occurrence?.id ?? occurrenceRef?.id ?? "";
  if (!occurrence || !occurrenceRef) return { occurrenceId: id, ok: false, error: "Session Occurrence not found" };
  const status = selectName(occurrence.fields["Status"]);
  if (status !== "Scheduled") return { occurrenceId: id, ok: false, error: `Occurrence is ${status || "not Scheduled"} - cover can only be requested for a Scheduled occurrence` };
  if (occurrenceRef.dateIso < todayUk) return { occurrenceId: id, ok: false, error: `Occurrence date ${occurrenceRef.dateIso} is in the past` };
  if (!assignment) return { occurrenceId: id, ok: false, error: "The coach is not assigned to this occurrence (Session Staff / Occurrence Staff), so cannot request cover for it" };
  if (openRequestExists) return { occurrenceId: id, ok: false, error: "An open cover request already exists for this coach and occurrence" };
  return { occurrenceId: id, ok: true, assignment };
}

export function buildGroupFields(actor: Actor, input: CreateRequestInput, now: Date): Record<string, unknown> {
  return {
    "Cover Group ID": `COVERGRP-${input.coachId}-${now.getTime()}`,
    "Requesting Coach": [input.coachId],
    "Reason": input.reason,
    "Handover Note": input.handoverNote,
    "Status": "Open",
    "Requested Via": actor.kind === "coach" ? "Coach Hub" : "Management Hub",
    "Active": true,
  };
}

export function buildRequestDateFields(actor: Actor, input: CreateRequestInput, groupId: string, occurrenceId: string, now: Date): Record<string, unknown> {
  return {
    "Request ID": `COVER-${occurrenceId}-${input.coachId}-${now.getTime()}`,
    "Coach": [input.coachId],
    "Session Occurrence": [occurrenceId],
    "Request Type": "Cover Request",
    "Coach Note": input.coachNote,
    "Requested Via": actor.kind === "coach" ? "Coach Hub" : "Management Hub",
    "Cover Request Group": [groupId],
    "Cover Date Status": "Open",
  };
}

// ---------------------------------------------------------------------
// Status derivation + 24h unfilled signal
// ---------------------------------------------------------------------

/** Group status is derived from its dates, never trusted from the stored text. */
export function deriveGroupStatus(dateStatuses: string[]): string {
  if (dateStatuses.length === 0) return "Cancelled";
  const open = dateStatuses.includes("Open");
  const filled = dateStatuses.includes("Filled");
  if (open) return filled ? "Partially Filled" : "Open";
  if (filled) return "Filled";
  if (dateStatuses.every((s) => s === "Cancelled")) return "Cancelled";
  return "Resolved Without Cover";
}

/**
 * The escalation SIGNAL only (no notifications): a date is flagged once it
 * has been Open for >= 24h, measured from the record's own Airtable
 * createdTime. Exactly 24h counts. Anything not Open is never flagged.
 */
export function unfilledSignal(dateStatus: string, createdTimeIso: string | undefined, now: Date): { openForMinutes: number | null; unfilledOver24h: boolean } {
  if (dateStatus !== "Open") return { openForMinutes: null, unfilledOver24h: false };
  const created = createdTimeIso ? new Date(createdTimeIso).getTime() : NaN;
  if (isNaN(created)) return { openForMinutes: null, unfilledOver24h: false };
  // createdTime has whole-second precision and comes from Airtable's clock, so a
  // just-created record can look fractionally "in the future" - clamp to 0.
  const age = Math.max(0, now.getTime() - created);
  return { openForMinutes: Math.floor(age / 60000), unfilledOver24h: age >= UNFILLED_ESCALATION_MS };
}

// ---------------------------------------------------------------------
// Candidate suitability (transparent, rule-based - never a ranking)
// ---------------------------------------------------------------------

export type SuitabilityStatus = "suitable" | "needs_management_review" | "unsuitable";

export interface SuitabilityFinding {
  code: string;
  detail: string;
}

export interface SuitabilityResult {
  status: SuitabilityStatus;
  blockers: SuitabilityFinding[];
  warnings: SuitabilityFinding[];
  info: SuitabilityFinding[];
}

export interface SuitabilityInput {
  candidateCoachId: string;
  candidateActive: boolean;
  requesterCoachId: string;
  /** Resolved roster of the target occurrence, before any cover is applied. */
  targetRosterCoachIds: string[];
  /** Slice 7 result for the occurrence's UK wall-clock time; null = the occurrence has no usable times. */
  availability: AvailabilityResult | null;
  /** Slice 8 summary for the candidate, evaluated as of the cover date. */
  compliance: ComplianceSummary;
  /** The requester's role on this occurrence (what the cover must fill); null = unresolvable. */
  requiredRole: { rank: number; roleName: string } | null;
  /** The candidate's strongest current role anywhere on that date; null = unknown. */
  candidateRole: { rank: number; roleName: string } | null;
  /** null = could not be evaluated (target has no usable times). */
  overlap: { clashes: { id: string }[]; uncertain: { id: string }[] } | null;
  /** The Session's own "Requires Lead Coach" flag. */
  requiresLeadCoach: boolean;
  /** Lead Coaches (by Role Key) left on the roster once the requester is removed. */
  otherLeadCoachesRemaining: number;
}

const BLOCKING_COMPLIANCE = new Set(["Missing", "Expired", "Needs Review"]);
const COACH_RANK = 2;
const LEAD_RANK = 3;

/**
 * Exact rule (see TEST-ENV.md):
 *  BLOCKERS (unsuitable - never selectable):
 *   - candidate is the requester, or already staffs this occurrence
 *   - Coach record not Active
 *   - availability `unavailable` or `ambiguous`
 *   - a time-overlapping assignment on another occurrence
 *   - any REQUIRED compliance item Missing / Expired / Needs Review
 *   - candidate's known role is weaker than the role being covered: a
 *     Learning Coach can never replace a Coach or Lead Coach; a Coach
 *     cannot replace a Lead Coach when the Session Requires Lead Coach
 *     and no other Lead Coach would remain
 *  WARNINGS (needs_management_review - selectable only with explicit
 *  Management confirmation, never silently):
 *   - availability `unknown`, or availability/overlap not evaluable
 *     (occurrence has no usable times)
 *   - a same-day assignment whose times are unusable (overlap uncertain)
 *   - candidate role capability unknown, or the covered role unresolvable
 *   - a Coach replacing a Lead Coach where no Lead Coach requirement is
 *     broken (role_downgrade)
 *   - compliance data problems (e.g. bad requirement config)
 *  INFO (no effect on status):
 *   - compliance Review Soon (usable, per the product rule)
 *   - no organisation requirements configured
 */
export function evaluateSuitability(input: SuitabilityInput): SuitabilityResult {
  const blockers: SuitabilityFinding[] = [];
  const warnings: SuitabilityFinding[] = [];
  const info: SuitabilityFinding[] = [];

  if (input.candidateCoachId === input.requesterCoachId) blockers.push({ code: "is_requester", detail: "The requesting coach cannot cover their own request" });
  if (input.targetRosterCoachIds.includes(input.candidateCoachId) && input.candidateCoachId !== input.requesterCoachId) {
    blockers.push({ code: "already_staffing_this_occurrence", detail: "Candidate is already staffing this occurrence" });
  }
  if (!input.candidateActive) blockers.push({ code: "coach_inactive", detail: "Candidate's Coach record is not Active" });

  const a = input.availability;
  if (!a) warnings.push({ code: "availability_not_evaluable", detail: "Occurrence has no usable Start/End Date & Time, so availability cannot be confirmed" });
  else if (a.status === "unavailable") blockers.push({ code: "availability_unavailable", detail: `Availability: unavailable (${a.reason})` });
  else if (a.status === "ambiguous") blockers.push({ code: "availability_ambiguous", detail: `Availability is ambiguous (${a.reason}) - fails safe` });
  else if (a.status === "unknown") warnings.push({ code: "availability_unknown", detail: "No availability supplied for this time - not confirmed available" });

  if (!input.overlap) warnings.push({ code: "overlap_not_evaluable", detail: "Occurrence has no usable times, so overlapping assignments cannot be ruled out" });
  else {
    if (input.overlap.clashes.length) blockers.push({ code: "overlapping_assignment", detail: `Already assigned to overlapping occurrence(s): ${input.overlap.clashes.map((c) => c.id).join(", ")}` });
    if (input.overlap.uncertain.length) warnings.push({ code: "overlap_uncertain", detail: `Assigned to same-day occurrence(s) with unusable times: ${input.overlap.uncertain.map((c) => c.id).join(", ")}` });
  }

  const blocking = input.compliance.items.filter((i) => BLOCKING_COMPLIANCE.has(i.status));
  if (blocking.length) blockers.push({ code: "compliance_blocking", detail: blocking.map((i) => `${i.documentType}: ${i.status}`).join("; ") });
  const soon = input.compliance.items.filter((i) => i.status === "Review Soon");
  if (soon.length) info.push({ code: "compliance_review_soon", detail: soon.map((i) => `${i.documentType}: Review Soon`).join("; ") });
  if (input.compliance.problems.length) warnings.push({ code: "compliance_data_problem", detail: input.compliance.problems.map((p) => p.issue).join("; ") });
  if (input.compliance.items.length === 0) info.push({ code: "no_compliance_requirements", detail: "No organisation compliance requirements are configured" });

  if (!input.requiredRole) warnings.push({ code: "covered_role_unresolved", detail: "The requester's role on this occurrence could not be resolved" });
  else if (!input.candidateRole) warnings.push({ code: "role_capability_unknown", detail: `Candidate holds no current recurring role, so capability for ${input.requiredRole.roleName} is unknown` });
  else if (input.candidateRole.rank < input.requiredRole.rank) {
    const coachForLead = input.requiredRole.rank === LEAD_RANK && input.candidateRole.rank === COACH_RANK;
    if (coachForLead && !(input.requiresLeadCoach && input.otherLeadCoachesRemaining === 0)) {
      warnings.push({ code: "role_downgrade", detail: `Candidate (${input.candidateRole.roleName}) would replace a ${input.requiredRole.roleName}; the session does not lose its only required Lead Coach` });
    } else if (coachForLead) {
      blockers.push({ code: "lead_coach_required", detail: "Session Requires Lead Coach and no other Lead Coach would remain - candidate is not a Lead Coach" });
    } else {
      blockers.push({ code: "role_insufficient", detail: `Candidate's role (${input.candidateRole.roleName}) cannot replace ${input.requiredRole.roleName}` });
    }
  }

  const status: SuitabilityStatus = blockers.length ? "unsuitable" : warnings.length ? "needs_management_review" : "suitable";
  return { status, blockers, warnings, info };
}

// ---------------------------------------------------------------------
// Rate / expected-cost preview (Slice 5 resolution; preview only)
// ---------------------------------------------------------------------

export type RateTypeDetermination =
  | { rateType: string; source: "management" | "requester_allocation" }
  | { rateType: null; reason: "no_rate_type" | "ambiguous_rate_type" | "invalid_rate_type" };

/**
 * Rate Type is never inferred from the Session (Slice 5 boundary). Sources,
 * in order: an explicit Management-supplied type; else the requesting
 * coach's own Coach Allocation(s) for this exact occurrence (same work,
 * same Rate Type Snapshot) - only when they agree on one type.
 */
export function determineRateType(explicit: string | null | undefined, requesterAllocationsForOccurrence: AirtableRecord[]): RateTypeDetermination {
  if (explicit != null && explicit !== "") {
    return (KNOWN_RATE_TYPES as readonly string[]).includes(explicit) ? { rateType: explicit, source: "management" } : { rateType: null, reason: "invalid_rate_type" };
  }
  const types = [...new Set(requesterAllocationsForOccurrence.map((a) => selectName(a.fields["Rate Type Snapshot"])).filter(Boolean))];
  if (types.length === 1) return { rateType: types[0], source: "requester_allocation" };
  return { rateType: null, reason: types.length ? "ambiguous_rate_type" : "no_rate_type" };
}

export type RatePreview =
  | { status: "resolved"; rateType: string; rateTypeSource: string; rateProfileId: string; payUnit: string; normalRate: number; paidUnits: number; expectedCost: number }
  | { status: "requires_management_review"; reason: string; detail: string };

export function previewRate(candidateCoachId: string, dateIso: string, rt: RateTypeDetermination, rateProfiles: CoachRateProfileRecord[], durationHours: number | null): RatePreview {
  if (rt.rateType == null) {
    const detail = {
      no_rate_type: "No Rate Type: none supplied by Management and the requester has no Coach Allocation for this occurrence",
      ambiguous_rate_type: "The requester's Coach Allocations for this occurrence disagree on Rate Type",
      invalid_rate_type: `Unknown Rate Type (valid: ${KNOWN_RATE_TYPES.join(", ")})`,
    }[rt.reason];
    return { status: "requires_management_review", reason: rt.reason, detail };
  }
  const res = resolveCoachRateProfile(candidateCoachId, dateIso, rt.rateType, rateProfiles);
  if (res.status === "missing") return { status: "requires_management_review", reason: "no_rate_profile", detail: `Candidate has no Active ${rt.rateType} Rate Profile applying on ${dateIso}` };
  if (res.status === "ambiguous") return { status: "requires_management_review", reason: "ambiguous_rate_profile", detail: `Candidate has ${res.candidates.length} overlapping ${rt.rateType} Rate Profiles on ${dateIso}` };
  const amount = res.profile.fields["Amount"];
  const payUnit = selectName(res.profile.fields["Pay Unit"]);
  if (typeof amount !== "number" || !isFinite(amount) || amount < 0) return { status: "requires_management_review", reason: "invalid_rate_amount", detail: "Rate Profile Amount is missing or invalid" };
  let paidUnits: number;
  if (payUnit === "Per Hour") {
    if (durationHours == null || !(durationHours > 0)) return { status: "requires_management_review", reason: "duration_unknown", detail: "Per Hour rate but the occurrence has no usable duration" };
    paidUnits = roundCurrency(durationHours);
  } else if (payUnit === "Per Session" || payUnit === "Per Day") {
    paidUnits = 1;
  } else {
    return { status: "requires_management_review", reason: "unknown_pay_unit", detail: `Unrecognised Pay Unit "${payUnit}"` };
  }
  return {
    status: "resolved",
    rateType: rt.rateType,
    rateTypeSource: rt.source,
    rateProfileId: res.profile.id,
    payUnit,
    normalRate: roundCurrency(amount),
    paidUnits,
    expectedCost: roundCurrency(amount * paidUnits),
  };
}

// ---------------------------------------------------------------------
// Responses (Accept / Decline)
// ---------------------------------------------------------------------

export type ResponsePlan =
  | { action: "create"; fields: Record<string, unknown> }
  | { action: "update"; responseId: string; patch: Record<string, unknown> }
  | { action: "reject"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string };

export function suitabilitySnapshotText(s: SuitabilityResult, rate: RatePreview, now: Date): string {
  return JSON.stringify({ evaluatedAt: now.toISOString(), suitability: s, rate });
}

/**
 * A coach's own response to one Open date. One active response per coach
 * per date: a repeat call updates it (Accept <-> Decline) rather than
 * adding a duplicate. An Accept is a statement of willingness - never an
 * assignment. The suitability and rate snapshot are recorded at response
 * time for Management; final selection always re-evaluates.
 */
export function planResponse(
  actor: Actor,
  requestDate: AirtableRecord,
  existingOwnResponse: AirtableRecord | null,
  answer: string,
  note: string | null,
  suitability: SuitabilityResult,
  rate: RatePreview,
  now: Date
): ResponsePlan {
  if (actor.kind !== "coach") return { action: "reject", httpStatus: 403, code: "coach_only", error: "Only a coach can respond to a cover request, for themselves" };
  if (answer !== "Accept" && answer !== "Decline") return { action: "reject", httpStatus: 400, code: "invalid_response", error: 'response must be "Accept" or "Decline"' };
  if (note != null && (typeof note !== "string" || note.length > 2000)) return { action: "reject", httpStatus: 400, code: "invalid_note", error: "note must be a string of at most 2000 characters" };
  const status = selectName(requestDate.fields["Cover Date Status"]);
  if (status !== "Open") return { action: "reject", httpStatus: 409, code: "date_not_open", error: `This cover date is ${status}, not Open` };
  if (firstLink(requestDate.fields, "Coach") === actor.coachId) return { action: "reject", httpStatus: 409, code: "is_requester", error: "You cannot respond to your own cover request" };

  const common: Record<string, unknown> = {
    "Response Status": RESPONSE_STATUS[answer],
    "Responded At": now.toISOString(),
    "Response Note": note,
    "Eligibility / Suitability Summary": suitabilitySnapshotText(suitability, rate, now),
    "Normal Rate Snapshot": rate.status === "resolved" ? rate.normalRate : null,
    "Expected Cost Snapshot": rate.status === "resolved" ? rate.expectedCost : null,
  };
  if (existingOwnResponse) return { action: "update", responseId: existingOwnResponse.id, patch: common };
  return {
    action: "create",
    fields: {
      "Cover Response ID": `COVERRESP-${requestDate.id}-${actor.coachId}`,
      "Cover Request Date": [requestDate.id],
      "Coach": [actor.coachId],
      "Active": true,
      ...common,
    },
  };
}

// ---------------------------------------------------------------------
// Management final selection
// ---------------------------------------------------------------------

export type SelectionPlan =
  | { action: "already_filled"; replacementCoachId: string }
  | {
      action: "fill";
      occurrenceStaffFields: Record<string, unknown>;
      requesterOccurrenceStaffPatches: Array<{ id: string; fields: Record<string, unknown> }>;
      requestDatePatch: Record<string, unknown>;
    }
  | { action: "reject"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string; findings?: SuitabilityFinding[] };

/** Deterministic Occurrence Staff ID per cover date - lets a retried selection find and reuse its own row rather than creating a second one. */
export function coverOccurrenceStaffId(requestDateId: string): string {
  return `COVER-${requestDateId}`;
}

/**
 * Validates and plans the one write that makes cover real. Must be called
 * INSIDE the per-date lock with freshly loaded rows. The resulting roster
 * is simulated with the unchanged Slice 3 resolver before anything is
 * written: the plan is only returned if, after it, the chosen coach IS on
 * the occurrence and the requester is NOT.
 */
export function planSelection(args: {
  actor: Actor;
  requestDate: AirtableRecord;
  response: AirtableRecord | null;
  occurrence: OccurrenceRef;
  staffing: StaffingContext;
  requesterAssignment: RequesterAssignment | null;
  suitability: SuitabilityResult;
  confirmWarnings: boolean;
  now: Date;
}): SelectionPlan {
  const { actor, requestDate, response, occurrence, staffing, requesterAssignment, suitability, now } = args;
  if (actor.kind !== "management") return { action: "reject", httpStatus: 403, code: "management_only", error: "Only Management can choose the final covering coach" };
  if (!response) return { action: "reject", httpStatus: 404, code: "response_not_found", error: "Cover Response not found" };
  const candidateId = firstLink(response.fields, "Coach");
  const status = selectName(requestDate.fields["Cover Date Status"]);

  if (status === "Filled") {
    const current = firstLink(requestDate.fields, "Replacement Coach");
    if (current && current === candidateId) return { action: "already_filled", replacementCoachId: current };
    return { action: "reject", httpStatus: 409, code: "already_filled_by_other", error: `This cover date is already Filled by ${current || "another coach"}` };
  }
  if (status !== "Open") return { action: "reject", httpStatus: 409, code: "date_not_open", error: `This cover date is ${status}, not Open` };

  if (!linkIds(response.fields["Cover Request Date"]).includes(requestDate.id)) return { action: "reject", httpStatus: 400, code: "response_not_for_date", error: "That response belongs to a different cover date" };
  if (response.fields["Active"] !== true) return { action: "reject", httpStatus: 409, code: "response_inactive", error: "That response is no longer active" };
  if (selectName(response.fields["Response Status"]) !== "Yes") return { action: "reject", httpStatus: 409, code: "response_not_accepted", error: "Only a coach who Accepted can be selected" };

  if (suitability.status === "unsuitable") return { action: "reject", httpStatus: 409, code: "candidate_unsuitable", error: "Candidate is not suitable", findings: suitability.blockers };
  if (suitability.status === "needs_management_review" && !args.confirmWarnings) {
    return { action: "reject", httpStatus: 409, code: "warnings_require_confirmation", error: "Candidate has unresolved warnings - resend with confirmWarnings: true to select deliberately", findings: suitability.warnings };
  }
  if (!requesterAssignment) return { action: "reject", httpStatus: 409, code: "requester_no_longer_assigned", error: "The requesting coach is no longer staffing this occurrence - review before assigning cover" };

  const requesterId = firstLink(requestDate.fields, "Coach");
  const roleName = requesterAssignment.roleCaps?.roleName || null;
  const osFields: Record<string, unknown> = {
    "Occurrence Staff ID": coverOccurrenceStaffId(requestDate.id),
    "Session Occurrence": [occurrence.id],
    "Coach": [candidateId],
    "Assignment Type": "Cover",
    "Planned Role Snapshot": roleName,
    "Attendance": "Planned",
    "Management Confirmed": true,
    "Confirmed At": now.toISOString(),
    "Confirmed By User ID": actor.userId,
    "Confirmed By Name Snapshot": actor.displayName,
    "Notes": `Cover for ${requesterId} via cover request date ${requestDate.id} (response ${response.id}).`,
  };
  if (requesterAssignment.sessionStaffSourceId) osFields["Session Staff Source"] = [requesterAssignment.sessionStaffSourceId];
  const requesterPatches = requesterAssignment.requesterOccurrenceStaffIds.map((id) => ({ id, fields: { "Attendance": "Absent" } as Record<string, unknown> }));

  // Simulate the post-write roster with the unchanged Slice 3 resolver.
  const absent = new Set(requesterAssignment.requesterOccurrenceStaffIds);
  const simulatedRows = [
    ...occurrenceStaffForOccurrence(staffing, occurrence.id).map((r) => (absent.has(r.id) ? { ...r, fields: { ...r.fields, "Attendance": "Absent" } } : r)),
    { id: "recSIMULATEDCOVER", fields: osFields },
  ];
  const after = resolveOccurrenceStaffing(
    occurrence.dateIso,
    staffing.sessionStaffRows.filter((r) => firstLink(r.fields, "Session") === occurrence.sessionId),
    simulatedRows,
    staffing.roleCapsById,
    staffing.roleCapsByNameMap,
    staffing.sessionStaffById
  );
  const ids = after.map((r) => r.coachId);
  if (!ids.includes(candidateId) || ids.includes(requesterId)) {
    return { action: "reject", httpStatus: 409, code: "replacement_not_representable", error: "Cover could not be represented as a clean replacement of the requester on this occurrence" };
  }

  return {
    action: "fill",
    occurrenceStaffFields: osFields,
    requesterOccurrenceStaffPatches: requesterPatches,
    requestDatePatch: {
      "Cover Date Status": "Filled",
      "Replacement Coach": [candidateId],
      "Decision At": now.toISOString(),
      "Decision By User ID": actor.userId,
      "Decision By Name Snapshot": actor.displayName,
    },
  };
}

// ---------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------

export type CancelPlan =
  | { action: "cancel"; patch: Record<string, unknown> }
  | { action: "already_cancelled" }
  | { action: "reject"; httpStatus: 403 | 409; code: string; error: string };

/**
 * The requesting coach (own dates only) or Management may cancel an Open
 * date. A Filled date is NEVER cancelled here - its Occurrence Staff
 * assignment stands until a deliberate Management un-assignment (not built
 * in this slice). Nothing is deleted; the cancelled state is recorded with
 * who and when.
 */
export function planCancel(actor: Actor, requestDate: AirtableRecord, note: string | null, now: Date): CancelPlan {
  if (actor.kind === "coach" && firstLink(requestDate.fields, "Coach") !== actor.coachId) {
    return { action: "reject", httpStatus: 403, code: "not_own_request", error: "A coach can only cancel their own cover request" };
  }
  const status = selectName(requestDate.fields["Cover Date Status"]);
  if (status === "Cancelled") return { action: "already_cancelled" };
  if (status === "Filled") return { action: "reject", httpStatus: 409, code: "filled_requires_deliberate_unassignment", error: "This date is already Filled - cancelling would leave the Occurrence Staff assignment inconsistent; it needs a deliberate Management un-assignment" };
  if (status !== "Open") return { action: "reject", httpStatus: 409, code: "date_not_open", error: `This cover date is ${status}` };
  const patch: Record<string, unknown> = {
    "Cover Date Status": "Cancelled",
    "Decision At": now.toISOString(),
    "Decision By User ID": actor.userId,
    "Decision By Name Snapshot": actor.displayName,
  };
  if (note) {
    const field = actor.kind === "coach" ? "Coach Note" : "Management Note";
    const prior = requestDate.fields[field];
    patch[field] = `${prior ? prior + "\n" : ""}[Cancelled ${now.toISOString()}] ${note}`;
  }
  return { action: "cancel", patch };
}

// ---------------------------------------------------------------------
// Future notification events (documented contract only - nothing is sent)
// ---------------------------------------------------------------------

export const FUTURE_NOTIFICATION_EVENTS = [
  "cover_requested",
  "cover_response_received",
  "cover_confirmed",
  "cover_cancelled",
  "cover_unfilled_escalation",
] as const;
