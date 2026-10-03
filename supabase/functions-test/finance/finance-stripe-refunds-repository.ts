/**
 * Stripe refund EXECUTION storage (Finance Foundation F21; see TEST-ENV.md
 * "Finance Foundation - F21"). Supabase only (service role, PostgREST); RLS on,
 * no client grants.
 *
 *   finance_stripe_refund_executions   one row per execution attempt (version):
 *                                      the decision's amount / charge / currency
 *                                      copied verbatim, the stable idempotency
 *                                      key, Stripe's refund id + status, the safe
 *                                      failure code. Append-only history (no
 *                                      DELETE; a closed row never changes; the
 *                                      refund id is set once).
 *   rpc finance_stripe_refund_reserve  ONE transaction: re-check the F11
 *                                      decision under its row lock, insert the
 *                                      execution, decision -> refund_processing,
 *                                      audit.
 *   rpc finance_stripe_refund_record   ONE transaction: Stripe's answer on an
 *                                      open execution (optimistic on its status),
 *                                      mirrored onto the decision (refunded /
 *                                      refund_failed / back to Refund Due),
 *                                      refund capability, audit.
 *
 * F21 reads the F11 decision row and writes it ONLY through those functions
 * (refund_state + the once-only stripe_refund_id the F11 guard reserved).
 */
import type { GrantStoreConfig } from "./repository.ts";
import { STRIPE_CONNECTIONS_TABLE } from "./finance-stripe-repository.ts";
import { type Capability, type DecisionForExecution, type ExecStatus, type FailureKind, type ProviderRefundStatus, type RefundExecution, PROVIDER_STATUSES } from "./finance-stripe-refunds.ts";

export const EXECUTIONS_TABLE = "finance_stripe_refund_executions";
export const DECISIONS_TABLE = "finance_refund_decisions";
export const REFUND_RPC = { reserve: "finance_stripe_refund_reserve", record: "finance_stripe_refund_record" } as const;

function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

/** A refused execution write: the database function's own rule code (f21:...), never a partial write. */
export class ExecutionRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function read(svc: GrantStoreConfig, table: string, organisationId: string, filter: string, order: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${rest(svc, table)}?organisation_id=${eq(organisationId)}${filter}&select=*&order=${order}`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`${table} read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} read returned an unexpected shape`);
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error(`${table} read returned another organisation's row`);
  return rows;
}

