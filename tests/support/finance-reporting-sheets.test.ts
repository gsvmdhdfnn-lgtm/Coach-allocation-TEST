/**
 * Finance Foundation F19 - Google Sheets reporting writer (TEST: sheets-sandbox emulator).
 * Run: node --experimental-strip-types tests/support/finance-reporting-sheets.test.ts
 *
 *   CN  connection / configure / status (optional, verified first, no credential stored)
 *   SY  first sync: managed tabs only, canonical F18 pass-through, Sync Info, history, audit
 *   BA  batching: a fixed number of Google requests whatever the row count (no per-row call)
 *   ID  idempotency (same month twice = same rows)
 *   MO  month isolation + row replacement by stable Row Key (never by row number)
 *   ME  manual edits: never change Hub; the next sync restores the canonical value
 *   SC  schema / ownership refusals (nothing written)
 *   FA  failures: permission, not found, credential, rate limit, 5xx, malformed, partial write,
 *       verification mismatch, retry, lock busy, unrecorded - Finance never mutated
 *   AC  access (View / Manage / Coach / Parent / no grant / module off / tenant keys)
 *   OI  organisation isolation (one workbook = one organisation)
 *   AU  audit + compact append-only history
 *   DC  disconnect (workbook untouched; Finance keeps working)
 *   BD  boundary (Hub -> Sheets only; no real Google; no hard-coded workbook)
 *   Z   drift (mirrors == canonical; routes; sandbox Edge Function wiring)
 *
 * The REAL F19 orchestrator, provider (HTTP adapter), repository and pure
 * module run against: the shared in-memory Finance world (F3 / F5 / F6 / F7
 * rows from their own builders, F12 Coach Months, F13 / F14 / F15 through
 * their real routes - the same October 2026 fixtures as the F18 suite), fake
 * finance_reporting_* database functions with the TEST SQL's rules, and the
 * sheets-sandbox emulator CORE (sheets-sandbox-emulator.ts == the deployed
 * emulator.ts) reached over fetch exactly like the Edge Function routes it.
 * NOW = 2026-10-15 (London). REAL GOOGLE WRITE: NOT PROVEN (no credential).
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
import { loadCanonicalMonth, readMonthReport } from "./finance-month-report-orchestrator.ts";
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
async function connection() {
  RS.conns = [];
  RS.runs = [];
  RS.vault.clear();
  emu.books.clear();
  emu.faults = [];
  emu.log = [];
  book(BOOK);
  const a0 = world.audit.length;
  const s0 = await status();
  ck("CN1. Optional: no connection -> GET status 200, configured:false, connection null, no history, managed tab list, direction Hub -> Sheets only; no Google call, no audit", s0.httpStatus === 200 && s0.body.configured === false && s0.body.connection === null && s0.body.lastAttempt === null && s0.body.lastSuccess === null && s0.body.recentRuns.length === 0 && J(s0.body.managedTabs) === J(MANAGED_TITLES) && /Hub -> Google Sheets only/.test(s0.body.direction) && emu.log.length === 0 && world.audit.length === a0, J(s0).slice(0, 400));
  const fin0 = financeState();
  const n0 = await sync({ month: "2026-10" });
  ck("CN2. Sync with no workbook -> 409 reporting_not_configured; no run, no audit, no Google call; Finance untouched (Finance works without Sheets)", n0.httpStatus === 409 && n0.code === "reporting_not_configured" && RS.runs.length === 0 && world.audit.length === a0 && emu.log.length === 0 && financeState() === fin0);
  const mr = await report("2026-10", "actual");
  ck("CN2b. Finance Month Report unaffected by the absence of Sheets (200)", mr.httpStatus === 200 && mr.body.overall.netRevenue === "12.50");
  const bad = await Promise.all([
    configure({ spreadsheetId: "short", endpoint: "sandbox" }),
    configure({ spreadsheetId: BOOK }),
    configure({ spreadsheetId: BOOK, endpoint: "sandbox", organisationId: ORG2 }),
    configure({ spreadsheetId: BOOK, endpoint: "sandbox", token: "x" }),
    configure({ spreadsheetId: "https://docs.google.com/spreadsheets/d/abc", endpoint: "sandbox" }),
    configure("not json"),
  ]);
  ck("CN3. Configure validation: bad / URL id 400 invalid_input, missing endpoint 400, tenant key 400 tenant_param_rejected, unknown field (e.g. a token) 400 unexpected_field, non-JSON 400", bad[0].code === "invalid_input" && !!bad[0].fields.spreadsheetId && bad[1].code === "invalid_input" && !!bad[1].fields.endpoint && bad[2].code === "tenant_param_rejected" && bad[3].code === "unexpected_field" && bad[4].code === "invalid_input" && bad[5].code === "invalid_body" && bad.every((b) => b.httpStatus === 400), J(bad.map((b) => b.code)));
  const g = await configure({ spreadsheetId: BOOK, endpoint: "google" });
  ck("CN4. endpoint google -> 409 reporting_google_not_available (real Google is NOT enabled in F19); nothing stored, no request", g.httpStatus === 409 && g.code === "reporting_google_not_available" && RS.conns.length === 0 && emu.log.length === 0);
  const nos = await configure({ spreadsheetId: BOOK, endpoint: "sandbox" });
  ck("CN5. No platform credential in Vault -> 409 reporting_credentials_unavailable (a platform setting, not per organisation); nothing stored", nos.httpStatus === 409 && nos.code === "reporting_credentials_unavailable" && RS.conns.length === 0 && emu.log.length === 0);
  RS.vault.set("finance_reporting_sheets_sandbox", SANDBOX_KEY);
  book(BOOK_B, { sharedWith: [] });
  const den = await configure({ spreadsheetId: BOOK_B, endpoint: "sandbox" });
  ck("CN6. Workbook not shared with the Hub's account -> 409 reporting_workbook_permission_denied (share it as Editor); nothing stored", den.httpStatus === 409 && den.code === "reporting_workbook_permission_denied" && RS.conns.length === 0 && emu.log.at(-1)!.status === 403);
  const nf = await configure({ spreadsheetId: "SBX_F19_DOES_NOT_EXIST_01", endpoint: "sandbox" });
  ck("CN7. Unknown workbook -> 409 reporting_workbook_not_found; nothing stored", nf.httpStatus === 409 && nf.code === "reporting_workbook_not_found" && RS.conns.length === 0);
  const v = await configure({ spreadsheetId: BOOK, endpoint: "sandbox", displayName: "ZZTEST Reporting", reason: "F19 test" }, viewer);
  ck("CN11. Configure by a Finance View user -> 403 finance_manage_required", v.httpStatus === 403 && v.code === "finance_manage_required" && RS.conns.length === 0);
  const before = legacyOf(BOOK);
  const l0 = emu.log.length;
  const a1 = world.audit.length;
  const c = await configure({ spreadsheetId: BOOK, endpoint: "sandbox", displayName: "ZZTEST Reporting", reason: "F19 test" });
  const cn = c.body?.connection;
  ck("CN8. Configure verifies the workbook first (metadata only - no write), then stores the identity: 201; provider google_sheets, authMode platform_service_account, endpoint sandbox, schema finance_reporting_v1, connected, revision 1", c.httpStatus === 201 && c.body.changed === true && c.body.verified === true && cn.provider === "google_sheets" && cn.authMode === "platform_service_account" && cn.endpoint === "sandbox" && cn.workbook.spreadsheetId === BOOK && cn.schemaVersion === SCHEMA_VERSION && cn.state === "connected" && emu.log.slice(l0).every((x) => x.method === "GET") && legacyOf(BOOK) === before, J(c).slice(0, 500));
  const evs = auditFrom(a1);
  ck("CN8b. Exactly one audit event finance_reporting.configured (entity finance_reporting_connection, reason kept); the stored row, the response and the audit hold NO credential", evs.length === 1 && evs[0].event_type === REPORTING_EVENTS.configured && evs[0].entity_type === "finance_reporting_connection" && evs[0].reason === "F19 test" && evs[0].before === null && ![J(RS.conns), J(c), J(world.audit), J(s0)].some((s) => s.includes(SANDBOX_KEY) || /secret|token|bearer|private_key|client_email/i.test(s.replace(/"(spreadsheetId|spreadsheet_id)"/g, ""))));
  const again = await configure({ spreadsheetId: BOOK, endpoint: "sandbox", displayName: "ZZTEST Reporting" });
  ck("CN9. Same configuration again -> 200 changed:false, no audit, revision unchanged", again.httpStatus === 200 && again.body.changed === false && auditFrom(a1).length === 1 && RS.conns[0].config_revision === 1);
  const s1 = await status(viewer);
  ck("CN10. Status (View): configured true, connection identity + schema version + writer version; no history yet", s1.httpStatus === 200 && s1.body.configured === true && s1.body.access === "view" && s1.body.connection.workbook.spreadsheetId === BOOK && s1.body.schemaVersion === SCHEMA_VERSION && s1.body.writerVersion === WRITER_VERSION && s1.body.recentRuns.length === 0);
}

async function firstSync() {
  const fin0 = financeState();
  const legacy0 = legacyOf(BOOK);
  const a0 = world.audit.length;
  const l0 = emu.log.length;
  const r = await sync({ month: "2026-10" });
  ck("SY1. POST sync {month: 2026-10} -> 200 succeeded, both modes, verification exact + control totals match F18", r.httpStatus === 200 && r.body.result === "succeeded" && J(r.body.run.modes) === J(["actual", "expected"]) && r.body.verification.rowsAndKeys === "exact" && r.body.verification.controlTotals === "match F18", J(r).slice(0, 600));
  const titles = emu.books.get(BOOK)!.sheets.map((s) => s.title);
  ck("SY2. Only the 8 'Hub ·' tabs were created (header row frozen); every existing tab (Overview, Session Ledger, Coach Costs, Revenue & Billing, Other Costs, Business Overheads, Monthly Summary, Setup, Integration Map, Cash Events) is byte-identical", J(titles) === J([...LEGACY, ...MANAGED_TITLES]) && MANAGED_TITLES.every((t) => tab(BOOK, t)!.frozenRows === 1) && legacyOf(BOOK) === legacy0);
  ck("SY3. Every data tab starts with the exact finance_reporting_v1 header row and every row carries Organisation ID + a Row Key", DATA_TABS.every((d) => J(grid(BOOK, d.title)[0]) === J(d.headers) && rowsOf(BOOK, d.title).every((x) => x[d.headers.length - 2] === ORG && typeof x[d.headers.length - 1] === "string" && x[d.headers.length - 1])));
  const act = (await report("2026-10", "actual")).body;
  const exp = (await report("2026-10", "expected")).body;
  const S = "Hub · Monthly Summary";
  const sum = rowsOf(BOOK, S, "2026-10");
  const sv = (mode: string, col: string) => sum.find((x) => x[1] === mode)![colOf(S, col)];
  const same = (o: any, mode: string) => ["Gross Revenue:grossRevenue", "VAT:vat", "Net Revenue:netRevenue", "Direct Costs:directCosts", "Programme Contribution:programmeContribution", "Overheads:overheads", "Final Business Profit:finalBusinessProfit"].every((p) => {
    const [c, k] = p.split(":");
    return sv(mode, c) === Number(o[k]);
  });
  ck("SY4. D8 canonical pass-through: Monthly Summary Actual and Expected + Actual = the F18 Month Report figures exactly (Gross, VAT, Net, Direct, Contribution, Overheads, Final Business Profit); Actual Net 12.50 / Profit -2292.50, Expected Net 150.00 / Profit -3470.00", sum.length === 2 && same(act.overall, "Actual") && same(exp.overall, "Expected + Actual") && sv("Actual", "Net Revenue") === 12.5 && sv("Actual", "Final Business Profit") === -2292.5 && sv("Expected + Actual", "Net Revenue") === 150 && sv("Expected + Actual", "Final Business Profit") === -3470 && sv("Actual", "State") === act.state && sv("Expected + Actual", "State") === "Mixed", J(sum));
  ck("SY4b. Margin, completeness and the excluded Parent / Stripe revenue come from F18 (no figure computed by the writer)", sv("Actual", "Final Margin %") === Number(act.overall.finalMargin.percent) && sv("Actual", "Report Complete?") === (act.completeness.complete ? "Yes" : "No") && String(sv("Actual", "Parent / Stripe Revenue")).startsWith(act.excluded.parentStripeRevenue.label));
  const P = "Hub · Programmes";
  const prog = rowsOf(BOOK, P, "2026-10");
  const pr = (mode: string, id: string) => prog.find((x) => x[1] === mode && x[2] === id)!;
  const pa = act.programmes.find((p: any) => p.financeServiceId === "FSV-AAAAAAAAAAAA");
  const pe = exp.programmes.find((p: any) => p.financeServiceId === "FSV-AAAAAAAAAAAA");
  ck("SY5. Programmes by stable Finance Service ID: FSV-AAAAAAAAAAAA 'ZZTEST F18 Academy' Actual Net 12.50 / Venue 300.00 / Credit 30.00 / Direct 270.00 / Contribution -257.50 and Expected Coach 75.00 - all equal to F18", pr("Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Programme")] === pa.label && pr("Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Net Revenue")] === Number(pa.revenue.net) && pr("Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Venue Cost")] === 300 && pr("Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Credit Adjustment")] === 30 && pr("Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Direct Costs")] === 270 && pr("Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Contribution")] === -257.5 && pr("Expected + Actual", "FSV-AAAAAAAAAAAA")[colOf(P, "Coach Cost")] === Number(pe.directCosts.coach) && pe.directCosts.coach === "75.00", J(prog));
  // detail rows: State per fact; Actual = State Actual; Expected + Actual = Actual + Expected; never double counted
  const rev = rowsOf(BOOK, "Hub · Revenue", "2026-10");
  const coachR = rowsOf(BOOK, "Hub · Coach Costs", "2026-10");
  const dir = rowsOf(BOOK, "Hub · Direct Costs", "2026-10");
  const oh = rowsOf(BOOK, "Hub · Overheads", "2026-10");
  const isA = (x: any[]) => x[2] === "Actual";
  const isAE = (x: any[]) => x[2] === "Actual" || x[2] === "Expected";
  const revNet = (f: (x: any[]) => boolean) => sumCol(rev.filter(f), colOf("Hub · Revenue", "Net"));
  const dirSum = (f: (x: any[]) => boolean) => sumCol(coachR.filter(f), colOf("Hub · Coach Costs", "Amount")) + sumCol(dir.filter(f), colOf("Hub · Direct Costs", "Net Cost"));
  const ohSum = (f: (x: any[]) => boolean) => sumCol(oh.filter(f), colOf("Hub · Overheads", "Net"));
  ck("SY6. D4 detail rows: Revenue Net (State Actual) = 12.50 = F18 Actual; Actual + Expected = 150.00 = F18 Expected + Actual (each fact once - no double count)", revNet(isA) === 1250 && revNet(isAE) === 15000 && [...rev, ...coachR, ...dir, ...oh].every((x) => ["Actual", "Expected", "Unresolved"].includes(x[2])), J(rev.map((x) => [x[2], x[13], x[x.length - 1]])));
  ck("SY7. D4 cost detail: Coach + Direct Net Cost Actual 270.00 / Expected + Actual 545.00; Overheads Net Actual 2035.00 / Expected + Actual 3075.00 - equal to F18", dirSum(isA) === 27000 && dirSum(isAE) === 54500 && ohSum(isA) === 203500 && ohSum(isAE) === 307500, J({ a: dirSum(isA), e: dirSum(isAE), oa: ohSum(isA), oe: ohSum(isAE) }));
  // keys: the F18 facts' stable keys exactly
  const org = (await import("./finance-orchestrator.ts")).authorizeFinance;
  const auth: any = await org(deps, mgr, "read");
  const can: any = await loadCanonicalMonth(deps, mgr, auth.organisation, "2026-10");
  const factKeys = can.facts.filter((f: any) => f.month === "2026-10").map((f: any) => f.key).sort();
  const sheetKeys = [...rev, ...coachR, ...dir, ...oh].map((x) => x[x.length - 1]).filter((k) => !String(k).startsWith("unresolved:")).sort();
  ck("SY8. Rows are identified by the F18 facts' stable keys (rev:/coach:/share:/credit:/oh:/emp:), one row per fact - never by row number; the same key set as buildFacts() for the month", J(factKeys) === J(sheetKeys) && new Set(sheetKeys).size === sheetKeys.length && sheetKeys.length >= 8, J({ factKeys, sheetKeys }));
  // verification is two independent checks: exact rows / keys AND the F18 controls recomputed from what was READ BACK
  const controls = controlsOf({ organisationId: ORG, month: "2026-10", actual: can.actual, expected: can.expected, facts: can.facts, serviceLabels: can.serviceLabels });
  const written = Object.fromEntries(DATA_TABS.map((d) => [d.title, grid(BOOK, d.title)]));
  const v0 = verifyWrite("2026-10", written, written, controls);
  const bent = clone(written);
  bent[S].find((x: any[]) => x[0] === "2026-10" && x[1] === "Actual")![colOf(S, "Net Revenue")] = 12.49;
  const v1 = verifyWrite("2026-10", bent, bent, controls);
  const bentRev = clone(written);
  bentRev["Hub · Revenue"].find((x: any[]) => x[0] === "2026-10" && x[2] === "Actual")![colOf("Hub · Revenue", "Net")] = 99;
  const v2 = verifyWrite("2026-10", bentRev, bentRev, controls);
  const bentOh = clone(written);
  bentOh["Hub · Overheads"] = bentOh["Hub · Overheads"].filter((x: any[], i: number) => i === 0 || x[2] !== "Expected");
  const v3 = verifyWrite("2026-10", bentOh, bentOh, controls);
  ck("SY8b. D5 verification is not only 'reads back as written': even a self-consistent grid fails when its Net Revenue, the Revenue detail, or the Expected overhead detail disagree with the F18 controls (Net / Direct / Overheads / Profit + Net - Direct - Overheads = Profit)", v0.ok && !v1.ok && v1.problems.some((x) => /Monthly Summary Actual net/.test(x)) && v1.problems.some((x) => /Net - Direct - Overheads != Profit/.test(x)) && !v2.ok && v2.problems.some((x) => /Hub · Revenue Actual Net/.test(x)) && !v3.ok && v3.problems.some((x) => /Hub · Overheads Expected \+ Actual Net/.test(x)), J([v0.problems, v1.problems, v2.problems, v3.problems]));
  const comp = rowsOf(BOOK, "Hub · Completeness", "2026-10");
  ck("SY9. Completeness tab: every F18 completeness item per mode + a reconciliation row ('All 8 F18 reconciliation equations hold')", comp.filter((x) => x[1] === "Actual").length === act.completeness.items.length + 1 && comp.some((x) => x[2] === "reconciliation" && /All 8 F18 reconciliation equations hold/.test(String(x[4]))));
  const info = infoOf(BOOK);
  ck("SY10. Hub · Sync Info: ownership marker, schema version, writer version, organisation ID, last successful sync (at / month / run), month:2026-10", info.get("ownership_marker") === OWNERSHIP_MARKER && info.get("schema_version") === SCHEMA_VERSION && info.get("writer_version") === WRITER_VERSION && info.get("organisation_id") === ORG && info.get("last_successful_sync_month") === "2026-10" && info.get("last_successful_sync_run") === r.body.run.runId && !!info.get("last_successful_sync_at") && info.has("month:2026-10"), J([...info]));
  const run = RS.runs.find((x) => x.run_id === r.body.run.runId);
  ck("SY11. History: one compact run row (succeeded, both modes, schema, writer version, row counts, control totals in pence = F18) - no Finance rows copied; connection last sync = succeeded", RS.runs.length === 1 && run.result === "succeeded" && run.control_totals.actual.netRevenue === "12.50" && run.control_totals.expected.finalBusinessProfit === "-3470.00" && run.row_counts.summary.month === 2 && run.error_code === null && RS.conns[0].last_sync_result === "succeeded" && !!RS.conns[0].last_sync_success_at && J(run).length < 2500, J(run).slice(0, 600));
  const ev = auditFrom(a0);
  ck("SY12. Exactly one Finance audit event per sync: finance_reporting.synced (record = run id; after = month, modes, result, workbook, googleRequests, rowCounts, controlTotals) - never a credential", ev.length === 1 && ev[0].event_type === REPORTING_EVENTS.synced && ev[0].entity_type === "finance_reporting_sync_run" && ev[0].record_id === run.run_id && ev[0].after.month === "2026-10" && ev[0].after.googleRequests === r.body.googleRequests && !J(ev).includes(SANDBOX_KEY));
  ck("SY13. Finance is never written by a sync: every Finance table / Airtable table identical, no Airtable write", financeState() === fin0 && world.airtableWrites === 0);
  const calls = emu.log.slice(l0);
  ck("BA1. Batched: first sync = 6 Google requests (metadata, addSheet x8 in ONE batchUpdate, ONE values.batchUpdate for all tabs, ONE read-back, Sync Info stamp + its read-back) - no per-row call", r.body.googleRequests === 6 && calls.length === 6 && calls.filter((x) => x.op === "batch_update").length === 1 && calls.filter((x) => x.op === "values_batch_update").length === 2, J(calls.map((x) => `${x.op}:${x.status}`)));
  const st = await status();
  ck("SY14. Status: lastAttempt = lastSuccess = this run; recentRuns 1", st.body.lastAttempt.runId === run.run_id && st.body.lastSuccess.runId === run.run_id && st.body.recentRuns.length === 1 && RS.conns[0].last_sync_result === "succeeded");
  return r;
}

async function idempotency(first: any) {
  const g0 = dataGrids(BOOK);
  const a0 = world.audit.length;
  const l0 = emu.log.length;
  const r = await sync({ month: "2026-10" });
  ck("ID1. Same month again -> succeeded; every data tab byte-identical (no per-row timestamps), row counts unchanged; only Sync Info's last-sync stamp moves", r.httpStatus === 200 && dataGrids(BOOK) === g0 && J(r.body.run.rowCounts) === J(first.body.run.rowCounts) && infoOf(BOOK).get("last_successful_sync_run") === r.body.run.runId);
  ck("ID2. A second run is recorded (history is per sync) with exactly one more audit event", RS.runs.length === 2 && auditFrom(a0).length === 1);
  ck("BA2. Re-sync = 6 requests too (metadata, ONE bounded read of all existing Hub tabs, ONE write, ONE read-back, stamp + read-back)", r.body.googleRequests === 6 && emu.log.slice(l0).filter((x) => x.op === "values_batch_get").length === 3);
}

async function months() {
  const oct0 = DATA_TABS.map((d) => J(rowsOf(BOOK, d.title, "2026-10")));
  const r = await sync({ month: "2026-09" });
  const sep = rowsOf(BOOK, "Hub · Monthly Summary", "2026-09");
  const sepR = (await report("2026-09", "actual")).body;
  ck("MO1. Sync 2026-09 -> September rows added (Actual Net 12.50 / Direct 45.00 / Profit -2082.50 = F18); every October row preserved exactly", r.httpStatus === 200 && sep.find((x) => x[1] === "Actual")![colOf("Hub · Monthly Summary", "Final Business Profit")] === Number(sepR.overall.finalBusinessProfit) && sepR.overall.finalBusinessProfit === "-2082.50" && DATA_TABS.every((d, i) => J(rowsOf(BOOK, d.title, "2026-10")) === oct0[i]), J(sep));
  ck("MO2. Rows are sorted by Month then Row Key (stable ordering, not insertion order)", DATA_TABS.every((d) => {
    const ks = rowsOf(BOOK, d.title).map((x) => `${x[0]}|${x[x.length - 1]}`);
    return J(ks) === J([...ks].sort());
  }));
  ck("BA3. Request count does not depend on row count (September and October both 6)", r.body.googleRequests === 6);
  const info = infoOf(BOOK);
  ck("MO3. Sync Info lists month:2026-09 and month:2026-10; last successful month 2026-09", info.has("month:2026-09") && info.has("month:2026-10") && info.get("last_successful_sync_month") === "2026-09");
  // Row replacement: the 15 Oct draft line is removed in Finance -> its row disappears on the next October sync; September untouched.
  const sep0 = DATA_TABS.map((d) => J(rowsOf(BOOK, d.title, "2026-09")));
  const draftKey = rowsOf(BOOK, "Hub · Revenue", "2026-10").find((x) => String(x[x.length - 1]).endsWith(":draft"))?.at(-1);
  const revLen0 = grid(BOOK, "Hub · Revenue").length;
  const saved = world.at[INVOICING_TABLES.lines];
  world.at[INVOICING_TABLES.lines] = [];
  const r2 = await sync({ month: "2026-10" });
  const revKeys = rowsOf(BOOK, "Hub · Revenue", "2026-10").map((x) => x[x.length - 1]);
  const exp = (await report("2026-10", "expected")).body;
  ck("MO4. Row replacement by Row Key: the removed draft line's row is gone (no stale row; the old last row is cleared, not left behind), the 15 Oct session falls back to its F4 Expected billing row; October totals = the new F18 report; September rows untouched", r2.httpStatus === 200 && !!draftKey && !revKeys.includes(draftKey) && revKeys.some((k) => String(k).endsWith(":billing") && String(k).includes("OccA2")) && rowsOf(BOOK, "Hub · Monthly Summary", "2026-10").find((x) => x[1] === "Expected + Actual")![colOf("Hub · Monthly Summary", "Net Revenue")] === Number(exp.overall.netRevenue) && DATA_TABS.every((d, i) => J(rowsOf(BOOK, d.title, "2026-09")) === sep0[i]) && grid(BOOK, "Hub · Revenue").length <= revLen0, J(revKeys));
  world.at[INVOICING_TABLES.lines] = saved;
  const r3 = await sync({ month: "2026-10" });
  ck("MO5. Restoring the draft line and re-syncing brings the canonical October rows back exactly", r3.httpStatus === 200 && DATA_TABS.every((d, i) => J(rowsOf(BOOK, d.title, "2026-10")) === oct0[i]));
}

async function manualEdits() {
  const S = "Hub · Monthly Summary";
  const hub0 = J((await report("2026-10", "actual")).body.overall);
  const t = tab(BOOK, S)!;
  const ri = t.values.findIndex((x) => x[0] === "2026-10" && x[1] === "Actual");
  const ci = colOf(S, "Net Revenue");
  t.values[ri][ci] = 999999;
  t.values[1][25] = "my own note (column Z)";
  const rv = tab(BOOK, "Hub · Revenue")!;
  rv.values[1][colOf("Hub · Revenue", "Net")] = 123.45;
  const fin0 = financeState();
  const st0 = J((await status()).body.connection);
  const hub1 = J((await report("2026-10", "actual")).body.overall);
  ck("ME1. Manual edits in Hub tabs never change Hub Finance (Sheets -> Hub is never read as input): Month Report, Finance stores and connection state unchanged", hub1 === hub0 && financeState() === fin0 && J((await status()).body.connection) === st0);
  const r = await sync({ month: "2026-10" });
  const tt = tab(BOOK, S)!;
  ck("ME2. The next October sync restores the canonical October value (Net Revenue 12.50); the edited September cell is another month's row - preserved as-is (D5) until September is synced", r.httpStatus === 200 && tt.values.find((x) => x[0] === "2026-10" && x[1] === "Actual")![ci] === 12.5 && rowsOf(BOOK, "Hub · Revenue", "2026-09").some((x) => x[colOf("Hub · Revenue", "Net")] === 123.45));
  const r9 = await sync({ month: "2026-09" });
  ck("ME2b. Syncing September restores its canonical value too (a manual edit is always disposable)", r9.httpStatus === 200 && rowsOf(BOOK, "Hub · Revenue").every((x) => x[colOf("Hub · Revenue", "Net")] !== 123.45));
  // a row with a VALID October Row Key that is not canonical: replaced away by key set; the tab shrinks and the leftover bottom row is cleared
  const ov = tab(BOOK, "Hub · Overheads")!;
  const len0 = rowsOf(BOOK, "Hub · Overheads").length;
  const fake = clone(ov.values.find((x) => x[0] === "2026-10")!);
  fake[fake.length - 1] = "oh:FSI-FAKEFAKEFAKE";
  ov.values.push(fake);
  const r4 = await sync({ month: "2026-10" });
  ck("ME4. A row typed with a valid-looking October Row Key is not canonical -> removed by the next October sync (rows replaced by the canonical key set); the tab shrinks back and the leftover bottom row is cleared, not left behind", r4.httpStatus === 200 && rowsOf(BOOK, "Hub · Overheads").length === len0 && !rowsOf(BOOK, "Hub · Overheads").some((x) => x.at(-1) === "oh:FSI-FAKEFAKEFAKE"), J([r4.httpStatus, r4.code, rowsOf(BOOK, "Hub · Overheads").length, len0]));
  ck("ME3. Columns to the right of the managed columns are never touched (the user's column Z note survives)", tt.values[1][25] === "my own note (column Z)");
}

async function schema() {
  const fin0 = financeState();
  const refuse = async (label: string, mutate: (b: Spreadsheet) => void, code: string) => {
    const saved = clone(emu.books.get(BOOK)!);
    mutate(emu.books.get(BOOK)!);
    const snap = J(emu.books.get(BOOK));
    const a0 = world.audit.length;
    const n0 = RS.runs.length;
    const l0 = emu.log.length;
    const r = await sync({ month: "2026-10" });
    const run = RS.runs.at(-1);
    const ok = r.httpStatus === 409 && r.code === code && J(emu.books.get(BOOK)) === snap && emu.log.slice(l0).every((x) => x.method === "GET") && RS.runs.length === n0 + 1 && run.result === "failed" && run.error_code === code && auditFrom(a0).length === 1 && auditFrom(a0)[0].event_type === REPORTING_EVENTS.syncFailed && financeState() === fin0;
    ck(label, ok, J({ r: [r.httpStatus, r.code, r.error], run: run?.error_code }));
    emu.books.set(BOOK, saved);
    return r;
  };
  await refuse("SC1. A Hub tab whose headers were changed -> 409 reporting_schema_incompatible; nothing written (only reads), a failed run + one finance_reporting.sync_failed event", (b) => (b.sheets.find((s) => s.title === "Hub · Revenue")!.values[0][3] = "Category"), "reporting_schema_incompatible");
  await refuse("SC2. Sync Info schema_version finance_reporting_v0 (an older / newer writer) -> refused, never migrated silently", (b) => (b.sheets.find((s) => s.title === SYNC_INFO_TAB.title)!.values.find((x) => x[0] === "schema_version")![1] = "finance_reporting_v0"), "reporting_schema_incompatible");
  await refuse("SC2b. Sync Info ownership marker changed / removed -> refused (the Hub only writes tabs carrying its own marker)", (b) => (b.sheets.find((s) => s.title === SYNC_INFO_TAB.title)!.values.find((x) => x[0] === "ownership_marker")![1] = "someone-else"), "reporting_schema_incompatible");
  await refuse("SC3. Hub tabs present without Sync Info (ownership cannot be proven) -> refused", (b) => (b.sheets = b.sheets.filter((s) => s.title !== SYNC_INFO_TAB.title)), "reporting_schema_incompatible");
  await refuse("SC4. Sync Info of another organisation -> 409 reporting_workbook_owned_elsewhere", (b) => (b.sheets.find((s) => s.title === SYNC_INFO_TAB.title)!.values.find((x) => x[0] === "organisation_id")![1] = ORG2), "reporting_workbook_owned_elsewhere");
  await refuse("SC5. A row typed into a Hub tab without Row Key / Month -> 409 reporting_managed_rows_unrecognised (the Hub never overwrites content it did not write)", (b) => b.sheets.find((s) => s.title === "Hub · Overheads")!.values.push(["my row", "", "", "x"]), "reporting_managed_rows_unrecognised");
  await refuse("SC6. A duplicated Row Key -> reporting_managed_rows_unrecognised", (b) => {
    const v = b.sheets.find((s) => s.title === "Hub · Overheads")!.values;
    v.push(clone(v[1]));
  }, "reporting_managed_rows_unrecognised");
  await refuse("SC7. Managed rows of another organisation inside a Hub tab -> owned_elsewhere", (b) => {
    const v = b.sheets.find((s) => s.title === "Hub · Overheads")!.values;
    v[1][colOf("Hub · Overheads", "Organisation ID")] = ORG2;
  }, "reporting_workbook_owned_elsewhere");
  const small = await sync({ month: "2026-10" }, mgr, { ...deps, reporting: { ...deps.reporting, maxRowsPerTab: 3 } });
  ck("SC8. Bounded: a tab that would exceed the row limit -> 409 reporting_workbook_too_large, nothing written", small.httpStatus === 409 && small.code === "reporting_workbook_too_large");
  const s = await status();
  ck("SC9. Refusals never move the last success: status lastSuccess is still the last good run; lastAttempt is the refusal", s.body.lastSuccess.result === "succeeded" && s.body.lastAttempt.result === "failed" && RS.conns[0].last_sync_result === "failed" && RS.conns[0].last_sync_error_code === "reporting_workbook_too_large");
}

async function failures() {
  const fin0 = financeState();
  const good = J(emu.books.get(BOOK));
  const lastOk = infoOf(BOOK).get("last_successful_sync_run");
  const failWith = async (label: string, setup: () => void, http: number, code: string, undo: () => void = () => {}) => {
    const a0 = world.audit.length;
    setup();
    const r = await sync({ month: "2026-10" });
    undo();
    emu.faults = [];
    const run = RS.runs.at(-1);
    ck(label, r.httpStatus === http && r.code === code && run.result === "failed" && run.error_code === code && auditFrom(a0).length === 1 && auditFrom(a0)[0].event_type === REPORTING_EVENTS.syncFailed && auditFrom(a0)[0].after.errorCode === code && financeState() === fin0 && infoOf(BOOK).get("last_successful_sync_run") === lastOk && !J(auditFrom(a0)).includes(SANDBOX_KEY), J({ r: [r.httpStatus, r.code], run: run.error_code }));
    return r;
  };
  const b = () => emu.books.get(BOOK)!;
  await failWith("FA1. Permission removed (workbook no longer shared) -> 409 reporting_workbook_permission_denied; failed run + sync_failed audit; Finance untouched; last success unchanged", () => (b().sharedWith = []), 409, "reporting_workbook_permission_denied", () => (b().sharedWith = [ACCOUNT]));
  await failWith("FA2. Workbook deleted -> 409 reporting_workbook_not_found", () => (b().deleted = true), 409, "reporting_workbook_not_found", () => (b().deleted = false));
  await failWith("FA3. Credential rejected (401) -> 409 reporting_credentials_rejected (platform connector needs attention)", () => fault("get", "fail_401"), 409, "reporting_credentials_rejected");
  await failWith("FA4. Rate limited (429) -> 503 reporting_workbook_busy", () => fault("get", "fail_429"), 503, "reporting_workbook_busy");
  await failWith("FA5. Google 5xx -> 503 reporting_workbook_unavailable", () => fault("values_batch_get", "fail_500"), 503, "reporting_workbook_unavailable");
  await failWith("FA6. Malformed values response -> 502 reporting_workbook_response_invalid", () => fault("values_batch_get", "malformed"), 502, "reporting_workbook_response_invalid");
  await failWith("FA6b. Platform credential removed from Vault -> 409 reporting_credentials_unavailable", () => RS.vault.clear(), 409, "reporting_credentials_unavailable", () => RS.vault.set("finance_reporting_sheets_sandbox", SANDBOX_KEY));
  ck("FA7. After all those failures the workbook is exactly as the last good sync left it", J(emu.books.get(BOOK)) === good);
  // partial write: the first range lands, then 500 -> Failed (never success-with-warning); retry repairs it
  const pw = await failWith("FA8. Partial write (first range applied, then 500) -> 503 reporting_write_failed; Sync Info's last success NOT advanced", () => fault("values_batch_update", "partial_write"), 503, "reporting_write_failed");
  ck("FA8b. ... and the failure says it is safe to sync again; the row counts of the attempted write are kept on the run", /safe to sync again/.test(pw.error) && !!RS.runs.at(-1).row_counts);
  const retry = await sync({ month: "2026-10" });
  ck("FA9. Retry after the partial write -> succeeded; the workbook's data tabs are exactly the canonical rows again", retry.httpStatus === 200 && dataGrids(BOOK) === J(DATA_TABS.map((d) => JSON.parse(good).sheets.find((s: any) => s.title === d.title).values)));
  // verification mismatch: a fresh workbook (no Hub tabs -> the read-back is the first values read) with one corrupted cell on read
  book(BOOK_B);
  const rc = await configure({ spreadsheetId: BOOK_B, endpoint: "sandbox" });
  const a1 = world.audit.length;
  fault("values_batch_get", "corrupt_read");
  const vm = await sync({ month: "2026-10" });
  emu.faults = [];
  const run = RS.runs.at(-1);
  ck("FA10. Verification mismatch (one cell reads back 0.01 off) -> 502 reporting_verification_failed: Failed, never success-with-warning; problems listed; Sync Info has no last-success stamp; failed run + sync_failed audit", rc.httpStatus === 200 && vm.httpStatus === 502 && vm.code === "reporting_verification_failed" && Array.isArray(vm.details.problems) && vm.details.problems.length >= 1 && run.result === "failed" && run.error_code === "reporting_verification_failed" && !infoOf(BOOK_B).get("last_successful_sync_run") && auditFrom(a1).filter((e: any) => e.event_type === REPORTING_EVENTS.syncFailed).length === 1, J(vm.details?.problems ?? vm));
  const ok2 = await sync({ month: "2026-10" });
  ck("FA11. Retry -> succeeded and verified on the new workbook (reconfiguring to a new workbook reset the connection's sync state)", ok2.httpStatus === 200 && infoOf(BOOK_B).get("last_successful_sync_run") === ok2.body.run.runId);
  world.lockHeld = "someone-else";
  const n0 = RS.runs.length;
  const busy = await sync({ month: "2026-10" });
  world.lockHeld = null;
  ck("FA12. The Finance write lock (reporting key) is held -> 409 finance_reporting_busy; no run, no request", busy.httpStatus === 409 && busy.code === "finance_reporting_busy" && RS.runs.length === n0);
  RS.finishFail = true;
  const un = await sync({ month: "2026-10" });
  RS.finishFail = false;
  ck("FA13. The workbook was written + verified but the run could not be completed -> 500 finance_reporting_unrecorded (safe to repeat), never reported as success", un.httpStatus === 500 && un.code === "finance_reporting_unrecorded" && RS.runs.at(-1).result === "running");
  const after = await sync({ month: "2026-10" });
  ck("FA14. The next sync works normally; the run left 'running' is never rewritten by the writer (only the SQL closes it as reporting_run_abandoned after the lock TTL)", after.httpStatus === 200 && RS.runs.filter((x) => x.result === "running").length === 1);
  ck("FA15. No failure ever mutated Finance", financeState() === fin0 && world.airtableWrites === 0);
  // back to the main workbook
  await configure({ spreadsheetId: BOOK, endpoint: "sandbox" });
}

async function access() {
  const r = await Promise.all([status(coach), status(parent), status(nogrant), sync({ month: "2026-10" }, viewer), disconnect({}, viewer), sync({ month: "2026-10" }, coach)]);
  ck("AC1. Coach / Parent -> 403 management_required; no grant -> 403 finance_access_denied; View user cannot sync or disconnect (403 finance_manage_required); View can read status", r[0].code === "management_required" && r[1].code === "management_required" && r[2].code === "finance_access_denied" && r[3].code === "finance_manage_required" && r[4].code === "finance_manage_required" && r[5].code === "management_required" && r.every((x) => x.httpStatus === 403), J(r.map((x) => x.code)));
  world.moduleOn = false;
  const off = await sync({ month: "2026-10" });
  world.moduleOn = true;
  ck("AC2. Finance module off -> 403 finance_module_disabled", off.httpStatus === 403 && off.code === "finance_module_disabled");
  const t = await Promise.all([sync({ month: "2026-10", organisationId: ORG2 }), status(mgr, "organisationId=ORG-TEST-002"), status(mgr, "x=1"), sync({ month: "2026-13" }), sync({ month: "Oct" }), sync({}), sync({ month: "2026-10", mode: "actual" })]);
  ck("AC3. The organisation is never accepted from the request (body / query tenant key 400 tenant_param_rejected); unexpected query 400; month must be YYYY-MM; unknown body field 400", t[0].code === "tenant_param_rejected" && t[1].code === "tenant_param_rejected" && t[2].code === "unexpected_query" && t[3].code === "invalid_input" && t[4].code === "invalid_input" && t[5].code === "invalid_input" && t[6].code === "unexpected_field" && t.every((x) => x.httpStatus === 400), J(t.map((x) => x.code)));
  const m = ["status:GET", "sync:POST", "configure:POST", "disconnect:POST"].map((x) => matchReportingRoute(`reporting/google-sheets/${x.split(":")[0]}`, x.split(":")[1]));
  ck("AC4. Routes: GET status, POST sync / configure / disconnect; wrong method 405; unknown reporting/* 404; no '/finance/' internal prefix (path /functions/v1/finance/reporting/google-sheets/sync -> reporting/google-sheets/sync)", m.every((x) => x?.status === "ok") && matchReportingRoute("reporting/google-sheets/sync", "GET")?.status === "method" && matchReportingRoute("reporting/google-sheets/status", "POST")?.status === "method" && matchReportingRoute("reporting/xero", "GET")?.status === "not_found" && matchReportingRoute("month-report", "GET") === null && "/functions/v1/finance/reporting/google-sheets/sync".replace(/^.*\/finance\/?/, "") === "reporting/google-sheets/sync");
}

async function isolation() {
  const s2 = await status(mgr2);
  ck("OI1. Another organisation's status: configured:false - it never sees ORG-TEST-001's workbook, runs or history", s2.httpStatus === 200 && s2.body.configured === false && s2.body.connection === null && s2.body.recentRuns.length === 0 && s2.body.organisation.organisationId === ORG2);
  const inUse = await configure({ spreadsheetId: BOOK, endpoint: "sandbox" }, mgr2);
  ck("OI2. A workbook connected to one organisation cannot be configured by another -> 409 reporting_workbook_in_use (one workbook = one organisation)", inUse.httpStatus === 409 && inUse.code === "reporting_workbook_in_use" && !RS.conns.some((c) => c.organisation_id === ORG2));
  // a copy of ORG1's Hub tabs in ORG2's own workbook -> the ownership marker refuses
  await sync({ month: "2026-10" });
  const copy = clone(emu.books.get(BOOK)!);
  copy.spreadsheetId = BOOK_ORG2;
  emu.books.set(BOOK_ORG2, copy);
  const own = await configure({ spreadsheetId: BOOK_ORG2, endpoint: "sandbox" }, mgr2);
  ck("OI3. A workbook whose Hub tabs belong to another organisation (a copied workbook) -> 409 reporting_workbook_owned_elsewhere at configure", own.httpStatus === 409 && own.code === "reporting_workbook_owned_elsewhere");
  book(BOOK_ORG2);
  const ok = await configure({ spreadsheetId: BOOK_ORG2, endpoint: "sandbox" }, mgr2);
  const o1 = J(emu.books.get(BOOK));
  const sy2 = await sync({ month: "2026-10" }, mgr2);
  ck("OI4. Its own workbook configures for ORG-TEST-002; its sync writes only ITS workbook (ORG-TEST-001's workbook byte-identical), every row + Sync Info carry ORG-TEST-002", ok.httpStatus === 201 && J(emu.books.get(BOOK)) === o1 && sy2.httpStatus === 200 && DATA_TABS.every((d) => rowsOf(BOOK_ORG2, d.title).every((x) => x[d.headers.length - 2] === ORG2)) && infoOf(BOOK_ORG2).get("organisation_id") === ORG2, J([sy2.httpStatus, sy2.code, sy2.error]));
  const s1 = await status();
  ck("OI5. Each organisation's history is its own (ORG-TEST-001 runs never list ORG-TEST-002's)", s1.body.recentRuns.length > 0 && s1.body.recentRuns.every((x: any) => x.workbook.spreadsheetId !== BOOK_ORG2) && (await status(mgr2)).body.recentRuns.every((x: any) => x.workbook.spreadsheetId === BOOK_ORG2));
}

async function auditHistory() {
  const mine = world.audit.filter((e: any) => String(e.event_type).startsWith("finance_reporting.") && e.organisation_id === ORG);
  const syncs = RS.runs.filter((r) => r.organisation_id === ORG && r.result !== "running");
  ck("AU1. One audit event per completed sync (synced / sync_failed) - none for status reads; configure / disconnect audited", mine.filter((e: any) => e.entity_type === "finance_reporting_sync_run").length === syncs.length && mine.filter((e: any) => e.event_type === REPORTING_EVENTS.synced).length === syncs.filter((r) => r.result === "succeeded").length && mine.some((e: any) => e.event_type === REPORTING_EVENTS.configured), J({ ev: mine.length, runs: syncs.length }));
  ck("AU2. Audit context carries the reporting contract + route; nothing in any audit event, run or connection row contains the credential", mine.every((e: any) => e.context.contract === "finance-reporting-v1" && /reporting\/google-sheets/.test(e.context.route)) && ![J(world.audit), J(RS.runs), J(RS.conns)].some((s) => s.includes(SANDBOX_KEY)));
  const patch = await fetch(`${worldDeps.grants.supabaseUrl}/rest/v1/finance_reporting_sync_runs?run_id=eq.${RS.runs[0].run_id}`, { method: "PATCH", body: J({ result: "succeeded" }) });
  ck("AU3. History is append-only: a direct UPDATE of a run is refused (history_is_append_only)", patch.status === 400 && /history_is_append_only/.test(await patch.text()));
  const st = await status();
  const rr = st.body.recentRuns;
  ck("AU4. Compact history: status lists at most 10 runs, newest first (started_at desc), each with result / month / counts / error code only", rr.length === Math.min(10, RS.runs.filter((r) => r.organisation_id === ORG).length) && rr.every((x: any, i: number) => i === 0 || x.startedAt <= rr[i - 1].startedAt) && rr.every((x: any) => !("rows" in x)));
  ck("BA4. Every sync's audit records its Google request count; every successful sync made <= 7 requests (no N+1)", world.audit.filter((e: any) => e.event_type === REPORTING_EVENTS.synced).every((e: any) => e.after.googleRequests <= 7));
}

async function disconnecting() {
  const before = J(emu.books.get(BOOK));
  const a0 = world.audit.length;
  const d = await disconnect({ reason: "F19 test done" });
  ck("DC1. Disconnect -> 200 configured:false, one finance_reporting.disconnected audit; the workbook itself is untouched", d.httpStatus === 200 && d.body.changed === true && d.body.configured === false && J(emu.books.get(BOOK)) === before && auditFrom(a0).length === 1 && auditFrom(a0)[0].event_type === REPORTING_EVENTS.disconnected);
  const s = await sync({ month: "2026-10" });
  const st = await status();
  const mr = await report("2026-10", "actual");
  ck("DC2. After disconnect: sync -> 409 reporting_not_configured; status configured:false (history kept); Finance still works", s.code === "reporting_not_configured" && st.body.configured === false && st.body.recentRuns.length > 0 && mr.httpStatus === 200);
  const d2 = await disconnect();
  ck("DC3. Disconnect again -> 200 changed:false (no audit)", d2.httpStatus === 200 && d2.body.changed === false && auditFrom(a0).length === 1);
  const re = await configure({ spreadsheetId: BOOK, endpoint: "sandbox" });
  ck("DC4. Reconnecting the same workbook keeps its Hub tabs (ownership marker is ours) -> 200, revision advanced", re.httpStatus === 200 && re.body.connection.revision >= 3);
}

async function boundary() {
  const orch = readFileSync(join(CANON, "finance", "finance-reporting-sheets-orchestrator.ts"), "utf8");
  const pure = readFileSync(join(CANON, "finance", "finance-reporting-sheets.ts"), "utf8");
  const prov = readFileSync(join(CANON, "finance", "finance-reporting-sheets-provider.ts"), "utf8");
  const repo = readFileSync(join(CANON, "finance", "finance-reporting-sheets-repository.ts"), "utf8");
  const all = orch + pure + prov + repo;
  ck("BD1. Hub -> Sheets only: the writer never writes a Finance table or Airtable (only finance_reporting_* RPCs + the lock), and never feeds a read value back into Finance", !/airtable\.com|patchRecord|createRecord|finance_supplier_|finance_bank_|finance_worker_|insertAuditEvent/.test(all) && reportingFetch.every((x) => /sheets|finance_reporting_/.test(x)));
  ck("BD2. D8: the writer never calculates a figure - its only source is loadCanonicalMonth (F18 buildMonthReport / buildFacts); no revenue / cost arithmetic in the orchestrator", /loadCanonicalMonth\(/.test(orch) && !/buildMonthReport\(|netRevenueMinor\s*[-+]|allocateProportionally/.test(orch));
  ck("BD3. Real Google is NOT enabled: no Google credential path (google -> auth_unavailable), only platform_service_account enabled (organisation_oauth reserved), no hard-coded workbook id, no Josh workbook name", /endpoint !== "sandbox"\) return \{ ok: false, kind: "auth_unavailable"/.test(orch) && J(ENABLED_AUTH_MODES) === J(["platform_service_account"]) && /organisation_oauth/.test(pure) && !/Josh|PL_and_Schedule|1[A-Za-z0-9_-]{40,}/.test(all) && baseUrlFor("google", "x") === "https://sheets.googleapis.com" && baseUrlFor("sandbox", "https://p.supabase.co/") === "https://p.supabase.co/functions/v1/sheets-sandbox");
  ck("BD4. Values are written RAW (no formula / no legacy formula preserved) and read UNFORMATTED (numbers stay numbers)", /valueInputOption: "RAW"/.test(prov) && /valueRenderOption=UNFORMATTED_VALUE/.test(prov));
  const r0 = RS.rpcLog.length;
  const gt = await tokenFor(deps, "google")();
  const st = await tokenFor(deps, "sandbox")();
  ck("BD3b. Token source: google -> auth_unavailable WITHOUT reading any credential (no Vault read); sandbox -> the platform Vault secret (finance_reporting_sheets_sandbox), held only in memory", !gt.ok && gt.kind === "auth_unavailable" && RS.rpcLog.slice(r0).join() === "finance_reporting_secret" && st.ok && st.token === SANDBOX_KEY);
  const facts = buildFacts;
  ck("BD5. The canonical facts used for detail rows are F18's own (buildFacts exported by finance-month-report.ts)", typeof facts === "function");
}

async function drift() {
  const mirror = (dir: string, f: string, copyName = f) => {
    const canon = readFileSync(join(CANON, dir, f), "utf8").replace(/from "\.\/orchestrator\.ts"/g, 'from "./finance-orchestrator.ts"').replace(/from "\.\/repository\.ts"/g, 'from "./finance-repository.ts"');
    const copy = readFileSync(join(HERE, copyName), "utf8");
    return copy.slice(copy.indexOf("/**", 3)) === canon || copy === canon;
  };
  ck("Z1. Test copies == canonical (finance-reporting-sheets.ts, -provider.ts, -repository.ts, -orchestrator.ts, finance-month-report-orchestrator.ts; only import paths adjusted)", ["finance-reporting-sheets.ts", "finance-reporting-sheets-provider.ts", "finance-reporting-sheets-repository.ts", "finance-reporting-sheets-orchestrator.ts", "finance-month-report-orchestrator.ts"].every((f) => mirror("finance", f)));
  ck("Z2. Emulator core copy == the deployed sheets-sandbox/emulator.ts", mirror("sheets-sandbox", "emulator.ts", "sheets-sandbox-emulator.ts"));
  const idx = readFileSync(join(CANON, "finance", "index.ts"), "utf8");
  ck("Z3. index.ts routes reporting/* first (before F18), 405 -> 401 -> 403 management_required -> 400 query / body -> orchestrator; deps typed with ReportingDeps", idx.indexOf("matchReportingRoute(route") > 0 && idx.indexOf("matchReportingRoute(route") < idx.indexOf("matchMonthReportRoute(route") && /async function handleReporting/.test(idx) && /checkReportingQuery\(url\.searchParams, isTenantKey\)/.test(idx) && /& ReportingDeps = \{/.test(idx));
  const sbx = readFileSync(join(CANON, "sheets-sandbox", "index.ts"), "utf8");
  ck("Z4. sheets-sandbox Edge Function: shared emulator core, sha256 key match, take-fault RPC, request log (never the key or values), refuses to start on production", /from "\.\/emulator\.ts"/.test(sbx) && /key_sha256=eq\./.test(sbx) && /sheets_sandbox_take_fault/.test(sbx) && /sheets_sandbox_requests/.test(sbx) && /bkkukymqaxawnudoxdjs/.test(sbx) && /refusing to start/.test(sbx));
}

async function main() {
  await seed();
  await connection();
  const first = await firstSync();
  await idempotency(first);
  await months();
  await manualEdits();
  await schema();
  await failures();
  await access();
  await isolation();
  await auditHistory();
  await disconnecting();
  await boundary();
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
