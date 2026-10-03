/**
 * Test-suite copy of the canonical finance/finance-stripe-refunds-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts; ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Stripe refund EXECUTION - orchestration (Finance Foundation F21; see
 * TEST-ENV.md "Finance Foundation - F21"). Every route authorises through F1's
 * authorizeFinance() first: View reads, Manage writes. The organisation is the
 * caller's; no request field can choose a tenant, an amount, a currency, a
 * Stripe payment or a funding split.
 *
 *   POST /refund-decisions/{FRD}/execute              (Manage) refund the decision's card part in Stripe
 *   POST /refund-decisions/{FRD}/execution/reconcile  (Manage) ask Stripe what happened (no webhook)
 *   GET  /refund-decisions/{FRD}/execution            (View)   the Hub's record (no Stripe call, never audited)
 *
 * Execute, under the shared Finance write lock (commercial:{org}) for the
 * whole call:
 *   1. the F11 decision is eligible (Refund Due / refund_failed, card part > 0,
 *      not reversed, nothing in flight, not already refunded);
 *   2. Stripe is connected (else 409, the decision is untouched);
 *   3. RESERVE (one database transaction): the execution row with its stable
 *      Idempotency-Key, decision -> refund_processing, audit - BEFORE Stripe;
 *   4. pre-flight reads: the charge (same customer, succeeded, GBP, not
 *      disputed, enough left) and its refunds (an earlier live refund for this
 *      decision is ADOPTED, never duplicated);
 *   5. POST /v1/refunds (amount = the decision's card part, verbatim);
 *   6. an ambiguous answer is reconciled at once through the charge's refund
 *      list (by hub_execution_id), else left outcome_unknown;
 *   7. RECORD (one database transaction): Stripe's answer, mirrored onto the
 *      decision, audit.
 * Only Stripe's "succeeded" makes the refund succeeded. Family credit is
 * never touched (F11 created it when it decided).
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import { connectionProblems, keyModeOf } from "./finance-stripe.ts";
import { type ProviderFail, type StripeReadProvider, baseUrlFor, httpStripeProvider } from "./finance-stripe-provider.ts";
import { loadStripeConnection, readStripeSecret } from "./finance-stripe-repository.ts";
import type { StripeDeps } from "./finance-stripe-orchestrator.ts";
import { type StripeRefundProvider, httpStripeRefundProvider } from "./finance-stripe-refund-provider.ts";
import {
  type DecisionForExecution,
  type Outcome,
  type RefundExecution,
  type StripeRefundObj,
  FAIL_HTTP,
  REFUND_EVENTS,
  REFUND_EXECUTION_CONTRACT,
  REFUND_REASON,
  chargeFromStripe,
  decisionExecutionView,
  eventFor,
  executionRefusal,
  executionView,
  findExecutionRefund,
  findLiveDecisionRefund,
  idempotencyKeyOf,
  latestOf,
  m,
  metadataOf,
  newExecutionId,
  outcomeFacts,
  outcomeOfCreateFailure,
  outcomeOfMismatch,
  outcomeOfPreflightFailure,
  outcomeOfRefund,
  preflight,
  refundAudit,
  refundFromStripe,
  refundMismatch,
  resultRow,
} from "./finance-stripe-refunds.ts";
import { ExecutionRefusal, loadDecision, loadExecutions, loadRefundCapability, recordExecution, reserveExecution } from "./finance-stripe-refunds-repository.ts";

export interface RefundExecDeps extends StripeDeps {
  refunds?: { random?: () => string };
}
export type RFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 502 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201 | 202; body: Record<string, unknown> };
const fail = (httpStatus: RFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): RFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is RFail => !!x && typeof x === "object" && (x as any).status === "error";

const now = (deps: RefundExecDeps) => (deps.clock ?? (() => new Date()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const requireTest = (deps: RefundExecDeps) => deps.stripe?.requireTestMode ?? true;
const unavailable = () => fail(503, "finance_refund_unavailable", "Refund execution details could not be loaded just now - try again");
const ROUTE = { execute: "POST /refund-decisions/{id}/execute", reconcile: "POST /refund-decisions/{id}/execution/reconcile" };

/** Database rule refusals in Management's words (nothing was changed). */
const REFUSAL_MESSAGES: Record<string, [409 | 404, string]> = {
  decision_not_found: [404, "No such refund decision"],
  decision_reversed: [409, "This refund decision was reversed - there is nothing to refund"],
  no_card_refund: [409, "This decision has no card refund - nothing is sent to Stripe"],
  already_refunded: [409, "This card refund has already been made in Stripe - it cannot be sent again"],
  execution_in_progress: [409, "This card refund is already being executed - reconcile it with Stripe instead of sending it again"],
  not_executable: [409, "This decision is not awaiting a card refund"],
  decision_mismatch: [409, "The decision changed while the refund was being prepared - nothing was sent"],
  version_changed: [409, "Someone else started this refund just now - nothing was sent; check its status"],
  execution_changed: [409, "This refund's record was changed by someone else just now - check its status"],
  execution_closed: [409, "This refund's outcome is already final"],
  decision_state_changed: [409, "The decision's refund state changed unexpectedly - check its status"],
  refund_id_conflict: [409, "Stripe reported a different refund for this execution - it needs investigation; nothing was changed"],
};
function refusalFail(e: unknown): RFail | null {
  if (e instanceof ExecutionRefusal) {
    const [status, msg] = REFUSAL_MESSAGES[e.code] ?? [409, "The change was refused by the refund ledger's rules - nothing was changed"];
    return fail(status, e.code === "execution_in_progress" ? "refund_execution_in_progress" : e.code, msg);
  }
  return null;
}

