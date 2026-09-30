/**
 * Finance Foundation F7 - receivables + payments received + overdue + client credit.
 * Run: node --experimental-strip-types tests/support/finance-receivables.test.ts
 *
 *   RB  receivable boundary (issued = receivable; awaiting external issue never; credit notes; no due date)
 *   PY  payments (full, partial, second payment, overpayment refused, concurrency, received date, immutability / reversal)
 *   OD  due / overdue (calendar days, organisation time zone, partial remainder, paid never overdue, asOf projection)
 *   CN  credit-note effect (reduces receivable, never cash)
 *   CC  client credit (from an already-paid correction, from an overpayment, apply / unapply / void, cross-client, limits)
 *   AR  actual receipt fact (trusted cash only)
 *   DD  deliberate due date moves (original kept, overdue follows)
 *   AC  access + tenant
 *   AU  audit (exact events; none on reads / refusals; rollback)
 *   PF  bounded reads
 *   RT  routes + request parsing
 *   Z   code / drift checks against the canonical finance files
 *
 * The harness (fetch mock, fixtures, F5 / F6 helpers) is the F6 suite's, unchanged.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, parseUpdateBody, toStoredFields } from "./finance-settings.ts";
import { updateFinanceSettings } from "./finance-settings-orchestrator.ts";
import { TABLES } from "./finance-commercial-mapping.ts";
import { COMMERCIAL_RETRY_DELAYS_MS } from "./finance-commercial-repository.ts";
import { SETTINGS_RETRY_DELAYS_MS } from "./finance-settings-repository.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type CommercialDeps, type WriteInput, writeCommercial } from "./finance-commercial-orchestrator.ts";
import { parseClientCreate, parseClientUpdate } from "./finance-commercial.ts";
import { clientFromRow } from "./finance-commercial-mapping.ts";
import { BILLING_TABLES } from "./finance-billing-mapping.ts";
import { type OverrideInput, readOccurrenceBilling, writeOverride } from "./finance-billing-orchestrator.ts";
import { parseOverrideCreate } from "./finance-billing.ts";
import { checkInvoicingQuery, formatDay, matchInvoicingRoute, parseDetails, parseDraftCreate, parseReady, parseReasonBody, parseTermsException } from "./finance-invoicing.ts";
import { INVOICING_TABLES, buildDrafts, buildLines } from "./finance-invoicing-mapping.ts";
import { WRITE_BATCH } from "./finance-invoicing-repository.ts";
import { type DraftWrite, listClientDrafts, markLineNotBillable, readDraft, readEligibleWork, writeDraft } from "./finance-invoicing-orchestrator.ts";
import { addDays, checkInvoiceListQuery, formatHubInvoiceNumber, invoiceNumberPlan, matchIssueRoute, parseCreditNote, parseIssue, parseReplacement, planCreditNote } from "./finance-issue.ts";
import { ISSUE_TABLES, buildInvoices } from "./finance-issue-mapping.ts";
import { createCreditNote, issueDraft, listInvoiceCreditNotes, listInvoices, readCreditNote, readInvoice, startReplacementDraft } from "./finance-issue-orchestrator.ts";
import { parseMoney } from "./finance-money.ts";
import { buildInvoices as buildInvoicesF7 } from "./finance-issue-mapping.ts";
import {
  checkReceiptsQuery,
  checkReceivablesQuery,
  daysBetween,
  matchReceivablesRoute,
  parseApplication,
  parseCreditCreate,
  parseDueDateChange,
  parsePayment,
  parseRequiredReason,
  planDueDateChange,
  receivableOf,
} from "./finance-receivables.ts";
import { RECEIVABLE_TABLES } from "./finance-receivables-mapping.ts";
import {
  applyClientCredit,
  changeDueDate,
  creditFromCreditNote,
  creditFromOverpayment,
  listClientCredits,
  listInvoicePayments,
  listReceipts,
  listReceivables,
  readClientCredit,
  readReceivable,
  recordPayment,
  reverseApplication,
  reversePayment,
  voidClientCredit,
} from "./finance-receivables-orchestrator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

const ORG = "ORG-TEST-001";
const ORG_REC = "recYXqi1DTZ8ZECPQ";
const OTHER_ORG_REC = "recOtherOrgRow001";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const VIEWER = "aaaaaaaa-e0d4-4257-8121-5f16781e97ba";
const g = (level: unknown): FinanceGrantRow => ({ organisation_id: ORG, access_level: level, revoked_at: null });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
const viewer = { userId: VIEWER, role: "management", active: true, organisationId: ORG };

const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7, invoiceNumberAuthority: "hub" as const, invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001 };
const settingsRow = (s: any) => ({ id: "recSettingsRow001", fields: { Organisation: [ORG_REC], "Finance Settings ID": "FINSET", Revision: 1, ...Object.fromEntries(Object.entries(toStoredFields(s, Object.keys(s) as any)).filter(([, v]) => v !== null)) } });

// ---------------------------------------------------------------------------
// fetch mock (filterByFormula is IGNORED on purpose: the repository must re-check every row in code)
// ---------------------------------------------------------------------------
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  tables: Record<string, { id: string; fields: Record<string, any> }[]>;
  audit: any[];
  lockHeld: string | null;
  lockMode: "ok" | "busy" | "error";
  settingsLockHeld: string | null;
  settingsLockMode: "ok" | "busy" | "error";
  /** Every settings-lock acquire / release, in order (to prove it is held across the whole issue). */
  settingsLockLog: string[];
  failCreateOn?: string;
  failPatchOn?: string;
  auditStatus?: number;
  undoStatus?: number;
  failedThisRequest?: boolean;
}
let world: World;
let calls: { url: string; method: string; body?: any }[] = [];
let recSeq = 0;
let hexSeq = 0;
let NOW = new Date("2026-09-29T12:00:00.000Z");
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };
function reset() {
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")] },
    moduleOn: true,
    tables: {
      [TABLES.clients]: [],
      [TABLES.services]: [],
      [TABLES.terms]: [],
      [TABLES.lifecycle]: [],
      "Finance Settings": [settingsRow(SETTINGS)],
      [BILLING_TABLES.overrides]: [],
      [BILLING_TABLES.occurrences]: [],
      [BILLING_TABLES.sessions]: [],
      [INVOICING_TABLES.drafts]: [],
      [INVOICING_TABLES.lines]: [],
      [ISSUE_TABLES.invoices]: [],
      [ISSUE_TABLES.lines]: [],
      [ISSUE_TABLES.creditNotes]: [],
      [RECEIVABLE_TABLES.payments]: [],
      [RECEIVABLE_TABLES.credits]: [],
      [RECEIVABLE_TABLES.applications]: [],
      [RECEIVABLE_TABLES.dueChanges]: [],
    },
    audit: [],
    lockHeld: null,
    lockMode: "ok",
    settingsLockHeld: null,
    settingsLockMode: "ok",
    settingsLockLog: [],
  };
  calls = [];
  NOW = new Date("2026-09-29T12:00:00.000Z");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tableOf = (url: string) => Object.keys(world.tables).find((t) => new URL(url).pathname.split("/")[3] === encodeURIComponent(t));
