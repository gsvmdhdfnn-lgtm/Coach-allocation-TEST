/**
 * Test-suite copy of the canonical finance/repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * finance-access.test.ts). Only import paths adjusted:
 * ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Finance repository layer (Finance Foundation F1; see TEST-ENV.md
 * "Finance Foundation - F1"). READ ONLY - F1 has no Finance business
 * writes, and this file writes nothing anywhere.
 *
 *   - Airtable: the two configuration tables the access decision needs,
 *     "Organisation & Branding" and "Feature Controls", each listed once
 *     per request. Same 429 retry/backoff as the other TEST repositories
 *     (copied, not shared).
 *   - Supabase: the caller's own rows of public.finance_access_grants,
 *     read with the service role over PostgREST. That table has RLS on and
 *     no anon/authenticated grants or policies (the lock-table pattern), so
 *     only this server-side read can see it; the filter is always the
 *     authenticated caller's user id, never anything from the request.
 *
 * Portable on purpose (no Deno.* calls, only fetch() with explicitly-passed
 * configs) so it runs the same under Node (unit tests, mocked global fetch)
 * and Deno.
 */
import type { AirtableRecord, FinanceGrantRow } from "./finance-access.ts";

export interface AirtableConfig {
  baseId: string;
  token: string;
}

export interface GrantStoreConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

export const CONFIG_TABLES = {
  features: "Feature Controls",
  organisations: "Organisation & Branding",
} as const;

export const GRANTS_TABLE = "finance_access_grants";

function tableUrl(config: AirtableConfig, tableName: string): string {
  return `https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`;
}

/**
 * Airtable allows ~5 requests/second per base and answers bursts with 429.
 * A 429 means the request was NOT processed, so retrying is safe. Backoff
 * totals ~31s; exported so unit tests can shorten it.
 */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function airtableFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= RETRY_DELAYS_MS.length) return res;
    await res.text();
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

async function listAll(config: AirtableConfig, tableName: string): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, tableName));
    if (offset) url.searchParams.set("offset", offset);
    const response = await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Airtable error for ${tableName}: ${response.status} ${message}`);
    }
    const data = await response.json();
    for (const r of data.records || []) records.push({ id: r.id, fields: r.fields || {}, createdTime: r.createdTime });
    offset = data.offset || "";
  } while (offset);
  return records;
}

export interface FinanceConfigSnapshot {
  organisations: AirtableRecord[];
  features: AirtableRecord[];
}

/** Both configuration tables, each read exactly once. */
export async function loadFinanceConfig(config: AirtableConfig): Promise<FinanceConfigSnapshot> {
  const [organisations, features] = await Promise.all([listAll(config, CONFIG_TABLES.organisations), listAll(config, CONFIG_TABLES.features)]);
  return { organisations, features };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every grant row (revoked or not) for exactly this user id; the pure
 * policy decides which one, if any, counts. Throws on any store error so
 * the caller fails closed (503) rather than treating "unreadable" as "none".
 */
export async function loadFinanceGrants(config: GrantStoreConfig, userId: string): Promise<FinanceGrantRow[]> {
  if (!UUID_RE.test(userId)) throw new Error("Finance grant lookup refused: caller user id is not a UUID");
  const url = new URL(`${config.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${GRANTS_TABLE}`);
  url.searchParams.set("select", "organisation_id,access_level,revoked_at");
  url.searchParams.set("user_id", `eq.${userId}`);
  const response = await fetch(url.toString(), {
    headers: { apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Finance grant store error: ${response.status} ${message}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Finance grant store returned a non-array body");
  return rows as FinanceGrantRow[];
}
