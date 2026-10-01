/**
 * stripe-sandbox - TEST ONLY. A small READ-ONLY emulator of the Stripe API
 * surface the Finance F10 connector reads, so the connector's REAL HTTP
 * adapter can be live-proven in TEST without real Stripe credentials (see
 * TEST-ENV.md "Finance Foundation - F10").
 *
 * It is NOT Stripe and proves nothing about Stripe itself. Objects are
 * fixtures in public.stripe_sandbox_objects (Stripe-shaped JSON, ids
 * cus_ / sub_ / in_ / ch_ / re_ / txn_ prefixed ZZTEST), always livemode
 * false; the connector labels every read "Stripe (TEST sandbox - emulator,
 * not real Stripe)".
 *
 * Surface (paths relative to /functions/v1/stripe-sandbox), GET only:
 *   /v1/account
 *   /v1/customers/{id}
 *   /v1/subscriptions            ?status (all | a status; default: not canceled) &customer &limit &starting_after &expand[]
 *   /v1/subscriptions/{id}       &expand[]
 *   /v1/invoices                 ?subscription &customer &limit &starting_after &expand[]
 *   /v1/invoices/upcoming        ?subscription  (computed preview; 404 invoice_upcoming_none when nothing will be billed)
 *   /v1/charges                  ?customer &created[gte] &created[lte] &limit &starting_after &expand[]
 *   /v1/refunds                  ?charge &created[gte] &created[lte] &limit &starting_after &expand[]
 * Lists: newest first (created desc, id desc), limit 1-100 (default 10),
 * has_more + starting_after. expand[] replaces stored ids (customer,
 * latest_invoice, charge, balance_transaction, invoice, product) with the
 * stored objects, through lists ("data.") and nested paths.
 * Every NON-GET request is refused with 405 and logged (the connector never
 * writes). Auth: `Authorization: Bearer <key>`, matched by sha256.
 * Faults: public.stripe_sandbox_faults (op account | list | page | retrieve |
 * upcoming; mode fail_500 | rate_limit | timeout | malformed | livemode).
 * "page" is consulted only for a list request carrying starting_after.
 * Every request is logged in public.stripe_sandbox_requests (method, path,
 * status, the Stripe-Version sent - never the key or query values).
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
if (["bkkukymqaxawnudoxdjs"].some((ref) => (SUPABASE_URL || "").includes(ref))) {
  throw new Error("stripe-sandbox refusing to start: this is a TEST-only emulator and SUPABASE_URL is the production project.");
}

type Out = { status: number; body: unknown };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (status: number, type: string, message: string, code?: string): Out => ({ status, body: { error: { type, message, ...(code ? { code } : {}) } } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`sandbox db ${path}: ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  return db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
}
const enc = encodeURIComponent;
async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const fault = async (op: string): Promise<string | null> => (await rpc("stripe_sandbox_take_fault", { p_op: op })) as string | null;
async function logReq(method: string, path: string, status: number | null, note: string | null) {
  await db("stripe_sandbox_requests", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ method, path, status, note }) }).catch((e) => console.error(e));
}

// ----- store -----
async function one(account: string, id: string): Promise<Record<string, any> | null> {
  const rows = await db(`stripe_sandbox_objects?account_id=eq.${enc(account)}&id=eq.${enc(id)}&select=data`);
  return rows.length ? structuredClone(rows[0].data) : null;
}
async function ofType(account: string, object: string): Promise<Record<string, any>[]> {
  const rows = await db(`stripe_sandbox_objects?account_id=eq.${enc(account)}&object=eq.${enc(object)}&select=data&order=created.desc,id.desc`);
  return rows.map((r: any) => structuredClone(r.data));
}

const EXPANDABLE = /^(cus|in|ch|py|txn|prod|sub|pi|re)_/;
/** Replaces stored ids along one expand path (e.g. data.latest_invoice.charge.balance_transaction). */
async function expandPath(account: string, target: any, segs: string[]): Promise<any> {
  if (target === null || target === undefined || !segs.length) return target;
  if (Array.isArray(target)) return Promise.all(target.map((t) => expandPath(account, t, segs)));
  if (typeof target !== "object") return target;
  const [k, ...rest] = segs;
  let v = target[k];
  if (typeof v === "string" && EXPANDABLE.test(v)) v = (await one(account, v)) ?? v;
  if (rest.length) v = await expandPath(account, v, rest);
  target[k] = v;
  return target;
}
async function expandAll(account: string, target: any, paths: string[]) {
  for (const p of paths) {
    if (p.split(".").length > 4 + (p.startsWith("data.") ? 1 : 0)) throw Object.assign(new Error("too deep"), { out: err(400, "invalid_request_error", `You cannot expand more than 4 levels of a property. Property: ${p}`) });
    await expandPath(account, target, p.split("."));
  }
  return target;
}

