/**
 * Test-suite copy of the canonical finance/finance-issue-mapping.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance invoices + credit notes - storage mapping, PURE (Finance
 * Foundation F6; see TEST-ENV.md "Finance Foundation - F6"). Translates the
 * transitional TEST Airtable rows of "Finance Invoices", "Finance Invoice
 * Lines" and "Finance Credit Notes" to/from the domain in finance-issue.ts.
 *
 *   - An invoice row is created once, complete. Afterwards ONLY its credit
 *     state (Status) and its revision / last-changed fields are ever
 *     patched (invoiceStateFields) - never an amount, date, term, PO,
 *     snapshot or official number.
 *   - Status is stored truthfully: "Awaiting external issue" (Xero numbering,
 *     frozen but not issued) has NO issue date, due date, Issued At / By,
 *     external id or number; an issued Xero-numbered invoice must carry the
 *     external id + number Xero gave it (F9). Frozen At / By = when the Hub
 *     froze the package (every invoice), never an issue date.
 *   - An invoice line row and a credit note row are created once and never
 *     edited.
 *
 * Every row is validated on read, and an invoice is validated against its
 * lines (sum + count); anything that does not validate is INVALID data
 * (409) - never skipped, repaired or guessed.
 */
import { type Minor, type VatTreatment, isRateBasisPoints, isVatTreatment } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { type ChargeType, CHARGE_TYPES, ID_PATTERNS, MAX_BILLABLE_QUANTITY, MAX_UNIT_AMOUNT_MINOR, REASON_MAX } from "./finance-commercial.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { OCCURRENCE_ID_PATTERN } from "./finance-billing.ts";
import { type QuantitySource, type TermsException, type TermsSource, type UnitAmountSource, CLIENT_ID_PATTERN, DRAFT_ID_PATTERN, LINE_ID_PATTERN, PO_NUMBER_MAX } from "./finance-invoicing.ts";
import {
  type CreditNote,
  type CreditedLine,
  type Invoice,
  type InvoiceLine,
  type InvoiceStatus,
  type IssueAuthority,
  type Issuer,
  type InvoiceBranding,
  CREDIT_NOTE_ID_PATTERN,
  CURRENCY,
  HUB_INVOICE_NUMBER_PATTERN,
  INVOICE_ID_PATTERN,
  INVOICE_LINE_ID_PATTERN,
} from "./finance-issue.ts";
import { type InvoiceNumberAuthority, type PaymentDetails, FIELD_VALIDATORS as SETTINGS_VALIDATORS, INVOICE_NUMBER_MAX, paymentRouteOf } from "./finance-settings.ts";
import { type BillingAddress, BILLING_ADDRESS_KEYS, checkBillingAddress } from "./finance-commercial.ts";

export const ISSUE_TABLES = { invoices: "Finance Invoices", lines: "Finance Invoice Lines", creditNotes: "Finance Credit Notes" } as const;

export const FV = {
  org: "Organisation",
  invoice: {
    id: "Invoice ID",
    sourceDraftId: "Source Draft ID",
    clientId: "Client ID",
    clientName: "Client Name",
    contact: "Billing Contact Name",
    email: "Billing Email",
    cc: "Billing CC Emails",
    date: "Invoice Date",
    due: "Due Date",
    from: "Period From",
    to: "Period To",
    termsDays: "Payment Terms (Days)",
    termsSource: "Payment Terms Source",
    poRequired: "PO Required",
    poNumber: "PO Number",
    poOverride: "PO Override Reason",
    net: "Net (Minor Units)",
    vat: "VAT (Minor Units)",
    gross: "Gross (Minor Units)",
    currency: "Currency",
    lineCount: "Line Count",
    status: "Status",
    authority: "Issue Authority",
    numberAuthority: "Invoice Number Authority",
    hubNumber: "Hub Invoice Number",
    hubSequence: "Hub Invoice Sequence",
    extProvider: "External Provider",
    extId: "External Invoice ID",
    extNumber: "External Invoice Number",
    replaces: "Replaces Invoice ID",
    correctionId: "Correction ID",
    omissions: "Approved Omissions",
    review: "Review Snapshot",
    issuer: "Issuer Snapshot",
    /** F22 frozen snapshots (JSON; blank on pre-F22 invoices - never back-filled). */
    billingAddress: "Billing Address Snapshot",
    paymentDetails: "Payment Details Snapshot",
    branding: "Branding Snapshot",
    frozenBy: "Frozen By User ID",
    frozenAt: "Frozen At",
    issuedBy: "Issued By User ID",
    issuedAt: "Issued At",
    revision: "Revision",
    changedBy: "Last Changed By User ID",
    changedAt: "Last Changed At",
  },
  line: {
    id: "Line ID",
    invoiceId: "Invoice ID",
    sequence: "Sequence",
    sourceDraftId: "Source Draft ID",
    sourceDraftLineId: "Source Draft Line ID",
    occurrenceId: "Occurrence ID",
    date: "Occurrence Date",
    sessionId: "Session ID",
    sessionName: "Session Name",
    serviceId: "Finance Service ID",
    serviceName: "Service Name",
    termsId: "Commercial Terms ID",
    chargeType: "Charge Type",
    description: "Description",
    quantity: "Quantity",
    quantitySource: "Quantity Source",
    unit: "Unit Amount (Minor Units)",
    unitSource: "Unit Amount Source",
    amount: "Amount (Minor Units)",
    vatTreatment: "VAT Treatment",
    rate: "VAT Rate (Basis Points)",
    net: "Net (Minor Units)",
    vat: "VAT (Minor Units)",
    gross: "Gross (Minor Units)",
    overrideIds: "Override IDs",
    snapshot: "Source Snapshot",
    createdBy: "Created By User ID",
    createdAt: "Created At",
  },
  credit: {
    id: "Credit Note ID",
    invoiceId: "Invoice ID",
    clientId: "Client ID",
    clientName: "Client Name",
    date: "Credit Date",
    reason: "Reason",
    lines: "Credited Lines",
    net: "Net (Minor Units)",
    vat: "VAT (Minor Units)",
    gross: "Gross (Minor Units)",
    currency: "Currency",
    status: "Status",
    authority: "Issue Authority",
    extProvider: "External Provider",
    extId: "External Credit Note ID",
    extNumber: "External Credit Note Number",
    createdBy: "Created By User ID",
    createdAt: "Created At",
  },
} as const;

