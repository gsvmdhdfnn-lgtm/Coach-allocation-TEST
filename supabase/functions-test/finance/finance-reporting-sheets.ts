/**
 * Google Sheets REPORTING writer - pure rules (Finance Foundation F19; see
 * TEST-ENV.md "Finance Foundation - F19").
 *
 * Direction: Hub -> Sheets ONLY. Google Sheets is a reporting output; it is
 * never read back as Finance truth. A manual edit in a Hub-owned tab is a
 * disposable reporting edit: the next sync replaces it with the canonical
 * Hub value and it never changes Finance.
 *
 * Every figure comes from the F18 Month Report engine (the canonical
 * calculation): the two report modes (Actual, Expected + Actual) and the F18
 * facts (with their stable fact keys). This module only TRANSFORMS them into
 * tabular rows - it never computes revenue, VAT, costs, contribution,
 * overheads, profit, margin, Actual / Expected state, programme attribution
 * or credit treatment itself.
 *
 * Ownership (schema finance_reporting_v1): the writer owns ONLY these tabs,
 * prefixed "Hub · ", and never reads or writes any other tab of the workbook
 * (Overview, Session Ledger, Coach Costs, Revenue & Billing, Other Costs,
 * Business Overheads, Monthly Summary, Setup, Integration Map, Cash Events or
 * anything else a user created):
 *   Hub · Monthly Summary / Programmes / Revenue / Coach Costs / Direct Costs /
 *   Overheads / Completeness  - data tabs, one row per stable Row Key;
 *   Hub · Sync Info           - ownership marker, schema, writer version,
 *                               organisation id, last successful sync.
 * Inside a data tab the writer reads / writes only columns A..(last managed
 * column); anything to the right of them is user space and is never touched.
 *
 * Month-scoped replace: a sync of month M keeps every row of every other
 * month exactly as read, replaces ALL rows of month M with the canonical set
 * (so a fact that changed identity - draft -> invoice line, open -> finalised
 * Coach Month - leaves no stale predecessor), sorts by (Month, Row Key) and
 * rewrites the tab. Identity is the Row Key, never a row number.
 */
import type { Fact, DirectFact, OverheadFact, RevenueFact, buildMonthReport } from "./finance-month-report.ts";
import { MONTH_RE } from "./finance-month-report.ts";
import { formatMinor } from "./finance-money.ts";
import { auditEvent } from "./finance-commercial.ts";

export type MonthReport = ReturnType<typeof buildMonthReport>;
/** A sheet cell as the Sheets API returns it with UNFORMATTED_VALUE ("" = empty). */
export type Cell = string | number | boolean;

