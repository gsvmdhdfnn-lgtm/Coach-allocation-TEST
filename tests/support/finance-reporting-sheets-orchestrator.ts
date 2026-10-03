/**
 * Test-suite copy of the canonical finance/finance-reporting-sheets-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts; ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Google Sheets reporting writer - orchestration (Finance Foundation F19;
 * see TEST-ENV.md "Finance Foundation - F19"). Every route authorises
 * through F1's authorizeFinance(): View reads status, Manage configures /
 * disconnects / syncs. The organisation is ALWAYS the caller's own.
 *
 *   GET  /reporting/google-sheets/status       View   stored state + compact history (no Google call, never audited)
 *   POST /reporting/google-sheets/configure    Manage workbook identity only; verified against the workbook first
 *   POST /reporting/google-sheets/disconnect   Manage the workbook itself is never touched
 *   POST /reporting/google-sheets/sync         Manage one month, BOTH modes (Actual, Expected + Actual)
 *
 * A sync, under the organisation's reporting write lock:
 *   1. records the attempt (sync run 'running');
 *   2. builds the canonical F18 month ONCE (loadCanonicalMonth) and
 *      transforms it into the managed tab rows (never recalculating);
 *   3. reads the workbook metadata + every existing Hub tab (1 + 1 calls),
 *      refuses on schema drift / foreign ownership / unrecognised rows;
 *   4. creates missing Hub tabs (0-1 call), writes every data tab + the Sync
 *      Info ownership block in ONE values.batchUpdate;
 *   5. reads everything back (1 call) and verifies exact rows, Row Keys,
 *      counts and the F18 control totals;
 *   6. only then stamps Sync Info's last successful sync (1 call) and reads
 *      it back (1 call);
 *   7. completes the run exactly once - succeeded, or failed with a code -
 *      atomically with the connection's last-sync fields and one audit event.
 * Google / emulator failure never touches Finance data and is safe to retry:
 * the next sync recomputes the month and replaces the same rows.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import { type MonthReportDeps, loadCanonicalMonth, reportingBoundaryFor } from "./finance-month-report-orchestrator.ts";
import { HISTORY_UNAVAILABLE_CODE, REPORTING_STATE_CANONICAL, historyUnavailable, startMessage } from "./finance-reporting-boundary.ts";
import {
  type CanonicalMonth,
  type Cell,
  type Endpoint,
  type Problem,
  type ReportingConnection,
  DATA_TABS,
  ENABLED_AUTH_MODES,
  ENTITY_CONNECTION,
  ENTITY_RUN,
  MANAGED_TITLES,
  PROVIDER,
  REPORTING_CONTRACT,
  REPORTING_EVENTS,
  SCHEMA_VERSION,
  SYNC_INFO_TAB,
  WRITER_VERSION,
  canonicalTables,
  controlView,
  controlsOf,
  inspectWorkbook,
  normGrid,
  planWrite,
  publicConnection,
  readRangeOf,
  reportingAuditEvent,
  runView,
  safeSummary,
  verifyWrite,
  writeRangeOf,
  writeSyncInfo,
} from "./finance-reporting-sheets.ts";
import { type SheetsFail, type SheetsProvider, type TokenSource, baseUrlFor, httpSheetsProvider } from "./finance-reporting-sheets-provider.ts";
import { disconnect, finishRun, isRefusal, lastSucceededRun, listRuns, loadConnection, readConnectorSecret, saveConnection, startRun, workbookConnectedElsewhere } from "./finance-reporting-sheets-repository.ts";

export interface ReportingDeps extends MonthReportDeps {
  clock?: () => Date;
  reporting?: {
    /** 12 upper-case hex chars for a run id (tests make it deterministic) */
    random?: () => string;
    /** override the connector (tests); default = the HTTP adapter for the connection's endpoint */
    provider?: (endpoint: Endpoint, token: TokenSource) => SheetsProvider;
    timeoutMs?: number;
    maxRowsPerTab?: number;
  };
}
export type RFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 502 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: RFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): RFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is RFail => !!x && typeof x === "object" && (x as any).status === "error";
const now = (deps: ReportingDeps) => (deps.clock ?? (() => new Date()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `reporting:google-sheets:${o.organisationId}`;
const unavailable = () => fail(503, "finance_reporting_unavailable", "The reporting connection details could not be loaded just now - try again");
const randomHex = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const GOOGLE_NOT_AVAILABLE = () => fail(409, "reporting_google_not_available", "Writing to real Google Sheets is not enabled in this Hub yet (no Google credential / TEST workbook) - use the TEST sheets-sandbox emulator");

/** A connector failure in Management's words (codes stay machine-readable). Never touches Finance data. */
export function connectorFailure(f: SheetsFail, doing: string): RFail {
  switch (f.kind) {
    case "auth_unavailable":
      return fail(409, "reporting_credentials_unavailable", `The Hub's Google Sheets credential is not set up (${doing}) - this is a platform setting, not an organisation one`);
    case "unauthorised":
      return fail(409, "reporting_credentials_rejected", `Google Sheets rejected the Hub's credential while ${doing} - the platform connector needs attention`);
    case "forbidden":
      return fail(409, "reporting_workbook_permission_denied", `The Hub is not allowed to open this workbook (${doing}) - share it with the Hub's reporting account as an Editor`);
    case "not_found":
      return fail(409, "reporting_workbook_not_found", `The configured workbook was not found (${doing}) - it may have been deleted or moved; reconfigure the reporting workbook`);
    case "rate_limited":
      return fail(503, "reporting_workbook_busy", `Google Sheets is busy (rate limit) while ${doing} - try again in a minute`);
    case "malformed":
      return fail(502, "reporting_workbook_response_invalid", `Google Sheets answered in a way the Hub could not read while ${doing} - try again`);
    case "rejected":
      return fail(502, "reporting_workbook_rejected", `Google Sheets refused the request while ${doing}: ${safeSummary(f.message)}`);
    default:
      return fail(503, "reporting_workbook_unavailable", `Google Sheets did not respond while ${doing} - nothing in the Hub changed; try again`);
  }
}
function problemFailure(p: Problem[]): RFail {
  const first = p[0];
  const code = first.code === "owned_elsewhere" ? "reporting_workbook_owned_elsewhere" : first.code === "too_large" ? "reporting_workbook_too_large" : first.code === "unrecognised_rows" ? "reporting_managed_rows_unrecognised" : "reporting_schema_incompatible";
  return fail(409, code, `${first.message}. Nothing was written to the workbook.`, { problems: p.map((x) => ({ code: x.code, tab: x.tab ?? null, message: x.message, ...(x.details ? { details: x.details } : {}) })) });
}

export function tokenFor(deps: ReportingDeps, endpoint: Endpoint): TokenSource {
  return async () => {
    if (endpoint !== "sandbox") return { ok: false, kind: "auth_unavailable", status: null, message: "real Google auth is not enabled" };
    let secret: string | null;
    try {
      secret = await readConnectorSecret(deps.grants, endpoint);
    } catch (e) {
      console.error(e);
      return { ok: false, kind: "unavailable", status: null, message: "the connector credential could not be read" };
    }
    return secret ? { ok: true, token: secret } : { ok: false, kind: "auth_unavailable", status: null, message: "no connector credential provisioned" };
  };
}
function providerFor(deps: ReportingDeps, endpoint: Endpoint): SheetsProvider {
  const token = tokenFor(deps, endpoint);
  return deps.reporting?.provider ? deps.reporting.provider(endpoint, token) : httpSheetsProvider({ baseUrl: baseUrlFor(endpoint, deps.grants.supabaseUrl), token, timeoutMs: deps.reporting?.timeoutMs });
}

/** Metadata + every existing Hub tab, in exactly two calls. */
async function readWorkbook(p: SheetsProvider, spreadsheetId: string, doing: string): Promise<{ titles: string[]; grids: Record<string, Cell[][]> } | RFail> {
  const meta = await p.getSpreadsheet(spreadsheetId);
  if (!meta.ok) return connectorFailure(meta, doing);
  const titles = meta.value.tabs.map((t) => t.title);
  const managed = MANAGED_TITLES.filter((t) => titles.includes(t));
  const grids: Record<string, Cell[][]> = {};
  if (managed.length) {
    const widths = (t: string) => (t === SYNC_INFO_TAB.title ? SYNC_INFO_TAB.headers.length : DATA_TABS.find((d) => d.title === t)!.headers.length);
    const r = await p.batchGet(spreadsheetId, managed.map((t) => readRangeOf(t, widths(t))));
    if (!r.ok) return connectorFailure(r, doing);
    managed.forEach((t, i) => (grids[t] = normGrid(r.value[i].values)));
  }
  return { titles, grids };
}

async function withLock(deps: ReportingDeps, caller: FinanceCaller, run: (org: OrganisationContext) => Promise<Ok | RFail>): Promise<Ok | RFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_reporting_unavailable", "The reporting change could not be started just now - try again");
  }
  if (!token) return fail(409, "finance_reporting_busy", "A reporting sync or change is already running for this organisation - try again in a moment");
  try {
    return await run(org);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_reporting_unavailable", "The reporting change could not be completed just now - try again");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Reporting write lock release failed (expires on its own)", e);
    }
  }
}

