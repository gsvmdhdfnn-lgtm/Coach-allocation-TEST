/**
 * Test-suite copy of the canonical coach-cover/orchestrator.ts, kept in sync by
 * hand exactly like every other deployed copy. Only import paths adjusted:
 * ./staffing|cover-workflow|repository|lock-client.ts become coach-cover-*.ts.
 */
/**
 * Composition layer for Coaches Slice 9 cover workflow (see TEST-ENV.md).
 * Loads rows, builds the staffing/availability/compliance/rate inputs,
 * calls the pure decisions in cover-workflow.ts, and executes the returned
 * plans. No workflow rule is decided here. Every write that changes a
 * cover DATE (respond, cancel, final selection) runs inside that date's
 * `cover_date_locks` lock and re-reads everything after acquiring it, so
 * two Management selections can never both succeed.
 */
import { resolveAvailability, ukWallClockFromInstant, type AvailabilityResult } from "./coach-availability.ts";
import { summarizeCompliance, ukToday } from "./coach-compliance.ts";
import {
  checkRequestDate,
  buildGroupFields,
  buildRequestDateFields,
  coverOccurrenceStaffId,
  deriveGroupStatus,
  determineRateType,
  evaluateSuitability,
  planCancel,
  planResponse,
  planSelection,
  previewRate,
  unfilledSignal,
  type Actor,
  type AirtableRecord,
  type CreateRequestInput,
  type RatePreview,
  type SuitabilityResult,
} from "./coach-cover-workflow.ts";
import { type LockClient } from "./coach-cover-lock-client.ts";
import { type AirtableConfig, type World, TABLES, createRecord, listRecords, loadWorld, patchRecord } from "./coach-cover-repository.ts";
import {
  buildStaffingContext,
  coachRoleCapabilityOnDate,
  firstLink,
  overlappingAssignments,
  resolveRequesterAssignment,
  roleRank,
  rosterForOccurrence,
  selectName,
  type OccurrenceRef,
  type RequesterAssignment,
  type StaffingContext,
  type TimedOccurrence,
} from "./coach-cover-staffing.ts";

export interface Deps {
  airtable: AirtableConfig;
  lock: LockClient;
}

export interface LockRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

// One cover operation re-reads the whole world (several waves of Airtable
// reads, ~2-4s), so a waiter needs a budget of several operations, not
// Slice 6's ~1s.
const DEFAULT_LOCK_MAX_ATTEMPTS = 150;
const DEFAULT_LOCK_RETRY_DELAY_MS = 100;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same bounded acquire/retry/always-release shape as occurrence-financial-outcomes' withOccurrenceLock. */
async function withLock<T>(lock: LockClient, key: string, fn: () => Promise<T>, opts: LockRetryOptions = {}): Promise<T | { status: "lock_unavailable" }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_LOCK_MAX_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  let token: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    token = await lock.acquire(key);
    if (token) break;
    if (attempt < maxAttempts - 1) await sleep(retryDelayMs);
  }
  if (!token) return { status: "lock_unavailable" };
  try {
    return await fn();
  } finally {
    await lock.release(key, token);
  }
}

function linkIds(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x?.id)).filter((x): x is string => typeof x === "string");
}

// ---------------------------------------------------------------------
// Views over one consistent world read
// ---------------------------------------------------------------------

interface Views {
  world: World;
  ctx: StaffingContext;
  occById: Map<string, AirtableRecord>;
  coachById: Map<string, AirtableRecord>;
  sessionById: Map<string, AirtableRecord>;
  timed: TimedOccurrence[];
}

function occurrenceRef(occ: AirtableRecord | undefined): OccurrenceRef | null {
  if (!occ) return null;
  const sessionId = firstLink(occ.fields, "Session");
  const dateIso = occ.fields["Date"];
  if (!sessionId || typeof dateIso !== "string" || !ISO_DATE_RE.test(dateIso)) return null;
  return { id: occ.id, sessionId, dateIso };
}

function timedOccurrence(occ: AirtableRecord): TimedOccurrence | null {
  const ref = occurrenceRef(occ);
  if (!ref) return null;
  let startMs: number | null = Date.parse(occ.fields["Start Date & Time"] ?? "");
  let endMs: number | null = Date.parse(occ.fields["End Date & Time"] ?? "");
  if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) startMs = endMs = null;
  return { ...ref, startMs, endMs, status: selectName(occ.fields["Status"]) };
}

