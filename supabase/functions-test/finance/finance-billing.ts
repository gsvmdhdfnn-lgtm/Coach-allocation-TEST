/**
 * Finance occurrence billing resolution - PURE (Finance Foundation F4; see
 * TEST-ENV.md "Finance Foundation - F4"). No HTTP, Airtable, Supabase or
 * Deno code.
 *
 * Answers, for ONE Session Occurrence: which commercial setup applies on its
 * date, is it currently eligible for billing, what quantity, and what is the
 * expected billable value - with a trace of where every figure came from.
 *
 * Boundaries (locked):
 *   - F3 says what the agreement is; F4 says what it means for this
 *     occurrence. F4 never edits F3 terms or the lifecycle.
 *   - Schedule owns the occurrence and its status/confirmation. F4 only
 *     READS those facts; it never writes a Schedule record.
 *   - The result is EXPECTED / BILLABLE VALUE. It is never revenue received;
 *     "already invoiced" is F5's concern, not F4's.
 *   - A non-success outcome is never a zero amount: every outcome is named,
 *     and GBP 0.00 appears only when the arithmetic really gives 0.
 */
import { type Minor, calculateVat, formatMinor, formatRatePercent, parseMoney } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import {
  type Client,
  type Service,
  type Terms,
  CHARGE_TYPE_LABELS,
  ID_PATTERNS,
  MAX_BILLABLE_QUANTITY,
  MAX_UNIT_AMOUNT_MINOR,
  PAYER_LABELS,
  REASON_MAX,
  describeTerms,
  formatGBP,
  termsOn,
} from "./finance-commercial.ts";
import { type LifecyclePeriod, isCommerciallyOperating, lifecycleOn } from "./finance-lifecycle.ts";

export const BILLING_CONTRACT = "finance-billing-v1";
export const ENTITY_OVERRIDE = "finance_occurrence_billing_override";
export const OVERRIDE_EVENTS = {
  created: "finance_occurrence_billing_override.created",
  removed: "finance_occurrence_billing_override.removed",
} as const;

/** Longest date range one session read may cover (a school term fits comfortably). */
export const MAX_RANGE_DAYS = 93;

// ---------------------------------------------------------------------
// Schedule facts (read-only input)
// ---------------------------------------------------------------------

export const SCHEDULE_STATUSES = ["Scheduled", "Completed", "Cancelled", "Postponed"] as const;
export const CONFIRMATION_STATES = ["Awaiting Confirmation", "Confirmed", "Exception Recorded"] as const;

export interface OccurrenceFacts {
  /** Schedule's own stable Occurrence ID - the public reference. */
  occurrenceId: string;
  sessionId: string | null;
  sessionName: string | null;
  /** The Session's Finance Service ID exactly as stored (may be blank or malformed). */
  financeServiceRef: string | null;
  date: string;
  start: string | null;
  end: string | null;
  status: string | null;
  confirmationState: string | null;
  exceptionReason: string | null;
  scheduleChangeState: string | null;
  /** Set when the stored Schedule rows cannot be read safely; resolution then reports configuration_error. */
  problem: string | null;
}

// ---------------------------------------------------------------------
// Occurrence billing overrides (Finance-owned, per occurrence)
// ---------------------------------------------------------------------

export const OVERRIDE_KINDS = ["not_billable", "quantity", "amount"] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];
export const OVERRIDE_KIND_LABELS: Record<OverrideKind, string> = { not_billable: "Not billable", quantity: "Billable quantity", amount: "Amount" };

export interface Override {
  overrideId: string;
  occurrenceId: string;
  kind: OverrideKind;
  quantity: number | null;
  amountMinor: Minor | null;
  reason: string;
  /** Service / terms in force when the override was made (history only). */
  serviceId: string | null;
  termsId: string | null;
  createdAt: string | null;
  removedAt: string | null;
  removalReason: string | null;
  supersededBy: string | null;
}

export const isActiveOverride = (o: Override) => o.removedAt === null;

