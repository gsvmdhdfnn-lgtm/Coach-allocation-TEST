/**
 * Parent / family credit + refund DECISION bridge - orchestration (Finance
 * Foundation F11; see TEST-ENV.md "Finance Foundation - F11"). Every route
 * authorises through F1's authorizeFinance() first: View reads, Manage writes.
 *
 * Reads (View, never audited): family credits, one family (balance, history,
 * payments, decisions + the simple parent summary), refund decisions, one
 * refund source's returnable balance, revenue-correction facts.
 *
 * Writes (Manage, under the Finance write lock, each ONE atomic database call
 * that also writes its audit rows):
 *   - POST /family-payments           a parent payable and how it is paid
 *   - POST /family-credits/apply      family credit, oldest first
 *   - POST /refund-decisions          refund to card / family credit / split / no return
 *   - POST /family-credits/{id}/void  unused credit only
 *   - POST /refund-decisions/{id}/reverse  only while nothing is spent or executed
 *
 * Stripe is READ only (F10's provider, GET): the source charge, its refunds.
 * A card refund decision is an obligation ("Refund Due / awaiting refund
 * action"); no Stripe call, no cash movement, no refund receipt - F21 executes.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import { idOf, currencyOf } from "./finance-stripe.ts";
import { loadCustomerLinks } from "./finance-stripe-repository.ts";
import { type StripeDeps, type StripeSession, openStripeSession, providerFailure, recordStripeHealth } from "./finance-stripe-orchestrator.ts";
import {
  type DecisionInput,
  type Family,
  type FamilyCredit,
  type FamilyPayment,
  type Ledger,
  type RefundDecision,
  type Refusal,
  type SourceFunding,
  type StripeRefundFact,
  ENTITY,
  FAMILY_CONTRACT,
  FAMILY_EVENTS,
  correctionWindow,
  creditStatus,
  creditView,
  decisionView,
  eligiblePlayer,
  executionStateOf,
  familiesOf,
  familyAudit,
  familyBalanceMinor,
  familyByParentId,
  m,
  newId,
  ownerOf,
  parentSummary,
  paymentFunding,
  planApplication,
  planDecision,
  refundStateOf,
  returnableOf,
  revenueCorrectionsOf,
  sameOwner,
} from "./finance-family.ts";
import { LedgerRefusal, applyCredit, loadHubFamilies, loadLedger, recordDecision, recordPayment, reverseDecision, voidCredit } from "./finance-family-repository.ts";

export interface FamilyDeps extends StripeDeps {
  family?: { random?: () => string };
}

export type FFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 502 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: FFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): FFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is FFail => !!x && typeof x === "object" && (x as any).status === "error";
const fromRefusal = (r: Refusal): FFail => fail(r.httpStatus, r.code, r.error, r.details);

const now = (deps: FamilyDeps) => (deps.clock ?? (() => new Date()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_family_unavailable", "Family credit and refund decisions could not be loaded just now - try again");
const id = (deps: FamilyDeps, prefix: Parameters<typeof newId>[0]) => newId(prefix, deps.family?.random);

/** Database rule refusals in Management's words (the write did not happen). */
const LEDGER_MESSAGES: Record<string, string> = {
  source_changed: "This payment's refund history was changed by someone else just now - reload and decide again",
  credit_used: "This credit has already been used - it cannot be voided or taken back",
  credit_already_voided: "This credit is already voided",
  credit_voided_separately: "This decision's credit was voided separately - the decision cannot be reversed",
  decision_already_reversed: "This decision is already reversed",
  refund_in_progress: "The card refund is already being executed - the decision cannot be reversed here",
  not_oldest_first: "The family's credit changed just now - reload and apply again",
  insufficient_credit: "The family's credit changed just now - there is not enough left",
  over_application: "That is more than is still unpaid on this payment",
  cross_family: "One family's credit cannot pay another family's payment",
  payment_has_decisions: "A refund decision exists for this payment - credit can no longer be applied to it",
  charge_already_recorded: "This Stripe charge is already part of a family payment",
  charge_already_a_refund_source: "A refund decision already exists for this Stripe charge on its own",
  charge_belongs_to_family_payment: "This Stripe charge is part of a family payment - decide on the family payment instead",
};
function ledgerFail(e: unknown): FFail | null {
  if (e instanceof LedgerRefusal) return fail(409, e.code, LEDGER_MESSAGES[e.code] ?? "The change was refused by the ledger's rules - nothing was changed");
  return null;
}

type Ctx = { org: OrganisationContext; access: string; ledger: Ledger; families: Map<string, Family> };

async function load(deps: FamilyDeps, org: OrganisationContext, access: string): Promise<Ctx | FFail> {
  try {
    const [ledger, hub] = await Promise.all([loadLedger(deps.grants, org.organisationId), loadHubFamilies(deps.airtable)]);
    return { org, access, ledger, families: familiesOf(hub.parents, hub.links, hub.players) };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}

async function readCtx(deps: FamilyDeps, caller: FinanceCaller): Promise<Ctx | FFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  return load(deps, auth.organisation, auth.access);
}

