/**
 * Session Occurrence delivery confirmation - Airtable repository (Schedule
 * prerequisite before Finance F5; see TEST-ENV.md). Portable (fetch only,
 * explicit config) so it runs under Node tests with a mocked global fetch
 * and under Deno.
 *
 *   - Session Occurrences: 1 filtered read by Occurrence ID (the formula
 *     only narrows; every row is re-checked for the exact id here), and a
 *     single-record PATCH of the confirmation fields. That PATCH is the
 *     ONLY write this slice makes, and it is one Airtable request - the
 *     confirmation facts and their Confirmed By / At stamps land together
 *     or not at all.
 *   - Organisation & Branding: read to resolve the caller's organisation
 *     (and so its timezone) - read only.
 * Same 429 retry as the other TEST repositories - copied, not shared.
 */
import { OCC_FIELDS, OCCURRENCE_ID_PATTERN } from "./occurrence-confirmation.ts";

export interface AirtableConfig {
  baseId: string;
  token: string;
}

export interface Row {
  id: string;
  fields: Record<string, any>;
}

export const OCCURRENCES_TABLE = "Session Occurrences";
export const ORGANISATIONS_TABLE = "Organisation & Branding";
export const CONFIRMATION_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function airtableFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= CONFIRMATION_RETRY_DELAYS_MS.length) return res;
    await res.text();
    await sleep(CONFIRMATION_RETRY_DELAYS_MS[attempt]);
  }
}

const tableUrl = (c: AirtableConfig, t: string) => `https://api.airtable.com/v0/${c.baseId}/${encodeURIComponent(t)}`;

async function expectOk(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function list(config: AirtableConfig, table: string, formula: string | null): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, table));
    if (formula) url.searchParams.set("filterByFormula", formula);
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${table}`);
    for (const r of data.records || []) rows.push({ id: r.id, fields: r.fields || {} });
    offset = data.offset || "";
  } while (offset);
  return rows;
}

/** Every Session Occurrence whose Occurrence ID is exactly `occurrenceId` (0, 1 or - bad data - several). */
export async function findOccurrenceRows(config: AirtableConfig, occurrenceId: string): Promise<Row[]> {
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId)) throw new Error("Occurrence lookup refused: id is malformed");
  const rows = await list(config, OCCURRENCES_TABLE, `{${OCC_FIELDS.id}}='${occurrenceId}'`);
  return rows.filter((r) => r.fields[OCC_FIELDS.id] === occurrenceId);
}

export async function loadOrganisations(config: AirtableConfig): Promise<Row[]> {
  return list(config, ORGANISATIONS_TABLE, null);
}

/** The single confirmation write: one PATCH of one occurrence record. */
export async function patchOccurrence(config: AirtableConfig, recordId: string, fields: Record<string, unknown>): Promise<Row> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("Occurrence patch refused: record id is malformed");
  const res = await airtableFetch(`${tableUrl(config, OCCURRENCES_TABLE)}/${recordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: false }),
  });
  const rec = await expectOk(res, `Airtable patch in ${OCCURRENCES_TABLE}`);
  return { id: rec.id, fields: rec.fields || {} };
}
