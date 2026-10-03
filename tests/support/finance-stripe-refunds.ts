/**
 * Test-suite copy of the canonical finance/finance-stripe-refunds.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Stripe refund EXECUTION - pure rules (Finance Foundation F21; see TEST-ENV.md
 * "Finance Foundation - F21"). No fetch, no Deno, no Supabase, no Airtable.
 *
 * F11 decides WHAT should happen (total return, family-credit part, card part,
 * the penny); F21 answers ONE question: did Stripe actually refund the card
 * money? Nothing here allocates, rounds or recalculates: the amount, the
 * charge and the currency are the F11 decision's own stored values, copied
 * verbatim (and re-checked by the database). F21 never creates, restores or
 * changes family credit.
 *
 * Execution status (one row per attempt "version", append-only history):
 *   processing       reserved / request in flight / Stripe says pending or requires_action
 *   outcome_unknown  the request's answer was lost (timeout, 5xx, unreadable) - reconcile first
 *   succeeded        Stripe says succeeded (terminal; the F11 decision becomes refunded)
 *   failed           Stripe refused before creating anything (decision back to Refund Due),
 *                    or Stripe's refund failed / was canceled (decision refund_failed)
 * Only a Stripe refund object with status "succeeded" makes an execution
 * succeeded - never the fact that a request was sent.
 *
 * Idempotency, two layers: (1) one stable Idempotency-Key per execution
 * version (f21:{org}:{decision}:v{n}); (2) every refund carries metadata
 * hub_organisation_id / hub_refund_decision_id / hub_execution_id, and before
 * any uncertain or late retry the charge's refunds are searched for it. A new
 * refund is only ever sent when Stripe's own refund list proves none exists.
 *
 * Cash (locked decision D1, 2026-10-03): a confirmed Stripe refund is a real
 * Stripe fact but NOT a bank Cash Flow OUT - it settles through Stripe payouts,
 * whose bank timing is not integrated. Shown for information only.
 */
import { formatMinor } from "./finance-money.ts";

export const REFUND_EXECUTION_CONTRACT = "finance-refund-execution-v1";
export const EXECUTION_ID_PATTERN = /^FRX-[0-9A-F]{12}$/;
export const DECISION_ID_PATTERN = /^FRD-[0-9A-F]{12}$/;
export const REFUND_ID_PATTERN = /^re_[A-Za-z0-9]{1,64}$/;
export const REFUND_REASON = "requested_by_customer";
const REASON_MAX = 500;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

export type ExecStatus = "processing" | "outcome_unknown" | "succeeded" | "failed";
export type ProviderRefundStatus = "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
export const PROVIDER_STATUSES: readonly ProviderRefundStatus[] = ["pending", "requires_action", "succeeded", "failed", "canceled"];
export type FailureKind =
  | "key_rejected"
  | "permission_denied"
  | "rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "charge_missing"
  | "charge_mismatch"
  | "charge_not_succeeded"
  | "currency_mismatch"
  | "insufficient_refundable"
  | "refund_failed"
  | "refund_canceled";
export type Capability = "unknown" | "available" | "unavailable";

export interface RefundExecution {
  organisationId: string;
  executionId: string;
  decisionId: string;
  version: number;
  stripeChargeId: string;
  amountMinor: number;
  currency: "GBP";
  idempotencyKey: string;
  status: ExecStatus;
  providerStatus: ProviderRefundStatus | null;
  stripeRefundId: string | null;
  stripeRefundCreatedAt: string | null;
  failureKind: FailureKind | null;
  failureCode: string | null;
  failureMessage: string | null;
  attempts: number;
  startedAt: string;
  startedBy: string;
  lastAttemptAt: string;
  lastCheckedAt: string | null;
  lastCheckedBy: string | null;
  succeededAt: string | null;
  failedAt: string | null;
}