/**
 * `excludeOccurrenceStaffIds` hides this date's own deterministic cover
 * row (Occurrence Staff ID = COVER-{dateId}) so candidates are always
 * evaluated against the roster the cover is REPLACING - which also lets a
 * retried selection recover a row a failed earlier attempt left behind.
 */
function buildViews(world: World, excludeOccurrenceStaffIds: Set<string> = new Set()): Views {
  const osRows = world.occurrenceStaff.filter((r) => !excludeOccurrenceStaffIds.has(String(r.fields["Occurrence Staff ID"] ?? "")));
  const ctx = buildStaffingContext(world.sessionStaff, osRows, world.coachRoles);
  const byId = (rows: AirtableRecord[]) => new Map(rows.map((r) => [r.id, r]));
  return {
    world,
    ctx,
    occById: byId(world.occurrences),
    coachById: byId(world.coaches),
    sessionById: byId(world.sessions),
    timed: world.occurrences.map(timedOccurrence).filter((t): t is TimedOccurrence => !!t),
  };
}

function coachName(v: Views, id: string | null): string | null {
  if (!id) return null;
  return v.coachById.get(id)?.fields["Coach Name"] || id;
}

function responsesForDate(world: World, dateId: string): AirtableRecord[] {
  return world.responses.filter((r) => linkIds(r.fields["Cover Request Date"]).includes(dateId) && r.fields["Active"] === true);
}

function availabilityFor(v: Views, occ: AirtableRecord, coachId: string): AvailabilityResult | null {
  const s = ukWallClockFromInstant(occ.fields["Start Date & Time"]);
  const e = ukWallClockFromInstant(occ.fields["End Date & Time"]);
  if (!s || !e || s.date !== e.date || e.time <= s.time) return null;
  return resolveAvailability({ coachId, date: s.date, startTime: s.time, endTime: e.time }, v.world.availability, v.world.availabilityExceptions);
}

export interface CandidateEvaluation {
  occurrence: OccurrenceRef;
  requesterAssignment: RequesterAssignment | null;
  suitability: SuitabilityResult;
  rate: RatePreview;
}

/** Everything the rules need for one candidate on one cover date, all from the same world read. */
function evaluateCandidate(v: Views, requestDate: AirtableRecord, candidateId: string, explicitRateType: string | null): CandidateEvaluation | null {
  const occId = firstLink(requestDate.fields, "Session Occurrence");
  const occ = v.occById.get(occId);
  const ref = occurrenceRef(occ);
  if (!occ || !ref) return null;
  const timed = timedOccurrence(occ)!;
  const requesterId = firstLink(requestDate.fields, "Coach");
  const roster = rosterForOccurrence(v.ctx, ref);
  const requesterAssignment = resolveRequesterAssignment(v.ctx, ref, requesterId);
  const requiredRank = roleRank(requesterAssignment?.roleCaps ?? null);
  const session = v.sessionById.get(ref.sessionId);
  const candidate = v.coachById.get(candidateId);

  const suitability = evaluateSuitability({
    candidateCoachId: candidateId,
    candidateActive: candidate?.fields["Active"] === true,
    requesterCoachId: requesterId,
    targetRosterCoachIds: roster.map((r) => r.coachId),
    availability: availabilityFor(v, occ, candidateId),
    compliance: summarizeCompliance(candidateId, v.world.documents, v.world.requirements, ref.dateIso),
    requiredRole: requiredRank != null ? { rank: requiredRank, roleName: requesterAssignment!.roleCaps!.roleName } : null,
    candidateRole: coachRoleCapabilityOnDate(v.ctx, candidateId, ref.dateIso),
    overlap: overlappingAssignments(v.ctx, candidateId, timed, v.timed),
    requiresLeadCoach: session?.fields["Requires Lead Coach"] === true,
    otherLeadCoachesRemaining: roster.filter((r) => r.coachId !== requesterId && r.roleCaps?.active && r.roleCaps.roleKey === "lead_coach").length,
  });

  const requesterAllocations = v.world.allocations.filter(
    (a) => linkIds(a.fields["Coach"]).includes(requesterId) && linkIds(a.fields["Session Occurrence"]).includes(occId)
  );
  const rt = determineRateType(explicitRateType, requesterAllocations);
  const durationHours = timed.startMs != null && timed.endMs != null ? (timed.endMs - timed.startMs) / 3_600_000 : null;
  const rate = previewRate(
    candidateId,
    ref.dateIso,
    rt,
    v.world.rateProfiles.filter((p) => firstLink(p.fields, "Coach") === candidateId),
    durationHours
  );
  return { occurrence: ref, requesterAssignment, suitability, rate };
}