// ---------------------------------------------------------------------
// GET /reporting/google-sheets/status (View) - stored state only
// ---------------------------------------------------------------------
export async function readReportingStatus(deps: ReportingDeps, caller: FinanceCaller): Promise<Ok | RFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  try {
    const [conn, runs, success] = await Promise.all([loadConnection(deps.grants, org.organisationId), listRuns(deps.grants, org.organisationId), lastSucceededRun(deps.grants, org.organisationId)]);
    const configured = !!conn && conn.state === "connected";
    return {
      status: "ok",
      httpStatus: 200,
      body: {
        contract: REPORTING_CONTRACT,
        organisation: orgBody(org),
        access: auth.access,
        provider: PROVIDER,
        configured,
        connection: conn ? publicConnection(conn) : null,
        schemaVersion: SCHEMA_VERSION,
        writerVersion: WRITER_VERSION,
        lastAttempt: runs.length ? runView(runs[0]) : null,
        lastSuccess: success ? runView(success) : null,
        recentRuns: runs.map(runView),
        direction: "Hub -> Google Sheets only. Sheets is reporting output; it never changes Hub Finance.",
        managedTabs: MANAGED_TITLES,
      },
    };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}

// ---------------------------------------------------------------------
// POST /reporting/google-sheets/configure (Manage) - workbook identity only
// ---------------------------------------------------------------------
export function configureReporting(deps: ReportingDeps, caller: FinanceCaller, req: { spreadsheetId: string; endpoint: Endpoint; displayName: string | null; reason: string | null }): Promise<Ok | RFail> {
  if (req.endpoint !== "sandbox") return Promise.resolve(GOOGLE_NOT_AVAILABLE());
  return withLock(deps, caller, async (org) => {
    const existing = await loadConnection(deps.grants, org.organisationId);
    if (await workbookConnectedElsewhere(deps.grants, org.organisationId, req.spreadsheetId)) return fail(409, "reporting_workbook_in_use", "That workbook is already the reporting workbook of another organisation - each organisation needs its own workbook");
    // Verify BEFORE saving: the workbook must exist, be shared with the Hub, and any Hub tabs must be ours and compatible.
    const p = providerFor(deps, req.endpoint);
    const w = await readWorkbook(p, req.spreadsheetId, "checking the workbook");
    if (isFail(w)) return w;
    const problems = inspectWorkbook(w, org.organisationId);
    if (problems.length) return problemFailure(problems);
    const unchanged = existing && existing.state === "connected" && existing.spreadsheetId === req.spreadsheetId && existing.endpoint === req.endpoint && existing.displayName === req.displayName;
    if (unchanged) return { status: "ok", httpStatus: 200, body: { contract: REPORTING_CONTRACT, organisation: orgBody(org), access: "manage", changed: false, verified: true, connection: publicConnection(existing!) } };
    const at = now(deps).toISOString();
    const before = existing ? publicConnection(existing) : null;
    const after = { provider: PROVIDER, authMode: ENABLED_AUTH_MODES[0], endpoint: req.endpoint, spreadsheetId: req.spreadsheetId, displayName: req.displayName, schemaVersion: SCHEMA_VERSION, state: "connected" };
    const saved = await saveConnection(deps.grants, {
      organisationId: org.organisationId,
      actor: caller.userId,
      expectedRevision: existing ? existing.revision : null,
      connection: { auth_mode: ENABLED_AUTH_MODES[0], endpoint: req.endpoint, spreadsheet_id: req.spreadsheetId, display_name: req.displayName, schema_version: SCHEMA_VERSION, last_verified_at: at, at },
      event: reportingAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: REPORTING_EVENTS.configured, entityType: ENTITY_CONNECTION, recordId: `${org.organisationId}:${PROVIDER}`, before: before as Record<string, unknown> | null, after, reason: req.reason, route: "POST /reporting/google-sheets/configure" }),
    });
    if (isRefusal(saved)) {
      if (saved.refused === "workbook_in_use") return fail(409, "reporting_workbook_in_use", "That workbook is already the reporting workbook of another organisation - each organisation needs its own workbook");
      return fail(409, "finance_reporting_busy", "The reporting connection was changed by someone else just now - reload and try again");
    }
    return { status: "ok", httpStatus: existing ? 200 : 201, body: { contract: REPORTING_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, verified: true, connection: publicConnection(saved) } };
  });
}

