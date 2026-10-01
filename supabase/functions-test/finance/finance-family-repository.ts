/**
 * Parent / family credit + refund decision storage (Finance Foundation F11;
 * see TEST-ENV.md "Finance Foundation - F11"). Supabase only (service role,
 * PostgREST); every table RLS on with no client grants:
 *
 *   finance_family_payments             a parent payable (priced first) and its funding:
 *                                       credit applications + at most one Stripe charge
 *   finance_family_credits              family credit, one per decision that returned value
 *                                       as credit; NO balance column - derived
 *   finance_family_credit_applications  credit used against a family payment (oldest first)
 *   finance_refund_decisions            Management's decision per source (never deleted;
 *                                       reversed by an explicit record)
 *   finance_family_sources              one version row per refund source (concurrency)
 *
 * Every ledger row carries owner_type + owner_key (who owns the value) apart
 * from family_parent_* (immutable guardian-account context). UPDATE guards in
 * the database: payments + applications never change; credits only their
 * void fields (once); decisions only their reversal fields (once) and F21's
 * refund_state / stripe_refund_id; owner fields only inside an explicit
 * guardian_account -> household transfer (none exists yet).
 *
 * Every write is ONE database function call (finance_family_*): the ledger
 * rows and their finance_audit_events rows commit together or not at all,
 * and the function re-checks the money rules under row locks (no overspend,
 * oldest first, no stale decision, no spent-credit void / reversal).
 * History tables refuse DELETE.
 *
 * Hub guardians / children are READ from Airtable (Parents & Guardians,
 * Parent-Player Links, Players); F11 writes nothing to Airtable.
 */
import type { AirtableConfig, GrantStoreConfig } from "./repository.ts";
import { listAll } from "./finance-stripe-repository.ts";
import { type CreditApplication, type CreditOwner, type FamilyCredit, type FamilyPayment, type HubRow, type Ledger, type OwnerType, type RefundDecision, OWNER_TYPES } from "./finance-family.ts";

export const PAYMENTS_TABLE = "finance_family_payments";
export const CREDITS_TABLE = "finance_family_credits";
export const APPLICATIONS_TABLE = "finance_family_credit_applications";
export const DECISIONS_TABLE = "finance_refund_decisions";
export const SOURCES_TABLE = "finance_family_sources";
export const RPC = {
  payment: "finance_family_payment_record",
  apply: "finance_family_credit_apply",
  decision: "finance_family_decision_record",
  void: "finance_family_credit_void",
  reverse: "finance_family_decision_reverse",
} as const;
export const HUB_TABLES = { parents: "Parents & Guardians", links: "Parent–Player Links", players: "Players" } as const;

function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

/** A refused ledger write: the database function's own rule code (f11:...), never a partial write. */
export class LedgerRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function read(svc: GrantStoreConfig, table: string, organisationId: string, order: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${rest(svc, table)}?organisation_id=${eq(organisationId)}&select=*&order=${order}`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`${table} read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} read returned an unexpected shape`);
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error(`${table} read returned another organisation's row`);
  return rows;
}

