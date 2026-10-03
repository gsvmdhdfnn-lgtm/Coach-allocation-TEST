/**
 * Finance Foundation F6 - invoice issue + immutability + correction / credit-note lifecycle.
 * Run: node --experimental-strip-types tests/support/finance-issue.test.ts
 *
 *   IS  issue (clean issue, identity, dates, lines copied exactly, draft stamped)
 *   PR  issue preconditions under the lock (not Ready, revision, blockers after Ready, manual billing, issuer / client data, claims, totals)
 *   DU  duplicate / concurrent issue
 *   CL  source claims are permanent (issued work never re-drafted; reopen / delete cannot release it)
 *   SN  snapshots (client / F3 / F4 / Settings changes never alter an issued invoice; reads never re-run F4)
 *   PT  PO / payment terms / due date
 *   MT  missing-terms approved omissions preserved (no line, no £0, still unresolved)
 *   AC  access + tenant
 *   CN  credit notes (whole lines, amounts, remaining, duplicate / excess refused, original unchanged)
 *   RP  correction -> replacement draft -> replacement invoice (links both ways)
 *   NB  official invoice numbering (F6 correction): internal FIV vs official number; Xero vs Hub authority;
 *       per-organisation sequence; concurrency; failed issue; never reused / never changed; Xero fields later
 *   RI  replacement drafts inherit the ORIGINAL invoice's terms / PO / PO context (F6 correction)
 *   AU  audit (exact events; none on reads / rejected; atomic rollback; undo failure)
 *   PF  bounded reads / batched writes
 *   RT  routes + request parsing
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

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== IS. Issue =====
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    const aft = addOcc(S.after, "2026-09-10");
    const extra = addOcc(S.ppa, "2026-09-11");
    const d0 = (await create(ids.parkside)).body;
    await exclude(d0.draft.draftId, lineOf(d0, extra).lineId);
    const rev = (await details(d0.draft.draftId, '{"poNumber":"PO-77"}')).body.draft.revision;
    const rd = (await ready(d0.draft.draftId, rev)).body;
    world.audit = [];
    calls = [];
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    const inv = r.body.invoice;
    ck("IS1. A Ready draft issues (201): stable internal reference FIV-..., status Issued, Hub authority, no external / legal number invented", r.httpStatus === 201 && /^FIV-[0-9A-F]{12}$/.test(inv.invoiceId) && inv.reference === inv.invoiceId && inv.status === "issued" && inv.statusLabel === "Issued" && inv.issueAuthority === "hub" && inv.external.provider === null && inv.external.invoiceNumber === null && inv.external.invoiceId === null && !/INV-0/.test(JSON.stringify(r.body)));
    ck("IS2. Totals are the draft's frozen totals in integer pence (net + VAT = gross), line count = included lines only", inv.totals.gross === rd.draft.totals.gross && inv.totals.net === "212.00" && inv.totals.vat === "10.00" && inv.totals.gross === "222.00" && inv.totals.lineCount === 2 && invRows()[0].fields["Gross (Minor Units)"] === 22200 && invRows()[0].fields["Net (Minor Units)"] + invRows()[0].fields["VAT (Minor Units)"] === 22200);
    const dl = (occ: string) => lineOf(rd, occ);
    const same = (il: any, occ: string) => ["description", "quantity", "unitAmount", "amount", "net", "vat", "gross", "termsId", "occurrenceId", "date", "serviceId", "vatRatePercent", "quantitySource", "unitAmountSource"].every((k) => il[k] === dl(occ)[k]) && il.sourceDraftLineId === dl(occ).lineId;
    ck("IS3. Invoice lines are exact copies of the draft's Included lines (figures, sources, refs) - nothing recalculated; sequence in date order", r.body.lines.length === 2 && same(r.body.lines[0], aft) && same(r.body.lines[1], ppa) && r.body.lines.map((l: any) => l.sequence).join() === "1,2" && r.body.lines.every((l: any) => /^FVL-/.test(l.lineId)));
    ck("IS4. Excluded work is not on the invoice (it stays billable later)", !r.body.lines.some((l: any) => l.occurrenceId === extra) && JSON.parse(invRows()[0].fields["Review Snapshot"]).excludedLineIds.length === 1);
    ck("IS5. Invoice date = today in the organisation's time zone; due date = invoice date + terms (calendar days)", inv.invoiceDate === "2026-09-29" && inv.dueDate === "2026-10-29" && inv.paymentTerms.days === 30);
    const dr = draftRows()[0].fields;
    ck("IS6. The draft is stamped with the invoice id (stays Ready for issue as the traceable source; revision +1)", dr["Issued Invoice ID"] === inv.invoiceId && dr.Status === "Ready for issue" && dr.Revision === rd.draft.revision + 1 && r.body.draft.issued === true && r.body.draft.issuedInvoiceId === inv.invoiceId && inv.sourceDraftId === rd.draft.draftId);
    const writes = airtableWrites();
    ck("IS7. Writes: 1 invoice row, its lines, the draft stamp (+ the Hub's next-number step) - nothing else (no Schedule / F3 / F4 / draft-line writes)", invRows().length === 1 && invLineRows().length === 2 && writes.every((c) => [ISSUE_TABLES.invoices, ISSUE_TABLES.lines, INVOICING_TABLES.drafts, "Finance Settings"].includes(tableOfCall(c))) && writes.filter((c) => tableOfCall(c) === INVOICING_TABLES.drafts).length === 1 && writes.filter((c) => tableOfCall(c) === "Finance Settings").length === 1 && nextNumber() === 1002);
    ck("IS8. Issuer + client snapshots frozen on the invoice (legal name, address, VAT no; client name, billing email)", inv.issuer.legalName === "T Ltd" && inv.issuer.address === "1 St" && inv.issuer.vatNumber === "GB1" && inv.issuer.organisationId === ORG && inv.client.name === "TEST Parkside Primary" && inv.client.billingEmail === "billing.parkside@test.invalid");
    const rv = inv.reviewed;
    ck("IS9. What Management reviewed is recorded: draft revision, Ready by/at, accepted warnings", rv.draftRevision === rd.draft.revision && rv.readyBy === MGR && rv.readyAt === NOW.toISOString() && rv.warnings.some((w: any) => w.code === "excluded_work"));
    ck("IS10. Calendar-date arithmetic for due dates (month ends, leap years, year end, 0 days)", addDays("2026-01-31", 30) === "2026-03-02" && addDays("2028-02-28", 1) === "2028-02-29" && addDays("2026-12-31", 1) === "2027-01-01" && addDays("2026-03-29", 0) === "2026-03-29" && addDays("2026-10-24", 7) === "2026-10-31");
    // Time-zone edge: 23:30 UTC on 29 Sep is 00:30 on 30 Sep in London
    const ids2 = await seed();
    addOcc(S.stannes, "2026-09-10");
    const sd = await readyDraft(ids2.stannes);
    NOW = new Date("2026-09-29T23:30:00.000Z");
    const r2 = (await issue(sd.draft.draftId, sd.draft.revision)).body.invoice;
    ck("IS11. Invoice date follows the organisation's calendar day (Europe/London), and the Finance Settings default terms apply", r2.invoiceDate === "2026-09-30" && r2.dueDate === "2026-10-30" && r2.paymentTerms.source === "finance_settings");
  }

  // ===== PR. Preconditions under the lock =====
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    const open = (await create(ids.parkside)).body;
    world.audit = [];
    calls = [];
    const p1 = await issue(open.draft.draftId, open.draft.revision);
    ck("PR1. An open Draft cannot be issued (409 draft_not_ready); nothing written or audited", p1.code === "draft_not_ready" && airtableWrites().length === 0 && world.audit.length === 0);
    const rev = (await details(open.draft.draftId, '{"poNumber":"PO-1"}')).body.draft.revision;
    const rd = (await ready(open.draft.draftId, rev)).body;
    const p2 = await issue(rd.draft.draftId, rd.draft.revision - 1);
    ck("PR2. The revision Management reviewed must match (409 draft_revision_mismatch)", p2.code === "draft_revision_mismatch");
    const p3 = await issue("FID-0123456789AB", 1);
    ck("PR3. Unknown draft -> 404 invoice_draft_not_found", p3.httpStatus === 404 && p3.code === "invoice_draft_not_found");
    // A blocker that appears after Ready: F4 now says not billable
    await ovCreate(ppa, '{"override":{"kind":"not_billable"},"reason":"Coach late"}');
    const linesBefore = JSON.stringify(lineRows());
    const draftBefore = JSON.stringify(draftRows());
    world.audit = [];
    calls = [];
    const p4 = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR4. A blocker after Ready refuses the issue (409 draft_has_blockers, names source_changed) - no silent refresh, nothing written", p4.code === "draft_has_blockers" && "source_changed" in p4.fields && JSON.stringify(lineRows()) === linesBefore && JSON.stringify(draftRows()) === draftBefore && invRows().length === 0 && airtableWrites().length === 0 && world.audit.length === 0);
  }
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const man = parseClientUpdate('{"client":{"billingMethod":"manual"}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: man.patch, reason: "now billed via the trust" });
    const p = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR5. A client switched to Manual billing is refused, fail closed (409 manual_billing_client); nothing written", p.code === "manual_billing_client" && invRows().length === 0);
    const hub = parseClientUpdate('{"client":{"billingMethod":"hub","billingEmail":null}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: hub.patch, reason: null });
    const p2 = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR6. No billing email -> refused (billing_email_missing blocker); the client snapshot must exist", p2.code === "draft_has_blockers" && "billing_email_missing" in p2.fields && invRows().length === 0);
    const back = parseClientUpdate('{"client":{"billingEmail":"billing.parkside@test.invalid"}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: back.patch, reason: null });
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, invoiceLegalName: null })];
    const p3 = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR7. No issuer legal name / address in Finance Settings -> 409 issuer_details_missing", p3.code === "issuer_details_missing" && invRows().length === 0);
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, vatRegistered: false, vatNumber: null, defaultVatRateBasisPoints: null, defaultVatTreatment: null })];
    const p4 = await issue(rd.draft.draftId, rd.draft.revision);
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, vatNumber: null })];
    const p4b = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR8. An invoice charging VAT needs the issuer's VAT registration AND number -> 409 issuer_vat_details_missing", p4.code === "issuer_vat_details_missing" && p4b.code === "issuer_vat_details_missing" && invRows().length === 0);
    world.tables["Finance Settings"] = [settingsRow(SETTINGS)];
    const row = draftRows()[0];
    row.fields["Net (Minor Units)"] += 1;
    const p5 = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR9. Stored totals that do not reconcile refuse the issue (totals_do_not_reconcile)", p5.code === "draft_has_blockers" && "totals_do_not_reconcile" in p5.fields && invRows().length === 0);
    row.fields["Net (Minor Units)"] -= 1;
    const ok = await issue(rd.draft.draftId, rd.draft.revision);
    ck("PR10. Once every precondition holds again, the same Ready draft issues", ok.httpStatus === 201 && invRows().length === 1);
    // A forged issued claim on another client's occurrence is a duplicate claim
    const sa = addOcc(S.stannes, "2026-09-10");
    const sd = await readyDraft(ids.stannes);
    const src = invLineRows()[0];
    invLineRows().push({ id: "recForgedInvLine1", fields: { ...src.fields, "Line ID": "FVL-FFFFFFFFFFFF", "Invoice ID": "FIV-EEEEEEEEEEEE", "Occurrence ID": sa, "Source Draft ID": "FID-EEEEEEEEEEEE" } });
    const p6 = await issue(sd.draft.draftId, sd.draft.revision);
    ck("PR11. Work already on an issued invoice line (another draft) is a duplicate claim: issue refused", p6.code === "draft_has_blockers" && "duplicate_claim" in p6.fields && invRows().length === 1);
    invLineRows().pop();
  }

  // ===== DU. Duplicate / concurrent issue =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const first = await issue(rd.draft.draftId, rd.draft.revision);
    world.audit = [];
    calls = [];
    const again = await issue(rd.draft.draftId, rd.draft.revision);
    const again2 = await issue(rd.draft.draftId, rd.draft.revision + 1);
    ck("DU1. Issuing the same draft again is refused (409 draft_already_issued naming the invoice) before any F4 work; still one invoice; no audit", again.code === "draft_already_issued" && again.error.includes(first.body.invoice.invoiceId) && again2.code === "draft_already_issued" && invRows().length === 1 && world.audit.length === 0 && airtableWrites().length === 0 && !airtableGets().some((c) => [BILLING_TABLES.sessions, BILLING_TABLES.occurrences].includes(tableOfCall(c))));
    delete draftRows()[0].fields["Issued Invoice ID"];
    const lost = await issue(rd.draft.draftId, rd.draft.revision + 1);
    ck("DU2. Even if the draft stamp were lost, the invoice recorded from the draft blocks a second issue", lost.code === "draft_already_issued" && invRows().length === 1);
    draftRows()[0].fields["Issued Invoice ID"] = first.body.invoice.invoiceId;
    const ids2 = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    const rd2 = await readyDraft(ids2.parkside);
    const [c1, c2] = await Promise.all([issue(rd2.draft.draftId, rd2.draft.revision), issue(rd2.draft.draftId, rd2.draft.revision)]);
    const oks = [c1, c2].filter((x) => x.httpStatus === 201);
    const no = [c1, c2].filter((x) => x.status === "error");
    ck("DU3. Two concurrent issue requests: exactly one invoice; the other is refused (busy / already issued); no duplicate lines", oks.length === 1 && no.length === 1 && ["finance_commercial_busy", "draft_already_issued"].includes(no[0].code) && invRows().length === 1 && invLineRows().length === 2);
    const ids3 = await seed();
    addOcc(S.ppa, "2026-09-10");
    const rd3 = await readyDraft(ids3.parkside);
    world.lockHeld = "33333333-3333-4333-8333-333333333333";
    calls = [];
    const busy = await issue(rd3.draft.draftId, rd3.draft.revision);
    ck("DU4. The shared Finance write lock is held -> 409 finance_commercial_busy, nothing written", busy.code === "finance_commercial_busy" && airtableWrites().length === 0 && invRows().length === 0);
    world.lockHeld = null;
  }

  // ===== CL. Source claims are permanent =====
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    const aft = addOcc(S.after, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const inv = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice;
    const e = (await elig(ids.parkside)).body;
    ck("CL1. Issued work is claimed: eligible work shows it claimed by the source draft, none available", e.available.length === 0 && e.claimed.length === 2 && e.claimed.every((x: any) => x.claimedBy.draftId === rd.draft.draftId));
    ck("CL2. A new normal draft for the period finds no unclaimed work (409 no_eligible_work)", (await create(ids.parkside)).code === "no_eligible_work");
    const id = rd.draft.draftId;
    world.audit = [];
    calls = [];
    const frozen = [await reopen(id), await refresh(id), await details(id, '{"poNumber":"PO-9"}'), await exclude(id, lineOf(rd, ppa).lineId), await ready(id, rd.draft.revision + 1), await DW({ route: "draft.terms_exception", draftId: id, occurrenceIds: [ppa], reason: "x" })];
    const nb = await notBillable(id, lineOf(rd, ppa).lineId);
    ck("CL3. An issued draft never changes: reopen / refresh / details / exclude / ready / exception / not-billable all refused (409 draft_issued); F4 untouched", frozen.every((x) => x.code === "draft_issued") && nb.code === "draft_issued" && world.tables[BILLING_TABLES.overrides].length === 0 && airtableWrites().length === 0 && world.audit.length === 0);
    const rd2 = (await read(id)).body;
    ck("CL4. The issued draft stays readable as the traceable source (issued, invoice id; its own invoice lines are not a duplicate claim)", rd2.draft.issued === true && rd2.draft.issuedInvoiceId === inv.invoiceId && rd2.lines.length === 2 && !rd2.review.blockers.some((b: any) => b.code === "duplicate_claim"));
    // Even deleting the draft rows cannot release issued work
    world.tables[INVOICING_TABLES.lines] = [];
    world.tables[INVOICING_TABLES.drafts] = [];
    const e2 = (await elig(ids.parkside)).body;
    ck("CL5. Deleting the draft + its lines does not release issued work: the invoice lines still claim it", e2.available.length === 0 && e2.claimed.length === 2 && (await create(ids.parkside)).code === "no_eligible_work");
    const late = addOcc(S.ppa, "2026-09-12");
    const d3 = (await create(ids.parkside)).body;
    ck("CL6. New work in the same period goes on a new draft; the issued occurrences never do", d3.lines.length === 1 && d3.lines[0].occurrenceId === late && ![ppa, aft].some((o) => d3.lines.some((l: any) => l.occurrenceId === o)));
  }

  // ===== SN. Snapshots never change =====
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    const aft = addOcc(S.after, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const invId = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice.invoiceId;
    const before = await readInv(invId);
    const rowsBefore = JSON.stringify([invRows(), invLineRows()]);
    const up = parseClientUpdate('{"client":{"name":"Parkside Academy (renamed)","billingEmail":"new.billing@test.invalid","paymentTermsDaysOverride":7,"poRequired":false,"billingContactName":"Someone Else"}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: up.patch, reason: "rebrand" });
    await W({ route: "terms.change", serviceId: ids.ppa, req: { effectiveFrom: "2026-10-01", changes: { amountMinor: 9900 }, changedKeys: ["amount"] }, reason: "new price" });
    await ovCreate(aft, '{"override":{"kind":"quantity","quantity":25},"reason":"recount after issue"}');
    await ovCreate(ppa, '{"override":{"kind":"not_billable"},"reason":"goodwill after issue"}');
    world.tables[BILLING_TABLES.occurrences].find((o) => o.fields["Occurrence ID"] === ppa)!.fields.Status = "Cancelled";
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, invoiceLegalName: "Renamed Ltd", invoiceAddress: "2 Other St", vatNumber: "GB999" })];
    calls = [];
    const after = await readInv(invId);
    ck("SN1. Client / F3 terms / F4 overrides / Schedule / Finance Settings changes after issue leave the invoice + lines byte-identical", stripVolatile(after.body) === stripVolatile(before.body) && after.body.invoice.client.name === "TEST Parkside Primary" && after.body.invoice.issuer.legalName === "T Ltd" && after.body.lines.find((l: any) => l.occurrenceId === aft).quantity === 18);
    ck("SN2. Stored invoice + line rows are untouched by those changes", JSON.stringify([invRows(), invLineRows()]) === rowsBefore);
    const forbidden = [TABLES.clients, TABLES.services, TABLES.terms, TABLES.lifecycle, "Finance Settings", BILLING_TABLES.overrides, BILLING_TABLES.occurrences, BILLING_TABLES.sessions, INVOICING_TABLES.lines];
    ck("SN3. Reading an invoice never re-runs F4: no Schedule / F3 / F4 / Settings / draft-line reads, and no writes", !airtableGets().some((c) => forbidden.includes(tableOfCall(c))) && airtableWrites().length === 0);
    const lr = invLineRows()[0];
    lr.fields["Gross (Minor Units)"] += 100;
    const bad = await readInv(invId);
    ck("SN4. A tampered stored figure is caught on read (409 invoice_data_invalid) - never shown as the invoice", bad.code === "invoice_data_invalid");
    lr.fields["Gross (Minor Units)"] -= 100;
    lr.fields["Net (Minor Units)"] += 100;
    lr.fields["Gross (Minor Units)"] += 100;
    const bad2 = await readInv(invId);
    ck("SN4b. A self-consistent tampered line that no longer sums to the invoice is also caught (409 invoice_data_invalid)", bad2.code === "invoice_data_invalid");
    lr.fields["Net (Minor Units)"] -= 100;
    lr.fields["Gross (Minor Units)"] -= 100;
    const foreign = { ...invRows()[0], fields: { ...invRows()[0].fields, Organisation: [OTHER_ORG_REC] } };
    const twoOrgs = { ...invRows()[0], fields: { ...invRows()[0].fields, Organisation: [ORG_REC, OTHER_ORG_REC] } };
    const badStatus = { ...invRows()[0], fields: { ...invRows()[0].fields, Status: "Paid" } };
    const selfRef = { ...invRows()[0], fields: { ...invRows()[0].fields, "Replaces Invoice ID": invId, "Correction ID": "FCN-000000000001" } };
    ck("SN6. Stored invoice rows are validated: another organisation's row, two organisations, an unknown status (e.g. Paid) or a self-replacement are invalid data", [foreign, twoOrgs, badStatus, selfRef].every((r) => (buildInvoices([r], ORG_REC) as any).ok === false) && (buildInvoices([invRows()[0]], ORG_REC) as any).ok === true);
    const snap = JSON.parse(invLineRows().find((r) => r.fields["Occurrence ID"] === aft)!.fields["Source Snapshot"]);
    ck("SN5. Each invoice line keeps the F4 source snapshot it was drafted from (terms, quantity basis, resolvedOn)", snap.terms.chargeType === "per_player" && snap.quantity.value === 18 && snap.resolvedOn === "2026-09-29");
  }

  // ===== PT. PO / payment terms =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const d = (await create(ids.parkside)).body;
    const r1 = (await details(d.draft.draftId, '{"poOverrideReason":"School confirmed by email no PO this term","paymentTermsDays":14}')).body;
    const rd = (await ready(d.draft.draftId, r1.draft.revision)).body;
    const inv = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice;
    ck("PT1. PO requirement + override reason preserved (no PO number invented)", inv.po.required === true && inv.po.number === null && inv.po.overrideReason === "School confirmed by email no PO this term");
    ck("PT2. An invoice-level terms override is preserved with its source; due = invoice date + 14", inv.paymentTerms.days === 14 && inv.paymentTerms.source === "invoice_override" && inv.dueDate === "2026-10-13");
    const ids2 = await seed();
    addOcc(S.ppa, "2026-09-10");
    const rd2 = await readyDraft(ids2.parkside);
    const inv2 = (await issue(rd2.draft.draftId, rd2.draft.revision)).body.invoice;
    ck("PT3. PO number + client terms (30 days, source client) preserved", inv2.po.number === "PO-77" && inv2.paymentTerms.source === "client" && inv2.paymentTerms.days === 30 && inv2.dueDate === "2026-10-29");
  }

  // ===== MT. Missing-terms approved omission =====
  {
    const ids = await seed();
    const ok1 = addOcc(S.ppa, "2026-09-10");
    world.tables[TABLES.terms].find((t) => t.fields["Amount (Minor Units)"] === 6000)!.fields["Effective From"] = "2026-09-20";
    const brk = addOcc(S.breakfast, "2026-09-10");
    const d = (await create(ids.parkside)).body;
    await details(d.draft.draftId, '{"poNumber":"PO-1"}');
    const ex = (await DW({ route: "draft.terms_exception", draftId: d.draft.draftId, occurrenceIds: [brk], reason: "Legacy price never agreed - leave off" })).body;
    const rd = (await ready(d.draft.draftId, ex.draft.revision)).body;
    const r = (await issue(rd.draft.draftId, rd.draft.revision)).body;
    const om = r.invoice.approvedOmissions;
    ck("MT1. The approved missing-terms exception is preserved on the invoice (occurrence, reason, approver) - shown apart from lines", om.length === 1 && om[0].occurrenceId === brk && om[0].reason === "Legacy price never agreed - leave off" && om[0].approvedBy === MGR && /never billed at £0/.test(om[0].note));
    ck("MT2. No fake line and no £0 line: only the priced work is invoiced", r.lines.length === 1 && r.lines[0].occurrenceId === ok1 && !r.lines.some((l: any) => l.occurrenceId === brk || l.gross === "0.00") && r.invoice.totals.lineCount === 1);
    const e = (await elig(ids.parkside)).body;
    ck("MT3. The underlying issue stays unresolved in Finance (still withoutTerms, not claimed by the invoice)", e.withoutTerms.some((x: any) => x.occurrenceId === brk) && !e.claimed.some((x: any) => x.occurrenceId === brk));
    ck("MT4. The issued audit records the omission", world.audit.some((a) => a.event_type === "finance_invoice.issued" && JSON.stringify(a.context.approvedOmissions) === JSON.stringify([brk])));
  }

  // ===== AC. Access + tenant =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    world.audit = [];
    calls = [];
    const vi = await issue(rd.draft.draftId, rd.draft.revision, viewer);
    ck("AC1. Finance View cannot issue (403 finance_manage_required); nothing written", vi.code === "finance_manage_required" && airtableWrites().length === 0 && world.audit.length === 0);
    const inv = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice;
    const r = await readInv(inv.invoiceId, viewer);
    const li = (await listInvoices(deps, viewer, ids.parkside)) as any;
    const cn = (await credit(inv.invoiceId)).body.creditNote;
    const rc = (await readCreditNote(deps, viewer, cn.creditNoteId)) as any;
    const lc = (await listInvoiceCreditNotes(deps, viewer, inv.invoiceId)) as any;
    ck("AC2. Finance View reads invoices, lines, the client list, credit notes", r.body.access === "view" && r.body.lines.length === 1 && li.body.invoices.length === 1 && li.body.invoices[0].invoiceId === inv.invoiceId && rc.body.creditNote.creditNoteId === cn.creditNoteId && lc.body.creditNotes.length === 1);
    world.audit = [];
    calls = [];
    const vw = [await credit(inv.invoiceId, null, "x", viewer), await replace(cn.creditNoteId, "x", viewer)];
    ck("AC3. Finance View cannot credit or start a replacement (403); nothing written", vw.every((x) => x.code === "finance_manage_required") && airtableWrites().length === 0 && world.audit.length === 0);
    world.grants[VIEWER] = [];
    ck("AC4. No Finance grant -> 403 finance_access_denied", (await readInv(inv.invoiceId, viewer)).code === "finance_access_denied");
    const coach = { userId: "c", role: "coach", active: true, organisationId: ORG };
    const parent = { userId: "p", role: "parent", active: true, organisationId: ORG };
    ck("AC5. Coach / Parent -> 403 management_required", (await readInv(inv.invoiceId, coach)).code === "management_required" && (await issue(rd.draft.draftId, 1, parent)).code === "management_required");
    world.moduleOn = false;
    ck("AC6. Finance module off -> 403 finance_module_disabled (reads and writes)", (await readInv(inv.invoiceId)).code === "finance_module_disabled" && (await credit(inv.invoiceId)).code === "finance_module_disabled");
    world.moduleOn = true;
    ck("AC7. Tenant keys rejected in every F6 body / query", (parseIssue('{"revision":1,"organisationId":"X"}', isTenantKey) as any).code === "tenant_param_rejected" && (parseCreditNote('{"reason":"x","org":"Y"}', isTenantKey) as any).code === "tenant_param_rejected" && (parseReplacement('{"reason":"x","organisation_id":"Y"}', isTenantKey) as any).code === "tenant_param_rejected" && (checkInvoiceListQuery(new URLSearchParams("clientId=FCL-AAAAAAAAAAAA&organisationId=X"), isTenantKey) as any).code === "tenant_param_rejected");
    invRows()[0].fields.Organisation = [OTHER_ORG_REC];
    ck("AC8. Another organisation's invoice is not found (404)", (await readInv(inv.invoiceId)).code === "invoice_not_found");
    invRows()[0].fields.Organisation = [ORG_REC];
  }

  // ===== CN. Credit notes =====
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    const aft = addOcc(S.after, "2026-09-10");
    addOcc(S.ppa, "2026-09-11");
    const rd = await readyDraft(ids.parkside);
    const inv = (await issue(rd.draft.draftId, rd.draft.revision)).body;
    const invId = inv.invoice.invoiceId;
    const lp = inv.lines.find((l: any) => l.occurrenceId === ppa).lineId;
    const la = inv.lines.find((l: any) => l.occurrenceId === aft).lineId;
    const linesBefore = JSON.stringify(invLineRows());
    const invBefore = { ...invRows()[0].fields };
    world.audit = [];
    const c1 = await credit(invId, [lp], "Session cut short - credit it");
    const cn1 = c1.body.creditNote;
    ck("CN1. A credit note for one whole line: 201, FCN- id, its amounts are the line's frozen figures, reason + date + creator recorded", c1.httpStatus === 201 && /^FCN-[0-9A-F]{12}$/.test(cn1.creditNoteId) && cn1.totals.gross === "60.00" && cn1.totals.net === "50.00" && cn1.totals.vat === "10.00" && cn1.lines.length === 1 && cn1.lines[0].invoiceLineId === lp && cn1.reason === "Session cut short - credit it" && cn1.creditDate === "2026-09-29" && cn1.createdBy === MGR && cn1.invoiceId === invId && cn1.status === "issued" && cn1.external.creditNoteNumber === null);
    ck("CN2. The invoice becomes Partially credited; remaining = invoice - credit; the credited line is marked", c1.body.invoice.status === "partially_credited" && c1.body.invoice.credit.credited.gross === "60.00" && c1.body.invoice.credit.remaining.gross === (Number(inv.invoice.totals.gross) - 60).toFixed(2) && c1.body.lines.find((l: any) => l.lineId === lp).creditedBy === cn1.creditNoteId);
    const invAfter = invRows()[0].fields;
    const changedKeys = Object.keys({ ...invBefore, ...invAfter }).filter((k) => JSON.stringify(invBefore[k]) !== JSON.stringify(invAfter[k])).sort();
    ck("CN3. The original invoice is unchanged except its credit state + revision: lines, amounts, dates, terms, snapshots identical", JSON.stringify(invLineRows()) === linesBefore && changedKeys.includes("Revision") && changedKeys.includes("Status") && changedKeys.every((k) => ["Last Changed At", "Last Changed By User ID", "Revision", "Status"].includes(k)) && invAfter.Revision === 2);
    cnRows().push({ id: "recForgedCredit02", fields: { ...cnRows()[0].fields, "Credit Note ID": "FCN-EEEEEEEEEEEE" } });
    ck("CN9b. A stored second credit of an already-credited line (even within the invoice total and status) is invalid data (409)", (await readInv(invId)).code === "invoice_data_invalid");
    cnRows().pop();
    world.audit = [];
    calls = [];
    const dup = await credit(invId, [lp]);
    const mixed = await credit(invId, [la, lp]);
    const unknown = await credit(invId, ["FVL-000000000000"]);
    ck("CN4. Crediting a line twice is refused (409 line_already_credited), also within a mixed request; an unknown line is 404; nothing written", dup.code === "line_already_credited" && mixed.code === "line_already_credited" && unknown.httpStatus === 404 && unknown.code === "invoice_line_not_found" && airtableWrites().length === 0 && world.audit.length === 0 && cnRows().length === 1);
    const c2 = await credit(invId, null, "Rest of the invoice was wrong");
    ck("CN5. Omitting lineIds credits every remaining line; the invoice becomes Credited; remaining 0.00", c2.body.creditNote.lines.length === inv.lines.length - 1 && !c2.body.creditNote.lines.some((c: any) => c.invoiceLineId === lp) && c2.body.invoice.status === "credited" && c2.body.invoice.credit.remaining.gross === "0.00" && c2.body.invoice.credit.credited.gross === inv.invoice.totals.gross);
    const over = await credit(invId);
    ck("CN6. Nothing left to credit -> 409 invoice_fully_credited (never exceeds the invoice)", over.code === "invoice_fully_credited" && cnRows().length === 2);
    const plan = planCreditNote({ invoice: buildInvoices(invRows(), ORG_REC).ok ? (buildInvoices(invRows(), ORG_REC) as any).invoices[0].value : null, lines: [], notes: [], lineIds: ["FVL-000000000001"], reason: "x", creditNoteId: "FCN-000000000001", meta: { userId: MGR, at: "x", today: "2026-09-29" } }) as any;
    ck("CN7. The pure planner refuses a line that is not on the invoice", plan.ok === false && plan.code === "invoice_line_not_found");
    const cnJson = JSON.stringify(c1.body.creditNote);
    ck("CN8. A credit note records the credit only - no refund / cash / payment fields", !/refund|paid|payment|cash/i.test(cnJson));
    const forged = { id: "recForgedCredit01", fields: { ...cnRows()[0].fields, "Credit Note ID": "FCN-FFFFFFFFFFFF" } };
    cnRows().push(forged);
    ck("CN9. Stored credits that would exceed / double-credit the invoice are invalid data (409 invoice_data_invalid)", (await readInv(invId)).code === "invoice_data_invalid");
    cnRows().pop();
    const full = (await readInv(invId)).body;
    ck("CN10. Reading the invoice shows both credit notes, the credited lines and a history (issued -> credit notes)", full.creditNotes.length === 2 && full.lines.every((l: any) => l.creditedBy) && full.history.map((h: any) => h.event).join() === "issued,credit_note,credit_note");
    ck("CN11. Credited work stays claimed for normal drafts (no_eligible_work) - only a replacement can re-bill it", (await create(ids.parkside)).code === "no_eligible_work");
  }

  // ===== RP. Correction -> replacement =====
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    const aft = addOcc(S.after, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const inv = (await issue(rd.draft.draftId, rd.draft.revision)).body;
    const invId = inv.invoice.invoiceId;
    const la = inv.lines.find((l: any) => l.occurrenceId === aft).lineId;
    const cn = (await credit(invId, [la], "Headcount was 20, not 18")).body.creditNote;
    await ovCreate(aft, '{"override":{"kind":"quantity","quantity":20},"reason":"register shows 20"}');
    const other = addOcc(S.ppa, "2026-09-15");
    world.audit = [];
    const rp = await replace(cn.creditNoteId);
    const rdr = rp.body;
    ck("RP1. A replacement draft starts from the credit note: 201, open Draft linked to the original invoice + correction", rp.httpStatus === 201 && rdr.draft.status === "draft" && rdr.draft.replacement.replacesInvoiceId === invId && rdr.draft.replacement.correctionId === cn.creditNoteId && JSON.stringify(rdr.draft.replacement.occurrenceIds) === JSON.stringify([aft]) && rdr.correction.replacementDraftId === rdr.draft.draftId);
    ck("RP2. It bills exactly the credited work at today's F4 figures (20 players = £180.00) - not the uncredited line, not other new work", rdr.lines.length === 1 && rdr.lines[0].occurrenceId === aft && rdr.lines[0].quantity === 20 && rdr.lines[0].gross === "180.00" && !rdr.lines.some((l: any) => [ppa, other].includes(l.occurrenceId)));
    ck("RP3. Its review has no duplicate-claim blocker (the credited claim is released to this draft only)", !rdr.review.blockers.some((b: any) => b.code === "duplicate_claim"));
    const twice = await replace(cn.creditNoteId);
    ck("RP4. One correction has one replacement (409 replacement_exists)", twice.code === "replacement_exists" && draftRows().filter((r) => r.fields["Correction ID"] === cn.creditNoteId).length === 1);
    const normal = (await create(ids.parkside)).body;
    ck("RP5. A normal draft for the period is not blocked by the replacement and never includes the credited occurrence", normal.lines.length === 1 && normal.lines[0].occurrenceId === other);
    const rev = (await details(rdr.draft.draftId, '{"poNumber":"PO-77B"}')).body.draft.revision;
    const rrd = (await ready(rdr.draft.draftId, rev)).body;
    world.audit = [];
    const ri = await issue(rrd.draft.draftId, rrd.draft.revision);
    const rinv = ri.body.invoice;
    ck("RP6. The replacement issues as a new invoice that records what it replaces (Replaces Invoice ID + Correction ID)", ri.httpStatus === 201 && rinv.invoiceId !== invId && rinv.replacesInvoiceId === invId && rinv.correctionId === cn.creditNoteId && rinv.totals.gross === "180.00");
    const orig = (await readInv(invId)).body;
    ck("RP7. The original invoice is untouched and links forward: credit note -> replacement draft -> replacement invoice; history shows the chain", orig.invoice.totals.gross === inv.invoice.totals.gross && orig.invoice.status === "partially_credited" && orig.links.corrections.length === 1 && orig.links.corrections[0].creditNoteId === cn.creditNoteId && orig.links.corrections[0].replacementDraftId === rdr.draft.draftId && orig.links.corrections[0].replacementInvoiceId === rinv.invoiceId && orig.history.map((h: any) => h.event).join() === "issued,credit_note,correction_initiated,replaced");
    const rc = (await readCreditNote(deps, mgr, cn.creditNoteId)) as any;
    ck("RP8. The credit note links both ways (original invoice, replacement draft, replacement invoice)", rc.body.links.invoiceId === invId && rc.body.links.replacementDraftId === rdr.draft.draftId && rc.body.links.replacementInvoiceId === rinv.invoiceId);
    // Second correction of the replacement (chain): the released claims are inherited
    const cn2 = (await credit(rinv.invoiceId, null, "Still wrong - 19 players")).body.creditNote;
    await ovCreate(aft, `{"override":{"kind":"quantity","quantity":19},"reason":"recount","supersedes":"${world.tables[BILLING_TABLES.overrides].find((o) => o.fields["Occurrence ID"] === aft && o.fields.Quantity === 20)?.fields["Override ID"] ?? ""}"}`);
    const rp2 = (await replace(cn2.creditNoteId)).body;
    const rev2 = (await details(rp2.draft.draftId, '{"poNumber":"PO-77C"}')).body.draft.revision;
    const rrd2 = (await ready(rp2.draft.draftId, rev2)).body;
    const ri2 = await issue(rrd2.draft.draftId, rrd2.draft.revision);
    ck("RP9. A correction of a replacement works the same way (claims of every earlier corrected invoice released to it)", ri2.httpStatus === 201 && ri2.body.invoice.replacesInvoiceId === rinv.invoiceId && ri2.body.lines[0].occurrenceId === aft && rp2.draft.replacement.occurrenceIds.join() === aft);
    ck("RP10. After all that, the occurrence is still claimed for normal drafts", !(await elig(ids.parkside)).body.available.some((x: any) => x.occurrenceId === aft));
  }
  {
    const ids = await seed();
    const ppa = addOcc(S.ppa, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const inv = (await issue(rd.draft.draftId, rd.draft.revision)).body.invoice;
    const cn = (await credit(inv.invoiceId, null, "Session did not happen")).body.creditNote;
    await ovCreate(ppa, '{"override":{"kind":"not_billable"},"reason":"did not happen"}');
    world.audit = [];
    calls = [];
    const r = await replace(cn.creditNoteId);
    ck("RP11. Credited work that is no longer billable has nothing to re-bill (409 no_replacement_work); the credit note stands alone; nothing written", r.code === "no_replacement_work" && airtableWrites().length === 0 && world.audit.length === 0);
    ck("RP12. Unknown credit note -> 404", (await replace("FCN-000000000000")).httpStatus === 404);
    const man = parseClientUpdate('{"client":{"billingMethod":"manual"}}', isTenantKey) as any;
    world.tables[BILLING_TABLES.overrides] = [];
    await W({ route: "client.update", clientId: ids.parkside, patch: man.patch, reason: "manual now" });
    ck("RP13. A manual-billing client gets no Hub replacement (409 manual_billing_client)", (await replace(cn.creditNoteId)).code === "manual_billing_client");
  }


  // ===== NB. Official invoice numbering (F6 correction) =====
  {
    // Xero authority: FIV now, no official number invented, nothing advanced
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    setSettings({ invoiceNumberAuthority: "xero", invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001 });
    const rd = await readyDraft(ids.parkside);
    world.audit = [];
    calls = [];
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    const n = r.body.invoice.numbering;
    ck("NB1. Internal FIV reference exists whatever the authority (Xero here): numbering.internalReference = invoiceId = reference", r.httpStatus === 201 && /^FIV-[0-9A-F]{12}$/.test(n.internalReference) && n.internalReference === r.body.invoice.invoiceId && r.body.invoice.reference === n.internalReference);
    ck("NB2. Xero authority: no official number is invented - pending from Xero; no Hub number stored; external fields blank", n.authority === "xero" && n.officialNumber === null && n.status === "pending_external" && n.hubSequence === null && invRows()[0].fields["Invoice Number Authority"] === "Xero" && !("Hub Invoice Number" in invRows()[0].fields) && !("Hub Invoice Sequence" in invRows()[0].fields) && r.body.invoice.external.invoiceNumber === null && !/INV-1001/.test(JSON.stringify(r.body)));
    ck("NB2b. Xero authority: the Settings next number is untouched and never written", nextNumber() === 1001 && !airtableWrites().some((c) => tableOfCall(c) === "Finance Settings"));
  }
  {
    // Hub authority: organisation sequence
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.stannes, "2026-09-10");
    setSettings(HUB);
    const a = await readyDraft(ids.parkside);
    const b = await readyDraft(ids.stannes);
    world.audit = [];
    const r1 = await issue(a.draft.draftId, a.draft.revision);
    const n1 = r1.body.invoice.numbering;
    ck("NB3. Hub authority: the invoice gets the organisation's next official number (prefix + next) at issue, alongside its FIV reference", r1.httpStatus === 201 && n1.authority === "hub" && n1.officialNumber === "INV-1001" && n1.status === "assigned" && n1.hubSequence === 1001 && /^FIV-/.test(n1.internalReference) && invRows()[0].fields["Hub Invoice Number"] === "INV-1001" && invRows()[0].fields["Hub Invoice Sequence"] === 1001 && invRows()[0].fields["Invoice Number Authority"] === "Hub");
    ck("NB3b. The Settings next number advanced to 1002 in the same write; the issue audit records the number and the sequence step", nextNumber() === 1002 && JSON.stringify(world.audit.find((e) => e.event_type === "finance_invoice.issued").context.numbering) === JSON.stringify({ authority: "hub", officialNumber: "INV-1001", sequence: 1001, nextNumberBefore: 1001, nextNumberAfter: 1002 }) && world.audit.find((e) => e.event_type === "finance_invoice.issued").after.invoice.hubInvoiceNumber === "INV-1001");
    const r2 = await issue(b.draft.draftId, b.draft.revision);
    ck("NB4. A second Hub invoice gets the next number (INV-1002); next becomes 1003", r2.body.invoice.numbering.officialNumber === "INV-1002" && r2.body.invoice.numbering.hubSequence === 1002 && nextNumber() === 1003);
    ck("NB4b. Padding is deliberate: prefix + number zero-padded to the minimum digits, never cut", formatHubInvoiceNumber("INV-", 7, 3) === "INV-007" && formatHubInvoiceNumber("INV-", 1001, 3) === "INV-1001" && formatHubInvoiceNumber("TEST-INV-", 42, null) === "TEST-INV-42");
    ck("NB4c. Not configured -> 409 invoice_numbering_not_configured (no authority; Hub without prefix / next); used-up sequence -> 409", (invoiceNumberPlan({ ...EMPTY_SETTINGS } as any) as any).code === "invoice_numbering_not_configured" && (invoiceNumberPlan({ ...EMPTY_SETTINGS, invoiceNumberAuthority: "hub", invoiceNumberNext: 5 } as any) as any).code === "invoice_numbering_not_configured" && (invoiceNumberPlan({ ...EMPTY_SETTINGS, invoiceNumberAuthority: "hub", invoiceNumberPrefix: "INV-" } as any) as any).code === "invoice_numbering_not_configured" && (invoiceNumberPlan({ ...EMPTY_SETTINGS, invoiceNumberAuthority: "hub", invoiceNumberPrefix: "INV-", invoiceNumberNext: 1_000_000_000 } as any) as any).code === "invoice_number_sequence_exhausted" && invoiceNumberPlan(null).ok === false);
  }
  {
    // Not configured: refused through the orchestrator, nothing written
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    // A prefix and next number are set, but no authority: never inferred as Hub.
    setSettings({ invoiceNumberAuthority: null, invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001 });
    const rd = await readyDraft(ids.parkside);
    world.audit = [];
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    ck("NB4d. No numbering authority chosen (even with a prefix + next number set) -> 409 invoice_numbering_not_configured, never inferred; nothing written, no audit, draft not stamped", r.httpStatus === 409 && r.code === "invoice_numbering_not_configured" && invRows().length === 0 && world.audit.length === 0 && nextNumber() === 1001 && (await read(rd.draft.draftId)).body.draft.issued === false);
  }
  {
    // Different organisations: independent sequences
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    setSettings(HUB);
    settingsRows().push({ id: "recOtherSettings01", fields: { Organisation: [OTHER_ORG_REC], "Finance Settings ID": "FINSET-OTHER", Revision: 1, ...Object.fromEntries(Object.entries(toStoredFields({ ...SETTINGS, ...HUB, invoiceNumberNext: 5 } as any, ["invoiceNumberAuthority", "invoiceNumberPrefix", "invoiceNumberNext"])).filter(([, v]) => v !== null)) } });
    // Another organisation already issued INV-1001 in ITS sequence
    invRows().push({ id: "recOtherInvoice01", fields: { Organisation: [OTHER_ORG_REC], "Invoice ID": "FIV-0THER0000001", "Hub Invoice Number": "INV-1001", "Hub Invoice Sequence": 1001, "Invoice Number Authority": "Hub" } });
    const rd = await readyDraft(ids.parkside);
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    ck("NB5. Sequences are per organisation: another organisation's INV-1001 neither blocks nor shifts ours, and its next number (5) is untouched", r.httpStatus === 201 && r.body.invoice.numbering.officialNumber === "INV-1001" && nextNumber() === 1002 && settingsRows()[1].fields["Next Invoice Number"] === 5);
  }
  {
    // Concurrency: never the same number twice
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.stannes, "2026-09-10");
    setSettings(HUB);
    const a = await readyDraft(ids.parkside);
    const b = await readyDraft(ids.stannes);
    const [x, y] = await Promise.all([issue(a.draft.draftId, a.draft.revision), issue(b.draft.draftId, b.draft.revision)]);
    const ok = [x, y].filter((r) => r.httpStatus === 201);
    const busy = [x, y].filter((r) => r.code === "finance_commercial_busy");
    const retry = busy.length ? await issue(busy[0] === x ? a.draft.draftId : b.draft.draftId, (busy[0] === x ? a : b).draft.revision) : null;
    const numbers = invRows().map((r) => r.fields["Hub Invoice Number"]);
    ck("NB6. Two simultaneous issues: one gets INV-1001, the other is refused busy (never a shared number); the retry gets INV-1002", ok.length === 1 && busy.length === 1 && ok[0].body.invoice.numbering.officialNumber === "INV-1001" && retry?.body.invoice.numbering.officialNumber === "INV-1002" && new Set(numbers).size === numbers.length && numbers.length === 2 && nextNumber() === 1003);
    ck("NB6b. The Settings lock is held for the whole issue and always released (acquire/release pairs; nothing left held)", world.settingsLockLog.length >= 4 && world.settingsLockLog.every((e, i) => e === (i % 2 ? "release" : "acquire")) && world.settingsLockHeld === null && world.lockHeld === null);
  }
  {
    // A Settings change racing an issue cannot corrupt the sequence
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    setSettings(HUB);
    const rd = await readyDraft(ids.parkside);
    world.settingsLockMode = "busy";
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    ck("NB6c. While Finance Settings are being changed, issue is refused 409 finance_settings_busy - nothing written, number not taken", r.httpStatus === 409 && r.code === "finance_settings_busy" && invRows().length === 0 && nextNumber() === 1001 && world.lockHeld === null);
    world.settingsLockMode = "ok";
    const [i1, s1] = await Promise.all([issue(rd.draft.draftId, rd.draft.revision), settingsUpdate({ invoiceNumberNext: 5000 })]);
    const issuedNo = i1.httpStatus === 201 ? i1.body.invoice.numbering.officialNumber : null;
    const consistent = i1.httpStatus === 201 && s1.status === "ok" ? (issuedNo === "INV-1001" && nextNumber() === 5000) || (issuedNo === "INV-5000" && nextNumber() === 5001) : i1.httpStatus === 201 ? issuedNo === "INV-1001" && nextNumber() === 1002 : s1.status === "ok" && nextNumber() === 5000 && invRows().length === 0;
    ck("NB6d. An issue racing a Settings change of the next number: they never interleave (one waits / is refused); the result is one consistent sequence", consistent && (i1.httpStatus === 201 || i1.code === "finance_settings_busy") && world.settingsLockHeld === null, `${i1.httpStatus} ${i1.code ?? issuedNo} / ${s1.status} ${s1.code ?? ""} / next ${nextNumber()}`);
  }
  {
    // Failed issue: nothing partial, number not consumed (gap-free)
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    setSettings(HUB);
    const rd = await readyDraft(ids.parkside);
    world.failCreateOn = ISSUE_TABLES.lines;
    const f1 = await issue(rd.draft.draftId, rd.draft.revision);
    world.failCreateOn = undefined;
    ck("NB7. A failed issue (line write fails) leaves no invoice, no number taken: next stays 1001, draft not stamped (503)", f1.httpStatus === 503 && invRows().length === 0 && invLineRows().length === 0 && nextNumber() === 1001 && (await read(rd.draft.draftId)).body.draft.issued === false);
    world.auditStatus = 500;
    const f2 = await issue(rd.draft.draftId, rd.draft.revision);
    world.auditStatus = undefined;
    ck("NB7b. A failed audit write also rolls the number back (503; no invoice; next 1001)", f2.code === "finance_audit_unavailable" && invRows().length === 0 && nextNumber() === 1001);
    const ok = await issue(rd.draft.draftId, rd.draft.revision);
    ck("NB7c. The next successful issue takes INV-1001 - no gap from the failed attempts", ok.httpStatus === 201 && ok.body.invoice.numbering.officialNumber === "INV-1001" && nextNumber() === 1002);
    // Never reused: Settings set back to a used number -> refused, not skipped or reused
    addOcc(S.stannes, "2026-09-10");
    const b = await readyDraft(ids.stannes);
    setSettings({ ...HUB, invoiceNumberNext: 1001 });
    const dup = await issue(b.draft.draftId, b.draft.revision);
    ck("NB8. A number already on an issued invoice is never reused: next set back to 1001 -> 409 invoice_number_taken, nothing written", dup.httpStatus === 409 && dup.code === "invoice_number_taken" && invRows().length === 1 && nextNumber() === 1001);
    const invId = ok.body.invoice.invoiceId;
    setSettings({ ...HUB, invoiceNumberPrefix: "NEW-", invoiceNumberNext: 7000 });
    await credit(invId, null, "Whole invoice disputed");
    const again = (await readInv(invId)).body.invoice;
    ck("NB8b. An issued invoice's official number never changes: after a Settings prefix / next change and a credit note it is still INV-1001 (seq 1001)", again.numbering.officialNumber === "INV-1001" && again.numbering.hubSequence === 1001 && again.status === "credited" && invRows()[0].fields["Hub Invoice Number"] === "INV-1001");
  }
  {
    // Xero later filling the external fields coexists with the FIV
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    setSettings({ invoiceNumberAuthority: "xero" });
    const rd = await readyDraft(ids.parkside);
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    const invId = r.body.invoice.invoiceId;
    // An external number alone (still "Awaiting external issue") is contradictory -> invalid, never half-issued.
    Object.assign(invRows()[0].fields, { "External Provider": "Xero", "External Invoice ID": "xero-guid-0001", "External Invoice Number": "INV-0042" });
    const half = await readInv(invId);
    // What F9 will record in one step: Xero's id + number, the external issue date / due date, Issued.
    Object.assign(invRows()[0].fields, { Status: "Issued", "Invoice Date": "2026-10-02", "Due Date": "2026-11-01", "Issued At": "2026-10-02T09:00:00.000Z", "Issued By User ID": "xero-sync" });
    const after = (await readInv(invId)).body.invoice;
    ck("NB9. When Xero's issue is recorded later (F9), its number becomes the official number next to the unchanged FIV reference (an external number without the issue is invalid)", half.code === "invoice_data_invalid" && after.invoiceId === invId && after.numbering.internalReference === invId && after.numbering.officialNumber === "INV-0042" && after.numbering.status === "assigned" && after.external.provider === "Xero" && after.external.invoiceId === "xero-guid-0001" && after.status === "issued" && after.receivable === true && after.invoiceDate === "2026-10-02" && after.frozenAt === r.body.invoice.frozenAt);
    const c = await credit(invId, null, "Cancelled");
    ck("NB9b. ... and the invoice keeps working (credit note 201) with both identities intact", c.httpStatus === 201 && c.body.invoice.numbering.officialNumber === "INV-0042");
    invRows()[0].fields["Hub Invoice Number"] = "INV-9";
    const bad = await readInv(invId);
    ck("NB9c. Stored data is strict: a Xero-numbered invoice carrying a Hub number is invalid (409), never guessed", bad.httpStatus === 409 && bad.code === "invoice_data_invalid");
    delete invRows()[0].fields["Hub Invoice Number"];
    invRows()[0].fields["Invoice Number Authority"] = "Hub";
    invRows()[0].fields["Issue Authority"] = "Hub";
    ck("NB9d. ... and a Hub-numbered invoice without its number / sequence is invalid (409)", (await readInv(invId)).code === "invoice_data_invalid");
  }

  // ===== RI. Replacement inherits the original invoice's terms / PO (F6 correction) =====
  {
    const ids = await seed();
    const aft = addOcc(S.after, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    const orig = r.body.invoice;
    const origRow = JSON.stringify(invRows()[0].fields);
    ck("RI10. Original invoice: 30-day client terms, PO PO-77", orig.paymentTerms.days === 30 && orig.paymentTerms.source === "client" && orig.po.number === "PO-77" && orig.po.required === true);
    await W({ route: "client.update", clientId: ids.parkside, patch: { paymentTermsDaysOverride: 14 }, reason: "new contract: 14 days" });
    ck("RI11. The client's current default is now 14 days", (await create(ids.parkside)).code === "no_eligible_work" && world.tables[TABLES.clients].find((c) => c.fields["Finance Client ID"] === ids.parkside)?.fields["Payment Terms Override (Days)"] === 14);
    const cn = (await credit(orig.invoiceId, null, "Headcount wrong")).body.creditNote;
    await ovCreate(aft, '{"override":{"kind":"quantity","quantity":20},"reason":"register shows 20"}');
    world.audit = [];
    const rp = (await replace(cn.creditNoteId)).body;
    ck("RI12. The replacement draft STARTS at the original 30 days (source original_invoice) - not the client's new 14", rp.draft.paymentTerms.days === 30 && rp.draft.paymentTerms.source === "original_invoice" && rp.draft.paymentTerms.sourceLabel === "Original invoice terms");
    ck("RI13. The original PO number is inherited (PO-77) and the draft has no PO / terms blocker", rp.draft.po.number === "PO-77" && rp.draft.po.required === true && !rp.review.blockers.some((b: any) => ["po_missing", "payment_terms_missing"].includes(b.code)));
    const rf = await refresh(rp.draft.draftId);
    ck("RI12b. A refresh of the replacement keeps the inherited 30 days (never silently re-read as 14)", rf.body.draft.paymentTerms.days === 30 && rf.body.draft.paymentTerms.source === "original_invoice");
    const d21 = await details(rp.draft.draftId, '{"paymentTermsDays":21,"reason":"Agreed 21 days for the corrected invoice"}');
    const ev = world.audit.find((e) => e.event_type === "finance_invoice_draft.payment_terms_changed");
    ck("RI15. Management may deliberately change the terms in review: 21 days (set on this invoice), audited before -> after with the reason", d21.body.draft.paymentTerms.days === 21 && d21.body.draft.paymentTerms.source === "invoice_override" && ev && ev.before.paymentTermsDays === 30 && ev.before.paymentTermsSource === "original_invoice" && ev.after.paymentTermsDays === 21 && ev.reason === "Agreed 21 days for the corrected invoice");
    const back = await details(rp.draft.draftId, '{"paymentTermsDays":null}');
    ck("RI15b. Resetting a replacement's terms (null) goes back to the ORIGINAL invoice's 30 days - never the client's 14", back.body.draft.paymentTerms.days === 30 && back.body.draft.paymentTerms.source === "original_invoice");
    const d21b = await details(rp.draft.draftId, '{"paymentTermsDays":21,"reason":"Agreed 21 days"}');
    const rr = await ready(rp.draft.draftId, d21b.body.draft.revision);
    const ri = await issue(rp.draft.draftId, rr.body.draft.revision);
    ck("RI16. The replacement invoice snapshots the final reviewed value: 21 days, due = invoice date + 21, PO-77", ri.httpStatus === 201 && ri.body.invoice.paymentTerms.days === 21 && ri.body.invoice.paymentTerms.source === "invoice_override" && ri.body.invoice.dueDate === addDays(ri.body.invoice.invoiceDate, 21) && ri.body.invoice.po.number === "PO-77");
    const origNow = (await readInv(orig.invoiceId)).body.invoice;
    const rowNow = { ...invRows()[0].fields };
    const strip = (f: Record<string, unknown>) => JSON.stringify({ ...f, Status: undefined, Revision: undefined, "Last Changed By User ID": undefined, "Last Changed At": undefined });
    ck("RI17. The original invoice is unchanged (terms 30 / client, PO-77, totals, dates; only its credit state moved)", origNow.paymentTerms.days === 30 && origNow.paymentTerms.source === "client" && origNow.po.number === "PO-77" && origNow.totals.gross === orig.totals.gross && origNow.dueDate === orig.dueDate && strip(rowNow) === strip(JSON.parse(origRow)));
  }
  {
    // PO override context: original had no PO number but an override reason; the client later stops requiring a PO
    const ids = await seed();
    const aft = addOcc(S.after, "2026-09-10");
    const d = (await create(ids.parkside)).body;
    const x = await details(d.draft.draftId, '{"poOverrideReason":"School confirmed no PO for September"}');
    const rdy = (await ready(d.draft.draftId, x.body.draft.revision)).body;
    const orig = (await issue(rdy.draft.draftId, rdy.draft.revision)).body.invoice;
    await W({ route: "client.update", clientId: ids.parkside, patch: { poRequired: false, paymentTermsDaysOverride: 14 }, reason: "trust pays now" });
    const cn = (await credit(orig.invoiceId, null, "Wrong")).body.creditNote;
    await ovCreate(aft, '{"override":{"kind":"quantity","quantity":20},"reason":"register shows 20"}');
    const rp = (await replace(cn.creditNoteId)).body;
    ck("RI14. PO override context is preserved: PO required (as on the original), no number, the original override reason kept; terms still 30", rp.draft.po.required === true && rp.draft.po.number === null && rp.draft.po.overrideReason === "School confirmed no PO for September" && rp.draft.paymentTerms.days === 30 && !rp.review.blockers.some((b: any) => b.code === "po_missing") && rp.review.warnings.some((w: any) => w.code === "po_override_recorded"));
  }

  // ===== XA. Xero authority = Awaiting external issue, NOT Issued (F6 final correction) =====
  {
    // 1. Hub authority: Ready -> Issued, official number, issue + due date established
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-11");
    const rh = await readyDraft(ids.parkside, "2026-09-10", "2026-09-10");
    world.audit = [];
    const h = await issue(rh.draft.draftId, rh.draft.revision);
    const hi = h.body.invoice;
    ck("XA1. Hub authority: Ready -> Issued now - official Hub number, invoice date + due date (terms), Issued At = frozen at, a receivable, issued in the Hub", h.httpStatus === 201 && h.body.outcome === "issued" && hi.status === "issued" && hi.statusLabel === "Issued" && hi.numbering.officialNumber === "INV-1001" && hi.invoiceDate === "2026-09-29" && hi.dueDate === "2026-10-29" && hi.issuedAt === hi.frozenAt && hi.issuedBy === hi.frozenBy && hi.receivable === true && hi.issueAuthority === "hub" && world.audit.map((e) => e.event_type).join(",") === "finance_invoice.issued,finance_invoice_draft.issued");

    // 2. Xero authority: Ready -> Awaiting external issue
    setSettings({ invoiceNumberAuthority: "xero", invoiceNumberNext: 1002 });
    const rx = await readyDraft(ids.parkside, "2026-09-11", "2026-09-11");
    world.audit = [];
    calls = [];
    const x = await issue(rx.draft.draftId, rx.draft.revision, mgr, "Send to Xero");
    const xi = x.body.invoice;
    const row = invRows()[1].fields;
    ck("XA2. Xero authority: Ready -> Awaiting external issue (201 outcome prepared_for_external_issue) - an FIV, no official number, no external id / number", x.httpStatus === 201 && x.body.outcome === "prepared_for_external_issue" && xi.status === "awaiting_external_issue" && xi.statusLabel === "Awaiting external issue" && /^FIV-[0-9A-F]{12}$/.test(xi.invoiceId) && xi.numbering.authority === "xero" && xi.numbering.officialNumber === null && xi.numbering.status === "pending_external" && xi.external.invoiceId === null && xi.external.invoiceNumber === null && xi.external.provider === null);
    ck("XA2b. ... and it is NOT represented as issued: no invoice date, no due date, no Issued At / By, not a receivable, issue authority = external accounting (Xero); only the Hub's frozen-at time", xi.invoiceDate === null && xi.dueDate === null && xi.issuedAt === null && xi.issuedBy === null && xi.receivable === false && xi.issueAuthority === "external_accounting" && xi.frozenAt === "2026-09-29T12:00:00.000Z" && xi.frozenBy === mgr.userId && xi.paymentTerms.days === 30);
    ck("XA2c. Stored row: Status 'Awaiting external issue', Issue Authority 'External accounting', Frozen At / By set; no Invoice Date / Due Date / Issued At / Issued By / external id or number", row.Status === "Awaiting external issue" && row["Issue Authority"] === "External accounting" && row["Frozen At"] === xi.frozenAt && row["Frozen By User ID"] === mgr.userId && !("Invoice Date" in row) && !("Due Date" in row) && !("Issued At" in row) && !("Issued By User ID" in row) && !("External Invoice ID" in row) && !("External Invoice Number" in row));
    ck("XA2d. Audit tells the truth: finance_invoice.prepared_for_external_issue + finance_invoice_draft.prepared_for_external_issue - never finance_invoice.issued", world.audit.map((e) => e.event_type).join(",") === "finance_invoice.prepared_for_external_issue,finance_invoice_draft.prepared_for_external_issue" && world.audit[0].after.invoice.status === "awaiting_external_issue" && world.audit[0].after.invoice.invoiceDate === null && world.audit[0].after.invoice.issuedAt === null && world.audit[0].context.numbering.authority === "xero" && world.audit[1].context.invoiceStatus === "awaiting_external_issue" && world.audit[0].reason === "Send to Xero");
    ck("XA2e. Hub numbering untouched by a Xero preparation (next stays 1002; Settings never written)", nextNumber() === 1002 && !airtableWrites().some((c) => tableOfCall(c) === "Finance Settings"));

    // 3. The awaiting package is frozen and claimed
    const before = stripVolatile((await readInv(xi.invoiceId)).body);
    const dup = await issue(rx.draft.draftId, rx.draft.revision);
    const ro = await reopen(rx.draft.draftId);
    const nd = await create(ids.parkside, "2026-09-11", "2026-09-11");
    const el = await elig(ids.parkside, "2026-09-11", "2026-09-11");
    ck("XA3. Duplicate prevention: the same draft cannot be issued / prepared again (409 draft_already_issued) and the F5 draft cannot change (409 draft_issued)", dup.code === "draft_already_issued" && ro.code === "draft_issued" && invRows().length === 2);
    ck("XA3b. Source claims protected while awaiting: the occurrence shows as claimed and no new draft can take it (409 no_eligible_work)", nd.code === "no_eligible_work" && el.body.summary.alreadyClaimed === 1 && el.body.summary.available.occurrences === 0);
    ck("XA3c. Lines frozen: the awaiting invoice reads back identically (no F4 re-run)", stripVolatile((await readInv(xi.invoiceId)).body) === before && (await readInv(xi.invoiceId)).body.lines.length === 1);

    // 4. Credit / correction refused while awaiting external issue
    world.audit = [];
    calls = [];
    const c1 = await credit(xi.invoiceId);
    const c2 = await credit(xi.invoiceId, [(await readInv(xi.invoiceId)).body.lines[0].lineId]);
    ck("XA4. A credit note against an invoice awaiting external issue is refused cleanly (409 invoice_not_issued) - nothing written, no audit", c1.httpStatus === 409 && c1.code === "invoice_not_issued" && c2.code === "invoice_not_issued" && cnRows().length === 0 && airtableWrites().length === 0 && world.audit.length === 0 && (await readInv(xi.invoiceId)).body.invoice.status === "awaiting_external_issue");
    // The Hub-issued invoice can still be credited normally
    const hc = await credit(hi.invoiceId);
    ck("XA4b. ... while a genuinely Issued (Hub) invoice is still credited normally (201, credited)", hc.httpStatus === 201 && hc.body.invoice.status === "credited");

    // 5. Legacy TEST shape: a credit note made under the superseded semantics on a Xero-bound package
    Object.assign(invRows()[0].fields, { Status: "Awaiting external issue", "Issue Authority": "External accounting", "Invoice Number Authority": "Xero" });
    for (const k of ["Invoice Date", "Due Date", "Issued At", "Issued By User ID", "Hub Invoice Number", "Hub Invoice Sequence", "Payment Details Snapshot", "Branding Snapshot"]) delete invRows()[0].fields[k];
    const legacy = await readInv(hi.invoiceId);
    const rp = await replace(hc.body.creditNote.creditNoteId);
    ck("XA5. A migrated legacy Xero-bound invoice (credit note from before this correction) reads as Awaiting external issue with its credit history, not issued / numbered", legacy.httpStatus === 200 && legacy.body.invoice.status === "awaiting_external_issue" && legacy.body.invoice.numbering.officialNumber === null && legacy.body.invoice.invoiceDate === null && legacy.body.invoice.receivable === false && legacy.body.creditNotes.length === 1 && legacy.body.history[0].event === "prepared_for_external_issue" && !legacy.body.history.some((e: any) => e.event === "issued"));
    ck("XA5b. ... and no correction (replacement draft) can start from it (409 invoice_not_issued)", rp.httpStatus === 409 && rp.code === "invoice_not_issued");

    // 6. Strict storage: no false Xero issue fact can be stored
    const bads: [string, Record<string, unknown>][] = [
      ["awaiting with an invoice date", { "Invoice Date": "2026-09-29", "Due Date": "2026-10-29" }],
      ["awaiting with Issued At", { "Issued At": "2026-09-29T10:00:00.000Z", "Issued By User ID": "u" }],
      ["awaiting with an external number", { "External Invoice ID": "g", "External Invoice Number": "INV-7" }],
      ["issued Xero-numbered without Xero's id / number", { Status: "Issued", "Invoice Date": "2026-09-29", "Due Date": "2026-10-29", "Issued At": "2026-09-29T10:00:00.000Z", "Issued By User ID": "u" }],
      ["issued (Xero id + number present) but no issue date / Issued At", { Status: "Issued", "External Invoice ID": "g", "External Invoice Number": "INV-7" }],
      ["Xero-numbered but issued in the Hub", { "Issue Authority": "Hub" }],
      ["no Frozen At", { "Frozen At": null }],
    ];
    const snap = { ...invRows()[1].fields };
    const res: string[] = [];
    for (const [name, patch] of bads) {
      invRows()[1].fields = { ...snap, ...patch };
      const rr = await readInv(xi.invoiceId);
      if (rr.code !== "invoice_data_invalid") res.push(name);
    }
    invRows()[1].fields = snap;
    ck("XA6. Stored data is strict: an awaiting invoice carrying an issue / due date, Issued At or an external number, an 'Issued' Xero invoice without Xero's id + number, a Hub issue authority on a Xero invoice, or a missing Frozen At -> 409 invoice_data_invalid", res.length === 0, res.join("; "));

    // 7. Reads: list + history + View access
    const li = (await listInvoices(deps, viewer, ids.parkside)) as any;
    const mine = li.body.invoices.find((i: any) => i.invoiceId === xi.invoiceId);
    const hist = (await readInv(xi.invoiceId, viewer)).body.history;
    ck("XA7. List + history (View access): status awaiting_external_issue, receivable false, no invoice / due date; history says prepared_for_external_issue (no 'issued')", li.httpStatus === 200 && mine.status === "awaiting_external_issue" && mine.receivable === false && mine.invoiceDate === null && mine.dueDate === null && mine.frozenAt === xi.frozenAt && hist.length === 1 && hist[0].event === "prepared_for_external_issue" && hist[0].at === xi.frozenAt);
    const vi = await credit(xi.invoiceId, null, "x", viewer);
    ck("XA7b. Access unchanged: View cannot credit (403 finance_manage_required before any state check)", vi.code === "finance_manage_required");
  }

  // ===== AU. Audit =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    world.audit = [];
    const r = await issue(rd.draft.draftId, rd.draft.revision, mgr, "Approved by DE");
    const [a, b] = world.audit;
    const invId = r.body.invoice.invoiceId;
    ck("AU1. Issue -> exactly 2 events: finance_invoice.issued (invoice + every line, before null) and finance_invoice_draft.issued (draft before/after)", world.audit.length === 2 && a.event_type === "finance_invoice.issued" && a.entity_type === "finance_invoice" && a.record_id === invId && a.before === null && a.after.lines.length === 2 && a.after.invoice.grossMinor === 22200 && a.reason === "Approved by DE" && a.context.contract === "finance-invoices-v1" && a.context.route === `POST /invoice-drafts/${rd.draft.draftId}/issue` && a.context.sourceDraftId === rd.draft.draftId && b.event_type === "finance_invoice_draft.issued" && b.entity_type === "finance_invoice_draft" && b.record_id === rd.draft.draftId && b.before.issuedInvoiceId === null && b.after.issuedInvoiceId === invId && a.organisation_id === ORG && a.actor_user_id === MGR);
    world.audit = [];
    const c = await credit(invId, [r.body.lines[0].lineId], "Wrong date");
    ck("AU2. Credit note -> exactly 2 events: finance_credit_note.created + finance_invoice.partially_credited (state change)", world.audit.length === 2 && world.audit[0].event_type === "finance_credit_note.created" && world.audit[0].entity_type === "finance_credit_note" && world.audit[0].record_id === c.body.creditNote.creditNoteId && world.audit[0].after.grossMinor === 16200 && world.audit[1].event_type === "finance_invoice.partially_credited" && world.audit[1].before.status === "issued" && world.audit[1].after.status === "partially_credited");
    world.audit = [];
    const rp = await replace(c.body.creditNote.creditNoteId);
    ck("AU3. Replacement draft -> exactly 2 events: finance_invoice.correction_initiated (on the original) + finance_invoice_draft.created (with the correction links)", world.audit.length === 2 && world.audit[0].event_type === "finance_invoice.correction_initiated" && world.audit[0].record_id === invId && world.audit[0].after.replacementDraftId === rp.body.draft.draftId && world.audit[1].event_type === "finance_invoice_draft.created" && world.audit[1].context.replacesInvoiceId === invId);
    const rev = (await details(rp.body.draft.draftId, '{"poNumber":"PO-R"}')).body.draft.revision;
    const rr = (await ready(rp.body.draft.draftId, rev)).body;
    world.audit = [];
    const ri = await issue(rr.draft.draftId, rr.draft.revision);
    ck("AU4. Replacement issue -> 3 events, incl. finance_invoice.replacement_linked on the ORIGINAL invoice", world.audit.length === 3 && world.audit.map((x) => x.event_type).join() === "finance_invoice.issued,finance_invoice_draft.issued,finance_invoice.replacement_linked" && world.audit[2].record_id === invId && world.audit[2].after.replacementInvoiceId === ri.body.invoice.invoiceId);
    world.audit = [];
    await readInv(invId);
    await listInvoices(deps, mgr, ids.parkside);
    await readCreditNote(deps, mgr, c.body.creditNote.creditNoteId);
    await issue(rr.draft.draftId, rr.draft.revision);
    await credit(invId, [r.body.lines[0].lineId]);
    await replace(c.body.creditNote.creditNoteId);
    ck("AU5. Reads, rejected and duplicate requests write no audit events", world.audit.length === 0);
  }
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    const rd = await readyDraft(ids.parkside);
    const draftBefore = JSON.stringify(draftRows());
    world.auditStatus = 500;
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    world.auditStatus = undefined;
    ck("AU6. Audit failure -> 503 finance_audit_unavailable and the whole issue is undone (no invoice, no lines, draft restored)", r.code === "finance_audit_unavailable" && invRows().length === 0 && invLineRows().length === 0 && JSON.stringify(draftRows().map((x) => ({ ...x.fields, "Last Changed At": 0, "Last Changed By User ID": 0 }))) === JSON.stringify(JSON.parse(draftBefore).map((x: any) => ({ ...x.fields, "Last Changed At": 0, "Last Changed By User ID": 0 }))) && !draftRows()[0].fields["Issued Invoice ID"] && draftRows()[0].fields.Revision === rd.draft.revision);
    world.failCreateOn = ISSUE_TABLES.lines;
    const r2 = await issue(rd.draft.draftId, rd.draft.revision);
    world.failCreateOn = undefined;
    ck("AU7. A failed line write -> 503; the invoice row already written is removed; draft untouched", r2.code === "finance_invoices_unavailable" && invRows().length === 0 && invLineRows().length === 0 && !draftRows()[0].fields["Issued Invoice ID"]);
    world.auditStatus = 500;
    world.undoStatus = 500;
    const r3 = await issue(rd.draft.draftId, rd.draft.revision);
    world.auditStatus = undefined;
    world.undoStatus = undefined;
    ck("AU8. If the undo also fails the caller gets 500 finance_invoices_unaudited (never success)", r3.httpStatus === 500 && r3.code === "finance_invoices_unaudited");
    const ids2 = await seed();
    addOcc(S.ppa, "2026-09-10");
    const rd2 = await readyDraft(ids2.parkside);
    const inv = (await issue(rd2.draft.draftId, rd2.draft.revision)).body.invoice;
    const before = JSON.stringify(invRows());
    world.auditStatus = 500;
    const c = await credit(inv.invoiceId);
    world.auditStatus = undefined;
    ck("AU9. A credit note whose audit fails is undone: no credit note row, invoice state restored", c.code === "finance_audit_unavailable" && cnRows().length === 0 && JSON.stringify(invRows()) === before);
  }

  // ===== PF. Bounded reads / batched writes =====
  {
    const ids = await seed();
    for (let day = 1; day <= 28; day++) {
      const dd = `2026-09-${String(day).padStart(2, "0")}`;
      addOcc(S.ppa, dd);
      addOcc(S.after, dd);
    }
    const rd = await readyDraft(ids.parkside);
    calls = [];
    const r = await issue(rd.draft.draftId, rd.draft.revision);
    const reads = airtableGets().length;
    const posts = airtableWrites().filter((c) => c.method === "POST");
    ck("PF1. Issuing 56 lines: a fixed number of reads (no per-line / per-occurrence reads); lines written in batches of 10", r.httpStatus === 201 && r.body.lines.length === 56 && reads <= 22 && posts.filter((c) => tableOfCall(c) === ISSUE_TABLES.lines).length === 6 && posts.every((c) => (c.body?.records?.length ?? 0) <= 10), `reads=${reads}`);
    calls = [];
    await readInv(r.body.invoice.invoiceId);
    const r2 = airtableGets().length;
    ck("PF2. Reading a 56-line invoice is a fixed number of reads (invoice, lines, credit notes, links + auth config)", r2 <= 8 && !airtableGets().some((c) => /\/rec[A-Za-z0-9]{14}$/.test(new URL(c.url).pathname)), `reads=${r2}`);
  }

  // ===== RT. Routes + parsing =====
  {
    const m = (p: string, meth: string) => matchIssueRoute(p, meth) as any;
    const I = "FIV-0123456789AB";
    const C = "FCN-0123456789AB";
    ck("RT1. Routes: issue / list / read / credit notes (GET+POST) / credit note / replacement draft", m("invoice-drafts/FID-0123456789AB/issue", "POST").route.name === "draft.issue" && m("invoices", "GET").route.name === "invoices.list" && m(`invoices/${I}`, "GET").route.name === "invoice.read" && m(`invoices/${I}/credit-notes`, "GET").route.name === "invoice.credit_notes" && m(`invoices/${I}/credit-notes`, "POST").route.name === "invoice.credit_note_create" && m(`credit-notes/${C}`, "GET").route.name === "credit_note.read" && m(`credit-notes/${C}/replacement-draft`, "POST").route.name === "credit_note.replacement");
    ck("RT2. Wrong method 405; malformed ids 404; every other invoice-drafts path stays F5's (null)", m("invoice-drafts/FID-0123456789AB/issue", "GET").status === "method" && m("invoices", "POST").status === "method" && m(`invoices/${I}`, "POST").status === "method" && m("invoices/FIV-bad", "GET").status === "not_found" && m("credit-notes/FIV-0123456789AB", "GET").status === "not_found" && m("invoice-drafts/FID-bad/issue", "POST").status === "not_found" && m("invoice-drafts/FID-0123456789AB/refresh", "POST") === null && m("invoice-drafts", "GET") === null && m("clients", "GET") === null);
    ck("RT3. No send / pay / overdue / PDF / external-sync / number routes exist", ["send", "pay", "paid", "overdue", "pdf", "xero", "sync", "number", "void", "email"].every((x) => m(`invoices/${I}/${x}`, "POST").status === "not_found" && m(`credit-notes/${C}/${x}`, "POST").status === "not_found"));
    ck("RT4. Issue body: revision required (whole number >= 1); optional reason; unknown fields rejected", (parseIssue("{}", isTenantKey) as any).fields.revision && (parseIssue('{"revision":0}', isTenantKey) as any).fields.revision && (parseIssue('{"revision":3,"reason":"ok"}', isTenantKey) as any).revision === 3 && (parseIssue('{"revision":3,"number":"INV-1"}', isTenantKey) as any).code === "unexpected_field" && (parseIssue("", isTenantKey) as any).code === "invalid_body");
    ck("RT5. Credit note body: reason required; lineIds optional, FVL- ids only, no repeats; amount fields not accepted", (parseCreditNote("{}", isTenantKey) as any).fields.reason === "is required" && (parseCreditNote('{"reason":"x"}', isTenantKey) as any).lineIds === null && (parseCreditNote('{"reason":"x","lineIds":["FIL-0123456789AB"]}', isTenantKey) as any).fields.lineIds && (parseCreditNote('{"reason":"x","lineIds":["FVL-0123456789AB","FVL-0123456789AB"]}', isTenantKey) as any).fields.lineIds && (parseCreditNote('{"reason":"x","lineIds":[]}', isTenantKey) as any).fields.lineIds && (parseCreditNote('{"reason":"x","amount":"10.00"}', isTenantKey) as any).code === "unexpected_field");
    ck("RT6. Replacement body needs a reason; invoice list needs clientId once", (parseReplacement("{}", isTenantKey) as any).fields.reason === "is required" && (checkInvoiceListQuery(new URLSearchParams(""), isTenantKey) as any).code === "invalid_input" && (checkInvoiceListQuery(new URLSearchParams("clientId=FCL-AAAAAAAAAAAA"), isTenantKey) as any).clientId === "FCL-AAAAAAAAAAAA");
  }

  // ===== Z. Code / drift =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const F6 = ["finance-issue.ts", "finance-issue-mapping.ts", "finance-issue-repository.ts", "finance-issue-orchestrator.ts"];
    const all = F6.map((f) => noComments(code(f))).join("\n");
    ck("Z1. Domain + mapping are pure (no fetch / Deno / Supabase / Airtable URLs)", ["finance-issue.ts", "finance-issue-mapping.ts"].every((f) => !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(code(f))));
    ck("Z2. No payment / overdue / sending / PDF / Xero or Stripe integration / Needs Attention code in F6 (\"xero\" is only a Settings authority value)", !/api\.xero|xero\.com|xeroClient|stripe|sendEmail|paidAt|overdue|pdf|refund|needs_attention|needsAttention|amountPaid|paymentReceived/i.test(all));
    const orchSrc = noComments(code("finance-issue-orchestrator.ts"));
    ck("Z3. Official numbers come ONLY from the organisation's Finance Settings (no hard-coded prefix, no platform-wide counter); the only sequence write is that Settings row's next number", !/INV-|autoNumber|counter|globalSequence/i.test(all) && /invoiceNumberPlan\(cw\.settings\)/.test(orchSrc) && (orchSrc.match(/SETTINGS_FIELDS\.invoiceNumberNext/g) || []).length === 2 && /txn\.patch\(SETTINGS_TABLE/.test(orchSrc));
    const orch = code("finance-issue-orchestrator.ts");
    ck("Z4. Reads + writes authorise via F1 authorizeFinance (read + manage); no new auth path", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && !/createClient|profiles/.test(orch));
    ck("Z5. The shared Finance write lock and a single audit insert are reused", /acquireWriteLock\(deps\.grants, lockKey\(org\)\)/.test(orch) && (orch.match(/insertAuditEvents\(/g) || []).length === 1 && /`commercial:\$\{o\.organisationId\}`/.test(orch));
    ck("Z6. Immutability: invoice lines + credit notes are never patched; the invoice row is only ever patched with invoiceStateFields", !/txn\.patch\(ISSUE_TABLES\.(lines|creditNotes)/.test(orch) && (orch.match(/txn\.patch\(ISSUE_TABLES\.invoices/g) || []).length === 1 && /txn\.patch\(ISSUE_TABLES\.invoices, \[\{ id: l\.invoice\.recordId, fields: invoiceStateFields\(after\), restore: invoiceStateFields\(inv\) \}\]\)/.test(orch) && !/txn\.(create|patch)\(BILLING_TABLES|txn\.(create|patch)\(TABLES/.test(orch));
    const readFn = orch.slice(orch.indexOf("export async function readInvoice"), orch.indexOf("export async function listInvoiceCreditNotes"));
    ck("Z7. The invoice read never re-runs F4 or the draft work (no loadClientWork / resolveOccurrenceBilling on the read path)", readFn.length > 100 && !/loadClientWork|resolveOccurrenceBilling|loadWorld/.test(readFn) && !/loadClientWork/.test(orch.slice(orch.indexOf("function loadInvoice"), orch.indexOf("function invoiceBody"))));
    const idx = code("index.ts");
    ck("Z8. index.ts routes F6 before F5 and keeps F1-F5 routes", /matchIssueRoute\(route, req\.method\)/.test(idx) && idx.indexOf("matchIssueRoute(route") < idx.indexOf("matchInvoicingRoute(route") && /matchBillingRoute\(decoded/.test(idx) && /matchCommercialRoute\(route/.test(idx) && /"write-check"/.test(idx));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z9. Test copies match the canonical finance files (only import paths swapped)", copy("finance-issue.ts") && copy("finance-issue-mapping.ts") && copy("finance-issue-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-issue-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]) && copy("finance-invoicing.ts") && copy("finance-invoicing-mapping.ts") && copy("finance-invoicing-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    ck("Z10. No Josh Evans naming in F6 code", !/josh|evans/i.test(F6.map(code).join("\n")));
  }

  for (const [s, n, x] of R) console.log(`${s}  ${n}${x ? `  (${x})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
