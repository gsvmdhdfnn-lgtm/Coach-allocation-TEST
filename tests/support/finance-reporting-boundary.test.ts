/**
 * Finance Foundation F20 - Finance Reporting Start Month (the management-reporting boundary).
 * Run: node --experimental-strip-types tests/support/finance-reporting-boundary.test.ts
 *
 * The F20 audit found no authoritative legacy Finance history, so NOTHING is imported. F20 adds one
 * optional F2 setting (reportingStartMonth, "Finance Reporting Start Month") and enforces it as a
 * reporting boundary:
 *   SE  the setting: absent baseline, YYYY-MM validation, access (View / Manage / no grant / Coach /
 *       Parent / module off / tenant keys), audit old -> new, no operational mutation        (tests 1-12)
 *   MR  Month Report: before start = history unavailable (no figures, no source load); start / later
 *       months = F18 unchanged; the start month's previous comparison is unavailable        (tests 13-19)
 *   OV  Finance Overview: pre-start unavailable; the current month unchanged                 (tests 20-21)
 *   SH  F19 Sheets: a pre-start sync is refused before any run / Google call; canonical months
 *       export exactly as before; no fake zero rows                                          (tests 22-24)
 *   BD  boundaries: F17 Cash Flow unchanged; no invoice / payment / Coach Month / supplier /
 *       employment change; no Needs Attention; no legacy tables; no Sheets -> Hub import;
 *       production untouched                                                                  (tests 25-32)
 *   Z   drift (mirrors == canonical; index.ts / NA bundle wiring)
 *
 * The harness (in-memory Finance world, fake finance_reporting_* functions, sheets-sandbox emulator
 * core) is the F19 suite's - the same October 2026 fixtures as F18 / F19. NOW = 2026-10-15 (London).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, SETTINGS_KEYS, toStoredFields } from "./finance-settings.ts";
import { TABLES as F3_TABLES, clientFields, lifecycleCreateFields, serviceFields, termsCreateFields } from "./finance-commercial-mapping.ts";
import { INVOICING_TABLES, lineCreateFields } from "./finance-invoicing-mapping.ts";
import { ISSUE_TABLES, invoiceLineCreateFields } from "./finance-issue-mapping.ts";
import type { CreditNote, Invoice, InvoiceLine } from "./finance-issue.ts";
import type { Line } from "./finance-invoicing.ts";
import { buildFacts } from "./finance-month-report.ts";
import { loadCanonicalMonth, readFinanceOverview, readMonthReport } from "./finance-month-report-orchestrator.ts";
import { getFinanceSettings, updateFinanceSettings } from "./finance-settings-orchestrator.ts";
import { parseUpdateBody } from "./finance-settings.ts";
import { parseMonthReportQuery } from "./finance-month-report.ts";
import { HISTORY_UNAVAILABLE_CODE, REASON_NOT_AUTHORITATIVE, REASON_PREVIOUS_BEFORE_START, boundaryOf, comparisonUnavailable, historyUnavailable, monthBefore, monthLabel, previousMonthBeforeStart } from "./finance-reporting-boundary.ts";
import {
  DATA_TABS,
  ENABLED_AUTH_MODES,
  MANAGED_TITLES,
  OWNERSHIP_MARKER,
  REPORTING_EVENTS,
  SCHEMA_VERSION,
  SYNC_INFO_TAB,
  WRITER_VERSION,
  checkReportingQuery,
  controlsOf,
  matchReportingRoute,
  verifyWrite,
  parseConfigureBody,
  parseDisconnectBody,
  parseSyncBody,
} from "./finance-reporting-sheets.ts";
import { baseUrlFor } from "./finance-reporting-sheets-provider.ts";
import { type ReportingDeps, configureReporting, disconnectReporting, readReportingStatus, syncReporting, tokenFor } from "./finance-reporting-sheets-orchestrator.ts";
import { type FaultMode, type Op, type Spreadsheet, handle, opOf } from "./sheets-sandbox-emulator.ts";
import {
  CLIENT,
  MGR,
  NOW,
  ORG,
  ORG_REC,
  R,
  SA,
  SESS_COACH,
  T_,
  VENUE_BODY,
  agreementNew,
  allocation,
  catNew,
  categorise,
  cashFlow,
  cfFetchLog,
  ck,
  coach,
  coachOcc,
  correctionRow,
  creditNew,
  creditNote,
  deps as worldDeps,
  empNew,
  failed,
  financeMonthRow,
  invoice,
  json,
  mgr,
  monthAct,
  nogrant,
  occ,
  parent,
  pay,
  payment,
  reset,
  setF7,
  supplierNew,
  viewer,
  world,
} from "./finance-cash-flow-world.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test");
const J = (x: unknown) => JSON.stringify(x);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, "0");

// =====================================================================
// sheets-sandbox in memory: the Edge Function's flow over the shared core
// =====================================================================
const SANDBOX_KEY = "sbx_f19_test_key_0123456789abcdef";
const ACCOUNT = "hub-reporting@sheets-sandbox.test";
const BOOK = "SBX_F19_ORG1_WORKBOOK_0001";
const BOOK_B = "SBX_F19_ORG1_WORKBOOK_0002";
const BOOK_ORG2 = "SBX_F19_ORG2_WORKBOOK_0001";
const LEGACY = ["Overview", "Session Ledger", "Coach Costs", "Revenue & Billing", "Other Costs", "Business Overheads", "Monthly Summary", "Setup", "Integration Map", "Cash Events"];
const emu = {
  books: new Map<string, Spreadsheet>(),
  keys: new Map<string, string>([[SANDBOX_KEY, ACCOUNT]]),
  faults: [] as { op: Op; mode: FaultMode; remaining: number }[],
  log: [] as { method: string; path: string; op: Op | null; status: number; note: string }[],
};
function book(id: string, o: { sharedWith?: string[]; legacy?: boolean } = {}): Spreadsheet {
  const sheets = (o.legacy === false ? [] : LEGACY).map((title, i) => ({ sheetId: i + 1, title, index: i, frozenRows: 1, values: [["Josh-style legacy tab", title], ["Formula", `=SUM(B2:B${i + 9})`], ["Note", 100 + i]] as any[][] }));
  const b: Spreadsheet = { spreadsheetId: id, title: `ZZTEST F19 ${id}`, sharedWith: o.sharedWith ?? [ACCOUNT], deleted: false, sheets };
  emu.books.set(id, b);
  return b;
}
const tab = (id: string, title: string) => emu.books.get(id)!.sheets.find((t) => t.title === title);
const grid = (id: string, title: string) => clone(tab(id, title)?.values ?? []);
const fault = (op: Op, mode: FaultMode, remaining = 1) => emu.faults.push({ op, mode, remaining });
function takeFault(op: Op): FaultMode | null {
  const f = emu.faults.find((x) => x.op === op && x.remaining > 0);
  if (!f) return null;
  f.remaining--;
  return f.mode;
}
async function sandbox(url: URL, method: string, init: any): Promise<Response> {
  const path = url.pathname.replace(/^.*\/sheets-sandbox/, "") || "/";
  const m = /^Bearer (.+)$/.exec(init.headers?.Authorization ?? "");
  const account = m ? emu.keys.get(m[1]) ?? null : null;
  const which = opOf(method, path);
  const fm = which ? takeFault(which.op) : null;
  const sheet = which && emu.books.has(which.spreadsheetId) ? clone(emu.books.get(which.spreadsheetId)!) : null;
  const body = method === "POST" ? JSON.parse(init.body || "null") : null;
  const r = handle({ method, path, query: url.searchParams, body, account }, sheet, fm);
  if (r.next && r.spreadsheetId) emu.books.set(r.spreadsheetId, r.next);
  emu.log.push({ method, path, op: r.op, status: r.status, note: r.note });
  return json(r.body, r.status);
}

// =====================================================================
// fake finance_reporting_* (same rules as the TEST SQL f19_finance_reporting_sheets)
// =====================================================================
const RS = { conns: [] as any[], runs: [] as any[], vault: new Map<string, string>(), finishFail: false, rpcLog: [] as string[] };
class Refused19 extends Error {}
const no19: (code: string) => never = (code) => {
  throw new Refused19(`f19:${code}`);
};
const CHK = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`${what} check violation`);
};
function checkConn(c: any) {
  CHK(c.provider === "google_sheets" && ["platform_service_account", "organisation_oauth"].includes(c.auth_mode) && ["sandbox", "google"].includes(c.endpoint), "finance_reporting_connections provider/auth/endpoint");
  CHK(/^[A-Za-z0-9_-]{20,128}$/.test(c.spreadsheet_id) && c.schema_version === "finance_reporting_v1" && ["connected", "disconnected"].includes(c.connection_state) && c.config_revision >= 1, "finance_reporting_connections");
  CHK(c.display_name === null || (c.display_name.length >= 1 && c.display_name.length <= 200), "finance_reporting_connections display_name");
  CHK(!RS.conns.some((x) => x !== c && x.organisation_id === c.organisation_id && x.provider === c.provider), "unique (organisation_id, provider)");
  if (c.connection_state === "connected" && RS.conns.some((x) => x !== c && x.provider === c.provider && x.spreadsheet_id === c.spreadsheet_id && x.connection_state === "connected")) no19("workbook_in_use");
}
function checkRun(r: any) {
  CHK(/^FRS-[0-9A-F]{12}$/.test(r.run_id) && /^[0-9]{4}-(0[1-9]|1[0-2])$/.test(r.requested_month) && J(r.modes) === J(["actual", "expected"]) && ["running", "succeeded", "failed"].includes(r.result), "finance_reporting_sync_runs");
  CHK((r.result === "running") === (r.completed_at === null), "finance_reporting_sync_runs running/completed_at");
  CHK(r.result !== "failed" || r.error_code !== null, "finance_reporting_sync_runs failed/error_code");
  CHK(r.result !== "succeeded" || (r.error_code === null && r.control_totals !== null), "finance_reporting_sync_runs succeeded/control_totals");
  CHK(r.error_summary === null || r.error_summary.length <= 500, "finance_reporting_sync_runs error_summary");
}
function auditOne(e: any, org: string) {
  if (!e || e.organisation_id !== org) no19("audit_missing");
  CHK(/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(e.event_type) && /^[a-z][a-z_]*$/.test(e.entity_type), "audit");
  world.audit.push({ ...clone(e), id: world.audit.length + 1, occurred_at: NOW.toISOString() });
}
function rpc19(fn: string, a: any): unknown {
  RS.rpcLog.push(fn);
  if (fn === "finance_reporting_secret") return ["sandbox", "google"].includes(a.p_endpoint) ? RS.vault.get(`finance_reporting_sheets_${a.p_endpoint}`) ?? null : null;
  if (fn === "finance_reporting_configure") {
    if (!a.p_event || a.p_event.organisation_id !== a.p_organisation_id) no19("audit_missing");
    const old = RS.conns.find((x) => x.organisation_id === a.p_organisation_id && x.provider === "google_sheets");
    if (!old !== (a.p_expected_revision === null) || (old && old.config_revision !== a.p_expected_revision)) no19("connection_changed");
    const c = a.p_connection;
    if (RS.conns.some((x) => x.provider === "google_sheets" && x.spreadsheet_id === c.spreadsheet_id && x.connection_state === "connected" && x.organisation_id !== a.p_organisation_id)) no19("workbook_in_use");
    const same = old && old.spreadsheet_id === c.spreadsheet_id;
    const next = old
      ? { ...old, auth_mode: c.auth_mode, endpoint: c.endpoint, spreadsheet_id: c.spreadsheet_id, display_name: c.display_name, schema_version: c.schema_version, connection_state: "connected", last_verified_at: c.last_verified_at, last_sync_attempt_at: same ? old.last_sync_attempt_at : null, last_sync_success_at: same ? old.last_sync_success_at : null, last_sync_result: same ? old.last_sync_result : null, last_sync_error_code: same ? old.last_sync_error_code : null, config_revision: old.config_revision + 1, updated_at: c.at, updated_by: a.p_actor }
      : { id: `conn-${RS.conns.length + 1}`, organisation_id: a.p_organisation_id, provider: "google_sheets", auth_mode: c.auth_mode, endpoint: c.endpoint, spreadsheet_id: c.spreadsheet_id, display_name: c.display_name, schema_version: c.schema_version, connection_state: "connected", last_verified_at: c.last_verified_at, last_sync_attempt_at: null, last_sync_success_at: null, last_sync_result: null, last_sync_error_code: null, config_revision: 1, created_at: c.at, created_by: a.p_actor, updated_at: c.at, updated_by: a.p_actor };
    const rest = RS.conns.filter((x) => x !== old);
    RS.conns = [...rest, next];
    checkConn(next);
    auditOne(a.p_event, a.p_organisation_id);
    return clone(next);
  }
  if (fn === "finance_reporting_disconnect") {
    if (!a.p_event || a.p_event.organisation_id !== a.p_organisation_id) no19("audit_missing");
    const old = RS.conns.find((x) => x.organisation_id === a.p_organisation_id && x.provider === "google_sheets");
    if (!old || old.config_revision !== a.p_expected_revision || old.connection_state !== "connected") no19("connection_changed");
    Object.assign(old, { connection_state: "disconnected", config_revision: old.config_revision + 1, updated_at: a.p_at, updated_by: a.p_actor });
    auditOne(a.p_event, a.p_organisation_id);
    return clone(old);
  }
  if (fn === "finance_reporting_sync_start") {
    const p = a.p_run;
    const conn = RS.conns.find((x) => x.organisation_id === p.organisation_id && x.provider === "google_sheets");
    if (!conn || conn.connection_state !== "connected" || conn.spreadsheet_id !== p.spreadsheet_id || conn.endpoint !== p.endpoint) no19("connection_changed");
    if (RS.runs.some((r) => r.run_id === p.run_id)) no19("run_exists");
    const run = { run_id: p.run_id, organisation_id: p.organisation_id, provider: p.provider, endpoint: p.endpoint, spreadsheet_id: p.spreadsheet_id, requested_month: p.requested_month, modes: p.modes, schema_version: p.schema_version, writer_version: p.writer_version, actor_user_id: p.actor_user_id, started_at: p.started_at, completed_at: null, result: "running", row_counts: null, control_totals: null, error_code: null, error_summary: null };
    checkRun(run);
    RS.runs.push(run);
    conn.last_sync_attempt_at = p.started_at;
    return p.run_id;
  }
  if (fn === "finance_reporting_sync_finish") {
    if (RS.finishFail) throw new Error("connection reset");
    const run = RS.runs.find((r) => r.run_id === a.p_run_id);
    if (!run) no19("run_not_found");
    if (run.result !== "running") no19("run_is_final");
    if (!a.p_event || a.p_event.organisation_id !== run.organisation_id || a.p_event.record_id !== a.p_run_id) no19("audit_missing");
    const next = { ...run, result: a.p_result, completed_at: a.p_completed_at, row_counts: a.p_row_counts, control_totals: a.p_control_totals, error_code: a.p_error_code, error_summary: a.p_error_summary };
    checkRun(next);
    Object.assign(run, next);
    const conn = RS.conns.find((x) => x.organisation_id === run.organisation_id && x.provider === "google_sheets" && x.spreadsheet_id === run.spreadsheet_id);
    if (conn) Object.assign(conn, { last_sync_result: a.p_result, last_sync_error_code: a.p_result === "failed" ? a.p_error_code : null, last_sync_success_at: a.p_result === "succeeded" ? a.p_completed_at : conn.last_sync_success_at });
    auditOne(a.p_event, run.organisation_id);
    return clone(run);
  }
  throw new Error(`unknown rpc ${fn}`);
}
function rest19(u: URL, method: string): Response {
  const table = u.pathname.split("/").pop() as string;
  // RLS on, no client grants, writes only through the database functions; the history guard refuses UPDATE / DELETE.
  if (method !== "GET") return json({ code: "P0001", message: table === "finance_reporting_sync_runs" ? "f19:history_is_append_only" : "f19:connection_is_kept" }, 400);
  let rows: any[] = clone(table === "finance_reporting_connections" ? RS.conns : RS.runs);
  let order: string | null = null;
  let limit = 0;
  for (const [k, v] of u.searchParams) {
    if (k === "select") continue;
    if (k === "order") order = v;
    else if (k === "limit") limit = Number(v);
    else rows = rows.filter((r) => String(r[k] ?? "") === v.replace(/^eq\./, ""));
  }
  if (order) {
    const keys = order.split(",").map((s) => s.split("."));
    rows.sort((x, y) => {
      for (const [k, dir] of keys) {
        const c = x[k] < y[k] ? -1 : x[k] > y[k] ? 1 : 0;
        if (c) return dir === "desc" ? -c : c;
      }
      return 0;
    });
  }
  return json(limit ? rows.slice(0, limit) : rows);
}
const reportingFetch: string[] = [];
const base = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  if (url.pathname.includes("/functions/v1/sheets-sandbox")) {
    reportingFetch.push(`${method} sheets ${url.pathname.replace(/^.*\/sheets-sandbox/, "")}`);
    return sandbox(url, method, init);
  }
  const m = /\/rest\/v1\/rpc\/(finance_reporting_[a-z_]+)$/.exec(url.pathname);
  if (m) {
    reportingFetch.push(`POST rpc ${m[1]}`);
    try {
      return json(rpc19(m[1], init.body ? JSON.parse(init.body) : {}));
    } catch (e) {
      if (e instanceof Refused19) return json({ code: "P0001", message: (e as Error).message }, 400);
      return json({ message: String(e) }, 500);
    }
  }
  if (/\/rest\/v1\/finance_reporting_(connections|sync_runs)$/.test(url.pathname)) {
    reportingFetch.push(`${method} ${url.pathname.split("/").pop()}`);
    return rest19(url, method);
  }
  return base(input, init);
}) as typeof fetch;

let runN = 0;
let clockN = 0;
const deps: ReportingDeps = { ...(worldDeps as any), clock: () => new Date(NOW.getTime() + ++clockN * 1000), reporting: { random: () => hex(0xf19000 + ++runN) } };
const err = (p: any) => Promise.resolve({ status: "error", ...p } as any);
// request helpers - parse exactly as index.ts does, then orchestrate
const status = (caller: any = mgr, q = ""): Promise<any> => {
  const p = checkReportingQuery(new URLSearchParams(q), isTenantKey);
  return p.ok ? readReportingStatus(deps, caller) : err(p);
};
const configure = (body: unknown, caller: any = mgr, d: ReportingDeps = deps): Promise<any> => {
  const p = parseConfigureBody(typeof body === "string" ? body : J(body), isTenantKey);
  return p.ok ? configureReporting(d, caller, { spreadsheetId: p.spreadsheetId, endpoint: p.endpoint, displayName: p.displayName, reason: p.reason }) : err(p);
};
const disconnect = (body: unknown = {}, caller: any = mgr): Promise<any> => {
  const p = parseDisconnectBody(J(body), isTenantKey);
  return p.ok ? disconnectReporting(deps, caller, { reason: p.reason }) : err(p);
};
const sync = (body: unknown, caller: any = mgr, d: ReportingDeps = deps): Promise<any> => {
  const p = parseSyncBody(typeof body === "string" ? body : J(body), isTenantKey);
  return p.ok ? syncReporting(d, caller, { month: p.month }) : err(p);
};
const report = (month: string, mode: "actual" | "expected"): Promise<any> => readMonthReport(deps, mgr, { month, mode }) as Promise<any>;
/** Every Finance store the writer must never touch (Supabase Finance tables + Airtable). */
const financeState = () => J({ sb: world.sb, at: world.at });
const legacyOf = (id: string) => J(emu.books.get(id)!.sheets.filter((s) => LEGACY.includes(s.title)));
const H = (title: string) => DATA_TABS.find((d) => d.title === title)!.headers;
const colOf = (title: string, name: string) => H(title).indexOf(name);
const rowsOf = (id: string, title: string, month?: string) => grid(id, title).slice(1).filter((r) => r.length && (!month || r[0] === month));
const infoOf = (id: string) => new Map(grid(id, SYNC_INFO_TAB.title).slice(1).map((r) => [r[0], r[1]] as [string, unknown]));
const pence = (v: unknown) => Math.round(Number(v) * 100);
const sumCol = (rows: any[][], ci: number) => rows.reduce((a, r) => a + (r[ci] === "" || r[ci] === undefined ? 0 : pence(r[ci])), 0);
const dataGrids = (id: string) => J(DATA_TABS.map((d) => grid(id, d.title)));
const auditFrom = (n: number) => world.audit.slice(n).filter((e: any) => String(e.event_type).startsWith("finance_reporting."));

