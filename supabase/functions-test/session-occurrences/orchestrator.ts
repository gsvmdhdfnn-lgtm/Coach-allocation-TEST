/**
 * The one shared per-Session orchestration path - Slice 3 (see
 * TEST-ENV.md). Nothing else in this codebase calls the lock, the
 * repository and the pure generator together; everything that ever
 * wants to generate occurrences for a Session goes through
 * generateForSession(), not a re-derived copy of this sequence.
 *
 * Slice 9 addition (Session History, see TEST-ENV.md): this function is
 * also where a Session's "Created" and "Active Status" History rows get
 * written - never generic ("something changed"), only when the caller
 * explicitly says which of those two lifecycle events this call
 * represents (`options.sessionEvent`), still inside the same lock, after
 * generation has already run to completion. `generateForSession()`
 * itself never writes the Session's own Lifecycle Status field (nor its
 * initial creation) - that responsibility stays with whoever writes the
 * Session record itself (see session-trigger.ts's own header for the
 * documented Management integration contract); this function only
 * records that it happened, using whatever the Session's OWN
 * already-written field now says, plus what generation itself actually
 * did as a result.
 *
 * Post-Slice-9 hardening (see TEST-ENV.md): `status_changed`'s retry
 * guard compares against `mostRecentRecordedStatus()` - the most
 * recently WRITTEN status in History itself - not against "has this
 * exact old/new pair ever been recorded before". The earlier version
 * wrongly suppressed a genuine later repeat of the same pair (e.g. a
 * second Active -> Inactive after an intervening Inactive -> Active);
 * see `writeSessionEventHistory()`'s own comment for the corrected rule.
 */
import { planGeneration } from "./generator.ts";
import {
  createOccurrences,
  createHistoryEntries,
  fetchExistingOccurrencesForSession,
  fetchSession,
  fetchSessionDatesForSession,
  fetchSessionHistoryForSession,
  type AirtableConfig,
  type HistoryCaller,
} from "./repository.ts";
import { selectName } from "./schedule-utils.ts";
import type { SessionRecord } from "./generator.ts";
import type { LockClient } from "./lock-client.ts";

export interface OrchestratorDeps {
  airtable: AirtableConfig;
  lock: LockClient;
}

export type GenerationOutcome =
  | { status: "skipped_locked"; created: 0; recordIds: string[] }
  | { status: "no_changes"; created: 0; recordIds: string[] }
  | { status: "generated"; created: number; recordIds: string[] };

/** A brand-new Session record was just created - see this file's own header for what this call site is and isn't responsible for. */
export interface SessionEventCreated {
  kind: "created";
}
/** The Session's own Session Lifecycle Status field was just written to a new value - `oldStatus`/`newStatus` describe that transition; this call never re-reads or second-guesses it beyond the idempotency check below. */
export interface SessionEventStatusChanged {
  kind: "status_changed";
  oldStatus: string;
  newStatus: string;
}
export type SessionEvent = SessionEventCreated | SessionEventStatusChanged;

export interface GenerateOptions {
  /** Present iff this call should be audited to Session History - omitted by every caller that isn't a genuine Management structural edit (the daily-top-up sweep and a plain manual /generate call both omit this on purpose: routine top-ups are not structural changes). */
  caller?: HistoryCaller;
  /** Present iff this call represents a Session creation or lifecycle-status transition worth recording - omitted for every other call, including the "generation_only" immediate-trigger path when nothing structural actually changed, and the backfill call after a Day propagation. */
  sessionEvent?: SessionEvent;
}

function describeGenerationOutcome(outcome: GenerationOutcome): string {
  if (outcome.status === "generated") return `${outcome.created} occurrence(s) generated.`;
  if (outcome.status === "no_changes") return "No occurrences generated (Session not yet Active, or already up to date).";
  // Unreachable in practice: this function is only ever called after this
  // same invocation's OWN lock.acquire() already succeeded, so a fresh
  // lock-contention outcome can't occur between here and there. Handled
  // anyway so this stays total over GenerationOutcome's real type.
  return "Occurrence generation was skipped (Session locked by another operation) - it will be picked up by the next trigger or scheduled top-up.";
}

/**
 * The Session's own "current known status" as far as Session History
 * itself can tell - the New Value of whichever `Created`/`Active
 * Status` row is chronologically most recent (sorted by `Changed At`,
 * ISO8601 strings so lexicographic order is chronological order), or
 * `undefined` if this Session has no such row yet. `Created`'s own New
 * Value counts as the baseline "known status" exactly like a real
 * `Active Status` row would - a Session created straight into Active
 * has a known status of "Active" from that one row alone, with no
 * `Active Status` row required first.
 *
 * This - NOT the Session record's own live Lifecycle Status field - is
 * the idempotency signal for `status_changed`, and deliberately so: by
 * the time this code ever runs, the Session's own field has ALREADY
 * been written by whoever called this (see this file's header) - true
 * on the very first genuine call just as much as on a retry of it - so
 * the live field can never distinguish "this transition was just
 * applied for the first time" from "this transition was already
 * recorded a moment ago". History's own most-recent row can, because it
 * only advances when THIS function actually writes to it.
 */
