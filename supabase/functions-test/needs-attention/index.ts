/**
 * Needs Attention - engine + API (see TEST-ENV.md "Needs Attention
 * Foundation - Slice 2" and "- Slice 5"). Thin HTTP wrapper, same
 * convention as the Coaches functions: rules live in needs-attention.ts
 * (pure) / exceptions.ts (pure exception policy) / repository.ts (Airtable
 * I/O) / orchestrator.ts (composition) / registry.ts (code-side evaluator
 * registrations). This file only authenticates/authorises, parses the
 * request, maps outcomes to HTTP responses, and boot-refuses against
 * production.
 *
 * Routes (Management only; Coach/Parent/pending/inactive -> 403, no auth -> 401):
 *   GET  /cases                    full queue: summary + ordered cases + configIssues
 *   GET  /cases?view=summary       summary only (Home state, counts)
 *   GET  /cases?caseKey=<key>      does this exact case currently exist?
 *   ...&debug=1                    adds diagnostics (skipped rules + reasons, read counts)
 *   POST /exceptions               { caseKey, reason, effectiveUntil? } -> approve an exact-case exception
 *   POST /exceptions/revoke        { exceptionId, reason } -> revoke (Active = false + revoke audit fields)
 *
 * The organisation is ALWAYS resolved from the caller's own Supabase
 * profile (organisation_id) - any tenant-looking query parameter or body
 * key is rejected with 400 rather than ignored. The only writes are the
 * two exception routes (one Needs Attention Exceptions row created or
 * patched); no Settings or other table is ever written, nothing deleted.
 *
 * Finance F8a: Finance (module_finance) cases are shown only to a caller
 * holding Finance View or Manage - the caller's own F1 grant rows are read
 * (GET, service role) only when a Finance rule would run - and only Finance
 * Manage may create / revoke an exception on a Finance case.
 *
 * Finance F16: the Money Out rules read four allowlisted Supabase Finance
 * tables (GET, service role, organisation-scoped from the profile) - only
 * when such a rule runs for a caller holding Finance View / Manage.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createSupabaseLockClient } from "./lock-client.ts";
import { createException, getCases, revokeException, type Caller, type Deps, type WriteOutcome } from "./orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./registry.ts";
import { loadFinanceGrants } from "./repository.ts";
import { resolveFinanceAccess } from "./finance.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;

// ---------------------------------------------------------------------
// TEST DEPLOYMENT GUARD. This copy runs only in the test Supabase
// project against the test Airtable base. If AIRTABLE_BASE_ID is ever a
// known production base, the function refuses to start at all - a boot
// failure is loud and harmless, a silent write to the live base is not.
// Same guard, same wording, as every other TEST function in this repo.
// ---------------------------------------------------------------------
const PRODUCTION_BASE_IDS: Record<string, string> = {
  apprptFotQuVL1mhs: "Josh Evans Hub - the live base",
  app6ex6UHY2RRO2Ak: "Master Copy - the template",
};
if (PRODUCTION_BASE_IDS[AIRTABLE_BASE_ID]) {
  throw new Error(
    `TEST function refusing to start: AIRTABLE_BASE_ID is ${AIRTABLE_BASE_ID} (${PRODUCTION_BASE_IDS[AIRTABLE_BASE_ID]}). ` +
      `A test deployment must never point at a production base.`
  );
}
if (!/^app[A-Za-z0-9]{14}$/.test(AIRTABLE_BASE_ID || "")) {
  throw new Error("TEST function refusing to start: AIRTABLE_BASE_ID is missing or malformed.");
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
/** Used ONLY for the needs_attention_exception_locks RPCs (service_role-only functions), (F8a) the caller's own Finance grant rows (GET) and (F16) the allowlisted Finance source tables (GET). */
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Same shape/logic as every other TEST function's resolveCaller(), plus organisation_id - copied, not shared, per the "each Edge Function is self-contained" convention. */
async function resolveCaller(authHeader: string | null): Promise<Caller | null> {
  if (!authHeader) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return null;
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, active, organisation_id, display_name")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return {
    userId: userData.user.id,
    role: profile.role,
    active: profile.active === true,
    organisationId: typeof profile.organisation_id === "string" ? profile.organisation_id : null,
    displayName: typeof profile.display_name === "string" ? profile.display_name : null,
    email: typeof userData.user.email === "string" ? userData.user.email : null,
  };
}

/** Tenant is never client-selectable: these parameters are refused outright, not silently ignored. */
const TENANT_PARAMS = ["organisation", "organisationId", "organisation_id", "organization", "organizationId", "org", "orgId", "tenant"];

const deps: Deps = {
  airtable: { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN },
  registry: IMPLEMENTED_EVALUATORS,
  lock: createSupabaseLockClient({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY }),
  // F8a: the F1 policy over the caller's own grant rows (role / active / organisation from the profile only).
  financeAccess: async (caller) =>
    resolveFinanceAccess(
      { userId: caller.userId, role: caller.role, active: caller.active, organisationId: caller.organisationId },
      await loadFinanceGrants({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY }, caller.userId)
    ).access,
  // F16: read-only Finance sources for the Money Out rules (repository.ts FINANCE_SOURCES).
  financeStore: { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY },
};

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function writeResponse(out: WriteOutcome): Response {
  if (out.status === "ok") return jsonResponse(out.body, out.httpStatus);
  return jsonResponse({ error: out.error, code: out.code, ...(out.body ?? {}) }, out.httpStatus);
}

const ROUTES: Record<string, string> = { cases: "GET", exceptions: "POST", "exceptions/revoke": "POST" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/needs-attention\/?/, "").replace(/\/$/, "");

  try {
    const method = ROUTES[route];
    if (!method) return jsonResponse({ error: `Unknown route: ${route}` }, 404);
    if (req.method !== method) return jsonResponse({ error: `Method not allowed - use ${method}` }, 405);
    const caller = await resolveCaller(req.headers.get("Authorization"));
    if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
    if (!caller.active || caller.role !== "management") return jsonResponse({ error: "Management access required" }, 403);
    const p = url.searchParams;
    if (TENANT_PARAMS.some((k) => p.has(k))) {
      return jsonResponse({ error: "The organisation is taken from your profile and cannot be chosen in the request", code: "tenant_param_rejected" }, 400);
    }
    if (route === "exceptions") return writeResponse(await createException(deps, caller, await readJson(req)));
    if (route === "exceptions/revoke") return writeResponse(await revokeException(deps, caller, await readJson(req)));
    const debug = p.get("debug") === "1" || p.get("debug") === "true";
    const outcome = await getCases(deps, caller, { view: p.get("view"), caseKey: p.get("caseKey"), debug });
    if (outcome.status === "rejected") return jsonResponse({ error: outcome.error, code: outcome.code }, outcome.httpStatus);
    return jsonResponse(outcome.body, 200);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