/** The F11 decision fields F21 reads (never writes beyond refund_state / the once-only stripe_refund_id, via its database function). */
export interface DecisionForExecution {
  organisationId: string;
  decisionId: string;
  familyParentId: string;
  sourceRef: string;
  stripeChargeId: string | null;
  stripeCustomerId: string | null;
  currency: string;
  returnMinor: number;
  cardRefundMinor: number;
  creditRestoredMinor: number;
  cardToCreditMinor: number;
  refundState: string;
  stripeRefundId: string | null;
  reversedAt: string | null;
}

export const REFUND_EVENTS = {
  started: "finance_refund_execution.started",
  succeeded: "finance_refund_execution.succeeded",
  pending: "finance_refund_execution.pending",
  unknown: "finance_refund_execution.outcome_unknown",
  failed: "finance_refund_execution.failed",
  reconciled: "finance_refund_execution.reconciled",
} as const;
export const ENTITY_EXECUTION = "finance_refund_execution";

export const m = (minor: number) => formatMinor(minor);
export const idempotencyKeyOf = (organisationId: string, decisionId: string, version: number) => `f21:${organisationId}:${decisionId}:v${version}`;
export function newExecutionId(random: () => string = () => crypto.randomUUID()): string {
  const hex = random().replace(/-/g, "").toUpperCase().slice(0, 12);
  if (!/^[0-9A-F]{12}$/.test(hex)) throw new Error("execution id randomness unavailable");
  return `FRX-${hex}`;
}
/** Stable Hub identity on every Stripe refund F21 creates (layer 2 of idempotency). */
export const metadataOf = (organisationId: string, decisionId: string, executionId: string) => ({ hub_organisation_id: organisationId, hub_refund_decision_id: decisionId, hub_execution_id: executionId });

// ---------------------------------------------------------------------
// Routes + input
// ---------------------------------------------------------------------
export type RefundExecRoute = { name: "refund.execute" | "refund.execution" | "refund.reconcile"; params: { decisionId: string } };
export type RefundExecMatch = { status: "match"; route: RefundExecRoute } | { status: "method"; allowed: string[] } | null;

/** F21 owns ONLY refund-decisions/{FRD}/execute, /execution and /execution/reconcile; everything else stays F11's. */
export function matchRefundExecutionRoute(path: string, method: string): RefundExecMatch {
  const seg = path.split("/");
  if (seg[0] !== "refund-decisions" || !DECISION_ID_PATTERN.test(seg[1] ?? "")) return null;
  const mt = (allowed: string[], route: RefundExecRoute): RefundExecMatch => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  const params = { decisionId: seg[1] };
  if (seg.length === 3 && seg[2] === "execute") return mt(["POST"], { name: "refund.execute", params });
  if (seg.length === 3 && seg[2] === "execution") return mt(["GET"], { name: "refund.execution", params });
  if (seg.length === 4 && seg[2] === "execution" && seg[3] === "reconcile") return mt(["POST"], { name: "refund.reconcile", params });
  return null;
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

/** No query parameter is accepted on any F21 route (and a tenant key is refused outright). */
export function checkRefundQuery(q: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true } | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  if (keys.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(keys)].join(", ")}`);
  return { ok: true };
}

/**
 * POST .../execute and .../execution/reconcile: an empty body, {} or { reason }.
 * The amount, currency, Stripe charge and funding split are NEVER taken from
 * the request - they come from the F11 decision; any such field is refused.
 */
export function parseExecuteBody(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string | null } | Invalid {
  if (!raw.trim()) return { ok: true, reason: null };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON (or empty)");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object (or empty)");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const unknown = keys.filter((k) => k !== "reason");
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")} - the amount, currency and Stripe payment come from the refund decision and cannot be supplied`);
  const r = (body as Record<string, unknown>).reason;
  if (r === undefined || r === null) return { ok: true, reason: null };
  if (typeof r !== "string") return invalid("invalid_input", "reason must be text", { reason: "must be text" });
  const t = r.trim();
  if (t.length > REASON_MAX) return invalid("invalid_input", `reason must be at most ${REASON_MAX} characters`, { reason: `must be at most ${REASON_MAX} characters` });
  if (CONTROL_RE.test(t)) return invalid("invalid_input", "reason contains control characters", { reason: "contains control characters" });
  return { ok: true, reason: t || null };
}

