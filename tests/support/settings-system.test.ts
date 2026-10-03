// Settings / Config S1-a: shared organisation context + module contract,
// read-only Settings & System overview, hub-content /settings org matching.
// See TEST-ENV.md ("Settings / Config S1-a").
//
//   O  1-7    organisation context (pure, canonical _shared module)
//   M  8-18   module contract (pure)
//   V  19-27  Settings & System overview (REAL settings function bundle)
//   H  28-31  hub-content /settings (REAL bundle, current vs 10e9c98)
//   R  32-36  regression / equivalence / scope
//
// The real functions are bundled with esbuild and booted with a stub Deno,
// a stub supabase-js and an in-memory Airtable + PostgREST behind fetch
// (the same harness technique as p1-corrections.test.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import {
  type ConfigRow,
  LEGACY_FEATURE_KEYS,
  MODULES,
  getModuleState,
  resolveOrganisationContext,
  todayIn,
} from "../../supabase/functions-test/_shared/organisation-context.ts";
import { buildSettingsSystemOverview } from "../../supabase/functions-test/settings/settings-system.ts";
import { moduleState as financeModuleState, resolveOrganisation as financeResolveOrganisation } from "./finance-access.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FUNCS = join(ROOT, "supabase", "functions-test");
const BASELINE = "10e9c98";

const org = (id: string, fields: Record<string, any>): ConfigRow => ({ id, fields });
const ORG_A = org("recOrgAAAAAAAAAAA", { "Organisation ID": "ORG-TEST-001", "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true, "Hub Name": "Test Hub" });
const feature = (key: string, enabled: boolean, id = "recF" + key.slice(0, 13).padEnd(13, "x")): ConfigRow => ({ id, fields: { "Feature Key": key, Enabled: enabled } });

// =================== O. Organisation context ===================
{
  const a = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [ORG_A]);
  ck("1. Active caller + exactly one Active matching row -> context (ID text, name, timezone from the record, GBP)",
    a.ok && a.context.organisationId === "ORG-TEST-001" && a.context.organisationRecordId === ORG_A.id && a.context.displayName === "Test Org"
    && a.context.timezone === "Europe/London" && a.context.timezoneSource === "organisation" && a.context.currency === "GBP");
  const b = resolveOrganisationContext({ active: false, organisationId: "ORG-TEST-001" }, [ORG_A]);
  ck("2. Inactive profile -> inactive_profile (403)", !b.ok && b.code === "inactive_profile" && b.status === 403);
  const c = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, []);
  const c2 = resolveOrganisationContext({ active: true, organisationId: "" }, [ORG_A]);
  ck("3. No organisation row / blank profile organisation -> organisation_not_found (409)", !c.ok && c.code === "organisation_not_found" && c.status === 409 && !c2.ok && c2.code === "organisation_not_found");
  const d = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [org("recOrgInactiveXXX", { ...ORG_A.fields, Active: false })]);
  ck("4. Matching row exists but is not Active -> organisation_not_found", !d.ok && d.code === "organisation_not_found");
  const e = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [ORG_A, org("recOrgDupeXXXXXXX", { ...ORG_A.fields })]);
  ck("5. Two Active rows with the same Organisation ID -> organisation_ambiguous (409)", !e.ok && e.code === "organisation_ambiguous" && e.status === 409);
  const f = resolveOrganisationContext({ active: true, organisationId: "ORG-OTHER-999" }, [ORG_A]);
  ck("6. Profile organisation differs from the active organisation here -> organisation_mismatch (403)", !f.ok && f.code === "organisation_mismatch" && f.status === 403);
  const first = org("recOrgFirstXXXXXX", { "Organisation ID": "ORG-FIRST", "Organisation Name": "First", Active: true });
  const g = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [first, ORG_A]);
  const g2 = resolveOrganisationContext({ active: true, organisationId: "ORG-NOPE" }, [first, ORG_A]);
  ck("7. Never the first Active row: matched by ID even when another Active row comes first; no match never falls back",
    g.ok && g.context.organisationRecordId === ORG_A.id && !g2.ok && g2.code === "organisation_mismatch");
  const blankTz = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [org("recOrgNoTzXXXXXXX", { ...ORG_A.fields, Timezone: "" })]);
  const badTz = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [org("recOrgBadTzXXXXXX", { ...ORG_A.fields, Timezone: "Mars/Olympus" })]);
  const nz = resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [org("recOrgNzXXXXXXXXX", { ...ORG_A.fields, Timezone: "Pacific/Auckland" })]);
  const at = new Date("2026-10-03T13:00:00Z"); // 14:00 London, 02:00 next day Auckland
  ck("7b. Timezone: blank -> Europe/London marked 'default'; invalid -> organisation_timezone_invalid; todayIn() uses ctx.timezone",
    blankTz.ok && blankTz.context.timezoneSource === "default" && blankTz.context.timezone === "Europe/London"
    && !badTz.ok && badTz.code === "organisation_timezone_invalid"
    && nz.ok && todayIn(nz.context, at) === "2026-10-04" && a.ok && todayIn(a.context, at) === "2026-10-03");
}