// =====================================================================
// Finance fixtures (the F18 October 2026 world, built by each slice's own builders / routes)
// =====================================================================
const T0 = "2026-09-01T09:00:00.000Z";
let rowN = 0;
const rowOf = (fields: Record<string, unknown>) => ({ id: `recF19${String(++rowN).padStart(11, "0")}`, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)) });
const occId = (key: string, date: string) => `OCC-${key}:${date}`;
const vline = (n: number, invoiceId: string, draftId: string, seq: number, occurrenceId: string, date: string, gross: number): InvoiceLine =>
  ({
    lineId: `FVL-${hex(n)}`, invoiceId, sequence: seq, sourceDraftId: draftId, sourceDraftLineId: `FIL-${hex(n)}`, occurrenceId, occurrenceDate: date, sessionId: "ZZ-VENUE-A", sessionName: "ZZTEST Venue A Academy",
    serviceId: "FSV-AAAAAAAAAAAA", serviceName: "ZZTEST F18 Academy", termsId: "FCT-AAAAAAAAAAAA", chargeType: "fixed_per_session", description: `ZZTEST session ${date}`, quantity: 1, quantitySource: "per_session", unitAmountMinor: gross,
    unitAmountSource: "commercial_terms", amountMinor: gross, vatTreatment: "no_vat", vatRateBasisPoints: 0, netMinor: gross, vatMinor: 0, grossMinor: gross, overrideIds: [], snapshot: "{}", createdBy: MGR, createdAt: T0,
  }) as InvoiceLine;
