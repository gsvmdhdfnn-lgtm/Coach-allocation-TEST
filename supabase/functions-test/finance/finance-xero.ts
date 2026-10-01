/**
 * Finance Xero invoice connector - PURE (Finance Foundation F9; see
 * TEST-ENV.md "Finance Foundation - F9"). No HTTP, Airtable, Supabase or
 * Deno code.
 *
 * Ownership (locked):
 *   - The Hub builds, reviews and freezes the invoice (F5 / F6). Reaching
 *     Ready, and F6 freezing a Xero-authority invoice into "Awaiting
 *     external issue", never contacts Xero.
 *   - Only an explicit Management "Send / Issue via Xero" (F9) contacts
 *     Xero. Xero then creates the official accounting invoice, assigns the
 *     official number, and sends it. The Hub records Xero's id / number /
 *     dates / status and only THEN moves the invoice to Issued (F7's
 *     receivable starts there).
 *   - Xero never recalculates the Hub's figures: the Xero invoice is built
 *     from the FROZEN F6 lines (never today's Sessions / terms), created as
 *     a Xero DRAFT, compared field-for-field with the frozen package, and
 *     only authorised when every line, tax amount, total, date, contact and
 *     reference matches. A mismatching draft is deleted in Xero and nothing
 *     is issued.
 *
 * Connector journal stages (finance_xero_invoice_links.stage):
 *   creating       create requested; no Xero invoice is KNOWN yet (a
 *                  previous attempt's outcome may be unknown - the next
 *                  attempt looks the invoice up in Xero first)
 *   draft_created  a Xero DRAFT exists (id known) - verify, then authorise
 *   created        the Xero invoice is authorised: official number + dates
 *                  known - the Hub records them (Awaiting -> Issued)
 *   issued         the Hub invoice is Issued (send state tracked separately)
 *   needs_review   Xero holds an AUTHORISED invoice that does not match the
 *                  frozen package - never recorded as issued, never
 *                  silently fixed; a person must resolve it
 */
import type { Minor } from "./finance-money.ts";
import { formatMinor } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { REASON_MAX, auditEvent } from "./finance-commercial.ts";
import { CLIENT_ID_PATTERN, INVOICE_ID_PATTERN } from "./finance-invoicing.ts";
import { type Invoice, type InvoiceLine, CURRENCY, addDays } from "./finance-issue.ts";

export const XERO_CONTRACT = "finance-xero-v1";
export const XERO_PROVIDER = "xero";

export const XERO_EVENTS = {
  createRequested: "finance_invoice.xero_create_requested",
  createFailed: "finance_invoice.xero_create_failed",
  createOutcomeUnknown: "finance_invoice.xero_create_outcome_unknown",
  draftDiscarded: "finance_invoice.xero_draft_discarded",
  mismatchDetected: "finance_invoice.xero_mismatch_detected",
  recovered: "finance_invoice.xero_invoice_recovered",
  created: "finance_invoice.xero_invoice_created",
  issueConfirmed: "finance_invoice.external_issue_confirmed",
  sent: "finance_invoice.xero_sent",
  sendFailed: "finance_invoice.xero_send_failed",
  contactLinked: "finance_client.xero_contact_linked",
  settingsUpdated: "finance_xero.settings_updated",
} as const;
export const ENTITY_INVOICE = "finance_invoice";
export const ENTITY_CLIENT = "finance_client";
export const ENTITY_CONNECTION = "finance_xero_connection";

export const ENVIRONMENTS = ["live", "sandbox"] as const;
export type XeroEnvironment = (typeof ENVIRONMENTS)[number];
/** What the Hub invoice row records as External Provider: the sandbox is never mistaken for real Xero. */
export const PROVIDER_LABEL: Record<XeroEnvironment, string> = { live: "Xero", sandbox: "Xero (TEST sandbox)" };

