/**
 * Test-suite copy of the canonical repository.ts, kept in sync by hand
 * exactly like every other deployed copy. Import paths below are
 * adjusted to this directory's own file names (session-generator.ts, not
 * generator.ts) - the only intentional divergence from the canonical
 * file; everything else is kept identical.
 *
 * Airtable repository layer for the Session Occurrence generator - Slice 3
 * (see TEST-ENV.md). Everything here is deliberately POST/create only:
 * there is no function in this file capable of issuing a PATCH/PUT/DELETE
 * against Session Occurrences, Session Dates or Sessions. That is a
 * structural property, not a runtime check - crystallisation and
 * recurring-edit propagation belong to Slice 6, not here.
 *
 * Portable on purpose: no Deno.* calls anywhere, only plain fetch() with
 * an explicitly-passed AirtableConfig. This lets the exact same code run
 * under Node (Slice 3's verification, before anything is deployed) and
 * later under Deno once Slice 4 wires it into a real Edge Function -
 * matching the existing player-access.ts precedent of "portable pure(ish)
 * logic, thin runtime-specific wiring kept elsewhere".
 */
import {
  computeOccurrenceKey,
  computeReplacementOccurrenceKey,
  selectName,
} from "./schedule-utils.ts";
import type {
  ExistingOccurrenceRecord,
  OccurrenceShell,
  SessionDateRecord,
  SessionRecord,
} from "./session-generator.ts";

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

/**
 * Chunks of up to 10 (Airtable's own limit per call). POST (create) only
 * - see the file header. Returns the created record IDs in the same
 * order as the input records, so callers (and TEST rollback) always know
 * exactly what this call created.
 */