const draftLine = (n: number, occurrenceId: string, date: string, gross: number): Line =>
  ({
    lineId: `FIL-${hex(n)}`, draftId: `FID-${hex(n)}`, status: "included", occurrenceId, occurrenceDate: date, sessionId: "ZZ-VENUE-A", sessionName: "ZZTEST Venue A Academy", serviceId: "FSV-AAAAAAAAAAAA", serviceName: "ZZTEST F18 Academy", termsId: "FCT-AAAAAAAAAAAA",
    chargeType: "fixed_per_session", description: `ZZTEST session ${date}`, quantity: 1, quantitySource: "per_session", unitAmountMinor: gross, unitAmountSource: "commercial_terms", amountMinor: gross, vatTreatment: "no_vat", vatRateBasisPoints: 0,
    netMinor: gross, vatMinor: 0, grossMinor: gross, overrideIds: [], snapshot: "{}", statusReason: null, statusChangedBy: null, statusChangedAt: null, supersededBy: null, createdBy: MGR, createdAt: T0,
  }) as Line;
const ORG2 = "ORG-TEST-002";
const MGR2 = "cccccccc-e0d4-4257-8121-5f16781e97ba";
const mgr2 = { userId: MGR2, role: "management", active: true, organisationId: ORG2 };

async function seed() {
  reset();
  const s = { ...EMPTY_SETTINGS, coachPaymentDayOfFollowingMonth: 20 };
  world.at["Finance Settings"] = [{ id: "recFinSettings001", fields: Object.fromEntries(Object.entries({ "Finance Settings ID": `FINSET-${ORG}`, Organisation: [ORG_REC], ...toStoredFields(s as any, SETTINGS_KEYS), Revision: 1 }).filter(([, v]) => v !== null && v !== undefined)) }];
  world.at["Organisation & Branding"].push({ id: "recORG20000000000", fields: { "Organisation ID": ORG2, "Organisation Name": "Other Org", Timezone: "Europe/London", Active: true } });
  world.grants[MGR2] = [{ organisation_id: ORG2, access_level: "manage", revoked_at: null }];
  const client = { clientId: CLIENT, name: "ZZTEST F18 School", status: "active", billingContactName: null, billingEmail: "billing@school.test", billingCcEmails: [], paymentTermsDaysOverride: null, poRequired: false, billingMethod: "hub", revision: 1, updatedAt: T0 } as any;
  const cRow = rowOf(clientFields(client, { userId: MGR, at: T0 }, ORG_REC));
  const svc = { serviceId: "FSV-AAAAAAAAAAAA", clientId: CLIENT, name: "ZZTEST F18 Academy", status: "active", revision: 1, updatedAt: T0 } as any;
  const sRow = rowOf(serviceFields(svc, { userId: MGR, at: T0 }, { orgRecordId: ORG_REC, clientRecordId: cRow.id }));
  const terms = { termsId: "FCT-AAAAAAAAAAAA", serviceId: svc.serviceId, effectiveFrom: "2026-01-01", effectiveUntil: null, payer: "client", chargeType: "fixed_per_session", amountMinor: 2500, vatTreatment: "no_vat", vatRateBasisPoints: 0, defaultBillableQuantity: null, subscriptionFrequency: null, otherDescription: null } as any;
  world.at[F3_TABLES.clients] = [cRow];
  world.at[F3_TABLES.services] = [sRow];
  world.at[F3_TABLES.terms] = [rowOf(termsCreateFields(terms, { orgRecordId: ORG_REC, serviceRecordId: sRow.id, userId: MGR, at: T0 }))];
  world.at[F3_TABLES.lifecycle] = [rowOf(lifecycleCreateFields({ lifecycleId: "FSL-AAAAAAAAAAAA", serviceId: svc.serviceId, status: "active", effectiveFrom: null, effectiveUntil: null, supersededBy: null, reason: null }, { orgRecordId: ORG_REC, serviceRecordId: sRow.id, userId: MGR, at: T0 }))];
  // F12
  const occSep = coachOcc("OccCSep1", "2026-09-16", "Completed", ["recAllocSep100000"]);
  const occOct1 = coachOcc("OccCOct1", "2026-10-05", "Completed", ["recAllocOct100000"]);
  const occOct2 = coachOcc("OccCOct2", "2026-10-22", "Scheduled", ["recAllocOct200000"]);
  world.at["Session Occurrences"].push(occSep, occOct1, occOct2, occ("OccAS", "2026-09-24", SA, "Completed"));
  world.at["Coach Allocations"] = [allocation("AllocSep1", occSep.id, 40), allocation("AllocOct1", occOct1.id, 45), allocation("AllocOct2", occOct2.id, 30)];
  const FM = financeMonthRow(1, { workMonth: "2026-09", totalMinor: 4000, payDate: "2026-10-20", items: 1 });
  T_("finance_worker_cost_months").push(FM);
  T_("finance_worker_cost_items").push({ organisation_id: ORG, month_id: FM.month_id, allocation_record_id: "recAllocSep100000", allocation_label: "ALLOC-AllocSep1", occurrence_record_id: occSep.id, occurrence_ref: occSep.fields["Occurrence ID"], work_date: "2026-09-16", session_record_id: SESS_COACH, session_name: "ZZTEST F17 Coached Session", finance_service_id: "FSV-AAAAAAAAAAAA", programme_label: "Academy", cost_basis: "paid", rate_type: "Per Session", pay_unit: "Session", paid_units: 1, rate_amount_minor: 4500, override_minor: null, override_reason: null, work_outcome: "Completed", final_cost_minor: 4000, work_summary_ref: null });
  T_("finance_worker_cost_corrections").push(correctionRow(1, FM.month_id, 500, 4500));
  // F13 / F14 / F15 through their real routes
  const VEN = (await supplierNew({ name: "ZZTEST F19 Hall", type: "venue" })).body.supplier.supplierId as string;
  const SOFT = (await supplierNew({ name: "ZZTEST F19 Software", type: "software_service" })).body.supplier.supplierId as string;
  const ven = await agreementNew(VENUE_BODY(VEN));
  const lic = await agreementNew({ supplierId: SOFT, name: "ZZTEST F19 licence", costType: "custom_dates", classification: "general", effectiveFrom: "2026-09-01", instalments: [{ dueDate: "2026-09-05", amount: "50.00" }, { dueDate: "2026-10-03", amount: "50.00" }, { dueDate: "2026-10-25", amount: "40.00", estimated: true }, { dueDate: "2026-11-05", amount: "70.00" }] });
  const SWC = (await catNew({ name: "Software" })).body.category.categoryId as string;
  const SALC = (await catNew({ name: "Salaries" })).body.category.categoryId as string;
  await categorise({ agreementId: lic.body.agreement.agreementId, categoryId: SWC, reason: "ZZTEST licence is software" });
  await pay((lic.body.schedule as any[]).find((i) => i.dueDate === "2026-09-05").instalmentId, "50.00", "2026-09-06");
  await creditNew({ supplierId: VEN, scope: "agreement", agreementId: ven.body.agreement.agreementId, amount: "30.00", creditDate: "2026-10-09", sourceType: "credit_note", sourceReference: "ZZ-F19-CN", reason: "ZZTEST hall unavailable" });
  await creditNew({ supplierId: SOFT, scope: "agreement", agreementId: lic.body.agreement.agreementId, amount: "15.00", creditDate: "2026-10-11", sourceType: "credit_note", sourceReference: "ZZ-F19-SW", reason: "ZZTEST outage credit" });
  const E1 = (await empNew({ name: "ZZTEST F19 Office Manager", categoryId: SALC, annualSalary: "24000.00", payDay: 25, startDate: "2026-09-01" })).body.employment.employmentId as string;
  await empNew({ name: "ZZTEST F19 Groundsman", categoryId: SALC, annualSalary: "12000.00", payDay: 28, startDate: "2026-10-01" });
  await monthAct(E1, "2026-09", "confirm-estimate", { useEstimate: true });
  await monthAct(E1, "2026-09", "payment", { amount: "2000.00", paidDate: "2026-09-25" });
  await monthAct(E1, "2026-10", "confirm-estimate", { useEstimate: true });
  // F5 / F6 / F7
  const INV1 = { ...invoice(1, { gross: 5000 }), lineCount: 2, sourceDraftId: `FID-${hex(901)}` } as Invoice;
  const INV2 = { ...invoice(2, { gross: 2500 }), sourceDraftId: `FID-${hex(902)}` } as Invoice;
  const L1 = vline(11, INV1.invoiceId, INV1.sourceDraftId, 1, occId("OccAS", "2026-09-24"), "2026-09-24", 2500);
  const L2 = vline(12, INV1.invoiceId, INV1.sourceDraftId, 2, occId("OccA0", "2026-10-01"), "2026-10-01", 2500);
  const L3 = vline(21, INV2.invoiceId, INV2.sourceDraftId, 1, occId("OccA1", "2026-10-08"), "2026-10-08", 2500);
  const CN2 = { ...creditNote(2, INV2, 2500, "2026-10-12"), lines: [{ invoiceLineId: L3.lineId, occurrenceId: L3.occurrenceId, netMinor: 2500, vatMinor: 0, grossMinor: 2500 }] } as CreditNote;
  setF7({ invoices: [INV1, INV2], notes: [CN2], payments: [payment(1, INV1, 2500, "2026-10-14")] });
  world.at[ISSUE_TABLES.lines] = [L1, L2, L3].map((l) => rowOf(invoiceLineCreateFields(l, ORG_REC)));
  world.at[INVOICING_TABLES.lines] = [rowOf(lineCreateFields(draftLine(31, occId("OccA2", "2026-10-15"), "2026-10-15", 2500), ORG_REC))];
}

