/**
 * Test-suite copy of the canonical daily-top-up.ts, kept in sync by hand
 * exactly like every other deployed copy. Import paths below are
 * adjusted to this directory's own file names (session-repository.ts and
 * session-orchestrator.ts, not repository.ts/orchestrator.ts) - the only
 * intentional divergence from the canonical file.
 *
 * Daily maintenance/top-up sweep - Slice 8 (see TEST-ENV.md). Answers:
 * "once a day, make sure every Active Session still reaches its
 * required occurrence horizon" - the recovery mechanism for a missed or
 * failed immediate trigger, and the thing that keeps a Session topped up
 * indefinitely with no per-edit trigger involved at all (the rolling
 * 12-week/10-occurrence Recurring horizon, in particular, only ever
 * advances because something calls generateForSession() again later -
 * this is that "later").
 *
 * Deliberately thin, same discipline as session-trigger.ts: the only
 * logic here is "which Sessions to consider, and what to do if one
 * fails" - every actual generation decision still goes through the
 * exact same generateForSession() already proven since Slice 3. This
 * file never calls planGeneration() or the repository directly, and
 * never touches propagation.ts at all - a Session's recurring defaults
 * are not changing during a routine top-up sweep, so there is nothing
 * to propagate; only new missing shells to create.
 *
 * Processes Sessions strictly one at a time (not Promise.all across
 * Sessions) - deliberately simple and safe rather than aggressively
 * parallel, per your instruction. Each Session's own lock-acquire/
 * release is already handled inside generateForSession(); this loop
 * adds nothing beyond try/catch isolation per Session, so one Session's
 * bad data (or e.g. a Default Start Time so malformed the pure
 * generator's buildShell() has been failing closed on it) can never
 * abort the sweep for every other Session.
 */
import { fetchActiveSessions, type AirtableConfig } from "./session-repository.ts";
import { generateForSession, type OrchestratorDeps } from "./session-orchestrator.ts";

export interface DailyTopUpFailure {
  sessionRecordId: string;
  error: string;
}

export interface DailyTopUpSummary {
  considered: number;
  generated: number;
  noChanges: number;
  skippedLocked: number;
  failed: number;
  occurrencesCreated: number;
  failures: DailyTopUpFailure[];
}

/**
 * Fetches every Active Session, then generates for each one in turn.
 * A Session already fully up to date returns no_changes (counted, not
 * an error). A Session another writer (a manual /generate call, an
 * immediate trigger, or a concurrent daily-top-up attempt) is already
 * holding the lock for returns skipped_locked (also counted, not an
 * error, and not retried within this same sweep - the next day's run,
 * or a future manual call, will pick it up). Only a genuine thrown
 * error (e.g. Airtable rejecting a malformed field) counts as failed,
 * and is recorded with the Session's own record ID so it's clear which
 * Session needs attention - never swallowed silently.
 */
export async function runDailyTopUp(deps: OrchestratorDeps, now: Date = new Date()): Promise<DailyTopUpSummary> {
  const sessions = await fetchActiveSessions(deps.airtable as AirtableConfig);

  const summary: DailyTopUpSummary = {
    considered: sessions.length,
    generated: 0,
    noChanges: 0,
    skippedLocked: 0,
    failed: 0,
    occurrencesCreated: 0,
    failures: [],
  };

  for (const session of sessions) {
    try {
      const outcome = await generateForSession(deps, session.id, now);
      if (outcome.status === "generated") {
        summary.generated++;
        summary.occurrencesCreated += outcome.created;
      } else if (outcome.status === "no_changes") {
        summary.noChanges++;
      } else {
        summary.skippedLocked++;
      }
    } catch (error) {
      summary.failed++;
      summary.failures.push({
        sessionRecordId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