async function withLock(deps: FamilyDeps, caller: FinanceCaller, run: (ctx: Ctx) => Promise<Ok | FFail>): Promise<Ok | FFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_family_unavailable", "The change could not be made just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    const ctx = await load(deps, org, auth.access);
    if (isFail(ctx)) return ctx;
    return await run(ctx);
  } catch (e) {
    const lf = ledgerFail(e);
    if (lf) return lf;
    console.error(e);
    return fail(503, "finance_family_unavailable", "The change could not be completed just now - nothing was changed; try again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

const head = (ctx: Ctx) => ({ contract: FAMILY_CONTRACT, organisation: orgBody(ctx.org), access: ctx.access });

// ---------------------------------------------------------------------
// Stripe (READ only) - the source charge and its refunds
// ---------------------------------------------------------------------

type ChargeFacts = { chargeId: string; customerId: string | null; amountMinor: number; currency: string | null; status: string; succeeded: boolean; disputed: boolean; refunds: StripeRefundFact[] };

async function readCharge(deps: FamilyDeps, caller: FinanceCaller, chargeId: string, level: "read" | "manage"): Promise<ChargeFacts | FFail> {
  const s = await openStripeSession(deps, caller, level);
  if (isFail(s)) return s as FFail;
  const at = now(deps).toISOString();
  const c = await s.p.charge(chargeId);
  if (!c.ok) {
    const f = providerFailure(c, "reading the Stripe payment");
    await recordStripeHealth(deps, s as StripeSession, at, f);
    return f as FFail;
  }
  if (!c.value) {
    await recordStripeHealth(deps, s as StripeSession, at, null);
    return fail(404, "stripe_charge_not_found", `Stripe has no payment ${chargeId} in this account`);
  }
  const r = await s.p.chargeRefunds(chargeId);
  if (!r.ok) {
    const f = providerFailure(r, "reading the payment's Stripe refunds");
    await recordStripeHealth(deps, s as StripeSession, at, f);
    return f as FFail;
  }
  await recordStripeHealth(deps, s as StripeSession, at, null);
  const ch = c.value;
  const amt = Number.isSafeInteger(ch.amount) ? ch.amount : 0;
  return {
    chargeId,
    customerId: idOf(ch.customer),
    amountMinor: amt,
    currency: currencyOf(ch.currency),
    status: typeof ch.status === "string" ? ch.status : "unknown",
    succeeded: ch.status === "succeeded" && ch.paid === true && amt > 0,
    disputed: ch.disputed === true,
    refunds: r.value.map((re) => ({ refundId: String(re.id), amountMinor: Number.isSafeInteger(re.amount) ? re.amount : 0, status: typeof re.status === "string" ? re.status : "unknown" })),
  };
}

/** Only a succeeded, undisputed GBP card payment can be the source of a refund or credit. */
function usableCharge(c: ChargeFacts): FFail | null {
  if (!c.succeeded) return fail(409, "stripe_charge_not_succeeded", `Stripe payment ${c.chargeId} did not succeed (${c.status}) - there is nothing to return`);
  if (c.disputed) return fail(409, "stripe_charge_disputed", `Stripe payment ${c.chargeId} is disputed - resolve the dispute in Stripe first`);
  if (c.currency !== "GBP") return fail(409, "currency_not_supported", "Only GBP payments are supported");
  return null;
}

/** The family a Stripe customer belongs to - ONLY through F10's explicit customer link. */
async function familyOfCustomer(deps: FamilyDeps, ctx: Ctx, customerId: string | null): Promise<Family | FFail> {
  if (!customerId) return fail(409, "stripe_customer_not_linked", "The Stripe payment has no customer, so its family is unknown - the Hub will not guess");
  let link;
  try {
    link = (await loadCustomerLinks(deps.grants, ctx.org.organisationId)).find((l) => l.customerId === customerId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!link) return fail(409, "stripe_customer_not_linked", `Stripe customer ${customerId} is not linked to a Hub parent - link it explicitly first (POST /stripe/customers/{cus}/parent-link)`);
  const f = ctx.families.get(link.parentRecordId);
  if (!f) return fail(409, "stripe_customer_parent_missing", `The Hub parent linked to ${customerId} no longer exists`);
  return f;
}

type Source = { funding: SourceFunding; family: Family; payment: FamilyPayment | null; charge: ChargeFacts | null; returnable: ReturnType<typeof returnableOf> };

async function resolveSource(deps: FamilyDeps, caller: FinanceCaller, ctx: Ctx, ref: string, level: "read" | "manage"): Promise<Source | FFail> {
  if (ref.startsWith("ch_")) {
    const owner = ctx.ledger.payments.find((p) => p.stripeChargeId === ref);
    if (owner) return fail(409, "charge_belongs_to_family_payment", `Stripe payment ${ref} is part of family payment ${owner.paymentId} (with any credit it used) - use that as the source`, { paymentId: owner.paymentId });
    const c = await readCharge(deps, caller, ref, level);
    if (isFail(c)) return c;
    const bad = usableCharge(c);
    if (bad) return bad;
    const family = await familyOfCustomer(deps, ctx, c.customerId);
    if (isFail(family)) return family;
    const funding: SourceFunding = { sourceType: "stripe_charge", sourceRef: ref, totalMinor: c.amountMinor, creditFundedMinor: 0, cardFundedMinor: c.amountMinor };
    return { funding, family, payment: null, charge: c, returnable: returnableOf(funding, ctx.ledger.decisions, c.refunds) };
  }
  const payment = ctx.ledger.payments.find((p) => p.paymentId === ref);
  if (!payment) return fail(404, "family_payment_not_found", `No family payment ${ref}`);
  // TRANSITIONAL: the owner is a guardian account; a household owner needs the future Family / Household entity.
  const family = payment.ownerType === "guardian_account" ? ctx.families.get(payment.ownerKey) : undefined;
  if (!family || !sameOwner(payment, ownerOf(family))) return fail(409, "family_missing", `The credit owner behind ${ref} is not a guardian account the Hub can resolve`);
  const fund = paymentFunding(payment, ctx.ledger.applications);
  if (fund.unfundedMinor !== 0) return fail(409, "funding_incomplete", `${m(fund.unfundedMinor)} of ${ref} has no recorded funding (neither family credit nor a Stripe payment) - the Hub will not guess how it was paid`, { due: m(fund.dueMinor), creditFunded: m(fund.creditFundedMinor), cardFunded: m(fund.cardFundedMinor) });
  let charge: ChargeFacts | null = null;
  if (payment.stripeChargeId) {
    const c = await readCharge(deps, caller, payment.stripeChargeId, level);
    if (isFail(c)) return c;
    const bad = usableCharge(c);
    if (bad) return bad;
    if (c.amountMinor !== payment.stripeChargeMinor || c.customerId !== payment.stripeCustomerId) return fail(409, "funding_history_mismatch", `Stripe now reports payment ${c.chargeId} differently from what was recorded on ${ref} - the funding split cannot be trusted; nothing was decided`);
    charge = c;
  }
  const funding: SourceFunding = { sourceType: "family_payment", sourceRef: ref, totalMinor: fund.dueMinor, creditFundedMinor: fund.creditFundedMinor, cardFundedMinor: fund.cardFundedMinor };
  return { funding, family, payment, charge, returnable: returnableOf(funding, ctx.ledger.decisions, charge?.refunds ?? []) };
}

function sourceView(src: Source) {
  const r = src.returnable;
  return {
    type: src.funding.sourceType,
    ref: src.funding.sourceRef,
    family: { parentId: src.family.parentId, name: src.family.name },
    originalPaid: m(src.funding.totalMinor),
    funding: { creditFunded: m(src.funding.creditFundedMinor), cardFunded: m(src.funding.cardFundedMinor) },
    alreadyDecided: { creditRestored: m(r.prior.creditRestoredMinor), cardRefund: m(r.prior.cardRefundMinor), cardKeptAsCredit: m(r.prior.cardToCreditMinor), retained: m(r.prior.retainedMinor) },
    stripeRefunds: { amount: m(r.external.amountMinor), refunds: r.external.refunds, state: r.external.state, mismatch: m(r.external.mismatchMinor) },
    returnable: { total: m(r.returnableMinor), creditFunded: m(r.creditFundedRemainingMinor), cardFunded: m(r.cardFundedRemainingMinor), closedByNoReturn: r.closedByNoReturn },
    technical: { stripeChargeId: src.charge?.chargeId ?? null, stripeCustomerId: src.charge?.customerId ?? null },
  };
}

// ---------------------------------------------------------------------
// Reads (View)
// ---------------------------------------------------------------------

export async function listFamilyCredits(deps: FamilyDeps, caller: FinanceCaller, q: { parentId?: string }): Promise<Ok | FFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  let only: ReturnType<typeof ownerOf> | null = null;
  if (q.parentId) {
    const f = familyByParentId(ctx.families, q.parentId);
    if (!f.ok) return fromRefusal(f);
    only = ownerOf(f.family);
  }
  const owners = [...new Map(ctx.ledger.credits.map((c) => [`${c.ownerType}:${c.ownerKey}`, { ownerType: c.ownerType, ownerKey: c.ownerKey }])).values()].filter((o) => !only || sameOwner(o, only));
  const families = owners.map((owner) => {
    const credits = ctx.ledger.credits.filter((c) => sameOwner(c, owner));
    // TRANSITIONAL: a guardian_account owner is its guardian record; nothing else exists yet.
    const fam = owner.ownerType === "guardian_account" ? ctx.families.get(owner.ownerKey) : undefined;
    return { owner: { type: owner.ownerType, key: owner.ownerKey }, parentId: fam?.parentId ?? credits[0].familyParentId, name: fam?.name ?? null, verified: fam?.verified ?? false, creditAvailable: m(familyBalanceMinor(owner, ctx.ledger)), credits: credits.map((c) => creditView(c, ctx.ledger.applications)) };
  });
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), currency: "GBP", families, rule: "Balances are derived from each credit's original amount minus its applications; used oldest first; not a discount" } };
}

