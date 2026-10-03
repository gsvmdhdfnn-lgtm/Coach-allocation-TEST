/**
 * TEST Edge Function: settings (Settings / Config S1-a).
 *
 * Organisation Management configuration only - not Platform Admin.
 *
 * Routes:
 *   GET /settings/system  -> the read-only Settings & System overview
 *                            (settings-system.ts). Active Management of a
 *                            matching active organisation only.
 *
 * No writes in S1-a. No organisation parameter is accepted: the
 * organisation always comes from the caller's own profile
 * (resolveOrganisationContext, _shared/organisation-context.ts).
 * Finance View / Manage is not required: connection health is read-only
 * and Finance still owns every connection.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  type ConfigRow,
  FEATURE_TABLE,
  ORGANISATION_TABLE,
  resolveOrganisationContext,
} from "../_shared/organisation-context.ts";
import {
  SHEETS_HEALTH_COLUMNS,
  STRIPE_HEALTH_COLUMNS,
  XERO_HEALTH_COLUMNS,
  buildSettingsSystemOverview,
  organisationParameterIn,
} from "./settings-system.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;

// ---------------------------------------------------------------------
// TEST DEPLOYMENT GUARD (same as every TEST function).
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
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getAirtableRecords(table: string): Promise<ConfigRow[]> {
  const records: ConfigRow[] = [];
  let offset = "";
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`);
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable error for ${table}: ${res.status} ${await res.text()}`);
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return records;
}

/** Health columns only, for this organisation only (service role; the tables are not client-readable). */
async function readHealth(table: string, columns: string, organisationId: string, extra = ""): Promise<any[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?organisation_id=eq.${encodeURIComponent(organisationId)}${extra}&select=${columns}`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!res.ok) throw new Error(`${table} health read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} health read returned an unexpected shape`);
  return rows;
}

async function resolveCaller(authHeader: string | null) {
  if (!authHeader) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return null;
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, active, organisation_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return { userId: userData.user.id, role: profile.role, active: profile.active === true, organisationId: profile.organisation_id || "" };
}

async function handleSystem(caller: { active: boolean; organisationId: string }) {
  const [orgRows, featureRows] = await Promise.all([getAirtableRecords(ORGANISATION_TABLE), getAirtableRecords(FEATURE_TABLE)]);
  const resolved = resolveOrganisationContext(caller, orgRows);
  if (!resolved.ok) return jsonResponse({ error: resolved.error, code: resolved.code }, resolved.status);
  const id = resolved.context.organisationId;
  const [xero, stripe, sheets] = await Promise.all([
    readHealth("finance_external_connections", XERO_HEALTH_COLUMNS, id, "&provider=eq.xero"),
    readHealth("finance_stripe_connections", STRIPE_HEALTH_COLUMNS, id),
    readHealth("finance_reporting_connections", SHEETS_HEALTH_COLUMNS, id, "&provider=eq.google_sheets"),
  ]);
  return jsonResponse(buildSettingsSystemOverview({ context: resolved.context, featureRows, xero, stripe, sheets }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/settings\/?/, "").replace(/\/$/, "");

  try {
    if (route === "system") {
      if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
      const caller = await resolveCaller(req.headers.get("Authorization"));
      if (!caller) return jsonResponse({ error: "Invalid or expired session" }, 401);
      if (!caller.active) return jsonResponse({ error: "This account is not active.", code: "inactive_profile" }, 403);
      if (caller.role !== "management") return jsonResponse({ error: "Management access required" }, 403);
      const param = organisationParameterIn(url.searchParams);
      if (param) return jsonResponse({ error: "The organisation comes from your account and cannot be chosen.", code: "organisation_parameter_not_accepted" }, 400);
      return await handleSystem(caller);
    }
    return jsonResponse({ error: "Unknown route" }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
  }
});
