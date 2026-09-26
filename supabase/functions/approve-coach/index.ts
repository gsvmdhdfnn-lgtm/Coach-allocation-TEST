import { createClient } from "jsr:@supabase/supabase-js@2";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * The caller's own JWT identifies them and is used, via a user-scoped
 * client (RLS applies), to read their OWN profile role - never trust a
 * role or user id supplied in the request body. Only role === 'management'
 * may use any route in this function. This is the real access control;
 * the frontend hiding the Coach Management screen from non-management
 * users is just UX, not security.
 */
async function requireManagement(authHeader: string) {
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) {
    return { error: jsonResponse({ error: "Invalid or expired session" }, 401) };
  }
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) {
    return { error: jsonResponse({ error: "Profile not found" }, 404) };
  }
  if (profile.role !== "management") {
    return { error: jsonResponse({ error: "Management access required" }, 403) };
  }
  return { user: userData.user };
}

async function airtableRequest(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable error: ${res.status} ${message}`);
  }
  return res.json();
}

async function airtableFindByField(fieldName: string, value: string) {
  const escaped = value.replace(/"/g, '\\"');
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Coaches`);
  url.searchParams.set("filterByFormula", `{${fieldName}} = "${escaped}"`);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable search error: ${res.status} ${message}`);
  }
  const data = await res.json();
  return data.records || [];
}

/**
 * Stable, non-name-based Coach ID: derived from the Supabase user UUID
 * (already globally unique), never from the coach's name - a name change
 * later must never mean an ID change. 12 hex characters (48 bits) makes an
 * accidental collision practically impossible, but a uniqueness check
 * against Airtable runs anyway before it's ever written.
 */
function makeCoachIdCandidate(userId: string) {
  return "COACH-" + userId.replace(/-/g, "").toUpperCase().slice(0, 12);
}

async function ensureUniqueCoachId(userId: string) {
  const base = makeCoachIdCandidate(userId);
  let candidate = base;
  for (let attempt = 0; attempt < 6; attempt++) {
    const matches = await airtableFindByField("Coach ID", candidate);
    if (matches.length === 0) return candidate;
    candidate = `${base}-${attempt + 1}`;
  }
  throw new Error("Could not generate a unique Coach ID");
}

/**
 * Pending staff/coach signups - management-only, used to populate the
 * Coach Management screen.
 *
 * Both conditions matter. A DECLINED signup keeps role = 'pending' (the
 * profiles_role_check constraint only permits pending/management/coach/
 * parent, so there is no 'rejected' role to move it to) and is marked
 * active = false instead. Filtering on active = true is therefore what
 * makes a declined account disappear from the approval queue, while its
 * Auth user and Airtable data stay untouched and a later restore is just
 * a matter of setting active back to true.
 */
async function handlePending(service: ReturnType<typeof createClient>) {
  const { data: pendingProfiles, error } = await service
    .from("profiles")
    .select("user_id, created_at")
    .eq("role", "pending")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const results = [];
  for (const p of pendingProfiles || []) {
    const { data } = await service.auth.admin.getUserById(p.user_id as string);
    results.push({
      user_id: p.user_id,
      email: data?.user?.email || "",
      created_at: p.created_at,
    });
  }
  return results;
}

/**
 * The whole point of searching by Supabase User ID first, on every call,
 * is idempotency: pressing Approve twice (a double-click, a retry after a
 * flaky connection) finds the record it already linked/created on the
 * first call and just re-applies the same values - it can never create a
 * second Coach record for the same person.
 *
 * Approving also sets active = true, which both grants Hub access and
 * un-declines a previously declined signup, so Approve is the restore
 * path for a decline made by mistake.
 */
async function handleApprove(service: ReturnType<typeof createClient>, targetUserId: string) {
  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("role")
    .eq("user_id", targetUserId)
    .single();
  if (profileError || !profile) return jsonResponse({ error: "Profile not found" }, 404);
  if (profile.role !== "pending" && profile.role !== "coach") {
    return jsonResponse({ error: `Refusing to approve a profile with role "${profile.role}" as a coach.` }, 400);
  }

  const { data: userRes } = await service.auth.admin.getUserById(targetUserId);
  // Lowercased so the Airtable lookup matches however the coach typed
  // their address at signup - Airtable's filterByFormula compare is
  // case-sensitive, and a stray capital would otherwise create a second
  // Coach record for someone who already has one.
  const email = String(userRes?.user?.email || "").trim().toLowerCase();

  let coachRecordId: string | null = null;

  const byUserId = await airtableFindByField("Supabase User ID", targetUserId);
  if (byUserId.length === 1) {
    coachRecordId = byUserId[0].id;
  } else if (byUserId.length > 1) {
    return jsonResponse(
      { error: "More than one Coach record already references this Supabase User ID - resolve manually in Airtable." },
      409
    );
  } else if (email) {
    const byEmail = await airtableFindByField("Email", email);
    if (byEmail.length === 1) {
      coachRecordId = byEmail[0].id;
    } else if (byEmail.length > 1) {
      return jsonResponse(
        { error: `More than one Coach record has the email ${email} - resolve manually in Airtable before approving.` },
        409
      );
    }
  }

  if (coachRecordId) {
    await airtableRequest(`Coaches/${coachRecordId}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          Active: true,
          Role: "Coach",
          "Supabase User ID": targetUserId,
        },
      }),
    });
  } else {
    const coachId = await ensureUniqueCoachId(targetUserId);
    const name = email ? email.split("@")[0] : "New Coach";
    const created = await airtableRequest("Coaches", {
      method: "POST",
      body: JSON.stringify({
        records: [
          {
            fields: {
              "Coach Name": name,
              "Coach ID": coachId,
              Email: email,
              Role: "Coach",
              Active: true,
              "Supabase User ID": targetUserId,
            },
          },
        ],
      }),
    });
    coachRecordId = created.records[0].id;
  }

  const { error: updateError } = await service
    .from("profiles")
    .update({ airtable_person_id: coachRecordId, role: "coach", active: true })
    .eq("user_id", targetUserId);
  if (updateError) throw new Error(updateError.message);

  return jsonResponse({ ok: true, airtable_person_id: coachRecordId });
}

