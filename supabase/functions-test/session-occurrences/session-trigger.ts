/**
 * The immediate-trigger integration point - Slice 8 (see TEST-ENV.md).
 * Answers: "a Session was just saved (created, activated, or edited) -
 * what should run right now to bring its occurrences up to date?"
 *
 * Deliberately the ONLY new logic here is *composition order* - which
 * already-proven function(s) to call and in what sequence. It contains
 * no generation/propagation/date business logic of its own, per the
 * ratified architecture rule ("the trigger layer must not contain
 * schedule business logic itself"):
 *
 *  - Session created, or transitioned Draft -> Active, or any other
 *    save with no recurring-default change: call generateForSession()
 *    alone. That function already handles "nothing to do yet" (an
 *    inactive/draft Session) and "already up to date" (no_changes) on
 *    its own - this file adds nothing on top.
 *  - A qualifying recurring edit (any of time/venue/capacity/dayOfWeek/
 *    endDate changed): call propagateForSession() - which already
 *    performs, under its own lock, exactly the ratified order (acquire
 *    lock -> plan against OLD values -> apply the occurrence-level
 *    plan -> write the Session's new defaults -> release lock, see
 *    propagation-orchestrator.ts's own comment for why that order
 *    matters) - then, ONLY if it reports backfillNeeded, call
 *    generateForSession() as a second, separate, lock-acquiring step.
 *    Never the reverse order, and never merged into one lock: a
 *    day-of-week change's cancellations must be committed before the
 *    generator looks for what's missing, or the generator would see a
 *    Session default that's already changed but stale occurrence rows
 *    that haven't been reconciled yet.
 *
 * This is the function a future Management "save Session" backend flow
 * is expected to call once, synchronously, immediately after writing
 * the Session record's own fields - see the HTTP wrapper in index.ts
 * (`POST /session-occurrences/trigger-session-saved`) for the concrete
 * integration point verified in TEST, and TEST-ENV.md, Slice 8, for the
 * documented contract a real Management UI would use.
 */
import { generateForSession, type GenerationOutcome, type OrchestratorDeps } from "./orchestrator.ts";
import { propagateForSession, type PropagateChanges, type PropagationOutcome } from "./propagation-orchestrator.ts";

export type SessionSavedTriggerOutcome =
  | { kind: "generation_only"; generation: GenerationOutcome }
  | { kind: "propagation_then_backfill"; propagation: PropagationOutcome; backfill: GenerationOutcome | null };

/**
 * `changes` omitted (or `undefined`) means "no recurring default
 * changed" - covers Session creation and a Draft/Inactive -> Active
 * transition alike, since both are simply "make sure the shells that
 * should exist, exist" with nothing to propagate. `changes` present
 * means a qualifying recurring edit was made - the exact same
 * `PropagateChanges` shape Slice 6's `/propagate` route already
 * validates and accepts, reused unchanged here.
 */
export async function triggerSessionSaved(
  deps: OrchestratorDeps,
  sessionRecordId: string,
  changes?: PropagateChanges,
  now: Date = new Date()
): Promise<SessionSavedTriggerOutcome> {
  if (!changes) {
    const generation = await generateForSession(deps, sessionRecordId, now);
    return { kind: "generation_only", generation };
  }

  const propagation = await propagateForSession(deps, sessionRecordId, changes, now);
  let backfill: GenerationOutcome | null = null;
  if (propagation.status === "applied" && propagation.plan.backfillNeeded) {
    backfill = await generateForSession(deps, sessionRecordId, now);
  }
  return { kind: "propagation_then_backfill", propagation, backfill };
}
