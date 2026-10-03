/**
 * Finance Foundation F22 - No-Xero branded invoice PDF + manual Sent.
 * Run: node --experimental-strip-types tests/support/finance-invoice-documents.test.ts
 *
 *   AS  settings (payment details) + client billing address
 *   IN  issue / numbering (F6 stays the only issue; the Hub issue generates the PDF; failures never un-issue)
 *   SN  issuance snapshot (address / payment / branding frozen; later changes never reach the PDF)
 *   PC  PDF content (header, From, Bill To, lines, totals, payment, footer; no internal ids)
 *   MO  money (stored values verbatim - nothing recalculated)
 *   ST  private storage (path, upload once, SHA-256 re-verified on every download)
 *   IM  immutability / idempotency / concurrency (one document per invoice, adopt never regenerate)
 *   OI  pre-F22 invoices (invoice_snapshot_incomplete - never reconstructed)
 *   LG  logo (embedded, or the text brand - never blocks)
 *   LD  long documents (pages, repeated header, nothing clipped)
 *   AC  access + tenant + routes
 *   SE  manual Sent (append-only; never payment)
 *   XE  Xero boundary (a Xero invoice never gets a Hub PDF; no Xero call)
 *   CO  corrections (credit notes never alter the issued PDF)
 *   BO  boundaries (no Airtable writes, no Stripe / Google / Xero, exact audit)
 *   Z   code / drift checks against the canonical finance files
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
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { FIELD_VALIDATORS, SETTINGS_KEYS, crossFieldErrors, ibanChecksumOk, paymentRouteOf } from "./finance-settings.ts";
import { getFinanceSettings } from "./finance-settings-orchestrator.ts";
import { checkBillingAddress } from "./finance-commercial.ts";
import { buildInvoices as buildInvoicesF22 } from "./finance-issue-mapping.ts";
import { DOCUMENT_CONTRACT, RENDERER_VERSION, canonicalJson, checkDocumentQuery, documentContract, gbp, longDate, matchDocumentRoute, parseGenerateBody, parseSentBody, renderInvoicePdf, storagePathOf, vatRateLabel } from "./finance-invoice-documents.ts";
import { downloadInvoicePdf, generateAfterIssue, generateInvoiceDocument, markInvoiceSent, readInvoiceDocument } from "./finance-invoice-documents-orchestrator.ts";
import { fetchLogo, logoUrlOf } from "./finance-invoice-documents-repository.ts";
import { decodeImage, textWidth, wrapText } from "./finance-pdf.ts";
import { readReceivable } from "./finance-receivables-orchestrator.ts";
import { loadInvoice } from "./finance-issue-orchestrator.ts";

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

const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7, invoiceNumberAuthority: "hub" as const, invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001, paymentAccountName: "T Ltd", paymentSortCode: "12-34-56", paymentAccountNumber: "12345678" };
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
  const pk = (await W({ route: "clients.create", client: { name: "TEST Parkside Primary", billingEmail: "billing.parkside@test.invalid", paymentTermsDaysOverride: 30, poRequired: true, billingAddress: { line1: "1 School Lane", townCity: "Testville", postcode: "TE1 1ST" } }, reason: null })).body.client.clientId as string;
  const sa = (await W({ route: "clients.create", client: { name: "TEST St Anne's", billingEmail: "office@stannes.test", billingAddress: { line1: "1 School Lane", townCity: "Testville", postcode: "TE1 1ST" } }, reason: null })).body.client.clientId as string;
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
// F22 emulation: the Supabase document tables + their database functions (same rules as the
// TEST migration: one document per invoice, a ready row never changes, retry only for the SAME
// snapshot, send only for a READY document, audit organisation must match) + the PRIVATE bucket.
// ---------------------------------------------------------------------------
interface F22 {
  docs: any[];
  sends: any[];
  objects: Map<string, Uint8Array>;
  rpcFail: Record<string, number>;
  uploadStatus?: number;
  downloadStatus?: number;
  uploads: number;
  logoBytes: Uint8Array | null;
  logoMode: "ok" | "fail";
  logoFetches: string[];
}
let f22: F22;
const resetF22 = () => {
  f22 = { docs: [], sends: [], objects: new Map(), rpcFail: {}, uploads: 0, logoBytes: null, logoMode: "ok", logoFetches: [] };
};
resetF22();
const SUPA = "https://dkqubldmfyeuudecxmvh.supabase.co";
const BUCKET_URL = `${SUPA}/storage/v1/object/finance-documents/`;
const rpcErr = (code: string) => json({ message: `f22:${code}` }, 400);
const pathRule = (org: string, inv: string, num: string) => `${org}/invoices/${inv}/${num.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`;
const auditOrgOk = (org: string, events: any) => Array.isArray(events) && events.length > 0 && events.every((e: any) => e.organisation_id === org);
const pushAudit = (events: any[]) => world.audit.push(...events.map((e: any, i: number) => ({ id: `aud-${world.audit.length + i + 1}`, ...e })));
const baseFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith(`${SUPA}/storage/`)) {
    await tick();
    calls.push({ url, method });
    if (!url.startsWith(BUCKET_URL)) return json({ error: "unknown bucket" }, 400);
    const path = url.slice(BUCKET_URL.length).split("/").map(decodeURIComponent).join("/");
    if (method === "POST") {
      if (f22.uploadStatus) return json({ error: "storage down" }, f22.uploadStatus);
      if (init.headers?.["x-upsert"] !== "false" || init.headers?.["Content-Type"] !== "application/pdf") return json({ error: "refused" }, 400);
      if (f22.objects.has(path)) return json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 400);
      f22.uploads++;
      f22.objects.set(path, new Uint8Array(init.body));
      return json({ Key: `finance-documents/${path}` });
    }
    if (method === "GET") {
      if (f22.downloadStatus) return json({ error: "storage down" }, f22.downloadStatus);
      const b = f22.objects.get(path);
      return b ? new Response(b, { status: 200, headers: { "Content-Type": "application/pdf" } }) : json({ statusCode: "404", error: "not_found", message: "Object not found" }, 400);
    }
    return json({ message: "f22:official_document_object_immutable" }, 400);
  }
  for (const table of ["finance_invoice_documents", "finance_invoice_send_events"]) {
    if (url.startsWith(`${SUPA}/rest/v1/${table}?`)) {
      await tick();
      calls.push({ url, method });
      if (method !== "GET") return json({ message: "no direct writes" }, 403);
      const u = new URL(url);
      const eqv = (k: string) => (u.searchParams.get(k) || "").replace(/^eq\./, "");
      const rows = table === "finance_invoice_documents" ? f22.docs : f22.sends;
      return json(rows.filter((r) => r.organisation_id === eqv("organisation_id") && r.invoice_id === eqv("invoice_id")).map((r) => ({ ...r, sent_to: r.sent_to ? [...r.sent_to] : undefined })));
    }
  }
  if (url.startsWith(`${SUPA}/rest/v1/rpc/finance_invoice_`)) {
    await tick();
    const fn = url.split("/rpc/")[1];
    const b = JSON.parse(init.body);
    calls.push({ url, method, body: b });
    if (f22.rpcFail[fn]) return json({ message: "database down" }, f22.rpcFail[fn]);
    const org = b.p_org;
    if (fn === "finance_invoice_documents_insert_audit") {
      if (!auditOrgOk(org, b.p_events)) return rpcErr("audit_org_mismatch");
      pushAudit(b.p_events);
      return new Response(null, { status: 204 });
    }
    if (fn === "finance_invoice_document_reserve") {
      const d = b.p_document;
      const ex = f22.docs.find((r) => r.organisation_id === org && r.invoice_id === d.invoice_id);
      if (ex) {
        if (ex.status === "ready") return json({ adopted: true, row: { ...ex } });
        if (ex.snapshot_sha256 !== d.snapshot_sha256 || ex.official_number !== d.official_number) return rpcErr("snapshot_changed");
        Object.assign(ex, { status: "generating", attempts: ex.attempts + 1, last_error_code: null, renderer_version: d.renderer_version, reserved_at: d.reserved_at, reserved_by: d.reserved_by });
        return json({ adopted: false, row: { ...ex } });
      }
      if (!/^FDC-[0-9A-F]{12}$/.test(d.document_id) || d.storage_path !== pathRule(org, d.invoice_id, d.official_number) || f22.docs.some((r) => r.storage_path === d.storage_path)) return json({ message: "check constraint violated" }, 400);
      const row = { organisation_id: org, document_id: d.document_id, invoice_id: d.invoice_id, document_type: "invoice", official_number: d.official_number, status: "generating", snapshot_sha256: d.snapshot_sha256, renderer_version: d.renderer_version, storage_bucket: "finance-documents", storage_path: d.storage_path, sha256: null, byte_size: null, logo_status: null, attempts: 1, last_error_code: null, reserved_at: d.reserved_at, reserved_by: d.reserved_by, generated_at: null, generated_by: null };
      f22.docs.push(row);
      return json({ adopted: false, row: { ...row } });
    }
    if (fn === "finance_invoice_document_record") {
      const row = f22.docs.find((r) => r.organisation_id === org && r.document_id === b.p_document_id);
      if (!row) return rpcErr("document_not_found");
      if (row.status !== "generating") return rpcErr("document_not_generating");
      if (!auditOrgOk(org, b.p_events)) return rpcErr("audit_org_mismatch");
      const r = b.p_result;
      if (r.status === "ready") Object.assign(row, { status: "ready", sha256: r.sha256, byte_size: r.byte_size, logo_status: r.logo_status, generated_at: r.generated_at, generated_by: r.generated_by, last_error_code: null });
      else if (r.status === "failed") Object.assign(row, { status: "failed", last_error_code: r.error_code });
      else return rpcErr("invalid_result");
      pushAudit(b.p_events);
      return json({ ...row });
    }
    if (fn === "finance_invoice_send_record") {
      const s = b.p_send;
      const doc = f22.docs.find((r) => r.organisation_id === org && r.document_id === s.document_id);
      if (!doc || doc.invoice_id !== s.invoice_id) return rpcErr("document_not_found");
      if (doc.status !== "ready") return rpcErr("document_not_ready");
      if (doc.sha256 !== s.document_sha256 || doc.official_number !== s.official_number) return rpcErr("document_mismatch");
      if (!auditOrgOk(org, b.p_events)) return rpcErr("audit_org_mismatch");
      const row = { organisation_id: org, send_id: s.send_id, invoice_id: doc.invoice_id, official_number: doc.official_number, document_id: doc.document_id, document_sha256: doc.sha256, sent_on: s.sent_on, sent_to: [...s.sent_to], note: s.note || null, recorded_by: s.recorded_by, recorded_at: s.recorded_at };
      f22.sends.push(row);
      pushAudit(b.p_events);
      return json({ ...row });
    }
    return json({ message: "unknown function" }, 404);
  }
  return baseFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Images (a real PNG + a JPEG header) and PDF reading helpers
// ---------------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngOf(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([200, 30, 60, x < w / 2 ? 255 : 0], y * (1 + w * 4) + 1 + x * 4);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const WIN_BACK: Record<number, string> = { 0x80: "€", 0x85: "…", 0x92: "’", 0x95: "•", 0x96: "–", 0x97: "—" };
/** The text drawn on the page (every Tj string, decoded). */
function pdfStrings(bytes: Uint8Array): string[] {
  const s = new TextDecoder().decode(bytes);
  const out: string[] = [];
  for (const m of s.matchAll(/\(((?:\\[0-7]{3}|\\[()\\]|[^\\)])*)\) Tj/g)) out.push(m[1].replace(/\\([0-7]{3})|\\([()\\])/g, (_, o, c) => c ?? WIN_BACK[parseInt(o, 8)] ?? String.fromCharCode(parseInt(o, 8))));
  return out;
}
const pdfText = (b: Uint8Array) => pdfStrings(b).join("\n");
/** Structural validity: the xref offsets point at their objects; every stream's /Length is exact; ASCII only. */
function pdfStructureOk(bytes: Uint8Array): boolean {
  const s = new TextDecoder().decode(bytes);
  if (!s.startsWith("%PDF-1.4\n") || !s.endsWith("%%EOF\n") || bytes.some((b) => b > 0x7e && b !== 0x0a)) return false;
  const sx = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)?.[1]);
  if (s.slice(sx, sx + 4) !== "xref") return false;
  const lines = s.slice(sx).split("\n");
  const n = Number(/^0 (\d+)$/.exec(lines[1])?.[1]);
  for (let i = 1; i < n; i++) {
    const off = Number(lines[2 + i].slice(0, 10));
    if (s.slice(off, off + `${i} 0 obj`.length) !== `${i} 0 obj`) return false;
  }
  for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    const start = (m.index as number) + m[0].length;
    if (s.slice(start + Number(m[1]), start + Number(m[1]) + 10) !== "\nendstream") return false;
  }
  return true;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------
