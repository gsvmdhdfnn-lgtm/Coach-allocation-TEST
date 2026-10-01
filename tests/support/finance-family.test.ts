/**
 * Finance Foundation F11 - parent / family credit + refund DECISION bridge.
 * Run: node --experimental-strip-types tests/support/finance-family.test.ts
 *
 *   FC  family credit (create, derived balance, partial, oldest first, cross-family, not a discount, void)  brief 1-9
 *   RD  refund decision (card -> Refund Due, credit, split, no return, cancellation, reason)          brief 10-15
 *   MX  mixed funding (credit part -> credit, card part -> card, never more than card, history gaps)   brief 16-19
 *   RB  returnable balance (prior decisions, Stripe refunds, over-return, duplicate, concurrency)       brief 20-24
 *   ST  Stripe boundary (succeeded source, failed refused, existing refund, no Stripe write)            brief 25-28
 *   RC  revenue / cash (credit = correction, Refund Due = no cash yet, nothing fabricated, no cost)    brief 29-32
 *   AC  access (View, Manage, no grant, coach, parent, module off, tenant)                             brief 33-39
 *   AU  audit (exact events, reads / refusals none)                                                     brief 40-41
 *   XR  reversal, family identity, parent summary
 *   Z   code / drift checks against the canonical finance files
 *
 * The REAL F11 orchestrator + repository + F10 HTTP adapter run against an
 * in-memory world: fake PostgREST + fake finance_family_* database functions
 * (the same rules as the TEST SQL, which was also exercised live), fake
 * Airtable (guardians, links, players) and a GET-only fake Stripe.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { FAMILY_EVENTS, matchFamilyRoute, parseApply, parseDecision, parseFamilyPayment, parseFamilyQuery, planApplication, planDecision, returnableOf } from "./finance-family.ts";
import {
  type FamilyDeps,
  applyFamilyCredit,
  listFamilyCredits,
  listRefundDecisions,
  listRevenueCorrections,
  readFamily,
  readRefundDecision,
  readRefundSource,
  recordFamilyPayment,
  recordRefundDecision,
  reverseRefundDecision,
  voidFamilyCredit,
} from "./finance-family-orchestrator.ts";
import { LedgerRefusal, recordDecision, loadLedger } from "./finance-family-repository.ts";
import { matchStripeRoute } from "./finance-stripe.ts";

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
const KEY = ["rk", "test", "ZZTESTreadonlyKey0123456789"].join("_");
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };
const A_REC = "recUleTQgqdkpBr8F"; // PARENT-TEST-001 Priya: Archie + Dylan verified, Bella pending
const B_REC = "recFamB000000000B"; // PARENT-ZZB: Charlie verified
const X_REC = "recFKtnX7mMJA9EFn"; // PARENT-TEST-002: only an Ended link -> not verified
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  parents: { id: string; fields: Record<string, any> }[];
  ppl: { id: string; fields: Record<string, any> }[];
  players: { id: string; fields: Record<string, any> }[];
  psl: { id: string; fields: Record<string, any> }[];
  sb: Record<string, Record<string, any>[]>;
  audit: any[];
  lockHeld: string | null;
  airtableWrites: number;
  airtableReads: string[];
  stripe: { objects: Map<string, Record<string, any>>; calls: { method: string; path: string }[] };
}
let world: World;
let NOW = new Date("2026-10-01T12:00:00.000Z");
let seq = 0;
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tick = () => new Promise((r) => setTimeout(r, 0));

const charge = (id: string, customer: string, amount: number, status = "succeeded", over: Record<string, any> = {}) => ({ id, object: "charge", customer, amount, amount_refunded: 0, currency: "gbp", status, paid: status === "succeeded", disputed: false, created: T("2026-09-15T10:00:00Z"), livemode: false, ...over });
const refund = (id: string, ch: string, amount: number, status = "succeeded") => ({ id, object: "refund", charge: ch, amount, currency: "gbp", status, created: T("2026-09-16T10:00:00Z"), livemode: false });

function seedStripe() {
  const o = new Map<string, Record<string, any>>();
  const put = (x: Record<string, any>) => o.set(x.id, x);
  put(charge("ch_A100", "cus_ZZA", 10000));
  put(charge("ch_A60", "cus_ZZA", 6000));
  put(charge("ch_A30", "cus_ZZA", 3000));
  put(refund("re_ext10", "ch_A30", 1000));
  put(refund("re_extfail", "ch_A30", 500, "failed"));
  put(charge("ch_Afull", "cus_ZZA", 2000, "succeeded", { amount_refunded: 2000 }));
  put(refund("re_extfull", "ch_Afull", 2000));
  put(charge("ch_Afail", "cus_ZZA", 5000, "failed"));
  put(charge("ch_Adisp", "cus_ZZA", 2500, "succeeded", { disputed: true }));
  put(charge("ch_J10", "cus_ZZA", 1000));
  put(charge("ch_F15", "cus_ZZA", 1500));
  put(charge("ch_C40", "cus_ZZA", 4000));
  put(charge("ch_B50", "cus_ZZB", 5000));
  put(charge("ch_B20", "cus_ZZB", 2000));
  put(charge("ch_X40", "cus_ZZX", 4000));
  put(charge("ch_U20", "cus_ZZU", 2000));
  return o;
}

function reset() {
  seq = 0;
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [] },
    moduleOn: true,
    parents: [
      { id: A_REC, fields: { "Parent ID": "PARENT-TEST-001", "Parent / Guardian Name": "Priya Parent", Active: true } },
      { id: B_REC, fields: { "Parent ID": "PARENT-ZZB", "Parent / Guardian Name": "ZZTEST Family B", Active: true } },
      { id: X_REC, fields: { "Parent ID": "PARENT-TEST-002", "Parent / Guardian Name": "Ex Parent", Active: true } },
      { id: "rec73xvcjMDl4Cckc", fields: { "Parent ID": "PARENT-DUP", "Parent / Guardian Name": "dup a", Active: true } },
      { id: "recqw4DrXB87B5Tcr", fields: { "Parent ID": "PARENT-DUP", "Parent / Guardian Name": "dup b", Active: true } },
    ],
    ppl: [
      { id: "recL1", fields: { "Parent / Guardian": [A_REC], Player: ["recegeM8tCgs5HyfU"], "Link Lifecycle Status": { name: "Verified" } } },
      { id: "recL2", fields: { "Parent / Guardian": [A_REC], Player: ["recAXySPtMtgHuwVj"], "Link Lifecycle Status": "Pending" } },
      { id: "recL3", fields: { "Parent / Guardian": [A_REC], Player: ["recbwYv7JLtoOlMV2"], "Link Lifecycle Status": "Verified" } },
      { id: "recL4", fields: { "Parent / Guardian": [B_REC], Player: ["recAUaigp0lcT3G2M"], "Link Lifecycle Status": "Verified" } },
      { id: "recL5", fields: { "Parent / Guardian": [X_REC], Player: ["recAUaigp0lcT3G2M"], "Link Lifecycle Status": "Ended" } },
    ],
    players: [
      { id: "recegeM8tCgs5HyfU", fields: { "Player ID": "PL-TEST-001", "Player Name": "Archie Atkinson" } },
      { id: "recAXySPtMtgHuwVj", fields: { "Player ID": "PL-TEST-002", "Player Name": "Bella Brown" } },
      { id: "recAUaigp0lcT3G2M", fields: { "Player ID": "PL-TEST-003", "Player Name": "Charlie Clarke" } },
      { id: "recbwYv7JLtoOlMV2", fields: { "Player ID": "PL-TEST-004", "Player Name": "Dylan Davies" } },
    ],
    psl: [{ id: "recPSL1", fields: { "Membership Lifecycle Status": "Cancellation Pending", "Cancellation Requested Date": "2026-09-30", Player: ["recegeM8tCgs5HyfU"] } }],
    sb: {
      finance_stripe_connections: [{ organisation_id: ORG, mode: "test", endpoint: "stripe", status: "connected", secret_id: "x", key_kind: "restricted", account_id: "acct_ZZTESTf11", account_name: "ZZTEST", connected_at: "2026-10-01T09:00:00Z", connected_by: MGR, last_success_at: null, last_error_at: null, last_error_code: null, last_error_message: null, fee_estimate: null, config_revision: 0, config_updated_at: null, config_updated_by: null }],
      finance_stripe_customer_links: [
        { organisation_id: ORG, stripe_customer_id: "cus_ZZA", parent_id: "PARENT-TEST-001", parent_record_id: A_REC, method: "linked_by_manager", linked_at: "2026-10-01T09:00:00Z", linked_by: MGR },
        { organisation_id: ORG, stripe_customer_id: "cus_ZZB", parent_id: "PARENT-ZZB", parent_record_id: B_REC, method: "linked_by_manager", linked_at: "2026-10-01T09:00:00Z", linked_by: MGR },
        { organisation_id: ORG, stripe_customer_id: "cus_ZZX", parent_id: "PARENT-TEST-002", parent_record_id: X_REC, method: "linked_by_manager", linked_at: "2026-10-01T09:00:00Z", linked_by: MGR },
      ],
      finance_family_payments: [],
      finance_family_credits: [],
      finance_family_credit_applications: [],
      finance_refund_decisions: [],
      finance_family_sources: [],
    },
    audit: [],
    lockHeld: null,
    airtableWrites: 0,
    airtableReads: [],
    stripe: { objects: seedStripe(), calls: [] },
  };
  NOW = new Date("2026-10-01T12:00:00.000Z");
}

// ----- fake finance_family_* database functions (same rules as the TEST SQL) -----
class Refused extends Error {}
const no = (code: string) => {
  throw new Refused(`f11:${code}`);
};
function audit(events: any[]) {
  if (!Array.isArray(events) || !events.length) no("audit_missing");
  for (const e of events) {
    if (!/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(e.event_type) || !/^[a-z][a-z_]*$/.test(e.entity_type)) throw new Error("audit check violation");
    if ((e.reason ?? "").length > 500) throw new Error("audit reason too long");
  }
  world.audit.push(...events.map((e) => ({ ...e, occurred_at: NOW.toISOString() })));
}
const T_ = (t: string) => world.sb[t];
/** The tables' owner CHECK: owner_type in (guardian_account, household); a guardian_account owner IS the guardian record. */
function ownerCheck(row: any, provenance = true) {
  if (!["guardian_account", "household"].includes(row.owner_type) || !/^[A-Za-z0-9_-]{1,64}$/.test(row.owner_key ?? "")) throw new Error("owner check violation");
  if (provenance && row.owner_type === "guardian_account" && row.owner_key !== row.family_parent_record_id) throw new Error("owner check violation");
}
function rpcFn(fn: string, a: any): unknown {
  // Each call is one transaction: work on copies, commit at the end.
  const snap = JSON.stringify({ sb: world.sb, audit: world.audit });
  try {
    const out = rpcBody(fn, a);
    return out;
  } catch (e) {
    const s = JSON.parse(snap);
    world.sb = s.sb;
    world.audit = s.audit;
    throw e;
  }
}
const appsOf = (creditId: string) => T_("finance_family_credit_applications").filter((x) => x.credit_id === creditId).reduce((s, x) => s + x.amount_minor, 0);
function rpcBody(fn: string, a: any): unknown {
  if (fn === "finance_family_payment_record") {
    const p = a.p_payment;
    if (p.stripe_charge_id) {
      if (T_("finance_family_payments").some((x) => x.organisation_id === p.organisation_id && x.stripe_charge_id === p.stripe_charge_id)) no("charge_already_recorded");
      if (T_("finance_refund_decisions").some((x) => x.organisation_id === p.organisation_id && x.source_ref === p.stripe_charge_id)) no("charge_already_a_refund_source");
    }
    ownerCheck(p);
    T_("finance_family_payments").push({ ...p });
    audit(a.p_events);
    return p.payment_id;
  }
  if (fn === "finance_family_credit_apply") {
    const pay = T_("finance_family_payments").find((x) => x.organisation_id === a.p_org && x.payment_id === a.p_payment_id);
    if (!pay) no("payment_not_found");
    if (pay.owner_type !== a.p_owner_type || pay.owner_key !== a.p_owner_key) no("cross_family");
    if (T_("finance_refund_decisions").some((x) => x.source_ref === a.p_payment_id)) no("payment_has_decisions");
    const funded = T_("finance_family_credit_applications").filter((x) => x.payment_id === a.p_payment_id).reduce((s, x) => s + x.amount_minor, 0);
    const allocs = a.p_allocations as any[];
    if (!allocs.length) no("nothing_to_apply");
    const total = allocs.reduce((s, x) => s + x.amount_minor, 0);
    if (total <= 0 || total > pay.amount_due_minor - (pay.stripe_charge_minor ?? 0) - funded) no("over_application");
    let left = total;
    let i = 0;
    const credits = T_("finance_family_credits")
      .filter((c) => c.organisation_id === a.p_org && c.owner_type === a.p_owner_type && c.owner_key === a.p_owner_key && !c.voided_at)
      .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.credit_id < y.credit_id ? -1 : 1));
    for (const c of credits) {
      if (left === 0) break;
      const rem = c.original_minor - appsOf(c.credit_id);
      if (rem <= 0) continue;
      i++;
      if (i > allocs.length) no("not_oldest_first");
      const x = allocs[i - 1];
      if (x.credit_id !== c.credit_id || x.sequence !== i) no("not_oldest_first");
      if (x.amount_minor > rem) no("insufficient_credit");
      const expect = Math.min(rem, left);
      if (x.amount_minor !== expect) no("not_oldest_first");
      T_("finance_family_credit_applications").push({ organisation_id: a.p_org, application_id: x.application_id, batch_id: a.p_batch_id, sequence: i, credit_id: c.credit_id, payment_id: a.p_payment_id, family_parent_record_id: pay.family_parent_record_id, owner_type: a.p_owner_type, owner_key: a.p_owner_key, amount_minor: expect, applied_at: a.p_applied_at, applied_by: a.p_applied_by, reason: a.p_reason });
      left -= expect;
    }
    if (left !== 0 || i !== allocs.length) no("insufficient_credit");
    audit(a.p_events);
    return { applied_minor: total, applications: allocs.length };
  }
  if (fn === "finance_family_decision_record") {
    let src = T_("finance_family_sources").find((x) => x.organisation_id === a.p_org && x.source_ref === a.p_source_ref);
    if (!src) T_("finance_family_sources").push((src = { organisation_id: a.p_org, source_ref: a.p_source_ref, version: 0 }));
    if (src.version !== a.p_expected_version) no("source_changed");
    if (a.p_source_ref.startsWith("ch_") && T_("finance_family_payments").some((x) => x.stripe_charge_id === a.p_source_ref)) no("charge_belongs_to_family_payment");
    const d = a.p_decision;
    if (a.p_source_ref.startsWith("FFP-")) {
      const pay = T_("finance_family_payments").find((x) => x.payment_id === a.p_source_ref);
      if (!pay || pay.owner_type !== d.owner_type || pay.owner_key !== d.owner_key) no("cross_family");
    }
    if (a.p_credit && (a.p_credit.owner_type !== d.owner_type || a.p_credit.owner_key !== d.owner_key)) no("cross_family");
    ownerCheck(d);
    if (a.p_credit) ownerCheck(a.p_credit);
    // The table's CHECK constraints.
    const ok =
      d.source_total_minor === d.source_credit_funded_minor + d.source_card_funded_minor &&
      d.return_minor === d.card_refund_minor + d.credit_restored_minor + d.card_to_credit_minor &&
      d.credit_restored_minor <= d.source_credit_funded_minor &&
      d.card_refund_minor + d.card_to_credit_minor <= d.source_card_funded_minor &&
      d.return_minor <= d.returnable_before_minor &&
      (d.decision_type === "no_return") === (d.return_minor === 0) &&
      (d.card_refund_minor > 0) === (d.refund_state !== "none") &&
      ["none", "awaiting_refund_action"].includes(d.refund_state);
    if (!ok) throw new Error("finance_refund_decisions check violation");
    T_("finance_refund_decisions").push({ ...d });
    if (a.p_credit) {
      if (a.p_credit.original_minor !== a.p_credit.credit_funded_minor + a.p_credit.card_funded_minor || a.p_credit.original_minor <= 0) throw new Error("credit check violation");
      T_("finance_family_credits").push({ ...a.p_credit });
    }
    src.version++;
    audit(a.p_events);
    return src.version;
  }
  if (fn === "finance_family_credit_void") {
    const c = T_("finance_family_credits").find((x) => x.organisation_id === a.p_org && x.credit_id === a.p_credit_id);
    if (!c) no("credit_not_found");
    if (c.voided_at) no("credit_already_voided");
    if (appsOf(c.credit_id) > 0) no("credit_used");
    Object.assign(c, { voided_at: a.p_at, voided_by: a.p_by, void_kind: "manual_void", void_reason: a.p_reason });
    audit(a.p_events);
    return null;
  }
  if (fn === "finance_family_decision_reverse") {
    const d = T_("finance_refund_decisions").find((x) => x.organisation_id === a.p_org && x.decision_id === a.p_decision_id);
    if (!d) no("decision_not_found");
    if (d.reversed_at) no("decision_already_reversed");
    if (!["none", "awaiting_refund_action"].includes(d.refund_state) || d.stripe_refund_id) no("refund_in_progress");
    const src = T_("finance_family_sources").find((x) => x.organisation_id === a.p_org && x.source_ref === d.source_ref);
    if ((src?.version ?? null) !== a.p_expected_version) no("source_changed");
    const c = T_("finance_family_credits").find((x) => x.origin_decision_id === d.decision_id);
    if (c) {
      if (c.voided_at) no("credit_voided_separately");
      if (appsOf(c.credit_id) > 0) no("credit_used");
      Object.assign(c, { voided_at: a.p_at, voided_by: a.p_by, void_kind: "decision_reversed", void_reason: a.p_reason });
    }
    Object.assign(d, { reversed_at: a.p_at, reversed_by: a.p_by, reverse_reason: a.p_reason });
    src.version++;
    audit(a.p_events);
    return src.version;
  }
  throw new Error(`unknown rpc ${fn}`);
}

