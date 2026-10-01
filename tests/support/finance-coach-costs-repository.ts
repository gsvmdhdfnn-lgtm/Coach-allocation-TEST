/**
 * Test-suite copy of the canonical finance/finance-coach-costs-repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Coach cost READ + Finance month storage (Finance Foundation F12; see
 * TEST-ENV.md "Finance Foundation - F12").
 *
 * Airtable is READ ONLY here (Coaches / Schedule own it). A month window is
 * read with a fixed number of requests, never one per allocation:
 *   1 filtered Session Occurrences read (date window, one day of slack each
 *   side, re-checked in code), then the linked Coach Allocations and Sessions
 *   by record id (40 per request), all Coaches, then the allocations' Work
 *   Summary Lines and their Work Summaries by record id.
 *
 * Supabase (service role, PostgREST; RLS on, no client grants):
 *   finance_worker_cost_months       one finalised Finance Coach Month per
 *                                    organisation + worker + work month (UNIQUE)
 *   finance_worker_cost_items        its frozen per-allocation snapshot
 *   finance_worker_cost_corrections  explicit additive corrections
 * All three refuse UPDATE and DELETE in the database. Every write is ONE
 * database function call (finance_worker_month_finalise /
 * finance_worker_month_correct) that writes its finance_audit_events rows in
 * the same transaction.
 */
import type { AirtableConfig, GrantStoreConfig } from "./finance-repository.ts";
import { RECORD_ID_RE, airtableFetch, expectOk, tableUrl } from "./finance-commercial-repository.ts";
import { type Correction, type CostWorld, type FinanceMonth, type FrozenItem, type Row, COST_BASES, F, FROZEN_KEYS, TABLES } from "./finance-coach-costs.ts";

export const MONTHS_TABLE = "finance_worker_cost_months";
export const ITEMS_TABLE = "finance_worker_cost_items";
export const CORRECTIONS_TABLE = "finance_worker_cost_corrections";
export const RPC = { finalise: "finance_worker_month_finalise", correct: "finance_worker_month_correct" } as const;
/** Record ids per by-id read (keeps the formula well inside URL limits). */
export const ID_READ_CHUNK = 40;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function list(config: AirtableConfig, table: string, formula: string | null, fields: readonly string[]): Promise<Row[]> {
  const rows: Row[] = [];
  let offset = "";
  do {
    const url = new URL(tableUrl(config, table));
    if (formula) url.searchParams.set("filterByFormula", formula);
    for (const f of fields) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);
    const data = await expectOk(await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } }), `Airtable read of ${table}`);
    for (const r of data.records || []) rows.push({ id: r.id, fields: r.fields || {} });
    offset = data.offset || "";
  } while (offset);
  return rows;
}

async function byIds(config: AirtableConfig, table: string, ids: Iterable<string>, fields: readonly string[]): Promise<Map<string, Row>> {
  const all = [...new Set(ids)];
  if (all.some((id) => !RECORD_ID_RE.test(id))) throw new Error(`${table} read refused: a record id is malformed`);
  const chunks: string[][] = [];
  for (let i = 0; i < all.length; i += ID_READ_CHUNK) chunks.push(all.slice(i, i + ID_READ_CHUNK));
  const res = await Promise.all(chunks.map((c) => list(config, table, `OR(${c.map((id) => `RECORD_ID()='${id}'`).join(",")})`, fields)));
  const out = new Map<string, Row>();
  for (const r of res.flat()) if (all.includes(r.id)) out.set(r.id, r);
  return out;
}

const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** Everything needed to read the work dated from..to (inclusive). */
export async function loadCostWorld(config: AirtableConfig, from: string, to: string): Promise<CostWorld> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error("Coach cost read refused: dates are malformed");
  const d = `{${F.occurrence.date}}`;
  const occRows = await list(config, TABLES.occurrences, `AND(IS_AFTER(${d},'${shiftDay(from, -1)}'),IS_BEFORE(${d},'${shiftDay(to, 1)}'))`, Object.values(F.occurrence));
  const occurrences = new Map(occRows.filter((r) => typeof r.fields[F.occurrence.date] === "string" && r.fields[F.occurrence.date] >= from && r.fields[F.occurrence.date] <= to).map((r) => [r.id, r]));
  const allocationIds = [...occurrences.values()].flatMap((o) => links(o.fields[F.occurrence.allocations]));
  const sessionIds = [...occurrences.values()].flatMap((o) => links(o.fields[F.occurrence.session]));
  const allocationFields = Object.values(F.allocation);
  const [allocMap, sessions, workers] = await Promise.all([
    byIds(config, TABLES.allocations, allocationIds, allocationFields),
    byIds(config, TABLES.sessions, sessionIds, Object.values(F.session)),
    list(config, TABLES.workers, null, Object.values(F.worker)),
  ]);
  const allocations = [...allocMap.values()];
  const lines = await byIds(config, TABLES.lines, allocations.flatMap((a) => links(a.fields[F.allocation.lines])), Object.values(F.line));
  const summaries = await byIds(config, TABLES.summaries, [...lines.values()].flatMap((l) => links(l.fields[F.line.summary])), Object.values(F.summary));
  return { allocations, occurrences, sessions, workers, lines, summaries };
}

// ---------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------
function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const rest = (svc: GrantStoreConfig, path: string) => `${svc.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

/** A refused month write: the database function's own rule code (f12:...), never a partial write. */
export class CostRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function read(svc: GrantStoreConfig, table: string, organisationId: string, order: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${rest(svc, table)}?organisation_id=${eq(organisationId)}&select=*&order=${order}`, { headers: headers(svc) });
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