export const STAGES = ["creating", "draft_created", "created", "issued", "needs_review"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  creating: "Not created in Xero yet",
  draft_created: "Draft created in Xero - being checked",
  created: "Created in Xero - being recorded in the Hub",
  issued: "Issued through Xero",
  needs_review: "Xero invoice does not match - needs review",
};
export const SEND_STATUSES = ["not_sent", "sent", "send_failed"] as const;
export type SendStatus = (typeof SEND_STATUSES)[number];
export const SEND_LABELS: Record<SendStatus, string> = { not_sent: "Not sent yet", sent: "Sent by Xero", send_failed: "Sending failed - retry to send" };

/** Xero object ids are GUIDs. */
export const XERO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Xero account codes are up to 10 characters; tax types are codes like OUTPUT2 / ZERORATEDOUTPUT / TAX001. */
export const ACCOUNT_CODE_PATTERN = /^[A-Za-z0-9._-]{1,10}$/;
export const TAX_TYPE_PATTERN = /^[A-Z0-9_]{1,50}$/;
/** Tax mapping keys: "no_vat" for no-VAT lines, "rate_<basis points>" for VAT lines at that rate (e.g. rate_2000 = 20%). */
export const TAX_KEY_PATTERN = /^(no_vat|rate_(0|[1-9][0-9]{0,4}))$/;
export const IDEMPOTENCY_KEY_MAX = 128;
export const LINE_DESCRIPTION_MAX = 4000;
export const REFERENCE_MAX = 255;

// ---------------------------------------------------------------------
// Stored shapes (Supabase rows, validated by the repository)
// ---------------------------------------------------------------------

