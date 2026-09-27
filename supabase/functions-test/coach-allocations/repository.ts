/**
 * Airtable repository layer for Coaches Slice 5 (see TEST-ENV.md). Reads
 * Coach Rate Profiles / Coach Allocations / Coaches / Session Occurrences;
 * the only write in this file is a single Coach Allocations create - there
 * is no update/delete path anywhere here, matching the historical-
 * snapshot principle (an allocation, once created, is never rewritten by
 * this layer). Portable on purpose: no Deno.* calls anywhere, only plain
 * fetch() with an explicitly-passed AirtableConfig - same convention as
 * session-occurrences/repository.ts, so this file runs identically under
 * Node (unit tests, via a mocked global fetch) and Deno (the real
 * deployed Edge Function).
 */
import {
  firstLink,
  selectName,
  type CoachRateProfileRecord,
  type CreateAllocationInput,
  type ResolveFinalCostResult,
} from "./coach-rates.ts";

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

/**
 * "not found" detector, same convention as session-occurrences/index.ts's
 * own sessionExists() (see TEST-ENV.md, Slice 4 for the confirmed real
 * Airtable behaviour this matches: a malformed id -> plain 404, a
 * well-formed id that doesn't exist -> 403
 * INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND - both count as "not found").
 */
function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /:\s*404\b/.test(message) || /MODEL_NOT_FOUND/.test(message);
}

export async function coachExists(config: AirtableConfig, coachRecordId: string): Promise<boolean> {
  try {
    await getAirtableRecordById(config, "Coaches", coachRecordId);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

export async function sessionOccurrenceExists(config: AirtableConfig, occurrenceRecordId: string): Promise<boolean> {
  try {
    await getAirtableRecordById(config, "Session Occurrences", occurrenceRecordId);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

/**
 * ALL of a Coach's own Coach Rate Profiles rows, unfiltered by date/
 * Active - resolveCoachRateProfile() (coach-rates.ts) does the actual
 * date/Active/Rate-Type filtering; this just narrows the whole-table
 * fetch down to the one Coach, same whole-table-fetch-and-filter
 * convention as session-occurrences/repository.ts's own fetch* functions.
 */
export async function fetchRateProfilesForCoach(config: AirtableConfig, coachRecordId: string): Promise<CoachRateProfileRecord[]> {
  const all = await getAirtableRecords(config, "Coach Rate Profiles");
  return all
    .filter((r) => firstLink(r.fields || {}, "Coach") === coachRecordId)
    .map((r) => ({ id: r.id, fields: r.fields || {} }));
}

/**
 * Idempotency check (Coaches Slice 5, see TEST-ENV.md - "Allocation
 * idempotency"). Coach Allocations has no dedicated Allocation ID/key
 * field the way Session Occurrences has "Occurrence Key" (confirmed by a
 * fresh schema re-read before writing this file - Allocation ID is a
 * plain human-label text field, not a formula-derived uniqueness key).
 * The safe uniqueness model adopted here, documented explicitly rather
 * than invented silently: at most one Coach Allocation per (Coach,
 * Session Occurrence) pair. This queries the real Coach + Session
 * Occurrence links already on the table - it is an application-level
 * check using data the schema genuinely provides, not a hidden
 * convention written into some other field. If a genuine future need for
 * more than one allocation per (Coach, Occurrence) pair emerges (e.g.
 * split cost across two Rate Types for one occurrence), that is new
 * product design, not something this function should silently allow.
 */
export async function fetchAllocationsForCoachAndOccurrence(
  config: AirtableConfig,
  coachRecordId: string,
  occurrenceRecordId: string
): Promise<{ id: string; fields: Record<string, any> }[]> {
  const all = await getAirtableRecords(config, "Coach Allocations");
  return all
    .filter((r) => {
      const fields = r.fields || {};
      const coachIds: string[] = fields["Coach"] || [];
      const occIds: string[] = fields["Session Occurrence"] || [];
      return coachIds.includes(coachRecordId) && occIds.includes(occurrenceRecordId);
    })
    .map((r) => ({ id: r.id, fields: r.fields || {} }));
}

/**
 * Reads one Coach Allocation exactly as stored - the "read an existing
 * Coach Allocation without recomputing from the Coach's current Rate
 * Profile" requirement from the brief. This function does not read Coach
 * Rate Profiles at all; it cannot recompute anything even by accident.
 */
export async function fetchAllocationById(config: AirtableConfig, allocationRecordId: string): Promise<{ id: string; fields: Record<string, any> } | null> {
  try {
    const raw = await getAirtableRecordById(config, "Coach Allocations", allocationRecordId);
    return { id: raw.id, fields: raw.fields || {} };
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

/**
 * Maps a resolved Rate Profile + computed cost + the caller's own inputs
 * to the exact Coach Allocations fields to create. This is the ONE place
 * the snapshot is written - Rate Type Snapshot/Pay Unit Snapshot/Rate
 * Amount Snapshot are copied from the RESOLVED Rate Profile's fields at
 * this exact moment, as plain values (not live references), so a later
 * edit to that Rate Profile row can never reach back and change what was
 * written here. Cost Override/Override Reason are written through
 * as-is; Final Coach Cost is always the resolved `costResult.finalCoachCost`,
 * never recomputed by this function itself (resolveFinalCost() in
 * coach-rates.ts already decided it).
 */
export function buildAllocationCreatePayload(
  input: CreateAllocationInput,
  rateProfile: CoachRateProfileRecord,
  costResult: ResolveFinalCostResult
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    "Allocation ID": `ALLOC-${input.sessionOccurrenceId}-${input.coachId}-${Date.now()}`,
    "Session Occurrence": [input.sessionOccurrenceId],
    Coach: [input.coachId],
    "Assignment Type": input.assignmentType,
    "Rate Profile": [rateProfile.id],
    "Rate Type Snapshot": selectName(rateProfile.fields["Rate Type"]),
    "Pay Unit Snapshot": selectName(rateProfile.fields["Pay Unit"]),
    "Paid Units": input.paidUnits,
    "Rate Amount Snapshot": rateProfile.fields["Amount"],
    "Final Coach Cost": costResult.finalCoachCost,
    "Cost Status": input.costStatus || "Draft",
  };
  if (input.costOverride != null) {
    fields["Cost Override"] = input.costOverride;
    fields["Override Reason"] = input.overrideReason;
  }
  if (input.notes) fields["Notes"] = input.notes;
  return fields;
}

export async function createAllocation(config: AirtableConfig, fields: Record<string, unknown>): Promise<string> {
  return createAirtableRecord(config, "Coach Allocations", fields);
}
