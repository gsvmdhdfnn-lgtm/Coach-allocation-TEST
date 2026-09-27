/**
 * Coaches Slice 10 - Coach Work Summaries (see TEST-ENV.md). Thin HTTP
 * wrapper, same convention as coach-cover/index.ts: rules live in
 * work-summaries.ts (pure) / repository.ts (Airtable I/O) /
 * orchestrator.ts (composition, per-coach lock). This file only
 * authenticates/authorises, parses requests, maps outcomes to HTTP
 * responses, and boot-refuses against production.
 *
 * Routes:
 *   GET  /summaries[?coachId=]   Coach - own only; Management - all (optional coach filter)
 *   GET  /summary?summaryId=     Coach - own only (404 otherwise); Management - any
 *   POST /prepare                Management - create or reuse {coachId, periodStart, periodEnd}
 *   POST /refresh                Management - recompute an OPEN summary {summaryId}
 *   POST /query                  Coach - query own summary {summaryId, note}
 *   POST /finalise               Management - freeze lines + Grand Total {summaryId}
 *   POST /reopen                 Management - reopen a finalised summary {summaryId, reason}
 *
 * A Work Summary is not an invoice, payslip or payment: nothing here pays,
 * invoices, exports (Stripe/Xero/banking) or sends email/notifications.
 * Identity always comes from the authenticated profile: a coach's own
 * Coaches record is profiles.airtable_person_id, never the request body.
 * Parent JWTs get 403 everywhere.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveActor, type Actor } from "./work-summaries.ts";
import { createSupabaseLockClient } from "./lock-client.ts";
import { finaliseSummary, listSummaries, prepareSummary, querySummary, readSummary, refreshSummary, reopenSummary, type Deps } from "./orchestrator.ts";

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
  if (!actor) return { ok: false, response: jsonResponse({ error: "Work summaries are available to Management and active Coaches only" }, 403) };
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

const LOCK_BUSY = { error: "This coach's work summaries are being updated by another request - please retry" };

/** Maps an orchestrator outcome to HTTP: rejected -> its own status, lock contention -> 409, success -> `okStatus`. */
function respond(outcome: any, okStatus = 200): Response {
  if (outcome.status === "lock_unavailable") return jsonResponse(LOCK_BUSY, 409);
  if (outcome.status === "rejected") {
    const { status: _s, httpStatus, ...rest } = outcome;
    return jsonResponse(rest, httpStatus);
  }
  return jsonResponse(outcome, okStatus);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/coach-work-summaries\/?/, "").replace(/\/$/, "");
  const ROUTES: Record<string, { method: string; who: "any" | "coach" | "management" }> = {
    summaries: { method: "GET", who: "any" },
    summary: { method: "GET", who: "any" },
    prepare: { method: "POST", who: "management" },
    refresh: { method: "POST", who: "management" },
    query: { method: "POST", who: "coach" },
    finalise: { method: "POST", who: "management" },
    reopen: { method: "POST", who: "management" },
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

    if (req.method === "GET") {
      const p = url.searchParams;
      if (route === "summaries") return respond(await listSummaries(deps, actor, { coachId: p.get("coachId") ?? undefined }));
      return respond(await readSummary(deps, actor, p.get("summaryId")));
    }
    const body = await readJson(req);
    if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400);
    switch (route) {
      case "prepare": {
        const out = await prepareSummary(deps, actor, { coachId: body.coachId, periodStart: body.periodStart, periodEnd: body.periodEnd });
        return respond(out, out.status === "created" ? 201 : 200);
      }
      case "refresh":
        return respond(await refreshSummary(deps, actor, body.summaryId));
      case "query":
        return respond(await querySummary(deps, actor, { summaryId: body.summaryId, note: body.note }));
      case "finalise":
        return respond(await finaliseSummary(deps, actor, body.summaryId));
      case "reopen":
        return respond(await reopenSummary(deps, actor, { summaryId: body.summaryId, reason: body.reason }));
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
