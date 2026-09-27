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
 * Writes exactly one History row for a Session creation or lifecycle-
 * status transition - never both, since `sessionEvent` is one or the
 * other. Guards against a retried identical call writing a duplicate row
 * by checking Session History itself for a matching existing row first -
 * the only idempotency signal available for these two Change Types,
 * since (unlike Day/Time/Venue/Capacity/Operating Dates) there is no
 * Session-record field whose CURRENT value naturally distinguishes "this
 * exact transition was already recorded" from "it wasn't" - see
 * propagation-orchestrator.ts's own header for why that trick works
 * there but not here. Known limitation, documented in TEST-ENV.md: a
 * genuine LATER real toggle back to an identical old/new status pair
 * would also be suppressed by this check - acceptable for how this field
 * is actually used (a Session doesn't realistically flip Draft/Active
 * repeatedly moment to moment), not pretended to be a fully general
 * event-sourced guarantee.
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

  if (sessionEvent.kind === "created") {
    const existing = await fetchSessionHistoryForSession(airtable, sessionRecordId);
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
  const existing = await fetchSessionHistoryForSession(airtable, sessionRecordId);
  const alreadyRecorded = existing.some(
    (r) =>
      selectName(r.fields["Change Type"]) === "Active Status" &&
      r.fields["Old Value"] === sessionEvent.oldStatus &&
      r.fields["New Value"] === sessionEvent.newStatus
  );
  if (alreadyRecorded) return;
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