const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what} is not an integer`);
  return n;
};
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);
const STATUSES: readonly ExecStatus[] = ["processing", "outcome_unknown", "succeeded", "failed"];

export function decisionForExecutionFromRow(r: Record<string, any>): DecisionForExecution {
  return {
    organisationId: r.organisation_id,
    decisionId: r.decision_id,
    familyParentId: r.family_parent_id,
    sourceRef: r.source_ref,
    stripeChargeId: r.stripe_charge_id ?? null,
    stripeCustomerId: r.stripe_customer_id ?? null,
    currency: r.currency,
    returnMinor: int(r.return_minor, "return_minor"),
    cardRefundMinor: int(r.card_refund_minor, "card_refund_minor"),
    creditRestoredMinor: int(r.credit_restored_minor, "credit_restored_minor"),
    cardToCreditMinor: int(r.card_to_credit_minor, "card_to_credit_minor"),
    refundState: r.refund_state,
    stripeRefundId: r.stripe_refund_id ?? null,
    reversedAt: iso(r.reversed_at),
  };
}

export function executionFromRow(r: Record<string, any>): RefundExecution {
  if (!STATUSES.includes(r.status)) throw new Error(`${EXECUTIONS_TABLE}: invalid status`);
  if (r.provider_status !== null && r.provider_status !== undefined && !PROVIDER_STATUSES.includes(r.provider_status)) throw new Error(`${EXECUTIONS_TABLE}: invalid provider_status`);
  if (r.currency !== "GBP") throw new Error(`${EXECUTIONS_TABLE}: invalid currency`);
  return {
    organisationId: r.organisation_id,
    executionId: r.execution_id,
    decisionId: r.decision_id,
    version: int(r.version, "version"),
    stripeChargeId: r.stripe_charge_id,
    amountMinor: int(r.amount_minor, "amount_minor"),
    currency: "GBP",
    idempotencyKey: r.idempotency_key,
    status: r.status as ExecStatus,
    providerStatus: (r.provider_status ?? null) as ProviderRefundStatus | null,
    stripeRefundId: r.stripe_refund_id ?? null,
    stripeRefundCreatedAt: iso(r.stripe_refund_created_at),
    failureKind: (r.failure_kind ?? null) as FailureKind | null,
    failureCode: r.failure_code ?? null,
    failureMessage: r.failure_message ?? null,
    attempts: int(r.attempts, "attempts"),
    startedAt: iso(r.started_at)!,
    startedBy: r.started_by,
    lastAttemptAt: iso(r.last_attempt_at)!,
    lastCheckedAt: iso(r.last_checked_at),
    lastCheckedBy: r.last_checked_by ?? null,
    succeededAt: iso(r.succeeded_at),
    failedAt: iso(r.failed_at),
  };
}

/** One F11 decision of this organisation (null when it is not this organisation's). */
export async function loadDecision(svc: GrantStoreConfig, organisationId: string, decisionId: string): Promise<DecisionForExecution | null> {
  const rows = await read(svc, DECISIONS_TABLE, organisationId, `&decision_id=${eq(decisionId)}`, "decision_id.asc");
  if (rows.length > 1) throw new Error("decision read returned more than one row");
  return rows.length ? decisionForExecutionFromRow(rows[0]) : null;
}
export async function loadExecutions(svc: GrantStoreConfig, organisationId: string, decisionId: string): Promise<RefundExecution[]> {
  return (await read(svc, EXECUTIONS_TABLE, organisationId, `&decision_id=${eq(decisionId)}`, "version.asc")).map(executionFromRow);
}
/** For Cash Flow: every card-refund decision + every execution of the organisation (small: one organisation's parent refunds). */
export async function loadRefundCashFacts(svc: GrantStoreConfig, organisationId: string): Promise<{ decisions: DecisionForExecution[]; executions: RefundExecution[] }> {
  const [d, x] = await Promise.all([read(svc, DECISIONS_TABLE, organisationId, "&card_refund_minor=gt.0", "decision_id.asc"), read(svc, EXECUTIONS_TABLE, organisationId, "", "decision_id.asc,version.asc")]);
  return { decisions: d.map(decisionForExecutionFromRow), executions: x.map(executionFromRow) };
}

/** What Stripe has told the Hub about refund permission on the ONE organisation connection (never assumed). */
export async function loadRefundCapability(svc: GrantStoreConfig, organisationId: string): Promise<{ connected: boolean; refundCapability: Capability; checkedAt: string | null; code: string | null }> {
  const res = await fetch(`${rest(svc, STRIPE_CONNECTIONS_TABLE)}?organisation_id=${eq(organisationId)}&select=organisation_id,status,refund_capability,refund_capability_at,refund_capability_code`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`Stripe connection read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Stripe connection read returned an unexpected shape");
  if (!rows.length) return { connected: false, refundCapability: "unknown", checkedAt: null, code: null };
  const r = rows[0];
  if (r.organisation_id !== organisationId) throw new Error("Stripe connection read returned another organisation's row");
  const cap: Capability = ["unknown", "available", "unavailable"].includes(r.refund_capability) ? r.refund_capability : "unknown";
  return { connected: r.status === "connected", refundCapability: cap, checkedAt: iso(r.refund_capability_at), code: r.refund_capability_code ?? null };
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(rest(svc, `rpc/${fn}`), { method: "POST", headers: headers(svc), body: JSON.stringify(args) });
  const t = await res.text();
  if (!res.ok) {
    let msg = t;
    try {
      msg = JSON.parse(t)?.message ?? t;
    } catch {
      /* raw text */
    }
    const mm = /f21:([a-z_]+)/.exec(String(msg));
    if (mm) throw new ExecutionRefusal(mm[1]);
    throw new Error(`Supabase RPC ${fn} failed: ${res.status} ${t}`);
  }
  return t ? JSON.parse(t) : null;
}

export async function reserveExecution(svc: GrantStoreConfig, x: Pick<RefundExecution, "organisationId" | "executionId" | "decisionId" | "version" | "amountMinor" | "stripeChargeId" | "currency" | "idempotencyKey" | "startedAt" | "startedBy">, events: Record<string, unknown>[]): Promise<RefundExecution> {
  const row = await rpc(svc, REFUND_RPC.reserve, {
    p_org: x.organisationId,
    p_decision_id: x.decisionId,
    p_execution: { execution_id: x.executionId, version: x.version, amount_minor: x.amountMinor, stripe_charge_id: x.stripeChargeId, currency: x.currency, idempotency_key: x.idempotencyKey, started_at: x.startedAt, started_by: x.startedBy },
    p_events: events,
  });
  return executionFromRow(row);
}

export async function recordExecution(svc: GrantStoreConfig, organisationId: string, executionId: string, expectedStatus: ExecStatus, result: Record<string, unknown>, events: Record<string, unknown>[]): Promise<RefundExecution> {
  const row = await rpc(svc, REFUND_RPC.record, { p_org: organisationId, p_execution_id: executionId, p_expected_status: expectedStatus, p_result: result, p_events: events });
  return executionFromRow(row);
}
