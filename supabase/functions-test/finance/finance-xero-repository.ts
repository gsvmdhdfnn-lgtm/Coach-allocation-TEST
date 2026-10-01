/**
 * Xero connector storage (Finance Foundation F9; see TEST-ENV.md "Finance
 * Foundation - F9"). Supabase only (service role, PostgREST), every table
 * RLS on with no client grants:
 *
 *   finance_external_connections   one row per (organisation, provider):
 *                                  environment, Xero tenant, status, the
 *                                  non-secret mapping (account code, tax
 *                                  types), last success / error. The client
 *                                  SECRET is in Supabase Vault; this row
 *                                  holds only its vault id, which is never
 *                                  selected here.
 *   finance_xero_invoice_links     the connector journal: one row per Hub
 *                                  invoice (primary key), at most one Xero
 *                                  invoice per Hub invoice (unique), stage,
 *                                  idempotency key, external facts, send
 *                                  state, last error, optimistic version.
 *   finance_xero_contact_links     Hub client -> Xero contact (both unique
 *                                  per organisation: one Xero contact can
 *                                  never serve two Hub clients).
 *   rpc finance_xero_client_secret the vault read (service role only).
 *
 * Every row is validated on read; anything unexpected is an error, never
 * guessed.
 */
import type { GrantStoreConfig } from "./repository.ts";
import {
  type ContactLink,
  type InvoiceLink,
  type SendStatus,
  type Stage,
  type XeroConnection,
  type XeroEnvironment,
  ENVIRONMENTS,
  SEND_STATUSES,
  STAGES,
  TAX_KEY_PATTERN,
  TAX_TYPE_PATTERN,
  XERO_ID_PATTERN,
} from "./finance-xero.ts";

export const CONNECTIONS_TABLE = "finance_external_connections";
export const LINKS_TABLE = "finance_xero_invoice_links";
export const CONTACT_LINKS_TABLE = "finance_xero_contact_links";
export const SECRET_RPC = "finance_xero_client_secret";

const CONNECTION_COLUMNS = "organisation_id,provider,environment,status,client_id,tenant_id,tenant_name,connected_at,connected_by,last_success_at,last_error_at,last_error_code,last_error_message,account_code,tax_types,config_revision,config_updated_at,config_updated_by";

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
const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function connectionFromRow(r: Record<string, any>): XeroConnection {
  const env = r.environment as XeroEnvironment;
  if (!ENVIRONMENTS.includes(env)) throw new Error("finance_external_connections: invalid environment");
  if (r.status !== "connected" && r.status !== "disconnected") throw new Error("finance_external_connections: invalid status");
  if (!s(r.client_id)) throw new Error("finance_external_connections: missing client_id");
  const tax = r.tax_types ?? {};
  if (typeof tax !== "object" || Array.isArray(tax) || Object.entries(tax).some(([k, v]) => !TAX_KEY_PATTERN.test(k) || typeof v !== "string" || !TAX_TYPE_PATTERN.test(v))) throw new Error("finance_external_connections: invalid tax_types");
  return {
    organisationId: r.organisation_id,
    environment: env,
    status: r.status,
    clientId: r.client_id,
    tenantId: s(r.tenant_id),
    tenantName: s(r.tenant_name),
    connectedAt: s(r.connected_at),
    connectedBy: s(r.connected_by),
    lastSuccessAt: s(r.last_success_at),
    lastErrorAt: s(r.last_error_at),
    lastErrorCode: s(r.last_error_code),
    lastErrorMessage: s(r.last_error_message),
    config: { accountCode: s(r.account_code), taxTypes: tax as Record<string, string>, revision: n(r.config_revision) ?? 0, updatedAt: s(r.config_updated_at), updatedBy: s(r.config_updated_by) },
  };
}

export async function loadConnection(svc: GrantStoreConfig, organisationId: string): Promise<XeroConnection | null> {
  const rows = await ok(await fetch(`${rest(svc, CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&provider=eq.xero&select=${CONNECTION_COLUMNS}`, { headers: headers(svc) }), "Xero connection read");
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Xero connection read returned an unexpected shape");
  if (!rows.length) return null;
  if (rows[0].organisation_id !== organisationId) throw new Error("Xero connection read returned another organisation's row");
  return connectionFromRow(rows[0]);
}

/** The Custom Connection client secret, decrypted from Vault by a service-role-only function; null when not connected. */
export async function readClientSecret(svc: GrantStoreConfig, organisationId: string): Promise<string | null> {
  const r = await ok(await fetch(rest(svc, `rpc/${SECRET_RPC}`), { method: "POST", headers: headers(svc), body: JSON.stringify({ p_organisation_id: organisationId }) }), "Xero secret read");
  return typeof r === "string" && r ? r : null;
}

