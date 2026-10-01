/**
 * Suppliers / agreements / instalments - storage (Finance Foundation F13; see
 * TEST-ENV.md "Finance Foundation - F13").
 *
 * Airtable is READ ONLY here (Schedule owns sessions, occurrences and venues):
 * Sessions by Session ID or Finance Service ID, their occurrences by record id
 * (40 per request), and Venues by record id.
 *
 * Supabase (service role, PostgREST; RLS on, no client grants):
 *   finance_suppliers               one row per supplier (revisioned; never deleted)
 *   finance_supplier_agreements     append-only; a change is a NEW version row
 *   finance_supplier_allocations    append-only frozen direct-cost split per occurrence
 *   finance_supplier_instalments    the cash schedule (narrow guarded updates only)
 *   finance_supplier_payments       append-only Management-confirmed payments
 * Every write is ONE database function call (finance_supplier_write /
 * finance_supplier_agreement_record / finance_supplier_instalment_change) that
 * writes its finance_audit_events rows in the same transaction.
 */
import type { AirtableConfig, GrantStoreConfig } from "./repository.ts";
import { RECORD_ID_RE, airtableFetch, expectOk, tableUrl } from "./finance-commercial-repository.ts";
import {
  type Agreement,
  type Allocation,
  type Instalment,
  type OccurrenceRow,
  type Payment,
  type SessionRow,
  type Supplier,
  SERVICE_ID_RE,
  SESSION_ID_RE,
} from "./finance-suppliers.ts";

export const TABLE = {
  suppliers: "finance_suppliers",
  agreements: "finance_supplier_agreements",
  allocations: "finance_supplier_allocations",
  instalments: "finance_supplier_instalments",
  payments: "finance_supplier_payments",
} as const;
export const RPC = { supplier: "finance_supplier_write", agreement: "finance_supplier_agreement_record", change: "finance_supplier_instalment_change" } as const;
export const ID_READ_CHUNK = 40;

// ---------------------------------------------------------------------
// Airtable (read only)
// ---------------------------------------------------------------------
type Row = { id: string; fields: Record<string, any> };
const SESSION_FIELDS = ["Session ID", "Session Name", "Programme", "Finance Service ID"];
const OCCURRENCE_FIELDS = ["Occurrence ID", "Date", "Status", "Session"];

