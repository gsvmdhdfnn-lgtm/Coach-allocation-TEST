/**
 * The one shared per-Session orchestration path - Slice 3 (see
 * TEST-ENV.md). Nothing else in this codebase calls the lock, the
 * repository and the pure generator together; everything that ever
 * wants to generate occurrences for a Session goes through
 * generateForSession(), not a re-derived copy of this sequence.
 *
 * Not wired to anything yet - no scheduled job, no HTTP route, no
 * frontend. Slice 4 is where this gets exposed manually; Slice 3 stops
 * at building and verifying the function itself.
 */
import { planGeneration } from "./generator.ts";
import {
  createOccurrences,
  fetchExistingOccurrencesForSession,
  fetchSession,
  fetchSessionDatesForSession,
  type AirtableConfig,
} from "./repository.ts";
import type { LockClient } from "./lock-client.ts";

export interface OrchestratorDeps {
  airtable: AirtableConfig;
  lock: LockClient;
}

export type GenerationOutcome =
  | { status: "skipped_locked"; created: 0; recordIds: string[] }
  | { status: "no_changes"; created: 0; recordIds: string[] }
  | { status: "generated"; created: number; recordIds: string[] };

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
  today: Date = new Date()
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
    if (toCreate.length === 0) {
      return { status: "no_changes", created: 0, recordIds: [] };
    }

    const { created, recordIds } = await createOccurrences(deps.airtable, toCreate, session);
    return { status: "generated", created, recordIds };
  } finally {
    await deps.lock.release(sessionRecordId, lockToken);
  }
}
