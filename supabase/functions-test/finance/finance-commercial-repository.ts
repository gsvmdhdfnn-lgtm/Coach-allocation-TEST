/**
 * Finance commercial setup repository (Finance Foundation F3; see TEST-ENV.md
 * "Finance Foundation - F3").
 *
 *   - Airtable (transitional operational storage, TEST only): the four
 *     tables in TABLES (finance-commercial-mapping.ts; the lifecycle table
 *     since F4). Rows are listed per
 *     organisation (the row's Organisation link must include the caller's
 *     Organisation & Branding record); create and patch only; delete ONLY as
 *     the compensating undo of a row created by the same request.
 *   - Supabase (service role, PostgREST): F2's append-only
 *     public.finance_audit_events - inserted as ONE array POST per request so
 *     the events of a multi-entity write land together or not at all - and
 *     the generic finance_write_locks acquire/release RPCs.
 *
 * Portable (fetch only). Same 429 retry as the other TEST repositories -
 * copied, not shared.
 */
import type { AirtableConfig, GrantStoreConfig } from "./repository.ts";
import type { AuditEvent } from "./finance-commercial.ts";
import { type Row, F, TABLES } from "./finance-commercial-mapping.ts";

export const AUDIT_TABLE = "finance_audit_events";
export const WRITE_LOCK_ACQUIRE_RPC = "acquire_finance_write_lock";
export const WRITE_LOCK_RELEASE_RPC = "release_finance_write_lock";

export const COMMERCIAL_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** A Finance-owned table (F3 TABLES, or the F4 billing override table). */
export type Table = string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function airtableFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= COMMERCIAL_RETRY_DELAYS_MS.length) return res;
    await res.text();
    await sleep(COMMERCIAL_RETRY_DELAYS_MS[attempt]);
  }
}

export const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
export const tableUrl = (c: AirtableConfig, t: Table) => `https://api.airtable.com/v0/${c.baseId}/${encodeURIComponent(t)}`;

export async function expectOk(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Every row of `table` whose Organisation link includes the caller's organisation record. */
export async function listForOrganisation(config: AirtableConfig, table: Table, organisationRecordId: string): Promise<Row[]> {
  if (!RECORD_ID_RE.test(organisationRecordId)) throw new Error("Commercial lookup refused: organisation record id is malformed");
  const rows: Row[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, table));
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${table}`);
    for (const r of data.records || []) {
      const link = r.fields?.[F.org];
      if (Array.isArray(link) && link.includes(organisationRecordId)) rows.push({ id: r.id, fields: r.fields || {} });
    }
    offset = data.offset || "";
  } while (offset);
  return rows;
}

export async function loadCommercialRows(config: AirtableConfig, organisationRecordId: string): Promise<{ clients: Row[]; services: Row[]; terms: Row[]; lifecycle: Row[] }> {
  const [clients, services, terms, lifecycle] = await Promise.all([
    listForOrganisation(config, TABLES.clients, organisationRecordId),
    listForOrganisation(config, TABLES.services, organisationRecordId),
    listForOrganisation(config, TABLES.terms, organisationRecordId),
    listForOrganisation(config, TABLES.lifecycle, organisationRecordId),
  ]);
  return { clients, services, terms, lifecycle };
}

export async function createRow(config: AirtableConfig, table: Table, fields: Record<string, unknown>): Promise<Row> {
  const res = await airtableFetch(tableUrl(config, table), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  const data = await expectOk(res, `Airtable create in ${table}`);
  const rec = data.records?.[0];
  if (!rec || !RECORD_ID_RE.test(rec.id)) throw new Error(`Airtable create in ${table} returned no record`);
  return { id: rec.id, fields: rec.fields || {} };
}

export async function patchRow(config: AirtableConfig, table: Table, recordId: string, fields: Record<string, unknown>): Promise<Row> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("Commercial patch refused: record id is malformed");
  const res = await airtableFetch(`${tableUrl(config, table)}/${recordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: false }),
  });
  const rec = await expectOk(res, `Airtable patch in ${table}`);
  return { id: rec.id, fields: rec.fields || {} };
}

/** Compensation only: removes a row THIS request created when a later step (or its audit) failed. */
export async function deleteCreatedRow(config: AirtableConfig, table: Table, recordId: string): Promise<void> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("Commercial delete refused: record id is malformed");
  const res = await airtableFetch(`${tableUrl(config, table)}/${recordId}`, { method: "DELETE", headers: { Authorization: `Bearer ${config.token}` } });
  await expectOk(res, `Airtable compensating delete in ${table}`);
}

function serviceHeaders(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}

const restUrl = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;

/** Appends all `events` in ONE insert (one statement: all or nothing). occurred_at is the database clock. */
export async function insertAuditEvents(svc: GrantStoreConfig, events: AuditEvent[]): Promise<void> {
  if (!events.length) return;
  const res = await fetch(`${restUrl(svc, AUDIT_TABLE)}?select=id`, {
    method: "POST",
    headers: { ...serviceHeaders(svc), Prefer: "return=representation" },
    body: JSON.stringify(events),
  });
  const rows = await expectOk(res, "Finance audit insert");
  if (!Array.isArray(rows) || rows.length !== events.length) throw new Error("Finance audit insert did not confirm every event");
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(restUrl(svc, `rpc/${fn}`), { method: "POST", headers: serviceHeaders(svc), body: JSON.stringify(args) });
  return expectOk(res, `Supabase RPC ${fn}`);
}

export async function acquireWriteLock(svc: GrantStoreConfig, key: string): Promise<string | null> {
  const r = await rpc(svc, WRITE_LOCK_ACQUIRE_RPC, { p_lock_key: key });
  return typeof r === "string" && r ? r : null;
}

export async function releaseWriteLock(svc: GrantStoreConfig, key: string, token: string): Promise<boolean> {
  return (await rpc(svc, WRITE_LOCK_RELEASE_RPC, { p_lock_key: key, p_lock_token: token })) === true;
}