/** Health bookkeeping on the connection row (never audited: it is not a business change). */
export async function recordConnectionOutcome(svc: GrantStoreConfig, organisationId: string, o: { ok: true; at: string; tenantId?: string; tenantName?: string | null } | { ok: false; at: string; code: string; message: string }): Promise<void> {
  const fields = o.ok
    ? { last_success_at: o.at, ...(o.tenantId ? { tenant_id: o.tenantId, tenant_name: o.tenantName ?? null } : {}) }
    : { last_error_at: o.at, last_error_code: o.code, last_error_message: o.message.slice(0, 500) };
  await ok(await fetch(`${rest(svc, CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&provider=eq.xero`, { method: "PATCH", headers: headers(svc, { Prefer: "return=minimal" }), body: JSON.stringify({ ...fields, updated_at: o.at }) }), "Xero connection health update");
}

/** Saves the non-secret mapping if (and only if) the stored revision is still `expectedRevision`; false = changed underneath. */
export async function saveConfig(svc: GrantStoreConfig, organisationId: string, expectedRevision: number, c: { accountCode: string | null; taxTypes: Record<string, string>; at: string; by: string }): Promise<boolean> {
  const rows = await ok(
    await fetch(`${rest(svc, CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&provider=eq.xero&config_revision=eq.${expectedRevision}`, {
      method: "PATCH",
      headers: headers(svc, { Prefer: "return=representation" }),
      body: JSON.stringify({ account_code: c.accountCode, tax_types: c.taxTypes, config_revision: expectedRevision + 1, config_updated_at: c.at, config_updated_by: c.by, updated_at: c.at }),
    }),
    "Xero settings save"
  );
  return Array.isArray(rows) && rows.length === 1;
}

// ----- invoice links (the connector journal) -----

