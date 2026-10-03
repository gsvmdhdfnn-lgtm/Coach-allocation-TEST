/**
 * Stripe REFUND provider adapter (Finance Foundation F21; see TEST-ENV.md
 * "Finance Foundation - F21"). The ONLY code that writes to Stripe, and it
 * can make exactly one kind of write: create a refund. It also retrieves one
 * refund (for reconciliation). F10's read provider stays GET-only; charges
 * and a charge's refund list are read through it.
 *
 *   - Auth: `Authorization: Bearer <key>` - the organisation's ONE Stripe
 *     connection key (locked decision D2), read from Supabase Vault for one
 *     request, never stored, logged, audited or returned. Refund-write
 *     permission is never assumed: Stripe's 403 is reported as such.
 *   - Every request pins `Stripe-Version` (F10's STRIPE_API_VERSION).
 *   - POST /v1/refunds is form-encoded (charge, amount, reason, metadata[...])
 *     and ALWAYS carries the execution's stable Idempotency-Key.
 *   - TEST guard: with requireTestMode, a response reporting livemode:true is
 *     refused (kind "live_data") - the key-mode guard stops it earlier.
 */
import { STRIPE_API_VERSION } from "./finance-stripe.ts";
import type { FailKind, PR, ProviderFail } from "./finance-stripe-provider.ts";

export const REFUND_TIMEOUT_MS = 15_000;

export interface StripeRefundProvider {
  /** POST /v1/refunds with the given Idempotency-Key; the raw Stripe refund object. */
  createRefund(p: { chargeId: string; amountMinor: number; reason: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<PR<Record<string, any>>>;
  /** GET /v1/refunds/{id}; null when Stripe has no such refund. */
  refund(refundId: string): Promise<PR<Record<string, any> | null>>;
  /** Calls made (method + path + status only - never headers, keys or bodies). */
  callLog(): { method: string; path: string; status: number | null }[];
}

const fail = (kind: FailKind, status: number | null, message: string, stripeCode: string | null = null): ProviderFail => ({ ok: false, kind, status, message, stripeCode });

export function httpStripeRefundProvider(o: { baseUrl: string; secretKey: string; requireTestMode: boolean; timeoutMs?: number }): StripeRefundProvider {
  const timeoutMs = o.timeoutMs ?? REFUND_TIMEOUT_MS;
  const log: { method: string; path: string; status: number | null }[] = [];

  async function call(method: "GET" | "POST", path: string, form: URLSearchParams | null, idempotencyKey: string | null): Promise<PR<any>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${o.secretKey}`, "Stripe-Version": STRIPE_API_VERSION, Accept: "application/json" };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let res: Response;
    try {
      res = await fetch(`${o.baseUrl}${path}`, { method, headers, body: form ? form.toString() : undefined, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const aborted = (e as Error)?.name === "AbortError";
      log.push({ method, path, status: null });
      return fail(aborted ? "timeout" : "unreachable", null, aborted ? `Stripe did not answer within ${Math.round(timeoutMs / 1000)}s` : "Stripe could not be reached");
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      clearTimeout(timer);
      log.push({ method, path, status: res.status });
      return fail("timeout", res.status, "Stripe's answer was cut off");
    }
    clearTimeout(timer);
    log.push({ method, path, status: res.status });
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
    const err = body && typeof body === "object" ? body.error : null;
    const code = typeof err?.code === "string" ? err.code : typeof err?.type === "string" && err.type === "idempotency_error" ? "idempotency_error" : null;
    if (res.status >= 200 && res.status < 300) {
      if (!body || typeof body !== "object") return fail("malformed", res.status, "Stripe answered in a way the Hub could not read");
      if (o.requireTestMode && body.livemode === true) return fail("live_data", res.status, "Stripe answered with LIVE-mode data to a TEST Hub");
      return { ok: true, value: body };
    }
    if (res.status === 400) return fail("rejected", 400, typeof err?.message === "string" ? err.message.slice(0, 300) : "Stripe rejected the request", code);
    if (res.status === 401) return fail("unauthorised", 401, "Stripe did not accept the organisation's key", code);
    if (res.status === 403) return fail("forbidden", 403, "The Stripe key is not allowed to do this", code);
    if (res.status === 404) return fail("not_found", 404, "Stripe has no such record", code);
    if (res.status === 429) return fail("rate_limited", 429, "Stripe's rate limit was reached", code);
    return fail("server", res.status, `Stripe returned an error (${res.status})`, code);
  }

  return {
    createRefund: (p, key) => {
      if (!key) return Promise.resolve(fail("rejected", null, "An Idempotency-Key is required for every refund", "idempotency_key_missing"));
      const form = new URLSearchParams();
      form.set("charge", p.chargeId);
      form.set("amount", String(p.amountMinor));
      form.set("reason", p.reason);
      for (const [k, v] of Object.entries(p.metadata)) form.set(`metadata[${k}]`, v);
      return call("POST", "/refunds", form, key);
    },
    refund: async (id) => {
      const r = await call("GET", `/refunds/${encodeURIComponent(id)}`, null, null);
      if (!r.ok) return r.kind === "not_found" ? { ok: true, value: null } : r;
      return r;
    },
    callLog: () => log.map((x) => ({ ...x })),
  };
}
