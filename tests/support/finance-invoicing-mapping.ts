/**
 * Test-suite copy of the canonical finance/finance-invoicing-mapping.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance client invoice drafts - storage mapping, PURE (Finance Foundation
 * F5; see TEST-ENV.md "Finance Foundation - F5"). Translates the
 * transitional TEST Airtable rows of "Finance Invoice Drafts" and "Finance
 * Invoice Draft Lines" to/from the domain in finance-invoicing.ts. The rest
 * of the Finance code never sees an Airtable field name.
 *
 *   - A draft row is created once and then patched (header, totals,
 *     revision, state). It is never deleted (except as the compensating undo
 *     of a row created by the same request).
 *   - A line row is created once with its snapshot; afterwards ONLY its
 *     status fields change (Included <-> Excluded, or closed as Removed /
 *     Superseded). Its figures are never edited.
 *   - F6: "Issued Invoice ID" is set once when the draft is issued; a
 *     replacement draft carries "Replaces Invoice ID", "Correction ID" and
 *     its "Correction Scope" (JSON) from creation - all three or none.
 *
 * Every row is validated on read; a row that does not validate makes the
 * draft data INVALID (409) - never skipped or guessed (same rule as F3/F4).
 */
import { type Minor, type VatTreatment, isRateBasisPoints, isVatTreatment } from "./finance-money.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { type ChargeType, CHARGE_TYPES, ID_PATTERNS, MAX_BILLABLE_QUANTITY, MAX_UNIT_AMOUNT_MINOR, REASON_MAX } from "./finance-commercial.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { OCCURRENCE_ID_PATTERN } from "./finance-billing.ts";
import {
  type Draft,
  type DraftStatus,
  type CorrectionScope,
  type Line,
  type LineStatus,
  type QuantitySource,
  type TermsException,
  type TermsSource,
  type UnitAmountSource,
  CLIENT_ID_PATTERN,
  CORRECTION_ID_PATTERN,
  DRAFT_ID_PATTERN,
  INVOICE_ID_PATTERN,
  LINE_ID_PATTERN,
  PO_NUMBER_MAX,
} from "./finance-invoicing.ts";

export const INVOICING_TABLES = { drafts: "Finance Invoice Drafts", lines: "Finance Invoice Draft Lines" } as const;

export const FI = {
  org: "Organisation",
  draft: {
    id: "Draft ID",
    clientId: "Client ID",
    clientName: "Client Name",
    status: "Status",
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
    included: "Included Lines",
    revision: "Revision",
    createdBy: "Created By User ID",
    createdAt: "Created At",
    readyBy: "Ready By User ID",
    readyAt: "Ready At",
    changedBy: "Last Changed By User ID",
    changedAt: "Last Changed At",
    termsExceptions: "Missing Terms Exceptions",
    issuedInvoiceId: "Issued Invoice ID",
    replacesInvoiceId: "Replaces Invoice ID",
    correctionId: "Correction ID",
    correctionScope: "Correction Scope",
  },
  line: {
    id: "Line ID",
    draftId: "Draft ID",
    status: "Status",
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
    statusReason: "Status Reason",
    statusBy: "Status Changed By User ID",
    statusAt: "Status Changed At",
    supersededBy: "Superseded By",
    createdBy: "Created By User ID",
    createdAt: "Created At",
  },
} as const;

const DRAFT_STATUS: Record<DraftStatus, string> = { draft: "Draft", ready_for_issue: "Ready for issue" };
const LINE_STATUS: Record<LineStatus, string> = { included: "Included", excluded: "Excluded", removed: "Removed", superseded: "Superseded" };
const TERMS_SOURCE: Record<TermsSource, string> = { client: "Client", finance_settings: "Finance Settings", invoice_override: "Invoice override" };
const QTY_SOURCES: readonly QuantitySource[] = ["default_commercial_quantity", "occurrence_override", "per_session"];
const UNIT_SOURCES: readonly UnitAmountSource[] = ["commercial_terms", "occurrence_override"];
const MAX_LINE_MINOR = MAX_UNIT_AMOUNT_MINOR * MAX_BILLABLE_QUANTITY;