const clean = (fields: Record<string, any>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== false));
const tick = () => new Promise((r) => setTimeout(r, 0));

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick(); // every request yields, so concurrent requests really interleave
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, method, body });
  if (url.includes("/rest/v1/finance_access_grants")) {
    const m = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(m ? world.grants[m[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockMode === "error") return json({ message: "boom" }, 500);
    if (world.lockMode === "busy" || world.lockHeld) return json(null);
    world.lockHeld = "22222222-2222-4222-8222-222222222222";
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld && body?.p_lock_key === `commercial:${ORG}`;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rpc/acquire_finance_settings_lock")) {
    if (world.settingsLockMode === "error") return json({ message: "boom" }, 500);
    if (body?.p_organisation_id !== ORG) return json({ message: "wrong org" }, 400);
    if (world.settingsLockMode === "busy" || world.settingsLockHeld) return json(null);
    world.settingsLockHeld = "33333333-3333-4333-8333-333333333333";
    world.settingsLockLog.push("acquire");
    return json(world.settingsLockHeld);
  }
  if (url.includes("/rpc/release_finance_settings_lock")) {
    const ok = body?.p_lock_token === world.settingsLockHeld && body?.p_organisation_id === ORG;
    if (ok) {
      world.settingsLockHeld = null;
      world.settingsLockLog.push("release");
    }
    return json(ok);
  }
  if (url.includes("/rest/v1/finance_audit_events") && method === "POST") {
    if (world.auditStatus) {
      world.failedThisRequest = true;
      return json({ message: "audit down" }, world.auditStatus);
    }
    const rows = (Array.isArray(body) ? body : [body]).map((e: any, i: number) => ({ id: `aud-${world.audit.length + i + 1}`, ...e }));
    world.audit.push(...rows);
    return json(rows.map((r: any) => ({ id: r.id })), 201);
  }
  if (url.startsWith("https://api.airtable.com/")) {
    if (url.includes(encodeURIComponent("Organisation & Branding"))) return json({ records: [ORG_ROW] });
    if (url.includes(encodeURIComponent("Feature Controls"))) return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
    const t = tableOf(url);
    if (!t) return json({ records: [] });
    const rows = world.tables[t];
    const id = new URL(url).pathname.split("/")[4];
    if (method === "GET") {
      if (id) {
        const rec = rows.find((r) => r.id === id);
        return rec ? json(rec) : json({ error: "NOT_FOUND" }, 404);
      }
      return json({ records: rows });
    }
    const isUndo = world.failedThisRequest;
    if (isUndo && world.undoStatus) return json({ error: "undo boom" }, world.undoStatus);
    if (method === "POST") {
      if (world.failCreateOn === t) {
        world.failedThisRequest = true;
        return json({ error: "boom" }, 422);
      }
      if (body.records.length > WRITE_BATCH) return json({ error: "TOO_MANY_RECORDS" }, 422);
      const recs = body.records.map((r: any) => ({ id: `rec${String(++recSeq).padStart(14, "0")}`, fields: clean(r.fields) }));
      rows.push(...recs);
      return json({ records: recs });
    }
    if (method === "PATCH") {
      if (world.failPatchOn === t && !isUndo) {
        world.failedThisRequest = true;
        return json({ error: "boom" }, 422);
      }
      const ups = id ? [{ id, fields: body.fields }] : body.records;
      if (ups.length > WRITE_BATCH) return json({ error: "TOO_MANY_RECORDS" }, 422);
      const out = [];
      for (const u of ups) {
        const rec = rows.find((r) => r.id === u.id);
        if (!rec) return json({ error: "NOT_FOUND" }, 404);
        for (const [k, v] of Object.entries(u.fields)) {
          if (v === null || v === false) delete rec.fields[k];
          else rec.fields[k] = v;
        }
        out.push(rec);
      }
      return json(id ? out[0] : { records: out });
    }
    if (method === "DELETE") {
      const ids = id ? [id] : new URL(url).searchParams.getAll("records[]");
      world.tables[t] = rows.filter((r) => !ids.includes(r.id));
      return json({ records: ids.map((x) => ({ deleted: true, id: x })) });
    }
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

const deps: CommercialDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  randomHex: () => (++hexSeq).toString(16).padStart(12, "0") + "a".repeat(20),
};
const fresh = () => {
  world.failedThisRequest = false;
};
const W = (input: WriteInput, caller: any = mgr) => (fresh(), writeCommercial(deps, caller, input) as Promise<any>);
const OW = (input: OverrideInput, caller: any = mgr) => (fresh(), writeOverride(deps, caller, input) as Promise<any>);
const DW = (input: DraftWrite, caller: any = mgr) => (fresh(), writeDraft(deps, caller, input) as Promise<any>);
const create = (clientId: string, from = "2026-09-01", to = "2026-09-30", caller: any = mgr) => DW({ route: "draft.create", req: { clientId, from, to } }, caller);
const read = (draftId: string, caller: any = mgr) => readDraft(deps, caller, draftId) as Promise<any>;
const elig = (clientId: string, from = "2026-09-01", to = "2026-09-30", caller: any = mgr) => readEligibleWork(deps, caller, clientId, from, to) as Promise<any>;
const exclude = (draftId: string, lineId: string, reason = "School asked to bill it next month") => DW({ route: "line.exclude", draftId, lineId, reason });
const restore = (draftId: string, lineId: string) => DW({ route: "line.restore", draftId, lineId, reason: null });
const refresh = (draftId: string) => DW({ route: "draft.refresh", draftId, reason: null });
const details = (draftId: string, body: string) => {
  const p = parseDetails(body, isTenantKey) as any;
  if (!p.ok) throw new Error(`bad details ${body}`);
  return DW({ route: "draft.details", draftId, req: p.req });
};
const ready = (draftId: string, revision: number) => DW({ route: "draft.ready", draftId, revision, reason: null });
const reopen = (draftId: string, reason = "School queried a date") => DW({ route: "draft.reopen", draftId, reason });
const notBillable = (draftId: string, lineId: string, reason = "Goodwill - coach arrived late") => (fresh(), markLineNotBillable(deps, mgr, draftId, lineId, reason) as Promise<any>);
const ovCreate = (occurrenceId: string, body: string) => {
  const p = parseOverrideCreate(body, isTenantKey) as any;
  if (!p.ok) throw new Error(`bad override ${body}`);
  return OW({ route: "override.create", occurrenceId, req: p.req });
};
const airtableGets = () => calls.filter((c) => c.method === "GET" && c.url.startsWith("https://api.airtable.com/"));
const airtableWrites = () => calls.filter((c) => c.method !== "GET" && c.url.startsWith("https://api.airtable.com/"));
const lineRows = () => world.tables[INVOICING_TABLES.lines];
const draftRows = () => world.tables[INVOICING_TABLES.drafts];
const lineOf = (body: any, occurrenceId: string, status = "included") => body.lines.find((l: any) => l.occurrenceId === occurrenceId && l.status === status);
const codes = (xs: any[]) => xs.map((x) => x.code).sort().join(",");

// ---------------------------------------------------------------------------
// Fixtures: Parkside (PO required, 30-day terms) and St Anne's (no PO, no terms override)
// ---------------------------------------------------------------------------
function addSession(recId: string, sessionId: string, financeServiceId: string | null) {
  world.tables[BILLING_TABLES.sessions].push({ id: recId, fields: { "Session ID": sessionId, "Session Name": `${sessionId} name`, ...(financeServiceId ? { "Finance Service ID": financeServiceId } : {}) } });
}
function addOcc(sessionRec: string, date: string, o: { status?: string; conf?: string | null; exception?: string } = {}) {
  const id = `${sessionRec}:${date}`;
  world.tables[BILLING_TABLES.occurrences].push({
    id: `recOcc${String(world.tables[BILLING_TABLES.occurrences].length).padStart(11, "0")}`,
    fields: {
      "Occurrence ID": id,
      Session: [sessionRec],
      Date: date,
      "Start Date & Time": `${date}T14:30:00.000Z`,
      "End Date & Time": `${date}T15:30:00.000Z`,
      Status: o.status ?? "Scheduled",
      ...(o.conf === null ? {} : { "Confirmation State": o.conf ?? "Confirmed" }),
      ...(o.exception ? { "Exception Reason": o.exception } : {}),
    },
  });
  return id;
}

const PPA = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 5000, vatTreatment: "plus_vat" as const };
const AFTER = { payer: "client" as const, chargeType: "per_player" as const, amountMinor: 900, vatTreatment: "no_vat" as const, defaultBillableQuantity: 18 };
const BREAKFAST = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 6000, vatTreatment: "vat_included" as const };
const CAMP = { payer: "parent" as const, chargeType: "per_player" as const, amountMinor: 2500, vatTreatment: "no_vat" as const, defaultBillableQuantity: 20 };
const STANNES = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 4500, vatTreatment: "plus_vat" as const };

const S = { ppa: "recSessPPA0000001", after: "recSessAFT0000001", breakfast: "recSessBRK0000001", camp: "recSessCMP0000001", stannes: "recSessSTA0000001", none: "recSessNON0000001" };

async function seed() {
  reset();
  const pk = (await W({ route: "clients.create", client: { name: "TEST Parkside Primary", billingEmail: "billing.parkside@test.invalid", paymentTermsDaysOverride: 30, poRequired: true }, reason: null })).body.client.clientId as string;
  const sa = (await W({ route: "clients.create", client: { name: "TEST St Anne's", billingEmail: "office@stannes.test" }, reason: null })).body.client.clientId as string;
  const mk = async (clientId: string, name: string, input: any) => (await W({ route: "services.create", clientId, name, initial: { effectiveFrom: "2026-09-01", input }, reason: null })).body.service.serviceId as string;
  const ids = { parkside: pk, stannes: sa, ppa: await mk(pk, "PPA", PPA), after: await mk(pk, "After-school", AFTER), breakfast: await mk(pk, "Breakfast club", BREAKFAST), camp: await mk(pk, "Holiday camp", CAMP), sa: await mk(sa, "PPA", STANNES) };
  addSession(S.ppa, "TEST-PPA", ids.ppa);
  addSession(S.after, "TEST-AFTER", ids.after);
  addSession(S.breakfast, "TEST-BREAKFAST", ids.breakfast);
  addSession(S.camp, "TEST-CAMP", ids.camp);
  addSession(S.stannes, "TEST-STANNES", ids.sa);
  addSession(S.none, "TEST-NONE", null);
  calls = [];
  world.audit = [];
  return ids;
}