export async function readFamily(deps: FamilyDeps, caller: FinanceCaller, parentId: string): Promise<Ok | FFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const f = familyByParentId(ctx.families, parentId);
  if (!f.ok) return fromRefusal(f);
  const fam = f.family;
  const owner = ownerOf(fam);
  const credits = ctx.ledger.credits.filter((c) => sameOwner(c, owner));
  const payments = ctx.ledger.payments.filter((p) => sameOwner(p, owner));
  const decisions = ctx.ledger.decisions.filter((d) => sameOwner(d, owner));
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      family: { parentId: fam.parentId, name: fam.name, active: fam.active, verified: fam.verified, eligibleChildren: fam.eligiblePlayers.map((p) => ({ playerId: p.playerId, name: p.name })) },
      owner: { type: owner.ownerType, key: owner.ownerKey, transitional: "verified guardian account - no Family / Household entity exists yet" },
      /** What a parent would see. */
      parentSummary: parentSummary(owner, ctx.ledger),
      creditAvailable: m(familyBalanceMinor(owner, ctx.ledger)),
      credits: credits.map((c) => creditView(c, ctx.ledger.applications)),
      payments: payments.map((p) => {
        const fd = paymentFunding(p, ctx.ledger.applications);
        return { paymentId: p.paymentId, description: p.description, bookingRef: p.bookingRef, due: m(fd.dueMinor), creditFunded: m(fd.creditFundedMinor), cardFunded: m(fd.cardFundedMinor), unfunded: m(fd.unfundedMinor), createdAt: p.createdAt, technical: { stripeChargeId: p.stripeChargeId } };
      }),
      refundDecisions: decisions.map((d) => decisionView(d, ctx.ledger.credits.find((c) => c.originDecisionId === d.decisionId) ?? null, fam, ctx.org.timezone)),
    },
  };
}

