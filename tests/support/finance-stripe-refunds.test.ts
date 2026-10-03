/**
 * Finance Foundation F21 - Stripe refund EXECUTION of an F11 decision's card part.
 * Run: node --experimental-strip-types tests/support/finance-stripe-refunds.test.ts
 *
 *   EL  eligibility (eligible, no card part, wrong org, not connected, no charge, currency, insufficient, already done)  brief 1-8
 *   EX  execution (success, exact amount, minor units, refund id, provider status, audit, F11 decision preserved)          brief 9-15
 *   ID  idempotency (twice, concurrent, same key on retry, timeout after accept, reconcile, no duplicate, late retry)      brief 16-21
 *   PM  partial / multiple returns + the locked mixed example (40 credit / 60 card, 50 -> 20 credit + 30 Stripe)          brief 22-27
 *   PF  provider failures (400, 401/403 permission, 429, 500, timeouts, pending, requires_action, failed, canceled, retry) brief 28-36
 *   RC  reconciliation (pending -> succeeded / failed, succeeded terminal, no second refund)                              decisions D3
 *   CF  Cash Flow (information only; never a bank OUT; no guessed date; refund never an overhead)                        brief 37-41, D1
 *   MR  Month Report / revenue unchanged                                                                                  brief 42-44, D4
 *   AC  access (View status, View cannot execute, Manage, no grant, coach / parent, module off, tenant)                  brief 45-51
 *   MO  multi-organisation isolation                                                                                      brief 52-53
 *   AU  audit / history (start, success, failure, reconcile, no secrets, reads not audited)                              brief 54-58
 *   Z   code / drift checks against the canonical finance files
 *
 * The REAL F21 orchestrator + repository + both HTTP adapters (F10's GET
 * provider, F21's refund provider) run against an in-memory world: fake
 * PostgREST + fake finance_stripe_refund_* database functions (the same rules
 * as the TEST SQL, also exercised live in a self-rolling-back smoke) and a
 * fake Stripe with Idempotency-Key replay, refund-write permission, refund
 * statuses and fault injection.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { checkRefundQuery, matchRefundExecutionRoute, parseExecuteBody, refundCashInfo, idempotencyKeyOf, REFUND_EVENTS } from "./finance-stripe-refunds.ts";
import { type RefundExecDeps, executeRefund, readRefundExecution, reconcileRefund } from "./finance-stripe-refunds-orchestrator.ts";
import { decisionForExecutionFromRow, executionFromRow } from "./finance-stripe-refunds-repository.ts";
import { returnableOf, revenueCorrectionsOf } from "./finance-family.ts";
import { matchFamilyRoute } from "./finance-family.ts";

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
const ORG2 = "ORG-TEST-002";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const VIEWER = "aaaaaaaa-e0d4-4257-8121-5f16781e97ba";
const NOGRANT = "bbbbbbbb-e0d4-4257-8121-5f16781e97ba";
const MGR2 = "cccccccc-e0d4-4257-8121-5f16781e97ba";
const g = (level: unknown, org = ORG): FinanceGrantRow => ({ organisation_id: org, access_level: level, revoked_at: null });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
const viewer = { userId: VIEWER, role: "management", active: true, organisationId: ORG };
const nogrant = { userId: NOGRANT, role: "management", active: true, organisationId: ORG };
const coach = { userId: MGR, role: "coach", active: true, organisationId: ORG };
const parent = { userId: MGR, role: "parent", active: true, organisationId: ORG };
const mgr2 = { userId: MGR2, role: "management", active: true, organisationId: ORG2 };
const KEY = ["rk", "test", "ZZTESTrefundKey0123456789"].join("_");
const KEY2 = ["rk", "test", "ZZTESTorgTwoKey0123456789"].join("_");
const ORG_ROWS = [
  { id: "recYXqi1DTZ8ZECPQ", fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } },
  { id: "recYXqi1DTZ8ZECP2", fields: { "Organisation ID": ORG2, "Organisation Name": "Other Org", Timezone: "Europe/London", Active: true } },
];

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
type Fault = "wrong_amount" | "timeout" | "timeout_after_accept" | "fail_500" | "rate_limit" | "malformed" | "reject_400" | "pending" | "requires_action" | "failed" | "canceled";
interface Stripe {
  objects: Map<string, Record<string, any>>;
  calls: { method: string; path: string; key: string | null; body: string | null; auth: string }[];
  idem: Map<string, { params: string; body: Record<string, any> }>;
  refundWrite: boolean;
  faults: Fault[];
  readFaults: number;
  /** Per GET /refunds list call, in order: true = that call fails with a 500. */
  listFaults: boolean[];
  expiredOnce: boolean;
  seq: number;
}
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  sb: Record<string, Record<string, any>[]>;
  audit: any[];
  lockHeld: string | null;
  rpcCalls: string[];
  stripe: Stripe;
  stripe2: Stripe;
}
let world: World;
let NOW = new Date("2026-10-03T10:00:00.000Z");
let seq = 0;
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const charge = (id: string, amount: number, over: Record<string, any> = {}) => ({ id, object: "charge", customer: "cus_ZZTESTa", amount, amount_refunded: 0, refunded: false, currency: "gbp", status: "succeeded", paid: true, disputed: false, created: T("2026-09-15T10:00:00Z"), livemode: false, ...over });
function newStripe(): Stripe {
  const o = new Map<string, Record<string, any>>();
  const put = (x: Record<string, any>) => o.set(x.id, x);
  put(charge("ch_ZZTESTm60", 6000));
  put(charge("ch_ZZTESTr100", 10000));
  put(charge("ch_ZZTESText30", 3000, { amount_refunded: 1000 }));
  o.set("re_ZZTESText10", { id: "re_ZZTESText10", object: "refund", amount: 1000, charge: "ch_ZZTESText30", currency: "gbp", status: "succeeded", created: T("2026-09-16T10:00:00Z"), metadata: {}, livemode: false });
  put(charge("ch_ZZTESTeur", 2500, { currency: "eur" }));
  put(charge("ch_ZZTESTcust", 2500, { customer: "cus_ZZTESTother" }));
  put(charge("ch_ZZTESTp668", 668));
  return { objects: o, calls: [], idem: new Map(), refundWrite: true, faults: [], readFaults: 0, listFaults: [], expiredOnce: false, seq: 0 };
}
const conn = (org: string, status = "connected") => ({ organisation_id: org, mode: "test", endpoint: "stripe", status, secret_id: status === "connected" ? "x" : null, key_kind: "restricted", account_id: "acct_ZZTESTf21", account_name: "ZZTEST", connected_at: "2026-10-03T09:00:00Z", connected_by: MGR, last_success_at: null, last_error_at: null, last_error_code: null, last_error_message: null, fee_estimate: null, config_revision: 0, config_updated_at: null, config_updated_by: null, refund_capability: "unknown", refund_capability_at: null, refund_capability_code: null });