export const REPORTING_CONTRACT = "finance-reporting-v1";
export const SCHEMA_VERSION = "finance_reporting_v1";
export const WRITER_VERSION = "f19.1";
export const PROVIDER = "google_sheets";
export const OWNERSHIP_MARKER = "hub-finance-reporting";
/** Generic auth boundary: only the platform service account is enabled; organisation OAuth is future work. */
export const AUTH_MODES = ["platform_service_account", "organisation_oauth"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export const ENABLED_AUTH_MODES: readonly AuthMode[] = ["platform_service_account"];
/** sandbox = the TEST sheets-sandbox emulator; google = real Google Sheets (NOT enabled / NOT PROVEN in F19). */
export const ENDPOINTS = ["sandbox", "google"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];
export const ENTITY_CONNECTION = "finance_reporting_connection";
export const ENTITY_RUN = "finance_reporting_sync_run";
export const REPORTING_EVENTS = {
  configured: "finance_reporting.configured",
  disconnected: "finance_reporting.disconnected",
  synced: "finance_reporting.synced",
  syncFailed: "finance_reporting.sync_failed",
} as const;
/** A bounded tab: more managed rows than this refuses the sync (never an unbounded read or write). */
export const MAX_ROWS_PER_TAB = 20_000;
export const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
export const RUN_ID_PATTERN = /^FRS-[0-9A-F]{12}$/;
const REASON_MAX = 500;
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";

// ---------------------------------------------------------------------
// Schema finance_reporting_v1 (the column contract - never reordered silently)
// ---------------------------------------------------------------------
export type TabId = "summary" | "programmes" | "revenue" | "coach" | "direct" | "overheads" | "completeness";
export interface TabDef {
  id: TabId;
  title: string;
  headers: readonly string[];
}
const ORG_KEY = ["Organisation ID", "Row Key"] as const;
export const DATA_TABS: readonly TabDef[] = [
  { id: "summary", title: "Hub · Monthly Summary", headers: ["Month", "Mode", "State", "Gross Revenue", "VAT", "Net Revenue", "Direct Costs", "Programme Contribution", "Overheads", "Final Business Profit", "Final Margin %", "Margin Note", "Report Complete?", "Incomplete Items", "Parent / Stripe Revenue", "Stripe Excluded Gross", ...ORG_KEY] },
  { id: "programmes", title: "Hub · Programmes", headers: ["Month", "Mode", "Finance Service ID", "Programme", "State", "Gross Revenue", "VAT", "Net Revenue", "Coach Cost", "Venue Cost", "Other Direct Cost", "Credit Adjustment", "Direct Costs", "Contribution", "Margin %", ...ORG_KEY] },
  { id: "revenue", title: "Hub · Revenue", headers: ["Month", "Date", "State", "Layer", "Finance Service ID", "Programme", "Client", "Session", "Occurrence ID", "Source", "Source ID", "Gross", "VAT", "Net", "Note", ...ORG_KEY] },
  { id: "coach", title: "Hub · Coach Costs", headers: ["Month", "Work Date", "State", "Coach", "Coach Ref", "Finance Service ID", "Programme", "Session", "Occurrence ID", "Cost Basis", "Coach Month ID", "Correction ID", "Allocation", "Amount", ...ORG_KEY] },
  { id: "direct", title: "Hub · Direct Costs", headers: ["Month", "Date", "State", "Cost Type", "Effect", "Supplier", "Supplier ID", "Agreement", "Agreement ID", "Credit ID", "Finance Service ID", "Programme", "Occurrence / Session", "Gross Cost", "Credit Adjustment", "Net Cost", "Note", ...ORG_KEY] },
  { id: "overheads", title: "Hub · Overheads", headers: ["Month", "Date", "State", "Category", "Category ID", "Kind", "Supplier / Person", "Source ID", "Agreement", "Gross", "Credit Adjustment", "Net", "VAT Context", "Note", ...ORG_KEY] },
  { id: "completeness", title: "Hub · Completeness", headers: ["Month", "Mode", "Code", "Severity", "Message", "Count", "Amount", ...ORG_KEY] },
];
export const SYNC_INFO_TAB = { title: "Hub · Sync Info", headers: ["Field", "Value"] as readonly string[] };
export const MANAGED_TITLES: readonly string[] = [...DATA_TABS.map((t) => t.title), SYNC_INFO_TAB.title];
export const SYNC_INFO_NOTE = "Managed by the Hub Finance reporting writer. Every 'Hub ·' tab is rebuilt from the Hub on each sync: edits here are overwritten and never change Hub Finance. Other tabs, and columns to the right of the managed columns, are never touched.";
const STATIC_INFO_FIELDS = ["ownership_marker", "schema_version", "writer_version", "organisation_id", "note"] as const;
const SUCCESS_INFO_FIELDS = ["last_successful_sync_at", "last_successful_sync_month", "last_successful_sync_run"] as const;

export function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;
/** The bounded read range of a managed tab: its managed columns, header + MAX rows. */
export const readRangeOf = (title: string, width: number, maxRows = MAX_ROWS_PER_TAB) => `${quote(title)}!A1:${colLetter(width - 1)}${maxRows + 1}`;
export const writeRangeOf = (title: string, width: number, rows: number) => `${quote(title)}!A1:${colLetter(width - 1)}${Math.max(rows, 1)}`;

// ---------------------------------------------------------------------
// Canonical rows (from F18 - never recalculated)
// ---------------------------------------------------------------------
export interface CanonicalMonth {
  organisationId: string;
  month: string;
  /** F18 report, mode actual */
  actual: MonthReport;
  /** F18 report, mode expected (Expected + Actual) */
  expected: MonthReport;
  /** the F18 facts the two reports were built from (stable fact keys) */
  facts: readonly Fact[];
  serviceLabels: Record<string, string>;
}
export type Row = Cell[];
export type Tables = Record<TabId, Row[]>;

/** Pounds as a sheet number from pence (exact 2 dp; the same string F18 shows). */
export const pounds = (minor: number): number => Number(formatMinor(minor));
/** An F18 money string ("372.33") as a sheet number. */
const money = (s: string | null | undefined): Cell => (s === null || s === undefined ? "" : Number(s));
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const STATE: Record<string, string> = { actual: "Actual", expected: "Expected" };
const MODE_LABEL = { actual: "Actual", expected: "Expected + Actual" } as const;
const byKey = (a: Row, b: Row) => {
  const ka = `${a[0]}|${a[a.length - 1]}`;
  const kb = `${b[0]}|${b[b.length - 1]}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};
const programmeOf = (c: CanonicalMonth, serviceId: string | null, label: string | null = null) => (serviceId === null ? "Unattributed" : c.serviceLabels[serviceId] ?? label ?? serviceId);

function summaryRows(c: CanonicalMonth): Row[] {
  return (["actual", "expected"] as const).map((mode) => {
    const r = c[mode];
    const o = r.overall;
    const incomplete = r.completeness.items.filter((i) => i.severity === "incomplete").map((i) => i.code);
    const stripe = r.excluded.parentStripeRevenue;
    return [
      c.month,
      MODE_LABEL[mode],
      r.state,
      money(o.grossRevenue),
      money(o.vat),
      money(o.netRevenue),
      money(o.directCosts),
      money(o.programmeContribution),
      money(o.overheads),
      money(o.finalBusinessProfit),
      money(o.finalMargin.percent),
      str(o.finalMargin.reason),
      r.completeness.complete ? "Yes" : "No",
      incomplete.join("; "),
      `${stripe.label} (${stripe.status})`,
      money(stripe.grossReceived),
      c.organisationId,
      `summary:${c.month}:${mode}`,
    ];
  });
}

function programmeRows(c: CanonicalMonth): Row[] {
  const rows: Row[] = [];
  for (const mode of ["actual", "expected"] as const) {
    const r = c[mode];
    const blocks: { id: string | null; label: string; v: any }[] = [...r.programmes.map((p: any) => ({ id: p.financeServiceId as string, label: p.label as string, v: p })), { id: null, label: "Unattributed", v: r.unattributed as any }];
    for (const b of blocks) {
      const v = b.v;
      const d = v.directCosts;
      const hasAny = b.id !== null || v.revenue.net !== "0.00" || d.total !== "0.00" || v.detail.coachCosts.length + v.detail.venueCosts.length + v.detail.otherDirectCosts.length + v.detail.revenueSources.length > 0;
      if (!hasAny) continue;
      const pc = (x: string) => Math.round(Number(x) * 100);
      const credit = pc(d.venue.creditAdjustment) + pc(d.otherDirect.creditAdjustment);
      rows.push([
        c.month,
        MODE_LABEL[mode],
        b.id ?? "",
        b.label,
        v.state,
        money(v.revenue.gross),
        money(v.revenue.vat),
        money(v.revenue.net),
        money(d.coach),
        money(d.venue.gross),
        money(d.otherDirect.gross),
        pounds(credit),
        money(d.total),
        money(v.contribution),
        money(v.margin.percent),
        c.organisationId,
        `programme:${c.month}:${mode}:${b.id ?? "UNATTRIBUTED"}`,
      ]);
    }
  }
  return rows;
}

const LAYER: Record<string, string> = { invoice: "Invoice line", draft: "Draft line", expected_billing: "Expected billing (F4)" };
function revenueRows(c: CanonicalMonth, facts: readonly Fact[]): Row[] {
  const rows: Row[] = [];
  for (const f of facts.filter((x): x is RevenueFact => x.side === "revenue")) {
    const s = f.source as Record<string, any>;
    const sourceId = s.type === "invoice_line" ? `${s.invoiceId}/${s.lineId}` : s.type === "draft_line" ? `${s.draftId}/${s.lineId}` : f.occurrenceId;
    const note =
      s.type === "invoice_line" ? `${str(s.portion)}${s.officialNumber ? ` - ${s.officialNumber}` : ""}` : s.type === "draft_line" ? "Included draft line" : `${str(s.why)}${s.manualBilling ? " (Manual Billing - stays Expected)" : ""}`;
    rows.push([c.month, f.date, STATE[f.state], LAYER[f.layer] ?? f.layer, f.serviceId, programmeOf(c, f.serviceId), str(s.client), str(s.session), f.occurrenceId, str(s.type), sourceId, pounds(f.grossMinor), pounds(f.vatMinor), pounds(f.netMinor), note, c.organisationId, f.key]);
  }
  // F18's unresolved client revenue (not in any figure, never guessed) - shown, never dropped.
  const un = c.expected.completeness.items.find((i) => i.code === "revenue_unresolved");
  for (const u of (Array.isArray(un?.detail) ? un!.detail : []) as Record<string, any>[]) {
    rows.push([c.month, str(u.date), "Unresolved", "Unresolved (not in totals)", str(u.serviceId), u.serviceId ? programmeOf(c, u.serviceId) : "", "", "", str(u.occurrenceId), "unresolved", str(u.occurrenceId), "", "", "", `${str(u.outcome)}: ${str(u.detail)}${u.expectedGross ? ` (would be ${u.expectedGross} gross)` : ""}`, c.organisationId, `unresolved:${u.occurrenceId}`]);
  }
  return rows;
}

function coachRows(c: CanonicalMonth, facts: readonly Fact[]): Row[] {
  return facts
    .filter((x): x is DirectFact => x.side === "direct" && x.kind === "coach")
    .map((f) => {
      const s = f.source as Record<string, any>;
      return [c.month, f.date, STATE[f.state], str(s.coach?.name), str(s.coach?.ref), f.serviceId ?? "", programmeOf(c, f.serviceId, f.label), str(s.session), str(s.occurrenceId), str(s.costBasis), str(s.monthId), str(s.correctionId), str(s.allocation), pounds(f.amountMinor), c.organisationId, f.key];
    });
}

function directRows(c: CanonicalMonth, facts: readonly Fact[]): Row[] {
  return facts
    .filter((x): x is DirectFact => x.side === "direct" && x.kind !== "coach")
    .map((f) => {
      const s = f.source as Record<string, any>;
      return [
        c.month,
        f.date,
        STATE[f.state],
        f.kind === "venue" ? "Venue" : "Other direct",
        f.adjustment ? "Credit adjustment" : "Cost",
        str(s.supplier),
        str(s.supplierId),
        str(s.agreement),
        str(s.agreementId),
        str(s.creditId),
        f.serviceId ?? "",
        programmeOf(c, f.serviceId, f.label),
        str(s.occurrence ?? s.attributedSession),
        f.adjustment ? 0 : pounds(f.amountMinor),
        f.adjustment ? pounds(f.amountMinor) : 0,
        pounds(f.adjustment ? -f.amountMinor : f.amountMinor),
        str(s.why ?? s.unattributedReason ?? s.note),
        c.organisationId,
        f.key,
      ];
    });
}

const KIND: Record<string, string> = { supplier_overhead: "Supplier overhead", employment: "Employment", supplier_credit: "Supplier credit" };
function overheadRows(c: CanonicalMonth, facts: readonly Fact[]): Row[] {
  return facts
    .filter((x): x is OverheadFact => x.side === "overhead")
    .map((f) => {
      const s = f.source as Record<string, any>;
      const person = typeof s.person === "string" ? s.person : s.person?.name;
      const sourceId = s.type === "employment_month" ? `${s.employmentId}/${s.month}` : str(s.instalmentId ?? s.creditId);
      return [
        c.month,
        f.date,
        STATE[f.state],
        f.category?.name ?? "Uncategorised",
        f.category?.categoryId ?? "",
        KIND[f.kind] ?? f.kind,
        str(s.supplier ?? person),
        sourceId,
        str(s.agreement),
        f.adjustment ? 0 : pounds(f.amountMinor),
        f.adjustment ? pounds(f.amountMinor) : 0,
        pounds(f.adjustment ? -f.amountMinor : f.amountMinor),
        str(s.vatTreatment),
        str(s.estimateLabel ?? f.uncategorisedReason ?? s.note),
        c.organisationId,
        f.key,
      ];
    });
}

function completenessRows(c: CanonicalMonth): Row[] {
  const rows: Row[] = [];
  for (const mode of ["actual", "expected"] as const) {
    const r = c[mode];
    for (const i of r.completeness.items) rows.push([c.month, MODE_LABEL[mode], i.code, i.severity, i.message, typeof i.count === "number" ? i.count : "", money(i.amount ?? null), c.organisationId, `completeness:${c.month}:${mode}:${i.code}`]);
    const eqs = r.reconciliation.equations;
    rows.push([c.month, MODE_LABEL[mode], "reconciliation", r.reconciliation.allHold ? "info" : "incomplete", r.reconciliation.allHold ? `All ${eqs.length} F18 reconciliation equations hold (no balancing line)` : "The F18 report does not reconcile - see the Month Report", "", "", c.organisationId, `completeness:${c.month}:${mode}:reconciliation`]);
  }
  return rows;
}

/** The canonical rows of month M for every data tab (sorted by Row Key; one row per stable key). */
export function canonicalTables(c: CanonicalMonth): Tables {
  const facts = c.facts.filter((f) => f.month === c.month);
  const t: Tables = {
    summary: summaryRows(c),
    programmes: programmeRows(c),
    revenue: revenueRows(c, facts),
    coach: coachRows(c, facts),
    direct: directRows(c, facts),
    overheads: overheadRows(c, facts),
    completeness: completenessRows(c),
  };
  for (const k of Object.keys(t) as TabId[]) {
    t[k].sort(byKey);
    const keys = t[k].map((r) => r[r.length - 1]);
    if (new Set(keys).size !== keys.length) throw new Error(`${k}: duplicate Row Key in the canonical rows`);
  }
  return t;
}

/** The F18 control figures (pence) the written workbook must reproduce. */
export interface Controls {
  actual: { net: number; direct: number; overheads: number; profit: number; gross: number; vat: number };
  expected: { net: number; direct: number; overheads: number; profit: number; gross: number; vat: number };
}
export function controlsOf(c: CanonicalMonth): Controls {
  const f = (r: MonthReport) => {
    const x = r._figures.current;
    return { net: x.netRevenueMinor, direct: x.directCostsMinor, overheads: x.overheadsMinor, profit: x.profitMinor, gross: x.grossRevenueMinor, vat: x.vatMinor };
  };
  return { actual: f(c.actual), expected: f(c.expected) };
}

// ---------------------------------------------------------------------
// Workbook inspection (ownership + schema) and the month-scoped merge
// ---------------------------------------------------------------------
export type Problem = { code: "schema_incompatible" | "owned_elsewhere" | "unrecognised_rows" | "too_large"; message: string; tab?: string; details?: Record<string, unknown> };
const normCell = (v: unknown): Cell => (v === undefined || v === null ? "" : (v as Cell));
export function normGrid(rows: readonly (readonly unknown[])[] | undefined): Cell[][] {
  const res = (rows ?? []).map((r) => {
    const a = r.map(normCell);
    while (a.length && a[a.length - 1] === "") a.pop();
    return a;
  });
  while (res.length && res[res.length - 1].length === 0) res.pop();
  return res;
}
const sameRow = (a: readonly unknown[], b: readonly unknown[]) => JSON.stringify(normGrid([a])[0] ?? []) === JSON.stringify(normGrid([b])[0] ?? []);

export interface WorkbookView {
  /** every tab title in the workbook */
  titles: readonly string[];
  /** read grids of the EXISTING managed tabs (header row first), by title */
  grids: Record<string, Cell[][]>;
}

/** Ownership / schema check of the managed tabs that exist. No problems = safe to (re)write them. */
export function inspectWorkbook(w: WorkbookView, organisationId: string): Problem[] {
  const problems: Problem[] = [];
  const existing = MANAGED_TITLES.filter((t) => w.titles.includes(t));
  const info = w.titles.includes(SYNC_INFO_TAB.title) ? normGrid(w.grids[SYNC_INFO_TAB.title]) : null;
  if (!info && existing.length) {
    problems.push({ code: "schema_incompatible", message: `Hub-owned tab(s) exist without '${SYNC_INFO_TAB.title}' - the Hub cannot prove it owns them, so it will not overwrite them`, details: { tabs: existing } });
    return problems;
  }
  if (info) {
    if (!sameRow(info[0] ?? [], SYNC_INFO_TAB.headers)) problems.push({ code: "schema_incompatible", tab: SYNC_INFO_TAB.title, message: `'${SYNC_INFO_TAB.title}' headers are not the ${SCHEMA_VERSION} headers`, details: { expected: SYNC_INFO_TAB.headers, found: info[0] ?? [] } });
    const kv = infoMap(info);
    if (kv.get("ownership_marker") !== OWNERSHIP_MARKER) problems.push({ code: "schema_incompatible", tab: SYNC_INFO_TAB.title, message: `'${SYNC_INFO_TAB.title}' has no Hub ownership marker`, details: { found: kv.get("ownership_marker") ?? null } });
    if (kv.get("schema_version") !== SCHEMA_VERSION) problems.push({ code: "schema_incompatible", tab: SYNC_INFO_TAB.title, message: `The workbook's Hub tabs are schema ${String(kv.get("schema_version") ?? "unknown")}; this Hub writes ${SCHEMA_VERSION} - a migration / setup is required`, details: { expected: SCHEMA_VERSION, found: kv.get("schema_version") ?? null } });
    if (kv.has("organisation_id") && kv.get("organisation_id") !== organisationId) problems.push({ code: "owned_elsewhere", tab: SYNC_INFO_TAB.title, message: "This workbook's Hub tabs belong to another organisation - nothing was written" });
  }
  for (const def of DATA_TABS) {
    if (!w.titles.includes(def.title)) continue;
    const g = normGrid(w.grids[def.title]);
    if (!g.length) continue; // an empty tab: set up on write
    if (!sameRow(g[0], def.headers)) {
      problems.push({ code: "schema_incompatible", tab: def.title, message: `'${def.title}' headers do not match ${SCHEMA_VERSION} - refusing rather than guessing`, details: { expected: def.headers, found: g[0] } });
      continue;
    }
    const keys = new Set<string>();
    for (let i = 1; i < g.length; i++) {
      const r = g[i];
      if (!r.length) continue;
      const key = r[def.headers.length - 1];
      const org = r[def.headers.length - 2];
      const month = r[0];
      if (typeof key !== "string" || !key || typeof month !== "string" || !MONTH_RE.test(month)) {
        problems.push({ code: "unrecognised_rows", tab: def.title, message: `'${def.title}' row ${i + 1} is not a Hub-managed row (no Row Key / Month) - the Hub will not overwrite content it did not write`, details: { row: i + 1 } });
        break;
      }
      if (org !== organisationId) {
        problems.push({ code: "owned_elsewhere", tab: def.title, message: `'${def.title}' row ${i + 1} belongs to another organisation - nothing was written`, details: { row: i + 1 } });
        break;
      }
      if (keys.has(key)) {
        problems.push({ code: "unrecognised_rows", tab: def.title, message: `'${def.title}' has Row Key ${key} twice - the managed rows were edited; fix or clear the tab`, details: { row: i + 1, key } });
        break;
      }
      keys.add(key);
    }
    if (g.length - 1 > MAX_ROWS_PER_TAB) problems.push({ code: "too_large", tab: def.title, message: `'${def.title}' has more than ${MAX_ROWS_PER_TAB} rows` });
  }
  return problems;
}

