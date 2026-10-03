/**
 * Settings & System overview read model (Settings / Config S1-a).
 *
 * Organisation Management configuration only - not Platform Admin. A small,
 * calm, read-only summary:
 *   - the caller's organisation (name + timezone);
 *   - the modules a manager should know about: the core modules (always on,
 *     never switches) and the genuinely optional ones (Finance today);
 *   - connection health read from Finance's own connection records
 *     (Finance still owns connecting / disconnecting);
 *   - one overall system status.
 *
 * Never returned: Airtable record ids, raw Feature Controls rows, secret /
 * Vault ids, client ids, tenant / account / spreadsheet ids, Finance
 * configuration, Needs Attention thresholds. Nothing here is editable in
 * S1-a ("editable": false everywhere).
 *
 * Pure: no network; the router supplies the rows.
 */
import {
  type ConfigRow,
  type ModuleReason,
  type OrganisationContext,
  MODULES,
  getModuleState,
  todayIn,
} from "../_shared/organisation-context.ts";

export type ConnectionStatus = "connected" | "disconnected" | "not_connected" | "unknown";

/** Only the health columns of each Finance connection table are ever selected. */
export interface XeroConnectionRow { status?: string | null; last_success_at?: string | null; last_error_at?: string | null; last_error_code?: string | null }
export type StripeConnectionRow = XeroConnectionRow;
export interface SheetsConnectionRow { connection_state?: string | null; last_sync_result?: string | null; last_sync_success_at?: string | null; last_sync_error_code?: string | null }

export const XERO_HEALTH_COLUMNS = "status,last_success_at,last_error_at,last_error_code";
export const STRIPE_HEALTH_COLUMNS = "status,last_success_at,last_error_at,last_error_code";
export const SHEETS_HEALTH_COLUMNS = "connection_state,last_sync_result,last_sync_success_at,last_sync_error_code";

export interface ConnectionHealth {
  provider: "xero" | "stripe" | "google_sheets";
  label: string;
  status: ConnectionStatus;
  lastSuccessAt: string | null;
  /** Only when the latest outcome was a failure; a recovered error is not shown. */
  lastErrorCode: string | null;
  needsAttention: boolean;
  managedIn: "finance";
}

export interface ModuleSummary {
  key: string;
  label: string;
  kind: "core" | "optional";
  enabled: boolean;
  editable: false;
  reason: ModuleReason;
}

export interface SettingsSystemOverview {
  organisation: { id: string; displayName: string; timezone: string };
  modules: ModuleSummary[];
  connections: ConnectionHealth[];
  system: { status: "healthy" | "attention"; today: string };
}

function iso(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function statusOf(raw: unknown): ConnectionStatus {
  return raw === "connected" ? "connected" : raw === "disconnected" ? "disconnected" : "unknown";
}

function credentialHealth(provider: "xero" | "stripe", label: string, rows: XeroConnectionRow[]): ConnectionHealth {
  if (rows.length === 0) return { provider, label, status: "not_connected", lastSuccessAt: null, lastErrorCode: null, needsAttention: false, managedIn: "finance" };
  if (rows.length > 1) return { provider, label, status: "unknown", lastSuccessAt: null, lastErrorCode: null, needsAttention: true, managedIn: "finance" };
  const r = rows[0];
  const status = statusOf(r.status);
  const lastSuccessAt = iso(r.last_success_at);
  const lastErrorAt = iso(r.last_error_at);
  const failingNow = status === "connected" && !!lastErrorAt && (!lastSuccessAt || Date.parse(lastErrorAt) > Date.parse(lastSuccessAt));
  return {
    provider,
    label,
    status,
    lastSuccessAt,
    lastErrorCode: failingNow ? (iso(r.last_error_code) ?? "unknown_error") : null,
    needsAttention: failingNow || status === "unknown",
    managedIn: "finance",
  };
}

function sheetsHealth(rows: SheetsConnectionRow[]): ConnectionHealth {
  const label = "Google Sheets reporting";
  if (rows.length === 0) return { provider: "google_sheets", label, status: "not_connected", lastSuccessAt: null, lastErrorCode: null, needsAttention: false, managedIn: "finance" };
  if (rows.length > 1) return { provider: "google_sheets", label, status: "unknown", lastSuccessAt: null, lastErrorCode: null, needsAttention: true, managedIn: "finance" };
  const r = rows[0];
  const status = statusOf(r.connection_state);
  const failingNow = status === "connected" && r.last_sync_result === "failed";
  return {
    provider: "google_sheets",
    label,
    status,
    lastSuccessAt: iso(r.last_sync_success_at),
    lastErrorCode: failingNow ? (iso(r.last_sync_error_code) ?? "unknown_error") : null,
    needsAttention: failingNow || status === "unknown",
    managedIn: "finance",
  };
}

export function buildSettingsSystemOverview(input: {
  context: OrganisationContext;
  featureRows: ConfigRow[];
  xero: XeroConnectionRow[];
  stripe: StripeConnectionRow[];
  sheets: SheetsConnectionRow[];
  now?: Date;
}): SettingsSystemOverview {
  const { context } = input;
  const modules: ModuleSummary[] = MODULES.filter((m) => m.userFacing && m.kind !== "unavailable").map((m) => {
    const state = getModuleState(input.featureRows, m.key);
    return { key: m.key, label: m.label, kind: m.kind as "core" | "optional", enabled: state.enabled, editable: false, reason: state.reason };
  });
  const connections = [
    credentialHealth("xero", "Xero", input.xero),
    credentialHealth("stripe", "Stripe", input.stripe),
    sheetsHealth(input.sheets),
  ];
  return {
    organisation: { id: context.organisationId, displayName: context.displayName, timezone: context.timezone },
    modules,
    connections,
    system: { status: connections.some((c) => c.needsAttention) ? "attention" : "healthy", today: todayIn(context, input.now) },
  };
}

/** Request parameters that try to choose an organisation are refused, never honoured. */
export const ORGANISATION_PARAMETERS = ["organisation", "organisation_id", "organisationId", "org", "org_id", "tenant", "tenant_id"];
export function organisationParameterIn(params: URLSearchParams): string | null {
  for (const p of ORGANISATION_PARAMETERS) if (params.has(p)) return p;
  return null;
}
