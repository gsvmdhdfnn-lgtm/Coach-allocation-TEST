/**
 * Coaches Slice 6 - cancellation/reschedule financial outcomes (see
 * TEST-ENV.md). Deliberately a thin HTTP wrapper, same convention as
 * coach-allocations/index.ts: every piece of actual logic lives in
 * financial-outcomes.ts (pure validation/patch-building) /
 * repository.ts (Airtable I/O) / orchestrator.ts (composition) and is
 * imported unchanged, never re-implemented here. This file's only jobs
 * are: authenticate/authorise the caller, validate the request shape,
 * translate an outcome into an HTTP response, and boot-refuse against
 * production.
 *
 * Backend/data foundation only - records the operational DECISION, never
 * executes money movement. No Stripe refunds, parent wallet/credit
 * ledger, venue invoice settlement, coach payments, Xero integration, or
 * finance exports exist anywhere in this file. See TEST-ENV.md for the
 * full Slice 6 write-up.
 *
 * Security: every route below is Management-only, using the exact same
 * resolveCaller()/role-check convention as every other TEST Edge
 * Function's Management routes - a Coach or Parent JWT gets 403, same as
 * everywhere else. Coach users cannot decide whether they are paid;
 * Parent users cannot assign themselves a refund/credit.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { KNOWN_COACH_OUTCOMES, KNOWN_PARENT_OUTCOMES, KNOWN_VENUE_OUTCOMES, isManagementCaller } from "./financial-outcomes.ts";
import {
  readFinancialOutcomes,
  setCoachOutcome,
  setParentOutcome,
  setVenueOutcome,
} from "./orchestrator.ts";
import { type AirtableConfig } from "./repository.ts";
import { createSupabaseLockClient } from "./lock-client.ts";

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

/** Identical shape/logic to hub-content's/parent-hub's/coach-allocations' own resolveCaller() - copied, not shared, per this codebase's "each Edge Function is self-contained" convention. */
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

async function requireManagement(req: Request): Promise<{ ok: true; caller: { userId: string; displayName: string | null } } | { ok: false; response: Response }> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return { ok: false, response: jsonResponse({ error: "Missing or invalid Authorization header" }, 401) };
  if (!isManagementCaller(caller)) {
    return { ok: false, response: jsonResponse({ error: "Management access required" }, 403) };
  }
  return { ok: true, caller: { userId: caller.userId, displayName: caller.displayName } };
}

const airtableConfig: AirtableConfig = { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN };
/**
 * Coaches Slice 6 hardening (see TEST-ENV.md) - guards the Occurrence
 * Financial Outcomes upsert-or-update sequence per occurrence, same
 * lock-client convention as session-occurrences/index.ts's own
 * lockClient, pointed at this domain's own table/RPC functions instead.
 * Not used by handleCoachOutcome - Coach outcome is always an update to
 * a caller-supplied allocationId, never a create, so it has no
 * duplicate-row race to guard against.
 */
const lockClient = createSupabaseLockClient({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY });

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