export function publicOverride(o: Override) {
  return {
    overrideId: o.overrideId,
    kind: o.kind,
    kindLabel: OVERRIDE_KIND_LABELS[o.kind],
    quantity: o.quantity,
    amount: o.amountMinor === null ? null : formatMinor(o.amountMinor),
    reason: o.reason,
    serviceId: o.serviceId,
    termsId: o.termsId,
    createdAt: o.createdAt,
    active: isActiveOverride(o),
    removedAt: o.removedAt,
    removalReason: o.removalReason,
    supersededBy: o.supersededBy,
  };
}

// ---------------------------------------------------------------------
// Eligibility from Schedule facts
// ---------------------------------------------------------------------

export type EligibilityStatus = "eligible" | "cancelled" | "postponed" | "not_yet_delivered" | "exception_delivery_unresolved" | "awaiting_confirmation";
export const ELIGIBILITY_LABELS: Record<EligibilityStatus, string> = {
  eligible: "Delivered and confirmed",
  cancelled: "Cancelled - not delivered",
  postponed: "Postponed - the replacement occurrence is billed on its own date",
  not_yet_delivered: "Not delivered yet",
  exception_delivery_unresolved:
    "Something changed was recorded, but Schedule does not yet say whether the session was delivered (Completed) or not (Cancelled / Postponed) - Finance does not guess",
  awaiting_confirmation: "Delivered but not confirmed yet",
};

export type ScheduleEligibility =
  | { ok: true; status: EligibilityStatus; delivered: boolean | null; confirmed: boolean; changeRecorded: boolean }
  | { ok: false; error: string };

/**
 * Encodes the Schedule contracts as they stand (see TEST-ENV.md, Session
 * Occurrences / Slice 6, and F4 correction FIN4.11):
 *   - Status is Scheduled / Completed / Cancelled / Postponed. Cancelled and
 *     Postponed never ran (a postponed occurrence's replacement is its own
 *     occurrence, billed on its own date).
 *   - Confirmation State is the operational confirmation path. Blank /
 *     "Awaiting Confirmation" = not resolved yet. "Confirmed" = went as
 *     planned. "Exception Recorded" = something changed - a RESOLVED
 *     confirmation that on its own says nothing about whether the session
 *     ran, so it is never a blanket "not billable".
 *   - Delivered, for "Confirmed": Completed, or a Scheduled occurrence whose
 *     time has passed (it went as planned, and Schedule treats a past
 *     Scheduled occurrence as having happened).
 *   - Delivered, for "Exception Recorded": ONLY the structured Schedule
 *     status says so - Completed = delivered with a change (eligible; any
 *     one-off commercial difference is an explicit Finance override);
 *     Cancelled / Postponed = not delivered. A still-Scheduled past
 *     occurrence with an exception is UNRESOLVED (the change may have been
 *     that it did not run) - never guessed from time, reason or free text.
 */
export function scheduleEligibility(occ: OccurrenceFacts, now: Date, today: string): ScheduleEligibility {
  if (!(SCHEDULE_STATUSES as readonly string[]).includes(occ.status ?? "")) return { ok: false, error: `Occurrence status "${occ.status ?? ""}" is not a Schedule status` };
  if (occ.confirmationState !== null && !(CONFIRMATION_STATES as readonly string[]).includes(occ.confirmationState)) {
    return { ok: false, error: `Confirmation State "${occ.confirmationState}" is not a Schedule confirmation state` };
  }
  const changeRecorded = occ.confirmationState === "Exception Recorded";
  const confirmed = occ.confirmationState === "Confirmed" || changeRecorded;
  if (occ.status === "Cancelled") return { ok: true, status: "cancelled", delivered: false, confirmed, changeRecorded };
  if (occ.status === "Postponed") return { ok: true, status: "postponed", delivered: false, confirmed, changeRecorded };
  const endsAt = occ.end ?? occ.start;
  const timePassed = endsAt !== null ? Date.parse(endsAt) <= now.getTime() : occ.date < today;
  if (occ.status !== "Completed" && !timePassed) return { ok: true, status: "not_yet_delivered", delivered: false, confirmed, changeRecorded };
  if (changeRecorded) {
    if (occ.status === "Completed") return { ok: true, status: "eligible", delivered: true, confirmed, changeRecorded };
    return { ok: true, status: "exception_delivery_unresolved", delivered: null, confirmed, changeRecorded };
  }
  if (!confirmed) return { ok: true, status: "awaiting_confirmation", delivered: true, confirmed, changeRecorded };
  return { ok: true, status: "eligible", delivered: true, confirmed, changeRecorded };
}