// ---------------------------------------------------------------------
// Eligibility (the database function re-checks all of it under the row lock)
// ---------------------------------------------------------------------
export type Refusal = { ok: false; httpStatus: 404 | 409; code: string; error: string };
const refuse = (httpStatus: Refusal["httpStatus"], code: string, error: string): Refusal => ({ ok: false, httpStatus, code, error });
export const latestOf = (xs: RefundExecution[]) => (xs.length ? xs.reduce((a, b) => (b.version > a.version ? b : a)) : null);

export function executionRefusal(d: DecisionForExecution, xs: RefundExecution[]): Refusal | null {
  if (d.reversedAt) return refuse(409, "decision_reversed", "This refund decision was reversed - there is nothing to refund");
  if (d.cardRefundMinor <= 0) return refuse(409, "no_card_refund", "This decision has no card refund (a family-credit-only return) - nothing is sent to Stripe; F11 already created the family credit");
  if (d.refundState === "refunded" || d.stripeRefundId || xs.some((x) => x.status === "succeeded")) return refuse(409, "already_refunded", "This card refund has already been made in Stripe - it cannot be sent again");
  if (d.refundState === "refund_processing" || xs.some((x) => x.status === "processing" || x.status === "outcome_unknown")) return refuse(409, "refund_execution_in_progress", "This card refund is already being executed - check its status or reconcile it with Stripe instead of sending it again");
  if (d.refundState !== "awaiting_refund_action" && d.refundState !== "refund_failed") return refuse(409, "refund_not_executable", "This decision is not awaiting a card refund");
  if (!d.stripeChargeId) return refuse(409, "stripe_payment_missing", "The decision has no Stripe payment to refund");
  if (d.currency !== "GBP") return refuse(409, "currency_not_supported", "Only GBP refunds are supported");
  return null;
}

// ---------------------------------------------------------------------
// Stripe facts (provider truth)
// ---------------------------------------------------------------------
export interface StripeRefundObj {
  id: string;
  amountMinor: number;
  chargeId: string | null;
  currency: string | null;
  status: ProviderRefundStatus | null;
  rawStatus: string;
  createdAt: string | null;
  metadata: Record<string, string>;
  failureReason: string | null;
}
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** A Stripe refund object as F21 reads it; null when it is not a usable refund object. */
export function refundFromStripe(o: unknown): StripeRefundObj | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, any>;
  if (r.object !== "refund" || typeof r.id !== "string" || !REFUND_ID_PATTERN.test(r.id) || !Number.isSafeInteger(r.amount) || r.amount <= 0) return null;
  const raw = typeof r.status === "string" ? r.status : "unknown";
  const md: Record<string, string> = {};
  if (r.metadata && typeof r.metadata === "object") for (const [k, v] of Object.entries(r.metadata)) if (typeof v === "string") md[k] = v;
  return {
    id: r.id,
    amountMinor: r.amount,
    chargeId: typeof r.charge === "string" ? r.charge : str(r.charge?.id),
    currency: typeof r.currency === "string" ? r.currency.toUpperCase() : null,
    status: (PROVIDER_STATUSES as readonly string[]).includes(raw) ? (raw as ProviderRefundStatus) : null,
    rawStatus: raw,
    createdAt: Number.isSafeInteger(r.created) ? new Date(r.created * 1000).toISOString() : null,
    metadata: md,
    failureReason: str(r.failure_reason),
  };
}