/** An F11 decision row as the TEST table holds it. */
function decision(id: string, o: { org?: string; charge?: string | null; card: number; credit?: number; state?: string; reversed?: boolean; sourceRef?: string; customer?: string; srcCredit?: number; srcCard?: number }) {
  const credit = o.credit ?? 0;
  return {
    organisation_id: o.org ?? ORG,
    decision_id: id,
    family_parent_record_id: "recUleTQgqdkpBr8F",
    family_parent_id: "PARENT-TEST-001",
    player_record_id: null,
    source_type: o.sourceRef?.startsWith("FFP-") ? "family_payment" : "stripe_charge",
    source_ref: o.sourceRef ?? o.charge ?? "ch_ZZTESTnone",
    stripe_charge_id: o.charge === undefined ? null : o.charge,
    stripe_customer_id: o.customer ?? "cus_ZZTESTa",
    currency: "GBP",
    source_total_minor: (o.srcCredit ?? credit) + (o.srcCard ?? o.card),
    source_credit_funded_minor: o.srcCredit ?? credit,
    source_card_funded_minor: o.srcCard ?? o.card,
    returnable_before_minor: (o.srcCredit ?? credit) + (o.srcCard ?? o.card),
    decision_type: o.card > 0 && credit > 0 ? "split" : o.card > 0 ? "refund_to_card" : "family_credit",
    return_minor: credit + o.card,
    card_refund_minor: o.card,
    credit_restored_minor: credit,
    card_to_credit_minor: 0,
    retained_minor: 0,
    execution_state: o.card > 0 && credit > 0 ? "split_refund_due" : o.card > 0 ? "refund_due" : "credit_created",
    refund_state: o.state ?? (o.card > 0 ? "awaiting_refund_action" : "none"),
    stripe_refund_id: null,
    reason: "F11 test decision",
    policy_kind: "manual_management_decision",
    policy_ref: null,
    decided_at: "2026-10-01T12:00:00Z",
    decided_by: MGR,
    reversed_at: o.reversed ? "2026-10-02T12:00:00Z" : null,
    reversed_by: o.reversed ? MGR : null,
    reverse_reason: o.reversed ? "test" : null,
    owner_type: "guardian_account",
    owner_key: "recUleTQgqdkpBr8F",
  };
}
const D = {
  MIX1: "FRD-1DA6EDEA084D", // FFP-793CCB2A2EC6: 40 credit + 60 card, 50 return -> 20 credit + 30 card
  MIX2: "FRD-9B917033B203", // the second 50 return on the same payment -> 20 credit + 30 card
  MIX3: "FRD-00000000AA03", // a (crafted) third card part on the same charge: cumulative cap
  FULL: "FRD-CBCEF63635E7", // ch_r100 card 100.00
  CREDIT: "FRD-C90FA93BF27A", // credit only
  REV: "FRD-00000000AA05", // reversed
  EXT: "FRD-3A041016358A", // ch_ext30: 10.00 already refunded outside the Hub; card 20.00
  INSUF: "FRD-00000000AA07", // ch_ext30 card 30.00 > 20.00 left
  EUR: "FRD-00000000AA08",
  CUST: "FRD-00000000AA09",
  NOCH: "FRD-00000000AA10", // Stripe has no such charge
  PENNY: "FRD-1653C1DF9EA7", // odd penny: 3.34 card of a 6.68 charge
  ORG2: "FRD-00000000BB01",
};
function reset() {
  seq = 0;
  NOW = new Date("2026-10-03T10:00:00.000Z");
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [], [MGR2]: [g("manage", ORG2)] },
    moduleOn: true,
    sb: {
      finance_stripe_connections: [conn(ORG), conn(ORG2)],
      finance_refund_decisions: [
        decision(D.MIX1, { charge: "ch_ZZTESTm60", card: 3000, credit: 2000, sourceRef: "FFP-793CCB2A2EC6", srcCredit: 4000, srcCard: 6000 }),
        decision(D.MIX2, { charge: "ch_ZZTESTm60", card: 3000, credit: 2000, sourceRef: "FFP-793CCB2A2EC6", srcCredit: 4000, srcCard: 6000 }),
        decision(D.MIX3, { charge: "ch_ZZTESTm60", card: 1000, sourceRef: "FFP-793CCB2A2EC6", srcCredit: 4000, srcCard: 6000 }),
        decision(D.FULL, { charge: "ch_ZZTESTr100", card: 10000 }),
        decision(D.CREDIT, { charge: "ch_ZZTESTj10", card: 0, credit: 1000 }),
        decision(D.REV, { charge: "ch_ZZTESTr100", card: 1000, reversed: true }),
        decision(D.EXT, { charge: "ch_ZZTESText30", card: 2000, srcCard: 3000 }),
        decision(D.INSUF, { charge: "ch_ZZTESText30", card: 3000 }),
        decision(D.EUR, { charge: "ch_ZZTESTeur", card: 2500 }),
        decision(D.CUST, { charge: "ch_ZZTESTcust", card: 2500 }),
        decision(D.NOCH, { charge: "ch_ZZTESTgone", card: 2500 }),
        decision(D.PENNY, { charge: "ch_ZZTESTp668", card: 334, credit: 166, sourceRef: "FFP-3BDCAD188E54", srcCredit: 333, srcCard: 668 }),
        decision(D.ORG2, { org: ORG2, charge: "ch_ZZTESTo2", card: 1500 }),
      ],
      finance_stripe_refund_executions: [],
      finance_family_credits: [{ organisation_id: ORG, credit_id: "FFC-0000000000C1", original_minor: 2000 }],
    },
    audit: [],
    lockHeld: null,
    rpcCalls: [],
    stripe: newStripe(),
    stripe2: (() => {
      const s = newStripe();
      s.objects.clear();
      s.objects.set("ch_ZZTESTo2", charge("ch_ZZTESTo2", 1500, { customer: "cus_ZZTESTa" }));
      return s;
    })(),
  };
}
const dec = (id: string) => world.sb.finance_refund_decisions.find((d) => d.decision_id === id)!;
const execs = (id?: string) => world.sb.finance_stripe_refund_executions.filter((x) => !id || x.decision_id === id);
const posts = (s: Stripe = world.stripe) => s.calls.filter((c) => c.method === "POST");
const refundsOn = (ch: string, s: Stripe = world.stripe) => [...s.objects.values()].filter((o) => o.object === "refund" && o.charge === ch);

