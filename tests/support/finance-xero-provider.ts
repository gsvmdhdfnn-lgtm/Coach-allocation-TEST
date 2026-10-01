/**
 * Test-suite copy of the canonical finance/finance-xero-provider.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Xero provider adapter (Finance Foundation F9; see TEST-ENV.md "Finance
 * Foundation - F9"). The ONLY code that talks HTTP to Xero. Portable
 * (fetch only); the orchestrator depends on the XeroProvider interface.
 *
 * Access mechanism (v1): a Xero Custom Connection - OAuth 2.0
 * client_credentials for ONE Xero organisation, per Hub organisation. The
 * client secret is read from Supabase Vault server-side for the duration of
 * one request; the access token it buys is held in memory for that request
 * only and is never stored, logged, audited or returned.
 *
 * Endpoints (environment "live"): identity.xero.com/connect/token,
 * api.xero.com/connections, api.xero.com/api.xro/2.0. Environment
 * "sandbox" (TEST only) uses the same paths on this Supabase project's
 * xero-sandbox function - a Xero API emulator; no other base URL can ever be
 * configured.
 *
 * Every write carries an Idempotency-Key (Xero: PUT/POST/PATCH, <= 128
 * chars). Every result is classified:
 *   - definite failures (rejected 400, unauthorised 401, forbidden 403,
 *     not found 404): Xero did not do it;
 *   - UNKNOWN outcome (timeout, unreachable, 5xx, 429 after send): Xero
 *     may or may not have done it - the caller must look before retrying.
 */
import type { XeroEnvironment } from "./finance-xero.ts";

export type FailKind = "timeout" | "unreachable" | "server" | "rate_limited" | "rejected" | "unauthorised" | "forbidden" | "not_found" | "malformed";
export type ProviderFail = { ok: false; kind: FailKind; status: number | null; message: string; validation: string[] };
export type PR<T> = { ok: true; value: T } | ProviderFail;
/** Xero may have performed the write: never treat as "not done". */
export const outcomeUnknown = (f: ProviderFail) => f.kind === "timeout" || f.kind === "unreachable" || f.kind === "server" || f.kind === "rate_limited" || f.kind === "malformed";

