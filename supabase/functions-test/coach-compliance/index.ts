/**
 * Coaches Slice 8 - coach compliance/qualification status (see TEST-ENV.md).
 * Thin HTTP wrapper, same convention as coach-availability/index.ts: all
 * logic lives in coach-compliance.ts (pure resolution/decisions) /
 * repository.ts (Airtable I/O) / orchestrator.ts (composition). This file
 * only authenticates/authorises, parses the request, maps outcomes to HTTP
 * responses, and boot-refuses against production.
 *
 * Routes:
 *   GET  /summary?coachId=      Management only - compliance summary (no attachment contents)
 *   POST /verify   {documentId} Management only - mark an active document verified/seen
 *   POST /submit   {...}        Management, or a Coach for their OWN records only -
 *                               create/update document content (never verification)
 *
 * Verified By / Verified At always come from the authenticated Management
 * caller and the server clock; a submission carrying any verification field
 * is rejected. A coach's own Coaches record comes from their profile, never
 * the request. Parent JWTs get 403 everywhere; Coach JWTs get 403 on
 * /summary and /verify. Attachment URLs/filenames are never returned.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isManagementCaller, parseSubmissionBody, resolveSubmitter } from "./coach-compliance.ts";
import { getComplianceSummary, submitCoachDocument, verifyCoachDocument } from "./orchestrator.ts";
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

async function requireManagement(req: Request): Promise<{ ok: true; caller: { userId: string; displayName: string | null } } | { ok: false; response: Response }> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return { ok: false, response: jsonResponse({ error: "Missing or invalid Authorization header" }, 401) };
  if (!isManagementCaller(caller)) return { ok: false, response: jsonResponse({ error: "Management access required" }, 403) };
  return { ok: true, caller: { userId: caller.userId, displayName: caller.displayName } };
}

async function readJson(req: Request): Promise<any | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

const airtableConfig: AirtableConfig = { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN };

async function handleSummary(req: Request, params: URLSearchParams): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;
  const outcome = await getComplianceSummary({ airtable: airtableConfig }, params.get("coachId"));
  switch (outcome.status) {
    case "validation_error":
      return jsonResponse({ error: outcome.error }, 400);
    case "coach_not_found":
      return jsonResponse({ error: `No Coach found for id ${params.get("coachId")}` }, 404);
    case "ok":
      return jsonResponse(outcome.summary, 200);
  }
}

async function handleVerify(req: Request): Promise<Response> {
  const auth = await requireManagement(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400);
  const outcome = await verifyCoachDocument({ airtable: airtableConfig }, body.documentId ?? null, auth.caller);
  switch (outcome.status) {
    case "validation_error":
      return jsonResponse({ error: outcome.error }, 400);
    case "document_not_found":
      return jsonResponse({ error: `No Coach Document found for id ${body.documentId}` }, 404);
    case "rejected":
      return jsonResponse({ error: outcome.error, code: outcome.code }, 409);
    case "already_verified":
      return jsonResponse({ status: "already_verified", document: outcome.document }, 200);
    case "verified":
      return jsonResponse({ status: "verified", document: outcome.document }, 200);
  }
}

async function handleSubmit(req: Request): Promise<Response> {
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  const submitter = resolveSubmitter(caller);
  if (!submitter) return jsonResponse({ error: "Only Management or an active Coach (for their own documents) can submit compliance documents" }, 403);
  const parsed = parseSubmissionBody(await readJson(req));
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);
  const outcome = await submitCoachDocument({ airtable: airtableConfig }, submitter, parsed.input);
  switch (outcome.status) {
    case "rejected":
      return jsonResponse({ error: outcome.error, code: outcome.code }, outcome.httpStatus);
    case "created":
      return jsonResponse({ status: "created", document: outcome.document }, 201);
    case "superseded":
      return jsonResponse({ status: "superseded", document: outcome.document, supersededDocumentId: outcome.supersededDocumentId }, 201);
    case "updated":
    case "unchanged":
      return jsonResponse({ status: outcome.status, document: outcome.document }, 200);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/coach-compliance\/?/, "").replace(/\/$/, "");

  try {
    if (route === "summary") {
      if (req.method !== "GET") return jsonResponse({ error: "Method not allowed - use GET" }, 405);
      return await handleSummary(req, url.searchParams);
    }
    if (route === "verify") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleVerify(req);
    }
    if (route === "submit") {
      if (req.method !== "POST") return jsonResponse({ error: "Method not allowed - use POST" }, 405);
      return await handleSubmit(req);
    }
    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
