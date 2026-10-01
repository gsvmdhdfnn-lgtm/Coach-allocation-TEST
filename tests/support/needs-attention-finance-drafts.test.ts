// Unit + integration tests for Finance Foundation F8b - ATT-048
// invoice_draft_blocked (see TEST-ENV.md "Finance Foundation - F8b"):
//
//   BL   blocker vs warning vs informational; one case per draft; count + labels
//   LC   draft lifecycle: Draft only (Ready / issued / awaiting external issue never)
//   ST   stored blockers: billing email, PO, payment terms, totals, no lines, manual billing
//   LV   live (F4) blockers: source changed, duplicate claim, unresolved configuration,
//        missing commercial terms + the approved draft-specific exception
//   ID   case identity (stable key while blockers change; one case per draft)
//   AC   F8a access reused: none / View / Manage, no existence leak
//   SET  Settings off / on / off
//   AR   auto-resolution through the REAL Finance write paths; snooze never changes Finance
//   PF   bounded reads (each table once, no per-draft read, one review pass)
//   PAR  parity: for EVERY draft in every scenario, Needs Attention's blocker set equals
//        Finance's own GET /invoice-drafts/{id} review (the real F5 orchestrator)
//   DR   drift: copied blocks verbatim; every F5 blocker code labelled; shared-module
//        allowlist = what the evaluator imports; no fetch / write / Deno anywhere shared
//
// One in-memory Airtable serves BOTH the real Finance orchestrators (which build
// every fixture through F3 / F4 / F5 write paths) and the real Needs Attention
// orchestrator + deployed registry. filterByFormula is ignored, exactly like the
// Finance tests: every repository re-checks rows in code.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, revokeException, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS as NA_RETRY } from "./needs-attention-repository.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import type { FinanceAccess } from "./needs-attention-finance.ts";
import { BLOCKER_LABELS, DRAFT_BLOCKED_SOURCES, draftReviewPassStats } from "./needs-attention-finance-drafts.ts";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, toStoredFields } from "./finance-settings.ts";
import { TABLES } from "./finance-commercial-mapping.ts";
import { COMMERCIAL_RETRY_DELAYS_MS } from "./finance-commercial-repository.ts";
import { SETTINGS_RETRY_DELAYS_MS } from "./finance-settings-repository.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type CommercialDeps, type WriteInput, writeCommercial } from "./finance-commercial-orchestrator.ts";
import { parseClientUpdate } from "./finance-commercial.ts";
import { BILLING_TABLES } from "./finance-billing-mapping.ts";
import { type OverrideInput, writeOverride } from "./finance-billing-orchestrator.ts";
import { parseOverrideCreate } from "./finance-billing.ts";
import { parseDetails } from "./finance-invoicing.ts";
import { FI, INVOICING_TABLES, buildLines } from "./finance-invoicing-mapping.ts";
import { ISSUE_TABLES, invoiceLineCreateFields } from "./finance-issue-mapping.ts";
import { WRITE_BATCH } from "./finance-invoicing-repository.ts";
import { type DraftWrite, readDraft, writeDraft } from "./finance-invoicing-orchestrator.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: unknown, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");

// ---------------------------------------------------------------------
// Shared in-memory world (Finance + Needs Attention)
// ---------------------------------------------------------------------
const ORG = "ORG-TEST-001";
const ORG_REC = "recYXqi1DTZ8ZECPQ";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
const MANAGER: Caller = { ...mgr, displayName: "Test Manager" };
let NOW = new Date("2026-09-29T12:00:00.000Z");

const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7 };
const settingsRow = (s: any) => ({ id: "recSettingsRow001", fields: { Organisation: [ORG_REC], "Finance Settings ID": "FINSET", Revision: 1, ...Object.fromEntries(Object.entries(toStoredFields(s, Object.keys(s) as any)).filter(([, v]) => v !== null)) } });

const RULE047: AirtableRecord = { id: "recC80hmlglLibk7I", fields: { "Rule Name": "Invoice overdue", "Rule ID": "ATT-047", "Rule Key": "invoice_overdue", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 47, Active: true, "Action Label": "Review Receivable", "Destination Area": "Finance", "Supports Override": true } };
const RULE048: AirtableRecord = { id: "recqJL02MwyCcMogr", fields: { "Rule Name": "Invoice draft blocked", "Rule ID": "ATT-048", "Rule Key": "invoice_draft_blocked", Category: "Finance & Billing", "Default Base Severity": "Normal", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 48, Active: true, "Action Label": "Review Invoice Draft", "Destination Area": "Finance", "Supports Override": true } };
const RULE044: AirtableRecord = { id: "recRuleATT044xxxx", fields: { "Rule Name": "Work summary queried", "Rule ID": "ATT-044", "Rule Key": "work_summary_queried", Category: "Coaches & Compliance", "Default Enabled": true, "Default Base Severity": "Normal", "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": 44, Active: true } };
const enable048 = (on = true): AirtableRecord => ({ id: "recSet048xxxxxxxx", fields: { Organisation: [ORG_REC], Rule: [RULE048.id], ...(on ? { Enabled: true } : {}), "Allow Override": true } });