// ---------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------

export type Outcome =
  | "eligible"
  | "not_billable"
  | "not_eligible"
  | "commercially_inactive"
  | "missing_finance_service"
  | "finance_service_not_found"
  | "missing_commercial_terms"
  | "deferred_revenue_model"
  | "configuration_error";

export const OUTCOME_LABELS: Record<Outcome, string> = {
  eligible: "Eligible - expected billable value calculated",
  not_billable: "Marked not billable by Management",
  not_eligible: "Not eligible for billing yet",
  commercially_inactive: "The service was not commercially active on this date",
  missing_finance_service: "The session has no Finance Service - commercial setup is missing",
  finance_service_not_found: "The session's Finance Service does not exist in this organisation",
  missing_commercial_terms: "No commercial terms apply on this date",
  deferred_revenue_model: "Revenue for this service is not calculated per occurrence",
  configuration_error: "The setup is inconsistent - it must be corrected before this occurrence can be resolved",
};

export type DeferralModel = "parent_paid" | "subscription" | "other_charge";
export const DEFERRAL_LABELS: Record<DeferralModel, string> = {
  parent_paid: "Parents pay - revenue comes from parent bookings/payments (a later Finance slice), not a client occurrence charge",
  subscription: "Subscription - revenue is billed per subscription period (a later Finance slice), not per occurrence",
  other_charge: "Other charge - the terms do not say how it applies per occurrence, so no amount is guessed",
};

/** The commercial data one occurrence may need, pre-validated by the caller (orchestrator). */
export interface ServiceContext {
  service: Service;
  client: Client;
  /** Validated, sorted terms history, or why it is invalid. */
  terms: { ok: true; history: Terms[] } | { ok: false; error: string };
  /** Validated applying lifecycle periods. */
  lifecycle: LifecyclePeriod[];
}

export interface Resolution {
  outcome: Outcome;
  detail: string | null;
  occurrence: OccurrenceFacts;
  service: ServiceContext | null;
  lifecycleOnDate: LifecyclePeriod | null;
  terms: Terms | null;
  eligibility: { status: EligibilityStatus | null; delivered: boolean | null; confirmed: boolean | null; changeRecorded: boolean | null; billable: boolean | null };
  quantity: { value: number; source: "default_commercial_quantity" | "occurrence_override" | "per_session"; override: Override | null } | null;
  unitAmount: { minor: Minor; source: "commercial_terms" | "occurrence_override"; override: Override | null } | null;
  expected: { netMinor: Minor; vatMinor: Minor; grossMinor: Minor; amountMinor: Minor } | null;
  deferral: DeferralModel | null;
  overrides: Override[];
}

export const SERVICE_REF_PATTERN = ID_PATTERNS.service;

/**
 * Resolves one occurrence. `findService` looks a Finance Service ID up in
 * the caller's organisation ONLY (null = not there). `overrides` are all
 * override rows for this occurrence (active and historical).
 */