/** The refund F21 created for THIS execution (by its stable metadata), if Stripe holds one. */
export function findExecutionRefund(refunds: StripeRefundObj[], x: Pick<RefundExecution, "organisationId" | "decisionId" | "executionId">): StripeRefundObj | null {
  const hit = refunds.filter((r) => r.metadata.hub_execution_id === x.executionId && r.metadata.hub_organisation_id === x.organisationId && r.metadata.hub_refund_decision_id === x.decisionId);
  if (hit.length > 1) throw new Error(`Stripe holds ${hit.length} refunds for one Hub execution ${x.executionId}`);
  return hit[0] ?? null;
}
/** A live (pending / requires_action / succeeded) Stripe refund already made for this DECISION by an earlier execution - adopted, never duplicated. */
export function findLiveDecisionRefund(refunds: StripeRefundObj[], organisationId: string, decisionId: string): StripeRefundObj | null {
  const live = refunds.filter((r) => r.metadata.hub_organisation_id === organisationId && r.metadata.hub_refund_decision_id === decisionId && (r.status === "pending" || r.status === "requires_action" || r.status === "succeeded"));
  if (live.length > 1) throw new Error(`Stripe holds ${live.length} live refunds for one Hub decision ${decisionId}`);
  return live[0] ?? null;
}

/** Why a Stripe refund cannot be this execution's (amount / charge / currency / identity) - then it is never treated as success. */
export function refundMismatch(r: StripeRefundObj, x: Pick<RefundExecution, "amountMinor" | "stripeChargeId" | "organisationId" | "decisionId">): string | null {
  if (r.amountMinor !== x.amountMinor) return `Stripe refund ${r.id} is ${m(r.amountMinor)}, not the decided ${m(x.amountMinor)}`;
  if (r.chargeId !== x.stripeChargeId) return `Stripe refund ${r.id} is for another payment`;
  if (r.currency !== "GBP") return `Stripe refund ${r.id} is not in GBP`;
  if (r.metadata.hub_organisation_id !== x.organisationId || r.metadata.hub_refund_decision_id !== x.decisionId) return `Stripe refund ${r.id} belongs to another Hub refund`;
  if (!r.status) return `Stripe refund ${r.id} has a status the Hub does not recognise (${r.rawStatus})`;
  return null;
}

/** The charge facts the pre-flight needs. */
export interface ChargeFacts {
  chargeId: string;
  customerId: string | null;
  amountMinor: number;
  amountRefundedMinor: number;
  currency: string | null;
  status: string;
  paid: boolean;
  disputed: boolean;
}
export function chargeFromStripe(o: Record<string, any>): ChargeFacts {
  return {
    chargeId: String(o.id),
    customerId: typeof o.customer === "string" ? o.customer : str(o.customer?.id),
    amountMinor: Number.isSafeInteger(o.amount) ? o.amount : 0,
    amountRefundedMinor: Number.isSafeInteger(o.amount_refunded) ? o.amount_refunded : 0,
    currency: typeof o.currency === "string" ? o.currency.toUpperCase() : null,
    status: typeof o.status === "string" ? o.status : "unknown",
    paid: o.paid === true,
    disputed: o.disputed === true,
  };
}

export type Outcome = {
  status: ExecStatus;
  providerStatus: ProviderRefundStatus | null;
  refund: StripeRefundObj | null;
  failureKind: FailureKind | null;
  failureCode: string | null;
  failureMessage: string | null;
  capability: Capability | null;
  capabilityCode: string | null;
};
const outcome = (o: Partial<Outcome> & { status: ExecStatus }): Outcome => ({ providerStatus: null, refund: null, failureKind: null, failureCode: null, failureMessage: null, capability: null, capabilityCode: null, ...o });

/** Pre-flight on the charge (nothing has been sent to Stripe yet; a refusal returns the decision to Refund Due). */
export function preflight(c: ChargeFacts, d: DecisionForExecution, amountMinor: number): Outcome | null {
  if (c.chargeId !== d.stripeChargeId) return outcome({ status: "failed", failureKind: "charge_mismatch", failureCode: "charge_mismatch", failureMessage: "Stripe returned another payment than the decision's" });
  if (d.stripeCustomerId && c.customerId !== d.stripeCustomerId) return outcome({ status: "failed", failureKind: "charge_mismatch", failureCode: "customer_changed", failureMessage: "The Stripe payment now belongs to another customer than when the refund was decided - nothing was sent" });
  if (c.status !== "succeeded" || !c.paid) return outcome({ status: "failed", failureKind: "charge_not_succeeded", failureCode: "charge_not_succeeded", failureMessage: `The Stripe payment is ${c.status} - there is nothing to refund` });
  if (c.currency !== "GBP") return outcome({ status: "failed", failureKind: "currency_mismatch", failureCode: "currency_mismatch", failureMessage: "The Stripe payment is not in GBP - nothing was sent" });
  if (c.disputed) return outcome({ status: "failed", failureKind: "provider_rejected", failureCode: "charge_disputed", failureMessage: "The Stripe payment is disputed - resolve the dispute in Stripe first" });
  const left = c.amountMinor - c.amountRefundedMinor;
  if (left < amountMinor) return outcome({ status: "failed", failureKind: "insufficient_refundable", failureCode: "insufficient_refundable", failureMessage: `Stripe can refund only ${m(Math.max(0, left))} more on this payment, less than the decided ${m(amountMinor)} - nothing was sent` });
  return null;
}

