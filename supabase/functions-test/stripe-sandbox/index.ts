/**
 * stripe-sandbox - TEST ONLY. A small emulator of the Stripe API surface the
 * Finance F10 connector reads and the F21 refund writer calls, so the
 * connector's REAL HTTP adapters can be live-proven in TEST without real
 * Stripe credentials (see TEST-ENV.md "Finance Foundation - F10" / "F21").
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
 * The ONLY write (F21, v2): POST /v1/refunds (form-encoded: charge, amount,
 * reason, metadata[...]). Every other NON-GET request is refused with 405 and
 * logged. Auth: `Authorization: Bearer <key>`, matched by sha256.
 *   - Permission: the account's refund_write flag (a restricted key without
 *     Refunds write) -> 403, exactly as Stripe answers a restricted key.
 *   - Idempotency-Key: a stored 200 is replayed for the same key + params
 *     (header Idempotent-Replayed: true); the same key with other params ->
 *     400 idempotency_error. Only creations are stored (as Stripe stores only
 *     requests that started executing).
 *   - Validation: unknown charge -> 400 resource_missing; nothing left ->
 *     400 charge_already_refunded; amount > unrefunded -> 400 amount_too_large.
 *   - A created refund: re_ZZTEST21..., livemode false, metadata kept; the
 *     charge's amount_refunded counts pending + succeeded refunds (failed /
 *     canceled give it back).
 * Faults: public.stripe_sandbox_faults (op account | list | page | retrieve |
 * upcoming; mode fail_500 | rate_limit | timeout | malformed | livemode).
 * "page" is consulted only for a list request carrying starting_after.
 * Refund faults (op refund_create): fail_500 | rate_limit | timeout (no refund
 * created, answers after 20s) | timeout_after_accept (refund created, answer
 * after 20s) | malformed (refund created, unreadable answer) |
 * permission_denied (403) | refund_pending | refund_requires_action |
 * refund_failed | refund_canceled | refund_pending_then_succeeded /
 * refund_pending_then_failed (pending; the next read of it at least
 * SETTLE_SECONDS later finds it settled - Stripe's asynchronous outcome,
 * without webhooks). op idempotency, mode expired: the next POST whose key
 * is stored ignores the stored result (Stripe pruned the key after ~24h).
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
async function saveObject(account: string, o: Record<string, any>) {
  await db("stripe_sandbox_objects?on_conflict=account_id,id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ account_id: account, id: o.id, object: o.object, created: o.created, data: o }) });
}

// ----- refunds (F21) -----
const SETTLE_SECONDS = 2;
const LIVE_REFUND = (st: string) => st === "pending" || st === "requires_action" || st === "succeeded";
/** A pending refund created with a _sandbox_settle instruction settles on a read at least SETTLE_SECONDS after creation. */
async function settled(account: string, r: Record<string, any>): Promise<Record<string, any>> {
  const s = r._sandbox_settle;
  if (!s || r.status !== "pending" || Math.floor(Date.now() / 1000) < r.created + SETTLE_SECONDS) return r;
  r.status = s.to;
  if (s.to === "failed") r.failure_reason = "expired_or_canceled_card";
  delete r._sandbox_settle;
  await saveObject(account, r);
  if (!LIVE_REFUND(r.status)) {
    const ch = await one(account, typeof r.charge === "string" ? r.charge : r.charge?.id);
    if (ch) {
      ch.amount_refunded = Math.max(0, (ch.amount_refunded ?? 0) - r.amount);
      ch.refunded = ch.amount_refunded === ch.amount;
      await saveObject(account, ch);
    }
  }
  return r;
}
const publicView = (o: any): any => {
  if (Array.isArray(o)) return o.map(publicView);
  if (!o || typeof o !== "object") return o;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith("_sandbox")) out[k] = publicView(v);
  return out;
};
async function settleAll(account: string, body: any) {
  if (body?.object === "refund") return settled(account, body);
  if (body?.object === "list" && Array.isArray(body.data)) body.data = await Promise.all(body.data.map((x: any) => (x?.object === "refund" ? settled(account, x) : x)));
  return body;
}
function randomId(n: number) {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join("");
}
const STATUS_FAULT: Record<string, string> = { refund_pending: "pending", refund_requires_action: "requires_action", refund_failed: "failed", refund_canceled: "canceled", refund_pending_then_succeeded: "pending", refund_pending_then_failed: "pending" };

