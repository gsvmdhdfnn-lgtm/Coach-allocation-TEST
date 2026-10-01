/**
 * Test-suite copy of the canonical finance/finance-stripe-repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Stripe READ connector storage (Finance Foundation F10; see TEST-ENV.md
 * "Finance Foundation - F10"). Supabase only (service role, PostgREST),
 * every table RLS on with no client grants:
 *
 *   finance_stripe_connections      one row per organisation: mode (test /
 *                                   live), endpoint (stripe / sandbox),
 *                                   status, the Stripe account it reached,
 *                                   last success / error, the non-secret
 *                                   fee estimate. The key is in Supabase
 *                                   Vault; this row holds only its vault id,
 *                                   which is never selected here.
 *   finance_stripe_customer_links   Stripe customer -> Hub parent (one parent
 *                                   per customer; a parent may own several
 *                                   Stripe customers). Written ONLY by an
 *                                   explicit Management link.
 *   rpc finance_stripe_secret       the vault read (service role only).
 *
 * Nothing Stripe-authoritative (subscriptions, payments, refunds, fees) is
 * stored anywhere: every read goes to Stripe. Hub parents are READ from
 * Airtable (Parents & Guardians + Parent-Player Links); F10 writes nothing
 * to Airtable.
 */
import type { AirtableConfig, GrantStoreConfig } from "./finance-repository.ts";
import { airtableFetch, expectOk, tableUrl } from "./finance-commercial-repository.ts";
import { type CustomerLink, type FeeEstimate, type HubParent, type StripeConnection, ACCOUNT_ID_PATTERN, CUSTOMER_ID_PATTERN, ENDPOINTS, MODES, PARENT_ID_PATTERN } from "./finance-stripe.ts";

export const STRIPE_CONNECTIONS_TABLE = "finance_stripe_connections";
export const CUSTOMER_LINKS_TABLE = "finance_stripe_customer_links";
export const STRIPE_SECRET_RPC = "finance_stripe_secret";
export const PARENTS_TABLE = "Parents & Guardians";
export const PARENT_PLAYER_LINKS_TABLE = "Parent–Player Links";
/** Health bookkeeping is written at most this often on success (repeated reads never churn the row). */
export const SUCCESS_THROTTLE_MS = 60_000;

const COLUMNS = "organisation_id,mode,endpoint,status,account_id,account_name,connected_at,connected_by,last_success_at,last_error_at,last_error_code,last_error_message,fee_estimate,config_revision,config_updated_at,config_updated_by";
const LINK_COLUMNS = "organisation_id,stripe_customer_id,parent_id,parent_record_id,method,linked_at,linked_by";

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

function feeFromRow(v: unknown): FeeEstimate | null {
  if (v === null || v === undefined) return null;
  const o = v as Record<string, unknown>;
  const bp = n(o?.percentBasisPoints);
  const fx = n(o?.fixedMinor);
  if (bp === null || fx === null || bp > 1000 || fx > 1000 || Object.keys(o).length !== 2) throw new Error("finance_stripe_connections: invalid fee_estimate");
  return { percentBasisPoints: bp, fixedMinor: fx };
}

export function stripeConnectionFromRow(r: Record<string, any>): StripeConnection {
  if (!MODES.includes(r.mode)) throw new Error("finance_stripe_connections: invalid mode");
  if (!ENDPOINTS.includes(r.endpoint)) throw new Error("finance_stripe_connections: invalid endpoint");
  if (r.status !== "connected" && r.status !== "disconnected") throw new Error("finance_stripe_connections: invalid status");
  if (r.account_id !== null && r.account_id !== undefined && !ACCOUNT_ID_PATTERN.test(String(r.account_id))) throw new Error("finance_stripe_connections: invalid account_id");
  return {
    organisationId: r.organisation_id,
    mode: r.mode,
    endpoint: r.endpoint,
    status: r.status,
    accountId: s(r.account_id),
    accountName: s(r.account_name),
    connectedAt: s(r.connected_at),
    connectedBy: s(r.connected_by),
    lastSuccessAt: s(r.last_success_at),
    lastErrorAt: s(r.last_error_at),
    lastErrorCode: s(r.last_error_code),
    lastErrorMessage: s(r.last_error_message),
    config: { feeEstimate: feeFromRow(r.fee_estimate), revision: n(r.config_revision) ?? 0, updatedAt: s(r.config_updated_at), updatedBy: s(r.config_updated_by) },
  };
}