interface W {
  grants: Record<string, FinanceGrantRow[]>;
  tables: Record<string, { id: string; fields: Record<string, any> }[]>;
  audit: any[];
  lockHeld: string | null;
}
let world: W;
let calls: { url: string; method: string; table: string | null }[] = [];
let recSeq = 0;
let hexSeq = 0;
function reset() {
  world = {
    grants: { [MGR]: [{ organisation_id: ORG, access_level: "manage", revoked_at: null }] },
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
      [ISSUE_TABLES.lines]: [],
      [CONFIG_TABLES.rules]: [RULE047, RULE048, RULE044],
      [CONFIG_TABLES.settings]: [enable048()],
      [CONFIG_TABLES.exceptions]: [],
      [CONFIG_TABLES.features]: [
        { id: "recFeatFinance001", fields: { "Feature Key": FINANCE_MODULE_KEY, Enabled: true } },
        { id: "recFeatCoaches001", fields: { "Feature Key": "module_coaches", Enabled: true } },
      ],
      [CONFIG_TABLES.organisations]: [{ id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } }],
    },
    audit: [],
    lockHeld: null,
  };
  calls = [];
  NOW = new Date("2026-09-29T12:00:00.000Z");
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tableOf = (url: string) => Object.keys(world.tables).find((t) => new URL(url).pathname.split("/")[3] === encodeURIComponent(t)) ?? null;
const clean = (fields: Record<string, any>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== false));

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (url.includes("/rest/v1/finance_access_grants")) {
    const m = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    calls.push({ url, method, table: null });
    return json(m ? world.grants[m[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockHeld) return json(null);
    world.lockHeld = "22222222-2222-4222-8222-222222222222";
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rest/v1/finance_audit_events") && method === "POST") {
    const rows = (Array.isArray(body) ? body : [body]).map((e: any, i: number) => ({ id: `aud-${world.audit.length + i + 1}`, ...e }));
    world.audit.push(...rows);
    return json(rows.map((r: any) => ({ id: r.id })), 201);
  }
  if (url.startsWith("https://api.airtable.com/")) {
    const t = tableOf(url);
    calls.push({ url, method, table: t });
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
    if (method === "POST") {
      if (body.records) {
        if (body.records.length > WRITE_BATCH) return json({ error: "TOO_MANY_RECORDS" }, 422);
        const recs = body.records.map((r: any) => ({ id: `rec${String(++recSeq).padStart(14, "0")}`, fields: clean(r.fields) }));
        rows.push(...recs);
        return json({ records: recs });
      }
      const rec = { id: `rec${String(++recSeq).padStart(14, "0")}`, fields: clean(body.fields) };
      rows.push(rec);
      return json(rec);
    }
    if (method === "PATCH") {
      const ups = id ? [{ id, fields: body.fields }] : body.records;
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
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

const fdeps: CommercialDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  randomHex: () => (++hexSeq).toString(16).padStart(12, "0") + "a".repeat(20),
};
const W_ = (input: WriteInput) => writeCommercial(fdeps, mgr, input) as Promise<any>;
const OW = (input: OverrideInput) => writeOverride(fdeps, mgr, input) as Promise<any>;
const DW = (input: DraftWrite) => writeDraft(fdeps, mgr, input) as Promise<any>;
const create = (clientId: string, from = "2026-09-01", to = "2026-09-30") => DW({ route: "draft.create", req: { clientId, from, to } });
const readF = (draftId: string) => readDraft(fdeps, mgr, draftId) as Promise<any>;
const details = (draftId: string, body: string) => DW({ route: "draft.details", draftId, req: (parseDetails(body, isTenantKey) as any).req });
const ovCreate = (occurrenceId: string, body: string) => OW({ route: "override.create", occurrenceId, req: (parseOverrideCreate(body, isTenantKey) as any).req });
const clientUpdate = (clientId: string, patch: string, reason = "F8b test") => W_({ route: "client.update", clientId, patch: (parseClientUpdate(patch, isTenantKey) as any).patch, reason });

function addSession(recId: string, sessionId: string, financeServiceId: string | null) {
  world.tables[BILLING_TABLES.sessions].push({ id: recId, fields: { "Session ID": sessionId, "Session Name": `${sessionId} name`, ...(financeServiceId ? { "Finance Service ID": financeServiceId } : {}) } });
}
function addOcc(sessionRec: string, date: string, o: { status?: string } = {}) {
  const id = `${sessionRec}:${date}`;
  world.tables[BILLING_TABLES.occurrences].push({
    id: `recOcc${String(world.tables[BILLING_TABLES.occurrences].length).padStart(11, "0")}`,
    fields: { "Occurrence ID": id, Session: [sessionRec], Date: date, "Start Date & Time": `${date}T14:30:00.000Z`, "End Date & Time": `${date}T15:30:00.000Z`, Status: o.status ?? "Scheduled", "Confirmation State": "Confirmed" },
  });
  return id;
}
const PPA = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 5000, vatTreatment: "plus_vat" as const };
const AFTER = { payer: "client" as const, chargeType: "per_player" as const, amountMinor: 900, vatTreatment: "no_vat" as const, defaultBillableQuantity: 18 };
const BREAKFAST = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 6000, vatTreatment: "vat_included" as const };
const STANNES = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 4500, vatTreatment: "plus_vat" as const };
const S = { ppa: "recSessPPA0000001", after: "recSessAFT0000001", breakfast: "recSessBRK0000001", stannes: "recSessSTA0000001" };

async function seed() {
  reset();
  const pk = (await W_({ route: "clients.create", client: { name: "ZZTEST F8B Parkside", billingEmail: "billing.parkside@test.invalid", paymentTermsDaysOverride: 30, poRequired: true }, reason: null })).body.client.clientId as string;
  const sa = (await W_({ route: "clients.create", client: { name: "ZZTEST F8B St Anne's", billingEmail: "office@stannes.test" }, reason: null })).body.client.clientId as string;
  const mk = async (clientId: string, name: string, input: any) => (await W_({ route: "services.create", clientId, name, initial: { effectiveFrom: "2026-09-01", input }, reason: null })).body.service.serviceId as string;
  const ids = { parkside: pk, stannes: sa, ppa: await mk(pk, "PPA", PPA), after: await mk(pk, "After-school", AFTER), breakfast: await mk(pk, "Breakfast club", BREAKFAST), sa: await mk(sa, "PPA", STANNES) };
  addSession(S.ppa, "TEST-PPA", ids.ppa);
  addSession(S.after, "TEST-AFTER", ids.after);
  addSession(S.breakfast, "TEST-BREAKFAST", ids.breakfast);
  addSession(S.stannes, "TEST-STANNES", ids.sa);
  return ids;
}

