/**
 * Finance Foundation F3 - Clients, Services, commercial setup.
 * Run: node --experimental-strip-types tests/support/finance-commercial.test.ts
 *
 *   A   access (View reads, View cannot manage, Manage, no grant, Coach/Parent, module off)
 *   T   tenant / request shape (bodies, query, routes, dangerous keys)
 *   CL  clients (create/read/update, duplicates, invalid contact/terms, isolation, inactive)
 *   SV  services (several per client, different payer/charge, Active/Paused/Ended, ended readable + frozen)
 *   CM  commercial terms (fixed, per player, subscription, other, pence, VAT defaults, summaries, illustration)
 *   ED  effective dating / history (initial, future change, earlier dates, boundary, backdate/overlap, quantity)
 *   AU  audit (exactly once, content, rejected writes none, atomic batch, rollback on failure, lock)
 *   SE  Session relationship / compatibility (options route; Finance never writes Sessions)
 *   Z   code / drift checks against the canonical finance files
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, toStoredFields } from "./finance-settings.ts";
import {
  checkCommercialQuery,
  checkHistory,
  completeTerms,
  dayBefore,
  describeTerms,
  formatGBP,
  illustrate,
  matchCommercialRoute,
  parseClientCreate,
  parseClientUpdate,
  parseServiceCreate,
  parseTermsChange,
  planChange,
  termsOn,
  todayIn,
} from "./finance-commercial.ts";
import { TABLES, buildWorld } from "./finance-commercial-mapping.ts";
import { COMMERCIAL_RETRY_DELAYS_MS } from "./finance-commercial-repository.ts";
import { SETTINGS_RETRY_DELAYS_MS } from "./finance-settings-repository.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type CommercialDeps, type WriteInput, readCommercial, writeCommercial } from "./finance-commercial-orchestrator.ts";

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

const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "vat_included" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7 };
const settingsRow = (s: any) => ({ id: "recSettingsRow001", fields: { Organisation: [ORG_REC], "Finance Settings ID": "FINSET", Revision: 1, ...Object.fromEntries(Object.entries(toStoredFields(s, Object.keys(s) as any)).filter(([, v]) => v !== null)) } });

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  tables: Record<string, { id: string; fields: Record<string, any> }[]>;
  audit: any[];
  lockHeld: string | null;
  lockMode: "ok" | "busy" | "error";
  releases: number;
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
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };
function reset(over: Partial<World> = {}) {
  world = {
    grants: { [MGR]: [g("manage")] },
    moduleOn: true,
    tables: { [TABLES.clients]: [], [TABLES.services]: [], [TABLES.terms]: [], "Finance Settings": [settingsRow(SETTINGS)] },
    audit: [],
    lockHeld: null,
    lockMode: "ok",
    releases: 0,
    ...over,
  };
  calls = [];
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tableOf = (url: string) => Object.keys(world.tables).find((t) => url.includes(`/${encodeURIComponent(t)}`));

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
    world.releases++;
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
    if (method === "GET") return json({ records: rows });
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
    const id = url.split("/").pop()!.split("?")[0];
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
  clock: () => new Date("2026-09-29T12:00:00.000Z"),
  randomHex: () => (++hexSeq).toString(16).padStart(12, "0") + "a".repeat(20),
};
const W = (input: WriteInput, caller: any = mgr) => {
  world.failedThisRequest = false;
  return writeCommercial(deps, caller, input) as Promise<any>;
};
const Rd = (route: any, on?: string, caller: any = mgr) => readCommercial(deps, caller, route, on) as Promise<any>;
const tableWrites = () => calls.filter((c) => c.method !== "GET" && tableOf(c.url));
const auditPosts = () => calls.filter((c) => c.url.includes("finance_audit_events"));

const PPA = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 5000, vatTreatment: "plus_vat" as const };
const AFTER = { payer: "client" as const, chargeType: "per_player" as const, amountMinor: 900, vatTreatment: "no_vat" as const, defaultBillableQuantity: 18 };

async function seed() {
  reset();
  const c = await W({ route: "clients.create", client: { name: "TEST Parkside Primary" }, reason: null });
  const clientId = c.body.client.clientId;
  const ppa = await W({ route: "services.create", clientId, name: "PPA", initial: { effectiveFrom: "2026-09-01", input: PPA }, reason: null });
  const after = await W({ route: "services.create", clientId, name: "After-school", initial: { effectiveFrom: "2026-09-01", input: AFTER }, reason: null });
  return { clientId, ppaId: ppa.body.service.serviceId, afterId: after.body.service.serviceId };
}

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== A. Access =====
  {
    const { clientId, ppaId } = await seed();
    world.grants[MGR] = [g("view")];
    calls = [];
    const r1 = await Rd({ name: "clients.list", params: {} });
    const r2 = await Rd({ name: "service.read", params: { serviceId: ppaId } });
    ck("A1. View reads clients and services (access view)", r1.status === "ok" && r1.body.access === "view" && r1.body.clients.length === 1 && r2.status === "ok");
    const w1 = await W({ route: "client.update", clientId, patch: { name: "X" }, reason: null });
    const w2 = await W({ route: "terms.change", serviceId: ppaId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 6000 }, changedKeys: ["amount"] }, reason: null });
    ck("A2. View cannot manage: 403 finance_manage_required; no lock, no write, no event", w1.httpStatus === 403 && w1.code === "finance_manage_required" && w2.code === "finance_manage_required" && tableWrites().length === 0 && !calls.some((c) => c.url.includes("/rpc/")) && auditPosts().length === 0);
    world.grants[MGR] = [];
    ck("A3. No grant: reads and writes 403 finance_access_denied", (await Rd({ name: "options", params: {} })).code === "finance_access_denied" && (await W({ route: "clients.create", client: { name: "Y" }, reason: null })).code === "finance_access_denied");
    world.grants[COACH] = [g("manage")];
    const coach = { ...mgr, userId: COACH, role: "coach" };
    ck("A4. Coach (even holding a grant) / Parent: 403 management_required", (await Rd({ name: "clients.list", params: {} }, undefined, coach)).code === "management_required" && (await W({ route: "clients.create", client: { name: "Y" }, reason: null }, { ...mgr, role: "parent" })).code === "management_required");
    world.grants[MGR] = [g("manage")];
    world.moduleOn = false;
    ck("A5. Module off: reads and writes 403 finance_module_disabled", (await Rd({ name: "clients.list", params: {} })).code === "finance_module_disabled" && (await W({ route: "clients.create", client: { name: "Y" }, reason: null })).code === "finance_module_disabled");
    world.moduleOn = true;
    ck("A6. Manage reads and writes", (await Rd({ name: "client.read", params: { clientId } })).body.access === "manage" && (await W({ route: "client.update", clientId, patch: { poRequired: true }, reason: null })).status === "ok");
  }

  // ===== T. Tenant / request shape =====
  {
    const code = (r: any) => (r.ok ? "ok" : r.code);
    ck("T1. Tenant keys at the top level or inside a section -> tenant_param_rejected", code(parseClientCreate('{"organisationId":"ORG-TEST-999","client":{"name":"x"}}', isTenantKey)) === "tenant_param_rejected" && code(parseClientCreate('{"client":{"name":"x","tenant":"t"}}', isTenantKey)) === "tenant_param_rejected" && code(parseServiceCreate('{"service":{"name":"x"},"commercial":{"baseId":"apprptFotQuVL1mhs"}}', isTenantKey)) === "tenant_param_rejected");
    ck("T2. Unknown / dangerous fields -> unexpected_field (id, revision, __proto__, recordId, clientId)", ['{"client":{"name":"x","clientId":"FCL-AAAAAAAAAAAA"}}', '{"client":{"name":"x","revision":9}}', '{"client":{"__proto__":{"a":1}}}', '{"client":{"name":"x"},"recordId":"recX"}'].every((b) => code(parseClientCreate(b, isTenantKey)) === "unexpected_field") && ({} as any).a === undefined);
    ck("T3. Malformed / empty / non-object bodies -> invalid_body", ["", "nope", "[]", '{"client":[]}', '{"client":{}}', "{}"].every((b) => code(parseClientCreate(b, isTenantKey)) === "invalid_body"));
    const q = (s: string, allowed: string[]) => checkCommercialQuery(new URLSearchParams(s), allowed, isTenantKey) as any;
    ck("T4. Query: tenant -> 400 tenant_param_rejected; unknown -> unexpected_parameter; `on` only on service read and must be a real date", q("organisationId=ORG-TEST-999", ["on"]).code === "tenant_param_rejected" && q("debug=1", []).code === "unexpected_parameter" && q("on=2026-10-01", []).code === "unexpected_parameter" && q("on=2026-02-30", ["on"]).code === "invalid_input" && q("on=2026-10-01", ["on"]).on === "2026-10-01");
    const m = (p: string, meth: string) => matchCommercialRoute(p, meth) as any;
    ck("T5. Routes: ids must be well formed (bad id -> 404), wrong method -> 405, unknown F3 path -> 404, non-F3 path -> null", m("clients/FCL-ABCDEF123456", "GET").route.name === "client.read" && m("clients/recAAAAAAAAAAAAAA", "GET").status === "not_found" && m("services/FSV-ABCDEF123456/commercial", "GET").status === "method" && m("services/FSV-ABCDEF123456/commercial/changes", "POST").route.name === "terms.change" && m("clients/FCL-ABCDEF123456/nope", "GET").status === "not_found" && m("settings", "GET") === null && m("access", "GET") === null);
    ck("T6. Only GET service read accepts ?on", m("services/FSV-ABCDEF123456", "GET").queryAllowed.join() === "on" && m("clients", "GET").queryAllowed.length === 0);
  }

  // ===== CL. Clients =====
  {
    reset();
    const bad = parseClientCreate('{"client":{"name":"x","billingEmail":"not-an-email","billingCcEmails":["a@b.co","nope"],"paymentTermsDaysOverride":400,"poRequired":"yes"}}', isTenantKey) as any;
    ck("CL1. Invalid email / CC / payment terms / PO flag all reported together", bad.code === "invalid_input" && Object.keys(bad.fields).sort().join() === "billingCcEmails,billingEmail,paymentTermsDaysOverride,poRequired");
    ck("CL2. Client name is required on create", (parseClientCreate('{"client":{"billingEmail":"a@b.co"}}', isTenantKey) as any).fields?.name === "is required");
    const parsed = parseClientCreate('{"client":{"name":" TEST Parkside Primary ","billingContactName":"Bursar","billingEmail":"Bursar@Parkside.test","billingCcEmails":["office@parkside.test"],"paymentTermsDaysOverride":14,"poRequired":true},"reason":"setup"}', isTenantKey) as any;
    const c = await W({ route: "clients.create", client: parsed.client, reason: parsed.reason });
    const cl = c.body.client;
    ck("CL3. Create: 201, opaque FCL id, trimmed name, lower-cased email, CC list, terms override, PO required, revision 1", c.httpStatus === 201 && /^FCL-[0-9A-F]{12}$/.test(cl.clientId) && cl.name === "TEST Parkside Primary" && cl.billingEmail === "bursar@parkside.test" && cl.billingCcEmails.join() === "office@parkside.test" && cl.paymentTermsDaysOverride === 14 && cl.poRequired === true && cl.revision === 1 && cl.status === "active");
    const row = world.tables[TABLES.clients][0];
    ck("CL4. Stored row owned by the caller's organisation; no Airtable id in the response", JSON.stringify(row.fields.Organisation) === JSON.stringify([ORG_REC]) && !JSON.stringify(c.body).includes(row.id));
    ck("CL5. Duplicate client name (case/space-insensitive) -> 409 duplicate_client_name, nothing written", (await W({ route: "clients.create", client: { name: "test parkside primary" }, reason: null })).code === "duplicate_client_name" && world.tables[TABLES.clients].length === 1);
    const up = await W({ route: "client.update", clientId: cl.clientId, patch: { status: "inactive", paymentTermsDaysOverride: null }, reason: "closed" });
    ck("CL6. Update: inactive + override cleared, revision 2", up.status === "ok" && up.body.client.status === "inactive" && up.body.client.paymentTermsDaysOverride === null && up.body.client.revision === 2);
    const read = await Rd({ name: "client.read", params: { clientId: cl.clientId } });
    ck("CL7. Inactive client remains readable (history)", read.status === "ok" && read.body.client.status === "inactive");
    ck("CL8. Inactive client cannot take a new service -> 409 client_inactive", (await W({ route: "services.create", clientId: cl.clientId, name: "PPA", initial: null, reason: null })).code === "client_inactive");
    const noop = await W({ route: "client.update", clientId: cl.clientId, patch: { status: "inactive" }, reason: null });
    ck("CL9. No-op update -> 200 changed:false, no write, no event", noop.body.changed === false && world.audit.length === 2);
    ck("CL10. Unknown client -> 404 client_not_found", (await Rd({ name: "client.read", params: { clientId: "FCL-000000000000" } })).httpStatus === 404);
    world.tables[TABLES.clients].push({ id: "recOtherClient001", fields: { Organisation: [OTHER_ORG_REC], "Finance Client ID": "FCL-BBBBBBBBBBBB", "Client Name": "Other org school", Status: "Active", Revision: 1 } });
    const list = await Rd({ name: "clients.list", params: {} });
    ck("CL11. Organisation isolation: another organisation's client is invisible and unreachable", list.body.clients.length === 1 && (await Rd({ name: "client.read", params: { clientId: "FCL-BBBBBBBBBBBB" } })).httpStatus === 404);
    world.tables[TABLES.clients][0].fields["Billing Email"] = "broken";
    ck("CL12. A stored row that fails validation -> 409 commercial_data_invalid (never skipped)", (await Rd({ name: "clients.list", params: {} })).code === "commercial_data_invalid");
    const bw = buildWorld({ clients: [{ id: "recC1", fields: { Organisation: [ORG_REC, OTHER_ORG_REC], "Finance Client ID": "FCL-AAAAAAAAAAAA", "Client Name": "x", Status: "Active", Revision: 1 } }], services: [], terms: [] }) as any;
    ck("CL13. A stored row linked to two organisations makes the data invalid (never shared across tenants)", bw.ok === false && /more than one organisation/.test(bw.error));
  }

  // ===== SV. Services =====
  {
    const { clientId, ppaId, afterId } = await seed();
    const cr = await Rd({ name: "client.read", params: { clientId } });
    const byName = Object.fromEntries(cr.body.services.map((s: any) => [s.name, s]));
    ck("SV1. One client, several services, each with its own commercial setup", cr.body.services.length === 2 && byName["PPA"].commercial.current.chargeType === "fixed_per_session" && byName["After-school"].commercial.current.chargeType === "per_player");
    const parent = await W({ route: "services.create", clientId, name: "Holiday camp", initial: { effectiveFrom: "2026-09-01", input: { payer: "parent", chargeType: "subscription", amountMinor: 3000, vatTreatment: "no_vat", subscriptionFrequency: "monthly" } }, reason: null });
    ck("SV2. Different payer per service under the same client (client pays PPA, parents pay camp)", byName["PPA"].commercial.current.payer === "client" && parent.body.service.commercial.current.payer === "parent" && parent.body.service.commercial.current.payerLabel === "Parents pay");
    ck("SV3. Duplicate service name within the client -> 409", (await W({ route: "services.create", clientId, name: "ppa", initial: null, reason: null })).code === "duplicate_service_name");
    const p = await W({ route: "service.update", serviceId: afterId, patch: { status: "paused" }, reason: "half term" });
    const a = await W({ route: "service.update", serviceId: afterId, patch: { status: "active" }, reason: null });
    ck("SV4. Active -> Paused -> Active", p.body.service.status === "paused" && a.body.service.status === "active" && a.body.service.revision === 3);
    const e = await W({ route: "service.update", serviceId: ppaId, patch: { status: "ended" }, reason: "contract ended" });
    ck("SV5. Ended: status ended; commercial history kept", e.body.service.status === "ended" && e.body.service.commercial.history.length === 1);
    const er = await Rd({ name: "service.read", params: { serviceId: ppaId } });
    ck("SV6. Ended service remains readable with its history", er.status === "ok" && er.body.service.status === "ended" && er.body.service.commercial.current.summary === "£50 + VAT per delivered session");
    const writes = tableWrites().length;
    ck("SV7. Ended service is frozen: reopen / rename / commercial change -> 409 service_ended, nothing written", (await W({ route: "service.update", serviceId: ppaId, patch: { status: "active" }, reason: null })).code === "service_ended" && (await W({ route: "terms.change", serviceId: ppaId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 1 }, changedKeys: ["amount"] }, reason: null })).code === "service_ended" && tableWrites().length === writes);
    ck("SV8. Unknown service -> 404", (await Rd({ name: "service.read", params: { serviceId: "FSV-000000000000" } })).httpStatus === 404);
  }

  // ===== CM. Commercial terms =====
  {
    const fixed = { ...PPA, vatRateBasisPoints: 2000, defaultBillableQuantity: null, subscriptionFrequency: null, otherDescription: null };
    const per = { ...AFTER, vatRateBasisPoints: 0, subscriptionFrequency: null, otherDescription: null };
    ck("CM1. Fixed per session: \"£50 + VAT per delivered session\"", describeTerms(fixed) === "£50 + VAT per delivered session");
    ck("CM2. Per player: \"£9 per player · 18 billable · £162 expected per session\"", describeTerms(per) === "£9 per player · 18 billable · £162 expected per session");
    ck("CM3. Subscription / other / VAT included / pence formatting", describeTerms({ ...per, chargeType: "subscription", defaultBillableQuantity: null, subscriptionFrequency: "monthly", amountMinor: 3000, vatTreatment: "vat_included", vatRateBasisPoints: 2000 }) === "£30 inc. VAT per month" && describeTerms({ ...fixed, chargeType: "other", otherDescription: "per term fee", amountMinor: 125050 }) === "£1,250.50 + VAT · per term fee" && formatGBP(950) === "£9.50");
    const ill = illustrate(per) as any;
    const illF = illustrate(fixed) as any;
    ck("CM4. Illustration uses the F2 kernel (per player 18 x £9 = £162.00; £50 + VAT -> £10.00 VAT, £60.00 gross)", ill.amount === "162.00" && ill.gross === "162.00" && ill.basis === "per session at 18 billable" && illF.vat === "10.00" && illF.gross === "60.00");
    const defaulted = completeTerms({ payer: "client", chargeType: "fixed_per_session", amountMinor: 5000 }, null, SETTINGS as any) as any;
    ck("CM5. VAT defaults come from Finance Settings as a pre-fill (vat_included 20%) and are stored on the terms", defaulted.ok && defaulted.terms.vatTreatment === "vat_included" && defaulted.terms.vatRateBasisPoints === 2000);
    const explicit = completeTerms({ payer: "client", chargeType: "fixed_per_session", amountMinor: 5000, vatTreatment: "plus_vat", vatRateBasisPoints: 500 }, null, SETTINGS as any) as any;
    ck("CM6. Explicit VAT choice wins over the default", explicit.terms.vatTreatment === "plus_vat" && explicit.terms.vatRateBasisPoints === 500);
    ck("CM7. No settings default and no explicit VAT -> refused (no rate is assumed)", (completeTerms({ payer: "client", chargeType: "fixed_per_session", amountMinor: 5000 }, null, null) as any).fields?.vatTreatment !== undefined && (completeTerms({ payer: "client", chargeType: "fixed_per_session", amountMinor: 5000, vatTreatment: "plus_vat" }, null, null) as any).fields?.vatRatePercent !== undefined);
    ck("CM8. Organisation not VAT registered -> only no_vat allowed", (completeTerms({ payer: "client", chargeType: "fixed_per_session", amountMinor: 5000, vatTreatment: "plus_vat", vatRateBasisPoints: 2000 }, null, { ...SETTINGS, vatRegistered: false } as any) as any).fields?.vatTreatment !== undefined);
    const req = (o: any) => completeTerms({ payer: "client", amountMinor: 900, vatTreatment: "no_vat", ...o }, null, SETTINGS as any) as any;
    ck("CM9. Charge-type rules: per player needs a quantity; subscription needs a frequency; other needs a description; each refused elsewhere", req({ chargeType: "per_player" }).fields?.defaultBillableQuantity && req({ chargeType: "subscription" }).fields?.subscriptionFrequency && req({ chargeType: "other" }).fields?.otherDescription && req({ chargeType: "fixed_per_session", defaultBillableQuantity: 18 }).fields?.defaultBillableQuantity && req({ chargeType: "fixed_per_session", subscriptionFrequency: "weekly" }).fields?.subscriptionFrequency);
    const p = (b: string) => (parseServiceCreate(b, isTenantKey) as any);
    ck("CM10. Malformed money / VAT treatment / charge type / quantity / date refused at the API edge", p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"per_player","amount":9,"vatTreatment":"exempt","defaultBillableQuantity":1.5}}').fields.amount && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"per_player","amount":"9","vatTreatment":"exempt","defaultBillableQuantity":1.5}}').fields.vatTreatment && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"hourly","amount":"9"}}').fields.chargeType && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"per_player","amount":"9","defaultBillableQuantity":-1}}').fields.defaultBillableQuantity && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-02-30","payer":"client","chargeType":"per_player","amount":"9"}}').fields.effectiveFrom && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"school","chargeType":"per_player","amount":"9.999"}}').fields.payer);
    ck("CM11. Negative / over-limit amounts refused; amounts parse to integer pence", p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"other","amount":"-1"}}').fields.amount && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"other","amount":"100000.01"}}').fields.amount && p('{"service":{"name":"x"},"commercial":{"effectiveFrom":"2026-09-01","payer":"client","chargeType":"fixed_per_session","amount":"50.5","vatRatePercent":"17.5","vatTreatment":"plus_vat"}}').initial.input.amountMinor === 5050);
    const { ppaId, afterId } = await seed();
    const s = await Rd({ name: "service.read", params: { serviceId: afterId } });
    const cur = s.body.service.commercial.current;
    ck("CM12. API body: plain labels + summary + illustration; amount as decimal text; no internal enums/record ids", cur.chargeTypeLabel === "Per player" && cur.payerLabel === "Client / school pays" && cur.amount === "9.00" && cur.summary === "£9 per player · 18 billable · £162 expected per session" && cur.illustrativeAmount.amount === "162.00" && !/rec[A-Za-z0-9]{14}|Minor Units|Charge Type|per_delivered|charge_basis/.test(JSON.stringify(s.body)));
    const stored = world.tables[TABLES.terms].find((r) => r.fields["Commercial Terms ID"] === (s.body.service.commercial.current.termsId));
    ck("CM13. Stored amount is integer pence (900) and the default quantity 18", stored?.fields["Amount (Minor Units)"] === 900 && stored?.fields["Default Billable Quantity"] === 18);
    ck("CM14. Initial setup on a service that already has terms -> 409 commercial_terms_exist", (await W({ route: "terms.create", serviceId: ppaId, req: { effectiveFrom: "2026-10-01", input: PPA }, reason: null })).code === "commercial_terms_exist");
  }

  // ===== ED. Effective dating / history =====
  {
    const { ppaId, afterId } = await seed();
    const ch = await W({ route: "terms.change", serviceId: ppaId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: "new contract" });
    ck("ED1. Future change: 201, history = closed old (until 2026-10-31) + new from 2026-11-01", ch.httpStatus === 201 && ch.body.service.commercial.history.length === 2 && ch.body.service.commercial.history[0].effectiveUntil === "2026-10-31" && ch.body.service.commercial.history[1].effectiveFrom === "2026-11-01");
    const on = async (d: string) => (await Rd({ name: "service.read", params: { serviceId: ppaId } }, d)).body.service.commercial.onDate.terms?.summary ?? null;
    ck("ED2. Earlier date still resolves the old terms; today still old", (await on("2026-10-15")) === "£50 + VAT per delivered session" && (await Rd({ name: "service.read", params: { serviceId: ppaId } })).body.service.commercial.current.summary === "£50 + VAT per delivered session");
    ck("ED3. Exact boundary: 2026-10-31 old, 2026-11-01 new; before the first segment -> none", (await on("2026-10-31")) === "£50 + VAT per delivered session" && (await on("2026-11-01")) === "£55 + VAT per delivered session" && (await on("2026-08-31")) === null);
    const oldRow = world.tables[TABLES.terms].find((r) => r.fields["Effective Until"] === "2026-10-31")!;
    ck("ED4. The old segment's terms were not edited (only Effective Until set)", oldRow.fields["Amount (Minor Units)"] === 5000 && oldRow.fields["Payer"] === "Client / school");
    const before = world.tables[TABLES.terms].length;
    const back = await W({ route: "terms.change", serviceId: afterId, req: { effectiveFrom: "2026-09-15", changes: { defaultBillableQuantity: 20 }, changedKeys: ["defaultBillableQuantity"] }, reason: null });
    ck("ED5. Backdated change (before today) -> 409 backdated_change_not_allowed; nothing written", back.code === "backdated_change_not_allowed" && world.tables[TABLES.terms].length === before);
    const ov = await W({ route: "terms.change", serviceId: ppaId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 6000 }, changedKeys: ["amount"] }, reason: null });
    ck("ED6. Change on/before the current segment's start (would overlap) -> 409 change_overlaps_current_terms; nothing written", ov.code === "change_overlaps_current_terms" && world.tables[TABLES.terms].length === before);
    const q = await W({ route: "terms.change", serviceId: afterId, req: { effectiveFrom: "2026-10-05", changes: { defaultBillableQuantity: 20 }, changedKeys: ["defaultBillableQuantity"] }, reason: "school confirmed 20" });
    const qh = q.body.service.commercial.history;
    ck("ED7. Quantity change is effective-dated: 18 kept until 2026-10-04, 20 from 2026-10-05 (£180 expected)", qh[0].defaultBillableQuantity === 18 && qh[0].effectiveUntil === "2026-10-04" && qh[1].defaultBillableQuantity === 20 && qh[1].summary === "£9 per player · 20 billable · £180 expected per session");
    const noop = await W({ route: "terms.change", serviceId: afterId, req: { effectiveFrom: "2026-12-01", changes: { defaultBillableQuantity: 20 }, changedKeys: ["defaultBillableQuantity"] }, reason: null });
    ck("ED8. A change identical to the current terms -> 200 changed:false, nothing written", noop.httpStatus === 200 && noop.body.changed === false);
    const tochg = await W({ route: "terms.change", serviceId: afterId, req: { effectiveFrom: "2026-12-01", changes: { chargeType: "fixed_per_session", amountMinor: 20000 }, changedKeys: ["chargeType", "amount"] }, reason: null });
    ck("ED9. Charge type change drops the inherited per-player quantity (not carried into fixed)", tochg.body.service.commercial.history[2].defaultBillableQuantity === null && tochg.body.service.commercial.history[2].summary === "£200 per delivered session");
    const T = (id: string, from: string, until: string | null) => ({ termsId: id, serviceId: "FSV-X", effectiveFrom: from, effectiveUntil: until, ...PPA, vatRateBasisPoints: 2000, defaultBillableQuantity: null, subscriptionFrequency: null, otherDescription: null });
    const overlap = checkHistory([T("A", "2026-01-01", "2026-06-30"), T("B", "2026-06-01", null)]) as any;
    const twoOpen = checkHistory([T("A", "2026-01-01", null), T("B", "2027-01-01", null)]) as any;
    ck("ED10. Stored overlapping / double-open history is a configuration error (never picks newest)", overlap.code === "commercial_terms_overlap" && twoOpen.code === "commercial_terms_overlap" && termsOn([T("A", "2026-01-01", "2026-06-30"), T("B", "2026-06-01", null)], "2026-06-15").status === "ambiguous");
    ck("ED11. planChange: missing terms / closed latest / before today / not after start", planChange([], "2026-10-01", "2026-09-29").ok === false && (planChange([T("A", "2026-01-01", "2026-05-01")], "2026-10-01", "2026-09-29") as any).code === "commercial_terms_invalid" && (planChange([T("A", "2026-01-01", null)], "2026-09-28", "2026-09-29") as any).code === "backdated_change_not_allowed" && (planChange([T("A", "2026-10-01", null)], "2026-10-01", "2026-09-29") as any).code === "change_overlaps_current_terms" && (planChange([T("A", "2026-01-01", null)], "2026-09-29", "2026-09-29") as any).closed.effectiveUntil === "2026-09-28");
    ck("ED12. dayBefore handles month/leap boundaries; today is taken in the organisation's timezone", dayBefore("2026-03-01") === "2026-02-28" && dayBefore("2028-03-01") === "2028-02-29" && dayBefore("2027-01-01") === "2026-12-31" && todayIn("Europe/London", new Date("2026-06-30T23:30:00Z")) === "2026-07-01");
    const tr = world.tables[TABLES.terms][0];
    tr.fields["Effective Until"] = null;
    world.tables[TABLES.terms].push({ id: "recDupTerms00001", fields: { ...tr.fields, "Commercial Terms ID": "FCT-EEEEEEEEEEEE", "Effective From": "2026-10-01" } });
    ck("ED13. Stored overlap for a service -> 409 on read and write (never resolved silently)", (await Rd({ name: "service.read", params: { serviceId: ppaId } })).code === "commercial_terms_overlap" && (await W({ route: "service.update", serviceId: ppaId, patch: { name: "PPA2" }, reason: null })).code === "commercial_terms_overlap");
  }

  // ===== AU. Audit =====
  {
    reset();
    const c = await W({ route: "clients.create", client: { name: "TEST Audit School" }, reason: "r1" });
    const e1 = world.audit[0];
    ck("AU1. Client create -> exactly one event: org, actor, entity, id, before null, after, reason", world.audit.length === 1 && e1.event_type === "finance_client.created" && e1.organisation_id === ORG && e1.actor_user_id === MGR && e1.entity_type === "finance_client" && e1.record_id === c.body.client.clientId && e1.before === null && e1.after.name === "TEST Audit School" && e1.reason === "r1" && !("occurred_at" in e1));
    const s = await W({ route: "services.create", clientId: c.body.client.clientId, name: "PPA", initial: { effectiveFrom: "2026-09-01", input: PPA }, reason: "r2" });
    const posts = auditPosts();
    ck("AU2. Service + inline terms -> two events in ONE audit insert (service created, terms created)", world.audit.length === 3 && Array.isArray(posts[posts.length - 1].body) && posts[posts.length - 1].body.length === 2 && world.audit[1].event_type === "finance_client_service.created" && world.audit[2].event_type === "finance_commercial_terms.created" && world.audit[2].after.amountMinor === 5000);
    await W({ route: "service.update", serviceId: s.body.service.serviceId, patch: { status: "paused" }, reason: "r3" });
    const e3 = world.audit[3];
    ck("AU3. Status change -> one updated event with before/after status and changedFields", world.audit.length === 4 && e3.event_type === "finance_client_service.updated" && e3.before.status === "active" && e3.after.status === "paused" && e3.context.changedFields.join() === "status");
    await W({ route: "terms.change", serviceId: s.body.service.serviceId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: "r4" });
    const e4 = world.audit[4];
    ck("AU4. Effective-dated change -> one changed event: before current, after closed + next, effectiveFrom", world.audit.length === 5 && e4.event_type === "finance_commercial_terms.changed" && e4.before.current.effectiveUntil === null && e4.after.closed.effectiveUntil === "2026-10-31" && e4.after.next.amountMinor === 5500 && e4.context.effectiveFrom === "2026-11-01");
    const n = world.audit.length;
    await W({ route: "clients.create", client: { name: "test audit school" }, reason: null });
    await W({ route: "terms.change", serviceId: s.body.service.serviceId, req: { effectiveFrom: "2026-09-01", changes: { amountMinor: 1 }, changedKeys: ["amount"] }, reason: null });
    ck("AU5. Rejected writes create no audit event", world.audit.length === n);

    reset({ auditStatus: 500 });
    const f1 = await W({ route: "services.create", clientId: "FCL-000000000000", name: "x", initial: null, reason: null });
    ck("AU6. (precondition) unknown client with audit down -> 404, no writes", f1.httpStatus === 404 && tableWrites().length === 0);
    world.auditStatus = undefined;
    const c2 = await W({ route: "clients.create", client: { name: "TEST Rollback School" }, reason: null });
    world.auditStatus = 500;
    calls = [];
    const f2 = await W({ route: "services.create", clientId: c2.body.client.clientId, name: "PPA", initial: { effectiveFrom: "2026-09-01", input: PPA }, reason: null });
    ck("AU7. Audit failure after service + terms create -> both rows deleted, 503, no event", f2.httpStatus === 503 && f2.code === "finance_audit_unavailable" && world.tables[TABLES.services].length === 0 && world.tables[TABLES.terms].length === 0 && world.audit.length === 1);
    world.auditStatus = undefined;
    const sv = await W({ route: "services.create", clientId: c2.body.client.clientId, name: "PPA", initial: { effectiveFrom: "2026-09-01", input: PPA }, reason: null });
    const snap = JSON.stringify(world.tables[TABLES.terms]);
    world.auditStatus = 500;
    const f3 = await W({ route: "terms.change", serviceId: sv.body.service.serviceId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: null });
    ck("AU8. Audit failure after a change -> old segment re-opened, new segment deleted, 503", f3.httpStatus === 503 && JSON.stringify(world.tables[TABLES.terms]) === snap);
    world.auditStatus = undefined;
    world.failCreateOn = TABLES.terms;
    const f4 = await W({ route: "terms.change", serviceId: sv.body.service.serviceId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: null });
    ck("AU9. Write failure midway (new segment create fails) -> the close is undone, 503, no event", f4.httpStatus === 503 && f4.code === "finance_commercial_unavailable" && JSON.stringify(world.tables[TABLES.terms]) === snap && world.audit.length === 3);
    world.failCreateOn = undefined;
    world.auditStatus = 500;
    world.undoStatus = 500;
    const f5 = await W({ route: "terms.change", serviceId: sv.body.service.serviceId, req: { effectiveFrom: "2026-11-01", changes: { amountMinor: 5500 }, changedKeys: ["amount"] }, reason: null });
    ck("AU10. Audit AND undo fail -> 500 finance_commercial_unaudited (never success)", f5.httpStatus === 500 && f5.code === "finance_commercial_unaudited");
    world.auditStatus = undefined;
    world.undoStatus = undefined;
    ck("AU11. Lock always released", world.lockHeld === null);
    reset({ lockMode: "busy" });
    ck("AU12. Lock held elsewhere -> 409 finance_commercial_busy; lock store down -> 503; nothing written", (await W({ route: "clients.create", client: { name: "X" }, reason: null })).code === "finance_commercial_busy" && ((world.lockMode = "error"), (await W({ route: "clients.create", client: { name: "X" }, reason: null })).httpStatus === 503) && tableWrites().length === 0);
  }

  // ===== SE. Session relationship =====
  {
    const { clientId, ppaId, afterId } = await seed();
    await W({ route: "service.update", serviceId: afterId, patch: { status: "paused" }, reason: null });
    const o = await Rd({ name: "options", params: {} });
    ck("SE1. Session-creation options list Active services of Active clients with the current summary (paused excluded)", o.body.options.length === 1 && o.body.options[0].serviceId === ppaId && o.body.options[0].clientId === clientId && o.body.options[0].commercial.summary === "£50 + VAT per delivered session");
    ck("SE2. Options carry opaque ids only (a Session stores Finance Service ID, never price fields)", /^FSV-[0-9A-F]{12}$/.test(o.body.options[0].serviceId) && !/rec[A-Za-z0-9]{14}/.test(JSON.stringify(o.body)));
    ck("SE3. Finance never touches the Sessions table (reads or writes)", !calls.some((c) => c.url.includes(encodeURIComponent("Sessions"))));
  }

  // ===== Z. Code / drift =====
  {
    const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
    const support = (f: string) => readFileSync(join(HERE, f), "utf8");
    const strip = (s: string) => s.replace(/^\/\*\*\n \* Test-suite copy[\s\S]*?\*\/\n/, "");
    ck("Z1. finance-commercial / -mapping support copies are byte-identical", ["finance-commercial.ts", "finance-commercial-mapping.ts"].every((f) => strip(support(f)) === canon(f)));
    ck("Z2. repository / orchestrator support copies differ only in the adjusted import", strip(support("finance-commercial-repository.ts")) === canon("finance-commercial-repository.ts").replace('"./repository.ts"', '"./finance-repository.ts"') && strip(support("finance-commercial-orchestrator.ts")) === canon("finance-commercial-orchestrator.ts").replace('"./orchestrator.ts"', '"./finance-orchestrator.ts"'));
    const code = (f: string) => canon(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("Z3. Domain + mapping are pure (no fetch / Deno / Supabase / Airtable URLs)", ["finance-commercial.ts", "finance-commercial-mapping.ts"].every((f) => !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(code(f))));
    ck("Z4. Money/VAT/effective dating reused from F2 (no local VAT maths, no float rounding, no own effective-date resolver)", /from "\.\/finance-money\.ts"/.test(canon("finance-commercial.ts")) && /resolveEffective/.test(code("finance-commercial.ts")) && !/Math\.round|toFixed|parseFloat|\/ ?10_?000/.test(code("finance-commercial.ts")));
    const repo = code("finance-commercial-repository.ts");
    ck("Z5. Repository only touches its three tables, the audit table and the write-lock RPCs (never Sessions)", !/Sessions|Occurrence|Player/.test(repo) && /TABLES/.test(repo));
    ck("Z6. The only Airtable DELETE is the compensating deleteCreatedRow", (repo.match(/method: "DELETE"/g) ?? []).length === 1 && /export async function deleteCreatedRow[\s\S]*?method: "DELETE"/.test(repo));
    ck("Z7. Existing terms rows are only ever patched through termsUntilField (Effective Until)", (code("finance-commercial-orchestrator.ts").match(/txn\.patch\(TABLES\.terms/g) ?? []).length === 1 && /txn\.patch\(TABLES\.terms, closeRow, termsUntilField\(/.test(code("finance-commercial-orchestrator.ts")));
    ck("Z8. Commercial routes reuse F1 authorizeFinance (read for GET, manage for writes) - no new auth path", /authorizeFinance\(deps, caller, "read"\)/.test(canon("finance-commercial-orchestrator.ts")) && /authorizeFinance\(deps, caller, "manage"\)/.test(canon("finance-commercial-orchestrator.ts")) && !/createClient|profiles/.test(code("finance-commercial-orchestrator.ts")));
    const idx = canon("index.ts");
    ck("Z9. index.ts: F1/F2 ROUTES unchanged; F3 dispatched before them with the same 401/403/400 order", /const ROUTES: Record<string, string\[\]> = \{ access: \["GET"\], "write-check": \["POST"\], settings: \["GET", "POST"\] \};/.test(idx) && idx.indexOf("matchCommercialRoute(route") < idx.indexOf("const methods = ROUTES[route]") && /isFinanceEligible\(caller\)[\s\S]*checkCommercialQuery/.test(idx.slice(idx.indexOf("async function handleCommercial"))));
    ck("Z10. No occurrence billing / invoices / payments / revenue logic in F3 code", !/occurrence|invoice|payment_|actualRevenue|Actual Revenue|stripe|xero/i.test(["finance-commercial.ts", "finance-commercial-mapping.ts", "finance-commercial-repository.ts", "finance-commercial-orchestrator.ts"].map(code).join("\n")));
    ck("Z11. No Josh Evans naming in F3 code", !/josh|evans/i.test(["finance-commercial.ts", "finance-commercial-mapping.ts", "finance-commercial-repository.ts", "finance-commercial-orchestrator.ts"].map(canon).join("\n")));
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