export interface XeroEndpoints {
  token: string;
  connections: string;
  api: string;
}
export function endpointsFor(environment: XeroEnvironment, supabaseUrl: string): XeroEndpoints {
  if (environment === "live") return { token: "https://identity.xero.com/connect/token", connections: "https://api.xero.com/connections", api: "https://api.xero.com/api.xro/2.0" };
  const base = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/xero-sandbox`;
  return { token: `${base}/connect/token`, connections: `${base}/connections`, api: `${base}/api.xro/2.0` };
}

export interface XeroProvider {
  connections(): Promise<PR<{ tenantId: string; tenantName: string | null }[]>>;
  organisation(): Promise<PR<Record<string, any>>>;
  taxRates(): Promise<PR<Record<string, any>[]>>;
  accounts(): Promise<PR<Record<string, any>[]>>;
  getContact(contactId: string): Promise<PR<Record<string, any> | null>>;
  findContactsByNumber(contactNumber: string): Promise<PR<Record<string, any>[]>>;
  createContact(c: { name: string; contactNumber: string; email: string }, idempotencyKey: string): Promise<PR<Record<string, any>>>;
  updateContactEmail(contactId: string, email: string, idempotencyKey: string): Promise<PR<Record<string, any>>>;
  createInvoice(payload: Record<string, unknown>, idempotencyKey: string): Promise<PR<Record<string, any>>>;
  getInvoice(invoiceId: string): Promise<PR<Record<string, any> | null>>;
  /** Live (non-deleted, non-voided) invoices of one contact (paged), for finding a previous attempt's invoice by its Reference. */
  listContactInvoices(contactId: string): Promise<PR<Record<string, any>[]>>;
  setInvoiceStatus(invoiceId: string, status: "AUTHORISED" | "DELETED", idempotencyKey: string): Promise<PR<Record<string, any>>>;
  emailInvoice(invoiceId: string, idempotencyKey: string): Promise<PR<null>>;
  /** Calls made through this provider (method + path only - no headers, no bodies): for diagnostics and tests. */
  callLog(): { method: string; path: string; status: number | null }[];
}

export const XERO_TIMEOUT_MS = 20_000;
export const INVOICE_PAGES_MAX = 20;

const fail = (kind: FailKind, status: number | null, message: string, validation: string[] = []): ProviderFail => ({ ok: false, kind, status, message, validation });

/** Xero validation messages from a 400 body (ValidationException Elements[].ValidationErrors[].Message, or Message / Detail). */
export function validationMessages(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const b = body as Record<string, any>;
  const out: string[] = [];
  for (const el of Array.isArray(b.Elements) ? b.Elements : []) for (const v of Array.isArray(el?.ValidationErrors) ? el.ValidationErrors : []) if (typeof v?.Message === "string") out.push(v.Message);
  if (!out.length && typeof b.Message === "string") out.push(b.Message);
  if (!out.length && typeof b.Detail === "string") out.push(b.Detail);
  return out.slice(0, 10).map((m) => m.slice(0, 300));
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

export function httpXeroProvider(o: { endpoints: XeroEndpoints; clientId: string; clientSecret: string; tenantId: string | null; timeoutMs?: number }): XeroProvider {
  const timeoutMs = o.timeoutMs ?? XERO_TIMEOUT_MS;
  const log: { method: string; path: string; status: number | null }[] = [];
  let token: string | null = null;
  let tenantId = o.tenantId;

  async function call(method: string, url: string, init: { headers: Record<string, string>; body?: string }): Promise<PR<{ status: number; body: any }>> {
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method, headers: init.headers, body: init.body, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error)?.name === "AbortError";
      log.push({ method, path, status: null });
      return fail(aborted ? "timeout" : "unreachable", null, aborted ? `Xero did not answer within ${Math.round(timeoutMs / 1000)}s` : "Xero could not be reached");
    }
    clearTimeout(timer);
    log.push({ method, path, status: res.status });
    const text = await res.text().catch(() => "");
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, value: { status: res.status, body } };
    const v = validationMessages(body);
    if (res.status === 400) return fail("rejected", 400, v[0] ?? "Xero rejected the request", v);
    if (res.status === 401) return fail("unauthorised", 401, "Xero did not accept the connection's credentials");
    if (res.status === 403) return fail("forbidden", 403, "The Xero connection is not allowed to do this (check its scopes)");
    if (res.status === 404) return fail("not_found", 404, "Xero has no such record");
    if (res.status === 429) return fail("rate_limited", 429, "Xero's rate limit was reached - try again in a minute");
    return fail("server", res.status, `Xero returned an error (${res.status})`);
  }

  async function ensureToken(): Promise<ProviderFail | null> {
    if (token) return null;
    const r = await call("POST", o.endpoints.token, {
      headers: { Authorization: `Basic ${b64(`${o.clientId}:${o.clientSecret}`)}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "grant_type=client_credentials",
    });
    if (!r.ok) return r.kind === "rejected" ? fail("unauthorised", r.status, "Xero did not accept the connection's credentials") : r;
    const t = r.value.body?.access_token;
    if (typeof t !== "string" || !t) return fail("malformed", r.value.status, "Xero's token response had no access token");
    token = t;
    return null;
  }

  async function api(method: string, path: string, opts: { body?: unknown; idempotencyKey?: string; query?: Record<string, string> } = {}): Promise<PR<{ status: number; body: any }>> {
    const t = await ensureToken();
    if (t) return t;
    if (!tenantId) {
      const c = await connections();
      if (!c.ok) return c;
      if (c.value.length !== 1) return fail("forbidden", null, c.value.length ? "The Xero connection reaches more than one Xero organisation" : "The Xero connection reaches no Xero organisation");
      tenantId = c.value[0].tenantId;
    }
    const url = new URL(`${o.endpoints.api}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    return call(method, url.toString(), { headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  }

  async function connections(): Promise<PR<{ tenantId: string; tenantName: string | null }[]>> {
    const t = await ensureToken();
    if (t) return t;
    const r = await call("GET", o.endpoints.connections, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return r;
    if (!Array.isArray(r.value.body)) return fail("malformed", r.value.status, "Xero's connections response was not a list");
    return { ok: true, value: r.value.body.filter((x: any) => typeof x?.tenantId === "string" && (x.tenantType === undefined || x.tenantType === "ORGANISATION")).map((x: any) => ({ tenantId: x.tenantId, tenantName: typeof x.tenantName === "string" ? x.tenantName : null })) };
  }

  const first = (r: PR<{ status: number; body: any }>, key: string, what: string): PR<Record<string, any>> => {
    if (!r.ok) return r;
    const x = r.value.body?.[key]?.[0];
    return x && typeof x === "object" ? { ok: true, value: x } : fail("malformed", r.value.status, `Xero's ${what} response was empty`);
  };
  const list = (r: PR<{ status: number; body: any }>, key: string, what: string): PR<Record<string, any>[]> => {
    if (!r.ok) return r;
    const xs = r.value.body?.[key];
    return Array.isArray(xs) ? { ok: true, value: xs } : fail("malformed", r.value.status, `Xero's ${what} response was not a list`);
  };
  const guid = (id: string) => encodeURIComponent(id);

  return {
    connections,
    organisation: async () => first(await api("GET", "/Organisation"), "Organisations", "organisation"),
    taxRates: async () => list(await api("GET", "/TaxRates"), "TaxRates", "tax rates"),
    accounts: async () => list(await api("GET", "/Accounts"), "Accounts", "accounts"),
    getContact: async (id) => {
      const r = await api("GET", `/Contacts/${guid(id)}`);
      if (!r.ok && r.kind === "not_found") return { ok: true, value: null };
      return first(r, "Contacts", "contact");
    },
    findContactsByNumber: async (n) => list(await api("GET", "/Contacts", { query: { where: `ContactNumber=="${n.replace(/["\\]/g, "")}"` } }), "Contacts", "contact search"),
    createContact: async (c, key) => first(await api("PUT", "/Contacts", { body: { Contacts: [{ Name: c.name, ContactNumber: c.contactNumber, EmailAddress: c.email }] }, idempotencyKey: key }), "Contacts", "contact"),
    updateContactEmail: async (id, email, key) => first(await api("POST", `/Contacts/${guid(id)}`, { body: { Contacts: [{ ContactID: id, EmailAddress: email }] }, idempotencyKey: key }), "Contacts", "contact"),
    createInvoice: async (payload, key) => first(await api("PUT", "/Invoices", { body: { Invoices: [payload] }, idempotencyKey: key }), "Invoices", "invoice"),
    getInvoice: async (id) => {
      const r = await api("GET", `/Invoices/${guid(id)}`);
      if (!r.ok && r.kind === "not_found") return { ok: true, value: null };
      return first(r, "Invoices", "invoice");
    },
    listContactInvoices: async (contactId) => {
      const all: Record<string, any>[] = [];
      for (let page = 1; page <= INVOICE_PAGES_MAX; page++) {
        const r = list(await api("GET", "/Invoices", { query: { ContactIDs: contactId, Statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID", page: String(page) } }), "Invoices", "invoice search");
        if (!r.ok) return r;
        all.push(...r.value);
        if (r.value.length < 100) return { ok: true, value: all };
      }
      return fail("malformed", null, `This Xero contact has more than ${INVOICE_PAGES_MAX * 100} invoices - the Hub could not search them all`);
    },
    setInvoiceStatus: async (id, status, key) => first(await api("POST", `/Invoices/${guid(id)}`, { body: { Invoices: [{ InvoiceID: id, Status: status }] }, idempotencyKey: key }), "Invoices", "invoice"),
    emailInvoice: async (id, key) => {
      const r = await api("POST", `/Invoices/${guid(id)}/Email`, { body: {}, idempotencyKey: key });
      return r.ok ? { ok: true, value: null } : r;
    },
    callLog: () => log.slice(),
  };
}