/** What anyone allowed to see a date may see. Management-only fields are added separately. */
function dateView(v: Views, rd: AirtableRecord, now: Date) {
  const occId = firstLink(rd.fields, "Session Occurrence");
  const occ = v.occById.get(occId);
  const groupId = firstLink(rd.fields, "Cover Request Group");
  const group = v.world.groups.find((g) => g.id === groupId);
  const requesterId = firstLink(rd.fields, "Coach");
  const replacementId = firstLink(rd.fields, "Replacement Coach") || null;
  const status = selectName(rd.fields["Cover Date Status"]);
  return {
    requestDateId: rd.id,
    requestId: rd.fields["Request ID"] ?? null,
    status,
    groupId: groupId || null,
    reason: group ? selectName(group.fields["Reason"]) : null,
    handoverNote: group?.fields["Handover Note"] ?? null,
    coachNote: rd.fields["Coach Note"] ?? null,
    requestedVia: selectName(rd.fields["Requested Via"]) || null,
    requesterCoachId: requesterId,
    requesterName: coachName(v, requesterId),
    occurrence: occ
      ? {
          id: occ.id,
          name: occ.fields["Occurrence Name"] ?? null,
          date: occ.fields["Date"] ?? null,
          start: occ.fields["Start Date & Time"] ?? null,
          end: occ.fields["End Date & Time"] ?? null,
          status: selectName(occ.fields["Status"]),
        }
      : { id: occId, name: null, date: null, start: null, end: null, status: "not_found" },
    replacementCoachId: replacementId,
    replacementName: coachName(v, replacementId),
    decisionAt: rd.fields["Decision At"] ?? null,
    createdTime: rd.createdTime ?? null,
    ...unfilledSignal(status, rd.createdTime, now),
  };
}

function suitabilityBrief(s: SuitabilityResult) {
  return { status: s.status, blockers: s.blockers, warnings: s.warnings, info: s.info };
}

/**
 * Keeps the stored Group Status in step with its dates. The stored value
 * is a convenience only - every read derives it again - so it is
 * recomputed from a FRESH read of the group's dates just before writing.
 */
async function refreshGroupStatus(cfg: AirtableConfig, world: World, groupId: string): Promise<string | null> {
  const group = world.groups.find((g) => g.id === groupId);
  if (!group) return null;
  const dates = (await listRecords(cfg, TABLES.requestDates)).filter((r) => linkIds(r.fields["Cover Request Group"]).includes(groupId));
  const derived = deriveGroupStatus(dates.map((d) => selectName(d.fields["Cover Date Status"])));
  if (selectName(group.fields["Status"]) !== derived) await patchRecord(cfg, TABLES.groups, groupId, { "Status": derived });
  return derived;
}

// ---------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------

export type CreateResult =
  | { status: "lock_unavailable" }
  | { status: "rejected"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string; dates?: Array<{ occurrenceId: string; ok: boolean; error?: string }> }
  | { status: "created"; groupId: string; groupStatus: string; dates: ReturnType<typeof dateView>[] };

/**
 * All-or-nothing validation: every requested date must pass
 * checkRequestDate() before anything is written. Serialised per requesting
 * coach so a double-submitted form cannot create two Open requests for
 * the same date.
 */
