/**
 * Test-suite copy of the canonical lock-client.ts, kept in sync by hand
 * exactly like every other deployed copy. No import adjustment needed -
 * this file has no internal imports.
 *
 * TEST Supabase lock client for Coaches Slice 6 hardening (see
 * TEST-ENV.md). Talks to the `acquire_occurrence_outcome_lock`/
 * `release_occurrence_outcome_lock` Postgres functions (project
 * dkqubldmfyeuudecxmvh) via plain PostgREST RPC calls - deliberately the
 * same shape as session-occurrences/lock-client.ts (this codebase's
 * proven per-entity lock pattern, reused rather than inventing new
 * architecture), just pointed at the occurrence-outcome domain's own
 * table/functions instead of sharing session-occurrences' generation
 * lock. Needs no Supabase client library, so it is portable under both
 * Node (unit tests, via an in-memory fake implementing the same
 * LockClient interface) and Deno (the real deployed function).
 *
 * Ownership, not mere presence, is what makes a lock safe: acquire()
 * returns the token THIS call now owns (or null if someone else holds a
 * live lock); release() only ever deletes a row whose lock_token matches
 * the token passed in. A stale invocation that reawakens after its lock
 * was reclaimed by someone else can never delete the new owner's lock -
 * its own (now-superseded) token simply won't match any row.
 */

export interface SupabaseLockConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface LockClient {
  /** Returns a lock token this caller now owns, or null if acquisition failed (someone else holds a live lock). */
  acquire(occurrenceRecordId: string): Promise<string | null>;
  /** Returns true iff a row was actually deleted - i.e. this caller still owned the lock at release time. */
  release(occurrenceRecordId: string, lockToken: string): Promise<boolean>;
}

async function callRpc(config: SupabaseLockConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Supabase RPC ${fn} error: ${res.status} ${message}`);
  }
  return res.json();
}

export function createSupabaseLockClient(config: SupabaseLockConfig): LockClient {
  return {
    async acquire(occurrenceRecordId: string): Promise<string | null> {
      const result = await callRpc(config, "acquire_occurrence_outcome_lock", { p_occurrence_record_id: occurrenceRecordId });
      return typeof result === "string" && result ? result : null;
    },
    async release(occurrenceRecordId: string, lockToken: string): Promise<boolean> {
      const result = await callRpc(config, "release_occurrence_outcome_lock", {
        p_occurrence_record_id: occurrenceRecordId,
        p_lock_token: lockToken,
      });
      return result === true;
    },
  };
}