export async function listRefundDecisions(deps: FamilyDeps, caller: FinanceCaller, q: { parentId?: string; state?: string }): Promise<Ok | FFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  let rows = ctx.ledger.decisions;
  if (q.parentId) {
    const f = familyByParentId(ctx.families, q.parentId);
    if (!f.ok) return fromRefusal(f);
    const owner = ownerOf(f.family);
    rows = rows.filter((d) => sameOwner(d, owner));
  }
  if (q.state) rows = rows.filter((d) => (q.state === "reversed" ? !!d.reversedAt : !d.reversedAt && (d.executionState === q.state || d.refundState === q.state)));
  const views = rows.map((d) => decisionView(d, ctx.ledger.credits.find((c) => c.originDecisionId === d.decisionId) ?? null, ctx.families.get(d.familyRecordId), ctx.org.timezone));
  const live = rows.filter((d) => !d.reversedAt);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      summary: {
        decisions: rows.length,
        awaitingRefundAction: live.filter((d) => d.refundState === "awaiting_refund_action").length,
        refundDue: m(live.filter((d) => d.refundState === "awaiting_refund_action").reduce((a, d) => a + d.cardRefundMinor, 0)),
        familyCreditCreated: m(live.reduce((a, d) => a + d.creditRestoredMinor + d.cardToCreditMinor, 0)),
        reversed: rows.length - live.length,
      },
      decisions: views,
    },
  };
}

export async function readRefundDecision(deps: FamilyDeps, caller: FinanceCaller, decisionId: string): Promise<Ok | FFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const d = ctx.ledger.decisions.find((x) => x.decisionId === decisionId);
  if (!d) return fail(404, "refund_decision_not_found", `No refund decision ${decisionId}`);
  const credit = ctx.ledger.credits.find((c) => c.originDecisionId === d.decisionId) ?? null;
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), decision: decisionView(d, credit, ctx.families.get(d.familyRecordId), ctx.org.timezone), familyCredit: credit ? creditView(credit, ctx.ledger.applications) : null } };
}

/** GET /refund-sources/{ch_|FFP-}: how a payment was funded and what is still returnable (live Stripe read where a card paid). */
export async function readRefundSource(deps: FamilyDeps, caller: FinanceCaller, ref: string): Promise<Ok | FFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const src = await resolveSource(deps, caller, ctx, ref, "read");
  if (isFail(src)) return src;
  const decisions = ctx.ledger.decisions.filter((d) => d.sourceRef === ref).map((d) => ({ decisionId: d.decisionId, decisionType: d.decisionType, returned: m(d.returnMinor), status: d.reversedAt ? "reversed" : d.executionState }));
  return { status: "ok", httpStatus: 200, body: { ...head(ctx), source: sourceView(src), decisions } };
}