function infoMap(info: Cell[][]): Map<string, Cell> {
  const kv = new Map<string, Cell>();
  for (const r of info.slice(1)) if (typeof r[0] === "string" && r[0]) kv.set(r[0], r[1] ?? "");
  return kv;
}

export interface Plan {
  /** tabs to create (header row frozen) */
  addTabs: string[];
  /** ONE values.batchUpdate: every managed data tab + Sync Info (static rows) */
  writes: { range: string; values: Cell[][] }[];
  /** what each data tab must read back as (header first, normalised) */
  expected: Record<string, Cell[][]>;
  rowCounts: Record<TabId, { month: number; total: number }>;
}

/** Month-scoped replace of every data tab + the Sync Info static block. Pure; deterministic. */
export function planWrite(w: WorkbookView, organisationId: string, month: string, canonical: Tables, maxRows = MAX_ROWS_PER_TAB): { ok: true; plan: Plan } | { ok: false; problems: Problem[] } {
  const problems = inspectWorkbook(w, organisationId);
  if (problems.length) return { ok: false, problems };
  const addTabs = MANAGED_TITLES.filter((t) => !w.titles.includes(t));
  const writes: Plan["writes"] = [];
  const expected: Record<string, Cell[][]> = {};
  const rowCounts = {} as Plan["rowCounts"];
  for (const def of DATA_TABS) {
    const width = def.headers.length;
    const old = normGrid(w.grids[def.title]);
    const kept = old.slice(1).filter((r) => r.length && r[0] !== month);
    const rows = [...kept, ...canonical[def.id]].map((r) => {
      const x = [...r];
      while (x.length < width) x.push("");
      return x;
    });
    rows.sort(byKey);
    if (rows.length > maxRows) return { ok: false, problems: [{ code: "too_large", tab: def.title, message: `'${def.title}' would have ${rows.length} rows (limit ${maxRows}) - archive older months to a copy before syncing` }] };
    const grid: Cell[][] = [[...def.headers], ...rows];
    const blank = Math.max(0, old.length - grid.length);
    const values = [...grid, ...Array.from({ length: blank }, () => Array<Cell>(width).fill(""))];
    writes.push({ range: writeRangeOf(def.title, width, values.length), values });
    expected[def.title] = normGrid(grid);
    rowCounts[def.id] = { month: canonical[def.id].length, total: rows.length };
  }
  // Sync Info: static ownership block (+ whatever success / month rows already exist, unchanged)
  const info = writeSyncInfo(normGrid(w.grids[SYNC_INFO_TAB.title]), organisationId, null);
  writes.push({ range: writeRangeOf(SYNC_INFO_TAB.title, 2, info.values.length), values: info.values });
  return { ok: true, plan: { addTabs, writes, expected, rowCounts } };
}