export interface XeroConfig {
  accountCode: string | null;
  taxTypes: Record<string, string>;
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface XeroConnection {
  organisationId: string;
  environment: XeroEnvironment;
  status: "connected" | "disconnected";
  clientId: string;
  tenantId: string | null;
  tenantName: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  config: XeroConfig;
}

export interface InvoiceLink {
  organisationId: string;
  invoiceId: string;
  clientId: string;
  environment: XeroEnvironment;
  idempotencyKey: string;
  generation: number;
  stage: Stage;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  xeroStatus: string | null;
  xeroContactId: string | null;
  xeroDate: string | null;
  xeroDueDate: string | null;
  createAttempts: number;
  sendStatus: SendStatus;
  sendAttempts: number;
  sendKeyGeneration: number;
  sentAt: string | null;
  lastErrorStage: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  mismatches: string[] | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactLink {
  organisationId: string;
  clientId: string;
  xeroContactId: string;
  method: "matched_contact_number" | "created" | "linked_by_manager";
  linkedAt: string;
  linkedBy: string;
}

// ---------------------------------------------------------------------
// Readiness (everything checked BEFORE any external call)
// ---------------------------------------------------------------------

export const taxKeyOf = (l: Pick<InvoiceLine, "vatTreatment" | "vatRateBasisPoints">): string => (l.vatTreatment === "no_vat" ? "no_vat" : `rate_${l.vatRateBasisPoints}`);
export const taxKeyLabel = (k: string): string => (k === "no_vat" ? "lines without VAT" : `VAT at ${(Number(k.slice(5)) / 100).toString()}%`);

export type Problem = { code: string; message: string };

/** Connection + configuration problems that stop an issue before Xero is contacted (empty = ready). */
export function connectionProblems(conn: XeroConnection | null): Problem[] {
  if (!conn) return [{ code: "xero_not_connected", message: "Xero is not connected for this organisation" }];
  if (conn.status !== "connected") return [{ code: "xero_not_connected", message: "The Xero connection has been disconnected" }];
  const out: Problem[] = [];
  if (!conn.config.accountCode) out.push({ code: "xero_account_code_missing", message: "Choose the Xero sales account invoices are posted to" });
  return out;
}

/** Per-invoice mapping problems: every line's VAT must map to a Xero tax type. */
export function mappingProblems(conn: XeroConnection, lines: readonly InvoiceLine[]): Problem[] {
  const missing = [...new Set(lines.map(taxKeyOf))].filter((k) => !conn.config.taxTypes[k]).sort();
  return missing.map((k) => ({ code: "xero_tax_mapping_missing", message: `Choose the Xero tax rate for ${taxKeyLabel(k)} (${k})` }));
}

// ---------------------------------------------------------------------
// The Xero invoice request, built ONLY from the frozen invoice
// ---------------------------------------------------------------------

/** The Xero Reference: the frozen PO (when there is one) and the Hub's FIV reference, so the Xero invoice is always traceable. Never truncated (PO <= 100 chars). */
export function xeroReference(i: Pick<Invoice, "invoiceId" | "poNumber">): string {
  return i.poNumber ? `${i.poNumber} | ${i.invoiceId}` : i.invoiceId;
}

export interface ExpectedInvoice {
  contactId: string;
  date: string;
  dueDate: string;
  reference: string;
  currency: string;
  lines: { description: string; quantity: number; netMinor: Minor; vatMinor: Minor; taxType: string; accountCode: string }[];
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
}

/** What Xero must hold for this frozen invoice issued on `date` (the Hub's day): due date = date + the FROZEN payment terms. */
export function expectedInvoice(inv: Invoice, lines: readonly InvoiceLine[], conn: XeroConnection, contactId: string, date: string): ExpectedInvoice {
  const sorted = [...lines].sort((a, b) => a.sequence - b.sequence);
  return {
    contactId,
    date,
    dueDate: addDays(date, inv.paymentTermsDays),
    reference: xeroReference(inv),
    currency: inv.currency,
    lines: sorted.map((l) => ({
      description: l.description.length > LINE_DESCRIPTION_MAX ? l.description.slice(0, LINE_DESCRIPTION_MAX) : l.description,
      quantity: l.quantity,
      netMinor: l.netMinor,
      vatMinor: l.vatMinor,
      taxType: conn.config.taxTypes[taxKeyOf(l)],
      accountCode: conn.config.accountCode as string,
    })),
    netMinor: inv.netMinor,
    vatMinor: inv.vatMinor,
    grossMinor: inv.grossMinor,
  };
}

const money = (m: Minor) => Number(formatMinor(m));

/**
 * The Xero create payload: a DRAFT ACCREC invoice, amounts EXCLUSIVE of
 * tax, each line carrying the frozen net (LineAmount) and frozen VAT
 * (TaxAmount) so Xero holds the Hub's figures (UnitAmount is derived by
 * Xero from LineAmount / Quantity). No InvoiceNumber: Xero assigns the
 * official number.
 */
export function xeroInvoicePayload(e: ExpectedInvoice): Record<string, unknown> {
  return {
    Type: "ACCREC",
    Contact: { ContactID: e.contactId },
    Date: e.date,
    DueDate: e.dueDate,
    LineAmountTypes: "Exclusive",
    Reference: e.reference,
    CurrencyCode: e.currency,
    Status: "DRAFT",
    LineItems: e.lines.map((l) => ({ Description: l.description, Quantity: l.quantity, LineAmount: money(l.netMinor), TaxAmount: money(l.vatMinor), TaxType: l.taxType, AccountCode: l.accountCode })),
  };
}

// ---------------------------------------------------------------------
// Parsing Xero responses (strict: anything unexpected is malformed)
// ---------------------------------------------------------------------

export interface XeroInvoice {
  invoiceId: string;
  number: string | null;
  status: string;
  type: string;
  date: string | null;
  dueDate: string | null;
  reference: string | null;
  contactId: string | null;
  currency: string | null;
  lineAmountTypes: string | null;
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
  sentToContact: boolean;
  lines: { description: string; quantity: number; netMinor: Minor; vatMinor: Minor; taxType: string | null; accountCode: string | null }[];
}

/** A Xero decimal (number or numeric string) in exact minor units, or undefined. */
export function toMinor(v: unknown): Minor | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const m = Math.round(n * 100);
  return Math.abs(n * 100 - m) > 1e-6 ? undefined : m;
}

/** A Xero date: "DateString" ("2026-10-01T00:00:00") preferred, else the MS JSON "/Date(1790812800000+0000)/". */
export function xeroDate(dateString: unknown, msDate: unknown): string | null {
  if (typeof dateString === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateString) && isIsoDate(dateString.slice(0, 10))) return dateString.slice(0, 10);
  if (typeof msDate === "string") {
    const m = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(msDate);
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}/.test(msDate) && isIsoDate(msDate.slice(0, 10))) return msDate.slice(0, 10);
  }
  return null;
}