async function list(config: AirtableConfig, table: string, formula: string, fields: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, table));
    url.searchParams.set("filterByFormula", formula);
    for (const f of fields) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${table}`);
    for (const r of data.records || []) rows.push({ id: r.id, fields: r.fields || {} });
    offset = data.offset || "";
  } while (offset);
  return rows;
}
async function byIds(config: AirtableConfig, table: string, ids: Iterable<string>, fields: readonly string[]): Promise<Row[]> {
  const all = [...new Set(ids)];
  if (all.some((id) => !RECORD_ID_RE.test(id))) throw new Error(`${table} read refused: a record id is malformed`);
  const chunks: string[][] = [];
  for (let i = 0; i < all.length; i += ID_READ_CHUNK) chunks.push(all.slice(i, i + ID_READ_CHUNK));
  const res = await Promise.all(chunks.map((c) => list(config, table, `OR(${c.map((id) => `RECORD_ID()='${id}'`).join(",")})`, fields)));
  return res.flat().filter((r) => all.includes(r.id));
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const sel = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export interface LinkedWork {
  sessions: SessionRow[];
  occurrences: OccurrenceRow[];
  /** Session IDs asked for that matched no session (or matched more than one). */
  unmatchedSessionIds: string[];
}
/** The sessions an agreement names (by stable Session ID or Finance Service ID) and all their occurrences. */
export async function loadLinkedWork(config: AirtableConfig, by: { sessionIds: string[] } | { financeServiceId: string }): Promise<LinkedWork> {
  let formula: string;
  if ("financeServiceId" in by) {
    if (!SERVICE_ID_RE.test(by.financeServiceId)) throw new Error("Session read refused: malformed Finance Service ID");
    formula = `{Finance Service ID}='${by.financeServiceId}'`;
  } else {
    if (!by.sessionIds.length || by.sessionIds.some((s) => !SESSION_ID_RE.test(s))) throw new Error("Session read refused: malformed Session ID");
    formula = `OR(${by.sessionIds.map((s) => `{Session ID}='${s}'`).join(",")})`;
  }
  const rows = await list(config, "Sessions", formula, [...SESSION_FIELDS, "Session Occurrences"]);
  let sessionRows = rows;
  const unmatched: string[] = [];
  if ("sessionIds" in by) {
    sessionRows = [];
    for (const id of by.sessionIds) {
      const hits = rows.filter((r) => str(r.fields["Session ID"]) === id);
      if (hits.length === 1) sessionRows.push(hits[0]);
      else unmatched.push(id);
    }
  }
  const sessions: SessionRow[] = sessionRows.map((r) => ({
    recordId: r.id,
    sessionId: str(r.fields["Session ID"]),
    name: str(r.fields["Session Name"]),
    programme: str(r.fields["Programme"]),
    financeServiceId: str(r.fields["Finance Service ID"]),
  }));
  const occIds = sessionRows.flatMap((r) => links(r.fields["Session Occurrences"]));
  const occurrences = occIds.length ? (await byIds(config, "Session Occurrences", occIds, OCCURRENCE_FIELDS)).map(occurrenceRow) : [];
  return { sessions, occurrences, unmatchedSessionIds: unmatched };
}
const occurrenceRow = (r: Row): OccurrenceRow => ({
  recordId: r.id,
  ref: str(r.fields["Occurrence ID"]),
  date: typeof r.fields["Date"] === "string" ? r.fields["Date"] : null,
  status: sel(r.fields["Status"]),
  sessionRecordId: links(r.fields["Session"])[0] ?? null,
});
/** Current schedule status of the given occurrences (for information on the profitability view). */
export async function loadOccurrenceStatuses(config: AirtableConfig, ids: string[]): Promise<Map<string, string | null>> {
  if (!ids.length) return new Map();
  const rows = await byIds(config, "Session Occurrences", ids, OCCURRENCE_FIELDS);
  return new Map(rows.map((r) => [r.id, sel(r.fields["Status"])]));
}
export async function venueExists(config: AirtableConfig, recordId: string): Promise<boolean> {
  return (await byIds(config, "Venues", [recordId], ["Venue Name"])).length === 1;
}

// ---------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------
function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

/** A write the ledger's own rules refused (f13:...): nothing was changed. */
export class SupplierRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function read(svc: GrantStoreConfig, table: string, organisationId: string, order: string, extra = ""): Promise<Record<string, any>[]> {
  const res = await fetch(`${rest(svc, table)}?organisation_id=${eq(organisationId)}${extra}&select=*&order=${order}`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`${table} read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} read returned an unexpected shape`);
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error(`${table} read returned another organisation's row`);
  return rows;
}
const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what}: not an integer`);
  return n;
};
const intOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : int(v, what));
const dateOf = (v: unknown) => String(v).slice(0, 10);
const iso = (v: unknown) => new Date(String(v)).toISOString();

export const supplierFromRow = (r: Record<string, any>): Supplier => ({
  organisationId: r.organisation_id,
  supplierId: r.supplier_id,
  name: r.name,
  supplierType: r.supplier_type,
  active: r.active === true,
  contactName: r.contact_name ?? null,
  contactEmail: r.contact_email ?? null,
  contactPhone: r.contact_phone ?? null,
  vatTreatment: r.vat_treatment ?? null,
  notes: r.notes ?? null,
  venueRecordId: r.venue_record_id ?? null,
  revision: int(r.revision, "revision"),
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
  updatedAt: iso(r.updated_at),
  updatedBy: r.updated_by,
});
export const supplierRow = (s: Supplier) => ({
  organisation_id: s.organisationId,
  supplier_id: s.supplierId,
  name: s.name,
  supplier_type: s.supplierType,
  active: s.active,
  contact_name: s.contactName,
  contact_email: s.contactEmail,
  contact_phone: s.contactPhone,
  vat_treatment: s.vatTreatment,
  notes: s.notes,
  venue_record_id: s.venueRecordId,
  revision: s.revision,
  created_at: s.createdAt,
  created_by: s.createdBy,
  updated_at: s.updatedAt,
  updated_by: s.updatedBy,
});
export const agreementFromRow = (r: Record<string, any>): Agreement => ({
  organisationId: r.organisation_id,
  agreementId: r.agreement_id,
  supplierId: r.supplier_id,
  supersedesAgreementId: r.supersedes_agreement_id ?? null,
  name: r.name,
  description: r.description ?? null,
  costType: r.cost_type,
  frequency: r.frequency ?? null,
  classification: r.classification,
  effectiveFrom: dateOf(r.effective_from),
  effectiveUntil: r.effective_until ? dateOf(r.effective_until) : null,
  amountMinor: intOrNull(r.amount_minor, "amount_minor"),
  hourlyRateMinor: intOrNull(r.hourly_rate_minor, "hourly_rate_minor"),
  expectedMonthlyHoursHundredths: intOrNull(r.expected_monthly_hours_hundredths, "expected_monthly_hours_hundredths"),
  amountIsEstimate: r.amount_is_estimate === true,
  instalmentCount: int(r.instalment_count, "instalment_count"),
  totalPlannedMinor: int(r.total_planned_minor, "total_planned_minor"),
  linkSessionIds: Array.isArray(r.link_session_ids) ? r.link_session_ids : [],
  linkFinanceServiceId: r.link_finance_service_id ?? null,
  linkState: r.link_state,
  allocationCount: int(r.allocation_count, "allocation_count"),
  sourceDocumentRef: r.source_document_ref ?? null,
  reason: r.reason ?? null,
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
});
export const agreementRow = (a: Agreement) => ({
  organisation_id: a.organisationId,
  agreement_id: a.agreementId,
  supplier_id: a.supplierId,
  supersedes_agreement_id: a.supersedesAgreementId,
  name: a.name,
  description: a.description,
  cost_type: a.costType,
  frequency: a.frequency,
  classification: a.classification,
  effective_from: a.effectiveFrom,
  effective_until: a.effectiveUntil,
  amount_minor: a.amountMinor,
  hourly_rate_minor: a.hourlyRateMinor,
  expected_monthly_hours_hundredths: a.expectedMonthlyHoursHundredths,
  amount_is_estimate: a.amountIsEstimate,
  instalment_count: a.instalmentCount,
  total_planned_minor: a.totalPlannedMinor,
  link_session_ids: a.linkSessionIds,
  link_finance_service_id: a.linkFinanceServiceId,
  link_state: a.linkState,
  allocation_count: a.allocationCount,
  source_document_ref: a.sourceDocumentRef,
  reason: a.reason,
  created_at: a.createdAt,
  created_by: a.createdBy,
});
export const allocationFromRow = (r: Record<string, any>): Allocation => ({
  organisationId: r.organisation_id,
  agreementId: r.agreement_id,
  occurrenceRecordId: r.occurrence_record_id,
  occurrenceRef: r.occurrence_ref ?? null,
  occurrenceDate: dateOf(r.occurrence_date),
  statusAtAgreement: r.status_at_agreement ?? null,
  sessionRecordId: r.session_record_id ?? null,
  sessionId: r.session_id ?? null,
  sessionName: r.session_name ?? null,
  financeServiceId: r.finance_service_id ?? null,
  programmeLabel: r.programme_label ?? null,
  allocatedMinor: int(r.allocated_minor, "allocated_minor"),
});
export const allocationRow = (a: Allocation) => ({
  organisation_id: a.organisationId,
  agreement_id: a.agreementId,
  occurrence_record_id: a.occurrenceRecordId,
  occurrence_ref: a.occurrenceRef,
  occurrence_date: a.occurrenceDate,
  status_at_agreement: a.statusAtAgreement,
  session_record_id: a.sessionRecordId,
  session_id: a.sessionId,
  session_name: a.sessionName,
  finance_service_id: a.financeServiceId,
  programme_label: a.programmeLabel,
  allocated_minor: a.allocatedMinor,
});
export const instalmentFromRow = (r: Record<string, any>): Instalment => ({
  organisationId: r.organisation_id,
  instalmentId: r.instalment_id,
  agreementId: r.agreement_id,
  supplierId: r.supplier_id,
  sequence: int(r.sequence, "sequence"),
  originalDueDate: dateOf(r.original_due_date),
  dueDate: dateOf(r.due_date),
  plannedMinor: int(r.planned_minor, "planned_minor"),
  amountDueMinor: int(r.amount_due_minor, "amount_due_minor"),
  amountState: r.amount_state,
  paidMinor: int(r.paid_minor, "paid_minor"),
  splitFromInstalmentId: r.split_from_instalment_id ?? null,
  note: r.note ?? null,
  cancelledAt: r.cancelled_at ? iso(r.cancelled_at) : null,
  cancelledBy: r.cancelled_by ?? null,
  cancelReason: r.cancel_reason ?? null,
  createdAt: iso(r.created_at),
  createdBy: r.created_by,
});
export const instalmentRow = (i: Instalment) => ({
  organisation_id: i.organisationId,
  instalment_id: i.instalmentId,
  agreement_id: i.agreementId,
  supplier_id: i.supplierId,
  sequence: i.sequence,
  original_due_date: i.originalDueDate,
  due_date: i.dueDate,
  planned_minor: i.plannedMinor,
  amount_due_minor: i.amountDueMinor,
  amount_state: i.amountState,
  paid_minor: i.paidMinor,
  split_from_instalment_id: i.splitFromInstalmentId,
  note: i.note,
  cancelled_at: i.cancelledAt,
  cancelled_by: i.cancelledBy,
  cancel_reason: i.cancelReason,
  created_at: i.createdAt,
  created_by: i.createdBy,
});
export const paymentFromRow = (r: Record<string, any>): Payment => ({
  organisationId: r.organisation_id,
  paymentId: r.payment_id,
  instalmentId: r.instalment_id,
  agreementId: r.agreement_id,
  supplierId: r.supplier_id,
  amountMinor: int(r.amount_minor, "amount_minor"),
  paidDate: dateOf(r.paid_date),
  method: r.method ?? null,
  reference: r.reference ?? null,
  note: r.note ?? null,
  remainingAfterMinor: int(r.remaining_after_minor, "remaining_after_minor"),
  recordedAt: iso(r.recorded_at),
  recordedBy: r.recorded_by,
});
export const paymentRow = (p: Payment) => ({
  organisation_id: p.organisationId,
  payment_id: p.paymentId,
  instalment_id: p.instalmentId,
  agreement_id: p.agreementId,
  supplier_id: p.supplierId,
  amount_minor: p.amountMinor,
  paid_date: p.paidDate,
  method: p.method,
  reference: p.reference,
  note: p.note,
  remaining_after_minor: p.remainingAfterMinor,
  recorded_at: p.recordedAt,
  recorded_by: p.recordedBy,
});

export interface SupplierLedger {
  suppliers: Supplier[];
  agreements: Agreement[];
  allocations: Allocation[];
  instalments: Instalment[];
  payments: Payment[];
}
export async function loadSupplierLedger(svc: GrantStoreConfig, organisationId: string): Promise<SupplierLedger> {
  const [s, a, al, i, p] = await Promise.all([
    read(svc, TABLE.suppliers, organisationId, "name.asc,supplier_id.asc"),
    read(svc, TABLE.agreements, organisationId, "effective_from.asc,agreement_id.asc"),
    read(svc, TABLE.allocations, organisationId, "agreement_id.asc,occurrence_date.asc,occurrence_record_id.asc"),
    read(svc, TABLE.instalments, organisationId, "due_date.asc,sequence.asc,instalment_id.asc"),
    read(svc, TABLE.payments, organisationId, "paid_date.asc,recorded_at.asc,payment_id.asc"),
  ]);
  return { suppliers: s.map(supplierFromRow), agreements: a.map(agreementFromRow), allocations: al.map(allocationFromRow), instalments: i.map(instalmentFromRow), payments: p.map(paymentFromRow) };
}
/** The audit trail of one record (its created / updated history), oldest first. */
export async function loadHistory(svc: GrantStoreConfig, organisationId: string, recordId: string): Promise<Record<string, any>[]> {
  const rows = await read(svc, "finance_audit_events", organisationId, "occurred_at.asc,id.asc", `&record_id=${eq(recordId)}`);
  return rows.map((r) => ({ at: r.occurred_at, event: r.event_type, by: r.actor_user_id, before: r.before, after: r.after, reason: r.reason }));
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(rest(svc, `rpc/${fn}`), { method: "POST", headers: headers(svc), body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {
      /* keep the raw text */
    }
    const mm = /f13:([a-z_]+)/.exec(String(msg));
    if (mm) throw new SupplierRefusal(mm[1]);
    if (/one_successor/i.test(String(msg))) throw new SupplierRefusal("agreement_already_versioned");
    throw new Error(`${fn} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}