// ---------------------------------------------------------------------
// POST /reporting/google-sheets/disconnect (Manage)
// ---------------------------------------------------------------------
export function disconnectReporting(deps: ReportingDeps, caller: FinanceCaller, req: { reason: string | null }): Promise<Ok | RFail> {
  return withLock(deps, caller, async (org) => {
    const existing = await loadConnection(deps.grants, org.organisationId);
    if (!existing || existing.state !== "connected") return { status: "ok", httpStatus: 200, body: { contract: REPORTING_CONTRACT, organisation: orgBody(org), access: "manage", changed: false, configured: false, connection: existing ? publicConnection(existing) : null } };
    const at = now(deps).toISOString();
    const r = await disconnect(deps.grants, {
      organisationId: org.organisationId,
      actor: caller.userId,
      expectedRevision: existing.revision,
      at,
      event: reportingAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: REPORTING_EVENTS.disconnected, entityType: ENTITY_CONNECTION, recordId: `${org.organisationId}:${PROVIDER}`, before: publicConnection(existing) as Record<string, unknown>, after: { ...publicConnection(existing), state: "disconnected" }, reason: req.reason, route: "POST /reporting/google-sheets/disconnect" }),
    });
    if (isRefusal(r)) return fail(409, "finance_reporting_busy", "The reporting connection was changed by someone else just now - reload and try again");
    return { status: "ok", httpStatus: 200, body: { contract: REPORTING_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, configured: false, connection: publicConnection(r), note: "The workbook itself was not changed; its Hub tabs simply stop being updated." } };
  });
}

