/**
 * Test-suite copy of the canonical repository.ts (occurrence-financial-
 * outcomes), kept in sync by hand exactly like every other deployed
 * copy. No import adjustment needed - this file has no internal imports.
 *
 * Airtable repository layer for Coaches Slice 6 (see TEST-ENV.md). Reads/
 * updates Coach Allocations (Coach outcome - reused from Slice 5, no
 * duplicate coach-cost table) and Occurrence Financial Outcomes (Parent/
 * Venue outcome - new this slice); reads Session Occurrences for
 * existence/status context only. Portable on purpose: no Deno.* calls
 * anywhere, only plain fetch() with an explicitly-passed AirtableConfig -
 * same convention as coach-allocations/repository.ts, so this file runs
 * identically under Node (unit tests, mocked global fetch) and Deno (the
 * real deployed Edge Function).
 *
 * This function is self-contained per this codebase's established
 * convention (no shared filesystem across Edge Functions) - it does not
 * import coach-allocations' own repository.ts, even though several
 * helpers below are structurally identical to it.
 */

export interface AirtableConfig {
  baseId: string;
  token: string;
}

async function getAirtableRecords(config: AirtableConfig, tableName: string): Promise<any[]> {
  const records: any[] = [];
  let offset = "";
  do {
    const url = new URL(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`);
    if (offset) url.searchParams.set("offset", offset);
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Airtable error for ${tableName}: ${response.status} ${message}`);
    }
    const data = await response.json();
    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return records;
}

async function getAirtableRecordById(config: AirtableConfig, tableName: string, id: string): Promise<any> {
  const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}/${id}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable error fetching ${tableName}/${id}: ${res.status} ${message}`);
  }
  return res.json();
}

async function createAirtableRecord(config: AirtableConfig, tableName: string, fields: Record<string, unknown>): Promise<string> {
  const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable create ${tableName} error: ${res.status} ${message}`);
  }
  const data = await res.json();
  return data.records[0].id;
}

async function updateAirtableRecord(config: AirtableConfig, tableName: string, id: string, fields: Record<string, unknown>): Promise<void> {
  const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable update ${tableName}/${id} error: ${res.status} ${message}`);
  }
}

/** Same "not found" convention as every other TEST function's own isNotFoundError (see TEST-ENV.md, Slice 4). */
function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /:\s*404\b/.test(message) || /MODEL_NOT_FOUND/.test(message);
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

export async function fetchSessionOccurrenceById(config: AirtableConfig, occurrenceId: string): Promise<AirtableRecord | null> {
  try {
    const raw = await getAirtableRecordById(config, "Session Occurrences", occurrenceId);
    return { id: raw.id, fields: raw.fields || {} };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export async function fetchAllocationById(config: AirtableConfig, allocationId: string): Promise<AirtableRecord | null> {
  try {
    const raw = await getAirtableRecordById(config, "Coach Allocations", allocationId);
    return { id: raw.id, fields: raw.fields || {} };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

/** Every Coach Allocation linked to one occurrence (an occurrence may have several coaches) - used only for the combined read, never for the coach-outcome write (that takes an explicit allocationId). */
export async function fetchAllocationsForOccurrence(config: AirtableConfig, occurrenceId: string): Promise<AirtableRecord[]> {
  const all = await getAirtableRecords(config, "Coach Allocations");
  return all
    .filter((r) => {
      const occIds: string[] = (r.fields || {})["Session Occurrence"] || [];
      return occIds.includes(occurrenceId);
    })
    .map((r) => ({ id: r.id, fields: r.fields || {} }));
}

export async function updateAllocation(config: AirtableConfig, allocationId: string, fields: Record<string, unknown>): Promise<void> {
  await updateAirtableRecord(config, "Coach Allocations", allocationId, fields);
}

/**
 * The idempotency/upsert boundary for Parent/Venue outcomes (Coaches
 * Slice 6 - "Idempotency"): at most one Occurrence Financial Outcomes
 * row per Session Occurrence, same application-level pattern as Slice
 * 5's Coach Allocations (Coach, Session Occurrence) uniqueness - no
 * schema-level key enforces this, so the repository/orchestrator layer
 * does, by always looking for an existing row before deciding whether
 * to create or update.
 */
export async function fetchOutcomeRowForOccurrence(config: AirtableConfig, occurrenceId: string): Promise<AirtableRecord | null> {
  const all = await getAirtableRecords(config, "Occurrence Financial Outcomes");
  const match = all.find((r) => {
    const occIds: string[] = (r.fields || {})["Session Occurrence"] || [];
    return occIds.includes(occurrenceId);
  });
  return match ? { id: match.id, fields: match.fields || {} } : null;
}

export async function createOutcomeRow(config: AirtableConfig, occurrenceId: string, familyFields: Record<string, unknown>): Promise<string> {
  return createAirtableRecord(config, "Occurrence Financial Outcomes", {
    "Outcome ID": `OUTCOME-${occurrenceId}-${Date.now()}`,
    "Session Occurrence": [occurrenceId],
    ...familyFields,
  });
}

export async function updateOutcomeRow(config: AirtableConfig, outcomeRowId: string, familyFields: Record<string, unknown>): Promise<void> {
  await updateAirtableRecord(config, "Occurrence Financial Outcomes", outcomeRowId, familyFields);
}