/** Stripe's refund object -> the execution outcome (only "succeeded" is success). */
export function outcomeOfRefund(r: StripeRefundObj): Outcome {
  switch (r.status) {
    case "succeeded":
      return outcome({ status: "succeeded", providerStatus: "succeeded", refund: r, capability: "available" });
    case "pending":
    case "requires_action":
      return outcome({ status: "processing", providerStatus: r.status, refund: r, capability: "available" });
    case "failed":
      return outcome({ status: "failed", providerStatus: "failed", refund: r, failureKind: "refund_failed", failureCode: r.failureReason ?? "refund_failed", failureMessage: "Stripe could not complete the card refund - no money was returned", capability: "available" });
    case "canceled":
      return outcome({ status: "failed", providerStatus: "canceled", refund: r, failureKind: "refund_canceled", failureCode: "refund_canceled", failureMessage: "The Stripe refund was canceled - no money was returned", capability: "available" });
    default:
      return outcome({ status: "outcome_unknown", failureCode: "unrecognised_refund_status", failureMessage: `Stripe reported a refund status the Hub does not recognise (${r.rawStatus})` });
  }
}

/** A provider failure on POST /v1/refunds. A definitive refusal (nothing created) fails; anything ambiguous is outcome_unknown. */
export type ProviderFailLike = { kind: string; status: number | null; message: string; stripeCode: string | null };
export function outcomeOfCreateFailure(f: ProviderFailLike): Outcome {
  switch (f.kind) {
    case "forbidden":
      return outcome({ status: "failed", failureKind: "permission_denied", failureCode: f.stripeCode ?? "permission_denied", failureMessage: "The organisation's Stripe key is not allowed to create refunds - give the restricted key Refunds write permission, then try again", capability: "unavailable", capabilityCode: "permission_denied" });
    case "unauthorised":
      return outcome({ status: "failed", failureKind: "key_rejected", failureCode: f.stripeCode ?? "key_rejected", failureMessage: "Stripe no longer accepts the organisation's key - it needs reconnecting", capability: "unavailable", capabilityCode: "key_rejected" });
    case "rate_limited":
      return outcome({ status: "failed", failureKind: "rate_limited", failureCode: f.stripeCode ?? "rate_limit", failureMessage: "Stripe's rate limit was reached - nothing was created; try again in a minute" });
    case "not_found":
      return outcome({ status: "failed", failureKind: "charge_missing", failureCode: f.stripeCode ?? "resource_missing", failureMessage: "Stripe has no such payment" });
    case "rejected":
      if (f.stripeCode === "idempotency_key_in_use" || f.stripeCode === "idempotency_error") return outcome({ status: "outcome_unknown", failureCode: f.stripeCode, failureMessage: "Stripe reports the request's key is already in use - the outcome must be reconciled" });
      if (f.stripeCode === "resource_missing") return outcome({ status: "failed", failureKind: "charge_missing", failureCode: f.stripeCode, failureMessage: "Stripe has no such payment" });
      return outcome({ status: "failed", failureKind: "provider_rejected", failureCode: f.stripeCode ?? "rejected", failureMessage: `Stripe refused the refund: ${f.message}`.slice(0, 300) });
    default:
      // timeout / unreachable / server / malformed / live_data: Stripe may or may not have created it.
      return outcome({ status: "outcome_unknown", failureCode: f.kind, failureMessage: "Stripe's answer was lost or unreadable - the refund may or may not exist; it must be reconciled with Stripe before anything is sent again" });
  }
}
/** A failed READ before anything was sent (pre-flight): nothing was created, so the decision stays Refund Due. */
export function outcomeOfPreflightFailure(f: ProviderFailLike): Outcome {
  if (f.kind === "unauthorised") return outcome({ status: "failed", failureKind: "key_rejected", failureCode: "key_rejected", failureMessage: "Stripe no longer accepts the organisation's key - nothing was sent", capability: "unavailable", capabilityCode: "key_rejected" });
  if (f.kind === "rate_limited") return outcome({ status: "failed", failureKind: "rate_limited", failureCode: "rate_limit", failureMessage: "Stripe's rate limit was reached before the refund was sent - nothing was sent; try again in a minute" });
  return outcome({ status: "failed", failureKind: "provider_unavailable", failureCode: f.kind, failureMessage: "Stripe could not be read before the refund was sent - nothing was sent; try again" });
}
export const outcomeOfMismatch = (message: string): Outcome => outcome({ status: "outcome_unknown", failureCode: "provider_response_mismatch", failureMessage: message.slice(0, 300) });
export const outcomeUnknownStill = (prev: RefundExecution): Outcome => outcome({ status: prev.status === "processing" && prev.providerStatus ? "processing" : "outcome_unknown", providerStatus: prev.providerStatus, failureCode: prev.failureCode, failureMessage: prev.failureMessage });

