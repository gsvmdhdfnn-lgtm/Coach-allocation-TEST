/**
 * Test-suite copy of the canonical finance/finance-family.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Parent / family credit + refund DECISION bridge - pure logic (Finance
 * Foundation F11; see TEST-ENV.md "Finance Foundation - F11").
 *
 * Domains:
 *   - Players & Parents owns guardians, children, memberships, cancellations.
 *   - Finance (here) owns the refund DECISION, family credit, the value
 *     allocation and the revenue-correction facts.
 *   - Stripe owns card payment truth and refund EXECUTION (F21, not built).
 *
 * Family = one verified guardian account (a Parents & Guardians record with a
 * unique Parent ID). Its eligible children are the players on its Verified
 * Parent-Player Links. A family is never inferred from surname, address,
 * email or a Stripe customer's name; two guardian accounts are never merged.
 *
 * Money is integer pence (GBP). A family's credit balance is DERIVED:
 * original amount minus applications, per credit. Credit is used oldest
 * first (created_at, then credit id), partial balances are kept, nothing is
 * rounded away. Family credit is not a discount: it pays an amount that is
 * already priced.
 *
 * A return of value never manufactures a funding source: the credit-funded
 * part of a source goes back to family credit, the card-funded part becomes a
 * Stripe refund obligation (Refund Due) unless Management explicitly keeps it
 * as family credit. A partial return of a mixed source is split in
 * proportion to the source's remaining credit- and card-funded parts (credit
 * share rounded down; the odd penny stays with the card share).
 *
 * Nothing here executes a refund, moves cash or calls Stripe.
 */
import { REASON_MAX, auditEvent, todayIn } from "./finance-commercial.ts";
import { formatMinor, isMinor, parseMoney } from "./finance-money.ts";

export const FAMILY_CONTRACT = "finance-family-v1";

export const PARENT_ID_PATTERN = /^PARENT-[A-Za-z0-9-]{1,48}$/;
export const PLAYER_ID_PATTERN = /^PL-[A-Za-z0-9-]{1,48}$/;
export const PAYMENT_ID_PATTERN = /^FFP-[0-9A-F]{12}$/;
export const CREDIT_ID_PATTERN = /^FFC-[0-9A-F]{12}$/;
export const DECISION_ID_PATTERN = /^FRD-[0-9A-F]{12}$/;
export const CHARGE_ID_PATTERN = /^ch_[A-Za-z0-9]{1,64}$/;
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";
export const MAX_WINDOW_DAYS = 366;

export const DECISION_TYPES = ["refund_to_card", "family_credit", "split", "no_return"] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
export const POLICY_KINDS = ["manual_management_decision", "occurrence_financial_outcome", "membership_cancellation", "parent_request", "booking_policy"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];
export type ExecutionState = "decided_no_return" | "credit_created" | "refund_due" | "split_refund_due";
/** F11 writes none / awaiting_refund_action only; refund_processing / refunded / refund_failed belong to F21. */
export type RefundState = "none" | "awaiting_refund_action" | "refund_processing" | "refunded" | "refund_failed";

export const FAMILY_EVENTS = {
  paymentRecorded: "finance_family.payment_recorded",
  creditApplied: "finance_family.credit_applied",
  decisionRecorded: "finance_family.refund_decision_recorded",
  creditCreated: "finance_family.credit_created",
  refundDueRecorded: "finance_family.refund_due_recorded",
  creditVoided: "finance_family.credit_voided",
  decisionReversed: "finance_family.refund_decision_reversed",
} as const;
export const ENTITY = { payment: "finance_family_payment", application: "finance_family_credit_application", decision: "finance_refund_decision", credit: "finance_family_credit" } as const;

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

