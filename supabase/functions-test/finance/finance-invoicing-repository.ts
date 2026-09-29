/**
 * Finance client invoice drafts - repository (Finance Foundation F5; see
 * TEST-ENV.md "Finance Foundation - F5").
 *
 * Read pattern for one client + billing period (a fixed number of
 * requests, bounded by the client's services and the period - NEVER one per
 * occurrence or per line):
 *   1. F1 auth (grants + organisation/feature config) and the F3 commercial
 *      snapshot (4 parallel table reads) + Finance Settings (1 read);
 *   2. Sessions whose Finance Service ID is one of the client's services
 *      (1 read per 40 services);
 *   3. Session Occurrences of those Sessions in the period (1 read per 20
 *      Sessions, date-windowed);
 *   4. F4 overrides for those occurrences (1 read per 40 occurrences);
 *   5. Included draft lines claiming those occurrences, in any draft
 *      (1 read per 40 occurrences);
 *   6. for a draft: the draft row by Draft ID and its lines by Draft ID
 *      (1 read each), or the client's drafts by Client ID (1 read).
 * Every formula only narrows; each row is re-checked in code (exact id,
 * links, date window, organisation). Values placed in a formula are
 * pattern-checked first, so they can never alter it.
 *
 * Writes: draft rows and line rows only (Airtable batches of 10), each
 * registered with its undo; Schedule tables are never written.
 */
import type { AirtableConfig } from "./repository.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { RECORD_ID_RE, airtableFetch, expectOk, tableUrl } from "./finance-commercial-repository.ts";
import { BILLING_TABLES, FB } from "./finance-billing-mapping.ts";
import { OCCURRENCE_ID_PATTERN, SESSION_ID_PATTERN } from "./finance-billing.ts";
import { ID_PATTERNS, dayBefore } from "./finance-commercial.ts";
import { dayAfter } from "./finance-lifecycle.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { CLIENT_ID_PATTERN, DRAFT_ID_PATTERN } from "./finance-invoicing.ts";
import { FI, INVOICING_TABLES } from "./finance-invoicing-mapping.ts";

export const SERVICE_READ_CHUNK = 40;
export const SESSION_READ_CHUNK = 20;
export const CLAIM_READ_CHUNK = 40;
/** Airtable's per-request record limit for create / update / delete. */
export const WRITE_BATCH = 10;

const field = (name: string) => `{${name}}`;

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

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const inOrg = (r: Row, orgRec: string) => Array.isArray(r.fields?.[FI.org]) && r.fields[FI.org].includes(orgRec);

/** Sessions whose Finance Service ID is exactly one of `serviceIds`. */
export async function listSessionsForServices(config: AirtableConfig, serviceIds: readonly string[]): Promise<Row[]> {
  const ids = [...new Set(serviceIds)];
  if (ids.some((id) => !ID_PATTERNS.service.test(id))) throw new Error("Session lookup refused: service id is malformed");
  const results = await Promise.all(chunk(ids, SERVICE_READ_CHUNK).map((c) => listByFormula(config, BILLING_TABLES.sessions, `OR(${c.map((id) => `${field(FB.session.financeServiceId)}='${id}'`).join(",")})`)));
  return results.flat().filter((r) => ids.includes(typeof r.fields[FB.session.financeServiceId] === "string" ? r.fields[FB.session.financeServiceId].trim() : ""));
}

/** Occurrences linked to one of `sessions` dated from..to (formula window one day wider each side; re-checked exactly). */
export async function listOccurrencesForSessions(config: AirtableConfig, sessions: readonly { recordId: string; sessionId: string }[], from: string, to: string): Promise<Row[]> {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new Error("Occurrence range read refused: dates are malformed");
  if (sessions.some((s) => !SESSION_ID_PATTERN.test(s.sessionId) || !RECORD_ID_RE.test(s.recordId))) throw new Error("Occurrence range read refused: session is malformed");
  const d = field(FB.occurrence.date);
  const recs = new Set(sessions.map((s) => s.recordId));
  const results = await Promise.all(
    chunk(sessions, SESSION_READ_CHUNK).map((c) =>
      listByFormula(config, BILLING_TABLES.occurrences, `AND(OR(${c.map((s) => `ARRAYJOIN(${field(FB.occurrence.session)})='${s.sessionId}'`).join(",")}),IS_AFTER(${d},'${dayBefore(from)}'),IS_BEFORE(${d},'${dayAfter(to)}'))`)
    )
  );
  const seen = new Set<string>();
  return results.flat().filter((r) => {
    const link = r.fields[FB.occurrence.session];
    const date = r.fields[FB.occurrence.date];
    const ok = Array.isArray(link) && link.some((l: string) => recs.has(l)) && typeof date === "string" && date >= from && date <= to && !seen.has(r.id);
    if (ok) seen.add(r.id);
    return ok;
  });
}