// ---------------------------------------------------------------------------
// F6 helpers
// ---------------------------------------------------------------------------
const issue = (draftId: string, revision: number, caller: any = mgr, reason: string | null = null) => (fresh(), issueDraft(deps, caller, draftId, revision, reason) as Promise<any>);
const readInv = (invoiceId: string, caller: any = mgr) => readInvoice(deps, caller, invoiceId) as Promise<any>;
const credit = (invoiceId: string, lineIds: string[] | null = null, reason = "School disputed the session", caller: any = mgr) => (fresh(), createCreditNote(deps, caller, invoiceId, lineIds, reason) as Promise<any>);
const replace = (creditNoteId: string, reason = "Re-bill at the corrected figures", caller: any = mgr) => (fresh(), startReplacementDraft(deps, caller, creditNoteId, reason) as Promise<any>);
const invRows = () => world.tables[ISSUE_TABLES.invoices];
const invLineRows = () => world.tables[ISSUE_TABLES.lines];
const cnRows = () => world.tables[ISSUE_TABLES.creditNotes];
const tableOfCall = (c: { url: string }) => decodeURIComponent(new URL(c.url).pathname.split("/")[3] ?? "");
/** create (+ PO when required) + Ready; returns the Ready draft body */
async function readyDraft(clientId: string, from = "2026-09-01", to = "2026-09-30") {
  const d = (await create(clientId, from, to)).body;
  let rev = d.draft.revision;
  if (d.draft.po.required) { const x = await details(d.draft.draftId, '{"poNumber":"PO-77"}'); if (x.status !== "ok") throw new Error(`fixture details: ${x.code} ${x.error}`); rev = x.body.draft.revision; }
  const r = await ready(d.draft.draftId, rev);
  if (r.status !== "ok") throw new Error(`fixture draft not Ready: ${r.code} ${r.error}`);
  return r.body;
}
const stripVolatile = (b: any) => JSON.stringify({ invoice: b.invoice, lines: b.lines });
const settingsRows = () => world.tables["Finance Settings"];
/** Replace this organisation's stored Finance Settings (SETTINGS + patch). */
const setSettings = (patch: Record<string, unknown>) => {
  settingsRows()[0] = settingsRow({ ...SETTINGS, ...patch });
};
const nextNumber = () => settingsRows()[0].fields["Next Invoice Number"];
const HUB = { invoiceNumberAuthority: "hub", invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001, invoiceNumberDigits: null };
const settingsUpdate = (settings: Record<string, unknown>) => {
  const p = parseUpdateBody(JSON.stringify({ settings }), isTenantKey) as any;
  if (!p.ok) throw new Error("bad settings update");
  return updateFinanceSettings(deps, mgr, p) as Promise<any>;
};