// =================== M. Modules ===================
{
  const rowsAllOff = MODULES.map((m) => feature(m.key, false));
  const core = ["module_schedule", "module_coaches", "module_players_parents", "module_system"];
  core.forEach((k, i) => {
    const off = getModuleState(rowsAllOff, k), none = getModuleState([], k);
    ck(`${8 + i}. ${k} is core: enabled/core even when its row says off or is missing`, off.enabled && off.reason === "core" && none.enabled && none.reason === "core");
  });
  ck("12. Finance explicit ON -> enabled", getModuleState([feature("module_finance", true)], "module_finance").enabled === true);
  const off = getModuleState([feature("module_finance", false)], "module_finance");
  ck("13. Finance explicit OFF -> disabled", !off.enabled && off.reason === "disabled");
  const miss = getModuleState([], "module_finance");
  ck("14. Finance missing row -> off (missing)", !miss.enabled && miss.reason === "missing");
  const conf = getModuleState([feature("module_finance", true, "recFinOnXXXXXXXXX"), feature("module_finance", false, "recFinOffXXXXXXXX")], "module_finance");
  ck("15. Finance conflicting rows -> off (conflicting)", !conf.enabled && conf.reason === "conflicting");
  const dev = getModuleState([feature("module_development", true)], "module_development");
  const devMissing = getModuleState([], "module_development");
  ck("16. Development: optional, follows its row (TEST row ON -> enabled), missing -> off, and it is not user-facing yet",
    dev.enabled && dev.reason === "enabled" && !devMissing.enabled && MODULES.find((m) => m.key === "module_development")!.userFacing === false);
  const comms = getModuleState([feature("module_communications", true)], "module_communications");
  const safe = getModuleState([feature("module_safeguarding", true)], "module_safeguarding");
  ck("17. Communications / Safeguarding are not built: always off (unavailable) even if a row says on", !comms.enabled && comms.reason === "unavailable" && !safe.enabled && safe.reason === "unavailable");
  const legacyMissing = getModuleState([], "legacy_assigned_coaches");
  const legacyOn = getModuleState([feature("legacy_assigned_coaches", true)], "legacy_assigned_coaches");
  const unknown = getModuleState([feature("module_anything", true)], "module_anything");
  ck("18. Legacy fail-open never leaks: legacy_assigned_coaches -> off/legacy (missing or not); unknown keys -> off/unknown",
    !legacyMissing.enabled && legacyMissing.reason === "legacy" && !legacyOn.enabled && LEGACY_FEATURE_KEYS.includes("legacy_assigned_coaches") && !unknown.enabled && unknown.reason === "unknown");
}