/** The record function's p_result (snake_case, exactly the columns it sets). */
export function resultRow(o: Outcome, prev: Pick<RefundExecution, "stripeRefundId" | "stripeRefundCreatedAt">, at: string, by: string, flags: { attempted: boolean; checked: boolean }) {
  return {
    status: o.status,
    provider_status: o.providerStatus,
    stripe_refund_id: o.refund?.id ?? prev.stripeRefundId,
    stripe_refund_created_at: o.refund?.createdAt ?? prev.stripeRefundCreatedAt,
    failure_kind: o.failureKind,
    failure_code: o.failureCode,
    failure_message: o.failureMessage,
    attempted: flags.attempted,
    checked: flags.checked,
    by,
    at,
    ...(o.capability === "available" || o.capability === "unavailable" ? { capability: o.capability, capability_code: o.capabilityCode } : {}),
  };
}

// ---------------------------------------------------------------------
// HTTP outcome (the execute / reconcile response)
// ---------------------------------------------------------------------
export const FAIL_HTTP: Record<FailureKind, { httpStatus: 409 | 502 | 503; code: string }> = {
  permission_denied: { httpStatus: 409, code: "provider_permission_denied" },
  key_rejected: { httpStatus: 409, code: "stripe_connection_rejected" },
  rate_limited: { httpStatus: 503, code: "stripe_rate_limited" },
  provider_rejected: { httpStatus: 409, code: "stripe_refund_rejected" },
  provider_unavailable: { httpStatus: 503, code: "stripe_unavailable" },
  charge_missing: { httpStatus: 409, code: "stripe_charge_not_found" },
  charge_mismatch: { httpStatus: 409, code: "stripe_payment_mismatch" },
  charge_not_succeeded: { httpStatus: 409, code: "stripe_charge_not_succeeded" },
  currency_mismatch: { httpStatus: 409, code: "currency_mismatch" },
  insufficient_refundable: { httpStatus: 409, code: "insufficient_refundable" },
  refund_failed: { httpStatus: 409, code: "stripe_refund_failed" },
  refund_canceled: { httpStatus: 409, code: "stripe_refund_canceled" },
};