export async function createCoverRequest(deps: Deps, actor: Actor, input: CreateRequestInput, now: Date = new Date(), lockOpts?: LockRetryOptions): Promise<CreateResult> {
  const coachId = input.coachId!;
  return withLock(
    deps.lock,
    `create:${coachId}`,
    async (): Promise<CreateResult> => {
      const world = await loadWorld(deps.airtable, ["coaches", "occurrences", "sessionStaff", "occurrenceStaff", "coachRoles", "requestDates", "groups"]);
      const v = buildViews(world);
      if (!v.coachById.has(coachId)) return { status: "rejected", httpStatus: 404, code: "coach_not_found", error: `No Coach found for id ${coachId}` };
      const today = ukToday(now);
      const checks = input.occurrenceIds.map((occId) => {
        const occ = v.occById.get(occId) ?? null;
        const ref = occurrenceRef(occ ?? undefined);
        const assignment = ref ? resolveRequesterAssignment(v.ctx, ref, coachId) : null;
        const openExists = world.requestDates.some(
          (r) => firstLink(r.fields, "Coach") === coachId && firstLink(r.fields, "Session Occurrence") === occId && selectName(r.fields["Cover Date Status"]) === "Open"
        );
        const c = checkRequestDate(occ, ref, assignment, openExists, today);
        return { occurrenceId: occId, ok: c.ok, ...(c.error ? { error: c.error } : {}) };
      });
      if (checks.some((c) => !c.ok)) {
        return { status: "rejected", httpStatus: 409, code: "invalid_dates", error: "One or more requested dates are not valid - nothing was created", dates: checks };
      }
      const group = await createRecord(deps.airtable, TABLES.groups, buildGroupFields(actor, input, now));
      const created: AirtableRecord[] = [];
      for (const occId of input.occurrenceIds) {
        created.push(await createRecord(deps.airtable, TABLES.requestDates, buildRequestDateFields(actor, input, group.id, occId, now)));
      }
      const after = buildViews({ ...world, groups: [...world.groups, group] });
      return { status: "created", groupId: group.id, groupStatus: "Open", dates: created.map((d) => dateView(after, d, now)) };
    },
    lockOpts
  );
}

// ---------------------------------------------------------------------
// Coach view
// ---------------------------------------------------------------------

export async function listForCoach(deps: Deps, actor: Extract<Actor, { kind: "coach" }>, now: Date = new Date()) {
  const world = await loadWorld(deps.airtable);
  const today = ukToday(now);
  const mine = world.requestDates.filter((r) => firstLink(r.fields, "Coach") === actor.coachId);
  const openOthers = world.requestDates.filter((r) => firstLink(r.fields, "Coach") !== actor.coachId && selectName(r.fields["Cover Date Status"]) === "Open");

  const requestedByMe = mine.map((rd) => {
    const v = buildViews(world, new Set([coverOccurrenceStaffId(rd.id)]));
    const responses = responsesForDate(world, rd.id);
    return {
      ...dateView(v, rd, now),
      acceptedCount: responses.filter((r) => selectName(r.fields["Response Status"]) === "Yes").length,
      declinedCount: responses.filter((r) => selectName(r.fields["Response Status"]) === "No").length,
    };
  });

  const availableToRespond = [];
  for (const rd of openOthers) {
    const v = buildViews(world, new Set([coverOccurrenceStaffId(rd.id)]));
    const view = dateView(v, rd, now);
    if (view.occurrence.status !== "Scheduled" || !view.occurrence.date || view.occurrence.date < today) continue;
    const ev = evaluateCandidate(v, rd, actor.coachId, null);
    if (!ev) continue;
    if (ev.suitability.blockers.some((b) => b.code === "already_staffing_this_occurrence")) continue;
    const own = responsesForDate(world, rd.id).find((r) => firstLink(r.fields, "Coach") === actor.coachId) ?? null;
    availableToRespond.push({
      ...view,
      myResponse: own ? { responseId: own.id, status: selectName(own.fields["Response Status"]), respondedAt: own.fields["Responded At"] ?? null, note: own.fields["Response Note"] ?? null } : null,
      mySuitability: suitabilityBrief(ev.suitability),
    });
  }
  // Coaches never see other coaches' responses, rates, or Management notes.
  return { coachId: actor.coachId, requestedByMe, availableToRespond };
}

// ---------------------------------------------------------------------
// Respond (Accept / Decline)
// ---------------------------------------------------------------------

