/**
 * Session Occurrence delivery confirmation - orchestration (Schedule
 * prerequisite before Finance F5; see TEST-ENV.md).
 *
 * Order (first failure wins; nothing is written before step 6):
 *   1. authenticated active Management caller           -> else 401 / 403
 *   2. the caller's own organisation (profile
 *      organisation_id -> one Active Organisation &
 *      Branding row), for its timezone                   -> else 409
 *   3. find the occurrence by Occurrence ID              -> 404 / 409 ambiguous
 *   4. the Schedule generation lock for the occurrence's
 *      Session (the same per-Session lock generation and
 *      propagation hold, so a confirmation never
 *      interleaves with them or with another confirmation) -> 409 busy
 *   5. RE-READ the occurrence under the lock and decide  -> 409 refused / 200 no-op
 *   6. one PATCH: the confirmation facts + Confirmed By / At stamps
 *   7. release the lock (always)
 * A read or write failure is 503 - never "assume confirmed".
 */
import {
  type ConfirmRequest,
  CONFIRMATION_CONTRACT,
  applyFields,
  decide,
  isManagementCaller,
  occurrenceState,
  publicConfirmation,
  resolveOrganisation,
  todayIn,
} from "./occurrence-confirmation.ts";
import { type AirtableConfig, findOccurrenceRows, loadOrganisations, patchOccurrence } from "./confirmation-repository.ts";
import type { LockClient } from "./lock-client.ts";

export interface ConfirmationCaller {
  userId: string;
  role: string | null;
  active: boolean;
  organisationId: string | null;
  displayName: string | null;
}

export interface ConfirmationDeps {
  airtable: AirtableConfig;
  lock: LockClient;
  clock?: () => Date;
  lockAttempts?: number;
  lockRetryDelayMs?: number;
}

export type ConfirmResult =
  | { status: "ok"; httpStatus: 200; body: Record<string, unknown> }
  | { status: "error"; httpStatus: 403 | 404 | 409 | 503; code: string; error: string };

const fail = (httpStatus: 403 | 404 | 409 | 503, code: string, error: string): ConfirmResult => ({ status: "error", httpStatus, code, error });
const unavailable = () => fail(503, "schedule_unavailable", "The occurrence could not be confirmed just now - nothing was changed, try again");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findOne(deps: ConfirmationDeps, occurrenceId: string) {
  const rows = await findOccurrenceRows(deps.airtable, occurrenceId);
  if (rows.length === 0) return { found: "none" as const };
  if (rows.length > 1) return { found: "many" as const };
  return { found: "one" as const, row: rows[0] };
}

export async function confirmOccurrence(deps: ConfirmationDeps, caller: ConfirmationCaller, req: ConfirmRequest): Promise<ConfirmResult> {
  if (!isManagementCaller(caller)) return fail(403, "management_required", "Management access required");

  let org;
  let first;
  try {
    const [orgs, found] = await Promise.all([loadOrganisations(deps.airtable), findOne(deps, req.occurrenceId)]);
    org = resolveOrganisation(caller.organisationId, orgs);
    first = found;
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!org.ok) return fail(409, org.code, org.error);
  if (first.found === "none") return fail(404, "occurrence_not_found", "No such session occurrence");
  if (first.found === "many") return fail(409, "occurrence_ambiguous", "More than one session occurrence has this Occurrence ID - Schedule data must be corrected first");
  const sessionRecordId = occurrenceState(first.row).sessionRecordId;
  if (!sessionRecordId) return fail(409, "occurrence_invalid", "The occurrence is not linked to exactly one Session - Schedule data must be corrected first");

  let token: string | null = null;
  try {
    const attempts = deps.lockAttempts ?? 25;
    for (let i = 0; i < attempts && !token; i++) {
      token = await deps.lock.acquire(sessionRecordId);
      if (!token && i < attempts - 1) await sleep(deps.lockRetryDelayMs ?? 40);
    }
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!token) return fail(409, "schedule_busy", "This session's schedule is being changed right now - try again in a moment");

  try {
    const now = (deps.clock ?? (() => new Date()))();
    const today = todayIn(org.organisation.timezone, now);
    let current;
    try {
      current = await findOne(deps, req.occurrenceId);
    } catch (e) {
      console.error(e);
      return unavailable();
    }
    if (current.found !== "one" || current.row.id !== first.row.id) return fail(409, "occurrence_changed", "The occurrence changed while it was being confirmed - reload and try again");
    const before = occurrenceState(current.row);
    const decision = decide(before, req, { now, today, actor: { userId: caller.userId, name: caller.displayName } });
    const base = { contract: CONFIRMATION_CONTRACT, organisation: { organisationId: org.organisation.organisationId } };
    if (decision.kind === "refuse") return fail(decision.httpStatus, decision.code, decision.error);
    if (decision.kind === "noop") return { status: "ok", httpStatus: 200, body: { ...base, changed: false, occurrence: publicConfirmation(before) } };
    try {
      await patchOccurrence(deps.airtable, current.row.id, decision.fields);
    } catch (e) {
      console.error(e);
      return unavailable();
    }
    return {
      status: "ok",
      httpStatus: 200,
      body: { ...base, changed: true, before: publicConfirmation(before), occurrence: publicConfirmation(applyFields(before, decision.fields)) },
    };
  } finally {
    try {
      await deps.lock.release(sessionRecordId, token);
    } catch (e) {
      console.error("Schedule generation lock release failed (expires on its own)", e);
    }
  }
}
