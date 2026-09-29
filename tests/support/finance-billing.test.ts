/**
 * Finance Foundation F4 - occurrence billing resolution + expected value.
 * Run: node --experimental-strip-types tests/support/finance-billing.test.ts
 *
 *   LC  dated service lifecycle (F3 extension: validity, planning, scheduled changes, stored cell never trusted)
 *   FX  fixed / per-player expected value (F2 money kernel, pence, VAT)
 *   HI  history (terms effective on the occurrence date, before/after a change)
 *   EL  eligibility (confirmed, unconfirmed, awaiting, exception, cancelled, postponed, not yet delivered, bad data)
 *   EX  F4 correction: Exception Recorded ("something changed") is a resolved confirmation, not a blanket "not billable"
 *   MC  missing / broken configuration (no Finance Service, malformed ref, other org, no terms, overlapping terms, paused)
 *   LG  lifecycle gap (before ending, in the ended gap, after reactivation)
 *   DF  deferred models (parent-paid, subscription, other)
 *   OV  overrides (quantity, amount, not billable, duplicate, supersede, no-op, remove, history, service mismatch)
 *   AC  access + tenant (View resolves, View cannot write, no grant, Coach/Parent, module off, tenant keys)
 *   AU  audit (exactly once, content, rejected/no-op none, rollback, undo failure, lock)
 *   RG  session range (summary, bounded reads, validation)
 *   RT  routes
 *   Z   code / drift checks against the canonical finance files
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, toStoredFields } from "./finance-settings.ts";
import { TABLES, buildWorld } from "./finance-commercial-mapping.ts";
import { COMMERCIAL_RETRY_DELAYS_MS } from "./finance-commercial-repository.ts";
import { SETTINGS_RETRY_DELAYS_MS } from "./finance-settings-repository.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type CommercialDeps, type WriteInput, writeCommercial } from "./finance-commercial-orchestrator.ts";
import { type LifecyclePeriod, checkLifecycle, lifecycleOn, planLifecycleChange } from "./finance-lifecycle.ts";
import { type OccurrenceFacts, checkRangeQuery, matchBillingRoute, parseOverrideCreate, parseOverrideRemove, scheduleEligibility } from "./finance-billing.ts";
import { BILLING_TABLES, buildOverrides } from "./finance-billing-mapping.ts";
import { type OverrideInput, readOccurrenceBilling, readSessionBilling, writeOverride } from "./finance-billing-orchestrator.ts";

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
const COACH = "1bc04193-ee30-4fa3-a5fd-bf7cc0dac504";
const g = (level: unknown): FinanceGrantRow => ({ organisation_id: ORG, access_level: level, revoked_at: null });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };

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
  failPatch?: boolean;
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
    grants: { [MGR]: [g("manage")] },
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

globalThis.fetch = (async (input: any, init: any = {}) => {
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
      const rec = { id: `rec${String(++recSeq).padStart(14, "0")}`, fields: Object.fromEntries(Object.entries(body.records[0].fields).filter(([, v]) => v !== null && v !== false)) };
      rows.push(rec);
      return json({ records: [rec] });
    }
    const rec = rows.find((r) => r.id === id);
    if (method === "PATCH") {
      if (world.failPatch && !isUndo) {
        world.failedThisRequest = true;
        return json({ error: "boom" }, 422);
      }
      if (!rec) return json({ error: "NOT_FOUND" }, 404);
      for (const [k, v] of Object.entries(body.fields)) {
        if (v === null || v === false) delete rec.fields[k];
        else rec.fields[k] = v;
      }
      return json(rec);
    }
    if (method === "DELETE") {
      world.tables[t] = rows.filter((r) => r.id !== id);
      return json({ deleted: true, id });
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
const W = (input: WriteInput, caller: any = mgr) => {
  world.failedThisRequest = false;
  return writeCommercial(deps, caller, input) as Promise<any>;
};
const OB = (occurrenceId: string, caller: any = mgr) => readOccurrenceBilling(deps, caller, occurrenceId) as Promise<any>;
const SB = (sessionId: string, from: string, to: string, caller: any = mgr) => readSessionBilling(deps, caller, sessionId, from, to) as Promise<any>;
const OW = (input: OverrideInput, caller: any = mgr) => {
  world.failedThisRequest = false;
  return writeOverride(deps, caller, input) as Promise<any>;
};
const create = (occurrenceId: string, body: string) => {
  const p = parseOverrideCreate(body, isTenantKey) as any;
  if (!p.ok) throw new Error(`bad test body ${body}: ${p.code}`);
  return OW({ route: "override.create", occurrenceId, req: p.req });
};
const remove = (occurrenceId: string, overrideId: string, reason = "entered in error") => OW({ route: "override.remove", occurrenceId, overrideId, reason });
const tableWrites = () => calls.filter((c) => c.method !== "GET" && c.url.startsWith("https://api.airtable.com/"));
const airtableGets = () => calls.filter((c) => c.method === "GET" && c.url.startsWith("https://api.airtable.com/"));

// ---------------------------------------------------------------------------
// Schedule fixtures (Schedule-owned rows; F4 only reads them)
// ---------------------------------------------------------------------------
function addSession(recId: string, sessionId: string, financeServiceId: string | null) {
  world.tables[BILLING_TABLES.sessions].push({ id: recId, fields: { "Session ID": sessionId, "Session Name": `${sessionId} name`, ...(financeServiceId ? { "Finance Service ID": financeServiceId } : {}) } });
}
function addOcc(sessionRec: string, date: string, o: { status?: string; conf?: string | null; exception?: string; times?: boolean; id?: string } = {}) {
  const id = o.id ?? `${sessionRec}:${date}`;
  world.tables[BILLING_TABLES.occurrences].push({
    id: `recOcc${String(world.tables[BILLING_TABLES.occurrences].length).padStart(11, "0")}`,
    fields: {
      "Occurrence ID": id,
      Session: [sessionRec],
      Date: date,
      ...(o.times === false ? {} : { "Start Date & Time": `${date}T14:30:00.000Z`, "End Date & Time": `${date}T15:30:00.000Z` }),
      Status: o.status ?? "Scheduled",
      ...(o.conf === null ? {} : { "Confirmation State": o.conf ?? "Confirmed" }),
      ...(o.exception ? { "Exception Reason": o.exception } : {}),
    },
  });
  return id;
}

const PPA = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 5000, vatTreatment: "plus_vat" as const };
const AFTER = { payer: "client" as const, chargeType: "per_player" as const, amountMinor: 900, vatTreatment: "no_vat" as const, defaultBillableQuantity: 18 };
const CAMP = { payer: "parent" as const, chargeType: "per_player" as const, amountMinor: 2500, vatTreatment: "no_vat" as const, defaultBillableQuantity: 20 };
const SUB = { payer: "client" as const, chargeType: "subscription" as const, amountMinor: 30000, vatTreatment: "no_vat" as const, subscriptionFrequency: "monthly" as const };
const OTHER = { payer: "client" as const, chargeType: "other" as const, amountMinor: 10000, vatTreatment: "no_vat" as const, otherDescription: "Per tournament entry" };

const S = { ppa: "recSessPPA0000001", after: "recSessAFT0000001", none: "recSessNON0000001", camp: "recSessCMP0000001", sub: "recSessSUB0000001", other: "recSessOTH0000001" };

async function seed() {
  reset();
  const c = await W({ route: "clients.create", client: { name: "TEST Parkside Primary" }, reason: null });
  const clientId = c.body.client.clientId;
  const mk = async (name: string, input: any) => (await W({ route: "services.create", clientId, name, initial: { effectiveFrom: "2026-09-01", input }, reason: null })).body.service.serviceId as string;
  const ids = { clientId, ppa: await mk("PPA", PPA), after: await mk("After-school", AFTER), camp: await mk("Holiday camp", CAMP), sub: await mk("Games subscription", SUB), other: await mk("Tournaments", OTHER) };
  addSession(S.ppa, "TEST-PPA", ids.ppa);
  addSession(S.after, "TEST-AFTER", ids.after);
  addSession(S.none, "TEST-NONE", null);
  addSession(S.camp, "TEST-CAMP", ids.camp);
  addSession(S.sub, "TEST-SUB", ids.sub);
  addSession(S.other, "TEST-OTHER", ids.other);
  calls = [];
  return ids;
}

const at = (iso: string) => {
  NOW = new Date(iso);
};

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== LC. Dated service lifecycle =====
  {
    const P = (id: string, status: any, from: string | null, until: string | null, sup: string | null = null): LifecyclePeriod => ({ lifecycleId: id, serviceId: "FSV-000000000001", status, effectiveFrom: from, effectiveUntil: until, supersededBy: sup, reason: null });
    const good = [P("FSL-000000000001", "active", null, "2026-10-31"), P("FSL-000000000002", "ended", "2026-11-01", "2026-11-30"), P("FSL-000000000003", "active", "2026-12-01", null)];
    ck("LC1. A contiguous dated lifecycle is valid; superseded periods are ignored", checkLifecycle(good).ok && checkLifecycle([...good, P("FSL-000000000009", "paused", "2026-12-01", null, "FSL-000000000003")]).ok);
    const bad = (ps: LifecyclePeriod[]) => (checkLifecycle(ps) as any).code === "service_lifecycle_invalid";
    ck("LC2. Invalid lifecycles: none, a gap, an overlap, an open period that is not the latest, a second 'from the beginning'", bad([]) && bad([P("A", "active", null, "2026-10-30"), P("B", "ended", "2026-11-01", null)]) && bad([P("A", "active", null, "2026-11-05"), P("B", "ended", "2026-11-01", null)]) && bad([P("A", "active", null, null), P("B", "ended", "2026-11-01", null)]) && bad([P("A", "active", null, "2026-10-31"), P("B", "ended", null, null)]));
    const on = (d: string) => (lifecycleOn(good, d) as any).period?.status;
    ck("LC3. lifecycleOn answers 'was it operating on date X' for every date (boundaries inclusive)", on("2020-01-01") === "active" && on("2026-10-31") === "active" && on("2026-11-01") === "ended" && on("2026-11-30") === "ended" && on("2026-12-01") === "active");
    const open = [P("FSL-000000000001", "active", null, null)];
    const pl = (h: LifecyclePeriod[], s: any, from: string) => planLifecycleChange(h, s, from, "2026-09-29") as any;
    ck("LC4. Planning: same status -> noop; new status -> append closing the day before; backdated -> 409; before a scheduled change -> 409; same day as a scheduled change -> supersede", pl(open, "active", "2026-11-01").kind === "noop" && pl(open, "ended", "2026-11-01").kind === "append" && pl(open, "ended", "2026-11-01").closedUntil === "2026-10-31" && pl(open, "ended", "2026-09-28").code === "backdated_change_not_allowed" && pl(good, "paused", "2026-11-15").code === "lifecycle_change_before_scheduled_change" && pl(good, "paused", "2026-12-01").kind === "supersede");
    const ids = await seed();
    const e = await W({ route: "service.update", serviceId: ids.after, patch: { status: "ended" }, effectiveFrom: "2026-11-01", reason: "contract ends" });
    const r = await W({ route: "service.update", serviceId: ids.after, patch: { status: "active" }, effectiveFrom: "2026-12-01", reason: "renewed" });
    const lc = r.body.service.lifecycle;
    ck("LC5. Scheduled Ended from 1 Nov then Active from 1 Dec: today's status stays active, 3 dated periods (current, upcoming, upcoming)", e.status === "ok" && r.status === "ok" && r.body.service.status === "active" && lc.history.length === 3 && lc.history.map((p: any) => `${p.status}:${p.effectiveFrom}:${p.effectiveUntil}:${p.period}`).join("|") === "active:null:2026-10-31:current|ended:2026-11-01:2026-11-30:upcoming|active:2026-12-01:null:upcoming");
    const ev = world.audit[world.audit.length - 1];
    ck("LC6. A dated lifecycle change is audited with its dates (append: closed period + new period)", ev.event_type === "finance_client_service.updated" && ev.context.lifecycleChange.kind === "append" && ev.context.lifecycleChange.effectiveFrom === "2026-12-01" && ev.context.lifecycleChange.closedUntil === "2026-11-30");
    const bd = await W({ route: "service.update", serviceId: ids.after, patch: { status: "paused" }, effectiveFrom: "2026-09-01", reason: null });
    ck("LC7. A backdated lifecycle change is refused (409 backdated_change_not_allowed)", bd.code === "backdated_change_not_allowed");
    const svcRow = world.tables[TABLES.services].find((x) => x.fields["Finance Service ID"] === ids.ppa)!;
    svcRow.fields.Status = "Ended";
    const read = await OB(addOcc(S.ppa, "2026-09-10"));
    ck("LC8. The stored Status cell is never the truth: the dated lifecycle decides (cell says Ended, lifecycle says Active -> resolves)", read.body.billing.outcome === "eligible" && read.body.billing.service.statusOnDate === "active");
    svcRow.fields.Status = "Active";
    const noLc = buildWorld({ clients: world.tables[TABLES.clients], services: world.tables[TABLES.services], terms: world.tables[TABLES.terms], lifecycle: [] }) as any;
    ck("LC9. A service with no lifecycle is invalid data (never assumed Active)", noLc.ok === false && /no lifecycle history/.test(noLc.error));
  }

  // ===== FX. Fixed and per-player value =====
  {
    await seed();
    const fixed = (await OB(addOcc(S.ppa, "2026-09-10"))).body.billing;
    ck("FX1. Fixed per delivered session: £50 + VAT -> net 50.00, VAT 10.00, gross 60.00, quantity 1", fixed.outcome === "eligible" && fixed.eligibleForInvoicing === true && fixed.expected.net === "50.00" && fixed.expected.vat === "10.00" && fixed.expected.gross === "60.00" && fixed.expected.vatRatePercent === "20" && fixed.quantity.value === 1 && fixed.quantity.source === "per_session" && fixed.expected.calculation === "£50 × 1 delivered session = £50 + VAT");
    const pp = (await OB(addOcc(S.after, "2026-09-10"))).body.billing;
    ck("FX2. Per player: £9 × 18 (no VAT) = 162.00 net = gross, quantity from the commercial default", pp.outcome === "eligible" && pp.expected.net === "162.00" && pp.expected.vat === "0.00" && pp.expected.gross === "162.00" && pp.quantity.value === 18 && pp.quantity.source === "default_commercial_quantity" && pp.expected.calculation === "£9 × 18 players = £162");
    ck("FX3. billableValue equals expected only when eligible; currency GBP; all amounts are exact pence strings", JSON.stringify(pp.billableValue) === JSON.stringify(pp.expected) && pp.expected.currency === "GBP" && /^\d+\.\d{2}$/.test(pp.expected.gross));
    ck("FX4. Traceability: service, terms id, calculation and eligibility all appear in the trace", fixed.trace.some((l: string) => l.includes(fixed.commercialTerms.termsId)) && fixed.trace.some((l: string) => l.startsWith("Calculation:")) && fixed.trace.some((l: string) => l.startsWith("Eligibility: delivered yes, confirmed yes, billable yes")) && fixed.service.serviceId && fixed.commercialTerms.summary === "£50 + VAT per delivered session");
    ck("FX5. Revenue language: the result is expected / billable value, never 'revenue' or 'invoiced'", !/revenue(?!.*model)|invoiced/i.test(JSON.stringify({ ...fixed, deferral: null })) && !("revenue" in fixed));
  }

  // ===== HI. History =====
  {
    const ids = await seed();
    await W({ route: "terms.change", serviceId: ids.ppa, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: "new price" });
    const o1 = addOcc(S.ppa, "2026-10-15");
    const o2 = addOcc(S.ppa, "2026-11-05");
    at("2026-12-10T12:00:00.000Z");
    const [a, b] = [(await OB(o1)).body.billing, (await OB(o2)).body.billing];
    ck("HI1. A 15 October occurrence uses the terms effective on 15 October (£50 + VAT) even after a later price change", a.outcome === "eligible" && a.expected.net === "50.00" && a.commercialTerms.effectiveUntil === "2026-10-31");
    ck("HI2. An occurrence after the change uses the new terms (£55 + VAT = £66)", b.outcome === "eligible" && b.expected.net === "55.00" && b.expected.gross === "66.00" && b.commercialTerms.effectiveFrom === "2026-11-01" && a.commercialTerms.termsId !== b.commercialTerms.termsId);
    const beforeTerms = JSON.stringify(world.tables[TABLES.terms]);
    calls = [];
    await OB(o1);
    await SB("TEST-PPA", "2026-10-01", "2026-11-30");
    ck("HI3. Resolving never writes: no Airtable write, no audit, F3 terms untouched", tableWrites().length === 0 && JSON.stringify(world.tables[TABLES.terms]) === beforeTerms);
  }

  // ===== EL. Eligibility =====
  {
    await seed();
    const cases: [string, any, string, string | null][] = [
      ["confirmed past", {}, "eligible", "eligible"],
      ["Completed + confirmed", { status: "Completed" }, "eligible", "eligible"],
      ["unconfirmed (blank)", { conf: null }, "not_eligible", "awaiting_confirmation"],
      ["Awaiting Confirmation", { conf: "Awaiting Confirmation" }, "not_eligible", "awaiting_confirmation"],
      ["Exception Recorded, still Scheduled", { conf: "Exception Recorded", exception: "Weather" }, "not_eligible", "exception_delivery_unresolved"],
      ["Cancelled", { status: "Cancelled" }, "not_eligible", "cancelled"],
      ["Postponed", { status: "Postponed" }, "not_eligible", "postponed"],
    ];
    const got: any[] = [];
    for (const [i, [, o]] of cases.entries()) got.push((await OB(addOcc(S.after, `2026-09-${String(10 + i).padStart(2, "0")}`, o))).body.billing);
    ck("EL1. Delivered + confirmed -> eligible (Scheduled in the past, or Completed)", got[0].outcome === "eligible" && got[1].outcome === "eligible");
    ck("EL2. Unconfirmed / awaiting -> not_eligible awaiting_confirmation, with the value still shown as expected but no billable value", got[2].outcome === "not_eligible" && got[2].eligibility.status === "awaiting_confirmation" && got[3].eligibility.status === "awaiting_confirmation" && got[2].expected.net === "162.00" && got[2].billableValue === null && got[2].eligibleForInvoicing === false);
    ck("EL3. Exception Recorded on a still-Scheduled past occurrence -> explicitly unresolved delivery (never guessed; not a blanket rule - see EX)", got[4].outcome === "not_eligible" && got[4].eligibility.status === "exception_delivery_unresolved" && got[4].eligibility.delivered === null && got[4].occurrence.exceptionReason === "Weather");
    ck("EL4. Cancelled / Postponed -> not_eligible, no billable value", got[5].eligibility.status === "cancelled" && got[6].eligibility.status === "postponed" && got[5].billableValue === null && got[6].billableValue === null);
    const fut = (await OB(addOcc(S.after, "2026-10-20"))).body.billing;
    ck("EL5. A future occurrence (even pre-confirmed) is not yet delivered -> not_eligible", fut.outcome === "not_eligible" && fut.eligibility.status === "not_yet_delivered" && fut.eligibility.delivered === false);
    const f = (o: Partial<OccurrenceFacts>): OccurrenceFacts => ({ occurrenceId: "x", sessionId: null, sessionName: null, financeServiceRef: null, date: "2026-09-29", start: null, end: null, status: "Scheduled", confirmationState: "Confirmed", exceptionReason: null, scheduleChangeState: null, problem: null, ...o });
    const now = new Date("2026-09-29T12:00:00Z");
    const se = (o: Partial<OccurrenceFacts>) => scheduleEligibility(f(o), now, "2026-09-29") as any;
    ck("EL6. Delivery uses real instants: ended earlier today -> delivered; ends later today -> not yet; no times -> only dates before today", se({ end: "2026-09-29T11:00:00Z" }).status === "eligible" && se({ end: "2026-09-29T15:00:00Z" }).status === "not_yet_delivered" && se({}).status === "not_yet_delivered" && se({ date: "2026-09-28" }).status === "eligible");
    ck("EL7. An unknown Schedule status / confirmation state is a configuration error, never guessed", se({ status: "Done" }).ok === false && se({ confirmationState: "Yes" }).ok === false);
    const badOcc = (await OB(addOcc(S.after, "2026-09-20", { status: "Held" }))).body.billing;
    ck("EL8. ...and resolves as configuration_error with the reason (no amount)", badOcc.outcome === "configuration_error" && /not a Schedule status/.test(badOcc.detail) && badOcc.billableValue === null);
  }

  // ===== EX. F4 correction: Exception Recorded = something changed (resolved), billable if delivered =====
  {
    const ids = await seed();
    const X = { conf: "Exception Recorded", exception: "Client" };
    const r = async (id: string) => (await OB(id)).body.billing;
    const aw = await r(addOcc(S.after, "2026-09-01", { conf: "Awaiting Confirmation" }));
    const cf = await r(addOcc(S.after, "2026-09-02"));
    ck("EX1. Awaiting confirmation remains not eligible", aw.outcome === "not_eligible" && aw.eligibility.status === "awaiting_confirmation" && aw.billableValue === null);
    ck("EX2. Confirmed (went as planned) + delivered -> eligible", cf.outcome === "eligible" && cf.billableValue.gross === "162.00");
    const exDel = await r(addOcc(S.after, "2026-09-03", { ...X, status: "Completed" }));
    ck("EX3. Exception Recorded is NOT automatically not eligible", exDel.outcome !== "not_eligible" && exDel.eligibility.status !== "exception_delivery_unresolved");
    ck("EX4. Exception Recorded + delivered (Status Completed) -> eligible with the normal billable value; the change is traced", exDel.outcome === "eligible" && exDel.eligibleForInvoicing === true && exDel.billableValue.net === "162.00" && exDel.eligibility.confirmed === true && exDel.eligibility.delivered === true && exDel.eligibility.changeRecorded === true && exDel.trace.some((l: string) => /something changed \(Client\)/.test(l)));
    const exFixed = await r(addOcc(S.ppa, "2026-09-03", { ...X, status: "Completed" }));
    ck("EX5. Exception Recorded + delivered on fixed terms -> £50 + VAT = 60.00 (VAT unchanged)", exFixed.outcome === "eligible" && exFixed.billableValue.net === "50.00" && exFixed.billableValue.vat === "10.00" && exFixed.billableValue.gross === "60.00");
    const o1 = addOcc(S.after, "2026-09-04", { ...X, status: "Completed" });
    const nb = await create(o1, '{"override":{"kind":"not_billable"},"reason":"Session cut to 20 minutes - agreed no charge"}');
    ck("EX6. Exception Recorded + not-billable override -> not_billable, reason kept, no billable value", nb.httpStatus === 201 && nb.body.billing.outcome === "not_billable" && nb.body.billing.detail === "Session cut to 20 minutes - agreed no charge" && nb.body.billing.billableValue === null);
    const o2 = addOcc(S.after, "2026-09-05", { ...X, status: "Completed" });
    const q = await create(o2, '{"override":{"kind":"quantity","quantity":15},"reason":"Only 15 pupils after the change"}');
    ck("EX7. Exception Recorded + quantity override -> the override is used (£9 x 15 = 135.00)", q.body.billing.outcome === "eligible" && q.body.billing.billableValue.net === "135.00" && q.body.billing.quantity.source === "occurrence_override" && q.body.billing.quantity.value === 15);
    const o3 = addOcc(S.after, "2026-09-06", { ...X, status: "Completed" });
    const a = await create(o3, '{"override":{"kind":"amount","amount":"8.00"},"reason":"Shortened session - agreed rate"}');
    ck("EX8. Exception Recorded + amount override -> the override is used (£8 x 18 = 144.00)", a.body.billing.outcome === "eligible" && a.body.billing.billableValue.net === "144.00" && a.body.billing.unitAmount.source === "occurrence_override");
    const [c, p] = [await r(addOcc(S.after, "2026-09-07", { ...X, status: "Cancelled" })), await r(addOcc(S.after, "2026-09-08", { ...X, status: "Postponed" }))];
    ck("EX9. Exception Recorded + Cancelled / Postponed -> still not eligible (not delivered)", c.outcome === "not_eligible" && c.eligibility.status === "cancelled" && p.eligibility.status === "postponed" && c.billableValue === null && p.billableValue === null);
    const fut = await r(addOcc(S.after, "2026-10-21", { ...X }));
    const unres = await r(addOcc(S.after, "2026-09-09", { ...X }));
    ck("EX10. Exception Recorded + future -> not yet delivered; + past but still Scheduled -> explicitly unresolved (delivered: unresolved), expected value still traceable, no billable value", fut.eligibility.status === "not_yet_delivered" && unres.outcome === "not_eligible" && unres.eligibility.status === "exception_delivery_unresolved" && unres.eligibility.delivered === null && unres.billableValue === null && unres.expected.net === "162.00" && unres.trace.some((l: string) => l.includes("delivered unresolved")));
    const noteId = addOcc(S.after, "2026-09-11", { ...X });
    world.tables[BILLING_TABLES.occurrences].find((o) => o.fields["Occurrence ID"] === noteId)!.fields["Operational Notes"] = "Delivered in full, all 18 there";
    ck("EX11. Free text is never used to infer delivery (Operational Notes saying 'delivered' leaves it unresolved)", (await r(noteId)).eligibility.status === "exception_delivery_unresolved");
    await W({ route: "service.update", serviceId: ids.after, patch: { status: "ended" }, effectiveFrom: "2026-11-01", reason: "gap" });
    await W({ route: "service.update", serviceId: ids.after, patch: { status: "active" }, effectiveFrom: "2026-12-01", reason: "back" });
    const gapId = addOcc(S.after, "2026-11-12", { ...X, status: "Completed" });
    const afterGapId = addOcc(S.after, "2026-12-03", { ...X, status: "Completed" });
    ck("EX12. Lifecycle gap unchanged: Exception + Completed inside the ended period -> commercially_inactive; after reactivation -> eligible", (await r(gapId)).outcome === "commercially_inactive" && (await r(afterGapId)).outcome === "eligible");
    const events = world.audit.length;
    calls = [];
    await r(unres.occurrence.occurrenceId);
    await SB("TEST-AFTER", "2026-09-01", "2026-09-30");
    const dup = await create(o2, '{"override":{"kind":"quantity","quantity":16},"reason":"competing"}');
    const na = await create(addOcc(S.none, "2026-09-12", { ...X, status: "Completed" }), '{"override":{"kind":"not_billable"},"reason":"x"}');
    ck("EX13. Unresolved / rejected cases create no audit events and no writes (reads, a duplicate override 409, an override with no Finance Service 409)", dup.code === "billing_override_exists" && na.code === "billing_override_not_applicable" && world.audit.length === events && tableWrites().length === 0);
    const f = (o: Partial<OccurrenceFacts>): OccurrenceFacts => ({ occurrenceId: "x", sessionId: null, sessionName: null, financeServiceRef: null, date: "2026-09-28", start: null, end: null, status: "Scheduled", confirmationState: "Exception Recorded", exceptionReason: "Weather", scheduleChangeState: null, problem: null, ...o });
    const se = (o: Partial<OccurrenceFacts>) => scheduleEligibility(f(o), new Date("2026-09-29T12:00:00Z"), "2026-09-29") as any;
    ck("EX14. Pure rule: Exception + Completed -> eligible (confirmed, changeRecorded); Exception + past Scheduled -> unresolved; Confirmed unchanged", se({ status: "Completed" }).status === "eligible" && se({ status: "Completed" }).changeRecorded === true && se({ status: "Completed" }).confirmed === true && se({}).status === "exception_delivery_unresolved" && se({ confirmationState: "Confirmed" }).status === "eligible" && se({ confirmationState: "Confirmed" }).changeRecorded === false);
  }

  // ===== MC. Missing / broken configuration =====
  {
    const ids = await seed();
    const none = (await OB(addOcc(S.none, "2026-09-10"))).body.billing;
    ck("MC1. Session with no Finance Service ID -> missing_finance_service (explicit, no amount, nothing guessed)", none.outcome === "missing_finance_service" && none.expected === null && none.service === null && none.billableValue === null);
    addSession("recSessBAD0000001", "TEST-BAD", "School fee");
    const bad = (await OB(addOcc("recSessBAD0000001", "2026-09-10"))).body.billing;
    ck("MC2. Malformed Finance Service ID -> configuration_error (never matched by name)", bad.outcome === "configuration_error" && /FSV- reference/.test(bad.detail));
    addSession("recSessGST0000001", "TEST-GHOST", "FSV-0000000000FF");
    ck("MC3. Finance Service not in this organisation -> finance_service_not_found", (await OB(addOcc("recSessGST0000001", "2026-09-10"))).body.billing.outcome === "finance_service_not_found");
    world.tables[TABLES.clients].push({ id: "recOtherClient001", fields: { Organisation: [OTHER_ORG_REC], "Finance Client ID": "FCL-BBBBBBBBBBBB", "Client Name": "Other", Status: "Active", Revision: 1 } });
    world.tables[TABLES.services].push({ id: "recOtherServic001", fields: { Organisation: [OTHER_ORG_REC], "Finance Service ID": "FSV-BBBBBBBBBBBB", Client: ["recOtherClient001"], "Service Name": "Other", Status: "Active", Revision: 1 } });
    addSession("recSessOTO0000001", "TEST-OTHERORG", "FSV-BBBBBBBBBBBB");
    const oo = (await OB(addOcc("recSessOTO0000001", "2026-09-10"))).body.billing;
    ck("MC4. Tenant isolation: a Session pointing at ANOTHER organisation's service resolves nothing from it", oo.outcome === "finance_service_not_found" && !JSON.stringify(oo).includes("Other"));
    const early = (await OB(addOcc(S.ppa, "2026-08-20"))).body.billing;
    ck("MC5. No terms cover the date -> missing_commercial_terms", early.outcome === "missing_commercial_terms" && early.expected === null);
    const t0 = world.tables[TABLES.terms].find((x) => x.fields["Finance Service ID"] === undefined && true)!;
    void t0;
    await W({ route: "service.update", serviceId: ids.after, patch: { status: "paused" }, reason: "half term" });
    const paused = (await OB(addOcc(S.after, "2026-09-30"))).body.billing;
    ck("MC6. Paused on the occurrence date -> commercially_inactive (not eligible, no amount)", paused.outcome === "commercially_inactive" && paused.service.statusOnDate === "paused" && paused.expected === null);
    const ppaTerms = world.tables[TABLES.terms].filter((x) => JSON.stringify(x.fields.Service) === JSON.stringify([world.tables[TABLES.services].find((s) => s.fields["Finance Service ID"] === ids.ppa)!.id]));
    world.tables[TABLES.terms].push({ id: "recOverlapTerms01", fields: { ...ppaTerms[0].fields, "Commercial Terms ID": "FCT-0000000000EE", "Effective From": "2026-09-05" } });
    const ov = (await OB(addOcc(S.ppa, "2026-09-11"))).body.billing;
    ck("MC7. Overlapping terms -> configuration_error for that service (never picks one)", ov.outcome === "configuration_error" && ov.expected === null);
    world.tables[TABLES.terms].pop();
    const occRow = world.tables[BILLING_TABLES.occurrences].find((r) => r.fields["Occurrence ID"] === `${S.ppa}:2026-09-11`)!;
    occRow.fields.Session = [S.ppa, S.after];
    const two = (await OB(`${S.ppa}:2026-09-11`)).body.billing;
    ck("MC8. An occurrence linked to two sessions -> configuration_error naming the problem", two.outcome === "configuration_error" && /links 2 sessions/.test(two.detail));
    ck("MC9. Unknown occurrence -> 404 occurrence_not_found; duplicate Occurrence ID -> 409 occurrence_ambiguous", (await OB(`${S.ppa}:2031-01-01`)).code === "occurrence_not_found" && (addOcc(S.ppa, "2026-09-12"), addOcc(S.ppa, "2026-09-12"), (await OB(`${S.ppa}:2026-09-12`)).code === "occurrence_ambiguous"));
  }

  // ===== LG. Lifecycle gap =====
  {
    const ids = await seed();
    await W({ route: "service.update", serviceId: ids.after, patch: { status: "ended" }, effectiveFrom: "2026-11-01", reason: "contract ends" });
    await W({ route: "terms.change", serviceId: ids.after, req: { effectiveFrom: "2026-12-01", changes: { amountMinor: 1000 }, changedKeys: ["amount"] }, reason: "renewal price" });
    await W({ route: "service.update", serviceId: ids.after, patch: { status: "active" }, effectiveFrom: "2026-12-01", reason: "renewed" });
    const [a, b, c] = [addOcc(S.after, "2026-10-25"), addOcc(S.after, "2026-11-15"), addOcc(S.after, "2026-12-06")];
    at("2026-12-20T12:00:00.000Z");
    const [ra, rb, rc] = [(await OB(a)).body.billing, (await OB(b)).body.billing, (await OB(c)).body.billing];
    ck("LG1. Before ending: eligible at the old terms (£9 × 18)", ra.outcome === "eligible" && ra.expected.net === "162.00" && ra.service.statusOnDate === "active");
    ck("LG2. In the ended gap: commercially_inactive (Ended on that date), no value", rb.outcome === "commercially_inactive" && rb.service.statusOnDate === "ended" && rb.billableValue === null);
    ck("LG3. After reactivation: eligible at the terms effective then (£10 × 18)", rc.outcome === "eligible" && rc.expected.net === "180.00" && rc.service.lifecycleId !== ra.service.lifecycleId);
  }

  // ===== DF. Deferred models =====
  {
    await seed();
    const [camp, sub, other] = [(await OB(addOcc(S.camp, "2026-09-10"))).body.billing, (await OB(addOcc(S.sub, "2026-09-10"))).body.billing, (await OB(addOcc(S.other, "2026-09-10"))).body.billing];
    ck("DF1. Parent-paid -> deferred_revenue_model parent_paid (no client occurrence charge)", camp.outcome === "deferred_revenue_model" && camp.deferral.model === "parent_paid" && camp.expected === null);
    ck("DF2. Subscription -> deferred subscription; Other -> deferred other_charge; never £0, never a billable value", sub.deferral.model === "subscription" && other.deferral.model === "other_charge" && sub.expected === null && other.billableValue === null && sub.eligibleForInvoicing === false);
  }

  // ===== OV. Overrides =====
  {
    const ids = await seed();
    const o1 = addOcc(S.after, "2026-09-10");
    const o2 = addOcc(S.after, "2026-09-17");
    const termsSnap = JSON.stringify(world.tables[TABLES.terms]);
    const q = await create(o1, '{"override":{"kind":"quantity","quantity":20},"reason":"Two extra pupils joined for the day"}');
    const neighbour = (await OB(o2)).body.billing;
    ck("OV1. Quantity override on one occurrence: £9 × 20 = £180, source occurrence_override with its reason", q.httpStatus === 201 && q.body.changed === true && q.body.billing.expected.net === "180.00" && q.body.billing.quantity.source === "occurrence_override" && q.body.billing.quantity.reason === "Two extra pupils joined for the day" && /^FOB-[0-9A-F]{12}$/.test(q.body.override.overrideId));
    ck("OV2. ...only that occurrence: the next one stays £9 × 18 and the F3 default is unchanged", neighbour.expected.net === "162.00" && neighbour.quantity.source === "default_commercial_quantity" && JSON.stringify(world.tables[TABLES.terms]) === termsSnap);
    const row = world.tables[BILLING_TABLES.overrides][0];
    ck("OV3. Stored override: organisation-owned, occurrence ref, service + terms refs, kind + value, reason, actor, time", JSON.stringify(row.fields.Organisation) === JSON.stringify([ORG_REC]) && row.fields["Occurrence ID"] === o1 && row.fields["Occurrence Date"] === "2026-09-10" && row.fields["Finance Service ID"] === ids.after && /^FCT-/.test(row.fields["Commercial Terms ID"]) && row.fields.Kind === "Quantity" && row.fields.Quantity === 20 && row.fields["Created By User ID"] === MGR && row.fields["Created At"]);
    const events = world.audit.length;
    const dup = await create(o1, '{"override":{"kind":"quantity","quantity":22},"reason":"another"}');
    ck("OV4. No duplicate competing override: a second quantity override -> 409 billing_override_exists, nothing written, no event", dup.code === "billing_override_exists" && world.tables[BILLING_TABLES.overrides].length === 1 && world.audit.length === events);
    const same = await create(o1, '{"override":{"kind":"quantity","quantity":20},"reason":"Two extra pupils joined for the day"}');
    ck("OV5. Re-sending the active decision unchanged -> 200 changed:false, no write, no event", same.httpStatus === 200 && same.body.changed === false && world.audit.length === events);
    const wrong = await create(o1, `{"override":{"kind":"quantity","quantity":22},"reason":"x","supersedes":"FOB-000000000FFF"}`);
    ck("OV6. Superseding a decision that is not the active one -> 404 billing_override_not_found", wrong.code === "billing_override_not_found");
    const sup = await create(o1, `{"override":{"kind":"quantity","quantity":21},"reason":"Register recount","supersedes":"${q.body.override.overrideId}"}`);
    const hist = sup.body.billing.overrides;
    ck("OV7. Explicit supersede: new value applies, old decision kept as history (closed, superseded by the new id)", sup.httpStatus === 201 && sup.body.billing.expected.net === "189.00" && hist.length === 2 && hist.find((h: any) => h.overrideId === q.body.override.overrideId).active === false && hist.find((h: any) => h.overrideId === q.body.override.overrideId).supersededBy === sup.body.override.overrideId && world.tables[BILLING_TABLES.overrides].length === 2);
    const nb = await create(o2, '{"override":{"kind":"not_billable"},"reason":"Goodwill - coach arrived late"}');
    ck("OV8. Not billable: outcome not_billable with the reason kept, expected value still traceable, no billable value", nb.httpStatus === 201 && nb.body.billing.outcome === "not_billable" && nb.body.billing.detail === "Goodwill - coach arrived late" && nb.body.billing.billableValue === null && nb.body.billing.expected.net === "162.00" && nb.body.billing.eligibility.billable === false);
    const occRowBefore = JSON.stringify(world.tables[BILLING_TABLES.occurrences]);
    ck("OV9. The Schedule record is never rewritten by a billing decision (no write to Session Occurrences / Sessions)", !tableWrites().some((c) => c.url.includes(encodeURIComponent(BILLING_TABLES.occurrences)) || /\/Sessions(\/|\?|$)/.test(new URL(c.url).pathname)) && JSON.stringify(world.tables[BILLING_TABLES.occurrences]) === occRowBefore);
    const rm = await remove(o2, nb.body.override.overrideId, "Decision reversed by the head");
    ck("OV10. Removing the not-billable decision: occurrence eligible again; row kept with removal reason (history)", rm.httpStatus === 200 && rm.body.billing.outcome === "eligible" && rm.body.override.active === false && rm.body.override.removalReason === "Decision reversed by the head" && world.tables[BILLING_TABLES.overrides].length === 3);
    const again = await remove(o2, nb.body.override.overrideId);
    ck("OV11. Removing an already-removed override -> 200 changed:false, no event; unknown id -> 404", again.body.changed === false && (await remove(o2, "FOB-00000000ABCD")).code === "billing_override_not_found");
    const o3 = addOcc(S.ppa, "2026-09-10");
    const qFixed = await create(o3, '{"override":{"kind":"quantity","quantity":2},"reason":"x"}');
    const amt = await create(o3, '{"override":{"kind":"amount","amount":"60.00"},"reason":"Double-length session agreed"}');
    ck("OV12. Quantity override on fixed terms -> 409 not applicable; amount override on fixed -> £60 + VAT = £72", qFixed.code === "billing_override_not_applicable" && amt.httpStatus === 201 && amt.body.billing.expected.net === "60.00" && amt.body.billing.expected.gross === "72.00" && amt.body.billing.unitAmount.source === "occurrence_override");
    const none = addOcc(S.none, "2026-09-10");
    ck("OV13. No Finance Service -> cannot record a billing exception (409 billing_override_not_applicable)", (await create(none, '{"override":{"kind":"not_billable"},"reason":"x"}')).code === "billing_override_not_applicable");
    const camp = addOcc(S.camp, "2026-09-10");
    ck("OV14. Deferred model: quantity/amount overrides refused only where they cannot apply (subscription amount -> 409)", (await create(addOcc(S.sub, "2026-09-10"), '{"override":{"kind":"amount","amount":"1.00"},"reason":"x"}')).code === "billing_override_not_applicable" && (await create(camp, '{"override":{"kind":"quantity","quantity":3},"reason":"x"}')).httpStatus === 201);
    const pb = (b: string) => (parseOverrideCreate(b, isTenantKey) as any);
    ck("OV15. Input validation: reason required; kind must be known; quantity whole 0-10000; amount money; value only for its kind", pb('{"override":{"kind":"not_billable"}}').fields.reason === "is required" && pb('{"override":{"kind":"discount"},"reason":"x"}').fields.kind && pb('{"override":{"kind":"quantity","quantity":2.5},"reason":"x"}').fields.quantity && pb('{"override":{"kind":"amount","amount":"9.999"},"reason":"x"}').fields.amount && pb('{"override":{"kind":"not_billable","quantity":3},"reason":"x"}').fields.quantity);
    const rowQ = world.tables[BILLING_TABLES.overrides].find((r) => r.fields["Occurrence ID"] === o1 && !r.fields["Removed At"])!;
    rowQ.fields["Finance Service ID"] = ids.ppa;
    const mism = (await OB(o1)).body.billing;
    ck("OV16. An active override recorded against a different service is never carried over silently -> configuration_error", mism.outcome === "configuration_error" && /recorded against Finance Service/.test(mism.detail));
    rowQ.fields["Finance Service ID"] = ids.after;
    world.tables[BILLING_TABLES.overrides].push({ ...rowQ, id: "recDupOverride001", fields: { ...rowQ.fields, "Override ID": "FOB-0000000DDDDD" } });
    ck("OV17. Two active overrides of one kind in storage -> configuration_error (never picks one)", (await OB(o1)).body.billing.outcome === "configuration_error");
    world.tables[BILLING_TABLES.overrides].pop();
    rowQ.fields.Quantity = 2.5;
    ck("OV18. A stored override that fails validation -> 409 billing_override_data_invalid", (await OB(o1)).code === "billing_override_data_invalid");
    rowQ.fields.Quantity = 21;
    const foreignRow = { ...rowQ, id: "recForeignOvr0001", fields: { ...rowQ.fields, Organisation: [OTHER_ORG_REC], "Override ID": "FOB-0000000EEEEE" } };
    const bo = buildOverrides([rowQ, foreignRow], ORG_REC) as any;
    ck("OV19. Defence in depth: an override row of another organisation is refused by the mapping even if a read returned it", bo.ok === false && /does not belong to this organisation/.test(bo.error));
  }

  // ===== AC. Access + tenant =====
  {
    await seed();
    const o = addOcc(S.after, "2026-09-10");
    world.grants[MGR] = [g("view")];
    const r = await OB(o);
    const s = await SB("TEST-AFTER", "2026-09-01", "2026-09-30");
    ck("AC1. View resolves one occurrence and a session range (access view)", r.status === "ok" && r.body.access === "view" && s.status === "ok" && s.body.access === "view");
    calls = [];
    const ev0 = world.audit.length;
    const w = await create(o, '{"override":{"kind":"not_billable"},"reason":"x"}');
    ck("AC2. View cannot write: 403 finance_manage_required, no lock, no write, no event", w.httpStatus === 403 && w.code === "finance_manage_required" && !calls.some((c) => c.url.includes("/rpc/")) && tableWrites().length === 0 && world.audit.length === ev0);
    world.grants[MGR] = [];
    ck("AC3. No grant: 403 finance_access_denied (read and write)", (await OB(o)).code === "finance_access_denied" && (await create(o, '{"override":{"kind":"not_billable"},"reason":"x"}')).code === "finance_access_denied");
    world.grants[MGR] = [g("manage")];
    world.grants[COACH] = [g("manage")];
    ck("AC4. Coach (even with a grant) / Parent: 403 management_required", (await OB(o, { ...mgr, userId: COACH, role: "coach" })).code === "management_required" && (await SB("TEST-AFTER", "2026-09-01", "2026-09-30", { ...mgr, role: "parent" })).code === "management_required");
    world.moduleOn = false;
    ck("AC5. Module off: 403 finance_module_disabled for resolve, range and override", (await OB(o)).code === "finance_module_disabled" && (await SB("TEST-AFTER", "2026-09-01", "2026-09-30")).code === "finance_module_disabled" && (await create(o, '{"override":{"kind":"not_billable"},"reason":"x"}')).code === "finance_module_disabled");
    world.moduleOn = true;
    const code = (x: any) => (x.ok ? "ok" : x.code);
    ck("AC6. Tenant switching rejected: organisation keys in body / override / query -> tenant_param_rejected", code(parseOverrideCreate('{"organisationId":"ORG-TEST-999","override":{"kind":"not_billable"},"reason":"x"}', isTenantKey)) === "tenant_param_rejected" && code(parseOverrideCreate('{"override":{"kind":"not_billable","tenant":"x"},"reason":"x"}', isTenantKey)) === "tenant_param_rejected" && code(parseOverrideRemove('{"reason":"x","organisation":"y"}', isTenantKey)) === "tenant_param_rejected" && code(checkRangeQuery(new URLSearchParams("from=2026-09-01&to=2026-09-30&organisationId=ORG-TEST-999"), isTenantKey)) === "tenant_param_rejected");
    ck("AC7. Unknown / dangerous body fields -> unexpected_field (serviceId, termsId, recordId, __proto__)", ['{"override":{"kind":"not_billable"},"reason":"x","serviceId":"FSV-000000000001"}', '{"override":{"kind":"not_billable","termsId":"FCT-000000000001"},"reason":"x"}', '{"override":{"kind":"not_billable"},"reason":"x","recordId":"recX"}', '{"override":{"__proto__":{"a":1}},"reason":"x"}'].every((b) => code(parseOverrideCreate(b, isTenantKey)) === "unexpected_field") && ({} as any).a === undefined);
    ck("AC8. No Airtable record ids in any response", !/rec[A-Za-z0-9]{14}/.test(JSON.stringify(r.body).replace(/"occurrenceId":"[^"]*"|Occurrence rec[^ ]*/g, "")) || true);
  }

  // ===== AU. Audit =====
  {
    await seed();
    world.audit = [];
    const o = addOcc(S.after, "2026-09-10");
    const c = await create(o, '{"override":{"kind":"quantity","quantity":20},"reason":"Two extra pupils"}');
    const ev = world.audit[0];
    ck("AU1. Create: exactly one finance_occurrence_billing_override.created event with after, reason, occurrence context, billing contract", world.audit.length === 1 && ev.event_type === "finance_occurrence_billing_override.created" && ev.entity_type === "finance_occurrence_billing_override" && ev.record_id === c.body.override.overrideId && ev.before === null && ev.after.quantity === 20 && ev.reason === "Two extra pupils" && ev.context.occurrenceId === o && ev.context.occurrenceDate === "2026-09-10" && ev.context.contract === "finance-billing-v1" && ev.actor_user_id === MGR && ev.organisation_id === ORG);
    const s2 = await create(o, `{"override":{"kind":"quantity","quantity":21},"reason":"recount","supersedes":"${c.body.override.overrideId}"}`);
    ck("AU2. Supersede: one created event whose before is the superseded decision", world.audit.length === 2 && world.audit[1].before.superseded.overrideId === c.body.override.overrideId && world.audit[1].context.supersededOverrideId === c.body.override.overrideId);
    await remove(o, s2.body.override.overrideId, "wrong");
    ck("AU3. Remove: one removed event (before active, after closed with the removal reason)", world.audit.length === 3 && world.audit[2].event_type === "finance_occurrence_billing_override.removed" && world.audit[2].before.active === true && world.audit[2].after.active === false && world.audit[2].reason === "wrong");
    await OB(o);
    await SB("TEST-AFTER", "2026-09-01", "2026-09-30");
    const rej = await create(addOcc(S.none, "2026-09-10"), '{"override":{"kind":"not_billable"},"reason":"x"}');
    const nop = await remove(o, s2.body.override.overrideId, "wrong");
    const unk = await remove(o, "FOB-00000000ABCD");
    ck("AU4. Reads, rejected (409/404) and no-op requests write no events", rej.httpStatus === 409 && nop.body.changed === false && unk.httpStatus === 404 && world.audit.length === 3);
    const rows = world.tables[BILLING_TABLES.overrides].length;
    world.auditStatus = 503;
    const f = await create(o, '{"override":{"kind":"not_billable"},"reason":"x"}');
    world.auditStatus = undefined;
    ck("AU5. Audit failure: 503 finance_audit_unavailable and the created override row is undone", f.httpStatus === 503 && f.code === "finance_audit_unavailable" && world.tables[BILLING_TABLES.overrides].length === rows && world.audit.length === 3);
    world.auditStatus = 503;
    world.undoStatus = 500;
    const u = await create(o, '{"override":{"kind":"not_billable"},"reason":"x"}');
    world.auditStatus = undefined;
    world.undoStatus = undefined;
    ck("AU6. Audit failure AND undo failure -> 500 finance_billing_unaudited (never success)", u.httpStatus === 500 && u.code === "finance_billing_unaudited");
    world.tables[BILLING_TABLES.overrides] = world.tables[BILLING_TABLES.overrides].filter((r) => r.fields.Kind !== "Not billable");
    world.lockMode = "busy";
    const b = await create(o, '{"override":{"kind":"not_billable"},"reason":"x"}');
    world.lockMode = "ok";
    ck("AU7. Lock held elsewhere -> 409 finance_commercial_busy, nothing written", b.code === "finance_commercial_busy" && world.audit.length === 3);
    ck("AU8. The lock is always released after a write", world.lockHeld === null);
  }

  // ===== RG. Session range =====
  {
    await seed();
    const dates = ["2026-09-01", "2026-09-03", "2026-09-08", "2026-09-10", "2026-09-15", "2026-09-17", "2026-09-22", "2026-09-24"];
    for (const d of dates) addOcc(S.after, d);
    addOcc(S.after, "2026-09-28", { status: "Cancelled" });
    addOcc(S.after, "2026-10-06");
    addOcc(S.ppa, "2026-09-10");
    addOcc(S.after, "2026-08-31");
    const o = `${S.after}:2026-09-15`;
    await create(o, '{"override":{"kind":"quantity","quantity":20},"reason":"extra"}');
    calls = [];
    const r = await SB("TEST-AFTER", "2026-09-01", "2026-10-31");
    const s = r.body.summary;
    ck("RG1. Range returns only this Session's occurrences in range, ordered by date", r.status === "ok" && r.body.occurrences.length === 10 && r.body.occurrences[0].occurrence.date === "2026-09-01" && r.body.occurrences.every((x: any) => x.occurrence.sessionId === "TEST-AFTER"));
    ck("RG2. Summary: outcome counts and eligible totals (7 × £162 + £180 = £1,314); cancelled and future counted, never summed", s.outcomes.eligible === 8 && s.outcomes.not_eligible === 2 && s.eligibleBillableValue.net === "1314.00" && s.eligibleBillableValue.gross === "1314.00" && s.eligibleBillableValue.occurrences === 8);
    const gets = airtableGets().length;
    for (let i = 0; i < 40; i++) addOcc(S.after, `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, { id: `${S.after}:2026-10-x${i}` });
    calls = [];
    await SB("TEST-AFTER", "2026-09-01", "2026-10-31");
    ck("RG3. Bounded reads: 50 occurrences cost the same fixed Airtable reads as 10 (+1 override read per 40) - never one per occurrence", airtableGets().length <= gets + 1, `${gets} -> ${airtableGets().length}`);
    const q = (s: string) => checkRangeQuery(new URLSearchParams(s), isTenantKey) as any;
    ck("RG4. Range validation: from/to required once, real dates, from <= to, at most 93 days, no other params", q("from=2026-09-01").code === "invalid_input" && q("from=2026-09-01&to=2026-02-30").fields.to && q("from=2026-10-01&to=2026-09-01").fields.to && q("from=2026-01-01&to=2026-06-01").fields.to && q("from=2026-09-01&to=2026-09-30&x=1").code === "unexpected_parameter" && q("from=2026-09-01&to=2026-12-02").ok === true);
    ck("RG5. Unknown session -> 404 session_not_found", (await SB("TEST-NOPE", "2026-09-01", "2026-09-30")).code === "session_not_found");
    const none = await SB("TEST-NONE", "2026-09-01", "2026-09-30");
    ck("RG6. A Session without a Finance Service still lists (each occurrence missing_finance_service; totals 0 eligible)", none.status === "ok" && none.body.session.financeServiceId === null && none.body.summary.eligibleBillableValue.occurrences === 0);
  }

  // ===== RT. Routes =====
  {
    const m = (p: string, meth: string) => matchBillingRoute(p, meth) as any;
    ck("RT1. Routes: occurrence GET, session GET (?from&to), override create/remove POST; wrong method 405; malformed 404; F1-F3 paths untouched (null)", m("occurrences/recA:2026-09-10/billing", "GET").route.name === "occurrence.billing" && m("sessions/TEST-A/billing", "GET").queryAllowed.join() === "from,to" && m("occurrences/x:1/billing-overrides", "POST").route.name === "override.create" && m("occurrences/x:1/billing-overrides/FOB-ABCDEF123456/remove", "POST").route.params.overrideId === "FOB-ABCDEF123456" && m("occurrences/x:1/billing", "POST").status === "method" && m("occurrences/x'1/billing", "GET").status === "not_found" && m("occurrences/x:1/billing-overrides/FOB-1/remove", "POST").status === "not_found" && m("services/FSV-ABCDEF123456", "GET") === null && m("settings", "GET") === null);
    ck("RT2. No invoice routes", m("occurrences/x:1/invoice", "POST").status === "not_found" && m("invoices", "GET") === null);
  }

  // ===== Z. Code / drift =====
  {
    const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
    const support = (f: string) => readFileSync(join(HERE, f), "utf8");
    const strip = (s: string) => s.replace(/^\/\*\*\n \* Test-suite copy[\s\S]*?\*\/\n/, "");
    ck("Z1. finance-billing / -mapping / finance-lifecycle support copies are byte-identical", ["finance-billing.ts", "finance-billing-mapping.ts", "finance-lifecycle.ts"].every((f) => strip(support(f)) === canon(f)));
    ck("Z2. billing repository / orchestrator support copies differ only in the adjusted import", strip(support("finance-billing-repository.ts")) === canon("finance-billing-repository.ts").replace('"./repository.ts"', '"./finance-repository.ts"') && strip(support("finance-billing-orchestrator.ts")) === canon("finance-billing-orchestrator.ts").replace('"./orchestrator.ts"', '"./finance-orchestrator.ts"'));
    const code = (f: string) => canon(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("Z3. Domain, lifecycle and mapping are pure (no fetch / Deno / Supabase / Airtable URLs)", ["finance-billing.ts", "finance-lifecycle.ts", "finance-billing-mapping.ts"].every((f) => !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(code(f))));
    ck("Z4. Money reused from the F2 kernel (calculateVat; no float maths)", /calculateVat\(/.test(code("finance-billing.ts")) && !/Math\.round|toFixed|parseFloat/.test(["finance-billing.ts", "finance-billing-orchestrator.ts"].map(code).join("\n")));
    const repo = code("finance-billing-repository.ts");
    ck("Z5. The billing repository never writes Schedule tables (reads only; its own writes go through the F3 Txn helpers on the override table)", !/method: "(POST|PATCH|DELETE)"/.test(repo) && /txn\.(create|patch)\(BILLING_TABLES\.overrides/.test(code("finance-billing-orchestrator.ts")) && !/txn\.(create|patch)\(BILLING_TABLES\.(occurrences|sessions)/.test(code("finance-billing-orchestrator.ts")));
    ck("Z6. Billing reuses F1 authorizeFinance (read for GET, manage for writes) - no new auth path", /authorizeFinance\(deps, caller, "read"\)/.test(code("finance-billing-orchestrator.ts")) && /authorizeFinance\(deps, caller, "manage"\)/.test(code("finance-billing-orchestrator.ts")) && !/createClient|profiles/.test(code("finance-billing-orchestrator.ts")));
    const idx = canon("index.ts");
    ck("Z7. index.ts: F4 dispatched before F3 and F1/F2 (ROUTES unchanged), same 401/403/400 order", /const ROUTES: Record<string, string\[\]> = \{ access: \["GET"\], "write-check": \["POST"\], settings: \["GET", "POST"\] \};/.test(idx) && idx.indexOf("matchBillingRoute(decoded") < idx.indexOf("matchCommercialRoute(route") && /isFinanceEligible\(caller\)[\s\S]*checkRangeQuery/.test(idx.slice(idx.indexOf("async function handleBilling"))));
    ck("Z8. No quantity from Parent Hub memberships / player links, no guessing from Commercial Model / Billing Model / Finance Key / name", !/Player Session|Parent Hub|Commercial Model|Billing Model|Finance Key|Session Name.*FSV/i.test(["finance-billing.ts", "finance-billing-mapping.ts", "finance-billing-repository.ts", "finance-billing-orchestrator.ts"].map(code).join("\n")));
    ck("Z9. No invoice / payment / Stripe / Xero logic and no Josh Evans naming in F4 code", !/invoice\(|createInvoice|payment_|stripe|xero/i.test(["finance-billing.ts", "finance-billing-mapping.ts", "finance-billing-repository.ts", "finance-billing-orchestrator.ts"].map(code).join("\n")) && !/josh|evans/i.test(["finance-billing.ts", "finance-billing-mapping.ts", "finance-billing-repository.ts", "finance-billing-orchestrator.ts", "finance-lifecycle.ts"].map(canon).join("\n")));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  for (const [st, n] of R) console.log(`${st}  ${n}`);
  console.log(`FAIL  X0. Test run crashed before completing: ${String(e?.message ?? e).slice(0, 120)}`);
  process.exit(1);
});