export type RespondResult =
  | { status: "lock_unavailable" }
  | { status: "rejected"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string }
  | { status: "created" | "updated"; responseId: string; responseStatus: string; suitability: ReturnType<typeof suitabilityBrief> };

export async function respondToCover(
  deps: Deps,
  actor: Actor,
  args: { requestDateId: string; response: string; note: string | null },
  now: Date = new Date(),
  lockOpts?: LockRetryOptions
): Promise<RespondResult> {
  if (actor.kind !== "coach") return { status: "rejected", httpStatus: 403, code: "coach_only", error: "Only a coach can respond to a cover request, for themselves" };
  return withLock(
    deps.lock,
    args.requestDateId,
    async (): Promise<RespondResult> => {
      const world = await loadWorld(deps.airtable);
      const rd = world.requestDates.find((r) => r.id === args.requestDateId);
      if (!rd) return { status: "rejected", httpStatus: 404, code: "request_not_found", error: `No cover request date found for id ${args.requestDateId}` };
      const v = buildViews(world, new Set([coverOccurrenceStaffId(rd.id)]));
      const ev = evaluateCandidate(v, rd, actor.coachId, null);
      if (!ev) return { status: "rejected", httpStatus: 409, code: "occurrence_unresolvable", error: "The cover date's occurrence could not be resolved" };
      if (ev.occurrence.dateIso < ukToday(now)) return { status: "rejected", httpStatus: 409, code: "date_past", error: "This cover date is in the past" };
      const own = responsesForDate(world, rd.id).find((r) => firstLink(r.fields, "Coach") === actor.coachId) ?? null;
      const plan = planResponse(actor, rd, own, args.response, args.note, ev.suitability, ev.rate, now);
      if (plan.action === "reject") return { status: "rejected", httpStatus: plan.httpStatus, code: plan.code, error: plan.error };
      const rec =
        plan.action === "create"
          ? await createRecord(deps.airtable, TABLES.responses, plan.fields)
          : await patchRecord(deps.airtable, TABLES.responses, plan.responseId, plan.patch);
      return {
        status: plan.action === "create" ? "created" : "updated",
        responseId: rec.id,
        responseStatus: selectName(rec.fields["Response Status"]),
        suitability: suitabilityBrief(ev.suitability),
      };
    },
    lockOpts
  );
}

// ---------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------

export type CancelResult =
  | { status: "lock_unavailable" }
  | { status: "rejected"; httpStatus: 403 | 404 | 409; code: string; error: string }
  | { status: "cancelled" | "already_cancelled"; requestDateId: string; groupStatus: string | null };

export async function cancelCoverDate(deps: Deps, actor: Actor, args: { requestDateId: string; note: string | null }, now: Date = new Date(), lockOpts?: LockRetryOptions): Promise<CancelResult> {
  return withLock(
    deps.lock,
    args.requestDateId,
    async (): Promise<CancelResult> => {
      const world = await loadWorld(deps.airtable, ["requestDates", "groups"]);
      const rd = world.requestDates.find((r) => r.id === args.requestDateId);
      if (!rd) return { status: "rejected", httpStatus: 404, code: "request_not_found", error: `No cover request date found for id ${args.requestDateId}` };
      const plan = planCancel(actor, rd, args.note, now);
      if (plan.action === "reject") return { status: "rejected", httpStatus: plan.httpStatus, code: plan.code, error: plan.error };
      const groupId = firstLink(rd.fields, "Cover Request Group");
      if (plan.action === "already_cancelled") return { status: "already_cancelled", requestDateId: rd.id, groupStatus: groupId ? await refreshGroupStatus(deps.airtable, world, groupId) : null };
      await patchRecord(deps.airtable, TABLES.requestDates, rd.id, plan.patch);
      return { status: "cancelled", requestDateId: rd.id, groupStatus: groupId ? await refreshGroupStatus(deps.airtable, world, groupId) : null };
    },
    lockOpts
  );
}

// ---------------------------------------------------------------------
// Management list / detail
// ---------------------------------------------------------------------

