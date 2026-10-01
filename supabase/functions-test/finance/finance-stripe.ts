/**
 * Stripe READ connector - pure model (Finance Foundation F10; see
 * TEST-ENV.md "Finance Foundation - F10"). No HTTP, no storage: the
 * provider adapter fetches, the orchestrator decides, this file turns raw
 * Stripe objects into the Hub's Finance read model.
 *
 * Stripe is the payment authority for parent money (subscriptions, payment
 * methods, charges, success / failure, refunds, fees). The Hub only READS
 * and interprets: nothing here can create, change, cancel or refund
 * anything, and no Stripe payment state is copied into Airtable.
 *
 *   - Actual money = a SUCCEEDED Stripe charge (a trusted external receipt,
 *     source "stripe"), kept apart from F7's manual Finance Payments.
 *     Active subscriptions, upcoming invoices, open invoices and renewal
 *     dates are EXPECTED facts, never Actual Revenue.
 *   - Fees: a completed charge's fee / net come ONLY from its Stripe balance
 *     transaction (never estimated). A future charge's fee is shown only
 *     when the organisation configured an estimate, and is labelled
 *     estimated; otherwise expected net is deferred.
 *   - VAT: read from the Stripe invoice when Stripe recorded tax; otherwise
 *     "not recorded in Stripe" - gross is never assumed to be revenue.
 *   - Mapping: a Stripe customer is a Hub parent ONLY through a stored
 *     link (never by name / email); a subscription's child (player) and
 *     Finance service stay UNRESOLVED unless a stable mapping exists - and
 *     none does yet.
 */
import { REASON_MAX, auditEvent, todayIn } from "./finance-commercial.ts";
import { formatMinor } from "./finance-money.ts";

export const STRIPE_CONTRACT = "finance-stripe-v1";
/** Every request pins this API version so the object shapes read here cannot shift under the connector (see TEST-ENV.md FIN10.4). */
export const STRIPE_API_VERSION = "2024-06-20";

export const MODES = ["test", "live"] as const;
export type StripeMode = (typeof MODES)[number];
/** "stripe" = api.stripe.com; "sandbox" = this TEST project's stripe-sandbox emulator (TEST only, test mode only). */
export const ENDPOINTS = ["stripe", "sandbox"] as const;
export type StripeEndpoint = (typeof ENDPOINTS)[number];

export const CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9]{1,64}$/;
export const SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9]{1,64}$/;
export const ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]{1,64}$/;
export const PARENT_ID_PATTERN = /^PARENT-[A-Za-z0-9-]{1,48}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A bounded read window for payments / refunds (one quarter). */
export const MAX_WINDOW_DAYS = 93;
export const DEFAULT_WINDOW_DAYS = 30;
/** Currencies whose minor unit is 1/100 (the only ones this read model formats). */
const TWO_DECIMAL = new Set(["GBP", "EUR", "USD"]);

export const STRIPE_EVENTS = {
  connected: "finance_stripe.connected",
  disconnected: "finance_stripe.disconnected",
  settingsUpdated: "finance_stripe.settings_updated",
  customerLinked: "finance_stripe.customer_linked",
} as const;
export const ENTITY_CONNECTION = "finance_stripe_connection";
export const ENTITY_CUSTOMER_LINK = "finance_stripe_customer_link";

export interface FeeEstimate {
  /** e.g. 150 = 1.5 % */
  percentBasisPoints: number;
  /** e.g. 20 = 20p per charge */
  fixedMinor: number;
}
export interface StripeConnection {
  organisationId: string;
  mode: StripeMode;
  endpoint: StripeEndpoint;
  status: "connected" | "disconnected";
  accountId: string | null;
  accountName: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  config: { feeEstimate: FeeEstimate | null; revision: number; updatedAt: string | null; updatedBy: string | null };
}
export interface CustomerLink {
  organisationId: string;
  customerId: string;
  parentId: string;
  parentRecordId: string;
  method: "linked_by_manager";
  linkedAt: string;
  linkedBy: string;
}
/** A Hub parent as F10 needs it (Parents & Guardians + its active Parent-Player Links). */
export interface HubParent {
  recordId: string;
  parentId: string;
  name: string;
  active: boolean;
  linkedPlayerCount: number;
}
export type Problem = { code: string; message: string };

// ---------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------

/** "test" / "live" from a Stripe secret or restricted key prefix; null for anything else. Never logs or returns the key. */
export function keyModeOf(key: string): StripeMode | null {
  const m = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.exec(key);
  return m ? (m[2] as StripeMode) : null;
}
export function keyKindOf(key: string): "secret" | "restricted" | null {
  const m = /^(sk|rk)_(test|live)_/.exec(key);
  return m ? (m[1] === "rk" ? "restricted" : "secret") : null;
}

