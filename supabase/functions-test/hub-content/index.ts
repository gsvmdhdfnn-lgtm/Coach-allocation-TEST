import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildOccurrenceStaffByOccurrenceId,
  buildSessionStaffByCoachAndSession,
  buildSessionStaffById,
  buildSessionStaffBySessionId,
  capabilitiesForCoach,
  firstLink,
  legacyFallbackPerms,
  resolvePlayerAccess,
  roleCapabilitiesById,
  roleCapsByRoleName,
  selectName,
  ukTodayIso,
  type PlayerAccessRow,
  type AccessTier,
} from "./player-access.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;

// ---------------------------------------------------------------------
// TEST DEPLOYMENT GUARD. This copy runs only in the test Supabase
// project against the test Airtable base. If AIRTABLE_BASE_ID is ever a
// known production base, the function refuses to start at all - a boot
// failure is loud and harmless, a silent write to the live base is not.
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

// Same public "publish to web" CSV this project's config.js already points
// the client at (Sessions tab) - kept in sync by hand if that URL is ever
// republished.
//
// SESSIONS_CSV_URL is currently unused in this file: handlePlayers() now
// reads Session Staff instead (see player-access.ts), and the Sessions-
// from-Sheet auto-sync that used to read it has been retired (see
// TEST-ENV.md), not fixed. Left in place, not deleted - it's the exact
// "Coach Hub Sessions CSV" flagged separately for the upcoming Schedule
// cleanup, which decides what (if anything) still needs it here.
//
// RETIRED (Coaches Slice 4): a CHANGES_CSV_URL constant used to point at
// the same published sheet's "Changes" tab, read by resolveCoverSessionIds()
// to compute date-specific cover access from free-text coach_in names.
// That whole mechanism (fetching, matching, and the access it granted)
// was removed from this function this slice - see TEST-ENV.md. This
// file no longer fetches the Changes tab at all; the Sheet itself is
// untouched, only this backend's dependency on it for player access is
// gone.
const SESSIONS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQj4giL7oEoZLLfC74Sq97bnUGIdMqnG_ECOkNyRis-Drz4yH1OUssQ-YBRbCR6ajiJBvV05JjzOi8I/pub?gid=349419235&single=true&output=csv";

/**
 * The SAME published Financials "publish to web" CSV the management-only
 * password/AES flow (config.js's `financials` block + management.js's
 * unlock()) already decrypts client-side - given to this function
 * directly, server-side only, purely so handleSessionParticipants() below
 * can read it without ever sending the full sheet (revenue/cost/profit)
 * to a browser. Optional: unset until someone adds it as a Supabase
 * secret, in which case the route simply returns no counts yet - nothing
 * else in the Hub depends on it.
 */
const FINANCIALS_CSV_URL = Deno.env.get("FINANCIALS_CSV_URL") || "";

// Unused since the Sessions-from-Sheet auto-sync was retired below (see
// TEST-ENV.md) - left in place rather than deleted pending the Schedule
// cleanup that decides what, if anything, still needs this constant.
const SESSIONS_SYNC_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAirtableRecords(tableName: string) {
  const records: any[] = [];
  let offset = "";

  do {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`
    );

    if (offset) {
      url.searchParams.set("offset", offset);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(
        `Airtable error for ${tableName}: ${response.status} ${message}`
      );
    }

    const data = await response.json();

    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);

  return records;
}

async function updateAirtableRecord(tableName: string, id: string, fields: Record<string, unknown>) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable update error: ${res.status} ${message}`);
  }
  return res.json();
}