// ---------------------------------------------------------------------------
// F7 helpers
// ---------------------------------------------------------------------------
const RTB = RECEIVABLE_TABLES;
const payRows = () => world.tables[RTB.payments];
const creditRows = () => world.tables[RTB.credits];
const appRows = () => world.tables[RTB.applications];
const dueRows = () => world.tables[RTB.dueChanges];
const mn = (s: string) => (parseMoney(s) as any).minor as number;
const types = () => world.audit.map((e) => e.event_type).join(",");
async function issueFor(clientId: string, occs: [string, string][]) {
  for (const [s, d] of occs) addOcc(s, d);
  const rd = await readyDraft(clientId);
  const r = await issue(rd.draft.draftId, rd.draft.revision);
  if (r.status !== "ok") throw new Error(`fixture issue: ${r.code} ${r.error}`);
  return r.body as any;
}
const lineFor = (body: any, sess: string, date: string) => body.lines.find((l: any) => l.occurrenceId === `${sess}:${date}`).lineId as string;
const pay = (invoiceId: string, body: Record<string, unknown>, caller: any = mgr): Promise<any> => {
  const p = parsePayment(JSON.stringify(body), isTenantKey) as any;
  if (!p.ok) return Promise.resolve(p);
  fresh();
  return recordPayment(deps, caller, invoiceId, p.req) as Promise<any>;
};
const rrec = (invoiceId: string, asOf: string | null = null, caller: any = mgr) => readReceivable(deps, caller, invoiceId, asOf) as Promise<any>;
const rlist = (clientId: string | null = null, asOf: string | null = null, caller: any = mgr) => listReceivables(deps, caller, clientId, asOf) as Promise<any>;
const revPay = (paymentId: string, reason = "Recorded against the wrong invoice", caller: any = mgr) => (fresh(), reversePayment(deps, caller, paymentId, reason) as Promise<any>);
const moveDue = (invoiceId: string, dueDate: string, reason = "School agreed to pay after half term", caller: any = mgr) => (fresh(), changeDueDate(deps, caller, invoiceId, dueDate, reason) as Promise<any>);
const noteCredit = (creditNoteId: string, amount: string, reason = "Client keeps the value for next term", caller: any = mgr) => (fresh(), creditFromCreditNote(deps, caller, creditNoteId, mn(amount), reason) as Promise<any>);
const overCredit = (paymentId: string, amount: string, reason = "Client paid too much - keep it for the next invoice", caller: any = mgr) => (fresh(), creditFromOverpayment(deps, caller, paymentId, mn(amount), reason) as Promise<any>);
const apply = (creditId: string, invoiceId: string, amount: string, caller: any = mgr) => (fresh(), applyClientCredit(deps, caller, creditId, invoiceId, mn(amount), null) as Promise<any>);
const unapply = (applicationId: string, reason = "Applied to the wrong invoice", caller: any = mgr) => (fresh(), reverseApplication(deps, caller, applicationId, reason) as Promise<any>);
const voidC = (creditId: string, reason = "Created in error", caller: any = mgr) => (fresh(), voidClientCredit(deps, caller, creditId, reason) as Promise<any>);
const receipts = (from = "2026-09-01", to = "2027-06-30", caller: any = mgr) => listReceipts(deps, caller, from, to) as Promise<any>;
const patchesOn = (t: string) => calls.filter((c) => c.method === "PATCH" && tableOfCall(c) === t);
const TODAY = "2026-09-29";
const at = (iso: string) => {
  NOW = new Date(iso);
};

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== RB. Receivable boundary =====
  {
    const ids = await seed();
    const b = await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]]);
    const inv = b.invoice;
    world.audit = [];
    calls = [];
    const r = await rrec(inv.invoiceId);
    const rv = r.body.receivable;
    ck("RB1. A Hub-issued invoice is a receivable: 222.00 outstanding, unpaid, not due (30 days to go), nothing received", r.httpStatus === 200 && rv.receivable === true && rv.amounts.gross === "222.00" && rv.amounts.outstanding === "222.00" && rv.amounts.cashReceived === "0.00" && rv.settlement === "unpaid" && rv.state === "not_due" && rv.dueState === "not_due" && rv.daysUntilDue === 30 && rv.daysOverdue === null && rv.dueDate === "2026-10-29" && rv.invoiceDate === TODAY && rv.officialNumber === "INV-1001" && r.body.payments.length === 0);
    ck("RB1b. Reads write nothing and audit nothing", airtableWrites().length === 0 && world.audit.length === 0);
    setSettings({ invoiceNumberAuthority: "xero" });
    const aw = (await issueFor(ids.stannes, [[S.stannes, "2026-09-10"]])).invoice;
    const ar = await rrec(aw.invoiceId);
    const l = await rlist();
    world.audit = [];
    calls = [];
    const p = await pay(aw.invoiceId, { amount: "10.00", receivedDate: TODAY });
    const d = await moveDue(aw.invoiceId, "2026-11-30");
    ck("RB2. An invoice awaiting external issue (Xero) is NOT a receivable: no due date / state, not listed (only counted), no payment, no due-date move; nothing written", aw.status === "awaiting_external_issue" && ar.httpStatus === 200 && ar.body.receivable.receivable === false && ar.body.receivable.reason === "awaiting_external_issue" && ar.body.receivable.dueDate === undefined && ar.body.receivable.amounts === undefined && !l.body.receivables.some((x: any) => x.invoiceId === aw.invoiceId) && l.body.receivables.some((x: any) => x.invoiceId === inv.invoiceId) && l.body.summary.notReceivable.awaitingExternalIssue === 1 && p.code === "invoice_not_issued" && d.code === "invoice_not_issued" && airtableWrites().length === 0 && world.audit.length === 0);
    at("2027-06-01T12:00:00.000Z");
    const far = await rrec(aw.invoiceId);
    const farList = await rlist(null, "2027-12-31");
    ck("RB2b / OD17. Awaiting-Xero never becomes due or overdue, whatever the date (and is never in aged debt)", far.body.receivable.receivable === false && far.body.receivable.state === undefined && !farList.body.receivables.some((x: any) => x.invoiceId === aw.invoiceId) && farList.body.summary.overdue === "222.00");
    at("2026-09-29T12:00:00.000Z");
    setSettings({});
    const cn = await credit(inv.invoiceId, [lineFor(b, S.ppa, "2026-09-10")]);
    const r3 = (await rrec(inv.invoiceId)).body.receivable;
    ck("RB3 / CN18. A credited (corrected) invoice resolves from history: 222.00 - 60.00 credit note = 162.00 outstanding; the invoice gross is unchanged", cn.httpStatus === 201 && r3.amounts.gross === "222.00" && r3.amounts.creditNotes === "60.00" && r3.amounts.outstanding === "162.00" && r3.amounts.cashReceived === "0.00" && r3.settlement === "unpaid" && invRows()[0].fields["Gross (Minor Units)"] === 22200);
    const v = (buildInvoicesF7(invRows(), ORG_REC) as any).invoices.find((x: any) => x.value.invoiceId === inv.invoiceId).value;
    const empty = { notes: [], payments: [], paymentReversals: [], applications: [], applicationReversals: [], creditsFromNotes: [], dueChanges: [] };
    const nd = receivableOf({ ...v, dueDate: null }, empty, TODAY) as any;
    const ndMove = planDueDateChange({ invoice: { ...v, dueDate: null }, rec: nd, newDueDate: "2026-11-01", reason: "x", changeId: "FDD-000000000001", meta: { userId: MGR, at: NOW.toISOString(), today: TODAY } }) as any;
    ck("RB4. No due date -> an explicit no_due_date result (never guessed, never overdue); a due-date move refuses it", nd.dueState === "no_due_date" && nd.state === "no_due_date" && nd.daysOverdue === null && nd.outstandingMinor === 22200 && ndMove.code === "no_due_date");
  }

  // ===== PY. Payments =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    world.audit = [];
    calls = [];
    const r = await pay(inv.invoiceId, { amount: "222.00", receivedDate: TODAY, method: "bank_transfer", reference: "BACS 4471", reason: "Remittance advice received" });
    const rv = r.body.receivable;
    const row = payRows()[0]?.fields ?? {};
    ck("PY5. Full payment: 201; outstanding 0.00, state Paid, cash received 222.00; the payment is its own record (amount, date, method, reference, source manual, recorded by / at)", r.httpStatus === 201 && rv.amounts.outstanding === "0.00" && rv.settlement === "paid" && rv.state === "paid" && rv.dueState === "settled" && rv.amounts.cashReceived === "222.00" && rv.paymentCount === 1 && rv.lastPaymentDate === TODAY && r.body.payment.amount === "222.00" && r.body.payment.source === "manual" && /^FPY-[0-9A-F]{12}$/.test(r.body.payment.paymentId) && row["Entry Type"] === "Payment" && row["Amount (Minor Units)"] === 22200 && row["Received Date"] === TODAY && row.Method === "Bank transfer" && row.Reference === "BACS 4471" && row.Source === "Manual" && row["Recorded By User ID"] === MGR && row["Invoice ID"] === inv.invoiceId);
    ck("PY5b. The invoice row is never touched (no invoice / line / credit-note write); exactly one payment row + one audit event", airtableWrites().every((c) => tableOfCall(c) === RTB.payments) && payRows().length === 1 && types() === "finance_payment.recorded" && world.audit[0].entity_type === "finance_payment" && world.audit[0].record_id === r.body.payment.paymentId && world.audit[0].before.receivable.outstandingMinor === 22200 && world.audit[0].after.receivable.outstandingMinor === 0 && world.audit[0].context.outstandingMinorAfter === 0 && world.audit[0].reason === "Remittance advice received");
    world.audit = [];
    calls = [];
    const again = await pay(inv.invoiceId, { amount: "1.00", receivedDate: TODAY });
    ck("PY5c. A paid invoice takes no further payment (409 invoice_settled); nothing written", again.code === "invoice_settled" && airtableWrites().length === 0 && world.audit.length === 0);
  }
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    const p1 = await pay(inv.invoiceId, { amount: "100.00", receivedDate: "2026-09-20" });
    const r1 = p1.body.receivable;
    ck("PY6. Partial payment: 100.00 received -> 122.00 outstanding, Partially paid (state partially_paid before the due date)", p1.httpStatus === 201 && r1.amounts.cashReceived === "100.00" && r1.amounts.outstanding === "122.00" && r1.settlement === "partially_paid" && r1.state === "partially_paid" && r1.dueState === "not_due");
    const p2 = await pay(inv.invoiceId, { settleRemaining: true, receivedDate: TODAY });
    const r2 = p2.body.receivable;
    ck("PY7. A second payment clears the remainder (settleRemaining = exactly the 122.00 outstanding): Paid, 2 payments, last payment date", p2.httpStatus === 201 && p2.body.payment.amount === "122.00" && r2.amounts.outstanding === "0.00" && r2.amounts.cashReceived === "222.00" && r2.settlement === "paid" && r2.paymentCount === 2 && r2.lastPaymentDate === TODAY && payRows().length === 2);
    const hist = await listInvoicePayments(deps, mgr, inv.invoiceId) as any;
    ck("PY7b. Payment history lists both payments (active, counted as cash)", hist.body.payments.length === 2 && hist.body.payments.every((x: any) => x.status === "active" && x.countsAsCashReceived) && hist.body.cashReceived === "222.00" && hist.body.outstanding === "0.00");
  }
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    world.audit = [];
    calls = [];
    const over = await pay(inv.invoiceId, { amount: "222.01", receivedDate: TODAY });
    ck("PY8. Overpayment refused (409 payment_exceeds_outstanding, points to client credit); no payment row, no audit", over.code === "payment_exceeds_outstanding" && /client credit/.test(over.error) && payRows().length === 0 && airtableWrites().length === 0 && world.audit.length === 0);
    const [a, b2] = await Promise.all([pay(inv.invoiceId, { amount: "222.00", receivedDate: TODAY }), pay(inv.invoiceId, { amount: "222.00", receivedDate: TODAY })]);
    const okN = [a, b2].filter((x) => x.httpStatus === 201).length;
    const other = [a, b2].find((x) => x.httpStatus !== 201);
    ck("PY9. Two simultaneous full payments: exactly one lands; the other is refused (409 busy) - never an overpayment", okN === 1 && other?.code === "finance_commercial_busy" && payRows().length === 1 && world.lockHeld === null);
    const after = await pay(inv.invoiceId, { amount: "222.00", receivedDate: TODAY });
    ck("PY9b. Retrying the lost one finds nothing outstanding (409 invoice_settled) - cash never exceeds the invoice", after.code === "invoice_settled" && payRows().length === 1);
  }
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    const p = await pay(inv.invoiceId, { amount: "50.00", receivedDate: "2026-09-15" });
    world.audit = [];
    calls = [];
    const fut = await pay(inv.invoiceId, { amount: "5.00", receivedDate: "2026-09-30" });
    const noDate = parsePayment('{"amount":"5.00"}', isTenantKey) as any;
    ck("PY10. The real received date is stored and returned (2026-09-15, not today); a future date is refused (409); receivedDate is required (400) - never assumed", p.body.payment.receivedDate === "2026-09-15" && payRows()[0].fields["Received Date"] === "2026-09-15" && fut.code === "received_date_in_future" && noDate.code === "invalid_input" && !!noDate.fields.receivedDate && airtableWrites().length === 0 && world.audit.length === 0);
    const before = JSON.stringify(payRows()[0]);
    calls = [];
    world.audit = [];
    const rv = await revPay(p.body.payment.paymentId);
    const again = await revPay(p.body.payment.paymentId);
    const h = (await rrec(inv.invoiceId)).body;
    ck("PY11. A payment is never edited: a reversal is a NEW record (full amount, reason); the original row is unchanged; cash drops back; reversing twice is refused", rv.httpStatus === 201 && /^FPR-/.test(rv.body.reversal.reversalId) && payRows().length === 2 && JSON.stringify(payRows()[0]) === before && payRows()[1].fields["Entry Type"] === "Reversal" && payRows()[1].fields["Reverses Payment ID"] === p.body.payment.paymentId && payRows()[1].fields["Amount (Minor Units)"] === 5000 && h.receivable.amounts.cashReceived === "0.00" && h.receivable.amounts.outstanding === "222.00" && h.payments[0].status === "reversed" && h.payments[0].countsAsCashReceived === false && again.code === "payment_already_reversed" && patchesOn(RTB.payments).length === 0 && types() === "finance_payment.reversed");
    ck("PY11b. Reversal needs a reason (400); the reversal audit keeps before / after outstanding", (parseRequiredReason("{}", isTenantKey, "reversed") as any).fields.reason === "is required" && world.audit[0].before.status === "active" && world.audit[0].after.status === "reversed" && world.audit[0].context.outstandingMinorBefore === 17200 && world.audit[0].context.outstandingMinorAfter === 22200);
  }

  // ===== OD. Due / overdue =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    const s = async () => (await rrec(inv.invoiceId)).body.receivable;
    const a = await s();
    ck("OD12. Before the due date: not due (30 days until due)", a.dueState === "not_due" && a.state === "not_due" && a.daysUntilDue === 30);
    at("2026-10-29T08:00:00.000Z");
    const b = await s();
    ck("OD13. On the due date: due today (0 days, not overdue)", b.dueState === "due_today" && b.state === "due_today" && b.daysUntilDue === 0 && b.daysOverdue === null);
    at("2026-11-01T08:00:00.000Z");
    const c = await s();
    ck("OD14. After the due date: overdue by the calendar-day count (3)", c.dueState === "overdue" && c.state === "overdue" && c.daysOverdue === 3);
    at("2026-10-29T23:30:00.000Z");
    const d1 = await s();
    at("2026-10-30T00:30:00.000Z");
    const d2 = await s();
    ck("OD14b. Calendar days in the organisation's time zone (not elapsed hours): 23:30 on the due date = due today; 00:30 the next day = overdue 1", d1.dueState === "due_today" && d2.dueState === "overdue" && d2.daysOverdue === 1);
    ck("OD14c. Calendar arithmetic across clock changes, month / year ends and leap days", daysBetween("2026-10-24", "2026-10-26") === 2 && daysBetween("2026-03-28", "2026-03-30") === 2 && daysBetween("2028-02-28", "2028-03-01") === 2 && daysBetween("2026-12-31", "2027-01-01") === 1 && daysBetween("2026-10-29", "2026-10-29") === 0);
    at("2026-09-29T12:00:00.000Z");
    const proj = (await rrec(inv.invoiceId, "2026-11-05")).body.receivable;
    const past = await rrec(inv.invoiceId, "2026-09-01");
    ck("OD14d. asOf projects forward (2026-11-05 -> overdue 7); an asOf in the past is refused (400) - no historical balances", proj.dueState === "overdue" && proj.daysOverdue === 7 && proj.asOf === "2026-11-05" && past.httpStatus === 400 && past.code === "invalid_input");
    await pay(inv.invoiceId, { amount: "100.00", receivedDate: TODAY });
    at("2026-11-01T08:00:00.000Z");
    const e = await s();
    ck("OD15. A partial payment can still be overdue on the remainder (122.00 overdue by 3 days; settlement Partially paid)", e.state === "overdue" && e.settlement === "partially_paid" && e.amounts.outstanding === "122.00" && e.daysOverdue === 3);
    const l1 = await rlist();
    ck("OD15b. The receivables list gives outstanding + due date + overdue days (enough for aged-debt buckets later) and summary totals", l1.body.receivables.length === 1 && l1.body.receivables[0].daysOverdue === 3 && l1.body.receivables[0].dueDate === "2026-10-29" && l1.body.summary.overdue === "122.00" && l1.body.summary.outstanding === "122.00" && l1.body.summary.cashReceived === "100.00" && l1.body.summary.byState.overdue === 1);
    await pay(inv.invoiceId, { settleRemaining: true, receivedDate: "2026-11-01" });
    at("2027-01-01T08:00:00.000Z");
    const f = await s();
    const l2 = await rlist();
    ck("OD16. A paid invoice is never overdue (settled; no overdue days), whatever the date", f.state === "paid" && f.dueState === "settled" && f.daysOverdue === null && l2.body.summary.overdue === "0.00" && l2.body.summary.outstanding === "0.00");
    at("2026-09-29T12:00:00.000Z");
  }

  // ===== CN. Credit-note effect =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    await credit(inv.invoiceId, null);
    world.audit = [];
    calls = [];
    const r = (await rrec(inv.invoiceId)).body.receivable;
    const p = await pay(inv.invoiceId, { amount: "1.00", receivedDate: TODAY });
    const d = await moveDue(inv.invoiceId, "2026-12-01");
    at("2027-03-01T08:00:00.000Z");
    const late = (await rrec(inv.invoiceId)).body.receivable;
    at("2026-09-29T12:00:00.000Z");
    ck("CN19. A fully credited invoice has no cash outstanding: 0.00, 'nothing due' (not Paid), never overdue; payments and due moves refused", r.amounts.outstanding === "0.00" && r.amounts.creditNotes === "222.00" && r.settlement === "nothing_due" && r.state === "nothing_due" && late.state === "nothing_due" && late.daysOverdue === null && p.code === "invoice_settled" && d.code === "invoice_settled" && airtableWrites().length === 0 && world.audit.length === 0);
    const rc = await receipts();
    ck("CN20. A credit note is never cash received (cash 0.00; no receipt)", r.amounts.cashReceived === "0.00" && rc.body.receipts.length === 0 && rc.body.totals.cashReceived === "0.00");
  }

  // ===== CC. Client credit =====
  {
    const ids = await seed();
    const b1 = await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]]);
    const inv1 = b1.invoice;
    const invS = (await issueFor(ids.stannes, [[S.stannes, "2026-09-10"]])).invoice;
    await pay(inv1.invoiceId, { amount: "222.00", receivedDate: TODAY });
    const cn = (await credit(inv1.invoiceId, [lineFor(b1, S.ppa, "2026-09-10")])).body.creditNote;
    const ex = (await rrec(inv1.invoiceId)).body.receivable;
    ck("CC0. A credit note after full payment never shows a negative balance: outstanding 0.00, credit excess 60.00 (value the client already paid)", ex.amounts.outstanding === "0.00" && ex.amounts.creditExcess === "60.00" && ex.amounts.cashReceived === "222.00" && ex.settlement === "paid");
    world.audit = [];
    calls = [];
    const tooMuch = await noteCredit(cn.creditNoteId, "60.01");
    const cnS = (await credit(invS.invoiceId, null)).body.creditNote;
    world.audit = [];
    calls = [];
    const unpaid = await noteCredit(cnS.creditNoteId, "1.00");
    ck("CC21a. Client credit is refused above what the correction freed (409 credit_exceeds_available), and for a credit note that only reduced an unpaid invoice (409 no_credit_available); nothing written", tooMuch.code === "credit_exceeds_available" && unpaid.code === "no_credit_available" && creditRows().length === 0 && airtableWrites().length === 0 && world.audit.length === 0);
    const c = await noteCredit(cn.creditNoteId, "60.00");
    const cc = c.body.clientCredit;
    const after1 = (await rrec(inv1.invoiceId)).body.receivable;
    const crow = creditRows()[0]?.fields ?? {};
    ck("CC21. Create client credit from the paid correction: 60.00 available, source credit note, linked to the credit note + invoice; the credit note stays; no cash moves", c.httpStatus === 201 && /^FCC-/.test(cc.creditId) && cc.original === "60.00" && cc.remaining === "60.00" && cc.status === "available" && cc.source === "credit_note" && cc.sourceCreditNoteId === cn.creditNoteId && cc.sourceInvoiceId === inv1.invoiceId && cc.wasCashReceived === false && cc.appliedAutomatically === false && after1.amounts.creditExcess === "0.00" && after1.amounts.creditNotesKeptAsClientCredit === "60.00" && after1.amounts.outstanding === "0.00" && after1.amounts.cashReceived === "222.00" && cnRows().length === 2 && crow.Status === "Available" && crow["Remaining (Minor Units)"] === 6000 && types() === "finance_client_credit.created");
    const again = await noteCredit(cn.creditNoteId, "1.00");
    ck("CC21b. The same correction can never become client credit twice (409 no_credit_available)", again.code === "no_credit_available" && creditRows().length === 1);
    const cn2 = (await credit(inv1.invoiceId, [lineFor(b1, S.after, "2026-09-10")])).body.creditNote;
    const ex2 = (await rrec(inv1.invoiceId)).body.receivable;
    const twice = await noteCredit(cn.creditNoteId, "1.00");
    const over2 = await noteCredit(cn2.creditNoteId, "162.01");
    ck("CC21c. Even while the invoice holds more excess (a second credit note: 162.00), the first credit note's value is never kept twice (409 no_credit_available), and the second is capped at its own value (409 credit_exceeds_available)", ex2.amounts.creditExcess === "162.00" && twice.code === "no_credit_available" && over2.code === "credit_exceeds_available" && creditRows().length === 1);
    const b2 = await issueFor(ids.parkside, [[S.ppa, "2026-09-17"], [S.after, "2026-09-17"]]);
    const inv2 = b2.invoice;
    world.audit = [];
    calls = [];
    const a1 = await apply(cc.creditId, inv2.invoiceId, "25.00");
    const r2 = a1.body.invoice;
    ck("CC22. Apply part of the credit (25.00): invoice outstanding 222.00 -> 197.00, credit 60.00 -> 35.00 left (Available); cash received unchanged (0.00)", a1.httpStatus === 201 && /^FCA-/.test(a1.body.application.applicationId) && r2.amounts.outstanding === "197.00" && r2.amounts.clientCreditApplied === "25.00" && r2.amounts.cashReceived === "0.00" && r2.settlement === "partially_paid" && a1.body.clientCredit.remaining === "35.00" && a1.body.clientCredit.status === "available" && creditRows()[0].fields["Remaining (Minor Units)"] === 3500 && creditRows()[0].fields.Revision === 2 && types() === "finance_client_credit.applied" && world.audit[0].context.cashReceived === false);
    const cross = await apply(cc.creditId, invS.invoiceId, "1.00");
    ck("CC24. Cross-client application refused (409 client_mismatch)", cross.code === "client_mismatch");
    const aboveRem = await apply(cc.creditId, inv2.invoiceId, "35.01");
    ck("CC25. Above the credit remaining refused (409 credit_exceeds_remaining)", aboveRem.code === "credit_exceeds_remaining");
    const cash190 = await pay(inv2.invoiceId, { amount: "190.00", receivedDate: TODAY });
    const aboveOut = await apply(cc.creditId, inv2.invoiceId, "8.00");
    ck("CC26. Above the invoice outstanding refused (7.00 left; 409 credit_exceeds_outstanding); nothing written by the refusals", aboveOut.code === "credit_exceeds_outstanding" && appRows().length === 1);
    const a2 = await apply(cc.creditId, inv2.invoiceId, "7.00");
    ck("CC26b. Applying exactly the outstanding settles the invoice (Paid): 25.00 + 7.00 credit + 190.00 cash = 222.00; 28.00 credit left", a2.body.invoice.amounts.outstanding === "0.00" && a2.body.invoice.settlement === "paid" && a2.body.invoice.amounts.clientCreditApplied === "32.00" && a2.body.invoice.amounts.cashReceived === "190.00" && a2.body.clientCredit.remaining === "28.00");
    const b3 = await issueFor(ids.parkside, [[S.ppa, "2026-09-24"]]);
    const inv3 = b3.invoice;
    const a3 = await apply(cc.creditId, inv3.invoiceId, "28.00");
    const used = await apply(cc.creditId, inv3.invoiceId, "1.00");
    ck("CC23. Apply all remaining credit (28.00): credit Used (0.00 left); a further application is refused (409 client_credit_used)", a3.httpStatus === 201 && a3.body.clientCredit.remaining === "0.00" && a3.body.clientCredit.status === "used" && creditRows()[0].fields.Status === "Used" && a3.body.invoice.amounts.outstanding === "32.00" && used.code === "client_credit_used");
    const rc = await receipts();
    ck("CC27. Client credit applied is never cash received: receipts are only the 222.00 + 190.00 payments (412.00); invoice 3 shows 0.00 cash", rc.body.totals.cashReceived === "412.00" && rc.body.receipts.length === 2 && rc.body.receipts.every((x: any) => x.kind === "invoice_payment") && a3.body.invoice.amounts.cashReceived === "0.00");
    world.audit = [];
    calls = [];
    const un = await unapply(a3.body.application.applicationId);
    const un2 = await unapply(a3.body.application.applicationId);
    const read = (await readClientCredit(deps, mgr, cc.creditId)) as any;
    const r3 = (await rrec(inv3.invoiceId)).body.receivable;
    ck("CC28. Unapply restores both sides (credit 28.00 Available again; invoice 3 back to 60.00 outstanding); the application stays, marked reversed; a second unapply is refused", un.httpStatus === 201 && un.body.clientCredit.remaining === "28.00" && un.body.clientCredit.status === "available" && r3.amounts.outstanding === "60.00" && r3.amounts.clientCreditApplied === "0.00" && read.body.clientCredit.applications.length === 3 && read.body.clientCredit.applications.filter((x: any) => x.status === "reversed").length === 1 && read.body.clientCredit.remaining === "28.00" && un2.code === "application_already_reversed" && appRows().length === 4 && appRows()[3].fields["Entry Type"] === "Reversal" && types() === "finance_client_credit.application_reversed");
    const inUse = await voidC(cc.creditId);
    ck("CC28b. A credit that is still applied cannot be voided (409 client_credit_in_use)", inUse.code === "client_credit_in_use");
    // overpayment -> client credit
    const p190 = cash190.body.payment.paymentId;
    world.audit = [];
    calls = [];
    const oc = await overCredit(p190, "15.00");
    const occ = oc.body.clientCredit;
    const rc2 = await receipts();
    ck("CC29. Cash beyond the invoice kept as client credit (overpayment, 15.00): dated when that payment arrived, a cash receipt of its own; the invoice itself unchanged", oc.httpStatus === 201 && occ.source === "overpayment" && occ.sourcePaymentId === p190 && occ.receivedDate === TODAY && occ.wasCashReceived === true && rc2.body.totals.cashReceived === "427.00" && rc2.body.receipts.some((x: any) => x.kind === "overpayment_credit" && x.amount === "15.00") && oc.body.sourceInvoice.amounts.outstanding === "0.00" && types() === "finance_client_credit.created");
    const pay1 = (await listInvoicePayments(deps, mgr, inv1.invoiceId) as any).body.payments[0].paymentId;
    const p2 = await pay(inv3.invoiceId, { amount: "10.00", receivedDate: TODAY });
    const notSettled = await overCredit(p2.body.payment.paymentId, "1.00");
    const held = await revPay(p190);
    ck("CC29b. Only cash beyond a settled invoice can be kept (409 invoice_not_settled); a payment whose extra cash is held as credit cannot be reversed until that credit is voided (409 payment_has_client_credit)", notSettled.code === "invoice_not_settled" && held.code === "payment_has_client_credit" && !!pay1);
    world.audit = [];
    calls = [];
    const vd = await voidC(occ.creditId);
    const vd2 = await voidC(occ.creditId);
    const vApply = await apply(occ.creditId, inv3.invoiceId, "1.00");
    const rc3 = await receipts();
    const rv = await revPay(p190);
    ck("CC30. Void (unapplied credit only, reason kept): status Void, the record stays, no longer a receipt; void twice / apply a void credit refused; the payment can then be reversed", vd.httpStatus === 200 && vd.body.clientCredit.status === "void" && vd.body.clientCredit.void.reason === "Created in error" && creditRows().length === 2 && vd2.code === "client_credit_void" && vApply.code === "client_credit_void" && rc3.body.totals.cashReceived === "422.00" && rv.httpStatus === 201 && rv.body.receivable.amounts.outstanding === "190.00" && world.audit.map((e) => e.event_type).join(",") === "finance_client_credit.voided,finance_payment.reversed");
    const lc = (await listClientCredits(deps, mgr, ids.parkside)) as any;
    ck("CC31. Client credits are visible on the client (both, void included) with the available total (28.00); never applied automatically", lc.body.credits.length === 2 && lc.body.available === "28.00" && lc.body.appliedAutomatically === false && lc.body.credits.find((x: any) => x.creditId === cc.creditId).applications.length === 3);
    const byClient = await rlist(ids.stannes);
    ck("CC31b. The receivables list can be narrowed to one client (St Anne's: only its invoice)", byClient.body.receivables.length === 1 && byClient.body.receivables[0].invoiceId === invS.invoiceId && byClient.body.clientId === ids.stannes);
    ck("CC32. Credit rows are only ever patched through their state fields; payments / applications / due-date rows never patched", patchesOn(RTB.payments).length === 0 && patchesOn(RTB.applications).length === 0 && patchesOn(ISSUE_TABLES.invoices).length === 0);
  }

  // ===== AR. Actual receipt fact =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    const r0 = await receipts();
    ck("AR30. Issuing an invoice alone is no receipt (0.00, no rows) - issued / due / overdue is expected, not actual", r0.body.receipts.length === 0 && r0.body.totals.cashReceived === "0.00" && /never receipts/.test(r0.body.rule));
    const p = await pay(inv.invoiceId, { amount: "80.00", receivedDate: "2026-09-21", method: "cheque", reference: "CHQ 991" });
    const r1 = await receipts("2026-09-01", "2026-09-30");
    const x = r1.body.receipts[0];
    const out = await receipts("2026-10-01", "2026-10-31");
    ck("AR29. A manual payment is a trusted receipt: cash amount, received date, source manual, invoice, client (by received date)", r1.body.receipts.length === 1 && x.kind === "invoice_payment" && x.receiptId === p.body.payment.paymentId && x.amount === "80.00" && x.receivedDate === "2026-09-21" && x.source === "manual" && x.invoiceId === inv.invoiceId && x.client.clientId === ids.parkside && x.method === "cheque" && out.body.receipts.length === 0);
    await revPay(p.body.payment.paymentId);
    const r2 = await receipts("2026-09-01", "2026-09-30");
    ck("AR29b. A reversed payment is no receipt (listed apart as reversed, not counted)", r2.body.receipts.length === 0 && r2.body.reversedPayments.length === 1 && r2.body.reversedPayments[0].countsAsCashReceived === false);
    ck("AR29c. Receipts query: from/to required, to >= from, at most 366 days; tenant keys rejected", (checkReceiptsQuery(new URLSearchParams("from=2026-09-01"), isTenantKey) as any).fields.to && (checkReceiptsQuery(new URLSearchParams("from=2026-09-10&to=2026-09-01"), isTenantKey) as any).fields.to && (checkReceiptsQuery(new URLSearchParams("from=2026-01-01&to=2027-01-02"), isTenantKey) as any).fields.to && (checkReceiptsQuery(new URLSearchParams("from=2026-01-01&to=2027-01-01"), isTenantKey) as any).ok && (checkReceiptsQuery(new URLSearchParams("from=2026-01-01&to=2026-02-01&organisationId=X"), isTenantKey) as any).code === "tenant_param_rejected");
  }

  // ===== DD. Due date moves =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    at("2026-11-01T08:00:00.000Z");
    const before = (await rrec(inv.invoiceId)).body.receivable;
    const invBefore = JSON.stringify(invRows());
    world.audit = [];
    calls = [];
    const m1 = await moveDue(inv.invoiceId, "2026-11-15");
    const r1 = (await rrec(inv.invoiceId)).body;
    ck("DD31. A deliberate due date move moves overdue: overdue 3 -> not due (14 days to go) on the new date", before.state === "overdue" && m1.httpStatus === 201 && r1.receivable.dueDate === "2026-11-15" && r1.receivable.state === "not_due" && r1.receivable.daysUntilDue === 14 && r1.receivable.dueDateMoved === true);
    const e = world.audit[0];
    ck("DD32. The original due date is kept (on the invoice, untouched) and in history + audit; payment terms and invoice date never change", r1.receivable.originalDueDate === "2026-10-29" && JSON.stringify(invRows()) === invBefore && airtableWrites().every((c) => tableOfCall(c) === RTB.dueChanges) && r1.dueDateHistory.length === 1 && r1.dueDateHistory[0].previousDueDate === "2026-10-29" && r1.dueDateHistory[0].newDueDate === "2026-11-15" && types() === "finance_invoice.due_date_changed" && e.before.dueDate === "2026-10-29" && e.after.dueDate === "2026-11-15" && e.before.dueState === "overdue" && e.after.dueState === "not_due" && e.reason === "School agreed to pay after half term" && e.context.originalDueDate === "2026-10-29" && e.context.paymentTermsDays === 30 && (await readInv(inv.invoiceId)).body.invoice.dueDate === "2026-10-29");
    await moveDue(inv.invoiceId, "2026-11-20");
    const r2 = (await rrec(inv.invoiceId)).body;
    world.audit = [];
    calls = [];
    const early = await moveDue(inv.invoiceId, "2026-09-28");
    const same = await moveDue(inv.invoiceId, "2026-11-20");
    const noReason = parseDueDateChange('{"dueDate":"2026-12-01"}', isTenantKey) as any;
    ck("DD33. Moves chain (each keeps the previous); before the invoice date / unchanged refused (409); a reason is required (400); nothing written by refusals", r2.dueDateHistory.length === 2 && r2.dueDateHistory[1].previousDueDate === "2026-11-15" && r2.receivable.dueDate === "2026-11-20" && early.code === "due_date_before_invoice_date" && same.code === "due_date_unchanged" && noReason.fields.reason === "is required" && airtableWrites().length === 0 && world.audit.length === 0);
    at("2026-09-29T12:00:00.000Z");
  }

  // ===== AC. Access + tenant =====
  {
    const ids = await seed();
    const b = await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]]);
    const inv = b.invoice;
    const pmt = (await pay(inv.invoiceId, { amount: "222.00", receivedDate: TODAY })).body.payment;
    const cn = (await credit(inv.invoiceId, [lineFor(b, S.after, "2026-09-10")])).body.creditNote;
    const cc = (await noteCredit(cn.creditNoteId, "10.00")).body.clientCredit;
    world.audit = [];
    calls = [];
    const reads = [await rrec(inv.invoiceId, null, viewer), await rlist(null, null, viewer), await listInvoicePayments(deps, viewer, inv.invoiceId), await listClientCredits(deps, viewer, ids.parkside), await readClientCredit(deps, viewer, cc.creditId), await receipts(undefined, undefined, viewer)] as any[];
    ck("AC33. Finance View reads receivables, payments, client credits and receipts (200, access view)", reads.every((r) => r.httpStatus === 200 && r.body.access === "view"));
    const writes = [await pay(inv.invoiceId, { amount: "1.00", receivedDate: TODAY }, viewer), await revPay(pmt.paymentId, "x", viewer), await moveDue(inv.invoiceId, "2026-12-01", "x", viewer), await noteCredit(cn.creditNoteId, "1.00", "x", viewer), await overCredit(pmt.paymentId, "1.00", "x", viewer), await apply(cc.creditId, inv.invoiceId, "1.00", viewer), await voidC(cc.creditId, "x", viewer)];
    ck("AC34. Finance View cannot write anything (403 finance_manage_required); nothing written or audited", writes.every((w: any) => w.code === "finance_manage_required") && airtableWrites().length === 0 && world.audit.length === 0);
    world.grants[VIEWER] = [];
    const coach = { userId: "c", role: "coach", active: true, organisationId: ORG };
    const parent = { userId: "p", role: "parent", active: true, organisationId: ORG };
    const noGrant = await rrec(inv.invoiceId, null, viewer);
    const co = await rlist(null, null, coach);
    const pa = await pay(inv.invoiceId, { amount: "1.00", receivedDate: TODAY }, parent);
    world.moduleOn = false;
    const off = [await rrec(inv.invoiceId), await pay(inv.invoiceId, { amount: "1.00", receivedDate: TODAY }), await apply(cc.creditId, inv.invoiceId, "1.00")];
    world.moduleOn = true;
    ck("AC35. No grant -> 403 finance_access_denied; Coach / Parent -> 403 management_required; module off -> 403 finance_module_disabled (reads and writes)", noGrant.code === "finance_access_denied" && co.code === "management_required" && pa.code === "management_required" && off.every((x: any) => x.code === "finance_module_disabled"));
    const T = (raw: string, f: (r: string, t: (k: string) => boolean) => any) => f(raw, isTenantKey).code === "tenant_param_rejected";
    ck("AC35b. Tenant keys rejected in every F7 body and query", T('{"amount":"1.00","receivedDate":"2026-09-01","organisationId":"X"}', parsePayment) && T('{"dueDate":"2026-12-01","reason":"x","org":"Y"}', parseDueDateChange) && T('{"amount":"1.00","reason":"x","organisation_id":"Y"}', parseCreditCreate) && T('{"invoiceId":"FIV-0123456789AB","amount":"1.00","tenant":"Y"}', parseApplication) && (parseRequiredReason('{"reason":"x","orgId":"Y"}', isTenantKey, "reversed") as any).code === "tenant_param_rejected" && (checkReceivablesQuery(new URLSearchParams("organisationId=X"), true, isTenantKey) as any).code === "tenant_param_rejected");
    payRows().push({ id: "recForeignPay0001", fields: { Organisation: [OTHER_ORG_REC], "Payment Entry ID": "FPY-FFFFFFFFFFFF", "Entry Type": "Payment", "Invoice ID": inv.invoiceId, "Client ID": ids.parkside, "Client Name": "X", "Amount (Minor Units)": 5000, Currency: "GBP", "Received Date": TODAY, Source: "Manual", "Recorded By User ID": "x", "Recorded At": "2026-09-29T12:00:00.000Z" } });
    const iso = (await rrec(inv.invoiceId)).body.receivable;
    const foreign = await revPay("FPY-FFFFFFFFFFFF");
    ck("AC35c. Another organisation's payment row never counts and cannot be reversed (404)", iso.amounts.cashReceived === "222.00" && foreign.code === "payment_not_found");
  }

  // ===== AU. Audit + rollback =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    world.audit = [];
    calls = [];
    world.auditStatus = 500;
    const p = await pay(inv.invoiceId, { amount: "10.00", receivedDate: TODAY });
    world.auditStatus = undefined;
    ck("AU36a. If the audit cannot be written the payment is undone (503; no payment row, no audit)", p.httpStatus === 503 && p.code === "finance_audit_unavailable" && payRows().length === 0 && world.audit.length === 0 && world.lockHeld === null);
    await pay(inv.invoiceId, { amount: "222.00", receivedDate: TODAY });
    const b2 = await issueFor(ids.parkside, [[S.ppa, "2026-09-17"]]);
    const cn = (await credit(inv.invoiceId, null)).body.creditNote;
    const cc = (await noteCredit(cn.creditNoteId, "20.00")).body.clientCredit;
    const credBefore = JSON.stringify(creditRows());
    world.audit = [];
    calls = [];
    world.failPatchOn = RTB.credits;
    const a = await apply(cc.creditId, b2.invoice.invoiceId, "5.00");
    world.failPatchOn = undefined;
    ck("AU36b. If the credit update fails, the application row is removed again (503) - no half-applied credit, no audit", a.httpStatus === 503 && appRows().length === 0 && JSON.stringify(creditRows()) === credBefore && world.audit.length === 0);
    world.auditStatus = 500;
    world.undoStatus = 500;
    const u = await apply(cc.creditId, b2.invoice.invoiceId, "5.00");
    world.auditStatus = undefined;
    world.undoStatus = undefined;
    ck("AU36c. If the undo itself fails the caller gets 500 finance_receivables_unaudited (never 'success')", u.httpStatus === 500 && u.code === "finance_receivables_unaudited");
    const ev = await seed();
    const i2 = (await issueFor(ev.parkside, [[S.ppa, "2026-09-10"]])).invoice;
    world.audit = [];
    const w1 = await pay(i2.invoiceId, { amount: "60.00", receivedDate: TODAY });
    const e1 = world.audit.slice();
    ck("AU36d. Exact event per write: actor, organisation, record, before / after amounts, contract, route", e1.length === 1 && e1[0].actor_user_id === MGR && e1[0].organisation_id === ORG && e1[0].record_id === w1.body.payment.paymentId && e1[0].before.receivable.outstandingMinor === 6000 && e1[0].after.payment.amountMinor === 6000 && e1[0].context.contract === "finance-receivables-v1" && e1[0].context.route === `POST /invoices/${i2.invoiceId}/payments` && e1[0].context.invoiceId === i2.invoiceId);
    world.audit = [];
    calls = [];
    await rrec(i2.invoiceId);
    await rlist();
    await receipts();
    await listClientCredits(deps, mgr, ev.parkside);
    const bad = [await pay(i2.invoiceId, { amount: "0.01", receivedDate: TODAY }), await moveDue(i2.invoiceId, "2026-12-01"), await revPay("FPY-000000000000")];
    ck("AU37. Reads and rejected / no-op writes create no audit event and no write", bad[0].code === "invoice_settled" && bad[1].code === "invoice_settled" && bad[2].code === "payment_not_found" && world.audit.length === 0 && airtableWrites().length === 0);
  }

  // ===== PF. Bounded reads =====
  {
    const ids = await seed();
    const inv = (await issueFor(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]])).invoice;
    for (let i = 0; i < 5; i++) await pay(inv.invoiceId, { amount: "10.00", receivedDate: TODAY });
    calls = [];
    await rrec(inv.invoiceId);
    const r1 = airtableGets().length;
    calls = [];
    await rlist();
    const r2 = airtableGets().length;
    calls = [];
    await pay(inv.invoiceId, { amount: "10.00", receivedDate: TODAY });
    const r3 = airtableGets().length;
    ck("PF1. A fixed number of reads, whatever the number of payments: receivable read <= 10, list <= 9, payment write <= 10", r1 <= 10 && r2 <= 9 && r3 <= 10, `reads=${r1}/${r2}/${r3}`);
  }

  // ===== RT. Routes + parsing =====
  {
    const m = (p: string, meth: string) => matchReceivablesRoute(p, meth) as any;
    const I = "FIV-0123456789AB";
    ck("RT1. F7 routes: receivables / receipts / invoice receivable + payments (GET/POST) + due-date / payment reverse + overpayment credit / credit-note client credit / client credits / credit read + apply + void / application reverse", m("receivables", "GET").route.name === "receivables.list" && m("receipts", "GET").route.name === "receipts.list" && m(`invoices/${I}/receivable`, "GET").route.name === "invoice.receivable" && m(`invoices/${I}/payments`, "GET").route.name === "invoice.payments" && m(`invoices/${I}/payments`, "POST").route.name === "invoice.payment_create" && m(`invoices/${I}/due-date`, "POST").route.name === "invoice.due_date" && m("payments/FPY-0123456789AB/reverse", "POST").route.name === "payment.reverse" && m("payments/FPY-0123456789AB/overpayment-credit", "POST").route.name === "payment.overpayment_credit" && m("credit-notes/FCN-0123456789AB/client-credit", "POST").route.name === "credit_note.client_credit" && m("clients/FCL-0123456789AB/credits", "GET").route.name === "client.credits" && m("client-credits/FCC-0123456789AB", "GET").route.name === "client_credit.read" && m("client-credits/FCC-0123456789AB/applications", "POST").route.name === "client_credit.apply" && m("client-credits/FCC-0123456789AB/void", "POST").route.name === "client_credit.void" && m("client-credit-applications/FCA-0123456789AB/reverse", "POST").route.name === "application.reverse");
    ck("RT2. F6 / F3 paths are left alone (null); wrong method 405; malformed F7 ids 404", m(`invoices/${I}`, "GET") === null && m(`invoices/${I}/credit-notes`, "POST") === null && m("invoices", "GET") === null && m("credit-notes/FCN-0123456789AB", "GET") === null && m("credit-notes/FCN-0123456789AB/replacement-draft", "POST") === null && m("clients/FCL-0123456789AB", "GET") === null && m("clients/FCL-0123456789AB/services", "POST") === null && m("receivables", "POST").status === "method" && m(`invoices/${I}/due-date`, "GET").status === "method" && m("payments/FPY-bad/reverse", "POST").status === "not_found" && m("client-credits/FCC-bad", "GET").status === "not_found");
    ck("RT3. No reminder / send / Xero / Stripe / cash-flow / month-report routes", ["remind", "reminder", "send", "email", "xero", "sync", "stripe", "cash-flow"].every((x) => m(`invoices/${I}/${x}`, "POST") === null && m(`payments/FPY-0123456789AB/${x}`, "POST").status === "not_found") && m("cash-flow", "GET") === null && m("month-report", "GET") === null);
    const P = (o: unknown) => parsePayment(JSON.stringify(o), isTenantKey) as any;
    ck("RT4. Payment body: exactly one of amount / settleRemaining; amount a positive decimal string (<= 2 dp); method enum; reference <= 100; unknown fields rejected", P({ receivedDate: "2026-09-01" }).fields.amount && P({ amount: 10, receivedDate: "2026-09-01" }).fields.amount && P({ amount: "0", receivedDate: "2026-09-01" }).fields.amount && P({ amount: "-5", receivedDate: "2026-09-01" }).fields.amount && P({ amount: "1.234", receivedDate: "2026-09-01" }).fields.amount && P({ amount: "5", settleRemaining: true, receivedDate: "2026-09-01" }).fields.amount && P({ amount: "5", receivedDate: "2026-09-01", method: "bitcoin" }).fields.method && P({ amount: "5", receivedDate: "2026-09-01", reference: "x".repeat(101) }).fields.reference && P({ amount: "5", receivedDate: "2026-09-01", paid: true }).code === "unexpected_field" && P({ amount: "5.5", receivedDate: "2026-09-01" }).req.amountMinor === 550 && P({ settleRemaining: true, receivedDate: "2026-09-01" }).req.settleRemaining === true && P({ amount: "5", receivedDate: "2026-02-30" }).fields.receivedDate);
    ck("RT5. Credit / application / due-date bodies: amount + reason required; invoiceId must be FIV-; dueDate a real date", (parseCreditCreate('{"amount":"5"}', isTenantKey) as any).fields.reason && (parseCreditCreate('{"reason":"x"}', isTenantKey) as any).fields.amount && (parseApplication('{"invoiceId":"FCL-0123456789AB","amount":"5"}', isTenantKey) as any).fields.invoiceId && (parseApplication('{"invoiceId":"FIV-0123456789AB","amount":"5"}', isTenantKey) as any).ok && (parseDueDateChange('{"dueDate":"2026-13-01","reason":"x"}', isTenantKey) as any).fields.dueDate && (checkReceivablesQuery(new URLSearchParams("clientId=FCL-0123456789AB&asOf=2026-10-01"), true, isTenantKey) as any).asOf === "2026-10-01" && (checkReceivablesQuery(new URLSearchParams("clientId=FCL-0123456789AB"), false, isTenantKey) as any).code === "unexpected_parameter");
  }

  // ===== Z. Code / drift =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const F7 = ["finance-receivables.ts", "finance-receivables-mapping.ts", "finance-receivables-repository.ts", "finance-receivables-orchestrator.ts"];
    const all = F7.map((f) => noComments(code(f))).join("\n");
    ck("Z1. Domain + mapping are pure (no fetch / Deno / Supabase / Airtable URLs)", ["finance-receivables.ts", "finance-receivables-mapping.ts"].every((f) => !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(code(f))));
    ck("Z2. No Xero / Stripe integration, reminders / email, Needs Attention, Cash Flow or Month Report code in F7 (\"xero\" is only a future payment source value)", !/api\.xero|xero\.com|xeroClient|stripe|sendEmail|sendReminder|needs_attention|needsAttention|cashFlow|monthReport|pdf/i.test(all));
    const orch = code("finance-receivables-orchestrator.ts");
    ck("Z3. Reads + writes authorise via F1 authorizeFinance (read + manage); no new auth path", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && !/createClient|profiles/.test(orch));
    ck("Z4. The shared Finance write lock (commercial:{org}) and a single audit insert are reused", /acquireWriteLock\(deps\.grants, lockKey\(org\)\)/.test(orch) && (orch.match(/insertAuditEvents\(/g) || []).length === 1 && /`commercial:\$\{o\.organisationId\}`/.test(orch));
    ck("Z5. F7 never writes an F6 invoice / line / credit-note row; history rows are only created; only client credits are patched, and only through clientCreditStateFields", !/txn\.(create|patch)\(ISSUE_TABLES/.test(orch) && !/txn\.patch\(T\.(payments|applications|dueChanges)/.test(orch) && (orch.match(/txn\.patch\(T\.credits, \[\{ id: l\.recordId, fields: clientCreditStateFields\(p\.creditAfter\), restore: clientCreditStateFields\(l\.credit\) \}\]\)/g) || []).length === 3 && (orch.match(/txn\.patch\(/g) || []).length === 3);
    const idx = code("index.ts");
    ck("Z6. index.ts routes F7 first (before F6), keeps F1-F6", idx.indexOf("matchReceivablesRoute(route") > 0 && idx.indexOf("matchReceivablesRoute(route") < idx.indexOf("matchIssueRoute(route") && idx.indexOf("matchIssueRoute(route") < idx.indexOf("matchInvoicingRoute(route") && /matchBillingRoute\(decoded/.test(idx) && /matchCommercialRoute\(route/.test(idx) && /"write-check"/.test(idx));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z7. Test copies match the canonical finance files (only import paths swapped)", copy("finance-receivables.ts") && copy("finance-receivables-mapping.ts") && copy("finance-receivables-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-receivables-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]) && copy("finance-issue-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    ck("Z8. No Josh Evans naming in F7 code", !/josh|evans/i.test(F7.map(code).join("\n")));
  }

  for (const [s, n, x] of R) console.log(`${s}  ${n}${x ? `  (${x})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