export interface EligiblePlayer {
  recordId: string;
  playerId: string | null;
  name: string;
}
export interface Family {
  recordId: string;
  parentId: string;
  name: string;
  active: boolean;
  /** Active guardian with at least one Verified child link. Only a verified family can hold or use credit. */
  verified: boolean;
  eligiblePlayers: EligiblePlayer[];
}
export interface FamilyPayment {
  organisationId: string;
  paymentId: string;
  familyRecordId: string;
  familyParentId: string;
  playerRecordId: string | null;
  bookingRef: string | null;
  description: string;
  currency: "GBP";
  amountDueMinor: number;
  stripeChargeId: string | null;
  stripeCustomerId: string | null;
  stripeChargeMinor: number | null;
  createdAt: string;
  createdBy: string;
  reason: string;
}
export interface FamilyCredit {
  organisationId: string;
  creditId: string;
  familyRecordId: string;
  familyParentId: string;
  currency: "GBP";
  originalMinor: number;
  creditFundedMinor: number;
  cardFundedMinor: number;
  originDecisionId: string;
  sourceRef: string;
  createdAt: string;
  createdBy: string;
  reason: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidKind: "manual_void" | "decision_reversed" | null;
  voidReason: string | null;
}
export interface CreditApplication {
  organisationId: string;
  applicationId: string;
  batchId: string;
  sequence: number;
  creditId: string;
  paymentId: string;
  familyRecordId: string;
  amountMinor: number;
  appliedAt: string;
  appliedBy: string;
  reason: string | null;
}
export interface RefundDecision {
  organisationId: string;
  decisionId: string;
  familyRecordId: string;
  familyParentId: string;
  playerRecordId: string | null;
  sourceType: "stripe_charge" | "family_payment";
  sourceRef: string;
  stripeChargeId: string | null;
  stripeCustomerId: string | null;
  currency: "GBP";
  sourceTotalMinor: number;
  sourceCreditFundedMinor: number;
  sourceCardFundedMinor: number;
  returnableBeforeMinor: number;
  decisionType: DecisionType;
  returnMinor: number;
  cardRefundMinor: number;
  creditRestoredMinor: number;
  cardToCreditMinor: number;
  retainedMinor: number;
  executionState: ExecutionState;
  refundState: RefundState;
  stripeRefundId: string | null;
  reason: string;
  policyKind: PolicyKind;
  policyRef: string | null;
  decidedAt: string;
  decidedBy: string;
  reversedAt: string | null;
  reversedBy: string | null;
  reverseReason: string | null;
}
export interface Ledger {
  payments: FamilyPayment[];
  credits: FamilyCredit[];
  applications: CreditApplication[];
  decisions: RefundDecision[];
  versions: Map<string, number>;
}

export const m = (minor: number) => formatMinor(minor);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** FFP- / FFC- / FFA- / FFB- / FRD- + 12 upper-case hex. */
export function newId(prefix: "FFP" | "FFC" | "FFA" | "FFB" | "FRD", random: () => string = () => crypto.randomUUID()): string {
  return `${prefix}-${random().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

// ---------------------------------------------------------------------
// Family identity (verified guardian account; never inferred)
// ---------------------------------------------------------------------

export type HubRow = { id: string; fields: Record<string, any> };
const selectName = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** Every guardian account with its Verified children, by record id. */
export function familiesOf(parents: HubRow[], parentPlayerLinks: HubRow[], players: HubRow[]): Map<string, Family> {
  const playerById = new Map(players.map((p) => [p.id, p]));
  const verified = new Map<string, Set<string>>();
  for (const l of parentPlayerLinks) {
    if (selectName(l.fields["Link Lifecycle Status"]) !== "Verified") continue;
    for (const p of links(l.fields["Parent / Guardian"])) {
      const set = verified.get(p) ?? new Set<string>();
      for (const pl of links(l.fields.Player)) set.add(pl);
      verified.set(p, set);
    }
  }
  const out = new Map<string, Family>();
  for (const p of parents) {
    const eligiblePlayers = [...(verified.get(p.id) ?? [])].sort().map((id) => {
      const row = playerById.get(id);
      return { recordId: id, playerId: typeof row?.fields["Player ID"] === "string" ? row.fields["Player ID"].trim() || null : null, name: typeof row?.fields["Player Name"] === "string" ? row.fields["Player Name"] : "" };
    });
    const active = p.fields.Active === true;
    out.set(p.id, {
      recordId: p.id,
      parentId: typeof p.fields["Parent ID"] === "string" ? p.fields["Parent ID"].trim() : "",
      name: typeof p.fields["Parent / Guardian Name"] === "string" ? p.fields["Parent / Guardian Name"] : "",
      active,
      verified: active && eligiblePlayers.length > 0,
      eligiblePlayers,
    });
  }
  return out;
}

export type Refusal = { ok: false; httpStatus: 400 | 403 | 404 | 409; code: string; error: string; details?: Record<string, unknown> };
export const refuse = (httpStatus: Refusal["httpStatus"], code: string, error: string, details?: Record<string, unknown>): Refusal => ({ ok: false, httpStatus, code, error, ...(details ? { details } : {}) });

/** The ONE guardian account carrying this Parent ID (a duplicate Parent ID is refused, never guessed). */
export function familyByParentId(families: Map<string, Family>, parentId: string): { ok: true; family: Family } | Refusal {
  const hits = [...families.values()].filter((f) => f.parentId === parentId);
  if (!hits.length) return refuse(404, "parent_not_found", `No Hub parent has Parent ID ${parentId}`);
  if (hits.length > 1) return refuse(409, "parent_id_ambiguous", `${hits.length} Hub parent records carry Parent ID ${parentId} - the Hub will not guess which family it is; fix the duplicate first`, { parentRecordIds: hits.map((h) => h.recordId) });
  return { ok: true, family: hits[0] };
}

/** A child reference must be one of THIS family's verified children. */
export function eligiblePlayer(family: Family, playerId: string): { ok: true; player: EligiblePlayer } | Refusal {
  const p = family.eligiblePlayers.find((x) => x.playerId === playerId);
  return p ? { ok: true, player: p } : refuse(409, "player_not_eligible", `${playerId} is not a verified child of ${family.parentId} - family credit and refunds are only for this family's verified children`);
}