function reverse<T extends string>(map: Record<T, string>, label: unknown): T | undefined {
  const name = label && typeof label === "object" && typeof (label as any).name === "string" ? (label as any).name : label;
  return (Object.keys(map) as T[]).find((k) => map[k] === name);
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const intOrNull = (v: unknown, min: number, max: number): number | null | undefined => (v === undefined || v === null ? null : int(v, min, max));
/** A money cell: whole pence, never negative, within the F3 bounds. */
const minor = (v: unknown): Minor | undefined => (v === undefined || v === null ? undefined : int(v, 0, MAX_LINE_MINOR));

type Parsed<T> = { ok: true; recordId: string; value: T } | { ok: false; problem: string };

/**
 * The draft's approved missing-terms exceptions: blank = none; otherwise a
 * JSON array of { occurrenceId, occurrenceDate, serviceId, reason,
 * approvedBy, approvedAt }, one per occurrence. Anything else is invalid
 * data (never guessed).
 */
function termsExceptionsOf(v: unknown): TermsException[] | undefined {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return [];
  if (typeof v !== "string") return undefined;
  let a: unknown;
  try {
    a = JSON.parse(v);
  } catch {
    return undefined;
  }
  if (!Array.isArray(a)) return undefined;
  const out: TermsException[] = [];
  for (const e of a) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return undefined;
    const keys = Object.keys(e).sort().join(",");
    if (keys !== "approvedAt,approvedBy,occurrenceDate,occurrenceId,reason,serviceId") return undefined;
    const { occurrenceId, occurrenceDate, serviceId, reason, approvedBy, approvedAt } = e as Record<string, unknown>;
    if (typeof occurrenceId !== "string" || !OCCURRENCE_ID_PATTERN.test(occurrenceId)) return undefined;
    if (!isIsoDate(occurrenceDate)) return undefined;
    if (serviceId !== null && (typeof serviceId !== "string" || !ID_PATTERNS.service.test(serviceId))) return undefined;
    if (typeof reason !== "string" || !reason.trim() || reason.length > REASON_MAX) return undefined;
    if (typeof approvedBy !== "string" || !approvedBy.trim() || typeof approvedAt !== "string" || !approvedAt.trim()) return undefined;
    if (out.some((x) => x.occurrenceId === occurrenceId)) return undefined;
    out.push({ occurrenceId, occurrenceDate: occurrenceDate as string, serviceId: serviceId as string | null, reason, approvedBy, approvedAt });
  }
  return out;
}

/** A replacement draft's scope: JSON { correctionId, invoiceId, occurrenceIds, releasedDraftIds }; blank = none; anything else invalid. */
function correctionScopeOf(v: unknown): CorrectionScope | null | undefined {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string") return undefined;
  let o: any;
  try {
    o = JSON.parse(v);
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join(",") !== "correctionId,invoiceId,occurrenceIds,releasedDraftIds") return undefined;
  if (typeof o.correctionId !== "string" || !CORRECTION_ID_PATTERN.test(o.correctionId) || typeof o.invoiceId !== "string" || !INVOICE_ID_PATTERN.test(o.invoiceId)) return undefined;
  const list = (a: unknown, re: RegExp) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === "string" && re.test(x)) && new Set(a).size === a.length;
  if (!list(o.occurrenceIds, OCCURRENCE_ID_PATTERN) || !list(o.releasedDraftIds, DRAFT_ID_PATTERN)) return undefined;
  return { correctionId: o.correctionId, invoiceId: o.invoiceId, occurrenceIds: [...o.occurrenceIds], releasedDraftIds: [...o.releasedDraftIds] };
}

