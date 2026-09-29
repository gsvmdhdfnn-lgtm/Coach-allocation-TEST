/**
 * Finance occurrence billing repository (Finance Foundation F4; see
 * TEST-ENV.md "Finance Foundation - F4").
 *
 * Read pattern (a fixed number of requests per call - never one per
 * occurrence):
 *   - one occurrence:  1 filtered read of Session Occurrences by Occurrence
 *                      ID, then 1 Session read + 1 filtered override read
 *                      in parallel;
 *   - session range:   1 filtered Sessions read by Session ID, 1 filtered
 *                      Session Occurrences read for that Session and date
 *                      window, then 1 override read per 40 occurrences;
 *   - plus the F3 commercial snapshot (4 parallel table reads) and F1 auth.
 * Every formula only narrows the read; the orchestrator re-checks each row
 * (exact id, session link, date, organisation) in code. Values placed in a
 * formula are pattern-checked first, so they can never alter it.
 *
 * Schedule tables are READ ONLY here. The only Finance writes are to the
 * override table, through the F3 create/patch/compensating-delete helpers.
 */
import type { AirtableConfig } from "./repository.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { RECORD_ID_RE, airtableFetch, expectOk, tableUrl } from "./finance-commercial-repository.ts";
import { BILLING_TABLES, FB } from "./finance-billing-mapping.ts";
import { OCCURRENCE_ID_PATTERN, SESSION_ID_PATTERN } from "./finance-billing.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { dayBefore } from "./finance-commercial.ts";
import { dayAfter } from "./finance-lifecycle.ts";

/** Occurrence ids per override read (keeps the formula well inside URL limits). */
export const OVERRIDE_READ_CHUNK = 40;

async function listByFormula(config: AirtableConfig, table: string, formula: string): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, table));
    url.searchParams.set("filterByFormula", formula);
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${table}`);
    for (const r of data.records || []) rows.push({ id: r.id, fields: r.fields || {} });
    offset = data.offset || "";
  } while (offset);
  return rows;
}

const field = (name: string) => `{${name}}`;

export async function findOccurrenceRows(config: AirtableConfig, occurrenceId: string): Promise<Row[]> {
  if (!OCCURRENCE_ID_PATTERN.test(occurrenceId)) throw new Error("Occurrence lookup refused: id is malformed");
  const rows = await listByFormula(config, BILLING_TABLES.occurrences, `${field(FB.occurrence.id)}='${occurrenceId}'`);
  return rows.filter((r) => r.fields[FB.occurrence.id] === occurrenceId);
}

export async function findSessionRowsById(config: AirtableConfig, sessionId: string): Promise<Row[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("Session lookup refused: id is malformed");
  const rows = await listByFormula(config, BILLING_TABLES.sessions, `${field(FB.session.id)}='${sessionId}'`);
  return rows.filter((r) => r.fields[FB.session.id] === sessionId);
}

/** One Session by record id (null = no such record). */
export async function getSessionRow(config: AirtableConfig, recordId: string): Promise<Row | null> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("Session read refused: record id is malformed");
  const res = await airtableFetch(`${tableUrl(config, BILLING_TABLES.sessions)}/${recordId}`, { headers: { Authorization: `Bearer ${config.token}` } });
  if (res.status === 404) {
    await res.text();
    return null;
  }
  const rec = await expectOk(res, `Airtable read of ${BILLING_TABLES.sessions}`);
  return { id: rec.id, fields: rec.fields || {} };
}

/**
 * The occurrences linked to `sessionRecordId` dated from..to. The formula
 * window is one day wider on each side (date-field time-zone slack); rows
 * are re-checked exactly here.
 */
export async function listSessionOccurrenceRows(config: AirtableConfig, session: { recordId: string; sessionId: string }, from: string, to: string): Promise<Row[]> {
  if (!SESSION_ID_PATTERN.test(session.sessionId) || !RECORD_ID_RE.test(session.recordId)) throw new Error("Occurrence range read refused: session is malformed");
  if (!isIsoDate(from) || !isIsoDate(to)) throw new Error("Occurrence range read refused: dates are malformed");
  const d = field(FB.occurrence.date);
  const formula = `AND(ARRAYJOIN(${field(FB.occurrence.session)})='${session.sessionId}',IS_AFTER(${d},'${dayBefore(from)}'),IS_BEFORE(${d},'${dayAfter(to)}'))`;
  const rows = await listByFormula(config, BILLING_TABLES.occurrences, formula);
  return rows.filter((r) => {
    const link = r.fields[FB.occurrence.session];
    const date = r.fields[FB.occurrence.date];
    return Array.isArray(link) && link.includes(session.recordId) && typeof date === "string" && date >= from && date <= to;
  });
}

/** Every override row (active and historical) for these occurrences in the caller's organisation. */
export async function listOverrideRows(config: AirtableConfig, organisationRecordId: string, occurrenceIds: readonly string[]): Promise<Row[]> {
  if (!RECORD_ID_RE.test(organisationRecordId)) throw new Error("Override lookup refused: organisation record id is malformed");
  const ids = [...new Set(occurrenceIds)];
  if (ids.some((id) => !OCCURRENCE_ID_PATTERN.test(id))) throw new Error("Override lookup refused: occurrence id is malformed");
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += OVERRIDE_READ_CHUNK) chunks.push(ids.slice(i, i + OVERRIDE_READ_CHUNK));
  const results = await Promise.all(
    chunks.map((c) => listByFormula(config, BILLING_TABLES.overrides, `OR(${c.map((id) => `${field(FB.override.occurrenceId)}='${id}'`).join(",")})`))
  );
  return results.flat().filter((r) => {
    const org = r.fields[FB.org];
    return Array.isArray(org) && org.includes(organisationRecordId) && ids.includes(r.fields[FB.override.occurrenceId]);
  });
}
