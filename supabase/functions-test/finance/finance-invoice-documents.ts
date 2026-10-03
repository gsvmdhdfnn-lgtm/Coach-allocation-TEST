/**
 * Official Hub invoice PDF + manual "Sent" history - PURE (Finance Foundation
 * F22; see TEST-ENV.md "Finance Foundation - F22"). No HTTP, Airtable,
 * Supabase, Storage or Deno code.
 *
 * The PDF is a RENDERING of the F6 issuance snapshot - never a second
 * authority, never a second issue workflow:
 *   - only a Hub-authority invoice (Hub numbering AND Hub issue) that is
 *     canonically issued gets one; a Xero-numbered / Xero-issued invoice,
 *     an invoice awaiting external issue and any draft never do (Xero owns
 *     those documents) -> refused, no Xero call;
 *   - the number is the F6 Hub number; dates, terms, PO, client, billing
 *     address, issuer, VAT number, payment details and branding are the
 *     values FROZEN on the invoice at issue - today's Settings, client or
 *     branding are never read for them. An invoice frozen before F22 (no
 *     address / payment / branding snapshot) is refused with
 *     invoice_snapshot_incomplete - nothing is reconstructed;
 *   - every money figure is the stored minor amount, formatted only: no
 *     total, VAT or line amount is recalculated here;
 *   - credit state is never printed: a credit note changes the invoice's
 *     credit state, never its issued document;
 *   - no internal Hub ids (FIV / FVL / FDC ...) and no secrets are printed.
 *
 * snapshotSha256 = sha256 of the canonical JSON of exactly what is printed
 * (renderInputOf). The document row pins it: a retry can only ever render the
 * same snapshot (the database refuses another - f22:snapshot_changed).
 *
 * Lifecycle states stay distinct: ISSUED (F6) / PDF generated (this
 * document) / downloaded (audit only) / SENT (manual, append-only history) /
 * PAID (F7). Generating or downloading is not sending; sending is not payment.
 */
import { formatMinor, formatRatePercent } from "./finance-money.ts";
import type { BillingAddress } from "./finance-commercial.ts";
import { auditEvent } from "./finance-commercial.ts";
import type { PaymentDetails } from "./finance-settings.ts";
import { type Invoice, type InvoiceBranding, type InvoiceLine, HUB_INVOICE_NUMBER_PATTERN, INVOICE_ID_PATTERN, isIssued } from "./finance-issue.ts";
import { type FontName, type PdfImage, type Rgb, A4, PdfBuilder, textWidth, wrapText } from "./finance-pdf.ts";

export const DOCUMENT_CONTRACT = "finance-invoice-documents-v1";
/** Bumped whenever the layout changes; stored on each document (a stored PDF is never re-rendered). */
export const RENDERER_VERSION = "hub-invoice-pdf-1";
export const DOCUMENT_BUCKET = "finance-documents";
export const ENTITY_DOCUMENT = "finance_invoice_document";
export const ENTITY_INVOICE = "finance_invoice";
export const DOCUMENT_EVENTS = {
  generated: "finance_invoice_document.generated",
  generationFailed: "finance_invoice_document.generation_failed",
  /** Downloads of an official document are audited (a documented exception to "reads are never audited"). */
  downloaded: "finance_invoice_document.downloaded",
  sent: "finance_invoice.sent_manually",
} as const;
export const DOCUMENT_ID_PATTERN = /^FDC-[0-9A-F]{12}$/;
export const SEND_ID_PATTERN = /^FSE-[0-9A-F]{12}$/;
export function newDocumentId(prefix: "FDC" | "FSE", randomHex: string): string {
  const h = randomHex.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (h.length < 12) throw new Error("newDocumentId needs at least 12 hex characters");
  return `${prefix}-${h.slice(0, 12)}`;
}
export const SENT_TO_MAX = 10;
export const NOTE_MAX = 500;

/** Storage object path - derived ONLY from the organisation + invoice + official number (the database CHECK says the same). Never trusted for authorisation. */
export function storagePathOf(organisationId: string, invoiceId: string, officialNumber: string): string {
  return `${organisationId}/invoices/${invoiceId}/${officialNumber.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`;
}
export const fileNameOf = (officialNumber: string) => `${officialNumber.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`;