// ---------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------
const STATUS_TEXT: Record<ExecStatus, string> = {
  processing: "Processing in Stripe - not yet refunded",
  outcome_unknown: "Outcome unknown - reconcile with Stripe before anything is sent again",
  succeeded: "Refunded via Stripe",
  failed: "Not refunded",
};
const dateIn = (iso: string, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
};
/** The plain-language cash note (locked decision D1): never a bank movement. */
export function cashNote(x: RefundExecution, tz: string): string {
  if (x.status === "succeeded" && x.stripeRefundCreatedAt) return `Refunded via Stripe on ${dateIn(x.stripeRefundCreatedAt, tz)} - settles through Stripe payouts (not in the bank Cash Flow projection)`;
  if (x.status === "processing" || x.status === "outcome_unknown") return "Not refunded yet - no cash has been returned";
  return "Not refunded - no cash has been returned";
}

export function executionView(x: RefundExecution, tz: string) {
  return {
    executionId: x.executionId,
    version: x.version,
    status: x.status,
    statusText: STATUS_TEXT[x.status],
    providerStatus: x.providerStatus,
    amount: m(x.amountMinor),
    currency: x.currency,
    stripeRefundId: x.stripeRefundId,
    refundedOn: x.status === "succeeded" && x.stripeRefundCreatedAt ? dateIn(x.stripeRefundCreatedAt, tz) : null,
    stripeRefundCreatedAt: x.stripeRefundCreatedAt,
    failure: x.failureKind || x.failureCode ? { kind: x.failureKind, code: x.failureCode, message: x.failureMessage } : null,
    attempts: x.attempts,
    startedAt: x.startedAt,
    startedBy: x.startedBy,
    lastAttemptAt: x.lastAttemptAt,
    lastCheckedAt: x.lastCheckedAt,
    succeededAt: x.succeededAt,
    failedAt: x.failedAt,
    cash: { bankProjection: false, note: cashNote(x, tz) },
    technical: { stripeChargeId: x.stripeChargeId, idempotencyKey: x.idempotencyKey },
  };
}

export function decisionExecutionView(d: DecisionForExecution, xs: RefundExecution[], capability: { connected: boolean; refundCapability: Capability; checkedAt: string | null; code: string | null }, tz: string) {
  const latest = latestOf(xs);
  const refusal = executionRefusal(d, xs);
  return {
    decision: {
      decisionId: d.decisionId,
      parentId: d.familyParentId,
      source: d.sourceRef,
      refundState: d.reversedAt ? "reversed" : d.refundState,
      cardRefund: m(d.cardRefundMinor),
      currency: d.currency,
      /** F11's family-credit part of the same return: already created by F11 when it decided; F21 never touches it. */
      familyCreditPortion: { amount: m(d.creditRestoredMinor + d.cardToCreditMinor), handledBy: "F11 at decision time - F21 never creates, restores or changes family credit" },
      stripeRefundId: d.stripeRefundId,
    },
    execution: latest ? executionView(latest, tz) : null,
    history: [...xs].sort((a, b) => b.version - a.version).map((x) => executionView(x, tz)),
    stripe: { connected: capability.connected, refundCapability: capability.refundCapability, refundCapabilityCheckedAt: capability.checkedAt, refundCapabilityReason: capability.code },
    actions: {
      canExecute: refusal === null,
      executeBlockedBy: refusal ? refusal.code : null,
      canReconcile: !!latest && (latest.status === "processing" || latest.status === "outcome_unknown"),
    },
  };
}

// ---------------------------------------------------------------------
// Cash Flow (informational only - locked decision D1)
// ---------------------------------------------------------------------
export const REFUND_CASH = {
  label: "Parent card refunds (F11 / F21): Not in the bank projection",
  reason:
    "A card refund is paid from the Stripe balance and reaches the bank through Stripe payouts, whose timing is not integrated yet. Refund Due, pending and succeeded Stripe refunds are shown for information only and never change the projected bank balance.",
} as const;
export const REFUND_INFO_DAYS = 93;