const num = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what}: not an integer amount`);
  return n;
};
const numOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : num(v, what));
const ownerTypeOf = (v: unknown): OwnerType => {
  if (!(OWNER_TYPES as readonly unknown[]).includes(v)) throw new Error("F11 ledger row: invalid owner_type");
  return v as OwnerType;
};
const ownerKeyOf = (v: unknown): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error("F11 ledger row: invalid owner_key");
  return v;
};

export const paymentFromRow = (r: Record<string, any>): FamilyPayment => ({
  organisationId: r.organisation_id,
  paymentId: r.payment_id,
  familyRecordId: r.family_parent_record_id,
  ownerType: ownerTypeOf(r.owner_type),
  ownerKey: ownerKeyOf(r.owner_key),
  familyParentId: r.family_parent_id,
  playerRecordId: r.player_record_id ?? null,
  bookingRef: r.booking_ref ?? null,
  description: r.description,
  currency: "GBP",
  amountDueMinor: num(r.amount_due_minor, "amount_due_minor"),
  stripeChargeId: r.stripe_charge_id ?? null,
  stripeCustomerId: r.stripe_customer_id ?? null,
  stripeChargeMinor: numOrNull(r.stripe_charge_minor, "stripe_charge_minor"),
  createdAt: r.created_at,
  createdBy: r.created_by,
  reason: r.reason,
});
export const creditFromRow = (r: Record<string, any>): FamilyCredit => ({
  organisationId: r.organisation_id,
  creditId: r.credit_id,
  familyRecordId: r.family_parent_record_id,
  ownerType: ownerTypeOf(r.owner_type),
  ownerKey: ownerKeyOf(r.owner_key),
  familyParentId: r.family_parent_id,
  currency: "GBP",
  originalMinor: num(r.original_minor, "original_minor"),
  creditFundedMinor: num(r.credit_funded_minor, "credit_funded_minor"),
  cardFundedMinor: num(r.card_funded_minor, "card_funded_minor"),
  originDecisionId: r.origin_decision_id,
  sourceRef: r.source_ref,
  createdAt: new Date(r.created_at).toISOString(),
  createdBy: r.created_by,
  reason: r.reason,
  voidedAt: r.voided_at ? new Date(r.voided_at).toISOString() : null,
  voidedBy: r.voided_by ?? null,
  voidKind: r.void_kind ?? null,
  voidReason: r.void_reason ?? null,
});
export const applicationFromRow = (r: Record<string, any>): CreditApplication => ({
  organisationId: r.organisation_id,
  applicationId: r.application_id,
  batchId: r.batch_id,
  sequence: num(r.sequence, "sequence"),
  creditId: r.credit_id,
  paymentId: r.payment_id,
  familyRecordId: r.family_parent_record_id,
  ownerType: ownerTypeOf(r.owner_type),
  ownerKey: ownerKeyOf(r.owner_key),
  amountMinor: num(r.amount_minor, "amount_minor"),
  appliedAt: new Date(r.applied_at).toISOString(),
  appliedBy: r.applied_by,
  reason: r.reason ?? null,
});
export const decisionFromRow = (r: Record<string, any>): RefundDecision => ({
  organisationId: r.organisation_id,
  decisionId: r.decision_id,
  familyRecordId: r.family_parent_record_id,
  ownerType: ownerTypeOf(r.owner_type),
  ownerKey: ownerKeyOf(r.owner_key),
  familyParentId: r.family_parent_id,
  playerRecordId: r.player_record_id ?? null,
  sourceType: r.source_type,
  sourceRef: r.source_ref,
  stripeChargeId: r.stripe_charge_id ?? null,
  stripeCustomerId: r.stripe_customer_id ?? null,
  currency: "GBP",
  sourceTotalMinor: num(r.source_total_minor, "source_total_minor"),
  sourceCreditFundedMinor: num(r.source_credit_funded_minor, "source_credit_funded_minor"),
  sourceCardFundedMinor: num(r.source_card_funded_minor, "source_card_funded_minor"),
  returnableBeforeMinor: num(r.returnable_before_minor, "returnable_before_minor"),
  decisionType: r.decision_type,
  returnMinor: num(r.return_minor, "return_minor"),
  cardRefundMinor: num(r.card_refund_minor, "card_refund_minor"),
  creditRestoredMinor: num(r.credit_restored_minor, "credit_restored_minor"),
  cardToCreditMinor: num(r.card_to_credit_minor, "card_to_credit_minor"),
  retainedMinor: num(r.retained_minor, "retained_minor"),
  executionState: r.execution_state,
  refundState: r.refund_state,
  stripeRefundId: r.stripe_refund_id ?? null,
  reason: r.reason,
  policyKind: r.policy_kind,
  policyRef: r.policy_ref ?? null,
  decidedAt: new Date(r.decided_at).toISOString(),
  decidedBy: r.decided_by,
  reversedAt: r.reversed_at ? new Date(r.reversed_at).toISOString() : null,
  reversedBy: r.reversed_by ?? null,
  reverseReason: r.reverse_reason ?? null,
});

/** The organisation's whole F11 ledger (small: one organisation's parent decisions). */
export async function loadLedger(svc: GrantStoreConfig, organisationId: string): Promise<Ledger> {
  const [p, c, a, d, s] = await Promise.all([
    read(svc, PAYMENTS_TABLE, organisationId, "created_at.asc,payment_id.asc"),
    read(svc, CREDITS_TABLE, organisationId, "created_at.asc,credit_id.asc"),
    read(svc, APPLICATIONS_TABLE, organisationId, "applied_at.asc,batch_id.asc,sequence.asc"),
    read(svc, DECISIONS_TABLE, organisationId, "decided_at.asc,decision_id.asc"),
    read(svc, SOURCES_TABLE, organisationId, "source_ref.asc"),
  ]);
  return {
    payments: p.map(paymentFromRow),
    credits: c.map(creditFromRow),
    applications: a.map(applicationFromRow),
    decisions: d.map(decisionFromRow),
    versions: new Map(s.map((r) => [r.source_ref as string, num(r.version, "version")])),
  };
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(rest(svc, `rpc/${fn}`), { method: "POST", headers: headers(svc), body: JSON.stringify(args) });
  const t = await res.text();
  if (!res.ok) {
    let msg = t;
    try {
      msg = JSON.parse(t)?.message ?? t;
    } catch {
      /* raw text */
    }
    const m = /f11:([a-z_]+)/.exec(String(msg));
    if (m) throw new LedgerRefusal(m[1]);
    throw new Error(`Supabase RPC ${fn} failed: ${res.status} ${t}`);
  }
  return t ? JSON.parse(t) : null;
}

export const paymentRow = (p: FamilyPayment) => ({
  organisation_id: p.organisationId,
  payment_id: p.paymentId,
  family_parent_record_id: p.familyRecordId,
  family_parent_id: p.familyParentId,
  owner_type: p.ownerType,
  owner_key: p.ownerKey,
  player_record_id: p.playerRecordId,
  booking_ref: p.bookingRef,
  description: p.description,
  currency: p.currency,
  amount_due_minor: p.amountDueMinor,
  stripe_charge_id: p.stripeChargeId,
  stripe_customer_id: p.stripeCustomerId,
  stripe_charge_minor: p.stripeChargeMinor,
  created_at: p.createdAt,
  created_by: p.createdBy,
  reason: p.reason,
});
export const decisionRow = (d: RefundDecision) => ({
  organisation_id: d.organisationId,
  decision_id: d.decisionId,
  family_parent_record_id: d.familyRecordId,
  family_parent_id: d.familyParentId,
  owner_type: d.ownerType,
  owner_key: d.ownerKey,
  player_record_id: d.playerRecordId,
  source_type: d.sourceType,
  source_ref: d.sourceRef,
  stripe_charge_id: d.stripeChargeId,
  stripe_customer_id: d.stripeCustomerId,
  currency: d.currency,
  source_total_minor: d.sourceTotalMinor,
  source_credit_funded_minor: d.sourceCreditFundedMinor,
  source_card_funded_minor: d.sourceCardFundedMinor,
  returnable_before_minor: d.returnableBeforeMinor,
  decision_type: d.decisionType,
  return_minor: d.returnMinor,
  card_refund_minor: d.cardRefundMinor,
  credit_restored_minor: d.creditRestoredMinor,
  card_to_credit_minor: d.cardToCreditMinor,
  retained_minor: d.retainedMinor,
  execution_state: d.executionState,
  refund_state: d.refundState,
  stripe_refund_id: d.stripeRefundId,
  reason: d.reason,
  policy_kind: d.policyKind,
  policy_ref: d.policyRef,
  decided_at: d.decidedAt,
  decided_by: d.decidedBy,
  reversed_at: null,
  reversed_by: null,
  reverse_reason: null,
});
export const creditRow = (c: FamilyCredit) => ({
  organisation_id: c.organisationId,
  credit_id: c.creditId,
  family_parent_record_id: c.familyRecordId,
  family_parent_id: c.familyParentId,
  owner_type: c.ownerType,
  owner_key: c.ownerKey,
  currency: c.currency,
  original_minor: c.originalMinor,
  credit_funded_minor: c.creditFundedMinor,
  card_funded_minor: c.cardFundedMinor,
  origin_type: "refund_decision",
  origin_decision_id: c.originDecisionId,
  source_ref: c.sourceRef,
  created_at: c.createdAt,
  created_by: c.createdBy,
  reason: c.reason,
  voided_at: null,
  voided_by: null,
  void_kind: null,
  void_reason: null,
});

type Events = Record<string, unknown>[];

export const recordPayment = (svc: GrantStoreConfig, p: FamilyPayment, events: Events) => rpc(svc, RPC.payment, { p_payment: paymentRow(p), p_events: events });

export const applyCredit = (
  svc: GrantStoreConfig,
  a: { organisationId: string; paymentId: string; owner: CreditOwner; batchId: string; allocations: { applicationId: string; creditId: string; amountMinor: number; sequence: number }[]; at: string; by: string; reason: string | null },
  events: Events
) =>
  rpc(svc, RPC.apply, {
    p_org: a.organisationId,
    p_payment_id: a.paymentId,
    p_owner_type: a.owner.ownerType,
    p_owner_key: a.owner.ownerKey,
    p_batch_id: a.batchId,
    p_allocations: a.allocations.map((x) => ({ application_id: x.applicationId, credit_id: x.creditId, amount_minor: x.amountMinor, sequence: x.sequence })),
    p_applied_at: a.at,
    p_applied_by: a.by,
    p_reason: a.reason,
    p_events: events,
  });

export const recordDecision = (svc: GrantStoreConfig, d: RefundDecision, credit: FamilyCredit | null, expectedVersion: number, events: Events) =>
  rpc(svc, RPC.decision, { p_org: d.organisationId, p_source_ref: d.sourceRef, p_expected_version: expectedVersion, p_decision: decisionRow(d), p_credit: credit ? creditRow(credit) : null, p_events: events });

export const voidCredit = (svc: GrantStoreConfig, a: { organisationId: string; creditId: string; at: string; by: string; reason: string }, events: Events) =>
  rpc(svc, RPC.void, { p_org: a.organisationId, p_credit_id: a.creditId, p_at: a.at, p_by: a.by, p_reason: a.reason, p_events: events });

export const reverseDecision = (svc: GrantStoreConfig, a: { organisationId: string; decisionId: string; expectedVersion: number; at: string; by: string; reason: string }, events: Events) =>
  rpc(svc, RPC.reverse, { p_org: a.organisationId, p_decision_id: a.decisionId, p_expected_version: a.expectedVersion, p_at: a.at, p_by: a.by, p_reason: a.reason, p_events: events });

/** Guardians, their Parent-Player Links and the Players they name (one organisation per base today - see TEST-ENV.md FIN10.7). */
export async function loadHubFamilies(config: AirtableConfig): Promise<{ parents: HubRow[]; links: HubRow[]; players: HubRow[] }> {
  const [parents, links, players] = await Promise.all([
    listAll(config, HUB_TABLES.parents, ["Parent ID", "Parent / Guardian Name", "Active"]),
    listAll(config, HUB_TABLES.links, ["Parent / Guardian", "Player", "Link Lifecycle Status"]),
    listAll(config, HUB_TABLES.players, ["Player ID", "Player Name"]),
  ]);
  return { parents, links, players };
}