/** Every Included line (any draft of this organisation) for these occurrences - the claims. */
export async function listIncludedLineRows(config: AirtableConfig, organisationRecordId: string, occurrenceIds: readonly string[]): Promise<Row[]> {
  if (!RECORD_ID_RE.test(organisationRecordId)) throw new Error("Claim lookup refused: organisation record id is malformed");
  const ids = [...new Set(occurrenceIds)];
  if (ids.some((id) => !OCCURRENCE_ID_PATTERN.test(id))) throw new Error("Claim lookup refused: occurrence id is malformed");
  const results = await Promise.all(
    chunk(ids, CLAIM_READ_CHUNK).map((c) => listByFormula(config, INVOICING_TABLES.lines, `AND(${field(FI.line.status)}='Included',OR(${c.map((id) => `${field(FI.line.occurrenceId)}='${id}'`).join(",")}))`))
  );
  return results.flat().filter((r) => inOrg(r, organisationRecordId) && ids.includes(r.fields[FI.line.occurrenceId]) && (r.fields[FI.line.status]?.name ?? r.fields[FI.line.status]) === "Included");
}

export async function findDraftRows(config: AirtableConfig, organisationRecordId: string, draftId: string): Promise<Row[]> {
  if (!DRAFT_ID_PATTERN.test(draftId) || !RECORD_ID_RE.test(organisationRecordId)) throw new Error("Draft lookup refused: id is malformed");
  const rows = await listByFormula(config, INVOICING_TABLES.drafts, `${field(FI.draft.id)}='${draftId}'`);
  return rows.filter((r) => r.fields[FI.draft.id] === draftId && inOrg(r, organisationRecordId));
}

export async function listDraftLineRows(config: AirtableConfig, organisationRecordId: string, draftId: string): Promise<Row[]> {
  if (!DRAFT_ID_PATTERN.test(draftId) || !RECORD_ID_RE.test(organisationRecordId)) throw new Error("Draft line lookup refused: id is malformed");
  const rows = await listByFormula(config, INVOICING_TABLES.lines, `${field(FI.line.draftId)}='${draftId}'`);
  return rows.filter((r) => r.fields[FI.line.draftId] === draftId && inOrg(r, organisationRecordId));
}

export async function listClientDraftRows(config: AirtableConfig, organisationRecordId: string, clientId: string): Promise<Row[]> {
  if (!CLIENT_ID_PATTERN.test(clientId) || !RECORD_ID_RE.test(organisationRecordId)) throw new Error("Draft lookup refused: id is malformed");
  const rows = await listByFormula(config, INVOICING_TABLES.drafts, `${field(FI.draft.clientId)}='${clientId}'`);
  return rows.filter((r) => r.fields[FI.draft.clientId] === clientId && inOrg(r, organisationRecordId));
}

// ----- batched writes -----

const jsonHeaders = (config: AirtableConfig) => ({ Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" });

export async function createRows(config: AirtableConfig, table: string, fieldsList: Record<string, unknown>[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const c of chunk(fieldsList, WRITE_BATCH)) {
    const res = await airtableFetch(tableUrl(config, table), { method: "POST", headers: jsonHeaders(config), body: JSON.stringify({ records: c.map((fields) => ({ fields })), typecast: false }) });
    const data = await expectOk(res, `Airtable create in ${table}`);
    const recs = data.records ?? [];
    if (recs.length !== c.length || recs.some((r: any) => !RECORD_ID_RE.test(r?.id))) throw new Error(`Airtable create in ${table} did not confirm every record`);
    for (const r of recs) out.push({ id: r.id, fields: r.fields || {} });
  }
  return out;
}

export async function patchRows(config: AirtableConfig, table: string, updates: { id: string; fields: Record<string, unknown> }[]): Promise<void> {
  if (updates.some((u) => !RECORD_ID_RE.test(u.id))) throw new Error("Draft patch refused: record id is malformed");
  for (const c of chunk(updates, WRITE_BATCH)) {
    const res = await airtableFetch(tableUrl(config, table), { method: "PATCH", headers: jsonHeaders(config), body: JSON.stringify({ records: c, typecast: false }) });
    const data = await expectOk(res, `Airtable patch in ${table}`);
    if ((data.records ?? []).length !== c.length) throw new Error(`Airtable patch in ${table} did not confirm every record`);
  }
}

/** Compensation only: removes rows THIS request created when a later step (or its audit) failed. */
export async function deleteCreatedRows(config: AirtableConfig, table: string, recordIds: string[]): Promise<void> {
  if (recordIds.some((id) => !RECORD_ID_RE.test(id))) throw new Error("Draft delete refused: record id is malformed");
  for (const c of chunk(recordIds, WRITE_BATCH)) {
    const url = new URL(tableUrl(config, table));
    for (const id of c) url.searchParams.append("records[]", id);
    await expectOk(await airtableFetch(url.toString(), { method: "DELETE", headers: { Authorization: `Bearer ${config.token}` } }), `Airtable compensating delete in ${table}`);
  }
}