/**
 * The Sync Info grid: static fields first (fixed order), then the last
 * successful sync fields, then one `month:YYYY-MM` row per month ever synced
 * successfully (sorted). `success` = the just-verified sync, or null to keep
 * what is there.
 */
export function writeSyncInfo(old: Cell[][], organisationId: string, success: { at: string; month: string; runId: string } | null): { values: Cell[][]; expected: Cell[][] } {
  const kv = old.length ? infoMap(old) : new Map<string, Cell>();
  const months = [...kv.keys()].filter((k) => /^month:\d{4}-\d{2}$/.test(k));
  const monthVal = new Map(months.map((k) => [k, kv.get(k) ?? ""]));
  if (success) monthVal.set(`month:${success.month}`, success.at);
  const stat: Record<(typeof STATIC_INFO_FIELDS)[number], Cell> = { ownership_marker: OWNERSHIP_MARKER, schema_version: SCHEMA_VERSION, writer_version: WRITER_VERSION, organisation_id: organisationId, note: SYNC_INFO_NOTE };
  const succ: Record<(typeof SUCCESS_INFO_FIELDS)[number], Cell> = success
    ? { last_successful_sync_at: success.at, last_successful_sync_month: success.month, last_successful_sync_run: success.runId }
    : { last_successful_sync_at: kv.get("last_successful_sync_at") ?? "", last_successful_sync_month: kv.get("last_successful_sync_month") ?? "", last_successful_sync_run: kv.get("last_successful_sync_run") ?? "" };
  const grid: Cell[][] = [[...SYNC_INFO_TAB.headers], ...STATIC_INFO_FIELDS.map((k) => [k, stat[k]]), ...SUCCESS_INFO_FIELDS.map((k) => [k, succ[k]]), ...[...monthVal.keys()].sort().map((k) => [k, monthVal.get(k) ?? ""])];
  const blank = Math.max(0, old.length - grid.length);
  return { values: [...grid, ...Array.from({ length: blank }, () => ["", ""] as Cell[])], expected: normGrid(grid) };
}