// =================== Harness for the real bundles ===================
type Rec = { id: string; createdTime?: string; fields: Record<string, any> };
type Profile = { user_id: string; role: string; active: boolean; organisation_id: string; airtable_person_id: string | null; display_name: string | null };
interface World { tables: Record<string, Rec[]>; profiles: Profile[]; users: Record<string, { id: string; email: string }>; pg: Record<string, any[]>; pgReads: string[] }
let W: World;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "api.airtable.com") {
    const name = decodeURIComponent(url.pathname.split("/").filter(Boolean)[2]);
    return json({ records: structuredClone(W.tables[name] || []) });
  }
  if (url.hostname === "fake.supabase.test" && url.pathname.startsWith("/rest/v1/")) {
    const table = url.pathname.slice("/rest/v1/".length);
    W.pgReads.push(url.search);
    const orgFilter = (url.searchParams.get("organisation_id") || "").replace(/^eq\./, "");
    const prov = (url.searchParams.get("provider") || "").replace(/^eq\./, "");
    const cols = (url.searchParams.get("select") || "*").split(",");
    const rows = (W.pg[table] || []).filter((r) => r.organisation_id === orgFilter && (!prov || r.provider === prov));
    return json(rows.map((r) => (cols[0] === "*" ? r : Object.fromEntries(cols.map((c) => [c, r[c]])))));
  }
  return json({ error: `unexpected fetch ${url}` }, 599);
}) as typeof fetch;
(globalThis as any).__S1A_WORLD = () => W;
const SUPABASE_STUB = `export function createClient(url, key, opts) {
  const W = globalThis.__S1A_WORLD();
  const auth = ((opts && opts.global && opts.global.headers && opts.global.headers.Authorization) || "").replace("Bearer ", "");
  return {
    auth: { getUser: async () => { const u = W.users[auth]; return u ? { data: { user: { id: u.id, email: u.email } }, error: null } : { data: { user: null }, error: { message: "invalid" } }; } },
    from() { const eqs = []; const b = { select() { return b; }, eq(c, v) { eqs.push([c, v]); return b; },
      async single() { const r = W.profiles.find((p) => eqs.every(([c, v]) => p[c] === v)); return r ? { data: { ...r }, error: null } : { data: null, error: { message: "no rows" } }; } }; return b; },
  };
}`;
type Handler = (req: Request) => Promise<Response>;
const ENV: Record<string, string> = { AIRTABLE_BASE_ID: "appQktredAuGa1X7e", AIRTABLE_TOKEN: "t", SUPABASE_URL: "https://fake.supabase.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service" };
let bootSlot: Handler | null = null;
(globalThis as any).Deno = { env: { get: (k: string) => ENV[k] ?? "" }, serve: (h: Handler) => { bootSlot = h; } };
const TMP = mkdtempSync(join(tmpdir(), "s1a-"));
let seq = 0;
async function boot(fn: string, files: string[], fromBaseline: boolean): Promise<Handler> {
  const dir = join(TMP, `b${++seq}`);
  for (const f of files) {
    const rel = `supabase/functions-test/${f}`;
    const src = fromBaseline ? execFileSync("git", ["show", `${BASELINE}:${rel}`], { cwd: ROOT, encoding: "utf8" }) : readFileSync(join(ROOT, rel), "utf8");
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), src);
  }
  const out = await esbuild.build({ entryPoints: [join(dir, fn, "index.ts")], bundle: true, format: "esm", platform: "neutral", write: false, external: ["jsr:*"], logLevel: "silent" });
  const code = out.outputFiles[0].text.replace(/"jsr:@supabase\/supabase-js@2"/g, JSON.stringify("data:text/javascript," + encodeURIComponent(SUPABASE_STUB)));
  const file = join(dir, "bundle.mjs");
  writeFileSync(file, code);
  bootSlot = null;
  await import(pathToFileURL(file).href);
  if (!bootSlot) throw new Error(`${fn} did not boot`);
  return bootSlot;
}
const call = async (h: Handler, fn: string, path: string, token?: string, method = "GET") => {
  const res = await h(new Request(`https://fake.supabase.test/functions/v1/${fn}/${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }));
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
};

const U = { mgr: "11111111-1111-4111-8111-111111111111", coach: "22222222-2222-4222-8222-222222222222", parent: "33333333-3333-4333-8333-333333333333", other: "44444444-4444-4444-8444-444444444444" };
function seed(): void {
  W = {
    tables: {
      "Organisation & Branding": [structuredClone(ORG_A)],
      "Feature Controls": [
        feature("module_finance", true), feature("module_schedule", true), feature("module_coaches", true), feature("module_players_parents", true),
        feature("module_system", true), feature("module_development", true), feature("module_communications", false), feature("module_safeguarding", false),
      ],
      "Hub Settings": [{ id: "recHubSetXXXXXXXX", fields: { Setting: "my_players_label", Label: "My Players", Active: true } }],
    },
    profiles: [
      { user_id: U.mgr, role: "management", active: true, organisation_id: "ORG-TEST-001", airtable_person_id: null, display_name: "M" },
      { user_id: U.coach, role: "coach", active: true, organisation_id: "ORG-TEST-001", airtable_person_id: null, display_name: "C" },
      { user_id: U.parent, role: "parent", active: true, organisation_id: "ORG-TEST-001", airtable_person_id: null, display_name: "P" },
      { user_id: U.other, role: "management", active: true, organisation_id: "ORG-OTHER-999", airtable_person_id: null, display_name: "O" },
    ],
    users: { "tok-mgr": { id: U.mgr, email: "m@t" }, "tok-coach": { id: U.coach, email: "c@t" }, "tok-parent": { id: U.parent, email: "p@t" }, "tok-other": { id: U.other, email: "o@t" } },
    pg: {
      finance_external_connections: [{ organisation_id: "ORG-TEST-001", provider: "xero", status: "disconnected", last_success_at: "2026-10-01T08:48:37Z", last_error_at: null, last_error_code: null, client_id: "zztest-client", client_secret_id: null, tenant_id: "tenant-uuid" }],
      finance_stripe_connections: [{ organisation_id: "ORG-TEST-001", status: "disconnected", last_success_at: "2026-10-03T11:59:34Z", last_error_at: null, last_error_code: null, secret_id: null, account_id: null }],
      finance_reporting_connections: [{ organisation_id: "ORG-TEST-001", provider: "google_sheets", connection_state: "connected", last_sync_result: "succeeded", last_sync_success_at: "2026-10-03T12:00:19Z", last_sync_error_code: null, spreadsheet_id: "SBX_F19_TEST_REPORTING_WB01" }],
      // Another organisation's rows must never appear.
      finance_external_connections_other: [],
    },
    pgReads: [],
  };
  W.pg.finance_stripe_connections.push({ organisation_id: "ORG-OTHER-999", status: "connected", last_success_at: "2026-01-01T00:00:00Z", last_error_at: "2026-02-01T00:00:00Z", last_error_code: "OTHER_ORG_ERROR", secret_id: "secret" });
}
const setActive = (uid: string, v: boolean) => { W.profiles.find((p) => p.user_id === uid)!.active = v; };

(async () => {
  const SET = await boot("settings", ["settings/index.ts", "settings/settings-system.ts", "_shared/organisation-context.ts"], false);
  const HC = await boot("hub-content", ["hub-content/index.ts", "hub-content/player-access.ts", "_shared/organisation-context.ts"], false);
  const HC_BASE = await boot("hub-content", ["hub-content/index.ts", "hub-content/player-access.ts"], true);

  // =================== V. Overview ===================
  seed();
  const ok = await call(SET, "settings", "system", "tok-mgr");
  ck("19. Active Management -> 200 overview", ok.status === 200 && ok.data.organisation?.id === "ORG-TEST-001", `${ok.status}`);
  seed();
  const coach = await call(SET, "settings", "system", "tok-coach");
  ck("20. Coach -> 403", coach.status === 403);
  const parent = await call(SET, "settings", "system", "tok-parent");
  ck("21. Parent -> 403", parent.status === 403);
  setActive(U.mgr, false);
  const inactive = await call(SET, "settings", "system", "tok-mgr");
  ck("22. Inactive Management -> 403 inactive_profile", inactive.status === 403 && inactive.data.code === "inactive_profile");
  seed();
  const noAuth = await call(SET, "settings", "system");
  const param = await call(SET, "settings", "system?organisation_id=ORG-OTHER-999", "tok-mgr");
  const param2 = await call(SET, "settings", "system?tenant=x", "tok-mgr");
  const other = await call(SET, "settings", "system", "tok-other");
  const post = await call(SET, "settings", "system", "tok-mgr", "POST");
  ck("23. No organisation override: ?organisation_id / ?tenant -> 400 organisation_parameter_not_accepted; another org's manager -> 403 organisation_mismatch; no token -> 401; POST -> 405",
    param.status === 400 && param.data.code === "organisation_parameter_not_accepted" && param2.status === 400 && other.status === 403 && other.data.code === "organisation_mismatch" && noAuth.status === 401 && post.status === 405);
  const leaks = [ORG_A.id, "recF", "zztest-client", "tenant-uuid", "SBX_F19", "secret", "client_id", "tenant_id", "spreadsheet", "Feature Key", "OTHER_ORG_ERROR", "Warning", "Threshold", "vault"];
  ck("24. No secrets / internal ids: no Airtable record ids, client/tenant/spreadsheet ids, secret ids, raw Feature Controls fields, other-org data or NA thresholds",
    leaks.every((l) => !ok.text.includes(l)), leaks.filter((l) => ok.text.includes(l)).join(","));
  ck("25. Organisation summary = { id, displayName, timezone } from the record",
    JSON.stringify(ok.data.organisation) === JSON.stringify({ id: "ORG-TEST-001", displayName: "Test Org", timezone: "Europe/London" }));
  const mods = ok.data.modules || [];
  ck("26. Modules small and clear: 4 core (enabled/core) + Finance only; nothing editable; Development / Communications / Safeguarding not surfaced",
    mods.length === 5 && mods.filter((m: any) => m.kind === "core").every((m: any) => m.enabled && m.reason === "core") && mods.find((m: any) => m.key === "module_finance")?.enabled === true
    && mods.every((m: any) => m.editable === false) && !mods.some((m: any) => /development|communications|safeguarding/.test(m.key)));
  const con = ok.data.connections || [];
  ck("27. Connections read-only and redacted: Xero / Stripe / Google Sheets, status + last success + error code, managedIn finance; only health columns selected; only this org",
    con.length === 3 && con.every((c: any) => c.managedIn === "finance" && Object.keys(c).sort().join() === "label,lastErrorCode,lastSuccessAt,managedIn,needsAttention,provider,status")
    && con.find((c: any) => c.provider === "xero").status === "disconnected" && con.find((c: any) => c.provider === "google_sheets").status === "connected"
    && W.pgReads.every((s) => s.includes("organisation_id=eq.ORG-TEST-001") && !s.includes("select=*")) && ok.data.system.status === "healthy" && /^\d{4}-\d{2}-\d{2}$/.test(ok.data.system.today));
  // Pure overview: failing connection -> attention, stale error after recovery hidden.
  const ctx = (resolveOrganisationContext({ active: true, organisationId: "ORG-TEST-001" }, [ORG_A]) as any).context;
  const ov = buildSettingsSystemOverview({ context: ctx, featureRows: [], xero: [{ status: "connected", last_success_at: "2026-10-01T00:00:00Z", last_error_at: "2026-10-02T00:00:00Z", last_error_code: "xero_unauthorised" }],
    stripe: [{ status: "connected", last_success_at: "2026-10-03T00:00:00Z", last_error_at: "2026-10-02T00:00:00Z", last_error_code: "old" }], sheets: [] });
  ck("27b. Health: a current failure -> needsAttention + code + system 'attention'; a recovered error is not shown; no row -> not_connected; Finance missing -> off",
    ov.system.status === "attention" && ov.connections[0].lastErrorCode === "xero_unauthorised" && ov.connections[1].lastErrorCode === null && !ov.connections[1].needsAttention
    && ov.connections[2].status === "not_connected" && ov.modules.find((m) => m.key === "module_finance")!.enabled === false);

  // =================== H. hub-content /settings ===================
  seed();
  const pubNew = await call(HC, "hub-content", "settings");
  const pubBase = await call(HC_BASE, "hub-content", "settings");
  const rootNew = await call(HC, "hub-content", "");
  const rootBase = await call(HC_BASE, "hub-content", "");
  const anonNew = await call(HC, "hub-content", "settings", "anon-key-not-a-user");
  ck("31. Public bootstrap unchanged: no user session -> byte-identical to 10e9c98 (/settings and the bare route; anon key too)",
    pubNew.status === 200 && pubNew.text === pubBase.text && rootNew.text === rootBase.text && anonNew.text === pubBase.text);
  // Authenticated: put another Active org FIRST so "first Active row" would be wrong.
  seed();
  W.tables["Organisation & Branding"].unshift(org("recOrgFirstXXXXXX", { "Organisation ID": "ORG-FIRST", "Organisation Name": "First Org", "Hub Name": "WRONG HUB", Active: true }));
  const authNew = await call(HC, "hub-content", "settings", "tok-coach");
  const pubFirst = await call(HC, "hub-content", "settings");
  const pubFirstBase = await call(HC_BASE, "hub-content", "settings");
  ck("28. Authenticated read resolves the caller's own organisation (exact ID), not the first Active row",
    authNew.status === 200 && authNew.data.organisation.organisation_id === "ORG-TEST-001" && authNew.data.organisation.hub_name === "Test Hub" && authNew.data.settings.my_players_label === "My Players"
    && pubFirst.data.organisation.organisation_id === "ORG-FIRST" && pubFirst.text === pubFirstBase.text);
  seed();
  W.tables["Organisation & Branding"].push(org("recOrgDupeXXXXXXX", { ...ORG_A.fields }));
  const amb = await call(HC, "hub-content", "settings", "tok-mgr");
  const mismatch = await call(HC, "hub-content", "settings", "tok-other");
  ck("29. Ambiguous organisation fails closed (409 organisation_ambiguous); another org's user -> 403 organisation_mismatch",
    amb.status === 409 && amb.data.code === "organisation_ambiguous" && mismatch.status === 403 && mismatch.data.code === "organisation_mismatch");
  seed();
  setActive(U.parent, false);
  const inact = await call(HC, "hub-content", "settings", "tok-parent");
  ck("30. Inactive signed-in profile fails closed on the authenticated path (403 inactive_profile)", inact.status === 403 && inact.data.code === "inactive_profile");
  seed();
  const authSame = await call(HC, "hub-content", "settings", "tok-mgr");
  ck("30b. Single-organisation TEST shape: the authenticated payload equals the public payload (same builder, same organisation)", authSame.text === pubBase.text);

  // =================== R. Regression / equivalence ===================
  const base = (f: string) => execFileSync("git", ["show", `${BASELINE}:supabase/functions-test/${f}`], { cwd: ROOT, encoding: "utf8" });
  const now = (f: string) => readFileSync(join(FUNCS, f), "utf8");
  const untouched = ["finance/finance-access.ts", "finance/index.ts", "needs-attention/needs-attention.ts", "needs-attention/index.ts", "session-occurrences/occurrence-confirmation.ts", "parent-hub/index.ts", "parent-hub/parent-identity.ts", "hub-content/player-access.ts"];
  const changed = untouched.filter((f) => base(f) !== now(f));
  ck("32-36. Finance, Needs Attention, occurrence confirmation, parent-hub (P1) and player access are byte-identical to 10e9c98 (not switched over in S1-a)", changed.length === 0, changed.join(","));
  // Contract equivalence with the existing Finance/NA copies.
  const cases: [string, ConfigRow[]][] = [
    ["ORG-TEST-001", [ORG_A]], ["ORG-TEST-001", []], ["ORG-TEST-001", [ORG_A, org("recOrgDupeXXXXXXX", { ...ORG_A.fields })]],
    ["ORG-OTHER-999", [ORG_A]], ["", [ORG_A]], ["ORG-TEST-001", [org("recOrgInactiveXXX", { ...ORG_A.fields, Active: false })]],
    ["ORG-TEST-001", [org("recOrgFirstXXXXXX", { "Organisation ID": "ORG-FIRST", Active: true }), ORG_A]],
  ];
  const eq = cases.every(([pid, rows]) => {
    const fin = financeResolveOrganisation(pid, rows as any);
    const mine = resolveOrganisationContext({ active: true, organisationId: pid }, rows);
    if (fin.ok !== mine.ok) return false;
    if (fin.ok && mine.ok) return fin.organisation.recordId === mine.context.organisationRecordId && fin.organisation.timezone === mine.context.timezone;
    const mapped = !mine.ok && mine.code === "organisation_mismatch" ? "organisation_not_found" : (mine as any).code;
    return (fin as any).code === mapped;
  });
  ck("E1. Same organisation decisions as Finance/NA resolveOrganisation on every case (mismatch is Finance's not_found, split out)", eq);
  const modCases: ConfigRow[][] = [[], [feature("module_finance", true)], [feature("module_finance", false)], [feature("module_finance", true, "recA1xxxxxxxxxxxx"), feature("module_finance", false, "recA2xxxxxxxxxxxx")]];
  ck("E2. Optional-module semantics identical to Finance/NA moduleState for module_finance (enabled / disabled / missing / conflicting)",
    modCases.every((rows) => { const a = financeModuleState(rows as any, "module_finance"); const b = getModuleState(rows, "module_finance"); return a.active === b.enabled && a.reason === b.reason; }));
  const hc = now("hub-content/index.ts");
  ck("E3. hub-content: legacy_assigned_coaches path left as documented DEBT (still its own missing-row default), /players untouched",
    hc.includes('legacyFlag ? legacyFlag.fields["Enabled"] === true : true') && base("hub-content/index.ts").includes('legacyFlag ? legacyFlag.fields["Enabled"] === true : true'));
  const shared = now("_shared/organisation-context.ts");
  ck("E4. Shared module is portable (no Deno / network) and is the single source both callers import",
    !/Deno\.|fetch\(/.test(shared) && hc.includes('from "../_shared/organisation-context.ts"') && now("settings/index.ts").includes('from "../_shared/organisation-context.ts"'));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
  console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
