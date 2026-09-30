/**
 * Test-suite copy of the canonical finance/finance-issue.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance invoice ISSUE + immutability + correction / credit-note lifecycle -
 * PURE (Finance Foundation F6; see TEST-ENV.md "Finance Foundation - F6").
 * No HTTP, Airtable, Supabase or Deno code.
 *
 * Turns a reviewed, Ready F5 draft into an issued invoice record that never
 * changes again, and gives every later correction a traceable path:
 *
 *   Ready draft --issue--> Invoice (Issued)            immutable lines + snapshots
 *   Invoice --credit note (whole lines)--> Partially credited / Credited
 *   Credit note --replacement draft--> F5 draft (scoped to the credited work)
 *                --review / Ready / issue--> replacement Invoice (Replaces ...)
 *
 * Boundaries (locked):
 *   - F5 owns building / reviewing / Ready. F6 only ISSUES what F5 marked
 *     Ready, re-checking every precondition under the lock; it never
 *     refreshes, re-prices or edits a line. A blocker that appears after
 *     Ready makes issue fail - it is never silently fixed.
 *   - Identity: the Hub's own stable reference is the Invoice ID
 *     (FIV-xxxxxxxxxxxx, random, never a sequence). A legal / accounting
 *     number is NOT invented here: the external provider / id / number
 *     fields stay blank until the accounting connection (F9) fills them.
 *   - An issued invoice's lines, amounts, VAT, terms, PO, dates and client /
 *     issuer snapshots are written once and never edited. The only field
 *     that ever changes on the invoice row is its credit state (Issued ->
 *     Partially credited -> Credited) with its revision.
 *   - A credit note credits WHOLE invoice lines (its amounts are exactly
 *     those lines' frozen figures), so it can never exceed what is left to
 *     credit and a line can never be credited twice. It records the credit
 *     only - no refund, no cash, no payment.
 *   - Credited work stays claimed for normal drafts forever. Only the
 *     replacement draft started from THAT credit note may bill it again.
 *   - No payment, due / overdue tracking, sending, PDF, Xero or Stripe here
 *     (F7 / F9 / F22).
 */
import { type Minor, type VatTreatment, formatMinor, formatRatePercent } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { type ChargeType, CHARGE_TYPE_LABELS, REASON_MAX, auditEvent } from "./finance-commercial.ts";
import {
  type Draft,
  type Line,
  type QuantitySource,
  type Review,
  type TermsException,
  type TermsSource,
  type UnitAmountSource,
  CORRECTION_ID_PATTERN,
  DRAFT_ID_PATTERN,
  INVOICE_ID_PATTERN,
  TERMS_SOURCE_LABELS,
  checkInvoicingQuery,
  totalsOf,
} from "./finance-invoicing.ts";

export const ISSUE_CONTRACT = "finance-invoices-v1";
export const ENTITY_INVOICE = "finance_invoice";
export const ENTITY_CREDIT_NOTE = "finance_credit_note";
export const ISSUE_EVENTS = {
  issued: "finance_invoice.issued",
  draftIssued: "finance_invoice_draft.issued",
  partiallyCredited: "finance_invoice.partially_credited",
  credited: "finance_invoice.credited",
  creditNoteCreated: "finance_credit_note.created",
  correctionInitiated: "finance_invoice.correction_initiated",
  replacementLinked: "finance_invoice.replacement_linked",
} as const;

export { INVOICE_ID_PATTERN };
export const INVOICE_LINE_ID_PATTERN = /^FVL-[0-9A-F]{12}$/;
/** A credit note's id is also the id of the correction it starts (a replacement draft / invoice carries it as Correction ID). */
export const CREDIT_NOTE_ID_PATTERN = CORRECTION_ID_PATTERN;
export function newIssueId(prefix: "FIV" | "FVL" | "FCN", randomHex: string): string {
  return `${prefix}-${randomHex.replace(/[^0-9a-f]/gi, "").slice(0, 12).toUpperCase()}`;
}
export const CURRENCY = "GBP";
/** Lines one credit-note request may name. */
export const CREDIT_BATCH_MAX = 200;

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------