// ---------------------------------------------------------------------
// The official-document contract
// ---------------------------------------------------------------------

export type Refusal = { ok: false; httpStatus: 404 | 409; code: string; error: string; missing?: string[] };
const refuse = (httpStatus: Refusal["httpStatus"], code: string, error: string, missing?: string[]): Refusal => ({ ok: false, httpStatus, code, error, ...(missing ? { missing } : {}) });

/** Everything printed on the PDF - all of it frozen on the invoice at issue. */
export interface RenderInput {
  documentType: "invoice";
  currency: "GBP";
  officialNumber: string;
  invoiceDate: string;
  dueDate: string;
  issuedAt: string;
  period: { from: string; to: string };
  paymentTermsDays: number;
  poNumber: string | null;
  issuer: { legalName: string; tradingName: string | null; address: string; companyNumber: string | null; vatRegistered: boolean; vatNumber: string | null };
  branding: InvoiceBranding;
  billTo: { name: string; contactName: string | null; email: string; ccEmails: string[]; address: BillingAddress };
  lines: { sequence: number; date: string; description: string; quantity: number; unitMinor: number; vatTreatment: string; vatRateBasisPoints: number; netMinor: number; vatMinor: number; grossMinor: number }[];
  totals: { netMinor: number; vatMinor: number; grossMinor: number };
  payment: PaymentDetails & { reference: string };
}

/** Xero owns the invoice (its number / issue / document) - the Hub never produces a PDF for it. */
export const isHubAuthority = (i: Pick<Invoice, "numberAuthority" | "issueAuthority">) => i.numberAuthority === "hub" && i.issueAuthority === "hub";

/**
 * May this invoice have an official Hub PDF, and if so exactly what is printed?
 * Refusals: Xero authority (409 xero_invoice_document), not issued (409
 * invoice_not_issued), or an issuance snapshot that misses anything the
 * official document needs (409 invoice_snapshot_incomplete - never filled
 * from today's data).
 */
export function documentContract(i: Invoice, lines: readonly InvoiceLine[]): { ok: true; input: RenderInput } | Refusal {
  if (!isHubAuthority(i)) return refuse(409, "xero_invoice_document", "This invoice is numbered and issued by Xero - its official document comes from Xero; the Hub does not produce a PDF for it");
  if (!isIssued(i)) return refuse(409, "invoice_not_issued", "Only an issued invoice has an official document");
  const missing: string[] = [];
  if (!i.hubInvoiceNumber || !HUB_INVOICE_NUMBER_PATTERN.test(i.hubInvoiceNumber)) missing.push("official Hub invoice number");
  if (!i.invoiceDate) missing.push("issue date");
  if (!i.dueDate) missing.push("due date");
  if (!i.issuedAt) missing.push("issued at");
  if (!i.issuer?.legalName || !i.issuer?.address) missing.push("issuer legal name / address");
  if (i.vatMinor > 0 && (!i.issuer?.vatRegistered || !i.issuer?.vatNumber)) missing.push("issuer VAT number");
  if (!i.billingEmail) missing.push("billing email");
  if (!i.billingAddress) missing.push("client billing address");
  if (!i.paymentDetails) missing.push("payment details");
  if (!i.branding) missing.push("branding");
  if (lines.length !== i.lineCount || !lines.length) missing.push("invoice lines");
  if (missing.length) {
    return refuse(409, "invoice_snapshot_incomplete", `This invoice was issued without everything the official PDF needs (${missing.join(", ")}). Its frozen record is never back-filled from today's details - nothing was generated`, missing);
  }
  const sorted = [...lines].sort((a, b) => a.sequence - b.sequence);
  const input: RenderInput = {
    documentType: "invoice",
    currency: "GBP",
    officialNumber: i.hubInvoiceNumber as string,
    invoiceDate: i.invoiceDate as string,
    dueDate: i.dueDate as string,
    issuedAt: i.issuedAt as string,
    period: { from: i.periodFrom, to: i.periodTo },
    paymentTermsDays: i.paymentTermsDays,
    poNumber: i.poNumber,
    issuer: {
      legalName: i.issuer.legalName,
      tradingName: (i.branding as InvoiceBranding).tradingName,
      address: i.issuer.address,
      companyNumber: i.issuer.companyNumber,
      vatRegistered: i.issuer.vatRegistered,
      vatNumber: i.issuer.vatNumber,
    },
    branding: { ...(i.branding as InvoiceBranding) },
    billTo: { name: i.clientName, contactName: i.billingContactName, email: i.billingEmail, ccEmails: [...i.billingCcEmails], address: { ...(i.billingAddress as BillingAddress) } },
    lines: sorted.map((l) => ({ sequence: l.sequence, date: l.occurrenceDate, description: l.description, quantity: l.quantity, unitMinor: l.unitAmountMinor, vatTreatment: l.vatTreatment, vatRateBasisPoints: l.vatRateBasisPoints, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor })),
    totals: { netMinor: i.netMinor, vatMinor: i.vatMinor, grossMinor: i.grossMinor },
    payment: { ...(i.paymentDetails as PaymentDetails), reference: i.hubInvoiceNumber as string },
  };
  return { ok: true, input };
}