function mostRecentRecordedStatus(historyRows: { fields: Record<string, any> }[]): string | undefined {
  const statusRows = historyRows.filter((r) => {
    const changeType = selectName(r.fields["Change Type"]);
    return changeType === "Created" || changeType === "Active Status";
  });
  if (statusRows.length === 0) return undefined;
  statusRows.sort((a, b) => String(a.fields["Changed At"]).localeCompare(String(b.fields["Changed At"])));
  return statusRows[statusRows.length - 1].fields["New Value"];
}

/**
 * Writes exactly one History row for a Session creation or lifecycle-
 * status transition - never both, since `sessionEvent` is one or the
 * other.
 *
 * `Created` keeps its own separate idempotency guard: skipped if ANY
 * `Created` row already exists for this Session - a Session only ever
 * has one genuine creation event, full stop, so no comparison against
 * "current status" applies here at all.
 *
 * `status_changed` is idempotent against `mostRecentRecordedStatus()`,
 * not against "does a row with this exact old/new pair already exist"
 * (the bug this replaces, see TEST-ENV.md's hardening-fix section): the
 * request is a no-op - "requested status == current [recorded] Session
 * status" - iff `newStatus` already equals the most recently recorded
 * status, in which case nothing is written; otherwise this is a genuine
 * transition (even if the exact same old->new pair was recorded at some
 * EARLIER point - e.g. Active -> Inactive -> Active -> Inactive again is
 * still two genuine, independent `Active Status` rows) and both the real
 * transition's generation and its History row happen. An immediate
 * retry of the same call afterward then correctly writes nothing, because
 * the most-recently-recorded status is now the retry's own `newStatus`.
 */
async function writeSessionEventHistory(
  airtable: AirtableConfig,
  sessionRecordId: string,
  session: SessionRecord,
  caller: HistoryCaller,
  sessionEvent: SessionEvent,
  outcome: GenerationOutcome,
  now: Date
): Promise<void> {
  const generationSummary = describeGenerationOutcome(outcome);
  const existing = await fetchSessionHistoryForSession(airtable, sessionRecordId);

  if (sessionEvent.kind === "created") {
    if (existing.some((r) => selectName(r.fields["Change Type"]) === "Created")) return;
    const pattern = selectName(session.fields["Schedule Pattern"]) || "no pattern set";
    const status = selectName(session.fields["Session Lifecycle Status"]) || "unknown status";
    await createHistoryEntries(airtable, sessionRecordId, [
      {
        changeType: "Created",
        oldValue: "",
        newValue: status,
        changeSummary: `Session created (${pattern}) as ${status}. ${generationSummary}`,
        changedByUserId: caller.userId,
        changedByNameSnapshot: caller.displayName || caller.userId,
        changedAt: now.toISOString(),
      },
    ]);
    return;
  }

  // status_changed
  if (sessionEvent.oldStatus === sessionEvent.newStatus) return; // not a real transition - nothing to record
  if (mostRecentRecordedStatus(existing) === sessionEvent.newStatus) return; // already reflects this status - a retry, not a new transition
  await createHistoryEntries(airtable, sessionRecordId, [
    {
      changeType: "Active Status",
      oldValue: sessionEvent.oldStatus,
      newValue: sessionEvent.newStatus,
      changeSummary: generationSummary,
      changedByUserId: caller.userId,
      changedByNameSnapshot: caller.displayName || caller.userId,
      changedAt: now.toISOString(),
    },
  ]);
}

/**
 * Acquires the per-Session lock, generates (read + pure plan + create)
 * if and only if the lock was actually acquired, and always releases in
 * a `finally` - even if generation throws. Concurrency is the lock, not
 * an extra read-before-write check: two invocations can never both reach
 * the generation step for the same Session, so there is nothing further
 * for this function to guard against.
 */
export async function generateForSession(
  deps: OrchestratorDeps,
  sessionRecordId: string,
  today: Date = new Date(),
  options: GenerateOptions = {}
): Promise<GenerationOutcome> {
  const lockToken = await deps.lock.acquire(sessionRecordId);
  if (!lockToken) {
    return { status: "skipped_locked", created: 0, recordIds: [] };
  }

  try {
    const [session, sessionDates, existingOccurrences] = await Promise.all([
      fetchSession(deps.airtable, sessionRecordId),
      fetchSessionDatesForSession(deps.airtable, sessionRecordId),
      fetchExistingOccurrencesForSession(deps.airtable, sessionRecordId),
    ]);

    const { toCreate } = planGeneration({ session, sessionDates, existingOccurrences, today });
    const outcome: GenerationOutcome =
      toCreate.length === 0
        ? { status: "no_changes", created: 0, recordIds: [] }
        : { status: "generated", ...(await createOccurrences(deps.airtable, toCreate, session)) };

    if (options.caller && options.sessionEvent) {
      await writeSessionEventHistory(deps.airtable, sessionRecordId, session, options.caller, options.sessionEvent, outcome, today);
    }

    return outcome;
  } finally {
    await deps.lock.release(sessionRecordId, lockToken);
  }
}