// =====================================================================
// F20: Finance Settings writes (the shared world is read-only for Airtable) - settings lock, row PATCH, audit
// =====================================================================
const SW = { patches: [] as any[], otherAirtableWrites: [] as string[], lockHeld: null as string | null, auditN: 0 };
const base20 = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (url.includes("/rpc/acquire_finance_settings_lock")) {
    if (body?.p_organisation_id !== ORG && body?.p_organisation_id !== ORG2) return json({ message: "wrong org" }, 400);
    if (SW.lockHeld) return json(null);
    SW.lockHeld = "44444444-4444-4444-8444-444444444444";
    return json(SW.lockHeld);
  }
  if (url.includes("/rpc/release_finance_settings_lock")) {
    const ok = body?.p_lock_token === SW.lockHeld;
    if (ok) SW.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rest/v1/finance_audit_events") && method === "POST") {
    world.audit.push({ ...clone(body), id: `aud-${++SW.auditN}`, occurred_at: NOW.toISOString() });
    return json([{ id: `aud-${SW.auditN}` }], 201);
  }
  if (url.startsWith("https://api.airtable.com/") && method !== "GET") {
    const t = decodeURIComponent(new URL(url).pathname.split("/")[3] ?? "");
    if (t !== "Finance Settings") {
      SW.otherAirtableWrites.push(`${method} ${t}`);
      return json({ error: "F20 must not write this table" }, 418);
    }
    const id = new URL(url).pathname.split("/")[4];
    const rows = world.at["Finance Settings"] as any[];
    if (method === "PATCH") {
      const r = rows.find((x) => x.id === id);
      if (!r) return json({ error: "NOT_FOUND" }, 404);
      for (const [k, v] of Object.entries(body.fields)) {
        if (v === null) delete r.fields[k];
        else r.fields[k] = v;
      }
      SW.patches.push(clone(body.fields));
      return json(clone(r));
    }
    return json({ error: "unexpected settings write" }, 418);
  }
  return base20(input, init);
}) as typeof fetch;

