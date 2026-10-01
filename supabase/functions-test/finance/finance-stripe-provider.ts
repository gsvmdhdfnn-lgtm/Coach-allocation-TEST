/**
 * Stripe READ provider adapter (Finance Foundation F10; see TEST-ENV.md
 * "Finance Foundation - F10"). The ONLY code that talks HTTP to Stripe.
 * Portable (fetch only); the orchestrator depends on StripeReadProvider.
 *
 * READ ONLY by construction: every request is a GET. There is no method
 * here (or anywhere in F10) that creates, updates, cancels or refunds.
 *
 *   - Auth: `Authorization: Bearer <key>` with the organisation's Stripe
 *     secret / restricted key, read from Supabase Vault for one request and
 *     never stored, logged, audited or returned. A restricted key with read
 *     permissions only is the recommended credential.
 *   - Every request pins `Stripe-Version` (STRIPE_API_VERSION).
 *   - Lists are paged with `limit` + `starting_after` until `has_more` is
 *     false, bounded by MAX_PAGES; a failure on any page fails the whole
 *     read (nothing partial is ever returned as if complete).
 *   - TEST guard: with requireTestMode, any object reporting
 *     `livemode: true` fails the read (kind "live_data").
 *
 * Endpoints: "stripe" = https://api.stripe.com/v1; "sandbox" (TEST only) =
 * this Supabase project's stripe-sandbox function - no other base URL can
 * ever be configured.
 */
import { type StripeEndpoint, STRIPE_API_VERSION } from "./finance-stripe.ts";

export type FailKind = "timeout" | "unreachable" | "server" | "rate_limited" | "rejected" | "unauthorised" | "forbidden" | "not_found" | "malformed" | "live_data" | "too_many" | "page_failed";
export type ProviderFail = { ok: false; kind: FailKind; status: number | null; message: string; stripeCode: string | null };
export type PR<T> = { ok: true; value: T } | ProviderFail;

export const STRIPE_TIMEOUT_MS = 15_000;
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 20;

