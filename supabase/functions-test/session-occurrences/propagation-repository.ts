/**
 * Airtable write layer for Slice 6 recurring-edit propagation (see
 * TEST-ENV.md). Deliberately a SEPARATE file from repository.ts: that
 * file's header states, as a structural property, that it is create-only
 * and never issues a PATCH/PUT/DELETE - crystallisation and propagation
 * were explicitly deferred to Slice 6, "not here". Adding PATCH support
 * there would make that claim false. This file is where the update path
 * for Session Occurrences (and the Session record itself) lives instead.
 *
 * Same portability discipline as repository.ts: plain fetch() only, no
 * Deno.* calls, so this runs unchanged under Node (verification) and
 * Deno (once deployed).
 */
import type { AirtableConfig } from "./repository.ts";
import type { OccurrenceFieldUpdate } from "./propagation.ts";

/**
 * Chunks of up to 10 (Airtable's own limit per call), PATCH (partial
 * update) semantics - fields not named in the payload are left alone.
 * Returns the updated record IDs in the same order as the input, same
 * convention as repository.ts's airtableBatchCreate, so a TEST run can be
 * identified/rolled back precisely.
 */
async function airtableBatchUpdate(
  config: AirtableConfig,
  tableName: string,
  updates: { id: string; fields: Record<string, unknown> }[]
): Promise<string[]> {
  const updatedIds: string[] = [];
  for (let i = 0; i < updates.length; i += 10) {
    const chunk = updates.slice(i, i + 10);
    if (!chunk.length) continue;
    const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      const message = await res.text();
      throw new Error(`Airtable update ${tableName} error: ${res.status} ${message}`);
    }
    const data = await res.json();
    for (const rec of data.records || []) updatedIds.push(rec.id);
  }
  return updatedIds;
}

/**
 * Applies one category of a RecurringEditPlan (toUpdate, toCancel or
 * toCrystallise - all share the same {occurrenceRecordId, fields} shape)
 * against Session Occurrences. A no-op (returns immediately) for an
 * empty list, matching repository.ts's createOccurrences() convention.
 */
export async function applyOccurrenceFieldUpdates(
  config: AirtableConfig,
  updates: OccurrenceFieldUpdate[]
): Promise<{ updated: number; recordIds: string[] }> {
  if (updates.length === 0) return { updated: 0, recordIds: [] };
  const records = updates.map((u) => ({ id: u.occurrenceRecordId, fields: u.fields }));
  const recordIds = await airtableBatchUpdate(config, "Session Occurrences", records);
  return { updated: recordIds.length, recordIds };
}

/**
 * The actual recurring-Session edit itself - a PATCH to the Session
 * record's own default fields (Default Start/End Time, Venue, Default
 * Capacity, Default Day, End Date). This is a plain single-record write,
 * not a batch - Slice 6 propagates the CONSEQUENCES of this write, this
 * function performs the write.
 */
export async function updateSessionFields(
  config: AirtableConfig,
  sessionRecordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/Sessions/${sessionRecordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable update Sessions error: ${res.status} ${message}`);
  }
}