export function draftFromRow(r: Row): Parsed<Draft> {
  const f = r.fields ?? {};
  const x = FI.draft;
  const id = str(f[x.id]);
  if (!id || !DRAFT_ID_PATTERN.test(id)) return { ok: false, problem: `draft row ${r.id}: bad Draft ID` };
  const bad = (why: string): Parsed<Draft> => ({ ok: false, problem: `draft ${id}: ${why}` });
  if (links(f[FI.org]).length !== 1) return bad("must link exactly one organisation");
  const clientId = str(f[x.clientId]);
  const clientName = str(f[x.clientName]);
  if (!clientId || !CLIENT_ID_PATTERN.test(clientId) || !clientName) return bad("invalid client");
  const status = reverse(DRAFT_STATUS, f[x.status]);
  if (!status) return bad("invalid Status");
  const from = f[x.from];
  const to = f[x.to];
  if (!isIsoDate(from) || !isIsoDate(to) || (to as string) < (from as string)) return bad("invalid billing period");
  const termsDays = intOrNull(f[x.termsDays], 0, 365);
  const termsLabel = f[x.termsSource];
  const termsSource = termsLabel === undefined || termsLabel === null ? null : reverse(TERMS_SOURCE, termsLabel);
  if (termsDays === undefined || termsSource === undefined || (termsDays === null) !== (termsSource === null)) return bad("invalid payment terms");
  const po = f[x.poRequired];
  if (po !== undefined && po !== null && typeof po !== "boolean") return bad("invalid PO Required");
  const poNumber = str(f[x.poNumber]);
  const poOverride = str(f[x.poOverride]);
  if ((poNumber && poNumber.length > PO_NUMBER_MAX) || (poOverride && poOverride.length > REASON_MAX)) return bad("invalid PO details");
  const net = f[x.net] ?? 0;
  const vat = f[x.vat] ?? 0;
  const gross = f[x.gross] ?? 0;
  const included = f[x.included] ?? 0;
  if (minor(net) === undefined || minor(vat) === undefined || minor(gross) === undefined || int(included, 0, 100_000) === undefined) return bad("invalid totals");
  const revision = int(f[x.revision], 1, Number.MAX_SAFE_INTEGER);
  if (revision === undefined) return bad("invalid Revision");
  const termsExceptions = termsExceptionsOf(f[x.termsExceptions]);
  if (termsExceptions === undefined) return bad("invalid Missing Terms Exceptions");
  const issuedInvoiceId = str(f[x.issuedInvoiceId]);
  if (issuedInvoiceId !== null && (!INVOICE_ID_PATTERN.test(issuedInvoiceId) || status !== "ready_for_issue")) return bad("invalid Issued Invoice ID (an issued draft stays Ready for issue)");
  const replacesInvoiceId = str(f[x.replacesInvoiceId]);
  const correctionId = str(f[x.correctionId]);
  const correctionScope = correctionScopeOf(f[x.correctionScope]);
  if (correctionScope === undefined) return bad("invalid Correction Scope");
  const replacement = [replacesInvoiceId, correctionId, correctionScope].filter((v) => v !== null).length;
  if (replacement !== 0 && (replacement !== 3 || correctionScope?.invoiceId !== replacesInvoiceId || correctionScope?.correctionId !== correctionId)) return bad("replacement references must be all set and consistent, or all blank");
  return {
    ok: true,
    recordId: r.id,
    value: {
      draftId: id,
      clientId,
      clientName,
      status,
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
      includedLines: included,
      revision,
      createdBy: str(f[x.createdBy]),
      createdAt: str(f[x.createdAt]),
      readyBy: str(f[x.readyBy]),
      readyAt: str(f[x.readyAt]),
      updatedBy: str(f[x.changedBy]),
      updatedAt: str(f[x.changedAt]),
      termsExceptions,
      issuedInvoiceId,
      replacesInvoiceId,
      correctionId,
      correctionScope,
    },
  };
}