function postgrest(url: string, method: string, body: any): Response {
  const u = new URL(url);
  const table = u.pathname.split("/").pop() as string;
  const rows = world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  if (method !== "GET" && table.startsWith("finance_family") || method !== "GET" && table === "finance_refund_decisions") return json({ message: "F11 writes only through its database functions" }, 403);
  const fs: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (k !== "select" && k !== "order") fs.push([k, v.replace(/^eq\./, "")]);
  const hit = (r: Record<string, any>) => fs.every(([k, v]) => String(r[k] ?? "") === v);
  if (method === "GET") return json(rows.filter(hit).map((r) => ({ ...r })));
  if (method === "PATCH") {
    const h = rows.filter(hit);
    for (const r of h) Object.assign(r, body);
    return json(null, 204);
  }
  return json({ message: "unexpected" }, 405);
}

async function stripeFetch(url: string, init: any): Promise<Response> {
  const u = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const path = u.pathname.replace(/^\/v1\/?/, "");
  world.stripe.calls.push({ method, path: `/${path}` });
  if (init.headers?.Authorization !== `Bearer ${KEY}`) return json({ error: { message: "bad key" } }, 401);
  if (method !== "GET") return json({ error: { message: "fake Stripe is read-only" } }, 405);
  const seg = path.split("/").filter(Boolean);
  if (seg[0] === "charges" && seg.length === 2) {
    const o = world.stripe.objects.get(seg[1]);
    return o && o.object === "charge" ? json(JSON.parse(JSON.stringify(o))) : json({ error: { message: "No such charge", code: "resource_missing" } }, 404);
  }
  if (seg[0] === "refunds" && seg.length === 1) {
    const ch = u.searchParams.get("charge");
    const all = [...world.stripe.objects.values()].filter((o) => o.object === "refund" && (!ch || o.charge === ch));
    return json({ object: "list", data: all, has_more: false });
  }
  return json({ error: { message: "Unrecognized request URL" } }, 404);
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick();
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("https://api.stripe.com/")) return stripeFetch(url, init);
  const body = init.body ? JSON.parse(init.body) : undefined;
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
  if (url.includes("/rpc/finance_stripe_secret")) return json(KEY);
  const rpcMatch = /\/rpc\/(finance_family_[a-z_]+)$/.exec(url);
  if (rpcMatch) {
    try {
      return json(rpcFn(rpcMatch[1], body));
    } catch (e) {
      if (e instanceof Refused) return json({ code: "P0001", message: e.message }, 400);
      return json({ message: String(e) }, 400);
    }
  }
  if (url.includes("/rest/v1/finance_audit_events")) return json({ message: "F11 audits inside its database functions" }, 403);
  if (url.includes("/rest/v1/")) return postgrest(url, method, body);
  if (url.startsWith("https://api.airtable.com/")) {
    if (method !== "GET") {
      world.airtableWrites++;
      return json({ error: "F11 must not write Airtable" }, 418);
    }
    const t = decodeURIComponent(new URL(url).pathname.split("/").pop() as string);
    world.airtableReads.push(t);
    if (t === "Organisation & Branding") return json({ records: [ORG_ROW] });
    if (t === "Feature Controls") return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
    if (t === "Parents & Guardians") return json({ records: world.parents });
    if (t === "Parent–Player Links") return json({ records: world.ppl });
    if (t === "Players") return json({ records: world.players });
    if (t === "Player Session Links") return json({ records: world.psl });
    return json({ records: [] });
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

let rnd = 0;
const deps: FamilyDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  stripe: { requireTestMode: true, timeoutMs: 40 },
  family: { random: () => (++rnd).toString(16).padStart(12, "0") + "0000" },
};