export function connectionProblems(conn: StripeConnection | null, requireTestMode: boolean): Problem[] {
  if (!conn || conn.status !== "connected") return [{ code: "stripe_not_connected", message: "Stripe is not connected for this organisation" }];
  if (requireTestMode && conn.mode !== "test") return [{ code: "stripe_live_mode_refused", message: "This TEST Hub may only read a Stripe account in test mode - the connection is live; nothing was read" }];
  if (conn.endpoint === "sandbox" && conn.mode !== "test") return [{ code: "stripe_live_mode_refused", message: "The TEST Stripe emulator only runs in test mode" }];
  return [];
}

export const SOURCE_LABEL = (c: Pick<StripeConnection, "endpoint" | "mode">) => (c.endpoint === "sandbox" ? "Stripe (TEST sandbox - emulator, not real Stripe)" : c.mode === "test" ? "Stripe (test mode)" : "Stripe");

/** Freshness block carried by every Stripe read response: always a live read, never a cache. */
export function sourceOf(c: StripeConnection, fetchedAt: string) {
  return { provider: "stripe", label: SOURCE_LABEL(c), endpoint: c.endpoint, mode: c.mode, accountId: c.accountId, apiVersion: STRIPE_API_VERSION, fetchedAt, cached: false };
}

export function publicConnection(c: StripeConnection | null) {
  if (!c) return { provider: "stripe", connected: false, status: "not_connected" };
  return {
    provider: "stripe",
    connected: c.status === "connected",
    status: c.status,
    mode: c.mode,
    endpoint: c.endpoint,
    label: SOURCE_LABEL(c),
    accountId: c.accountId,
    accountName: c.accountName,
    connectedAt: c.connectedAt,
    lastSuccessAt: c.lastSuccessAt,
    lastError: c.lastErrorAt ? { at: c.lastErrorAt, code: c.lastErrorCode, message: c.lastErrorMessage } : null,
  };
}
export const publicConfig = (c: StripeConnection["config"]) => ({ feeEstimate: c.feeEstimate, revision: c.revision, updatedAt: c.updatedAt });

// ---------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------

