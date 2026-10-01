/**
 * Stripe READ connector - orchestration (Finance Foundation F10; see
 * TEST-ENV.md "Finance Foundation - F10"). Every route authorises through
 * F1's authorizeFinance() first: View reads, Manage writes.
 *
 * Reads (View): status, subscriptions, one subscription, payments, refunds.
 * Each is a LIVE read from Stripe (no cache) carrying a freshness block
 * (source, account, mode, apiVersion, fetchedAt). Reads write nothing but
 * the connection row's throttled health stamp, and are never audited.
 *
 * Local writes (Manage, audited, under the Finance write lock) - neither
 * touches Stripe:
 *   - POST /stripe/customers/{cus}/parent-link: the explicit Stripe
 *     customer -> Hub parent link (never by name / email);
 *   - POST /stripe/settings: the optional fee estimate for FUTURE charges.
 *
 * There is no route or code path that creates, changes, cancels, retries or
 * refunds anything in Stripe, writes Stripe metadata, creates family
 * credit, or records a Stripe payment as an F7 Finance Payment.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { type Deps, authorizeFinance } from "./orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { acquireWriteLock, insertAuditEvents, releaseWriteLock } from "./finance-commercial-repository.ts";
import {
  type CustomerLink,
  type FeeEstimate,
  type HubParent,
  type StripeConnection,
  ENTITY_CONNECTION,
  ENTITY_CUSTOMER_LINK,
  STRIPE_CONTRACT,
  STRIPE_EVENTS,
  collectionOfInvoice,
  connectionProblems,
  customerMapping,
  keyModeOf,
  localMidnightEpoch,
  money,
  currencyOf,
  paymentFromCharge,
  paymentSummary,
  publicConfig,
  publicConnection,
  refundView,
  sourceOf,
  stateCounts,
  stripeAuditEvent,
  subscriptionState,
  subscriptionView,
  windowOf,
} from "./finance-stripe.ts";
import { type ProviderFail, type StripeReadProvider, baseUrlFor, httpStripeProvider } from "./finance-stripe-provider.ts";
import { deleteCustomerLink, insertCustomerLink, loadCustomerLinks, loadHubParents, loadStripeConnection, readStripeSecret, recordStripeOutcome, saveStripeConfig } from "./finance-stripe-repository.ts";

export interface StripeDeps extends Deps {
  clock?: () => Date;
  stripe?: {
    /** TEST deployment guard: only a test-mode key / account may be read (never live). Default true. */
    requireTestMode?: boolean;
    timeoutMs?: number;
    pageLimit?: number;
    maxPages?: number;
    baseUrl?: (endpoint: StripeConnection["endpoint"]) => string;
  };
}

export type SFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 502 | 503; code: string; error: string; fields?: Record<string, string>; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: SFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): SFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is SFail => !!x && typeof x === "object" && (x as any).status === "error";

