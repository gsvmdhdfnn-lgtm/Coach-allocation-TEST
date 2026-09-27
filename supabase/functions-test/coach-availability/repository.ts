/**
 * Airtable repository layer for Coaches Slice 7 (see TEST-ENV.md). Read-only:
 * Coaches (existence check), Coach Availability (recurring weekly
 * pattern) and Coach Availability Exceptions (date-specific overrides).
 * Portable on purpose - no Deno.* calls, only plain fetch() with an
 * explicitly-passed AirtableConfig - so it runs identically under Node
 * (unit tests, mocked global fetch) and Deno (the deployed function).
 * Self-contained per this codebase's convention: it does not import any
 * other function's repository.ts.
 */

export interface AirtableConfig {
  baseId: string;
  token: string;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
}

async function getAirtableRecords(config: AirtableConfig, tableName: string): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = [];
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

export async function fetchCoachById(config: AirtableConfig, coachId: string): Promise<AirtableRecord | null> {
  const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent("Coaches")}/${coachId}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!res.ok) {
    const message = await res.text();
    const error = new Error(`Airtable error fetching Coaches/${coachId}: ${res.status} ${message}`);
    if (isNotFoundError(error)) return null;
    throw error;
  }
  const raw = await res.json();
  return { id: raw.id, fields: raw.fields || {} };
}

/**
 * Every row is fetched and filtered to the coach in code (never via
 * filterByFormula - a linked-record field renders as display names inside
 * an Airtable formula, not record ids, so a formula filter could match the
 * wrong coach by name). The pure resolver re-checks coach ownership and
 * Active on every row regardless.
 */
export async function fetchRecurringAvailabilityForCoach(config: AirtableConfig, coachId: string): Promise<AirtableRecord[]> {
  const all = await getAirtableRecords(config, "Coach Availability");
  return all.filter((r) => Array.isArray(r.fields["Coach"]) && r.fields["Coach"].includes(coachId));
}

export async function fetchAvailabilityExceptionsForCoach(config: AirtableConfig, coachId: string): Promise<AirtableRecord[]> {
  const all = await getAirtableRecords(config, "Coach Availability Exceptions");
  return all.filter((r) => Array.isArray(r.fields["Coach"]) && r.fields["Coach"].includes(coachId));
}
