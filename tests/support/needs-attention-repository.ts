/**
 * Test-suite copy of the canonical needs-attention/repository.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Airtable repository layer for Needs Attention (see TEST-ENV.md "Needs
 * Attention Foundation - Slice 2" and "- Slice 5"). Reads are unchanged.
 * The ONLY write path (Slice 5) is the narrow exception writer at the end
 * of this file: create one row in, or patch one row of, the "Needs
 * Attention Exceptions" table - no other table can be written, and
 * nothing is ever deleted. Portable on purpose (no Deno.* calls,
 * only fetch() with an explicitly-passed AirtableConfig) so it runs the
 * same under Node (unit tests, mocked global fetch) and Deno. Same 429
 * retry/backoff as the other TEST repositories (copied, not shared).
 *
 * Read model: createReader() returns a per-request reader that lists each
 * table AT MOST ONCE (memoised promise per table name) and counts every
 * page request per table, so the orchestrator can prove "config tables
 * read once, gated-off evaluators read nothing, no query per rule".
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

export const CONFIG_TABLES = {
  rules: "Needs Attention Rules",
  settings: "Needs Attention Settings",
  exceptions: "Needs Attention Exceptions",
  features: "Feature Controls",
  organisations: "Organisation & Branding",
} as const;

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

export interface ReadStats {
  /** Number of list operations per table (must be <= 1 per request). */
  lists: Record<string, number>;
  /** Number of HTTP page requests per table (a large table may page). */
  pages: Record<string, number>;
}

export interface Reader {
  list(tableName: string): Promise<AirtableRecord[]>;
  /** Loads several tables, each once, at most `concurrency` at a time. */
  listMany(tableNames: readonly string[], concurrency?: number): Promise<Record<string, AirtableRecord[]>>;
  stats(): ReadStats;
}

export function createReader(config: AirtableConfig): Reader {
  const memo = new Map<string, Promise<AirtableRecord[]>>();
  const stats: ReadStats = { lists: {}, pages: {} };

  async function fetchAll(tableName: string): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset = "";
    do {
      const url = new URL(tableUrl(config, tableName));
      if (offset) url.searchParams.set("offset", offset);
      stats.pages[tableName] = (stats.pages[tableName] ?? 0) + 1;
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

  function list(tableName: string): Promise<AirtableRecord[]> {
    let p = memo.get(tableName);
    if (!p) {
      stats.lists[tableName] = (stats.lists[tableName] ?? 0) + 1;
      p = fetchAll(tableName);
      memo.set(tableName, p);
    }
    return p;
  }

  async function listMany(tableNames: readonly string[], concurrency = 5): Promise<Record<string, AirtableRecord[]>> {
    const unique = [...new Set(tableNames)];
    const out: Record<string, AirtableRecord[]> = {};
    for (let i = 0; i < unique.length; i += concurrency) {
      const wave = unique.slice(i, i + concurrency);
      const results = await Promise.all(wave.map((t) => list(t)));
      wave.forEach((t, j) => (out[t] = results[j]));
    }
    return out;
  }

  return { list, listMany, stats: () => ({ lists: { ...stats.lists }, pages: { ...stats.pages } }) };
}

export interface ConfigSnapshot {
  rules: AirtableRecord[];
  settings: AirtableRecord[];
  exceptions: AirtableRecord[];
  features: AirtableRecord[];
  organisations: AirtableRecord[];
}

/** The five configuration tables, each listed exactly once, in one wave. */
export async function loadConfig(reader: Reader): Promise<ConfigSnapshot> {
  const t = CONFIG_TABLES;
  const r = await reader.listMany([t.rules, t.settings, t.exceptions, t.features, t.organisations]);
  return { rules: r[t.rules], settings: r[t.settings], exceptions: r[t.exceptions], features: r[t.features], organisations: r[t.organisations] };
}

// ---------------------------------------------------------------------
// Exception writer (Slice 5) - the only write path in this function.
// The table name is fixed here; callers cannot point it anywhere else.
// ---------------------------------------------------------------------

async function writeException(config: AirtableConfig, method: "POST" | "PATCH", path: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
  const response = await airtableFetch(`${tableUrl(config, CONFIG_TABLES.exceptions)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Airtable ${method} error for ${CONFIG_TABLES.exceptions}: ${response.status} ${message}`);
  }
  const r = await response.json();
  return { id: r.id, fields: r.fields || {}, createdTime: r.createdTime };
}

/** Create one Needs Attention Exceptions row (a 429 means "not processed", so the shared retry is safe). */
export function createExceptionRecord(config: AirtableConfig, fields: Record<string, unknown>): Promise<AirtableRecord> {
  return writeException(config, "POST", "", fields);
}

/** Patch one Needs Attention Exceptions row by record id (revoke). */
export function updateExceptionRecord(config: AirtableConfig, recordId: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
  if (!/^rec[A-Za-z0-9]{14}$/.test(recordId)) throw new Error(`Invalid exception record id: ${recordId}`);
  return writeException(config, "PATCH", `/${recordId}`, fields);
}
