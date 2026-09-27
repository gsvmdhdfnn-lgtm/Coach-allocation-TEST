/**
 * Coaches Slice 7 - coach availability truth layer (see TEST-ENV.md). Thin
 * HTTP wrapper, same convention as occurrence-financial-outcomes/index.ts:
 * all logic lives in coach-availability.ts (pure resolution) /
 * repository.ts (Airtable reads) / orchestrator.ts (composition). This
 * file only authenticates/authorises, reads the query string, maps the
 * outcome to an HTTP response, and boot-refuses against production.
 *
 * Read-only. Answers "has this coach said they are available at this UK
 * date/time?" - not "is this coach free from other assignments", and not
 * any cover recommendation/ranking/assignment.
 *
 * Security: Management-only, same resolveCaller()/role-check convention as
 * every other TEST function's Management routes. The TEST architecture is
 * one organisation per Airtable base, so a Management caller can only ever
 * read coaches in this base; no cross-organisation path exists here.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isManagementCaller } from "./coach-availability.ts";
import { resolveCoachAvailability } from "./orchestrator.ts";
import { type AirtableConfig } from "./repository.ts";

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

/** Identical shape/logic to every other TEST function's resolveCaller() - copied, not shared, per the "each Edge Function is self-contained" convention. */
async function resolveCaller(
  authHeader: string | null
): Promise<{ role: string; airtablePersonId: string | null; active: boolean; userId: string; displayName: string | null } | null> {
  if (!authHeader) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return null;
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, airtable_person_id, active, display_name")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return {
    role: profile.role,
    airtablePersonId: profile.airtable_person_id || null,
    active: profile.active === true,
    userId: userData.user.id,
    displayName: profile.display_name || null,
  };
}

const airtableConfig: AirtableConfig = { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN };

async function handleResolve(req: Request, params: URLSearchParams): Promise<Response> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isManagementCaller(caller)) return jsonResponse({ error: "Management access required" }, 403);

  try {
    const outcome = await resolveCoachAvailability(
      { airtable: airtableConfig },
      {
        coachId: params.get("coachId"),
        date: params.get("date"),
        startTime: params.get("startTime"),
        endTime: params.get("endTime"),
        startAt: params.get("startAt"),
        endAt: params.get("endAt"),
      }
    );
    switch (outcome.status) {
      case "validation_error":
        return jsonResponse({ error: outcome.error }, 400);
      case "coach_not_found":
        return jsonResponse({ error: `No Coach found for id ${params.get("coachId")}` }, 404);
      case "resolved":
        return jsonResponse(outcome.result, 200);
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/coach-availability\/?/, "").replace(/\/$/, "");

  try {
    if (route === "resolve") {
      if (req.method !== "GET") return jsonResponse({ error: "Method not allowed - use GET" }, 405);
      return await handleResolve(req, url.searchParams);
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