export async function listForManagement(deps: Deps, args: { status: string | null; asOf: Date | null }, now: Date = new Date()) {
  const world = await loadWorld(deps.airtable, ["requestDates", "groups", "responses", "coaches", "occurrences"]);
  const at = args.asOf ?? now;
  const v = buildViews(world);
  const dates = world.requestDates
    .filter((rd) => !args.status || selectName(rd.fields["Cover Date Status"]) === args.status)
    .map((rd) => {
      const responses = responsesForDate(world, rd.id);
      return {
        ...dateView(v, rd, at),
        managementNote: rd.fields["Management Note"] ?? null,
        decisionByName: rd.fields["Decision By Name Snapshot"] ?? null,
        acceptedCount: responses.filter((r) => selectName(r.fields["Response Status"]) === "Yes").length,
        declinedCount: responses.filter((r) => selectName(r.fields["Response Status"]) === "No").length,
      };
    })
    .sort((a, b) => String(a.occurrence.date).localeCompare(String(b.occurrence.date)));
  const groups = world.groups.map((g) => {
    const own = world.requestDates.filter((rd) => linkIds(rd.fields["Cover Request Group"]).includes(g.id));
    return {
      groupId: g.id,
      coverGroupId: g.fields["Cover Group ID"] ?? null,
      requesterCoachId: firstLink(g.fields, "Requesting Coach"),
      requesterName: coachName(v, firstLink(g.fields, "Requesting Coach")),
      reason: selectName(g.fields["Reason"]),
      storedStatus: selectName(g.fields["Status"]),
      derivedStatus: deriveGroupStatus(own.map((d) => selectName(d.fields["Cover Date Status"]))),
      requestDateIds: own.map((d) => d.id),
    };
  });
  return { asOf: at.toISOString(), unfilledOver24hCount: dates.filter((d) => d.unfilledOver24h).length, dates, groups };
}

export async function detailForManagement(deps: Deps, args: { requestDateId: string; rateType: string | null }, now: Date = new Date()) {
  const world = await loadWorld(deps.airtable);
  const rd = world.requestDates.find((r) => r.id === args.requestDateId);
  if (!rd) return null;
  const v = buildViews(world, new Set([coverOccurrenceStaffId(rd.id)]));
  const occRef = occurrenceRef(v.occById.get(firstLink(rd.fields, "Session Occurrence")));
  const requesterId = firstLink(rd.fields, "Coach");
  const requesterAssignment = occRef ? resolveRequesterAssignment(v.ctx, occRef, requesterId) : null;
  const responses = responsesForDate(world, rd.id).map((r) => {
    const candidateId = firstLink(r.fields, "Coach");
    const ev = evaluateCandidate(v, rd, candidateId, args.rateType);
    let snapshot: unknown = null;
    try {
      snapshot = r.fields["Eligibility / Suitability Summary"] ? JSON.parse(r.fields["Eligibility / Suitability Summary"]) : null;
    } catch {
      snapshot = r.fields["Eligibility / Suitability Summary"];
    }
    return {
      responseId: r.id,
      coachId: candidateId,
      coachName: coachName(v, candidateId),
      responseStatus: selectName(r.fields["Response Status"]),
      respondedAt: r.fields["Responded At"] ?? null,
      note: r.fields["Response Note"] ?? null,
      storedNormalRateSnapshot: r.fields["Normal Rate Snapshot"] ?? null,
      storedExpectedCostSnapshot: r.fields["Expected Cost Snapshot"] ?? null,
      snapshotAtResponse: snapshot,
      current: ev ? { suitability: suitabilityBrief(ev.suitability), rate: ev.rate } : null,
    };
  });
  return {
    ...dateView(v, rd, now),
    managementNote: rd.fields["Management Note"] ?? null,
    decisionByName: rd.fields["Decision By Name Snapshot"] ?? null,
    occurrenceStaffId: firstLink(rd.fields, "Occurrence Staff") || null,
    requesterRole: requesterAssignment?.roleCaps?.roleName ?? null,
    requesterStillAssigned: !!requesterAssignment,
    currentRoster: occRef ? rosterForOccurrence(buildViews(world).ctx, occRef).map((r) => ({ coachId: r.coachId, name: coachName(v, r.coachId), role: r.roleCaps?.roleName ?? null })) : [],
    responses,
  };
}

// ---------------------------------------------------------------------
// Management final selection
// ---------------------------------------------------------------------

