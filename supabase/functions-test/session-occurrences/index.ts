/**
 * Manual TEST-only Session Occurrence generator endpoint - Slice 4 (see
 * TEST-ENV.md). Deliberately a thin HTTP wrapper: every piece of actual
 * logic - the pure generator, the Airtable repository, the lock client,
 * the shared orchestration path - lives in generator.ts/repository.ts/
 * lock-client.ts/orchestrator.ts and is imported unchanged, never
 * re-implemented here. This file's only jobs are: authenticate/authorise
 * the caller, validate the request body, translate the orchestrator's
 * outcome into an HTTP response, and boot-refuse against production.
 *
 * Deliberately manual for now: one Session per call, no "generate all
 * Sessions", no cron/scheduled trigger, no frontend wiring. That's later
 * slices - this one exists purely so the already-proven Slice 3
 * orchestration can be exercised over real HTTP before anything
 * automatic is built on top of it.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { generateForSession } from "./orchestrator.ts";
import { fetchSession, type AirtableConfig } from "./repository.ts";
import { createSupabaseLockClient } from "./lock-client.ts";
import { propagateForSession, type PropagateChanges } from "./propagation-orchestrator.ts";
import { parseHHMM, weekdayIndexFromName } from "./schedule-utils.ts";

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

/**
 * Resolves the caller from a Supabase Auth JWT and their `profiles` row -
 * identical shape/logic to hub-content's and parent-hub's own
 * resolveCaller(), copied rather than shared per this codebase's
 * "each Edge Function is self-contained" convention (see
 * player-access.ts's own header comment for why).
 */
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
const lockClient = createSupabaseLockClient({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY });

function isValidAirtableRecordId(id: unknown): id is string {
  return typeof id === "string" && /^rec[A-Za-z0-9]{14}$/.test(id);
}

/**
 * Calls the real repository.fetchSession() (no re-implementation) purely
 * to give a clean 404 for an unknown Session before ever acquiring a
 * lock for it - otherwise an unknown id would acquire the lock, fail
 * inside generateForSession with a generic thrown error, release the
 * lock, and surface as an opaque 500. Anything other than "not found"
 * (auth failure, network error, etc.) is rethrown as-is.
 *
 * Confirmed by real call (see TEST-ENV.md, Slice 4): Airtable returns a
 * plain 404 for a malformed id, but 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND
 * for a well-formed id that simply doesn't exist - it deliberately does
 * not distinguish "no permission" from "doesn't exist". Both count as
 * not found here.
 */
async function sessionExists(sessionRecordId: string): Promise<boolean> {
  try {
    await fetchSession(airtableConfig, sessionRecordId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/:\s*404\b/.test(message) || /MODEL_NOT_FOUND/.test(message)) return false;
    throw error;
  }
}

async function handleGenerate(req: Request): Promise<Response> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!caller.active || caller.role !== "management") {
    return jsonResponse({ error: "Management access required" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionRecordId = body?.sessionRecordId;
  if (!isValidAirtableRecordId(sessionRecordId)) {
    return jsonResponse({ error: "sessionRecordId is required and must be a valid Airtable record ID" }, 400);
  }

  let exists: boolean;
  try {
    exists = await sessionExists(sessionRecordId);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: `Failed to look up Session: ${error instanceof Error ? error.message : "Unknown error"}` }, 502);
  }
  if (!exists) {
    return jsonResponse({ error: `No Session found for id ${sessionRecordId}` }, 404);
  }

  try {
    const outcome = await generateForSession({ airtable: airtableConfig, lock: lockClient }, sessionRecordId);
    return jsonResponse(outcome, 200);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the shape of the request body's `changes` object before it
 * ever reaches propagateForSession() - the same "index.ts owns HTTP-
 * boundary validation, orchestrator/repository trust their inputs"
 * convention as handleGenerate()'s isValidAirtableRecordId() check.
 * Returns a human-readable error string, or null if the shape is valid
 * and at least one change type is present.
 */
function validatePropagateChanges(changes: any): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return "changes is required and must be an object";
  }
  const knownKeys = ["time", "venue", "capacity", "dayOfWeek", "endDate"];
  if (!knownKeys.some((k) => changes[k] != null)) {
    return `changes must include at least one of: ${knownKeys.join(", ")}`;
  }

  if (changes.time != null) {
    const { newStartTime, newEndTime } = changes.time;
    if (!parseHHMM(newStartTime) || !parseHHMM(newEndTime)) {
      return `changes.time.newStartTime/newEndTime must both be "HH:MM"`;
    }
  }
  if (changes.venue != null) {
    const ids = changes.venue.newVenueRecordIds;
    if (!Array.isArray(ids) || !ids.every((id: unknown) => isValidAirtableRecordId(id))) {
      return "changes.venue.newVenueRecordIds must be an array of valid Airtable record IDs (may be empty)";
    }
  }
  if (changes.capacity != null) {
    const cap = changes.capacity.newCapacity;
    if (cap !== null && typeof cap !== "number") {
      return "changes.capacity.newCapacity must be a number or null";
    }
  }
  if (changes.dayOfWeek != null) {
    if (weekdayIndexFromName(changes.dayOfWeek.newDayName) == null) {
      return "changes.dayOfWeek.newDayName must be a recognised weekday name";
    }
    const eff = changes.dayOfWeek.effectiveFromDateIso;
    if (eff != null && !ISO_DATE_RE.test(eff)) {
      return "changes.dayOfWeek.effectiveFromDateIso must be \"YYYY-MM-DD\" if provided";
    }
  }
  if (changes.endDate != null) {
    if (!ISO_DATE_RE.test(changes.endDate.newEndDateIso)) {
      return "changes.endDate.newEndDateIso must be \"YYYY-MM-DD\"";
    }
  }
  return null;
}

async function handlePropagate(req: Request): Promise<Response> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!caller.active || caller.role !== "management") {
    return jsonResponse({ error: "Management access required" }, 403);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionRecordId = body?.sessionRecordId;
  if (!isValidAirtableRecordId(sessionRecordId)) {
    return jsonResponse({ error: "sessionRecordId is required and must be a valid Airtable record ID" }, 400);
  }

  const validationError = validatePropagateChanges(body?.changes);
  if (validationError) {
    return jsonResponse({ error: validationError }, 400);
  }

  let exists: boolean;
  try {
    exists = await sessionExists(sessionRecordId);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: `Failed to look up Session: ${error instanceof Error ? error.message : "Unknown error"}` }, 502);
  }
  if (!exists) {
    return jsonResponse({ error: `No Session found for id ${sessionRecordId}` }, 404);
  }

  try {
    const outcome = await propagateForSession(
      { airtable: airtableConfig, lock: lockClient },
      sessionRecordId,
      body.changes as PropagateChanges
    );
    return jsonResponse(outcome, 200);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const pathname = new URL(req.url).pathname;
  const route = pathname.replace(/^.*\/session-occurrences\/?/, "").replace(/\/$/, "");

  try {
    if (route === "generate") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleGenerate(req);
    }
    if (route === "propagate") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handlePropagate(req);
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
