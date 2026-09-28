/**
 * Needs Attention Slice 2 - engine + read-only API (see TEST-ENV.md
 * "Needs Attention Foundation - Slice 2"). Thin HTTP wrapper, same
 * convention as the Coaches functions: rules live in needs-attention.ts
 * (pure) / repository.ts (read-only Airtable I/O) / orchestrator.ts
 * (composition) / registry.ts (code-side evaluator registrations). This
 * file only authenticates/authorises, parses the query, maps outcomes to
 * HTTP responses, and boot-refuses against production.
 *
 * Routes (Management only; Coach/Parent/pending/inactive -> 403):
 *   GET /cases                    full queue: summary + ordered cases + configIssues
 *   GET /cases?view=summary       summary only (Home state, counts)
 *   GET /cases?caseKey=<key>      does this exact case currently exist?
 *   ...&debug=1                   adds diagnostics (skipped rules + reasons, read counts)
 *
 * The organisation is ALWAYS resolved from the caller's own Supabase
 * profile (organisation_id) - any tenant-looking query parameter is
 * rejected with 400 rather than ignored. Nothing here writes anywhere:
 * no exception or Settings mutation routes exist in Slice 2.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCases, type Caller, type Deps } from "./orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./registry.ts";

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
    .select("role, active, organisation_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return {
    userId: userData.user.id,
    role: profile.role,
    active: profile.active === true,
    organisationId: typeof profile.organisation_id === "string" ? profile.organisation_id : null,
  };
}

/** Tenant is never client-selectable: these parameters are refused outright, not silently ignored. */
const TENANT_PARAMS = ["organisation", "organisationId", "organisation_id", "organization", "organizationId", "org", "orgId", "tenant"];

const deps: Deps = {
  airtable: { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN },
  registry: IMPLEMENTED_EVALUATORS,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/needs-attention\/?/, "").replace(/\/$/, "");

  try {
    if (route !== "cases") return jsonResponse({ error: `Unknown route: ${route}` }, 404);
    if (req.method !== "GET") return jsonResponse({ error: "Method not allowed - use GET" }, 405);
    const caller = await resolveCaller(req.headers.get("Authorization"));
    if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
    if (!caller.active || caller.role !== "management") return jsonResponse({ error: "Management access required" }, 403);
    const p = url.searchParams;
    if (TENANT_PARAMS.some((k) => p.has(k))) {
      return jsonResponse({ error: "The organisation is taken from your profile and cannot be chosen in the request", code: "tenant_param_rejected" }, 400);
    }
    const debug = p.get("debug") === "1" || p.get("debug") === "true";
    const outcome = await getCases(deps, caller, { view: p.get("view"), caseKey: p.get("caseKey"), debug });
    if (outcome.status === "rejected") return jsonResponse({ error: outcome.error, code: outcome.code }, outcome.httpStatus);
    return jsonResponse(outcome.body, 200);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