const settingsGet = (caller: any = mgr): Promise<any> => getFinanceSettings(deps as any, caller) as Promise<any>;
const settingsSet = (body: unknown, caller: any = mgr): Promise<any> => {
  const p = parseUpdateBody(typeof body === "string" ? body : J(body), isTenantKey);
  return p.ok ? (updateFinanceSettings(deps as any, caller, p) as Promise<any>) : err(p);
};
const setStart = (v: string | null) => settingsSet({ settings: { reportingStartMonth: v }, reason: `ZZTEST F20 start month ${v}` });
const mr = (month: string | undefined, mode: "actual" | "expected" = "actual", caller: any = mgr, q?: string): Promise<any> => {
  if (q !== undefined) {
    const p = parseMonthReportQuery("month.report", new URLSearchParams(q), isTenantKey);
    return p.ok ? (readMonthReport(deps, caller, { month: p.month, mode: p.mode }) as Promise<any>) : err(p);
  }
  return readMonthReport(deps, caller, { month, mode }) as Promise<any>;
};
let naCalls = 0;
const naStub = async () => {
  naCalls++;
  return { status: "ok" as const, state: "clear", total: 0, counts: {}, suppressed: 0, complete: true };
};
const ov = (month?: string, caller: any = mgr): Promise<any> => readFinanceOverview(deps, caller, { month }, naStub) as Promise<any>;
/** A report body without its volatile / F20-only fields - what F18 itself produced. */
const f18Of = (b: any) => {
  const { generatedAt, reportingState, financeReportingStartMonth, comparison, ...rest } = b;
  return J(rest);
};
const ovF18Of = (b: any) => {
  const { reportingState, financeReportingStartMonth, ...rest } = b;
  return J(rest);
};
/** Every operational Finance store (Supabase + Airtable) except the Finance Settings row itself. */
const operationalState = () => J({ sb: world.sb, at: Object.fromEntries(Object.entries(world.at).filter(([k]) => k !== "Finance Settings")), runs: RS.runs, conns: RS.conns, books: [...emu.books.entries()] });
const settingsAudit = () => world.audit.filter((e: any) => String(e.event_type).startsWith("finance_settings."));

const base0: Record<string, any> = {};