// ---------------------------------------------------------------------
// Verification (never trust a 200)
// ---------------------------------------------------------------------
const toMinor = (v: Cell | undefined): number => (typeof v === "number" ? Math.round(v * 100) : NaN);
export interface Verification {
  ok: boolean;
  problems: string[];
  /** control totals read back from the workbook for month M (pence), by mode */
  readBack: Record<"actual" | "expected", { net: number; direct: number; overheads: number; profit: number }>;
}

/** Exact grid equality of every data tab + the F18 control totals recomputed from what was READ BACK. */
export function verifyWrite(month: string, expected: Record<string, Cell[][]>, actual: Record<string, Cell[][] | undefined>, controls: Controls): Verification {
  const problems: string[] = [];
  for (const def of DATA_TABS) {
    const want = expected[def.title];
    const got = normGrid(actual[def.title]);
    if (!want) continue;
    if (JSON.stringify(got[0] ?? []) !== JSON.stringify(normGrid([def.headers])[0])) problems.push(`${def.title}: header row differs from ${SCHEMA_VERSION}`);
    if (got.length !== want.length) problems.push(`${def.title}: ${got.length - 1} row(s) read back, ${want.length - 1} expected`);
    const wantKeys = want.slice(1).map((r) => r[def.headers.length - 1]);
    const gotKeys = got.slice(1).map((r) => r[def.headers.length - 1]);
    if (JSON.stringify(wantKeys) !== JSON.stringify(gotKeys)) problems.push(`${def.title}: Row Keys read back differ from the written keys`);
    else
      for (let i = 1; i < want.length; i++)
        if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) {
          problems.push(`${def.title}: row ${i + 1} (${String(want[i][def.headers.length - 1])}) read back differently`);
          break;
        }
  }
  const rows = (id: TabId) => {
    const def = DATA_TABS.find((d) => d.id === id)!;
    return normGrid(actual[def.title]).slice(1).filter((r) => r[0] === month);
  };
  const col = (id: TabId, name: string) => DATA_TABS.find((d) => d.id === id)!.headers.indexOf(name);
  const sumOf = (rs: Cell[][], ci: number) => rs.reduce((a, r) => a + (r[ci] === "" || r[ci] === undefined ? 0 : toMinor(r[ci])), 0);
  const readBack = {} as Verification["readBack"];
  for (const mode of ["actual", "expected"] as const) {
    const label = MODE_LABEL[mode];
    const s = rows("summary").find((r) => r[1] === label);
    const want = controls[mode];
    if (!s) {
      problems.push(`Monthly Summary has no ${label} row for ${month}`);
      readBack[mode] = { net: NaN, direct: NaN, overheads: NaN, profit: NaN };
      continue;
    }
    const sum = { net: toMinor(s[col("summary", "Net Revenue")]), direct: toMinor(s[col("summary", "Direct Costs")]), overheads: toMinor(s[col("summary", "Overheads")]), profit: toMinor(s[col("summary", "Final Business Profit")]) };
    readBack[mode] = sum;
    for (const k of ["net", "direct", "overheads", "profit"] as const) if (sum[k] !== want[k]) problems.push(`Monthly Summary ${label} ${k} ${formatMinor(sum[k] || 0)} != F18 ${formatMinor(want[k])}`);
    if (sum.net - sum.direct - sum.overheads !== sum.profit) problems.push(`Monthly Summary ${label}: Net - Direct - Overheads != Profit`);
    // detail rows reproduce the same controls (Actual = State Actual; Expected + Actual = Actual + Expected; never Unresolved)
    const inMode = (r: Cell[]) => (mode === "actual" ? r[2] === "Actual" : r[2] === "Actual" || r[2] === "Expected");
    const revNet = sumOf(rows("revenue").filter(inMode), col("revenue", "Net"));
    const direct = sumOf(rows("coach").filter(inMode), col("coach", "Amount")) + sumOf(rows("direct").filter(inMode), col("direct", "Net Cost"));
    const oh = sumOf(rows("overheads").filter(inMode), col("overheads", "Net"));
    if (revNet !== want.net) problems.push(`Hub · Revenue ${label} Net ${formatMinor(revNet || 0)} != F18 ${formatMinor(want.net)}`);
    if (direct !== want.direct) problems.push(`Coach + Direct Costs ${label} ${formatMinor(direct || 0)} != F18 ${formatMinor(want.direct)}`);
    if (oh !== want.overheads) problems.push(`Hub · Overheads ${label} Net ${formatMinor(oh || 0)} != F18 ${formatMinor(want.overheads)}`);
  }
  return { ok: problems.length === 0, problems, readBack };
}