const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseXeroInvoice(raw: unknown): { ok: true; invoice: XeroInvoice } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `Xero returned an invoice the Hub cannot read (${why})` });
  if (!raw || typeof raw !== "object") return bad("not an object");
  const x = raw as Record<string, any>;
  const id = strOrNull(x.InvoiceID);
  if (!id || !XERO_ID_PATTERN.test(id)) return bad("no InvoiceID");
  const status = strOrNull(x.Status);
  if (!status) return bad("no Status");
  const net = toMinor(x.SubTotal);
  const vat = toMinor(x.TotalTax);
  const gross = toMinor(x.Total);
  if (net === undefined || vat === undefined || gross === undefined) return bad("totals are not exact amounts");
  if (!Array.isArray(x.LineItems)) return bad("no LineItems");
  const lines = [];
  for (const li of x.LineItems) {
    const ln = toMinor(li?.LineAmount);
    const lt = toMinor(li?.TaxAmount ?? 0);
    const q = typeof li?.Quantity === "number" ? li.Quantity : Number(li?.Quantity);
    if (ln === undefined || lt === undefined || !Number.isFinite(q)) return bad("a line has no exact amount / quantity");
    lines.push({ description: typeof li.Description === "string" ? li.Description : "", quantity: q, netMinor: ln, vatMinor: lt, taxType: strOrNull(li.TaxType), accountCode: strOrNull(li.AccountCode) });
  }
  const contactId = strOrNull(x.Contact?.ContactID);
  return {
    ok: true,
    invoice: {
      invoiceId: id.toLowerCase(),
      number: strOrNull(x.InvoiceNumber),
      status,
      type: strOrNull(x.Type) ?? "",
      date: xeroDate(x.DateString, x.Date),
      dueDate: xeroDate(x.DueDateString, x.DueDate),
      reference: strOrNull(x.Reference),
      contactId: contactId ? contactId.toLowerCase() : null,
      currency: strOrNull(x.CurrencyCode),
      lineAmountTypes: strOrNull(x.LineAmountTypes),
      netMinor: net,
      vatMinor: vat,
      grossMinor: gross,
      sentToContact: x.SentToContact === true,
      lines,
    },
  };
}

/**
 * Every way the Xero invoice differs from the frozen Hub invoice (empty =
 * identical). Compared: type, currency, tax basis, contact, reference,
 * dates, line count / order, every line's description, quantity, net, VAT,
 * tax type and account, and the three totals. Xero's own representation
 * (derived UnitAmount, line ids) is not compared.
 */
export function invoiceMismatches(x: XeroInvoice, e: ExpectedInvoice): string[] {
  const out: string[] = [];
  const eq = (what: string, got: unknown, want: unknown) => {
    if (got !== want) out.push(`${what}: Xero has ${JSON.stringify(got)}, the Hub froze ${JSON.stringify(want)}`);
  };
  eq("type", x.type, "ACCREC");
  eq("currency", x.currency, e.currency);
  eq("line amount type", x.lineAmountTypes, "Exclusive");
  eq("contact", x.contactId, e.contactId.toLowerCase());
  eq("reference", x.reference, e.reference);
  eq("invoice date", x.date, e.date);
  eq("due date", x.dueDate, e.dueDate);
  eq("number of lines", x.lines.length, e.lines.length);
  e.lines.forEach((w, k) => {
    const g = x.lines[k];
    if (!g) return;
    eq(`line ${k + 1} description`, g.description, w.description);
    eq(`line ${k + 1} quantity`, g.quantity, w.quantity);
    eq(`line ${k + 1} net`, g.netMinor, w.netMinor);
    eq(`line ${k + 1} VAT`, g.vatMinor, w.vatMinor);
    eq(`line ${k + 1} tax type`, g.taxType, w.taxType);
    eq(`line ${k + 1} account`, g.accountCode, w.accountCode);
  });
  eq("net total", x.netMinor, e.netMinor);
  eq("VAT total", x.vatMinor, e.vatMinor);
  eq("total", x.grossMinor, e.grossMinor);
  return out;
}