export function resolveOccurrenceBilling(input: {
  occurrence: OccurrenceFacts;
  findService: (serviceId: string) => ServiceContext | null;
  overrides: readonly Override[];
  now: Date;
  today: string;
}): Resolution {
  const occ = input.occurrence;
  const overrides = input.overrides.filter((o) => o.occurrenceId === occ.occurrenceId);
  const active = overrides.filter(isActiveOverride);
  const r: Resolution = {
    outcome: "configuration_error",
    detail: null,
    occurrence: occ,
    service: null,
    lifecycleOnDate: null,
    terms: null,
    eligibility: { status: null, delivered: null, confirmed: null, changeRecorded: null, billable: null },
    quantity: null,
    unitAmount: null,
    expected: null,
    deferral: null,
    overrides,
  };
  const done = (outcome: Outcome, detail: string | null = null): Resolution => ({ ...r, outcome, detail });

  if (occ.problem) return done("configuration_error", occ.problem);
  if (!isIsoDate(occ.date)) return done("configuration_error", "The occurrence has no valid date");
  const sched = scheduleEligibility(occ, input.now, input.today);
  if (!sched.ok) return done("configuration_error", sched.error);
  r.eligibility = { status: sched.status, delivered: sched.delivered, confirmed: sched.confirmed, changeRecorded: sched.changeRecorded, billable: null };

  if (occ.financeServiceRef === null) return done("missing_finance_service", "Link the session to a Finance Service to resolve its billing");
  if (!SERVICE_REF_PATTERN.test(occ.financeServiceRef)) return done("configuration_error", "The session's Finance Service ID is not a valid FSV- reference");
  const ctx = input.findService(occ.financeServiceRef);
  if (!ctx) return done("finance_service_not_found");
  r.service = ctx;
  // An exception recorded while the session pointed at another service is never carried over silently.
  const foreign = active.find((o) => o.serviceId !== null && o.serviceId !== ctx.service.serviceId);
  if (foreign) return done("configuration_error", `Override ${foreign.overrideId} was recorded against Finance Service ${foreign.serviceId}, not ${ctx.service.serviceId} - remove it and record it again`);

  const lc = lifecycleOn(ctx.lifecycle, occ.date);
  if (lc.status !== "resolved") return done("configuration_error", `The service has no lifecycle period covering ${occ.date}`);
  r.lifecycleOnDate = lc.period;
  if (!isCommerciallyOperating(lc.period.status)) return done("commercially_inactive", `The service was ${lc.period.status} on ${occ.date}`);

  if (!ctx.terms.ok) return done("configuration_error", ctx.terms.error);
  const tr = termsOn(ctx.terms.history, occ.date);
  if (tr.status === "none") return done("missing_commercial_terms", `No commercial terms cover ${occ.date}`);
  if (tr.status !== "resolved") return done("configuration_error", tr.status === "invalid" ? tr.error : "Commercial terms overlap on this date");
  const t = tr.terms;
  r.terms = t;

  if (t.payer === "parent") return { ...done("deferred_revenue_model"), deferral: "parent_paid" };
  if (t.chargeType === "subscription") return { ...done("deferred_revenue_model"), deferral: "subscription" };
  if (t.chargeType === "other") return { ...done("deferred_revenue_model"), deferral: "other_charge" };

  for (const kind of OVERRIDE_KINDS) {
    if (active.filter((o) => o.kind === kind).length > 1) return done("configuration_error", `More than one active ${OVERRIDE_KIND_LABELS[kind].toLowerCase()} override exists for this occurrence`);
  }
  const qOv = active.find((o) => o.kind === "quantity") ?? null;
  const aOv = active.find((o) => o.kind === "amount") ?? null;
  const nbOv = active.find((o) => o.kind === "not_billable") ?? null;
  if (qOv && t.chargeType !== "per_player") return done("configuration_error", "A quantity override exists but the terms on this date are not per player");

  if (t.chargeType === "per_player") {
    if (t.defaultBillableQuantity === null) return done("configuration_error", "Per-player terms have no default billable quantity");
    r.quantity = qOv ? { value: qOv.quantity as number, source: "occurrence_override", override: qOv } : { value: t.defaultBillableQuantity, source: "default_commercial_quantity", override: null };
  } else {
    r.quantity = { value: 1, source: "per_session", override: null };
  }
  r.unitAmount = aOv ? { minor: aOv.amountMinor as Minor, source: "occurrence_override", override: aOv } : { minor: t.amountMinor, source: "commercial_terms", override: null };
  const amountMinor = r.unitAmount.minor * r.quantity.value;
  const vat = calculateVat({ amountMinor, treatment: t.vatTreatment, rateBasisPoints: t.vatTreatment === "no_vat" ? null : t.vatRateBasisPoints });
  if (!vat.ok) return done("configuration_error", vat.error);
  r.expected = { amountMinor, netMinor: vat.netMinor, vatMinor: vat.vatMinor, grossMinor: vat.grossMinor };

  r.eligibility = { ...r.eligibility, billable: !nbOv };
  if (nbOv) return done("not_billable", nbOv.reason);
  if (sched.status !== "eligible") return done("not_eligible", ELIGIBILITY_LABELS[sched.status]);
  return done("eligible");
}