export type SelectResult =
  | { status: "lock_unavailable" }
  | { status: "rejected"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string; findings?: unknown }
  | { status: "already_filled"; requestDateId: string; replacementCoachId: string }
  | {
      status: "filled";
      requestDateId: string;
      replacementCoachId: string;
      occurrenceStaffId: string;
      requesterOccurrenceStaffPatched: string[];
      groupStatus: string | null;
      suitability: ReturnType<typeof suitabilityBrief>;
      rate: RatePreview;
    };

export async function selectCover(
  deps: Deps,
  actor: Actor,
  args: { requestDateId: string; responseId: string; confirmWarnings: boolean; rateType: string | null },
  now: Date = new Date(),
  lockOpts?: LockRetryOptions
): Promise<SelectResult> {
  if (actor.kind !== "management") return { status: "rejected", httpStatus: 403, code: "management_only", error: "Only Management can choose the final covering coach" };
  return withLock(
    deps.lock,
    args.requestDateId,
    async (): Promise<SelectResult> => {
      // Fresh read AFTER the lock: whatever a concurrent selection wrote is visible here.
      const world = await loadWorld(deps.airtable);
      const rd = world.requestDates.find((r) => r.id === args.requestDateId);
      if (!rd) return { status: "rejected", httpStatus: 404, code: "request_not_found", error: `No cover request date found for id ${args.requestDateId}` };
      const response = world.responses.find((r) => r.id === args.responseId) ?? null;
      const coverOsId = coverOccurrenceStaffId(rd.id);
      const existingCoverRow = world.occurrenceStaff.find((r) => r.fields["Occurrence Staff ID"] === coverOsId) ?? null;
      const v = buildViews(world, new Set([coverOsId]));
      const candidateId = response ? firstLink(response.fields, "Coach") : "";
      const ev = response ? evaluateCandidate(v, rd, candidateId, args.rateType) : null;
      if (response && !ev) return { status: "rejected", httpStatus: 409, code: "occurrence_unresolvable", error: "The cover date's occurrence could not be resolved" };

      const plan = planSelection({
        actor,
        requestDate: rd,
        response,
        occurrence: ev?.occurrence ?? { id: "", sessionId: "", dateIso: "" },
        staffing: v.ctx,
        requesterAssignment: ev?.requesterAssignment ?? null,
        suitability: ev?.suitability ?? { status: "unsuitable", blockers: [], warnings: [], info: [] },
        confirmWarnings: args.confirmWarnings,
        now,
      });
      if (plan.action === "reject") return { status: "rejected", httpStatus: plan.httpStatus, code: plan.code, error: plan.error, findings: plan.findings };
      if (plan.action === "already_filled") return { status: "already_filled", requestDateId: rd.id, replacementCoachId: plan.replacementCoachId };

      // 1) The one Occurrence Staff (Cover) row for THIS occurrence only - reused by its deterministic ID if a failed earlier attempt left it.
      const os = existingCoverRow
        ? await patchRecord(deps.airtable, TABLES.occurrenceStaff, existingCoverRow.id, plan.occurrenceStaffFields)
        : await createRecord(deps.airtable, TABLES.occurrenceStaff, plan.occurrenceStaffFields);
      // 2) Requester's own Occurrence Staff rows on this occurrence (if any) marked Absent. Session Staff is never touched.
      for (const p of plan.requesterOccurrenceStaffPatches) await patchRecord(deps.airtable, TABLES.occurrenceStaff, p.id, p.fields);
      // 3) The date becomes Filled, last - so a date is never Filled without its assignment.
      await patchRecord(deps.airtable, TABLES.requestDates, rd.id, { ...plan.requestDatePatch, "Occurrence Staff": [os.id] });
      const groupId = firstLink(rd.fields, "Cover Request Group");
      return {
        status: "filled",
        requestDateId: rd.id,
        replacementCoachId: candidateId,
        occurrenceStaffId: os.id,
        requesterOccurrenceStaffPatched: plan.requesterOccurrenceStaffPatches.map((p) => p.id),
        groupStatus: groupId ? await refreshGroupStatus(deps.airtable, world, groupId) : null,
        suitability: suitabilityBrief(ev!.suitability),
        rate: ev!.rate,
      };
    },
    lockOpts
  );
}