const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** An expandable Stripe field: the id whether it came back as a string or as the expanded object. */
export const idOf = (v: unknown): string | null => (typeof v === "string" ? v || null : v && typeof v === "object" && typeof (v as any).id === "string" ? (v as any).id : null);
/** The expanded object, or null when Stripe returned only an id. */
export const objOf = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
export const isoOf = (epoch: unknown): string | null => (int(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : null);
export const dateOf = (epoch: unknown, tz: string): string | null => (int(epoch) && epoch > 0 ? todayIn(tz, new Date(epoch * 1000)) : null);
export const currencyOf = (v: unknown): string | null => (typeof v === "string" && /^[a-z]{3}$/i.test(v) ? v.toUpperCase() : null);

/** Minor units -> "12.34" in a 2-decimal currency; null when the amount or currency cannot be shown exactly. */
export function money(minor: unknown, currency: string | null): string | null {
  if (!int(minor) || !currency || !TWO_DECIMAL.has(currency)) return null;
  return formatMinor(minor);
}

// ---------------------------------------------------------------------
// Subscription status -> Hub read state (raw Stripe status always kept)
// ---------------------------------------------------------------------

export const HUB_STATES = ["active", "trialling", "payment_issue", "cancelling", "cancelled", "inactive", "unknown"] as const;
export type HubState = (typeof HUB_STATES)[number];
export const STATE_LABELS: Record<HubState, string> = {
  active: "Active",
  trialling: "Trialling",
  payment_issue: "Payment issue",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  inactive: "Inactive",
  unknown: "Unknown - check Stripe",
};
/**
 * The documented mapping (TEST-ENV.md FIN10.5). `reason` keeps the meaning a
 * single state would lose (e.g. past_due vs unpaid vs incomplete).
 */
export function subscriptionState(sub: Record<string, any>): { state: HubState; label: string; reason: string; stripeStatus: string; cancellationScheduled: boolean } {
  const raw = typeof sub.status === "string" ? sub.status : "";
  const scheduled = sub.cancel_at_period_end === true || int(sub.cancel_at);
  const s = (state: HubState, reason: string) => ({ state, label: STATE_LABELS[state], reason, stripeStatus: raw, cancellationScheduled: scheduled });
  switch (raw) {
    case "active":
      return scheduled ? s("cancelling", sub.cancel_at_period_end === true ? "cancels_at_period_end" : "cancel_date_scheduled") : s("active", "renewing");
    case "trialing":
      return scheduled ? s("cancelling", "trial_cancels_before_first_payment") : s("trialling", "in_trial");
    case "past_due":
      return s("payment_issue", "payment_failed_stripe_retrying");
    case "unpaid":
      return s("payment_issue", "payment_failed_retries_exhausted");
    case "incomplete":
      return s("payment_issue", "first_payment_not_completed");
    case "incomplete_expired":
      return s("inactive", "first_payment_never_completed");
    case "paused":
      return s("inactive", "paused_trial_ended_without_payment_method");
    case "canceled":
      return s("cancelled", "cancelled");
    default:
      return s("unknown", "unrecognised_stripe_status");
  }
}

// ---------------------------------------------------------------------
// Periods, plan amount, expected next collection
// ---------------------------------------------------------------------

const itemsOf = (sub: Record<string, any>): Record<string, any>[] => (Array.isArray(sub.items?.data) ? sub.items.data : []);

/** Current billing period: the subscription's own fields (pinned API version), else its items' (newer API versions moved them). */
export function periodOf(sub: Record<string, any>): { start: number | null; end: number | null } {
  if (int(sub.current_period_start) && int(sub.current_period_end)) return { start: sub.current_period_start, end: sub.current_period_end };
  const starts = itemsOf(sub).map((i) => i.current_period_start).filter(int);
  const ends = itemsOf(sub).map((i) => i.current_period_end).filter(int);
  return { start: starts.length ? Math.min(...starts) : null, end: ends.length ? Math.min(...ends) : null };
}

/** The recurring price-list amount per cycle (Σ unit_amount × quantity) - EXPECTED, not a receipt; null when it is not one simple amount. */
export function planOf(sub: Record<string, any>) {
  const items = itemsOf(sub);
  const lines = items.map((i) => {
    const p = objOf(i.price) ?? {};
    return {
      priceId: idOf(i.price),
      productId: idOf(p.product),
      productName: str(objOf(p.product)?.name),
      nickname: str(p.nickname),
      unitAmount: int(p.unit_amount) ? p.unit_amount : null,
      quantity: int(i.quantity) ? i.quantity : 1,
      currency: currencyOf(p.currency),
      interval: str(p.recurring?.interval),
      intervalCount: int(p.recurring?.interval_count) ? p.recurring.interval_count : 1,
      taxBehavior: str(p.tax_behavior),
    };
  });
  const currencies = [...new Set(lines.map((l) => l.currency))];
  const intervals = [...new Set(lines.map((l) => `${l.interval}:${l.intervalCount}`))];
  const simple = lines.length > 0 && lines.every((l) => l.unitAmount !== null && l.interval) && currencies.length === 1 && intervals.length === 1;
  const grossMinor = simple ? lines.reduce((a, l) => a + (l.unitAmount as number) * l.quantity, 0) : null;
  const currency = currencies.length === 1 ? currencies[0] : null;
  const discounted = !!sub.discount || (Array.isArray(sub.discounts) && sub.discounts.length > 0);
  return {
    lines,
    currency,
    interval: intervals.length === 1 && lines[0]?.interval ? lines[0].interval : intervals.length > 1 ? "mixed" : null,
    intervalCount: intervals.length === 1 ? lines[0]?.intervalCount ?? null : null,
    grossMinor,
    gross: money(grossMinor, currency),
    amountState: !lines.length ? "no_items" : simple ? (discounted ? "price_list_discount_applies" : "price_list") : "not_one_simple_amount",
    taxBehavior: [...new Set(lines.map((l) => l.taxBehavior ?? "unspecified"))].join(","),
    automaticTax: sub.automatic_tax?.enabled === true,
  };
}

/** A configured fee estimate for a FUTURE charge (labelled estimated); never used for completed charges. */
export function estimateFee(grossMinor: number | null, est: FeeEstimate | null): number | null {
  if (grossMinor === null || !est) return null;
  return Math.round((grossMinor * est.percentBasisPoints) / 10_000) + est.fixedMinor;
}

/**
 * The next EXPECTED collection - never Actual Revenue. Gross is Stripe's
 * upcoming-invoice preview when given (detail route), else the price list.
 */
export function expectedNextOf(sub: Record<string, any>, st: ReturnType<typeof subscriptionState>, tz: string, fee: FeeEstimate | null, upcoming: Record<string, any> | null) {
  const period = periodOf(sub);
  const latest = objOf(sub.latest_invoice);
  let at: number | null = null;
  let basis: string;
  if (st.state === "active") ((at = period.end), (basis = "period_end_renewal"));
  else if (st.state === "trialling") ((at = int(sub.trial_end) ? sub.trial_end : period.end), (basis = "trial_end_first_charge"));
  else if (st.state === "payment_issue" && st.stripeStatus === "past_due" && int(latest?.next_payment_attempt)) ((at = latest!.next_payment_attempt), (basis = "stripe_retry_of_failed_invoice"));
  else if (st.state === "cancelling") basis = "none_cancellation_scheduled";
  else if (st.stripeStatus === "unpaid") basis = "none_stripe_stopped_retrying";
  else basis = `none_${st.state}`;
  if (at === null) return { kind: "expected", actualRevenue: false, date: null, at: null, basis, endsAt: st.state === "cancelling" ? isoOf(int(sub.cancel_at) ? sub.cancel_at : period.end) : null };
  const plan = planOf(sub);
  const fromUpcoming = upcoming && int(upcoming.amount_due);
  const currency = fromUpcoming ? currencyOf(upcoming!.currency) : plan.currency;
  const grossMinor = fromUpcoming ? (upcoming!.amount_due as number) : basis === "stripe_retry_of_failed_invoice" && int(latest?.amount_remaining) ? latest!.amount_remaining : plan.grossMinor;
  const feeMinor = estimateFee(grossMinor, fee);
  return {
    kind: "expected",
    actualRevenue: false,
    at: isoOf(at),
    date: dateOf(at, tz),
    basis,
    currency,
    gross: money(grossMinor, currency),
    grossSource: fromUpcoming ? "stripe_upcoming_invoice" : basis === "stripe_retry_of_failed_invoice" ? "stripe_open_invoice" : plan.amountState,
    vat: fromUpcoming ? taxOfInvoice(upcoming) : { state: "see_upcoming_invoice", vat: null, netRevenue: null, message: "VAT for a future charge is read from Stripe's upcoming invoice (subscription detail)" },
    fee: feeMinor === null ? null : { amount: money(feeMinor, currency), estimated: true, basis: "organisation_configured_estimate" },
    feeState: grossMinor === null ? "gross_unknown" : fee ? "estimated" : "not_configured",
    netCash: feeMinor === null || grossMinor === null ? null : money(grossMinor - feeMinor, currency),
  };
}

// ---------------------------------------------------------------------
// VAT / tax (read from Stripe, never fabricated)
// ---------------------------------------------------------------------

export function taxOfInvoice(inv: Record<string, any> | null) {
  if (!inv) return { state: "no_invoice", vat: null, netRevenue: null, message: "No Stripe invoice is attached, so Stripe holds no tax breakdown" };
  const cur = currencyOf(inv.currency);
  const amounts: Record<string, any>[] = Array.isArray(inv.total_tax_amounts) ? inv.total_tax_amounts : [];
  const auto = inv.automatic_tax?.enabled === true && inv.automatic_tax?.status === "complete";
  const total = int(inv.total) ? inv.total : null;
  if ((amounts.length || auto) && total !== null) {
    const vatMinor = int(inv.tax) ? inv.tax : amounts.reduce((a, t) => a + (int(t.amount) ? t.amount : 0), 0);
    const netMinor = int(inv.total_excluding_tax) ? inv.total_excluding_tax : total - vatMinor;
    return { state: "recorded_by_stripe", source: auto ? "stripe_tax" : "stripe_tax_rates", inclusive: amounts.some((t) => t.inclusive === true), currency: cur, gross: money(total, cur), vat: money(vatMinor, cur), netRevenue: money(netMinor, cur) };
  }
  return { state: "not_recorded_in_stripe", currency: cur, gross: money(total, cur), vat: null, netRevenue: null, message: "Stripe recorded no tax on this invoice and the Hub has no stable link to a Finance service's VAT rule - VAT and net revenue are not known (gross is not assumed to be revenue)" };
}

// ---------------------------------------------------------------------
// Payments (charges) - the trusted receipt facts
// ---------------------------------------------------------------------

export function failureCategory(code: string | null, decline: string | null): string {
  const c = `${code ?? ""} ${decline ?? ""}`;
  if (/insufficient_funds/.test(c)) return "insufficient_funds";
  if (/expired_card/.test(c)) return "card_expired";
  if (/authentication_required/.test(c)) return "authentication_required";
  if (/incorrect_|invalid_(number|cvc|expiry)/.test(c)) return "incorrect_card_details";
  if (/processing_error/.test(c)) return "processing_error";
  if (/card_declined|do_not_honor|generic_decline|fraudulent|lost_card|stolen_card|pickup_card/.test(c)) return "card_declined";
  return code || decline ? "other" : "unknown";
}

const subscriptionOfInvoice = (inv: Record<string, any> | null): string | null => (inv ? idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription) : null);