const decide = (body: Record<string, unknown>, caller: any = mgr) => {
  const p = parseDecision(JSON.stringify({ reason: "Agreed with the parent after cancellation", ...body }), isTenantKey);
  if (!p.ok) return Promise.resolve({ status: "error", ...p } as any);
  return recordRefundDecision(deps, caller, p) as Promise<any>;
};
const pay = (body: Record<string, unknown>, caller: any = mgr) => {
  const p = parseFamilyPayment(JSON.stringify({ parentId: "PARENT-TEST-001", description: "ZZTEST camp booking", reason: "TEST payment record", ...body }), isTenantKey);
  if (!p.ok) return Promise.resolve({ status: "error", ...p } as any);
  return recordFamilyPayment(deps, caller, p) as Promise<any>;
};
const apply = (body: Record<string, unknown>, caller: any = mgr) => {
  const p = parseApply(JSON.stringify({ parentId: "PARENT-TEST-001", ...body }), isTenantKey);
  if (!p.ok) return Promise.resolve({ status: "error", ...p } as any);
  return applyFamilyCredit(deps, caller, p) as Promise<any>;
};
const fam = (pid = "PARENT-TEST-001", caller: any = mgr) => readFamily(deps, caller, pid) as Promise<any>;
const src = (ref: string, caller: any = mgr) => readRefundSource(deps, caller, ref) as Promise<any>;
const at = (iso: string) => (NOW = new Date(iso));
const evTypes = (from: number) => world.audit.slice(from).map((e) => e.event_type);
const stripeWrites = () => world.stripe.calls.filter((c) => c.method !== "GET").length;