export const monthFromRow = (r: Record<string, any>): FinanceMonth => ({
  organisationId: r.organisation_id,
  monthId: r.month_id,
  workerRecordId: r.worker_record_id,
  workerRef: r.worker_ref,
  workerName: r.worker_name ?? null,
  workMonth: dateOf(r.work_month).slice(0, 7),
  finalisedTotalMinor: int(r.finalised_total_minor, "finalised_total_minor"),
  itemCount: int(r.item_count, "item_count"),
  paymentDay: int(r.payment_day, "payment_day"),
  expectedPaymentDate: dateOf(r.expected_payment_date),
  snapshotHash: r.snapshot_hash,
  finalisedAt: new Date(r.finalised_at).toISOString(),
  finalisedBy: r.finalised_by,
  reason: r.reason ?? null,
});
export const itemFromRow = (r: Record<string, any>): FrozenItem & { month_id: string } => {
  if (!(COST_BASES as readonly unknown[]).includes(r.cost_basis)) throw new Error("F12 item row: invalid cost_basis");
  return {
    month_id: r.month_id,
    allocation_record_id: r.allocation_record_id,
    allocation_label: r.allocation_label,
    occurrence_record_id: r.occurrence_record_id,
    occurrence_ref: r.occurrence_ref ?? null,
    work_date: dateOf(r.work_date),
    session_record_id: r.session_record_id ?? null,
    session_name: r.session_name,
    finance_service_id: r.finance_service_id ?? null,
    programme_label: r.programme_label ?? null,
    cost_basis: r.cost_basis,
    rate_type: r.rate_type ?? null,
    pay_unit: r.pay_unit ?? null,
    paid_units: r.paid_units === null || r.paid_units === undefined ? null : Number(r.paid_units).toFixed(2),
    rate_amount_minor: intOrNull(r.rate_amount_minor, "rate_amount_minor"),
    override_minor: intOrNull(r.override_minor, "override_minor"),
    override_reason: r.override_reason ?? null,
    work_outcome: r.work_outcome ?? null,
    final_cost_minor: int(r.final_cost_minor, "final_cost_minor"),
    work_summary_ref: r.work_summary_ref ?? null,
  };
};
export const correctionFromRow = (r: Record<string, any>): Correction => ({
  organisationId: r.organisation_id,
  correctionId: r.correction_id,
  monthId: r.month_id,
  amountMinor: int(r.amount_minor, "amount_minor"),
  allocationRecordId: r.allocation_record_id ?? null,
  reason: r.reason,
  resultingTotalMinor: int(r.resulting_total_minor, "resulting_total_minor"),
  createdAt: new Date(r.created_at).toISOString(),
  createdBy: r.created_by,
});

export interface MonthLedger {
  months: FinanceMonth[];
  items: (FrozenItem & { month_id: string })[];
  corrections: Correction[];
}
export async function loadMonthLedger(svc: GrantStoreConfig, organisationId: string): Promise<MonthLedger> {
  const [m, i, c] = await Promise.all([
    read(svc, MONTHS_TABLE, organisationId, "work_month.asc,month_id.asc"),
    read(svc, ITEMS_TABLE, organisationId, "month_id.asc,work_date.asc,allocation_record_id.asc"),
    read(svc, CORRECTIONS_TABLE, organisationId, "created_at.asc,correction_id.asc"),
  ]);
  return { months: m.map(monthFromRow), items: i.map(itemFromRow), corrections: c.map(correctionFromRow) };
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
    const mm = /f12:([a-z_]+)/.exec(String(msg));
    if (mm) throw new CostRefusal(mm[1]);
    if (/duplicate key|unique/i.test(String(msg))) throw new CostRefusal("already_finalised");
    throw new Error(`${fn} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export type Events = Record<string, unknown>[];
export function monthRow(m: FinanceMonth): Record<string, unknown> {
  return {
    organisation_id: m.organisationId,
    month_id: m.monthId,
    worker_record_id: m.workerRecordId,
    worker_ref: m.workerRef,
    worker_name: m.workerName,
    work_month: `${m.workMonth}-01`,
    finalised_total_minor: m.finalisedTotalMinor,
    item_count: m.itemCount,
    payment_day: m.paymentDay,
    expected_payment_date: m.expectedPaymentDate,
    snapshot_hash: m.snapshotHash,
    currency: "GBP",
    finalised_at: m.finalisedAt,
    finalised_by: m.finalisedBy,
    reason: m.reason,
  };
}
export function itemRow(organisationId: string, monthId: string, i: FrozenItem): Record<string, unknown> {
  const out: Record<string, unknown> = { organisation_id: organisationId, month_id: monthId };
  for (const k of FROZEN_KEYS) out[k] = i[k] ?? null;
  return out;
}
export const finaliseMonth = (svc: GrantStoreConfig, m: FinanceMonth, items: FrozenItem[], events: Events) =>
  rpc(svc, RPC.finalise, { p_month: monthRow(m), p_items: items.map((i) => itemRow(m.organisationId, m.monthId, i)), p_events: events });
export const correctMonth = (svc: GrantStoreConfig, c: Correction, expectedTotalMinor: number, events: Events) =>
  rpc(svc, RPC.correct, {
    p_org: c.organisationId,
    p_month_id: c.monthId,
    p_expected_total_minor: expectedTotalMinor,
    p_correction: {
      organisation_id: c.organisationId,
      correction_id: c.correctionId,
      month_id: c.monthId,
      amount_minor: c.amountMinor,
      allocation_record_id: c.allocationRecordId,
      reason: c.reason,
      resulting_total_minor: c.resultingTotalMinor,
      created_at: c.createdAt,
      created_by: c.createdBy,
    },
    p_events: events,
  });