// ---------------------------------------------------------------------
// Public result + traceability
// ---------------------------------------------------------------------

const vatWords = (t: Terms) => (t.vatTreatment === "plus_vat" ? " + VAT" : t.vatTreatment === "vat_included" ? " inc. VAT" : "");

export function calculationText(r: Resolution): string | null {
  if (!r.terms || !r.quantity || !r.unitAmount || !r.expected) return null;
  const unit = formatGBP(r.unitAmount.minor);
  const total = `${formatGBP(r.expected.amountMinor)}${vatWords(r.terms)}`;
  return r.terms.chargeType === "per_player" ? `${unit} × ${r.quantity.value} players = ${total}` : `${unit} × 1 delivered session = ${total}`;
}

/** Plain-language lines, one level deeper than the headline, so nobody has to reverse-engineer a figure. */
export function traceLines(r: Resolution): string[] {
  const o = r.occurrence;
  const lines: string[] = [`Occurrence ${o.occurrenceId} on ${o.date}: status ${o.status ?? "unknown"}, confirmation ${o.confirmationState ?? "not recorded"}`];
  if (o.sessionId) lines.push(`Session ${o.sessionId}${o.sessionName ? ` (${o.sessionName})` : ""} -> Finance Service ${o.financeServiceRef ?? "none"}`);
  if (r.service) lines.push(`Service: ${r.service.service.name} for ${r.service.client.name}`);
  if (r.lifecycleOnDate) lines.push(`Service lifecycle on ${o.date}: ${r.lifecycleOnDate.status} (period from ${r.lifecycleOnDate.effectiveFrom ?? "the beginning"}${r.lifecycleOnDate.effectiveUntil ? ` to ${r.lifecycleOnDate.effectiveUntil}` : ""})`);
  if (r.terms) lines.push(`Commercial terms ${r.terms.termsId}, effective ${r.terms.effectiveFrom} to ${r.terms.effectiveUntil ?? "open"}: ${describeTerms(r.terms)}`);
  if (r.quantity && r.terms?.chargeType === "per_player") {
    lines.push(r.quantity.override ? `Quantity ${r.quantity.value}: occurrence override ${r.quantity.override.overrideId} - ${r.quantity.override.reason}` : `Quantity ${r.quantity.value}: default commercial quantity`);
  }
  if (r.unitAmount?.override) lines.push(`Amount ${formatGBP(r.unitAmount.minor)}: occurrence override ${r.unitAmount.override.overrideId} - ${r.unitAmount.override.reason}`);
  const calc = calculationText(r);
  if (calc && r.expected) lines.push(`Calculation: ${calc} -> net £${formatMinor(r.expected.netMinor)}, VAT £${formatMinor(r.expected.vatMinor)}, gross £${formatMinor(r.expected.grossMinor)}`);
  if (r.eligibility.status) {
    const e = r.eligibility;
    if (e.changeRecorded) lines.push(`Schedule recorded that something changed${o.exceptionReason ? ` (${o.exceptionReason})` : ""}: status ${o.status ?? "unknown"}`);
    lines.push(`Eligibility: delivered ${e.delivered === null ? "unresolved" : e.delivered ? "yes" : "no"}, confirmed ${e.confirmed ? "yes" : "no"}, billable ${e.billable === null ? "not assessed" : e.billable ? "yes" : "no"} (${ELIGIBILITY_LABELS[e.status as EligibilityStatus]})`);
  }
  if (r.deferral) lines.push(`Deferred: ${DEFERRAL_LABELS[r.deferral]}`);
  lines.push(`Outcome: ${OUTCOME_LABELS[r.outcome]}${r.detail ? ` - ${r.detail}` : ""}`);
  return lines;
}