// ---------------------------------------------------------------------
// Needs Attention side
// ---------------------------------------------------------------------
NA_RETRY.length = 0;
let tokN = 0;
const held = new Map<string, string>();
const fakeLock: LockClient = {
  async acquire(key) {
    if (held.has(key)) return null;
    const t = `${String(++tokN).padStart(8, "0")}-aaaa-4000-8000-000000000000`;
    held.set(key, t);
    return t;
  },
  async release(key, token) {
    if (held.get(key) !== token) return false;
    held.delete(key);
    return true;
  },
};
let accessCalls = 0;
const ndeps = (access: FinanceAccess): Deps => ({
  airtable: { baseId: "appQktredAuGa1X7e", token: "t" },
  registry: IMPLEMENTED_EVALUATORS,
  lock: fakeLock,
  financeAccess: async () => {
    accessCalls++;
    return access;
  },
});
async function na(access: FinanceAccess = "manage", q: { view?: string; caseKey?: string; debug?: boolean } = { debug: true }) {
  accessCalls = 0;
  calls = [];
  const out = await getCases(ndeps(access), MANAGER, q, NOW);
  if (out.status !== "ok") throw new Error(`getCases rejected: ${JSON.stringify(out)}`);
  return out.body as any;
}
const draftCases = (b: any) => (b.cases ?? []).filter((c: any) => c.ruleKey === "invoice_draft_blocked");
const caseOf = (b: any, draftId: string) => draftCases(b).find((c: any) => c.targetIds.draftId === draftId);
const keyOf = (draftId: string) => `invoice_draft_blocked|draft:${draftId}`;
const codesOf = (c: any) => (c ? String(c.context.blockerCodes).split(",").sort().join(",") : "");
const naGets = () => calls.filter((c) => c.method === "GET" && c.table);
const naWrites = () => calls.filter((c) => c.method !== "GET" && c.table);
const listsOf = (t: string) => naGets().filter((c) => c.table === t).length;
const draftRow = (draftId: string) => world.tables[INVOICING_TABLES.drafts].find((r) => r.fields[FI.draft.id] === draftId)!;

/**
 * PARITY: for every draft of the organisation, Finance's own review (GET
 * /invoice-drafts/{id} through the real F5 orchestrator) vs ATT-048 on the SAME rows.
 * Open draft with blockers <=> exactly one case with exactly those codes; anything else <=> no case.
 */