// ----- fake finance_stripe_refund_* database functions (same rules as the TEST SQL) -----
class Refused extends Error {}
const no = (code: string): never => {
  throw new Refused(`f21:${code}`);
};
function audit(org: string, events: any[]) {
  if (!Array.isArray(events) || !events.length) no("audit_missing");
  if (events.some((e) => e.organisation_id !== org)) no("audit_org_mismatch");
  for (const e of events) if (!/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(e.event_type) || e.entity_type !== "finance_refund_execution") throw new Error("audit check violation");
  world.audit.push(...events.map((e) => ({ ...e, occurred_at: NOW.toISOString() })));
}
function rowCheck(x: any, self: any = x) {
  const ok =
    /^FRX-[0-9A-F]{12}$/.test(x.execution_id) &&
    x.amount_minor > 0 &&
    x.currency === "GBP" &&
    x.idempotency_key === `f21:${x.organisation_id}:${x.decision_id}:v${x.version}` &&
    ["processing", "outcome_unknown", "succeeded", "failed"].includes(x.status) &&
    (x.status === "succeeded") === !!x.succeeded_at &&
    (x.status !== "succeeded" || (x.stripe_refund_id && x.provider_status === "succeeded")) &&
    (x.status === "failed") === !!(x.failed_at && x.failure_kind) &&
    (!["failed", "canceled"].includes(x.provider_status) || x.status === "failed") &&
    (x.provider_status == null || !!x.stripe_refund_id) &&
    (x.stripe_refund_id == null) === (x.stripe_refund_created_at == null);
  if (!ok) throw new Error("finance_stripe_refund_executions check violation");
  const live = execs(x.decision_id).filter((y) => y !== self && y.organisation_id === x.organisation_id && ["processing", "outcome_unknown", "succeeded"].includes(y.status));
  if (["processing", "outcome_unknown", "succeeded"].includes(x.status) && live.length) throw new Error("duplicate key value violates unique constraint finance_stripe_refund_executions_one_live");
}
function rpcBody(fn: string, a: any): unknown {
  if (fn === "finance_stripe_refund_reserve") {
    const d = world.sb.finance_refund_decisions.find((x) => x.organisation_id === a.p_org && x.decision_id === a.p_decision_id);
    if (!d) no("decision_not_found");
    if (d.reversed_at) no("decision_reversed");
    if (d.card_refund_minor <= 0) no("no_card_refund");
    if (d.refund_state === "refunded" || d.stripe_refund_id) no("already_refunded");
    if (d.refund_state === "refund_processing") no("execution_in_progress");
    if (!["awaiting_refund_action", "refund_failed"].includes(d.refund_state)) no("not_executable");
    const mine = execs(d.decision_id).filter((x) => x.organisation_id === a.p_org);
    if (mine.some((x) => ["processing", "outcome_unknown"].includes(x.status))) no("execution_in_progress");
    if (mine.some((x) => x.status === "succeeded")) no("already_refunded");
    const p = a.p_execution;
    if (p.amount_minor !== d.card_refund_minor || p.stripe_charge_id !== d.stripe_charge_id || p.currency !== d.currency) no("decision_mismatch");
    if (p.version !== Math.max(0, ...mine.map((x) => x.version)) + 1) no("version_changed");
    const row = { organisation_id: a.p_org, execution_id: p.execution_id, decision_id: d.decision_id, version: p.version, stripe_charge_id: d.stripe_charge_id, amount_minor: d.card_refund_minor, currency: d.currency, idempotency_key: p.idempotency_key, status: "processing", provider_status: null, stripe_refund_id: null, stripe_refund_created_at: null, failure_kind: null, failure_code: null, failure_message: null, attempts: 1, started_at: p.started_at, started_by: p.started_by, last_attempt_at: p.started_at, last_checked_at: null, last_checked_by: null, succeeded_at: null, failed_at: null };
    rowCheck(row);
    world.sb.finance_stripe_refund_executions.push(row);
    d.refund_state = "refund_processing";
    audit(a.p_org, a.p_events);
    return { ...row };
  }
  if (fn === "finance_stripe_refund_record") {
    const x = world.sb.finance_stripe_refund_executions.find((y) => y.organisation_id === a.p_org && y.execution_id === a.p_execution_id);
    if (!x) no("execution_not_found");
    if (["succeeded", "failed"].includes(x.status)) no("execution_closed");
    if (x.status !== a.p_expected_status) no("execution_changed");
    const d = world.sb.finance_refund_decisions.find((y) => y.organisation_id === a.p_org && y.decision_id === x.decision_id)!;
    if (d.refund_state !== "refund_processing") no("decision_state_changed");
    const r = a.p_result;
    const refund = r.stripe_refund_id || null;
    if (x.stripe_refund_id && refund !== x.stripe_refund_id) no("refund_id_conflict");
    const next = {
      ...x,
      status: r.status,
      provider_status: r.provider_status || null,
      stripe_refund_id: refund,
      stripe_refund_created_at: r.stripe_refund_created_at || null,
      failure_kind: r.status === "failed" ? r.failure_kind : null,
      failure_code: r.failure_code ? String(r.failure_code).slice(0, 80) : null,
      failure_message: r.failure_message ? String(r.failure_message).slice(0, 300) : null,
      attempts: x.attempts + (r.attempted ? 1 : 0),
      last_attempt_at: r.attempted ? r.at : x.last_attempt_at,
      last_checked_at: r.checked ? r.at : x.last_checked_at,
      last_checked_by: r.checked ? r.by : x.last_checked_by,
      succeeded_at: r.status === "succeeded" ? r.at : null,
      failed_at: r.status === "failed" ? r.at : null,
    };
    rowCheck(next, x);
    Object.assign(x, next);
    if (r.status === "succeeded") {
      if (d.stripe_refund_id) throw new Error("stripe_refund_id is set once");
      d.refund_state = "refunded";
      d.stripe_refund_id = refund;
    } else if (r.status === "failed") d.refund_state = refund ? "refund_failed" : "awaiting_refund_action";
    if (r.capability === "available" || r.capability === "unavailable") {
      const c = world.sb.finance_stripe_connections.find((y) => y.organisation_id === a.p_org && y.status === "connected");
      if (c) Object.assign(c, { refund_capability: r.capability, refund_capability_at: r.at, refund_capability_code: r.capability_code ?? null });
    }
    audit(a.p_org, a.p_events);
    return { ...x };
  }
  throw new Error(`unknown rpc ${fn}`);
}
function rpcFn(fn: string, a: any): unknown {
  world.rpcCalls.push(fn);
  const snap = JSON.stringify({ sb: world.sb, audit: world.audit });
  try {
    return rpcBody(fn, a);
  } catch (e) {
    const s = JSON.parse(snap);
    world.sb = s.sb;
    world.audit = s.audit;
    throw e;
  }
}

function postgrest(url: string, method: string): Response {
  const u = new URL(url);
  const table = u.pathname.split("/").pop() as string;
  const rows = world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  if (method !== "GET") return json({ message: "F21 writes only through its database functions" }, 403);
  const fs: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (k !== "select" && k !== "order") fs.push([k, v]);
  const hit = (r: Record<string, any>) => fs.every(([k, v]) => (v.startsWith("gt.") ? Number(r[k]) > Number(v.slice(3)) : String(r[k] ?? "") === v.replace(/^eq\./, "")));
  return json(rows.filter(hit).map((r) => ({ ...r })));
}