// ---------------------------------------------------------------------
// Connection + run views (never a credential)
// ---------------------------------------------------------------------
export interface ReportingConnection {
  organisationId: string;
  provider: typeof PROVIDER;
  authMode: AuthMode;
  endpoint: Endpoint;
  spreadsheetId: string;
  displayName: string | null;
  schemaVersion: string;
  state: "connected" | "disconnected";
  lastVerifiedAt: string | null;
  lastSyncAttemptAt: string | null;
  lastSyncSuccessAt: string | null;
  lastSyncResult: "succeeded" | "failed" | null;
  lastSyncErrorCode: string | null;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
export interface SyncRun {
  runId: string;
  organisationId: string;
  provider: string;
  endpoint: Endpoint;
  spreadsheetId: string;
  month: string;
  modes: string[];
  schemaVersion: string;
  writerVersion: string;
  actorUserId: string;
  startedAt: string;
  completedAt: string | null;
  result: "running" | "succeeded" | "failed";
  rowCounts: Record<string, unknown> | null;
  controlTotals: Record<string, unknown> | null;
  errorCode: string | null;
  errorSummary: string | null;
}
export const publicConnection = (c: ReportingConnection) => ({
  provider: c.provider,
  providerLabel: "Google Sheets",
  authMode: c.authMode,
  endpoint: c.endpoint,
  endpointLabel: c.endpoint === "sandbox" ? "TEST sheets-sandbox emulator (not real Google)" : "Google Sheets",
  workbook: { spreadsheetId: c.spreadsheetId, displayName: c.displayName },
  schemaVersion: c.schemaVersion,
  state: c.state,
  lastVerifiedAt: c.lastVerifiedAt,
  configuredAt: c.createdAt,
  updatedAt: c.updatedAt,
  revision: c.revision,
});
export const runView = (r: SyncRun) => ({
  runId: r.runId,
  month: r.month,
  modes: r.modes,
  result: r.result,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
  workbook: { spreadsheetId: r.spreadsheetId, endpoint: r.endpoint },
  schemaVersion: r.schemaVersion,
  writerVersion: r.writerVersion,
  actorUserId: r.actorUserId,
  rowCounts: r.rowCounts,
  controlTotals: r.controlTotals,
  error: r.errorCode ? { code: r.errorCode, summary: r.errorSummary } : null,
});
/** Pence controls as money strings for history / audit. */
export const controlView = (c: Controls) => ({
  actual: { netRevenue: formatMinor(c.actual.net), directCosts: formatMinor(c.actual.direct), overheads: formatMinor(c.actual.overheads), finalBusinessProfit: formatMinor(c.actual.profit) },
  expected: { netRevenue: formatMinor(c.expected.net), directCosts: formatMinor(c.expected.direct), overheads: formatMinor(c.expected.overheads), finalBusinessProfit: formatMinor(c.expected.profit) },
});
/** A safe one-line error summary: never a token, key or cell content dump. */
export function safeSummary(s: string): string {
  return s.replace(/(Bearer\s+)\S+/gi, "$1[redacted]").replace(/(rk|sk|ya29|key)[_.-][A-Za-z0-9._-]{8,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 500);
}
export function reportingAuditEvent(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string; context?: Record<string, unknown> }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: REPORTING_CONTRACT } };
}

