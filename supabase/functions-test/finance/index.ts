/**
 * Finance - access boundary + core API shell (Finance Foundation F1; see
 * TEST-ENV.md "Finance Foundation - F1"). Thin HTTP wrapper, same convention
 * as the Coaches / Needs Attention functions: policy lives in
 * finance-access.ts (pure), reads in repository.ts, composition in
 * orchestrator.ts. This file only authenticates, checks request shape, maps
 * outcomes to HTTP responses, and boot-refuses against production.
 *
 * Routes (every one requires an active Management profile holding a Finance
 * grant for their own organisation, with module_finance enabled):
 *   GET  /access        Finance read  -> { contract, organisation, module, access, capabilities }
 *   POST /write-check   Finance manage -> authorisation probe only; persists NOTHING
 *
 * No auth -> 401. Coach / Parent / pending / inactive -> 403. The organisation
 * is ALWAYS the caller's own Supabase profile organisation_id - any
 * tenant-looking query parameter or body key is rejected with 400, never
 * ignored. F1 creates no Finance business records and writes nothing.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { type FinanceCaller, FINANCE_CONTRACT, buildAccessBody, checkEmptyBody, checkQueryKeys, isFinanceEligible } from "./finance-access.ts";
import { type Deps, authorizeFinance } from "./orchestrator.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;

// ---------------------------------------------------------------------
// TEST DEPLOYMENT GUARD. This copy runs only in the test Supabase
// project against the test Airtable base. If AIRTABLE_BASE_ID is ever a
// known production base, or SUPABASE_URL is the production project, the
// function refuses to start at all - a boot failure is loud and harmless,
// a Finance decision made against live data is not.
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
/** Used ONLY to read public.finance_access_grants (RLS on, no client grants - service role only). */
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PRODUCTION_SUPABASE_REFS = ["bkkukymqaxawnudoxdjs"];
if (PRODUCTION_SUPABASE_REFS.some((ref) => (SUPABASE_URL || "").includes(ref))) {
  throw new Error("TEST function refusing to start: SUPABASE_URL is the production project.");
}

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

/** Same shape/logic as every other TEST function's resolveCaller() - copied, not shared, per the "each Edge Function is self-contained" convention. */
async function resolveCaller(authHeader: string | null): Promise<FinanceCaller | null> {
  if (!authHeader) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return null;
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, active, organisation_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return {
    userId: userData.user.id,
    role: typeof profile.role === "string" ? profile.role : null,
    active: profile.active === true,
    organisationId: typeof profile.organisation_id === "string" ? profile.organisation_id : null,
  };
}

const deps: Deps = {
  airtable: { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN },
  grants: { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY },
};

const ROUTES: Record<string, string> = { access: "GET", "write-check": "POST" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/finance\/?/, "").replace(/\/$/, "");

  try {
    const method = ROUTES[route];
    if (!method) return jsonResponse({ error: `Unknown route: ${route}` }, 404);
    if (req.method !== method) return jsonResponse({ error: `Method not allowed - use ${method}` }, 405);
    const caller = await resolveCaller(req.headers.get("Authorization"));
    if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
    if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);

    const query = checkQueryKeys([...url.searchParams.keys()]);
    if (!query.ok) return jsonResponse({ error: query.error, code: query.code }, 400);

    if (route === "write-check") {
      const body = checkEmptyBody(await req.text());
      if (!body.ok) return jsonResponse({ error: body.error, code: body.code }, 400);
      const out = await authorizeFinance(deps, caller, "manage");
      if (out.status !== "ok") return jsonResponse({ error: out.error, code: out.code }, out.httpStatus);
      return jsonResponse({ contract: FINANCE_CONTRACT, action: "manage", authorized: true, persisted: false }, 200);
    }

    const out = await authorizeFinance(deps, caller, "read");
    if (out.status !== "ok") return jsonResponse({ error: out.error, code: out.code }, out.httpStatus);
    return jsonResponse(buildAccessBody(out.organisation, out.access), 200);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "Unexpected error" }, 500);
  }
});
