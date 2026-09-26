/**
 * Test-suite copy of the canonical lock-client.ts, kept in sync by hand
 * exactly like every other deployed copy - no import path changes needed
 * here, it has no cross-file imports.
 *
 * TEST Supabase lock client - Slice 3 (see TEST-ENV.md). Talks to the
 * `acquire_generation_lock`/`release_generation_lock` Postgres functions
 * (project dkqubldmfyeuudecxmvh) via plain PostgREST RPC calls, so this
 * file needs no Supabase client library and stays portable under both
 * Node (Slice 3's verification) and Deno (once Slice 4 deploys it).
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
  acquire(sessionRecordId: string): Promise<string | null>;
  /** Returns true iff a row was actually deleted - i.e. this caller still owned the lock at release time. */
  release(sessionRecordId: string, lockToken: string): Promise<boolean>;
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
    async acquire(sessionRecordId: string): Promise<string | null> {
      const result = await callRpc(config, "acquire_generation_lock", { p_session_record_id: sessionRecordId });
      return typeof result === "string" && result ? result : null;
    },
    async release(sessionRecordId: string, lockToken: string): Promise<boolean> {
      const result = await callRpc(config, "release_generation_lock", {
        p_session_record_id: sessionRecordId,
        p_lock_token: lockToken,
      });
      return result === true;
    },
  };
}