async function main() {
  // ===== FC. Family credit =====
  reset();
  {
    const a0 = world.audit.length;
    const d = await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const credit = world.sb.finance_family_credits[0];
    ck("FC1. Family credit is created from a decision: 100.00 credit for the guardian account (family), available, linked to its decision and source", d.httpStatus === 201 && d.body.decision.status.execution === "credit_created" && d.body.decision.status.refund === "none" && d.body.familyCredit.original === "100.00" && d.body.familyCredit.status === "available" && credit.family_parent_record_id === A_REC && credit.origin_decision_id === d.body.decision.decisionId && credit.source_ref === "ch_A100", JSON.stringify(d.body ?? d));
    ck("AU40a. Exact audit for a credit decision: refund_decision_recorded + credit_created, nothing else", JSON.stringify(evTypes(a0)) === JSON.stringify([FAMILY_EVENTS.decisionRecorded, FAMILY_EVENTS.creditCreated]));
    const f = await fam();
    ck("FC2. The balance is derived from the ledger (original - applications), never stored", f.body.creditAvailable === "100.00" && f.body.credits[0].remaining === "100.00" && !Object.keys(credit).some((k) => /balance|remaining/.test(k)));
    const p = await pay({ amount: "30.00" });
    const a1 = world.audit.length;
    const ap = await apply({ paymentId: p.body.payment.paymentId });
    const f2 = await fam();
    ck("FC3. Partial use keeps the remainder (pennies intact): 30.00 applied, 70.00 left, partially used", ap.httpStatus === 201 && ap.body.applied === "30.00" && f2.body.creditAvailable === "70.00" && f2.body.credits[0].status === "partially_used" && f2.body.credits[0].remaining === "70.00" && ap.body.payment.unfunded === "0.00");
    ck("AU40b. Exact audit for an application: one credit_applied event with its allocations", JSON.stringify(evTypes(a1)) === JSON.stringify([FAMILY_EVENTS.creditApplied]) && world.audit[a1].after.allocations.length === 1);
    ck("FC7. Family credit is not a discount: the payment's priced amount is unchanged (credit pays it), credits say isDiscount false", f2.body.payments[0].due === "30.00" && f2.body.payments[0].creditFunded === "30.00" && f2.body.credits.every((c: any) => c.isDiscount === false));
    // Void: used credit refused, unused voided.
    const a2 = world.audit.length;
    const v1 = await voidFamilyCredit(deps, mgr, credit.credit_id, "Wrong family") as any;
    ck("FC9. Voiding a used (partly spent) credit is refused - history stays; no audit", v1.httpStatus === 409 && v1.code === "credit_used" && world.audit.length === a2 && !world.sb.finance_family_credits[0].voided_at);
    const d2 = await decide({ source: "ch_C40", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const v2 = await voidFamilyCredit(deps, mgr, d2.body.familyCredit.creditId, "Goodwill withdrawn - TEST") as any;
    const f3 = await fam();
    ck("FC8. An unused credit can be voided with a reason (audited credit_voided); the balance drops by exactly it", v2.httpStatus === 200 && v2.body.credit.status === "voided" && f3.body.creditAvailable === "70.00" && world.audit[world.audit.length - 1].event_type === FAMILY_EVENTS.creditVoided);
  }
  // Oldest first: 10.00 (Jan) and 15.00 (Feb), apply 12.00 -> 10.00 Jan + 2.00 Feb, 13.00 Feb left.
  reset();
  {
    at("2026-01-10T10:00:00Z");
    const jan = await decide({ source: "ch_J10", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    at("2026-02-10T10:00:00Z");
    const feb = await decide({ source: "ch_F15", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    at("2026-10-01T12:00:00Z");
    const p = await pay({ amount: "12.00" });
    const ap = await apply({ paymentId: p.body.payment.paymentId });
    const f = await fam();
    const al = ap.body.allocations;
    ck("FC4. Oldest credit first: 12.00 uses the January 10.00 then 2.00 of February", al.length === 2 && al[0].creditId === jan.body.familyCredit.creditId && al[0].amount === "10.00" && al[0].remainingAfter === "0.00" && al[1].creditId === feb.body.familyCredit.creditId && al[1].amount === "2.00" && al[1].remainingAfter === "13.00");
    ck("FC5. Several credits are consumed deterministically: Jan used, Feb partially used 13.00, balance 13.00", f.body.credits.find((c: any) => c.creditId === jan.body.familyCredit.creditId).status === "used" && f.body.credits.find((c: any) => c.creditId === feb.body.familyCredit.creditId).remaining === "13.00" && f.body.creditAvailable === "13.00");
    // Same timestamp: credit id breaks the tie; never newest first.
    const credits = [
      { creditId: "FFC-00000000000B", familyRecordId: A_REC, createdAt: "2026-03-01T00:00:00.000Z", originalMinor: 500, voidedAt: null },
      { creditId: "FFC-00000000000A", familyRecordId: A_REC, createdAt: "2026-03-01T00:00:00.000Z", originalMinor: 500, voidedAt: null },
      { creditId: "FFC-000000000000", familyRecordId: A_REC, createdAt: "2026-04-01T00:00:00.000Z", originalMinor: 500, voidedAt: null },
    ] as any[];
    const pl = planApplication({ ownerType: "guardian_account", ownerKey: A_REC }, { credits: credits.map((c) => ({ ...c, ownerType: "guardian_account", ownerKey: A_REC })), applications: [] }, 700) as any;
    ck("FC4b. Equal creation times break ties by credit id; the newest credit is used last", pl.ok && pl.allocations.map((x: any) => x.creditId).join(",") === "FFC-00000000000A,FFC-00000000000B" && pl.allocations[1].amountMinor === 200);
    // Cross-family.
    const pB = await pay({ parentId: "PARENT-ZZB", amount: "5.00" });
    const a0 = world.audit.length;
    const x1 = await apply({ parentId: "PARENT-TEST-001", paymentId: pB.body.payment.paymentId });
    const x2 = await apply({ parentId: "PARENT-ZZB", paymentId: p.body.payment.paymentId });
    let dbRefused = "";
    try {
      rpcFn("finance_family_credit_apply", { p_org: ORG, p_payment_id: pB.body.payment.paymentId, p_owner_type: "guardian_account", p_owner_key: A_REC, p_batch_id: "FFB-000000000099", p_allocations: [{ application_id: "FFA-000000000099", credit_id: feb.body.familyCredit.creditId, amount_minor: 100, sequence: 1 }], p_applied_at: NOW.toISOString(), p_applied_by: MGR, p_reason: null, p_events: [{}] });
    } catch (e) {
      dbRefused = (e as Error).message;
    }
    ck("FC6. One family cannot spend another's credit: refused by the API (both directions) and by the database function; no audit", x1.httpStatus === 409 && x1.code === "cross_family_refused" && x2.httpStatus === 409 && x2.code === "cross_family_refused" && dbRefused === "f11:cross_family" && world.audit.length === a0);
  }

  // ===== RD. Refund decisions =====
  reset();
  {
    const a0 = world.audit.length;
    const d = await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", playerId: "PL-TEST-001" });
    ck("RD10. Full card refund decision -> Refund Due / awaiting refund action; 100.00 refund portion, no credit, no Stripe write", d.httpStatus === 201 && d.body.decision.status.execution === "refund_due" && d.body.decision.status.refund === "awaiting_refund_action" && d.body.decision.refundPortion === "100.00" && d.body.decision.creditPortion === "0.00" && d.body.familyCredit === null && stripeWrites() === 0 && d.body.decision.player.name === "Archie Atkinson");
    ck("AU40c. Exact audit for a card refund decision: refund_decision_recorded + refund_due_recorded", JSON.stringify(evTypes(a0)) === JSON.stringify([FAMILY_EVENTS.decisionRecorded, FAMILY_EVENTS.refundDueRecorded]) && !JSON.stringify(world.audit.slice(a0)).includes(KEY));
    const fc = await decide({ source: "ch_B50", parentId: "PARENT-ZZB", decisionType: "family_credit" });
    ck("RD11. Full family-credit decision: 50.00 credit, credit_created, no refund obligation", fc.httpStatus === 201 && fc.body.decision.status.execution === "credit_created" && fc.body.familyCredit.original === "50.00" && fc.body.familyCredit.fundedBy.cardFunded === "50.00" && fc.body.decision.status.refund === "none");
    const a1 = world.audit.length;
    const sp = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "split", cardRefundAmount: "40.00" });
    ck("RD12. Split: 40.00 to card (Refund Due) + 20.00 family credit under ONE decision (split_refund_due)", sp.httpStatus === 201 && sp.body.decision.status.execution === "split_refund_due" && sp.body.decision.refundPortion === "40.00" && sp.body.decision.creditPortion === "20.00" && sp.body.familyCredit.original === "20.00" && sp.body.familyCredit.origin.decisionId === sp.body.decision.decisionId);
    ck("AU40d. Exact audit for a split: decision + credit_created + refund_due_recorded", JSON.stringify(evTypes(a1)) === JSON.stringify([FAMILY_EVENTS.decisionRecorded, FAMILY_EVENTS.creditCreated, FAMILY_EVENTS.refundDueRecorded]));
    const nr = await decide({ source: "ch_B20", parentId: "PARENT-ZZB", decisionType: "no_return" });
    const nr2 = await decide({ source: "ch_B20", parentId: "PARENT-ZZB", decisionType: "refund_to_card" });
    ck("RD13. No-return decision: decided_no_return, 20.00 retained, nothing returned; a later return is refused until reversed", nr.httpStatus === 201 && nr.body.decision.status.execution === "decided_no_return" && nr.body.decision.retained === "20.00" && nr.body.decision.returned === "0.00" && nr2.httpStatus === 409 && nr2.code === "source_closed_no_return");
    const before = world.sb.finance_refund_decisions.length;
    const list = await listRefundDecisions(deps, mgr, {}) as any;
    ck("RD14. Cancellation alone creates nothing: a 'Cancellation Pending' membership exists, but only the 4 explicit decisions exist; F11 never reads memberships", world.psl[0].fields["Membership Lifecycle Status"] === "Cancellation Pending" && list.body.decisions.length === before && before === 4 && !world.airtableReads.includes("Player Session Links"));
    const r1 = parseDecision(JSON.stringify({ source: "ch_A30", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }), isTenantKey) as any;
    const r2 = parseDecision(JSON.stringify({ source: "ch_A30", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", reason: "x", policy: { kind: "occurrence_financial_outcome" } }), isTenantKey) as any;
    const r3 = parseDecision(JSON.stringify({ source: "ch_A30", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", reason: "Camp cancelled by us", policy: { kind: "occurrence_financial_outcome", ref: "recOFO0000000001" } }), isTenantKey) as any;
    ck("RD15. A decision requires a reason; a policy-sourced decision requires its source record ref", !r1.ok && r1.fields.reason === "is required" && !r2.ok && /ref is required/.test(r2.fields.policy) && r3.ok && r3.policyKind === "occurrence_financial_outcome");
  }

  // ===== MX. Mixed funding =====
  reset();
  {
    await decide({ source: "ch_C40", parentId: "PARENT-TEST-001", decisionType: "family_credit" }); // 40.00 credit
    const p = await pay({ amount: "100.00", stripeChargeId: "ch_A60", playerId: "PL-TEST-004", bookingRef: "ZZTEST-CAMP-1" });
    const ap = await apply({ paymentId: p.body.payment.paymentId });
    const s = await src(p.body.payment.paymentId);
    ck("MX16a. A 100.00 payment funded 40.00 by family credit + 60.00 by card is recorded from facts (applications + Stripe charge)", p.httpStatus === 201 && p.body.payment.unfunded === "40.00" && ap.body.applied === "40.00" && s.body.source.funding.creditFunded === "40.00" && s.body.source.funding.cardFunded === "60.00" && s.body.source.returnable.total === "100.00");
    // Partial 50.00: proportional to the remaining parts -> 20.00 credit + 30.00 card.
    const part = await decide({ source: p.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "refund_to_card", amount: "50.00" });
    ck("MX17. Partial 50.00 return of 40/60 funding -> 20.00 back to family credit + 30.00 Refund Due (credit-funded value never goes to card)", part.httpStatus === 201 && part.body.decision.creditPortion === "20.00" && part.body.decision.refundPortion === "30.00" && part.body.familyCredit.fundedBy.creditFunded === "20.00" && part.body.decision.status.execution === "split_refund_due" && part.body.decision.player.name === "Dylan Davies");
    const rest = await decide({ source: p.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    const cardTotal = world.sb.finance_refund_decisions.reduce((a, d) => a + d.card_refund_minor, 0);
    ck("MX18. The card part never exceeds the original card payment: the rest returns 20.00 credit + 30.00 card; card total 60.00 = the charge", rest.httpStatus === 201 && rest.body.decision.creditPortion === "20.00" && rest.body.decision.refundPortion === "30.00" && cardTotal === 6000);
    // Full return in one go (fresh): 40 -> credit, 60 -> card.
    reset();
    await decide({ source: "ch_C40", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const p2 = await pay({ amount: "100.00", stripeChargeId: "ch_A60" });
    await apply({ paymentId: p2.body.payment.paymentId });
    const full = await decide({ source: p2.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("MX16b. A full 100.00 return of 40 credit + 60 card -> 40.00 family credit + 60.00 Refund Due, never 100.00 to card", full.httpStatus === 201 && full.body.decision.creditPortion === "40.00" && full.body.decision.refundPortion === "60.00");
    const direct = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("MX16c. The card charge inside a family payment cannot be decided on its own (that would ignore the credit part)", direct.httpStatus === 409 && direct.code === "charge_belongs_to_family_payment");
    // Fully credit-funded payment: refund to card is impossible.
    reset();
    await decide({ source: "ch_C40", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const p3 = await pay({ amount: "25.00" });
    await apply({ paymentId: p3.body.payment.paymentId });
    const toCard = await decide({ source: p3.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    const toCredit = await decide({ source: p3.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    ck("MX17b. A wholly credit-funded payment cannot be refunded to card (409 no_card_funded_value); it returns as family credit", toCard.httpStatus === 409 && toCard.code === "no_card_funded_value" && toCredit.httpStatus === 201 && toCredit.body.familyCredit.fundedBy.creditFunded === "25.00" && toCredit.body.familyCredit.fundedBy.cardFunded === "0.00");
    // Insufficient history.
    const p4 = await pay({ amount: "80.00" });
    const gap = await decide({ source: p4.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const p5 = await pay({ amount: "100.00", stripeChargeId: "ch_A100" });
    world.stripe.objects.get("ch_A100")!.amount = 9000;
    const mism = await decide({ source: p5.body.payment.paymentId, parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("MX19. Insufficient funding history fails safely: unfunded remainder -> 409 funding_incomplete; Stripe no longer matching -> 409 funding_history_mismatch; nothing recorded", gap.httpStatus === 409 && gap.code === "funding_incomplete" && mism.httpStatus === 409 && mism.code === "funding_history_mismatch" && world.sb.finance_refund_decisions.length === 2);
  }

  // ===== RB. Returnable balance =====
  reset();
  {
    await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", amount: "40.00" });
    const s = await src("ch_A100");
    ck("RB20. A prior decision reduces what remains: 100.00 - 40.00 Refund Due = 60.00 returnable", s.body.source.returnable.total === "60.00" && s.body.source.alreadyDecided.cardRefund === "40.00" && s.body.decisions.length === 1);
    const s2 = await src("ch_A30");
    ck("RB21. A Stripe refund the Hub did not decide reduces what remains and is surfaced (30.00 - 10.00 = 20.00; failed refund ignored)", s2.body.source.returnable.total === "20.00" && s2.body.source.stripeRefunds.amount === "10.00" && s2.body.source.stripeRefunds.state === "partially_refunded_in_stripe_without_hub_decision" && s2.body.source.stripeRefunds.refunds.length === 1);
    const a0 = world.audit.length;
    const over = await decide({ source: "ch_A30", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", amount: "25.00" });
    ck("RB22. Over-return refused (25.00 > 20.00 returnable); nothing recorded or audited", over.httpStatus === 409 && over.code === "over_return" && over.details.returnable === "20.00" && world.audit.length === a0);
    const d1 = await decide({ source: "ch_A30", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    const d2 = await decide({ source: "ch_A30", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("RB23. A duplicate decision is refused once nothing remains (409 nothing_returnable)", d1.httpStatus === 201 && d1.body.decision.refundPortion === "20.00" && d2.httpStatus === 409 && d2.code === "nothing_returnable");
    // Concurrency: two simultaneous full decisions; two simultaneous applications.
    const [c1, c2] = await Promise.all([decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }), decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "family_credit" })]);
    const okN = [c1, c2].filter((x) => x.httpStatus === 201).length;
    let stale = "";
    try {
      const L = await loadLedger(deps.grants, ORG);
      const d = { ...L.decisions[L.decisions.length - 1], decisionId: "FRD-0000000000FF" };
      await recordDecision(deps.grants, d, null, 0, [{ organisation_id: ORG, actor_user_id: MGR, event_type: "finance_family.x", entity_type: "x", record_id: "x", before: null, after: {}, reason: null, context: {} }]);
    } catch (e) {
      stale = e instanceof LedgerRefusal ? e.code : String(e);
    }
    ck("RB24a. Two simultaneous full decisions: exactly one succeeds (the other is refused busy); a stale decision is refused by the database (source_changed)", okN === 1 && [c1, c2].some((x) => x.code === "finance_commercial_busy") && stale === "source_changed" && world.sb.finance_refund_decisions.filter((d) => d.source_ref === "ch_A60").length === 1);
    await decide({ source: "ch_C40", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const pA = await pay({ amount: "40.00" });
    const pB = await pay({ amount: "40.00" });
    const [x1, x2] = await Promise.all([apply({ paymentId: pA.body.payment.paymentId }), apply({ paymentId: pB.body.payment.paymentId })]);
    const f = await fam();
    const applied = world.sb.finance_family_credit_applications.reduce((a, x) => a + x.amount_minor, 0);
    ck("RB24b. Two simultaneous applications never overspend: one applies, the other is refused; total applied <= credit", [x1, x2].filter((x) => x.httpStatus === 201).length === 1 && applied <= 4000 + (c1.httpStatus === 201 && c1.body.familyCredit ? 0 : 6000) && Number(f.body.creditAvailable) >= 0);
  }

  // ===== ST. Stripe boundary =====
  reset();
  {
    const ok = await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("ST25. An F10-readable succeeded Stripe payment is a valid source (family from the explicit customer link)", ok.httpStatus === 201 && ok.body.decision.technical.stripeChargeId === "ch_A100" && ok.body.decision.family.parentId === "PARENT-TEST-001");
    const bad = await decide({ source: "ch_Afail", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    const disp = await decide({ source: "ch_Adisp", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    const unl = await decide({ source: "ch_U20", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    const wrongFam = await decide({ source: "ch_B50", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("ST26. A failed Stripe charge cannot be a refund source (409 stripe_charge_not_succeeded); disputed, unlinked customer and another family's charge are refused too", bad.httpStatus === 409 && bad.code === "stripe_charge_not_succeeded" && disp.code === "stripe_charge_disputed" && unl.code === "stripe_customer_not_linked" && wrongFam.code === "family_mismatch");
    const s = await src("ch_Afull");
    const again = await decide({ source: "ch_Afull", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("ST27. A refund already made in Stripe is recognised: fully refunded -> 0.00 returnable, surfaced as external; no second refund obligation", s.body.source.returnable.total === "0.00" && s.body.source.stripeRefunds.state === "fully_refunded_in_stripe_without_hub_decision" && again.httpStatus === 409 && again.code === "nothing_returnable");
    const prov = readFileSync(join(CANON, "finance-stripe-provider.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    ck("ST28. No Stripe write exists: every fake-Stripe call was GET; the provider sends GET only; no refund route in F10 or F11", stripeWrites() === 0 && world.stripe.calls.length > 0 && !/"POST"|"DELETE"|refund\(/.test(prov) && matchFamilyRoute("stripe/refund", "POST") === null && matchStripeRoute("stripe/refunds", "POST")!.status === "method" && matchFamilyRoute("refund-decisions/FRD-000000000001/execute", "POST")!.status === "not_found");
  }

  // ===== RC. Revenue / cash =====
  reset();
  {
    await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "split", cardRefundAmount: "70.00" });
    const rc = await listRevenueCorrections(deps, mgr, {}) as any;
    const credit = rc.body.corrections.find((c: any) => c.type === "family_credit");
    const due = rc.body.corrections.find((c: any) => c.type === "refund_due");
    ck("RC29. Family credit is a revenue correction with no cash impact", credit.amount === "30.00" && credit.cashImpact === "none" && credit.source === "parent_finance_decision");
    ck("RC30. Refund Due is a revenue correction with NO cash out yet (cash leaves only when F21 executes)", due.amount === "70.00" && due.cashImpact === "none_yet" && rc.body.totals.refund_due === "70.00");
    const d = (await listRefundDecisions(deps, mgr, {}) as any).body.decisions[0];
    ck("RC31. No executed refund is fabricated: refund state stays awaiting_refund_action, no Stripe refund id, no refund object in Stripe, cash moved 0.00", d.status.refund === "awaiting_refund_action" && d.technical.stripeRefundId === null && [...world.stripe.objects.values()].filter((o) => o.object === "refund").length === 3 && d.cash.movedNow === "0.00");
    ck("RC32. No fake business cost: every fact says businessCost false; nothing is written to Airtable (no F7 payment / cost rows)", rc.body.corrections.every((c: any) => c.businessCost === false) && world.airtableWrites === 0);
  }

  // ===== AC. Access =====
  reset();
  {
    const d = await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const reads = await Promise.all([fam("PARENT-TEST-001", viewer), listFamilyCredits(deps, viewer, {}), listRefundDecisions(deps, viewer, {}), readRefundDecision(deps, viewer, d.body.decision.decisionId), src("ch_A100", viewer), listRevenueCorrections(deps, viewer, {})]);
    const vw = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }, viewer);
    const vv = await voidFamilyCredit(deps, viewer, d.body.familyCredit.creditId, "x") as any;
    ck("AC33. Finance View reads every F11 read model; its writes are refused 403", reads.every((r: any) => r.httpStatus === 200 && r.body.access === "view") && vw.httpStatus === 403 && vv.httpStatus === 403);
    ck("AC34. Finance Manage writes (decisions, payments, applications, voids, reversals)", d.httpStatus === 201 && d.body.access === "manage");
    const ng = await fam("PARENT-TEST-001", nogrant);
    const ngw = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }, nogrant);
    ck("AC35. No Finance grant: reads and writes refused 403", ng.httpStatus === 403 && ngw.httpStatus === 403);
    const co = await fam("PARENT-TEST-001", coach);
    const cow = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }, coach);
    ck("AC36. Coach refused", co.httpStatus === 403 && cow.httpStatus === 403);
    const pa = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }, parent);
    const pap = await apply({ paymentId: "FFP-000000000001" }, parent);
    ck("AC37. A Parent cannot use Management write routes (or read Management views)", pa.httpStatus === 403 && pap.httpStatus === 403 && (await fam("PARENT-TEST-001", parent)).httpStatus === 403);
    world.moduleOn = false;
    const mo = await fam();
    const mow = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    ck("AC38. Module off: reads and writes refused 403 finance_module_disabled", mo.code === "finance_module_disabled" && mow.code === "finance_module_disabled");
    world.moduleOn = true;
    const t1 = parseDecision(JSON.stringify({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", reason: "x", organisationId: "ORG-OTHER" }), isTenantKey) as any;
    const t2 = parseFamilyQuery("family.decisions", new URLSearchParams("organisation_id=ORG-OTHER"), isTenantKey) as any;
    const t3 = parseApply(JSON.stringify({ parentId: "PARENT-TEST-001", paymentId: "FFP-000000000001", org: "x" }), isTenantKey) as any;
    ck("AC39. A tenant override in a body or query is rejected 400 tenant_param_rejected", t1.code === "tenant_param_rejected" && t2.code === "tenant_param_rejected" && t3.code === "tenant_param_rejected");
  }

  // ===== AU. Audit on reads / refusals =====
  reset();
  {
    await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const a0 = world.audit.length;
    await fam();
    await listFamilyCredits(deps, mgr, {});
    await listRefundDecisions(deps, mgr, {});
    await src("ch_A100");
    await listRevenueCorrections(deps, mgr, {});
    await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }); // nothing returnable
    await decide({ source: "ch_Afail", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" });
    await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card" }, viewer);
    await apply({ parentId: "PARENT-ZZB", paymentId: "FFP-000000000009" });
    ck("AU41. Reads and refused writes create no audit event", world.audit.length === a0);
  }

  // ===== XR. Reversal, identity, summary =====
  reset();
  {
    const d = await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "split", cardRefundAmount: "60.00" });
    const a0 = world.audit.length;
    const rv = await reverseRefundDecision(deps, mgr, d.body.decision.decisionId, "Entered against the wrong payment") as any;
    const s = await src("ch_A100");
    const f = await fam();
    ck("XR1. Reversing an unspent decision restores the returnable value, voids its unused credit and cancels its Refund Due (one audit event)", rv.httpStatus === 200 && rv.body.restoredReturnable === "100.00" && s.body.source.returnable.total === "100.00" && f.body.creditAvailable === "0.00" && f.body.credits[0].voided.kind === "decision_reversed" && JSON.stringify(evTypes(a0)) === JSON.stringify([FAMILY_EVENTS.decisionReversed]) && f.body.parentSummary.refunds.length === 0);
    const d2 = await decide({ source: "ch_A100", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const p = await pay({ amount: "10.00" });
    await apply({ paymentId: p.body.payment.paymentId });
    const rv2 = await reverseRefundDecision(deps, mgr, d2.body.decision.decisionId, "x") as any;
    const rv3 = await reverseRefundDecision(deps, mgr, d.body.decision.decisionId, "x") as any;
    ck("XR2. A decision whose credit has been spent cannot be reversed; a reversed one cannot be reversed twice", rv2.httpStatus === 409 && rv2.code === "credit_used" && rv3.code === "decision_already_reversed");
    const x = await decide({ source: "ch_X40", parentId: "PARENT-TEST-002", decisionType: "family_credit" });
    const xCard = await decide({ source: "ch_X40", parentId: "PARENT-TEST-002", decisionType: "refund_to_card" });
    const dup = await fam("PARENT-DUP");
    const notMine = await decide({ source: "ch_A60", parentId: "PARENT-TEST-001", decisionType: "refund_to_card", playerId: "PL-TEST-002" });
    ck("XR3. Family identity: an unverified guardian gets no credit (card refund only); a duplicate Parent ID is refused; a pending (unverified) child is refused", x.httpStatus === 409 && x.code === "family_not_verified" && xCard.httpStatus === 201 && dup.httpStatus === 409 && dup.code === "parent_id_ambiguous" && notMine.code === "player_not_eligible");
    const fA = await fam();
    ck("XR4. The parent summary is simple: credit available + refunds awaiting processing (ledger detail stays underneath)", fA.body.parentSummary.creditAvailable === "90.00" && Array.isArray(fA.body.parentSummary.refunds) && fA.body.family.eligibleChildren.map((c: any) => c.playerId).sort().join(",") === "PL-TEST-001,PL-TEST-004");
    const r = returnableOf({ sourceType: "family_payment", sourceRef: "FFP-000000000001", totalMinor: 1001, creditFundedMinor: 333, cardFundedMinor: 668 }, [], []);
    const pd = planDecision(r, { decisionType: "refund_to_card", amountMinor: 500, cardRefundMinor: null }, true) as any;
    ck("XR5. Proportional partial split is exact in pence (credit share rounded down, the penny stays with the card share)", pd.ok && pd.amounts.creditRestoredMinor === 166 && pd.amounts.cardRefundMinor === 334 && pd.amounts.returnMinor === 500);
  }

  // ===== OW. Owner fields (separate from guardian history) =====
  reset();
  {
    await decide({ source: "ch_C40", parentId: "PARENT-TEST-001", decisionType: "family_credit" });
    const p = await pay({ amount: "15.00" });
    await apply({ paymentId: p.body.payment.paymentId });
    const rows = [...world.sb.finance_family_payments, ...world.sb.finance_family_credits, ...world.sb.finance_family_credit_applications, ...world.sb.finance_refund_decisions];
    ck("OW1. Every F11 row carries owner_type = guardian_account and owner_key = the verified guardian account, beside its (separate) guardian-account history fields", rows.length === 4 && rows.every((r) => r.owner_type === "guardian_account" && r.owner_key === A_REC && r.family_parent_record_id === A_REC));
    const f0 = await fam();
    ck("OW2. Read models expose the owner (transitional: the verified guardian account)", f0.body.owner.type === "guardian_account" && f0.body.owner.key === A_REC && f0.body.credits[0].owner.key === A_REC && f0.body.refundDecisions[0].owner.key === A_REC);
    // Simulate the FUTURE explicit transfer (guardian_account -> household) on credit + payment + decision rows only.
    for (const t of ["finance_family_credits", "finance_family_payments", "finance_refund_decisions"]) for (const r of world.sb[t]) Object.assign(r, { owner_type: "household", owner_key: "HH-ZZTEST-1" });
    const f1 = await fam();
    const list = await listFamilyCredits(deps, mgr, {}) as any;
    const p2 = await pay({ amount: "5.00" });
    const ap2 = await apply({ paymentId: p2.body.payment.paymentId });
    const ap3 = await apply({ paymentId: p.body.payment.paymentId });
    const app = world.sb.finance_family_credit_applications[0];
    ck("OW3. All ownership logic follows the OWNER, not the guardian history: after a (simulated) transfer the guardian account no longer sees or spends the credit; the owner group shows it with its history intact", f1.body.creditAvailable === "0.00" && f1.body.credits.length === 0 && list.body.families.length === 1 && list.body.families[0].owner.type === "household" && list.body.families[0].creditAvailable === "25.00" && list.body.families[0].credits[0].applications.length === 1 && ap2.httpStatus === 409 && ap2.code === "insufficient_credit" && ap3.httpStatus === 409 && ap3.code === "cross_family_refused");
    const moved = [{ creditId: "FFC-0000000000AA", familyRecordId: A_REC, ownerType: "household", ownerKey: "HH-ZZTEST-1", createdAt: "2026-03-01T00:00:00.000Z", originalMinor: 900, voidedAt: null }] as any[];
    const byOwner = planApplication({ ownerType: "household", ownerKey: "HH-ZZTEST-1" }, { credits: moved, applications: [] }, 300) as any;
    const byGuardian = planApplication({ ownerType: "guardian_account", ownerKey: A_REC }, { credits: moved, applications: [] }, 300) as any;
    ck("OW3b. Oldest-first selection is scoped by owner (not by the guardian history on the row)", byOwner.ok && byOwner.allocations[0].creditId === "FFC-0000000000AA" && !byGuardian.ok && byGuardian.code === "insufficient_credit");
    ck("OW4. A transfer leaves history untouched: the application keeps its original owner, amount and guardian; the credit keeps its original amount and guardian context", app.owner_type === "guardian_account" && app.owner_key === A_REC && app.amount_minor === 1500 && world.sb.finance_family_credits[0].original_minor === 4000 && world.sb.finance_family_credits[0].family_parent_record_id === A_REC);
  }

  // ===== Z. Code / drift checks =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ck("Z1. finance-family.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(noComments(code("finance-family.ts"))));
    const orch = noComments(code("finance-family-orchestrator.ts"));
    ck("Z2. F11 never calls Stripe directly: no fetch in the orchestrator; Stripe only through F10's GET provider (charge, chargeRefunds)", !/fetch\(/.test(orch) && /s\.p\.charge\(/.test(orch) && /s\.p\.chargeRefunds\(/.test(orch) && !/s\.p\.(?!charge\(|chargeRefunds\()[a-zA-Z]+\(/.test(orch));
    ck("Z3. Reads authorise View, writes Manage via F1 authorizeFinance; writes take the shared Finance write lock", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && /acquireWriteLock/.test(orch));
    const repo = noComments(code("finance-family-repository.ts"));
    ck("Z4. F11 writes ONLY through its finance_family_* database functions (no direct table writes, no Airtable writes, no F7 client credit)", !/method: "(POST|PATCH|DELETE)"[^]*rest\(svc, (PAYMENTS|CREDITS|APPLICATIONS|DECISIONS|SOURCES)_TABLE/.test(repo) && !/airtableFetch|createRow|patchRow|Client Credits|Finance Payments/.test(repo + orch));
    const idx = code("index.ts");
    ck("Z5. index.ts routes F11 first and keeps the TEST Stripe guard", idx.indexOf("matchFamilyRoute(route") < idx.indexOf("matchStripeRoute(route") && /stripe: \{ requireTestMode: true \}/.test(idx));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z6. No F11 code in the 12 Finance modules shared with Needs Attention", shared.every((f) => !/finance-family/.test(code(f))));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z7. Test copies match the canonical finance files (only import paths swapped)", copy("finance-family.ts") && copy("finance-family-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-family-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]) && copy("finance-stripe-provider.ts") && copy("finance-stripe-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    const all = noComments(code("finance-family.ts") + code("finance-family-orchestrator.ts") + code("finance-family-repository.ts"));
    ck("Z8. No refund execution, subscription write, Cash Flow, discount engine or Needs Attention rule in F11", !/executeRefund|createRefund|\/refunds"[^)]*POST|cancelSubscription|cashFlow|siblingDiscount|needs-attention/i.test(all) && !/Josh|sk_live_[A-Za-z0-9]|rk_live_[A-Za-z0-9]/.test(all));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${s === "FAIL" && e ? `  (${e})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
