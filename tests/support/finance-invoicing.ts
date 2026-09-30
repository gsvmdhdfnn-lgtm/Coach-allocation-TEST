/**
 * Test-suite copy of the canonical finance/finance-invoicing.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance client invoice DRAFTS + review - PURE (Finance Foundation F5; see
 * TEST-ENV.md "Finance Foundation - F5"). No HTTP, Airtable, Supabase or
 * Deno code.
 *
 * Answers "what eligible, not-yet-claimed work exists for Client X in this
 * billing period?", turns it into a draft whose lines keep the F4 billing
 * snapshot taken when each line was made, and reviews the draft for
 * Management (blockers vs warnings) before it may be marked Ready for issue.
 *
 * Boundaries (locked):
 *   - F4 decides what an occurrence is worth and whether it is billable; F5
 *     only CONSUMES F4 resolutions ("eligible" = delivered + confirmed +
 *     billable + client-paid + calculable). Nothing here prices anything.
 *   - A line is a historical snapshot. It is never recalculated with
 *     today's rules; an open Draft may be deliberately refreshed, a Ready
 *     draft never changes until it is explicitly returned to Draft.
 *   - "Exclude from this invoice" is a draft-only deferral (the work stays
 *     billable). "Not billable" is ONLY the F4 override - F5 has no flag of
 *     its own for it.
 *   - An Included line is the claim on an occurrence: one occurrence may be
 *     Included on at most one line anywhere.
 *   - Delivered + confirmed work with NO commercial terms on its date could
 *     change the total, so it BLOCKS Ready - unless Management records a
 *     draft-specific approved exception for that exact occurrence (reason
 *     required). The exception only lets THIS draft leave the work off; it
 *     never prices it, never makes a £0 line and never touches F3.
 *   - Draft and Ready for issue are the only states. Issuing (F6) freezes a
 *     Ready draft for good: it records the issued invoice's id on the draft,
 *     after which the draft can never be reopened, edited or refreshed, and
 *     its lines keep their claims. A draft started as the replacement for a
 *     corrected invoice carries a correction scope (below). No sending,
 *     payment or overdue here (F7+).
 */
import { type Minor, type VatTreatment, formatMinor, formatRatePercent } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { type ChargeType, type Client, CHARGE_TYPE_LABELS, REASON_MAX, auditEvent, describeTerms } from "./finance-commercial.ts";
import { type EligibilityStatus, type Outcome, type Resolution, BILLING_CONTRACT, ELIGIBILITY_LABELS, MAX_RANGE_DAYS, OCCURRENCE_ID_PATTERN, OUTCOME_LABELS, isActiveOverride, publicOverride } from "./finance-billing.ts";

export const INVOICING_CONTRACT = "finance-invoicing-v1";
export const ENTITY_DRAFT = "finance_invoice_draft";
export const DRAFT_EVENTS = {
  created: "finance_invoice_draft.created",
  refreshed: "finance_invoice_draft.refreshed",
  lineExcluded: "finance_invoice_draft.line_excluded",
  lineRestored: "finance_invoice_draft.line_restored",
  lineMarkedNotBillable: "finance_invoice_draft.line_marked_not_billable",
  poUpdated: "finance_invoice_draft.po_updated",
  poOverrideRecorded: "finance_invoice_draft.po_override_recorded",
  paymentTermsChanged: "finance_invoice_draft.payment_terms_changed",
  markedReady: "finance_invoice_draft.marked_ready",
  returnedToDraft: "finance_invoice_draft.returned_to_draft",
  missingTermsExceptionApproved: "finance_invoice_draft.missing_terms_exception_approved",
} as const;

export const DRAFT_ID_PATTERN = /^FID-[0-9A-F]{12}$/;
export const LINE_ID_PATTERN = /^FIL-[0-9A-F]{12}$/;
export const CLIENT_ID_PATTERN = /^FCL-[0-9A-F]{12}$/;
/** F6 references a draft may carry (the issued invoice; the correction that started a replacement draft). */
export const INVOICE_ID_PATTERN = /^FIV-[0-9A-F]{12}$/;
export const CORRECTION_ID_PATTERN = /^FCN-[0-9A-F]{12}$/;
export function newDraftId(prefix: "FID" | "FIL", randomHex: string): string {
  return `${prefix}-${randomHex.replace(/[^0-9a-f]/gi, "").slice(0, 12).toUpperCase()}`;
}

/** A draft covers at most one F4 range (a month or a school term fits comfortably). */
export const MAX_PERIOD_DAYS = MAX_RANGE_DAYS;
export const PO_NUMBER_MAX = 100;
/** Occurrences one approved-exception request may name. */
export const EXCEPTION_BATCH_MAX = 50;

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