export async function listRevenueCorrections(deps: FamilyDeps, caller: FinanceCaller, q: { from?: string; to?: string }): Promise<Ok | FFail> {
  const ctx = await readCtx(deps, caller);
  if (isFail(ctx)) return ctx;
  const w = correctionWindow(q.from, q.to, todayIn(ctx.org.timezone, now(deps)));
  if (!w.ok) return { status: "error", httpStatus: 400, code: w.code, error: w.error };
  const facts = ctx.ledger.decisions.flatMap((d) => revenueCorrectionsOf(d, ctx.ledger.credits.find((c) => c.originDecisionId === d.decisionId) ?? null, ctx.org.timezone)).filter((f) => (f.date as string) >= w.from && (f.date as string) <= w.to);
  const totals: Record<string, number> = {};
  for (const f of facts) totals[f.type as string] = (totals[f.type as string] ?? 0) + Math.round(Number(f.amount) * 100);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      ...head(ctx),
      window: { from: w.from, to: w.to, timezone: ctx.org.timezone },
      rule: "Family credit and refunds correct revenue; they are never business costs. Family credit moves no cash; Refund Due moves none yet - cash leaves only when F21 executes the Stripe refund.",
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, m(v)])),
      corrections: facts,
    },
  };
}

// ---------------------------------------------------------------------
// Writes (Manage)
// ---------------------------------------------------------------------

export function recordFamilyPayment(deps: FamilyDeps, caller: FinanceCaller, input: { parentId: string; amountMinor: number; description: string; playerId: string | null; bookingRef: string | null; stripeChargeId: string | null; reason: string }): Promise<Ok | FFail> {
  return withLock(deps, caller, async (ctx) => {
    const f = familyByParentId(ctx.families, input.parentId);
    if (!f.ok) return fromRefusal(f);
    const fam = f.family;
    if (!fam.verified) return fail(409, "family_not_verified", `${fam.parentId} has no verified child - family payments and credit are for verified guardian accounts only`);
    let playerRecordId: string | null = null;
    if (input.playerId) {
      const p = eligiblePlayer(fam, input.playerId);
      if (!p.ok) return fromRefusal(p);
      playerRecordId = p.player.recordId;
    }
    let charge: ChargeFacts | null = null;
    if (input.stripeChargeId) {
      const ch = input.stripeChargeId;
      if (ctx.ledger.payments.some((p) => p.stripeChargeId === ch)) return fail(409, "charge_already_recorded", LEDGER_MESSAGES.charge_already_recorded);
      if (ctx.ledger.decisions.some((d) => d.sourceRef === ch)) return fail(409, "charge_already_a_refund_source", LEDGER_MESSAGES.charge_already_a_refund_source);
      const c = await readCharge(deps, caller, ch, "manage");
      if (isFail(c)) return c;
      const bad = usableCharge(c);
      if (bad) return bad;
      const owner = await familyOfCustomer(deps, ctx, c.customerId);
      if (isFail(owner)) return owner;
      if (owner.recordId !== fam.recordId) return fail(409, "stripe_charge_other_family", `Stripe payment ${ch} belongs to ${owner.parentId}, not ${fam.parentId}`);
      if (c.amountMinor > input.amountMinor) return fail(409, "charge_exceeds_due", `The Stripe payment (${m(c.amountMinor)}) is more than the amount due (${m(input.amountMinor)})`);
      charge = c;
    }
    const at = now(deps).toISOString();
    const p: FamilyPayment = {
      organisationId: ctx.org.organisationId,
      paymentId: id(deps, "FFP"),
      familyRecordId: fam.recordId,
      familyParentId: fam.parentId,
      ...ownerOf(fam),
      playerRecordId,
      bookingRef: input.bookingRef,
      description: input.description,
      currency: "GBP",
      amountDueMinor: input.amountMinor,
      stripeChargeId: charge?.chargeId ?? null,
      stripeCustomerId: charge?.customerId ?? null,
      stripeChargeMinor: charge?.amountMinor ?? null,
      createdAt: at,
      createdBy: caller.userId,
      reason: input.reason,
    };
    const fd = paymentFunding(p, []);
    await recordPayment(deps.grants, p, [
      familyAudit({ organisationId: p.organisationId, actorUserId: caller.userId, eventType: FAMILY_EVENTS.paymentRecorded, entityType: ENTITY.payment, recordId: `${p.organisationId}:${p.paymentId}`, before: null, after: { paymentId: p.paymentId, parentId: fam.parentId, due: m(p.amountDueMinor), cardFunded: m(fd.cardFundedMinor), unfunded: m(fd.unfundedMinor), stripeChargeId: p.stripeChargeId, playerRecordId }, reason: input.reason, route: "POST /family-payments" }),
    ]);
    return { status: "ok", httpStatus: 201, body: { ...head(ctx), payment: { paymentId: p.paymentId, parentId: fam.parentId, description: p.description, due: m(fd.dueMinor), creditFunded: m(0), cardFunded: m(fd.cardFundedMinor), unfunded: m(fd.unfundedMinor), technical: { stripeChargeId: p.stripeChargeId } } } };
  });
}