const now = (deps: StripeDeps) => (deps.clock ?? (() => new Date()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const requireTest = (deps: StripeDeps) => deps.stripe?.requireTestMode ?? true;
const unavailable = () => fail(503, "finance_stripe_unavailable", "The Stripe connection details could not be loaded just now - try again");

/** A provider failure in Management's words (codes stay machine-readable). */
export function providerFailure(f: ProviderFail, doing: string): SFail {
  switch (f.kind) {
    case "unauthorised":
      return fail(409, "stripe_connection_rejected", `Stripe no longer accepts this organisation's key while ${doing} - it needs reconnecting`);
    case "forbidden":
      return fail(409, "stripe_permission_missing", `The Stripe key is not allowed to read this (${doing}) - give the restricted key read access`);
    case "rate_limited":
      return fail(503, "stripe_rate_limited", `Stripe is busy (rate limit) while ${doing} - try again in a minute`);
    case "live_data":
      return fail(409, "stripe_live_mode_refused", `Stripe returned LIVE-mode data while ${doing}. This TEST Hub only reads test mode - nothing was shown`);
    case "too_many":
      return fail(409, "stripe_too_many_results", `${f.message} (${doing})`);
    case "page_failed":
      return fail(502, "stripe_pagination_failed", `${f.message} (${doing})`);
    case "malformed":
      return fail(502, "stripe_response_invalid", `Stripe answered in a way the Hub could not read while ${doing} - try again`);
    case "not_found":
      return fail(404, "stripe_not_found", `Stripe has no such record (${doing})`);
    case "rejected":
      return fail(409, "stripe_rejected", `Stripe refused the read while ${doing}: ${f.message}`);
    default:
      return fail(503, "stripe_unavailable", `Stripe did not respond while ${doing} - try again in a moment`);
  }
}

export type StripeSession = { org: OrganisationContext; access: string; conn: StripeConnection; p: StripeReadProvider };

/** Authorise, load the connection, apply the TEST guards, open the provider. No Stripe call yet. */
export async function openStripeSession(deps: StripeDeps, caller: FinanceCaller, level: "read" | "manage"): Promise<StripeSession | SFail> {
  const auth = await authorizeFinance(deps, caller, level);
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let conn: StripeConnection | null;
  let secret: string | null = null;
  try {
    conn = await loadStripeConnection(deps.grants, org.organisationId);
    const problems = connectionProblems(conn, requireTest(deps));
    if (problems.length) return fail(409, problems[0].code, problems[0].message);
    secret = await readStripeSecret(deps.grants, org.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!conn || !secret) return fail(409, "stripe_not_connected", "Stripe is not connected for this organisation");
  const keyMode = keyModeOf(secret);
  if (keyMode !== conn.mode || (requireTest(deps) && keyMode !== "test")) return fail(409, "stripe_live_mode_refused", "The stored Stripe key is not a test-mode key for this TEST Hub (or does not match the connection's mode) - nothing was read");
  const p = httpStripeProvider({ baseUrl: deps.stripe?.baseUrl ? deps.stripe.baseUrl(conn.endpoint) : baseUrlFor(conn.endpoint, deps.grants.supabaseUrl), secretKey: secret, requireTestMode: requireTest(deps), timeoutMs: deps.stripe?.timeoutMs, pageLimit: deps.stripe?.pageLimit, maxPages: deps.stripe?.maxPages });
  return { org, access: auth.access, conn, p };
}

/** Throttled health stamp after a Stripe read (never a new row, never audited, never fails the read). */
export async function recordStripeHealth(deps: StripeDeps, s: StripeSession, at: string, f: SFail | null) {
  try {
    if (f) await recordStripeOutcome(deps.grants, s.conn, { ok: false, at, code: f.code, message: f.error });
    else await recordStripeOutcome(deps.grants, s.conn, { ok: true, at });
  } catch (e) {
    console.error("Stripe health bookkeeping failed", e);
  }
}

async function hubMapping(deps: StripeDeps, org: OrganisationContext): Promise<{ links: CustomerLink[]; parents: Map<string, HubParent> } | SFail> {
  try {
    const [links, parents] = await Promise.all([loadCustomerLinks(deps.grants, org.organisationId), loadHubParents(deps.airtable)]);
    return { links, parents };
  } catch (e) {
    console.error(e);
    return fail(503, "finance_stripe_unavailable", "The Hub's customer links could not be loaded just now - try again");
  }
}

const head = (s: StripeSession, fetchedAt: string) => ({ contract: STRIPE_CONTRACT, organisation: orgBody(s.org), access: s.access, source: sourceOf(s.conn, fetchedAt) });

// ---------------------------------------------------------------------
// GET /stripe/status[?check=1]
// ---------------------------------------------------------------------

export async function readStripeStatus(deps: StripeDeps, caller: FinanceCaller, check: boolean): Promise<Ok | SFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let conn: StripeConnection | null;
  try {
    conn = await loadStripeConnection(deps.grants, org.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const problems = connectionProblems(conn, requireTest(deps));
  const body: Record<string, unknown> = {
    contract: STRIPE_CONTRACT,
    organisation: orgBody(org),
    access: auth.access,
    connection: publicConnection(conn),
    settings: conn ? publicConfig(conn.config) : null,
    readiness: { ready: problems.length === 0, problems },
    readOnly: true,
  };
  if (!check) return { status: "ok", httpStatus: 200, body };
  if (problems.length) return { status: "ok", httpStatus: 200, body: { ...body, check: { ran: false, reason: problems[0].code } } };
  const s = await openStripeSession(deps, caller, "read");
  if (isFail(s)) return s.code === "stripe_live_mode_refused" || s.code === "stripe_not_connected" ? { status: "ok", httpStatus: 200, body: { ...body, check: { ran: false, reason: s.code, message: s.error } } } : s;
  const at = now(deps).toISOString();
  const a = await s.p.account();
  let result: Record<string, unknown>;
  if (!a.ok) {
    const f = providerFailure(a, "checking the Stripe account");
    await recordStripeHealth(deps, s, at, f);
    result = { ran: true, ok: false, at, error: { code: f.code, message: f.error }, calls: s.p.callLog().length };
  } else {
    const id = String(a.value.id);
    const name = typeof a.value.settings?.dashboard?.display_name === "string" ? a.value.settings.dashboard.display_name : typeof a.value.business_profile?.name === "string" ? a.value.business_profile.name : null;
    if (s.conn.accountId && s.conn.accountId !== id) {
      const f = fail(409, "stripe_account_changed", "The key now reaches a different Stripe account than the one recorded - reconnect it deliberately");
      await recordStripeHealth(deps, s, at, f);
      result = { ran: true, ok: false, at, error: { code: f.code, message: f.error }, calls: s.p.callLog().length };
    } else {
      try {
        await recordStripeOutcome(deps.grants, s.conn, { ok: true, at, ...(s.conn.accountId ? {} : { account: { id, name } }) });
      } catch (e) {
        console.error("Stripe health bookkeeping failed", e);
      }
      result = { ran: true, ok: true, at, account: { accountId: id, name }, mode: s.conn.mode, endpoint: s.conn.endpoint, apiVersion: sourceOf(s.conn, at).apiVersion, calls: s.p.callLog().length };
    }
  }
  return { status: "ok", httpStatus: 200, body: { ...body, check: result } };
}

// ---------------------------------------------------------------------
// GET /stripe/subscriptions[?customer=cus_...]
// ---------------------------------------------------------------------

export async function listStripeSubscriptions(deps: StripeDeps, caller: FinanceCaller, q: { customer?: string }): Promise<Ok | SFail> {
  const s = await openStripeSession(deps, caller, "read");
  if (isFail(s)) return s;
  const hub = await hubMapping(deps, s.org);
  if (isFail(hub)) return hub;
  const at = now(deps).toISOString();
  const r = await s.p.listSubscriptions({ customer: q.customer });
  if (!r.ok) {
    const f = providerFailure(r, "listing subscriptions");
    await recordStripeHealth(deps, s, at, f);
    return f;
  }
  await recordStripeHealth(deps, s, at, null);
  const views = r.value.map((sub) => subscriptionView(sub, { tz: s.org.timezone, fee: s.conn.config.feeEstimate, links: hub.links, parents: hub.parents }));
  const customers = [...new Set(views.map((v) => v.customer.customerId).filter(Boolean))] as string[];
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(s, at),
      summary: {
        subscriptions: views.length,
        byState: stateCounts(views),
        customers: customers.length,
        customersLinkedToHubParents: customers.filter((c) => hub.links.some((l) => l.customerId === c)).length,
        playerAllocation: "unresolved",
        serviceAllocation: "unresolved",
        pagesRead: s.p.callLog().length,
      },
      subscriptions: views,
    },
  };
}

// ---------------------------------------------------------------------
// GET /stripe/subscriptions/{sub_...}
// ---------------------------------------------------------------------

export async function readStripeSubscription(deps: StripeDeps, caller: FinanceCaller, subscriptionId: string): Promise<Ok | SFail> {
  const s = await openStripeSession(deps, caller, "read");
  if (isFail(s)) return s;
  const hub = await hubMapping(deps, s.org);
  if (isFail(hub)) return hub;
  const at = now(deps).toISOString();
  const r = await s.p.subscription(subscriptionId);
  if (!r.ok) {
    const f = providerFailure(r, "reading the subscription");
    await recordStripeHealth(deps, s, at, f);
    return f;
  }
  if (!r.value) {
    await recordStripeHealth(deps, s, at, null);
    return fail(404, "stripe_subscription_not_found", `Stripe has no subscription ${subscriptionId} in this account`);
  }
  const sub = r.value;
  const st = subscriptionState(sub);
  const inv = await s.p.subscriptionInvoices(subscriptionId, 12);
  if (!inv.ok) {
    const f = providerFailure(inv, "reading the subscription's invoices");
    await recordStripeHealth(deps, s, at, f);
    return f;
  }
  let upcoming: Record<string, any> | null = null;
  if (st.state === "active" || st.state === "trialling") {
    const u = await s.p.upcomingInvoice(subscriptionId);
    if (!u.ok) {
      const f = providerFailure(u, "reading Stripe's upcoming invoice");
      await recordStripeHealth(deps, s, at, f);
      return f;
    }
    upcoming = u.value;
  }
  await recordStripeHealth(deps, s, at, null);
  const view = subscriptionView(sub, { tz: s.org.timezone, fee: s.conn.config.feeEstimate, links: hub.links, parents: hub.parents, upcoming });
  const recent = inv.value.map((i) => collectionOfInvoice(i, s.org.timezone)).filter(Boolean) as NonNullable<ReturnType<typeof collectionOfInvoice>>[];
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(s, at),
      subscription: view,
      lastSuccessfulPayment: recent.find((c) => c.outcome === "succeeded") ?? null,
      recentCollections: recent,
      upcomingInvoice: upcoming ? { amountDue: money(upcoming.amount_due, currencyOf(upcoming.currency)), currency: currencyOf(upcoming.currency), source: "stripe_upcoming_invoice_preview", actualRevenue: false } : null,
    },
  };
}

