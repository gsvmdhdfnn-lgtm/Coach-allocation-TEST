/**
 * Finance Foundation F5 - client invoice draft + review.
 * Run: node --experimental-strip-types tests/support/finance-invoicing.test.ts
 *
 *   EL  eligibility (delivered + confirmed + billable + client-paid + calculable + unclaimed; every other outcome named, never £0)
 *   BM  F3 billing method (the one additive client field F5 needed)
 *   GR  client grouping (several services on one draft, clients never mixed, inactive client, ended service history, manual billing)
 *   SN  line snapshots (terms on the occurrence date, later terms change never rewrites a line)
 *   PP  per-player quantity (default and F4 override)
 *   VT  VAT (plus / included / none) and totals reconciliation
 *   DU  duplicate / claim protection (second create, concurrent create, claims across drafts, review detection)
 *   EX  exclude / restore
 *   NB  mark not billable delegates to F4
 *   PO  PO requirement, number, override
 *   PT  payment terms snapshot (client, Finance Settings default, invoice override, revert)
 *   RF  refresh (source changed blocks; refresh supersedes / removes / adds; no-op)
 *   ST  states (Ready freezes, revision check, reopen)
 *   AC  access + tenant
 *   AU  audit (exact events, none on reads / rejected / no-op, rollback, undo failure, lock)
 *   PF  bounded reads (no per-occurrence / per-line reads)
 *   RT  routes + request parsing
 *   Z   code / drift checks against the canonical finance files
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, toStoredFields } from "./finance-settings.ts";
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
import { checkInvoicingQuery, formatDay, matchInvoicingRoute, parseDetails, parseDraftCreate, parseReady, parseReasonBody } from "./finance-invoicing.ts";
import { INVOICING_TABLES, buildDrafts, buildLines } from "./finance-invoicing-mapping.ts";
import { WRITE_BATCH } from "./finance-invoicing-repository.ts";
import { type DraftWrite, listClientDrafts, markLineNotBillable, readDraft, readEligibleWork, writeDraft } from "./finance-invoicing-orchestrator.ts";

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

const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7 };
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
    },
    audit: [],
    lockHeld: null,
    lockMode: "ok",
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

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== EL. Eligibility =====
  {
    const ids = await seed();
    const ok1 = addOcc(S.ppa, "2026-09-10");
    const ok2 = addOcc(S.ppa, "2026-09-11", { status: "Completed" });
    const exc = addOcc(S.ppa, "2026-09-12", { status: "Completed", conf: "Exception Recorded", exception: "Weather" });
    const awaiting = addOcc(S.ppa, "2026-09-15", { conf: "Awaiting Confirmation" });
    const blank = addOcc(S.ppa, "2026-09-16", { conf: null });
    const unresolved = addOcc(S.ppa, "2026-09-17", { conf: "Exception Recorded", exception: "Weather" });
    const cancelled = addOcc(S.ppa, "2026-09-18", { status: "Cancelled" });
    const postponed = addOcc(S.ppa, "2026-09-19", { status: "Postponed" });
    const future = addOcc(S.ppa, "2026-09-30", { conf: null });
    const nb = addOcc(S.ppa, "2026-09-22");
    const parent = addOcc(S.camp, "2026-09-17");
    const outside = addOcc(S.ppa, "2026-10-01");
    const noSvc = addOcc(S.none, "2026-09-10");
    await ovCreate(nb, '{"override":{"kind":"not_billable"},"reason":"Goodwill"}');
    calls = [];
    world.audit = [];
    const e = (await elig(ids.parkside)).body;
    const avail = e.available.map((x: any) => x.occurrenceId);
    ck("EL1. Delivered + confirmed (Scheduled-past or Completed) + billable client-paid work is available", avail.includes(ok1) && avail.includes(ok2) && e.available.find((x: any) => x.occurrenceId === ok1).value.gross === "60.00");
    ck("EL2. Exception Recorded + Completed (delivered with a change) is available, as F4 says", avail.includes(exc));
    ck("EL3. Awaiting / blank confirmation and unresolved exceptions are pending, never available", [awaiting, blank, unresolved].every((o) => e.pending.some((x: any) => x.occurrenceId === o)) && ![awaiting, blank, unresolved].some((o) => avail.includes(o)));
    ck("EL4. Cancelled, postponed, not-yet-delivered and F4 not-billable are named as not invoiceable", [cancelled, postponed, future, nb].every((o) => e.notInvoiceable.some((x: any) => x.occurrenceId === o && x.value === null && x.reason)));
    ck("EL5. Parent-paid work is deferred (named), never on a client invoice", e.notInvoiceable.some((x: any) => x.occurrenceId === parent && x.outcome === "deferred_revenue_model") && !avail.includes(parent));
    ck("EL6. Work outside the period and Sessions with no Finance Service are not this client's work", ![outside, noSvc].some((o) => JSON.stringify(e).includes(o)));
    ck("EL7. Summary: exact counts; only available work is summed as money", e.summary.available.occurrences === 3 && e.summary.available.gross === "180.00" && e.summary.awaitingConfirmation === 3 && e.summary.notInvoiceable === 5 && e.summary.setupProblems === 0);
    ck("EL8. Reading eligible work never writes and never audits", airtableWrites().length === 0 && world.audit.length === 0);
    // Broken setup: terms missing -> a setup problem (blocker), never a £0 line
    const terms = world.tables[TABLES.terms].find((t) => t.fields["Amount (Minor Units)"] === 6000)!;
    terms.fields["Effective From"] = "2026-09-20";
    const brk = addOcc(S.breakfast, "2026-09-10");
    const e2 = (await elig(ids.parkside)).body;
    ck("EL9. Missing commercial terms on the date is a setup problem, never a £0 amount", e2.setupProblems.some((x: any) => x.occurrenceId === brk && x.outcome === "missing_commercial_terms" && x.value === null) && !e2.available.some((x: any) => x.occurrenceId === brk));
    const d = await create(ids.parkside);
    ck("EL10. The draft has lines only for available work; its review blocks on the unresolved setup", d.httpStatus === 201 && d.body.lines.length === 3 && d.body.lines.every((l: any) => Number(l.gross) > 0) && d.body.review.blockers.some((b: any) => b.code === "unresolved_configuration"));
  }

  // ===== BM. Billing method (F3 addition) =====
  {
    const ids = await seed();
    const row = world.tables[TABLES.clients].find((r) => r.fields["Finance Client ID"] === ids.parkside)!;
    ck("BM1. New clients default to Hub billing; stored as \"Hub billing\"", row.fields["Billing Method"] === "Hub billing" && (clientFromRow(row) as any).stored.value.billingMethod === "hub");
    const blank = { id: row.id, fields: { ...row.fields } };
    delete blank.fields["Billing Method"];
    ck("BM2. A blank stored Billing Method (pre-F5 rows) reads as hub; an unknown label is invalid data, never guessed", (clientFromRow(blank) as any).stored.value.billingMethod === "hub" && (clientFromRow({ id: row.id, fields: { ...row.fields, "Billing Method": "Hub invoice" } }) as any).ok === false);
    const bad = parseClientCreate('{"client":{"name":"x","billingMethod":"xero"}}', isTenantKey) as any;
    const good = parseClientCreate('{"client":{"name":"x","billingMethod":"manual"}}', isTenantKey) as any;
    ck("BM3. billingMethod accepts only hub / manual", bad.fields?.billingMethod === "must be one of hub, manual" && good.ok && good.client.billingMethod === "manual");
    const up = parseClientUpdate('{"client":{"billingMethod":"manual"}}', isTenantKey) as any;
    const res = await W({ route: "client.update", clientId: ids.parkside, patch: up.patch, reason: "billed via the trust" });
    ck("BM4. Changing it is an ordinary audited F3 client update; the public client shows method + label", res.body.client.billingMethod === "manual" && res.body.client.billingMethodLabel === "Manual billing (outside the Hub)" && world.audit[world.audit.length - 1].event_type === "finance_client.updated" && world.audit[world.audit.length - 1].context.changedFields.join() === "billingMethod");
  }

  // ===== GR. Grouping =====
  {
    const ids = await seed();
    const p1 = addOcc(S.ppa, "2026-09-10");
    const a1 = addOcc(S.after, "2026-09-10");
    const b1 = addOcc(S.breakfast, "2026-09-11");
    const s1 = addOcc(S.stannes, "2026-09-10");
    const d = await create(ids.parkside);
    const occs = d.body.lines.map((l: any) => l.occurrenceId).sort();
    ck("GR1. One draft holds every eligible service of the client (PPA + After-school + Breakfast)", d.httpStatus === 201 && occs.join() === [a1, b1, p1].sort().join() && new Set(d.body.lines.map((l: any) => l.serviceId)).size === 3);
    ck("GR2. Clients are never mixed: St Anne's work is not on Parkside's draft", !occs.includes(s1) && d.body.draft.clientId === ids.parkside);
    const d2 = await create(ids.stannes);
    ck("GR3. St Anne's gets its own draft with only its own work", d2.httpStatus === 201 && d2.body.lines.length === 1 && d2.body.lines[0].occurrenceId === s1 && d2.body.draft.clientId === ids.stannes);
    const up = parseClientUpdate('{"client":{"status":"inactive"}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.stannes, patch: up.patch, reason: null });
    addOcc(S.stannes, "2026-09-17");
    await ready(d2.body.draft.draftId, 1);
    const d3 = await create(ids.stannes, "2026-09-12", "2026-09-30");
    ck("GR4. An inactive client's already-delivered work can still be drafted, with a client_inactive warning", d3.httpStatus === 201 && d3.body.review.warnings.some((w: any) => w.code === "client_inactive"));
    // Ended service: work delivered while it was active is still billable
    await W({ route: "service.update", serviceId: ids.breakfast, patch: { status: "ended" }, effectiveFrom: "2026-10-01", reason: "contract ended" });
    NOW = new Date("2026-10-20T12:00:00.000Z");
    const old = addOcc(S.breakfast, "2026-09-24");
    const after = addOcc(S.breakfast, "2026-10-05");
    const e = (await elig(ids.parkside, "2026-09-12", "2026-10-15")).body;
    ck("GR5. Ended service: work delivered before it ended is available; work after it ended is commercially inactive", e.available.some((x: any) => x.occurrenceId === old) && e.notInvoiceable.some((x: any) => x.occurrenceId === after && x.outcome === "commercially_inactive"));
    const man = parseClientUpdate('{"client":{"billingMethod":"manual"}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: man.patch, reason: "billed via the trust" });
    const m = await create(ids.parkside, "2026-09-12", "2026-10-15");
    ck("GR6. Manual Billing clients are not forced through Hub drafting (409 manual_billing_client, nothing written)", m.code === "manual_billing_client" && draftRows().length === 3);
    const mr = (await read(d.body.draft.draftId)).body;
    ck("GR7. A client switched to Manual Billing after drafting blocks its draft", mr.review.blockers.some((b: any) => b.code === "manual_billing_client"));
    const ml = (await elig(ids.parkside, "2026-09-12", "2026-10-15")).body;
    ck("GR8. Manual Billing work still resolves (commercial values stay in Finance reporting); hubBilling false", ml.client.billingMethod === "manual" && ml.client.hubBilling === false && ml.available.length > 0);
  }

  // ===== SN. Snapshots =====
  {
    const ids = await seed();
    await W({ route: "terms.change", serviceId: ids.ppa, req: { effectiveFrom: "2026-10-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: "new price" });
    NOW = new Date("2026-10-20T12:00:00.000Z");
    const sep = addOcc(S.ppa, "2026-09-24");
    const oct = addOcc(S.ppa, "2026-10-08");
    const d = await create(ids.parkside, "2026-09-15", "2026-10-15");
    const ls = lineOf(d.body, sep);
    const lo = lineOf(d.body, oct);
    ck("SN1. Each line uses the terms effective on its own date (Sep £50 + VAT, Oct £55 + VAT)", ls.unitAmount === "50.00" && ls.gross === "60.00" && lo.unitAmount === "55.00" && lo.gross === "66.00" && ls.termsId !== lo.termsId);
    ck("SN2. The line keeps source refs: occurrence, Session, Service, terms, date, description", ls.sessionId === "TEST-PPA" && ls.serviceName === "PPA" && ls.date === "2026-09-24" && ls.description === "24 Sep 2026 — PPA" && /^FCT-/.test(ls.termsId));
    const snap = JSON.parse(lineRows().find((r) => r.fields["Line ID"] === ls.lineId)!.fields["Source Snapshot"]);
    ck("SN3. The stored snapshot records the F4 facts behind the figures (terms, quantity, unit amount, client, resolvedOn)", snap.terms.termsId === ls.termsId && snap.terms.amountMinor === 5000 && snap.quantity.source === "per_session" && snap.client.clientId === ids.parkside && snap.resolvedOn === "2026-10-20" && snap.contract === "finance-billing-v1");
    await W({ route: "terms.change", serviceId: ids.ppa, req: { effectiveFrom: "2026-10-21", changes: { amountMinor: 7000 }, changedKeys: ["amount"] }, reason: "another price" });
    const before = JSON.stringify(lineRows());
    calls = [];
    const auditBefore = world.audit.length;
    const r = (await read(d.body.draft.draftId)).body;
    ck("SN4. A later terms change never rewrites a line (rows untouched; figures unchanged on read)", JSON.stringify(lineRows()) === before && lineOf(r, sep).gross === "60.00" && lineOf(r, oct).gross === "66.00" && r.review.blockers.every((b: any) => b.code !== "source_changed"));
    ck("SN5. Reading a draft never writes and never audits", airtableWrites().length === 0 && world.audit.length === auditBefore);
  }

  // ===== PP. Per-player =====
  {
    const ids = await seed();
    const a = addOcc(S.after, "2026-09-10");
    const b = addOcc(S.after, "2026-09-11");
    await ovCreate(b, '{"override":{"kind":"quantity","quantity":15},"reason":"3 absent"}');
    const d = await create(ids.parkside);
    const la = lineOf(d.body, a);
    const lb = lineOf(d.body, b);
    ck("PP1. Per player at the default quantity: £9 × 18 = £162, no VAT", la.quantity === 18 && la.quantitySource === "default_commercial_quantity" && la.unitAmount === "9.00" && la.net === "162.00" && la.gross === "162.00" && la.description === "10 Sep 2026 — After-school (18 players)");
    ck("PP2. The F4 quantity override is used: £9 × 15 = £135, with its override ref", lb.quantity === 15 && lb.quantitySource === "occurrence_override" && lb.gross === "135.00" && lb.overrideIds.length === 1 && /^FOB-/.test(lb.overrideIds[0]));
    ck("PP3. An overridden line is a review warning (billing_overrides), not a blocker", d.body.review.warnings.some((w: any) => w.code === "billing_overrides" && w.lineIds.includes(lb.lineId)) && !d.body.review.blockers.some((x: any) => x.code === "billing_overrides"));
  }

  // ===== VT. VAT + totals =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    addOcc(S.breakfast, "2026-09-10");
    const d = (await create(ids.parkside)).body;
    const by = (svc: string) => d.lines.find((l: any) => l.serviceName === svc);
    ck("VT1. Plus VAT: £50 -> net 50.00, VAT 10.00, gross 60.00 (20%)", by("PPA").net === "50.00" && by("PPA").vat === "10.00" && by("PPA").gross === "60.00" && by("PPA").vatRatePercent === "20");
    ck("VT2. VAT included: £60 -> net 50.00, VAT 10.00, gross 60.00", by("Breakfast club").net === "50.00" && by("Breakfast club").vat === "10.00" && by("Breakfast club").gross === "60.00" && by("Breakfast club").vatTreatment === "vat_included");
    ck("VT3. No VAT: £162 -> VAT 0.00", by("After-school").vat === "0.00" && by("After-school").vatRatePercent === "0");
    ck("VT4. Draft totals are the exact pence sums and Gross = Net + VAT", d.draft.totals.net === "262.00" && d.draft.totals.vat === "20.00" && d.draft.totals.gross === "282.00" && d.review.totals.reconciles === true && d.draft.totals.includedLines === 3);
    const row = draftRows()[0];
    ck("VT5. Stored totals are integer pence (no floats)", [row.fields["Net (Minor Units)"], row.fields["VAT (Minor Units)"], row.fields["Gross (Minor Units)"]].join() === "26200,2000,28200");
    row.fields["Gross (Minor Units)"] = 28201;
    const r = (await read(d.draft.draftId)).body;
    ck("VT6. Totals that do not reconcile with the lines are a blocker", r.review.blockers.some((b: any) => b.code === "totals_do_not_reconcile"));
    row.fields["Gross (Minor Units)"] = 28200;
  }

  // ===== DU. Duplicates / claims =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.ppa, "2026-09-11");
    const d1 = await create(ids.parkside);
    const again = await create(ids.parkside);
    ck("DU1. A second draft for the same client + period while one is open is refused (409 open_draft_exists), nothing written", again.code === "open_draft_exists" && draftRows().length === 1 && lineRows().length === 2);
    const overlap = await create(ids.parkside, "2026-09-11", "2026-10-15");
    ck("DU2. An overlapping period is also refused while the first draft is open", overlap.code === "open_draft_exists");
    // Concurrent creates for a fresh client/period
    const ids2 = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    const [c1, c2] = await Promise.all([create(ids2.parkside), create(ids2.parkside)]);
    const oks = [c1, c2].filter((x) => x.httpStatus === 201);
    const refused = [c1, c2].filter((x) => x.status === "error");
    ck("DU3. Two concurrent creates: exactly one succeeds, the other is refused; no duplicate lines", oks.length === 1 && refused.length === 1 && ["finance_commercial_busy", "open_draft_exists"].includes(refused[0].code) && draftRows().length === 1 && lineRows().length === 2);
    // Sequential after the lock frees: still refused (open draft), and after Ready: claimed work is not re-drafted
    const d = oks[0].body;
    await details(d.draft.draftId, '{"poNumber":"PO-1"}');
    const rd = await ready(d.draft.draftId, 2);
    const next = await create(ids2.parkside);
    ck("DU4. After the first draft is Ready, a new draft for the period finds no unclaimed work (409 no_eligible_work)", rd.status === "ok" && next.code === "no_eligible_work");
    const e = (await elig(ids2.parkside)).body;
    ck("DU5. Eligible work shows the claimed occurrences with the claiming draft, and none available", e.available.length === 0 && e.claimed.length === 2 && e.claimed.every((x: any) => x.claimedBy.draftId === d.draft.draftId));
    // A forged duplicate claim (bad data) is detected at review
    const row = lineRows()[0];
    lineRows().push({ id: "recForgedLine0001", fields: { ...row.fields, "Line ID": "FIL-FFFFFFFFFFFF", "Draft ID": "FID-EEEEEEEEEEEE" } });
    const r = (await read(d.draft.draftId)).body;
    ck("DU6. An occurrence Included on another draft's line is a duplicate_claim blocker at review", r.review.blockers.some((b: any) => b.code === "duplicate_claim"));
    lineRows().pop();
  }

  // ===== EX. Exclude / restore =====
  {
    const ids = await seed();
    const a = addOcc(S.ppa, "2026-09-10");
    const b = addOcc(S.breakfast, "2026-09-24");
    const d = (await create(ids.parkside)).body;
    const lb = lineOf(d, b);
    world.audit = [];
    const x = await exclude(d.draft.draftId, lb.lineId);
    ck("EX1. Exclude removes the line from THIS invoice (status excluded, reason kept) and totals drop", x.status === "ok" && lineOf(x.body, b, "excluded").statusReason === "School asked to bill it next month" && x.body.draft.totals.gross === "60.00" && x.body.draft.revision === 2);
    ck("EX2. Excluded work stays billable: F4 still eligible, and it appears as available work for the client", (await readOccurrenceBilling(deps, mgr, b) as any).body.billing.outcome === "eligible" && (await elig(ids.parkside)).body.available.some((w: any) => w.occurrenceId === b));
    ck("EX3. Excluding does not touch F3 terms or F4 overrides", world.tables[BILLING_TABLES.overrides].length === 0 && world.audit.every((e: any) => e.entity_type === "finance_invoice_draft"));
    ck("EX4. The exclusion is a review warning (excluded_work), not a blocker", x.body.review.warnings.some((w: any) => w.code === "excluded_work"));
    const again = await exclude(d.draft.draftId, lb.lineId);
    ck("EX5. Excluding an excluded line is a no-op (200 changed:false, no audit)", again.status === "ok" && again.body.changed === false && world.audit.length === 1);
    const rfx = await refresh(d.draft.draftId);
    ck("EX5b. Refresh keeps Management's exclusion: the unclaimed excluded occurrence is not re-added (no-op)", rfx.body.changed === false && !rfx.body.lines.some((l: any) => l.occurrenceId === b && l.status === "included") && world.audit.length === 1);
    const rs = await restore(d.draft.draftId, lb.lineId);
    ck("EX6. Restore puts it back (included, totals back, revision 3)", rs.status === "ok" && lineOf(rs.body, b).status === "included" && rs.body.draft.totals.gross === "120.00" && rs.body.draft.revision === 3);
    await exclude(d.draft.draftId, lb.lineId);
    await details(d.draft.draftId, '{"poNumber":"PO-7"}');
    const rd = await ready(d.draft.draftId, 5);
    const d2 = await create(ids.parkside);
    ck("EX7. Excluded work appears on a LATER draft for the client", rd.status === "ok" && d2.httpStatus === 201 && d2.body.lines.length === 1 && d2.body.lines[0].occurrenceId === b);
    await reopen(d.draft.draftId);
    const back = await restore(d.draft.draftId, lb.lineId);
    ck("EX8. Restoring on the first draft once the later draft claims it is refused (409 occurrence_claimed)", back.code === "occurrence_claimed");
    ck("EX9. Refresh never re-adds an occurrence Management excluded from this draft", (await refresh(d.draft.draftId)).body.lines.filter((l: any) => l.occurrenceId === b && l.status === "included").length === 0);
    void a;
  }

  // ===== NB. Not billable delegates to F4 =====
  {
    const ids = await seed();
    const a = addOcc(S.after, "2026-09-10");
    addOcc(S.after, "2026-09-11");
    const d = (await create(ids.parkside)).body;
    const la = lineOf(d, a);
    world.audit = [];
    const n = await notBillable(d.draft.draftId, la.lineId);
    const ov = world.tables[BILLING_TABLES.overrides];
    ck("NB1. Mark not billable records an F4 not_billable override (the F4 table), not a draft-only flag", n.status === "ok" && ov.length === 1 && ov[0].fields.Kind === "Not billable" && ov[0].fields["Occurrence ID"] === a && /^FOB-/.test(n.body.override.overrideId));
    ck("NB2. F4 now says not billable for the occurrence", (await readOccurrenceBilling(deps, mgr, a) as any).body.billing.outcome === "not_billable");
    ck("NB3. The line is removed from the draft with the F4 reference; totals drop", lineOf(n.body, a, "removed").statusReason.startsWith(`Marked not billable (${n.body.override.overrideId})`) && n.body.draft.totals.gross === "162.00");
    ck("NB4. Audit: F4's own override event + one draft event (line_marked_not_billable)", codes(world.audit.map((e: any) => ({ code: e.event_type }))) === "finance_invoice_draft.line_marked_not_billable,finance_occurrence_billing_override.created");
    const e = (await elig(ids.parkside)).body;
    ck("NB5. A not-billable occurrence is never offered again", !e.available.some((w: any) => w.occurrenceId === a) && e.notInvoiceable.some((w: any) => w.occurrenceId === a && w.outcome === "not_billable"));
    // Already not billable in F4 with a different reason -> uses the existing decision
    const ids2 = await seed();
    const b = addOcc(S.ppa, "2026-09-10");
    addOcc(S.ppa, "2026-09-11");
    const d2 = (await create(ids2.parkside)).body;
    await ovCreate(b, '{"override":{"kind":"not_billable"},"reason":"Earlier decision"}');
    const n2 = await notBillable(d2.draft.draftId, lineOf(d2, b).lineId, "Another reason");
    ck("NB6. An existing F4 not-billable decision is reused (never overwritten); the line is removed", n2.status === "ok" && world.tables[BILLING_TABLES.overrides].length === 1 && lineOf(n2.body, b, "removed") !== undefined);
    await details(d2.draft.draftId, '{"poNumber":"PO-9"}');
    const rev = (await read(d2.draft.draftId)).body.draft.revision;
    await ready(d2.draft.draftId, rev);
    const frozen = await notBillable(d2.draft.draftId, d2.lines.find((l: any) => l.occurrenceId !== b).lineId);
    ck("NB7. On a Ready draft the convenience refuses BEFORE touching F4 (409 draft_not_open, no new override)", frozen.code === "draft_not_open" && world.tables[BILLING_TABLES.overrides].length === 1);
  }

  // ===== PO =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const d = (await create(ids.parkside)).body;
    ck("PO1. Client requires a PO: the draft snapshots it and review blocks (po_missing)", d.draft.po.required === true && d.review.blockers.some((b: any) => b.code === "po_missing") && d.review.readyForIssue === false);
    const blocked = await ready(d.draft.draftId, 1);
    ck("PO2. Ready is refused while the PO is missing (409 draft_has_blockers, names the blocker)", blocked.code === "draft_has_blockers" && "po_missing" in blocked.fields && draftRows()[0].fields.Status === "Draft");
    world.audit = [];
    const p = await details(d.draft.draftId, '{"poNumber":"PO-2026-114"}');
    ck("PO3. The PO is stored on the draft (not the client) and review passes", p.body.draft.po.number === "PO-2026-114" && p.body.review.readyForIssue === true && !JSON.stringify(world.tables[TABLES.clients]).includes("PO-2026-114"));
    ck("PO4. PO update audited once (po_updated)", world.audit.length === 1 && world.audit[0].event_type === "finance_invoice_draft.po_updated" && world.audit[0].after.poNumber === "PO-2026-114");
    const same = await details(d.draft.draftId, '{"poNumber":"PO-2026-114"}');
    ck("PO5. Re-sending the same PO is a no-op (no audit)", same.body.changed === false && world.audit.length === 1);
    await details(d.draft.draftId, '{"poNumber":null}');
    const o = await details(d.draft.draftId, '{"poOverrideReason":"School confirmed by email no PO this term"}');
    ck("PO6. An override reason instead of a PO passes review, shown as a warning, audited as po_override_recorded", o.body.review.readyForIssue === true && o.body.review.warnings.some((w: any) => w.code === "po_override_recorded") && world.audit[world.audit.length - 1].event_type === "finance_invoice_draft.po_override_recorded" && world.audit[world.audit.length - 1].reason === "School confirmed by email no PO this term");
    const ok = await ready(d.draft.draftId, o.body.draft.revision);
    ck("PO7. With the override recorded the draft can be marked Ready", ok.status === "ok" && ok.body.draft.status === "ready_for_issue");
    addOcc(S.stannes, "2026-09-10");
    const sa = (await create(ids.stannes)).body;
    ck("PO8. A client without a PO requirement never blocks on PO", sa.draft.po.required === false && !sa.review.blockers.some((x: any) => x.code === "po_missing") && sa.review.readyForIssue === true);
  }

  // ===== PT. Payment terms =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.stannes, "2026-09-10");
    const pk = (await create(ids.parkside)).body;
    const sa = (await create(ids.stannes)).body;
    ck("PT1. Client payment terms override snapshotted (30, source client)", pk.draft.paymentTerms.days === 30 && pk.draft.paymentTerms.source === "client");
    ck("PT2. No client override: the Finance Settings default is snapshotted (30, source finance_settings)", sa.draft.paymentTerms.days === 30 && sa.draft.paymentTerms.source === "finance_settings");
    const up = parseClientUpdate('{"client":{"paymentTermsDaysOverride":14}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: up.patch, reason: null });
    ck("PT3. Changing the client's terms later does not change the draft's snapshot", (await read(pk.draft.draftId)).body.draft.paymentTerms.days === 30);
    const up2 = parseClientUpdate('{"client":{"billingEmail":null}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.stannes, patch: up2.patch, reason: null });
    const noEmail = (await read(sa.draft.draftId)).body;
    ck("PT3b. A client with no billing email blocks (billing_email_missing)", noEmail.review.blockers.some((b: any) => b.code === "billing_email_missing") && (await ready(sa.draft.draftId, 1)).code === "draft_has_blockers");
    const up3 = parseClientUpdate('{"client":{"billingEmail":"office@stannes.test"}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.stannes, patch: up3.patch, reason: null });
    const ov = await details(sa.draft.draftId, '{"paymentTermsDays":7,"reason":"agreed with bursar"}');
    ck("PT4. Terms can be set on this invoice (source invoice_override), audited, and shown as a warning", ov.body.draft.paymentTerms.days === 7 && ov.body.draft.paymentTerms.source === "invoice_override" && world.audit[world.audit.length - 1].event_type === "finance_invoice_draft.payment_terms_changed" && ov.body.review.warnings.some((w: any) => w.code === "payment_terms_overridden"));
    const back = await details(sa.draft.draftId, '{"paymentTermsDays":null}');
    ck("PT5. null returns the invoice to the default terms", back.body.draft.paymentTerms.days === 30 && back.body.draft.paymentTerms.source === "finance_settings");
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, defaultPaymentTermsDays: null })];
    const ids2 = await seed();
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, defaultPaymentTermsDays: null })];
    addOcc(S.stannes, "2026-09-10");
    const none = (await create(ids2.stannes)).body;
    ck("PT6. No client terms and no default: payment_terms_missing blocks", none.draft.paymentTerms.days === null && none.review.blockers.some((b: any) => b.code === "payment_terms_missing"));
    ck("PT7. No due date is invented (F7 owns overdue)", !JSON.stringify(none).includes("dueDate"));
  }

  // ===== RF. Refresh =====
  {
    const ids = await seed();
    const a = addOcc(S.after, "2026-09-17");
    const q = await ovCreate(a, '{"override":{"kind":"quantity","quantity":20},"reason":"extra players"}');
    const d = (await create(ids.parkside)).body;
    const orig = lineOf(d, a);
    ck("RF0. Line made with quantity 20 (£180)", orig.quantity === 20 && orig.gross === "180.00");
    await ovCreate(a, `{"override":{"kind":"quantity","quantity":19},"reason":"recount","supersedes":"${q.body.override.overrideId}"}`);
    const r = (await read(d.draft.draftId)).body;
    ck("RF1. A later F4 change never rewrites the line; review blocks with source_changed", lineOf(r, a).quantity === 20 && r.review.blockers.some((b: any) => b.code === "source_changed" && b.lineIds.includes(orig.lineId)));
    const late = addOcc(S.ppa, "2026-09-18");
    const r2 = (await read(d.draft.draftId)).body;
    ck("RF2. New eligible work not on the draft is a warning (new_eligible_work), never added silently", r2.review.warnings.some((w: any) => w.code === "new_eligible_work" && w.occurrenceIds.includes(late)) && !r2.lines.some((l: any) => l.occurrenceId === late));
    world.audit = [];
    const f = await refresh(d.draft.draftId);
    const nl = lineOf(f.body, a);
    const old = f.body.lines.find((l: any) => l.lineId === orig.lineId);
    ck("RF3. Refresh supersedes the changed line (old kept, marked superseded -> new), adds new work", nl.quantity === 19 && nl.gross === "171.00" && old.status === "superseded" && old.supersededBy === nl.lineId && lineOf(f.body, late) !== undefined);
    ck("RF4. Refresh audited once with added / superseded detail; review is clean of source changes", world.audit.length === 1 && world.audit[0].event_type === "finance_invoice_draft.refreshed" && world.audit[0].after.added.length === 1 && world.audit[0].after.superseded.length === 1 && !f.body.review.blockers.some((b: any) => b.code === "source_changed"));
    const again = await refresh(d.draft.draftId);
    ck("RF5. A refresh with nothing to change is a no-op (no write, no audit)", again.body.changed === false && world.audit.length === 1);
    // An occurrence that stops being eligible is removed on refresh
    world.tables[BILLING_TABLES.occurrences].find((o) => o.fields["Occurrence ID"] === late)!.fields.Status = "Cancelled";
    const f2 = await refresh(d.draft.draftId);
    ck("RF6. Refresh removes a line whose occurrence is no longer invoiceable (with the reason)", lineOf(f2.body, late, "removed").statusReason === "Cancelled - not delivered");
    const up = parseClientUpdate('{"client":{"poRequired":false}}', isTenantKey) as any;
    await W({ route: "client.update", clientId: ids.parkside, patch: up.patch, reason: null });
    const w = (await read(d.draft.draftId)).body;
    const f3 = await refresh(d.draft.draftId);
    ck("RF7. Client PO requirement change: warned on review, applied by an explicit refresh", w.review.warnings.some((x: any) => x.code === "po_requirement_changed") && f3.body.draft.po.required === false);
    const rows = lineRows().filter((l) => l.fields["Draft ID"] === d.draft.draftId);
    ck("RF8. Line rows are never edited in their figures (only status fields change): every row still validates", buildLines(rows, ORG_REC).ok === true && rows.length === 3);
    const inc = rows.find((r) => r.fields.Status === "Included")!;
    const keep = inc.fields["Commercial Terms ID"];
    inc.fields["Commercial Terms ID"] = "FCT-000000000000";
    const drift = (await read(d.draft.draftId)).body;
    ck("RF9. A line whose stored terms reference no longer matches F4 is flagged source_changed", drift.review.blockers.some((b: any) => b.code === "source_changed"));
    inc.fields["Commercial Terms ID"] = keep;
    const foreignLine = { ...inc, fields: { ...inc.fields, Organisation: [OTHER_ORG_REC] } };
    const foreignDraft = { ...draftRows()[0], fields: { ...draftRows()[0].fields, Organisation: [ORG_REC, OTHER_ORG_REC] } };
    ck("RF10. Mapping refuses rows of another organisation (or linked to two) - invalid data, never skipped", (buildLines([foreignLine], ORG_REC) as any).ok === false && (buildDrafts([foreignDraft], ORG_REC) as any).ok === false);
  }

  // ===== ST. States =====
  {
    const ids = await seed();
    const a = addOcc(S.ppa, "2026-09-10");
    addOcc(S.ppa, "2026-09-11");
    const d = (await create(ids.parkside)).body;
    await details(d.draft.draftId, '{"poNumber":"PO-1"}');
    const stale = await ready(d.draft.draftId, 1);
    ck("ST1. Ready needs the revision Management reviewed (409 draft_revision_mismatch)", stale.code === "draft_revision_mismatch");
    const rd = await ready(d.draft.draftId, 2);
    ck("ST2. Marked Ready for issue: status, ready stamp, revision 3; no invoice number / sent / issued anywhere", rd.body.draft.status === "ready_for_issue" && rd.body.draft.statusLabel === "Ready for issue" && rd.body.draft.readyAt === NOW.toISOString() && rd.body.draft.revision === 3 && !/invoiceNumber|"sent"|issued|xero/i.test(JSON.stringify(rd.body)));
    const lid = lineOf(rd.body, a).lineId;
    const frozen = [await refresh(d.draft.draftId), await exclude(d.draft.draftId, lid), await details(d.draft.draftId, '{"poNumber":"PO-2"}'), await DW({ route: "line.restore", draftId: d.draft.draftId, lineId: lid, reason: null })];
    ck("ST3. A Ready draft is frozen: refresh / exclude / details / restore refused (409 draft_not_open)", frozen.every((x) => x.code === "draft_not_open"));
    await ovCreate(a, '{"override":{"kind":"not_billable"},"reason":"late"}');
    const r = (await read(d.draft.draftId)).body;
    ck("ST4. Source changes after Ready are FLAGGED, never applied (snapshot unchanged)", lineOf(r, a).gross === "60.00" && r.review.blockers.some((b: any) => b.code === "source_changed" && /return it to Draft/.test(b.message)));
    const again = await ready(d.draft.draftId, 3);
    ck("ST5. Marking an already-Ready draft Ready is a no-op", again.body.changed === false);
    world.audit = [];
    const ro = await reopen(d.draft.draftId);
    ck("ST6. Reopen (Ready -> Draft) needs a reason and is audited as returned_to_draft", ro.body.draft.status === "draft" && world.audit.length === 1 && world.audit[0].event_type === "finance_invoice_draft.returned_to_draft" && world.audit[0].reason === "School queried a date");
    const f = await refresh(d.draft.draftId);
    ck("ST7. Back in Draft, a deliberate refresh applies the change", lineOf(f.body, a, "removed") !== undefined && f.body.draft.totals.gross === "60.00");
    ck("ST8. Only two states exist in the stored data", new Set(draftRows().map((r) => r.fields.Status)).size <= 2 && draftRows().every((r) => ["Draft", "Ready for issue"].includes(r.fields.Status)));
  }

  // ===== AC. Access + tenant =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const d = (await create(ids.parkside)).body;
    ck("AC1. Finance View reads eligible work, drafts and a draft", (await elig(ids.parkside, "2026-09-01", "2026-09-30", viewer)).body.access === "view" && (await listClientDrafts(deps, viewer, ids.parkside) as any).body.drafts.length === 1 && (await read(d.draft.draftId, viewer)).body.access === "view");
    const vw = [await create(ids.parkside, "2026-10-01", "2026-10-31", viewer), await DW({ route: "draft.refresh", draftId: d.draft.draftId, reason: null }, viewer), await (fresh(), markLineNotBillable(deps, viewer, d.draft.draftId, d.lines[0].lineId, "x") as Promise<any>)];
    ck("AC2. Finance View cannot write (403 finance_manage_required) - including not-billable, before F4 is touched", vw.every((x) => x.code === "finance_manage_required") && world.tables[BILLING_TABLES.overrides].length === 0);
    world.grants[VIEWER] = [];
    ck("AC3. No grant -> 403 finance_access_denied", (await read(d.draft.draftId, viewer)).code === "finance_access_denied");
    const coach = { userId: "c", role: "coach", active: true, organisationId: ORG };
    const parent = { userId: "p", role: "parent", active: true, organisationId: ORG };
    ck("AC4. Coach / Parent -> 403 management_required", (await read(d.draft.draftId, coach)).code === "management_required" && (await create(ids.parkside, "2026-10-01", "2026-10-31", parent)).code === "management_required");
    world.moduleOn = false;
    ck("AC5. Module off -> 403 finance_module_disabled (reads and writes)", (await read(d.draft.draftId)).code === "finance_module_disabled" && (await refresh(d.draft.draftId)).code === "finance_module_disabled");
    world.moduleOn = true;
    ck("AC6. Tenant keys rejected in query and body", (checkInvoicingQuery(new URLSearchParams("clientId=FCL-AAAAAAAAAAAA&from=2026-09-01&to=2026-09-30&organisation_id=X"), true, isTenantKey) as any).code === "tenant_param_rejected" && (parseDraftCreate('{"clientId":"FCL-AAAAAAAAAAAA","from":"2026-09-01","to":"2026-09-30","organisationId":"X"}', isTenantKey) as any).code === "tenant_param_rejected" && (parseDetails('{"poNumber":"x","org":"Y"}', isTenantKey) as any).code === "tenant_param_rejected");
    // Another organisation's draft rows are invisible
    draftRows()[0].fields.Organisation = [OTHER_ORG_REC];
    ck("AC7. A draft of another organisation is not found (404)", (await read(d.draft.draftId)).code === "invoice_draft_not_found");
    draftRows()[0].fields.Organisation = [ORG_REC];
  }

  // ===== AU. Audit =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-09-10");
    const d = await create(ids.parkside);
    const e = world.audit[0];
    ck("AU1. Create -> exactly one event: org, actor, entity, draft id, before null, draft + every line, contract", world.audit.length === 1 && e.event_type === "finance_invoice_draft.created" && e.organisation_id === ORG && e.actor_user_id === MGR && e.entity_type === "finance_invoice_draft" && e.record_id === d.body.draft.draftId && e.before === null && e.after.lines.length === 2 && e.after.draft.grossMinor === 22200 && e.context.contract === "finance-invoicing-v1" && e.context.route === "POST /invoice-drafts");
    const n = world.audit.length;
    await read(d.body.draft.draftId);
    await elig(ids.parkside);
    await create(ids.parkside);
    await details(d.body.draft.draftId, '{"poNumber":null}');
    await DW({ route: "line.exclude", draftId: d.body.draft.draftId, lineId: "FIL-000000000000", reason: "x" });
    ck("AU2. No audit on reads, rejected writes (open draft, unknown line) or no-op writes", world.audit.length === n);
    // Audit failure -> every write of the request undone
    const ids2 = await seed();
    addOcc(S.ppa, "2026-09-10");
    for (let i = 11; i <= 22; i++) addOcc(S.after, `2026-09-${i}`);
    world.auditStatus = 500;
    const f = await create(ids2.parkside);
    ck("AU3. Audit failure: 503 finance_audit_unavailable and the draft + all 13 lines are deleted again (batched)", f.code === "finance_audit_unavailable" && draftRows().length === 0 && lineRows().length === 0 && calls.some((c) => c.method === "DELETE" && new URL(c.url).searchParams.getAll("records[]").length === 10));
    world.auditStatus = undefined;
    world.failCreateOn = INVOICING_TABLES.lines;
    const f2 = await create(ids2.parkside);
    ck("AU4. A line write failure undoes the draft row (503, nothing left)", f2.code === "finance_invoicing_unavailable" && draftRows().length === 0 && lineRows().length === 0 && world.audit.length === 0);
    world.failCreateOn = undefined;
    world.auditStatus = 500;
    world.undoStatus = 500;
    const f3 = await create(ids2.parkside);
    ck("AU5. Undo failure -> 500 finance_invoicing_unaudited (never success)", f3.httpStatus === 500 && f3.code === "finance_invoicing_unaudited");
    world.auditStatus = undefined;
    world.undoStatus = undefined;
    const ids3 = await seed();
    addOcc(S.ppa, "2026-09-10");
    world.lockMode = "busy";
    ck("AU6. Lock busy -> 409 finance_commercial_busy, nothing read or written", (await create(ids3.parkside)).code === "finance_commercial_busy" && draftRows().length === 0);
    world.lockMode = "error";
    ck("AU7. Lock store error -> 503", (await create(ids3.parkside)).httpStatus === 503);
    world.lockMode = "ok";
    ck("AU8. The lock is always released", world.lockHeld === null);
  }

  // ===== PF. Bounded reads =====
  {
    const ids = await seed();
    for (let day = 1; day <= 30; day++) {
      const dd = `2026-09-${String(day).padStart(2, "0")}`;
      if (dd >= "2026-09-29") continue;
      addOcc(S.ppa, dd);
      addOcc(S.after, dd);
      addOcc(S.breakfast, dd);
    }
    calls = [];
    const d = await create(ids.parkside);
    const reads = airtableGets().length;
    ck("PF1. 84 occurrences -> 84 lines with a fixed number of Airtable reads (no per-occurrence reads)", d.httpStatus === 201 && d.body.lines.length === 84 && reads <= 20, `reads=${reads}`);
    ck("PF2. Lines are written in Airtable batches of 10 (9 line creates + 1 draft create)", airtableWrites().filter((c) => c.method === "POST").length === 10);
    calls = [];
    await read(d.body.draft.draftId);
    const r2 = airtableGets().length;
    ck("PF3. Reading + reviewing an 84-line draft is also a fixed number of reads (no per-line reads)", r2 <= 20 && !airtableGets().some((c) => /\/rec[A-Za-z0-9]{14}$/.test(new URL(c.url).pathname)), `reads=${r2}`);
  }

  // ===== RT. Routes + parsing =====
  {
    const m = (p: string, meth: string) => matchInvoicingRoute(p, meth) as any;
    ck("RT1. Routes: eligible / list / create / read / refresh / details / ready / reopen / exclude / restore / not-billable", m("invoicing/eligible", "GET").route.name === "eligible.read" && m("invoice-drafts", "GET").route.name === "drafts.list" && m("invoice-drafts", "POST").route.name === "draft.create" && m("invoice-drafts/FID-0123456789AB", "GET").route.name === "draft.read" && ["refresh", "details", "ready", "reopen"].every((x) => m(`invoice-drafts/FID-0123456789AB/${x}`, "POST").route.name === `draft.${x}`) && m("invoice-drafts/FID-0123456789AB/lines/FIL-0123456789AB/exclude", "POST").route.name === "line.exclude" && m("invoice-drafts/FID-0123456789AB/lines/FIL-0123456789AB/not-billable", "POST").route.name === "line.not_billable");
    ck("RT2. Wrong method -> 405; malformed ids / unknown actions -> 404; other paths -> not F5", m("invoice-drafts/FID-0123456789AB", "POST").status === "method" && m("invoice-drafts/FID-XYZ", "GET").status === "not_found" && m("invoice-drafts/FID-0123456789AB/send", "POST").status === "not_found" && m("invoice-drafts/FID-0123456789AB/issue", "POST").status === "not_found" && m("clients", "GET") === null);
    ck("RT3. No send / issue / payment / Xero / number routes exist", ["send", "issue", "pay", "xero", "number", "sent", "paid"].every((x) => m(`invoice-drafts/FID-0123456789AB/${x}`, "POST").status === "not_found"));
    const q = (s: string, per = true) => checkInvoicingQuery(new URLSearchParams(s), per, isTenantKey) as any;
    ck("RT4. Eligible query: clientId + from + to required; real dates; <= 93 days; unknown keys rejected", q("clientId=FCL-AAAAAAAAAAAA&from=2026-09-01&to=2026-09-30").ok && q("clientId=FCL-AAAAAAAAAAAA&from=2026-09-01").code === "invalid_input" && q("clientId=FCL-AAAAAAAAAAAA&from=2026-09-01&to=2026-12-31").fields.to.includes("93") && q("clientId=FCL-AAAAAAAAAAAA&from=2026-09-31&to=2026-10-01").fields.from && q("clientId=FCL-AAAAAAAAAAAA&from=2026-09-01&to=2026-09-30&x=1").code === "unexpected_parameter" && q("clientId=bad", false).fields.clientId);
    ck("RT5. Create body validated (client id, dates, order, unknown field)", (parseDraftCreate('{"clientId":"FCL-AAAAAAAAAAAA","from":"2026-09-30","to":"2026-09-01"}', isTenantKey) as any).fields.to === "must be on or after from" && (parseDraftCreate('{"clientId":"FCL-AAAAAAAAAAAA","from":"2026-09-01","to":"2026-09-30","lines":[]}', isTenantKey) as any).code === "unexpected_field");
    ck("RT6. Exclude / not-billable / reopen need a reason; refresh / restore may be empty", (parseReasonBody("{}", true, isTenantKey) as any).fields.reason === "is required" && (parseReasonBody("", false, isTenantKey) as any).ok && (parseReasonBody('{"reason":"x"}', true, isTenantKey) as any).reason === "x");
    ck("RT7. Details: at least one field; PO text <= 100; terms 0-365 or null; Ready needs a revision", (parseDetails('{"reason":"x"}', isTenantKey) as any).code === "invalid_body" && (parseDetails(`{"poNumber":"${"x".repeat(101)}"}`, isTenantKey) as any).fields.poNumber && (parseDetails('{"paymentTermsDays":400}', isTenantKey) as any).fields.paymentTermsDays && (parseDetails('{"paymentTermsDays":null}', isTenantKey) as any).req.paymentTermsDays === null && (parseReady("{}", isTenantKey) as any).fields.revision);
    ck("RT8. Description date format", formatDay("2026-09-04") === "4 Sep 2026" && formatDay("2026-12-25") === "25 Dec 2026");
  }

  // ===== Z. Code / drift =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const F5 = ["finance-invoicing.ts", "finance-invoicing-mapping.ts", "finance-invoicing-repository.ts", "finance-invoicing-orchestrator.ts"];
    ck("Z1. Domain + mapping are pure (no fetch / Deno / Supabase / Airtable URLs)", ["finance-invoicing.ts", "finance-invoicing-mapping.ts"].every((f) => !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(code(f))));
    ck("Z2. F5 never prices: no VAT calculation or terms lookup of its own - it consumes resolveOccurrenceBilling", !/calculateVat|termsOn\(|lifecycleOn\(/.test(F5.map((f) => noComments(code(f))).join("\n")) && /resolveOccurrenceBilling\(/.test(code("finance-invoicing-orchestrator.ts")));
    ck("Z3. Reads / writes authorise via F1 authorizeFinance (read + manage); no new auth path", /authorizeFinance\(deps, caller, "read"\)/.test(code("finance-invoicing-orchestrator.ts")) && /authorizeFinance\(deps, caller, "manage"\)/.test(code("finance-invoicing-orchestrator.ts")) && !/createClient|profiles/.test(code("finance-invoicing-orchestrator.ts")));
    ck("Z4. Not billable reuses the F4 writeOverride - no F5 not-billable storage", /writeOverride\(deps, caller/.test(code("finance-invoicing-orchestrator.ts")) && !/"Not billable"|not_billable:/.test(noComments(code("finance-invoicing-mapping.ts"))));
    ck("Z5. No issue / sending / numbering / payment / Xero / Stripe / Needs Attention code in F5", !/xero|stripe|sendEmail|invoiceNumber|issuedAt|paidAt|overdue|creditNote|needs_attention|needsAttention/i.test(F5.map((f) => noComments(code(f))).join("\n")));
    ck("Z6. The shared Finance write lock and the single audit insert are reused", /acquireWriteLock\(deps\.grants, lockKey\(org\)\)/.test(code("finance-invoicing-orchestrator.ts")) && /insertAuditEvents\(deps\.grants, result\.events\)/.test(code("finance-invoicing-orchestrator.ts")) && /`commercial:\$\{o\.organisationId\}`/.test(code("finance-invoicing-orchestrator.ts")));
    ck("Z7. Schedule tables are never written by F5 (only draft + line tables)", !/BILLING_TABLES\.(occurrences|sessions)[^\n]*(createRows|patchRows)/.test(code("finance-invoicing-repository.ts")) && !/txn\.(create|patch)\(BILLING_TABLES/.test(code("finance-invoicing-orchestrator.ts")));
    ck("Z8. index.ts routes F5 through the orchestrator and keeps F1-F4 routes", /matchInvoicingRoute\(route, req\.method\)/.test(code("index.ts")) && /matchBillingRoute\(decoded/.test(code("index.ts")) && /matchCommercialRoute\(route/.test(code("index.ts")) && /"write-check"/.test(code("index.ts")));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z9. Test copies match the canonical finance files (only import paths swapped)", copy("finance-invoicing.ts") && copy("finance-invoicing-mapping.ts") && copy("finance-invoicing-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-invoicing-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]) && copy("finance-commercial.ts") && copy("finance-commercial-mapping.ts"));
    ck("Z10. No Josh Evans naming in F5 code", !/josh|evans/i.test(F5.map(code).join("\n")));
  }

  for (const [s, n, x] of R) console.log(`${s}  ${n}${x ? `  (${x})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
