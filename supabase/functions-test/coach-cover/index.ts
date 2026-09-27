/**
 * Coaches Slice 9 - cover workflow (see TEST-ENV.md). Thin HTTP wrapper,
 * same convention as coach-compliance/index.ts: rules live in
 * cover-workflow.ts (pure) / staffing.ts (Slice 3 resolver, copied) /
 * repository.ts (Airtable I/O) / orchestrator.ts (composition, per-date
 * lock). This file only authenticates/authorises, parses requests, maps
 * outcomes to HTTP responses, and boot-refuses against production.
 *
 * Routes:
 *   POST /requests              Coach (own assignments only) or Management (any coach via coachId)
 *   GET  /mine                  Coach - own requests + open requests they could respond to
 *   POST /respond               Coach - Accept / Decline one open date, for themselves only
 *   POST /cancel                Coach (own open dates) or Management
 *   GET  /manage?status=&asOf=  Management - all dates with the >=24h unfilled signal
 *   GET  /manage/detail?requestDateId=&rateType=  Management - responses + fresh suitability/rate
 *   POST /select                Management - final selection (writes Occurrence Staff Cover)
 *
 * Identity always comes from the authenticated profile: a coach's own
 * Coaches record is profiles.airtable_person_id, never the request body.
 * Parent JWTs get 403 everywhere. Nothing here sends email/notifications.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isValidRecordId, parseCreateRequestBody, resolveActor, type Actor } from "./cover-workflow.ts";
import { createSupabaseLockClient } from "./lock-client.ts";
import { cancelCoverDate, createCoverRequest, detailForManagement, listForCoach, listForManagement, respondToCover, selectCover, type Deps } from "./orchestrator.ts";

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

async function requireActor(req: Request): Promise<{ ok: true; actor: Actor } | { ok: false; response: Response }> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return { ok: false, response: jsonResponse({ error: "Missing or invalid Authorization header" }, 401) };
  const actor = resolveActor(caller);
  if (!actor) return { ok: false, response: jsonResponse({ error: "Cover requests are available to Management and active Coaches only" }, 403) };
  return { ok: true, actor };
}

async function readJson(req: Request): Promise<any | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

const deps: Deps = {
  airtable: { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN },
  lock: createSupabaseLockClient({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY }),
};

const LOCK_BUSY = { error: "This cover date is being updated by another request - please retry" };

function rejected(o: { httpStatus: number; code: string; error: string; [k: string]: unknown }): Response {
  const { status: _s, httpStatus, ...rest } = o as any;
  return jsonResponse(rest, httpStatus);
}

async function handleCreate(req: Request, actor: Actor): Promise<Response> {
  const parsed = parseCreateRequestBody(await readJson(req), actor);
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, parsed.httpStatus);
  const outcome = await createCoverRequest(deps, actor, parsed.input);
  if (outcome.status === "lock_unavailable") return jsonResponse(LOCK_BUSY, 409);
  if (outcome.status === "rejected") return rejected(outcome);
  return jsonResponse(outcome, 201);
}

async function handleRespond(req: Request, actor: Actor): Promise<Response> {
  const body = await readJson(req);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400);
  if (!isValidRecordId(body.requestDateId)) return jsonResponse({ error: "requestDateId must be a valid Airtable record ID" }, 400);
  const outcome = await respondToCover(deps, actor, { requestDateId: body.requestDateId, response: body.response, note: body.note ?? null });
  if (outcome.status === "lock_unavailable") return jsonResponse(LOCK_BUSY, 409);
  if (outcome.status === "rejected") return rejected(outcome);
  return jsonResponse(outcome, outcome.status === "created" ? 201 : 200);
}

async function handleCancel(req: Request, actor: Actor): Promise<Response> {
  const body = await readJson(req);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400);
  if (!isValidRecordId(body.requestDateId)) return jsonResponse({ error: "requestDateId must be a valid Airtable record ID" }, 400);
  if (body.note != null && (typeof body.note !== "string" || body.note.length > 2000)) return jsonResponse({ error: "note must be a string of at most 2000 characters" }, 400);
  const outcome = await cancelCoverDate(deps, actor, { requestDateId: body.requestDateId, note: body.note ?? null });
  if (outcome.status === "lock_unavailable") return jsonResponse(LOCK_BUSY, 409);
  if (outcome.status === "rejected") return rejected(outcome);
  return jsonResponse(outcome, 200);
}

async function handleManageList(params: URLSearchParams): Promise<Response> {
  const status = params.get("status");
  if (status && !["Open", "Filled", "Cancelled", "Resolved Without Cover"].includes(status)) return jsonResponse({ error: "status must be Open, Filled, Cancelled or Resolved Without Cover" }, 400);
  let asOf: Date | null = null;
  if (params.get("asOf")) {
    asOf = new Date(params.get("asOf")!);
    if (isNaN(asOf.getTime())) return jsonResponse({ error: "asOf must be an ISO 8601 instant" }, 400);
  }
  return jsonResponse(await listForManagement(deps, { status, asOf }), 200);
}

async function handleManageDetail(params: URLSearchParams): Promise<Response> {
  const id = params.get("requestDateId");
  if (!isValidRecordId(id)) return jsonResponse({ error: "requestDateId must be a valid Airtable record ID" }, 400);
  const detail = await detailForManagement(deps, { requestDateId: id, rateType: params.get("rateType") || null });
  if (!detail) return jsonResponse({ error: `No cover request date found for id ${id}` }, 404);
  return jsonResponse(detail, 200);
}

async function handleSelect(req: Request, actor: Actor): Promise<Response> {
  const body = await readJson(req);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400);
  if (!isValidRecordId(body.requestDateId) || !isValidRecordId(body.responseId)) return jsonResponse({ error: "requestDateId and responseId must be valid Airtable record IDs" }, 400);
  if (body.rateType != null && typeof body.rateType !== "string") return jsonResponse({ error: "rateType must be a string" }, 400);
  const outcome = await selectCover(deps, actor, {
    requestDateId: body.requestDateId,
    responseId: body.responseId,
    confirmWarnings: body.confirmWarnings === true,
    rateType: body.rateType || null,
  });
  if (outcome.status === "lock_unavailable") return jsonResponse(LOCK_BUSY, 409);
  if (outcome.status === "rejected") return rejected(outcome);
  return jsonResponse(outcome, 200);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/coach-cover\/?/, "").replace(/\/$/, "");
  const ROUTES: Record<string, { method: string; who: "any" | "coach" | "management" }> = {
    requests: { method: "POST", who: "any" },
    mine: { method: "GET", who: "coach" },
    respond: { method: "POST", who: "coach" },
    cancel: { method: "POST", who: "any" },
    manage: { method: "GET", who: "management" },
    "manage/detail": { method: "GET", who: "management" },
    select: { method: "POST", who: "management" },
  };

  try {
    const spec = ROUTES[route];
    if (!spec) return jsonResponse({ error: `Unknown route: ${route}` }, 404);
    if (req.method !== spec.method) return jsonResponse({ error: `Method not allowed - use ${spec.method}` }, 405);
    const auth = await requireActor(req);
    if (!auth.ok) return auth.response;
    const actor = auth.actor;
    if (spec.who === "management" && actor.kind !== "management") return jsonResponse({ error: "Management access required" }, 403);
    if (spec.who === "coach" && actor.kind !== "coach") return jsonResponse({ error: "Coach access required" }, 403);

    switch (route) {
      case "requests":
        return await handleCreate(req, actor);
      case "mine":
        return jsonResponse(await listForCoach(deps, actor as Extract<Actor, { kind: "coach" }>), 200);
      case "respond":
        return await handleRespond(req, actor);
      case "cancel":
        return await handleCancel(req, actor);
      case "manage":
        return await handleManageList(url.searchParams);
      case "manage/detail":
        return await handleManageDetail(url.searchParams);
      case "select":
        return await handleSelect(req, actor);
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
