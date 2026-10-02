/**
 * Test-suite copy of the canonical finance/finance-reporting-sheets-repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts; ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Google Sheets reporting writer - storage (Finance Foundation F19; see
 * TEST-ENV.md "Finance Foundation - F19"). Supabase only (service role,
 * PostgREST); every table RLS on with no client grants:
 *
 *   finance_reporting_connections  one reporting destination per organisation
 *                                  per provider: provider, auth_mode, endpoint,
 *                                  spreadsheet_id (unique across organisations
 *                                  while connected), display name, schema
 *                                  version, state, last verified / sync. It
 *                                  holds NO credential or token.
 *   finance_reporting_sync_runs    append-only compact sync history: one row
 *                                  per Management-triggered sync, inserted
 *                                  'running' and completed exactly once
 *                                  (succeeded / failed) - never edited after,
 *                                  never deleted. No Finance rows are copied.
 *
 * Writes go ONLY through database functions (atomic with their audit event):
 *   finance_reporting_configure / _disconnect / _sync_start / _sync_finish.
 *   finance_reporting_secret(endpoint) reads the PLATFORM connector
 *   credential from Vault (service role only) - never per organisation,
 *   never returned to a client, never audited.
 */
import type { GrantStoreConfig } from "./finance-repository.ts";
import { type AuthMode, type Endpoint, type ReportingConnection, type SyncRun, AUTH_MODES, ENDPOINTS, PROVIDER, RUN_ID_PATTERN, SPREADSHEET_ID_PATTERN } from "./finance-reporting-sheets.ts";

export const CONNECTIONS_TABLE = "finance_reporting_connections";
export const RUNS_TABLE = "finance_reporting_sync_runs";
export const RPC = {
  configure: "finance_reporting_configure",
  disconnect: "finance_reporting_disconnect",
  syncStart: "finance_reporting_sync_start",
  syncFinish: "finance_reporting_sync_finish",
  secret: "finance_reporting_secret",
} as const;
export const RECENT_RUNS = 10;

const CONN_COLUMNS = "organisation_id,provider,auth_mode,endpoint,spreadsheet_id,display_name,schema_version,connection_state,last_verified_at,last_sync_attempt_at,last_sync_success_at,last_sync_result,last_sync_error_code,config_revision,created_at,created_by,updated_at,updated_by";
const RUN_COLUMNS = "run_id,organisation_id,provider,endpoint,spreadsheet_id,requested_month,modes,schema_version,writer_version,actor_user_id,started_at,completed_at,result,row_counts,control_totals,error_code,error_summary";