// ---------------------------------------------------------------------
// GET /stripe/payments + /stripe/refunds (bounded local-date window)
// ---------------------------------------------------------------------

function epochWindow(org: OrganisationContext, from: string, to: string) {
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { gte: localMidnightEpoch(from, org.timezone), lte: localMidnightEpoch(next, org.timezone) - 1 };
}

export async function listStripePayments(deps: StripeDeps, caller: FinanceCaller, q: { from?: string; to?: string; customer?: string }): Promise<Ok | SFail> {
  const s = await openStripeSession(deps, caller, "read");
  if (isFail(s)) return s;
  const w = windowOf(q.from, q.to, todayIn(s.org.timezone, now(deps)));
  if (!w.ok) return { status: "error", httpStatus: 400, code: w.code, error: w.error };
  const hub = await hubMapping(deps, s.org);
  if (isFail(hub)) return hub;
  const at = now(deps).toISOString();
  const r = await s.p.listCharges({ ...epochWindow(s.org, w.from, w.to), customer: q.customer });
  if (!r.ok) {
    const f = providerFailure(r, "listing payments");
    await recordStripeHealth(deps, s, at, f);
    return f;
  }
  await recordStripeHealth(deps, s, at, null);
  const payments = r.value.map((ch) => {
    const p = paymentFromCharge(ch, s.org.timezone);
    const cm = customerMapping(p.customerId, hub.links, hub.parents);
    return { ...p, parent: cm.state === "linked" ? { parentId: cm.parent!.parentId, name: cm.parent!.name } : null, customerMapping: cm.state };
  });
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(s, at),
      window: { from: w.from, to: w.to, timezone: s.org.timezone },
      /** Only receipt:true rows are Actual money; this is never an F7 Finance Payment. */
      receiptRule: "receipt = Stripe charge succeeded; fee / net from Stripe's balance transaction only",
      summary: paymentSummary(payments, r.value),
      payments,
    },
  };
}

