/**
 * Test-suite copy of the canonical coach-work-summaries/repository.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./work-summaries|repository|lock-client.ts become coach-work-summaries-*.ts.
 */
/**
 * Airtable repository layer for Coaches Slice 10 work summaries (see
 * TEST-ENV.md). Generic list/get/create/PATCH by table name - nothing
 * here decides anything. Portable on purpose (no Deno.* calls, only
 * fetch() with an explicitly-passed AirtableConfig) so it runs the same
 * under Node (unit tests, mocked global fetch) and Deno. Same 429
 * retry/backoff and read-in-waves as coach-cover/repository.ts (copied,
 * not shared). Nothing is ever deleted through this module.
 */

export interface AirtableConfig {
  baseId: string;
  token: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

export const TABLES = {
  coaches: "Coaches",
  sessions: "Sessions",
  occurrences: "Session Occurrences",
  allocations: "Coach Allocations",
  summaries: "Coach Work Summaries",
  lines: "Work Summary Lines",
  history: "Work Summary History",
} as const;

function tableUrl(config: AirtableConfig, tableName: string): string {
  return `https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`;
}

/**
 * Airtable allows ~5 requests/second per base and answers bursts with 429.
 * A 429 means the request was NOT processed, so retrying it (even a POST)
 * cannot double-write. Backoff totals ~31s, well inside the Edge Function
 * limit; exported so unit tests can shorten it.
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

function toRecord(r: any): AirtableRecord {
  return { id: r.id, fields: r.fields || {}, createdTime: r.createdTime };
}

export async function listRecords(config: AirtableConfig, tableName: string): Promise<AirtableRecord[]> {
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
    for (const r of data.records || []) records.push(toRecord(r));
    offset = data.offset || "";
  } while (offset);
  return records;
}

/** Same "not found" convention as every other TEST function's own isNotFoundError. */
function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /:\s*404\b/.test(message) || /MODEL_NOT_FOUND/.test(message);
}

export async function getRecord(config: AirtableConfig, tableName: string, id: string): Promise<AirtableRecord | null> {
  const res = await airtableFetch(`${tableUrl(config, tableName)}/${id}`, { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) {
    const message = await res.text();
    const error = new Error(`Airtable error fetching ${tableName}/${id}: ${res.status} ${message}`);
    if (isNotFoundError(error)) return null;
    throw error;
  }
  return toRecord(await res.json());
}

export async function createRecord(config: AirtableConfig, tableName: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
  const res = await airtableFetch(tableUrl(config, tableName), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable create ${tableName} error: ${res.status} ${message}`);
  }
  const data = await res.json();
  return toRecord(data.records[0]);
}

/** PATCH (not PUT): only the named fields change. */
export async function patchRecord(config: AirtableConfig, tableName: string, id: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
  const res = await airtableFetch(`${tableUrl(config, tableName)}/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable update ${tableName}/${id} error: ${res.status} ${message}`);
  }
  return toRecord(await res.json());
}

export type World = { -readonly [K in keyof typeof TABLES]: AirtableRecord[] };

/**
 * One consistent read of the tables an operation reasons over (all of
 * them unless `only` narrows it; the rest come back empty). Whole-table
 * fetch-and-filter in code, same convention as every other TEST function
 * (links render as names inside filterByFormula). Fine for the TEST base
 * size; a production build would narrow by date window.
 */
export async function loadWorld(config: AirtableConfig, only?: (keyof typeof TABLES)[]): Promise<World> {
  const all = Object.keys(TABLES) as (keyof typeof TABLES)[];
  const keys = only ?? all;
  const world = {} as World;
  for (const k of all) world[k] = [];
  // Waves of at most 5 parallel reads - Airtable's own per-base rate - with
  // airtableFetch() absorbing any 429 that concurrent requests still cause.
  for (let i = 0; i < keys.length; i += 5) {
    const wave = keys.slice(i, i + 5);
    const lists = await Promise.all(wave.map((k) => listRecords(config, TABLES[k])));
    wave.forEach((k, j) => (world[k] = lists[j]));
  }
  return world;
}