/** The fake Stripe: GET charge / refunds / one refund, POST /v1/refunds with Idempotency-Key replay. */
async function stripeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const path = u.pathname.replace(/^\/v1\/?/, "");
  const auth = init.headers?.Authorization ?? "";
  const S = auth === `Bearer ${KEY}` ? world.stripe : auth === `Bearer ${KEY2}` ? world.stripe2 : null;
  const key = init.headers?.["Idempotency-Key"] ?? null;
  (S ?? world.stripe).calls.push({ method, path: `/${path}`, key, body: init.body ?? null, auth: auth ? "Bearer ***" : "" });
  if (!S) return json({ error: { message: "Invalid API Key provided" } }, 401);
  const hang = () => new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const seg = path.split("/").filter(Boolean);
  if (method === "GET") {
    if (S.readFaults > 0 && seg[0] === "charges") {
      S.readFaults--;
      return json({ error: { type: "api_error", message: "boom" } }, 500);
    }
    if (seg[0] === "charges" && seg.length === 2) {
      const o = S.objects.get(seg[1]);
      return o && o.object === "charge" ? json(JSON.parse(JSON.stringify(o))) : json({ error: { message: "No such charge", code: "resource_missing" } }, 404);
    }
    if (seg[0] === "refunds" && seg.length === 2) {
      const o = S.objects.get(seg[1]);
      return o && o.object === "refund" ? json(JSON.parse(JSON.stringify(o))) : json({ error: { message: "No such refund", code: "resource_missing" } }, 404);
    }
    if (seg[0] === "refunds" && seg.length === 1) {
      if (S.listFaults.shift() === true) {
        return json({ error: { type: "api_error", message: "list boom" } }, 500);
      }
      const ch = u.searchParams.get("charge");
      const all = [...S.objects.values()].filter((o) => o.object === "refund" && (!ch || o.charge === ch)).map((o) => JSON.parse(JSON.stringify(o)));
      return json({ object: "list", data: all, has_more: false });
    }
    return json({ error: { message: "Unrecognized request URL" } }, 404);
  }
  if (method !== "POST" || path !== "refunds") return json({ error: { message: "fake Stripe: only POST /v1/refunds is a write" } }, 405);
  if (!S.refundWrite) return json({ error: { type: "invalid_request_error", code: "permission_denied", message: "The provided key does not have the required permissions for this endpoint." } }, 403);
  const f = S.faults.shift();
  if (f === "timeout") return hang();
  if (f === "fail_500") return json({ error: { type: "api_error", message: "boom" } }, 500);
  if (f === "rate_limit") return json({ error: { type: "rate_limit_error", code: "rate_limit", message: "Too many requests" } }, 429);
  if (f === "reject_400") return json({ error: { type: "invalid_request_error", code: "amount_too_large", message: "Refund amount is greater than unrefunded amount on charge" } }, 400);
  const form = new URLSearchParams(String(init.body ?? ""));
  const params = [...form.entries()].map(([k, v]) => `${k}=${v}`).sort().join("&");
  if (key) {
    const stored = S.idem.get(key);
    if (stored && !S.expiredOnce) {
      if (stored.params !== params) return json({ error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" } }, 400);
      return json(JSON.parse(JSON.stringify(S.objects.get(stored.body.id))));
    }
    if (stored) S.expiredOnce = false;
  }
  const ch = S.objects.get(form.get("charge") ?? "");
  if (!ch) return json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such charge" } }, 400);
  const left = ch.amount - ch.amount_refunded;
  const amount = Number(form.get("amount"));
  if (!/^\d+$/.test(form.get("amount") ?? "")) return json({ error: { type: "invalid_request_error", code: "parameter_invalid_integer", message: "Invalid integer" } }, 400);
  if (amount > left) return json({ error: { type: "invalid_request_error", code: "amount_too_large", message: "Refund amount is greater than unrefunded amount on charge" } }, 400);
  const md: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    const mm = /^metadata\[(.+)\]$/.exec(k);
    if (mm) md[mm[1]] = v;
  }
  const status = f === "pending" ? "pending" : f === "requires_action" ? "requires_action" : f === "failed" ? "failed" : f === "canceled" ? "canceled" : "succeeded";
  const re = { id: `re_ZZTESTf21x${++S.seq}`, object: "refund", amount: f === "wrong_amount" ? amount - 1 : amount, charge: ch.id, currency: ch.currency, status, created: Math.floor(NOW.getTime() / 1000), metadata: md, reason: form.get("reason"), livemode: false, failure_reason: status === "failed" ? "expired_or_canceled_card" : null };
  S.objects.set(re.id, re);
  if (["pending", "requires_action", "succeeded"].includes(status)) ch.amount_refunded += amount;
  if (key) S.idem.set(key, { params, body: re });
  if (f === "timeout_after_accept") return hang();
  if (f === "malformed") return new Response("<html>", { status: 200 });
  return json(JSON.parse(JSON.stringify(re)));
}
/** Stripe settles a pending refund asynchronously (what reconcile later reads). */
function settle(refundId: string, status: "succeeded" | "failed" | "canceled", s: Stripe = world.stripe) {
  const r = s.objects.get(refundId)!;
  r.status = status;
  if (status !== "succeeded") {
    const ch = s.objects.get(r.charge)!;
    ch.amount_refunded -= r.amount;
    r.failure_reason = status === "failed" ? "expired_or_canceled_card" : null;
  }
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick();
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("https://api.stripe.com/")) return stripeFetch(url, init);
  const body = init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
  if (url.includes("/rest/v1/finance_access_grants")) {
    const mm = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(mm ? world.grants[mm[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockHeld) return json(null);
    world.lockHeld = `lock-${++seq}`;
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rpc/finance_stripe_secret")) return json(body?.p_organisation_id === ORG2 ? KEY2 : body?.p_organisation_id === ORG ? KEY : null);
  const rpcMatch = /\/rpc\/([a-z_]+)$/.exec(url);
  if (rpcMatch) {
    try {
      return json(rpcFn(rpcMatch[1], body));
    } catch (e) {
      if (e instanceof Refused) return json({ code: "P0001", message: e.message }, 400);
      return json({ message: String(e) }, 409);
    }
  }
  if (url.includes("/rest/v1/finance_audit_events")) return json({ message: "F21 audits inside its database functions" }, 403);
  if (url.includes("/rest/v1/")) return postgrest(url, method);
  if (url.startsWith("https://api.airtable.com/")) {
    if (method !== "GET") return json({ error: "F21 must not write Airtable" }, 418);
    const t = decodeURIComponent(new URL(url).pathname.split("/").pop() as string);
    if (t === "Organisation & Branding") return json({ records: ORG_ROWS });
    if (t === "Feature Controls") return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
    return json({ records: [] });
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

let rnd = 0;
const deps: RefundExecDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  stripe: { requireTestMode: true, timeoutMs: 40 },
  refunds: { random: () => (++rnd).toString(16).padStart(12, "0") + "0000" },
};
const exec = (id: string, caller: any = mgr, reason: string | null = "F21 test refund") => executeRefund(deps, caller, id, reason) as Promise<any>;
const recon = (id: string, caller: any = mgr) => reconcileRefund(deps, caller, id, "F21 test reconcile") as Promise<any>;
const status = (id: string, caller: any = mgr) => readRefundExecution(deps, caller, id) as Promise<any>;
const evTypes = (from: number) => world.audit.slice(from).map((e) => e.event_type);
const E = REFUND_EVENTS;

async function main() {
  // ===== EL / EX. Eligibility + a plain successful execution =====
  reset();
  {
    const a0 = world.audit.length;
    const before = JSON.stringify({ ...dec(D.FULL), refund_state: null, stripe_refund_id: null });
    const r = await exec(D.FULL);
    const x = execs(D.FULL)[0];
    const p = posts()[0];
    const form = new URLSearchParams(p?.body ?? "");
    ck("EL1/EX9. An eligible Refund Due decision is executed: 200, execution succeeded, decision refunded", r.httpStatus === 200 && r.body.execution.status === "succeeded" && dec(D.FULL).refund_state === "refunded", JSON.stringify(r).slice(0, 300));
    ck("EX10/EX11. Stripe was asked for EXACTLY the F11 card part, in integer minor units (amount=10000), on the decision's charge", posts().length === 1 && form.get("amount") === "10000" && form.get("charge") === "ch_ZZTESTr100" && !form.has("currency") && /^\d+$/.test(form.get("amount")!));
    ck("EX12/EX13. Stripe's refund id + provider status are stored on the execution and the refund id once on the F11 decision", !!x.stripe_refund_id && x.provider_status === "succeeded" && dec(D.FULL).stripe_refund_id === x.stripe_refund_id && r.body.execution.stripeRefundId === x.stripe_refund_id);
    ck("ID-key. The request carried the stable Idempotency-Key f21:{org}:{decision}:v1 and the Hub identity metadata", p.key === idempotencyKeyOf(ORG, D.FULL, 1) && form.get("metadata[hub_organisation_id]") === ORG && form.get("metadata[hub_refund_decision_id]") === D.FULL && form.get("metadata[hub_execution_id]") === x.execution_id && form.get("reason") === "requested_by_customer");
    ck("EX14/AU54/AU55. Audit: exactly started + succeeded, actor = the manager, the refund id and amount recorded", JSON.stringify(evTypes(a0)) === JSON.stringify([E.started, E.succeeded]) && world.audit.slice(a0).every((e) => e.actor_user_id === MGR) && world.audit[a0 + 1].after.stripeRefundId === x.stripe_refund_id && world.audit[a0 + 1].after.amount === "100.00");
    ck("EX15. The F11 decision is preserved: only refund_state and the once-only stripe_refund_id changed (amounts, split, reason, owner untouched)", JSON.stringify({ ...dec(D.FULL), refund_state: null, stripe_refund_id: null }) === before);
    ck("EL8. Already succeeded: a second execute is refused 409 already_refunded with NO Stripe call and no new execution", (await exec(D.FULL)).code === "already_refunded" && posts().length === 1 && execs(D.FULL).length === 1);
    const calls0 = world.stripe.calls.length;
    const c = await exec(D.CREDIT);
    ck("EL2. No card portion (credit-only return): 409 no_card_refund - no Stripe call, no execution, no fake 0.00 refund", c.httpStatus === 409 && c.code === "no_card_refund" && world.stripe.calls.length === calls0 && !execs(D.CREDIT).length);
    const rv = await exec(D.REV);
    ck("EL-rev. A reversed decision is refused 409 decision_reversed (nothing sent)", rv.code === "decision_reversed" && world.stripe.calls.length === calls0);
    const o2 = await exec(D.ORG2);
    ck("EL3/MO52. Another organisation's decision is invisible: 404 refund_decision_not_found, no Stripe call", o2.httpStatus === 404 && o2.code === "refund_decision_not_found" && world.stripe.calls.length === calls0 && world.stripe2.calls.length === 0);
    const nf = await exec("FRD-0000000000FF");
    ck("EL3b. An unknown decision id: 404", nf.httpStatus === 404);
  }
  // Not connected / charge missing / currency / insufficient / customer changed.
  reset();
  {
    world.sb.finance_stripe_connections[0] = conn(ORG, "disconnected");
    const a0 = world.audit.length;
    const r = await exec(D.FULL);
    ck("EL4/R. Stripe not connected: 409 stripe_not_connected - the decision stays Refund Due, no execution, no audit, no Stripe call", r.httpStatus === 409 && r.code === "stripe_not_connected" && dec(D.FULL).refund_state === "awaiting_refund_action" && !execs().length && world.audit.length === a0 && !world.stripe.calls.length);
    world.sb.finance_stripe_connections[0] = conn(ORG);
    const m = await exec(D.NOCH);
    ck("EL5. Original Stripe payment missing in Stripe: 409 stripe_charge_not_found, nothing POSTed, decision back to Refund Due, the failed attempt kept as history", m.httpStatus === 409 && m.code === "stripe_charge_not_found" && !posts().length && dec(D.NOCH).refund_state === "awaiting_refund_action" && execs(D.NOCH)[0].status === "failed" && execs(D.NOCH)[0].failure_kind === "charge_missing");
    const e = await exec(D.EUR);
    ck("EL6. Currency mismatch (the charge is EUR): 409 currency_mismatch, nothing POSTed", e.code === "currency_mismatch" && !posts().length && dec(D.EUR).refund_state === "awaiting_refund_action");
    const i = await exec(D.INSUF);
    ck("EL7. Insufficient refundable in Stripe (30.00 decided, only 20.00 left after a 10.00 outside refund): 409 insufficient_refundable, nothing POSTed", i.code === "insufficient_refundable" && /20\.00/.test(i.error) && !posts().length && dec(D.INSUF).refund_state === "awaiting_refund_action");
    const cu = await exec(D.CUST);
    ck("EL-cust. The Stripe payment now belongs to another customer: 409 stripe_payment_mismatch, nothing POSTed", cu.code === "stripe_payment_mismatch" && !posts().length);
    const ex = await exec(D.EXT);
    ck("EL-ext. The remaining 20.00 after an outside 10.00 refund is executable: succeeded, the charge is now fully refunded", ex.httpStatus === 200 && world.stripe.objects.get("ch_ZZTESText30")!.amount_refunded === 3000);
  }

  // ===== ID. Idempotency =====
  reset();
  {
    // ID17: two managers at the same time.
    const [a, b] = await Promise.all([exec(D.FULL), exec(D.FULL)]);
    const codes = [a, b].map((x) => x.httpStatus === 200 ? "ok" : x.code).sort();
    ck("ID17. Concurrent execute: exactly one succeeds; the other is refused (Finance busy / already in progress); ONE Stripe POST, one refund", codes.length === 2 && codes.includes("ok") && codes.some((c) => c === "finance_commercial_busy" || c === "refund_execution_in_progress" || c === "already_refunded") && posts().length === 1 && refundsOn("ch_ZZTESTr100").length === 1);
    const again = await exec(D.FULL);
    ck("ID16. The same request again after success: 409 already_refunded, still one refund in Stripe", again.code === "already_refunded" && refundsOn("ch_ZZTESTr100").length === 1);
  }
  reset();
  {
    // ID18 / PF32: timeout BEFORE Stripe accepted -> unknown; reconcile proves none exists -> re-send with the SAME key.
    world.stripe.faults.push("timeout");
    const r = await exec(D.FULL);
    const x0 = execs(D.FULL)[0];
    ck("PF32. Timeout before Stripe accepted: 202 outcome_unknown (never success, never failure), decision still refund_processing, no refund in Stripe", r.httpStatus === 202 && r.body.execution.status === "outcome_unknown" && dec(D.FULL).refund_state === "refund_processing" && !refundsOn("ch_ZZTESTr100").length && x0.status === "outcome_unknown");
    const st = await status(D.FULL);
    ck("RC-st. Status read shows the unknown outcome and that reconcile (not execute) is the next action", st.httpStatus === 200 && st.body.execution.status === "outcome_unknown" && st.body.actions.canReconcile === true && st.body.actions.canExecute === false && st.body.actions.executeBlockedBy === "refund_execution_in_progress");
    const blocked = await exec(D.FULL);
    ck("ID-block. Execute while the outcome is unknown is refused 409 refund_execution_in_progress (no second request)", blocked.code === "refund_execution_in_progress" && posts().length === 1);
    const rc = await recon(D.FULL);
    const p = posts();
    ck("ID18. Reconcile: Stripe's refund list proves none exists, so it re-sends with the SAME Idempotency-Key (never a new key) -> succeeded", rc.httpStatus === 200 && rc.body.execution.status === "succeeded" && rc.body.resent === true && p.length === 2 && p[0].key === p[1].key && p[0].key === idempotencyKeyOf(ORG, D.FULL, 1) && execs(D.FULL)[0].attempts === 2 && refundsOn("ch_ZZTESTr100").length === 1);
  }
  reset();
  {
    // ID19 / PF33: timeout AFTER Stripe accepted, and the in-call lookup also fails -> unknown; reconcile finds it by metadata.
    world.stripe.faults.push("timeout_after_accept");
    world.stripe.listFaults = [false, true]; // the pre-flight list works; the lookup after the lost answer fails
    const r = await exec(D.FULL);
    ck("PF33/ID19. Timeout after Stripe accepted (lookup unavailable): 202 outcome_unknown - the refund exists in Stripe but the Hub never claims success without seeing it", r.httpStatus === 202 && r.body.execution.status === "outcome_unknown" && refundsOn("ch_ZZTESTr100").length === 1 && dec(D.FULL).refund_state === "refund_processing");
    // Stripe pruned the key (late retry): a POST would now create a SECOND refund - reconcile must find the first by metadata instead.
    world.stripe.expiredOnce = true;
    const a0 = world.audit.length;
    const rc = await recon(D.FULL);
    ck("ID20/ID21/late. Reconcile after the key expired finds Stripe's refund by its Hub metadata (no POST): succeeded, exactly ONE refund on the charge", rc.httpStatus === 200 && rc.body.execution.status === "succeeded" && rc.body.resent === false && posts().length === 1 && refundsOn("ch_ZZTESTr100").length === 1 && world.stripe.expiredOnce === true);
    ck("AU56. Reconcile audit: reconciled + succeeded events", JSON.stringify(evTypes(a0)) === JSON.stringify([E.reconciled, E.succeeded]));
    const a1 = world.audit.length;
    const rc2 = await recon(D.FULL);
    ck("RC-term. Reconcile on a succeeded refund: 200 'already final' - nothing sent to Stripe, nothing changed, nothing audited", rc2.httpStatus === 200 && rc2.body.reconciled === false && posts().length === 1 && world.audit.length === a1);
  }
  reset();
  {
    // Timeout after accept with the in-call lookup working: reconciled at once (layer 2).
    world.stripe.faults.push("timeout_after_accept");
    const r = await exec(D.FULL);
    ck("ID19b. Timeout after accept with Stripe readable: found at once by hub_execution_id on the charge -> succeeded, no second POST", r.httpStatus === 200 && r.body.execution.status === "succeeded" && posts().length === 1 && refundsOn("ch_ZZTESTr100").length === 1);
  }
  reset();
  {
    // A lost answer that is unreadable (malformed) after accept: the same.
    world.stripe.faults.push("malformed");
    const r = await exec(D.FULL);
    ck("PF-mal. An unreadable answer after accept is never treated as success until Stripe's refund is seen: found by metadata -> succeeded once", r.httpStatus === 200 && posts().length === 1 && refundsOn("ch_ZZTESTr100").length === 1);
  }

  // ===== PM. Mixed funding + partial / multiple returns =====
  reset();
  {
    const credits0 = JSON.stringify(world.sb.finance_family_credits);
    const r1 = await exec(D.MIX1);
    const f1 = new URLSearchParams(posts()[0].body ?? "");
    ck("PM25/PM26. Locked example: 40.00 credit / 60.00 card paid, 50.00 return -> F11's 20.00 credit + 30.00 card; F21 sends EXACTLY 30.00 (3000) to Stripe", r1.httpStatus === 200 && f1.get("amount") === "3000" && dec(D.MIX1).credit_restored_minor === 2000 && dec(D.MIX1).card_refund_minor === 3000);
    ck("PM22. Partial refund: 30.00 of the 60.00 card payment refunded, the charge keeps 30.00 refundable", world.stripe.objects.get("ch_ZZTESTm60")!.amount_refunded === 3000);
    const st = await status(D.MIX1);
    ck("PM27/I. The 20.00 family-credit part is F11's (created when it decided): F21 never calls a family-credit function, the credit ledger is unchanged, the read model says so", JSON.stringify(world.sb.finance_family_credits) === credits0 && !world.rpcCalls.some((f) => /family/.test(f)) && st.body.decision.familyCreditPortion.amount === "20.00" && /never creates/.test(st.body.decision.familyCreditPortion.handledBy));
    const r2 = await exec(D.MIX2);
    ck("PM23. A second valid partial refund on the same payment (the rest of the card part, 30.00): succeeded; the charge is now fully refunded", r2.httpStatus === 200 && world.stripe.objects.get("ch_ZZTESTm60")!.amount_refunded === 6000 && refundsOn("ch_ZZTESTm60").length === 2);
    const r3 = await exec(D.MIX3);
    ck("PM24. The cumulative cap: a further card refund on the fully refunded charge is refused 409 insufficient_refundable - nothing POSTed (still 2 refunds)", r3.code === "insufficient_refundable" && posts().length === 2 && refundsOn("ch_ZZTESTm60").length === 2);
    const rp = await exec(D.PENNY);
    ck("PM-penny. The odd-penny decision (3.34 card of a 6.68 charge, F11's rounding) is sent verbatim: amount=334", rp.httpStatus === 200 && new URLSearchParams(posts()[2].body ?? "").get("amount") === "334");
    // F11 counts an F21 refund once: its metadata links it to the decision.
    const src = { sourceType: "family_payment" as const, sourceRef: "FFP-793CCB2A2EC6", totalMinor: 10000, creditFundedMinor: 4000, cardFundedMinor: 6000 };
    const dRows = [dec(D.MIX1), dec(D.MIX2)].map((r) => ({ ...decisionForExecutionFromRow(r), sourceRef: r.source_ref, creditRestoredMinor: r.credit_restored_minor, cardToCreditMinor: 0, retainedMinor: 0, decisionType: r.decision_type, stripeRefundId: null as string | null, reversedAt: null })) as any[];
    const facts = refundsOn("ch_ZZTESTm60").map((o) => ({ refundId: o.id, amountMinor: o.amount, status: o.status, hubDecisionId: o.metadata.hub_refund_decision_id }));
    const ret = returnableOf(src, dRows, facts);
    ck("PM-F11. F11's returnable balance counts each F21 refund ONCE (as its decision's card refund, matched by Hub metadata), never again as an outside Stripe refund", ret.external.amountMinor === 0 && ret.external.state === "none" && ret.cardFundedRemainingMinor === 0 && ret.creditFundedRemainingMinor === 0);
  }

  // ===== Adoption + response validation =====
  reset();
  {
    // An earlier attempt was recorded as refused, yet Stripe holds a live refund for this decision (e.g. created by a lost request): adopt it, never send a second.
    world.stripe.faults.push("reject_400");
    await exec(D.FULL);
    const ch = world.stripe.objects.get("ch_ZZTESTr100")!;
    world.stripe.objects.set("re_ZZTESTlost1", { id: "re_ZZTESTlost1", object: "refund", amount: 10000, charge: "ch_ZZTESTr100", currency: "gbp", status: "succeeded", created: T("2026-10-03T09:59:00Z"), metadata: { hub_organisation_id: ORG, hub_refund_decision_id: D.FULL, hub_execution_id: execs(D.FULL)[0].execution_id }, livemode: false });
    ch.amount_refunded = 10000;
    const r = await exec(D.FULL);
    ck("ID-adopt. Execute finds a live Stripe refund already made for this decision (by its Hub metadata) and ADOPTS it: succeeded, no POST, still one refund", r.httpStatus === 200 && r.body.adoptedExistingStripeRefund === true && posts().length === 1 && refundsOn("ch_ZZTESTr100").length === 1 && dec(D.FULL).stripe_refund_id === "re_ZZTESTlost1");
  }
  reset();
  {
    world.stripe.faults.push("wrong_amount");
    const r = await exec(D.FULL);
    ck("PF-mis. Stripe answers with a refund for another amount: never treated as success - 202 outcome_unknown (provider_response_mismatch), decision not refunded", r.httpStatus === 202 && r.body.execution.status === "outcome_unknown" && r.body.execution.failure.code === "provider_response_mismatch" && dec(D.FULL).refund_state === "refund_processing" && !dec(D.FULL).stripe_refund_id);
  }

  // ===== PF. Provider failures =====
  reset();
  {
    world.stripe.faults.push("reject_400");
    const r = await exec(D.FULL);
    ck("PF28. Provider 400 (Stripe refused): 409 stripe_refund_rejected with Stripe's code - nothing created, decision back to Refund Due, attempt kept as history", r.httpStatus === 409 && r.code === "stripe_refund_rejected" && r.details.execution.failure.code === "amount_too_large" && dec(D.FULL).refund_state === "awaiting_refund_action" && execs(D.FULL)[0].status === "failed");
    world.stripe.faults.push("rate_limit");
    const r2 = await exec(D.FULL);
    ck("PF30. Provider 429: 503 stripe_rate_limited - Stripe processed nothing, decision back to Refund Due (version 2 kept as history)", r2.httpStatus === 503 && r2.code === "stripe_rate_limited" && dec(D.FULL).refund_state === "awaiting_refund_action" && execs(D.FULL).length === 2);
    const r3 = await exec(D.FULL);
    ck("PF36. Safe retry after a definitive failure: version 3, a NEW key (f21:...:v3), succeeded once", r3.httpStatus === 200 && execs(D.FULL).length === 3 && posts()[posts().length - 1].key === idempotencyKeyOf(ORG, D.FULL, 3) && refundsOn("ch_ZZTESTr100").length === 1);
  }
  reset();
  {
    // PF31: provider 500 - ambiguous; the in-call lookup shows nothing -> unknown; reconcile re-sends with the same key.
    world.stripe.faults.push("fail_500");
    const r = await exec(D.FULL);
    ck("PF31. Provider 500: 202 outcome_unknown (Stripe may or may not have processed it) - never success, never a fresh key", r.httpStatus === 202 && r.body.execution.status === "outcome_unknown" && r.body.execution.failure.code === "server");
    const rc = await recon(D.FULL);
    ck("PF31b. Reconcile after a 500: no refund found by metadata -> re-sent with the same key -> succeeded once", rc.body.execution.status === "succeeded" && posts().length === 2 && posts()[0].key === posts()[1].key && refundsOn("ch_ZZTESTr100").length === 1);
  }
  reset();
  {
    // PF29 + D2: read access but no refund-write permission.
    world.stripe.refundWrite = false;
    const a0 = world.audit.length;
    const r = await exec(D.FULL);
    const cap0 = world.sb.finance_stripe_connections[0];
    ck("PF29/D2. Key lacks Refunds write: 409 provider_permission_denied - nothing created, F11 decision back to Refund Due, no succeeded state", r.httpStatus === 409 && r.code === "provider_permission_denied" && dec(D.FULL).refund_state === "awaiting_refund_action" && !dec(D.FULL).stripe_refund_id && execs(D.FULL)[0].status === "failed" && execs(D.FULL)[0].failure_kind === "permission_denied" && !refundsOn("ch_ZZTESTr100").length);
    ck("PF29b. Refund capability is learnt from Stripe, never assumed: the connection now reads 'unavailable' (permission_denied); audit started + failed", cap0.refund_capability === "unavailable" && cap0.refund_capability_code === "permission_denied" && JSON.stringify(evTypes(a0)) === JSON.stringify([E.started, E.failed]));
    const st = await status(D.FULL);
    ck("PF29c. The status read shows 'Stripe connected / refund capability unavailable' and that execute is allowed again (no key ever shown)", st.body.stripe.connected === true && st.body.stripe.refundCapability === "unavailable" && st.body.actions.canExecute === true && !JSON.stringify(st.body).includes(KEY));
    world.stripe.refundWrite = true;
    const r2 = await exec(D.FULL);
    ck("PF29d. After the permission is granted, the safe retry succeeds ONCE (version 2); capability becomes available", r2.httpStatus === 200 && execs(D.FULL).length === 2 && refundsOn("ch_ZZTESTr100").length === 1 && world.sb.finance_stripe_connections[0].refund_capability === "available");
  }
  reset();
  {
    // PF34 + RC: pending -> succeeded through reconcile; pending -> failed; requires_action; canceled.
    world.stripe.faults.push("pending");
    const r = await exec(D.FULL);
    const reId = execs(D.FULL)[0].stripe_refund_id;
    ck("PF34. Stripe says pending: 202 processing, provider status pending, refund id stored, decision refund_processing - NOT refunded", r.httpStatus === 202 && r.body.execution.status === "processing" && r.body.execution.providerStatus === "pending" && !!reId && dec(D.FULL).refund_state === "refund_processing" && !dec(D.FULL).stripe_refund_id);
    const rc0 = await recon(D.FULL);
    ck("RC-pend. Reconcile while still pending: stays processing (GET by refund id, no POST)", rc0.httpStatus === 202 && rc0.body.execution.status === "processing" && posts().length === 1 && world.stripe.calls.some((c) => c.method === "GET" && c.path === `/refunds/${reId}`));
    settle(reId, "succeeded");
    const rc = await recon(D.FULL);
    ck("RC1. pending -> succeeded: reconcile records Stripe's success; decision refunded; still ONE refund", rc.httpStatus === 200 && rc.body.execution.status === "succeeded" && dec(D.FULL).refund_state === "refunded" && dec(D.FULL).stripe_refund_id === reId && refundsOn("ch_ZZTESTr100").length === 1);
  }
  reset();
  {
    world.stripe.faults.push("pending");
    await exec(D.FULL);
    const reId = execs(D.FULL)[0].stripe_refund_id;
    settle(reId, "failed");
    const rc = await recon(D.FULL);
    ck("RC2/PF35. pending -> failed: 409 stripe_refund_failed - the decision is refund_failed (not refunded), the failure reason kept", rc.httpStatus === 409 && rc.code === "stripe_refund_failed" && dec(D.FULL).refund_state === "refund_failed" && execs(D.FULL)[0].provider_status === "failed" && execs(D.FULL)[0].failure_code === "expired_or_canceled_card");
    const r2 = await exec(D.FULL);
    ck("RC3. Safe retry after Stripe's refund FAILED (no money moved, Stripe released the amount): version 2 succeeds, one live refund", r2.httpStatus === 200 && execs(D.FULL).length === 2 && refundsOn("ch_ZZTESTr100").filter((o) => o.status === "succeeded").length === 1);
  }
  reset();
  {
    world.stripe.faults.push("requires_action");
    const r = await exec(D.FULL);
    ck("PF-ra. requires_action: processing (not success), reconcilable", r.httpStatus === 202 && r.body.execution.providerStatus === "requires_action" && dec(D.FULL).refund_state === "refund_processing");
    world.stripe.faults.push("canceled");
    const r2 = await exec(D.EXT);
    ck("PF-can. canceled: 409 stripe_refund_canceled, decision refund_failed (never refunded)", r2.code === "stripe_refund_canceled" && dec(D.EXT).refund_state === "refund_failed");
    world.stripe.faults.push("failed");
    const r3 = await exec(D.PENNY);
    ck("PF35b. Stripe answers failed at once: 409 stripe_refund_failed, decision refund_failed", r3.code === "stripe_refund_failed" && dec(D.PENNY).refund_state === "refund_failed");
  }
  reset();
  {
    // Pre-flight read fails (Stripe down before anything was sent).
    world.stripe.readFaults = 1;
    const r = await exec(D.FULL);
    ck("PF-pre. Stripe unreadable before sending: 503 stripe_unavailable, NOTHING POSTed, decision back to Refund Due", r.httpStatus === 503 && r.code === "stripe_unavailable" && !posts().length && dec(D.FULL).refund_state === "awaiting_refund_action");
  }

  // ===== R. Disconnected after a successful refund: history preserved =====
  reset();
  {
    await exec(D.FULL);
    world.sb.finance_stripe_connections[0] = conn(ORG, "disconnected");
    const st = await status(D.FULL);
    const rc = await recon(D.FULL);
    ck("R2. Stripe disconnected after the refund: the confirmed success is preserved and readable; reconcile of a final outcome needs no Stripe", st.body.execution.status === "succeeded" && st.body.stripe.connected === false && rc.httpStatus === 200 && rc.body.reconciled === false);
  }

  // ===== CF. Cash Flow (information only) / MR. Month Report =====
  reset();
  {
    world.stripe.faults.push("pending");
    await exec(D.MIX1);
    await exec(D.FULL);
    const facts = { decisions: world.sb.finance_refund_decisions.filter((d) => d.organisation_id === ORG && d.card_refund_minor > 0).map(decisionForExecutionFromRow), executions: execs().map(executionFromRow) };
    const info = refundCashInfo(facts.decisions, facts.executions, "Europe/London", "2026-10-03");
    ck("CF37. Refund Due alone is not cash: listed as an obligation (cash none), never a cash date", info.included === false && info.awaitingRefundAction.count >= 1 && /none/.test(info.awaitingRefundAction.cash));
    ck("CF-pend. A pending Stripe refund is not cash either: 'processing in Stripe' (30.00), cash none", info.processingInStripe.amount === "30.00" && /none/.test(info.processingInStripe.cash));
    const ref = info.refundedViaStripe.refunds;
    ck("CF38/D1. A SUCCEEDED Stripe refund is a real Stripe fact for information only: 'Refunded via Stripe on 2026-10-03 - settles through Stripe payouts', bankProjection false, no bank date", ref.length === 1 && ref[0].decisionId === D.FULL && ref[0].refundedOn === "2026-10-03" && ref[0].bankProjection === false && /settles through Stripe payouts/.test(ref[0].note) && !("cashDate" in ref[0]));
    ck("CF39. No duplicate: one refunded line per decision (100.00), and never a timeline event", info.refundedViaStripe.count === 1 && info.refundedViaStripe.amount === "100.00");
    ck("CF40/AA. A refund is never an overhead or business cost: no category, no cost field, F11 facts keep businessCost false", !/overhead|category|businessCost":true/.test(JSON.stringify(info)));
    const d = { ...decisionForExecutionFromRow(dec(D.FULL)) } as any;
    const asF11 = (state: string) => revenueCorrectionsOf({ ...d, refundState: state, decisionType: "refund_to_card", decidedAt: "2026-10-01T12:00:00.000Z", reversedAt: null, cardRefundMinor: 10000, creditRestoredMinor: 0, cardToCreditMinor: 0, retainedMinor: 0 } as any, null, "Europe/London");
    ck("CF41/MR42/MR43. The revenue-correction facts are identical whether the refund is awaiting or refunded (no refund-month revenue, same decision-date fact)", JSON.stringify(asF11("awaiting_refund_action")) === JSON.stringify(asF11("refunded")));
  }

  // ===== AC. Access =====
  reset();
  {
    const v = await status(D.FULL, viewer);
    ck("AC45. Finance View can read the execution status (200, access view)", v.httpStatus === 200 && v.body.access === "view" && v.body.decision.cardRefund === "100.00");
    const ve = await exec(D.FULL, viewer);
    ck("AC46. Finance View cannot execute: 403 finance_manage_required, nothing sent", ve.httpStatus === 403 && ve.code === "finance_manage_required" && !world.stripe.calls.length);
    ck("AC46b. Finance View cannot reconcile: 403 finance_manage_required", (await recon(D.FULL, viewer)).code === "finance_manage_required");
    const ng = await status(D.FULL, nogrant);
    ck("AC48. No grant: 403 finance_access_denied (read and write)", ng.code === "finance_access_denied" && (await exec(D.FULL, nogrant)).code === "finance_access_denied");
    ck("AC49. Coach / Parent: 403 management_required", (await exec(D.FULL, coach)).code === "management_required" && (await status(D.FULL, parent)).code === "management_required");
    world.moduleOn = false;
    ck("AC50. Finance module off: 403 finance_module_disabled", (await exec(D.FULL)).code === "finance_module_disabled" && (await status(D.FULL)).code === "finance_module_disabled");
    world.moduleOn = true;
    const tb = parseExecuteBody(JSON.stringify({ organisationId: ORG2 }), isTenantKey) as any;
    const tq = checkRefundQuery(new URLSearchParams("organisationId=ORG-TEST-002"), isTenantKey) as any;
    ck("AC51. A tenant key in the body or the query is rejected 400 tenant_param_rejected", tb.code === "tenant_param_rejected" && tq.code === "tenant_param_rejected");
    const ov = ["amount", "currency", "stripeChargeId", "chargeId", "cardRefundAmount", "split"].map((k) => (parseExecuteBody(JSON.stringify({ [k]: "1.00" }), isTenantKey) as any).code);
    ck("AC-override. The caller can never supply the amount, currency, Stripe payment or split: each field -> 400 unexpected_field", ov.every((c) => c === "unexpected_field"));
    ck("AC-body. An empty body, {} and { reason } are accepted", (parseExecuteBody("", isTenantKey) as any).ok && (parseExecuteBody("{}", isTenantKey) as any).ok && (parseExecuteBody('{"reason":"Agreed refund"}', isTenantKey) as any).reason === "Agreed refund");
    const m = await exec(D.FULL);
    ck("AC47. Finance Manage executes", m.httpStatus === 200);
  }

  // ===== MO. Multi-organisation =====
  reset();
  {
    const r = await exec(D.ORG2, mgr2);
    const p2 = posts(world.stripe2);
    ck("MO52b. Org 2's manager executes Org 2's decision through Org 2's own Stripe key/account only", r.httpStatus === 200 && p2.length === 1 && !posts().length && world.audit.every((e) => e.organisation_id === ORG2));
    const x = await exec(D.FULL, mgr2);
    const s = await status(D.FULL, mgr2);
    ck("MO53. Org 2 cannot see or execute Org 1's decision (404), and its connector never touched Org 1's Stripe payment", x.httpStatus === 404 && s.httpStatus === 404 && !world.stripe.calls.length && !world.stripe2.calls.some((c) => /ch_ZZTESTr100/.test(c.path + (c.body ?? ""))));
  }

  // ===== AU. Audit / history =====
  reset();
  {
    const a0 = world.audit.length;
    await status(D.FULL);
    await status(D.FULL, viewer);
    ck("AU58. Status reads are never audited", world.audit.length === a0);
    await exec(D.CREDIT);
    await exec(D.ORG2);
    ck("AU-ref. Refused requests audit nothing", world.audit.length === a0);
    world.stripe.refundWrite = false;
    await exec(D.FULL);
    world.stripe.refundWrite = true;
    await exec(D.FULL);
    const all = JSON.stringify(world.audit);
    ck("AU57. No secret or card data in the audit: no key, no Authorization, no card fields; ids, amounts, statuses and codes only", !all.includes(KEY) && !/Bearer|rk_test|sk_test|card_number|exp_month|last4/i.test(all) && world.audit.every((e) => e.entity_type === "finance_refund_execution"));
    ck("AU56b. Failed then retried: started, failed, started, succeeded", JSON.stringify(evTypes(a0)) === JSON.stringify([E.started, E.failed, E.started, E.succeeded]));
    const hist = (await status(D.FULL)).body.history;
    ck("AU-hist. The execution history keeps every attempt (append-only), newest first", hist.length === 2 && hist[0].version === 2 && hist[0].status === "succeeded" && hist[1].status === "failed");
  }

  // ===== Routes =====
  {
    ck("RT. F21 owns only refund-decisions/{FRD}/execute (POST), /execution (GET), /execution/reconcile (POST); F11 keeps everything else", matchRefundExecutionRoute("refund-decisions/FRD-0123456789AB/execute", "POST")?.status === "match" && matchRefundExecutionRoute("refund-decisions/FRD-0123456789AB/execute", "GET")?.status === "method" && matchRefundExecutionRoute("refund-decisions/FRD-0123456789AB/execution", "GET")?.status === "match" && matchRefundExecutionRoute("refund-decisions/FRD-0123456789AB/execution/reconcile", "POST")?.status === "match" && matchRefundExecutionRoute("refund-decisions/FRD-0123456789AB", "GET") === null && matchRefundExecutionRoute("refund-decisions/FRD-0123456789AB/reverse", "POST") === null && matchFamilyRoute("refund-decisions/FRD-0123456789AB/reverse", "POST")?.status === "match");
  }

  // ===== Z. Code / drift checks =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ck("Z1. finance-stripe-refunds.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(noComments(code("finance-stripe-refunds.ts"))));
    const prov = noComments(code("finance-stripe-refund-provider.ts"));
    ck("Z2. The refund provider makes exactly one kind of write (POST /refunds, always with an Idempotency-Key) plus one GET; F10's read provider still sends GET only", (prov.match(/call\("POST"/g) ?? []).length === 1 && /call\("POST", "\/refunds", form, key\)/.test(prov) && /Idempotency-Key/.test(prov) && !/"DELETE"|"PATCH"|cancel|\/charges"/.test(prov) && !/"POST"|refund\(/.test(noComments(code("finance-stripe-provider.ts"))));
    const orch = noComments(code("finance-stripe-refunds-orchestrator.ts"));
    ck("Z3. Execute/reconcile authorise Manage, the read View; writes take the shared Finance write lock and go only through the two finance_stripe_refund_* functions", /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /acquireWriteLock/.test(orch) && !/fetch\(/.test(orch) && /reserveExecution\(/.test(orch) && /recordExecution\(/.test(orch));
    const repo = noComments(code("finance-stripe-refunds-repository.ts"));
    ck("Z4. F21 never writes family credit, payments or the decision table directly (no finance_family_* function, no PATCH/POST to a table)", !/finance_family_/.test(repo + orch) && !/method: "(PATCH|DELETE)"/.test(repo) && !/(credit_restored|card_to_credit)_minor\s*[:=][^=]/.test(orch));
    ck("Z5. F21 never recalculates the allocation: the amount sent is the decision's card_refund_minor (no rounding / proportion code)", /amountMinor: d\.cardRefundMinor/.test(orch) && !/Math\.(round|floor|ceil)|proportion|\* 0\./.test(orch + noComments(code("finance-stripe-refunds.ts"))));
    const idx = code("index.ts");
    ck("Z6. index.ts routes F21 before F11 and keeps the TEST Stripe guard", idx.indexOf("matchRefundExecutionRoute(route") > -1 && idx.indexOf("matchRefundExecutionRoute(route") < idx.indexOf("matchFamilyRoute(route") && /stripe: \{ requireTestMode: true \}/.test(idx));
    const nas = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts", "finance-overheads.ts", "finance-suppliers.ts", "finance-cash-flow.ts", "finance-coach-costs.ts"];
    ck("Z7. No F21 module is shared with Needs Attention (only F17's not-included wording changed in finance-cash-flow.ts)", nas.every((f) => !/finance-stripe-refund/.test(code(f))));
    const mr = code("finance-month-report.ts") + code("finance-month-report-orchestrator.ts");
    ck("Z8/MR44. The Month Report / Overview do not read F21 (revenue and profit treatment unchanged)", !/finance-stripe-refund|refund_execution|stripe_refund/.test(mr));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z9. Test copies match the canonical finance files (only import paths swapped)", copy("finance-stripe-refunds.ts") && copy("finance-stripe-refund-provider.ts") && copy("finance-stripe-refunds-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-stripe-refunds-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    const all = noComments(code("finance-stripe-refunds.ts") + code("finance-stripe-refunds-orchestrator.ts") + code("finance-stripe-refunds-repository.ts") + code("finance-stripe-refund-provider.ts"));
    ck("Z10. No webhook, Cash Flow event, overhead, F22 invoice PDF or production secret in F21", !/webhook\s*\(|CashEvent|overhead|invoicePdf|pdf\(/i.test(all) && !/Josh|sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]|bkkukymqaxawnudoxdjs/.test(all));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