async function baseline() {
  // no start month: the F18 / F19 behaviour every later check is compared with
  const s = await settingsGet();
  ck("SE1. Setting absent (baseline): GET /settings shows reportingStartMonth null; completeness does not require it; the Month Report is canonical for every month with financeReportingStartMonth null and the normal previous-month comparison", s.status === "ok" && s.body.settings.reportingStartMonth === null && !s.body.completeness.missing.includes("reportingStartMonth"), J(s.body?.settings));
  for (const m of ["2026-09", "2026-10", "2026-11"]) for (const mode of ["actual", "expected"] as const) base0[`${m}:${mode}`] = (await mr(m, mode)).body;
  base0.ov = (await ov()).body;
  base0.ovSep = (await ov("2026-09")).body;
  base0.cf = (await cashFlow({ range: "3m" })).body;
  const sep = base0["2026-09:actual"];
  ck("SE1b. ... (baseline Month Report) every month canonical; the comparison is the normal F18 one", ["2026-09", "2026-10", "2026-11"].every((m) => base0[`${m}:actual`].reportingState === "canonical" && base0[`${m}:actual`].financeReportingStartMonth === null && typeof base0[`${m}:actual`].comparison.netRevenue === "object") && sep.overall && sep.comparison.previousMonth === "2026-08", J(sep.comparison));
  // F19 baseline: connect the workbook and export October with no boundary
  RS.vault.set("finance_reporting_sheets_sandbox", SANDBOX_KEY);
  book(BOOK);
  const c = await configure({ spreadsheetId: BOOK, endpoint: "sandbox" });
  const sy = await sync({ month: "2026-10" });
  base0.grids = dataGrids(BOOK);
  ck("SH0. (baseline) workbook connected and October exported with no start month set", c.httpStatus === 201 && sy.httpStatus === 200 && rowsOf(BOOK, "Hub · Monthly Summary", "2026-10").length === 2, J([c.code, sy.code]));
}

async function setting() {
  const op0 = operationalState();
  const a0 = settingsAudit().length;
  const set = await setStart("2026-10");
  const ev = settingsAudit().slice(a0);
  ck("SE2. Finance Manage sets a valid YYYY-MM -> 200; stored as Finance Reporting Start Month = 2026-10; revision advanced", set.status === "ok" && set.body.settings.reportingStartMonth === "2026-10" && (world.at["Finance Settings"] as any[])[0].fields["Finance Reporting Start Month"] === "2026-10" && set.body.revision === 2, J([set.code, set.body?.settings?.reportingStartMonth]));
  ck("SE11. Audit: exactly one finance_settings.updated event - before.settings.reportingStartMonth null -> after 2026-10, changedFields [reportingStartMonth], the reason, actor = the manager, organisation-scoped", ev.length === 1 && ev[0].event_type === "finance_settings.updated" && ev[0].before.settings.reportingStartMonth === null && ev[0].after.settings.reportingStartMonth === "2026-10" && J(ev[0].context.changedFields) === J(["reportingStartMonth"]) && ev[0].reason === "ZZTEST F20 start month 2026-10" && ev[0].actor_user_id === MGR && ev[0].organisation_id === ORG, J(ev));
  const bad = await Promise.all(["2026-13", "2026-9", "Sep 2026", "1999-12", "2101-01", "2026-10-01", 202610, true].map((v) => settingsSet({ settings: { reportingStartMonth: v } })));
  ck("SE3. Invalid month (2026-13, 2026-9, 'Sep 2026', 1999-12, 2101-01, a date, a number, a boolean) -> 400 invalid_settings, field error on reportingStartMonth; nothing saved", bad.every((r) => r.httpStatus === 400 && r.code === "invalid_settings" && /YYYY-MM/.test(r.fields?.reportingStartMonth ?? "")) && (world.at["Finance Settings"] as any[])[0].fields["Finance Reporting Start Month"] === "2026-10", J(bad.map((r) => [r.code, r.fields?.reportingStartMonth])));
  const v = await settingsGet(viewer);
  ck("SE4. Finance View reads the setting (GET /settings, access view)", v.status === "ok" && v.body.access === "view" && v.body.settings.reportingStartMonth === "2026-10");
  const vw = await settingsSet({ settings: { reportingStartMonth: "2026-09" } }, viewer);
  ck("SE5. Finance View cannot change it -> 403 finance_manage_required; unchanged", vw.httpStatus === 403 && vw.code === "finance_manage_required" && (await settingsGet()).body.settings.reportingStartMonth === "2026-10");
  const ch = await setStart("2026-11");
  const back = await setStart("2026-10");
  ck("SE6. Finance Manage changes it (2026-10 -> 2026-11 -> 2026-10), each an audited revision", ch.status === "ok" && ch.body.settings.reportingStartMonth === "2026-11" && back.status === "ok" && back.body.settings.reportingStartMonth === "2026-10" && settingsAudit().length === a0 + 3 && settingsAudit().slice(-1)[0].before.settings.reportingStartMonth === "2026-11");
  const ng = await Promise.all([settingsGet(nogrant), settingsSet({ settings: { reportingStartMonth: "2026-09" } }, nogrant), mr("2026-10", "actual", nogrant)]);
  ck("SE7. No Finance grant -> 403 finance_access_denied (settings read / write, Month Report)", ng.every((r) => r.httpStatus === 403 && r.code === "finance_access_denied"), J(ng.map((r) => r.code)));
  const cp = await Promise.all([settingsGet(coach), settingsSet({ settings: { reportingStartMonth: "2026-09" } }, parent), mr("2026-09", "actual", coach), ov("2026-09", parent)]);
  ck("SE8. Coach / Parent -> 403 management_required (settings, Month Report, Overview)", cp.every((r) => r.httpStatus === 403 && r.code === "management_required"), J(cp.map((r) => r.code)));
  world.moduleOn = false;
  const off = await Promise.all([settingsGet(), setStart("2026-09"), mr("2026-09"), ov("2026-09")]);
  world.moduleOn = true;
  ck("SE9. Finance module off -> 403 finance_module_disabled (settings, Month Report, Overview)", off.every((r) => r.httpStatus === 403 && r.code === "finance_module_disabled"), J(off.map((r) => r.code)));
  const t = await Promise.all([settingsSet({ settings: { reportingStartMonth: "2026-09" }, organisationId: ORG2 }), settingsSet({ settings: { reportingStartMonth: "2026-09", organisationId: ORG2 } }), mr(undefined, "actual", mgr, "month=2026-09&organisationId=ORG-TEST-002")]);
  ck("SE10. Tenant override rejected (body / settings / query organisationId -> 400 tenant_param_rejected); nothing changed", t.every((r) => r.httpStatus === 400 && r.code === "tenant_param_rejected") && (await settingsGet()).body.settings.reportingStartMonth === "2026-10", J(t.map((r) => r.code)));
  const o2 = await settingsGet(mgr2);
  ck("SE10b. Organisation-scoped: ORG-TEST-002 does not see ORG-TEST-001's start month (no settings row) and its Month Report is unbounded", o2.status === "ok" && o2.body.settings.reportingStartMonth === null && (await mr("2026-09", "actual", mgr2)).body.reportingState === "canonical");
  ck("SE12. Setting changes mutate no operational Finance data: every store except the Finance Settings row is byte-identical; the only Airtable write is the Finance Settings row", operationalState() === op0 && SW.otherAirtableWrites.length === 0 && SW.patches.every((p) => J(Object.keys(p).sort()) === J(["Finance Reporting Start Month", "Last Changed At", "Last Changed By User ID", "Revision"])), J([SW.otherAirtableWrites, SW.patches.map((p) => Object.keys(p))]));
}