/** POST /v1/refunds - the one write F21 needs. */
async function createRefund(req: Request, acct: Record<string, any>, path: string, note: string): Promise<Response> {
  const account = acct.account_id as string;
  const raw = await req.text();
  const form = new URLSearchParams(raw);
  const key = req.headers.get("Idempotency-Key");
  if (!acct.refund_write) {
    await logReq("POST", path, 403, `refund refused: key lacks Refunds write (${note})`);
    return json(err(403, "invalid_request_error", "The provided key does not have the required permissions for this endpoint on this account. Having the 'rak_refund_write' permission would allow this request to continue.", "permission_denied").body, 403);
  }
  const f = await fault("refund_create");
  if (f === "permission_denied") {
    await logReq("POST", path, 403, `fault permission_denied (${note})`);
    return json(err(403, "invalid_request_error", "The provided key does not have the required permissions for this endpoint (fault injection).", "permission_denied").body, 403);
  }
  if (f === "fail_500") {
    await logReq("POST", path, 500, `fault fail_500 - no refund created (${note})`);
    return json(err(500, "api_error", "Sandbox server error (fault injection)").body, 500);
  }
  if (f === "rate_limit") {
    await logReq("POST", path, 429, `fault rate_limit - no refund created (${note})`);
    return json(err(429, "rate_limit_error", "Too many requests (fault injection)", "rate_limit").body, 429);
  }
  if (f === "timeout") {
    await logReq("POST", path, null, `fault timeout before accept: no refund created, answering after 20s (${note})`);
    await sleep(20_000);
    return json(err(500, "api_error", "Sandbox timed out before accepting (fault injection)").body, 500);
  }
  // Idempotency: replay a stored creation for the same key + params.
  const paramsSha = await sha256([...form.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&"));
  if (key) {
    const stored = (await db(`stripe_sandbox_idempotency?account_id=eq.${enc(account)}&key=eq.${enc(key)}&select=*`))[0];
    if (stored) {
      const expired = (await fault("idempotency")) === "expired";
      if (!expired) {
        if (stored.params_sha256 !== paramsSha) {
          await logReq("POST", path, 400, `idempotency_error: key reused with other params (${note})`);
          return json(err(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.", "idempotency_key_in_use").body, 400);
        }
        await logReq("POST", path, stored.status, `idempotent replay (${note})`);
        return new Response(JSON.stringify(publicView(stored.body)), { status: stored.status, headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" } });
      }
      await logReq("POST", path, null, `fault idempotency expired: stored key ignored (${note})`);
    }
  }
  const chargeId = form.get("charge");
  const ch = chargeId ? await one(account, chargeId) : null;
  if (!ch || ch.object !== "charge") {
    await logReq("POST", path, 400, `no such charge (${note})`);
    return json(err(400, "invalid_request_error", `No such charge: '${chargeId ?? ""}'`, "resource_missing").body, 400);
  }
  const left = ch.amount - (ch.amount_refunded ?? 0);
  if (left <= 0) {
    await logReq("POST", path, 400, `charge already refunded (${note})`);
    return json(err(400, "invalid_request_error", `Charge ${ch.id} has already been refunded.`, "charge_already_refunded").body, 400);
  }
  const amount = form.has("amount") ? Number(form.get("amount")) : left;
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    await logReq("POST", path, 400, `invalid amount (${note})`);
    return json(err(400, "invalid_request_error", "Invalid positive integer: amount", "parameter_invalid_integer").body, 400);
  }
  if (amount > left) {
    await logReq("POST", path, 400, `amount too large (${note})`);
    return json(err(400, "invalid_request_error", `Refund amount (${amount}) is greater than unrefunded amount on charge (${left})`, "amount_too_large").body, 400);
  }
  const metadata: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    const m = /^metadata\[([^\]]{1,40})\]$/.exec(k);
    if (m) metadata[m[1]] = v.slice(0, 500);
  }
  const status = (f && STATUS_FAULT[f]) || "succeeded";
  const now = Math.floor(Date.now() / 1000);
  const refund: Record<string, any> = {
    id: `re_ZZTEST21${randomId(14)}`,
    object: "refund",
    amount,
    charge: ch.id,
    currency: ch.currency,
    created: now,
    livemode: false,
    metadata,
    reason: form.get("reason"),
    status,
    payment_intent: ch.payment_intent ?? null,
    balance_transaction: null,
    failure_reason: status === "failed" ? "expired_or_canceled_card" : null,
    ...(f === "refund_pending_then_succeeded" ? { _sandbox_settle: { to: "succeeded" } } : f === "refund_pending_then_failed" ? { _sandbox_settle: { to: "failed" } } : {}),
  };
  await saveObject(account, refund);
  if (LIVE_REFUND(status)) {
    ch.amount_refunded = (ch.amount_refunded ?? 0) + amount;
    ch.refunded = ch.amount_refunded === ch.amount;
    await saveObject(account, ch);
  }
  const body = publicView(refund);
  if (key) await db("stripe_sandbox_idempotency?on_conflict=account_id,key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ account_id: account, key, params_sha256: paramsSha, status: 200, body: refund }) });
  if (f === "timeout_after_accept") {
    await logReq("POST", path, null, `fault timeout after accept: refund ${refund.id} created, answering after 20s (${note})`);
    await sleep(20_000);
    return json(body, 200);
  }
  if (f === "malformed") {
    await logReq("POST", path, 200, `fault malformed after accept: refund ${refund.id} created (${note})`);
    return new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } });
  }
  await logReq("POST", path, 200, `refund ${refund.id} ${status}${f ? ` (fault ${f})` : ""} (${note})`);
  return json(body, 200);
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
    if (method === "POST" && path.replace(/\/+$/, "") === "/v1/refunds") return await createRefund(req, acct, path, note);
    if (method !== "GET") {
      await logReq(method, path, 405, `write refused (${note})`);
      return json(err(405, "invalid_request_error", "stripe-sandbox emulates GET reads and POST /v1/refunds only").body, 405);
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
      out = o && o.object === want ? { status: 200, body: await expandAll(account, await settleAll(account, o), expand) } : err(404, "invalid_request_error", `No such ${want}: '${seg[1]}'`, "resource_missing");
    } else if (isList) {
      const type = { subscriptions: "subscription", invoices: "invoice", charges: "charge", refunds: "refund" }[seg[0]] as string;
      let all = await ofType(account, type);
      if (type === "refund") all = await Promise.all(all.map((r) => settled(account, r)));
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
    return json(publicView(out.body), out.status);
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