export function paymentFromCharge(ch: Record<string, any>, tz: string) {
  const cur = currencyOf(ch.currency);
  const bt = objOf(ch.balance_transaction);
  const btCur = bt ? currencyOf(bt.currency) : null;
  const inv = objOf(ch.invoice);
  const status = typeof ch.status === "string" ? ch.status : "unknown";
  const succeeded = status === "succeeded" && ch.paid === true;
  const refunded = int(ch.amount_refunded) ? ch.amount_refunded : 0;
  const amount = int(ch.amount) ? ch.amount : null;
  const decline = str(ch.outcome?.reason);
  return {
    paymentId: ch.id,
    paymentIntentId: idOf(ch.payment_intent),
    source: "stripe",
    customerId: idOf(ch.customer),
    invoiceId: idOf(ch.invoice),
    subscriptionId: subscriptionOfInvoice(inv),
    status,
    outcome: succeeded ? "succeeded" : status === "failed" ? "failed" : status === "pending" ? "pending" : status,
    /** A trusted external receipt (Actual money) only when Stripe says the charge succeeded. */
    receipt: succeeded,
    at: isoOf(ch.created),
    date: dateOf(ch.created, tz),
    currency: cur,
    gross: money(amount, cur),
    refunded: money(refunded, cur),
    refundState: refunded === 0 ? "none" : amount !== null && refunded >= amount ? "full" : "partial",
    fee: bt && int(bt.fee) ? money(bt.fee, btCur) : null,
    netReceived: bt && int(bt.net) ? money(bt.net, btCur) : null,
    settlementCurrency: btCur,
    feeSource: bt ? "stripe_balance_transaction" : succeeded ? "not_yet_available_in_stripe" : "not_applicable",
    availableOn: bt ? dateOf(bt.available_on, tz) : null,
    vat: inv ? taxOfInvoice(inv) : idOf(ch.invoice) ? { state: "invoice_not_expanded", vat: null, netRevenue: null } : taxOfInvoice(null),
    failure: status === "failed" ? { code: str(ch.failure_code), declineCode: decline, category: failureCategory(str(ch.failure_code), decline) } : null,
    disputed: ch.disputed === true,
  };
}

