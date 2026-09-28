/**
 * Test-suite copy of the canonical needs-attention/lock-client.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * TEST Supabase lock client for the Needs Attention exception write path
 * (Slice 5; see TEST-ENV.md). Talks to the
 * `acquire_needs_attention_exception_lock` /
 * `release_needs_attention_exception_lock` Postgres functions (project
 * dkqubldmfyeuudecxmvh) via plain PostgREST RPC calls - the same shape as
 * coach-cover/lock-client.ts and occurrence-financial-outcomes/
 * lock-client.ts (this codebase's proven per-entity lock pattern, copied
 * not shared), pointed at its own narrow `needs_attention_exception_locks`
 * table. The functions are executable by service_role only. Needs no
 * Supabase client library, so it is portable under Node (unit tests use an
 * in-memory fake implementing LockClient) and Deno (the deployed function).
 *
 * Ownership, not mere presence, is what makes a lock safe: acquire()
 * returns the token THIS call now owns (or null if someone else holds a
 * live lock); release() only ever deletes a row whose lock_token matches.
 */

export interface SupabaseLockConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export interface LockClient {
  /** Returns a lock token this caller now owns, or null if someone else holds a live lock on `key`. */
  acquire(key: string): Promise<string | null>;
  /** Returns true iff a row was actually deleted - i.e. this caller still owned the lock at release time. */
  release(key: string, lockToken: string): Promise<boolean>;
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
    async acquire(key: string): Promise<string | null> {
      const result = await callRpc(config, "acquire_needs_attention_exception_lock", { p_exception_key: key });
      return typeof result === "string" && result ? result : null;
    },
    async release(key: string, lockToken: string): Promise<boolean> {
      const result = await callRpc(config, "release_needs_attention_exception_lock", { p_exception_key: key, p_lock_token: lockToken });
      return result === true;
    },
  };
}