export function applyFamilyCredit(deps: FamilyDeps, caller: FinanceCaller, input: { parentId: string; paymentId: string; amountMinor: number | null; reason: string | null }): Promise<Ok | FFail> {
  return withLock(deps, caller, async (ctx) => {
    const pay = ctx.ledger.payments.find((p) => p.paymentId === input.paymentId);
    if (!pay) return fail(404, "family_payment_not_found", `No family payment ${input.paymentId}`);
    const f = familyByParentId(ctx.families, input.parentId);
    if (!f.ok) return fromRefusal(f);
    const fam = f.family;
    const owner = ownerOf(fam);
    if (!sameOwner(owner, pay)) return fail(409, "cross_family_refused", `${fam.parentId}'s credit cannot pay ${pay.familyParentId}'s payment - one family never spends another family's credit`);
    if (!fam.verified) return fail(409, "family_not_verified", `${fam.parentId} has no verified child - its credit cannot be used`);
    if (pay.playerRecordId && !fam.eligiblePlayers.some((p) => p.recordId === pay.playerRecordId)) return fail(409, "player_not_eligible", "The payment's child is no longer a verified child of this family - credit cannot be used for it");
    if (ctx.ledger.decisions.some((d) => d.sourceRef === pay.paymentId)) return fail(409, "payment_has_decisions", LEDGER_MESSAGES.payment_has_decisions);
    const fd = paymentFunding(pay, ctx.ledger.applications);
    if (fd.unfundedMinor <= 0) return fail(409, "payment_fully_funded", `${pay.paymentId} is already fully paid`);
    const balance = familyBalanceMinor(owner, ctx.ledger);
    if (balance === 0) return fail(409, "insufficient_credit", `${fam.parentId} has no family credit available`);
    const amount = input.amountMinor ?? Math.min(fd.unfundedMinor, balance);
    if (amount > fd.unfundedMinor) return fail(409, "over_application", `Only ${m(fd.unfundedMinor)} of ${pay.paymentId} is still unpaid`);
    const plan = planApplication(owner, ctx.ledger, amount);
    if (!plan.ok) return fromRefusal(plan);
    const at = now(deps).toISOString();
    const batchId = id(deps, "FFB");
    const allocations = plan.allocations.map((a) => ({ ...a, applicationId: id(deps, "FFA") }));
    await applyCredit(deps.grants, { organisationId: ctx.org.organisationId, paymentId: pay.paymentId, owner, batchId, allocations, at, by: caller.userId, reason: input.reason }, [
      familyAudit({
        organisationId: ctx.org.organisationId,
        actorUserId: caller.userId,
        eventType: FAMILY_EVENTS.creditApplied,
        entityType: ENTITY.application,
        recordId: `${ctx.org.organisationId}:${batchId}`,
        before: { creditAvailable: m(balance), paymentUnfunded: m(fd.unfundedMinor) },
        after: { paymentId: pay.paymentId, parentId: fam.parentId, applied: m(amount), order: "oldest_first", allocations: allocations.map((a) => ({ applicationId: a.applicationId, creditId: a.creditId, amount: m(a.amountMinor), remainingAfter: m(a.remainingAfterMinor) })), creditAvailable: m(balance - amount), paymentUnfunded: m(fd.unfundedMinor - amount) },
        reason: input.reason,
        route: "POST /family-credits/apply",
      }),
    ]);
    return {
      status: "ok",
      httpStatus: 201,
      body: {
        ...head(ctx),
        applied: m(amount),
        order: "oldest_first",
        allocations: allocations.map((a) => ({ creditId: a.creditId, amount: m(a.amountMinor), remainingAfter: m(a.remainingAfterMinor), order: a.sequence })),
        payment: { paymentId: pay.paymentId, due: m(fd.dueMinor), creditFunded: m(fd.creditFundedMinor + amount), cardFunded: m(fd.cardFundedMinor), unfunded: m(fd.unfundedMinor - amount) },
        creditAvailable: m(balance - amount),
      },
    };
  });
}

