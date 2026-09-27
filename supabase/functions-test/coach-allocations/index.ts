/**
 * Coaches Slice 5 - rates + historical coach-cost foundation (see
 * TEST-ENV.md). Deliberately a thin HTTP wrapper, same convention as
 * session-occurrences/index.ts: every piece of actual logic lives in
 * coach-rates.ts (pure resolution/calculation) / repository.ts (Airtable
 * I/O) / orchestrator.ts (composition) and is imported unchanged, never
 * re-implemented here. This file's only jobs are: authenticate/authorise
 * the caller, validate the request shape, translate an outcome into an
 * HTTP response, and boot-refuse against production.
 *
 * Backend/data-layer foundation only - no invoicing, payroll, payments,
 * work-summary finalisation, cancellation/weather rules, or UI. See
 * TEST-ENV.md for the full Slice 5 write-up.
 *
 * Security: every route below is Management-only, using the exact same
 * resolveCaller()/role-check convention as every other TEST Edge
 * Function's Management routes (hub-content's session-participants,
 * session-occurrences' generate/propagate/trigger-session-saved) - a
 * Coach or Parent JWT gets 403, same as everywhere else. Nothing here
 * weakens the platform's own verify_jwt (still required) or invents a
 * separate auth path.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  KNOWN_RATE_TYPES,
  resolveCoachRateProfile,
  type CreateAllocationInput,
} from "./coach-rates.ts";
import { createCoachAllocationForOccurrence } from "./orchestrator.ts";
import {
  type AirtableConfig,
  fetchAllocationById,
  fetchRateProfilesForCoach,
} from "./repository.ts";

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

/** Identical shape/logic to hub-content's/parent-hub's/session-occurrences' own resolveCaller() - copied, not shared, per this codebase's "each Edge Function is self-contained" convention. */
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

async function requireManagement(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return { ok: false, response: jsonResponse({ error: "Missing or invalid Authorization header" }, 401) };
  if (!caller.active || caller.role !== "management") {
    return { ok: false, response: jsonResponse({ error: "Management access required" }, 403) };
  }
  return { ok: true };
}

const airtableConfig: AirtableConfig = { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN };

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Given Coach + work date + intended Rate Type, resolve the correct Rate
 * Profile" as its own route - the first item in the Slice 5 brief's
 * "Backend/API design" list, exposed directly so resolution can be
 * exercised/verified independent of actually creating an allocation.
 * Read-only: fetches Coach Rate Profiles and reports the outcome
 * (resolved / missing / ambiguous), never writes anything.
 */
async function handleResolveRate(req: Request): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const coachId = body?.coachId;
  const workDateIso = body?.workDateIso;
  const rateType = body?.rateType;
  if (!RECORD_ID_RE.test(coachId || "")) return jsonResponse({ error: "coachId is required and must be a valid Airtable record ID" }, 400);
  if (!ISO_DATE_RE.test(workDateIso || "")) return jsonResponse({ error: 'workDateIso is required and must be "YYYY-MM-DD"' }, 400);
  if (!KNOWN_RATE_TYPES.includes(rateType)) return jsonResponse({ error: `rateType must be one of: ${KNOWN_RATE_TYPES.join(", ")}` }, 400);

  try {
    const rateProfileRows = await fetchRateProfilesForCoach(airtableConfig, coachId);
    const resolution = resolveCoachRateProfile(coachId, workDateIso, rateType, rateProfileRows);
    if (resolution.status === "resolved") {
      return jsonResponse({
        status: "resolved",
        rateProfileRecordId: resolution.profile.id,
        amount: resolution.profile.fields["Amount"],
        payUnit: resolution.profile.fields["Pay Unit"],
      });
    }
    if (resolution.status === "missing") return jsonResponse({ status: "missing" }, 404);
    return jsonResponse({ status: "ambiguous", candidateRecordIds: resolution.candidates.map((c) => c.id) }, 409);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

/**
 * Creates a Coach Allocation, snapshotting the resolved Rate Profile -
 * see TEST-ENV.md for the full outcome-status contract
 * (createCoachAllocationForOccurrence()'s own return type). Never called
 * automatically from any staffing write path - see orchestrator.ts's own
 * header for the staffing-vs-financial-allocation boundary.
 */
async function handleAllocate(req: Request): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const input: CreateAllocationInput = {
    coachId: body?.coachId,
    sessionOccurrenceId: body?.sessionOccurrenceId,
    workDateIso: body?.workDateIso,
    rateType: body?.rateType,
    assignmentType: body?.assignmentType,
    paidUnits: body?.paidUnits,
    costOverride: body?.costOverride ?? null,
    overrideReason: body?.overrideReason ?? null,
    costStatus: body?.costStatus,
    notes: body?.notes ?? null,
  };

  try {
    const outcome = await createCoachAllocationForOccurrence({ airtable: airtableConfig }, input);
    switch (outcome.status) {
      case "validation_error":
        return jsonResponse({ error: outcome.error }, 400);
      case "coach_not_found":
        return jsonResponse({ error: `No Coach found for id ${input.coachId}` }, 404);
      case "occurrence_not_found":
        return jsonResponse({ error: `No Session Occurrence found for id ${input.sessionOccurrenceId}` }, 404);
      case "rate_missing":
        return jsonResponse({ error: `No applicable, Active Coach Rate Profile of type "${input.rateType}" for this Coach on ${input.workDateIso}` }, 422);
      case "rate_ambiguous":
        return jsonResponse(
          { error: "More than one Active Coach Rate Profile of this type applies on this date - cannot resolve safely", candidateRecordIds: outcome.candidateRecordIds },
          422
        );
      case "existing":
        return jsonResponse({ status: "existing", recordId: outcome.recordId }, 200);
      case "created":
        return jsonResponse(outcome, 201);
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

/**
 * Reads one Coach Allocation exactly as stored - no Coach Rate Profile is
 * ever re-read here, so this route structurally cannot recompute a
 * historical allocation's cost from a since-changed rate.
 */
async function handleGetAllocation(req: Request, allocationId: string | null): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  if (!RECORD_ID_RE.test(allocationId || "")) {
    return jsonResponse({ error: "id query parameter is required and must be a valid Airtable record ID" }, 400);
  }

  try {
    const allocation = await fetchAllocationById(airtableConfig, allocationId!);
    if (!allocation) return jsonResponse({ error: `No Coach Allocation found for id ${allocationId}` }, 404);
    return jsonResponse(allocation);
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
  const route = url.pathname.replace(/^.*\/coach-allocations\/?/, "").replace(/\/$/, "");

  try {
    if (route === "resolve-rate") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleResolveRate(req);
    }
    if (route === "allocate") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleAllocate(req);
    }
    if (route === "allocation") {
      if (req.method !== "GET") return jsonResponse({ error: "Method not allowed - use GET" }, 405);
      return await handleGetAllocation(req, url.searchParams.get("id"));
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