function headers(svc: GrantStoreConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json", ...extra };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;
async function ok(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const s = (v: unknown) => (typeof v === "string" && v ? v : null);

export function connectionFromRow(r: Record<string, any>): ReportingConnection {
  if (r.provider !== PROVIDER) throw new Error("finance_reporting_connections: invalid provider");
  if (!(AUTH_MODES as readonly string[]).includes(r.auth_mode)) throw new Error("finance_reporting_connections: invalid auth_mode");
  if (!(ENDPOINTS as readonly string[]).includes(r.endpoint)) throw new Error("finance_reporting_connections: invalid endpoint");
  if (!SPREADSHEET_ID_PATTERN.test(String(r.spreadsheet_id))) throw new Error("finance_reporting_connections: invalid spreadsheet_id");
  if (r.connection_state !== "connected" && r.connection_state !== "disconnected") throw new Error("finance_reporting_connections: invalid connection_state");
  if (!Number.isInteger(r.config_revision) || r.config_revision < 1) throw new Error("finance_reporting_connections: invalid config_revision");
  return {
    organisationId: r.organisation_id,
    provider: PROVIDER,
    authMode: r.auth_mode as AuthMode,
    endpoint: r.endpoint as Endpoint,
    spreadsheetId: r.spreadsheet_id,
    displayName: s(r.display_name),
    schemaVersion: r.schema_version,
    state: r.connection_state,
    lastVerifiedAt: s(r.last_verified_at),
    lastSyncAttemptAt: s(r.last_sync_attempt_at),
    lastSyncSuccessAt: s(r.last_sync_success_at),
    lastSyncResult: r.last_sync_result === "succeeded" || r.last_sync_result === "failed" ? r.last_sync_result : null,
    lastSyncErrorCode: s(r.last_sync_error_code),
    revision: r.config_revision,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export function runFromRow(r: Record<string, any>): SyncRun {
  if (!RUN_ID_PATTERN.test(String(r.run_id))) throw new Error("finance_reporting_sync_runs: invalid run_id");
  if (!["running", "succeeded", "failed"].includes(r.result)) throw new Error("finance_reporting_sync_runs: invalid result");
  return {
    runId: r.run_id,
    organisationId: r.organisation_id,
    provider: r.provider,
    endpoint: r.endpoint,
    spreadsheetId: r.spreadsheet_id,
    month: r.requested_month,
    modes: Array.isArray(r.modes) ? r.modes : [],
    schemaVersion: r.schema_version,
    writerVersion: r.writer_version,
    actorUserId: r.actor_user_id,
    startedAt: r.started_at,
    completedAt: s(r.completed_at),
    result: r.result,
    rowCounts: r.row_counts ?? null,
    controlTotals: r.control_totals ?? null,
    errorCode: s(r.error_code),
    errorSummary: s(r.error_summary),
  };
}

/** This organisation's Google Sheets destination (or null). */
export async function loadConnection(svc: GrantStoreConfig, organisationId: string): Promise<ReportingConnection | null> {
  const rows = await ok(await fetch(`${rest(svc, CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&provider=${eq(PROVIDER)}&select=${CONN_COLUMNS}`, { headers: headers(svc) }), "Reporting connection read");
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Reporting connection read returned an unexpected shape");
  if (!rows.length) return null;
  if (rows[0].organisation_id !== organisationId) throw new Error("Reporting connection read returned another organisation's row");
  return connectionFromRow(rows[0]);
}

/** Whether ANOTHER organisation has this workbook connected (workbook ids are unique across organisations). */
export async function workbookConnectedElsewhere(svc: GrantStoreConfig, organisationId: string, spreadsheetId: string): Promise<boolean> {
  const rows = await ok(await fetch(`${rest(svc, CONNECTIONS_TABLE)}?provider=${eq(PROVIDER)}&spreadsheet_id=${eq(spreadsheetId)}&connection_state=eq.connected&select=organisation_id`, { headers: headers(svc) }), "Reporting workbook ownership read");
  if (!Array.isArray(rows)) throw new Error("Reporting workbook ownership read returned an unexpected shape");
  return rows.some((r) => r.organisation_id !== organisationId);
}

export async function listRuns(svc: GrantStoreConfig, organisationId: string, limit = RECENT_RUNS): Promise<SyncRun[]> {
  const rows = await ok(await fetch(`${rest(svc, RUNS_TABLE)}?organisation_id=${eq(organisationId)}&select=${RUN_COLUMNS}&order=started_at.desc,run_id.desc&limit=${limit}`, { headers: headers(svc) }), "Reporting sync history read");
  if (!Array.isArray(rows)) throw new Error("Reporting sync history read returned an unexpected shape");
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error("Reporting sync history read returned another organisation's row");
  return rows.map(runFromRow);
}

/** The latest succeeded run (bounded: one row). */
export async function lastSucceededRun(svc: GrantStoreConfig, organisationId: string): Promise<SyncRun | null> {
  const rows = await ok(await fetch(`${rest(svc, RUNS_TABLE)}?organisation_id=${eq(organisationId)}&result=eq.succeeded&select=${RUN_COLUMNS}&order=started_at.desc,run_id.desc&limit=1`, { headers: headers(svc) }), "Reporting last success read");
  if (!Array.isArray(rows)) throw new Error("Reporting last success read returned an unexpected shape");
  return rows.length && rows[0].organisation_id === organisationId ? runFromRow(rows[0]) : null;
}

export type RpcRefusal = { refused: string };
async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<unknown | RpcRefusal> {
  const res = await fetch(rest(svc, `rpc/${fn}`), { method: "POST", headers: headers(svc), body: JSON.stringify(args) });
  if (res.status === 400 || res.status === 409) {
    const t = await res.text();
    const m = /f19:([a-z_]+)/.exec(t);
    if (m) return { refused: m[1] };
    throw new Error(`Supabase RPC ${fn} failed: ${res.status} ${t}`);
  }
  return ok(res, `Supabase RPC ${fn}`);
}
export const isRefusal = (x: unknown): x is RpcRefusal => !!x && typeof x === "object" && typeof (x as RpcRefusal).refused === "string";

/** Insert or update the destination + its audit event, atomically. Refusals: connection_changed, workbook_in_use. */
export async function saveConnection(svc: GrantStoreConfig, a: { organisationId: string; actor: string; expectedRevision: number | null; connection: { auth_mode: AuthMode; endpoint: Endpoint; spreadsheet_id: string; display_name: string | null; schema_version: string; last_verified_at: string; at: string }; event: Record<string, unknown> }): Promise<ReportingConnection | RpcRefusal> {
  const r = await rpc(svc, RPC.configure, { p_organisation_id: a.organisationId, p_actor: a.actor, p_expected_revision: a.expectedRevision, p_connection: a.connection, p_event: a.event });
  return isRefusal(r) ? r : connectionFromRow(r as Record<string, any>);
}

export async function disconnect(svc: GrantStoreConfig, a: { organisationId: string; actor: string; expectedRevision: number; at: string; event: Record<string, unknown> }): Promise<ReportingConnection | RpcRefusal> {
  const r = await rpc(svc, RPC.disconnect, { p_organisation_id: a.organisationId, p_actor: a.actor, p_expected_revision: a.expectedRevision, p_at: a.at, p_event: a.event });
  return isRefusal(r) ? r : connectionFromRow(r as Record<string, any>);
}

/** Records the attempt ('running') before anything is written to the workbook. */
export async function startRun(svc: GrantStoreConfig, run: { run_id: string; organisation_id: string; provider: string; endpoint: Endpoint; spreadsheet_id: string; requested_month: string; modes: string[]; schema_version: string; writer_version: string; actor_user_id: string; started_at: string }): Promise<string | RpcRefusal> {
  const r = await rpc(svc, RPC.syncStart, { p_run: run });
  return isRefusal(r) ? r : String(r);
}

/** Completes the run exactly once + the connection's last-sync fields + the audit event, atomically. */
export async function finishRun(svc: GrantStoreConfig, a: { runId: string; result: "succeeded" | "failed"; completedAt: string; rowCounts: Record<string, unknown> | null; controlTotals: Record<string, unknown> | null; errorCode: string | null; errorSummary: string | null; event: Record<string, unknown> }): Promise<SyncRun | RpcRefusal> {
  const r = await rpc(svc, RPC.syncFinish, { p_run_id: a.runId, p_result: a.result, p_completed_at: a.completedAt, p_row_counts: a.rowCounts, p_control_totals: a.controlTotals, p_error_code: a.errorCode, p_error_summary: a.errorSummary, p_event: a.event });
  return isRefusal(r) ? r : runFromRow(r as Record<string, any>);
}

/** The PLATFORM connector credential for an endpoint (Vault, service role only); null when not provisioned. */
export async function readConnectorSecret(svc: GrantStoreConfig, endpoint: Endpoint): Promise<string | null> {
  const r = await rpc(svc, RPC.secret, { p_endpoint: endpoint });
  return typeof r === "string" && r ? r : null;
}