export function recordRefundDecision(deps: FamilyDeps, caller: FinanceCaller, input: DecisionInput): Promise<Ok | FFail> {
  return withLock(deps, caller, async (ctx) => {
    const named = familyByParentId(ctx.families, input.parentId);
    if (!named.ok) return fromRefusal(named);
    const src = await resolveSource(deps, caller, ctx, input.source, "manage");
    if (isFail(src)) return src;
    const fam = src.family;
    if (!sameOwner(ownerOf(named.family), ownerOf(fam))) return fail(409, "family_mismatch", `${input.source} belongs to ${fam.parentId}, not ${input.parentId} - nothing was decided`);
    let playerRecordId = src.payment?.playerRecordId ?? null;
    if (input.playerId) {
      const p = eligiblePlayer(fam, input.playerId);
      if (!p.ok) return fromRefusal(p);
      if (playerRecordId && playerRecordId !== p.player.recordId) return fail(409, "player_mismatch", `${input.source} is for a different child`);
      playerRecordId = p.player.recordId;
    }
    const plan = planDecision(src.returnable, { decisionType: input.decisionType, amountMinor: input.amountMinor, cardRefundMinor: input.cardRefundMinor }, fam.verified);
    if (!plan.ok) return fromRefusal(plan);
    const a = plan.amounts;
    const at = now(deps).toISOString();
    const decisionId = id(deps, "FRD");
    const d: RefundDecision = {
      organisationId: ctx.org.organisationId,
      decisionId,
      familyRecordId: fam.recordId,
      familyParentId: fam.parentId,
      ...ownerOf(fam),
      playerRecordId,
      sourceType: src.funding.sourceType,
      sourceRef: src.funding.sourceRef,
      stripeChargeId: src.charge?.chargeId ?? null,
      stripeCustomerId: src.charge?.customerId ?? null,
      currency: "GBP",
      sourceTotalMinor: src.funding.totalMinor,
      sourceCreditFundedMinor: src.funding.creditFundedMinor,
      sourceCardFundedMinor: src.funding.cardFundedMinor,
      returnableBeforeMinor: src.returnable.returnableMinor,
      decisionType: input.decisionType,
      ...a,
      executionState: executionStateOf(input.decisionType, a),
      refundState: refundStateOf(a),
      stripeRefundId: null,
      reason: input.reason,
      policyKind: input.policyKind,
      policyRef: input.policyRef,
      decidedAt: at,
      decidedBy: caller.userId,
      reversedAt: null,
      reversedBy: null,
      reverseReason: null,
    };
    const credited = a.creditRestoredMinor + a.cardToCreditMinor;
    const credit: FamilyCredit | null = credited > 0
      ? { organisationId: d.organisationId, creditId: id(deps, "FFC"), familyRecordId: fam.recordId, familyParentId: fam.parentId, ...ownerOf(fam), currency: "GBP", originalMinor: credited, creditFundedMinor: a.creditRestoredMinor, cardFundedMinor: a.cardToCreditMinor, originDecisionId: decisionId, sourceRef: d.sourceRef, createdAt: at, createdBy: caller.userId, reason: input.reason, voidedAt: null, voidedBy: null, voidKind: null, voidReason: null }
      : null;
    const route = "POST /refund-decisions";
    const base = { organisationId: d.organisationId, actorUserId: caller.userId, reason: input.reason, route };
    const events = [
      familyAudit({
        ...base,
        eventType: FAMILY_EVENTS.decisionRecorded,
        entityType: ENTITY.decision,
        recordId: `${d.organisationId}:${decisionId}`,
        before: { returnable: m(d.returnableBeforeMinor) },
        after: { decisionId, parentId: fam.parentId, source: { type: d.sourceType, ref: d.sourceRef, creditFunded: m(d.sourceCreditFundedMinor), cardFunded: m(d.sourceCardFundedMinor) }, decisionType: d.decisionType, returned: m(a.returnMinor), creditPortion: m(credited), refundPortion: m(a.cardRefundMinor), retained: m(a.retainedMinor), executionState: d.executionState, refundState: d.refundState, policy: { kind: d.policyKind, ref: d.policyRef } },
      }),
      ...(credit ? [familyAudit({ ...base, eventType: FAMILY_EVENTS.creditCreated, entityType: ENTITY.credit, recordId: `${d.organisationId}:${credit.creditId}`, before: null, after: { creditId: credit.creditId, parentId: fam.parentId, amount: m(credit.originalMinor), creditFunded: m(credit.creditFundedMinor), cardFunded: m(credit.cardFundedMinor), decisionId } })] : []),
      ...(a.cardRefundMinor > 0 ? [familyAudit({ ...base, eventType: FAMILY_EVENTS.refundDueRecorded, entityType: ENTITY.decision, recordId: `${d.organisationId}:${decisionId}:refund_due`, before: null, after: { decisionId, amount: m(a.cardRefundMinor), refundState: "awaiting_refund_action", stripeChargeId: d.stripeChargeId, executedBy: "F21 (not built) - no Stripe call was made" } })] : []),
    ];
    await recordDecision(deps.grants, d, credit, ctx.ledger.versions.get(d.sourceRef) ?? 0, events);
    return {
      status: "ok",
      httpStatus: 201,
      body: {
        ...head(ctx),
        decision: decisionView(d, credit, fam, ctx.org.timezone),
        familyCredit: credit ? creditView(credit, []) : null,
        returnableAfter: m(d.decisionType === "no_return" ? 0 : src.returnable.returnableMinor - a.returnMinor),
        stripe: "No Stripe call was made. A card refund is Refund Due until F21 executes it.",
      },
    };
  });
}