export function lineFromRow(r: Row): Parsed<Line> {
  const f = r.fields ?? {};
  const x = FI.line;
  const id = str(f[x.id]);
  if (!id || !LINE_ID_PATTERN.test(id)) return { ok: false, problem: `line row ${r.id}: bad Line ID` };
  const bad = (why: string): Parsed<Line> => ({ ok: false, problem: `line ${id}: ${why}` });
  if (links(f[FI.org]).length !== 1) return bad("must link exactly one organisation");
  const draftId = str(f[x.draftId]);
  if (!draftId || !DRAFT_ID_PATTERN.test(draftId)) return bad("invalid Draft ID");
  const status = reverse(LINE_STATUS, f[x.status]);
  if (!status) return bad("invalid Status");
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
  const amount = minor(f[x.amount] ?? 0);
  const net = minor(f[x.net] ?? 0);
  const vat = minor(f[x.vat] ?? 0);
  const gross = minor(f[x.gross] ?? 0);
  if (amount === undefined || net === undefined || vat === undefined || gross === undefined || amount !== unit * quantity) return bad("invalid amounts");
  const overrideIds = (str(f[x.overrideIds]) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (overrideIds.some((o) => !ID_PATTERNS.override.test(o))) return bad("invalid Override IDs");
  const snapshot = str(f[x.snapshot]);
  if (!snapshot) return bad("missing Source Snapshot");
  const supersededBy = str(f[x.supersededBy]);
  if (supersededBy !== null && !LINE_ID_PATTERN.test(supersededBy)) return bad("invalid Superseded By");
  if ((status === "superseded") !== (supersededBy !== null)) return bad("Superseded By must be set exactly when superseded");
  return {
    ok: true,
    recordId: r.id,
    value: {
      lineId: id,
      draftId,
      status,
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
      statusReason: str(f[x.statusReason]),
      statusChangedBy: str(f[x.statusBy]),
      statusChangedAt: str(f[x.statusAt]),
      supersededBy,
      createdBy: str(f[x.createdBy]),
      createdAt: str(f[x.createdAt]),
    },
  };
}

export type StoredDraft = { recordId: string; value: Draft };
export type StoredLine = { recordId: string; value: Line };

/** Validates every row of the caller's organisation (enforced by the repository, re-checked here). Duplicate public ids are invalid. */
export function buildDrafts(rows: Row[], organisationRecordId: string): { ok: true; drafts: StoredDraft[] } | { ok: false; error: string } {
  const r = buildAll(rows, organisationRecordId, draftFromRow, (d) => d.draftId, "invoice drafts");
  return r.ok ? { ok: true, drafts: r.items } : r;
}
export function buildLines(rows: Row[], organisationRecordId: string): { ok: true; lines: StoredLine[] } | { ok: false; error: string } {
  const r = buildAll(rows, organisationRecordId, lineFromRow, (l) => l.lineId, "invoice draft lines");
  return r.ok ? { ok: true, lines: r.items } : r;
}

function buildAll<T>(rows: Row[], orgRec: string, parse: (r: Row) => Parsed<T>, idOf: (t: T) => string, what: string): { ok: true; items: { recordId: string; value: T }[] } | { ok: false; error: string } {
  const problems: string[] = [];
  const out: { recordId: string; value: T }[] = [];
  for (const r of rows) {
    const org = links(r.fields?.[FI.org]);
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

// ----- domain -> Airtable fields -----

export function draftFields(d: Draft, meta: { userId: string; at: string }, orgRecordId?: string): Record<string, unknown> {
  const x = FI.draft;
  return {
    ...(orgRecordId
      ? {
          [FI.org]: [orgRecordId],
          [x.id]: d.draftId,
          [x.clientId]: d.clientId,
          [x.from]: d.periodFrom,
          [x.to]: d.periodTo,
          [x.createdBy]: d.createdBy,
          [x.createdAt]: d.createdAt,
          [x.replacesInvoiceId]: d.replacesInvoiceId,
          [x.correctionId]: d.correctionId,
          [x.correctionScope]: d.correctionScope ? JSON.stringify(d.correctionScope) : null,
        }
      : {}),
    [x.clientName]: d.clientName,
    [x.status]: DRAFT_STATUS[d.status],
    [x.termsDays]: d.paymentTermsDays,
    [x.termsSource]: d.paymentTermsSource ? TERMS_SOURCE[d.paymentTermsSource] : null,
    [x.poRequired]: d.poRequired,
    [x.poNumber]: d.poNumber,
    [x.poOverride]: d.poOverrideReason,
    [x.net]: d.netMinor,
    [x.vat]: d.vatMinor,
    [x.gross]: d.grossMinor,
    [x.included]: d.includedLines,
    [x.revision]: d.revision,
    [x.readyBy]: d.readyBy,
    [x.readyAt]: d.readyAt,
    [x.changedBy]: meta.userId,
    [x.changedAt]: meta.at,
    [x.termsExceptions]: d.termsExceptions.length ? JSON.stringify(d.termsExceptions) : null,
    [x.issuedInvoiceId]: d.issuedInvoiceId,
  };
}

/** Exactly the fields needed to put a draft row back to `d` (compensation). */
export function draftRestoreFields(d: Draft): Record<string, unknown> {
  return draftFields(d, { userId: d.updatedBy as string, at: d.updatedAt as string });
}

export function lineCreateFields(l: Line, orgRecordId: string): Record<string, unknown> {
  const x = FI.line;
  return {
    [FI.org]: [orgRecordId],
    [x.id]: l.lineId,
    [x.draftId]: l.draftId,
    [x.status]: LINE_STATUS[l.status],
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

/** The ONLY edit ever made to an existing line: its status fields. The undo writes the previous status fields back. */
export function lineStatusFields(l: Pick<Line, "status" | "statusReason" | "statusChangedBy" | "statusChangedAt" | "supersededBy">): Record<string, unknown> {
  const x = FI.line;
  return { [x.status]: LINE_STATUS[l.status], [x.statusReason]: l.statusReason, [x.statusBy]: l.statusChangedBy, [x.statusAt]: l.statusChangedAt, [x.supersededBy]: l.supersededBy };
}
