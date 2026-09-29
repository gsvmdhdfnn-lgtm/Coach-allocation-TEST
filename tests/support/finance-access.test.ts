/**
 * Finance Foundation F1 - Finance access + core API boundary.
 * Run: node --experimental-strip-types tests/support/finance-access.test.ts
 *
 *   A   pure access policy (levels, eligibility, revocation, organisation, malformed values)
 *   T   tenant / request-shape rejection (query + body)
 *   O   organisation + module resolution
 *   R   orchestrator decisions over a mocked grant store + Airtable (fetch mock)
 *   C   public response contract (no internals leak)
 *   Z   code / drift checks against the canonical supabase/functions-test/finance files
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FinanceCaller,
  type FinanceGrantRow,
  FINANCE_CONTRACT,
  FINANCE_MODULE_KEY,
  buildAccessBody,
  capabilitiesFor,
  checkEmptyBody,
  checkQueryKeys,
  isTenantKey,
  moduleState,
  resolveFinanceAccess,
  resolveOrganisation,
  satisfies,
} from "./finance-access.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type Deps, authorizeFinance } from "./finance-orchestrator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");
const NA_CANON = join(HERE, "..", "..", "supabase", "functions-test", "needs-attention");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

const ORG = "ORG-TEST-001";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const COACH = "1bc04193-ee30-4fa3-a5fd-bf7cc0dac504";
const mgr = (over: Partial<FinanceCaller> = {}): FinanceCaller => ({ userId: MGR, role: "management", active: true, organisationId: ORG, ...over });
const g = (level: unknown, org: unknown = ORG, revoked: unknown = null): FinanceGrantRow => ({ organisation_id: org, access_level: level, revoked_at: revoked });

// ---------------------------------------------------------------------------
// fetch mock: PostgREST grant store + Airtable config tables
// ---------------------------------------------------------------------------
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  orgs: { id: string; fields: Record<string, unknown> }[];
  features: { id: string; fields: Record<string, unknown> }[];
  grantStatus?: number;
  grantBody?: unknown;
  airtableStatus?: number;
}
let world: World;
let calls: { url: string; method: string; headers: Record<string, string> }[] = [];
const ORG_ROW = { id: "recYXqi1DTZ8ZECPQ", fields: { "Organisation ID": ORG, "Organisation Name": "Josh Evans Soccer School (TEST)", Timezone: "Europe/London", Active: true } };
const FIN_ON = { id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, Enabled: true } };
const FIN_OFF = { id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY } };
const COACHES_ON = { id: "recD6JSqZV7l7391m", fields: { "Feature Key": "module_coaches", Enabled: true } };

function reset(over: Partial<World> = {}) {
  world = { grants: { [MGR]: [g("manage")] }, orgs: [ORG_ROW], features: [FIN_ON, COACHES_ON], ...over };
  calls = [];
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  calls.push({ url, method, headers });
  if (method !== "GET") return json({ error: "writes are never expected in F1" }, 599);
  if (url.includes("/rest/v1/finance_access_grants")) {
    if (world.grantStatus) return json({ message: "boom" }, world.grantStatus);
    if (world.grantBody !== undefined) return json(world.grantBody);
    const u = new URL(url);
    const m = /^eq\.(.+)$/.exec(u.searchParams.get("user_id") || "");
    return json(m ? world.grants[m[1]] ?? [] : []);
  }
  if (url.startsWith("https://api.airtable.com/")) {
    if (world.airtableStatus) return json({ error: "boom" }, world.airtableStatus);
    if (url.includes(encodeURIComponent("Organisation & Branding"))) return json({ records: world.orgs });
    if (url.includes(encodeURIComponent("Feature Controls"))) return json({ records: world.features });
    return json({ records: [] });
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

const deps: Deps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
};
const airtableCalls = () => calls.filter((c) => c.url.startsWith("https://api.airtable.com/")).length;
const grantCalls = () => calls.filter((c) => c.url.includes("/rest/v1/finance_access_grants"));

async function main() {
  RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1, 1, 1, 1, 1);

  // ===== A. Pure access policy =====
  {
    ck("A1. Coach is never Finance-eligible, even holding a manage grant", resolveFinanceAccess(mgr({ userId: COACH, role: "coach" }), [g("manage")]).access === "none" && resolveFinanceAccess(mgr({ role: "coach" }), [g("manage")]).reason === "not_management");
    ck("A2. Parent / pending / unknown / missing role are never Finance-eligible", ["parent", "pending", "admin", "Management", "", null].every((role) => resolveFinanceAccess(mgr({ role: role as any }), [g("manage")]).access === "none"));
    ck("A3. Inactive Management profile is refused (inactive_profile)", resolveFinanceAccess(mgr({ active: false }), [g("manage")]).reason === "inactive_profile");
    ck("A4. Management with no grant -> none (Management never implies Finance access)", JSON.stringify(resolveFinanceAccess(mgr(), [])) === JSON.stringify({ access: "none", reason: "no_grant" }));
    ck("A5. view grant -> view; manage grant -> manage", resolveFinanceAccess(mgr(), [g("view")]).access === "view" && resolveFinanceAccess(mgr(), [g("manage")]).access === "manage");
    ck("A6. A revoked grant is ignored (revoked view + no active -> none)", resolveFinanceAccess(mgr(), [g("manage", ORG, "2026-09-29T10:00:00Z")]).access === "none");
    ck("A7. History: revoked view + active manage -> manage", resolveFinanceAccess(mgr(), [g("view", ORG, "2026-09-29T10:00:00Z"), g("manage")]).access === "manage");
    ck("A8. Another organisation's grant never counts (cross-org -> none)", resolveFinanceAccess(mgr(), [g("manage", "ORG-TEST-999")]).reason === "no_grant" && resolveFinanceAccess(mgr({ organisationId: "ORG-TEST-999" }), [g("manage")]).access === "none");
    ck("A9. Two active grants for the organisation -> none (grant_ambiguous, not the higher one)", JSON.stringify(resolveFinanceAccess(mgr(), [g("view"), g("manage")])) === JSON.stringify({ access: "none", reason: "grant_ambiguous" }));
    const malformed = ["admin", "VIEW", "Manage", " view", "manage ", "none", "", null, undefined, 1, true, {}, ["manage"]];
    ck("A10. Malformed / unknown access values fail closed (never mapped to view or manage)", malformed.every((lv) => JSON.stringify(resolveFinanceAccess(mgr(), [g(lv)])) === JSON.stringify({ access: "none", reason: "grant_invalid" })));
    ck("A11. Profile without an organisation -> none (no_profile_organisation)", ["", "   ", null].every((o) => resolveFinanceAccess(mgr({ organisationId: o as any }), [g("manage")]).reason === "no_profile_organisation"));
    ck("A12. Non-string grant organisation never matches", resolveFinanceAccess(mgr(), [g("manage", null), g("manage", 1 as any)]).reason === "no_grant");
    ck("A13. satisfies(): none -> nothing; view -> read only; manage -> read + manage", !satisfies("none", "read") && !satisfies("none", "manage") && satisfies("view", "read") && !satisfies("view", "manage") && satisfies("manage", "read") && satisfies("manage", "manage"));
    ck("A14. capabilitiesFor() mirrors satisfies()", JSON.stringify([capabilitiesFor("none"), capabilitiesFor("view"), capabilitiesFor("manage")]) === JSON.stringify([{ read: false, manage: false }, { read: true, manage: false }, { read: true, manage: true }]));
  }

  // ===== T. Tenant / request shape =====
  {
    ck("T1. Tenant selectors are recognised case-insensitively (org, tenant, Airtable base)", ["organisationId", "ORGANISATION_ID", "organizationId", "org", "tenant", "tenantId", "baseId", "airtable_base_id", "BASE"].every(isTenantKey) && !isTenantKey("view") && !isTenantKey("debug"));
    ck("T2. Query: tenant selector -> 400 tenant_param_rejected", (checkQueryKeys(["organisationId"]) as any).code === "tenant_param_rejected" && (checkQueryKeys(["debug", "Tenant"]) as any).code === "tenant_param_rejected");
    ck("T3. Query: any other parameter -> 400 unexpected_parameter (never silently ignored)", (checkQueryKeys(["debug"]) as any).code === "unexpected_parameter" && checkQueryKeys([]).ok === true);
    ck("T4. Body: empty / whitespace / {} accepted", checkEmptyBody("").ok && checkEmptyBody("  \n").ok && checkEmptyBody("{}").ok);
    ck("T5. Body: tenant key -> tenant_param_rejected; other key -> unexpected_field", (checkEmptyBody('{"organisation_id":"ORG-X"}') as any).code === "tenant_param_rejected" && (checkEmptyBody('{"baseId":"appX"}') as any).code === "tenant_param_rejected" && (checkEmptyBody('{"amount":1}') as any).code === "unexpected_field");
    ck("T6. Body: non-object / invalid JSON -> invalid_body", ["[]", "null", "1", '"x"', "{", "not json"].every((b) => (checkEmptyBody(b) as any).code === "invalid_body"));
  }

  // ===== O. Organisation + module =====
  {
    ck("O1. Organisation resolves only from an exact Active Organisation ID match", resolveOrganisation(ORG, [ORG_ROW]).ok === true && (resolveOrganisation("org-test-001", [ORG_ROW]) as any).code === "organisation_not_found");
    ck("O2. Inactive organisation row -> organisation_not_found", (resolveOrganisation(ORG, [{ ...ORG_ROW, fields: { ...ORG_ROW.fields, Active: false } }]) as any).code === "organisation_not_found");
    ck("O3. Two Active rows with the same ID -> organisation_ambiguous", (resolveOrganisation(ORG, [ORG_ROW, { ...ORG_ROW, id: "recOther" }]) as any).code === "organisation_ambiguous");
    ck("O4. module_finance: enabled only when every row for the key is Enabled", moduleState([FIN_ON], FINANCE_MODULE_KEY).active === true && moduleState([FIN_OFF], FINANCE_MODULE_KEY).reason === "disabled" && moduleState([], FINANCE_MODULE_KEY).reason === "missing" && moduleState([FIN_ON, { ...FIN_OFF, id: "rec2" }], FINANCE_MODULE_KEY).reason === "conflicting");
    ck("O5. Another module being on never enables Finance", moduleState([COACHES_ON], FINANCE_MODULE_KEY).active === false);
  }

  // ===== R. Orchestrator decisions =====
  {
    reset();
    const m = await authorizeFinance(deps, mgr(), "read");
    ck("R1. Manage grant + module on -> authorised read (manage)", m.status === "ok" && (m as any).access === "manage" && (m as any).organisation.organisationId === ORG);
    reset();
    const mw = await authorizeFinance(deps, mgr(), "manage");
    ck("R2. Manage grant -> authorised manage", mw.status === "ok");

    reset({ grants: { [MGR]: [g("view")] } });
    const vr = await authorizeFinance(deps, mgr(), "read");
    reset({ grants: { [MGR]: [g("view")] } });
    const vw = await authorizeFinance(deps, mgr(), "manage");
    ck("R3. View grant -> read allowed; manage 403 finance_manage_required", vr.status === "ok" && (vr as any).access === "view" && vw.status === "denied" && (vw as any).httpStatus === 403 && (vw as any).code === "finance_manage_required");

    reset({ grants: {} });
    const none = await authorizeFinance(deps, mgr(), "read");
    ck("R4. Management without a grant -> 403 finance_access_denied, and Airtable is never read", none.status === "denied" && (none as any).httpStatus === 403 && (none as any).code === "finance_access_denied" && airtableCalls() === 0);

    reset();
    const coach = await authorizeFinance(deps, mgr({ userId: COACH, role: "coach" }), "read");
    ck("R5. Coach (even with a grant row) -> 403 management_required before any store read", coach.status === "denied" && (coach as any).code === "management_required" && calls.length === 0);
    reset();
    const parent = await authorizeFinance(deps, mgr({ role: "parent" }), "read");
    ck("R6. Parent -> 403 management_required", parent.status === "denied" && (parent as any).code === "management_required");
    reset();
    const inactive = await authorizeFinance(deps, mgr({ active: false }), "read");
    ck("R7. Inactive Management -> 403 management_required", inactive.status === "denied" && (inactive as any).code === "management_required");

    reset({ features: [FIN_OFF, COACHES_ON] });
    const off = await authorizeFinance(deps, mgr(), "read");
    reset({ features: [COACHES_ON] });
    const missing = await authorizeFinance(deps, mgr(), "read");
    reset({ features: [FIN_ON, { ...FIN_OFF, id: "rec2" }] });
    const conflicting = await authorizeFinance(deps, mgr(), "manage");
    ck("R8. module_finance off / missing / conflicting -> 403 finance_module_disabled (read and write)", [off, missing, conflicting].every((o) => o.status === "denied" && (o as any).httpStatus === 403 && (o as any).code === "finance_module_disabled"));

    reset({ grants: { [MGR]: [g("manage", "ORG-TEST-999")] } });
    const cross = await authorizeFinance(deps, mgr(), "read");
    ck("R9. A grant for another organisation gives no access to this one", cross.status === "denied" && (cross as any).code === "finance_access_denied");

    reset({ grants: { [MGR]: [g("manage", "ORG-TEST-999")] }, orgs: [ORG_ROW, { id: "recOrg999", fields: { "Organisation ID": "ORG-TEST-999", "Organisation Name": "Other", Active: true } }] });
    const other = await authorizeFinance(deps, mgr(), "read");
    ck("R10. Cannot reach another organisation's Finance context even when it exists and has a grant for this user", other.status === "denied" && (other as any).code === "finance_access_denied");

    reset({ orgs: [] });
    const noOrg = await authorizeFinance(deps, mgr(), "read");
    reset({ orgs: [ORG_ROW, { ...ORG_ROW, id: "recDup" }] });
    const dupOrg = await authorizeFinance(deps, mgr(), "read");
    ck("R11. Organisation not found / ambiguous -> 409, fails closed", noOrg.status === "denied" && (noOrg as any).httpStatus === 409 && (noOrg as any).code === "organisation_not_found" && (dupOrg as any).code === "organisation_ambiguous");

    reset({ grants: { [MGR]: [g("admin")] } });
    const bad = await authorizeFinance(deps, mgr(), "read");
    reset({ grants: { [MGR]: [g("view"), g("manage")] } });
    const amb = await authorizeFinance(deps, mgr(), "read");
    ck("R12. Malformed or ambiguous stored grant -> 403 finance_access_denied", (bad as any).code === "finance_access_denied" && (amb as any).code === "finance_access_denied");

    reset({ grantStatus: 500 });
    const storeDown = await authorizeFinance(deps, mgr(), "read");
    reset({ grantBody: { not: "an array" } });
    const storeOdd = await authorizeFinance(deps, mgr(), "read");
    reset({ airtableStatus: 500 });
    const atDown = await authorizeFinance(deps, mgr(), "read");
    ck("R13. Grant store / Airtable failure -> 503, never 'assume access'", (storeDown as any).httpStatus === 503 && (storeDown as any).code === "finance_access_unavailable" && (storeOdd as any).httpStatus === 503 && (atDown as any).httpStatus === 503 && (atDown as any).code === "finance_config_unavailable");

    reset();
    await authorizeFinance(deps, mgr(), "read");
    const gc = grantCalls();
    const gu = gc.length === 1 ? new URL(gc[0].url) : null;
    ck("R14. Grant lookup: exactly one read, filtered by the authenticated caller's user id only, service role headers", gc.length === 1 && gu!.searchParams.get("user_id") === `eq.${MGR}` && [...gu!.searchParams.keys()].sort().join() === "select,user_id" && gc[0].headers["apikey"] === "service-role-test" && gc[0].headers["authorization"] === "Bearer service-role-test");
    ck("R15. Config tables each read once; every request is a GET (F1 writes nothing)", airtableCalls() === 2 && calls.every((c) => c.method === "GET"));

    reset();
    let threw = false;
    try {
      await authorizeFinance(deps, mgr({ userId: "not-a-uuid" }), "read");
    } catch {
      threw = true;
    }
    const oddId = await authorizeFinance(deps, mgr({ userId: "x&user_id=neq.0" }), "read");
    ck("R16. A non-UUID caller id is never sent to the grant store (fails closed, no query injection)", !threw && (oddId as any).code === "finance_access_unavailable" && grantCalls().length === 0);
  }

  // ===== C. Public response contract =====
  {
    reset({ grants: { [MGR]: [g("view")] } });
    const out = await authorizeFinance(deps, mgr(), "read");
    const body = buildAccessBody((out as any).organisation, (out as any).access);
    ck("C1. Access body keys are exactly contract/organisation/module/access/capabilities", Object.keys(body).join() === "contract,organisation,module,access,capabilities" && body.contract === FINANCE_CONTRACT);
    ck("C2. Organisation exposes only organisationId + name (no Airtable record id, timezone, other orgs)", Object.keys(body.organisation).join() === "organisationId,name" && body.organisation.organisationId === ORG);
    ck("C3. View body: access view, capabilities read true / manage false, module enabled", body.access === "view" && body.capabilities.read === true && body.capabilities.manage === false && body.module.key === FINANCE_MODULE_KEY && body.module.enabled === true);
    const s = JSON.stringify(body);
    ck("C4. No user id, grant data, service key or Airtable ids in the body", !s.includes(MGR) && !/service|revoked|granted|rec[A-Za-z0-9]{14}|app[A-Za-z0-9]{14}|token/i.test(s));
  }

  // ===== Z. Code / drift =====
  {
    const canon = (f: string) => readFileSync(join(CANON, f), "utf8");
    const support = (f: string) => readFileSync(join(HERE, f), "utf8");
    const stripHeader = (s: string) => s.replace(/^\/\*\*\n \* Test-suite copy[\s\S]*?\*\/\n/, "");
    ck("Z1. finance-access.ts support copy is byte-identical to canonical", stripHeader(support("finance-access.ts")) === canon("finance-access.ts"));
    ck("Z2. finance-repository.ts support copy is byte-identical to canonical repository.ts", stripHeader(support("finance-repository.ts")) === canon("repository.ts"));
    ck("Z3. finance-orchestrator.ts support copy = canonical orchestrator.ts with only the repository import path adjusted", stripHeader(support("finance-orchestrator.ts")) === canon("orchestrator.ts").replace('"./repository.ts"', '"./finance-repository.ts"'));
    const pure = canon("finance-access.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("Z4. finance-access.ts is pure: no fetch, Deno, Supabase or Airtable calls", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(pure));
    const fn = (src: string, name: string) => {
      const i = src.indexOf(`export function ${name}(`);
      const j = src.indexOf("\n}\n", i);
      return i < 0 || j < 0 ? null : src.slice(i, j + 2);
    };
    const na = readFileSync(join(NA_CANON, "needs-attention.ts"), "utf8");
    ck("Z5. resolveOrganisation() and moduleState() are byte-identical to Needs Attention's", ["resolveOrganisation", "moduleState"].every((n) => fn(na, n) !== null && fn(na, n) === fn(canon("finance-access.ts"), n)));
    const repo = canon("repository.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("Z6. Repository is read-only: no POST/PATCH/PUT/DELETE, no method override", !/method\s*:|"POST"|"PATCH"|"PUT"|"DELETE"/.test(repo));
    const idx = canon("index.ts");
    ck("Z7. index.ts boot-refuses production Airtable bases AND the production Supabase project", idx.includes("apprptFotQuVL1mhs") && idx.includes('PRODUCTION_SUPABASE_REFS = ["bkkukymqaxawnudoxdjs"]') && (idx.match(/throw new Error\(/g) ?? []).length >= 3);
    ck("Z8. Only two routes exist: GET access, POST write-check", /const ROUTES: Record<string, string> = \{ access: "GET", "write-check": "POST" \};/.test(idx));
    ck("Z9. write-check authorises 'manage' and persists nothing", /authorizeFinance\(deps, caller, "manage"\)/.test(idx) && /persisted: false/.test(idx) && !/insert|upsert|update\(|\.from\("finance/.test(idx));
    ck("Z10. Tenant query/body checks run on every route after the Management check; 500s never echo internals", idx.indexOf("isFinanceEligible(caller)") < idx.indexOf("checkQueryKeys(") && /jsonResponse\(\{ error: "Unexpected error" \}, 500\)/.test(idx));
    const all = ["finance-access.ts", "repository.ts", "orchestrator.ts", "index.ts"].map(canon).join("\n");
    ck("Z11. No Josh Evans naming in the Finance function code", !/josh|evans/i.test(all.replace(/"Josh Evans Hub - the live base"/, "")));
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? `  [${e}]` : ""}`);
  const passed = R.filter((r) => r[0] === "PASS").length;
  console.log(`\n${passed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