// ---------------------------------------------------------------------
// Family credit ledger (balances derived, oldest first)
// ---------------------------------------------------------------------

export const appliedTo = (creditId: string, apps: CreditApplication[]) => sum(apps.filter((a) => a.creditId === creditId).map((a) => a.amountMinor));
export const creditRemaining = (c: FamilyCredit, apps: CreditApplication[]) => (c.voidedAt ? 0 : c.originalMinor - appliedTo(c.creditId, apps));

export function creditStatus(c: FamilyCredit, apps: CreditApplication[]): "available" | "partially_used" | "used" | "voided" {
  if (c.voidedAt) return "voided";
  const used = appliedTo(c.creditId, apps);
  return used === 0 ? "available" : used >= c.originalMinor ? "used" : "partially_used";
}

/** The locked order: oldest eligible credit first (created_at, then credit id - deterministic). */
export const oldestFirst = (a: FamilyCredit, b: FamilyCredit) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.creditId < b.creditId ? -1 : a.creditId > b.creditId ? 1 : 0);

export function familyBalanceMinor(familyRecordId: string, l: Pick<Ledger, "credits" | "applications">): number {
  return sum(l.credits.filter((c) => c.familyRecordId === familyRecordId).map((c) => creditRemaining(c, l.applications)));
}

export type Allocation = { creditId: string; amountMinor: number; sequence: number; remainingAfterMinor: number };

/** Uses `amountMinor` of the family's credit, oldest first, never more than a credit holds; partial balances stay. */
export function planApplication(familyRecordId: string, l: Pick<Ledger, "credits" | "applications">, amountMinor: number): { ok: true; allocations: Allocation[] } | Refusal {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return refuse(400, "invalid_input", "The amount to apply must be more than zero");
  const usable = l.credits
    .filter((c) => c.familyRecordId === familyRecordId && !c.voidedAt)
    .sort(oldestFirst)
    .map((c) => ({ c, left: creditRemaining(c, l.applications) }))
    .filter((x) => x.left > 0);
  const balance = sum(usable.map((x) => x.left));
  if (amountMinor > balance) return refuse(409, "insufficient_credit", `The family has ${m(balance)} of credit available - ${m(amountMinor)} cannot be applied`, { availableCredit: m(balance) });
  const allocations: Allocation[] = [];
  let need = amountMinor;
  for (const x of usable) {
    if (!need) break;
    const take = Math.min(x.left, need);
    allocations.push({ creditId: x.c.creditId, amountMinor: take, sequence: allocations.length + 1, remainingAfterMinor: x.left - take });
    need -= take;
  }
  return { ok: true, allocations };
}

/** How a family payment was paid: credit applications + the linked Stripe charge; the rest is unfunded (not paid). */
export function paymentFunding(p: FamilyPayment, apps: CreditApplication[]) {
  const creditFundedMinor = sum(apps.filter((a) => a.paymentId === p.paymentId).map((a) => a.amountMinor));
  const cardFundedMinor = p.stripeChargeMinor ?? 0;
  return { dueMinor: p.amountDueMinor, creditFundedMinor, cardFundedMinor, unfundedMinor: p.amountDueMinor - creditFundedMinor - cardFundedMinor };
}

// ---------------------------------------------------------------------
// Returnable balance of one source
// ---------------------------------------------------------------------

export type StripeRefundFact = { refundId: string; amountMinor: number; status: string };
export interface SourceFunding {
  sourceType: "stripe_charge" | "family_payment";
  sourceRef: string;
  totalMinor: number;
  creditFundedMinor: number;
  cardFundedMinor: number;
}

/**
 * original returnable value
 *   - family credit already created from it (credit-funded restorations + card value kept as credit)
 *   - card refunds already decided (Refund Due) or executed
 *   - Stripe refunds that no Hub decision accounts for (succeeded or pending)
 * = remaining returnable, never below zero. A recorded "no return" closes the source until reversed.
 */