async function handleCoachOutcome(req: Request): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!RECORD_ID_RE.test(body?.allocationId || "")) return jsonResponse({ error: "allocationId is required and must be a valid Airtable record ID" }, 400);
  if (!KNOWN_COACH_OUTCOMES.includes(body?.outcome)) return jsonResponse({ error: `outcome must be one of: ${KNOWN_COACH_OUTCOMES.join(", ")}` }, 400);

  try {
    const outcome = await setCoachOutcome(
      { airtable: airtableConfig },
      { allocationId: body.allocationId, outcome: body.outcome, amount: body.amount ?? null, reason: body.reason ?? null },
      { userId: auth.caller.userId, name: auth.caller.displayName }
    );
    switch (outcome.status) {
      case "validation_error":
        return jsonResponse({ error: outcome.error }, 400);
      case "allocation_not_found":
        return jsonResponse({ error: `No Coach Allocation found for id ${body.allocationId}` }, 404);
      case "updated":
        return jsonResponse(outcome, 200);
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

async function handleParentOutcome(req: Request): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!RECORD_ID_RE.test(body?.occurrenceId || "")) return jsonResponse({ error: "occurrenceId is required and must be a valid Airtable record ID" }, 400);
  if (!KNOWN_PARENT_OUTCOMES.includes(body?.outcome)) return jsonResponse({ error: `outcome must be one of: ${KNOWN_PARENT_OUTCOMES.join(", ")}` }, 400);

  try {
    const outcome = await setParentOutcome(
      { airtable: airtableConfig, lock: lockClient },
      { occurrenceId: body.occurrenceId, outcome: body.outcome, amount: body.amount ?? null, reason: body.reason ?? null },
      { userId: auth.caller.userId, name: auth.caller.displayName }
    );
    switch (outcome.status) {
      case "validation_error":
        return jsonResponse({ error: outcome.error }, 400);
      case "occurrence_not_found":
        return jsonResponse({ error: `No Session Occurrence found for id ${body.occurrenceId}` }, 404);
      case "lock_unavailable":
        return jsonResponse({ error: "This occurrence's financial outcome is being updated by another request - please retry" }, 409);
      case "created":
        return jsonResponse(outcome, 201);
      case "updated":
        return jsonResponse(outcome, 200);
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

async function handleVenueOutcome(req: Request): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (!RECORD_ID_RE.test(body?.occurrenceId || "")) return jsonResponse({ error: "occurrenceId is required and must be a valid Airtable record ID" }, 400);
  if (!KNOWN_VENUE_OUTCOMES.includes(body?.outcome)) return jsonResponse({ error: `outcome must be one of: ${KNOWN_VENUE_OUTCOMES.join(", ")}` }, 400);

  try {
    const outcome = await setVenueOutcome(
      { airtable: airtableConfig, lock: lockClient },
      { occurrenceId: body.occurrenceId, outcome: body.outcome, amount: body.amount ?? null, reason: body.reason ?? null },
      { userId: auth.caller.userId, name: auth.caller.displayName }
    );
    switch (outcome.status) {
      case "validation_error":
        return jsonResponse({ error: outcome.error }, 400);
      case "occurrence_not_found":
        return jsonResponse({ error: `No Session Occurrence found for id ${body.occurrenceId}` }, 404);
      case "lock_unavailable":
        return jsonResponse({ error: "This occurrence's financial outcome is being updated by another request - please retry" }, 409);
      case "created":
        return jsonResponse(outcome, 201);
      case "updated":
        return jsonResponse(outcome, 200);
    }
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

/** Combined read-only view - Coach Allocations (all linked to this occurrence) + Parent/Venue outcome row, never recomputed. */
async function handleGetOutcomes(req: Request, occurrenceId: string | null): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;

  if (!RECORD_ID_RE.test(occurrenceId || "")) {
    return jsonResponse({ error: "occurrenceId query parameter is required and must be a valid Airtable record ID" }, 400);
  }

  try {
    const view = await readFinancialOutcomes({ airtable: airtableConfig }, occurrenceId!);
    if (!view) return jsonResponse({ error: `No Session Occurrence found for id ${occurrenceId}` }, 404);
    return jsonResponse(view);
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
  const route = url.pathname.replace(/^.*\/occurrence-financial-outcomes\/?/, "").replace(/\/$/, "");

  try {
    if (route === "coach-outcome") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleCoachOutcome(req);
    }
    if (route === "parent-outcome") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleParentOutcome(req);
    }
    if (route === "venue-outcome") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleVenueOutcome(req);
    }
    if (route === "outcomes") {
      if (req.method !== "GET") return jsonResponse({ error: "Method not allowed - use GET" }, 405);
      return await handleGetOutcomes(req, url.searchParams.get("occurrenceId"));
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