export interface XeroContact {
  contactId: string;
  name: string;
  contactNumber: string | null;
  email: string | null;
  status: string;
}
export function parseXeroContact(raw: unknown): XeroContact | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, any>;
  const id = strOrNull(x.ContactID);
  const name = strOrNull(x.Name);
  if (!id || !XERO_ID_PATTERN.test(id) || !name) return null;
  return { contactId: id.toLowerCase(), name, contactNumber: strOrNull(x.ContactNumber), email: strOrNull(x.EmailAddress), status: strOrNull(x.ContactStatus) ?? "ACTIVE" };
}

// ---------------------------------------------------------------------
// Idempotency keys (stable per invoice; <= 128 chars, no secrets)
// ---------------------------------------------------------------------

export const invoiceKeyBase = (organisationId: string, invoiceId: string) => `hub:${organisationId}:${invoiceId}`;
export const createKey = (l: Pick<InvoiceLink, "idempotencyKey" | "generation">) => `${l.idempotencyKey}:g${l.generation}:create`;
export const authoriseKey = (l: Pick<InvoiceLink, "idempotencyKey" | "generation">) => `${l.idempotencyKey}:g${l.generation}:authorise`;
export const discardKey = (l: Pick<InvoiceLink, "idempotencyKey" | "generation">) => `${l.idempotencyKey}:g${l.generation}:discard`;
export const sendKey = (l: Pick<InvoiceLink, "idempotencyKey" | "sendKeyGeneration">) => `${l.idempotencyKey}:email:${l.sendKeyGeneration}`;
export const contactKey = (organisationId: string, clientId: string) => `hub:${organisationId}:${clientId}:contact`;
export const contactEmailKey = (organisationId: string, clientId: string, email: string) => `hub:${organisationId}:${clientId}:email:${email}`.slice(0, IDEMPOTENCY_KEY_MAX);

// ---------------------------------------------------------------------
// Public views (never a token, secret or client secret id)
// ---------------------------------------------------------------------

export function nextAction(l: InvoiceLink | null): "issue" | "retry_create" | "finish_recording" | "retry_send" | "review" | null {
  if (!l) return "issue";
  if (l.stage === "needs_review") return "review";
  if (l.stage === "creating" || l.stage === "draft_created") return "retry_create";
  if (l.stage === "created") return "finish_recording";
  return l.sendStatus === "sent" ? null : "retry_send";
}

export function publicXeroState(l: InvoiceLink | null) {
  if (!l) return { started: false, stage: null, nextAction: "issue" };
  return {
    started: true,
    environment: l.environment,
    stage: l.stage,
    stageLabel: STAGE_LABELS[l.stage],
    xeroInvoiceId: l.xeroInvoiceId,
    officialNumber: l.xeroInvoiceNumber,
    externalStatus: l.xeroStatus,
    invoiceDate: l.xeroDate,
    dueDate: l.xeroDueDate,
    xeroContactId: l.xeroContactId,
    createAttempts: l.createAttempts,
    send: { status: l.sendStatus, label: SEND_LABELS[l.sendStatus], sentAt: l.sentAt, attempts: l.sendAttempts },
    lastError: l.lastErrorCode ? { stage: l.lastErrorStage, code: l.lastErrorCode, message: l.lastErrorMessage, at: l.lastErrorAt } : null,
    mismatches: l.mismatches,
    nextAction: nextAction(l),
  };
}