export function refundView(re: Record<string, any>, tz: string) {
  const cur = currencyOf(re.currency);
  const bt = objOf(re.balance_transaction);
  return {
    refundId: re.id,
    paymentId: idOf(re.charge),
    paymentIntentId: idOf(re.payment_intent),
    source: "stripe",
    amount: money(re.amount, cur),
    currency: cur,
    at: isoOf(re.created),
    date: dateOf(re.created, tz),
    status: typeof re.status === "string" ? re.status : "unknown",
    reason: str(re.reason),
    cashImpact: bt && int(bt.net) ? money(bt.net, currencyOf(bt.currency)) : null,
    /** Read-only: the Hub never initiates a refund and never turns one into family credit (F11 / F21). */
    hubAction: "none",
  };
}

/** Totals per currency over the payments' trusted receipts (succeeded charges only) and their refunds. */
export function paymentSummary(payments: ReturnType<typeof paymentFromCharge>[], raw: Record<string, any>[]) {
  const by: Record<string, { receipts: number; failed: number; pending: number; grossMinor: number; feeMinor: number; netMinor: number; refundedMinor: number; feesPending: number }> = {};
  raw.forEach((ch, i) => {
    const p = payments[i];
    const cur = p.currency ?? "UNKNOWN";
    const b = (by[cur] ??= { receipts: 0, failed: 0, pending: 0, grossMinor: 0, feeMinor: 0, netMinor: 0, refundedMinor: 0, feesPending: 0 });
    if (p.receipt) {
      b.receipts++;
      b.grossMinor += int(ch.amount) ? ch.amount : 0;
      b.refundedMinor += int(ch.amount_refunded) ? ch.amount_refunded : 0;
      const bt = objOf(ch.balance_transaction);
      if (bt && int(bt.fee) && int(bt.net)) ((b.feeMinor += bt.fee), (b.netMinor += bt.net));
      else b.feesPending++;
    } else if (p.outcome === "failed") b.failed++;
    else b.pending++;
  });
  return Object.fromEntries(
    Object.entries(by).map(([cur, b]) => [
      cur,
      { receipts: b.receipts, failed: b.failed, pending: b.pending, grossReceived: money(b.grossMinor, cur), stripeFees: money(b.feeMinor, cur), netReceived: money(b.netMinor, cur), refundedFromTheseReceipts: money(b.refundedMinor, cur), receiptsWithoutFeeYet: b.feesPending },
    ])
  );
}

