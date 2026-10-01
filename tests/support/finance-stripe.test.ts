/**
 * Finance Foundation F10 - Stripe READ connector.
 * Run: node --experimental-strip-types tests/support/finance-stripe.test.ts
 *
 *   CN  connection (healthy, not connected, live refused)                       brief 1-3
 *   SB  subscriptions (states, renewal, multi-subscription, pagination)         brief 4-10
 *   PY  payments (success, failure, gross, fee, net, receipt, expected != actual) brief 11-17
 *   RF  refunds (full, partial, no family credit, no execution route)           brief 18-21
 *   MP  mapping (stored link, never by name, multi-child, service, unmapped)    brief 22-26
 *   VT  VAT (Stripe breakdown, explicit incomplete)                             brief 27-28
 *   AC  access (View, Manage, no grant, coach / parent, module off, tenant)     brief 29-34
 *   FR  freshness / errors (fetchedAt + source, timeout, pagination failure, repeated reads) brief 35-38
 *   Z   code / drift checks against the canonical finance files
 *
 * The REAL F10 HTTP adapter talks to an in-memory fake Stripe (GET-only
 * Stripe list / retrieve shapes, limit + starting_after + has_more, expand[]
 * through lists, error bodies, fault injection, aborting timeouts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import {
  STRIPE_API_VERSION,
  STRIPE_EVENTS,
  keyModeOf,
  localMidnightEpoch,
  matchStripeRoute,
  parseParentLink,
  parseStripeQuery,
  parseStripeSettings,
  periodOf,
  subscriptionState,
  taxOfInvoice,
  windowOf,
} from "./finance-stripe.ts";
import { type StripeDeps, linkStripeCustomer, listStripePayments, listStripeRefunds, listStripeSubscriptions, readStripeStatus, readStripeSubscription, updateStripeSettings } from "./finance-stripe-orchestrator.ts";
import { PARENTS_TABLE, PARENT_PLAYER_LINKS_TABLE } from "./finance-stripe-repository.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

const ORG = "ORG-TEST-001";
const ORG_REC = "recYXqi1DTZ8ZECPQ";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const VIEWER = "aaaaaaaa-e0d4-4257-8121-5f16781e97ba";
const NOGRANT = "bbbbbbbb-e0d4-4257-8121-5f16781e97ba";
const g = (level: unknown): FinanceGrantRow => ({ organisation_id: ORG, access_level: level, revoked_at: null });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
const viewer = { userId: VIEWER, role: "management", active: true, organisationId: ORG };
const nogrant = { userId: NOGRANT, role: "management", active: true, organisationId: ORG };
const coach = { userId: MGR, role: "coach", active: true, organisationId: ORG };
const parent = { userId: MGR, role: "parent", active: true, organisationId: ORG };
// Fake keys, assembled at runtime so no key-shaped literal is ever committed (secret scanning).
const KEY = ["rk", "test", "ZZTESTreadonlyKey0123456789"].join("_");
const LIVE_KEY = ["rk", "live", "ZZTESTliveKeyMustNeverBeRead99"].join("_");
const ACCT = "acct_ZZTESTf10sandbox";
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
interface StripeWorld {
  key: string;
  objects: Map<string, Record<string, any>>;
  faults: { op: string; mode: string; n: number }[];
  calls: { method: string; path: string; query: string; version: string | null; status: number }[];
}
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  parents: { id: string; fields: Record<string, any> }[];
  ppl: { id: string; fields: Record<string, any> }[];
  sb: Record<string, Record<string, any>[]>;
  secret: string | null;
  audit: any[];
  auditStatus?: number;
  lockHeld: string | null;
  airtableWrites: number;
  s: StripeWorld;
}
let world: World;
let NOW = new Date("2026-10-01T12:00:00.000Z");
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

const connRow = (over: Record<string, any> = {}) => ({
  organisation_id: ORG,
  mode: "test",
  endpoint: "stripe",
  status: "connected",
  secret_id: "99999999-9999-4999-8999-999999999999",
  key_kind: "restricted",
  account_id: null,
  account_name: null,
  connected_at: "2026-10-01T09:00:00Z",
  connected_by: MGR,
  last_success_at: null,
  last_error_at: null,
  last_error_code: null,
  last_error_message: null,
  fee_estimate: null,
  config_revision: 0,
  config_updated_at: null,
  config_updated_by: null,
  ...over,
});

// ----- Stripe fixtures (Stripe-shaped, livemode false) -----
const price = (id: string, amount: number, interval = "month", tax = "exclusive") => ({ id, object: "price", product: `prod_${id.slice(6)}`, unit_amount: amount, currency: "gbp", recurring: { interval, interval_count: 1 }, tax_behavior: tax, nickname: `${id} plan`, livemode: false });
function sub(id: string, customer: string, status: string, over: Record<string, any> = {}) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    created: T("2026-08-01T10:00:00Z") + id.length,
    current_period_start: T("2026-09-15T00:00:00Z"),
    current_period_end: T("2026-10-15T00:00:00Z"),
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    trial_end: null,
    items: { object: "list", data: [{ id: `si_${id.slice(4)}`, object: "subscription_item", price: price("price_ppa", 5500), quantity: 1 }] },
    latest_invoice: null,
    default_tax_rates: [],
    automatic_tax: { enabled: false },
    metadata: {},
    livemode: false,
    ...over,
  };
}
const bt = (id: string, amount: number, fee: number, created: number) => ({ id, object: "balance_transaction", amount, fee, net: amount - fee, currency: "gbp", available_on: created + 7 * 86400, fee_details: [{ type: "stripe_fee", amount: fee }], livemode: false });
function charge(id: string, customer: string, amount: number, status: string, created: number, over: Record<string, any> = {}) {
  return { id, object: "charge", customer, amount, amount_refunded: 0, refunded: false, currency: "gbp", status, paid: status === "succeeded", created, payment_intent: `pi_${id.slice(3)}`, invoice: null, balance_transaction: null, failure_code: null, outcome: { type: status === "failed" ? "issuer_declined" : "authorized", reason: null }, disputed: false, livemode: false, ...over };
}
function invoice(id: string, sub: string, customer: string, status: string, total: number, created: number, over: Record<string, any> = {}) {
  return { id, object: "invoice", subscription: sub, customer, status, currency: "gbp", total, subtotal: total, amount_due: total, amount_paid: status === "paid" ? total : 0, amount_remaining: status === "paid" ? 0 : total, created, attempt_count: status === "paid" ? 1 : 0, next_payment_attempt: null, status_transitions: { paid_at: status === "paid" ? created + 60 : null }, charge: null, tax: null, total_excluding_tax: null, total_tax_amounts: [], automatic_tax: { enabled: false, status: null }, livemode: false, ...over };
}
const TAX20 = { id: "txr_zz20", percentage: 20, inclusive: false };

function seedStripe(): Map<string, Record<string, any>> {
  const o = new Map<string, Record<string, any>>();
  const put = (x: Record<string, any>) => o.set(x.id, x);
  put({ id: "cus_ZZA", object: "customer", name: "ZZTEST Priya Parent", email: "parent.a@test.invalid", livemode: false, created: T("2026-08-01T09:00:00Z") });
  // Same NAME and EMAIL as a Hub parent - must never be matched by them.
  put({ id: "cus_ZZB", object: "customer", name: "Priya Parent", email: "parent.a@test.invalid", livemode: false, created: T("2026-08-01T09:01:00Z") });
  put({ id: "cus_ZZD", object: "customer", deleted: true, livemode: false, created: T("2026-08-01T09:02:00Z") });
  // Active, VAT recorded by Stripe tax rates: 55.00 + 11.00 VAT = 66.00; fee 1.5% + 20p = 1.19, net 64.81.
  const c1 = T("2026-09-15T06:00:00Z");
  put(bt("txn_ok1", 6600, 119, c1));
  put(charge("ch_ok1", "cus_ZZA", 6600, "succeeded", c1, { invoice: "in_paid1", balance_transaction: "txn_ok1" }));
  put(invoice("in_paid1", "sub_active", "cus_ZZA", "paid", 6600, c1 - 30, { charge: "ch_ok1", subtotal: 5500, tax: 1100, total_excluding_tax: 5500, total_tax_amounts: [{ amount: 1100, inclusive: false, tax_rate: "txr_zz20" }] }));
  put(sub("sub_active", "cus_ZZA", "active", { latest_invoice: "in_paid1", default_tax_rates: [TAX20] }));
  // Trialling (first charge at trial end).
  put(sub("sub_trial", "cus_ZZA", "trialing", { trial_end: T("2026-10-08T00:00:00Z"), current_period_end: T("2026-10-08T00:00:00Z") }));
  // Past due: the renewal failed (insufficient funds); Stripe retries.
  const c2 = T("2026-09-20T06:00:00Z");
  put(charge("ch_fail1", "cus_ZZA", 5500, "failed", c2, { invoice: "in_open1", failure_code: "card_declined", outcome: { type: "issuer_declined", reason: "insufficient_funds" } }));
  put(invoice("in_open1", "sub_pastdue", "cus_ZZA", "open", 5500, c2 - 30, { charge: "ch_fail1", attempt_count: 1, next_payment_attempt: T("2026-10-03T06:00:00Z") }));
  put(sub("sub_pastdue", "cus_ZZA", "past_due", { latest_invoice: "in_open1", items: { object: "list", data: [{ id: "si_pd", object: "subscription_item", price: price("price_u9", 8700, "month", "inclusive"), quantity: 1 }] } }));
  // Cancelling (at period end) and cancelled - unlinked customer B.
  put(sub("sub_cancelling", "cus_ZZB", "active", { cancel_at_period_end: true, cancel_at: T("2026-10-15T00:00:00Z") }));
  put(sub("sub_cancelled", "cus_ZZB", "canceled", { canceled_at: T("2026-09-01T10:00:00Z"), ended_at: T("2026-09-01T10:00:00Z") }));
  // No tax recorded anywhere in Stripe: VAT must be "not recorded", never assumed.
  const c3 = T("2026-09-16T06:00:00Z");
  put(bt("txn_ok2", 5500, 103, c3));
  put(charge("ch_ok2", "cus_ZZB", 5500, "succeeded", c3, { invoice: "in_paid2", balance_transaction: "txn_ok2" }));
  put(invoice("in_paid2", "sub_notax", "cus_ZZB", "paid", 5500, c3 - 30, { charge: "ch_ok2" }));
  put(sub("sub_notax", "cus_ZZB", "active", { latest_invoice: "in_paid2" }));
  // Refunds: one fully refunded payment, one partially refunded, one pending charge (no balance transaction yet).
  const c4 = T("2026-09-10T06:00:00Z");
  put(bt("txn_full", 3000, 65, c4));
  put(charge("ch_full", "cus_ZZA", 3000, "succeeded", c4, { amount_refunded: 3000, refunded: true, balance_transaction: "txn_full" }));
  put({ id: "txn_re_full", object: "balance_transaction", amount: -3000, fee: 0, net: -3000, currency: "gbp", available_on: c4 + 86400, livemode: false });
  put({ id: "re_full", object: "refund", charge: "ch_full", payment_intent: "pi_full", amount: 3000, currency: "gbp", status: "succeeded", reason: "requested_by_customer", created: c4 + 3600, balance_transaction: "txn_re_full", livemode: false });
  put(bt("txn_part", 4000, 80, c4 + 10));
  put(charge("ch_part", "cus_ZZB", 4000, "succeeded", c4 + 10, { amount_refunded: 1500, balance_transaction: "txn_part" }));
  put({ id: "re_part", object: "refund", charge: "ch_part", payment_intent: "pi_part", amount: 1500, currency: "gbp", status: "succeeded", reason: null, created: c4 + 7200, balance_transaction: null, livemode: false });
  put({ id: "re_pend", object: "refund", charge: "ch_ok2", payment_intent: "pi_ok2", amount: 500, currency: "gbp", status: "pending", reason: null, created: c4 + 9000, balance_transaction: null, livemode: false });
  put(charge("ch_pend", "cus_ZZB", 2500, "pending", T("2026-09-30T10:00:00Z")));
  // Outside the default 30-day window.
  put(charge("ch_old", "cus_ZZA", 1000, "succeeded", T("2026-07-01T10:00:00Z")));
  return o;
}

function reset() {
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [] },
    moduleOn: true,
    parents: [
      { id: "recUleTQgqdkpBr8F", fields: { "Parent ID": "PARENT-TEST-001", "Parent / Guardian Name": "Priya Parent", Active: true } },
      { id: "recFKtnX7mMJA9EFn", fields: { "Parent ID": "PARENT-TEST-002", "Parent / Guardian Name": "Ex Parent", Active: true } },
      { id: "rec73xvcjMDl4Cckc", fields: { "Parent ID": "PARENT-DUP", "Parent / Guardian Name": "dup a", Active: true } },
      { id: "recqw4DrXB87B5Tcr", fields: { "Parent ID": "PARENT-DUP", "Parent / Guardian Name": "dup b", Active: true } },
      { id: "recInactiveParen1", fields: { "Parent ID": "PARENT-OFF", "Parent / Guardian Name": "Gone", Active: false } },
    ],
    ppl: [
      { id: "recL1", fields: { "Parent / Guardian": ["recUleTQgqdkpBr8F"], Player: ["recArchie"], "Link Lifecycle Status": "Verified" } },
      { id: "recL2", fields: { "Parent / Guardian": ["recUleTQgqdkpBr8F"], Player: ["recBella"], "Link Lifecycle Status": "Pending" } },
      { id: "recL3", fields: { "Parent / Guardian": ["recUleTQgqdkpBr8F"], Player: ["recDylan"], "Link Lifecycle Status": "Verified" } },
      { id: "recL4", fields: { "Parent / Guardian": ["recUleTQgqdkpBr8F"], Player: ["recOld"], "Link Lifecycle Status": "Ended" } },
      { id: "recL5", fields: { "Parent / Guardian": ["recFKtnX7mMJA9EFn"], Player: ["recCharlie"], "Link Lifecycle Status": "Verified" } },
    ],
    sb: { finance_stripe_connections: [connRow()], finance_stripe_customer_links: [] },
    secret: KEY,
    audit: [],
    lockHeld: null,
    airtableWrites: 0,
    s: { key: KEY, objects: seedStripe(), faults: [], calls: [] },
  };
  NOW = new Date("2026-10-01T12:00:00.000Z");
}

// ----- PostgREST emulation for the F10 tables -----
const PK: Record<string, string[]> = { finance_stripe_connections: ["organisation_id"], finance_stripe_customer_links: ["organisation_id", "stripe_customer_id"] };
function postgrest(url: string, method: string, body: any, prefer: string): Response {
  const u = new URL(url);
  const table = u.pathname.split("/").pop() as string;
  const rows = world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  const fs: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (k !== "select" && k !== "order") fs.push([k, v.replace(/^eq\./, "")]);
  const hit = (r: Record<string, any>) => fs.every(([k, v]) => String(r[k] ?? "") === v);
  if (method === "GET") return json(rows.filter(hit).map((r) => ({ ...r })));
  if (method === "POST") {
    const ins = Array.isArray(body) ? body : [body];
    for (const r of ins) if (rows.some((o) => PK[table].every((c) => o[c] === r[c]))) return json({ code: "23505", message: "duplicate key" }, 409);
    rows.push(...ins.map((r) => ({ ...r })));
    return json(null, 201);
  }
  if (method === "PATCH") {
    const h = rows.filter(hit);
    for (const r of h) Object.assign(r, body);
    return prefer.includes("return=representation") ? json(h.map((r) => ({ ...r }))) : json(null, 204);
  }
  if (method === "DELETE") {
    world.sb[table] = rows.filter((r) => !hit(r));
    return json(null, 204);
  }
  return json({ message: "bad method" }, 405);
}

// ----- fake Stripe (GET only) -----
function takeFault(op: string): string | null {
  const f = world.s.faults.find((x) => x.op === op && x.n > 0);
  if (!f) return null;
  f.n--;
  return f.mode;
}
const sErr = (status: number, message: string, code?: string) => json({ error: { type: "invalid_request_error", message, ...(code ? { code } : {}) } }, status);
const clone = (x: any) => JSON.parse(JSON.stringify(x));
function expandPath(target: any, segs: string[]): any {
  if (target === null || target === undefined || !segs.length) return target;
  if (Array.isArray(target)) return target.map((t) => expandPath(t, segs));
  if (typeof target !== "object") return target;
  const [k, ...rest] = segs;
  let v = target[k];
  if (typeof v === "string" && world.s.objects.has(v)) v = clone(world.s.objects.get(v));
  if (rest.length) v = expandPath(v, rest);
  target[k] = v;
  return target;
}
async function stripeFetch(url: string, init: any): Promise<Response> {
  const S = world.s;
  const u = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const h = init.headers ?? {};
  const path = u.pathname.replace(/^\/v1\/?/, "");
  const call = { method, path: `/${path}`, query: u.search, version: h["Stripe-Version"] ?? null, status: 0 };
  S.calls.push(call);
  const done = (r: Response) => ((call.status = r.status), r);
  if (h.Authorization !== `Bearer ${S.key}`) return done(sErr(401, "Invalid API Key provided"));
  if (method !== "GET") return done(sErr(405, "fake Stripe is read-only"));
  const seg = path.split("/").filter(Boolean);
  const q = u.searchParams;
  const isList = seg.length === 1 && ["subscriptions", "invoices", "charges", "refunds"].includes(seg[0]);
  const op = seg[0] === "account" ? "account" : seg[0] === "invoices" && seg[1] === "upcoming" ? "upcoming" : isList ? (q.get("starting_after") ? "page" : "list") : "retrieve";
  const f = takeFault(op);
  if (f === "fail_500") return done(sErr(500, "server error"));
  if (f === "rate_limit") return done(sErr(429, "too many", "rate_limit"));
  if (f === "malformed") return done(new Response("<html>", { status: 200 }));
  if (f === "timeout") {
    call.status = -1;
    return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }
  const expand = q.getAll("expand[]");
  let body: any;
  if (seg[0] === "account") body = { id: ACCT, object: "account", settings: { dashboard: { display_name: "ZZTEST Stripe sandbox" } } };
  else if (seg[0] === "invoices" && seg[1] === "upcoming") {
    const s = S.objects.get(q.get("subscription") ?? "");
    if (!s || s.status === "canceled" || s.cancel_at_period_end) return done(sErr(404, "No upcoming invoices for customer", "invoice_upcoming_none"));
    const subtotal = s.items.data.reduce((a: number, i: any) => a + i.price.unit_amount * i.quantity, 0);
    const r = s.default_tax_rates?.[0];
    const tax = r ? Math.round((subtotal * r.percentage) / 100) : null;
    body = { object: "invoice", subscription: s.id, currency: "gbp", subtotal, tax, total: subtotal + (tax ?? 0), total_excluding_tax: subtotal, total_tax_amounts: r ? [{ amount: tax, inclusive: false, tax_rate: r.id }] : [], amount_due: subtotal + (tax ?? 0), automatic_tax: { enabled: false }, livemode: false };
  } else if (seg.length === 2) {
    const o = S.objects.get(seg[1]);
    if (!o) return done(sErr(404, `No such object: '${seg[1]}'`, "resource_missing"));
    body = clone(o);
    for (const p of expand) expandPath(body, p.split("."));
  } else if (isList) {
    const type = { subscriptions: "subscription", invoices: "invoice", charges: "charge", refunds: "refund" }[seg[0]];
    let all = [...S.objects.values()].filter((o) => o.object === type);
    if (seg[0] === "subscriptions") {
      const st = q.get("status");
      all = all.filter((s) => (st === "all" ? true : st ? s.status === st : s.status !== "canceled"));
    }
    for (const k of ["customer", "subscription", "charge"]) if (q.get(k)) all = all.filter((o) => o[k] === q.get(k));
    if (q.get("created[gte]")) all = all.filter((o) => o.created >= Number(q.get("created[gte]")));
    if (q.get("created[lte]")) all = all.filter((o) => o.created <= Number(q.get("created[lte]")));
    all.sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
    const limit = Number(q.get("limit") ?? 10);
    let start = 0;
    if (q.get("starting_after")) start = all.findIndex((o) => o.id === q.get("starting_after")) + 1;
    body = { object: "list", data: all.slice(start, start + limit).map(clone), has_more: start + limit < all.length, url: `/v1/${seg[0]}` };
    for (const p of expand) expandPath(body, p.split("."));
  } else return done(sErr(404, "Unrecognized request URL"));
  if (f === "livemode") {
    if (Array.isArray(body.data) && body.data.length) body.data[0].livemode = true;
    else body.livemode = true;
  }
  return done(json(body));
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick();
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("https://api.stripe.com/")) return stripeFetch(url, init);
  const body = init.body ? JSON.parse(init.body) : undefined;
  const prefer = (init.headers?.Prefer ?? "") as string;
  if (url.includes("/rest/v1/finance_access_grants")) {
    const m = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(m ? world.grants[m[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockHeld) return json(null);
    world.lockHeld = "22222222-2222-4222-8222-222222222222";
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rpc/finance_stripe_secret")) {
    const c = world.sb.finance_stripe_connections.find((r) => r.organisation_id === body?.p_organisation_id && r.status === "connected");
    return json(c ? world.secret : null);
  }
  if (url.includes("/rest/v1/finance_audit_events") && method === "POST") {
    if (world.auditStatus) return json({ message: "audit down" }, world.auditStatus);
    const evs = Array.isArray(body) ? body : [body];
    world.audit.push(...evs);
    return json(evs.map((_: any, i: number) => ({ id: `aud-${world.audit.length + i}` })), 201);
  }
  if (url.includes("/rest/v1/finance_stripe_")) return postgrest(url, method, body, prefer);
  if (url.startsWith("https://api.airtable.com/")) {
    if (method !== "GET") {
      world.airtableWrites++;
      return json({ error: "F10 must not write Airtable" }, 418);
    }
    if (url.includes(encodeURIComponent("Organisation & Branding"))) return json({ records: [ORG_ROW] });
    if (url.includes(encodeURIComponent("Feature Controls"))) return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
    if (url.includes(encodeURIComponent(PARENTS_TABLE))) return json({ records: world.parents });
    if (url.includes(encodeURIComponent(PARENT_PLAYER_LINKS_TABLE))) return json({ records: world.ppl });
    return json({ records: [] });
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

const deps: StripeDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  stripe: { requireTestMode: true, timeoutMs: 40, pageLimit: 2 },
};
const subs = (caller: any = mgr, q: any = {}, d: StripeDeps = deps) => listStripeSubscriptions(d, caller, q) as Promise<any>;
const subOne = (id: string, caller: any = mgr) => readStripeSubscription(deps, caller, id) as Promise<any>;
const pays = (caller: any = mgr, q: any = {}, d: StripeDeps = deps) => listStripePayments(d, caller, q) as Promise<any>;
const refs = (caller: any = mgr, q: any = {}) => listStripeRefunds(deps, caller, q) as Promise<any>;
const status = (caller: any = mgr, check = false) => readStripeStatus(deps, caller, check) as Promise<any>;
const link = (cus: string, pid: string, caller: any = mgr, reason = "Confirmed with the parent") => linkStripeCustomer(deps, caller, cus, pid, reason) as Promise<any>;
const byId = (list: any[], id: string, k = "subscriptionId") => list.find((x) => x[k] === id);
const conn = () => world.sb.finance_stripe_connections[0];
const writes = () => world.s.calls.filter((c) => c.method !== "GET").length;

async function main() {
  // ===== CN. Connection =====
  reset();
  {
    const st = await status(mgr, true);
    ck("CN1. A connected TEST account reports healthy: account read, recorded on the connection; mode test; read-only; the key never appears", st.httpStatus === 200 && st.body.check.ok === true && st.body.check.account.accountId === ACCT && conn().account_id === ACCT && st.body.connection.mode === "test" && st.body.readOnly === true && !JSON.stringify(st.body).includes(KEY), JSON.stringify(st.body.check));
    world.sb.finance_stripe_connections = [];
    const s0 = await status();
    const r0 = await subs();
    ck("CN2. No connection: status says not connected (readiness problem); reads refuse 409 stripe_not_connected with no Stripe call", s0.body.connection.connected === false && s0.body.readiness.problems[0].code === "stripe_not_connected" && r0.httpStatus === 409 && r0.code === "stripe_not_connected" && world.s.calls.length === 1);
    reset();
    world.sb.finance_stripe_connections = [connRow({ mode: "live" })];
    world.secret = LIVE_KEY;
    world.s.key = LIVE_KEY;
    const s1 = await status(mgr, true);
    const r1 = await subs();
    reset();
    world.secret = LIVE_KEY; // a test-mode row holding a live key
    const r2 = await subs();
    reset();
    world.s.faults.push({ op: "list", mode: "livemode", n: 1 });
    const r3 = await subs();
    ck("CN3. Live mode is blocked in TEST: a live connection, a live key on a test row, or any livemode object -> 409 stripe_live_mode_refused, nothing shown", s1.body.readiness.problems[0].code === "stripe_live_mode_refused" && s1.body.check.ran === false && r1.code === "stripe_live_mode_refused" && r2.code === "stripe_live_mode_refused" && r3.code === "stripe_live_mode_refused" && !r3.body);
    ck("CN3b. ... and the live key / live row reached Stripe zero times (only the injected livemode list call)", world.s.calls.length === 1);
    ck("CN4. Key mode parsing: sk_/rk_ test / live only", keyModeOf(KEY) === "test" && keyModeOf(LIVE_KEY) === "live" && keyModeOf("pk_test_abcdefghijk") === null && keyModeOf("sk_test_short") === null);
  }

  // ===== SB. Subscriptions =====
  reset();
  {
    const r = await subs();
    const list = r.body.subscriptions;
    const a = byId(list, "sub_active");
    ck("SB4. Active subscription read: state active (raw active), plan 55.00 / month, Stripe-authoritative", r.httpStatus === 200 && a.state === "active" && a.stripeStatus === "active" && a.stateReason === "renewing" && a.plan.gross === "55.00" && a.plan.interval === "month" && a.source === "stripe");
    const t = byId(list, "sub_trial");
    ck("SB5. Trialling read: state trialling; next collection = trial end (2026-10-08), expected not actual", t.state === "trialling" && t.nextCollection.date === "2026-10-08" && t.nextCollection.basis === "trial_end_first_charge" && t.nextCollection.actualRevenue === false);
    const c = byId(list, "sub_cancelling");
    ck("SB6. Cancelling read: active + cancel_at_period_end -> cancelling; no next collection; ends 2026-10-15", c.state === "cancelling" && c.stripeStatus === "active" && c.cancellation.atPeriodEnd === true && c.nextCollection.date === null && c.nextCollection.endsAt === "2026-10-15T00:00:00.000Z");
    const x = byId(list, "sub_cancelled");
    const map = ["incomplete", "incomplete_expired", "paused", "unpaid", "past_due", "canceled", "weird"].map((s) => subscriptionState({ status: s }));
    ck(
      "SB7. Cancelled / inactive read + the full documented mapping (raw status always kept)",
      x.state === "cancelled" && x.cancellation.canceledAt === "2026-09-01T10:00:00.000Z" && x.nextCollection.date === null &&
        JSON.stringify(map.map((m) => [m.stripeStatus, m.state, m.reason])) ===
          JSON.stringify([
            ["incomplete", "payment_issue", "first_payment_not_completed"],
            ["incomplete_expired", "inactive", "first_payment_never_completed"],
            ["paused", "inactive", "paused_trial_ended_without_payment_method"],
            ["unpaid", "payment_issue", "payment_failed_retries_exhausted"],
            ["past_due", "payment_issue", "payment_failed_stripe_retrying"],
            ["canceled", "cancelled", "cancelled"],
            ["weird", "unknown", "unrecognised_stripe_status"],
          ])
    );
    ck("SB8. Next renewal date = current period end (2026-10-15, local date) for an active subscription; newer API shape (period on items) also read", a.nextCollection.date === "2026-10-15" && a.currentPeriod.endDate === "2026-10-15" && periodOf({ items: { data: [{ current_period_start: 10, current_period_end: 99 }, { current_period_start: 20, current_period_end: 50 }] } }).end === 50);
    const rA = await subs(mgr, { customer: "cus_ZZA" });
    ck("SB9. Multiple subscriptions under one customer: cus_ZZA has 3, each its own row, one customer counted", rA.body.subscriptions.length === 3 && rA.body.summary.customers === 1 && rA.body.subscriptions.every((s: any) => s.customer.customerId === "cus_ZZA"));
    const pages = world.s.calls.filter((c) => c.path === "/subscriptions");
    ck("SB10. Pagination: every page is read (limit + starting_after until has_more is false) - 6 subscriptions over 3 pages of 2; status=all requested", list.length === 6 && pages.filter((c) => !c.query.includes("&customer=")).length === 3 && pages.some((c) => c.query.includes("starting_after=")) && pages.every((c) => c.query.includes("status=all")));
    const bounded = await subs(mgr, {}, { ...deps, stripe: { ...deps.stripe, maxPages: 2 } });
    ck("SB10b. Bounded reads: more than maxPages x limit -> 409 stripe_too_many_results, nothing partial returned", bounded.httpStatus === 409 && bounded.code === "stripe_too_many_results" && !bounded.body);
    ck("SB10c. One list call per page with expansion (no per-subscription customer / invoice calls)", world.s.calls.every((c) => !c.path.startsWith("/customers") && !c.path.startsWith("/invoices")));
    ck("SB10d. Counts by Hub state", JSON.stringify(r.body.summary.byState) === JSON.stringify({ active: 2, trialling: 1, payment_issue: 1, cancelling: 1, cancelled: 1 }));
  }

  // ===== PY. Payments =====
  reset();
  {
    const p = await pays();
    const list = p.body.payments;
    const ok1 = byId(list, "ch_ok1", "paymentId");
    ck("PY11. Successful payment: outcome succeeded, linked to its subscription via the invoice", p.httpStatus === 200 && ok1.outcome === "succeeded" && ok1.subscriptionId === "sub_active" && ok1.invoiceId === "in_paid1" && ok1.date === "2026-09-15");
    const f1 = byId(list, "ch_fail1", "paymentId");
    const pd = byId((await subs()).body.subscriptions, "sub_pastdue");
    ck("PY12. Failed payment: outcome failed, category insufficient_funds, never a receipt; the past-due subscription shows the failed collection + Stripe's next retry", f1.outcome === "failed" && f1.receipt === false && f1.failure.category === "insufficient_funds" && f1.failure.declineCode === "insufficient_funds" && pd.state === "payment_issue" && pd.latestCollection.outcome === "failed" && pd.latestCollection.nextRetryAt === "2026-10-03T06:00:00.000Z" && pd.nextCollection.date === "2026-10-03");
    ck("PY13. Gross amount = the charge (66.00)", ok1.gross === "66.00" && ok1.currency === "GBP");
    ck("PY14. Actual fee = Stripe's balance transaction fee (1.19), source stripe_balance_transaction", ok1.fee === "1.19" && ok1.feeSource === "stripe_balance_transaction");
    ck("PY15. Actual net = Stripe's balance transaction net (64.81)", ok1.netReceived === "64.81");
    ck("PY16. A successful payment is a trusted Stripe receipt (source stripe, receipt true) - never written as an F7 Finance Payment", ok1.receipt === true && ok1.source === "stripe" && world.airtableWrites === 0 && p.body.receiptRule.includes("succeeded"));
    const pend = byId(list, "ch_pend", "paymentId");
    const a = byId((await subs()).body.subscriptions, "sub_active");
    ck("PY17. Upcoming / pending is not Actual: a pending charge is no receipt (no fee guessed); the next renewal is kind expected, actualRevenue false, and absent from payments", pend.receipt === false && pend.fee === null && pend.feeSource === "not_applicable" && a.nextCollection.kind === "expected" && a.nextCollection.actualRevenue === false && !list.some((x: any) => x.paymentId.startsWith("in_")));
    const sum = p.body.summary.GBP;
    ck("PY17b. Window summary: receipts only (5 succeeded charges in window; old one excluded), gross / Stripe fees / net from balance transactions", sum.receipts === 4 && sum.failed === 1 && sum.pending === 1 && sum.grossReceived === "191.00" && sum.stripeFees === "3.67" && sum.netReceived === "187.33" && !list.some((x: any) => x.paymentId === "ch_old"), JSON.stringify(sum));
    const w = windowOf("2026-01-01", "2026-06-30", "2026-10-01") as any;
    ck("PY17c. Windows: default last 30 days; max 93 days; local midnight (BST) boundaries", p.body.window.from === "2026-09-02" && p.body.window.to === "2026-10-01" && w.code === "invalid_query" && localMidnightEpoch("2026-09-15", "Europe/London") === T("2026-09-14T23:00:00Z"));
  }

  // ===== RF. Refunds =====
  reset();
  {
    const r = await refs(mgr, {});
    const full = byId(r.body.refunds, "re_full", "refundId");
    ck("RF18. Full refund read: id, original payment, amount 30.00, date, status succeeded, source stripe, cash impact from its balance transaction", r.httpStatus === 200 && full.paymentId === "ch_full" && full.amount === "30.00" && full.status === "succeeded" && full.source === "stripe" && full.cashImpact === "-30.00" && full.date === "2026-09-10");
    const part = byId(r.body.refunds, "re_part", "refundId");
    const pch = byId((await pays()).body.payments, "ch_part", "paymentId");
    ck("RF19. Partial refund read: refund 15.00 of a 40.00 payment; the payment shows refundState partial", part.amount === "15.00" && pch.refundState === "partial" && pch.refunded === "15.00" && byId((await pays()).body.payments, "ch_full", "paymentId").refundState === "full");
    ck("RF20. A refund creates no Hub family credit: no Airtable write, no audit, no local row (only the connection health stamp)", world.airtableWrites === 0 && world.audit.length === 0 && world.sb.finance_stripe_customer_links.length === 0 && full.hubAction === "none");
    ck(
      "RF21. No refund / cancel / retry / write route exists; the fake Stripe saw zero non-GET requests",
      (matchStripeRoute("stripe/refunds", "POST") as any).status === "method" &&
        (matchStripeRoute("stripe/payments/ch_ok1/refund", "POST") as any).status === "not_found" &&
        (matchStripeRoute("stripe/subscriptions/sub_active/cancel", "POST") as any).status === "not_found" &&
        (matchStripeRoute("stripe/subscriptions/sub_active", "DELETE") as any).status === "method" &&
        writes() === 0
    );
    ck("RF21b. Refund summary per currency (succeeded total, pending)", r.body.summary.GBP.refunds === 3 && r.body.summary.GBP.refundedSucceeded === "45.00" && r.body.summary.GBP.pending === 1);
  }

  // ===== MP. Mapping =====
  reset();
  {
    const l = await link("cus_ZZA", "PARENT-TEST-001");
    const a = byId((await subs()).body.subscriptions, "sub_active");
    ck("MP22. Stored Stripe Customer ID mapping: Manage links cus_ZZA -> PARENT-TEST-001 (201, audited once); the subscription now shows the linked parent", l.httpStatus === 201 && world.sb.finance_stripe_customer_links.length === 1 && world.audit.length === 1 && world.audit[0].event_type === STRIPE_EVENTS.customerLinked && a.mapping.customer.state === "linked" && a.mapping.customer.parent.parentId === "PARENT-TEST-001");
    const b = byId((await subs()).body.subscriptions, "sub_cancelling");
    ck("MP23. No name-only / email-only match: cus_ZZB has the Hub parent's exact name and email and stays unlinked", b.customer.name === "Priya Parent" && b.customer.email === "parent.a@test.invalid" && b.mapping.customer.state === "unlinked" && /never matches by name or email/.test(b.mapping.customer.reason));
    ck("MP24. Multi-child parent handled safely: 3 active linked players (the Ended link not counted) -> player unresolved, never guessed", a.mapping.customer.parent.linkedPlayerCount === 3 && a.mapping.player.state === "unresolved" && a.mapping.player.player === null && /3 linked players/.test(a.mapping.player.reason));
    const l2 = await link("cus_ZZB", "PARENT-TEST-002");
    const b2 = byId((await subs()).body.subscriptions, "sub_cancelling");
    ck("MP25. Service / session mapping only where stable - none is, so it stays unresolved (Stripe price / product ids exposed for later mapping); a single-child parent's player is not inferred either", l2.httpStatus === 201 && a.mapping.service.state === "unresolved" && a.mapping.service.stripePriceIds[0] === "price_ppa" && a.mapping.service.stripeProductIds[0] === "prod_ppa" && b2.mapping.customer.parent.linkedPlayerCount === 1 && b2.mapping.player.state === "unresolved");
    reset();
    const u = byId((await subs()).body.subscriptions, "sub_notax");
    ck("MP26. An unmapped subscription stays explicit: customer unlinked, player + service unresolved, reasons given", u.mapping.customer.state === "unlinked" && u.mapping.customer.parent === null && u.mapping.player.state === "unresolved" && u.mapping.service.state === "unresolved");
    const dup = await link("cus_ZZA", "PARENT-DUP");
    const off = await link("cus_ZZA", "PARENT-OFF");
    const none = await link("cus_ZZA", "PARENT-NOPE");
    const del = await link("cus_ZZD", "PARENT-TEST-001");
    const ghost = await link("cus_ZZNONE", "PARENT-TEST-001");
    ck("MP26b. Link refusals: duplicated Parent ID -> 409 parent_id_ambiguous (never guessed); inactive / unknown parent; deleted or unknown Stripe customer -> 404", dup.code === "parent_id_ambiguous" && dup.details.parentRecordIds.length === 2 && off.code === "parent_inactive" && none.code === "parent_not_found" && del.code === "stripe_customer_not_found" && ghost.code === "stripe_customer_not_found" && world.sb.finance_stripe_customer_links.length === 0 && world.audit.length === 0);
    await link("cus_ZZA", "PARENT-TEST-001");
    const again = await link("cus_ZZA", "PARENT-TEST-001");
    const other = await link("cus_ZZA", "PARENT-TEST-002");
    const asView = await link("cus_ZZB", "PARENT-TEST-002", viewer);
    ck("MP26c. Repeating a link changes nothing (200, no second row / audit); a customer never belongs to two parents (409); View cannot link (403)", again.httpStatus === 200 && again.body.changed === false && other.code === "stripe_customer_linked_elsewhere" && asView.httpStatus === 403 && world.sb.finance_stripe_customer_links.length === 1 && world.audit.length === 1);
    world.auditStatus = 503;
    const noAudit = await link("cus_ZZB", "PARENT-TEST-002");
    ck("MP26d. A link that cannot be audited is undone (503 finance_audit_unavailable; no row left)", noAudit.code === "finance_audit_unavailable" && world.sb.finance_stripe_customer_links.length === 1);
    world.auditStatus = undefined;
  }

  // ===== VT. VAT =====
  reset();
  {
    const a = byId((await subs()).body.subscriptions, "sub_active");
    const d = await subOne("sub_active");
    ck("VT27. Tax breakdown read from Stripe where recorded: 66.00 = 55.00 net + 11.00 VAT (stripe_tax_rates); upcoming invoice preview likewise", a.latestCollection.vat.state === "recorded_by_stripe" && a.latestCollection.vat.vat === "11.00" && a.latestCollection.vat.netRevenue === "55.00" && a.latestCollection.vat.gross === "66.00" && d.body.subscription.nextCollection.vat.vat === "11.00" && d.body.subscription.nextCollection.gross === "66.00" && d.body.subscription.nextCollection.grossSource === "stripe_upcoming_invoice");
    const n = byId((await subs()).body.subscriptions, "sub_notax");
    const pay = byId((await pays()).body.payments, "ch_ok2", "paymentId");
    ck("VT28. No Stripe tax recorded -> explicit incomplete state (vat + net revenue null); gross is never assumed to be revenue", n.latestCollection.vat.state === "not_recorded_in_stripe" && n.latestCollection.vat.vat === null && n.latestCollection.vat.netRevenue === null && pay.vat.state === "not_recorded_in_stripe" && taxOfInvoice(null).state === "no_invoice");
  }

  // ===== AC. Access =====
  reset();
  {
    const reads = async (c: any) => [await status(c), await subs(c), await subOne("sub_active", c), await pays(c), await refs(c)];
    const v = await reads(viewer);
    const vw = [await link("cus_ZZA", "PARENT-TEST-001", viewer), await updateStripeSettings(deps, viewer, { feeEstimate: null, reason: null })] as any[];
    ck("AC29. View reads all five Stripe reads (access view); its writes are refused 403 finance_manage_required", v.every((r: any) => r.httpStatus === 200 && r.body.access === "view") && vw.every((r) => r.httpStatus === 403 && r.code === "finance_manage_required"));
    const m = await reads(mgr);
    ck("AC30. Manage reads the same (access manage)", m.every((r: any) => r.httpStatus === 200 && r.body.access === "manage"));
    const ng = await reads(nogrant);
    ck("AC31. No grant: every read denied (403 finance_access_denied), no Stripe call", ng.every((r: any) => r.httpStatus === 403 && r.code === "finance_access_denied"));
    const cp = [...(await reads(coach)), ...(await reads(parent))];
    ck("AC32. Coach / Parent denied (403 management_required)", cp.every((r: any) => r.httpStatus === 403 && r.code === "management_required"));
    world.moduleOn = false;
    const mo = await reads(mgr);
    ck("AC33. module_finance off: denied (403 finance_module_disabled)", mo.every((r: any) => r.httpStatus === 403 && r.code === "finance_module_disabled"));
    const t1 = parseStripeQuery("stripe.subscriptions", new URLSearchParams("organisationId=ORG-X"), isTenantKey) as any;
    const t2 = parseParentLink('{"parentId":"PARENT-TEST-001","reason":"x","tenantId":"t"}', isTenantKey) as any;
    const t3 = parseStripeSettings('{"feeEstimate":null,"baseId":"appX"}', isTenantKey) as any;
    const t4 = parseStripeQuery("stripe.payments", new URLSearchParams("from=2026-09-01&org=ORG-X"), isTenantKey) as any;
    ck("AC34. Tenant override rejected (query and body): 400 tenant_param_rejected", [t1, t2, t3, t4].every((t) => t.code === "tenant_param_rejected"));
    const q1 = parseStripeQuery("stripe.payments", new URLSearchParams("from=2026-02-30"), isTenantKey) as any;
    const q2 = parseStripeQuery("stripe.subscriptions", new URLSearchParams("limit=5"), isTenantKey) as any;
    const q3 = parseStripeQuery("stripe.subscriptions", new URLSearchParams("customer=bob"), isTenantKey) as any;
    ck("AC34b. Query validation: real dates only, only the route's own keys, Stripe-shaped ids", q1.code === "invalid_query" && q2.code === "unexpected_parameter" && q3.code === "invalid_query");
  }

  // ===== FR. Freshness / errors =====
  reset();
  {
    const r = await subs();
    ck("FR35. Freshness: every read carries source (stripe, account, mode, label, apiVersion), fetchedAt = now, cached false; the API version is pinned on every call", r.body.source.provider === "stripe" && r.body.source.fetchedAt === NOW.toISOString() && r.body.source.cached === false && r.body.source.mode === "test" && r.body.source.apiVersion === STRIPE_API_VERSION && world.s.calls.every((c) => c.version === STRIPE_API_VERSION));
    world.s.faults.push({ op: "list", mode: "timeout", n: 1 });
    const t = await subs();
    ck("FR36. Provider timeout is safe: 503 stripe_unavailable, no data, recorded as the connection's last error", t.httpStatus === 503 && t.code === "stripe_unavailable" && !t.body && conn().last_error_code === "stripe_unavailable");
    world.s.faults.push({ op: "list", mode: "rate_limit", n: 1 }, { op: "list", mode: "malformed", n: 1 }, { op: "retrieve", mode: "fail_500", n: 1 });
    const rl = await subs();
    const mf = await subs();
    const f5 = await subOne("sub_active");
    ck("FR36b. Rate limit -> 503 stripe_rate_limited; unreadable answer -> 502 stripe_response_invalid; server error -> 503", rl.code === "stripe_rate_limited" && mf.code === "stripe_response_invalid" && f5.code === "stripe_unavailable");
    world.s.faults.push({ op: "page", mode: "fail_500", n: 1 });
    const pf = await subs();
    ck("FR37. A failure on a later page is explicit: 502 stripe_pagination_failed, nothing partial returned", pf.httpStatus === 502 && pf.code === "stripe_pagination_failed" && !pf.body);
    reset();
    const before = JSON.stringify({ sb: world.sb.finance_stripe_customer_links });
    for (let i = 0; i < 3; i++) {
      await subs();
      await pays();
      await refs();
      await subOne("sub_active");
    }
    const stamps = conn().last_success_at;
    NOW = new Date(NOW.getTime() + 5_000);
    await subs();
    ck("FR38. Repeated reads create no audit, no mapping / cache rows, no Airtable write; the health stamp is throttled (not rewritten within 60 s)", world.audit.length === 0 && JSON.stringify({ sb: world.sb.finance_stripe_customer_links }) === before && world.airtableWrites === 0 && conn().last_success_at === stamps && stamps === "2026-10-01T12:00:00.000Z");
    const nf = await subOne("sub_ZZnothing");
    ck("FR38b. Unknown subscription -> 404 stripe_subscription_not_found", nf.httpStatus === 404 && nf.code === "stripe_subscription_not_found");
  }

  // ===== Settings (fee estimate) =====
  reset();
  {
    const bad = parseStripeSettings('{"feeEstimate":{"percentBasisPoints":5000,"fixedMinor":20}}', isTenantKey) as any;
    const p = parseStripeSettings('{"feeEstimate":{"percentBasisPoints":150,"fixedMinor":20},"reason":"Stripe UK standard card pricing (estimate)"}', isTenantKey) as any;
    const s = (await updateStripeSettings(deps, mgr, p)) as any;
    const same = (await updateStripeSettings(deps, mgr, p)) as any;
    const a = byId((await subs()).body.subscriptions, "sub_active");
    const pay = byId((await pays()).body.payments, "ch_ok1", "paymentId");
    ck("ST1. Fee estimate (Manage, audited once; identical update changes nothing): future charges show an ESTIMATED fee / net; completed charges keep Stripe's actual fee", bad.code === "invalid_input" && s.body.changed === true && same.body.changed === false && world.audit.filter((e) => e.event_type === STRIPE_EVENTS.settingsUpdated).length === 1 && a.nextCollection.fee.estimated === true && a.nextCollection.fee.amount === "1.03" && a.nextCollection.netCash === "53.97" && a.nextCollection.feeState === "estimated" && pay.fee === "1.19");
    reset();
    const a0 = byId((await subs()).body.subscriptions, "sub_active");
    ck("ST2. With no estimate configured, expected fee / net are deferred (never guessed)", a0.nextCollection.fee === null && a0.nextCollection.netCash === null && a0.nextCollection.feeState === "not_configured" && a0.nextCollection.gross === "55.00");
    const all = JSON.stringify(R) + JSON.stringify(world.audit);
    ck("ST3. The key never appears in any response or audit payload", !all.includes(KEY));
  }

  // ===== Z. Code / drift =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ck("Z1. finance-stripe.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(noComments(code("finance-stripe.ts"))));
    const prov = noComments(code("finance-stripe-provider.ts"));
    ck("Z2. The provider is the only HTTP to Stripe and only ever sends GET (no POST / DELETE / refund / cancel)", /fetch\(/.test(prov) && (prov.match(/method:\s*"([A-Z]+)"/g) ?? []).every((m) => m.includes('"GET"')) && !/refund\(|cancel\(|"POST"|"DELETE"|"PATCH"/.test(prov) && !/fetch\(/.test(noComments(code("finance-stripe-orchestrator.ts"))));
    ck("Z3. Reads authorise View, writes Manage, via F1 authorizeFinance; local writes take the shared Finance write lock", /authorizeFinance\(deps, caller, level\)/.test(code("finance-stripe-orchestrator.ts")) && /openStripeSession\(deps, caller, "read"\)/.test(code("finance-stripe-orchestrator.ts")) && /acquireWriteLock/.test(code("finance-stripe-orchestrator.ts")));
    ck("Z4. F10 never writes Airtable, Finance Payments or family credit (no Airtable write helper, no F7 payment / credit code)", !/createRow|patchRow|recordPayment|Finance Payments|Client Credits|airtableFetch\([^)]*method/.test(noComments(code("finance-stripe-orchestrator.ts") + code("finance-stripe-repository.ts"))));
    const idx = code("index.ts");
    ck("Z5. index.ts routes F10 first (stripe/... only) and keeps the TEST guard requireTestMode", idx.indexOf("matchStripeRoute(route") < idx.indexOf("matchXeroRoute(route") && /stripe: \{ requireTestMode: true \}/.test(idx));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z6. No F10 code in the 12 Finance modules shared with Needs Attention (so the NA bundle is unchanged)", shared.every((f) => !/finance-stripe/.test(code(f))));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z7. Test copies match the canonical finance files (only import paths swapped)", copy("finance-stripe.ts") && copy("finance-stripe-provider.ts") && copy("finance-stripe-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-stripe-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    ck("Z8. No Josh Evans naming, live keys or Stripe account ids hard-coded in F10 code", !/Josh|sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]|acct_[A-Za-z0-9]{6}/.test(code("finance-stripe.ts") + code("finance-stripe-provider.ts") + code("finance-stripe-repository.ts") + code("finance-stripe-orchestrator.ts")));
    ck("Z9. No webhook, Cash Flow, F11 credit / F21 refund execution or Needs Attention code in F10", !/webhook\s*\(|cashFlow|createFamilyCredit|executeRefund|needs-attention/i.test(noComments(code("finance-stripe.ts") + code("finance-stripe-orchestrator.ts"))));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