const INVOICE_STATUS: Record<InvoiceStatus, string> = { awaiting_external_issue: "Awaiting external issue", issued: "Issued", partially_credited: "Partially credited", credited: "Credited" };
const AUTHORITY: Record<IssueAuthority, string> = { hub: "Hub", external_accounting: "External accounting" };
const NUMBER_AUTHORITY: Record<InvoiceNumberAuthority, string> = { hub: "Hub", xero: "Xero" };
const TERMS_SOURCE: Record<TermsSource, string> = { client: "Client", finance_settings: "Finance Settings", invoice_override: "Invoice override", original_invoice: "Original invoice" };
const QTY_SOURCES: readonly QuantitySource[] = ["default_commercial_quantity", "occurrence_override", "per_session"];
const UNIT_SOURCES: readonly UnitAmountSource[] = ["commercial_terms", "occurrence_override"];
const MAX_LINE_MINOR = MAX_UNIT_AMOUNT_MINOR * MAX_BILLABLE_QUANTITY;
const MAX_TOTAL_MINOR = 100_000_000_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function reverse<T extends string>(map: Record<T, string>, label: unknown): T | undefined {
  const name = label && typeof label === "object" && typeof (label as any).name === "string" ? (label as any).name : label;
  return (Object.keys(map) as T[]).find((k) => map[k] === name);
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const lineMinor = (v: unknown): Minor | undefined => int(v ?? 0, 0, MAX_LINE_MINOR);
const totalMinor = (v: unknown): Minor | undefined => int(v ?? 0, 0, MAX_TOTAL_MINOR);
const json = (v: unknown): unknown => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};

type Parsed<T> = { ok: true; recordId: string; value: T } | { ok: false; problem: string };

function omissionsOf(v: unknown): TermsException[] | undefined {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return [];
  const a = json(v);
  if (!Array.isArray(a)) return undefined;
  const out: TermsException[] = [];
  for (const e of a) {
    if (!e || typeof e !== "object" || Object.keys(e).sort().join(",") !== "approvedAt,approvedBy,occurrenceDate,occurrenceId,reason,serviceId") return undefined;
    if (!OCCURRENCE_ID_PATTERN.test(e.occurrenceId) || !isIsoDate(e.occurrenceDate) || typeof e.reason !== "string" || !e.reason.trim() || typeof e.approvedBy !== "string" || typeof e.approvedAt !== "string") return undefined;
    if (e.serviceId !== null && (typeof e.serviceId !== "string" || !ID_PATTERNS.service.test(e.serviceId))) return undefined;
    out.push({ occurrenceId: e.occurrenceId, occurrenceDate: e.occurrenceDate, serviceId: e.serviceId, reason: e.reason, approvedBy: e.approvedBy, approvedAt: e.approvedAt });
  }
  return out;
}