export function returnableOf(src: SourceFunding, decisions: RefundDecision[], stripeRefunds: StripeRefundFact[]) {
  const live = decisions.filter((d) => d.sourceRef === src.sourceRef && !d.reversedAt);
  const prior = {
    creditRestoredMinor: sum(live.map((d) => d.creditRestoredMinor)),
    cardRefundMinor: sum(live.map((d) => d.cardRefundMinor)),
    cardToCreditMinor: sum(live.map((d) => d.cardToCreditMinor)),
    retainedMinor: sum(live.map((d) => d.retainedMinor)),
  };
  const matched = new Set(decisions.map((d) => d.stripeRefundId).filter(Boolean));
  const counted = stripeRefunds.filter((r) => (r.status === "succeeded" || r.status === "pending" || r.status === "requires_action") && !matched.has(r.refundId));
  const externalMinor = sum(counted.map((r) => r.amountMinor));
  const creditFundedRemainingMinor = Math.max(0, src.creditFundedMinor - prior.creditRestoredMinor);
  const cardRaw = src.cardFundedMinor - prior.cardRefundMinor - prior.cardToCreditMinor - externalMinor;
  const closed = live.some((d) => d.decisionType === "no_return");
  const cardFundedRemainingMinor = Math.max(0, cardRaw);
  return {
    prior,
    closedByNoReturn: closed,
    creditFundedRemainingMinor: closed ? 0 : creditFundedRemainingMinor,
    cardFundedRemainingMinor: closed ? 0 : cardFundedRemainingMinor,
    returnableMinor: closed ? 0 : creditFundedRemainingMinor + cardFundedRemainingMinor,
    external: {
      refunds: counted.map((r) => ({ refundId: r.refundId, amount: m(r.amountMinor), status: r.status })),
      amountMinor: externalMinor,
      /** Stripe already refunded money no Hub decision explains (F21 later links its own refunds). Surfaced, never fabricated into history. */
      state: externalMinor === 0 ? "none" : externalMinor >= src.cardFundedMinor ? "fully_refunded_in_stripe_without_hub_decision" : "partially_refunded_in_stripe_without_hub_decision",
      /** Stripe refunded more than the Hub thinks is still card-refundable (e.g. refunded outside the Hub after a decision). */
      mismatchMinor: cardRaw < 0 ? -cardRaw : 0,
    },
  };
}

// ---------------------------------------------------------------------
// A decision's value allocation
// ---------------------------------------------------------------------

export interface DecisionRequest {
  decisionType: DecisionType;
  amountMinor: number | null;
  cardRefundMinor: number | null;
}
export interface DecisionAmounts {
  returnMinor: number;
  creditRestoredMinor: number;
  cardRefundMinor: number;
  cardToCreditMinor: number;
  retainedMinor: number;
}

/**
 * Splits a return between the source's credit-funded and card-funded parts
 * (in proportion to what remains of each; a full return takes all of both),
 * then routes them: credit-funded -> family credit always; card-funded ->
 * card refund (refund_to_card), family credit (family_credit), or both
 * (split, cardRefundAmount to card and the rest to credit).
 */
export function planDecision(r: ReturnType<typeof returnableOf>, req: DecisionRequest, familyVerified: boolean): { ok: true; amounts: DecisionAmounts } | Refusal {
  if (r.closedByNoReturn) return refuse(409, "source_closed_no_return", "A 'no return' decision already covers this payment - reverse it first if that was a mistake");
  const avail = r.returnableMinor;
  if (req.decisionType === "no_return") {
    if (req.amountMinor !== null || req.cardRefundMinor !== null) return refuse(400, "invalid_input", "A 'no return' decision takes no amounts");
    if (avail === 0) return refuse(409, "nothing_returnable", "Nothing remains returnable on this payment");
    return { ok: true, amounts: { returnMinor: 0, creditRestoredMinor: 0, cardRefundMinor: 0, cardToCreditMinor: 0, retainedMinor: avail } };
  }
  if (avail === 0) return refuse(409, "nothing_returnable", "Nothing remains returnable on this payment (already returned, refunded in Stripe, or decided)");
  const total = req.amountMinor ?? avail;
  if (total <= 0) return refuse(400, "invalid_input", "The amount to return must be more than zero");
  if (total > avail) return refuse(409, "over_return", `Only ${m(avail)} remains returnable on this payment - ${m(total)} cannot be returned`, { returnable: m(avail) });
  const cr = r.creditFundedRemainingMinor;
  const kr = r.cardFundedRemainingMinor;
  let x = total === avail ? cr : Number((BigInt(total) * BigInt(cr)) / BigInt(avail));
  let y = total - x;
  if (y > kr) {
    x += y - kr;
    y = kr;
  }
  let cardRefund = 0;
  let cardToCredit = 0;
  if (req.decisionType === "refund_to_card") {
    if (y === 0) return refuse(409, "no_card_funded_value", "None of this return was paid by card - credit-funded value can only go back to family credit (choose family_credit)");
    if (req.cardRefundMinor !== null) return refuse(400, "invalid_input", "cardRefundAmount is only for a split decision");
    cardRefund = y;
  } else if (req.decisionType === "family_credit") {
    if (req.cardRefundMinor !== null) return refuse(400, "invalid_input", "cardRefundAmount is only for a split decision");
    cardToCredit = y;
  } else {
    if (y === 0) return refuse(409, "no_card_funded_value", "None of this return was paid by card, so it cannot be split with a card refund");
    if (req.cardRefundMinor === null) return refuse(400, "invalid_input", "A split needs cardRefundAmount (the part going back to the card)");
    if (req.cardRefundMinor <= 0 || req.cardRefundMinor >= y) return refuse(409, "invalid_split", `The card part of a split must be more than 0.00 and less than the card-funded ${m(y)} of this return`, { cardFundedInThisReturn: m(y) });
    cardRefund = req.cardRefundMinor;
    cardToCredit = y - cardRefund;
  }
  if (x + cardToCredit > 0 && !familyVerified) return refuse(409, "family_not_verified", "This guardian has no verified child, so family credit cannot be created - only a card refund of card-funded value is possible");
  return { ok: true, amounts: { returnMinor: total, creditRestoredMinor: x, cardRefundMinor: cardRefund, cardToCreditMinor: cardToCredit, retainedMinor: 0 } };
}