// ---------------------------------------------------------------------
// POST /reporting/google-sheets/sync (Manage) - one month, both modes
// ---------------------------------------------------------------------
export function syncReporting(deps: ReportingDeps, caller: FinanceCaller, req: { month: string }): Promise<Ok | RFail> {
  return withLock(deps, caller, async (org) => {
    const conn = await loadConnection(deps.grants, org.organisationId);
    if (!conn || conn.state !== "connected") return fail(409, "reporting_not_configured", "No Google Sheets reporting workbook is configured for this organisation - Finance works fully without one");
    if (conn.endpoint !== "sandbox") return GOOGLE_NOT_AVAILABLE();
    // F20: a month before the Finance Reporting Start Month has no Hub Finance report - refuse before any run, Google call or row
    const boundary = await reportingBoundaryFor(deps, org, req.month);
    if (isFail(boundary)) return fail(boundary.httpStatus === 409 ? 409 : 503, boundary.code, boundary.error);
    if (boundary.state !== REPORTING_STATE_CANONICAL) return fail(409, HISTORY_UNAVAILABLE_CODE, `${startMessage(boundary.financeReportingStartMonth)} ${req.month} is before it, so there is no Hub Finance report to export - nothing was written to the workbook`, historyUnavailable(req.month, boundary.financeReportingStartMonth));
    const runId = `FRS-${(deps.reporting?.random ?? randomHex)()}`;
    const startedAt = now(deps).toISOString();
    const started = await startRun(deps.grants, { run_id: runId, organisation_id: org.organisationId, provider: PROVIDER, endpoint: conn.endpoint, spreadsheet_id: conn.spreadsheetId, requested_month: req.month, modes: ["actual", "expected"], schema_version: SCHEMA_VERSION, writer_version: WRITER_VERSION, actor_user_id: caller.userId, started_at: startedAt });
    if (isRefusal(started)) return fail(409, "finance_reporting_busy", "A reporting sync could not be recorded - try again");
    const p = providerFor(deps, conn.endpoint);
    const outcome = await runSync(deps, caller, org, conn, req.month, runId, p);
    const completedAt = now(deps).toISOString();
    const isOk = !isFail(outcome);
    const afterBody: Record<string, unknown> = {
      runId,
      month: req.month,
      modes: ["actual", "expected"],
      result: isOk ? "succeeded" : "failed",
      spreadsheetId: conn.spreadsheetId,
      endpoint: conn.endpoint,
      schemaVersion: SCHEMA_VERSION,
      writerVersion: WRITER_VERSION,
      googleRequests: p.requests,
      ...(isOk ? { rowCounts: outcome.rowCounts, controlTotals: outcome.controlTotals } : { errorCode: outcome.code }),
    };
    let finished;
    try {
      finished = await finishRun(deps.grants, {
        runId,
        result: isOk ? "succeeded" : "failed",
        completedAt,
        rowCounts: isOk ? outcome.rowCounts : (outcome as any).details?.rowCounts ?? null,
        controlTotals: isOk ? outcome.controlTotals : null,
        errorCode: isOk ? null : outcome.code,
        errorSummary: isOk ? null : safeSummary(outcome.error),
        event: reportingAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: isOk ? REPORTING_EVENTS.synced : REPORTING_EVENTS.syncFailed, entityType: ENTITY_RUN, recordId: runId, before: null, after: afterBody, reason: null, route: "POST /reporting/google-sheets/sync" }),
      });
    } catch (e) {
      console.error(e);
      finished = null;
    }
    if (!finished || isRefusal(finished)) {
      return isOk
        ? fail(500, "finance_reporting_unrecorded", "The reporting workbook was updated and verified, but the sync could not be recorded - run it again (it is safe to repeat)", { runId })
        : fail(outcome.httpStatus, outcome.code, outcome.error, { ...(outcome.details ?? {}), runId, recorded: false });
    }
    if (!isOk) return fail(outcome.httpStatus, outcome.code, outcome.error, { ...(outcome.details ?? {}), runId });
    return { status: "ok", httpStatus: 200, body: { contract: REPORTING_CONTRACT, organisation: orgBody(org), access: "manage", result: "succeeded", run: runView(finished), workbook: { spreadsheetId: conn.spreadsheetId, displayName: conn.displayName, endpoint: conn.endpoint }, googleRequests: p.requests, verification: outcome.verification } };
  });
}