/** Chunks of up to 10 - Airtable's own limit per create/update call. */
async function airtableBatch(tableName: string, method: "POST" | "PATCH", records: { id?: string; fields: Record<string, unknown> }[]) {
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    if (!chunk.length) continue;
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`, {
      method,
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      const message = await res.text();
      throw new Error(`Airtable ${method} ${tableName} error: ${res.status} ${message}`);
    }
  }
}

/** First attachment's URL for an Airtable attachment field, or "". */
function attachmentUrl(fields: Record<string, any>, fieldName: string): string {
  const list = fields[fieldName];
  if (!Array.isArray(list) || !list.length) return "";
  return list[0].url || "";
}

/**
 * Active === true, sorted by Sort Order ascending (blank/missing sorts
 * last). Also drops a record whose primary field is blank - a stray empty
 * row (no title/name typed in yet) is never useful to show regardless of
 * its Active checkbox, and real Airtable use turned one up immediately.
 *
 * Must be === true, not !== false: Airtable's API omits an unchecked
 * checkbox from the record entirely (it never sends false), so an
 * unticked box and a box that was never touched look identical to this
 * code - both come through as undefined. !== false treats undefined as
 * active, which means unticking Active could never actually hide a
 * record. === true is the only check that makes the tickbox do anything;
 * it does mean a new row needs Active ticked to appear, not left blank.
 * Every checkbox in this file uses this same === true rule now, for the
 * same reason - see handleSettings below for the organisation record and
 * Hub Settings rows.
 */
function activeSorted(rows: any[], primaryField: string): any[] {
  return rows
    .filter((record) => record.fields.Active === true && record.fields[primaryField])
    .sort((a, b) => {
      const sa = a.fields["Sort Order"];
      const sb = b.fields["Sort Order"];
      if (sa == null && sb == null) return 0;
      if (sa == null) return 1;
      if (sb == null) return -1;
      return sa - sb;
    });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Resources, Venues and Coach Support are coach-facing reference material,
 * not private data - same trust level the live Coaches Hub's Handbook and
 * Resources already have (visible to anyone with the link, no per-user
 * gating). Left public here to match, on purpose, rather than gated
 * behind auth that doesn't exist yet. The `Audience` field on these
 * tables is designed for future role-based filtering once real login
 * (Phase 0's other half) exists to filter by - not applied yet.
 */
async function handleResources() {
  const rows = await getAirtableRecords("Resources");
  return activeSorted(rows, "Title").map((record) => {
    const f = record.fields;
    return {
      resource_id: f["Resource ID"] || "",
      title: f.Title || "",
      category: f.Category || "",
      description: f.Description || "",
      thumbnail_url: attachmentUrl(f, "Thumbnail"),
      attachment_url: attachmentUrl(f, "Attachment"),
      video_url: f["Video URL"] || "",
      external_link: f["External Link"] || "",
      audience: f.Audience || [],
    };
  });
}

async function handleVenues() {
  const rows = await getAirtableRecords("Venues");
  return activeSorted(rows, "Venue Name").map((record) => {
    const f = record.fields;
    return {
      venue_id: f["Venue ID"] || "",
      name: f["Venue Name"] || "",
      address: f.Address || "",
      postcode: f.Postcode || "",
      parking: f.Parking || "",
      meeting_point: f["Meeting Point"] || "",
      access: f.Access || "",
      notes: f.Notes || "",
      hero_image_url: attachmentUrl(f, "Hero Image"),
      parking_image_url: attachmentUrl(f, "Parking Image"),
      site_map_url: attachmentUrl(f, "Site Map"),
    };
  });
}

async function handleCoachSupport() {
  const rows = await getAirtableRecords("Coach Support");
  return activeSorted(rows, "Title").map((record) => {
    const f = record.fields;
    return {
      support_id: f["Support ID"] || "",
      title: f.Title || "",
      section: f.Section || "",
      body: f.Body || "",
      attachment_url: attachmentUrl(f, "Attachment"),
      external_link: f["External Link"] || "",
      audience: f.Audience || [],
    };
  });
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { q = false; }
      else field += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
  }
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}
function csvHeaderKey(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
function csvObjects(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const headers = (rows.shift() || []).map(csvHeaderKey);
  return rows.map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((k, i) => { if (k) o[k] = (r[i] || "").trim(); });
    return o;
  });
}
async function fetchCsvObjects(url: string): Promise<Record<string, string>[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return csvObjects(await res.text());
}
/**
 * RETIRED (Coaches Slice 4) - `resolveCoverSessionIds()` and its private
 * date helpers (`mondayOf`/`parseDateOnly`/`isoDateUTC`/`DAY_OFFSET`)
 * used to compute, from the published Changes Google Sheet, which
 * Session records a coach was covering on the exact current date. Slice
 * 3 made Occurrence Staff the real per-occurrence staffing/cover source,
 * and Slice 4 removed this Sheet-driven fallback from player access
 * entirely - see TEST-ENV.md ("Coaches Foundation - Slice 4") for the
 * full cutover record. `nameKey()` is still exported from
 * player-access.ts and still used there (coachIdentityKeys(),
 * splitCoachNames()) for the separate former-player-snapshot path (see
 * that file's own header) - only this file's own use of it, and the
 * `CHANGES_CSV_URL` constant that fed it, were removed as dead.
 */

/**
 * `active` and `userId` were added alongside role/airtable_person_id for
 * handleSessionParticipants()'s auth gate and player-feedback-style
 * write attribution (Coach User ID) respectively. `displayName` was
 * originally added for the Changes-sheet cover tier's coach-identity
 * matching (coachIdentityKeys()) - Coaches Slice 4 retired that tier
 * from this file entirely, so `displayName` is currently unused here,
 * but left in place (it costs nothing extra - already part of the same
 * `profiles` row) as generic caller profile info any future consumer can
 * read without a new query. RLS on profiles only allows a user to read
 * their own row, so this is always the CALLER's own display_name.
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

function legacyRow(
  player: any,
  sessionLabel: string,
  tier: AccessTier,
  perms: { can_edit_feedback: boolean; can_edit_idp: boolean; can_edit_attendance: boolean }
): PlayerAccessRow {
  return {
    player_record_id: player.id,
    player_id: player.fields["Player ID"] || "",
    name: player.fields["Player Name"] || "",
    photo_url: attachmentUrl(player.fields, "Profile Photo"),
    date_of_birth: player.fields["Date of Birth"] || "",
    session_record_id: "",
    session_id: "",
    session_name: sessionLabel,
    link_record_id: "",
    tier,
    access_until: null,
    ...perms,
  };
}

const LEGACY_ADMIN_PERMS = { can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true };

/**
 * Players a signed-in coach/management user can see, grouped implicitly by
 * session (each row already carries its session_id/session_name - the
 * client groups them for display). Requires a valid Authorization header;
 * with none/invalid, returns nothing.
 *
 * Access is resolved once, centrally, by resolvePlayerAccess() (see
 * player-access.ts): a coach's current-session access comes from their
 * own Active, effective-dated Session Staff row on that session (Lead
 * Coach/Coach only, Learning Coach never - see player-access.ts), plus
 * any Occurrence Staff one-date exception for a session occurrence dated
 * exactly today (Slice 3). Coaches Slice 4 retired the separate Changes-
 * sheet "cover" tier entirely - the Google Sheets Changes tab is no
 * longer fetched or consulted anywhere in this function, and a coach can
 * no longer gain player-data access purely from a Sheet row or a
 * free-text schedule-name match. Occurrence Staff (Slice 3) is now the
 * ONLY mechanism for a one-date addition/replacement; if it's missing or
 * unresolvable, access fails closed rather than falling back to the
 * Sheet. See TEST-ENV.md ("Coaches Foundation - Slice 4") for the full
 * cutover record.
 *
 * A player who isn't in the new system yet (no Player Session Links at
 * all) still falls back to the legacy Assigned Coaches link on their own
 * Players record - gated by the "legacy_assigned_coaches" Feature
 * Control flag (default on). That fallback is left exactly as it was:
 * it still reads Players.Active/Assigned Coaches by their pre-rename
 * names (now LEGACY - Active / LEGACY - Assigned Coaches in this base),
 * so it still returns no rows here, same as before this repair - fixing
 * it is a different task (see TEST-ENV.md).
 *
 * Coaches Slice 3: also fetches Session Occurrences and Occurrence Staff,
 * purely to find - per session - the one occurrence (if any) dated
 * exactly today, so that occurrence's own one-date staffing exceptions
 * (an additive coach, or an explicit Cover replacing someone) participate
 * in today's access decision via resolveOccurrenceStaffing() inside
 * player-access.ts. A session with no occurrence dated today resolves
 * exactly as it did in Slice 2 - Occurrence Staff never touches a date
 * it isn't linked to.
 */
async function handlePlayers(authHeader: string | null) {
  const caller = await resolveCaller(authHeader);
  if (!caller) return [];

  const [playerRows, coachRows, sessionRows, linkRows, featureRows, coachRoleRows, sessionStaffRows, occurrenceRows, occurrenceStaffRows] = await Promise.all([
    getAirtableRecords("Players"),
    getAirtableRecords("Coaches"),
    getAirtableRecords("Sessions"),
    getAirtableRecords("Player Session Links"),
    getAirtableRecords("Feature Controls"),
    getAirtableRecords("Coach Roles"),
    getAirtableRecords("Session Staff"),
    getAirtableRecords("Session Occurrences"),
    getAirtableRecords("Occurrence Staff"),
  ]);

  const coachRecordById: Record<string, any> = {};
  for (const c of coachRows) coachRecordById[c.id] = c;

  const roleCapsById = roleCapabilitiesById(coachRoleRows);
  const roleCapsByNameMap = roleCapsByRoleName(coachRoleRows);
  const callerCoachRecord = caller.airtablePersonId ? coachRecordById[caller.airtablePersonId] : null;
  // Legacy Assigned Coaches fallback only (see this function's own docstring) - deliberately untouched.
  const coachCapabilities = capabilitiesForCoach(callerCoachRecord, roleCapsById);
  const sessionStaffBySessionAndCoach = buildSessionStaffByCoachAndSession(sessionStaffRows);
  const sessionStaffBySessionId = buildSessionStaffBySessionId(sessionStaffRows);
  const sessionStaffById = buildSessionStaffById(sessionStaffRows);
  const occurrenceStaffByOccurrenceId = buildOccurrenceStaffByOccurrenceId(occurrenceStaffRows);
  // Coaches Slice 2's date check uses the exact same instant as
  // resolvePlayerAccess() below - one "now" per request.
  const today = new Date();
  const todayIso = ukTodayIso(today);
  // Session RECORD id -> the Session Occurrence RECORD id dated exactly
  // today, for sessions that have one - Coaches Slice 3. Cancelled/
  // Postponed occurrences are skipped: an occurrence that isn't really
  // happening today shouldn't grant a one-date staffing exception, same
  // "not a live candidate" filter parent-hub's resolveNextOccurrence()
  // already applies for its own, separate purpose.
  const occurrenceIdForSessionToday: Record<string, string> = {};
  for (const occ of occurrenceRows) {
    if (occ.fields["Date"] !== todayIso) continue;
    const status = selectName(occ.fields["Status"]);
    if (status === "Cancelled" || status === "Postponed") continue;
    const sid = firstLink(occ.fields, "Session");
    if (sid) occurrenceIdForSessionToday[sid] = occ.id;
  }

  const rows = resolvePlayerAccess({
    role: caller.role,
    coachRecordId: caller.airtablePersonId,
    players: playerRows,
    sessions: sessionRows,
    links: linkRows,
    sessionStaffBySessionAndCoach,
    roleCapsById,
    today,
    occurrenceIdForSessionToday,
    occurrenceStaffByOccurrenceId,
    sessionStaffBySessionId,
    sessionStaffById,
    roleCapsByNameMap,
  });

  const legacyFlag = featureRows.find((r: any) => r.fields["Feature Key"] === "legacy_assigned_coaches");
  const legacyEnabled = legacyFlag ? legacyFlag.fields["Enabled"] === true : true;

  const covered = new Set(rows.map((r) => r.player_record_id));
  const fallback: PlayerAccessRow[] = [];
  if (legacyEnabled) {
    if (caller.role === "management") {
      // Management behaviour is unchanged: fixed admin permissions, same as before.
      for (const p of playerRows) {
        if (p.fields["Active"] !== true || covered.has(p.id)) continue;
        if (!(p.fields["Assigned Coaches"] || []).length) continue;
        fallback.push(legacyRow(p, "Not yet linked to a session", "admin", LEGACY_ADMIN_PERMS));
      }
    } else if (caller.airtablePersonId) {
      // Never a separate rule set: no valid active Coach Role, or Can
      // View Players = false, means no legacy rows either (fail closed).
      const legacyPerms = legacyFallbackPerms(coachCapabilities);
      if (legacyPerms) {
        for (const p of playerRows) {
          if (p.fields["Active"] !== true || covered.has(p.id)) continue;
          const assigned: string[] = p.fields["Assigned Coaches"] || [];
          if (!assigned.includes(caller.airtablePersonId)) continue;
          fallback.push(legacyRow(p, "Not yet linked to a session", "permanent", legacyPerms));
        }
      }
    }
  }

  return [...rows, ...fallback];
}

/**
 * RETIRED, not fixed - see TEST-ENV.md ("Retiring the legacy
 * Sessions-from-Sheet sync"). This upserted Airtable Sessions from the
 * published Sessions sheet, treating the Sheet as authoritative for
 * which Sessions exist: created any new session_id, refreshed the name
 * of one that changed, and archived (Active=false) any Airtable Session
 * no longer in the sheet.
 *
 * That premise is exactly the architecture this project has moved away
 * from - Sessions are now created and managed directly in Airtable
 * (Session Staff, Session Occurrences). A "fixed" version of this
 * function (reading LEGACY - Active instead of the retired Active name)
 * would not restore anything worth having: TEST-A and TEST-B exist only
 * in Airtable, with no corresponding row in the Sheet, so the very next
 * run would archive both of them. Left here, disconnected, rather than
 * deleted, only because player-sessions carries an identical copy this
 * comment doesn't reach - remove both together once the replacement
 * Schedule system (Occurrence Staff / Session Staff-based) makes this
 * fully redundant, rather than reviving either copy by fixing field names.
 *
 * function syncSessions() { ... } - body intentionally removed from this
 * TEST copy; see git history for the original if ever needed for
 * reference while designing the replacement.
 */

/**
 * RETIRED, not fixed - see syncSessions()'s comment above and
 * TEST-ENV.md. This called syncSessions() automatically (throttled
 * hourly via a "Sessions Last Synced" timestamp on Organisation &
 * Branding) from every hit to handleSettings() - i.e. on ordinary Hub
 * traffic, not just an explicit sync request. No longer called from
 * handleSettings() below; nothing else in this file invokes it, and
 * hub-content exposes no "sync" route of its own, so this is the only
 * invocation path that existed and it is now fully disconnected.
 */

/**
 * Up to 3 optional photo+description slots on a Public Page, for a
 * stacked "event list" layout (e.g. Upcoming Events) instead of the
 * usual single body paragraph. Any Public Page can use this - it's not
 * tied to a specific page ID or category - by filling in Event 1/2/3
 * Photo+Description; slots left entirely blank are dropped.
 */
function eventItems(f: Record<string, any>) {
  return [1, 2, 3]
    .map((n) => ({
      photo_url: attachmentUrl(f, `Event ${n} Photo`),
      description: f[`Event ${n} Description`] || "",
    }))
    .filter((e) => e.photo_url || e.description);
}

/**
 * Public landing-page content - Trials/Academy/Tours/Events/General cards
 * shown to visitors who have never signed up. Genuinely public: this
 * whole function runs with verify_jwt off, matching Resources/Venues/
 * Coach Support above, and this table needs it even more since it's the
 * very first thing an anonymous visitor sees, before any login screen.
 */
async function handlePublicPages() {
  const rows = await getAirtableRecords("Public Pages");
  return activeSorted(rows, "Title").map((record) => {
    const f = record.fields;
    return {
      page_id: f["Page ID"] || "",
      title: f.Title || "",
      category: f.Category || "",
      summary: f.Summary || "",
      body: f.Body || "",
      colour: f["Custom Colour (hex)"] || "",
      colour_preset: f["Colour Preset"] || "",
      age_groups: f["Age Groups"] || "",
      cta_label: f["CTA Label"] || "",
      cta_link: f["CTA Link"] || "",
      image_url: attachmentUrl(f, "Image"),
      show_register_form: f["Show Register Form"] === true,
      show_what_we_offer: f["Show What We Offer"] === true,
      events: eventItems(f),
    };
  });
}

/**
 * Shared "What We Offer" informational cards - not clickable, and not
 * tied to any specific Public Page by ID/title. A Public Page opts in by
 * ticking its own "Show What We Offer" checkbox (see handlePublicPages
 * above); this collection itself is just the shared list of offerings,
 * same activeSorted()/attachmentUrl() pipeline as every other public
 * collection in this file.
 *
 * Pricing stays deliberately simple (no payment/finance logic here):
 * Price Note doubles as a prefix shown in front of a numeric Price (e.g.
 * "From" -> "From £10 weekly") or, when Price is blank, as standalone
 * wording instead of a price (e.g. "Trial / invitation pathway",
 * "Contact us"). The client owns exactly how that's displayed; this just
 * passes both fields through as-is.
 */
async function handleWhatWeOffer() {
  const rows = await getAirtableRecords("What We Offer");
  return activeSorted(rows, "Title").map((record) => {
    const f = record.fields;
    return {
      offering_id: f["Offering ID"] || "",
      title: f.Title || "",
      description: f.Description || "",
      image_url: attachmentUrl(f, "Image"),
      age_for: f["Age / Who For"] || "",
      day_time: f["Day / Time"] || "",
      venue: f.Venue || "",
      price: typeof f.Price === "number" ? f.Price : null,
      billing_period: f["Billing Period"] || "",
      price_note: f["Price Note"] || "",
    };
  });
}

/**
 * The ONE safe, coach-facing read of Financials: session_id and
 * participant count only. This deliberately does not reuse
 * handlePlayers()/management's unlock() path - those exist for a
 * different purpose (player access / the full protected dashboard) and
 * the latter never runs server-side at all (it's a client-side password
 * decrypt). Every other Financials column (revenue_gross, revenue_net,
 * coach_cost, venue_cost, profit) is read here, server-side, and then
 * immediately discarded - it never enters the mapped response, so it can
 * never reach a coach's browser through this route.
 *
 * Auth gate lives in the dispatcher below (resolveCaller + active +
 * role check), not here - this function stays a pure, already-gated
 * data read, same shape as before.
 */
async function handleSessionParticipants() {
  if (!FINANCIALS_CSV_URL) return [];
  const rows = await fetchCsvObjects(FINANCIALS_CSV_URL);
  const bySessionId: Record<string, string> = {};
  for (const r of rows) {
    if (r.session_id) bySessionId[r.session_id] = r.participants || "";
  }
  return Object.keys(bySessionId).map((sessionId) => ({
    session_id: sessionId,
    participants: bySessionId[sessionId],
  }));
}

async function handleSettings() {
  const [organisationRows, settingRows, featureRows] = await Promise.all([
    getAirtableRecords("Organisation & Branding"),
    getAirtableRecords("Hub Settings"),
    getAirtableRecords("Feature Controls"),
  ]);

  const organisationRecord = organisationRows.find(
    (record) => record.fields.Active === true
  );

  // The auto Sessions-from-Sheet sync that used to fire here on every
  // load has been retired, not fixed - see the comment above the (now
  // removed) syncSessions()/maybeAutoSyncSessions() and TEST-ENV.md.

  const organisation = organisationRecord
    ? {
        organisation_id: organisationRecord.fields["Organisation ID"] || "",
        organisation_name:
          organisationRecord.fields["Organisation Name"] || "",
        hub_name: organisationRecord.fields["Hub Name"] || "",
        tagline: organisationRecord.fields.Tagline || "",
        website: organisationRecord.fields.Website || "",
        hub_domain: organisationRecord.fields["Hub Domain"] || "",
        timezone: organisationRecord.fields.Timezone || "Europe/London",
        primary_colour: organisationRecord.fields["Custom Primary Colour (hex)"] || "",
        secondary_colour: organisationRecord.fields["Custom Secondary Colour (hex)"] || "",
        accent_colour: organisationRecord.fields["Custom Accent Colour (hex)"] || "",
        primary_colour_preset: organisationRecord.fields["Primary Colour Preset"] || "",
        secondary_colour_preset: organisationRecord.fields["Secondary Colour Preset"] || "",
        accent_colour_preset: organisationRecord.fields["Accent Colour Preset"] || "",
        logo_url: attachmentUrl(organisationRecord.fields, "Logo"),
      }
    : {};

  const settings: Record<string, string> = {};
  for (const record of settingRows) {
    const fields = record.fields;
    if (fields.Active !== true) continue;
    if (!fields.Setting) continue;
    settings[fields.Setting] = fields.Label || "";
  }

  const features: Record<string, boolean> = {};
  for (const record of featureRows) {
    const fields = record.fields;
    if (!fields["Feature Key"]) continue;
    features[fields["Feature Key"]] = fields.Enabled === true;
  }

  return { organisation, settings, features };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const pathname = new URL(req.url).pathname;
  const route = pathname.replace(/^.*\/hub-content\/?/, "").replace(/\/$/, "");

  try {
    if (route === "resources") return jsonResponse(await handleResources());
    if (route === "venues") return jsonResponse(await handleVenues());
    if (route === "coach-support") return jsonResponse(await handleCoachSupport());
    if (route === "public-pages") return jsonResponse(await handlePublicPages());
    if (route === "what-we-offer") return jsonResponse(await handleWhatWeOffer());
    if (route === "session-participants") {
      // Internal Coach/Management operational data, not public Landing
      // content - unlike Resources/Venues/Coach Support/Public Pages
      // above, this one requires a valid session AND an active
      // coach/management profile. 401 for no/invalid session, 403 for a
      // valid session that isn't an active coach or management account.
      const caller = await resolveCaller(req.headers.get("Authorization"));
      if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
      if (!caller.active || (caller.role !== "coach" && caller.role !== "management")) {
        return jsonResponse({ error: "Forbidden" }, 403);
      }
      return jsonResponse(await handleSessionParticipants());
    }
    if (route === "players") return jsonResponse(await handlePlayers(req.headers.get("Authorization")));
    if (route === "" || route === "settings") return jsonResponse(await handleSettings());

    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Unknown error" },
      500
    );
  }
});