async function parity(label: string) {
  const b = await na();
  const problems: string[] = [];
  for (const row of world.tables[INVOICING_TABLES.drafts]) {
    const draftId = row.fields[FI.draft.id];
    const f = await readF(draftId);
    if (f.status !== "ok") {
      problems.push(`${draftId}: Finance read ${f.code}`);
      continue;
    }
    const open = f.body.draft.status === "draft" && !f.body.draft.issued;
    const fin = open ? f.body.review.blockers.map((x: any) => x.code).sort().join(",") : "";
    const nac = codesOf(caseOf(b, draftId));
    if (fin !== nac) problems.push(`${draftId}: Finance [${fin}] vs NA [${nac}]`);
  }
  ck(`PAR. ${label}: ATT-048 equals Finance's own draft review for every draft (${world.tables[INVOICING_TABLES.drafts].length} drafts)`, problems.length === 0 && b.complete === true, problems.join(" | ") || JSON.stringify(b.configIssues));
  return b;
}

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== BL / ST / LV / ID / AR: one evolving world, parity after every step =====
  {
    const ids = await seed();
    const p1 = addOcc(S.ppa, "2026-09-10");
    const p2 = addOcc(S.ppa, "2026-09-11");
    const s1 = addOcc(S.stannes, "2026-09-10");
    const D1 = (await create(ids.parkside)).body.draft.draftId as string; // PO required, no PO yet
    const D2 = (await create(ids.stannes)).body.draft.draftId as string; // clean
    let b = await parity("Fresh drafts");
    let c1 = caseOf(b, D1);
    ck("BL1 / ST13 / LC6. Draft + real F5 blocker (PO required, none recorded) -> exactly one case", draftCases(b).length === 1 && c1 && codesOf(c1) === "po_missing");
    ck("LC7. Draft with no blocker (St Anne's: email, terms, no PO) -> no case", !caseOf(b, D2));
    ck("ID. Case key invoice_draft_blocked|draft:<FID>; Normal; ATT-048; Review Invoice Draft; destination Finance / finance/invoice-draft", c1?.caseKey === keyOf(D1) && c1.severity === "Normal" && c1.ruleId === "ATT-048" && c1.actionLabel === "Review Invoice Draft" && c1.destination.area === "Finance" && c1.destination.route === "finance/invoice-draft" && c1.destination.params.draftId === D1 && c1.module === "module_finance");
    ck("BL5. Plain content: client, period, count, Management wording - no internal codes in title / detail", c1?.title === "Invoice draft for ZZTEST F8B Parkside has 1 issue to resolve" && c1.detail === "2026-09-01 to 2026-09-30: PO required" && c1.context.blockerCount === 1 && c1.context.clientName === "ZZTEST F8B Parkside" && c1.context.periodFrom === "2026-09-01" && c1.context.sourceApi === `GET /finance/invoice-drafts/${D1}` && !/_/.test(c1.title + c1.detail));

    // Second blocker: billing email removed from the client (F3 write).
    await clientUpdate(ids.parkside, '{"client":{"billingEmail":null}}');
    b = await parity("Billing email removed");
    c1 = caseOf(b, D1);
    ck("BL4 / ST12. Two blockers (PO + billing email) -> still ONE case for the draft, count 2", draftCases(b).length === 1 && codesOf(c1) === "billing_email_missing,po_missing" && c1.context.blockerCount === 2 && c1.title.endsWith("has 2 issues to resolve") && /Missing billing information/.test(c1.detail) && /PO required/.test(c1.detail));
    ck("ID23. Same draft, more blockers -> same case key", c1?.caseKey === keyOf(D1));

    // Live: source changed (F4 not-billable override on a line already on the draft).
    await ovCreate(p2, '{"override":{"kind":"not_billable"},"reason":"Goodwill"}');
    b = await parity("Source changed");
    c1 = caseOf(b, D1);
    ck("LV18. Source changed (F4 says a line is no longer billable) -> blocker on the same case", codesOf(c1) === "billing_email_missing,po_missing,source_changed" && c1.caseKey === keyOf(D1) && /Source work has changed/.test(c1.detail));

    // Live: missing commercial terms (delivered + confirmed Breakfast work with no terms on its date).
    const terms = world.tables[TABLES.terms].find((t) => t.fields["Amount (Minor Units)"] === 6000)!;
    terms.fields["Effective From"] = "2026-09-20";
    const brk = addOcc(S.breakfast, "2026-09-10");
    b = await parity("Missing commercial terms");
    c1 = caseOf(b, D1);
    ck("LV21. Delivered + confirmed work with no commercial terms on its date -> missing_commercial_terms blocker", codesOf(c1).split(",").includes("missing_commercial_terms") && /Commercial terms need attention/.test(c1.detail));

    // Live: unresolved configuration.
    const bad = addOcc(S.ppa, "2026-09-25", { status: "Rescheduled?" });
    b = await parity("Unresolved configuration");
    ck("LV20. A configuration error in the client's work for the period -> unresolved_configuration blocker", codesOf(caseOf(b, D1)).split(",").includes("unresolved_configuration"));
    ck("BL5b. Five blockers -> still one case, count 5, deduplicated plain labels", caseOf(b, D1)?.context.blockerCount === 5 && caseOf(b, D1).context.blockerSummary.split("; ").length === 5);

    // ----- fix them one by one through the REAL Finance paths -----
    world.tables[BILLING_TABLES.occurrences].find((o) => o.fields["Occurrence ID"] === bad)!.fields.Status = "Cancelled";
    b = await parity("Configuration fixed (occurrence cancelled)");
    ck("AR33a. Fix the configuration at source -> that blocker disappears, the case stays (others remain), same key", !codesOf(caseOf(b, D1)).includes("unresolved_configuration") && caseOf(b, D1)?.caseKey === keyOf(D1));

    const ex = await DW({ route: "draft.terms_exception", draftId: D1, occurrenceIds: [brk], reason: "Breakfast pricing agreed separately - leave off this invoice" });
    b = await parity("Approved missing-terms exception");
    const fAfter = await readF(D1);
    ck("LV22. Approved draft-specific omission (F5 route) -> missing_commercial_terms clears; F5 shows it as a warning only", ex.httpStatus === 200 && !codesOf(caseOf(b, D1)).includes("missing_commercial_terms") && fAfter.body.review.warnings.some((w: any) => w.code === "missing_terms_exception_approved"));
    ck("BL3. Informational (approved exception, approvedExceptions list) never raises anything by itself", !caseOf(b, D1) || !/terms/i.test(caseOf(b, D1).context.blockerSummary));

    const rf = await DW({ route: "draft.refresh", draftId: D1, reason: null });
    b = await parity("Draft refreshed through F5");
    ck("AR33b / LV18b. Proper Finance refresh -> source_changed clears (Needs Attention never refreshes)", rf.httpStatus === 200 && !codesOf(caseOf(b, D1)).includes("source_changed"));

    await clientUpdate(ids.parkside, '{"client":{"billingEmail":"billing.parkside@test.invalid"}}');
    b = await parity("Billing email restored");
    ck("AR33c. Billing email added back -> that blocker clears; PO still blocks; same case", codesOf(caseOf(b, D1)) === "po_missing" && caseOf(b, D1).caseKey === keyOf(D1));

    await details(D1, '{"poNumber":"PO-ZZTEST-F8B-1"}');
    b = await parity("PO supplied");
    ck("AR33d / ST13b. PO supplied through F5 -> last blocker gone -> the case disappears automatically", !caseOf(b, D1) && draftCases(b).length === 0);

    await details(D1, '{"poNumber":null}');
    b = await parity("PO cleared again");
    ck("AR34. Blocker returns -> the case returns with the same key", caseOf(b, D1)?.caseKey === keyOf(D1));
    await details(D1, '{"poOverrideReason":"School confirmed no PO this term"}');
    b = await parity("PO override recorded");
    const fOv = await readF(D1);
    ck("ST13c / BL2. A recorded PO override is an F5 warning, not a blocker -> no case", !caseOf(b, D1) && fOv.body.review.warnings.some((w: any) => w.code === "po_override_recorded"));

    // ----- warnings only: excluded work + billing override + inactive client -----
    const s2 = addOcc(S.stannes, "2026-09-11");
    await DW({ route: "draft.refresh", draftId: D2, reason: null });
    const l2 = (await readF(D2)).body.lines.find((l: any) => l.occurrenceId === s2);
    await DW({ route: "line.exclude", draftId: D2, lineId: l2.lineId, reason: "Bill next month" });
    await clientUpdate(ids.stannes, '{"client":{"status":"inactive"}}');
    b = await parity("Warnings only");
    const fw = (await readF(D2)).body.review;
    ck("BL2b. Warning-only conditions (excluded work, inactive client) never raise ATT-048", !caseOf(b, D2) && fw.warnings.some((w: any) => w.code === "excluded_work") && fw.warnings.some((w: any) => w.code === "client_inactive") && fw.blockers.length === 0);

    // ----- stored: no included lines, totals, payment terms, manual billing, duplicate claim -----
    const l1 = (await readF(D2)).body.lines.find((l: any) => l.occurrenceId === s1 && l.status === "included");
    await DW({ route: "line.exclude", draftId: D2, lineId: l1.lineId, reason: "Bill next month too" });
    b = await parity("No included lines");
    ck("ST16. Every line excluded -> no_included_lines blocker", codesOf(caseOf(b, D2)) === "no_included_lines" && /Nothing to invoice/.test(caseOf(b, D2).detail));
    await DW({ route: "line.restore", draftId: D2, lineId: l1.lineId, reason: null });
    b = await parity("Line restored");
    ck("AR33e. Line restored -> case gone", !caseOf(b, D2));

    const set = world.tables["Finance Settings"][0];
    world.tables["Finance Settings"] = [settingsRow({ ...SETTINGS, defaultPaymentTermsDays: null })];
    await details(D2, '{"paymentTermsDays":null}');
    b = await parity("Payment terms missing");
    ck("ST14. No client terms and no Finance Settings default -> payment_terms_missing blocker", codesOf(caseOf(b, D2)) === "payment_terms_missing" && /Payment terms missing/.test(caseOf(b, D2).detail));
    await details(D2, '{"paymentTermsDays":14}');
    world.tables["Finance Settings"] = [set];
    b = await parity("Payment terms set on the invoice");
    ck("ST14b. Terms set on the invoice -> blocker gone (F5 warning payment_terms_overridden only)", !caseOf(b, D2));

    const dr2 = draftRow(D2);
    const keepGross = dr2.fields[FI.draft.gross];
    dr2.fields[FI.draft.gross] = keepGross + 1;
    b = await parity("Totals tampered");
    ck("ST15. Stored totals that do not reconcile -> totals_do_not_reconcile blocker", codesOf(caseOf(b, D2)) === "totals_do_not_reconcile" && /Invoice totals need review/.test(caseOf(b, D2).detail));
    dr2.fields[FI.draft.gross] = keepGross;

    await clientUpdate(ids.stannes, '{"client":{"billingMethod":"manual"}}');
    b = await parity("Client switched to manual billing");
    ck("ST17. Client switched to Manual billing after drafting -> manual_billing_client blocker (F5 GR7 semantics)", codesOf(caseOf(b, D2)) === "manual_billing_client" && /billed manually/.test(caseOf(b, D2).detail));
    await clientUpdate(ids.stannes, '{"client":{"billingMethod":"hub"}}');
    b = await parity("Client back to Hub billing");
    ck("ST17b. Back to Hub billing -> case gone", !caseOf(b, D2));

    // Duplicate claim: a second Included line elsewhere claims D2's occurrence (stored-data defect).
    const src = world.tables[INVOICING_TABLES.lines].find((r) => r.fields[FI.line.draftId] === D2 && r.fields[FI.line.occurrenceId] === s1 && (r.fields[FI.line.status]?.name ?? r.fields[FI.line.status]) === "Included")!;
    world.tables[INVOICING_TABLES.lines].push({ id: "recDupLine0000001", fields: { ...src.fields, [FI.line.id]: "FIL-DDDDDDDDDDDD", [FI.line.draftId]: D1 } });
    b = await parity("Duplicate claim");
    ck("LV19. Work already Included on another draft -> duplicate_claim blocker (on both drafts, as F5 says)", codesOf(caseOf(b, D2)).includes("duplicate_claim") && codesOf(caseOf(b, D1)).includes("duplicate_claim") && /already on another invoice/.test(caseOf(b, D2).detail));
    ck("ID24. Two blocked drafts -> two distinct cases", draftCases(b).length === 2 && new Set(draftCases(b).map((c: any) => c.caseKey)).size === 2);
    world.tables[INVOICING_TABLES.lines] = world.tables[INVOICING_TABLES.lines].filter((r) => r.id !== "recDupLine0000001");
    b = await parity("Duplicate removed");

    // ----- lifecycle: Ready / issued / awaiting external issue -----
    const rd = await DW({ route: "draft.ready", draftId: D2, revision: (await readF(D2)).body.draft.revision, reason: null });
    await ovCreate(s1, '{"override":{"kind":"not_billable"},"reason":"after Ready"}');
    b = await parity("Ready draft whose source then changed");
    const fr = (await readF(D2)).body;
    ck("LC8. Ready for issue -> never a case, even when Finance's review of it now shows a blocker", rd.httpStatus === 200 && fr.draft.status === "ready_for_issue" && fr.review.blockers.length > 0 && !caseOf(b, D2));
    const d1r = draftRow(D1);
    d1r.fields[FI.draft.status] = "Ready for issue";
    d1r.fields[FI.draft.issuedInvoiceId] = "FIV-0000000000AA";
    d1r.fields[FI.draft.readyBy] = MGR;
    d1r.fields[FI.draft.readyAt] = NOW.toISOString();
    d1r.fields[FI.draft.poNumber] = "PO-X";
    b = await parity("Issued draft");
    ck("LC9 / LC10. Issued (Hub) or handed to Xero (awaiting external issue) - the draft carries Issued Invoice ID -> never a case", !caseOf(b, D1) && draftCases(b).length === 0);
    ck("LC11. F5 has no cancelled / superseded DRAFT state: Draft vs Ready vs issued is the whole lifecycle (replacement drafts are open drafts, reviewed through their correction scope by the same code)", !/cancel/i.test(readFileSync(join(FUNCS, "finance", "finance-invoicing.ts"), "utf8").match(/DRAFT_STATUSES = \[[^\]]*\]/)![0]));
  }

  // ===== AC / SET / snooze =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const D = (await create(ids.parkside)).body.draft.draftId as string; // po_missing
    const fin = Object.values(world.tables).length;
    let b = await na("none");
    ck("AC25. No Finance access -> no case, no count, no Finance table read, skipped finance_access_required", draftCases(b).length === 0 && b.summary.total === 0 && DRAFT_BLOCKED_SOURCES.filter((t) => t !== "Sessions" && t !== "Session Occurrences").every((t) => listsOf(t) === 0) && b.diagnostics.skipped.some((s: any) => s.ruleKey === "invoice_draft_blocked" && s.reason === "finance_access_required") && !JSON.stringify(b).includes(D) && fin > 0);
    const lk = await na("none", { caseKey: keyOf(D) });
    ck("AC29a. No access: caseKey lookup -> exists:false, case null", lk.exists === false && lk.case === null);
    const cx = await createException(ndeps("none"), MANAGER, { caseKey: keyOf(D), reason: "snooze" }, NOW);
    ck("AC29b. No access: create exception -> 404 case_not_found (existence never confirmed), nothing written", cx.status === "rejected" && cx.httpStatus === 404 && (cx as any).code === "case_not_found" && world.tables[CONFIG_TABLES.exceptions].length === 0);
    b = await na("view");
    ck("AC26. Finance View -> sees the case", caseOf(b, D)?.caseKey === keyOf(D) && accessCalls === 1);
    ck("AC27a. Finance View -> exceptionAllowed false", caseOf(b, D)?.exceptionAllowed === false);
    const cv = await createException(ndeps("view"), MANAGER, { caseKey: keyOf(D), reason: "snooze" }, NOW);
    ck("AC27b. Finance View cannot snooze -> 403 finance_manage_required", cv.status === "rejected" && cv.httpStatus === 403 && (cv as any).code === "finance_manage_required" && world.tables[CONFIG_TABLES.exceptions].length === 0);
    const draftBefore = JSON.stringify(world.tables[INVOICING_TABLES.drafts]);
    const linesBefore = JSON.stringify(world.tables[INVOICING_TABLES.lines]);
    const auditBefore = world.audit.length;
    const cm = await createException(ndeps("manage"), MANAGER, { caseKey: keyOf(D), reason: "Waiting for the school's PO", effectiveUntil: "2026-10-05T09:00:00Z" }, NOW);
    calls = [];
    b = await na("manage");
    ck("AC28. Finance Manage snoozes the exact case -> 201, suppressed, summary.suppressed 1", cm.status === "ok" && cm.httpStatus === 201 && !caseOf(b, D) && b.summary.suppressed === 1 && b.diagnostics.suppressedCases[0].caseKey === keyOf(D));
    const fstill = (await readF(D)).body.review.blockers.map((x: any) => x.code).join();
    ck("AR35. Snooze never changes Finance: draft + lines rows identical, no Finance audit, F5 review still blocked", JSON.stringify(world.tables[INVOICING_TABLES.drafts]) === draftBefore && JSON.stringify(world.tables[INVOICING_TABLES.lines]) === linesBefore && world.audit.length === auditBefore && fstill === "po_missing");
    const excId = (cm as any).body.exception.exceptionId;
    const rv = await revokeException(ndeps("view"), MANAGER, { exceptionId: excId, reason: "no" }, NOW);
    ck("AC27c. Finance View cannot revoke it -> 403 finance_manage_required", rv.status === "rejected" && rv.httpStatus === 403);
    const rn = await revokeException(ndeps("none"), MANAGER, { exceptionId: excId, reason: "no" }, NOW);
    ck("AC29c. No access cannot even see it -> revoke 404 exception_not_found", rn.status === "rejected" && rn.httpStatus === 404 && (rn as any).code === "exception_not_found");
    const NOW0 = NOW;
    NOW = new Date("2026-10-06T12:00:00.000Z");
    b = await na("manage");
    ck("AR35b. After the snooze expires, the still-blocked draft's case returns (same key)", caseOf(b, D)?.caseKey === keyOf(D));
    NOW = NOW0;

    world.tables[CONFIG_TABLES.settings] = [];
    b = await na("manage");
    ck("SET30. ATT-048 OFF (Default Enabled No, no Settings row) -> skipped disabled, no case, no Finance draft table read, no access lookup", !caseOf(b, D) && b.diagnostics.skipped.some((s: any) => s.ruleKey === "invoice_draft_blocked" && s.reason === "disabled") && listsOf(INVOICING_TABLES.drafts) === 0 && accessCalls === 0);
    world.tables[CONFIG_TABLES.settings] = [enable048(true)];
    b = await na("manage");
    ck("SET31. Enabled by Settings -> the case appears", !!caseOf(b, D) || b.summary.suppressed === 1);
    const before = JSON.stringify(world.tables[INVOICING_TABLES.drafts]);
    world.tables[CONFIG_TABLES.settings] = [enable048(false)];
    b = await na("manage");
    ck("SET32. Disabled again -> gone (settings_disabled) without any Finance change", !caseOf(b, D) && b.diagnostics.skipped.some((s: any) => s.ruleKey === "invoice_draft_blocked" && s.reason === "settings_disabled") && JSON.stringify(world.tables[INVOICING_TABLES.drafts]) === before && naWrites().length === 0);
  }

  // ===== PF: bounded reads =====
  {
    const ids = await seed();
    const clients: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = (await W_({ route: "clients.create", client: { name: `ZZTEST F8B Bulk ${i}`, billingEmail: `b${i}@test.invalid`, poRequired: true }, reason: null })).body.client.clientId as string;
      const svc = (await W_({ route: "services.create", clientId: c, name: "PPA", initial: { effectiveFrom: "2026-09-01", input: PPA }, reason: null })).body.service.serviceId as string;
      const rec = `recSessBLK${String(i).padStart(7, "0")}`;
      addSession(rec, `BULK-${i}`, svc);
      for (const d of ["2026-09-08", "2026-09-15", "2026-09-22"]) addOcc(rec, d);
      clients.push(c);
    }
    for (const c of clients) await create(c);
    const r0 = draftReviewPassStats().runs;
    const b = await na("manage");
    const gets = naGets();
    const perTable = new Map<string, number>();
    for (const g of gets) perTable.set(g.table!, (perTable.get(g.table!) ?? 0) + 1);
    ck("PF36. 12 blocked drafts -> 12 cases; every table listed exactly once (no per-draft read)", draftCases(b).length === 12 && [...perTable.values()].every((n) => n === 1) && DRAFT_BLOCKED_SOURCES.every((t) => perTable.get(t) === 1), JSON.stringify([...perTable]));
    ck("PF37. One review pass for all drafts; no Finance API call, no grant lookup per draft, no write", draftReviewPassStats().runs === r0 + 1 && calls.filter((c) => c.url.includes("/functions/v1/")).length === 0 && accessCalls === 1 && naWrites().length === 0 && calls.filter((c) => !c.url.startsWith("https://api.airtable.com/")).length === 0);
    ck("PF37b. Read count does not scale with drafts: total lists = config + engine sources, independent of the 12 drafts", gets.length === perTable.size);
    ids.parkside;
  }

  // ===== DQ: malformed Finance data fails loudly =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const D = (await create(ids.parkside)).body.draft.draftId as string;
    draftRow(D).fields[FI.draft.status] = "Sent?";
    const b = await na("manage");
    ck("DQ. A malformed draft row of this organisation -> complete:false + evaluator_error; no partial ATT-048 list", draftCases(b).length === 0 && b.complete === false && b.configIssues.some((i: any) => i.code === "evaluator_error" && i.ruleKey === "invoice_draft_blocked"));
  }

  // ===== EDGE: every input F5's loadClientWork() builds, built the same way (parity after each) =====
  {
    const ids = await seed();
    const p1 = addOcc(S.ppa, "2026-09-10");
    const s1 = addOcc(S.stannes, "2026-09-10");
    const R = (await create(ids.parkside)).body.draft.draftId as string;
    await details(R, '{"poNumber":"PO-ZZTEST-EDGE"}');
    const D2 = (await create(ids.stannes)).body.draft.draftId as string;
    await parity("EDGE baseline");
    // Period window: configuration errors just OUTSIDE the period are not this draft's work.
    addOcc(S.stannes, "2026-08-31", { status: "Rescheduled?" });
    addOcc(S.stannes, "2026-10-01", { status: "Rescheduled?" });
    let b = await parity("Out-of-period occurrences (both sides)");
    ck("ED1. Work outside the draft period never blocks it (inclusive Period From / To window, as F5)", !caseOf(b, D2));
    // A Session whose Session ID is malformed is not read by F5 (its occurrences are not the client's work).
    addSession("recSessBAD0000001", "BAD ID!", ids.sa);
    addOcc("recSessBAD0000001", "2026-09-12", { status: "Rescheduled?" });
    b = await parity("Session with a malformed Session ID");
    ck("ED2. Occurrences of a Session with a malformed Session ID are ignored, exactly as F5 ignores them", !caseOf(b, D2));
    // Finance Service ID is matched after trimming (F5 re-check in code).
    addSession("recSessTRM0000001", "TEST-TRIM", ids.sa + " ");
    const trim = addOcc("recSessTRM0000001", "2026-09-13", { status: "Rescheduled?" });
    b = await parity("Finance Service ID with trailing space");
    ck("ED3. A Session whose Finance Service ID differs only by whitespace is the client's (F5 trims) -> its configuration error blocks", codesOf(caseOf(b, D2)) === "unresolved_configuration");
    world.tables[BILLING_TABLES.occurrences] = world.tables[BILLING_TABLES.occurrences].filter((o) => o.fields["Occurrence ID"] !== trim);
    // An occurrence linked to two Sessions resolves with no Session (F5: exactly one link or none).
    world.tables[BILLING_TABLES.occurrences].push({ id: "recOccMULTI000001", fields: { "Occurrence ID": `${S.stannes}:2026-09-14`, Session: [S.stannes, S.ppa], Date: "2026-09-14", "Start Date & Time": "2026-09-14T14:30:00.000Z", "End Date & Time": "2026-09-14T15:30:00.000Z", Status: "Scheduled", "Confirmation State": "Confirmed" } });
    b = await parity("Occurrence linked to two Sessions");
    ck("ED4. An occurrence linked to two Sessions is a configuration problem for the client's draft (F4 occurrenceFacts: exactly one Session expected), as F5 says", codesOf(caseOf(b, D2)).split(",").includes("unresolved_configuration"));
    world.tables[BILLING_TABLES.occurrences] = world.tables[BILLING_TABLES.occurrences].filter((o) => o.id !== "recOccMULTI000001");
    // Another organisation's draft line never counts (and never breaks the pass).
    const own = world.tables[INVOICING_TABLES.lines].find((r) => r.fields[FI.line.draftId] === D2)!;
    world.tables[INVOICING_TABLES.lines].push({ id: "recForeignLine001", fields: { ...own.fields, Organisation: ["recOtherOrgRow001"], [FI.line.id]: "FIL-FFFFFFFFFFFF", [FI.line.draftId]: "FID-FFFFFFFFFFFF" } });
    b = await parity("Another organisation's line claiming the same occurrence");
    ck("ED5. Another organisation's rows are invisible: no duplicate claim, evaluation complete", !caseOf(b, D2) && b.complete === true);
    world.tables[INVOICING_TABLES.lines] = world.tables[INVOICING_TABLES.lines].filter((r) => r.id !== "recForeignLine001");
    // An ISSUED invoice line claiming the occurrence is a claim too (F6 hook).
    const ownLine = buildLines([own] as any, ORG_REC) as any;
    const l = ownLine.lines[0].value;
    world.tables[ISSUE_TABLES.lines].push({ id: "recIssuedLine0001", fields: invoiceLineCreateFields({ ...l, lineId: "FVL-EEEEEEEEEEEE", invoiceId: "FIV-EEEEEEEEEEEE", sequence: 1, sourceDraftId: "FID-EEEEEEEEEEEE", sourceDraftLineId: "FIL-EEEEEEEEEEEE", createdBy: MGR, createdAt: NOW.toISOString() } as any, ORG_REC) });
    b = await parity("Issued invoice line claims the same occurrence");
    ck("ED6. Work already on an ISSUED invoice blocks the draft (duplicate_claim)", codesOf(caseOf(b, D2)) === "duplicate_claim");
    world.tables[ISSUE_TABLES.lines] = [];
    // Replacement draft: reviewed only through its correction scope.
    addOcc(S.ppa, "2026-09-20", { status: "Rescheduled?" });
    const rr = draftRow(R);
    rr.fields[FI.draft.replacesInvoiceId] = "FIV-RRRRRRRRRRRR".replace(/R/g, "A");
    rr.fields[FI.draft.correctionId] = "FCN-AAAAAAAAAAAA";
    rr.fields[FI.draft.correctionScope] = JSON.stringify({ correctionId: "FCN-AAAAAAAAAAAA", invoiceId: "FIV-AAAAAAAAAAAA", occurrenceIds: [p1], releasedDraftIds: ["FID-0000000000AA"] });
    b = await parity("Replacement draft with a correction scope");
    const fR = await readF(R);
    ck("ED7. A replacement draft is reviewed through its correction scope: the client's other work (here a configuration error) does not block it", fR.status === "ok" && fR.body.draft.replacement !== null && !caseOf(b, R) && b.complete === true);
    world.tables[INVOICING_TABLES.drafts].forEach((d) => { if (d.fields[FI.draft.id] === R) { delete d.fields[FI.draft.replacesInvoiceId]; delete d.fields[FI.draft.correctionId]; delete d.fields[FI.draft.correctionScope]; } });
    b = await parity("Same draft without its correction scope");
    ck("ED7b. ...and without the scope the same draft IS blocked by that configuration error (the scope is what changed the answer)", codesOf(caseOf(b, R)) === "unresolved_configuration");
    s1;
  }

  // ===== DQ2: Finance data that makes F5's own review fail -> loud, never a guess =====
  {
    const ids = await seed();
    addOcc(S.ppa, "2026-09-10");
    const D = (await create(ids.parkside)).body.draft.draftId as string;
    world.tables["Finance Settings"].push({ ...world.tables["Finance Settings"][0], id: "recSettingsRow002" });
    let b = await na("manage");
    const f1 = await readF(D);
    ck("DQ2. Two Finance Settings rows: F5 refuses to review (409) and ATT-048 is incomplete (evaluator_error), never partial", f1.status === "error" && f1.httpStatus === 409 && b.complete === false && draftCases(b).length === 0 && b.configIssues.some((i: any) => i.code === "evaluator_error" && i.ruleKey === "invoice_draft_blocked"));
    world.tables["Finance Settings"].pop();
    for (const r of world.tables[TABLES.lifecycle]) r.fields["Effective From"] = "2026-10-15";
    b = await na("manage");
    const f2 = await readF(D);
    ck("DQ3. A service with no lifecycle period covering today: F5 refuses (409) and ATT-048 is incomplete", f2.status === "error" && f2.httpStatus === 409 && b.complete === false && draftCases(b).length === 0);
  }

  // ===== DR: drift =====
  {
    const canon = (rel: string) => readFileSync(join(FUNCS, rel), "utf8");
    const mine = canon("needs-attention/finance-drafts.ts");
    const blocks = mine.split(/\/\/ ===== COPIED FROM ([^ ]+) - DO NOT EDIT HERE =====\n/).slice(1);
    const verify: { file: string; missing: string[] }[] = [];
    for (let i = 0; i < blocks.length; i += 2) {
      const body = blocks[i + 1].split("// ===== END COPIED BLOCK =====")[0];
      const target = canon(blocks[i]);
      const missing = body.split(/\n\n+/).map((c) => c.trim()).filter(Boolean).filter((c) => !target.includes(c));
      verify.push({ file: blocks[i], missing });
    }
    ck("DR1. Copied blocks (lifecycleHistory, serviceFinder) appear verbatim in their Finance orchestrators", verify.length === 2 && verify.map((v) => v.file).join() === "finance/finance-commercial-orchestrator.ts,finance/finance-billing-orchestrator.ts" && verify.every((v) => v.missing.length === 0), JSON.stringify(verify));
    const f5 = canon("finance/finance-invoicing.ts");
    const review = f5.slice(f5.indexOf("export function reviewDraft("), f5.indexOf("export function publicDraft("));
    const blockerCodes = [...review.matchAll(/\bb\(\{\s*code: "([a-z_]+)"/g)].map((m) => m[1]).sort();
    const warningCodes = [...review.matchAll(/\bw\(\{\s*code: "([a-z_]+)"/g)].map((m) => m[1]).sort();
    ck("DR2. Every F5 review BLOCKER code has plain wording here - and nothing else does (no warning is labelled)", blockerCodes.length === 11 && blockerCodes.join() === Object.keys(BLOCKER_LABELS).sort().join() && warningCodes.every((c) => !(c in BLOCKER_LABELS)), `${blockerCodes} | ${warningCodes}`);
    ck("DR2b. The blocker / warning split is F5's own: 11 blockers, 10 warnings, decided only by reviewDraft (no blocker list re-implemented here)", warningCodes.length === 10 && !/po_missing|billing_email_missing|"source_changed"/.test(mine.replace(/BLOCKER_LABELS[\s\S]*?\};/, "")));
    const imports = [...mine.matchAll(/from "\.\.\/finance\/([a-z-]+\.ts)"/g)].map((m) => m[1]);
    const script = readFileSync(join(HERE, "..", "..", "scripts", "build-needs-attention-bundle.mjs"), "utf8");
    const allow = [...script.slice(script.indexOf("SHARED_FINANCE_FILES = ["), script.indexOf("];", script.indexOf("SHARED_FINANCE_FILES = ["))).matchAll(/"([a-z-]+\.ts)"/g)].map((m) => m[1]);
    ck("DR3. The evaluator imports only allowlisted pure Finance modules (bundled at build time)", imports.length > 0 && imports.every((f) => allow.includes(f)) && allow.every((f) => !/orchestrator|repository|index/.test(f)));
    const sharedCode = allow.map((f) => canon(`finance/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
    ck("DR4. Every shared Finance module is pure: no fetch, no Deno, no Supabase client", sharedCode.every((c) => !/\bfetch\(|Deno\.|createClient/.test(c)));
    const code = mine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("DR5. finance-drafts.ts is read-only: no fetch, no write method, no Deno, no runtime URL import", !/\bfetch\(|method:\s*["'`](POST|PATCH|PUT|DELETE)|Deno\.|https?:\/\//.test(code));
    ck("DR6. Registered as ATT-048 invoice_draft_blocked, alongside ATT-047; no other Finance rule implemented", IMPLEMENTED_EVALUATORS.filter((e) => /^ATT-0(2[456]|34|47|48)$/.test(e.ruleId)).map((e) => e.ruleKey).sort().join() === "invoice_draft_blocked,invoice_overdue");
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? "  " + e : ""}`);
  const pass = R.filter((r) => r[0] === "PASS").length;
  console.log(`\nneeds-attention-finance-drafts: ${pass}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