type SyncOk = { rowCounts: Record<string, unknown>; controlTotals: Record<string, unknown>; verification: Record<string, unknown> };
async function runSync(deps: ReportingDeps, caller: FinanceCaller, org: OrganisationContext, conn: ReportingConnection, month: string, runId: string, p: SheetsProvider): Promise<SyncOk | RFail> {
  // 2. canonical F18 (never recalculated here)
  let canonical: CanonicalMonth;
  try {
    const c = await loadCanonicalMonth(deps, caller, org, month);
    if (c.status !== "ok") return fail(c.httpStatus === 409 ? 409 : 503, c.code, c.error);
    canonical = { organisationId: org.organisationId, month, actual: c.actual, expected: c.expected, facts: c.facts, serviceLabels: c.serviceLabels };
  } catch (e) {
    console.error(e);
    return fail(503, "month_report_unavailable", "The Month Report could not be built just now - nothing was written to the workbook");
  }
  const tables = canonicalTables(canonical);
  const controls = controlsOf(canonical);
  // 3. workbook + ownership / schema
  const w = await readWorkbook(p, conn.spreadsheetId, "reading the reporting workbook");
  if (isFail(w)) return w;
  const plan = planWrite(w, org.organisationId, month, tables, deps.reporting?.maxRowsPerTab);
  if (!plan.ok) return problemFailure(plan.problems);
  const rowCounts = plan.plan.rowCounts as unknown as Record<string, unknown>;
  // 4. create missing Hub tabs, then ONE batched write
  if (plan.plan.addTabs.length) {
    const a = await p.addTabs(conn.spreadsheetId, plan.plan.addTabs);
    if (!a.ok) return withCounts(connectorFailure(a, "creating the Hub reporting tabs"), rowCounts);
  }
  const wr = await p.batchUpdateValues(conn.spreadsheetId, plan.plan.writes);
  if (!wr.ok) return withCounts(fail(503, "reporting_write_failed", `The reporting workbook was only partly updated or not at all (${connectorFailure(wr, "writing").code}) - it is safe to sync again`), rowCounts);
  // 5. read back + verify (never trust a 200)
  const back = await p.batchGet(conn.spreadsheetId, DATA_TABS.map((d) => readRangeOf(d.title, d.headers.length)));
  if (!back.ok) return withCounts(connectorFailure(back, "reading back the written rows"), rowCounts);
  const got: Record<string, Cell[][]> = {};
  DATA_TABS.forEach((d, i) => (got[d.title] = back.value[i].values));
  const v = verifyWrite(month, plan.plan.expected, got, controls);
  if (!v.ok) return fail(502, "reporting_verification_failed", `The workbook did not read back as written (${v.problems[0]}) - the sync is NOT successful; sync again`, { problems: v.problems.slice(0, 20), rowCounts });
  // 6. only now: last successful sync in Sync Info (+ read back)
  const info = writeSyncInfo(normGrid(w.grids[SYNC_INFO_TAB.title] ?? []), org.organisationId, { at: now(deps).toISOString(), month, runId });
  const infoLen = Math.max(info.values.length, (plan.plan.writes.find((x) => x.range.startsWith(`'${SYNC_INFO_TAB.title}'`))?.values.length ?? 0));
  const padded = [...info.values, ...Array.from({ length: infoLen - info.values.length }, () => ["", ""] as Cell[])];
  const iw = await p.batchUpdateValues(conn.spreadsheetId, [{ range: writeRangeOf(SYNC_INFO_TAB.title, 2, padded.length), values: padded }]);
  if (!iw.ok) return withCounts(fail(503, "reporting_write_failed", `The reporting rows were written and verified, but the Sync Info stamp failed (${connectorFailure(iw, "writing").code}) - sync again`), rowCounts);
  const ib = await p.batchGet(conn.spreadsheetId, [readRangeOf(SYNC_INFO_TAB.title, 2)]);
  if (!ib.ok) return withCounts(connectorFailure(ib, "reading back Sync Info"), rowCounts);
  if (JSON.stringify(normGrid(ib.value[0].values)) !== JSON.stringify(info.expected)) return fail(502, "reporting_verification_failed", "Sync Info did not read back as written - the sync is NOT successful; sync again", { rowCounts });
  return { rowCounts, controlTotals: controlView(controls), verification: { rowsAndKeys: "exact", controlTotals: "match F18", readBack: v.readBack, tabs: DATA_TABS.map((d) => d.title) } };
}
const withCounts = (f: RFail, rowCounts: Record<string, unknown>): RFail => ({ ...f, details: { ...(f.details ?? {}), rowCounts } });