const LINK_FIELDS: Record<keyof Omit<InvoiceLink, "mismatches">, string> & { mismatches: string } = {
  organisationId: "organisation_id",
  invoiceId: "invoice_id",
  clientId: "client_id",
  environment: "environment",
  idempotencyKey: "idempotency_key",
  generation: "generation",
  stage: "stage",
  xeroInvoiceId: "xero_invoice_id",
  xeroInvoiceNumber: "xero_invoice_number",
  xeroStatus: "xero_status",
  xeroContactId: "xero_contact_id",
  xeroDate: "xero_date",
  xeroDueDate: "xero_due_date",
  createAttempts: "create_attempts",
  sendStatus: "send_status",
  sendAttempts: "send_attempts",
  sendKeyGeneration: "send_key_generation",
  sentAt: "sent_at",
  lastErrorStage: "last_error_stage",
  lastErrorCode: "last_error_code",
  lastErrorMessage: "last_error_message",
  lastErrorAt: "last_error_at",
  mismatches: "mismatches",
  version: "version",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export function linkFromRow(r: Record<string, any>): InvoiceLink {
  const bad = (why: string) => new Error(`finance_xero_invoice_links ${r?.invoice_id}: ${why}`);
  if (!STAGES.includes(r.stage as Stage)) throw bad("invalid stage");
  if (!SEND_STATUSES.includes(r.send_status as SendStatus)) throw bad("invalid send status");
  if (!ENVIRONMENTS.includes(r.environment)) throw bad("invalid environment");
  const xid = s(r.xero_invoice_id);
  if (xid && !XERO_ID_PATTERN.test(xid)) throw bad("invalid xero_invoice_id");
  if ((r.stage === "creating") !== (xid === null)) throw bad("stage and xero_invoice_id disagree");
  if ((r.stage === "created" || r.stage === "issued") && (!s(r.xero_invoice_number) || !s(r.xero_date) || !s(r.xero_due_date))) throw bad("an authorised Xero invoice needs its number and dates");
  if (r.stage !== "issued" && r.send_status !== "not_sent") throw bad("sent before being issued");
  const ints = [r.generation, r.create_attempts, r.send_attempts, r.send_key_generation, r.version].map(n);
  if (ints.some((x) => x === null)) throw bad("invalid counters");
  const mm = r.mismatches;
  if (mm !== null && mm !== undefined && (!Array.isArray(mm) || mm.some((x: unknown) => typeof x !== "string"))) throw bad("invalid mismatches");
  return {
    organisationId: r.organisation_id,
    invoiceId: r.invoice_id,
    clientId: r.client_id,
    environment: r.environment,
    idempotencyKey: r.idempotency_key,
    generation: r.generation,
    stage: r.stage,
    xeroInvoiceId: xid ? xid.toLowerCase() : null,
    xeroInvoiceNumber: s(r.xero_invoice_number),
    xeroStatus: s(r.xero_status),
    xeroContactId: s(r.xero_contact_id),
    xeroDate: s(r.xero_date),
    xeroDueDate: s(r.xero_due_date),
    createAttempts: r.create_attempts,
    sendStatus: r.send_status,
    sendAttempts: r.send_attempts,
    sendKeyGeneration: r.send_key_generation,
    sentAt: s(r.sent_at),
    lastErrorStage: s(r.last_error_stage),
    lastErrorCode: s(r.last_error_code),
    lastErrorMessage: s(r.last_error_message),
    lastErrorAt: s(r.last_error_at),
    mismatches: Array.isArray(mm) ? mm : null,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const toRow = (patch: Partial<InvoiceLink>) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [(LINK_FIELDS as Record<string, string>)[k], v]));

export async function loadInvoiceLink(svc: GrantStoreConfig, organisationId: string, invoiceId: string): Promise<InvoiceLink | null> {
  const rows = await ok(await fetch(`${rest(svc, LINKS_TABLE)}?organisation_id=${eq(organisationId)}&invoice_id=${eq(invoiceId)}&select=*`, { headers: headers(svc) }), "Xero invoice link read");
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Xero invoice link read returned an unexpected shape");
  if (!rows.length) return null;
  const l = linkFromRow(rows[0]);
  if (l.organisationId !== organisationId || l.invoiceId !== invoiceId) throw new Error("Xero invoice link read returned another invoice's row");
  return l;
}

/** Creates the journal row; null when one already exists (the primary key decides - never two). */
export async function insertInvoiceLink(svc: GrantStoreConfig, l: InvoiceLink): Promise<InvoiceLink | null> {
  const res = await fetch(`${rest(svc, LINKS_TABLE)}?select=*`, { method: "POST", headers: headers(svc, { Prefer: "return=representation" }), body: JSON.stringify(toRow(l)) });
  if (res.status === 409) return null;
  const rows = await ok(res, "Xero invoice link insert");
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Xero invoice link insert did not confirm the row");
  return linkFromRow(rows[0]);
}

/**
 * Updates the journal row only if it is still at `expected.version`
 * (optimistic: a stale request can never overwrite a newer state); returns
 * the new row, or null when it had changed.
 */
export async function updateInvoiceLink(svc: GrantStoreConfig, expected: InvoiceLink, patch: Partial<InvoiceLink>): Promise<InvoiceLink | null> {
  const body = toRow({ ...patch, version: expected.version + 1, updatedAt: patch.updatedAt ?? new Date().toISOString() });
  const res = await fetch(`${rest(svc, LINKS_TABLE)}?organisation_id=${eq(expected.organisationId)}&invoice_id=${eq(expected.invoiceId)}&version=eq.${expected.version}&select=*`, {
    method: "PATCH",
    headers: headers(svc, { Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (res.status === 409) throw new Error("Xero invoice link update conflicts with another invoice's Xero id");
  const rows = await ok(res, "Xero invoice link update");
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Xero invoice link update returned an unexpected shape");
  return rows.length ? linkFromRow(rows[0]) : null;
}

// ----- contact links -----

export function contactLinkFromRow(r: Record<string, any>): ContactLink {
  if (!s(r.client_id) || !s(r.xero_contact_id) || !XERO_ID_PATTERN.test(r.xero_contact_id)) throw new Error("finance_xero_contact_links: invalid row");
  if (!["matched_contact_number", "created", "linked_by_manager"].includes(r.method)) throw new Error("finance_xero_contact_links: invalid method");
  return { organisationId: r.organisation_id, clientId: r.client_id, xeroContactId: String(r.xero_contact_id).toLowerCase(), method: r.method, linkedAt: r.linked_at, linkedBy: r.linked_by };
}

export async function loadContactLinks(svc: GrantStoreConfig, organisationId: string, by: { clientId?: string; xeroContactId?: string }): Promise<ContactLink[]> {
  const f = by.clientId ? `client_id=${eq(by.clientId)}` : `xero_contact_id=${eq(String(by.xeroContactId).toLowerCase())}`;
  const rows = await ok(await fetch(`${rest(svc, CONTACT_LINKS_TABLE)}?organisation_id=${eq(organisationId)}&${f}&select=*`, { headers: headers(svc) }), "Xero contact link read");
  if (!Array.isArray(rows)) throw new Error("Xero contact link read returned an unexpected shape");
  return rows.map(contactLinkFromRow).filter((l) => l.organisationId === organisationId);
}

/** Inserts the link; "conflict" when the client or the Xero contact is already linked (unique keys decide). */
export async function insertContactLink(svc: GrantStoreConfig, l: ContactLink): Promise<"ok" | "conflict"> {
  const res = await fetch(rest(svc, CONTACT_LINKS_TABLE), {
    method: "POST",
    headers: headers(svc, { Prefer: "return=minimal" }),
    body: JSON.stringify({ organisation_id: l.organisationId, client_id: l.clientId, xero_contact_id: l.xeroContactId, method: l.method, linked_at: l.linkedAt, linked_by: l.linkedBy }),
  });
  if (res.status === 409) return "conflict";
  await ok(res, "Xero contact link insert");
  return "ok";
}

/** Compensation only: removes a contact link THIS request created when its audit could not be written. */
export async function deleteContactLink(svc: GrantStoreConfig, organisationId: string, clientId: string, xeroContactId: string): Promise<void> {
  await ok(
    await fetch(`${rest(svc, CONTACT_LINKS_TABLE)}?organisation_id=${eq(organisationId)}&client_id=${eq(clientId)}&xero_contact_id=${eq(xeroContactId)}`, { method: "DELETE", headers: headers(svc, { Prefer: "return=minimal" }) }),
    "Xero contact link compensating delete"
  );
}