export function executionStateOf(type: DecisionType, a: DecisionAmounts): ExecutionState {
  if (type === "no_return") return "decided_no_return";
  const credit = a.creditRestoredMinor + a.cardToCreditMinor;
  return a.cardRefundMinor > 0 ? (credit > 0 ? "split_refund_due" : "refund_due") : "credit_created";
}
export const refundStateOf = (a: DecisionAmounts): RefundState => (a.cardRefundMinor > 0 ? "awaiting_refund_action" : "none");

// ---------------------------------------------------------------------
// Revenue-correction facts (decision -> reporting later; no cash, no costs)
// ---------------------------------------------------------------------

export function revenueCorrectionsOf(d: RefundDecision, credit: FamilyCredit | null, tz: string) {
  const base = { decisionId: d.decisionId, sourceType: d.sourceType, sourceRef: d.sourceRef, parentId: d.familyParentId, currency: d.currency, source: "parent_finance_decision" as const };
  const at = (iso: string) => todayIn(tz, new Date(iso));
  const out: Record<string, unknown>[] = [];
  const credited = d.creditRestoredMinor + d.cardToCreditMinor;
  if (credited > 0) out.push({ ...base, type: "family_credit", amount: m(credited), fundedBy: { creditFunded: m(d.creditRestoredMinor), cardFunded: m(d.cardToCreditMinor) }, date: at(d.decidedAt), cashImpact: "none", businessCost: false });
  if (d.cardRefundMinor > 0) out.push({ ...base, type: "refund_due", amount: m(d.cardRefundMinor), date: at(d.decidedAt), cashImpact: "none_yet", expectedCashOut: m(d.cardRefundMinor), executedBy: "F21 (not built) - cash leaves only when Stripe refunds", businessCost: false });
  if (d.decisionType === "no_return") out.push({ ...base, type: "no_return", amount: m(0), retained: m(d.retainedMinor), date: at(d.decidedAt), cashImpact: "none", businessCost: false });
  if (credit?.voidedAt && credit.voidKind === "manual_void") out.push({ ...base, type: "family_credit_voided", amount: m(-credit.originalMinor), date: at(credit.voidedAt), cashImpact: "none", businessCost: false });
  if (d.reversedAt) {
    if (credited > 0 && !(credit?.voidKind === "manual_void")) out.push({ ...base, type: "decision_reversed", amount: m(-credited), reverses: "family_credit", date: at(d.reversedAt), cashImpact: "none", businessCost: false });
    if (d.cardRefundMinor > 0) out.push({ ...base, type: "decision_reversed", amount: m(-d.cardRefundMinor), reverses: "refund_due", date: at(d.reversedAt), cashImpact: "none", businessCost: false });
  }
  return out;
}

// ---------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------

export function creditView(c: FamilyCredit, apps: CreditApplication[]) {
  const own = apps.filter((a) => a.creditId === c.creditId).sort((a, b) => (a.appliedAt < b.appliedAt ? -1 : a.appliedAt > b.appliedAt ? 1 : a.sequence - b.sequence));
  return {
    creditId: c.creditId,
    parentId: c.familyParentId,
    currency: c.currency,
    original: m(c.originalMinor),
    remaining: m(creditRemaining(c, apps)),
    status: creditStatus(c, apps),
    fundedBy: { creditFunded: m(c.creditFundedMinor), cardFunded: m(c.cardFundedMinor) },
    createdAt: c.createdAt,
    reason: c.reason,
    origin: { type: "refund_decision", decisionId: c.originDecisionId, sourceRef: c.sourceRef },
    voided: c.voidedAt ? { at: c.voidedAt, kind: c.voidKind, reason: c.voidReason } : null,
    /** Not a discount: it pays an amount that was priced first. */
    isDiscount: false,
    applications: own.map((a) => ({ applicationId: a.applicationId, paymentId: a.paymentId, amount: m(a.amountMinor), appliedAt: a.appliedAt, order: a.sequence })),
  };
}