async function airtableBatchCreate(
  config: AirtableConfig,
  tableName: string,
  records: { fields: Record<string, unknown> }[]
): Promise<string[]> {
  const createdIds: string[] = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    if (!chunk.length) continue;
    const res = await fetch(`https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(tableName)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      const message = await res.text();
      throw new Error(`Airtable create ${tableName} error: ${res.status} ${message}`);
    }
    const data = await res.json();
    for (const rec of data.records || []) createdIds.push(rec.id);
  }
  return createdIds;
}

export async function fetchSession(config: AirtableConfig, sessionRecordId: string): Promise<SessionRecord> {
  const raw = await getAirtableRecordById(config, "Sessions", sessionRecordId);
  return { id: raw.id, fields: raw.fields || {} };
}

/**
 * All Sessions whose Session Lifecycle Status is Active - Slice 8's
 * daily top-up reads this to decide which Sessions to sweep. Fetches
 * the whole Sessions table and filters client-side, the exact same
 * style as fetchSessionDatesForSession/fetchExistingOccurrencesForSession
 * above (both already fetch a whole table and filter in memory) -
 * consistent with this repository's existing approach rather than a new
 * one. planGeneration() itself already re-checks Session Lifecycle
 * Status = Active per Session, so a Draft/Inactive Session slipping
 * through here (e.g. a status change mid-sweep) still generates
 * nothing - this filter is a sweep-scoping optimisation, not the only
 * place that invariant is enforced.
 */
export async function fetchActiveSessions(config: AirtableConfig): Promise<SessionRecord[]> {
  const all = await getAirtableRecords(config, "Sessions");
  return all
    .filter((r) => selectName(r.fields?.["Session Lifecycle Status"]) === "Active")
    .map((r) => ({ id: r.id, fields: r.fields || {} }));
}

export async function fetchSessionDatesForSession(config: AirtableConfig, sessionRecordId: string): Promise<SessionDateRecord[]> {
  const all = await getAirtableRecords(config, "Session Dates");
  return all
    .filter((r) => Array.isArray(r.fields?.Session) && r.fields.Session.includes(sessionRecordId))
    .map((r) => ({ id: r.id, fields: r.fields || {} }));
}

/**
 * Derives the Occurrence Key an existing row effectively has, WITHOUT
 * ever writing it back - this is purely an in-memory reconciliation so
 * the pure generator's idempotency check works correctly against rows
 * hand-seeded before the Occurrence Key field existed (see TEST-ENV.md,
 * Slice 3 - the five real TEST-A rows this was checked against).
 *
 *  - An explicit Occurrence Key value already present -> used as-is.
 *  - A row with an incoming "From field: Replacement Occurrence" link
 *    (it IS a reschedule replacement landing here) -> the :R: shape, at
 *    ITS OWN Date, naming the origin it replaced.
 *  - Anything else (a plain occurrence, OR an origin that was later
 *    moved away via an outgoing "Replacement Occurrence" link) -> the
 *    standard key at ITS OWN Date. An origin keeps owning the standard
 *    slot for the date it was originally scheduled on even after being
 *    flagged Postponed/Cancelled and pointed at a replacement - it is
 *    still the historical record of what stood at that slot.
 */
export function deriveOccurrenceKey(sessionRecordId: string, occ: { id: string; fields: Record<string, any> }): string {
  const explicit = occ.fields["Occurrence Key"];
  if (typeof explicit === "string" && explicit) return explicit;

  const dateIso = typeof occ.fields["Date"] === "string" ? occ.fields["Date"] : "";

  const incomingReplacementLink = occ.fields["From field: Replacement Occurrence"];
  if (Array.isArray(incomingReplacementLink) && incomingReplacementLink.length > 0) {
    const originId = incomingReplacementLink[0];
    return computeReplacementOccurrenceKey(sessionRecordId, dateIso, originId);
  }

  return computeOccurrenceKey(sessionRecordId, dateIso);
}

export async function fetchExistingOccurrencesForSession(config: AirtableConfig, sessionRecordId: string): Promise<ExistingOccurrenceRecord[]> {
  const all = await getAirtableRecords(config, "Session Occurrences");
  return all
    .filter((r) => Array.isArray(r.fields?.Session) && r.fields.Session.includes(sessionRecordId))
    .map((r) => {
      const fields = { ...(r.fields || {}) };
      const key = deriveOccurrenceKey(sessionRecordId, { id: r.id, fields });
      // In-memory only, per the file header - nothing is ever written
      // back to this row because of this derivation.
      return { id: r.id, fields: { ...fields, "Occurrence Key": key } };
    });
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-02" -> "2 Nov 2026", matching the existing hand-seeded Occurrence Name convention ("Monday Juniors (TEST A) - 28 Sep 2026"). */
export function formatDisplayDate(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return dateIso;
  const day = parseInt(m[3], 10);
  const month = MONTH_ABBR[parseInt(m[2], 10) - 1] || "";
  return `${day} ${month} ${m[1]}`;
}

/**
 * Maps one generator-produced shell to the exact Airtable fields to
 * create. Deliberately omits Venue, Capacity Override, Confirmation
 * State and Register State - all left blank so Airtable's own
 * fallback-to-Session-default resolves them at read time, per the
 * ratified snapshot model (matches every existing hand-seeded row,
 * which is also blank on all four).
 *
 * Occurrence ID reuses the Occurrence Key (approved decision, see
 * TEST-ENV.md - Slice 3): a generator-created row's Occurrence ID is an
 * internal stable identifier, not something the UI needs to present, so
 * there is no separate sequential numbering scheme to maintain or race
 * against the hand-seeded OCC-TEST-A-0N rows.
 */
export function buildOccurrenceCreatePayload(shell: OccurrenceShell, session: SessionRecord): Record<string, unknown> {
  const sessionName = typeof session.fields["Session Name"] === "string" ? session.fields["Session Name"] : "";
  return {
    Session: [shell.sessionRecordId],
    Date: shell.date,
    "Start Date & Time": shell.startDateTime,
    "End Date & Time": shell.endDateTime,
    Status: shell.status,
    "Occurrence Key": shell.occurrenceKey,
    "Occurrence ID": shell.occurrenceKey,
    "Occurrence Name": `${sessionName} - ${formatDisplayDate(shell.date)}`,
  };
}

/**
 * The only write this repository ever performs: create brand-new
 * Session Occurrences rows from generator shells. Never touches an
 * existing row - there is no update/cancel path in this file at all.
 * Returns the exact record IDs created, in order, so a TEST run can be
 * rolled back precisely (see TEST-ENV.md - Slice 3, Amendment 4) rather
 * than relying on a Created-timestamp cutoff that could also catch an
 * unrelated legitimate record made in the same window.
 */
export async function createOccurrences(
  config: AirtableConfig,
  shells: OccurrenceShell[],
  session: SessionRecord
): Promise<{ created: number; recordIds: string[] }> {
  if (shells.length === 0) return { created: 0, recordIds: [] };
  const records = shells.map((shell) => ({ fields: buildOccurrenceCreatePayload(shell, session) }));
  const recordIds = await airtableBatchCreate(config, "Session Occurrences", records);
  return { created: recordIds.length, recordIds };
}