export const INVOICE_STATUSES = ["issued", "partially_credited", "credited"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = { issued: "Issued", partially_credited: "Partially credited", credited: "Credited" };

export const ISSUE_AUTHORITIES = ["hub", "external_accounting"] as const;
export type IssueAuthority = (typeof ISSUE_AUTHORITIES)[number];
export const ISSUE_AUTHORITY_LABELS: Record<IssueAuthority, string> = { hub: "Issued in the Hub", external_accounting: "Issued by the external accounting system" };

/** Who issued the invoice, frozen at issue (Finance Settings + organisation). */
export interface Issuer {
  organisationId: string;
  organisationName: string | null;
  legalName: string;
  address: string;
  companyNumber: string | null;
  vatRegistered: boolean;
  vatNumber: string | null;
}

export interface Invoice {
  invoiceId: string;
  sourceDraftId: string;
  clientId: string;
  clientName: string;
  billingContactName: string | null;
  billingEmail: string;
  billingCcEmails: string[];
  invoiceDate: string;
  dueDate: string;
  periodFrom: string;
  periodTo: string;
  paymentTermsDays: number;
  paymentTermsSource: TermsSource;
  poRequired: boolean;
  poNumber: string | null;
  poOverrideReason: string | null;
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
  currency: typeof CURRENCY;
  lineCount: number;
  status: InvoiceStatus;
  issueAuthority: IssueAuthority;
  externalProvider: string | null;
  externalInvoiceId: string | null;
  externalInvoiceNumber: string | null;
  replacesInvoiceId: string | null;
  correctionId: string | null;
  /** The draft's approved missing-terms exceptions: work deliberately left off (never a line, never £0; still unresolved in Finance). */
  approvedOmissions: TermsException[];
  /** JSON: what Management reviewed (draft revision, Ready by / at, warnings accepted). */
  reviewSnapshot: string;
  issuer: Issuer;
  issuedBy: string;
  issuedAt: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface InvoiceLine {
  lineId: string;
  invoiceId: string;
  sequence: number;
  sourceDraftId: string;
  sourceDraftLineId: string;
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
  overrideIds: string[];
  snapshot: string;
  createdBy: string;
  createdAt: string;
}

export interface CreditedLine {
  invoiceLineId: string;
  occurrenceId: string;
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
}

export interface CreditNote {
  creditNoteId: string;
  invoiceId: string;
  clientId: string;
  clientName: string;
  creditDate: string;
  reason: string;
  lines: CreditedLine[];
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
  currency: typeof CURRENCY;
  status: "issued";
  issueAuthority: IssueAuthority;
  externalProvider: string | null;
  externalCreditNoteId: string | null;
  externalCreditNoteNumber: string | null;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------
// Dates (calendar arithmetic only - never a time zone shift)
// ---------------------------------------------------------------------

/** "2026-09-30" + 30 -> "2026-10-30"; pure calendar-date arithmetic. */
export function addDays(iso: string, days: number): string {
  if (!isIsoDate(iso) || !Number.isInteger(days)) throw new Error("addDays needs a real date and whole days");
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Issue (pure plan; the orchestrator runs it under the lock)
// ---------------------------------------------------------------------

export type Refusal = { ok: false; httpStatus: 404 | 409; code: string; error: string; fields?: Record<string, string> };
const refuse = (httpStatus: 404 | 409, code: string, error: string, fields?: Record<string, string>): Refusal => ({ ok: false, httpStatus, code, error, ...(fields ? { fields } : {}) });

export interface IssueInput {
  draft: Draft;
  lines: readonly Line[];
  /** The F5 review computed NOW, under the lock (never a stored one). */
  review: Review;
  client: { clientId: string; name: string; billingMethod: string; billingContactName: string | null; billingEmail: string | null; billingCcEmails: readonly string[] } | null;
  settings: { invoiceLegalName: string | null; invoiceAddress: string | null; companyNumber: string | null; vatRegistered: boolean | null; vatNumber: string | null } | null;
  organisation: { organisationId: string; name: string | null };
  /** Invoices already recorded with this draft as their source (must be none). */
  existingFromDraft: readonly { invoiceId: string }[];
  /** For a replacement draft: the invoice it replaces (null when not found). */
  replaced: Invoice | null;
  reviewedRevision: number;
  ids: { invoiceId: string; lineIds: string[] };
  meta: { userId: string; at: string; today: string };
}

/** The cheap refusals, checked before anything heavy is loaded: never twice from one draft, only a Ready draft, only the revision Management reviewed. */
export function issueGate(draft: Draft, existingFromDraft: readonly { invoiceId: string }[], reviewedRevision: number): { ok: true } | Refusal {
  const already = draft.issuedInvoiceId ?? existingFromDraft[0]?.invoiceId ?? null;
  if (already) return refuse(409, "draft_already_issued", `${draft.draftId} has already been issued as ${already} - an invoice is never issued twice from one draft`);
  if (draft.status !== "ready_for_issue") return refuse(409, "draft_not_ready", `${draft.draftId} is not Ready for issue - review it and mark it Ready first`);
  if (reviewedRevision !== draft.revision) return refuse(409, "draft_revision_mismatch", `The draft changed since you reviewed it (you reviewed revision ${reviewedRevision}, it is now revision ${draft.revision}) - review it again`);
  return { ok: true };
}

const orderForInvoice = (ls: readonly Line[]) => [...ls].sort((a, b) => `${a.occurrenceDate} ${a.occurrenceId} ${a.lineId}`.localeCompare(`${b.occurrenceDate} ${b.occurrenceId} ${b.lineId}`));

/**
 * Every issue precondition, in order (first failure wins, nothing written):
 * not already issued -> Ready -> the reviewed revision -> client resolves and
 * is billed through the Hub -> zero blockers NOW (claims, source changes,
 * PO, terms, missing terms, totals ...) -> totals reconcile -> issuer and
 * client snapshot data exist -> a replacement's original invoice exists.
 */
export function planIssue(input: IssueInput): { ok: true; invoice: Invoice; lines: InvoiceLine[] } | Refusal {
  const { draft, review, client, settings, meta } = input;
  const gate = issueGate(draft, input.existingFromDraft, input.reviewedRevision);
  if (!gate.ok) return gate;
  if (!client) return refuse(409, "client_not_found", `Client ${draft.clientId} no longer exists in Finance - nothing was issued`);
  if (client.billingMethod !== "hub") return refuse(409, "manual_billing_client", `${client.name} is billed manually outside the Hub - no Hub invoice is issued for it`);
  if (!review.readyForIssue) return refuse(409, "draft_has_blockers", `The draft cannot be issued: ${review.blockers.map((b) => b.message).join(" | ")}`, Object.fromEntries(review.blockers.map((b) => [b.code, b.message])));
  const included = orderForInvoice(input.lines.filter((l) => l.status === "included"));
  const t = totalsOf(included);
  if (!included.length || included.some((l) => l.netMinor + l.vatMinor !== l.grossMinor || l.amountMinor !== l.unitAmountMinor * l.quantity) || t.netMinor !== draft.netMinor || t.vatMinor !== draft.vatMinor || t.grossMinor !== draft.grossMinor || t.includedLines !== draft.includedLines || t.netMinor + t.vatMinor !== t.grossMinor) {
    return refuse(409, "totals_do_not_reconcile", "The draft's lines and totals do not reconcile (net + VAT = gross, line by line and in total) - nothing was issued");
  }
  if (draft.paymentTermsDays === null || draft.paymentTermsSource === null) return refuse(409, "payment_terms_missing", "The draft has no payment terms - nothing was issued");
  if (!client.billingEmail) return refuse(409, "billing_email_missing", `${client.name} has no billing email - nothing was issued`);
  if (!settings || !settings.invoiceLegalName || !settings.invoiceAddress) return refuse(409, "issuer_details_missing", "Finance Settings need the invoice legal name and address before an invoice can be issued");
  if (t.vatMinor > 0 && (settings.vatRegistered !== true || !settings.vatNumber)) return refuse(409, "issuer_vat_details_missing", "This invoice charges VAT - Finance Settings must say VAT registered and give the VAT number before it can be issued");
  if (draft.replacesInvoiceId) {
    if (!input.replaced || input.replaced.invoiceId !== draft.replacesInvoiceId) return refuse(409, "replaced_invoice_not_found", `The invoice this draft replaces (${draft.replacesInvoiceId}) cannot be found - nothing was issued`);
    if (input.replaced.clientId !== draft.clientId) return refuse(409, "replaced_invoice_mismatch", `${draft.replacesInvoiceId} belongs to another client - nothing was issued`);
  }
  if (input.ids.lineIds.length !== included.length) throw new Error("planIssue needs one line id per included line");

  const invoiceId = input.ids.invoiceId;
  const lines: InvoiceLine[] = included.map((l, i) => ({
    lineId: input.ids.lineIds[i],
    invoiceId,
    sequence: i + 1,
    sourceDraftId: draft.draftId,
    sourceDraftLineId: l.lineId,
    occurrenceId: l.occurrenceId,
    occurrenceDate: l.occurrenceDate,
    sessionId: l.sessionId,
    sessionName: l.sessionName,
    serviceId: l.serviceId,
    serviceName: l.serviceName,
    termsId: l.termsId,
    chargeType: l.chargeType,
    description: l.description,
    quantity: l.quantity,
    quantitySource: l.quantitySource,
    unitAmountMinor: l.unitAmountMinor,
    unitAmountSource: l.unitAmountSource,
    amountMinor: l.amountMinor,
    vatTreatment: l.vatTreatment,
    vatRateBasisPoints: l.vatRateBasisPoints,
    netMinor: l.netMinor,
    vatMinor: l.vatMinor,
    grossMinor: l.grossMinor,
    overrideIds: [...l.overrideIds],
    snapshot: l.snapshot,
    createdBy: meta.userId,
    createdAt: meta.at,
  }));
  const reviewSnapshot = {
    draftId: draft.draftId,
    draftRevision: draft.revision,
    readyBy: draft.readyBy,
    readyAt: draft.readyAt,
    checkedOn: meta.today,
    warnings: review.warnings.map((w) => ({ code: w.code, message: w.message })),
    excludedLineIds: input.lines.filter((l) => l.status === "excluded").map((l) => l.lineId),
  };
  const invoice: Invoice = {
    invoiceId,
    sourceDraftId: draft.draftId,
    clientId: client.clientId,
    clientName: client.name,
    billingContactName: client.billingContactName,
    billingEmail: client.billingEmail,
    billingCcEmails: [...client.billingCcEmails],
    invoiceDate: meta.today,
    dueDate: addDays(meta.today, draft.paymentTermsDays),
    periodFrom: draft.periodFrom,
    periodTo: draft.periodTo,
    paymentTermsDays: draft.paymentTermsDays,
    paymentTermsSource: draft.paymentTermsSource,
    poRequired: draft.poRequired,
    poNumber: draft.poNumber,
    poOverrideReason: draft.poOverrideReason,
    netMinor: t.netMinor,
    vatMinor: t.vatMinor,
    grossMinor: t.grossMinor,
    currency: CURRENCY,
    lineCount: lines.length,
    status: "issued",
    issueAuthority: "hub",
    externalProvider: null,
    externalInvoiceId: null,
    externalInvoiceNumber: null,
    replacesInvoiceId: draft.replacesInvoiceId,
    correctionId: draft.correctionId,
    approvedOmissions: draft.termsExceptions.map((e) => ({ ...e })),
    reviewSnapshot: JSON.stringify(reviewSnapshot),
    issuer: {
      organisationId: input.organisation.organisationId,
      organisationName: input.organisation.name,
      legalName: settings.invoiceLegalName,
      address: settings.invoiceAddress,
      companyNumber: settings.companyNumber,
      vatRegistered: settings.vatRegistered === true,
      vatNumber: settings.vatNumber,
    },
    issuedBy: meta.userId,
    issuedAt: meta.at,
    revision: 1,
    updatedBy: meta.userId,
    updatedAt: meta.at,
  };
  return { ok: true, invoice, lines };
}

// ---------------------------------------------------------------------
// Credit state + credit notes (whole lines)
// ---------------------------------------------------------------------

export interface CreditState {
  creditedLineIds: Set<string>;
  credited: { netMinor: Minor; vatMinor: Minor; grossMinor: Minor };
  remaining: { netMinor: Minor; vatMinor: Minor; grossMinor: Minor };
  status: InvoiceStatus;
}

/** What the credit notes so far have credited, and what is left. Throws if stored credits exceed the invoice (never happens through this API). */
export function creditState(invoice: Invoice, lines: readonly InvoiceLine[], notes: readonly CreditNote[]): CreditState {
  const ids = new Set<string>();
  let net = 0;
  let vat = 0;
  let gross = 0;
  for (const n of notes) {
    for (const c of n.lines) {
      if (ids.has(c.invoiceLineId)) throw new Error(`invoice line ${c.invoiceLineId} is credited twice`);
      ids.add(c.invoiceLineId);
    }
    net += n.netMinor;
    vat += n.vatMinor;
    gross += n.grossMinor;
  }
  if (gross > invoice.grossMinor || net > invoice.netMinor || vat > invoice.vatMinor) throw new Error(`credits exceed ${invoice.invoiceId}`);
  const all = lines.length > 0 && lines.every((l) => ids.has(l.lineId));
  return {
    creditedLineIds: ids,
    credited: { netMinor: net, vatMinor: vat, grossMinor: gross },
    remaining: { netMinor: invoice.netMinor - net, vatMinor: invoice.vatMinor - vat, grossMinor: invoice.grossMinor - gross },
    status: ids.size === 0 ? "issued" : all ? "credited" : "partially_credited",
  };
}

/**
 * A credit note for whole invoice lines: `lineIds` null = every line not
 * credited yet. Refused when a line is unknown, already credited, or
 * nothing is left to credit. Its amounts are the lines' frozen figures.
 */
export function planCreditNote(input: { invoice: Invoice; lines: readonly InvoiceLine[]; notes: readonly CreditNote[]; lineIds: string[] | null; reason: string; creditNoteId: string; meta: { userId: string; at: string; today: string } }): { ok: true; note: CreditNote; before: CreditState; statusAfter: InvoiceStatus } | Refusal {
  const { invoice, lines, notes } = input;
  const st = creditState(invoice, lines, notes);
  if (st.status === "credited") return refuse(409, "invoice_fully_credited", `${invoice.invoiceId} is already fully credited - nothing is left to credit`);
  let chosen: InvoiceLine[];
  if (input.lineIds === null) chosen = lines.filter((l) => !st.creditedLineIds.has(l.lineId));
  else {
    const unknown = input.lineIds.filter((id) => !lines.some((l) => l.lineId === id));
    if (unknown.length) return refuse(404, "invoice_line_not_found", `${invoice.invoiceId} has no line(s) ${unknown.join(", ")}`);
    const done = input.lineIds.filter((id) => st.creditedLineIds.has(id));
    if (done.length) return refuse(409, "line_already_credited", `Line(s) ${done.join(", ")} of ${invoice.invoiceId} are already credited - a line is never credited twice`);
    chosen = lines.filter((l) => input.lineIds!.includes(l.lineId));
  }
  chosen = [...chosen].sort((a, b) => a.sequence - b.sequence);
  const credited = chosen.map((l) => ({ invoiceLineId: l.lineId, occurrenceId: l.occurrenceId, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor }));
  const t = credited.reduce((a, c) => ({ net: a.net + c.netMinor, vat: a.vat + c.vatMinor, gross: a.gross + c.grossMinor }), { net: 0, vat: 0, gross: 0 });
  if (!credited.length || t.gross > st.remaining.grossMinor || t.net > st.remaining.netMinor || t.vat > st.remaining.vatMinor || t.net + t.vat !== t.gross) return refuse(409, "credit_exceeds_invoice", `The credit would exceed what is left to credit on ${invoice.invoiceId} (${formatMinor(st.remaining.grossMinor)})`);
  const note: CreditNote = {
    creditNoteId: input.creditNoteId,
    invoiceId: invoice.invoiceId,
    clientId: invoice.clientId,
    clientName: invoice.clientName,
    creditDate: input.meta.today,
    reason: input.reason,
    lines: credited,
    netMinor: t.net,
    vatMinor: t.vat,
    grossMinor: t.gross,
    currency: CURRENCY,
    status: "issued",
    issueAuthority: "hub",
    externalProvider: null,
    externalCreditNoteId: null,
    externalCreditNoteNumber: null,
    createdBy: input.meta.userId,
    createdAt: input.meta.at,
  };
  const after = creditState(invoice, lines, [...notes, note]);
  return { ok: true, note, before: st, statusAfter: after.status };
}

// ---------------------------------------------------------------------
// Public bodies (no storage ids)
// ---------------------------------------------------------------------

const money = (m: { netMinor: Minor; vatMinor: Minor; grossMinor: Minor }) => ({ currency: CURRENCY, net: formatMinor(m.netMinor), vat: formatMinor(m.vatMinor), gross: formatMinor(m.grossMinor) });

export function publicInvoice(i: Invoice, st: CreditState | null = null) {
  return {
    invoiceId: i.invoiceId,
    reference: i.invoiceId,
    status: i.status,
    statusLabel: INVOICE_STATUS_LABELS[i.status],
    issueAuthority: i.issueAuthority,
    issueAuthorityLabel: ISSUE_AUTHORITY_LABELS[i.issueAuthority],
    external: { provider: i.externalProvider, invoiceId: i.externalInvoiceId, invoiceNumber: i.externalInvoiceNumber },
    sourceDraftId: i.sourceDraftId,
    client: { clientId: i.clientId, name: i.clientName, billingContactName: i.billingContactName, billingEmail: i.billingEmail, billingCcEmails: [...i.billingCcEmails] },
    issuer: { ...i.issuer },
    invoiceDate: i.invoiceDate,
    dueDate: i.dueDate,
    period: { from: i.periodFrom, to: i.periodTo },
    paymentTerms: { days: i.paymentTermsDays, source: i.paymentTermsSource, sourceLabel: TERMS_SOURCE_LABELS[i.paymentTermsSource] },
    po: { required: i.poRequired, number: i.poNumber, overrideReason: i.poOverrideReason },
    totals: { ...money(i), lineCount: i.lineCount },
    credit: st ? { credited: money(st.credited), remaining: money(st.remaining) } : null,
    approvedOmissions: i.approvedOmissions.map((e) => ({ occurrenceId: e.occurrenceId, date: e.occurrenceDate, serviceId: e.serviceId, reason: e.reason, approvedBy: e.approvedBy, approvedAt: e.approvedAt, note: "Left off this invoice by an approved exception - never billed at £0; still unresolved in Finance" })),
    reviewed: JSON.parse(i.reviewSnapshot),
    replacesInvoiceId: i.replacesInvoiceId,
    correctionId: i.correctionId,
    issuedBy: i.issuedBy,
    issuedAt: i.issuedAt,
    revision: i.revision,
    updatedAt: i.updatedAt,
  };
}

export function publicInvoiceLine(l: InvoiceLine, creditedBy: string | null = null) {
  return {
    lineId: l.lineId,
    sequence: l.sequence,
    sourceDraftLineId: l.sourceDraftLineId,
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
    creditedBy,
  };
}

export function publicCreditNote(n: CreditNote) {
  return {
    creditNoteId: n.creditNoteId,
    reference: n.creditNoteId,
    invoiceId: n.invoiceId,
    client: { clientId: n.clientId, name: n.clientName },
    creditDate: n.creditDate,
    reason: n.reason,
    status: n.status,
    issueAuthority: n.issueAuthority,
    external: { provider: n.externalProvider, creditNoteId: n.externalCreditNoteId, creditNoteNumber: n.externalCreditNoteNumber },
    lines: n.lines.map((c) => ({ invoiceLineId: c.invoiceLineId, occurrenceId: c.occurrenceId, net: formatMinor(c.netMinor), vat: formatMinor(c.vatMinor), gross: formatMinor(c.grossMinor) })),
    totals: money(n),
    createdBy: n.createdBy,
    createdAt: n.createdAt,
  };
}

/** The invoice's history, derived from its immutable records (no F4 re-run, no audit read). */
export function invoiceHistory(i: Invoice, notes: readonly CreditNote[], replacements: { drafts: readonly Draft[]; invoices: readonly Invoice[] }) {
  const h: { at: string; event: string; detail: Record<string, unknown> }[] = [];
  h.push({ at: i.issuedAt, event: "issued", detail: { invoiceId: i.invoiceId, sourceDraftId: i.sourceDraftId, gross: formatMinor(i.grossMinor), replacesInvoiceId: i.replacesInvoiceId, correctionId: i.correctionId } });
  for (const n of notes) h.push({ at: n.createdAt, event: "credit_note", detail: { creditNoteId: n.creditNoteId, gross: formatMinor(n.grossMinor), lines: n.lines.length, reason: n.reason } });
  for (const d of replacements.drafts) h.push({ at: d.createdAt ?? "", event: "correction_initiated", detail: { correctionId: d.correctionId, replacementDraftId: d.draftId, occurrenceIds: [...(d.correctionScope?.occurrenceIds ?? [])] } });
  for (const r of replacements.invoices) h.push({ at: r.issuedAt, event: "replaced", detail: { replacementInvoiceId: r.invoiceId, correctionId: r.correctionId, gross: formatMinor(r.grossMinor) } });
  const rank: Record<string, number> = { issued: 0, credit_note: 1, correction_initiated: 2, replaced: 3 };
  return h.sort((a, b) => a.at.localeCompare(b.at) || rank[a.event] - rank[b.event]);
}

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

export const auditInvoice = (i: Invoice) => ({
  invoiceId: i.invoiceId,
  sourceDraftId: i.sourceDraftId,
  clientId: i.clientId,
  status: i.status,
  invoiceDate: i.invoiceDate,
  dueDate: i.dueDate,
  periodFrom: i.periodFrom,
  periodTo: i.periodTo,
  paymentTermsDays: i.paymentTermsDays,
  paymentTermsSource: i.paymentTermsSource,
  poNumber: i.poNumber,
  poOverrideReason: i.poOverrideReason,
  netMinor: i.netMinor,
  vatMinor: i.vatMinor,
  grossMinor: i.grossMinor,
  lineCount: i.lineCount,
  issueAuthority: i.issueAuthority,
  replacesInvoiceId: i.replacesInvoiceId,
  correctionId: i.correctionId,
  approvedOmissions: i.approvedOmissions.map((e) => e.occurrenceId),
  revision: i.revision,
});
export const auditInvoiceLine = (l: InvoiceLine) => ({ lineId: l.lineId, sequence: l.sequence, sourceDraftLineId: l.sourceDraftLineId, occurrenceId: l.occurrenceId, termsId: l.termsId, quantity: l.quantity, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor });
export const auditCreditNote = (n: CreditNote) => ({ creditNoteId: n.creditNoteId, invoiceId: n.invoiceId, clientId: n.clientId, creditDate: n.creditDate, lines: n.lines.map((c) => ({ ...c })), netMinor: n.netMinor, vatMinor: n.vatMinor, grossMinor: n.grossMinor, status: n.status });

export function issueAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: ISSUE_CONTRACT } };
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const LINE_CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

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
  if (LINE_CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

/** POST /invoice-drafts/{id}/issue { revision, reason? } - the Ready revision Management reviewed. */
export function parseIssue(raw: string, isTenantKey: (k: string) => boolean): { ok: true; revision: number; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["revision", "reason"], isTenantKey);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const v = b.body.revision;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fields.revision = "must be the draft revision you reviewed";
  const r = reasonOf(b.body.reason, false);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was issued", fields);
  return { ok: true, revision: v as number, reason: (r as { ok: true; value: string | null }).value };
}

/** POST /invoices/{id}/credit-notes { lineIds?: [FVL-...], reason } - omit lineIds to credit every line not credited yet. */
export function parseCreditNote(raw: string, isTenantKey: (k: string) => boolean): { ok: true; lineIds: string[] | null; reason: string } | Invalid {
  const b = jsonObject(raw, ["lineIds", "reason"], isTenantKey);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const ids = b.body.lineIds;
  if (ids !== undefined && ids !== null) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > CREDIT_BATCH_MAX) fields.lineIds = `must list 1-${CREDIT_BATCH_MAX} invoice line ids, or be left out to credit every remaining line`;
    else if (ids.some((id) => typeof id !== "string" || !INVOICE_LINE_ID_PATTERN.test(id))) fields.lineIds = "must contain only FVL- invoice line ids";
    else if (new Set(ids).size !== ids.length) fields.lineIds = "must not repeat a line";
  }
  const r = reasonOf(b.body.reason, true);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was credited", fields);
  return { ok: true, lineIds: ids === undefined || ids === null ? null : [...(ids as string[])], reason: (r as { ok: true; value: string }).value };
}