function issuerOf(v: unknown): Issuer | undefined {
  const o = json(v) as any;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== "address,companyNumber,legalName,organisationId,organisationName,vatNumber,vatRegistered") return undefined;
  if (typeof o.organisationId !== "string" || !o.organisationId || typeof o.legalName !== "string" || !o.legalName || typeof o.address !== "string" || !o.address || typeof o.vatRegistered !== "boolean") return undefined;
  for (const k of ["organisationName", "companyNumber", "vatNumber"]) if (o[k] !== null && typeof o[k] !== "string") return undefined;
  return { organisationId: o.organisationId, organisationName: o.organisationName, legalName: o.legalName, address: o.address, companyNumber: o.companyNumber, vatRegistered: o.vatRegistered, vatNumber: o.vatNumber };
}

/** F22: blank = none frozen (null); otherwise exactly the frozen shape, re-validated (undefined = invalid data, never repaired). */
function billingAddressSnapshotOf(v: unknown): BillingAddress | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  const o = json(v) as any;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== [...BILLING_ADDRESS_KEYS].sort().join(",")) return undefined;
  const a = checkBillingAddress(o);
  return a.ok && a.value && JSON.stringify(a.value) === JSON.stringify(Object.fromEntries(BILLING_ADDRESS_KEYS.map((k) => [k, o[k]]))) ? a.value : undefined;
}
const PAYMENT_KEYS = ["accountName", "sortCode", "accountNumber", "iban", "bic", "instructions"] as const;
function paymentSnapshotOf(v: unknown): PaymentDetails | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  const o = json(v) as any;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== [...PAYMENT_KEYS].sort().join(",")) return undefined;
  const checks: [unknown, (x: unknown) => { ok: boolean; value?: unknown }][] = [
    [o.accountName, SETTINGS_VALIDATORS.paymentAccountName], [o.sortCode, SETTINGS_VALIDATORS.paymentSortCode], [o.accountNumber, SETTINGS_VALIDATORS.paymentAccountNumber],
    [o.iban, SETTINGS_VALIDATORS.paymentIban], [o.bic, SETTINGS_VALIDATORS.paymentBic], [o.instructions, SETTINGS_VALIDATORS.paymentInstructions],
  ];
  for (const [val, check] of checks) {
    const r = check(val);
    if (!r.ok || r.value !== val) return undefined;
  }
  const pr = paymentRouteOf({ paymentAccountName: o.accountName, paymentSortCode: o.sortCode, paymentAccountNumber: o.accountNumber, paymentIban: o.iban, paymentBic: o.bic, paymentInstructions: o.instructions });
  return pr.ok && JSON.stringify(pr.details) === JSON.stringify(Object.fromEntries(PAYMENT_KEYS.map((k) => [k, o[k]]))) ? pr.details : undefined;
}
const BRANDING_KEYS = ["tradingName", "primaryColour", "accentColour", "tagline", "website", "supportEmail"] as const;
function brandingSnapshotOf(v: unknown): InvoiceBranding | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  const o = json(v) as any;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== [...BRANDING_KEYS].sort().join(",")) return undefined;
  for (const k of BRANDING_KEYS) if (o[k] !== null && (typeof o[k] !== "string" || !o[k] || o[k].length > 254)) return undefined;
  for (const k of ["primaryColour", "accentColour"] as const) if (o[k] !== null && !/^#[0-9a-f]{6}$/.test(o[k])) return undefined;
  return { tradingName: o.tradingName, primaryColour: o.primaryColour, accentColour: o.accentColour, tagline: o.tagline, website: o.website, supportEmail: o.supportEmail };
}