export async function listStripeRefunds(deps: StripeDeps, caller: FinanceCaller, q: { from?: string; to?: string }): Promise<Ok | SFail> {
  const s = await openStripeSession(deps, caller, "read");
  if (isFail(s)) return s;
  const w = windowOf(q.from, q.to, todayIn(s.org.timezone, now(deps)));
  if (!w.ok) return { status: "error", httpStatus: 400, code: w.code, error: w.error };
  const at = now(deps).toISOString();
  const r = await s.p.listRefunds(epochWindow(s.org, w.from, w.to));
  if (!r.ok) {
    const f = providerFailure(r, "listing refunds");
    await recordStripeHealth(deps, s, at, f);
    return f;
  }
  await recordStripeHealth(deps, s, at, null);
  const refunds = r.value.map((re) => refundView(re, s.org.timezone));
  const by: Record<string, { count: number; succeededMinor: number; pending: number; failedOrCanceled: number }> = {};
  r.value.forEach((re, i) => {
    const cur = refunds[i].currency ?? "UNKNOWN";
    const b = (by[cur] ??= { count: 0, succeededMinor: 0, pending: 0, failedOrCanceled: 0 });
    b.count++;
    if (re.status === "succeeded" && Number.isInteger(re.amount)) b.succeededMinor += re.amount;
    else if (re.status === "pending" || re.status === "requires_action") b.pending++;
    else b.failedOrCanceled++;
  });
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(s, at),
      window: { from: w.from, to: w.to, timezone: s.org.timezone },
      readOnly: "The Hub never initiates a refund and never turns a refund into family credit (F11 / F21)",
      summary: Object.fromEntries(Object.entries(by).map(([c, b]) => [c, { refunds: b.count, refundedSucceeded: money(b.succeededMinor, c), pending: b.pending, failedOrCanceled: b.failedOrCanceled }])),
      refunds,
    },
  };
}