// ---------------------------------------------------------------------
// Routes + request parsing (the organisation is NEVER chosen in a request)
// ---------------------------------------------------------------------
export type ReportingRoute = { name: "reporting.status" } | { name: "reporting.sync" } | { name: "reporting.configure" } | { name: "reporting.disconnect" };
export type ReportingMatch = { status: "ok"; route: ReportingRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;
const ROUTES: Record<string, { route: ReportingRoute; method: "GET" | "POST" }> = {
  "reporting/google-sheets/status": { route: { name: "reporting.status" }, method: "GET" },
  "reporting/google-sheets/sync": { route: { name: "reporting.sync" }, method: "POST" },
  "reporting/google-sheets/configure": { route: { name: "reporting.configure" }, method: "POST" },
  "reporting/google-sheets/disconnect": { route: { name: "reporting.disconnect" }, method: "POST" },
};
/** F19 owns reporting/...; there is deliberately no route that reads Sheets into the Hub. */
export function matchReportingRoute(path: string, method: string): ReportingMatch {
  if (path !== "reporting" && !path.startsWith("reporting/")) return null;
  const hit = ROUTES[path];
  if (!hit) return { status: "not_found" };
  return method === hit.method ? { status: "ok", route: hit.route } : { status: "method", allowed: [hit.method] };
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });

export function checkReportingQuery(q: URLSearchParams, isTenantKey: (k: string) => boolean): { ok: true } | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  if (keys.length) return invalid("unexpected_query", `Unexpected query parameter(s): ${[...new Set(keys)].join(", ")}`);
  return { ok: true };
}
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
function textOf(v: unknown, max: number): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return { ok: true, value: null };
  if (t.length > max) return { ok: false, error: `must be at most ${max} characters` };
  if (CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

/** POST /reporting/google-sheets/sync { month: "YYYY-MM" } - one month, both modes. */
export function parseSyncBody(raw: string, isTenantKey: (k: string) => boolean): { ok: true; month: string } | Invalid {
  const b = jsonObject(raw, ["month"], isTenantKey, false);
  if (!b.ok) return b;
  const m = typeof b.body.month === "string" ? MONTH_RE.exec(b.body.month) : null;
  if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return invalid("invalid_input", "Some fields are not valid - nothing was synced", { month: "is required: a calendar month YYYY-MM (2000-2100)" });
  return { ok: true, month: b.body.month as string };
}

/** POST /reporting/google-sheets/configure { spreadsheetId, endpoint, displayName?, reason? } - workbook identity ONLY (credentials are platform secrets). */
export function parseConfigureBody(raw: string, isTenantKey: (k: string) => boolean): { ok: true; spreadsheetId: string; endpoint: Endpoint; displayName: string | null; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["spreadsheetId", "endpoint", "displayName", "reason"], isTenantKey, false);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  const id = typeof b.body.spreadsheetId === "string" ? b.body.spreadsheetId.trim() : "";
  if (!SPREADSHEET_ID_PATTERN.test(id)) f.spreadsheetId = "is required: the workbook id from its URL (20-128 letters, digits, - or _)";
  const endpoint = b.body.endpoint;
  if (!(ENDPOINTS as readonly unknown[]).includes(endpoint)) f.endpoint = `is required: one of ${ENDPOINTS.join(", ")}`;
  const name = textOf(b.body.displayName, 200);
  if (!name.ok) f.displayName = name.error;
  const reason = textOf(b.body.reason, REASON_MAX);
  if (!reason.ok) f.reason = reason.error;
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - nothing was saved", f);
  return { ok: true, spreadsheetId: id, endpoint: endpoint as Endpoint, displayName: (name as { value: string | null }).value, reason: (reason as { value: string | null }).value };
}

/** POST /reporting/google-sheets/disconnect { reason? } - the workbook itself is never touched. */
export function parseDisconnectBody(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey, true);
  if (!b.ok) return b;
  const reason = textOf(b.body.reason, REASON_MAX);
  if (!reason.ok) return invalid("invalid_input", "Some fields are not valid - nothing was changed", { reason: reason.error });
  return { ok: true, reason: reason.value };
}