/** Refund Due / in-progress / refunded-via-Stripe facts for Cash Flow - never a CashEvent, never a bank date. */
export function refundCashInfo(decisions: DecisionForExecution[], xs: RefundExecution[], tz: string, today: string) {
  const live = decisions.filter((d) => !d.reversedAt && d.cardRefundMinor > 0);
  const byDecision = new Map<string, RefundExecution[]>();
  for (const x of xs) byDecision.set(x.decisionId, [...(byDecision.get(x.decisionId) ?? []), x]);
  const awaiting = live.filter((d) => d.refundState === "awaiting_refund_action" || d.refundState === "refund_failed");
  const processing = live.filter((d) => d.refundState === "refund_processing");
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - REFUND_INFO_DAYS * 86_400_000).toISOString().slice(0, 10);
  const refunded = live
    .filter((d) => d.refundState === "refunded")
    .map((d) => ({ d, x: (byDecision.get(d.decisionId) ?? []).find((x) => x.status === "succeeded") ?? null }))
    .filter((r) => r.x && r.x.stripeRefundCreatedAt && dateIn(r.x.stripeRefundCreatedAt, tz) >= from)
    .sort((a, b) => (a.x!.stripeRefundCreatedAt! < b.x!.stripeRefundCreatedAt! ? 1 : a.x!.stripeRefundCreatedAt! > b.x!.stripeRefundCreatedAt! ? -1 : a.d.decisionId < b.d.decisionId ? -1 : 1));
  const sumOf = (ds: DecisionForExecution[]) => m(ds.reduce((a, d) => a + d.cardRefundMinor, 0));
  return {
    included: false,
    ...REFUND_CASH,
    awaitingRefundAction: { count: awaiting.length, amount: sumOf(awaiting), cash: "none - an obligation, not a cash movement" },
    processingInStripe: { count: processing.length, amount: sumOf(processing), cash: "none - not refunded until Stripe confirms" },
    refundedViaStripe: {
      window: `refunds created on or after ${from}`,
      count: refunded.length,
      amount: sumOf(refunded.map((r) => r.d)),
      refunds: refunded.map(({ d, x }) => ({ decisionId: d.decisionId, parentId: d.familyParentId, amount: m(d.cardRefundMinor), stripeRefundId: x!.stripeRefundId, refundedOn: dateIn(x!.stripeRefundCreatedAt!, tz), confirmedAt: x!.succeededAt, bankProjection: false, note: cashNote(x!, tz) })),
    },
  };
}

// ---------------------------------------------------------------------
// Audit (one event per state change; reads and refusals audit nothing)
// ---------------------------------------------------------------------
export function refundAudit(a: { organisationId: string; actorUserId: string; eventType: string; execution: Pick<RefundExecution, "executionId" | "decisionId">; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string }) {
  return {
    organisation_id: a.organisationId,
    actor_user_id: a.actorUserId,
    event_type: a.eventType,
    entity_type: ENTITY_EXECUTION,
    record_id: `${a.organisationId}:${a.execution.decisionId}:${a.execution.executionId}`,
    before: a.before,
    after: a.after,
    reason: a.reason ? a.reason.slice(0, 500) : null,
    context: { contract: REFUND_EXECUTION_CONTRACT, route: a.route, provider: "stripe" },
  };
}
/** The audited facts of an outcome: safe ids, amounts, statuses and codes only - never a key, card or customer detail. */
export function outcomeFacts(x: Pick<RefundExecution, "decisionId" | "executionId" | "version" | "amountMinor" | "currency" | "stripeChargeId">, o: Outcome, refundId: string | null) {
  return {
    decisionId: x.decisionId,
    executionId: x.executionId,
    version: x.version,
    amount: m(x.amountMinor),
    currency: x.currency,
    stripeChargeId: x.stripeChargeId,
    status: o.status,
    providerStatus: o.providerStatus,
    stripeRefundId: refundId,
    failureKind: o.failureKind,
    failureCode: o.failureCode,
  };
}
export function eventFor(o: Outcome): string {
  if (o.status === "succeeded") return REFUND_EVENTS.succeeded;
  if (o.status === "failed") return REFUND_EVENTS.failed;
  if (o.status === "processing") return REFUND_EVENTS.pending;
  return REFUND_EVENTS.unknown;
}