/**
 * Safe, reversible decline. The profile KEEPS role = 'pending' - the
 * profiles_role_check constraint allows only pending/management/coach/
 * parent, so writing 'rejected' here fails outright - and is deactivated
 * instead:
 *
 *   active = false            -> drops out of handlePending's queue, and
 *                                /me reports status "inactive" so the
 *                                sign-in screen refuses Hub access.
 *   airtable_person_id = null -> the profile no longer claims a Coach
 *                                record it was never approved for.
 *
 * Nothing is destroyed: the Supabase Auth user remains, any Airtable
 * Coach record remains, and Approve re-activates the account later.
 */
async function handleDecline(service: ReturnType<typeof createClient>, targetUserId: string) {
  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("role, active")
    .eq("user_id", targetUserId)
    .single();
  if (profileError || !profile) return jsonResponse({ error: "Profile not found" }, 404);
  if (profile.role !== "pending") {
    return jsonResponse({ error: `Only a pending coach signup can be declined (current role: "${profile.role}").` }, 400);
  }
  const { error: updateError } = await service
    .from("profiles")
    .update({ active: false, airtable_person_id: null })
    .eq("user_id", targetUserId);
  if (updateError) throw new Error(updateError.message);
  return jsonResponse({ ok: true, status: "declined" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const auth = await requireManagement(authHeader);
  if ("error" in auth) return auth.error;

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const pathname = new URL(req.url).pathname;
  const route = pathname.replace(/^.*\/approve-coach\/?/, "").replace(/\/$/, "");

  try {
    if (route === "pending" && req.method === "GET") {
      return jsonResponse(await handlePending(service));
    }
    if (route === "" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const targetUserId = String(body.user_id || "").trim();
      if (!targetUserId) return jsonResponse({ error: "user_id is required" }, 400);
      return await handleApprove(service, targetUserId);
    }
    if (route === "decline" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const targetUserId = String(body.user_id || "").trim();
      if (!targetUserId) return jsonResponse({ error: "user_id is required" }, 400);
      return await handleDecline(service, targetUserId);
    }
    return jsonResponse({ error: "Unknown route" }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