export function publicConnection(c: XeroConnection | null) {
  if (!c) return { provider: XERO_PROVIDER, connected: false, status: "not_connected" };
  return {
    provider: XERO_PROVIDER,
    connected: c.status === "connected",
    status: c.status,
    environment: c.environment,
    environmentLabel: c.environment === "sandbox" ? "TEST sandbox (not real Xero)" : "Xero",
    tenantName: c.tenantName,
    tenantId: c.tenantId,
    connectedAt: c.connectedAt,
    lastSuccessAt: c.lastSuccessAt,
    lastError: c.lastErrorCode ? { code: c.lastErrorCode, message: c.lastErrorMessage, at: c.lastErrorAt } : null,
  };
}

export const publicConfig = (c: XeroConfig) => ({ accountCode: c.accountCode, taxTypes: { ...c.taxTypes }, revision: c.revision, updatedAt: c.updatedAt });

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

export function xeroAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: XERO_CONTRACT } };
}

/** The external facts of a link, for audit payloads (ids, number, dates, states - never credentials). */
export const auditLink = (l: InvoiceLink) => ({
  stage: l.stage,
  xeroInvoiceId: l.xeroInvoiceId,
  xeroInvoiceNumber: l.xeroInvoiceNumber,
  xeroStatus: l.xeroStatus,
  xeroContactId: l.xeroContactId,
  xeroDate: l.xeroDate,
  xeroDueDate: l.xeroDueDate,
  sendStatus: l.sendStatus,
  generation: l.generation,
  createAttempts: l.createAttempts,
});

// ---------------------------------------------------------------------
// Routes + requests
// ---------------------------------------------------------------------

export type XeroRoute =
  | { name: "xero.status"; params: Record<string, never> }
  | { name: "xero.settings"; params: Record<string, never> }
  | { name: "invoice.xero_issue"; params: { invoiceId: string } }
  | { name: "invoice.xero_retry"; params: { invoiceId: string } }
  | { name: "invoice.xero_state"; params: { invoiceId: string } }
  | { name: "client.xero_contact"; params: { clientId: string } };