// ---------------------------------------------------------------------
// Local writes (Manage, audited, Finance write lock) - neither touches Stripe
// ---------------------------------------------------------------------

async function withLock(deps: StripeDeps, caller: FinanceCaller, run: (org: OrganisationContext) => Promise<Ok | SFail>): Promise<Ok | SFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_stripe_unavailable", "The change could not be made just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    return await run(org);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_stripe_unavailable", "The change could not be completed just now - try again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

/** POST /stripe/customers/{cus}/parent-link - Management links ONE Stripe customer to ONE Hub parent, explicitly. */
export function linkStripeCustomer(deps: StripeDeps, caller: FinanceCaller, customerId: string, parentId: string, reason: string): Promise<Ok | SFail> {
  return withLock(deps, caller, async (org) => {
    const parents = [...(await loadHubParents(deps.airtable)).values()].filter((p) => p.parentId === parentId);
    if (!parents.length) return fail(404, "parent_not_found", `No Hub parent has Parent ID ${parentId}`);
    if (parents.length > 1) return fail(409, "parent_id_ambiguous", `${parents.length} Hub parent records carry Parent ID ${parentId} - the Hub will not guess which one; fix the duplicate first`, { parentRecordIds: parents.map((p) => p.recordId) });
    const parent = parents[0];
    if (!parent.active) return fail(409, "parent_inactive", `Hub parent ${parentId} is not active`);
    const existing = (await loadCustomerLinks(deps.grants, org.organisationId)).find((l) => l.customerId === customerId);
    if (existing) {
      if (existing.parentRecordId === parent.recordId) return { status: "ok", httpStatus: 200, body: { contract: STRIPE_CONTRACT, organisation: orgBody(org), access: "manage", changed: false, link: { customerId, parentId, method: existing.method, linkedAt: existing.linkedAt } } };
      return fail(409, "stripe_customer_linked_elsewhere", `Stripe customer ${customerId} is already linked to Hub parent ${existing.parentId} - one Stripe customer never belongs to two parents`);
    }
    // Confirm the customer exists in THIS Stripe account (read-only) before storing a link to it.
    const s = await openStripeSession(deps, caller, "manage");
    if (isFail(s)) return s;
    const at = now(deps).toISOString();
    const c = await s.p.customer(customerId);
    if (!c.ok) {
      const f = providerFailure(c, "reading the Stripe customer");
      await recordStripeHealth(deps, s, at, f);
      return f;
    }
    await recordStripeHealth(deps, s, at, null);
    if (!c.value || c.value.deleted === true) return fail(404, "stripe_customer_not_found", `Stripe has no (undeleted) customer ${customerId} in this account`);
    const link: CustomerLink = { organisationId: org.organisationId, customerId, parentId, parentRecordId: parent.recordId, method: "linked_by_manager", linkedAt: at, linkedBy: caller.userId };
    if ((await insertCustomerLink(deps.grants, link)) === "conflict") return fail(409, "stripe_customer_linked_elsewhere", "This Stripe customer was linked by someone else just now - reload and try again");
    try {
      await insertAuditEvents(deps.grants, [
        stripeAuditEvent({
          organisationId: org.organisationId,
          actorUserId: caller.userId,
          eventType: STRIPE_EVENTS.customerLinked,
          entityType: ENTITY_CUSTOMER_LINK,
          recordId: `${org.organisationId}:${customerId}`,
          before: null,
          after: { customerId, parentId, parentRecordId: parent.recordId, method: link.method },
          reason,
          route: `POST /stripe/customers/${customerId}/parent-link`,
          context: { stripeAccountId: s.conn.accountId, mode: s.conn.mode, endpoint: s.conn.endpoint },
        }),
      ]);
    } catch (e) {
      console.error(e);
      try {
        await deleteCustomerLink(deps.grants, org.organisationId, customerId);
      } catch (e2) {
        console.error(e2);
        return fail(500, "finance_stripe_unaudited", "The link was saved but could not be recorded or undone - contact support");
      }
      return fail(503, "finance_audit_unavailable", "The link could not be saved just now (it could not be recorded) - nothing was changed");
    }
    return {
      status: "ok",
      httpStatus: 201,
      body: { contract: STRIPE_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, link: { customerId, parentId, parentName: parent.name, method: link.method, linkedAt: at, playerAllocation: "unresolved" } },
    };
  });
}