// ---------------------------------------------------------------------
// Latest collection (from the subscription's latest invoice)
// ---------------------------------------------------------------------

export function collectionOfInvoice(inv: Record<string, any> | null, tz: string) {
  if (!inv) return null;
  const cur = currencyOf(inv.currency);
  const ch = objOf(inv.charge);
  const bt = ch ? objOf(ch.balance_transaction) : null;
  const status = typeof inv.status === "string" ? inv.status : "unknown";
  const attempts = int(inv.attempt_count) ? inv.attempt_count : 0;
  const paidAt = int(inv.status_transitions?.paid_at) ? inv.status_transitions.paid_at : null;
  const outcome =
    status === "paid" ? (int(inv.amount_paid) && inv.amount_paid > 0 ? "succeeded" : "nothing_to_collect") : status === "open" ? (attempts > 0 ? "failed" : "awaiting_payment") : status === "draft" ? "not_yet_finalised" : status === "void" ? "voided" : status === "uncollectible" ? "uncollectible" : status;
  return {
    invoiceId: inv.id,
    status,
    outcome,
    currency: cur,
    amount: money(status === "paid" ? inv.amount_paid : inv.amount_due, cur),
    at: isoOf(paidAt ?? inv.created),
    date: dateOf(paidAt ?? inv.created, tz),
    paymentId: idOf(inv.charge),
    fee: bt && int(bt.fee) ? money(bt.fee, currencyOf(bt.currency)) : null,
    netReceived: bt && int(bt.net) ? money(bt.net, currencyOf(bt.currency)) : null,
    feeSource: bt ? "stripe_balance_transaction" : outcome === "succeeded" ? "not_expanded_or_not_yet_available" : "not_applicable",
    attempts,
    nextRetryAt: int(inv.next_payment_attempt) ? isoOf(inv.next_payment_attempt) : null,
    failure: ch && ch.status === "failed" ? { code: str(ch.failure_code), declineCode: str(ch.outcome?.reason), category: failureCategory(str(ch.failure_code), str(ch.outcome?.reason)) } : null,
    vat: taxOfInvoice(inv),
  };
}

// ---------------------------------------------------------------------
// Mapping (customer -> parent by stored link only; player / service unresolved)
// ---------------------------------------------------------------------

export function customerMapping(customerId: string | null, links: CustomerLink[], parents: Map<string, HubParent>) {
  const link = customerId ? links.find((l) => l.customerId === customerId) : undefined;
  if (!link) return { state: "unlinked", parent: null, reason: "No Hub parent is linked to this Stripe customer. The Hub never matches by name or email - Management links it explicitly." };
  const p = parents.get(link.parentRecordId);
  return {
    state: p ? "linked" : "link_broken",
    parent: { parentId: link.parentId, name: p?.name ?? null, active: p?.active ?? null, linkedPlayerCount: p?.linkedPlayerCount ?? null },
    method: link.method,
    linkedAt: link.linkedAt,
    reason: p ? null : "The linked Hub parent record no longer exists - re-check the link",
  };
}

export function playerMapping(cm: ReturnType<typeof customerMapping>) {
  const n = cm.parent?.linkedPlayerCount ?? null;
  return {
    state: "unresolved",
    player: null,
    reason:
      cm.state !== "linked"
        ? "No Hub parent is linked, so no child can be considered"
        : n && n > 1
          ? `The parent has ${n} linked players and Stripe does not say which one this subscription is for - not guessed`
          : "No stable subscription -> player mapping exists; not inferred (even from a single linked player)",
  };
}

export function serviceMapping(plan: ReturnType<typeof planOf>) {
  return {
    state: "unresolved",
    service: null,
    reason: "No stable Stripe price / product -> Finance Service mapping exists yet; never inferred from the amount",
    stripePriceIds: plan.lines.map((l) => l.priceId).filter(Boolean),
    stripeProductIds: [...new Set(plan.lines.map((l) => l.productId).filter(Boolean))],
  };
}