/** Canonical JSON: object keys sorted at every level (so the snapshot hash never depends on key order). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

// ---------------------------------------------------------------------
// Formatting (display only - nothing is calculated)
// ---------------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-10-03" -> "3 October 2026". */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
/** "2026-10-03" -> "03/10/2026" (table cells). */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}
/** Stored minor amount -> "£1,234.56" (formatMinor + thousands separators; never rounds or recalculates). */
export function gbp(minor: number): string {
  const s = formatMinor(minor);
  const neg = s.startsWith("-");
  const [whole, pence] = (neg ? s.slice(1) : s).split(".");
  return `${neg ? "-" : ""}£${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${pence}`;
}
export function vatRateLabel(treatment: string, bps: number): string {
  if (treatment === "no_vat") return "No VAT";
  return `${formatRatePercent(bps)}%`;
}
/** PDF date string from the frozen issue instant (deterministic - never the clock). */
export function pdfDate(isoInstant: string): string {
  const d = new Date(isoInstant);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hexRgb(hex: string | null, fallback: Rgb): Rgb {
  const m = hex ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : fallback;
}
/** A brand colour too light to read as text on white falls back to the neutral ink. */
function readable(c: Rgb, fallback: Rgb): Rgb {
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return lum > 190 ? fallback : c;
}
const lighten = (c: Rgb, t: number): Rgb => [0, 1, 2].map((k) => Math.round(c[k] + (255 - c[k]) * t)) as Rgb;

export function addressLines(a: BillingAddress): string[] {
  return [a.line1, a.line2, a.townCity, a.county, a.postcode, a.country].filter((x): x is string => !!x && !!x.trim());
}

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------

const INK: Rgb = [17, 24, 39];
const MUTED: Rgb = [90, 98, 112];
const RULE: Rgb = [209, 213, 219];
const NEUTRAL: Rgb = [31, 41, 55];
const M = 48;
const RIGHT = A4.width - M;
const BOTTOM = A4.height - 64;

/** Table columns: [x-left, x-right, align]. Total width = the printable width. */
const COLS = {
  date: [M, M + 52, "left"],
  desc: [M + 52, M + 215, "left"],
  qty: [M + 215, M + 245, "right"],
  unit: [M + 245, M + 299, "right"],
  rate: [M + 299, M + 337, "right"],
  net: [M + 337, M + 391, "right"],
  vat: [M + 391, M + 443, "right"],
  total: [M + 443, RIGHT, "right"],
} as const;
const PAD = 3;

export interface Rendered {
  bytes: Uint8Array;
  pages: number;
  logoEmbedded: boolean;
}

/**
 * Lays the official invoice out from the frozen snapshot. Deterministic: the
 * same input (and logo) always gives the same bytes. Long invoices continue
 * onto further pages with the table header repeated; nothing is clipped.
 */
export function renderInvoicePdf(input: RenderInput, logo: PdfImage | null): Rendered {
  const primary = hexRgb(input.branding.primaryColour, NEUTRAL);
  const accent = hexRgb(input.branding.accentColour, primary);
  const brandInk = readable(primary, NEUTRAL);
  const docTitle = `Invoice ${input.officialNumber}`;
  const pdf = new PdfBuilder({ title: docTitle, author: input.issuer.legalName, subject: docTitle, creationDate: pdfDate(input.issuedAt) });
  const T = (page: number, x: number, y: number, s: string, o: { font?: FontName; size?: number; colour?: Rgb; align?: "left" | "right" | "center" } = {}) => pdf.text(page, x, y, s, o);

  // ---- page 1 header ----
  let page = pdf.addPage();
  pdf.rect(page, 0, 0, A4.width, 6, primary);
  pdf.rect(page, 0, 6, A4.width, 2, accent);
  const brandName = input.issuer.tradingName || input.issuer.legalName;
  let leftY = 40;
  if (logo) {
    const maxW = 170, maxH = 60;
    const s = Math.min(maxW / logo.width, maxH / logo.height);
    const w = logo.width * s, h = logo.height * s;
    pdf.drawImage(page, logo, M, 32, w, h);
    leftY = 32 + h + 14;
  } else {
    const nameLines = wrapText(brandName, "bold", 18, 280).slice(0, 3);
    leftY = 52;
    for (const l of nameLines) {
      T(page, M, leftY, l, { font: "bold", size: 18, colour: brandInk });
      leftY += 21;
    }
    leftY -= 4;
  }
  if (input.branding.tagline) {
    for (const l of wrapText(input.branding.tagline, "regular", 8.5, 280).slice(0, 2)) {
      T(page, M, leftY, l, { size: 8.5, colour: MUTED });
      leftY += 11;
    }
  }
  T(page, RIGHT, 56, "INVOICE", { font: "bold", size: 24, colour: brandInk, align: "right" });
  const meta: [string, string][] = [
    ["Invoice number", input.officialNumber],
    ["Issue date", longDate(input.invoiceDate)],
    ["Due date", longDate(input.dueDate)],
  ];
  let my = 78;
  for (const [k, v] of meta) {
    T(page, RIGHT - 120, my, k, { size: 8.5, colour: MUTED, align: "right" });
    T(page, RIGHT, my, v, { font: "bold", size: 9, align: "right" });
    my += 13;
  }

  // ---- From / Bill to ----
  let y = Math.max(leftY, my) + 18;
  const colW = 230;
  const billX = M + 262;
  T(page, M, y, "FROM", { font: "bold", size: 7.5, colour: MUTED });
  T(page, billX, y, "BILL TO", { font: "bold", size: 7.5, colour: MUTED });
  y += 13;
  const from: { s: string; bold?: boolean }[] = [{ s: input.issuer.legalName, bold: true }];
  if (input.issuer.tradingName && input.issuer.tradingName !== input.issuer.legalName) from.push({ s: `Trading as ${input.issuer.tradingName}` });
  for (const l of input.issuer.address.split(/\r?\n/)) if (l.trim()) from.push({ s: l.trim() });
  if (input.issuer.companyNumber) from.push({ s: `Company number ${input.issuer.companyNumber}` });
  if (input.issuer.vatRegistered && input.issuer.vatNumber) from.push({ s: `VAT number ${input.issuer.vatNumber}` });
  if (input.branding.supportEmail) from.push({ s: input.branding.supportEmail });
  if (input.branding.website) from.push({ s: input.branding.website });
  const to: { s: string; bold?: boolean }[] = [{ s: input.billTo.name, bold: true }];
  if (input.billTo.contactName) to.push({ s: `For the attention of ${input.billTo.contactName}` });
  for (const l of addressLines(input.billTo.address)) to.push({ s: l });
  to.push({ s: input.billTo.email });
  const block = (x: number, items: { s: string; bold?: boolean }[], yy: number) => {
    for (const it of items) {
      for (const l of wrapText(it.s, it.bold ? "bold" : "regular", 9, colW)) {
        T(page, x, yy, l, { font: it.bold ? "bold" : "regular", size: 9 });
        yy += 12;
      }
    }
    return yy;
  };
  y = Math.max(block(M, from, y), block(billX, to, y)) + 10;

  // ---- invoice details row ----
  const details: [string, string][] = [
    ["Service period", `${longDate(input.period.from)} - ${longDate(input.period.to)}`],
    ["Payment terms", `${input.paymentTermsDays} days`],
    ["Purchase order", input.poNumber ?? "-"],
  ];
  const dw = (RIGHT - M) / 3;
  const wrapped = details.map(([, v]) => wrapText(v, "bold", 8.5, dw - 14));
  const dh = 20 + Math.max(...wrapped.map((w) => w.length)) * 11;
  pdf.rect(page, M, y, RIGHT - M, dh, lighten(primary, 0.92));
  details.forEach(([k], i) => {
    T(page, M + 8 + i * dw, y + 12, k, { size: 7.5, colour: MUTED });
    wrapped[i].forEach((line, j) => T(page, M + 8 + i * dw, y + 24 + j * 11, line, { font: "bold", size: 8.5 }));
  });
  y += dh + 14;

  // ---- lines table ----
  const header = (p: number, yy: number) => {
    pdf.rect(p, M, yy, RIGHT - M, 18, primary);
    const hc = readable(primary, NEUTRAL) === primary ? ([255, 255, 255] as Rgb) : INK;
    const label: Record<keyof typeof COLS, string> = { date: "Date", desc: "Description", qty: "Qty", unit: "Unit price", rate: "VAT rate", net: "Net", vat: "VAT", total: "Total" };
    for (const k of Object.keys(COLS) as (keyof typeof COLS)[]) {
      const [x0, x1, al] = COLS[k];
      T(p, al === "right" ? x1 - PAD : x0 + PAD, yy + 12, label[k], { font: "bold", size: 7.5, colour: hc, align: al });
    }
    return yy + 18;
  };
  const continuation = (): number => {
    page = pdf.addPage();
    pdf.rect(page, 0, 0, A4.width, 4, primary);
    T(page, M, 34, `Invoice ${input.officialNumber} (continued)`, { font: "bold", size: 10, colour: brandInk });
    T(page, RIGHT, 34, brandName, { size: 8.5, colour: MUTED, align: "right" });
    return 48;
  };
  y = header(page, y);
  const LH = 10.5;
  let anyIncluded = false;
  for (const l of input.lines) {
    const desc = wrapText(l.description, "regular", 8, COLS.desc[1] - COLS.desc[0] - 2 * PAD);
    const h = Math.max(1, desc.length) * LH + 7;
    if (y + h > BOTTOM) {
      const top = continuation();
      y = header(page, top);
    }
    const base = y + 11;
    const cell = (k: keyof typeof COLS, s: string) => {
      const [x0, x1, al] = COLS[k];
      T(page, al === "right" ? x1 - PAD : x0 + PAD, base, s, { size: 8, align: al });
    };
    cell("date", shortDate(l.date));
    desc.forEach((d, i) => T(page, COLS.desc[0] + PAD, base + i * LH, d, { size: 8 }));
    cell("qty", String(l.quantity));
    const included = l.vatTreatment === "vat_included";
    anyIncluded ||= included;
    cell("unit", `${gbp(l.unitMinor)}${included ? "*" : ""}`);
    cell("rate", vatRateLabel(l.vatTreatment, l.vatRateBasisPoints));
    cell("net", gbp(l.netMinor));
    cell("vat", gbp(l.vatMinor));
    cell("total", gbp(l.grossMinor));
    y += h;
    pdf.line(page, M, y, RIGHT, y, RULE, 0.4);
  }
  if (anyIncluded) {
    if (y + 14 > BOTTOM) y = continuation();
    T(page, M, y + 11, "* Unit price includes VAT.", { size: 7.5, colour: MUTED });
    y += 14;
  }

  // ---- totals (the stored totals, verbatim) ----
  if (y + 74 > BOTTOM) y = continuation();
  y += 12;
  const tx = RIGHT - 200;
  const totalsRows: [string, string, boolean][] = [
    ["Net", gbp(input.totals.netMinor), false],
    ["VAT", gbp(input.totals.vatMinor), false],
  ];
  for (const [k, v] of totalsRows) {
    T(page, tx + 8, y + 10, k, { size: 9, colour: MUTED });
    T(page, RIGHT - 8, y + 10, v, { size: 9, align: "right" });
    y += 16;
  }
  pdf.rect(page, tx, y, 200, 24, primary);
  const tc = readable(primary, NEUTRAL) === primary ? ([255, 255, 255] as Rgb) : INK;
  T(page, tx + 8, y + 16, "Total due (GBP)", { font: "bold", size: 10, colour: tc });
  T(page, RIGHT - 8, y + 16, gbp(input.totals.grossMinor), { font: "bold", size: 11, colour: tc, align: "right" });
  y += 38;

  // ---- payment details (frozen at issue; reference = the official number) ----
  const pay: [string, string][] = [["Account name", input.payment.accountName]];
  if (input.payment.sortCode) pay.push(["Sort code", input.payment.sortCode]);
  if (input.payment.accountNumber) pay.push(["Account number", input.payment.accountNumber]);
  if (input.payment.iban) pay.push(["IBAN", input.payment.iban]);
  if (input.payment.bic) pay.push(["BIC", input.payment.bic]);
  pay.push(["Payment reference", input.payment.reference]);
  const instr = input.payment.instructions ? input.payment.instructions.split(/\r?\n/).flatMap((p) => wrapText(p, "regular", 8.5, RIGHT - M - 20)) : [];
  const payH = 26 + pay.length * 13 + (instr.length ? 6 + instr.length * 11 : 0) + 8;
  if (y + payH > BOTTOM) y = continuation() + 6;
  pdf.rect(page, M, y, RIGHT - M, payH, lighten(accent, 0.9));
  pdf.rect(page, M, y, 3, payH, accent);
  T(page, M + 12, y + 16, "How to pay", { font: "bold", size: 10, colour: brandInk });
  T(page, RIGHT - 10, y + 16, `Please pay by ${longDate(input.dueDate)}`, { size: 8.5, colour: MUTED, align: "right" });
  let py = y + 32;
  for (const [k, v] of pay) {
    T(page, M + 12, py, k, { size: 8.5, colour: MUTED });
    T(page, M + 120, py, v, { font: "bold", size: 9 });
    py += 13;
  }
  if (instr.length) {
    py += 4;
    for (const l of instr) {
      T(page, M + 12, py, l, { size: 8.5 });
      py += 11;
    }
  }

  // ---- footer on every page: legal identity + page x of y ----
  const legal = [input.issuer.legalName, input.issuer.companyNumber ? `Company number ${input.issuer.companyNumber}` : null, input.issuer.vatRegistered && input.issuer.vatNumber ? `VAT number ${input.issuer.vatNumber}` : null].filter(Boolean).join("  |  ");
  const n = pdf.pageCount;
  for (let p = 0; p < n; p++) {
    pdf.line(p, M, A4.height - 40, RIGHT, A4.height - 40, RULE, 0.5);
    wrapText(legal, "regular", 7, RIGHT - M - 70).forEach((lf, j) => T(p, M, A4.height - 28 + j * 9, lf, { size: 7, colour: MUTED }));
    T(p, RIGHT, A4.height - 28, `Page ${p + 1} of ${n}`, { size: 7, colour: MUTED, align: "right" });
  }
  return { bytes: pdf.build(), pages: n, logoEmbedded: !!logo };
}

// ---------------------------------------------------------------------
// Stored document + send history (rows from Supabase)
// ---------------------------------------------------------------------

export type DocStatus = "generating" | "ready" | "failed";
export type LogoStatus = "embedded" | "none" | "unavailable";
export interface InvoiceDocument {
  organisationId: string;
  documentId: string;
  invoiceId: string;
  officialNumber: string;
  status: DocStatus;
  snapshotSha256: string;
  rendererVersion: string;
  storageBucket: string;
  storagePath: string;
  sha256: string | null;
  byteSize: number | null;
  logoStatus: LogoStatus | null;
  attempts: number;
  lastErrorCode: string | null;
  reservedAt: string;
  reservedBy: string;
  generatedAt: string | null;
  generatedBy: string | null;
}
export interface SendEvent {
  sendId: string;
  invoiceId: string;
  officialNumber: string;
  documentId: string;
  documentSha256: string;
  sentOn: string;
  sentTo: string[];
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** The F22 generation status of an invoice: pending (not generated yet), generating, ready, failed; not_available when the contract refuses. */
export type PdfGenerationStatus = "pending" | "generating" | "ready" | "failed" | "not_available";
export function generationStatusOf(doc: InvoiceDocument | null, contract: { ok: boolean }): PdfGenerationStatus {
  if (doc) return doc.status;
  return contract.ok ? "pending" : "not_available";
}

export function publicDocument(d: InvoiceDocument) {
  return {
    documentId: d.documentId,
    documentType: "invoice",
    officialNumber: d.officialNumber,
    status: d.status,
    fileName: fileNameOf(d.officialNumber),
    contentType: "application/pdf",
    sha256: d.sha256,
    byteSize: d.byteSize,
    logo: d.logoStatus,
    rendererVersion: d.rendererVersion,
    attempts: d.attempts,
    lastErrorCode: d.lastErrorCode,
    generatedAt: d.generatedAt,
    generatedBy: d.generatedBy,
    immutable: d.status === "ready",
  };
}
export function publicSend(s: SendEvent) {
  return { sendId: s.sendId, officialNumber: s.officialNumber, documentSha256: s.documentSha256, sentOn: s.sentOn, sentTo: [...s.sentTo], note: s.note, recordedBy: s.recordedBy, recordedAt: s.recordedAt };
}

/** Delivery state (manual history) - never payment state. */
export function sentSummary(sends: readonly SendEvent[]) {
  const sorted = [...sends].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.sendId.localeCompare(b.sendId));
  const last = sorted[sorted.length - 1] ?? null;
  return { sent: sorted.length > 0, timesSent: sorted.length, lastSentOn: last?.sentOn ?? null, lastSentTo: last ? [...last.sentTo] : [], history: sorted.map(publicSend), note: "Sent is delivery history recorded by Management - it never marks the invoice paid (payments are recorded separately)" };
}

/** What this caller may do now (honest per access level - View never sees a write action as available). */
export function documentActions(access: "view" | "manage", contractOk: boolean, doc: InvoiceDocument | null) {
  const ready = doc?.status === "ready";
  return {
    download: ready,
    generate: access === "manage" && contractOk && !ready,
    markSent: access === "manage" && ready,
  };
}

// ---------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------

export type DocRoute =
  | { name: "invoice.pdf"; params: { invoiceId: string } }
  | { name: "invoice.pdf_generate"; params: { invoiceId: string } }
  | { name: "invoice.document"; params: { invoiceId: string } }
  | { name: "invoice.sent"; params: { invoiceId: string } };
export type DocMatch = { status: "match"; route: DocRoute } | { status: "method"; allowed: string[] } | null;

/** F22 owns only invoices/{FIV}/pdf, invoices/{FIV}/document and invoices/{FIV}/sent; everything else returns null. */
export function matchDocumentRoute(path: string, method: string): DocMatch {
  const seg = path.split("/");
  if (seg.length !== 3 || seg[0] !== "invoices" || !INVOICE_ID_PATTERN.test(seg[1] ?? "")) return null;
  const params = { invoiceId: seg[1] };
  if (seg[2] === "pdf") return method === "GET" ? { status: "match", route: { name: "invoice.pdf", params } } : method === "POST" ? { status: "match", route: { name: "invoice.pdf_generate", params } } : { status: "method", allowed: ["GET", "POST"] };
  if (seg[2] === "document") return method === "GET" ? { status: "match", route: { name: "invoice.document", params } } : { status: "method", allowed: ["GET"] };
  if (seg[2] === "sent") return method === "POST" ? { status: "match", route: { name: "invoice.sent", params } } : { status: "method", allowed: ["POST"] };
  return null;
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** No query parameter is accepted on any F22 route (a tenant key is refused outright). */
export function checkDocumentQuery(q: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true } | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  if (keys.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(keys)].join(", ")}`);
  return { ok: true };
}

function objectBody(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean, why: string): { ok: true; body: Record<string, unknown> } | Invalid {
  if (!raw.trim()) return { ok: true, body: {} };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON (or empty)");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object (or empty)");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const extra = keys.filter((k) => !allowed.includes(k));
  if (extra.length) return invalid("unexpected_field", `Unexpected field(s): ${extra.join(", ")} - ${why}`);
  return { ok: true, body: body as Record<string, unknown> };
}

/** POST invoices/{id}/pdf: empty, {} or { reason }. Nothing about the document's content can be supplied - it is the frozen invoice. */
export function parseGenerateBody(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string | null } | Invalid {
  const b = objectBody(raw, ["reason"], isTenantKey, "the PDF is rendered only from the invoice as issued");
  if (!b.ok) return b;
  const r = b.body.reason;
  if (r === undefined || r === null) return { ok: true, reason: null };
  if (typeof r !== "string") return invalid("invalid_input", "reason must be text", { reason: "must be text" });
  const t = r.trim();
  if (t.length > NOTE_MAX) return invalid("invalid_input", `reason must be at most ${NOTE_MAX} characters`, { reason: `must be at most ${NOTE_MAX} characters` });
  if (CONTROL_RE.test(t)) return invalid("invalid_input", "reason contains control characters", { reason: "contains control characters" });
  return { ok: true, reason: t || null };
}

export interface SentRequest {
  sentOn: string | null;
  sentTo: string[] | null;
  note: string | null;
}
/** POST invoices/{id}/sent: { sentOn?: YYYY-MM-DD, sentTo?: [emails] (default: the frozen billing + CC emails), note? }. */
export function parseSentBody(raw: string, isTenantKey: (k: string) => boolean): { ok: true; req: SentRequest } | Invalid {
  const b = objectBody(raw, ["sentOn", "sentTo", "note"], isTenantKey, "allowed: sentOn, sentTo, note");
  if (!b.ok) return b;
  const o = b.body;
  let sentOn: string | null = null;
  if (o.sentOn !== undefined && o.sentOn !== null) {
    if (typeof o.sentOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.sentOn) || Number.isNaN(Date.parse(`${o.sentOn}T00:00:00Z`)) || new Date(`${o.sentOn}T00:00:00Z`).toISOString().slice(0, 10) !== o.sentOn) {
      return invalid("invalid_input", "sentOn must be a date YYYY-MM-DD", { sentOn: "must be a date YYYY-MM-DD" });
    }
    sentOn = o.sentOn;
  }
  let sentTo: string[] | null = null;
  if (o.sentTo !== undefined && o.sentTo !== null) {
    if (!Array.isArray(o.sentTo) || o.sentTo.length < 1 || o.sentTo.length > SENT_TO_MAX) return invalid("invalid_input", `sentTo must be a list of 1-${SENT_TO_MAX} email addresses`, { sentTo: `must be a list of 1-${SENT_TO_MAX} email addresses` });
    const out: string[] = [];
    for (const e of o.sentTo) {
      if (typeof e !== "string" || e.trim().length > 254 || !EMAIL_RE.test(e.trim())) return invalid("invalid_input", "sentTo contains an invalid email address", { sentTo: "contains an invalid email address" });
      const v = e.trim().toLowerCase();
      if (!out.includes(v)) out.push(v);
    }
    sentTo = out;
  }
  let note: string | null = null;
  if (o.note !== undefined && o.note !== null) {
    if (typeof o.note !== "string") return invalid("invalid_input", "note must be text", { note: "must be text" });
    const t = o.note.trim();
    if (t.length > NOTE_MAX) return invalid("invalid_input", `note must be at most ${NOTE_MAX} characters`, { note: `must be at most ${NOTE_MAX} characters` });
    if (CONTROL_RE.test(t)) return invalid("invalid_input", "note contains control characters", { note: "contains control characters" });
    note = t || null;
  }
  return { ok: true, req: { sentOn, sentTo, note } };
}

/** Default recipients: the billing email + CCs FROZEN on the invoice at issue (never today's client record). */
export function defaultRecipients(i: Pick<Invoice, "billingEmail" | "billingCcEmails">): string[] {
  const out: string[] = [];
  for (const e of [i.billingEmail, ...i.billingCcEmails]) {
    const v = (e ?? "").trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, SENT_TO_MAX);
}

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

export function documentAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: DOCUMENT_CONTRACT } };
}
export const auditDocument = (d: Pick<InvoiceDocument, "documentId" | "invoiceId" | "officialNumber" | "status" | "snapshotSha256" | "rendererVersion" | "sha256" | "byteSize" | "logoStatus" | "attempts" | "lastErrorCode">) => ({
  documentId: d.documentId,
  invoiceId: d.invoiceId,
  officialNumber: d.officialNumber,
  status: d.status,
  snapshotSha256: d.snapshotSha256,
  rendererVersion: d.rendererVersion,
  sha256: d.sha256,
  byteSize: d.byteSize,
  logoStatus: d.logoStatus,
  attempts: d.attempts,
  lastErrorCode: d.lastErrorCode,
});