function page(all: Record<string, any>[], q: URLSearchParams, url: string): Out {
  const limit = q.has("limit") ? Number(q.get("limit")) : 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, "invalid_request_error", "Invalid integer: limit must be between 1 and 100");
  let start = 0;
  const after = q.get("starting_after");
  if (after) {
    const i = all.findIndex((o) => o.id === after);
    if (i < 0) return err(400, "invalid_request_error", `No such object: '${after}'`, "resource_missing");
    start = i + 1;
  }
  const data = all.slice(start, start + limit);
  return { status: 200, body: { object: "list", data, has_more: start + limit < all.length, url } };
}
const createdOk = (o: Record<string, any>, q: URLSearchParams) => {
  const gte = q.get("created[gte]");
  const lte = q.get("created[lte]");
  return (gte === null || o.created >= Number(gte)) && (lte === null || o.created <= Number(lte));
};

/** Stripe's preview of the subscription's next invoice, computed from the stored subscription. */
async function upcoming(account: string, subId: string | null): Promise<Out> {
  if (!subId) return err(400, "invalid_request_error", "Missing required param: subscription or customer");
  const sub = await one(account, subId);
  if (!sub) return err(404, "invalid_request_error", `No such subscription: '${subId}'`, "resource_missing");
  if (["canceled", "incomplete_expired"].includes(sub.status) || sub.cancel_at_period_end === true) return err(404, "invalid_request_error", "No upcoming invoices for customer", "invoice_upcoming_none");
  const items: any[] = sub.items?.data ?? [];
  const subtotal = items.reduce((a, i) => a + (i.price?.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  const rate = sub.default_tax_rates?.[0];
  let tax: number | null = null;
  let total = subtotal;
  let excl = subtotal;
  const taxAmounts: any[] = [];
  if (rate && typeof rate.percentage === "number") {
    if (rate.inclusive) {
      tax = Math.round(subtotal - subtotal / (1 + rate.percentage / 100));
      excl = subtotal - tax;
    } else {
      tax = Math.round((subtotal * rate.percentage) / 100);
      total = subtotal + tax;
    }
    taxAmounts.push({ amount: tax, inclusive: !!rate.inclusive, tax_rate: rate.id ?? "txr_zztest" });
  }
  return {
    status: 200,
    body: {
      object: "invoice",
      customer: sub.customer,
      subscription: sub.id,
      currency: items[0]?.price?.currency ?? "gbp",
      period_start: sub.current_period_end,
      next_payment_attempt: sub.status === "trialing" ? sub.trial_end : sub.current_period_end,
      subtotal,
      tax,
      total,
      total_excluding_tax: excl,
      total_tax_amounts: taxAmounts,
      amount_due: total,
      livemode: false,
      lines: { object: "list", data: items.map((i) => ({ object: "line_item", amount: (i.price?.unit_amount ?? 0) * (i.quantity ?? 1), price: i.price, quantity: i.quantity ?? 1 })), has_more: false },
    },
  };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/stripe-sandbox/, "") || "/";
  const method = req.method.toUpperCase();
  const version = req.headers.get("Stripe-Version");
  const note = version ? `v=${version}` : "no Stripe-Version";
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  try {
    const acct = m ? (await db(`stripe_sandbox_accounts?key_sha256=eq.${await sha256(m[1])}&select=*`))[0] : null;
    if (!acct) {
      await logReq(method, path, 401, "invalid key");
      return json(err(401, "invalid_request_error", "Invalid API Key provided").body, 401);
    }
    if (method !== "GET") {
      await logReq(method, path, 405, `write refused (${note})`);
      return json(err(405, "invalid_request_error", "stripe-sandbox is read-only: only GET is emulated").body, 405);
    }
    const account = acct.account_id as string;
    const seg = path.replace(/^\/v1\/?/, "").split("/").filter(Boolean);
    const q = url.searchParams;
    const expand = q.getAll("expand[]");
    const isList = seg.length === 1 && ["subscriptions", "invoices", "charges", "refunds"].includes(seg[0]);
    const op = seg[0] === "account" ? "account" : seg[0] === "invoices" && seg[1] === "upcoming" ? "upcoming" : isList ? (q.get("starting_after") ? "page" : "list") : "retrieve";
    const f = await fault(op);
    if (f === "fail_500") {
      await logReq(method, path, 500, `fault fail_500 (${note})`);
      return json(err(500, "api_error", "Sandbox server error (fault injection)").body, 500);
    }
    if (f === "rate_limit") {
      await logReq(method, path, 429, `fault rate_limit (${note})`);
      return json(err(429, "rate_limit_error", "Too many requests (fault injection)", "rate_limit").body, 429);
    }
    if (f === "malformed") {
      await logReq(method, path, 200, `fault malformed (${note})`);
      return new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (f === "timeout") {
      await logReq(method, path, null, `fault timeout: answering after 20s (${note})`);
      await sleep(20_000);
    }
    let out: Out;
    if (seg[0] === "account" && seg.length === 1) out = { status: 200, body: { id: account, object: "account", country: "GB", default_currency: "gbp", settings: { dashboard: { display_name: acct.display_name } }, business_profile: { name: acct.display_name } } };
    else if (seg[0] === "invoices" && seg[1] === "upcoming" && seg.length === 2) out = await upcoming(account, q.get("subscription"));
    else if (seg.length === 2 && ["customers", "subscriptions", "invoices", "charges", "refunds"].includes(seg[0])) {
      const o = await one(account, seg[1]);
      const want = { customers: "customer", subscriptions: "subscription", invoices: "invoice", charges: "charge", refunds: "refund" }[seg[0]];
      out = o && o.object === want ? { status: 200, body: await expandAll(account, o, expand) } : err(404, "invalid_request_error", `No such ${want}: '${seg[1]}'`, "resource_missing");
    } else if (isList) {
      const type = { subscriptions: "subscription", invoices: "invoice", charges: "charge", refunds: "refund" }[seg[0]] as string;
      let all = await ofType(account, type);
      if (seg[0] === "subscriptions") {
        const st = q.get("status");
        all = all.filter((s) => (st === "all" ? true : st ? s.status === st : s.status !== "canceled"));
      }
      for (const k of ["customer", "subscription", "charge"]) {
        const v = q.get(k);
        if (v) all = all.filter((o) => (typeof o[k] === "string" ? o[k] : o[k]?.id) === v);
      }
      all = all.filter((o) => createdOk(o, q));
      out = page(all, q, `/v1/${seg[0]}`);
      if (out.status === 200) await expandAll(account, out.body, expand);
    } else out = err(404, "invalid_request_error", `Unrecognized request URL (GET: ${path})`);
    if (f === "livemode" && out.status === 200) {
      const b = out.body as any;
      if (Array.isArray(b.data) && b.data.length) b.data[0].livemode = true;
      else b.livemode = true;
    }
    await logReq(method, path, out.status, f ? `fault ${f} (${note})` : note);
    return json(out.body, out.status);
  } catch (e) {
    const o = (e as any)?.out as Out | undefined;
    if (o) {
      await logReq(method, path, o.status, note);
      return json(o.body, o.status);
    }
    console.error(e);
    await logReq(method, path, 500, "sandbox internal error");
    return json(err(500, "api_error", "Sandbox error").body, 500);
  }
});