export function decisionView(d: RefundDecision, credit: FamilyCredit | null, family: Family | undefined, tz: string) {
  const player = d.playerRecordId ? family?.eligiblePlayers.find((p) => p.recordId === d.playerRecordId) : undefined;
  return {
    decisionId: d.decisionId,
    family: { parentId: d.familyParentId, name: family?.name ?? null },
    player: d.playerRecordId ? { playerId: player?.playerId ?? null, name: player?.name ?? null } : null,
    source: { type: d.sourceType, ref: d.sourceRef, originalPaid: m(d.sourceTotalMinor), creditFunded: m(d.sourceCreditFundedMinor), cardFunded: m(d.sourceCardFundedMinor), returnableBefore: m(d.returnableBeforeMinor) },
    decisionType: d.decisionType,
    returned: m(d.returnMinor),
    creditPortion: m(d.creditRestoredMinor + d.cardToCreditMinor),
    refundPortion: m(d.cardRefundMinor),
    retained: m(d.retainedMinor),
    reason: d.reason,
    policy: { kind: d.policyKind, ref: d.policyRef },
    status: { execution: d.reversedAt ? "reversed" : d.executionState, refund: d.reversedAt ? "none" : d.refundState },
    decidedAt: d.decidedAt,
    reversed: d.reversedAt ? { at: d.reversedAt, reason: d.reverseReason } : null,
    familyCreditId: credit?.creditId ?? null,
    cash: { movedNow: m(0), expectedOutLater: d.reversedAt ? m(0) : m(d.cardRefundMinor), note: "Nothing has left the business: a card refund is only an obligation until F21 executes it in Stripe" },
    revenueCorrections: revenueCorrectionsOf(d, credit, tz),
    /** Technical Stripe ids, one level deeper. */
    technical: { stripeChargeId: d.stripeChargeId, stripeCustomerId: d.stripeCustomerId, stripeRefundId: d.stripeRefundId },
  };
}

/** The simple parent-facing summary ("Credit available: 25.00 / Refund: 40.00 awaiting processing"). */
export function parentSummary(familyRecordId: string, l: Ledger) {
  const awaiting = l.decisions.filter((d) => d.familyRecordId === familyRecordId && !d.reversedAt && d.refundState === "awaiting_refund_action");
  return {
    creditAvailable: m(familyBalanceMinor(familyRecordId, l)),
    refunds: awaiting.map((d) => ({ amount: m(d.cardRefundMinor), status: "awaiting processing" })),
  };
}

export function familyAudit(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: FAMILY_CONTRACT } };
}

// ---------------------------------------------------------------------
// Routes + requests
// ---------------------------------------------------------------------

export type FamilyRoute =
  | { name: "family.credits"; params: Record<string, never> }
  | { name: "family.family"; params: { parentId: string } }
  | { name: "family.apply"; params: Record<string, never> }
  | { name: "family.void"; params: { creditId: string } }
  | { name: "family.payments"; params: Record<string, never> }
  | { name: "family.decisions"; params: Record<string, never> }
  | { name: "family.decision"; params: { decisionId: string } }
  | { name: "family.reverse"; params: { decisionId: string } }
  | { name: "family.source"; params: { sourceRef: string } }
  | { name: "family.corrections"; params: Record<string, never> };