/** POST /credit-notes/{id}/replacement-draft { reason }. */
export function parseReplacement(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey);
  if (!b.ok) return b;
  const r = reasonOf(b.body.reason, true);
  if (!r.ok) return invalid("invalid_input", "Some fields are not valid - nothing was saved", { reason: r.error });
  return { ok: true, reason: r.value as string };
}

/** GET /invoices?clientId=FCL-.. (one client's invoices; bounded). */
export function checkInvoiceListQuery(params: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true; clientId: string } | Invalid {
  const q = checkInvoicingQuery(params, false, isTenantKey);
  return q.ok ? { ok: true, clientId: q.clientId } : q;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

export type IssueRoute =
  | { name: "draft.issue"; params: { draftId: string } }
  | { name: "invoices.list"; params: Record<string, never> }
  | { name: "invoice.read" | "invoice.credit_notes" | "invoice.credit_note_create"; params: { invoiceId: string } }
  | { name: "credit_note.read" | "credit_note.replacement"; params: { creditNoteId: string } };

type Match = { status: "match"; route: IssueRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/**
 * Matches the F6 paths (null = not an F6 path, including every other
 * invoice-drafts path, which stays F5's). A malformed id is 404. There is
 * deliberately no send / pay / overdue / PDF / external-sync route.
 */
export function matchIssueRoute(path: string, method: string): Match {
  const seg = path.split("/");
  const m = (allowed: string[], route: IssueRoute): Match => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg[0] === "invoice-drafts") {
    if (seg.length === 3 && seg[2] === "issue") return DRAFT_ID_PATTERN.test(seg[1]) ? m(["POST"], { name: "draft.issue", params: { draftId: seg[1] } }) : { status: "not_found" };
    return null;
  }
  if (seg[0] === "invoices") {
    if (seg.length === 1) return m(["GET"], { name: "invoices.list", params: {} });
    if (!INVOICE_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    const invoiceId = seg[1];
    if (seg.length === 2) return m(["GET"], { name: "invoice.read", params: { invoiceId } });
    if (seg.length === 3 && seg[2] === "credit-notes") return m(["GET", "POST"], { name: method === "POST" ? "invoice.credit_note_create" : "invoice.credit_notes", params: { invoiceId } });
    return { status: "not_found" };
  }
  if (seg[0] === "credit-notes") {
    if (seg.length < 2 || !CREDIT_NOTE_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    const creditNoteId = seg[1];
    if (seg.length === 2) return m(["GET"], { name: "credit_note.read", params: { creditNoteId } });
    if (seg.length === 3 && seg[2] === "replacement-draft") return m(["POST"], { name: "credit_note.replacement", params: { creditNoteId } });
    return { status: "not_found" };
  }
  return null;
}