export function voidFamilyCredit(deps: FamilyDeps, caller: FinanceCaller, creditId: string, reason: string): Promise<Ok | FFail> {
  return withLock(deps, caller, async (ctx) => {
    const c = ctx.ledger.credits.find((x) => x.creditId === creditId);
    if (!c) return fail(404, "family_credit_not_found", `No family credit ${creditId}`);
    const st = creditStatus(c, ctx.ledger.applications);
    if (st === "voided") return fail(409, "credit_already_voided", LEDGER_MESSAGES.credit_already_voided);
    if (st !== "available") return fail(409, "credit_used", "This credit has been used (in part or in full) - used credit is never voided; the payments it paid stay as they are");
    const at = now(deps).toISOString();
    await voidCredit(deps.grants, { organisationId: ctx.org.organisationId, creditId, at, by: caller.userId, reason }, [
      familyAudit({ organisationId: ctx.org.organisationId, actorUserId: caller.userId, eventType: FAMILY_EVENTS.creditVoided, entityType: ENTITY.credit, recordId: `${ctx.org.organisationId}:${creditId}`, before: { status: st, remaining: m(c.originalMinor) }, after: { status: "voided", remaining: m(0), kind: "manual_void" }, reason, route: `POST /family-credits/${creditId}/void` }),
    ]);
    return { status: "ok", httpStatus: 200, body: { ...head(ctx), credit: creditView({ ...c, voidedAt: at, voidedBy: caller.userId, voidKind: "manual_void", voidReason: reason }, ctx.ledger.applications), creditAvailable: m(familyBalanceMinor(c, ctx.ledger) - c.originalMinor) } };
  });
}

export function reverseRefundDecision(deps: FamilyDeps, caller: FinanceCaller, decisionId: string, reason: string): Promise<Ok | FFail> {
  return withLock(deps, caller, async (ctx) => {
    const d = ctx.ledger.decisions.find((x) => x.decisionId === decisionId);
    if (!d) return fail(404, "refund_decision_not_found", `No refund decision ${decisionId}`);
    if (d.reversedAt) return fail(409, "decision_already_reversed", LEDGER_MESSAGES.decision_already_reversed);
    if (!(d.refundState === "none" || d.refundState === "awaiting_refund_action") || d.stripeRefundId) return fail(409, "refund_in_progress", LEDGER_MESSAGES.refund_in_progress);
    const credit = ctx.ledger.credits.find((c) => c.originDecisionId === decisionId) ?? null;
    if (credit) {
      const st = creditStatus(credit, ctx.ledger.applications);
      if (st === "voided") return fail(409, "credit_voided_separately", LEDGER_MESSAGES.credit_voided_separately);
      if (st !== "available") return fail(409, "credit_used", "The family credit this decision created has already been used - the decision cannot be reversed (no safe compensating path)");
    }
    const at = now(deps).toISOString();
    await reverseDecision(deps.grants, { organisationId: ctx.org.organisationId, decisionId, expectedVersion: ctx.ledger.versions.get(d.sourceRef) ?? 0, at, by: caller.userId, reason }, [
      familyAudit({
        organisationId: ctx.org.organisationId,
        actorUserId: caller.userId,
        eventType: FAMILY_EVENTS.decisionReversed,
        entityType: ENTITY.decision,
        recordId: `${ctx.org.organisationId}:${decisionId}`,
        before: { executionState: d.executionState, refundState: d.refundState, creditPortion: m(d.creditRestoredMinor + d.cardToCreditMinor), refundPortion: m(d.cardRefundMinor) },
        after: { status: "reversed", restoredReturnable: m(d.returnMinor + d.retainedMinor), voidedCreditId: credit?.creditId ?? null, refundDueCancelled: m(d.cardRefundMinor) },
        reason,
        route: `POST /refund-decisions/${decisionId}/reverse`,
      }),
    ]);
    const after: RefundDecision = { ...d, reversedAt: at, reversedBy: caller.userId, reverseReason: reason };
    const c2 = credit ? { ...credit, voidedAt: at, voidedBy: caller.userId, voidKind: "decision_reversed" as const, voidReason: reason } : null;
    return { status: "ok", httpStatus: 200, body: { ...head(ctx), decision: decisionView(after, c2, ctx.families.get(d.familyRecordId), ctx.org.timezone), restoredReturnable: m(d.returnMinor + d.retainedMinor) } };
  });
}