export const DRAFT_STATUSES = ["draft", "ready_for_issue"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = { draft: "Draft", ready_for_issue: "Ready for issue" };

export const LINE_STATUSES = ["included", "excluded", "removed", "superseded"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
export const LINE_STATUS_LABELS: Record<LineStatus, string> = {
  included: "Included",
  excluded: "Excluded from this invoice",
  removed: "Removed - no longer billable",
  superseded: "Superseded by a refreshed line",
};

export const TERMS_SOURCES = ["client", "finance_settings", "invoice_override"] as const;
export type TermsSource = (typeof TERMS_SOURCES)[number];
export const TERMS_SOURCE_LABELS: Record<TermsSource, string> = { client: "Client payment terms", finance_settings: "Finance Settings default", invoice_override: "Set on this invoice" };

/**
 * A draft-specific approved exception: "leave this delivered occurrence,
 * which has no commercial terms on its date, off THIS draft". Recorded once,
 * never edited; the occurrence itself stays unresolved in Finance.
 */
export interface TermsException {
  occurrenceId: string;
  occurrenceDate: string;
  serviceId: string | null;
  reason: string;
  approvedBy: string;
  approvedAt: string;
}

/**
 * A replacement draft's scope (F6 correction). The draft may only bill the
 * corrected occurrences, and for exactly those occurrences the claims held
 * by the corrected invoice(s) - lines of `releasedDraftIds` and the invoice
 * lines issued from them - are released to THIS draft alone. Every other
 * draft still sees them claimed.
 */
export interface CorrectionScope {
  correctionId: string;
  invoiceId: string;
  occurrenceIds: string[];
  releasedDraftIds: string[];
}

export interface Draft {
  draftId: string;
  clientId: string;
  clientName: string;
  status: DraftStatus;
  periodFrom: string;
  periodTo: string;
  paymentTermsDays: number | null;
  paymentTermsSource: TermsSource | null;
  poRequired: boolean;
  poNumber: string | null;
  poOverrideReason: string | null;
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
  includedLines: number;
  revision: number;
  createdBy: string | null;
  createdAt: string | null;
  readyBy: string | null;
  readyAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** Approved missing-terms exceptions for this draft (append-only). */
  termsExceptions: TermsException[];
  /** Set once, when the draft is issued (F6): the draft is then frozen for good. */
  issuedInvoiceId: string | null;
  /** Replacement drafts only: the corrected invoice, the correction and its scope. */
  replacesInvoiceId: string | null;
  correctionId: string | null;
  correctionScope: CorrectionScope | null;
}

export type QuantitySource = "default_commercial_quantity" | "occurrence_override" | "per_session";
export type UnitAmountSource = "commercial_terms" | "occurrence_override";

export interface Line {
  lineId: string;
  draftId: string;
  status: LineStatus;
  occurrenceId: string;
  occurrenceDate: string;
  sessionId: string | null;
  sessionName: string | null;
  serviceId: string;
  serviceName: string;
  termsId: string;
  chargeType: ChargeType;
  description: string;
  quantity: number;
  quantitySource: QuantitySource;
  unitAmountMinor: Minor;
  unitAmountSource: UnitAmountSource;
  amountMinor: Minor;
  vatTreatment: VatTreatment;
  vatRateBasisPoints: number;
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
  /** The ACTIVE F4 overrides the snapshot was built with (sorted). */
  overrideIds: string[];
  /** JSON text: the F4 facts behind the figures, frozen with the line. */
  snapshot: string;
  statusReason: string | null;
  statusChangedBy: string | null;
  statusChangedAt: string | null;
  supersededBy: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

/** An Included line elsewhere (possibly this draft) that claims an occurrence; `invoiceId` when the claim is an issued invoice line. */
export interface Claim {
  lineId: string;
  draftId: string;
  occurrenceId: string;
  invoiceId?: string;
}

/**
 * Applies a replacement draft's correction scope: only the corrected
 * occurrences are this draft's work, and the claims the corrected invoice(s)
 * hold on them are released (for this draft only). No scope = unchanged.
 */
export function applyCorrectionScope<R extends { occurrence: { occurrenceId: string } }>(rs: readonly R[], claims: readonly Claim[], scope: CorrectionScope | null): { rs: R[]; claims: Claim[] } {
  if (!scope) return { rs: [...rs], claims: [...claims] };
  const ids = new Set(scope.occurrenceIds);
  const released = new Set(scope.releasedDraftIds);
  return { rs: rs.filter((r) => ids.has(r.occurrence.occurrenceId)), claims: claims.filter((c) => !(ids.has(c.occurrenceId) && released.has(c.draftId))) };
}

// ---------------------------------------------------------------------
// Eligible work for one client + period (consumes F4 resolutions)
// ---------------------------------------------------------------------

/** Outcomes that mean the stored setup is inconsistent and must be corrected before this client's total can be trusted. */
const SETUP_OUTCOMES: readonly Outcome[] = ["configuration_error", "finance_service_not_found", "missing_finance_service"];
/** not_eligible statuses that may still become billable later (not a blocker; a warning). */
const PENDING_STATUSES: readonly EligibilityStatus[] = ["awaiting_confirmation", "exception_delivery_unresolved"];

export interface Work {
  /** Eligible, client-paid, calculable and not claimed by any Included line. */
  available: Resolution[];
  /** Eligible but already Included on a draft line (the claim). */
  claimed: { resolution: Resolution; claim: Claim }[];
  /** Delivered but not resolved yet (awaiting confirmation / delivery unresolved). */
  pending: Resolution[];
  /** Setup problems for this client's work in the period (blockers for a draft). */
  setup: Resolution[];
  /**
   * Delivered AND confirmed work of the client's services with NO commercial
   * terms on its date (F4 missing_commercial_terms). Never priced, never a
   * £0 line. It could change the invoice total, so on a draft it is a
   * BLOCKER unless the draft carries an approved exception for it.
   * (Missing-terms work still awaiting confirmation is `pending`; cancelled,
   * postponed or not-yet-delivered missing-terms work is `other`.)
   */
  noTerms: Resolution[];
  /** Everything else, named - never money (not billable, cancelled, postponed, not delivered yet, inactive, deferred). */
  other: Resolution[];
}

const byDate = (a: Resolution, b: Resolution) => `${a.occurrence.date} ${a.occurrence.start ?? ""} ${a.occurrence.occurrenceId}`.localeCompare(`${b.occurrence.date} ${b.occurrence.start ?? ""} ${b.occurrence.occurrenceId}`);

/**
 * Sorts every resolution of the client's occurrences in the period. Only an
 * F4 "eligible" result with a calculated value is ever available; every
 * other outcome is named and carries no amount. A claim is any Included
 * line in `claims` (all drafts, this one included).
 */
export function classifyWork(rs: readonly Resolution[], claims: readonly Claim[]): Work {
  const w: Work = { available: [], claimed: [], pending: [], setup: [], noTerms: [], other: [] };
  for (const r of [...rs].sort(byDate)) {
    if (r.outcome === "eligible" && r.expected && r.terms && r.terms.payer === "client" && r.quantity && r.unitAmount && r.service) {
      const claim = claims.find((c) => c.occurrenceId === r.occurrence.occurrenceId);
      if (claim) w.claimed.push({ resolution: r, claim });
      else w.available.push(r);
    } else if (SETUP_OUTCOMES.includes(r.outcome)) w.setup.push(r);
    else if (r.outcome === "missing_commercial_terms") {
      if (r.eligibility.status === "eligible") w.noTerms.push(r);
      else if (r.eligibility.status && PENDING_STATUSES.includes(r.eligibility.status)) w.pending.push(r);
      else w.other.push(r);
    }
    else if (r.outcome === "not_eligible" && r.eligibility.status && PENDING_STATUSES.includes(r.eligibility.status)) w.pending.push(r);
    else w.other.push(r);
  }
  return w;
}

// ---------------------------------------------------------------------
// Line snapshots
// ---------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-04" -> "4 Sep 2026". */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The default line description, e.g. "4 Sep 2026 — PPA" or "10 Sep 2026 — After-school (18 players)". */
export function describeLine(r: Resolution): string {
  const base = `${formatDay(r.occurrence.date)} — ${(r.service as NonNullable<Resolution["service"]>).service.name}`;
  return r.terms?.chargeType === "per_player" && r.quantity ? `${base} (${r.quantity.value} players)` : base;
}

const activeOverrideIds = (r: Resolution) => r.overrides.filter(isActiveOverride).map((o) => o.overrideId).sort();

/** Builds one Included line from an eligible F4 resolution. The figures are copied, never recomputed. */
export function lineFromResolution(r: Resolution, ids: { lineId: string; draftId: string }, meta: { userId: string; at: string; resolvedOn: string }): Line {
  if (r.outcome !== "eligible" || !r.expected || !r.terms || !r.quantity || !r.unitAmount || !r.service) throw new Error("Only an eligible, calculated F4 resolution can become an invoice line");
  const t = r.terms;
  const rate = t.vatTreatment === "no_vat" ? 0 : t.vatRateBasisPoints;
  const snapshot = {
    contract: BILLING_CONTRACT,
    resolvedOn: meta.resolvedOn,
    occurrence: { status: r.occurrence.status, confirmationState: r.occurrence.confirmationState, exceptionReason: r.occurrence.exceptionReason, start: r.occurrence.start, end: r.occurrence.end },
    client: { clientId: r.service.client.clientId, name: r.service.client.name },
    lifecycle: r.lifecycleOnDate ? { lifecycleId: r.lifecycleOnDate.lifecycleId, status: r.lifecycleOnDate.status } : null,
    terms: {
      termsId: t.termsId,
      effectiveFrom: t.effectiveFrom,
      effectiveUntil: t.effectiveUntil,
      payer: t.payer,
      chargeType: t.chargeType,
      amountMinor: t.amountMinor,
      vatTreatment: t.vatTreatment,
      vatRateBasisPoints: t.vatRateBasisPoints,
      defaultBillableQuantity: t.defaultBillableQuantity,
      summary: describeTerms(t),
    },
    quantity: { value: r.quantity.value, source: r.quantity.source, overrideId: r.quantity.override?.overrideId ?? null, reason: r.quantity.override?.reason ?? null },
    unitAmount: { minor: r.unitAmount.minor, source: r.unitAmount.source, overrideId: r.unitAmount.override?.overrideId ?? null, reason: r.unitAmount.override?.reason ?? null },
    overrides: r.overrides.filter(isActiveOverride).map(publicOverride),
  };
  return {
    lineId: ids.lineId,
    draftId: ids.draftId,
    status: "included",
    occurrenceId: r.occurrence.occurrenceId,
    occurrenceDate: r.occurrence.date,
    sessionId: r.occurrence.sessionId,
    sessionName: r.occurrence.sessionName,
    serviceId: r.service.service.serviceId,
    serviceName: r.service.service.name,
    termsId: t.termsId,
    chargeType: t.chargeType,
    description: describeLine(r),
    quantity: r.quantity.value,
    quantitySource: r.quantity.source,
    unitAmountMinor: r.unitAmount.minor,
    unitAmountSource: r.unitAmount.source,
    amountMinor: r.expected.amountMinor,
    vatTreatment: t.vatTreatment,
    vatRateBasisPoints: rate,
    netMinor: r.expected.netMinor,
    vatMinor: r.expected.vatMinor,
    grossMinor: r.expected.grossMinor,
    overrideIds: activeOverrideIds(r),
    snapshot: JSON.stringify(snapshot),
    statusReason: null,
    statusChangedBy: null,
    statusChangedAt: null,
    supersededBy: null,
    createdBy: meta.userId,
    createdAt: meta.at,
  };
}

/** Does the current F4 resolution still give exactly this line's figures and sources? */
export function sameSource(line: Line, r: Resolution): boolean {
  if (r.outcome !== "eligible" || !r.expected || !r.terms || !r.quantity || !r.unitAmount || !r.service) return false;
  const rate = r.terms.vatTreatment === "no_vat" ? 0 : r.terms.vatRateBasisPoints;
  return (
    line.serviceId === r.service.service.serviceId &&
    line.termsId === r.terms.termsId &&
    line.chargeType === r.terms.chargeType &&
    line.quantity === r.quantity.value &&
    line.quantitySource === r.quantity.source &&
    line.unitAmountMinor === r.unitAmount.minor &&
    line.unitAmountSource === r.unitAmount.source &&
    line.amountMinor === r.expected.amountMinor &&
    line.vatTreatment === r.terms.vatTreatment &&
    line.vatRateBasisPoints === rate &&
    line.netMinor === r.expected.netMinor &&
    line.vatMinor === r.expected.vatMinor &&
    line.grossMinor === r.expected.grossMinor &&
    line.overrideIds.join(",") === activeOverrideIds(r).join(",")
  );
}

/** Why an occurrence is not (or no longer) invoiceable, in Management language. */
export function notInvoiceableReason(r: Resolution | undefined): string {
  if (!r) return "The occurrence is no longer in this client's work for the period";
  if (r.outcome === "not_eligible" && r.eligibility.status) return ELIGIBILITY_LABELS[r.eligibility.status];
  return `${OUTCOME_LABELS[r.outcome]}${r.detail ? ` - ${r.detail}` : ""}`;
}

// ---------------------------------------------------------------------
// Totals (integer pence only)
// ---------------------------------------------------------------------

export function totalsOf(lines: readonly Line[]): { netMinor: Minor; vatMinor: Minor; grossMinor: Minor; includedLines: number } {
  let net = 0;
  let vat = 0;
  let gross = 0;
  let n = 0;
  for (const l of lines) {
    if (l.status !== "included") continue;
    net += l.netMinor;
    vat += l.vatMinor;
    gross += l.grossMinor;
    n++;
  }
  return { netMinor: net, vatMinor: vat, grossMinor: gross, includedLines: n };
}

// ---------------------------------------------------------------------
// Payment terms (client override, else the Finance Settings default)
// ---------------------------------------------------------------------

export function defaultPaymentTerms(client: Client, settingsDefault: number | null): { days: number | null; source: TermsSource | null } {
  if (client.paymentTermsDaysOverride !== null) return { days: client.paymentTermsDaysOverride, source: "client" };
  if (settingsDefault !== null) return { days: settingsDefault, source: "finance_settings" };
  return { days: null, source: null };
}

// ---------------------------------------------------------------------
// Planning (pure): create + refresh
// ---------------------------------------------------------------------

export type Refusal = { ok: false; httpStatus: 404 | 409; code: string; error: string };
const refuse = (httpStatus: 404 | 409, code: string, error: string): Refusal => ({ ok: false, httpStatus, code, error });

const overlaps = (a: { periodFrom: string; periodTo: string }, from: string, to: string) => a.periodFrom <= to && from <= a.periodTo;

/**
 * Creating a draft. Refused (nothing written) when: the client is billed
 * manually; an OPEN draft for this client already overlaps the period (the
 * duplicate-draft rule - finish or mark that one Ready first); or no
 * eligible, unclaimed work exists (a draft is never created empty and a
 * missing setup is never a £0 line).
 */
export function planDraftCreate(input: { client: Client; drafts: readonly Draft[]; work: Work; from: string; to: string; settingsDefaultTerms: number | null }): { ok: true; terms: { days: number | null; source: TermsSource | null } } | Refusal {
  const c = input.client;
  if (c.billingMethod === "manual") return refuse(409, "manual_billing_client", `${c.name} is billed manually outside the Hub - no Hub invoice draft is made for it`);
  const open = input.drafts.find((d) => d.clientId === c.clientId && d.status === "draft" && d.replacesInvoiceId === null && overlaps(d, input.from, input.to));
  if (open) return refuse(409, "open_draft_exists", `${open.draftId} is already an open draft for ${c.name} covering ${open.periodFrom} to ${open.periodTo} - refresh or finish it instead of starting another`);
  if (!input.work.available.length) return refuse(409, "no_eligible_work", `There is no eligible, unclaimed work for ${c.name} between ${input.from} and ${input.to}`);
  return { ok: true, terms: defaultPaymentTerms(c, input.settingsDefaultTerms) };
}

export interface RefreshPlan {
  /** Lines to close: removed (no longer invoiceable) or superseded (figures changed). */
  close: { line: Line; status: "removed" | "superseded"; reason: string; replacement: Resolution | null }[];
  /** New eligible work to add as Included lines. */
  add: Resolution[];
  header: { clientName: string; poRequired: boolean; paymentTermsDays: number | null; paymentTermsSource: TermsSource | null };
  changed: boolean;
}

/**
 * Deliberate refresh of an OPEN draft against today's F4 results. Unchanged
 * lines are kept as they are; a line whose occurrence is no longer
 * invoiceable is removed; a line whose figures changed is superseded by a
 * new line (the old one is kept, never edited); new available work is
 * added. Occurrences Management excluded from this draft stay excluded.
 * Client name / PO requirement / default payment terms are re-read from the
 * client (an invoice-level terms override is kept).
 */
export function planRefresh(input: { draft: Draft; lines: readonly Line[]; current: ReadonlyMap<string, Resolution>; work: Work; client: Client; settingsDefaultTerms: number | null }): RefreshPlan {
  const { draft, lines, current, work } = input;
  const included = lines.filter((l) => l.status === "included");
  const excluded = new Set(lines.filter((l) => l.status === "excluded").map((l) => l.occurrenceId));
  const mine = new Set(included.map((l) => l.lineId));
  const close: RefreshPlan["close"] = [];
  for (const l of included) {
    const r = current.get(l.occurrenceId);
    const claimedElsewhere = work.claimed.some((c) => c.resolution.occurrence.occurrenceId === l.occurrenceId && !mine.has(c.claim.lineId));
    const invoiceable = r && r.outcome === "eligible" && r.terms?.payer === "client" && r.expected && !claimedElsewhere;
    if (!invoiceable) close.push({ line: l, status: "removed", reason: claimedElsewhere ? "The occurrence is claimed by another invoice draft" : notInvoiceableReason(r), replacement: null });
    else if (!sameSource(l, r)) close.push({ line: l, status: "superseded", reason: "The F4 billing figures changed since this line was made", replacement: r });
  }
  const onDraft = new Set([...included.map((l) => l.occurrenceId), ...excluded]);
  const add = work.available.filter((r) => !onDraft.has(r.occurrence.occurrenceId));
  const terms = draft.paymentTermsSource === "invoice_override" ? { days: draft.paymentTermsDays, source: draft.paymentTermsSource as TermsSource } : defaultPaymentTerms(input.client, input.settingsDefaultTerms);
  const header = { clientName: input.client.name, poRequired: input.client.poRequired, paymentTermsDays: terms.days, paymentTermsSource: terms.source };
  const headerChanged = header.clientName !== draft.clientName || header.poRequired !== draft.poRequired || header.paymentTermsDays !== draft.paymentTermsDays || header.paymentTermsSource !== draft.paymentTermsSource;
  return { close, add, header, changed: close.length > 0 || add.length > 0 || headerChanged };
}

// ---------------------------------------------------------------------
// Review: blockers vs warnings
// ---------------------------------------------------------------------

export type Severity = "blocker" | "warning";
export interface Check {
  code: string;
  severity: Severity;
  message: string;
  lineIds?: string[];
  occurrenceIds?: string[];
}

export interface ApprovedException {
  type: "missing_commercial_terms";
  occurrenceId: string;
  date: string;
  serviceId: string | null;
  reason: string;
  approvedBy: string;
  approvedAt: string;
  /** Whether the occurrence still has no commercial terms (false: resolved since - it is then normal work again). */
  stillMissingTerms: boolean;
}

export interface Review {
  readyForIssue: boolean;
  blockers: Check[];
  warnings: Check[];
  /** Approved exceptions on this draft - shown apart from unresolved blockers. */
  approvedExceptions: ApprovedException[];
  totals: { net: string; vat: string; gross: string; includedLines: number; reconciles: boolean };
}

/**
 * The compact "Check before sending" for one draft (Design Pack p11): a
 * blocker is anything that could change the total or make the invoice
 * wrong to issue; a warning is something Management should see but may
 * accept. Reviewing never writes and never changes a snapshot.
 *   `current`: today's F4 resolution for every occurrence of the client's
 *   services in the draft period; `work`: the same classified;
 *   `claims`: every Included line (all drafts) for those occurrences and
 *   this draft's own lines.
 */
export function reviewDraft(input: { draft: Draft; lines: readonly Line[]; client: Client | null; current: ReadonlyMap<string, Resolution>; work: Work; claims: readonly Claim[] }): Review {
  const { draft, lines, client, current, work, claims } = input;
  const blockers: Check[] = [];
  const warnings: Check[] = [];
  const b = (c: Omit<Check, "severity">) => blockers.push({ ...c, severity: "blocker" });
  const w = (c: Omit<Check, "severity">) => warnings.push({ ...c, severity: "warning" });
  const included = lines.filter((l) => l.status === "included");

  if (!included.length) b({ code: "no_included_lines", message: "The draft has no included lines - there is nothing to invoice" });
  if (!client) b({ code: "client_not_found", message: `Client ${draft.clientId} no longer exists in Finance` });
  else {
    if (client.billingMethod === "manual") b({ code: "manual_billing_client", message: `${client.name} is now billed manually outside the Hub` });
    if (!client.billingEmail) b({ code: "billing_email_missing", message: `${client.name} has no billing email - add one to the client before this invoice can be issued` });
    if (client.status === "inactive") w({ code: "client_inactive", message: `${client.name} is inactive - the draft only bills work already delivered` });
    if (client.poRequired !== draft.poRequired) w({ code: "po_requirement_changed", message: `The client's PO requirement changed since this draft was made (now ${client.poRequired ? "required" : "not required"}) - refresh the draft to apply it` });
  }
  if (draft.poRequired && !draft.poNumber && !draft.poOverrideReason) b({ code: "po_missing", message: "This client requires a PO - add the PO number, or record an override reason" });
  if (draft.poRequired && !draft.poNumber && draft.poOverrideReason) w({ code: "po_override_recorded", message: `No PO number - override recorded: ${draft.poOverrideReason}` });
  if (draft.paymentTermsDays === null) b({ code: "payment_terms_missing", message: "No payment terms: set the client's terms or the Finance Settings default, or set terms on this invoice" });
  else if (draft.paymentTermsSource === "invoice_override") w({ code: "payment_terms_overridden", message: `Payment terms set on this invoice: ${draft.paymentTermsDays} days` });

  // Source changes: a snapshot is never rewritten, but a stale one blocks issue.
  const changed = included.filter((l) => {
    const r = current.get(l.occurrenceId);
    return !r || !sameSource(l, r);
  });
  if (changed.length) {
    b({
      code: "source_changed",
      message: `${changed.length} line(s) no longer match today's billing (${changed.map((l) => `${l.description}: ${current.get(l.occurrenceId)?.outcome === "eligible" ? "figures changed" : notInvoiceableReason(current.get(l.occurrenceId))}`).join("; ")})${draft.status === "draft" ? " - refresh the draft" : " - return it to Draft and refresh"}`,
      lineIds: changed.map((l) => l.lineId),
    });
  }

  // Duplicate claims: an occurrence Included more than once anywhere.
  const dup = included.filter((l) => claims.some((c) => c.occurrenceId === l.occurrenceId && c.draftId !== draft.draftId) || included.some((o) => o !== l && o.occurrenceId === l.occurrenceId));
  if (dup.length) b({ code: "duplicate_claim", message: `${dup.length} line(s) bill an occurrence that is also included on another line`, lineIds: dup.map((l) => l.lineId) });

  if (work.setup.length) {
    b({
      code: "unresolved_configuration",
      message: `${work.setup.length} occurrence(s) of this client's services in the period cannot be priced until the setup is fixed (${work.setup.slice(0, 3).map((r) => `${r.occurrence.date}: ${OUTCOME_LABELS[r.outcome]}`).join("; ")}${work.setup.length > 3 ? "; ..." : ""})`,
      occurrenceIds: work.setup.map((r) => r.occurrence.occurrenceId),
    });
  }

  // Line arithmetic + stored totals must reconcile exactly.
  const t = totalsOf(lines);
  const badLine = included.filter((l) => l.netMinor + l.vatMinor !== l.grossMinor);
  const reconciles = !badLine.length && t.netMinor === draft.netMinor && t.vatMinor === draft.vatMinor && t.grossMinor === draft.grossMinor && t.includedLines === draft.includedLines && t.netMinor + t.vatMinor === t.grossMinor;
  if (!reconciles) b({ code: "totals_do_not_reconcile", message: "The stored draft totals do not equal the sum of its included lines (net + VAT = gross)", lineIds: badLine.map((l) => l.lineId) });

  const excl = lines.filter((l) => l.status === "excluded");
  if (excl.length) w({ code: "excluded_work", message: `${excl.length} item(s) excluded from this invoice (they stay billable and can go on a later invoice)`, lineIds: excl.map((l) => l.lineId) });
  const ov = included.filter((l) => l.quantitySource === "occurrence_override" || l.unitAmountSource === "occurrence_override");
  if (ov.length) w({ code: "billing_overrides", message: `${ov.length} line(s) use a Management billing override (quantity or amount)`, lineIds: ov.map((l) => l.lineId) });
  const zero = included.filter((l) => l.grossMinor === 0);
  if (zero.length) w({ code: "zero_value_lines", message: `${zero.length} included line(s) are worth £0.00`, lineIds: zero.map((l) => l.lineId) });
  // Delivered + confirmed work without commercial terms: a blocker unless an approved exception covers that exact occurrence.
  const excepted = new Set(draft.termsExceptions.map((e) => e.occurrenceId));
  const unresolvedTerms = work.noTerms.filter((r) => !excepted.has(r.occurrence.occurrenceId));
  const coveredTerms = work.noTerms.filter((r) => excepted.has(r.occurrence.occurrenceId));
  const dates = (rs: Resolution[]) => `${rs.slice(0, 3).map((r) => r.occurrence.date).join(", ")}${rs.length > 3 ? ", ..." : ""}`;
  if (unresolvedTerms.length) {
    b({
      code: "missing_commercial_terms",
      message: `${unresolvedTerms.length} delivered and confirmed occurrence(s) of this client's services have no commercial terms on their date (${dates(unresolvedTerms)}) - they could change this invoice's total. Fix the commercial setup, or record an approved exception to leave them off this invoice`,
      occurrenceIds: unresolvedTerms.map((r) => r.occurrence.occurrenceId),
    });
  }
  if (coveredTerms.length) {
    w({
      code: "missing_terms_exception_approved",
      message: `${coveredTerms.length} occurrence(s) without commercial terms are left off this invoice by an approved exception (${dates(coveredTerms)}) - they stay unresolved in Finance`,
      occurrenceIds: coveredTerms.map((r) => r.occurrence.occurrenceId),
    });
  }
  const stillMissing = new Set(work.noTerms.map((r) => r.occurrence.occurrenceId));
  if (work.pending.length) w({ code: "unconfirmed_work", message: `${work.pending.length} delivered occurrence(s) in the period are not confirmed yet and are not on this invoice`, occurrenceIds: work.pending.map((r) => r.occurrence.occurrenceId) });
  const onDraft = new Set(lines.filter((l) => l.status === "included" || l.status === "excluded").map((l) => l.occurrenceId));
  const fresh = work.available.filter((r) => !onDraft.has(r.occurrence.occurrenceId));
  if (fresh.length) w({ code: "new_eligible_work", message: `${fresh.length} eligible occurrence(s) in the period are not on this draft yet${draft.status === "draft" ? " - refresh to add them" : ""}`, occurrenceIds: fresh.map((r) => r.occurrence.occurrenceId) });

  return {
    readyForIssue: blockers.length === 0,
    blockers,
    warnings,
    approvedExceptions: draft.termsExceptions.map((e) => ({ type: "missing_commercial_terms" as const, occurrenceId: e.occurrenceId, date: e.occurrenceDate, serviceId: e.serviceId, reason: e.reason, approvedBy: e.approvedBy, approvedAt: e.approvedAt, stillMissingTerms: stillMissing.has(e.occurrenceId) })),
    totals: { net: formatMinor(t.netMinor), vat: formatMinor(t.vatMinor), gross: formatMinor(t.grossMinor), includedLines: t.includedLines, reconciles },
  };
}

// ---------------------------------------------------------------------
// Public bodies (no storage ids)
// ---------------------------------------------------------------------

export function publicDraft(d: Draft) {
  return {
    draftId: d.draftId,
    clientId: d.clientId,
    clientName: d.clientName,
    status: d.status,
    statusLabel: DRAFT_STATUS_LABELS[d.status],
    period: { from: d.periodFrom, to: d.periodTo },
    paymentTerms: { days: d.paymentTermsDays, source: d.paymentTermsSource, sourceLabel: d.paymentTermsSource ? TERMS_SOURCE_LABELS[d.paymentTermsSource] : null },
    po: { required: d.poRequired, number: d.poNumber, overrideReason: d.poOverrideReason },
    totals: { currency: "GBP", net: formatMinor(d.netMinor), vat: formatMinor(d.vatMinor), gross: formatMinor(d.grossMinor), includedLines: d.includedLines },
    revision: d.revision,
    missingTermsExceptions: d.termsExceptions.map((e) => ({ occurrenceId: e.occurrenceId, date: e.occurrenceDate, serviceId: e.serviceId, reason: e.reason, approvedBy: e.approvedBy, approvedAt: e.approvedAt })),
    issued: d.issuedInvoiceId !== null,
    issuedInvoiceId: d.issuedInvoiceId,
    replacement: d.replacesInvoiceId ? { replacesInvoiceId: d.replacesInvoiceId, correctionId: d.correctionId, occurrenceIds: [...(d.correctionScope?.occurrenceIds ?? [])] } : null,
    createdAt: d.createdAt,
    readyAt: d.readyAt,
    updatedAt: d.updatedAt,
  };
}

export function publicLine(l: Line) {
  return {
    lineId: l.lineId,
    status: l.status,
    statusLabel: LINE_STATUS_LABELS[l.status],
    statusReason: l.statusReason,
    supersededBy: l.supersededBy,
    occurrenceId: l.occurrenceId,
    date: l.occurrenceDate,
    sessionId: l.sessionId,
    sessionName: l.sessionName,
    serviceId: l.serviceId,
    serviceName: l.serviceName,
    termsId: l.termsId,
    chargeType: l.chargeType,
    chargeTypeLabel: CHARGE_TYPE_LABELS[l.chargeType],
    description: l.description,
    quantity: l.quantity,
    quantitySource: l.quantitySource,
    unitAmount: formatMinor(l.unitAmountMinor),
    unitAmountSource: l.unitAmountSource,
    amount: formatMinor(l.amountMinor),
    vatTreatment: l.vatTreatment,
    vatRatePercent: formatRatePercent(l.vatRateBasisPoints),
    net: formatMinor(l.netMinor),
    vat: formatMinor(l.vatMinor),
    gross: formatMinor(l.grossMinor),
    overrideIds: [...l.overrideIds],
    createdAt: l.createdAt,
  };
}

/** One piece of work in the eligible-work read (money only when available / claimed). */
export function publicWorkItem(r: Resolution, claim: Claim | null = null) {
  const money = r.outcome === "eligible" && r.expected && r.terms ? { net: formatMinor(r.expected.netMinor), vat: formatMinor(r.expected.vatMinor), gross: formatMinor(r.expected.grossMinor) } : null;
  return {
    occurrenceId: r.occurrence.occurrenceId,
    date: r.occurrence.date,
    sessionId: r.occurrence.sessionId,
    serviceId: r.service?.service.serviceId ?? r.occurrence.financeServiceRef,
    serviceName: r.service?.service.name ?? null,
    outcome: r.outcome,
    reason: r.outcome === "eligible" ? null : notInvoiceableReason(r),
    description: r.service && r.outcome === "eligible" ? describeLine(r) : null,
    quantity: r.quantity?.value ?? null,
    unitAmount: r.unitAmount ? formatMinor(r.unitAmount.minor) : null,
    value: money,
    claimedBy: claim ? { draftId: claim.draftId, lineId: claim.lineId } : null,
  };
}

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

export const auditDraft = (d: Draft) => ({
  draftId: d.draftId,
  clientId: d.clientId,
  status: d.status,
  periodFrom: d.periodFrom,
  periodTo: d.periodTo,
  paymentTermsDays: d.paymentTermsDays,
  paymentTermsSource: d.paymentTermsSource,
  poRequired: d.poRequired,
  poNumber: d.poNumber,
  poOverrideReason: d.poOverrideReason,
  netMinor: d.netMinor,
  vatMinor: d.vatMinor,
  grossMinor: d.grossMinor,
  includedLines: d.includedLines,
  revision: d.revision,
  missingTermsExceptions: d.termsExceptions.map((e) => e.occurrenceId),
  issuedInvoiceId: d.issuedInvoiceId,
  replacesInvoiceId: d.replacesInvoiceId,
  correctionId: d.correctionId,
});
export const auditLine = (l: Line) => ({ lineId: l.lineId, occurrenceId: l.occurrenceId, status: l.status, termsId: l.termsId, quantity: l.quantity, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor, overrideIds: l.overrideIds });

export function draftAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; draftId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent({ ...a, entityType: ENTITY_DRAFT, recordId: a.draftId });
  return { ...e, context: { ...e.context, contract: INVOICING_CONTRACT } };
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const LINE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

function jsonObject(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean, emptyOk = false): { ok: true; body: Record<string, unknown> } | Invalid {
  if (!raw.trim()) return emptyOk ? { ok: true, body: {} } : invalid("invalid_body", "Body must be a JSON object");
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

function textOf(v: unknown, max: number, required: boolean): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if (LINE_CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

function periodOf(from: unknown, to: unknown): { ok: true; from: string; to: string } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (typeof from !== "string" || !isIsoDate(from)) fields.from = "must be a real date YYYY-MM-DD";
  if (typeof to !== "string" || !isIsoDate(to)) fields.to = "must be a real date YYYY-MM-DD";
  if (!Object.keys(fields).length) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
    if (days < 1) fields.to = "must be on or after from";
    else if (days > MAX_PERIOD_DAYS) fields.to = `a billing period may cover at most ${MAX_PERIOD_DAYS} days`;
  }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, from: from as string, to: to as string };
}

/** GET /invoicing/eligible?clientId&from&to and GET /invoice-drafts?clientId. */
export function checkInvoicingQuery(params: URLSearchParams, needPeriod: boolean, isTenantKey: (k: string) => boolean): { ok: true; clientId: string; from: string; to: string } | Invalid {
  const keys = [...params.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const allowed = needPeriod ? ["clientId", "from", "to"] : ["clientId"];
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${bad.join(", ")}`);
  if (allowed.some((k) => params.getAll(k).length !== 1)) return invalid("invalid_input", `${allowed.join(", ")} are required, once each`, Object.fromEntries(allowed.filter((k) => params.getAll(k).length !== 1).map((k) => [k, "required once"])));
  const clientId = params.get("clientId") as string;
  if (!CLIENT_ID_PATTERN.test(clientId)) return invalid("invalid_input", "clientId must be a FCL- client id", { clientId: "must be a FCL- client id" });
  if (!needPeriod) return { ok: true, clientId, from: "", to: "" };
  const p = periodOf(params.get("from"), params.get("to"));
  if (!p.ok) return invalid("invalid_input", "The billing period is not valid", p.fields);
  return { ok: true, clientId, from: p.from, to: p.to };
}

export type CreateRequest = { clientId: string; from: string; to: string };

/** POST /invoice-drafts { clientId, from, to }. */
export function parseDraftCreate(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: CreateRequest } | Invalid {
  const b = jsonObject(raw, ["clientId", "from", "to"], isTenantKey);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  if (typeof b.body.clientId !== "string" || !CLIENT_ID_PATTERN.test(b.body.clientId)) fields.clientId = "must be a FCL- client id";
  const p = periodOf(b.body.from, b.body.to);
  if (!p.ok) Object.assign(fields, p.fields);
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  const pp = p as { ok: true; from: string; to: string };
  return { ok: true, req: { clientId: b.body.clientId as string, from: pp.from, to: pp.to } };
}

/** { reason } bodies. `required`: exclude / not-billable / reopen; optional: refresh / restore (an empty body is allowed). */
export function parseReasonBody(raw: string, required: boolean, isTenantKey: (k: string) => boolean): { ok: true; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey, !required);
  if (!b.ok) return b;
  const r = textOf(b.body.reason, REASON_MAX, required);
  if (!r.ok) return invalid("invalid_input", "Some fields are not valid - nothing was saved", { reason: r.error });
  return { ok: true, reason: r.value };
}

export type DetailsRequest = { poNumber?: string | null; poOverrideReason?: string | null; paymentTermsDays?: number | null; reason: string | null };

/**
 * POST /invoice-drafts/{id}/details: any of poNumber (text or null to
 * clear), poOverrideReason (text or null to clear), paymentTermsDays
 * (0-365 = set on this invoice; null = back to the client / Finance
 * Settings default), and an optional reason.
 */
export function parseDetails(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: DetailsRequest } | Invalid {
  const b = jsonObject(raw, ["poNumber", "poOverrideReason", "paymentTermsDays", "reason"], isTenantKey);
  if (!b.ok) return b;
  const x = b.body;
  if (!("poNumber" in x) && !("poOverrideReason" in x) && !("paymentTermsDays" in x)) return invalid("invalid_body", "Name at least one of poNumber, poOverrideReason, paymentTermsDays");
  const fields: Record<string, string> = {};
  const req: DetailsRequest = { reason: null };
  if ("poNumber" in x) {
    const t = textOf(x.poNumber, PO_NUMBER_MAX, false);
    if (!t.ok) fields.poNumber = t.error;
    else req.poNumber = t.value;
  }
  if ("poOverrideReason" in x) {
    const t = textOf(x.poOverrideReason, REASON_MAX, false);
    if (!t.ok) fields.poOverrideReason = t.error;
    else req.poOverrideReason = t.value;
  }
  if ("paymentTermsDays" in x) {
    const v = x.paymentTermsDays;
    if (v === null) req.paymentTermsDays = null;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 365) fields.paymentTermsDays = "must be a whole number of days 0-365, or null for the default";
    else req.paymentTermsDays = v;
  }
  const r = textOf(x.reason, REASON_MAX, false);
  if (!r.ok) fields.reason = r.error;
  else req.reason = r.value;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, req };
}

/** POST /invoice-drafts/{id}/ready { revision, reason? } - the revision Management reviewed. */
export function parseReady(raw: string, isTenantKey: (k: string) => boolean): { ok: true; revision: number; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["revision", "reason"], isTenantKey);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const v = b.body.revision;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fields.revision = "must be the draft revision you reviewed";
  const r = textOf(b.body.reason, REASON_MAX, false);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, revision: v as number, reason: (r as { ok: true; value: string | null }).value };
}

/**
 * POST /invoice-drafts/{id}/missing-terms-exceptions
 * { occurrenceIds: [exact Occurrence IDs, 1-50, no repeats], reason }.
 */
export function parseTermsException(raw: string, isTenantKey: (k: string) => boolean): { ok: true; occurrenceIds: string[]; reason: string } | Invalid {
  const b = jsonObject(raw, ["occurrenceIds", "reason"], isTenantKey);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const ids = b.body.occurrenceIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > EXCEPTION_BATCH_MAX) fields.occurrenceIds = `must list 1-${EXCEPTION_BATCH_MAX} exact occurrence ids`;
  else if (ids.some((id) => typeof id !== "string" || !OCCURRENCE_ID_PATTERN.test(id))) fields.occurrenceIds = "must contain only valid occurrence ids";
  else if (new Set(ids).size !== ids.length) fields.occurrenceIds = "must not repeat an occurrence id";
  const r = textOf(b.body.reason, REASON_MAX, true);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  return { ok: true, occurrenceIds: [...(ids as string[])], reason: (r as { ok: true; value: string }).value };
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

export type InvoicingRoute =
  | { name: "eligible.read"; params: Record<string, never> }
  | { name: "drafts.list" | "draft.create"; params: Record<string, never> }
  | { name: "draft.read" | "draft.refresh" | "draft.details" | "draft.ready" | "draft.reopen" | "draft.terms_exception"; params: { draftId: string } }
  | { name: "line.exclude" | "line.restore" | "line.not_billable"; params: { draftId: string; lineId: string } };

type Match = { status: "match"; route: InvoicingRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/** Matches the F5 paths (null = not an F5 path). A malformed id is 404. */
export function matchInvoicingRoute(path: string, method: string): Match {
  const seg = path.split("/");
  const m = (allowed: string[], route: InvoicingRoute): Match => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg[0] === "invoicing") {
    if (seg.length === 2 && seg[1] === "eligible") return m(["GET"], { name: "eligible.read", params: {} });
    return { status: "not_found" };
  }
  if (seg[0] !== "invoice-drafts") return null;
  if (seg.length === 1) return m(["GET", "POST"], { name: method === "POST" ? "draft.create" : "drafts.list", params: {} });
  if (!DRAFT_ID_PATTERN.test(seg[1])) return { status: "not_found" };
  const draftId = seg[1];
  if (seg.length === 2) return m(["GET"], { name: "draft.read", params: { draftId } });
  if (seg.length === 3) {
    const name = ({ refresh: "draft.refresh", details: "draft.details", ready: "draft.ready", reopen: "draft.reopen", "missing-terms-exceptions": "draft.terms_exception" } as const)[seg[2] as "refresh"];
    return name ? m(["POST"], { name, params: { draftId } }) : { status: "not_found" };
  }
  if (seg.length === 5 && seg[2] === "lines" && LINE_ID_PATTERN.test(seg[3])) {
    const name = ({ exclude: "line.exclude", restore: "line.restore", "not-billable": "line.not_billable" } as const)[seg[4] as "exclude"];
    return name ? m(["POST"], { name, params: { draftId, lineId: seg[3] } }) : { status: "not_found" };
  }
  return { status: "not_found" };
}