export async function loadStripeConnection(svc: GrantStoreConfig, organisationId: string): Promise<StripeConnection | null> {
  const rows = await ok(await fetch(`${rest(svc, STRIPE_CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&select=${COLUMNS}`, { headers: headers(svc) }), "Stripe connection read");
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Stripe connection read returned an unexpected shape");
  if (!rows.length) return null;
  if (rows[0].organisation_id !== organisationId) throw new Error("Stripe connection read returned another organisation's row");
  return stripeConnectionFromRow(rows[0]);
}

/** The organisation's Stripe key, decrypted from Vault by a service-role-only function; null when not connected. */
export async function readStripeSecret(svc: GrantStoreConfig, organisationId: string): Promise<string | null> {
  const r = await ok(await fetch(rest(svc, `rpc/${STRIPE_SECRET_RPC}`), { method: "POST", headers: headers(svc), body: JSON.stringify({ p_organisation_id: organisationId }) }), "Stripe secret read");
  return typeof r === "string" && r ? r : null;
}

/**
 * Health bookkeeping on the connection row (never audited - not a business
 * change; never a new row). A success is written only when the stored one is
 * older than SUCCESS_THROTTLE_MS (or the account is being recorded).
 */
export async function recordStripeOutcome(svc: GrantStoreConfig, conn: StripeConnection, o: { ok: true; at: string; account?: { id: string; name: string | null } } | { ok: false; at: string; code: string; message: string }): Promise<boolean> {
  if (o.ok && !o.account && conn.lastSuccessAt && Date.parse(o.at) - Date.parse(conn.lastSuccessAt) < SUCCESS_THROTTLE_MS) return false;
  const fields = o.ok ? { last_success_at: o.at, ...(o.account ? { account_id: o.account.id, account_name: o.account.name } : {}) } : { last_error_at: o.at, last_error_code: o.code, last_error_message: o.message.slice(0, 500) };
  await ok(await fetch(`${rest(svc, STRIPE_CONNECTIONS_TABLE)}?organisation_id=${eq(conn.organisationId)}`, { method: "PATCH", headers: headers(svc, { Prefer: "return=minimal" }), body: JSON.stringify({ ...fields, updated_at: o.at }) }), "Stripe connection health update");
  return true;
}

/** Saves the fee estimate if (and only if) the stored revision is still `expectedRevision`; false = changed underneath. */
export async function saveStripeConfig(svc: GrantStoreConfig, organisationId: string, expectedRevision: number, c: { feeEstimate: FeeEstimate | null; at: string; by: string }): Promise<boolean> {
  const rows = await ok(
    await fetch(`${rest(svc, STRIPE_CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&config_revision=eq.${expectedRevision}`, {
      method: "PATCH",
      headers: headers(svc, { Prefer: "return=representation" }),
      body: JSON.stringify({ fee_estimate: c.feeEstimate, config_revision: expectedRevision + 1, config_updated_at: c.at, config_updated_by: c.by, updated_at: c.at }),
    }),
    "Stripe settings save"
  );
  return Array.isArray(rows) && rows.length === 1;
}

export function customerLinkFromRow(r: Record<string, any>): CustomerLink {
  if (!CUSTOMER_ID_PATTERN.test(String(r.stripe_customer_id))) throw new Error("finance_stripe_customer_links: invalid stripe_customer_id");
  if (!PARENT_ID_PATTERN.test(String(r.parent_id))) throw new Error("finance_stripe_customer_links: invalid parent_id");
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(r.parent_record_id))) throw new Error("finance_stripe_customer_links: invalid parent_record_id");
  if (r.method !== "linked_by_manager") throw new Error("finance_stripe_customer_links: invalid method");
  return { organisationId: r.organisation_id, customerId: r.stripe_customer_id, parentId: r.parent_id, parentRecordId: r.parent_record_id, method: r.method, linkedAt: r.linked_at, linkedBy: r.linked_by };
}

