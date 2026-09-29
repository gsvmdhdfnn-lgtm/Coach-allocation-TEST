/**
 * Test-suite copy of the canonical finance/finance-invoicing-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts.
 */
/**
 * Finance client invoice drafts - orchestration (Finance Foundation F5; see
 * TEST-ENV.md "Finance Foundation - F5"). Every route authorises through
 * F1's authorizeFinance() first - View reads, Manage writes; no new auth.
 *
 * Reads compose the F3 snapshot, the Schedule facts (read only), the F4
 * overrides and the draft rows, then the pure F4 resolution and the pure F5
 * classification / review. A read never writes anything.
 *
 * Draft writes (Manage only) follow the F3/F4 write discipline exactly:
 *   1. authorise (manage)
 *   2. the per-organisation Finance write lock - the SAME lock F3 terms /
 *      lifecycle and F4 overrides take, so a draft is never built while
 *      the billing it reads is changing, and two draft writes (e.g. two
 *      concurrent creates) never interleave            -> 409 busy
 *   3. load the draft / client work UNDER the lock (the claim check reads
 *      every Included line for the period's occurrences here)
 *   4. validate / plan                                  -> 400 / 404 / 409
 *      no effective change                              -> 200 changed:false, nothing written
 *   5. the Airtable writes (each registered with its undo)
 *   6. the audit event(s), in ONE insert
 *   Failure in 5 or 6 undoes this request's writes and returns 503; if the
 *   undo fails the caller gets 500 (never "success").
 *   7. release the lock (always)
 *
 * "Mark not billable" from a draft is a convenience that DELEGATES to the F4
 * override write (its own lock, validation and audit), and only then closes
 * the draft line under the lock. There is no F5 not-billable flag.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { type Client, type Stored, todayIn } from "./finance-commercial.ts";
import type { Row, World } from "./finance-commercial-mapping.ts";
import { acquireWriteLock, insertAuditEvents, releaseWriteLock } from "./finance-commercial-repository.ts";
import { type CommercialDeps, loadWorld } from "./finance-commercial-orchestrator.ts";
import { fromStoredRow } from "./finance-settings.ts";
import { loadSettingsRows } from "./finance-settings-repository.ts";
import { type Resolution, OCCURRENCE_ID_PATTERN, resolveOccurrenceBilling } from "./finance-billing.ts";
import { FB, buildOverrides, occurrenceFacts } from "./finance-billing-mapping.ts";
import { listOverrideRows } from "./finance-billing-repository.ts";
import { readOccurrenceBilling, serviceFinder, writeOverride } from "./finance-billing-orchestrator.ts";
import {
  type Claim,
  type CreateRequest,
  type DetailsRequest,
  type Draft,
  type Line,
  type TermsSource,
  type Work,
  DRAFT_EVENTS,
  INVOICING_CONTRACT,
  auditDraft,
  auditLine,
  classifyWork,
  defaultPaymentTerms,
  draftAuditEvent,
  lineFromResolution,
  newDraftId,
  notInvoiceableReason,
  planDraftCreate,
  planRefresh,
  publicDraft,
  publicLine,
  publicWorkItem,
  reviewDraft,
  totalsOf,
} from "./finance-invoicing.ts";
import { type StoredDraft, type StoredLine, INVOICING_TABLES, buildDrafts, buildLines, draftFields, draftRestoreFields, lineCreateFields, lineStatusFields } from "./finance-invoicing-mapping.ts";
import { createRows, deleteCreatedRows, findDraftRows, listClientDraftRows, listDraftLineRows, listIncludedLineRows, listOccurrencesForSessions, listSessionsForServices, patchRows } from "./finance-invoicing-repository.ts";
import { formatMinor } from "./finance-money.ts";

export type InvoicingDeps = CommercialDeps;

export type Fail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 503; code: string; error: string; fields?: Record<string, string> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: Fail["httpStatus"], code: string, error: string, fields?: Record<string, string>): Fail => ({ status: "error", httpStatus, code, error, ...(fields ? { fields } : {}) });

const now = (deps: InvoicingDeps) => (deps.clock ?? (() => new Date()))();
const hex = (deps: InvoicingDeps) => (deps.randomHex ?? (() => crypto.randomUUID()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_invoicing_unavailable", "Invoice drafts could not be loaded just now - try again");

// ---------------------------------------------------------------------
// Batched compensating transaction (draft + line rows only)
// ---------------------------------------------------------------------

export class DraftTxn {
  private undo: { label: string; run: () => Promise<unknown> }[] = [];
  private deps: InvoicingDeps;
  constructor(deps: InvoicingDeps) {
    this.deps = deps;
  }
  async create(table: string, fieldsList: Record<string, unknown>[]): Promise<Row[]> {
    if (!fieldsList.length) return [];
    const created: Row[] = [];
    try {
      created.push(...(await createRows(this.deps.airtable, table, fieldsList)));
    } finally {
      // Register whatever this call created, even when a later batch failed.
      if (created.length) this.undo.push({ label: `delete ${created.length} ${table}`, run: () => deleteCreatedRows(this.deps.airtable, table, created.map((r) => r.id)) });
    }
    return created;
  }
  async patch(table: string, updates: { id: string; fields: Record<string, unknown>; restore: Record<string, unknown> }[]): Promise<void> {
    if (!updates.length) return;
    this.undo.push({ label: `restore ${updates.length} ${table}`, run: () => patchRows(this.deps.airtable, table, updates.map((u) => ({ id: u.id, fields: u.restore }))) });
    await patchRows(this.deps.airtable, table, updates.map((u) => ({ id: u.id, fields: u.fields })));
  }
  /** true when every write of this request was undone. */
  async rollback(): Promise<boolean> {
    for (const u of [...this.undo].reverse()) {
      try {
        await u.run();
      } catch (e) {
        console.error(`FINANCE INVOICING UNDO FAILED (${u.label})`, e);
        return false;
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------

async function loadSettingsDefault(deps: InvoicingDeps, org: OrganisationContext): Promise<{ ok: true; days: number | null } | Fail> {
  let rows;
  try {
    rows = await loadSettingsRows(deps.airtable, org.recordId);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_settings_unavailable", "Finance Settings could not be loaded just now - try again");
  }
  if (rows.length === 0) return { ok: true, days: null };
  if (rows.length > 1) return fail(409, "finance_settings_ambiguous", "More than one Finance Settings record exists for your organisation");
  const p = fromStoredRow(rows[0]);
  if (!p.ok) return fail(409, "finance_settings_invalid", `Stored Finance Settings are not valid (${p.problems.join(", ")})`);
  return { ok: true, days: p.state.settings.defaultPaymentTermsDays };
}

interface ClientWork {
  world: World;
  client: Stored<Client> | null;
  settingsDays: number | null;
  current: Map<string, Resolution>;
  claims: Claim[];
  work: Work;
  resolvedOn: string;
}

/**
 * Everything one client + period needs: the F3 snapshot, Finance Settings,
 * the client's Sessions and their occurrences in the period, the F4
 * overrides, today's F4 resolution for each, and every Included line that
 * claims one of them (plus `alsoClaimIds`, e.g. a draft's own lines).
 */
async function loadClientWork(deps: InvoicingDeps, org: OrganisationContext, clientId: string, from: string, to: string, at: Date, today: string, alsoClaimIds: string[] = []): Promise<ClientWork | Fail> {
  const [loaded, settings] = await Promise.all([loadWorld(deps, org, today), loadSettingsDefault(deps, org)]);
  if ("status" in loaded) return loaded;
  if ("status" in settings) return settings;
  const world = loaded.world;
  const client = world.clients.find((c) => c.value.clientId === clientId) ?? null;
  const serviceIds = client ? world.services.filter((s) => s.value.clientId === clientId).map((s) => s.value.serviceId) : [];
  let sessions: Row[] = [];
  let occRows: Row[] = [];
  let overrideRows: Row[] = [];
  let claimRows: Row[] = [];
  try {
    sessions = serviceIds.length ? await listSessionsForServices(deps.airtable, serviceIds) : [];
    const refs = sessions.map((s) => ({ recordId: s.id, sessionId: typeof s.fields[FB.session.id] === "string" ? s.fields[FB.session.id] : "" })).filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s.sessionId));
    occRows = refs.length ? await listOccurrencesForSessions(deps.airtable, refs, from, to) : [];
    const occIds = occRows.map((o) => String(o.fields[FB.occurrence.id] ?? "")).filter((id) => OCCURRENCE_ID_PATTERN.test(id));
    const claimIds = [...new Set([...occIds, ...alsoClaimIds])];
    [overrideRows, claimRows] = await Promise.all([
      occIds.length ? listOverrideRows(deps.airtable, org.recordId, occIds) : Promise.resolve([]),
      claimIds.length ? listIncludedLineRows(deps.airtable, org.recordId, claimIds) : Promise.resolve([]),
    ]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const ov = buildOverrides(overrideRows, org.recordId);
  if (!ov.ok) return fail(409, "billing_override_data_invalid", ov.error);
  const cl = buildLines(claimRows, org.recordId);
  if (!cl.ok) return fail(409, "invoice_draft_data_invalid", cl.error);
  const overrides = ov.overrides.map((o) => o.value);
  const byRecord = new Map(sessions.map((s) => [s.id, s]));
  const find = serviceFinder(world);
  const rs: Resolution[] = occRows.map((occ) => {
    const link = Array.isArray(occ.fields[FB.occurrence.session]) ? occ.fields[FB.occurrence.session] : [];
    const session = link.length === 1 ? byRecord.get(link[0]) ?? null : null;
    return resolveOccurrenceBilling({ occurrence: occurrenceFacts(occ, session), findService: find, overrides, now: at, today });
  });
  const current = new Map(rs.map((r) => [r.occurrence.occurrenceId, r]));
  const claims: Claim[] = cl.lines.filter((l) => l.value.status === "included").map((l) => ({ lineId: l.value.lineId, draftId: l.value.draftId, occurrenceId: l.value.occurrenceId }));
  return { world, client, settingsDays: settings.days, current, claims, work: classifyWork(rs, claims), resolvedOn: today };
}

async function loadDraft(deps: InvoicingDeps, org: OrganisationContext, draftId: string): Promise<{ draft: StoredDraft; lines: StoredLine[] } | Fail> {
  let draftRows: Row[];
  let lineRows: Row[];
  try {
    [draftRows, lineRows] = await Promise.all([findDraftRows(deps.airtable, org.recordId, draftId), listDraftLineRows(deps.airtable, org.recordId, draftId)]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const d = buildDrafts(draftRows, org.recordId);
  if (!d.ok) return fail(409, "invoice_draft_data_invalid", d.error);
  if (d.drafts.length === 0) return fail(404, "invoice_draft_not_found", "No such invoice draft in your organisation");
  if (d.drafts.length > 1) return fail(409, "invoice_draft_ambiguous", "More than one invoice draft has this id - the data must be corrected first");
  const l = buildLines(lineRows, org.recordId);
  if (!l.ok) return fail(409, "invoice_draft_data_invalid", l.error);
  return { draft: d.drafts[0], lines: l.lines };
}

const STATUS_ORDER = { included: 0, excluded: 1, removed: 2, superseded: 3 } as const;
const orderLines = (ls: readonly Line[]) => [...ls].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || `${a.occurrenceDate} ${a.occurrenceId} ${a.createdAt ?? ""}`.localeCompare(`${b.occurrenceDate} ${b.occurrenceId} ${b.createdAt ?? ""}`));

function draftBody(draft: Draft, lines: readonly Line[], cw: ClientWork) {
  const review = reviewDraft({ draft, lines, client: cw.client?.value ?? null, current: cw.current, work: cw.work, claims: cw.claims });
  return { draft: publicDraft(draft), lines: orderLines(lines).map(publicLine), review, resolvedOn: cw.resolvedOn };
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export async function readEligibleWork(deps: InvoicingDeps, caller: FinanceCaller, clientId: string, from: string, to: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  const cw = await loadClientWork(deps, org, clientId, from, to, at, today);
  if ("status" in cw) return cw;
  if (!cw.client) return fail(404, "client_not_found", "No such client in your organisation");
  const c = cw.client.value;
  const w = cw.work;
  const t = w.available.reduce((a, r) => ({ net: a.net + (r.expected?.netMinor ?? 0), vat: a.vat + (r.expected?.vatMinor ?? 0), gross: a.gross + (r.expected?.grossMinor ?? 0) }), { net: 0, vat: 0, gross: 0 });
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: INVOICING_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      client: { clientId: c.clientId, name: c.name, status: c.status, billingMethod: c.billingMethod, hubBilling: c.billingMethod === "hub" },
      period: { from, to },
      resolvedOn: today,
      summary: {
        available: { occurrences: w.available.length, currency: "GBP", net: formatMinor(t.net), vat: formatMinor(t.vat), gross: formatMinor(t.gross) },
        alreadyClaimed: w.claimed.length,
        awaitingConfirmation: w.pending.length,
        setupProblems: w.setup.length,
        withoutTerms: w.noTerms.length,
        notInvoiceable: w.other.length,
      },
      available: w.available.map((r) => publicWorkItem(r)),
      claimed: w.claimed.map((x) => publicWorkItem(x.resolution, x.claim)),
      pending: w.pending.map((r) => publicWorkItem(r)),
      setupProblems: w.setup.map((r) => publicWorkItem(r)),
      withoutTerms: w.noTerms.map((r) => publicWorkItem(r)),
      notInvoiceable: w.other.map((r) => publicWorkItem(r)),
    },
  };
}

export async function listClientDrafts(deps: InvoicingDeps, caller: FinanceCaller, clientId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let rows: Row[];
  try {
    rows = await listClientDraftRows(deps.airtable, org.recordId, clientId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const d = buildDrafts(rows, org.recordId);
  if (!d.ok) return fail(409, "invoice_draft_data_invalid", d.error);
  const drafts = d.drafts.map((x) => x.value).sort((a, b) => `${b.periodFrom} ${b.createdAt ?? ""}`.localeCompare(`${a.periodFrom} ${a.createdAt ?? ""}`));
  return { status: "ok", httpStatus: 200, body: { contract: INVOICING_CONTRACT, organisation: orgBody(org), access: auth.access, clientId, drafts: drafts.map(publicDraft) } };
}

export async function readDraft(deps: InvoicingDeps, caller: FinanceCaller, draftId: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  const l = await loadDraft(deps, org, draftId);
  if ("status" in l) return l;
  const draft = l.draft.value;
  const lines = l.lines.map((x) => x.value);
  const cw = await loadClientWork(deps, org, draft.clientId, draft.periodFrom, draft.periodTo, at, today, lines.map((x) => x.occurrenceId));
  if ("status" in cw) return cw;
  return { status: "ok", httpStatus: 200, body: { contract: INVOICING_CONTRACT, organisation: orgBody(org), access: auth.access, ...draftBody(draft, lines, cw) } };
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

export type DraftWrite =
  | { route: "draft.create"; req: CreateRequest }
  | { route: "draft.refresh"; draftId: string; reason: string | null }
  | { route: "line.exclude"; draftId: string; lineId: string; reason: string }
  | { route: "line.restore"; draftId: string; lineId: string; reason: string | null }
  | { route: "line.not_billable"; draftId: string; lineId: string; reason: string; overrideId: string }
  | { route: "draft.details"; draftId: string; req: DetailsRequest }
  | { route: "draft.ready"; draftId: string; revision: number; reason: string | null }
  | { route: "draft.reopen"; draftId: string; reason: string };

type AuditRow = ReturnType<typeof draftAuditEvent>;
type Plan = { kind: "noop"; draft: Draft; lines: Line[] } | { kind: "run"; httpStatus: 200 | 201; run: (txn: DraftTxn) => Promise<{ events: AuditRow[]; draft: Draft; lines: Line[] }> } | Fail;

const ROUTE_PATHS: Record<DraftWrite["route"], (i: any) => string> = {
  "draft.create": () => "POST /invoice-drafts",
  "draft.refresh": (i) => `POST /invoice-drafts/${i.draftId}/refresh`,
  "line.exclude": (i) => `POST /invoice-drafts/${i.draftId}/lines/${i.lineId}/exclude`,
  "line.restore": (i) => `POST /invoice-drafts/${i.draftId}/lines/${i.lineId}/restore`,
  "line.not_billable": (i) => `POST /invoice-drafts/${i.draftId}/lines/${i.lineId}/not-billable`,
  "draft.details": (i) => `POST /invoice-drafts/${i.draftId}/details`,
  "draft.ready": (i) => `POST /invoice-drafts/${i.draftId}/ready`,
  "draft.reopen": (i) => `POST /invoice-drafts/${i.draftId}/reopen`,
};

export async function writeDraft(deps: InvoicingDeps, caller: FinanceCaller, input: DraftWrite): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;

  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_invoicing_unavailable", "The change could not be saved just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");

  try {
    const atDate = now(deps);
    const at = atDate.toISOString();
    const today = todayIn(org.timezone, atDate);
    const route = ROUTE_PATHS[input.route](input);
    const base = { contract: INVOICING_CONTRACT, organisation: orgBody(org), access: "manage" };
    const ev = (eventType: string, draftId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null, context: Record<string, unknown> = {}) =>
      draftAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, draftId, before, after, reason, route, context });

    let plan: Plan;
    let cw: ClientWork;
    if (input.route === "draft.create") {
      const r = input.req;
      let draftRows: Row[];
      try {
        draftRows = await listClientDraftRows(deps.airtable, org.recordId, r.clientId);
      } catch (e) {
        console.error(e);
        return unavailable();
      }
      const ds = buildDrafts(draftRows, org.recordId);
      if (!ds.ok) return fail(409, "invoice_draft_data_invalid", ds.error);
      const loaded = await loadClientWork(deps, org, r.clientId, r.from, r.to, atDate, today);
      if ("status" in loaded) return loaded;
      cw = loaded;
      plan = planCreate(deps, cw, ds.drafts.map((d) => d.value), r, { userId: caller.userId, at, today, orgRecordId: org.recordId, ev });
    } else {
      const l = await loadDraft(deps, org, input.draftId);
      if ("status" in l) return l;
      const d = l.draft.value;
      const loaded = await loadClientWork(deps, org, d.clientId, d.periodFrom, d.periodTo, atDate, today, l.lines.map((x) => x.value.occurrenceId));
      if ("status" in loaded) return loaded;
      cw = loaded;
      plan = planDraftWrite(deps, cw, l.draft, l.lines, input, { userId: caller.userId, at, today, orgRecordId: org.recordId, ev });
    }
    if ("status" in plan) return plan;
    if (plan.kind === "noop") return { status: "ok", httpStatus: 200, body: { ...base, changed: false, ...draftBody(plan.draft, plan.lines, cw) } };

    const txn = new DraftTxn(deps);
    let result;
    try {
      result = await plan.run(txn);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_invoicing_unaudited", "The change was partly saved and could not be undone - contact support before changing this draft again");
      return fail(503, "finance_invoicing_unavailable", "The change could not be saved just now - nothing was changed");
    }
    try {
      await insertAuditEvents(deps.grants, result.events);
    } catch (e) {
      console.error(e);
      if (!(await txn.rollback())) return fail(500, "finance_invoicing_unaudited", "The change was saved but could not be audited or undone - contact support before changing this draft again");
      return fail(503, "finance_audit_unavailable", "The change could not be saved just now (it could not be recorded) - nothing was changed");
    }
    // The claims now include this request's own lines.
    const claims = [...cw.claims.filter((c) => !result.lines.some((l) => l.lineId === c.lineId)), ...result.lines.filter((l) => l.status === "included").map((l) => ({ lineId: l.lineId, draftId: l.draftId, occurrenceId: l.occurrenceId }))];
    const after: ClientWork = { ...cw, claims, work: classifyWork([...cw.current.values()], claims) };
    return { status: "ok", httpStatus: plan.httpStatus, body: { ...base, changed: true, ...draftBody(result.draft, result.lines, after) } };
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

type Meta = { userId: string; at: string; today: string; orgRecordId: string; ev: (eventType: string, draftId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null, context?: Record<string, unknown>) => AuditRow };

function uniqueIds(deps: InvoicingDeps, prefix: "FID" | "FIL", n: number, taken: Set<string>): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    let id = "";
    for (let i = 0; i < 5 && (!id || taken.has(id)); i++) id = newDraftId(prefix, hex(deps));
    if (taken.has(id)) throw new Error(`could not allocate a unique ${prefix} id`);
    taken.add(id);
    out.push(id);
  }
  return out;
}

const withTotals = (d: Draft, lines: readonly Line[]): Draft => ({ ...d, ...totalsOf(lines) });

function planCreate(deps: InvoicingDeps, cw: ClientWork, drafts: Draft[], req: CreateRequest, m: Meta): Plan {
  if (!cw.client) return fail(404, "client_not_found", "No such client in your organisation");
  const client = cw.client.value;
  const p = planDraftCreate({ client, drafts, work: cw.work, from: req.from, to: req.to, settingsDefaultTerms: cw.settingsDays });
  if (!p.ok) return fail(p.httpStatus, p.code, p.error);
  const [draftId] = uniqueIds(deps, "FID", 1, new Set(drafts.map((d) => d.draftId)));
  const lineIds = uniqueIds(deps, "FIL", cw.work.available.length, new Set());
  const lines = cw.work.available.map((r, i) => lineFromResolution(r, { lineId: lineIds[i], draftId }, { userId: m.userId, at: m.at, resolvedOn: m.today }));
  const draft: Draft = withTotals(
    {
      draftId,
      clientId: client.clientId,
      clientName: client.name,
      status: "draft",
      periodFrom: req.from,
      periodTo: req.to,
      paymentTermsDays: p.terms.days,
      paymentTermsSource: p.terms.source,
      poRequired: client.poRequired,
      poNumber: null,
      poOverrideReason: null,
      netMinor: 0,
      vatMinor: 0,
      grossMinor: 0,
      includedLines: 0,
      revision: 1,
      createdBy: m.userId,
      createdAt: m.at,
      readyBy: null,
      readyAt: null,
      updatedBy: m.userId,
      updatedAt: m.at,
    },
    lines
  );
  return {
    kind: "run",
    httpStatus: 201,
    run: async (txn) => {
      await txn.create(INVOICING_TABLES.drafts, [draftFields(draft, { userId: m.userId, at: m.at }, m.orgRecordId)]);
      await txn.create(INVOICING_TABLES.lines, lines.map((l) => lineCreateFields(l, m.orgRecordId)));
      return {
        events: [m.ev(DRAFT_EVENTS.created, draftId, null, { draft: auditDraft(draft), lines: lines.map(auditLine) }, null, { clientId: client.clientId, periodFrom: req.from, periodTo: req.to, lineCount: lines.length })],
        draft,
        lines,
      };
    },
  };
}

function planDraftWrite(deps: InvoicingDeps, cw: ClientWork, stored: StoredDraft, storedLines: StoredLine[], input: Exclude<DraftWrite, { route: "draft.create" }>, m: Meta): Plan {
  const before = stored.value;
  const lines = storedLines.map((l) => l.value);
  const bump = (d: Draft, ls: readonly Line[]): Draft => ({ ...withTotals(d, ls), revision: before.revision + 1, updatedBy: m.userId, updatedAt: m.at });
  const patchDraft = (after: Draft) => ({ id: stored.recordId, fields: draftFields(after, { userId: m.userId, at: m.at }), restore: draftRestoreFields(before) });
  const notOpen = () => fail(409, "draft_not_open", `${before.draftId} is ${before.status === "ready_for_issue" ? "Ready for issue - its snapshot is frozen; return it to Draft first" : "not open"}`);

  if (input.route === "draft.reopen") {
    if (before.status === "draft") return { kind: "noop", draft: before, lines };
    const after: Draft = { ...bump(before, lines), status: "draft", readyBy: null, readyAt: null };
    return {
      kind: "run",
      httpStatus: 200,
      run: async (txn) => {
        await txn.patch(INVOICING_TABLES.drafts, [patchDraft(after)]);
        return { events: [m.ev(DRAFT_EVENTS.returnedToDraft, before.draftId, auditDraft(before), auditDraft(after), input.reason, { readyAt: before.readyAt })], draft: after, lines };
      },
    };
  }

  if (input.route === "draft.ready") {
    if (before.status === "ready_for_issue") return { kind: "noop", draft: before, lines };
    if (input.revision !== before.revision) return fail(409, "draft_revision_mismatch", `The draft changed since you reviewed it (you reviewed revision ${input.revision}, it is now revision ${before.revision}) - review it again`);
    const review = reviewDraft({ draft: before, lines, client: cw.client?.value ?? null, current: cw.current, work: cw.work, claims: cw.claims });
    if (!review.readyForIssue) return fail(409, "draft_has_blockers", `The draft cannot be marked Ready for issue: ${review.blockers.map((b) => b.message).join(" | ")}`, Object.fromEntries(review.blockers.map((b) => [b.code, b.message])));
    const after: Draft = { ...bump(before, lines), status: "ready_for_issue", readyBy: m.userId, readyAt: m.at };
    return {
      kind: "run",
      httpStatus: 200,
      run: async (txn) => {
        await txn.patch(INVOICING_TABLES.drafts, [patchDraft(after)]);
        return {
          events: [m.ev(DRAFT_EVENTS.markedReady, before.draftId, auditDraft(before), auditDraft(after), input.reason, { reviewedRevision: input.revision, warnings: review.warnings.map((w) => w.code), gross: review.totals.gross })],
          draft: after,
          lines,
        };
      },
    };
  }

  if (before.status !== "draft") return notOpen();

  if (input.route === "draft.refresh") {
    if (!cw.client) return fail(409, "client_not_found", `Client ${before.clientId} no longer exists in Finance - the draft cannot be refreshed`);
    const p = planRefresh({ draft: before, lines, current: cw.current, work: cw.work, client: cw.client.value, settingsDefaultTerms: cw.settingsDays });
    if (!p.changed) return { kind: "noop", draft: before, lines };
    const replaced = p.close.filter((c) => c.replacement);
    const toAdd = [...replaced.map((c) => c.replacement as Resolution), ...p.add];
    const newIds = uniqueIds(deps, "FIL", toAdd.length, new Set(lines.map((l) => l.lineId)));
    const created = toAdd.map((r, i) => lineFromResolution(r, { lineId: newIds[i], draftId: before.draftId }, { userId: m.userId, at: m.at, resolvedOn: m.today }));
    const replacementOf = new Map(replaced.map((c, i) => [c.line.lineId, created[i].lineId]));
    const added = created.slice(replaced.length);
    const closed = p.close.map((c) => ({ stored: storedLines.find((s) => s.value.lineId === c.line.lineId) as StoredLine, after: { ...c.line, status: c.status, statusReason: c.reason, statusChangedBy: m.userId, statusChangedAt: m.at, supersededBy: replacementOf.get(c.line.lineId) ?? null } as Line }));
    const allLines = [...lines.map((l) => closed.find((c) => c.after.lineId === l.lineId)?.after ?? l), ...created];
    const after: Draft = { ...bump({ ...before, ...p.header }, allLines) };
    return {
      kind: "run",
      httpStatus: 200,
      run: async (txn) => {
        await txn.create(INVOICING_TABLES.lines, created.map((l) => lineCreateFields(l, m.orgRecordId)));
        await txn.patch(INVOICING_TABLES.lines, closed.map((c) => ({ id: c.stored.recordId, fields: lineStatusFields(c.after), restore: lineStatusFields(c.stored.value) })));
        await txn.patch(INVOICING_TABLES.drafts, [patchDraft(after)]);
        return {
          events: [
            m.ev(DRAFT_EVENTS.refreshed, before.draftId, auditDraft(before), {
              draft: auditDraft(after),
              added: added.map(auditLine),
              removed: closed.filter((c) => c.after.status === "removed").map((c) => ({ ...auditLine(c.after), reason: c.after.statusReason })),
              superseded: closed.filter((c) => c.after.status === "superseded").map((c) => ({ from: auditLine(c.stored.value), to: auditLine(created.find((l) => l.lineId === c.after.supersededBy) as Line) })),
            }, input.reason),
          ],
          draft: after,
          lines: allLines,
        };
      },
    };
  }

  if (input.route === "draft.details") {
    const r = input.req;
    let next: Draft = { ...before };
    if (r.poNumber !== undefined) next.poNumber = r.poNumber;
    if (r.poOverrideReason !== undefined) next.poOverrideReason = r.poOverrideReason;
    if (r.paymentTermsDays !== undefined) {
      if (r.paymentTermsDays === null) {
        if (!cw.client) return fail(409, "client_not_found", `Client ${before.clientId} no longer exists in Finance`);
        const t = defaultPaymentTerms(cw.client.value, cw.settingsDays);
        next = { ...next, paymentTermsDays: t.days, paymentTermsSource: t.source };
      } else next = { ...next, paymentTermsDays: r.paymentTermsDays, paymentTermsSource: "invoice_override" as TermsSource };
    }
    const poChanged = next.poNumber !== before.poNumber;
    const ovChanged = next.poOverrideReason !== before.poOverrideReason;
    const termsChanged = next.paymentTermsDays !== before.paymentTermsDays || next.paymentTermsSource !== before.paymentTermsSource;
    if (!poChanged && !ovChanged && !termsChanged) return { kind: "noop", draft: before, lines };
    const after = bump(next, lines);
    const events: AuditRow[] = [];
    if (poChanged) events.push(m.ev(DRAFT_EVENTS.poUpdated, before.draftId, { poNumber: before.poNumber, revision: before.revision }, { poNumber: after.poNumber, revision: after.revision }, r.reason, { poRequired: before.poRequired }));
    if (ovChanged) events.push(m.ev(DRAFT_EVENTS.poOverrideRecorded, before.draftId, { poOverrideReason: before.poOverrideReason, revision: before.revision }, { poOverrideReason: after.poOverrideReason, revision: after.revision }, after.poOverrideReason ?? r.reason, { poRequired: before.poRequired, cleared: after.poOverrideReason === null }));
    if (termsChanged) events.push(m.ev(DRAFT_EVENTS.paymentTermsChanged, before.draftId, { paymentTermsDays: before.paymentTermsDays, paymentTermsSource: before.paymentTermsSource, revision: before.revision }, { paymentTermsDays: after.paymentTermsDays, paymentTermsSource: after.paymentTermsSource, revision: after.revision }, r.reason));
    return {
      kind: "run",
      httpStatus: 200,
      run: async (txn) => {
        await txn.patch(INVOICING_TABLES.drafts, [patchDraft(after)]);
        return { events, draft: after, lines };
      },
    };
  }

  // ----- line routes -----
  const sl = storedLines.find((l) => l.value.lineId === input.lineId);
  if (!sl) return fail(404, "invoice_line_not_found", `No line ${input.lineId} on ${before.draftId}`);
  const line = sl.value;
  const lineChange = (status: Line["status"], reason: string | null, eventType: string, context: Record<string, unknown> = {}): Plan => {
    const changedLine: Line = { ...line, status, statusReason: reason, statusChangedBy: m.userId, statusChangedAt: m.at, supersededBy: null };
    const allLines = lines.map((l) => (l.lineId === line.lineId ? changedLine : l));
    const after = bump(before, allLines);
    return {
      kind: "run",
      httpStatus: 200,
      run: async (txn) => {
        await txn.patch(INVOICING_TABLES.lines, [{ id: sl.recordId, fields: lineStatusFields(changedLine), restore: lineStatusFields(line) }]);
        await txn.patch(INVOICING_TABLES.drafts, [patchDraft(after)]);
        return {
          events: [m.ev(eventType, before.draftId, { line: auditLine(line), draft: auditDraft(before) }, { line: auditLine(changedLine), draft: auditDraft(after) }, reason, { lineId: line.lineId, occurrenceId: line.occurrenceId, ...context })],
          draft: after,
          lines: allLines,
        };
      },
    };
  };

  if (input.route === "line.exclude") {
    if (line.status === "excluded") return { kind: "noop", draft: before, lines };
    if (line.status !== "included") return fail(409, "invoice_line_not_active", `Line ${line.lineId} is ${line.status} - only an included line can be excluded`);
    return lineChange("excluded", input.reason, DRAFT_EVENTS.lineExcluded);
  }

  if (input.route === "line.restore") {
    if (line.status === "included") return { kind: "noop", draft: before, lines };
    if (line.status !== "excluded") return fail(409, "invoice_line_not_active", `Line ${line.lineId} is ${line.status} - only an excluded line can be restored`);
    const other = cw.claims.find((c) => c.occurrenceId === line.occurrenceId && c.lineId !== line.lineId);
    if (other) return fail(409, "occurrence_claimed", `This occurrence is already included on ${other.draftId === before.draftId ? "another line of this draft" : `draft ${other.draftId}`} (${other.lineId}) - it cannot be billed twice`);
    const r = cw.current.get(line.occurrenceId);
    if (!r || r.outcome !== "eligible") return fail(409, "occurrence_not_invoiceable", `The occurrence cannot be restored: ${notInvoiceableReason(r)}`);
    return lineChange("included", input.reason, DRAFT_EVENTS.lineRestored);
  }

  // line.not_billable (after the F4 override was recorded)
  if (line.status === "removed" || line.status === "superseded") return { kind: "noop", draft: before, lines };
  return lineChange("removed", `Marked not billable (${input.overrideId}): ${input.reason}`, DRAFT_EVENTS.lineMarkedNotBillable, { overrideId: input.overrideId, previousStatus: line.status });
}

/**
 * "Mark not billable" from a draft line: delegates to the F4 override path
 * (POST /occurrences/{id}/billing-overrides, kind not_billable - its own
 * validation, lock and audit), then removes the line from this draft under
 * the lock. An occurrence that is already not billable in F4 goes straight
 * to the second step. If the second step fails, F4 still says not billable
 * and the draft review shows the line as changed until it is refreshed.
 */
export async function markLineNotBillable(deps: InvoicingDeps, caller: FinanceCaller, draftId: string, lineId: string, reason: string): Promise<Ok | Fail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const l = await loadDraft(deps, auth.organisation, draftId);
  if ("status" in l) return l;
  if (l.draft.value.status !== "draft") return fail(409, "draft_not_open", `${draftId} is Ready for issue - its snapshot is frozen; return it to Draft first`);
  const line = l.lines.find((x) => x.value.lineId === lineId)?.value;
  if (!line) return fail(404, "invoice_line_not_found", `No line ${lineId} on ${draftId}`);
  if (line.status !== "included" && line.status !== "excluded") return fail(409, "invoice_line_not_active", `Line ${lineId} is ${line.status} - it is not on this invoice`);

  const f4 = await writeOverride(deps, caller, { route: "override.create", occurrenceId: line.occurrenceId, req: { kind: "not_billable", quantity: null, amountMinor: null, reason, supersedes: null } });
  let override: Record<string, unknown>;
  if (f4.status === "ok") override = f4.body.override as Record<string, unknown>;
  else if (f4.code === "billing_override_exists") {
    // Already not billable in F4 (an active decision with another reason): use it, never overwrite it.
    const cur = await readOccurrenceBilling(deps, caller, line.occurrenceId);
    const ov = cur.status === "ok" ? ((cur.body.billing as any).overrides as any[]).find((o) => o.active && o.kind === "not_billable") : null;
    if (!ov) return fail(409, f4.code, f4.error);
    override = ov;
  } else return f4;

  const res = await writeDraft(deps, caller, { route: "line.not_billable", draftId, lineId, reason, overrideId: String(override.overrideId) });
  if (res.status !== "ok") return { ...res, error: `The occurrence is now not billable in Finance (${override.overrideId}), but this draft could not be updated: ${res.error} - refresh the draft` };
  return { ...res, body: { ...res.body, override } };
}