async function monthReport() {
  const reads0 = world.airtableReads.length;
  const cf0 = cfFetchLog.length;
  const pre = await mr("2026-09");
  const preReads = world.airtableReads.slice(reads0);
  const b = pre.body;
  ck("MR13. Month before start (2026-09) -> 200 reportingState history_unavailable, source pre_hub, financeReportingStartMonth 2026-10, reason hub_finance_not_authoritative_for_period, plain message", pre.httpStatus === 200 && b.reportingState === "history_unavailable" && b.source === "pre_hub" && b.financeReportingStartMonth === "2026-10" && b.reason === REASON_NOT_AUTHORITATIVE && b.month === "2026-09" && b.message === "Hub Finance records start from October 2026. There is no Hub Finance report for September 2026." && b.access === "manage" && b.organisation.organisationId === ORG, J(b));
  const noFig = ["overall", "programmes", "overheads", "comparison", "unattributed", "reconciliation", "completeness", "revenueCorrections", "excluded", "state"].every((k) => !(k in b)) && b.figures === null && !/netRevenue|finalBusinessProfit|directCosts|"0\.00"/.test(J(b));
  ck("MR16. No fake zero report before start: no overall / programmes / overheads / comparison / reconciliation, figures null, no money value at all - although September HAS canonical data (the baseline showed it)", noFig && base0["2026-09:actual"].overall.netRevenue !== undefined, J(Object.keys(b)));
  const preSb = cfFetchLog.slice(cf0);
  ck("MR16b. ... and no Finance source was even read for it (only Feature Controls / organisation / Finance Settings and the caller's grant; no ledgers, invoices, occurrences, Stripe)", preReads.every((t) => ["Feature Controls", "Organisation & Branding", "Finance Settings"].includes(t)) && preSb.every((x) => /finance_access_grants|\/(Organisation & Branding|Feature Controls|Finance Settings)$/.test(x)), J([preReads, preSb]));
  const preE = await mr("2026-09", "expected");
  ck("MR13b. ... Expected mode too (mode echoed, still no figures)", preE.httpStatus === 200 && preE.body.reportingState === "history_unavailable" && preE.body.mode === "expected" && preE.body.figures === null && !("overall" in preE.body));
  const far = await mr("2025-06");
  ck("MR13c. Any earlier month (2025-06): the same history-unavailable state", far.body.reportingState === "history_unavailable" && far.body.message === "Hub Finance records start from October 2026. There is no Hub Finance report for June 2025.");
  for (const mode of ["actual", "expected"] as const) {
    const st = await mr("2026-10", mode);
    const lt = await mr("2026-11", mode);
    ck(`MR14/15/17 (${mode}). Start month 2026-10 and later month 2026-11 are canonical F18 (reportingState canonical, financeReportingStartMonth 2026-10) - every figure byte-identical to the no-boundary baseline (overall, programmes, overheads, reconciliation, completeness)`, st.body.reportingState === "canonical" && st.body.financeReportingStartMonth === "2026-10" && lt.body.reportingState === "canonical" && f18Of(st.body) === f18Of(base0[`2026-10:${mode}`]) && f18Of(lt.body) === f18Of(base0[`2026-11:${mode}`]));
    const cmp = st.body.comparison;
    ck(`MR18 (${mode}). First canonical month: previous-month comparison unavailable (available false, previousMonth 2026-09, reason previous_month_before_reporting_start) - never compared with anything outside Hub Finance`, cmp.available === false && cmp.previousMonth === "2026-09" && cmp.reason === REASON_PREVIOUS_BEFORE_START && cmp.financeReportingStartMonth === "2026-10" && cmp.mode === mode && !("netRevenue" in cmp) && !("finalBusinessProfit" in cmp) && cmp.message === "No previous-month comparison: Hub Finance records start from October 2026.", J(cmp));
    ck(`MR19 (${mode}). A later canonical month (2026-11 vs 2026-10): comparison byte-identical to F18's`, J(lt.body.comparison) === J(base0[`2026-11:${mode}`].comparison) && typeof lt.body.comparison.netRevenue === "object");
  }
  const earlier = await setStart("2026-01");
  const e9 = await mr("2026-09");
  ck("MR20x. Moving the start month EARLIER (2026-01) exposes the canonical F18 calculation for those months - September is F18 again (identical figures and comparison), nothing invented", earlier.status === "ok" && e9.body.reportingState === "canonical" && f18Of(e9.body) === f18Of(base0["2026-09:actual"]) && J(e9.body.comparison) === J(base0["2026-09:actual"].comparison));
  await setStart(null);
  const cleared = await mr("2026-10");
  ck("MR20y. Clearing the setting restores the baseline exactly (no boundary; comparison back to F18's)", cleared.body.financeReportingStartMonth === null && f18Of(cleared.body) === f18Of(base0["2026-10:actual"]) && J(cleared.body.comparison) === J(base0["2026-10:actual"].comparison));
  await setStart("2026-10");
}

async function overview() {
  const na0 = naCalls;
  const pre = await ov("2026-09");
  ck("OV20. Overview for a month before start (2026-09) -> 200 history_unavailable, metrics null; no figures, no Needs Attention call, no upcoming payments / cash summary presented as that month", pre.httpStatus === 200 && pre.body.reportingState === "history_unavailable" && pre.body.metrics === null && pre.body.financeReportingStartMonth === "2026-10" && !("upcomingPayments" in pre.body) && !("cashSummary" in pre.body) && !/"0\.00"/.test(J(pre.body)) && naCalls === na0 && base0.ovSep.metrics.netRevenue !== undefined, J(pre.body));
  const cur = await ov();
  ck("OV21. Current / default month (2026-10, the start month) unchanged: canonical, every metric / completeness / Upcoming Payments / cash summary byte-identical to the baseline", cur.body.reportingState === "canonical" && cur.body.financeReportingStartMonth === "2026-10" && ovF18Of(cur.body) === ovF18Of(base0.ov), J([cur.body.metrics, base0.ov.metrics]));
}

async function sheets() {
  const runs0 = RS.runs.length;
  const log0 = emu.log.length;
  const book0 = J(emu.books.get(BOOK));
  const a0 = world.audit.length;
  const r = await sync({ month: "2026-09" });
  ck("SH22. F19 sync of a month before start -> 409 reporting_history_unavailable with the plain message; no run row, no Google request, no audit event, workbook byte-identical", r.httpStatus === 409 && r.code === HISTORY_UNAVAILABLE_CODE && /Hub Finance records start from October 2026/.test(r.error) && r.details?.reportingState === "history_unavailable" && RS.runs.length === runs0 && emu.log.length === log0 && J(emu.books.get(BOOK)) === book0 && world.audit.length === a0, J([r.httpStatus, r.code, r.error]));
  const direct = await loadCanonicalMonth(deps, mgr, { organisationId: ORG, recordId: ORG_REC, name: "x", timezone: "Europe/London" } as any, "2026-09");
  ck("SH22b. Defence in depth: loadCanonicalMonth itself refuses a pre-start month (409 reporting_history_unavailable) - nothing can export one", (direct as any).status === "error" && (direct as any).code === HISTORY_UNAVAILABLE_CODE);
  const ok = await sync({ month: "2026-10" });
  ck("SH23. F19 sync of the start month works unchanged: succeeded, every Hub tab byte-identical to the no-boundary export", ok.httpStatus === 200 && ok.body.result === "succeeded" && dataGrids(BOOK) === base0.grids, J([ok.httpStatus, ok.code]));
  ck("SH24. No fake zero Sheet rows: no Hub tab holds any 2026-09 row", DATA_TABS.every((d) => rowsOf(BOOK, d.title, "2026-09").length === 0));
}