// F22 helpers
// ---------------------------------------------------------------------------
const docDeps: any = {
  ...deps,
  documents: {
    fetchLogo: async (url: string) => {
      f22.logoFetches.push(url);
      if (f22.logoMode === "fail") throw new Error("logo host unreachable");
      if (!f22.logoBytes) throw new Error("no logo bytes");
      return f22.logoBytes;
    },
  },
};
const ORG_CTX = { recordId: ORG_REC, organisationId: ORG, name: "Test Org", timezone: "Europe/London" };
const LOGO_URL = "https://v5.airtableusercontent.com/v3/u/logo.png";
const BRANDING = { "Organisation Name": "Test Coaching", "Custom Primary Colour (hex)": "#123ABC", "Primary Colour Preset": "Navy", "Accent Colour Preset": "Lime", Tagline: "Coaching that sticks", Website: "https://coaching.test", "Support Email": "hello@coaching.test" };
const ORG_BASE = { ...ORG_ROW.fields };
const setBranding = (extra: Record<string, unknown> = {}) => {
  ORG_ROW.fields = { ...ORG_BASE, ...BRANDING, ...extra } as any;
};
const issueF22 = (draftId: string, revision: number, caller: any = mgr) => (fresh(), issueDraft(docDeps, caller, draftId, revision, null, (org, u, i) => generateAfterIssue(docDeps, org, u, i)) as Promise<any>);
const gen = (id: string, caller: any = mgr, reason: string | null = null) => (fresh(), generateInvoiceDocument(docDeps, caller, id, reason) as Promise<any>);
const dl = (id: string, caller: any = mgr) => downloadInvoicePdf(docDeps, caller, id) as Promise<any>;
const docRead = (id: string, caller: any = mgr) => readInvoiceDocument(docDeps, caller, id) as Promise<any>;
const markSent = (id: string, req: Record<string, unknown> = {}, caller: any = mgr) => {
  const p = parseSentBody(JSON.stringify(req), isTenantKey) as any;
  if (!p.ok) return Promise.resolve({ status: "error", ...p });
  return markInvoiceSent(docDeps, caller, id, p.req) as Promise<any>;
};
const ADDR = { line1: "1 School Lane", line2: null, townCity: "Testville", county: null, postcode: "TE1 1ST", country: null };
/** A seeded org with branding, three Parkside lines (plus_vat / no_vat / vat_included), Ready, then issued through the F22 hook. */
async function hubIssue(opts: { logo?: Uint8Array | null; before?: (ids: any) => Promise<void> | void } = {}) {
  const ids = await seedF22();
  resetF22();
  setBranding(opts.logo ? { Logo: [{ id: "attLogo", url: LOGO_URL, filename: "logo.png" }] } : {});
  f22.logoBytes = opts.logo ?? null;
  addOcc(S.ppa, "2026-09-10");
  addOcc(S.after, "2026-09-10");
  addOcc(S.breakfast, "2026-09-11");
  if (opts.before) await opts.before(ids);
  const rd = await readyDraft(ids.parkside);
  world.audit = [];
  calls = [];
  const r = await issueF22(rd.draft.draftId, rd.draft.revision);
  return { ids, rd, r, inv: r.body?.invoice };
}
/** seed() + the F22 clock (3 Oct 2026, 09:00 UTC = 10:00 London). */
async function seedF22() {
  const ids = await seed();
  NOW = new Date("2026-10-03T09:00:00.000Z");
  return ids;
}
const docRow = (invoiceId: string) => f22.docs.find((d) => d.invoice_id === invoiceId);
const storedBytes = (invoiceId: string) => f22.objects.get(docRow(invoiceId)?.storage_path);
const invRowOf = (invoiceId: string) => invRows().find((r) => r.fields["Invoice ID"] === invoiceId) as any;
const supaCalls = (fn: string) => calls.filter((c) => c.url.includes(`/rpc/${fn}`));
const ev = (t: string) => world.audit.filter((e) => e.event_type === t);

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);
  NOW = new Date("2026-10-03T09:00:00.000Z");

  // ===== AS. Settings (payment details) + client billing address =====
  {
    const V = FIELD_VALIDATORS as any;
    ck("AS1. Sort code: 6 digits in any common form -> 12-34-56; anything else refused", V.paymentSortCode("123456").value === "12-34-56" && V.paymentSortCode("12 34 56").value === "12-34-56" && V.paymentSortCode("12-34-56").value === "12-34-56" && !V.paymentSortCode("12345").ok && !V.paymentSortCode("ab-cd-ef").ok);
    ck("AS2. Account number: exactly 8 digits", V.paymentAccountNumber("12345678").value === "12345678" && !V.paymentAccountNumber("1234567").ok && !V.paymentAccountNumber("123456789").ok);
    ck("AS3. IBAN: mod-97 checksum enforced (GB82WEST12345698765432 valid; one digit changed refused); stored without spaces, upper case", ibanChecksumOk("GB82WEST12345698765432") && V.paymentIban("gb82 west 1234 5698 7654 32").value === "GB82WEST12345698765432" && !V.paymentIban("GB82WEST12345698765433").ok);
    ck("AS4. BIC 8 or 11 characters; account name <= 140; instructions multi-line <= 500", V.paymentBic("NWBKGB2L").ok && V.paymentBic("NWBKGB2LXXX").ok && !V.paymentBic("NWBK").ok && !V.paymentAccountName("x".repeat(141)).ok && V.paymentInstructions("Line 1\nLine 2").ok && !V.paymentInstructions("x".repeat(501)).ok);
    ck("AS5. A sort code without an account number (or the reverse) is a cross-field error - never half a bank account", "paymentAccountNumber" in crossFieldErrors({ ...SETTINGS, paymentSortCode: "12-34-56", paymentAccountNumber: null } as any) && "paymentSortCode" in crossFieldErrors({ ...SETTINGS, paymentSortCode: null, paymentAccountNumber: "12345678" } as any));
    const pr = (s: any) => paymentRouteOf({ paymentAccountName: null, paymentSortCode: null, paymentAccountNumber: null, paymentIban: null, paymentBic: null, paymentInstructions: null, ...s }) as any;
    ck("AS6. A usable route = account name + (sort code + account number) or IBAN; otherwise it says exactly what is missing", pr({ paymentAccountName: "T", paymentSortCode: "12-34-56", paymentAccountNumber: "12345678" }).ok && pr({ paymentAccountName: "T", paymentIban: "GB82WEST12345698765432" }).ok && pr({ paymentAccountName: "T", paymentIban: "GB82WEST12345698765432" }).details.sortCode === null && pr({ paymentSortCode: "12-34-56", paymentAccountNumber: "12345678" }).missing.join() === "paymentAccountName" && pr({ paymentAccountName: "T" }).missing.length === 1);
    await seedF22();
    const u = await settingsUpdate({ paymentAccountName: "T Ltd", paymentSortCode: "65 43 21", paymentAccountNumber: "87654321", paymentInstructions: "Quote the invoice number" });
    const g1 = (await getFinanceSettings(deps as any, viewer)) as any;
    ck("AS7. Payment details are organisation Finance Settings (POST /settings, Manage, audited) and read back normalised (GET /settings)", u.status === "ok" && g1.body.settings.paymentSortCode === "65-43-21" && g1.body.settings.paymentAccountNumber === "87654321" && world.audit.some((e) => e.event_type === "finance_settings.updated" && e.after?.settings?.paymentSortCode === "65-43-21"));
    ck("AS8. Payment details never make Settings 'incomplete' (they gate only a Hub-authority issue)", !g1.body.completeness.missing.some((k: string) => k.startsWith("payment")));
    const ba = (v: unknown) => checkBillingAddress(v) as any;
    ck("AS9. Client billing address: line 1, town / city and postcode required; postcode upper-cased; unknown parts refused; null clears", ba({ line1: "1 A St", townCity: "Town", postcode: "te1 1st" }).value.postcode === "TE1 1ST" && !ba({ line1: "1 A St", postcode: "TE1 1ST" }).ok && !ba({ line1: "1 A St", townCity: "T", postcode: "TE1" , street: "x" }).ok && ba(null).ok && ba(null).value === null && !ba({ line1: "x", townCity: "T", postcode: "!!" }).ok);
    const ids = await seedF22();
    const pu = parseClientUpdate(JSON.stringify({ client: { billingAddress: { line1: "2 Church Rd", line2: "Annexe", townCity: "Cardiff", county: "Glamorgan", postcode: "cf10 1aa", country: "United Kingdom" } } }), isTenantKey) as any;
    const up = await W({ route: "client.update", clientId: ids.stannes, patch: pu.patch, reason: null });
    const crow = world.tables[TABLES.clients].find((r: any) => r.fields["Finance Client ID"] === ids.stannes) as any;
    ck("AS10. The address is stored structured on the client (Billing Address Line 1 / 2, Town / City, County, Postcode, Country) and read back", up.status === "ok" && up.body.client.billingAddress.postcode === "CF10 1AA" && crow.fields["Billing Address Line 1"] === "2 Church Rd" && crow.fields["Billing Town / City"] === "Cardiff" && crow.fields["Billing Postcode"] === "CF10 1AA" && crow.fields["Billing Country"] === "United Kingdom");
    const bad = { ...crow, fields: { ...crow.fields, "Billing Town / City": undefined } };
    delete bad.fields["Billing Town / City"];
    ck("AS11. A partial stored address (e.g. no town) is invalid data, never half-shown", (clientFromRow(bad, ORG_REC) as any).ok === false);
    const pc = parseClientCreate(JSON.stringify({ client: { name: "X", billingEmail: "a@b.test", billingAddress: { line1: "1", townCity: "T", postcode: "AB1 2CD", planet: "Mars" } } }), isTenantKey) as any;
    ck("AS12. Client create validates the address on the way in (unknown part -> 400)", pc.ok === false && pc.httpStatus === 400);
  }

  // ===== IN. Issue / numbering =====
  {
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    await W({ route: "client.update", clientId: ids.parkside, patch: { billingAddress: null }, reason: null });
    const rd = await readyDraft(ids.parkside);
    world.audit = [];
    calls = [];
    const r1 = await issueF22(rd.draft.draftId, rd.draft.revision);
    ck("IN1. Hub issue without a client billing address -> 409 client_billing_address_missing: nothing issued, number not consumed, no audit, no document", r1.httpStatus === 409 && r1.code === "client_billing_address_missing" && invRows().length === 0 && nextNumber() === 1001 && world.audit.length === 0 && f22.docs.length === 0);
    await W({ route: "client.update", clientId: ids.parkside, patch: { billingAddress: ADDR }, reason: null });
    setSettings({ paymentAccountName: null });
    const r2 = await issueF22(rd.draft.draftId, rd.draft.revision);
    ck("IN2. Hub issue without a usable payment route -> 409 payment_details_missing (names what is missing); nothing issued", r2.httpStatus === 409 && r2.code === "payment_details_missing" && /paymentAccountName/.test(r2.error) && invRows().length === 0 && nextNumber() === 1001);
    setSettings({ paymentAccountName: "T Ltd", paymentSortCode: null, paymentAccountNumber: null, paymentIban: "GB82WEST12345698765432" });
    const r3 = await issueF22(rd.draft.draftId, rd.draft.revision);
    ck("IN3. An IBAN route (no UK account) is a deliberately supported route", r3.httpStatus === 201 && r3.body.invoice.paymentDetails.iban === "GB82WEST12345698765432" && r3.body.invoice.paymentDetails.sortCode === null);
  }
  {
    const { r, inv } = await hubIssue();
    const doc = docRow(inv.invoiceId);
    ck("IN4. F6 issue stays the only issue: 201 issued with the Hub number INV-1001, and its official PDF is generated straight after (document.pdfGenerationStatus ready)", r.httpStatus === 201 && r.body.outcome === "issued" && inv.numbering.officialNumber === "INV-1001" && r.body.document.pdfGenerationStatus === "ready" && r.body.document.document.officialNumber === "INV-1001");
    ck("IN5. Exactly one document row + one stored object for the invoice; the number advanced exactly once (next 1002)", f22.docs.length === 1 && f22.objects.size === 1 && f22.uploads === 1 && nextNumber() === 1002 && doc.official_number === "INV-1001");
    ck("IN6. Generation ran after the issue committed and its lock was released (issue audit first, then the document's)", world.audit.map((e) => e.event_type).join() === "finance_invoice.issued,finance_invoice_draft.issued,finance_invoice_document.generated" && world.lockHeld === null && world.settingsLockHeld === null);
    ck("IN7. The PDF shows the F6 Hub number (the PDF is a rendering, not a second numbering authority)", pdfText(storedBytes(inv.invoiceId) as Uint8Array).includes("INV-1001") && !/INV-1002/.test(pdfText(storedBytes(inv.invoiceId) as Uint8Array)));
  }
  {
    // A generation failure never un-issues: invoice stays issued, number kept, status failed, retry later.
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    f22.uploadStatus = 503;
    const r = await issueF22(rd.draft.draftId, rd.draft.revision);
    const inv = r.body.invoice;
    ck("IN8. Storage down at issue: the issue still succeeds (201, Issued, INV-1001); the response says pdfGenerationStatus failed with the retry route", r.httpStatus === 201 && inv.status === "issued" && inv.numbering.officialNumber === "INV-1001" && r.body.document.pdfGenerationStatus === "failed" && r.body.document.retry === `POST /invoices/${inv.invoiceId}/pdf`);
    ck("IN9. ... the document is recorded failed with a code (+ audited generation_failed); the number is not reused or renumbered", docRow(inv.invoiceId).status === "failed" && docRow(inv.invoiceId).last_error_code === "storage_failed" && ev("finance_invoice_document.generation_failed").length === 1 && nextNumber() === 1002);
    f22.uploadStatus = undefined;
    const rt = await gen(inv.invoiceId);
    ck("IN10. Retry (POST /pdf, Manage) renders the same frozen snapshot: 201 generated, attempts 2, same number, ready", rt.httpStatus === 201 && rt.body.outcome === "generated" && rt.body.document.attempts === 2 && rt.body.document.officialNumber === "INV-1001" && docRow(inv.invoiceId).status === "ready" && f22.docs.length === 1);
  }
  {
    // Xero authority: F6 prepares, F22 never generates.
    const ids = await seedF22();
    resetF22();
    setBranding();
    setSettings({ invoiceNumberAuthority: "xero" });
    await W({ route: "client.update", clientId: ids.stannes, patch: { billingAddress: null }, reason: null });
    addOcc(S.stannes, "2026-09-10");
    const rd = await readyDraft(ids.stannes);
    const r = await issueF22(rd.draft.draftId, rd.draft.revision);
    ck("IN11. Xero authority: prepared for external issue as before - no billing address or payment details needed, no PDF generated, no document, no upload", r.httpStatus === 201 && r.body.outcome === "prepared_for_external_issue" && r.body.document === undefined && f22.docs.length === 0 && f22.uploads === 0 && r.body.invoice.paymentDetails === null && r.body.invoice.branding === null);
  }

  // ===== SN. Snapshot =====
  {
    const { ids, inv } = await hubIssue({
      before: async (ids) => {
        await W({ route: "client.update", clientId: ids.parkside, patch: { billingContactName: "Jane Bursar", billingCcEmails: ["head@parkside.test"] }, reason: null });
      },
    });
    const row = invRowOf(inv.invoiceId).fields;
    ck("SN1. The billing address is frozen on the invoice row (Billing Address Snapshot) and in the invoice body", JSON.parse(row["Billing Address Snapshot"]).postcode === "TE1 1ST" && inv.billingAddress.line1 === "1 School Lane");
    ck("SN2. The payment details are frozen (Payment Details Snapshot): account name, sort code, account number", JSON.parse(row["Payment Details Snapshot"]).sortCode === "12-34-56" && inv.paymentDetails.accountName === "T Ltd" && inv.paymentDetails.accountNumber === "12345678");
    ck("SN3. The stable branding is frozen (Branding Snapshot): trading name, colours (custom hex beats preset; accent preset), tagline, website, support email", inv.branding.tradingName === "Test Coaching" && inv.branding.primaryColour === "#123abc" && inv.branding.accentColour === "#c8ed21" && inv.branding.tagline === "Coaching that sticks" && inv.branding.supportEmail === "hello@coaching.test" && JSON.parse(row["Branding Snapshot"]).primaryColour === "#123abc");
    const before = new Uint8Array(storedBytes(inv.invoiceId) as Uint8Array);
    const snap0 = docRow(inv.invoiceId).snapshot_sha256;
    await W({ route: "client.update", clientId: ids.parkside, patch: { billingAddress: { line1: "99 New Road", townCity: "Elsewhere", postcode: "NW1 1AA" }, billingEmail: "new@parkside.test", name: "Renamed Parkside" }, reason: null });
    setSettings({ paymentAccountName: "Changed Ltd", paymentSortCode: "11-11-11", paymentAccountNumber: "99999999", invoiceLegalName: "Changed Legal Ltd" });
    setBranding({ "Custom Primary Colour (hex)": "#ff0000", "Organisation Name": "New Brand" });
    const again = await gen(inv.invoiceId);
    const read = (await readInv(inv.invoiceId)).body.invoice;
    const t = pdfText(storedBytes(inv.invoiceId) as Uint8Array);
    ck("SN4. After the client, Settings and branding all change: the invoice reads exactly as issued (address, payment, issuer, branding)", read.billingAddress.line1 === "1 School Lane" && read.paymentDetails.sortCode === "12-34-56" && read.issuer.legalName === "T Ltd" && read.branding.primaryColour === "#123abc" && read.client.name === "TEST Parkside Primary");
    ck("SN5. ... generating again ADOPTS the stored PDF (200 already_generated) - byte-identical, no new upload", again.httpStatus === 200 && again.body.outcome === "already_generated" && sha(storedBytes(inv.invoiceId) as Uint8Array) === sha(before) && f22.uploads === 1);
    ck("SN6. ... and the PDF never shows the new address, account, legal name or brand", t.includes("1 School Lane") && !t.includes("99 New Road") && !t.includes("99999999") && !t.includes("Changed") && !t.includes("New Brand") && t.includes("Jane Bursar"));
    const li = (await loadInvoice(docDeps, ORG_CTX, inv.invoiceId)) as any;
    const c1 = documentContract(li.invoice.value, li.lines) as any;
    ck("SN7. The snapshot hash = SHA-256 of the canonical frozen render input (key order independent), pinned on the document row - unchanged by today's data", c1.ok && snap0 === sha(new TextEncoder().encode(canonicalJson(c1.input))) && canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }) === canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }) && c1.input.billTo.address.line1 === "1 School Lane");
    // Strict storage of the snapshots
    const bads: [string, Record<string, unknown>][] = [
      ["payment snapshot with an invalid sort code", { "Payment Details Snapshot": JSON.stringify({ accountName: "T", sortCode: "12-34", accountNumber: "12345678", iban: null, bic: null, instructions: null }) }],
      ["payment snapshot with an extra key", { "Payment Details Snapshot": JSON.stringify({ accountName: "T", sortCode: "12-34-56", accountNumber: "12345678", iban: null, bic: null, instructions: null, secret: "x" }) }],
      ["branding with a non-hex colour", { "Branding Snapshot": JSON.stringify({ tradingName: "T", primaryColour: "red", accentColour: null, tagline: null, website: null, supportEmail: null }) }],
      ["address without a postcode", { "Billing Address Snapshot": JSON.stringify({ line1: "1", line2: null, townCity: "T", county: null, postcode: null, country: null }) }],
      ["unparseable JSON", { "Billing Address Snapshot": "{not json" }],
    ];
    const keep = { ...invRowOf(inv.invoiceId).fields };
    const res: string[] = [];
    for (const [name, patch] of bads) {
      invRowOf(inv.invoiceId).fields = { ...keep, ...patch };
      if ((await readInv(inv.invoiceId)).code !== "invoice_data_invalid") res.push(name);
    }
    invRowOf(inv.invoiceId).fields = keep;
    ck("SN8. Stored snapshots are strict: an invalid / extra-key / unparseable snapshot -> 409 invoice_data_invalid (never shown half-valid)", res.length === 0, res.join("; "));
    const xeroRow = { ...keep, "Invoice Number Authority": "Xero", "Issue Authority": "External accounting", Status: "Awaiting external issue" } as any;
    for (const k of ["Invoice Date", "Due Date", "Issued At", "Issued By User ID", "Hub Invoice Number", "Hub Invoice Sequence"]) delete xeroRow[k];
    const xeroClean = { ...xeroRow };
    delete xeroClean["Payment Details Snapshot"];
    delete xeroClean["Branding Snapshot"];
    ck("SN9. A Xero-numbered row can never carry Hub payment details or branding (invalid data); the same row without them is valid", buildInvoicesF22([{ id: "recX", fields: xeroRow }], ORG_REC).ok === false && buildInvoicesF22([{ id: "recX", fields: xeroClean }], ORG_REC).ok === true);
  }

  // ===== PC. PDF content =====
  {
    const { inv } = await hubIssue({
      before: async (ids) => {
        await W({ route: "client.update", clientId: ids.parkside, patch: { billingContactName: "Jane Bursar", billingAddress: { line1: "Parkside Primary School", line2: "School Road", townCity: "Newport", county: "Gwent", postcode: "NP20 1AB", country: "United Kingdom" } }, reason: null });
        setSettings({ companyNumber: "01234567", invoiceAddress: "Unit 4, Mill Lane\nCardiff\nCF10 1AA", paymentInstructions: "BACS only, please" });
      },
    });
    const bytes = storedBytes(inv.invoiceId) as Uint8Array;
    const t = pdfText(bytes);
    const tSp = t.replace(/\n/g, " ");
    const has = (...xs: string[]) => xs.every((x) => t.includes(x) || tSp.includes(x));
    ck("PC1. A structurally valid PDF 1.4: header, exact xref offsets, exact stream lengths, %%EOF, 7-bit ASCII only", pdfStructureOk(bytes));
    ck("PC2. Header: brand name, INVOICE, the official number, issue date and due date (long form)", has("Test Coaching", "INVOICE", "Invoice number", "INV-1001", "Issue date", "3 October 2026", "Due date", "2 November 2026"));
    ck("PC3. From: frozen legal name, trading name, address lines, company number, VAT number, contact email + website", has("T Ltd", "Trading as Test Coaching", "Unit 4, Mill Lane", "Cardiff", "CF10 1AA", "Company number 01234567", "VAT number GB1", "hello@coaching.test", "https://coaching.test"));
    ck("PC4. Bill To: client, contact, frozen address (every line), billing email; the PO number", has("BILL TO", "TEST Parkside Primary", "For the attention of Jane Bursar", "Parkside Primary School", "School Road", "Newport", "Gwent", "NP20 1AB", "United Kingdom", "billing.parkside@test.invalid", "Purchase order", "PO-77"));
    ck("PC5. Service period + payment terms", has("Service period", "1 September 2026 - 30 September 2026", "Payment terms", "30 days"));
    const lines = (await readInv(inv.invoiceId)).body.lines;
    const allLines = lines.every((l: any) => t.includes(l.date.split("-").reverse().join("/")) && t.includes(`£${l.net}`) && t.includes(`£${l.gross}`));
    ck("PC6. Lines table: header (Date, Description, Qty, Unit price, VAT rate, Net, VAT, Total) and every line's date, net and gross", has("Date", "Description", "Qty", "Unit price", "VAT rate", "Net", "VAT", "Total") && lines.length === 3 && allLines);
    ck("PC7. Totals: the stored net / VAT / total due exactly", has("Total due (GBP)", `£${inv.totals.net}`, `£${inv.totals.vat}`, `£${inv.totals.gross}`));
    ck("PC8. Payment box: account name, sort code, account number, the official number as the payment reference, the instructions, the due date", has("How to pay", "Account name", "Sort code", "12-34-56", "Account number", "12345678", "Payment reference", "BACS only, please", "Please pay by 2 November 2026") && pdfStrings(bytes).filter((x) => x === "INV-1001").length >= 2);
    ck("PC9. Footer: legal identity + Page 1 of 1", has("Page 1 of 1") && pdfStrings(bytes).some((x) => x.startsWith("T Ltd") && x.includes("Company number 01234567")));
    const raw = new TextDecoder().decode(bytes);
    ck("PC10. No internal Hub ids or secrets anywhere in the file (FIV / FVL / FID / FCL / FSV / FDC / organisation id / record ids / service key)", !/FIV-|FVL-|FID-|FCL-|FSV-|FDC-|ORG-TEST|rec[A-Za-z0-9]{14}|service-role|pat-test/.test(raw));
    ck("PC11. Document metadata: title / subject 'Invoice INV-1001', author = the legal name, creation date = the frozen issue instant (never the clock)", /\/Title \(Invoice INV-1001\)/.test(raw) && /\/Author \(T Ltd\)/.test(raw) && /\/CreationDate \(D:20261003090000Z\)/.test(raw));
    const li = (await loadInvoice(docDeps, ORG_CTX, inv.invoiceId)) as any;
    const c = documentContract(li.invoice.value, li.lines) as any;
    ck("PC12. Deterministic: re-rendering the stored invoice's frozen snapshot gives the stored bytes exactly", c.ok && sha(renderInvoicePdf(c.input, null).bytes) === sha(bytes) && sha(renderInvoicePdf(sampleInput(), null).bytes) === sha(renderInvoicePdf(sampleInput(), null).bytes));
  }

  // ===== MO. Money =====
  {
    const inp = sampleInput();
    inp.totals = { netMinor: 123456, vatMinor: 24691, grossMinor: 148147 };
    const t = pdfText(renderInvoicePdf(inp, null).bytes);
    ck("MO1. Totals are printed from the STORED totals verbatim - never re-added from the lines", t.includes("£1,234.56") && t.includes("£246.91") && t.includes("£1,481.47") && !t.includes("£150.00") && !t.includes("£180.00"));
    ck("MO2. Money formatting is integer-exact (thousands separators, pence, negative)", gbp(0) === "£0.00" && gbp(5) === "£0.05" && gbp(123456789) === "£1,234,567.89" && gbp(-100) === "-£1.00" && gbp(100000) === "£1,000.00");
    ck("MO3. VAT rate labels: 20% / 5% / 12.5% / No VAT (from the stored basis points + treatment)", vatRateLabel("plus_vat", 2000) === "20%" && vatRateLabel("plus_vat", 500) === "5%" && vatRateLabel("plus_vat", 1250) === "12.5%" && vatRateLabel("no_vat", 0) === "No VAT");
    const { inv } = await hubIssue();
    const t2 = pdfText(storedBytes(inv.invoiceId) as Uint8Array);
    ck("MO4. A VAT-inclusive line is marked (* Unit price includes VAT) and a no-VAT line says No VAT", t2.includes("* Unit price includes VAT.") && /£60\.00\*/.test(t2) && t2.includes("No VAT"));
    const lines = (await readInv(inv.invoiceId)).body.lines;
    ck("MO5. Every line's stored unit price, net, VAT and gross appear exactly", lines.every((l: any) => t2.includes(`£${l.unitAmount}`) && t2.includes(`£${l.net}`) && t2.includes(`£${l.vat}`) && t2.includes(`£${l.gross}`)));
    ck("MO6. Dates are formatted, never shifted: long form for header dates, dd/mm/yyyy in the table", longDate("2026-02-28") === "28 February 2026" && longDate("2028-02-29") === "29 February 2028" && t2.includes("10/09/2026") && t2.includes("11/09/2026"));
  }

  // ===== ST. Storage =====
  {
    const { inv } = await hubIssue();
    const doc = docRow(inv.invoiceId);
    const bytes = storedBytes(inv.invoiceId) as Uint8Array;
    ck("ST1. Path = {organisation}/invoices/{invoice id}/{official number}.pdf in the private finance-documents bucket", doc.storage_path === `${ORG}/invoices/${inv.invoiceId}/INV-1001.pdf` && storagePathOf(ORG, inv.invoiceId, "INV/2026/7") === `${ORG}/invoices/${inv.invoiceId}/INV-2026-7.pdf` && doc.storage_bucket === "finance-documents");
    const up = calls.find((c) => c.method === "POST" && c.url.startsWith(BUCKET_URL));
    ck("ST2. Uploaded once with the service role, application/pdf, x-upsert false (never overwritten)", !!up && f22.uploads === 1);
    ck("ST3. The document row records SHA-256 + size of the exact stored bytes, renderer version, generated at / by, logo status", doc.sha256 === sha(bytes) && doc.byte_size === bytes.length && doc.renderer_version === RENDERER_VERSION && doc.generated_by === MGR && doc.generated_at === NOW.toISOString() && doc.logo_status === "none");
    const d1 = await dl(inv.invoiceId, viewer);
    ck("ST4. Download (View) streams the stored bytes with their SHA-256 and the file name INV-1001.pdf", d1.status === "ok" && sha(d1.pdf.bytes) === doc.sha256 && d1.pdf.sha256 === doc.sha256 && d1.pdf.fileName === "INV-1001.pdf");
    const body = JSON.stringify(await docRead(inv.invoiceId));
    ck("ST5. No public / signed URL or storage path is ever returned to the caller", !/storage\/v1|finance-documents\/|public|signedUrl|token=/.test(body) && !body.includes(doc.storage_path));
    world.audit = [];
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 20] ^= 1;
    f22.objects.set(doc.storage_path, tampered);
    const d2 = await dl(inv.invoiceId);
    ck("ST6. A stored object that no longer matches its SHA-256 is NEVER served (500 pdf_integrity_failed) and the download is not audited", d2.httpStatus === 500 && d2.code === "pdf_integrity_failed" && world.audit.length === 0);
    f22.objects.delete(doc.storage_path);
    const d3 = await dl(inv.invoiceId);
    ck("ST7. A missing object -> 500 pdf_missing (never regenerated by a download)", d3.httpStatus === 500 && d3.code === "pdf_missing" && f22.uploads === 1);
    f22.objects.set(doc.storage_path, bytes);
    const realPath = doc.storage_path;
    doc.storage_path = `ORG-OTHER/invoices/${inv.invoiceId}/INV-1001.pdf`;
    f22.objects.set(doc.storage_path, bytes);
    const d4 = await dl(inv.invoiceId);
    doc.storage_path = realPath;
    ck("ST8. The stored path is never trusted: a row pointing outside this organisation's derived path is refused (500 pdf_integrity_failed)", d4.httpStatus === 500 && d4.code === "pdf_integrity_failed");
    f22.downloadStatus = 503;
    const d5 = await dl(inv.invoiceId);
    f22.downloadStatus = undefined;
    ck("ST9. Storage unavailable on download -> 503 (nothing served)", d5.httpStatus === 503);
  }

  // ===== IM. Immutability / idempotency / concurrency =====
  {
    const { inv } = await hubIssue();
    const doc0 = { ...docRow(inv.invoiceId) };
    world.audit = [];
    calls = [];
    const g2 = await gen(inv.invoiceId);
    ck("IM1. Generate again -> 200 already_generated: same document id / SHA-256, no upload, no record call, not audited", g2.httpStatus === 200 && g2.body.outcome === "already_generated" && g2.body.changed === false && g2.body.document.documentId === doc0.document_id && g2.body.document.sha256 === doc0.sha256 && f22.uploads === 1 && supaCalls("finance_invoice_document_record").length === 0 && world.audit.length === 0);
    ck("IM2. A ready document is immutable in the API too (body says immutable: true)", g2.body.document.immutable === true && g2.body.document.status === "ready");
  }
  {
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const iss = await issue(rd.draft.draftId, rd.draft.revision);
    const id = iss.body.invoice.invoiceId;
    const [a, b] = await Promise.all([gen(id), gen(id)]);
    const codes2 = [a.httpStatus, b.httpStatus].sort().join();
    ck("IM3. Two generate requests at once: exactly ONE document + ONE object; the other is refused busy (409) or adopts it", f22.docs.length === 1 && f22.objects.size === 1 && f22.uploads === 1 && (codes2 === "201,409" || codes2 === "200,201"));
    world.lockMode = "busy";
    const busy = await gen(id);
    world.lockMode = "ok";
    ck("IM4. Generation takes the shared Finance write lock (409 finance_commercial_busy while held)", busy.httpStatus === 409 && busy.code === "finance_commercial_busy");
  }
  {
    // An earlier attempt stored the object but was never recorded -> adopted as it is.
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const id = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    f22.rpcFail["finance_invoice_document_record"] = 503;
    const g1 = await gen(id);
    delete f22.rpcFail["finance_invoice_document_record"];
    const stored = new Uint8Array(f22.objects.get(docRow(id).storage_path) as Uint8Array);
    ck("IM5. Stored but not recorded -> 503 pdf_generation_unrecorded; the row stays generating; the invoice is untouched", g1.httpStatus === 503 && g1.code === "pdf_generation_unrecorded" && docRow(id).status === "generating" && f22.objects.size === 1);
    setBranding({ Tagline: "A different tagline now" });
    const g2 = await gen(id);
    ck("IM6. Retry adopts the object already stored (never overwritten): ready with ITS SHA-256, still one upload", g2.httpStatus === 201 && docRow(id).status === "ready" && docRow(id).sha256 === sha(stored) && f22.uploads === 1 && sha(f22.objects.get(docRow(id).storage_path) as Uint8Array) === sha(stored));
    ck("IM7. Attempts are counted (2) and the document id never changes across retries", docRow(id).attempts === 2 && f22.docs.length === 1);
  }
  {
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const id = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    f22.docs.push({ organisation_id: ORG, document_id: "FDC-AAAAAAAAAAAA", invoice_id: id, document_type: "invoice", official_number: "INV-1001", status: "failed", snapshot_sha256: "0".repeat(64), renderer_version: "x", storage_bucket: "finance-documents", storage_path: pathRule(ORG, id, "INV-1001"), attempts: 1, last_error_code: "render_failed", reserved_at: NOW.toISOString(), reserved_by: MGR });
    const g = await gen(id);
    ck("IM8. A retry can only ever render the SAME snapshot: a failed row from different data -> 409 document_snapshot_changed, nothing uploaded", g.httpStatus === 409 && g.code === "document_snapshot_changed" && f22.uploads === 0);
    f22.rpcFail["finance_invoice_document_reserve"] = 503;
    f22.docs = [];
    const g2 = await gen(id);
    delete f22.rpcFail["finance_invoice_document_reserve"];
    ck("IM9. Document store unavailable -> 503 (the invoice stays issued; nothing uploaded)", g2.httpStatus === 503 && f22.uploads === 0 && invRows()[0].fields.Status === "Issued");
  }

  // ===== OI. Pre-F22 invoices =====
  {
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const id = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    for (const k of ["Billing Address Snapshot", "Payment Details Snapshot", "Branding Snapshot"]) delete invRowOf(id).fields[k];
    world.audit = [];
    calls = [];
    const g = await gen(id);
    ck("OI1. An invoice issued before F22 (no address / payment / branding snapshot) -> 409 invoice_snapshot_incomplete, listing exactly what is missing", g.httpStatus === 409 && g.code === "invoice_snapshot_incomplete" && JSON.stringify(g.details.missing) === JSON.stringify(["client billing address", "payment details", "branding"]));
    ck("OI2. ... although today's client HAS an address and Settings HAVE payment details, nothing is reconstructed: no document, no upload, no audit, no Airtable write", f22.docs.length === 0 && f22.uploads === 0 && world.audit.length === 0 && airtableWrites().length === 0);
    const r = await docRead(id, viewer);
    ck("OI3. GET /document says why (eligible false, invoice_snapshot_incomplete), status not_available, no generate action", r.body.eligibility.eligible === false && r.body.eligibility.code === "invoice_snapshot_incomplete" && r.body.pdfGenerationStatus === "not_available" && r.body.actions.generate === false && r.body.actions.download === false);
    const d = await dl(id);
    ck("OI4. GET /pdf for it -> 409 invoice_snapshot_incomplete (never generated by a read)", d.httpStatus === 409 && d.code === "invoice_snapshot_incomplete" && f22.docs.length === 0);
  }

  // ===== LG. Logo =====
  {
    const { inv } = await hubIssue({ logo: pngOf(60, 20) });
    const raw = new TextDecoder().decode(storedBytes(inv.invoiceId) as Uint8Array);
    ck("LG1. A PNG logo (alpha) is fetched from the organisation's Logo attachment and embedded (logo embedded; /Image with FlateDecode)", docRow(inv.invoiceId).logo_status === "embedded" && f22.logoFetches.join() === LOGO_URL && /\/Subtype \/Image \/Width 60 \/Height 20 \/ColorSpace \/DeviceRGB/.test(raw) && raw.includes("/FlateDecode"));
    ck("LG2. With a logo the brand name is not repeated as header text, and the PDF stays valid", pdfStructureOk(storedBytes(inv.invoiceId) as Uint8Array) && !pdfStrings(storedBytes(inv.invoiceId) as Uint8Array).slice(0, 1).includes("Test Coaching"));
  }
  {
    const { inv } = await hubIssue({ logo: JPEG });
    const raw = new TextDecoder().decode(storedBytes(inv.invoiceId) as Uint8Array);
    ck("LG3. A JPEG logo is embedded as-is (DCTDecode, its own size)", docRow(inv.invoiceId).logo_status === "embedded" && /\/Width 128 \/Height 64 \/ColorSpace \/DeviceRGB/.test(raw) && raw.includes("/DCTDecode"));
  }
  {
    const ids = await seedF22();
    resetF22();
    setBranding({ Logo: [{ url: LOGO_URL }] });
    f22.logoMode = "fail";
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const r = await issueF22(rd.draft.draftId, rd.draft.revision);
    const id = r.body.invoice.invoiceId;
    ck("LG4. Logo host unreachable -> never blocks: PDF ready with the TEXT brand, logo unavailable, reason reported", r.body.document.pdfGenerationStatus === "ready" && docRow(id).logo_status === "unavailable" && /unreachable/.test(r.body.document.logoFallback) && pdfStrings(storedBytes(id) as Uint8Array)[0] === "Test Coaching");
  }
  {
    const { inv } = await hubIssue({ logo: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]) });
    ck("LG5. A corrupt / unsupported logo -> text brand, logo unavailable (generation still ready)", docRow(inv.invoiceId).status === "ready" && docRow(inv.invoiceId).logo_status === "unavailable");
  }
  {
    const { inv } = await hubIssue();
    ck("LG6. No logo set -> logo none, neutral text brand, nothing fetched", docRow(inv.invoiceId).logo_status === "none" && f22.logoFetches.length === 0);
    const neutral = sampleInput();
    neutral.branding = { tradingName: null, primaryColour: null, accentColour: null, tagline: null, website: null, supportEmail: null };
    neutral.issuer.tradingName = null;
    const nb = renderInvoicePdf(neutral, null).bytes;
    ck("LG7. Neutral fallback (no branding at all): the legal name is the header brand and the PDF is complete", pdfStructureOk(nb) && pdfStrings(nb)[0] === neutral.issuer.legalName && pdfText(nb).includes("Total due (GBP)"));
  }
  {
    const okUrl = logoUrlOf({ Logo: [{ url: LOGO_URL }] }) === LOGO_URL && logoUrlOf({}) === null && logoUrlOf({ Logo: [] }) === null;
    const refused: string[] = [];
    for (const u of ["http://v5.airtableusercontent.com/x.png", "https://evil.test/x.png", "https://airtableusercontent.com.evil.test/x.png", "not a url"]) {
      try {
        await fetchLogo(u, 10);
        refused.push(`allowed ${u}`);
      } catch {
        /* refused */
      }
    }
    ck("LG8. The logo is fetched only over https from Airtable's attachment host (anything else refused before any request)", okUrl && refused.length === 0);
    const big = await decodeImage(new Uint8Array(2_000_001));
    ck("LG9. Logos over 2 MB or in other formats are refused (text fallback)", big.ok === false && (await decodeImage(new TextEncoder().encode("GIF89a....."))).ok === false);
  }
  {
    // Organisation & Branding unreadable at generation -> text brand, never blocks.
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const id = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    const saved = ORG_ROW.id;
    const realFetch = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async (input: any, init: any) => (String(input).includes("filterByFormula=RECORD_ID") && ++n ? new Response("{}", { status: 500 }) : realFetch(input, init))) as typeof fetch;
    const g = await gen(id);
    globalThis.fetch = realFetch;
    ck("LG10. Branding record unreadable at generation -> logo unavailable, PDF still ready (from the frozen branding)", g.httpStatus === 201 && docRow(id).logo_status === "unavailable" && n > 0 && ORG_ROW.id === saved && pdfStrings(storedBytes(id) as Uint8Array)[0] === "Test Coaching");
  }

  // ===== LD. Long documents =====
  {
    const inp = sampleInput(150);
    const r = renderInvoicePdf(inp, null);
    const strs = pdfStrings(r.bytes);
    ck("LD1. 150 lines -> several pages, each with 'Page x of y'", r.pages >= 4 && Array.from({ length: r.pages }, (_, i) => `Page ${i + 1} of ${r.pages}`).every((p) => strs.includes(p)));
    ck("LD2. The table header is repeated on every page; continuation pages say '(continued)'", strs.filter((s) => s === "Unit price").length === r.pages && strs.filter((s) => s === `Invoice ${inp.officialNumber} (continued)`).length === r.pages - 1);
    ck("LD3. Every line is present exactly once and totals / payment appear once (last page)", inp.lines.every((l) => strs.filter((s) => s === `Session ${l.sequence} - Key Stage 2`).length === 1) && strs.filter((s) => s === "Total due (GBP)").length === 1 && strs.filter((s) => s === "How to pay").length === 1);
    ck("LD4. Structurally valid at length (xref / stream lengths)", pdfStructureOk(r.bytes));
    const long = sampleInput(1);
    long.lines[0].description = "After-school multi-sport club (Years 3 & 4) - Ysgol Gymraeg Bro Morgannwg - Café session with an extraordinarilylongwordthatcannotpossiblyfitonasinglelineofthedescriptioncolumn";
    const ls = pdfStrings(renderInvoicePdf(long, null).bytes);
    const flat = (x: string) => x.replace(/\s/g, "");
    const descLines = ls.filter((s) => s.length > 3 && flat(long.lines[0].description).includes(flat(s)));
    ck("LD5. A long description wraps over several lines (a word longer than the column is broken) - nothing clipped, accents kept", descLines.length >= 4 && flat(descLines.join("")) === flat(long.lines[0].description) && descLines.join(" ").includes("Café"));
    const wr = wrapText("a ".repeat(200) + "b".repeat(300), "regular", 9, 120);
    ck("LD6. wrapText never drops characters and every wrapped line fits its column width", wr.join("").replace(/\s/g, "") === "a".repeat(200) + "b".repeat(300) && wr.every((l) => textWidth(l, "regular", 9) <= 120) && wr.length > 5);
  }

  // ===== AC. Access, tenant, routes =====
  {
    const { inv } = await hubIssue();
    const id = inv.invoiceId;
    world.audit = [];
    calls = [];
    const v1 = await docRead(id, viewer);
    ck("AC1. View: GET /document 200 - status ready, download allowed, generate + Mark Sent NOT offered", v1.httpStatus === 200 && v1.body.access === "view" && v1.body.pdfGenerationStatus === "ready" && v1.body.actions.download === true && v1.body.actions.generate === false && v1.body.actions.markSent === false);
    const v2 = await dl(id, viewer);
    ck("AC2. View: GET /pdf 200 (download)", v2.status === "ok" && v2.httpStatus === 200);
    const v3 = await gen(id, viewer);
    const v4 = await markSent(id, {}, viewer);
    ck("AC3. View: POST /pdf and POST /sent -> 403 finance_manage_required; nothing changed", v3.httpStatus === 403 && v3.code === "finance_manage_required" && v4.httpStatus === 403 && v4.code === "finance_manage_required" && f22.sends.length === 0 && f22.uploads === 1);
    const m1 = await docRead(id, mgr);
    ck("AC4. Manage: GET /document offers download + Mark Sent (generate not offered once ready)", m1.body.actions.download === true && m1.body.actions.markSent === true && m1.body.actions.generate === false);
    const nog = { userId: "bbbbbbbb-e0d4-4257-8121-5f16781e97ba", role: "management", active: true, organisationId: ORG };
    const n1 = await dl(id, nog);
    const n2 = await docRead(id, nog);
    ck("AC5. No Finance grant -> 403 finance_access_denied (download and status)", n1.httpStatus === 403 && n1.code === "finance_access_denied" && n2.httpStatus === 403);
    const coach = { userId: MGR, role: "coach", active: true, organisationId: ORG };
    const parent = { userId: MGR, role: "parent", active: true, organisationId: ORG };
    ck("AC6. Coach / Parent -> 403 management_required", (await dl(id, coach)).code === "management_required" && (await docRead(id, parent)).code === "management_required" && (await gen(id, coach)).httpStatus === 403);
    world.moduleOn = false;
    const off = await dl(id, viewer);
    world.moduleOn = true;
    ck("AC7. Finance module off -> 403 finance_module_disabled", off.httpStatus === 403 && off.code === "finance_module_disabled");
    // Another organisation's invoice + document
    const other = JSON.parse(JSON.stringify(invRowOf(id)));
    other.id = "recOtherInvoice01";
    other.fields.Organisation = [OTHER_ORG_REC];
    other.fields["Invoice ID"] = "FIV-ABCDEF012345";
    invRows().push(other);
    f22.docs.push({ ...docRow(id), organisation_id: "ORG-OTHER", invoice_id: other.fields["Invoice ID"], storage_path: pathRule("ORG-OTHER", other.fields["Invoice ID"], "INV-1001") });
    f22.objects.set(pathRule("ORG-OTHER", other.fields["Invoice ID"], "INV-1001"), storedBytes(id) as Uint8Array);
    const x1 = await dl(other.fields["Invoice ID"]);
    const x2 = await docRead(other.fields["Invoice ID"]);
    const x3 = await gen(other.fields["Invoice ID"]);
    const x4 = await markSent(other.fields["Invoice ID"]);
    ck("AC8. Another organisation's invoice / document is invisible: 404 invoice_not_found on download, status, generate and Mark Sent; nothing served", [x1, x2, x3, x4].every((x) => x.httpStatus === 404 && x.code === "invoice_not_found"));
    ck("AC9. Every document read filters on the caller's organisation", calls.filter((c) => c.url.includes("/rest/v1/finance_invoice_")).every((c) => c.url.includes(`organisation_id=eq.${ORG}`)));
    const q1 = checkDocumentQuery(new URLSearchParams("organisationId=ORG-OTHER"), isTenantKey) as any;
    const q2 = checkDocumentQuery(new URLSearchParams("download=1"), isTenantKey) as any;
    const b1 = parseGenerateBody('{"organisation_id":"ORG-OTHER"}', isTenantKey) as any;
    const b2 = parseSentBody('{"tenant":"x"}', isTenantKey) as any;
    ck("AC10. A tenant-looking query / body key -> 400 tenant_param_rejected; other query params -> 400", q1.code === "tenant_param_rejected" && q2.code === "unexpected_parameter" && b1.code === "tenant_param_rejected" && b2.code === "tenant_param_rejected");
    const b3 = parseGenerateBody('{"lines":[]}', isTenantKey) as any;
    const b4 = parseGenerateBody("", isTenantKey) as any;
    ck("AC11. Generate body: empty / {} / { reason } only - document content can never be supplied (400 unexpected_field)", b3.code === "unexpected_field" && b4.ok && (parseGenerateBody('{"reason":"retry after outage"}', isTenantKey) as any).reason === "retry after outage");
    const F = "FIV-0123456789AB";
    ck("AC12. Routes: GET|POST invoices/{FIV}/pdf, GET invoices/{FIV}/document, POST invoices/{FIV}/sent; wrong method 405; anything else is not F22's", (matchDocumentRoute(`invoices/${F}/pdf`, "GET") as any).route.name === "invoice.pdf" && (matchDocumentRoute(`invoices/${F}/pdf`, "POST") as any).route.name === "invoice.pdf_generate" && (matchDocumentRoute(`invoices/${F}/document`, "GET") as any).route.name === "invoice.document" && (matchDocumentRoute(`invoices/${F}/sent`, "POST") as any).route.name === "invoice.sent" && (matchDocumentRoute(`invoices/${F}/sent`, "GET") as any).status === "method" && matchDocumentRoute(`invoices/${F}`, "GET") === null && matchDocumentRoute(`invoices/FID-0123456789AB/pdf`, "GET") === null && matchDocumentRoute(`credit-notes/FCN-0123456789AB/pdf`, "GET") === null && matchDocumentRoute(`invoices/${F}/pdf/x`, "GET") === null);
  }
  {
    // GET never generates.
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const id = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    world.audit = [];
    calls = [];
    const r = await docRead(id, viewer);
    const d = await dl(id, viewer);
    ck("AC13. A View read never generates: GET /document says pending (generate offered only to Manage), GET /pdf -> 409 pdf_not_generated; no reserve, no upload, no audit", r.body.pdfGenerationStatus === "pending" && r.body.actions.generate === false && d.httpStatus === 409 && d.code === "pdf_not_generated" && supaCalls("finance_invoice_document_reserve").length === 0 && f22.uploads === 0 && world.audit.length === 0);
    const m = await docRead(id, mgr);
    ck("AC14. ... Manage sees generate offered while pending", m.body.actions.generate === true && m.body.actions.download === false);
    f22.docs.push({ organisation_id: ORG, document_id: "FDC-BBBBBBBBBBBB", invoice_id: id, document_type: "invoice", official_number: "INV-1001", status: "generating", snapshot_sha256: "1".repeat(64), renderer_version: "x", storage_bucket: "finance-documents", storage_path: pathRule(ORG, id, "INV-1001"), attempts: 1, reserved_at: NOW.toISOString(), reserved_by: MGR });
    ck("AC15. While generating: GET /pdf -> 409 pdf_generating; status says generating", (await dl(id)).code === "pdf_generating" && (await docRead(id)).body.pdfGenerationStatus === "generating");
  }

  // ===== SE. Manual Sent =====
  {
    const ids = await seedF22();
    resetF22();
    setBranding();
    addOcc(S.ppa, "2026-09-10");
    await W({ route: "client.update", clientId: ids.parkside, patch: { billingCcEmails: ["Head@Parkside.test"] }, reason: null });
    const rd = await readyDraft(ids.parkside);
    const id = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    const s0 = await markSent(id);
    ck("SE1. Mark as Sent before the official PDF exists -> 409 pdf_not_ready (Sent records which document was sent)", s0.httpStatus === 409 && s0.code === "pdf_not_ready" && f22.sends.length === 0);
    await gen(id);
    const dlBefore = await dl(id);
    const st0 = await docRead(id);
    ck("SE2. Generated + downloaded is NOT sent (delivery.sent false, timesSent 0)", dlBefore.status === "ok" && st0.body.delivery.sent === false && st0.body.delivery.timesSent === 0);
    const recBefore = (await readReceivable(deps as any, mgr, id, null)) as any;
    const invBefore = JSON.stringify(invRowOf(id).fields);
    world.audit = [];
    calls = [];
    const s1 = await markSent(id);
    ck("SE3. Mark as Sent (Manage) -> 201: defaults to today (organisation calendar) and the FROZEN billing email + CCs (lower-cased)", s1.httpStatus === 201 && s1.body.send.sentOn === "2026-10-03" && JSON.stringify(s1.body.send.sentTo) === JSON.stringify(["billing.parkside@test.invalid", "head@parkside.test"]));
    ck("SE4. The send pins the exact document bytes (document SHA-256) and the official number", s1.body.send.documentSha256 === docRow(id).sha256 && s1.body.send.officialNumber === "INV-1001" && f22.sends[0].document_id === docRow(id).document_id);
    const a = ev("finance_invoice.sent_manually")[0];
    ck("SE5. Audited finance_invoice.sent_manually (before timesSent 0 -> after 1, recipients, document) in the same transaction as the event", world.audit.length === 1 && a.record_id === id && a.before.timesSent === 0 && a.after.timesSent === 1 && a.after.documentSha256 === docRow(id).sha256 && a.context.contract === DOCUMENT_CONTRACT && a.context.paymentUnchanged === true);
    const recAfter = (await readReceivable(deps as any, mgr, id, null)) as any;
    ck("SE6. Sent is not Paid: invoice row, status and receivable state are unchanged; no Airtable write at all", JSON.stringify(invRowOf(id).fields) === invBefore && airtableWrites().length === 0 && recBefore.status === "ok" && JSON.stringify(recAfter.body) === JSON.stringify(recBefore.body) && s1.body.invoiceStatus === "issued");
    NOW = new Date("2026-10-05T10:00:00.000Z");
    const s2 = await markSent(id, { sentTo: ["finance@parkside.test"], note: "Resent after the school asked", sentOn: "2026-10-04" });
    const h = (await docRead(id, viewer)).body.delivery;
    ck("SE7. Resend allowed: append-only history in order (2 events), the last one's date / recipients / note kept", s2.httpStatus === 201 && h.timesSent === 2 && h.history.length === 2 && h.lastSentOn === "2026-10-04" && h.history[1].note === "Resent after the school asked" && h.history[0].sentOn === "2026-10-03");
    const fut = await markSent(id, { sentOn: "2026-10-06" });
    const early = await markSent(id, { sentOn: "2026-09-01" });
    ck("SE8. sentOn in the future -> 400 sent_on_in_future; before the issue date -> 400 sent_before_issue", fut.httpStatus === 400 && fut.code === "sent_on_in_future" && early.httpStatus === 400 && early.code === "sent_before_issue" && f22.sends.length === 2);
    const p1 = parseSentBody('{"sentTo":["not-an-email"]}', isTenantKey) as any;
    const p2 = parseSentBody(JSON.stringify({ sentTo: Array.from({ length: 11 }, (_, i) => `a${i}@x.test`) }), isTenantKey) as any;
    const p3 = parseSentBody('{"sentOn":"2026-02-30"}', isTenantKey) as any;
    const p4 = parseSentBody('{"amountPaid":100}', isTenantKey) as any;
    ck("SE9. Request validation: bad email, > 10 recipients, impossible date, unknown field (e.g. a payment) -> 400", p1.httpStatus === 400 && p2.httpStatus === 400 && p3.httpStatus === 400 && p4.code === "unexpected_field");
    ck("SE10. Sent history is View-readable but Mark Sent is Manage-only; NOW back", (await docRead(id, viewer)).body.delivery.history.length === 2);
    NOW = new Date("2026-10-03T09:00:00.000Z");
  }

  // ===== XE. Xero boundary =====
  {
    const ids = await seedF22();
    resetF22();
    setBranding();
    setSettings({ invoiceNumberAuthority: "xero" });
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const id = (await issueF22(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    calls = [];
    world.audit = [];
    const g = await gen(id);
    const d = await dl(id);
    const s = await markSent(id);
    const r = await docRead(id);
    ck("XE1. A Xero invoice awaiting external issue: POST /pdf, GET /pdf, Mark Sent -> 409 xero_invoice_document; nothing generated", g.code === "xero_invoice_document" && d.code === "xero_invoice_document" && s.code === "xero_invoice_document" && f22.docs.length === 0 && f22.uploads === 0);
    ck("XE2. GET /document: not eligible (Xero owns the document), status not_available, no actions", r.body.eligibility.code === "xero_invoice_document" && r.body.pdfGenerationStatus === "not_available" && r.body.actions.generate === false && r.body.actions.markSent === false && r.body.numberAuthority === "xero");
    Object.assign(invRowOf(id).fields, { Status: "Issued", "External Provider": "xero", "External Invoice ID": "xero-guid-1", "External Invoice Number": "INV-0042", "Invoice Date": "2026-10-01", "Due Date": "2026-10-31", "Issued At": "2026-10-01T10:00:00.000Z", "Issued By User ID": MGR });
    const g2 = await gen(id);
    ck("XE3. A Xero-ISSUED invoice (Xero number INV-0042) is refused the same way - no Hub PDF ever", (await readInv(id)).body.invoice.status === "issued" && g2.code === "xero_invoice_document" && f22.docs.length === 0);
    ck("XE4. No Xero (or any accounting) call is made by F22", !calls.some((c) => /xero|api\.xero\.com|identity\.xero/i.test(c.url)) && world.audit.length === 0);
  }

  // ===== CO. Corrections =====
  {
    const { inv } = await hubIssue();
    const id = inv.invoiceId;
    const sha0 = docRow(id).sha256;
    const doc0 = JSON.stringify(docRow(id));
    const lines = (await readInv(id)).body.lines;
    const cn = await credit(id, [lines[0].lineId], "Session cancelled - credited");
    const after = await dl(id);
    ck("CO1. A credit note after the PDF: the document row and stored bytes are unchanged (no regeneration, no upload)", cn.httpStatus === 201 && JSON.stringify(docRow(id)) === doc0 && sha(after.pdf.bytes) === sha0 && f22.uploads === 1);
    ck("CO2. The issued PDF never shows credit state (it is the invoice as issued)", !/credit/i.test(pdfText(after.pdf.bytes)) && (await readInv(id)).body.invoice.status === "partially_credited");
    const g = await gen(id);
    ck("CO3. Generate on a partially credited invoice adopts the original (200) - never a second, 'corrected' PDF", g.httpStatus === 200 && g.body.document.sha256 === sha0);
    const rp = await replace(cn.body.creditNote.creditNoteId);
    const rpd = rp.body.draft;
    const rr = await DW({ route: "draft.ready", draftId: rpd.draftId, revision: rpd.revision, reason: null });
    const ri = await issueF22(rr.body.draft.draftId, rr.body.draft.revision);
    ck("CO4. The replacement invoice gets its own Hub number and its own PDF; the original's stays byte-identical", ri.httpStatus === 201 && ri.body.invoice.numbering.officialNumber === "INV-1002" && ri.body.document.pdfGenerationStatus === "ready" && f22.docs.length === 2 && docRow(id).sha256 === sha0 && sha(storedBytes(id) as Uint8Array) === sha0);
    ck("CO5. Credit-note PDFs are deferred (debt): no F22 route for credit notes", matchDocumentRoute(`credit-notes/${cn.body.creditNote.creditNoteId}/pdf`, "GET") === null && matchDocumentRoute(`credit-notes/${cn.body.creditNote.creditNoteId}/pdf`, "POST") === null);
  }

  // ===== BO. Boundaries =====
  {
    const { inv } = await hubIssue();
    const id = inv.invoiceId;
    calls = [];
    world.audit = [];
    await gen(id);
    await dl(id, viewer);
    await dl(id);
    await docRead(id);
    await markSent(id);
    ck("BO1. Generate / download / status / Mark Sent never write to Airtable (invoices, clients, Settings untouched)", airtableWrites().length === 0);
    ck("BO2. No Stripe, Google, Xero or e-mail service is called (only Airtable reads, Supabase and the private bucket)", calls.every((c) => c.url.startsWith("https://api.airtable.com/") || c.url.startsWith(SUPA)));
    ck("BO3. Audit is exact: one download event per download, one sent event; reads and adoption are not audited", world.audit.map((e) => e.event_type).join() === "finance_invoice_document.downloaded,finance_invoice_document.downloaded,finance_invoice.sent_manually" && world.audit[0].context.access === "view" && world.audit[1].context.access === "manage");
    const all = JSON.stringify(world.audit);
    ck("BO4. Audit carries the F22 contract and never a secret, storage URL or file bytes", world.audit.every((e) => e.context.contract === DOCUMENT_CONTRACT && e.organisation_id === ORG) && !/service-role|pat-test|storage\/v1|JVBERi|%PDF/.test(all));
    const gEv = await (async () => {
      const s = await hubIssue();
      return ev("finance_invoice_document.generated")[0] && { e: ev("finance_invoice_document.generated")[0], id: s.inv.invoiceId };
    })();
    ck("BO5. The generated event: before = the reserved row (generating), after = ready + SHA-256 + size + logo + renderer, context = invoice, number, trigger issue", gEv.e.before.status === "generating" && gEv.e.after.status === "ready" && gEv.e.after.sha256 === docRow(gEv.id).sha256 && gEv.e.after.byteSize === docRow(gEv.id).byte_size && gEv.e.context.trigger === "issue" && gEv.e.context.officialNumber === "INV-1001" && gEv.e.actor_user_id === MGR);
  }

  // ===== Z. Code / drift =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const pdfSrc = noComments(code("finance-pdf.ts"));
    const docSrc = noComments(code("finance-invoice-documents.ts"));
    ck("Z1. The PDF writer + document layout are pure: no imports beyond Finance's own pure modules, no fetch / Deno / Supabase / Airtable / clock", !/^import /m.test(pdfSrc) && !/fetch\(|Deno\.|createClient|api\.airtable\.com|new Date\(\)|Date\.now|Math\.random/.test(pdfSrc + docSrc) && (docSrc.match(/^import .* from "\.\/(finance-money|finance-commercial|finance-settings|finance-issue|finance-pdf)\.ts";$/gm) || []).length === (docSrc.match(/^import /gm) || []).length);
    ck("Z2. No PDF library, no new Edge Function: the renderer lives inside finance (no npm / jsr / esm import in F22 files)", !/from "(npm:|jsr:|https?:)/.test(code("finance-pdf.ts") + code("finance-invoice-documents.ts") + code("finance-invoice-documents-orchestrator.ts") + code("finance-invoice-documents-repository.ts")));
    const orch = noComments(code("finance-invoice-documents-orchestrator.ts"));
    ck("Z3. F22 authorises through F1 (read for GET, manage for POST) and reuses the shared write lock; no Xero / Stripe / Google / email code", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && /`commercial:\$\{o\.organisationId\}`/.test(orch) && !/api\.xero|finance-xero|stripe|google|sheets|sendEmail|smtp/i.test(orch));
    ck("Z4. F22 never writes Airtable (no create / patch / txn in the orchestrator or repository)", !/txn\.|createRow|patchRow|createRows|patchRows|method: "PATCH"/.test(orch + noComments(code("finance-invoice-documents-repository.ts"))));
    const idx = code("index.ts");
    ck("Z5. index.ts: F22 routes are matched before F9 / F7 / F6, the issue route passes generateAfterIssue, the PDF is served private / no-store with its SHA-256", idx.indexOf("matchDocumentRoute(route") > 0 && idx.indexOf("matchDocumentRoute(route") < idx.indexOf("matchXeroRoute(route") && idx.indexOf("matchDocumentRoute(route") < idx.indexOf("matchReceivablesRoute(route") && idx.indexOf("matchDocumentRoute(route") < idx.indexOf("matchIssueRoute(route") && /generateAfterIssue\(deps, org, userId, invoiceId\)/.test(idx) && /"Cache-Control": "private, no-store"/.test(idx) && /"X-Content-SHA256": out\.pdf\.sha256/.test(idx));
    const iss = noComments(code("finance-issue-orchestrator.ts"));
    ck("Z6. F6 stays the only issue: F22 code never creates / patches an invoice, and the issue hook runs only after a committed Hub issue", !/ISSUE_TABLES/.test(orch) && /res\.status === "ok" && done && afterIssue && done\.invoice\.numberAuthority === "hub" && isIssued\(done\.invoice\)/.test(iss));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.split(a).join(b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    const sw: [string, string][] = [['"./orchestrator.ts"', '"./finance-orchestrator.ts"'], ['"./repository.ts"', '"./finance-repository.ts"']];
    ck("Z7. Test copies match the canonical finance files (only import paths swapped)", ["finance-pdf.ts", "finance-invoice-documents.ts", "finance-settings.ts", "finance-commercial.ts", "finance-commercial-mapping.ts", "finance-issue.ts", "finance-issue-mapping.ts"].every((f) => copy(f)) && ["finance-invoice-documents-orchestrator.ts", "finance-invoice-documents-repository.ts", "finance-issue-orchestrator.ts"].every((f) => copy(f, sw)));
    ck("Z8. No Josh Evans naming and no production identifiers in F22 code", !/josh|evans|apprptFotQuVL1mhs|bkkukymqaxawnudoxdjs/i.test(["finance-pdf.ts", "finance-invoice-documents.ts", "finance-invoice-documents-orchestrator.ts", "finance-invoice-documents-repository.ts"].map(code).join("\n")));
  }

  for (const [s, n, x] of R) console.log(`${s}  ${n}${x ? `  (${x})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

/** A complete, valid frozen render input (for the pure renderer checks). */
function sampleInput(n = 3): any {
  return {
    documentType: "invoice",
    currency: "GBP",
    officialNumber: "INV-2001",
    invoiceDate: "2026-10-03",
    dueDate: "2026-11-02",
    issuedAt: "2026-10-03T09:00:00.000Z",
    period: { from: "2026-09-01", to: "2026-09-30" },
    paymentTermsDays: 30,
    poNumber: "PO-1",
    issuer: { legalName: "Sample Coaching Ltd", tradingName: "Sample Coaching", address: "1 Road\nTown\nAB1 2CD", companyNumber: "01234567", vatRegistered: true, vatNumber: "GB123456789" },
    branding: { tradingName: "Sample Coaching", primaryColour: "#062a59", accentColour: "#c8ed21", tagline: null, website: null, supportEmail: null },
    billTo: { name: "Sample School", contactName: null, email: "accounts@school.test", ccEmails: [], address: { line1: "School Road", line2: null, townCity: "Town", county: null, postcode: "AB1 2CD", country: null } },
    lines: Array.from({ length: n }, (_, i) => ({ sequence: i + 1, date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, description: `Session ${i + 1} - Key Stage 2`, quantity: 1, unitMinor: 5000, vatTreatment: "plus_vat", vatRateBasisPoints: 2000, netMinor: 5000, vatMinor: 1000, grossMinor: 6000 })),
    totals: { netMinor: 5000 * n, vatMinor: 1000 * n, grossMinor: 6000 * n },
    payment: { accountName: "Sample Coaching Ltd", sortCode: "12-34-56", accountNumber: "12345678", iban: null, bic: null, instructions: null, reference: "INV-2001" },
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