type Session = { conn: { endpoint: "stripe" | "sandbox"; mode: string }; read: StripeReadProvider; write: StripeRefundProvider };

/** The ONE organisation Stripe connection (locked decision D2), opened for a refund: F10's TEST guards, F10's GET provider + the refund provider. */
async function openRefundSession(deps: RefundExecDeps, org: OrganisationContext): Promise<Session | RFail> {
  let conn;
  let secret: string | null = null;
  try {
    conn = await loadStripeConnection(deps.grants, org.organisationId);
    const problems = connectionProblems(conn, requireTest(deps));
    if (problems.length) return fail(409, problems[0].code, problems[0].code === "stripe_not_connected" ? "Stripe is not connected for this organisation - the refund cannot be executed now; the decision stays Refund Due" : problems[0].message);
    secret = await readStripeSecret(deps.grants, org.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!conn || !secret) return fail(409, "stripe_not_connected", "Stripe is not connected for this organisation - the refund cannot be executed now; the decision stays Refund Due");
  const keyMode = keyModeOf(secret);
  if (keyMode !== conn.mode || (requireTest(deps) && keyMode !== "test")) return fail(409, "stripe_live_mode_refused", "The stored Stripe key is not a test-mode key for this TEST Hub - nothing was sent");
  const baseUrl = deps.stripe?.baseUrl ? deps.stripe.baseUrl(conn.endpoint) : baseUrlFor(conn.endpoint, deps.grants.supabaseUrl);
  return {
    conn,
    read: httpStripeProvider({ baseUrl, secretKey: secret, requireTestMode: requireTest(deps), timeoutMs: deps.stripe?.timeoutMs, pageLimit: deps.stripe?.pageLimit, maxPages: deps.stripe?.maxPages }),
    write: httpStripeRefundProvider({ baseUrl, secretKey: secret, requireTestMode: requireTest(deps), timeoutMs: deps.stripe?.timeoutMs }),
  };
}

type Ctx = { org: OrganisationContext; access: string; decision: DecisionForExecution; executions: RefundExecution[] };

async function loadCtx(deps: RefundExecDeps, org: OrganisationContext, access: string, decisionId: string): Promise<Ctx | RFail> {
  try {
    const decision = await loadDecision(deps.grants, org.organisationId, decisionId);
    if (!decision) return fail(404, "refund_decision_not_found", `No refund decision ${decisionId} in this organisation`);
    const executions = await loadExecutions(deps.grants, org.organisationId, decisionId);
    return { org, access, decision, executions };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}

async function withLock(deps: RefundExecDeps, caller: FinanceCaller, decisionId: string, run: (ctx: Ctx) => Promise<Ok | RFail>): Promise<Ok | RFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_refund_unavailable", "The refund could not be started just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now (another refund may be in progress) - try again in a moment");
  try {
    const ctx = await loadCtx(deps, org, auth.access, decisionId);
    if (isFail(ctx)) return ctx;
    return await run(ctx);
  } catch (e) {
    const rf = refusalFail(e);
    if (rf) return rf;
    console.error(e);
    return fail(503, "finance_refund_unavailable", "The refund could not be completed just now - check its status before trying again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

const head = (ctx: Pick<Ctx, "org" | "access">) => ({ contract: REFUND_EXECUTION_CONTRACT, organisation: orgBody(ctx.org), access: ctx.access });

/** Stripe's refunds on the charge, as F21 reads them (unparseable objects are a provider error, never ignored). */
async function chargeRefunds(s: Session, chargeId: string): Promise<{ ok: true; refunds: StripeRefundObj[] } | { ok: false; fail: ProviderFail | { kind: "malformed"; status: null; message: string; stripeCode: null } }> {
  const r = await s.read.chargeRefunds(chargeId);
  if (!r.ok) return { ok: false, fail: r };
  const out: StripeRefundObj[] = [];
  for (const o of r.value) {
    const x = refundFromStripe(o);
    if (!x) return { ok: false, fail: { kind: "malformed", status: null, message: "Stripe returned a refund the Hub could not read", stripeCode: null } };
    out.push(x);
  }
  return { ok: true, refunds: out };
}

/** POST the refund (same Idempotency-Key every time for this execution) and turn Stripe's answer into an outcome; an ambiguous answer is reconciled at once through the charge's refund list. */
async function sendRefund(s: Session, x: RefundExecution): Promise<Outcome> {
  const r = await s.write.createRefund({ chargeId: x.stripeChargeId, amountMinor: x.amountMinor, reason: REFUND_REASON, metadata: metadataOf(x.organisationId, x.decisionId, x.executionId) }, x.idempotencyKey);
  if (r.ok) {
    const obj = refundFromStripe(r.value);
    if (!obj) return outcomeOfCreateFailure({ kind: "malformed", status: null, message: "unreadable refund", stripeCode: null });
    const mis = refundMismatch(obj, x);
    if (mis) return outcomeOfMismatch(mis);
    if (obj.metadata.hub_execution_id !== x.executionId) return outcomeOfMismatch(`Stripe refund ${obj.id} carries another Hub execution id`);
    return outcomeOfRefund(obj);
  }
  const o = outcomeOfCreateFailure(r);
  if (o.status !== "outcome_unknown") return o;
  // Layer 2: did Stripe create it anyway? Look for this execution's refund on the charge.
  const list = await chargeRefunds(s, x.stripeChargeId);
  if (!list.ok) return o;
  const found = findExecutionRefund(list.refunds, x);
  if (!found) return o;
  const mis = refundMismatch(found, x);
  return mis ? outcomeOfMismatch(mis) : outcomeOfRefund(found);
}

async function record(deps: RefundExecDeps, caller: FinanceCaller, ctx: Ctx, x: RefundExecution, o: Outcome, flags: { attempted: boolean; checked: boolean }, reason: string | null, route: string, extraEvents: Record<string, unknown>[] = []): Promise<RefundExecution> {
  const at = now(deps).toISOString();
  const refundId = o.refund?.id ?? x.stripeRefundId;
  const before = { status: x.status, providerStatus: x.providerStatus, stripeRefundId: x.stripeRefundId };
  const ev = [
    ...extraEvents,
    refundAudit({ organisationId: ctx.org.organisationId, actorUserId: caller.userId, eventType: eventFor(o), execution: x, before, after: outcomeFacts(x, o, refundId), reason, route }),
  ];
  return recordExecution(deps.grants, ctx.org.organisationId, x.executionId, x.status, resultRow(o, x, at, caller.userId, flags), ev);
}

function respond(ctx: Ctx, x: RefundExecution, extra: Record<string, unknown> = {}): Ok | RFail {
  const tz = ctx.org.timezone;
  const view = executionView(x, tz);
  if (x.status === "failed" && x.failureKind) {
    const h = FAIL_HTTP[x.failureKind];
    return fail(h.httpStatus, h.code, x.failureMessage ?? "The card refund was not made", { execution: view, decisionRefundState: x.stripeRefundId ? "refund_failed" : "awaiting_refund_action", ...extra });
  }
  const httpStatus = x.status === "succeeded" ? 200 : 202;
  return { status: "ok", httpStatus, body: { ...head(ctx), decisionId: x.decisionId, execution: view, ...extra } };
}

// ---------------------------------------------------------------------
// Execute (Manage)
// ---------------------------------------------------------------------
export async function executeRefund(deps: RefundExecDeps, caller: FinanceCaller, decisionId: string, reason: string | null): Promise<Ok | RFail> {
  return withLock(deps, caller, decisionId, async (ctx) => {
    const d = ctx.decision;
    const refusal = executionRefusal(d, ctx.executions);
    if (refusal) return fail(refusal.httpStatus, refusal.code, refusal.error);
    const s = await openRefundSession(deps, ctx.org);
    if (isFail(s)) return s;
    // RESERVE before Stripe: the stable key is committed first.
    const version = (latestOf(ctx.executions)?.version ?? 0) + 1;
    const executionId = newExecutionId(deps.refunds?.random);
    const startedAt = now(deps).toISOString();
    const draft = { organisationId: ctx.org.organisationId, executionId, decisionId: d.decisionId, version, amountMinor: d.cardRefundMinor, stripeChargeId: d.stripeChargeId!, currency: "GBP" as const, idempotencyKey: idempotencyKeyOf(ctx.org.organisationId, d.decisionId, version), startedAt, startedBy: caller.userId };
    const started = refundAudit({
      organisationId: ctx.org.organisationId,
      actorUserId: caller.userId,
      eventType: REFUND_EVENTS.started,
      execution: draft,
      before: { refundState: d.refundState },
      after: { decisionId: d.decisionId, executionId, version, amount: m(d.cardRefundMinor), currency: "GBP", stripeChargeId: d.stripeChargeId, idempotencyKey: draft.idempotencyKey, refundState: "refund_processing", amountSource: "F11 decision card_refund_minor (verbatim)" },
      reason,
      route: ROUTE.execute,
    });
    const x = await reserveExecution(deps.grants, draft, [started]);
    // Pre-flight (nothing sent yet).
    const c = await s.read.charge(x.stripeChargeId);
    if (!c.ok) return respond(ctx, await record(deps, caller, ctx, x, outcomeOfPreflightFailure(c), { attempted: false, checked: false }, reason, ROUTE.execute));
    if (!c.value) return respond(ctx, await record(deps, caller, ctx, x, { ...outcomeOfPreflightFailure({ kind: "not_found", status: 404, message: "", stripeCode: null }), failureKind: "charge_missing", failureCode: "resource_missing", failureMessage: "Stripe has no such payment - nothing was sent" }, { attempted: false, checked: false }, reason, ROUTE.execute));
    const list = await chargeRefunds(s, x.stripeChargeId);
    if (!list.ok) return respond(ctx, await record(deps, caller, ctx, x, outcomeOfPreflightFailure(list.fail), { attempted: false, checked: false }, reason, ROUTE.execute));
    const existing = findLiveDecisionRefund(list.refunds, x.organisationId, x.decisionId);
    if (existing) {
      // An earlier execution's refund already exists in Stripe: adopt it, never send a second one.
      const mis = refundMismatch(existing, x);
      const o = mis ? outcomeOfMismatch(mis) : outcomeOfRefund(existing);
      return respond(ctx, await record(deps, caller, ctx, x, o, { attempted: false, checked: true }, reason, ROUTE.execute), { adoptedExistingStripeRefund: !mis });
    }
    const pre = preflight(chargeFromStripe(c.value), d, x.amountMinor);
    if (pre) return respond(ctx, await record(deps, caller, ctx, x, pre, { attempted: false, checked: false }, reason, ROUTE.execute));
    // The one write.
    const o = await sendRefund(s, x);
    return respond(ctx, await record(deps, caller, ctx, x, o, { attempted: false, checked: false }, reason, ROUTE.execute));
  });
}

// ---------------------------------------------------------------------
// Reconcile (Manage) - pull Stripe's truth; no webhook
// ---------------------------------------------------------------------
export async function reconcileRefund(deps: RefundExecDeps, caller: FinanceCaller, decisionId: string, reason: string | null): Promise<Ok | RFail> {
  return withLock(deps, caller, decisionId, async (ctx) => {
    const x = latestOf(ctx.executions);
    if (!x) return fail(409, "no_refund_execution", "This refund has not been sent to Stripe - there is nothing to reconcile");
    if (x.status === "succeeded" || x.status === "failed") {
      // Final: nothing is sent to Stripe and nothing is changed (a succeeded refund is terminal).
      const view = executionView(x, ctx.org.timezone);
      return { status: "ok", httpStatus: 200, body: { ...head(ctx), decisionId, execution: view, reconciled: false, note: "The outcome is already final - nothing was sent to Stripe and nothing was changed" } };
    }
    const s = await openRefundSession(deps, ctx.org);
    if (isFail(s)) return s;
    const audit = refundAudit({ organisationId: ctx.org.organisationId, actorUserId: caller.userId, eventType: REFUND_EVENTS.reconciled, execution: x, before: { status: x.status, providerStatus: x.providerStatus, stripeRefundId: x.stripeRefundId }, after: { decisionId: x.decisionId, executionId: x.executionId, lookup: x.stripeRefundId ? "refund_id" : "charge_refunds_by_hub_execution_id" }, reason, route: ROUTE.reconcile });
    let o: Outcome;
    let attempted = false;
    if (x.stripeRefundId) {
      const r = await s.write.refund(x.stripeRefundId);
      if (!r.ok) return fail(503, "stripe_unavailable", "Stripe could not be read just now - nothing was changed; reconcile again later", { execution: executionView(x, ctx.org.timezone) });
      if (!r.value) return fail(409, "stripe_refund_missing", `Stripe has no refund ${x.stripeRefundId} - this needs investigation; nothing was changed`, { execution: executionView(x, ctx.org.timezone) });
      const obj = refundFromStripe(r.value);
      if (!obj) return fail(502, "stripe_response_invalid", "Stripe returned a refund the Hub could not read - nothing was changed");
      const mis = refundMismatch(obj, x);
      o = mis ? outcomeOfMismatch(mis) : outcomeOfRefund(obj);
    } else {
      const list = await chargeRefunds(s, x.stripeChargeId);
      if (!list.ok) return fail(503, "stripe_unavailable", "Stripe's refunds for this payment could not be read - nothing was sent and nothing was changed; reconcile again later", { execution: executionView(x, ctx.org.timezone) });
      const found = findExecutionRefund(list.refunds, x);
      if (found) {
        const mis = refundMismatch(found, x);
        o = mis ? outcomeOfMismatch(mis) : outcomeOfRefund(found);
      } else {
        // Stripe's own refund list proves no refund exists for this execution: re-send with the SAME
        // Idempotency-Key (layer 1) - never a new key, never a second refund.
        attempted = true;
        o = await sendRefund(s, x);
      }
    }
    const after = await record(deps, caller, ctx, x, o, { attempted, checked: true }, reason, ROUTE.reconcile, [audit]);
    return respond(ctx, after, { reconciled: true, resent: attempted });
  });
}

// ---------------------------------------------------------------------
// Read (View) - the Hub's record; no Stripe call, never audited
// ---------------------------------------------------------------------
export async function readRefundExecution(deps: RefundExecDeps, caller: FinanceCaller, decisionId: string): Promise<Ok | RFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const ctx = await loadCtx(deps, auth.organisation, auth.access, decisionId);
  if (isFail(ctx)) return ctx;
  let cap;
  try {
    cap = await loadRefundCapability(deps.grants, ctx.org.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), ...decisionExecutionView(ctx.decision, ctx.executions, cap, ctx.org.timezone) } };
}