export type XeroMatch = { status: "match"; route: XeroRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;

/** Owns only its own paths (xero/..., invoices/{id}/xero-*, clients/{id}/xero-contact) and returns null for everything else. */
export function matchXeroRoute(path: string, method: string): XeroMatch {
  const seg = path.split("/");
  const m = (allowed: string[], route: XeroRoute): XeroMatch => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg[0] === "xero") {
    if (seg.length === 2 && seg[1] === "status") return m(["GET"], { name: "xero.status", params: {} });
    if (seg.length === 2 && seg[1] === "settings") return m(["POST"], { name: "xero.settings", params: {} });
    return { status: "not_found" };
  }
  if (seg[0] === "invoices" && seg.length === 3 && /^xero(-|$)/.test(seg[2])) {
    if (!INVOICE_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    const invoiceId = seg[1];
    if (seg[2] === "xero") return m(["GET"], { name: "invoice.xero_state", params: { invoiceId } });
    if (seg[2] === "xero-issue") return m(["POST"], { name: "invoice.xero_issue", params: { invoiceId } });
    if (seg[2] === "xero-retry") return m(["POST"], { name: "invoice.xero_retry", params: { invoiceId } });
    return { status: "not_found" };
  }
  if (seg[0] === "clients" && seg.length === 3 && seg[2] === "xero-contact") {
    if (!CLIENT_ID_PATTERN.test(seg[1])) return { status: "not_found" };
    return m(["POST"], { name: "client.xero_contact", params: { clientId: seg[1] } });
  }
  return null;
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

function jsonObject(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean, emptyOk: boolean): { ok: true; body: Record<string, unknown> } | Invalid {
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

function reasonOf(v: unknown, required: boolean): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > REASON_MAX) return { ok: false, error: `must be at most ${REASON_MAX} characters` };
  if (CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

/** POST /invoices/{id}/xero-issue and /xero-retry: { reason? } (an empty body is fine). */
export function parseXeroAction(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey, true);
  if (!b.ok) return b;
  const r = reasonOf(b.body.reason, false);
  if (!r.ok) return invalid("invalid_input", "Some fields are not valid - nothing was sent", { reason: r.error });
  return { ok: true, reason: r.value };
}

/** POST /clients/{id}/xero-contact { contactId, reason } - link an existing Xero contact explicitly (never by name). */
export function parseContactLink(raw: string, isTenantKey: (k: string) => boolean): { ok: true; contactId: string; reason: string } | Invalid {
  const b = jsonObject(raw, ["contactId", "reason"], isTenantKey, false);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const id = b.body.contactId;
  if (typeof id !== "string" || !XERO_ID_PATTERN.test(id.trim())) fields.contactId = "must be the Xero ContactID (a GUID)";
  const r = reasonOf(b.body.reason, true);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was linked", fields);
  return { ok: true, contactId: (id as string).trim().toLowerCase(), reason: (r as { ok: true; value: string }).value };
}

export type SettingsChange = { accountCode?: string | null; taxTypes?: Record<string, string>; reason: string | null };
/**
 * POST /xero/settings { accountCode?, taxTypes?, reason? } - the non-secret
 * Xero mapping. taxTypes REPLACES the whole map ({} clears it); keys are
 * "no_vat" or "rate_<basis points>", values Xero tax type codes.
 */
export function parseXeroSettings(raw: string, isTenantKey: (k: string) => boolean): ({ ok: true } & SettingsChange) | Invalid {
  const b = jsonObject(raw, ["accountCode", "taxTypes", "reason"], isTenantKey, false);
  if (!b.ok) return b;
  const fields: Record<string, string> = {};
  const out: SettingsChange = { reason: null };
  if ("accountCode" in b.body) {
    const v = b.body.accountCode;
    if (v === null) out.accountCode = null;
    else if (typeof v !== "string" || !ACCOUNT_CODE_PATTERN.test(v.trim())) fields.accountCode = "must be a Xero account code (1-10 letters, digits, . _ -) or null";
    else out.accountCode = v.trim();
  }
  if ("taxTypes" in b.body) {
    const v = b.body.taxTypes;
    if (!v || typeof v !== "object" || Array.isArray(v)) fields.taxTypes = 'must be an object like {"rate_2000": "<Xero tax type>", "no_vat": "<Xero tax type>"}';
    else {
      const entries = Object.entries(v as Record<string, unknown>);
      const badKey = entries.find(([k]) => !TAX_KEY_PATTERN.test(k) || (k.startsWith("rate_") && Number(k.slice(5)) > 10000));
      const badVal = entries.find(([, t]) => typeof t !== "string" || !TAX_TYPE_PATTERN.test(t));
      if (badKey) fields.taxTypes = `"${badKey[0]}" is not a tax mapping key - use "no_vat" or "rate_<basis points>" (rate_2000 = 20%)`;
      else if (badVal) fields.taxTypes = `"${badVal[0]}" must map to a Xero tax type code (capital letters, digits, _)`;
      else if (entries.length > 20) fields.taxTypes = "at most 20 tax mappings";
      else out.taxTypes = Object.fromEntries(entries.map(([k, t]) => [k, t as string]).sort(([a], [b2]) => a.localeCompare(b2)));
    }
  }
  const r = reasonOf(b.body.reason, false);
  if (!r.ok) fields.reason = r.error;
  if (Object.keys(fields).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", fields);
  if (out.accountCode === undefined && out.taxTypes === undefined) return invalid("invalid_input", "Nothing to change - send accountCode and / or taxTypes");
  out.reason = r.ok ? r.value : null;
  return { ok: true, ...out };
}