/** The read model for one subscription. */
export function subscriptionView(sub: Record<string, any>, o: { tz: string; fee: FeeEstimate | null; links: CustomerLink[]; parents: Map<string, HubParent>; upcoming?: Record<string, any> | null }) {
  const st = subscriptionState(sub);
  const plan = planOf(sub);
  const period = periodOf(sub);
  const cust = objOf(sub.customer);
  const customerId = idOf(sub.customer);
  const cm = customerMapping(customerId, o.links, o.parents);
  return {
    subscriptionId: sub.id,
    source: "stripe",
    customer: { customerId, name: str(cust?.name), email: str(cust?.email), deleted: cust?.deleted === true },
    mapping: { customer: cm, player: playerMapping(cm), service: serviceMapping(plan) },
    state: st.state,
    stateLabel: st.label,
    stateReason: st.reason,
    stripeStatus: st.stripeStatus,
    cancellation: { scheduled: st.cancellationScheduled, atPeriodEnd: sub.cancel_at_period_end === true, cancelAt: isoOf(sub.cancel_at), canceledAt: isoOf(sub.canceled_at), endedAt: isoOf(sub.ended_at) },
    plan: { currency: plan.currency, gross: plan.gross, amountState: plan.amountState, interval: plan.interval, intervalCount: plan.intervalCount, taxBehavior: plan.taxBehavior, automaticTax: plan.automaticTax, items: plan.lines },
    currentPeriod: { start: isoOf(period.start), end: isoOf(period.end), startDate: dateOf(period.start, o.tz), endDate: dateOf(period.end, o.tz) },
    trialEnd: isoOf(sub.trial_end),
    nextCollection: expectedNextOf(sub, st, o.tz, o.fee, o.upcoming ?? null),
    latestCollection: collectionOfInvoice(objOf(sub.latest_invoice), o.tz),
    metadataKeys: sub.metadata && typeof sub.metadata === "object" ? Object.keys(sub.metadata).sort() : [],
    createdAt: isoOf(sub.created),
  };
}

export function stateCounts(views: { state: HubState }[]) {
  return Object.fromEntries(HUB_STATES.map((s) => [s, views.filter((v) => v.state === s).length]).filter(([, n]) => (n as number) > 0));
}

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

export function stripeAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: STRIPE_CONTRACT } };
}

// ---------------------------------------------------------------------
// Routes + requests
// ---------------------------------------------------------------------

export type StripeRoute =
  | { name: "stripe.status"; params: Record<string, never> }
  | { name: "stripe.settings"; params: Record<string, never> }
  | { name: "stripe.subscriptions"; params: Record<string, never> }
  | { name: "stripe.subscription"; params: { subscriptionId: string } }
  | { name: "stripe.payments"; params: Record<string, never> }
  | { name: "stripe.refunds"; params: Record<string, never> }
  | { name: "stripe.customer_link"; params: { customerId: string } };
