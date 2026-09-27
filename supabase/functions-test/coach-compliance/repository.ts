/**
 * Airtable repository layer for Coaches Slice 8 (see TEST-ENV.md): Coaches
 * (existence check), Coach Documents (read, create, PATCH) and Coach
 * Document Requirements (read). Portable on purpose - no Deno.* calls, only plain
 * fetch() with an explicitly-passed AirtableConfig - so it runs identically
 * under Node (unit tests, mocked global fetch) and Deno (the deployed
 * function). Self-contained per this codebase's convention.
 */

export interface AirtableConfig {
  baseId: string;
  token: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

const DOCUMENTS = "Coach Documents";
const REQUIREMENTS = "Coach Document Requirements";

function tableUrl(config: AirtableConfig, tableName: string): string {
  return `https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`;
}

async function getAirtableRecords(config: AirtableConfig, tableName: string): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, tableName));
    if (offset) url.searchParams.set("offset", offset);
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Airtable error for ${tableName}: ${response.status} ${message}`);
    }
    const data = await response.json();
    for (const r of data.records || []) records.push({ id: r.id, fields: r.fields || {} });
    offset = data.offset || "";
  } while (offset);
  return records;
}

/** Same "not found" convention as every other TEST function's own isNotFoundError. */
function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /:\s*404\b/.test(message) || /MODEL_NOT_FOUND/.test(message);
}

async function getRecordById(config: AirtableConfig, tableName: string, id: string): Promise<AirtableRecord | null> {
  const res = await fetch(`${tableUrl(config, tableName)}/${id}`, { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) {
    const message = await res.text();
    const error = new Error(`Airtable error fetching ${tableName}/${id}: ${res.status} ${message}`);
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const raw = await res.json();
  return { id: raw.id, fields: raw.fields || {} };
}

export function fetchCoachById(config: AirtableConfig, coachId: string): Promise<AirtableRecord | null> {
  return getRecordById(config, "Coaches", coachId);
}

export function fetchCoachDocumentById(config: AirtableConfig, documentId: string): Promise<AirtableRecord | null> {
  return getRecordById(config, DOCUMENTS, documentId);
}

/** Filtered to the coach in code by linked record id, never via filterByFormula (links render as names inside formulas). */
export async function fetchCoachDocumentsForCoach(config: AirtableConfig, coachId: string): Promise<AirtableRecord[]> {
  const all = await getAirtableRecords(config, DOCUMENTS);
  return all.filter((r) => Array.isArray(r.fields["Coach"]) && r.fields["Coach"].includes(coachId));
}

export function fetchDocumentRequirements(config: AirtableConfig): Promise<AirtableRecord[]> {
  return getAirtableRecords(config, REQUIREMENTS);
}

export async function createCoachDocument(config: AirtableConfig, fields: Record<string, unknown>): Promise<AirtableRecord> {
  const res = await fetch(tableUrl(config, DOCUMENTS), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable create ${DOCUMENTS} error: ${res.status} ${message}`);
  }
  const data = await res.json();
  const rec = data.records[0];
  return { id: rec.id, fields: rec.fields || {} };
}

/** PATCH (not PUT): only the named fields change - everything else on the record is left exactly as it was. */
export async function updateCoachDocument(config: AirtableConfig, documentId: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
  const res = await fetch(`${tableUrl(config, DOCUMENTS)}/${documentId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable update ${DOCUMENTS}/${documentId} error: ${res.status} ${message}`);
  }
  const raw = await res.json();
  return { id: raw.id, fields: raw.fields || {} };
}