export type FamilyMatch = { status: "match"; route: FamilyRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

const ROOTS = ["family-credits", "family-payments", "refund-decisions", "refund-sources", "revenue-corrections"];

/** F11 owns these paths. There is deliberately no route that executes a refund or touches Stripe (F21). */
export function matchFamilyRoute(path: string, method: string): FamilyMatch {
  const seg = path.split("/");
  if (!ROOTS.includes(seg[0])) return null;
  const mt = (allowed: string[], route: FamilyRoute): FamilyMatch => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg.length === 1 && seg[0] === "family-credits") return mt(["GET"], { name: "family.credits", params: {} });
  if (seg.length === 2 && seg[0] === "family-credits" && seg[1] === "apply") return mt(["POST"], { name: "family.apply", params: {} });
  if (seg.length === 2 && seg[0] === "family-credits" && PARENT_ID_PATTERN.test(seg[1])) return mt(["GET"], { name: "family.family", params: { parentId: seg[1] } });
  if (seg.length === 3 && seg[0] === "family-credits" && CREDIT_ID_PATTERN.test(seg[1]) && seg[2] === "void") return mt(["POST"], { name: "family.void", params: { creditId: seg[1] } });
  if (seg.length === 1 && seg[0] === "family-payments") return mt(["POST"], { name: "family.payments", params: {} });
  if (seg.length === 1 && seg[0] === "refund-decisions") return mt(["GET", "POST"], { name: "family.decisions", params: {} });
  if (seg.length === 2 && seg[0] === "refund-decisions" && DECISION_ID_PATTERN.test(seg[1])) return mt(["GET"], { name: "family.decision", params: { decisionId: seg[1] } });
  if (seg.length === 3 && seg[0] === "refund-decisions" && DECISION_ID_PATTERN.test(seg[1]) && seg[2] === "reverse") return mt(["POST"], { name: "family.reverse", params: { decisionId: seg[1] } });
  if (seg.length === 2 && seg[0] === "refund-sources" && (CHARGE_ID_PATTERN.test(seg[1]) || PAYMENT_ID_PATTERN.test(seg[1]))) return mt(["GET"], { name: "family.source", params: { sourceRef: seg[1] } });
  if (seg.length === 1 && seg[0] === "revenue-corrections") return mt(["GET"], { name: "family.corrections", params: {} });
  return { status: "not_found" };
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

export type FamilyQuery = { ok: true; parentId?: string; state?: string; from?: string; to?: string };
const STATES = ["decided_no_return", "credit_created", "refund_due", "split_refund_due", "awaiting_refund_action", "reversed"];

export function parseFamilyQuery(route: FamilyRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): FamilyQuery | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const allowed: Partial<Record<FamilyRoute["name"], string[]>> = { "family.credits": ["parentId"], "family.decisions": ["parentId", "state"], "family.corrections": ["from", "to"] };
  const ok = allowed[route] ?? [];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(bad)].join(", ")}`);
  if (new Set(keys).size !== keys.length) return invalid("unexpected_parameter", "A query parameter is repeated");
  const out: FamilyQuery = { ok: true };
  const p = q.get("parentId");
  if (p !== null) {
    if (!PARENT_ID_PATTERN.test(p)) return invalid("invalid_query", "parentId must be a Hub Parent ID (PARENT-...)");
    out.parentId = p;
  }
  const s = q.get("state");
  if (s !== null) {
    if (!STATES.includes(s)) return invalid("invalid_query", `state must be one of ${STATES.join(", ")}`);
    out.state = s;
  }
  for (const k of ["from", "to"] as const) {
    const v = q.get(k);
    if (v === null) continue;
    if (!DATE_RE.test(v) || isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return invalid("invalid_query", `${k} must be a date YYYY-MM-DD`);
    out[k] = v;
  }
  return out;
}

/** Inclusive local-date window for revenue corrections (default: the last 30 days), at most MAX_WINDOW_DAYS. */
export function correctionWindow(from: string | undefined, to: string | undefined, today: string): { ok: true; from: string; to: string } | Invalid {
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const t = to ?? today;
  const f = from ?? shift(t, -29);
  if (f > t) return invalid("invalid_query", "from must be on or before to");
  if ((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000 + 1 > MAX_WINDOW_DAYS) return invalid("invalid_query", `The window may be at most ${MAX_WINDOW_DAYS} days`);
  return { ok: true, from: f, to: t };
}

function jsonObject(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean): { ok: true; body: Record<string, unknown> } | Invalid {
  if (!raw.trim()) return invalid("invalid_body", "Body must be a JSON object");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")}`);
  return { ok: true, body: body as Record<string, unknown> };
}
function text(v: unknown, required: boolean, max = REASON_MAX): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if (CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}
function amount(v: unknown, required: boolean): { ok: true; minor: number | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, minor: null };
  const r = parseMoney(v);
  if (!r.ok) return { ok: false, error: r.error };
  if (!isMinor(r.minor) || r.minor <= 0) return { ok: false, error: "must be more than 0.00" };
  return { ok: true, minor: r.minor };
}
const pattern = (v: unknown, re: RegExp, required: boolean, what: string): { ok: true; value: string | null } | { ok: false; error: string } => {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  return typeof v === "string" && re.test(v.trim()) ? { ok: true, value: v.trim() } : { ok: false, error: `must be ${what}` };
};
function collect<T>(fields: Record<string, string>, k: string, r: { ok: true } & T | { ok: false; error: string }): T | null {
  if (!r.ok) {
    fields[k] = (r as { error: string }).error;
    return null;
  }
  return r as T;
}