/** POST /stripe/settings - the optional fee estimate for FUTURE charges (never applied to completed ones). Audited; no change = no write. */
export function updateStripeSettings(deps: StripeDeps, caller: FinanceCaller, change: { feeEstimate: FeeEstimate | null; reason: string | null }): Promise<Ok | SFail> {
  return withLock(deps, caller, async (org) => {
    const conn = await loadStripeConnection(deps.grants, org.organisationId);
    if (!conn) return fail(409, "stripe_not_connected", "Stripe is not connected for this organisation - connect it before choosing its settings");
    const before = publicConfig(conn.config);
    if (JSON.stringify(conn.config.feeEstimate) === JSON.stringify(change.feeEstimate)) return { status: "ok", httpStatus: 200, body: { contract: STRIPE_CONTRACT, organisation: orgBody(org), access: "manage", changed: false, settings: before } };
    const at = now(deps).toISOString();
    if (!(await saveStripeConfig(deps.grants, org.organisationId, conn.config.revision, { feeEstimate: change.feeEstimate, at, by: caller.userId }))) return fail(409, "finance_commercial_busy", "The Stripe settings were changed by someone else just now - reload and try again");
    const after = { feeEstimate: change.feeEstimate, revision: conn.config.revision + 1, updatedAt: at };
    try {
      await insertAuditEvents(deps.grants, [stripeAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: STRIPE_EVENTS.settingsUpdated, entityType: ENTITY_CONNECTION, recordId: `${org.organisationId}:stripe`, before, after, reason: change.reason, route: "POST /stripe/settings" })]);
    } catch (e) {
      console.error(e);
      const undone = await saveStripeConfig(deps.grants, org.organisationId, conn.config.revision + 1, { feeEstimate: conn.config.feeEstimate, at, by: caller.userId }).catch(() => false);
      return undone ? fail(503, "finance_audit_unavailable", "The Stripe settings could not be saved just now (they could not be recorded) - nothing was changed") : fail(500, "finance_stripe_unaudited", "The Stripe settings were saved but could not be recorded or undone - contact support");
    }
    return { status: "ok", httpStatus: 200, body: { contract: STRIPE_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, settings: after } };
  });
}