export function publicResolution(r: Resolution, today: string) {
  const o = r.occurrence;
  const t = r.terms;
  const money = r.expected && t
    ? {
        currency: "GBP",
        vatTreatment: t.vatTreatment,
        vatRatePercent: formatRatePercent(t.vatTreatment === "no_vat" ? 0 : t.vatRateBasisPoints),
        amount: formatMinor(r.expected.amountMinor),
        net: formatMinor(r.expected.netMinor),
        vat: formatMinor(r.expected.vatMinor),
        gross: formatMinor(r.expected.grossMinor),
        calculation: calculationText(r),
      }
    : null;
  return {
    occurrence: {
      occurrenceId: o.occurrenceId,
      sessionId: o.sessionId,
      sessionName: o.sessionName,
      date: o.date,
      start: o.start,
      end: o.end,
      status: o.status,
      confirmationState: o.confirmationState,
      scheduleChangeState: o.scheduleChangeState,
      exceptionReason: o.exceptionReason,
    },
    outcome: r.outcome,
    outcomeLabel: OUTCOME_LABELS[r.outcome],
    detail: r.detail,
    eligibleForInvoicing: r.outcome === "eligible",
    service: r.service
      ? {
          serviceId: r.service.service.serviceId,
          name: r.service.service.name,
          clientId: r.service.client.clientId,
          clientName: r.service.client.name,
          statusOnDate: r.lifecycleOnDate?.status ?? null,
          lifecycleId: r.lifecycleOnDate?.lifecycleId ?? null,
        }
      : null,
    commercialTerms: t
      ? {
          termsId: t.termsId,
          effectiveFrom: t.effectiveFrom,
          effectiveUntil: t.effectiveUntil,
          payer: t.payer,
          payerLabel: PAYER_LABELS[t.payer],
          chargeType: t.chargeType,
          chargeTypeLabel: CHARGE_TYPE_LABELS[t.chargeType],
          amount: formatMinor(t.amountMinor),
          summary: describeTerms(t),
        }
      : null,
    eligibility: { ...r.eligibility, label: r.eligibility.status ? ELIGIBILITY_LABELS[r.eligibility.status] : null },
    quantity: r.quantity ? { value: r.quantity.value, source: r.quantity.source, overrideId: r.quantity.override?.overrideId ?? null, reason: r.quantity.override?.reason ?? null } : null,
    unitAmount: r.unitAmount ? { amount: formatMinor(r.unitAmount.minor), source: r.unitAmount.source, overrideId: r.unitAmount.override?.overrideId ?? null, reason: r.unitAmount.override?.reason ?? null } : null,
    expected: money,
    billableValue: r.outcome === "eligible" ? money : null,
    deferral: r.deferral ? { model: r.deferral, label: DEFERRAL_LABELS[r.deferral] } : null,
    overrides: r.overrides.map(publicOverride),
    trace: traceLines(r),
    resolvedOn: today,
  };
}

// ---------------------------------------------------------------------
// Override requests
// ---------------------------------------------------------------------

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const LINE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;

function reasonOf(v: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  if (typeof v !== "string" || !v.trim()) return { ok: false, error: "is required" };
  const t = v.trim();
  if (t.length > REASON_MAX) return { ok: false, error: `must be at most ${REASON_MAX} characters` };
  if (LINE_CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, reason: t };
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
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")}`);
  return { ok: true, body: body as Record<string, unknown> };
}

export type OverrideRequest = { kind: OverrideKind; quantity: number | null; amountMinor: Minor | null; reason: string; supersedes: string | null };