export type PaymentInput = { ok: true; parentId: string; amountMinor: number; description: string; playerId: string | null; bookingRef: string | null; stripeChargeId: string | null; reason: string };
/** POST /family-payments { parentId, amount, description, playerId?, bookingRef?, stripeChargeId?, reason } - a parent payable (priced first) and how it is paid. */
export function parseFamilyPayment(raw: string, isTenantKey: (k: string) => boolean): PaymentInput | Invalid {
  const b = jsonObject(raw, ["parentId", "amount", "description", "playerId", "bookingRef", "stripeChargeId", "reason"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const parent = collect<{ value: string | null }>(f, "parentId", pattern(b.body.parentId, PARENT_ID_PATTERN, true, "a Hub Parent ID (PARENT-...)"));
  const amt = collect<{ minor: number | null }>(f, "amount", amount(b.body.amount, true));
  const desc = collect<{ value: string | null }>(f, "description", text(b.body.description, true, 200));
  const player = collect<{ value: string | null }>(f, "playerId", pattern(b.body.playerId, PLAYER_ID_PATTERN, false, "a Hub Player ID (PL-...)"));
  const booking = collect<{ value: string | null }>(f, "bookingRef", text(b.body.bookingRef, false, 120));
  const charge = collect<{ value: string | null }>(f, "stripeChargeId", pattern(b.body.stripeChargeId, CHARGE_ID_PATTERN, false, "a Stripe charge id (ch_...)"));
  const reason = collect<{ value: string | null }>(f, "reason", text(b.body.reason, true));
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was recorded", f);
  return { ok: true, parentId: parent!.value!, amountMinor: amt!.minor!, description: desc!.value!, playerId: player!.value, bookingRef: booking!.value, stripeChargeId: charge!.value, reason: reason!.value! };
}

export type ApplyInput = { ok: true; parentId: string; paymentId: string; amountMinor: number | null; reason: string | null };
/** POST /family-credits/apply { parentId, paymentId, amount?, reason? } - parentId is the family whose credit is spent. */
export function parseApply(raw: string, isTenantKey: (k: string) => boolean): ApplyInput | Invalid {
  const b = jsonObject(raw, ["parentId", "paymentId", "amount", "reason"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const parent = collect<{ value: string | null }>(f, "parentId", pattern(b.body.parentId, PARENT_ID_PATTERN, true, "a Hub Parent ID (PARENT-...)"));
  const pay = collect<{ value: string | null }>(f, "paymentId", pattern(b.body.paymentId, PAYMENT_ID_PATTERN, true, "a family payment id (FFP-...)"));
  const amt = collect<{ minor: number | null }>(f, "amount", amount(b.body.amount, false));
  const reason = collect<{ value: string | null }>(f, "reason", text(b.body.reason, false));
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - no credit was applied", f);
  return { ok: true, parentId: parent!.value!, paymentId: pay!.value!, amountMinor: amt!.minor, reason: reason!.value };
}

export type DecisionInput = { ok: true; source: string; parentId: string; playerId: string | null; reason: string; policyKind: PolicyKind; policyRef: string | null } & DecisionRequest;
/** POST /refund-decisions { source, parentId, decisionType, amount?, cardRefundAmount?, playerId?, reason, policy?: { kind, ref? } } */
export function parseDecision(raw: string, isTenantKey: (k: string) => boolean): DecisionInput | Invalid {
  const b = jsonObject(raw, ["source", "parentId", "decisionType", "amount", "cardRefundAmount", "playerId", "reason", "policy"], isTenantKey);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const src = b.body.source;
  if (typeof src !== "string" || !(CHARGE_ID_PATTERN.test(src) || PAYMENT_ID_PATTERN.test(src))) f.source = "must be a Stripe charge id (ch_...) or a family payment id (FFP-...)";
  const parent = collect<{ value: string | null }>(f, "parentId", pattern(b.body.parentId, PARENT_ID_PATTERN, true, "a Hub Parent ID (PARENT-...)"));
  const type = b.body.decisionType;
  if (typeof type !== "string" || !(DECISION_TYPES as readonly string[]).includes(type)) f.decisionType = `must be one of ${DECISION_TYPES.join(", ")}`;
  const amt = collect<{ minor: number | null }>(f, "amount", amount(b.body.amount, false));
  const card = collect<{ minor: number | null }>(f, "cardRefundAmount", amount(b.body.cardRefundAmount, false));
  const player = collect<{ value: string | null }>(f, "playerId", pattern(b.body.playerId, PLAYER_ID_PATTERN, false, "a Hub Player ID (PL-...)"));
  const reason = collect<{ value: string | null }>(f, "reason", text(b.body.reason, true));
  let policyKind: PolicyKind = "manual_management_decision";
  let policyRef: string | null = null;
  const pol = b.body.policy;
  if (pol !== undefined && pol !== null) {
    const o = pol as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "kind" && k !== "ref")) f.policy = "must be { kind, ref? }";
    else if (typeof o.kind !== "string" || !(POLICY_KINDS as readonly string[]).includes(o.kind)) f.policy = `kind must be one of ${POLICY_KINDS.join(", ")}`;
    else {
      const r = text(o.ref, false, 120);
      if (!r.ok) f.policy = `ref ${r.error}`;
      else if (o.kind !== "manual_management_decision" && !r.value) f.policy = "ref is required for this kind (the record the policy outcome came from)";
      else {
        policyKind = o.kind as PolicyKind;
        policyRef = r.value;
      }
    }
  }
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was decided", f);
  return { ok: true, source: src as string, parentId: parent!.value!, decisionType: type as DecisionType, amountMinor: amt!.minor, cardRefundMinor: card!.minor, playerId: player!.value, reason: reason!.value!, policyKind, policyRef };
}

/** POST /family-credits/{id}/void and /refund-decisions/{id}/reverse: { reason } (required). */
export function parseReason(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey);
  if (!b.ok) return b;
  const r = text(b.body.reason, true);
  if (!r.ok) return invalid("invalid_input", "A reason is required - nothing was changed", { reason: r.error });
  return { ok: true, reason: r.value! };
}

export const isRecordId = (v: unknown) => typeof v === "string" && RECORD_ID_RE.test(v);
