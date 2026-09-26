const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MIN_SECONDS_ON_FORM = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }

  // Honeypot: a real visitor never sees or fills this field (hidden with
  // CSS on the frontend). Anything in it means a bot filling every field
  // it can find - discard silently, don't tell the bot why.
  if (String(body.website_hp || "").trim() !== "") {
    return jsonResponse({ ok: true });
  }

  // Minimum-time check: reject anything submitted implausibly fast after
  // the form loaded (a bot filling and submitting in well under a second).
  const startedAt = Number(body.started_at);
  if (!startedAt || (Date.now() - startedAt) / 1000 < MIN_SECONDS_ON_FORM) {
    return jsonResponse({ error: "Please try again." }, 422);
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const phone = String(body.phone || "").trim();
  const notes = String(body.notes || "").trim();
  const ageGroup = String(body.age_group || "").trim();
  const pageId = String(body.page_id || "").trim();
  const pageTitle = String(body.page_title || "").trim();

  if (!name || !email || !pageTitle || !ageGroup) {
    return jsonResponse({ error: "Name, email, age group and which programme are required." }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: "That doesn't look like a valid email address." }, 400);
  }

  const fields: Record<string, unknown> = {
    Name: name,
    Email: email,
    "Interested In": pageTitle,
    "Age Group": ageGroup,
    Status: "New",
  };
  if (phone) fields.Phone = phone;
  if (notes) fields.Notes = notes;
  if (pageId) fields["Source Page ID"] = pageId;

  const response = await fetch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent("Trial Interest")}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields }] }),
    }
  );

  if (!response.ok) {
    const message = await response.text();
    console.error("Airtable error", response.status, message);
    return jsonResponse({ error: "Could not save your enquiry. Please try again." }, 502);
  }

  return jsonResponse({ ok: true });
});