async function boundaries() {
  const cf = await cashFlow({ range: "3m" });
  await setStart("2026-12");
  const cfFuture = await cashFlow({ range: "3m" });
  const curFuture = await ov();
  await setStart("2026-10");
  const strip = (b: any) => J({ ...b, generatedAt: undefined });
  ck("BD25. F17 Cash Flow unchanged by the start month (2026-10, and a future 2026-12): byte-identical to the baseline", strip(cf.body) === strip(base0.cf) && strip(cfFuture.body) === strip(base0.cf));
  ck("BD25b. A start month after today (2026-12) is a reporting boundary for the current month too (Overview history_unavailable) - documented; Cash Flow still unaffected", curFuture.body.reportingState === "history_unavailable" && curFuture.body.financeReportingStartMonth === "2026-12");
  const sb = world.sb as Record<string, any[]>;
  ck("BD26-28. No invoice / payment / receivable / Coach Month / supplier / employment record was created or changed by any F20 action (operational stores byte-identical to before the boundary was first set, apart from F19's own run history)", OP_BEFORE === J({ sb: world.sb, at: Object.fromEntries(Object.entries(world.at).filter(([k]) => k !== "Finance Settings")) }) && SW.otherAirtableWrites.length === 0 && Object.keys(sb).length > 0);
  const naSrc = ["needs-attention.ts", "registry.ts", "money-out.ts", "cash-flow.ts", "finance.ts", "finance-drafts.ts", "orchestrator.ts"].map((f) => readFileSync(join(CANON, "needs-attention", f), "utf8")).join("\n");
  ck("BD29. Needs Attention: no rule reads the start month and F20 adds no case or catalogue row (no needs-attention source mentions reportingStartMonth / history_unavailable)", !/reportingStartMonth|history_unavailable|Finance Reporting Start Month/.test(naSrc));
  const all = ["finance-reporting-boundary.ts", "finance-month-report-orchestrator.ts", "finance-reporting-sheets-orchestrator.ts", "finance-settings.ts", "index.ts"].map((f) => readFileSync(join(CANON, "finance", f), "utf8")).join("\n");
  ck("BD30. No legacy-history tables, import batches or CSV / Google import routes exist (no finance_legacy_* / import_batch / legacy-finance route anywhere in the Finance function)", !/finance_legacy|import_batch|legacy-finance|legacy_months/.test(all));
  const bnd = readFileSync(join(CANON, "finance", "finance-reporting-boundary.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ck("BD31. No Sheets -> Hub import: the boundary module is pure (no fetch / Deno / Supabase / Airtable / Sheets provider) and the Month Report orchestrator never imports the Sheets provider", !/fetch\(|Deno\.|createClient|airtable|sheets/i.test(bnd) && !/finance-reporting-sheets/.test(readFileSync(join(CANON, "finance", "finance-month-report-orchestrator.ts"), "utf8")));
  const f20Code = ["finance-reporting-boundary.ts", "finance-month-report-orchestrator.ts", "finance-reporting-sheets-orchestrator.ts", "finance-settings.ts"].map((f) => readFileSync(join(CANON, "finance", f), "utf8")).join("\n");
  ck("BD32. Production untouched: no production base / project id in the F20-touched modules (index.ts keeps its existing refuse-to-run-on-production guard); tests run against TEST ids only", !/apprptFotQuVL1mhs|bkkukymqaxawnudoxdjs/.test(f20Code) && /PRODUCTION_SUPABASE_REFS = \["bkkukymqaxawnudoxdjs"\]/.test(all) && (deps as any).airtable.baseId === "appQktredAuGa1X7e");
}

async function pure() {
  ck("P1. boundaryOf: null start = canonical; month < start = history_unavailable; month == / > start = canonical", boundaryOf(null, "2000-01").state === "canonical" && boundaryOf("2026-10", "2026-09").state === "history_unavailable" && boundaryOf("2026-10", "2026-10").state === "canonical" && boundaryOf("2026-10", "2027-01").state === "canonical" && boundaryOf("2026-10", "2025-12").state === "history_unavailable");
  ck("P2. previousMonthBeforeStart only for the start month itself (and never without a start month); January start wraps to the previous December", previousMonthBeforeStart("2026-10", "2026-10") && !previousMonthBeforeStart("2026-10", "2026-11") && !previousMonthBeforeStart(null, "2026-10") && previousMonthBeforeStart("2027-01", "2027-01") && monthBefore("2027-01") === "2026-12");
  ck("P3. Plain wording: monthLabel 2026-09 -> 'September 2026'; historyUnavailable carries no figures", monthLabel("2026-09") === "September 2026" && historyUnavailable("2025-06", "2026-09").figures === null && comparisonUnavailable("2026-09", "actual", "2026-09").available === false);
}

async function drift() {
  const mirror = (f: string) => {
    const canon = readFileSync(join(CANON, "finance", f), "utf8").replace(/from "\.\/orchestrator\.ts"/g, 'from "./finance-orchestrator.ts"').replace(/from "\.\/repository\.ts"/g, 'from "./finance-repository.ts"');
    const copy = readFileSync(join(HERE, f), "utf8");
    return copy.slice(copy.indexOf("/**", 3)) === canon || copy === canon;
  };
  ck("Z1. Test copies == canonical (finance-reporting-boundary.ts, finance-settings.ts, finance-month-report-orchestrator.ts, finance-reporting-sheets-orchestrator.ts; only import paths adjusted)", ["finance-reporting-boundary.ts", "finance-settings.ts", "finance-month-report-orchestrator.ts", "finance-reporting-sheets-orchestrator.ts"].every(mirror));
  const idx = readFileSync(join(CANON, "finance", "index.ts"), "utf8");
  ck("Z2. index.ts documents the F20 boundary; no new route (settings stay POST /settings)", /F20 reporting boundary/.test(idx) && !/legacy-finance|legacy-history/.test(idx));
  const na = readFileSync(join(HERE, "..", "..", "scripts", "build-needs-attention-bundle.mjs"), "utf8");
  ck("Z3. The needs-attention bundle shares finance-settings.ts (so its artifact is rebuilt with the new key) and does NOT include the boundary or Month Report modules", /"finance-settings\.ts"/.test(na) && !/finance-reporting-boundary|finance-month-report/.test(na));
}

let OP_BEFORE = "";
async function main() {
  await seed();
  await baseline();
  OP_BEFORE = J({ sb: world.sb, at: Object.fromEntries(Object.entries(world.at).filter(([k]) => k !== "Finance Settings")) });
  await setting();
  await monthReport();
  await overview();
  await sheets();
  await boundaries();
  await pure();
  await drift();
}

main()
  .then(() => {
    for (const [s, n, x] of R) console.log(`${s}  ${n}${s === "FAIL" && x ? `  -- ${x}` : ""}`);
    const passed = R.filter((r) => r[0] === "PASS").length;
    console.log(`\n${passed}/${R.length} checks passed`);
    if (failed) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
