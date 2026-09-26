import { createClient } from "jsr:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  // The caller's own JWT is forwarded, never a client-supplied user id -
  // RLS on profiles ("auth.uid() = user_id") is what actually scopes this.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session" }, 401);
  const user = userData.user;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("organisation_id, role, active, airtable_person_id, display_name")
    .eq("user_id", user.id)
    .single();

  if (profileError || !profile) return jsonResponse({ error: "Profile not found" }, 404);

  return jsonResponse({
    user_id: user.id,
    email: user.email,
    organisation_id: profile.organisation_id,
    role: profile.role,
    status: profile.active ? "active" : "inactive",
    airtable_person_id: profile.airtable_person_id || null,
    display_name: profile.display_name || null,
  });
});
