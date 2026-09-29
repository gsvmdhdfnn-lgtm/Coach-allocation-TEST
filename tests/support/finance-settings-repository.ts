/**
 * Test-suite copy of the canonical finance/finance-settings-repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * finance-settings.test.ts). Only import paths adjusted:
 * ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Finance Settings repository (Finance Foundation F2; see TEST-ENV.md
 * "Finance Foundation - F2"). The only Finance code that writes anything.
 * F1's repository.ts stays read-only and unchanged.
 *
 *   - Airtable (transitional operational storage): the TEST table
 *     "Finance Settings" - one row per organisation, owned through its
 *     "Organisation" link to Organisation & Branding. Read, create, patch;
 *     delete ONLY as the compensating undo of a row this same request
 *     created when the audit write then failed.
 *   - Supabase (service role, PostgREST): append-only
 *     public.finance_audit_events inserts, and the per-organisation
 *     finance_settings_locks acquire/release RPCs. Both have RLS on and no
 *     anon/authenticated access.
 *
 * Portable (fetch only, explicit configs) so it runs under Node tests with a
 * mocked global fetch and under Deno. Same 429 retry as the other TEST
 * repositories - copied, not shared.
 */
import type { AirtableConfig, GrantStoreConfig } from "./finance-repository.ts";
import { type FinanceAuditEvent, type StoredSettingsRow, SETTINGS_TABLE, STORED } from "./finance-settings.ts";

export const AUDIT_TABLE = "finance_audit_events";
export const LOCK_ACQUIRE_RPC = "acquire_finance_settings_lock";
export const LOCK_RELEASE_RPC = "release_finance_settings_lock";

export const SETTINGS_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function airtableFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= SETTINGS_RETRY_DELAYS_MS.length) return res;
    await res.text();
    await sleep(SETTINGS_RETRY_DELAYS_MS[attempt]);
  }
}

function tableUrl(config: AirtableConfig): string {
  return `https://api.airtable.com/v0/${config.baseId}/${encodeURIComponent(SETTINGS_TABLE)}`;
}

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

async function expectOk(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Every Finance Settings row whose Organisation link includes this
 * organisation's Organisation & Branding record. The caller decides what
 * 0 / 1 / many means; a row linking several organisations is returned too
 * (and rejected by the caller) rather than hidden.
 */
export async function loadSettingsRows(config: AirtableConfig, organisationRecordId: string): Promise<StoredSettingsRow[]> {
  if (!RECORD_ID_RE.test(organisationRecordId)) throw new Error("Finance Settings lookup refused: organisation record id is malformed");
  const rows: StoredSettingsRow[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config));
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${SETTINGS_TABLE}`);
    for (const r of data.records || []) {
      const link = r.fields?.[STORED.organisation];
      if (Array.isArray(link) && link.includes(organisationRecordId)) rows.push({ id: r.id, fields: r.fields || {} });
    }
    offset = data.offset || "";
  } while (offset);
  return rows;
}

export async function createSettingsRow(config: AirtableConfig, fields: Record<string, unknown>): Promise<StoredSettingsRow> {
  const res = await airtableFetch(tableUrl(config), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  const data = await expectOk(res, `Airtable create in ${SETTINGS_TABLE}`);
  const rec = data.records?.[0];
  if (!rec || !RECORD_ID_RE.test(rec.id)) throw new Error(`Airtable create in ${SETTINGS_TABLE} returned no record`);
  return { id: rec.id, fields: rec.fields || {} };
}

export async function patchSettingsRow(config: AirtableConfig, recordId: string, fields: Record<string, unknown>): Promise<StoredSettingsRow> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("Finance Settings patch refused: record id is malformed");
  const res = await airtableFetch(`${tableUrl(config)}/${recordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: false }),
  });
  const rec = await expectOk(res, `Airtable patch in ${SETTINGS_TABLE}`);
  return { id: rec.id, fields: rec.fields || {} };
}

/** Compensation only: removes a row THIS request created when its audit event could not be written. */
export async function deleteCreatedSettingsRow(config: AirtableConfig, recordId: string): Promise<void> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("Finance Settings delete refused: record id is malformed");
  const res = await airtableFetch(`${tableUrl(config)}/${recordId}`, { method: "DELETE", headers: { Authorization: `Bearer ${config.token}` } });
  await expectOk(res, `Airtable compensating delete in ${SETTINGS_TABLE}`);
}

function serviceHeaders(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}

function restUrl(svc: GrantStoreConfig, path: string): string {
  return `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
}

/** Appends one audit event; returns its id. occurred_at is set by the database, never by this code. */
export async function insertAuditEvent(svc: GrantStoreConfig, event: FinanceAuditEvent): Promise<string> {
  const res = await fetch(`${restUrl(svc, AUDIT_TABLE)}?select=id`, {
    method: "POST",
    headers: { ...serviceHeaders(svc), Prefer: "return=representation" },
    body: JSON.stringify(event),
  });
  const rows = await expectOk(res, "Finance audit insert");
  const id = Array.isArray(rows) ? rows[0]?.id : null;
  if (typeof id !== "string" || !id) throw new Error("Finance audit insert returned no id");
  return id;
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(restUrl(svc, `rpc/${fn}`), { method: "POST", headers: serviceHeaders(svc), body: JSON.stringify(args) });
  return expectOk(res, `Supabase RPC ${fn}`);
}

/** A lock token this call now owns, or null when another write for this organisation is in flight. */
export async function acquireSettingsLock(svc: GrantStoreConfig, organisationId: string): Promise<string | null> {
  const r = await rpc(svc, LOCK_ACQUIRE_RPC, { p_organisation_id: organisationId });
  return typeof r === "string" && r ? r : null;
}

export async function releaseSettingsLock(svc: GrantStoreConfig, organisationId: string, token: string): Promise<boolean> {
  return (await rpc(svc, LOCK_RELEASE_RPC, { p_organisation_id: organisationId, p_lock_token: token })) === true;
}