export async function loadCustomerLinks(svc: GrantStoreConfig, organisationId: string): Promise<CustomerLink[]> {
  const rows = await ok(await fetch(`${rest(svc, CUSTOMER_LINKS_TABLE)}?organisation_id=${eq(organisationId)}&select=${LINK_COLUMNS}`, { headers: headers(svc) }), "Stripe customer links read");
  if (!Array.isArray(rows)) throw new Error("Stripe customer links read returned an unexpected shape");
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error("Stripe customer links read returned another organisation's row");
  return rows.map(customerLinkFromRow);
}

/** "conflict" when the customer is already linked (primary key) - never a second row. */
export async function insertCustomerLink(svc: GrantStoreConfig, l: CustomerLink): Promise<"ok" | "conflict"> {
  const res = await fetch(rest(svc, CUSTOMER_LINKS_TABLE), {
    method: "POST",
    headers: headers(svc, { Prefer: "return=minimal" }),
    body: JSON.stringify({ organisation_id: l.organisationId, stripe_customer_id: l.customerId, parent_id: l.parentId, parent_record_id: l.parentRecordId, method: l.method, linked_at: l.linkedAt, linked_by: l.linkedBy }),
  });
  if (res.status === 409) return "conflict";
  await ok(res, "Stripe customer link insert");
  return "ok";
}

/** Compensation only (the audit insert failed right after the link). */
export async function deleteCustomerLink(svc: GrantStoreConfig, organisationId: string, customerId: string): Promise<void> {
  await ok(await fetch(`${rest(svc, CUSTOMER_LINKS_TABLE)}?organisation_id=${eq(organisationId)}&stripe_customer_id=${eq(customerId)}`, { method: "DELETE", headers: headers(svc, { Prefer: "return=minimal" }) }), "Stripe customer link removal");
}

export async function listAll(config: AirtableConfig, table: string, fields: string[]): Promise<{ id: string; fields: Record<string, any> }[]> {
  const rows: { id: string; fields: Record<string, any> }[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, table));
    for (const f of fields) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${table}`);
    for (const r of data.records || []) rows.push({ id: r.id, fields: r.fields || {} });
    offset = data.offset || "";
  } while (offset);
  return rows;
}

/**
 * Every Hub parent with its count of non-ended Parent-Player Links, by
 * record id. (Parents carry no Organisation link: one organisation per
 * Airtable base today - see TEST-ENV.md FIN10.7.)
 */
export async function loadHubParents(config: AirtableConfig): Promise<Map<string, HubParent>> {
  const [parents, links] = await Promise.all([
    listAll(config, PARENTS_TABLE, ["Parent ID", "Parent / Guardian Name", "Active"]),
    listAll(config, PARENT_PLAYER_LINKS_TABLE, ["Parent / Guardian", "Player", "Link Lifecycle Status"]),
  ]);
  const count = new Map<string, Set<string>>();
  for (const l of links) {
    const status = typeof l.fields["Link Lifecycle Status"] === "string" ? l.fields["Link Lifecycle Status"] : (l.fields["Link Lifecycle Status"]?.name ?? null);
    if (status === "Ended") continue;
    for (const p of Array.isArray(l.fields["Parent / Guardian"]) ? l.fields["Parent / Guardian"] : []) {
      const set = count.get(p) ?? new Set<string>();
      for (const pl of Array.isArray(l.fields.Player) ? l.fields.Player : []) set.add(pl);
      count.set(p, set);
    }
  }
  const out = new Map<string, HubParent>();
  for (const p of parents) {
    const pid = typeof p.fields["Parent ID"] === "string" ? p.fields["Parent ID"].trim() : "";
    out.set(p.id, { recordId: p.id, parentId: pid, name: typeof p.fields["Parent / Guardian Name"] === "string" ? p.fields["Parent / Guardian Name"] : "", active: p.fields.Active === true, linkedPlayerCount: count.get(p.id)?.size ?? 0 });
  }
  return out;
}