export type StripeMatch = { status: "match"; route: StripeRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/** F10 owns stripe/...; there is deliberately no write route against Stripe (no cancel, refund, retry, price or payment-method change). */
export function matchStripeRoute(path: string, method: string): StripeMatch {
  const seg = path.split("/");
  if (seg[0] !== "stripe") return null;
  const m = (allowed: string[], route: StripeRoute): StripeMatch => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg.length === 2 && seg[1] === "status") return m(["GET"], { name: "stripe.status", params: {} });
  if (seg.length === 2 && seg[1] === "settings") return m(["POST"], { name: "stripe.settings", params: {} });
  if (seg.length === 2 && seg[1] === "subscriptions") return m(["GET"], { name: "stripe.subscriptions", params: {} });
  if (seg.length === 3 && seg[1] === "subscriptions" && SUBSCRIPTION_ID_PATTERN.test(seg[2])) return m(["GET"], { name: "stripe.subscription", params: { subscriptionId: seg[2] } });
  if (seg.length === 2 && seg[1] === "payments") return m(["GET"], { name: "stripe.payments", params: {} });
  if (seg.length === 2 && seg[1] === "refunds") return m(["GET"], { name: "stripe.refunds", params: {} });
  if (seg.length === 4 && seg[1] === "customers" && CUSTOMER_ID_PATTERN.test(seg[2]) && seg[3] === "parent-link") return m(["POST"], { name: "stripe.customer_link", params: { customerId: seg[2] } });
  return { status: "not_found" };
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

/** Query rules for the GET routes: tenant keys refused first, then only the route's own keys, each once. */
export function parseStripeQuery(route: StripeRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true; check?: boolean; customer?: string; from?: string; to?: string } | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const allowed: Record<string, string[]> = { "stripe.status": ["check"], "stripe.subscriptions": ["customer"], "stripe.payments": ["from", "to", "customer"], "stripe.refunds": ["from", "to"] };
  const ok = allowed[route] ?? [];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(bad)].join(", ")}`);
  if (new Set(keys).size !== keys.length) return invalid("unexpected_parameter", "A query parameter is repeated");
  const out: { ok: true; check?: boolean; customer?: string; from?: string; to?: string } = { ok: true };
  const c = q.get("check");
  if (c !== null) {
    if (!["1", "true", "0", "false"].includes(c)) return invalid("invalid_query", "check must be 1 / true / 0 / false");
    out.check = c === "1" || c === "true";
  }
  const cu = q.get("customer");
  if (cu !== null) {
    if (!CUSTOMER_ID_PATTERN.test(cu)) return invalid("invalid_query", "customer must be a Stripe customer id (cus_...)");
    out.customer = cu;
  }
  for (const k of ["from", "to"] as const) {
    const v = q.get(k);
    if (v === null) continue;
    if (!DATE_RE.test(v) || isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return invalid("invalid_query", `${k} must be a date YYYY-MM-DD`);
    out[k] = v;
  }
  return out;
}

/** Resolves the inclusive local-date window (default: the last 30 days to today), at most 93 days. */
export function windowOf(from: string | undefined, to: string | undefined, today: string): { ok: true; from: string; to: string } | Invalid {
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const t = to ?? today;
  const f = from ?? shift(t, -(DEFAULT_WINDOW_DAYS - 1));
  if (f > t) return invalid("invalid_query", "from must be on or before to");
  if ((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000 + 1 > MAX_WINDOW_DAYS) return invalid("invalid_query", `The window may be at most ${MAX_WINDOW_DAYS} days`);
  return { ok: true, from: f, to: t };
}

/** UTC epoch seconds of local midnight starting `date` in `tz` (DST-safe: offset taken at that instant). */
export function localMidnightEpoch(date: string, tz: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const offsetAt = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return Math.floor(ms / 1000);
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
function reasonOf(v: unknown, required: boolean): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > REASON_MAX) return { ok: false, error: `must be at most ${REASON_MAX} characters` };
  if (CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

/** POST /stripe/customers/{cus}/parent-link { parentId, reason } - the explicit Management link (never by name / email). */
export function parseParentLink(raw: string, isTenantKey: (k: string) => boolean): { ok: true; parentId: string; reason: string } | Invalid {
  const b = jsonObject(raw, ["parentId", "reason"], isTenantKey);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const p = b.body.parentId;
  if (typeof p !== "string" || !PARENT_ID_PATTERN.test(p.trim())) fields.parentId = "must be a Hub Parent ID (PARENT-...)";
  const r = reasonOf(b.body.reason, true);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was linked", fields);
  return { ok: true, parentId: (p as string).trim(), reason: (r as { ok: true; value: string }).value };
}

/** POST /stripe/settings { feeEstimate: { percentBasisPoints, fixedMinor } | null, reason? } - the only non-secret setting. */
export function parseStripeSettings(raw: string, isTenantKey: (k: string) => boolean): { ok: true; feeEstimate: FeeEstimate | null; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["feeEstimate", "reason"], isTenantKey);
  if (!b.ok) return b;
  if (!("feeEstimate" in b.body)) return invalid("invalid_input", "Nothing to change - send feeEstimate (or null to clear it)");
  const fields: Record<string, string> = {};
  const f = b.body.feeEstimate;
  let fee: FeeEstimate | null = null;
  if (f !== null) {
    const o = f as Record<string, unknown>;
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "percentBasisPoints" && k !== "fixedMinor")) fields.feeEstimate = "must be { percentBasisPoints, fixedMinor } or null";
    else if (!int(o.percentBasisPoints) || o.percentBasisPoints < 0 || o.percentBasisPoints > 1000) fields.feeEstimate = "percentBasisPoints must be a whole number 0-1000 (150 = 1.5 %)";
    else if (!int(o.fixedMinor) || o.fixedMinor < 0 || o.fixedMinor > 1000) fields.feeEstimate = "fixedMinor must be a whole number of pence 0-1000";
    else fee = { percentBasisPoints: o.percentBasisPoints, fixedMinor: o.fixedMinor };
  }
  const r = reasonOf(b.body.reason, false);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, feeEstimate: fee, reason: (r as { ok: true; value: string | null }).value };
}