export type Events = Record<string, unknown>[];
export const writeSupplier = (svc: GrantStoreConfig, s: Supplier, expectedRevision: number | null, events: Events) =>
  rpc(svc, RPC.supplier, { p_supplier: supplierRow(s), p_expected_revision: expectedRevision, p_events: events });
export const recordAgreement = (svc: GrantStoreConfig, a: Agreement, allocations: Allocation[], instalments: Instalment[], cancel: Instalment[], events: Events) =>
  rpc(svc, RPC.agreement, {
    p_agreement: agreementRow(a),
    p_allocations: allocations.map(allocationRow),
    p_instalments: instalments.map(instalmentRow),
    p_cancel: cancel.map((c) => ({ instalment_id: c.instalmentId, cancelled_at: c.cancelledAt, cancelled_by: c.cancelledBy, cancel_reason: c.cancelReason })),
    p_events: events,
  });
export const changeInstalment = (
  svc: GrantStoreConfig,
  before: Instalment,
  kind: string,
  change: Record<string, unknown>,
  newInstalments: Instalment[],
  payment: Payment | null,
  events: Events,
) =>
  rpc(svc, RPC.change, {
    p_org: before.organisationId,
    p_instalment_id: before.instalmentId,
    p_kind: kind,
    p_expected: { paid_minor: before.paidMinor, amount_due_minor: before.amountDueMinor, due_date: before.dueDate, amount_state: before.amountState, cancelled: !!before.cancelledAt },
    p_change: change,
    p_new_instalments: newInstalments.map(instalmentRow),
    p_payment: payment ? paymentRow(payment) : null,
    p_events: events,
  });