/** POST /occurrences/{id}/billing-overrides body: { override: { kind, quantity? | amount? }, reason, supersedes? }. */
export function parseOverrideCreate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: OverrideRequest } | Invalid {
  const b = jsonObject(raw, ["override", "reason", "supersedes"], isTenantKey);
  if (!b.ok) return b;
  const ov = b.body.override;
  if (!ov || typeof ov !== "object" || Array.isArray(ov)) return invalid("invalid_body", "override must be an object");
  const keys = Object.keys(ov as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const unknown = keys.filter((k) => !["kind", "quantity", "amount"].includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unknown override field(s): ${unknown.join(", ")}`);
  const o = ov as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const kind = o.kind as OverrideKind;
  if (!(OVERRIDE_KINDS as readonly string[]).includes(o.kind as string)) fields.kind = `must be one of ${OVERRIDE_KINDS.join(", ")}`;
  let quantity: number | null = null;
  let amountMinor: Minor | null = null;
  if (kind === "quantity") {
    if (typeof o.quantity !== "number" || !Number.isInteger(o.quantity) || o.quantity < 0 || o.quantity > MAX_BILLABLE_QUANTITY) fields.quantity = `must be a whole number 0-${MAX_BILLABLE_QUANTITY}`;
    else quantity = o.quantity;
  } else if (o.quantity !== undefined) fields.quantity = "only applies to a quantity override";
  if (kind === "amount") {
    const m = parseMoney(o.amount);
    if (!m.ok) fields.amount = m.error;
    else if (m.minor < 0 || m.minor > MAX_UNIT_AMOUNT_MINOR) fields.amount = "must be between 0.00 and 100000.00";
    else amountMinor = m.minor;
  } else if (o.amount !== undefined) fields.amount = "only applies to an amount override";
  const reason = reasonOf(b.body.reason);
  if (!reason.ok) fields.reason = reason.error;
  const sup = b.body.supersedes;
  if (sup !== undefined && sup !== null && (typeof sup !== "string" || !ID_PATTERNS.override.test(sup))) fields.supersedes = "must be a FOB- override id";
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, req: { kind, quantity, amountMinor, reason: (reason as { ok: true; reason: string }).reason, supersedes: (sup as string | undefined) ?? null } };
}

/** POST /occurrences/{id}/billing-overrides/{FOB}/remove body: { reason }. */
export function parseOverrideRemove(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey);
  if (!b.ok) return b;
  const reason = reasonOf(b.body.reason);
  if (!reason.ok) return invalid("invalid_input", "Some fields are not valid - nothing was saved", { reason: reason.error });
  return { ok: true, reason: reason.reason };
}

export type OverridePlan =
  | { ok: true; kind: "noop"; existing: Override }
  | { ok: true; kind: "create"; supersede: Override | null }
  | { ok: false; httpStatus: 404 | 409; code: string; error: string };

/**
 * One active override of each kind per occurrence. Replacing one must name
 * it (`supersedes`) - an existing decision is never overwritten by accident;
 * the old row is kept, marked superseded. Re-sending the active decision
 * unchanged is a no-op.
 */
export function planOverrideCreate(existing: readonly Override[], req: OverrideRequest, resolution: Resolution): OverridePlan {
  const fail = (httpStatus: 404 | 409, code: string, error: string): OverridePlan => ({ ok: false, httpStatus, code, error });
  if (!resolution.service) {
    return fail(409, "billing_override_not_applicable", resolution.outcome === "missing_finance_service" ? "The session has no Finance Service - link one before recording billing exceptions" : "The occurrence does not resolve to a Finance Service in your organisation");
  }
  if (req.kind !== "not_billable") {
    const t = resolution.terms;
    if (!t) return fail(409, "billing_override_not_applicable", "No commercial terms apply to this occurrence, so there is nothing to override");
    if (req.kind === "quantity" && t.chargeType !== "per_player") return fail(409, "billing_override_not_applicable", "A quantity override only applies to per-player terms");
    if (req.kind === "amount" && t.chargeType !== "per_player" && t.chargeType !== "fixed_per_session") return fail(409, "billing_override_not_applicable", "An amount override only applies to fixed-per-session or per-player terms");
  }
  const current = existing.filter((o) => isActiveOverride(o) && o.kind === req.kind);
  if (current.length > 1) return fail(409, "billing_override_conflict", "More than one active override of this kind exists - the data must be corrected first");
  const cur = current[0] ?? null;
  if (req.supersedes !== null && (!cur || cur.overrideId !== req.supersedes)) return fail(404, "billing_override_not_found", `No active ${OVERRIDE_KIND_LABELS[req.kind].toLowerCase()} override ${req.supersedes} on this occurrence`);
  if (cur && cur.quantity === req.quantity && cur.amountMinor === req.amountMinor && cur.reason === req.reason) return { ok: true, kind: "noop", existing: cur };
  if (cur && req.supersedes === null) return fail(409, "billing_override_exists", `An active ${OVERRIDE_KIND_LABELS[req.kind].toLowerCase()} override (${cur.overrideId}) already exists - supersede it explicitly`);
  return { ok: true, kind: "create", supersede: cur };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

export const OCCURRENCE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type BillingRoute =
  | { name: "occurrence.billing"; params: { occurrenceId: string } }
  | { name: "session.billing"; params: { sessionId: string } }
  | { name: "override.create"; params: { occurrenceId: string } }
  | { name: "override.remove"; params: { occurrenceId: string; overrideId: string } };

type Match = { status: "match"; route: BillingRoute; queryAllowed: string[] } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/** Matches the F4 paths (null = not an F4 path). Path segments arrive URL-decoded. */
export function matchBillingRoute(path: string, method: string): Match {
  const seg = path.split("/");
  const m = (allowed: string[], route: BillingRoute, queryAllowed: string[] = []): Match => (allowed.includes(method) ? { status: "match", route, queryAllowed } : { status: "method", allowed });
  if (seg[0] === "occurrences") {
    if (seg.length < 3 || !OCCURRENCE_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    const occurrenceId = seg[1];
    if (seg.length === 3 && seg[2] === "billing") return m(["GET"], { name: "occurrence.billing", params: { occurrenceId } });
    if (seg.length === 3 && seg[2] === "billing-overrides") return m(["POST"], { name: "override.create", params: { occurrenceId } });
    if (seg.length === 5 && seg[2] === "billing-overrides" && ID_PATTERNS.override.test(seg[3]) && seg[4] === "remove") return m(["POST"], { name: "override.remove", params: { occurrenceId, overrideId: seg[3] } });
    return { status: "not_found" };
  }
  if (seg[0] === "sessions") {
    if (seg.length !== 3 || !SESSION_ID_PATTERN.test(seg[1]) || seg[2] !== "billing") return { status: "not_found" };
    return m(["GET"], { name: "session.billing", params: { sessionId: seg[1] } }, ["from", "to"]);
  }
  return null;
}

/** Range query for GET /sessions/{id}/billing: from + to required, real dates, from <= to, at most MAX_RANGE_DAYS days. */
export function checkRangeQuery(params: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true; from: string; to: string } | Invalid {
  const keys = [...params.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", "The organisation is taken from your profile and cannot be chosen in the request");
  const bad = keys.filter((k) => k !== "from" && k !== "to");
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${bad.join(", ")}`);
  if (params.getAll("from").length !== 1 || params.getAll("to").length !== 1) return invalid("invalid_input", "from and to are both required, once each", { from: "required", to: "required" });
  const from = params.get("from") as string;
  const to = params.get("to") as string;
  const fields: Record<string, string> = {};
  if (!isIsoDate(from)) fields.from = "must be a real date YYYY-MM-DD";
  if (!isIsoDate(to)) fields.to = "must be a real date YYYY-MM-DD";
  if (!Object.keys(fields).length) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days < 1) fields.to = "must be on or after from";
    else if (days > MAX_RANGE_DAYS) fields.to = `the range may cover at most ${MAX_RANGE_DAYS} days`;
  }
  if (Object.keys(fields).length) return invalid("invalid_input", "The date range is not valid", fields);
  return { ok: true, from, to };
}