export function baseUrlFor(endpoint: StripeEndpoint, supabaseUrl: string): string {
  if (endpoint === "stripe") return "https://api.stripe.com/v1";
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/stripe-sandbox/v1`;
}

export interface StripeReadProvider {
  account(): Promise<PR<Record<string, any>>>;
  customer(customerId: string): Promise<PR<Record<string, any> | null>>;
  /** All subscriptions of every status (or one customer's), customer + latest invoice + its charge + balance transaction expanded. */
  listSubscriptions(o: { customer?: string }): Promise<PR<Record<string, any>[]>>;
  subscription(subscriptionId: string): Promise<PR<Record<string, any> | null>>;
  /** The subscription's most recent invoices (one page), each with its charge + balance transaction. */
  subscriptionInvoices(subscriptionId: string, limit: number): Promise<PR<Record<string, any>[]>>;
  /** Stripe's preview of the next invoice; null when Stripe says there is none. */
  upcomingInvoice(subscriptionId: string): Promise<PR<Record<string, any> | null>>;
  /** Charges created in [gte, lte] (epoch seconds), balance transaction + invoice expanded. */
  listCharges(o: { gte: number; lte: number; customer?: string }): Promise<PR<Record<string, any>[]>>;
  /** Refunds created in [gte, lte], balance transaction expanded. */
  listRefunds(o: { gte: number; lte: number }): Promise<PR<Record<string, any>[]>>;
  /** One charge (F11 reads the source of a refund decision); null when Stripe has no such charge. */
  charge(chargeId: string): Promise<PR<Record<string, any> | null>>;
  /** Every refund Stripe holds for one charge (all pages). */
  chargeRefunds(chargeId: string): Promise<PR<Record<string, any>[]>>;
  /** Calls made (method + path + status only - never headers or query values that could carry data). */
  callLog(): { method: string; path: string; status: number | null }[];
}

const fail = (kind: FailKind, status: number | null, message: string, stripeCode: string | null = null): ProviderFail => ({ ok: false, kind, status, message, stripeCode });

function hasLive(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.livemode === true) return true;
  return Array.isArray(body.data) && body.data.some((o: any) => o && typeof o === "object" && o.livemode === true);
}

export function httpStripeProvider(o: { baseUrl: string; secretKey: string; requireTestMode: boolean; timeoutMs?: number; pageLimit?: number; maxPages?: number }): StripeReadProvider {
  const timeoutMs = o.timeoutMs ?? STRIPE_TIMEOUT_MS;
  const pageLimit = o.pageLimit ?? PAGE_LIMIT;
  const maxPages = o.maxPages ?? MAX_PAGES;
  const log: { method: string; path: string; status: number | null }[] = [];

  async function get(path: string, params: [string, string][] = []): Promise<PR<any>> {
    const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const url = `${o.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${o.secretKey}`, "Stripe-Version": STRIPE_API_VERSION, Accept: "application/json" }, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error)?.name === "AbortError";
      log.push({ method: "GET", path, status: null });
      return fail(aborted ? "timeout" : "unreachable", null, aborted ? `Stripe did not answer within ${Math.round(timeoutMs / 1000)}s` : "Stripe could not be reached");
    }
    clearTimeout(timer);
    log.push({ method: "GET", path, status: res.status });
    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
    const err = body && typeof body === "object" ? body.error : null;
    const code = typeof err?.code === "string" ? err.code : null;
    if (res.status >= 200 && res.status < 300) {
      if (!body || typeof body !== "object") return fail("malformed", res.status, "Stripe answered in a way the Hub could not read");
      if (o.requireTestMode && hasLive(body)) return fail("live_data", res.status, "Stripe returned LIVE-mode data to a TEST Hub - the read was refused");
      return { ok: true, value: body };
    }
    if (res.status === 400) return fail("rejected", 400, typeof err?.message === "string" ? err.message.slice(0, 300) : "Stripe rejected the request", code);
    if (res.status === 401) return fail("unauthorised", 401, "Stripe did not accept the organisation's key", code);
    if (res.status === 403) return fail("forbidden", 403, "The Stripe key is not allowed to read this (check the restricted key's read permissions)", code);
    if (res.status === 404) return fail("not_found", 404, "Stripe has no such record", code);
    if (res.status === 429) return fail("rate_limited", 429, "Stripe's rate limit was reached - try again in a minute", code);
    return fail("server", res.status, `Stripe returned an error (${res.status})`, code);
  }

  async function getOne(path: string, params: [string, string][] = []): Promise<PR<Record<string, any> | null>> {
    const r = await get(path, params);
    if (!r.ok) return r.kind === "not_found" ? { ok: true, value: null } : r;
    return { ok: true, value: r.value };
  }

  /** Every page of a list (limit + starting_after until has_more is false), bounded. */
  async function all(path: string, params: [string, string][]): Promise<PR<Record<string, any>[]>> {
    const out: Record<string, any>[] = [];
    let after: string | null = null;
    for (let page = 1; ; page++) {
      if (page > maxPages) return fail("too_many", null, `More than ${maxPages * pageLimit} records - narrow the request (nothing partial is returned)`);
      const r = await get(path, [...params, ["limit", String(pageLimit)], ...(after ? ([["starting_after", after]] as [string, string][]) : [])]);
      if (!r.ok) return page === 1 ? r : fail("page_failed", r.status, `Page ${page} of the Stripe list could not be read (${r.message}) - nothing partial is returned`, r.stripeCode);
      const b = r.value;
      if (b.object !== "list" || !Array.isArray(b.data) || typeof b.has_more !== "boolean") return fail(page === 1 ? "malformed" : "page_failed", null, "Stripe returned a list the Hub could not read");
      if (b.data.some((x: any) => !x || typeof x.id !== "string")) return fail("malformed", null, "Stripe returned a list item without an id");
      out.push(...b.data);
      if (!b.has_more) return { ok: true, value: out };
      if (!b.data.length) return fail("malformed", null, "Stripe said there is more but returned an empty page");
      after = b.data[b.data.length - 1].id;
    }
  }

  const SUB_EXPAND: [string, string][] = [
    ["expand[]", "data.customer"],
    ["expand[]", "data.latest_invoice.charge.balance_transaction"],
  ];
  return {
    account: async () => {
      const r = await get("/account");
      if (!r.ok) return r;
      return typeof r.value.id === "string" ? r : fail("malformed", null, "Stripe returned an account without an id");
    },
    customer: (id) => getOne(`/customers/${encodeURIComponent(id)}`),
    listSubscriptions: (q) => all("/subscriptions", [["status", "all"], ...SUB_EXPAND, ...(q.customer ? ([["customer", q.customer]] as [string, string][]) : [])]),
    subscription: (id) =>
      getOne(`/subscriptions/${encodeURIComponent(id)}`, [
        ["expand[]", "customer"],
        ["expand[]", "latest_invoice.charge.balance_transaction"],
        ["expand[]", "items.data.price.product"],
      ]),
    subscriptionInvoices: async (id, limit) => {
      const r = await get("/invoices", [["subscription", id], ["limit", String(limit)], ["expand[]", "data.charge.balance_transaction"]]);
      if (!r.ok) return r;
      if (r.value.object !== "list" || !Array.isArray(r.value.data)) return fail("malformed", null, "Stripe returned an invoice list the Hub could not read");
      return { ok: true, value: r.value.data };
    },
    upcomingInvoice: async (id) => {
      const r = await get("/invoices/upcoming", [["subscription", id]]);
      if (!r.ok) return r.kind === "not_found" || r.stripeCode === "invoice_upcoming_none" ? { ok: true, value: null } : r;
      return r;
    },
    listCharges: (q) =>
      all("/charges", [
        ["created[gte]", String(q.gte)],
        ["created[lte]", String(q.lte)],
        ["expand[]", "data.balance_transaction"],
        ["expand[]", "data.invoice"],
        ...(q.customer ? ([["customer", q.customer]] as [string, string][]) : []),
      ]),
    listRefunds: (q) => all("/refunds", [["created[gte]", String(q.gte)], ["created[lte]", String(q.lte)], ["expand[]", "data.balance_transaction"]]),
    charge: (id) => getOne(`/charges/${encodeURIComponent(id)}`),
    chargeRefunds: (id) => all("/refunds", [["charge", id]]),
    callLog: () => log.map((x) => ({ ...x })),
  };
}