export function invoiceFromRow(r: Row): Parsed<Invoice> {
  const f = r.fields ?? {};
  const x = FV.invoice;
  const id = str(f[x.id]);
  if (!id || !INVOICE_ID_PATTERN.test(id)) return { ok: false, problem: `invoice row ${r.id}: bad Invoice ID` };
  const bad = (why: string): Parsed<Invoice> => ({ ok: false, problem: `invoice ${id}: ${why}` });
  if (links(f[FV.org]).length !== 1) return bad("must link exactly one organisation");
  const sourceDraftId = str(f[x.sourceDraftId]);
  if (!sourceDraftId || !DRAFT_ID_PATTERN.test(sourceDraftId)) return bad("invalid Source Draft ID");
  const clientId = str(f[x.clientId]);
  const clientName = str(f[x.clientName]);
  const email = str(f[x.email]);
  if (!clientId || !CLIENT_ID_PATTERN.test(clientId) || !clientName || !email || !EMAIL_RE.test(email)) return bad("invalid client snapshot");
  const cc = (str(f[x.cc]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (cc.some((e) => !EMAIL_RE.test(e))) return bad("invalid Billing CC Emails");
  const date = f[x.date] ?? null;
  const due = f[x.due] ?? null;
  const from = f[x.from];
  const to = f[x.to];
  if (!isIsoDate(from) || !isIsoDate(to) || (to as string) < (from as string)) return bad("invalid dates");
  // Issue + due date come together (or not at all - checked against Status below).
  if ((date === null) !== (due === null) || (date !== null && (!isIsoDate(date) || !isIsoDate(due) || (due as string) < (date as string)))) return bad("invalid dates");
  const termsDays = int(f[x.termsDays], 0, 365);
  const termsSource = reverse(TERMS_SOURCE, f[x.termsSource]);
  if (termsDays === undefined || !termsSource) return bad("invalid payment terms");
  const po = f[x.poRequired];
  if (po !== undefined && po !== null && typeof po !== "boolean") return bad("invalid PO Required");
  const poNumber = str(f[x.poNumber]);
  const poOverride = str(f[x.poOverride]);
  if ((poNumber && poNumber.length > PO_NUMBER_MAX) || (poOverride && poOverride.length > REASON_MAX)) return bad("invalid PO details");
  const net = totalMinor(f[x.net]);
  const vat = totalMinor(f[x.vat]);
  const gross = totalMinor(f[x.gross]);
  const lineCount = int(f[x.lineCount], 1, 100_000);
  if (net === undefined || vat === undefined || gross === undefined || net + vat !== gross || lineCount === undefined) return bad("invalid totals");
  if (str(f[x.currency]) !== CURRENCY) return bad("invalid Currency");
  const status = reverse(INVOICE_STATUS, f[x.status]);
  const authority = reverse(AUTHORITY, f[x.authority]);
  if (!status || !authority) return bad("invalid Status / Issue Authority");
  const numberAuthority = reverse(NUMBER_AUTHORITY, f[x.numberAuthority]);
  if (!numberAuthority) return bad("invalid Invoice Number Authority");
  const hubNumber = str(f[x.hubNumber]);
  const hubSequence = f[x.hubSequence] === undefined || f[x.hubSequence] === null ? null : int(f[x.hubSequence], 1, INVOICE_NUMBER_MAX);
  if (numberAuthority === "hub") {
    // A Hub number is the prefix + its sequence (possibly zero-padded): both present and consistent.
    if (!hubNumber || !HUB_INVOICE_NUMBER_PATTERN.test(hubNumber) || typeof hubSequence !== "number" || !hubNumber.endsWith(String(hubSequence))) return bad("invalid Hub invoice number / sequence");
  } else if (hubNumber !== null || hubSequence !== null) return bad("a Xero-numbered invoice cannot carry a Hub invoice number");
  const replaces = str(f[x.replaces]);
  const correctionId = str(f[x.correctionId]);
  if ((replaces === null) !== (correctionId === null) || (replaces && (!INVOICE_ID_PATTERN.test(replaces) || replaces === id)) || (correctionId && !CREDIT_NOTE_ID_PATTERN.test(correctionId))) return bad("invalid replacement references");
  const omissions = omissionsOf(f[x.omissions]);
  if (omissions === undefined) return bad("invalid Approved Omissions");
  const review = str(f[x.review]);
  if (!review || !json(review)) return bad("missing Review Snapshot");
  const issuer = issuerOf(f[x.issuer]);
  if (!issuer) return bad("invalid Issuer Snapshot");
  const billingAddress = billingAddressSnapshotOf(f[x.billingAddress]);
  const paymentDetails = paymentSnapshotOf(f[x.paymentDetails]);
  const branding = brandingSnapshotOf(f[x.branding]);
  if (billingAddress === undefined || paymentDetails === undefined || branding === undefined) return bad("invalid F22 snapshot (billing address / payment details / branding)");
  // Payment details + branding are frozen only on Hub-authority issues (Xero owns its own document).
  if (numberAuthority !== "hub" && (paymentDetails !== null || branding !== null)) return bad("a Xero-numbered invoice cannot carry Hub payment details or branding");
  const frozenBy = str(f[x.frozenBy]);
  const frozenAt = str(f[x.frozenAt]);
  const issuedBy = str(f[x.issuedBy]);
  const issuedAt = str(f[x.issuedAt]);
  const changedBy = str(f[x.changedBy]);
  const changedAt = str(f[x.changedAt]);
  const revision = int(f[x.revision], 1, Number.MAX_SAFE_INTEGER);
  if (!frozenBy || !frozenAt || !changedBy || !changedAt || revision === undefined || (issuedBy === null) !== (issuedAt === null)) return bad("invalid issue / revision metadata");
  // Who issues follows who numbers: Hub numbering -> Hub; Xero numbering -> external accounting.
  if ((numberAuthority === "hub") !== (authority === "hub")) return bad("Issue Authority does not match Invoice Number Authority");
  const extId = str(f[x.extId]);
  const extNumber = str(f[x.extNumber]);
  if (status === "awaiting_external_issue") {
    // Frozen, not issued: nothing may claim an issue, a due date, or an external invoice.
    if (numberAuthority !== "xero" || date !== null || issuedAt !== null || extId !== null || extNumber !== null) return bad("an invoice awaiting external issue cannot carry an issue date, due date, Issued At or external invoice id / number");
  } else {
    if (date === null || issuedAt === null) return bad("an issued invoice needs its invoice date, due date and Issued At");
    // An issued Xero-numbered invoice exists only once Xero has issued it (F9): its external id + official number must be recorded.
    if (numberAuthority === "xero" && (extId === null || extNumber === null)) return bad("an issued Xero-numbered invoice needs the external invoice id and number Xero gave it");
  }
  return {
    ok: true,
    recordId: r.id,
    value: {
      invoiceId: id,
      sourceDraftId,
      clientId,
      clientName,
      billingContactName: str(f[x.contact]),
      billingEmail: email,
      billingCcEmails: cc,
      invoiceDate: date as string | null,
      dueDate: due as string | null,
      periodFrom: from as string,
      periodTo: to as string,
      paymentTermsDays: termsDays,
      paymentTermsSource: termsSource,
      poRequired: po === true,
      poNumber,
      poOverrideReason: poOverride,
      netMinor: net,
      vatMinor: vat,
      grossMinor: gross,
      currency: CURRENCY,
      lineCount,
      status,
      issueAuthority: authority,
      numberAuthority,
      hubInvoiceNumber: hubNumber,
      hubInvoiceSequence: hubSequence as number | null,
      externalProvider: str(f[x.extProvider]),
      externalInvoiceId: extId,
      externalInvoiceNumber: extNumber,
      replacesInvoiceId: replaces,
      correctionId,
      approvedOmissions: omissions,
      reviewSnapshot: review,
      issuer,
      billingAddress,
      paymentDetails,
      branding,
      frozenBy,
      frozenAt,
      issuedBy,
      issuedAt,
      revision,
      updatedBy: changedBy,
      updatedAt: changedAt,
    },
  };
}

export function invoiceLineFromRow(r: Row): Parsed<InvoiceLine> {
  const f = r.fields ?? {};
  const x = FV.line;
  const id = str(f[x.id]);
  if (!id || !INVOICE_LINE_ID_PATTERN.test(id)) return { ok: false, problem: `invoice line row ${r.id}: bad Line ID` };
  const bad = (why: string): Parsed<InvoiceLine> => ({ ok: false, problem: `invoice line ${id}: ${why}` });
  if (links(f[FV.org]).length !== 1) return bad("must link exactly one organisation");
  const invoiceId = str(f[x.invoiceId]);
  if (!invoiceId || !INVOICE_ID_PATTERN.test(invoiceId)) return bad("invalid Invoice ID");
  const sequence = int(f[x.sequence], 1, 100_000);
  if (sequence === undefined) return bad("invalid Sequence");
  const sourceDraftId = str(f[x.sourceDraftId]);
  const sourceDraftLineId = str(f[x.sourceDraftLineId]);
  if (!sourceDraftId || !DRAFT_ID_PATTERN.test(sourceDraftId) || !sourceDraftLineId || !LINE_ID_PATTERN.test(sourceDraftLineId)) return bad("invalid source draft references");
  const occurrenceId = str(f[x.occurrenceId]);
  if (!occurrenceId || !OCCURRENCE_ID_PATTERN.test(occurrenceId)) return bad("invalid Occurrence ID");
  const date = f[x.date];
  if (!isIsoDate(date)) return bad("invalid Occurrence Date");
  const serviceId = str(f[x.serviceId]);
  const termsId = str(f[x.termsId]);
  if (!serviceId || !ID_PATTERNS.service.test(serviceId) || !termsId || !ID_PATTERNS.terms.test(termsId)) return bad("invalid service / terms reference");
  const serviceName = str(f[x.serviceName]);
  const description = str(f[x.description]);
  if (!serviceName || !description) return bad("missing service name / description");
  const chargeType = str(f[x.chargeType]) as ChargeType | null;
  if (!chargeType || !(CHARGE_TYPES as readonly string[]).includes(chargeType)) return bad("invalid Charge Type");
  const quantity = int(f[x.quantity], 0, MAX_BILLABLE_QUANTITY);
  const qs = str(f[x.quantitySource]) as QuantitySource | null;
  const unit = int(f[x.unit], 0, MAX_UNIT_AMOUNT_MINOR);
  const us = str(f[x.unitSource]) as UnitAmountSource | null;
  if (quantity === undefined || !qs || !QTY_SOURCES.includes(qs) || unit === undefined || !us || !UNIT_SOURCES.includes(us)) return bad("invalid quantity / unit amount");
  const vt = str(f[x.vatTreatment]);
  const rate = f[x.rate] ?? 0;
  if (!isVatTreatment(vt) || !isRateBasisPoints(rate) || (vt === "no_vat" && rate !== 0)) return bad("invalid VAT");
  const amount = lineMinor(f[x.amount]);
  const net = lineMinor(f[x.net]);
  const vat = lineMinor(f[x.vat]);
  const gross = lineMinor(f[x.gross]);
  if (amount === undefined || net === undefined || vat === undefined || gross === undefined || amount !== unit * quantity || net + vat !== gross) return bad("invalid amounts");
  const overrideIds = (str(f[x.overrideIds]) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (overrideIds.some((o) => !ID_PATTERNS.override.test(o))) return bad("invalid Override IDs");
  const snapshot = str(f[x.snapshot]);
  const createdBy = str(f[x.createdBy]);
  const createdAt = str(f[x.createdAt]);
  if (!snapshot || !createdBy || !createdAt) return bad("missing Source Snapshot / created metadata");
  return {
    ok: true,
    recordId: r.id,
    value: {
      lineId: id,
      invoiceId,
      sequence,
      sourceDraftId,
      sourceDraftLineId,
      occurrenceId,
      occurrenceDate: date as string,
      sessionId: str(f[x.sessionId]),
      sessionName: str(f[x.sessionName]),
      serviceId,
      serviceName,
      termsId,
      chargeType,
      description,
      quantity,
      quantitySource: qs,
      unitAmountMinor: unit,
      unitAmountSource: us,
      amountMinor: amount,
      vatTreatment: vt as VatTreatment,
      vatRateBasisPoints: rate,
      netMinor: net,
      vatMinor: vat,
      grossMinor: gross,
      overrideIds,
      snapshot,
      createdBy,
      createdAt,
    },
  };
}

function creditedLinesOf(v: unknown): CreditedLine[] | undefined {
  const a = json(v);
  if (!Array.isArray(a) || !a.length) return undefined;
  const out: CreditedLine[] = [];
  for (const c of a) {
    if (!c || typeof c !== "object" || Object.keys(c).sort().join(",") !== "grossMinor,invoiceLineId,netMinor,occurrenceId,vatMinor") return undefined;
    if (!INVOICE_LINE_ID_PATTERN.test(c.invoiceLineId) || !OCCURRENCE_ID_PATTERN.test(c.occurrenceId)) return undefined;
    const n = lineMinor(c.netMinor);
    const v2 = lineMinor(c.vatMinor);
    const g = lineMinor(c.grossMinor);
    if (n === undefined || v2 === undefined || g === undefined || n + v2 !== g) return undefined;
    if (out.some((o) => o.invoiceLineId === c.invoiceLineId)) return undefined;
    out.push({ invoiceLineId: c.invoiceLineId, occurrenceId: c.occurrenceId, netMinor: n, vatMinor: v2, grossMinor: g });
  }
  return out;
}

export function creditNoteFromRow(r: Row): Parsed<CreditNote> {
  const f = r.fields ?? {};
  const x = FV.credit;
  const id = str(f[x.id]);
  if (!id || !CREDIT_NOTE_ID_PATTERN.test(id)) return { ok: false, problem: `credit note row ${r.id}: bad Credit Note ID` };
  const bad = (why: string): Parsed<CreditNote> => ({ ok: false, problem: `credit note ${id}: ${why}` });
  if (links(f[FV.org]).length !== 1) return bad("must link exactly one organisation");
  const invoiceId = str(f[x.invoiceId]);
  const clientId = str(f[x.clientId]);
  const clientName = str(f[x.clientName]);
  if (!invoiceId || !INVOICE_ID_PATTERN.test(invoiceId) || !clientId || !CLIENT_ID_PATTERN.test(clientId) || !clientName) return bad("invalid invoice / client references");
  const date = f[x.date];
  if (!isIsoDate(date)) return bad("invalid Credit Date");
  const reason = str(f[x.reason]);
  if (!reason || reason.length > REASON_MAX) return bad("invalid Reason");
  const lines = creditedLinesOf(f[x.lines]);
  if (!lines) return bad("invalid Credited Lines");
  const net = totalMinor(f[x.net]);
  const vat = totalMinor(f[x.vat]);
  const gross = totalMinor(f[x.gross]);
  const sum = lines.reduce((a, c) => ({ n: a.n + c.netMinor, v: a.v + c.vatMinor, g: a.g + c.grossMinor }), { n: 0, v: 0, g: 0 });
  if (net === undefined || vat === undefined || gross === undefined || net !== sum.n || vat !== sum.v || gross !== sum.g || net + vat !== gross) return bad("totals do not equal the credited lines");
  if (str(f[x.currency]) !== CURRENCY) return bad("invalid Currency");
  const statusName = f[x.status] && typeof f[x.status] === "object" ? (f[x.status] as any).name : f[x.status];
  const authority = reverse(AUTHORITY, f[x.authority]);
  if (statusName !== "Issued" || !authority) return bad("invalid Status / Issue Authority");
  const createdBy = str(f[x.createdBy]);
  const createdAt = str(f[x.createdAt]);
  if (!createdBy || !createdAt) return bad("missing created metadata");
  return {
    ok: true,
    recordId: r.id,
    value: {
      creditNoteId: id,
      invoiceId,
      clientId,
      clientName,
      creditDate: date as string,
      reason,
      lines,
      netMinor: net,
      vatMinor: vat,
      grossMinor: gross,
      currency: CURRENCY,
      status: "issued",
      issueAuthority: authority,
      externalProvider: str(f[x.extProvider]),
      externalCreditNoteId: str(f[x.extId]),
      externalCreditNoteNumber: str(f[x.extNumber]),
      createdBy,
      createdAt,
    },
  };
}

export type StoredInvoice = { recordId: string; value: Invoice };
export type StoredInvoiceLine = { recordId: string; value: InvoiceLine };
export type StoredCreditNote = { recordId: string; value: CreditNote };
type Built<T> = { ok: true; items: { recordId: string; value: T }[] } | { ok: false; error: string };

function buildAll<T>(rows: Row[], orgRec: string, parse: (r: Row) => Parsed<T>, idOf: (t: T) => string, what: string): Built<T> {
  const problems: string[] = [];
  const out: { recordId: string; value: T }[] = [];
  for (const r of rows) {
    const org = links(r.fields?.[FV.org]);
    if (org.length !== 1 || org[0] !== orgRec) {
      problems.push(`row ${r.id} does not belong to this organisation`);
      continue;
    }
    const p = parse(r);
    if (p.ok) out.push({ recordId: p.recordId, value: p.value });
    else problems.push(p.problem);
  }
  const ids = out.map((o) => idOf(o.value));
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) problems.push(`duplicate id ${d}`);
  if (problems.length) return { ok: false, error: `Stored ${what} are not valid (${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; +${problems.length - 3} more` : ""}) - they must be corrected before use` };
  return { ok: true, items: out };
}

export function buildInvoices(rows: Row[], orgRec: string): { ok: true; invoices: StoredInvoice[] } | { ok: false; error: string } {
  const r = buildAll(rows, orgRec, invoiceFromRow, (i) => i.invoiceId, "invoices");
  return r.ok ? { ok: true, invoices: r.items } : r;
}
export function buildInvoiceLines(rows: Row[], orgRec: string): { ok: true; lines: StoredInvoiceLine[] } | { ok: false; error: string } {
  const r = buildAll(rows, orgRec, invoiceLineFromRow, (l) => l.lineId, "invoice lines");
  return r.ok ? { ok: true, lines: r.items } : r;
}
export function buildCreditNotes(rows: Row[], orgRec: string): { ok: true; notes: StoredCreditNote[] } | { ok: false; error: string } {
  const r = buildAll(rows, orgRec, creditNoteFromRow, (n) => n.creditNoteId, "credit notes");
  return r.ok ? { ok: true, notes: r.items } : r;
}

/** An invoice must equal its lines exactly: count, sequence 1..n, one line per occurrence, and every total. */
export function invoiceMatchesLines(i: Invoice, lines: readonly InvoiceLine[]): boolean {
  if (lines.length !== i.lineCount || lines.some((l) => l.invoiceId !== i.invoiceId || l.sourceDraftId !== i.sourceDraftId)) return false;
  const seqs = lines.map((l) => l.sequence).sort((a, b) => a - b);
  if (seqs.some((s, k) => s !== k + 1)) return false;
  if (new Set(lines.map((l) => l.occurrenceId)).size !== lines.length) return false;
  const t = lines.reduce((a, l) => ({ n: a.n + l.netMinor, v: a.v + l.vatMinor, g: a.g + l.grossMinor }), { n: 0, v: 0, g: 0 });
  return t.n === i.netMinor && t.v === i.vatMinor && t.g === i.grossMinor;
}

// ----- domain -> Airtable fields -----

export function invoiceCreateFields(i: Invoice, orgRecordId: string): Record<string, unknown> {
  const x = FV.invoice;
  return {
    [FV.org]: [orgRecordId],
    [x.id]: i.invoiceId,
    [x.sourceDraftId]: i.sourceDraftId,
    [x.clientId]: i.clientId,
    [x.clientName]: i.clientName,
    [x.contact]: i.billingContactName,
    [x.email]: i.billingEmail,
    [x.cc]: i.billingCcEmails.length ? i.billingCcEmails.join("\n") : null,
    [x.date]: i.invoiceDate,
    [x.due]: i.dueDate,
    [x.from]: i.periodFrom,
    [x.to]: i.periodTo,
    [x.termsDays]: i.paymentTermsDays,
    [x.termsSource]: TERMS_SOURCE[i.paymentTermsSource],
    [x.poRequired]: i.poRequired,
    [x.poNumber]: i.poNumber,
    [x.poOverride]: i.poOverrideReason,
    [x.net]: i.netMinor,
    [x.vat]: i.vatMinor,
    [x.gross]: i.grossMinor,
    [x.currency]: i.currency,
    [x.lineCount]: i.lineCount,
    [x.status]: INVOICE_STATUS[i.status],
    [x.authority]: AUTHORITY[i.issueAuthority],
    [x.numberAuthority]: NUMBER_AUTHORITY[i.numberAuthority],
    [x.hubNumber]: i.hubInvoiceNumber,
    [x.hubSequence]: i.hubInvoiceSequence,
    [x.extProvider]: i.externalProvider,
    [x.extId]: i.externalInvoiceId,
    [x.extNumber]: i.externalInvoiceNumber,
    [x.replaces]: i.replacesInvoiceId,
    [x.correctionId]: i.correctionId,
    [x.omissions]: i.approvedOmissions.length ? JSON.stringify(i.approvedOmissions) : null,
    [x.review]: i.reviewSnapshot,
    [x.issuer]: JSON.stringify(i.issuer),
    [x.billingAddress]: i.billingAddress ? JSON.stringify(i.billingAddress) : null,
    [x.paymentDetails]: i.paymentDetails ? JSON.stringify(i.paymentDetails) : null,
    [x.branding]: i.branding ? JSON.stringify(i.branding) : null,
    [x.frozenBy]: i.frozenBy,
    [x.frozenAt]: i.frozenAt,
    [x.issuedBy]: i.issuedBy,
    [x.issuedAt]: i.issuedAt,
    [x.revision]: i.revision,
    [x.changedBy]: i.updatedBy,
    [x.changedAt]: i.updatedAt,
  };
}

/** The ONLY patch ever made to an invoice row: its credit state + revision. The undo writes the previous values back. */
export function invoiceStateFields(i: Pick<Invoice, "status" | "revision" | "updatedBy" | "updatedAt">): Record<string, unknown> {
  const x = FV.invoice;
  return { [x.status]: INVOICE_STATUS[i.status], [x.revision]: i.revision, [x.changedBy]: i.updatedBy, [x.changedAt]: i.updatedAt };
}

export function invoiceLineCreateFields(l: InvoiceLine, orgRecordId: string): Record<string, unknown> {
  const x = FV.line;
  return {
    [FV.org]: [orgRecordId],
    [x.id]: l.lineId,
    [x.invoiceId]: l.invoiceId,
    [x.sequence]: l.sequence,
    [x.sourceDraftId]: l.sourceDraftId,
    [x.sourceDraftLineId]: l.sourceDraftLineId,
    [x.occurrenceId]: l.occurrenceId,
    [x.date]: l.occurrenceDate,
    [x.sessionId]: l.sessionId,
    [x.sessionName]: l.sessionName,
    [x.serviceId]: l.serviceId,
    [x.serviceName]: l.serviceName,
    [x.termsId]: l.termsId,
    [x.chargeType]: l.chargeType,
    [x.description]: l.description,
    [x.quantity]: l.quantity,
    [x.quantitySource]: l.quantitySource,
    [x.unit]: l.unitAmountMinor,
    [x.unitSource]: l.unitAmountSource,
    [x.amount]: l.amountMinor,
    [x.vatTreatment]: l.vatTreatment,
    [x.rate]: l.vatRateBasisPoints,
    [x.net]: l.netMinor,
    [x.vat]: l.vatMinor,
    [x.gross]: l.grossMinor,
    [x.overrideIds]: l.overrideIds.length ? l.overrideIds.join(",") : null,
    [x.snapshot]: l.snapshot,
    [x.createdBy]: l.createdBy,
    [x.createdAt]: l.createdAt,
  };
}

export function creditNoteCreateFields(n: CreditNote, orgRecordId: string): Record<string, unknown> {
  const x = FV.credit;
  return {
    [FV.org]: [orgRecordId],
    [x.id]: n.creditNoteId,
    [x.invoiceId]: n.invoiceId,
    [x.clientId]: n.clientId,
    [x.clientName]: n.clientName,
    [x.date]: n.creditDate,
    [x.reason]: n.reason,
    [x.lines]: JSON.stringify(n.lines),
    [x.net]: n.netMinor,
    [x.vat]: n.vatMinor,
    [x.gross]: n.grossMinor,
    [x.currency]: n.currency,
    [x.status]: "Issued",
    [x.authority]: AUTHORITY[n.issueAuthority],
    [x.extProvider]: n.externalProvider,
    [x.extId]: n.externalCreditNoteId,
    [x.extNumber]: n.externalCreditNoteNumber,
    [x.createdBy]: n.createdBy,
    [x.createdAt]: n.createdAt,
  };
}
