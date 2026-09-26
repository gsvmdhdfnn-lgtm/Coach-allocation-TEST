import { createClient } from "jsr:@supabase/supabase-js@2";

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
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Table IDs (not names) for the two Phase 2 tables specifically because
// "Parent–Player Links" contains an en dash, not a hyphen - using the ID
// sidesteps any encoding mismatch. Every other table here already has a
// plain-ASCII name and is referenced by name, matching the rest of the
// codebase's Airtable calls.
// TEST DEPLOYMENT: these are the TEST base's table IDs. The production
// copy hardcodes the live base's IDs, which is a portability problem in
// its own right - a function that names table IDs cannot be pointed at
// another base without editing its source. Flagged, not silently fixed.
const TBL_PARENTS = "tbl2NC4oLuC4ZUFvD";
const TBL_PARENT_PLAYER_LINKS = "tblMrzy6TmiNPXqUG";

// Same "publish to web" Sessions CSV the Coach hub and player-feedback
// already read - the schedule's own source of truth for day/time/venue/
// coach. Airtable's Sessions table is only the access-control anchor
// (Session ID + Session Name), so parent-facing session detail has to
// join the two rather than inventing fields in Airtable.
const SESSIONS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQj4giL7oEoZLLfC74Sq97bnUGIdMqnG_ECOkNyRis-Drz4yH1OUssQ-YBRbCR6ajiJBvV05JjzOi8I/pub?gid=349419235&single=true&output=csv";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // GET/POST are CORS-safelisted and worked without this, but naming them
  // explicitly keeps a future PATCH/DELETE route from silently failing its
  // preflight the way player-feedback's PATCH did.
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function getAirtableRecords(table: string) {
  const records: any[] = [];
  let offset = "";
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`);
    if (offset) url.searchParams.set("offset", offset);
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Airtable error for ${table}: ${response.status} ${message}`);
    }
    const data = await response.json();
    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return records;
}

async function getAirtableRecord(table: string, id: string) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${id}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function updateAirtableRecord(table: string, id: string, fields: Record<string, unknown>) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${id}`, {
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

async function createAirtableRecord(table: string, fields: Record<string, unknown>) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable create error: ${res.status} ${message}`);
  }
  const data = await res.json();
  return data.records[0];
}

async function airtableFindByField(table: string, fieldName: string, value: string) {
  const escaped = value.replace(/"/g, '\\"');
  const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`);
  url.searchParams.set("filterByFormula", `{${fieldName}} = "${escaped}"`);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Airtable search error: ${res.status} ${message}`);
  }
  const data = await res.json();
  return data.records || [];
}

function attachmentUrl(fields: Record<string, any>, fieldName: string): string {
  const list = fields[fieldName];
  if (!Array.isArray(list) || !list.length) return "";
  return list[0].url || "";
}
function normalizeName(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Airtable's REST API returns a singleSelect as the plain option-name
 * string, never an {id,name,color} object. Handled defensively both ways
 * so a field-type change degrades instead of silently blanking every row
 * (the exact bug that made every framework item read as group "").
 */
function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

/**
 * A parent must never be shown an internal handle. Anything that reads
 * like a login rather than a person's name - an email address, or a
 * single token carrying dots/underscores/digits ("davidcole.surrey") -
 * is rejected so the caller can fall back to a better source, or to a
 * neutral label. Returns "" for anything unpresentable.
 */
function presentableName(v: any): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.indexOf("@") >= 0) return "";
  if (!/\s/.test(s) && /[._\d]/.test(s)) return "";
  return s;
}

/** The coach's account display name wins, then their Coach record name, then a neutral label - never the raw identifier. */
function parentFacingCoachName(displayName: any, coachName: any): string {
  return presentableName(displayName) || presentableName(coachName) || "Your coach";
}

// --- Sessions CSV (schedule source of truth) -------------------------

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
/** Never throws - a schedule outage degrades session detail to the Airtable name only, it never breaks the whole hub. */
async function fetchSessionsCsv(): Promise<Record<string, string>[]> {
  try {
    const res = await fetch(SESSIONS_CSV_URL, { cache: "no-store" });
    if (!res.ok) return [];
    return csvObjects(await res.text());
  } catch (e) {
    console.error("Sessions CSV unavailable", e);
    return [];
  }
}
function splitCoaches(s: string): string[] {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function makeParentId(userId: string): string {
  return "PARENT-" + userId.replace(/-/g, "").toUpperCase().slice(0, 12);
}
async function ensureUniqueParentId(userId: string): Promise<string> {
  const base = makeParentId(userId);
  let candidate = base;
  for (let attempt = 0; attempt < 6; attempt++) {
    const matches = await airtableFindByField(TBL_PARENTS, "Parent ID", candidate);
    if (!matches.length) return candidate;
    candidate = `${base}-${attempt + 1}`;
  }
  throw new Error("Could not generate a unique Parent ID");
}

async function resolveCaller(authHeader: string | null) {
  if (!authHeader) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return null;
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, airtable_person_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return {
    userId: userData.user.id,
    email: userData.user.email || "",
    role: profile.role,
    airtablePersonId: profile.airtable_person_id || null,
  };
}

/**
 * Finds or creates the Parents & Guardians record for this Supabase user -
 * auto-provisioned on first use, same pattern as a Coach record being
 * auto-provisioned on approval. This ONLY ever creates/links the parent's
 * OWN identity record - it never touches a Player. That stays entirely
 * behind the claim+approval flow below, per the rule that parent signup
 * never directly creates or links a Player record.
 */
async function resolveParentRecord(userId: string, email: string) {
  const byUserId = await airtableFindByField(TBL_PARENTS, "Supabase User ID", userId);
  if (byUserId.length) return byUserId[0];

  if (email) {
    const byEmail = await airtableFindByField(TBL_PARENTS, "Email", email);
    if (byEmail.length === 1) {
      await updateAirtableRecord(TBL_PARENTS, byEmail[0].id, { "Supabase User ID": userId });
      byEmail[0].fields["Supabase User ID"] = userId;
      return byEmail[0];
    }
  }

  const parentId = await ensureUniqueParentId(userId);
  return await createAirtableRecord(TBL_PARENTS, {
    "Parent / Guardian Name": email ? email.split("@")[0] : "New Parent",
    "Parent ID": parentId,
    ...(email ? { Email: email } : {}),
    "Supabase User ID": userId,
    Active: true,
  });
}

/**
 * Reads back the name/DOB a parent originally typed for a claim that never
 * resolved to a Player record (0 or 2+ matches) - handleCreateClaim writes
 * this exact sentence into Notes, and duplicate-detection parses it back
 * out rather than needing a dedicated Airtable field for something that
 * only ever needs to be read once, by this same function.
 */
function extractClaimedNameDob(notes: string): { name: string; dob: string } | null {
  const m = /Parent-entered claim: "([^"]*)", DOB (\S+)/.exec(notes || "");
  if (!m) return null;
  return { name: m[1], dob: m[2] };
}

/**
 * A membership's lifecycle status.
 *
 * `Membership Lifecycle Status` is canonical. The old `Status` was renamed
 * `LEGACY — Status`, so reading the old name alone returns undefined for
 * every row and no membership ever matches "Active" - which is why a
 * verified child showed no sessions at all.
 *
 * The canonical field carries five values where the old one carried two.
 * Per the agreed rules: Paused is shown separately and read-only, while
 * Cancellation Pending and Ending Scheduled stay with the current
 * sessions, because the player is still attending.
 */
function membershipStatus(fields: Record<string, any>): string {
  return (
    selectName(fields["Membership Lifecycle Status"]) ||
    selectName(fields["LEGACY — Status"]) ||
    selectName(fields["Status"]) ||
    ""
  );
}
const STILL_ATTENDING = ["Active", "Cancellation Pending", "Ending Scheduled"];

/**
 * Whether a Session is open. `Session Lifecycle Status` is canonical; the
 * old `Active` checkbox was renamed `LEGACY — Active`, so the old read
 * returned undefined for every session and the "Find Another Session"
 * list came back empty.
 */
function sessionIsActive(fields: Record<string, any>): boolean {
  const canonical = selectName(fields["Session Lifecycle Status"]);
  if (canonical) return canonical === "Active";
  if (typeof fields["LEGACY — Active"] === "boolean") return fields["LEGACY — Active"] === true;
  return fields["Active"] === true;
}

/**
 * The link's lifecycle status.
 *
 * `Link Lifecycle Status` is the canonical field. The old `Link Status`
 * was renamed `LEGACY — Link Status` in Airtable, so reading the old
 * name alone returns undefined for every row - and because the caller
 * defaulted undefined to "Pending", every link silently read as Pending,
 * including verified ones and ended ones. Both names are read here,
 * canonical first, so this behaves correctly against a base that has
 * migrated and one that has not.
 *
 * `LINK_WRITE_FIELD` is what approve/reject write back. Writing to the
 * retired name would 422, since that field no longer exists.
 */
const LINK_WRITE_FIELD = "Link Lifecycle Status";
function linkStatus(fields: Record<string, any>): string {
  return (
    selectName(fields[LINK_WRITE_FIELD]) ||
    selectName(fields["LEGACY — Link Status"]) ||
    selectName(fields["Link Status"]) ||
    "Pending"
  );
}

/**
 * A link that has been ended is not merely "not verified": the parent's
 * access was deliberately removed, so nothing about that child may be
 * returned to them - not a session, not a claim row, not the child's
 * name. Ended links are dropped before anything is built from them.
 */
function isEndedLink(fields: Record<string, any>): boolean {
  return linkStatus(fields) === "Ended";
}

/**
 * THE parent access gate, used by every parent-facing read below: returns
 * the Player record ids this parent is allowed to see, which is only ever
 * their own Verified links. A Pending or Needs Review claim grants
 * nothing, so a parent can never read a child's data while their claim is
 * still awaiting management approval. Callers pass a client-supplied
 * player id in, and it is checked against THIS set - the id itself is
 * never trusted.
 */
function verifiedPlayerIds(linkRows: any[], parentRecordId: string): Set<string> {
  const ids = new Set<string>();
  for (const l of linkRows) {
    if (!(l.fields["Parent / Guardian"] || []).includes(parentRecordId)) continue;
    if (linkStatus(l.fields) !== "Verified") continue;
    for (const pid of l.fields["Player"] || []) ids.add(pid);
  }
  return ids;
}

/** Session record id -> the schedule row for its Session ID, when the sheet still carries one. */
function buildScheduleBySessionRecordId(sessionRows: any[], csvRows: Record<string, string>[]) {
  const csvBySessionId: Record<string, Record<string, string>> = {};
  for (const r of csvRows) {
    const sid = r.session_id;
    if (sid && !csvBySessionId[sid]) csvBySessionId[sid] = r;
  }
  const out: Record<string, Record<string, string>> = {};
  for (const s of sessionRows) {
    const sid = s.fields["Session ID"];
    if (sid && csvBySessionId[sid]) out[s.id] = csvBySessionId[sid];
  }
  return out;
}

/** Venue name -> the editable Venues record, for the parent-facing address/parking/meeting-point rows. */
function buildVenueByName(venueRows: any[]) {
  const out: Record<string, any> = {};
  for (const v of venueRows) {
    if (v.fields["Active"] !== true) continue;
    const name = v.fields["Venue Name"];
    if (name) out[normalizeName(name)] = v.fields;
  }
  return out;
}

/**
 * One session as a parent should see it: the Airtable access anchor
 * (record id / name) plus the real schedule row and the real venue
 * record. Every field is passed through exactly as published - nothing
 * is invented, and a field the sheet/venue record doesn't carry comes
 * back as "" so the client can omit that row rather than print a
 * placeholder.
 */
function sessionPayload(session: any, schedule: Record<string, string> | undefined, venueByName: Record<string, any>) {
  const sched = schedule || {};
  const venueName = sched.venue || "";
  const venue = venueName ? venueByName[normalizeName(venueName)] : null;
  return {
    session_record_id: session.id,
    session_id: session.fields["Session ID"] || "",
    session_name: session.fields["Session Name"] || "",
    programme: sched.programme || "",
    category: sched.category || "",
    age_group: sched.age_group || "",
    day: sched.day || "",
    time: sched.time || "",
    venue: venueName,
    address: sched.address || "",
    // Schedule coach names are free text, so they get the same
    // presentable-name check as feedback authors - a login-style entry is
    // dropped rather than shown to a parent.
    coaches: splitCoaches(sched.coaches || "").map(presentableName).filter(Boolean),
    venue_info: venue
      ? {
          address: venue["Address"] || "",
          postcode: venue["Postcode"] || "",
          parking: venue["Parking"] || "",
          meeting_point: venue["Meeting Point"] || "",
          access: venue["Access"] || "",
          notes: venue["Notes"] || "",
        }
      : null,
  };
}

/**
 * Session requests are switched OFF at the source while the feature is
 * rebuilt against Player & Parent Requests. The Management screen that
 * processes them is hidden, so a request accepted now would land in a
 * queue nobody reads.
 *
 * That is why this is a deliberate flag and not just "did the read
 * succeed". The old table currently returns 403
 * INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND, but if that cleared on its own
 * a read-driven check would quietly re-open the form while the
 * Management side was still gone. Turning this back on has to be a
 * decision taken when BOTH ends work, never a side effect of a
 * permissions error resolving.
 */
const SESSION_REQUESTS_ENABLED = false;

/**
 * Also contains the read itself. This table was being read inside the
 * same Promise.all as everything else, so when it began failing, one
 * unavailable optional feature rejected the whole handler and took the
 * entire Parent Home down - Next Session, schedule and development
 * included. Both guards report the same way, so the client has one
 * answer to render regardless of which applied.
 */
async function fetchSessionRequests(): Promise<{ rows: any[]; available: boolean }> {
  // Disabled means we do not even ask - one fewer Airtable call on every
  // Parent Hub load, and no 403 noise in the logs for a known state.
  if (!SESSION_REQUESTS_ENABLED) return { rows: [], available: false };
  try {
    return { rows: await getAirtableRecords("Player Session Requests"), available: true };
  } catch (e) {
    console.error("Player Session Requests unavailable", e);
    return { rows: [], available: false };
  }
}

async function handleParentMe(caller: { userId: string; email: string }) {
  const parentRecord = await resolveParentRecord(caller.userId, caller.email);

  // Best-effort: keep profiles.airtable_person_id in sync so the generic
  // /me endpoint also reflects it, same field Coach approval writes -
  // only fills it if still empty, never overwrites an existing link.
  try {
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    await service.from("profiles").update({ airtable_person_id: parentRecord.id }).eq("user_id", caller.userId).is("airtable_person_id", null);
  } catch (e) {
    console.error("Could not sync profiles.airtable_person_id", e);
  }

  const [linkRows, playerRows, sessionRows, sessionLinkRows, sessionRequests, venueRows, csvRows] = await Promise.all([
    getAirtableRecords(TBL_PARENT_PLAYER_LINKS),
    getAirtableRecords("Players"),
    getAirtableRecords("Sessions"),
    getAirtableRecords("Player Session Links"),
    fetchSessionRequests(),
    getAirtableRecords("Venues"),
    fetchSessionsCsv(),
  ]);
  const requestRows = sessionRequests.rows;
  const playerById: Record<string, any> = {};
  for (const p of playerRows) playerById[p.id] = p;
  const sessionById: Record<string, any> = {};
  for (const s of sessionRows) sessionById[s.id] = s;
  const scheduleBySessionRecordId = buildScheduleBySessionRecordId(sessionRows, csvRows);
  const venueByName = buildVenueByName(venueRows);

  const myLinks = linkRows.filter((l: any) => (l.fields["Parent / Guardian"] || []).includes(parentRecord.id));

  const children: any[] = [];
  const pendingClaims: any[] = [];
  for (const link of myLinks) {
    // Ended first, and with `continue`, so no branch below can put this
    // child's name into the response.
    if (isEndedLink(link.fields)) continue;
    const status = linkStatus(link.fields);
    const playerIds: string[] = link.fields["Player"] || [];
    const player = playerIds[0] ? playerById[playerIds[0]] : null;
    if (status === "Verified" && player) {
      // Reuses the same Player Session Links / Player Session Requests
      // tables Phase 1 already built - no parallel "what sessions does
      // this child have" model, just read the real ones for this player.
      const myLinkRows = sessionLinkRows.filter((l: any) => (l.fields["Player"] || []).includes(player.id));

      const activeSessions = myLinkRows
        .filter((l: any) => STILL_ATTENDING.includes(membershipStatus(l.fields)))
        .map((l: any) => {
          const session = sessionById[firstLink(l.fields, "Session")];
          if (!session) return null;
          return {
            ...sessionPayload(session, scheduleBySessionRecordId[session.id], venueByName),
            start_date: l.fields["Start Date"] || "",
          };
        })
        .filter((x: any) => x);

      // Paused is its own bucket: still a membership, but nothing about it
      // is actionable from here, so the client shows it read-only rather
      // than mixed in with the sessions the child is currently attending.
      const pausedSessions = myLinkRows
        .filter((l: any) => membershipStatus(l.fields) === "Paused")
        .map((l: any) => {
          const session = sessionById[firstLink(l.fields, "Session")];
          if (!session) return null;
          return {
            ...sessionPayload(session, scheduleBySessionRecordId[session.id], venueByName),
            paused_from: l.fields["Pause Start Date"] || "",
            returns_on: l.fields["Pause Return Date"] || "",
          };
        })
        .filter((x: any) => x);

      const endedSessions = myLinkRows
        .filter((l: any) => membershipStatus(l.fields) === "Ended")
        .map((l: any) => {
          const session = sessionById[firstLink(l.fields, "Session")];
          if (!session) return null;
          return {
            session_record_id: session.id,
            session_name: session.fields["Session Name"] || "",
            // The date it ACTUALLY ended. Scheduled End Date is what was
            // planned and is deliberately reported separately - a plan is
            // not an outcome, and former access is judged on the real end.
            end_date: l.fields["LEGACY — End Date"] || l.fields["End Date"] || "",
            scheduled_end_date: l.fields["Scheduled End Date"] || "",
          };
        })
        .filter((x: any) => x)
        .sort((a: any, b: any) => (a.end_date < b.end_date ? 1 : -1));

      const pendingRequests = requestRows
        .filter((r: any) => (r.fields["Player"] || []).includes(player.id) && r.fields["Status"] === "Pending")
        .map((r: any) => {
          const session = sessionById[firstLink(r.fields, "Requested Session")];
          return {
            request_id: r.id,
            session_record_id: session ? session.id : "",
            session_name: session ? session.fields["Session Name"] || "" : "",
            requested_date: r.fields["Requested Date"] || "",
          };
        });

      children.push({
        link_id: link.id,
        player_record_id: player.id,
        player_id: player.fields["Player ID"] || "",
        name: player.fields["Player Name"] || "",
        photo_url: attachmentUrl(player.fields, "Profile Photo"),
        relationship: link.fields["Relationship"] || "",
        active_sessions: activeSessions,
        paused_sessions: pausedSessions,
        ended_sessions: endedSessions,
        pending_requests: pendingRequests,
      });
    } else {
      pendingClaims.push({
        link_id: link.id,
        player_name: player ? player.fields["Player Name"] || "" : "Claim submitted",
        status,
        relationship: link.fields["Relationship"] || "",
      });
    }
  }

  // Deliberately name + schedule only: the "Find Another Session"
  // browser is a public-style list of what's on offer, never a window
  // into who else is in a session or anything operational.
  const availableSessions = sessionRows
    .filter((s: any) => sessionIsActive(s.fields))
    .map((s: any) => {
      const sched = scheduleBySessionRecordId[s.id] || {};
      return {
        session_record_id: s.id,
        // The schedule's own Session ID, used only to tell two otherwise
        // identical-looking picker options apart. It is NOT unique in
        // this table (D13 exists twice), so the record id above stays the
        // identity every write is validated against.
        session_id: s.fields["Session ID"] || "",
        session_name: s.fields["Session Name"] || "",
        day: sched.day || "",
        time: sched.time || "",
        venue: sched.venue || "",
        age_group: sched.age_group || "",
        programme: sched.programme || "",
      };
    })
    .sort((a: any, b: any) => a.session_name.localeCompare(b.session_name));

  return {
    parent_id: parentRecord.fields["Parent ID"] || "",
    children,
    pending_claims: pendingClaims,
    available_sessions: availableSessions,
    // False means the requests feature is temporarily unavailable, which
    // is NOT the same as "this child has no pending requests" - the
    // client must say so rather than render a confident empty list.
    session_requests_available: sessionRequests.available,
  };
}

/**
 * Parent-facing feedback for ONE verified child. Deliberately a separate
 * endpoint from the coach-facing player-feedback function rather than a
 * shared one with a role branch: this returns strictly less (no drafts,
 * no coach capability data, no other players) and can never be made to
 * return more by passing a different role.
 *
 * Three independent gates, all server-side:
 *  1. caller must be a parent (checked by the router);
 *  2. the player must be one of THIS parent's Verified children;
 *  3. only Published = true AND Active = true feedback is ever returned -
 *     a coach's unpublished draft is invisible to parents even for their
 *     own child.
 */
async function handleParentFeedback(caller: { userId: string; email: string }, playerRecordId: string) {
  if (!playerRecordId) return jsonResponse({ error: "player_record_id is required" }, 400);

  const parentRecord = await resolveParentRecord(caller.userId, caller.email);
  const linkRows = await getAirtableRecords(TBL_PARENT_PLAYER_LINKS);
  if (!verifiedPlayerIds(linkRows, parentRecord.id).has(playerRecordId)) {
    return jsonResponse({ error: "You can only view feedback for your own verified children." }, 403);
  }

  const [feedbackRows, ratingRows, frameworkRows, settingsRows, sessionRows, coachRows] = await Promise.all([
    getAirtableRecords("Feedback"),
    getAirtableRecords("Feedback Ratings"),
    getAirtableRecords("Development Framework"),
    getAirtableRecords("Development Framework Settings"),
    getAirtableRecords("Sessions"),
    getAirtableRecords("Coaches"),
  ]);

  const sessionById: Record<string, any> = {};
  for (const s of sessionRows) sessionById[s.id] = s;
  const coachById: Record<string, any> = {};
  for (const c of coachRows) coachById[c.id] = c;

  /**
   * Parent rating visibility is driven by the Development Framework
   * item's own "Visible to Parent/Player" flag - the configured,
   * management-editable control - not by the per-rating checkbox of the
   * same name, which the coach entry flow never writes and which is
   * therefore unticked on every historical rating row. Keying off the
   * per-row flag would show a parent an empty snapshot for feedback that
   * genuinely has ratings.
   */
  const parentVisibleItems: Record<string, any> = {};
  for (const f of frameworkRows) {
    if (f.fields["Active"] !== true) continue;
    if (f.fields["Visible to Parent/Player"] !== true) continue;
    parentVisibleItems[f.id] = {
      name: f.fields["Name"] || "",
      group: selectName(f.fields["Group"]),
      sortOrder: typeof f.fields["Sort Order"] === "number" ? f.fields["Sort Order"] : 9999,
    };
  }

  const settingsRecord = settingsRows.find((r: any) => r.fields["Active"] === true) || settingsRows[0] || null;
  const sf = settingsRecord ? settingsRecord.fields : {};
  const settings = {
    framework_name: sf["Framework Name"] || "",
    intro_text: sf["Intro Text"] || "",
    blue_label: sf["Blue Label"] || "Blue",
    green_label: sf["Green Label"] || "Green",
    amber_label: sf["Amber Label"] || "Amber",
    red_label: sf["Red Label"] || "Red",
    show_keep_doing: sf["Show Keep Doing"] === true,
    show_my_focus: sf["Show My Focus"] === true,
    show_general_feedback: sf["Show General Coach Feedback"] === true,
    per_area_written_feedback: sf["Per-Area Written Feedback"] === true,
  };

  const mine = feedbackRows.filter(
    (r: any) =>
      r.fields["Active"] === true &&
      r.fields["Published"] === true &&
      (r.fields["Player"] || []).includes(playerRecordId)
  );

  // The coach's own account display name, which is the human-facing name
  // set when their account was approved - looked up once for every coach
  // who authored one of these reviews.
  const displayNameByUserId: Record<string, string> = {};
  const coachUserIds = [...new Set(mine.map((r: any) => String(r.fields["Coach User ID"] || "")).filter(Boolean))];
  if (coachUserIds.length) {
    try {
      const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await service.from("profiles").select("user_id, display_name").in("user_id", coachUserIds);
      for (const row of data || []) displayNameByUserId[row.user_id] = row.display_name || "";
    } catch (e) {
      console.error("Could not resolve coach display names", e);
    }
  }

  const feedback = mine
    .map((r: any) => {
      const session = sessionById[firstLink(r.fields, "Session")];

      /**
       * Exactly one row per framework item. The Feedback Ratings table
       * still carries duplicate rows for the same (Feedback, Framework
       * Item) pair, left behind by an earlier coach save path that
       * recreated rating children instead of updating them - without
       * this a parent sees "Winners" four times. The most recently
       * created row wins, i.e. what the coach last saved.
       */
      const newestByItem = new Map<string, any>();
      for (const rt of ratingRows) {
        if (!(rt.fields["Feedback"] || []).includes(r.id)) continue;
        const itemId = firstLink(rt.fields, "Framework Item");
        if (!itemId || !parentVisibleItems[itemId]) continue;
        const prev = newestByItem.get(itemId);
        if (!prev || String(rt.createdTime || "") > String(prev.createdTime || "")) newestByItem.set(itemId, rt);
      }
      const ratings = [...newestByItem.values()]
        .map((rt: any) => {
          const itemId = firstLink(rt.fields, "Framework Item");
          const item = parentVisibleItems[itemId];
          return {
            framework_item_id: itemId,
            name: item.name || rt.fields["Label Snapshot"] || "",
            group: item.group || rt.fields["Group Snapshot"] || "",
            sort_order: item.sortOrder,
            rating: selectName(rt.fields["Rating"]),
            notes: settings.per_area_written_feedback ? rt.fields["Notes"] || "" : "",
          };
        })
        .sort((a: any, b: any) => a.sort_order - b.sort_order);

      const coachRecord = coachById[firstLink(r.fields, "Coach")];
      return {
        feedback_id: r.id,
        date: r.fields["Feedback Date"] || "",
        title: r.fields["Feedback Title"] || "",
        coach_name: parentFacingCoachName(
          displayNameByUserId[String(r.fields["Coach User ID"] || "")],
          (coachRecord && coachRecord.fields["Coach Name"]) || r.fields["Coach Name"]
        ),
        session_name: session ? session.fields["Session Name"] || "" : "",
        summary: settings.show_general_feedback ? r.fields["Summary"] || "" : "",
        keep_doing: settings.show_keep_doing ? r.fields["Keep Doing"] || "" : "",
        big_focus: settings.show_my_focus ? r.fields["Big Focus"] || "" : "",
        ratings,
      };
    })
    .sort((a: any, b: any) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return jsonResponse({ settings, feedback });
}

/**
 * A claim NEVER auto-grants access, even on a clean unambiguous match -
 * every claim lands as Pending (single match) or Needs Review (zero or
 * multiple matches) and only management's Approve sets it to Verified.
 * Matching is name + Date of Birth together (never name alone), per the
 * Players table's own Date of Birth field description.
 *
 * Before creating anything, this also checks the caller's own existing
 * (non-Rejected) claims - Pending, Needs Review or already Verified -
 * for the same child by name+DOB, so a parent can't pile up duplicate
 * claims for a child they've already claimed or already have a claim
 * pending for. A Rejected claim doesn't block resubmission (e.g. a typo
 * that was rejected for that reason should be fixable by trying again).
 */
async function handleCreateClaim(caller: { userId: string; email: string }, body: any) {
  const playerName = String(body?.player_name || "").trim();
  const dob = String(body?.date_of_birth || "").trim();
  const relationship = String(body?.relationship || "Parent").trim();
  if (!playerName || !dob) return jsonResponse({ error: "Child's name and date of birth are required." }, 400);

  const parentRecord = await resolveParentRecord(caller.userId, caller.email);
  const [allPlayers, existingLinks] = await Promise.all([
    getAirtableRecords("Players"),
    getAirtableRecords(TBL_PARENT_PLAYER_LINKS),
  ]);
  const playerById: Record<string, any> = {};
  for (const p of allPlayers) playerById[p.id] = p;

  const norm = normalizeName(playerName);

  const myOpenLinks = existingLinks.filter(
    (l: any) =>
      (l.fields["Parent / Guardian"] || []).includes(parentRecord.id) &&
      !["Rejected", "Ended"].includes(linkStatus(l.fields))
  );
  const alreadyClaimed = myOpenLinks.some((l: any) => {
    const linkedIds: string[] = l.fields["Player"] || [];
    if (linkedIds.length) {
      const linkedPlayer = playerById[linkedIds[0]];
      return !!linkedPlayer && normalizeName(linkedPlayer.fields["Player Name"]) === norm && linkedPlayer.fields["Date of Birth"] === dob;
    }
    const claimed = extractClaimedNameDob(l.fields["Notes"] || "");
    return !!claimed && normalizeName(claimed.name) === norm && claimed.dob === dob;
  });
  if (alreadyClaimed) {
    return jsonResponse({ error: "You've already submitted a claim for this child." }, 400);
  }

  const matches = allPlayers.filter((p: any) =>
    p.fields["Active"] === true &&
    normalizeName(p.fields["Player Name"]) === norm &&
    p.fields["Date of Birth"] === dob
  );

  const linkId = `PPLINK-${parentRecord.id.slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

  if (matches.length === 1) {
    await createAirtableRecord(TBL_PARENT_PLAYER_LINKS, {
      "Link ID": linkId,
      "Parent / Guardian": [parentRecord.id],
      Player: [matches[0].id],
      Relationship: relationship,
      [LINK_WRITE_FIELD]: "Pending",
      "Signup Source": "Parent signup",
    });
    return jsonResponse({ ok: true, status: "Pending" });
  }

  const note =
    matches.length === 0
      ? `Parent-entered claim: "${playerName}", DOB ${dob} - no matching active Player record found. Find or create the Player, link them on this record, then approve.`
      : `Parent-entered claim: "${playerName}", DOB ${dob} - matched ${matches.length} Player records (ambiguous). Candidates: ${matches.map((m: any) => m.fields["Player ID"] || m.id).join(", ")}. Pick the right one, link it, then approve.`;

  await createAirtableRecord(TBL_PARENT_PLAYER_LINKS, {
    "Link ID": linkId,
    "Parent / Guardian": [parentRecord.id],
    Relationship: relationship,
    [LINK_WRITE_FIELD]: "Needs Review",
    "Signup Source": "Parent signup",
    Notes: note,
  });
  return jsonResponse({ ok: true, status: "Needs Review" });
}

async function handleListClaims() {
  const [linkRows, parentRows, playerRows] = await Promise.all([
    getAirtableRecords(TBL_PARENT_PLAYER_LINKS),
    getAirtableRecords(TBL_PARENTS),
    getAirtableRecords("Players"),
  ]);
  const parentById: Record<string, any> = {};
  for (const p of parentRows) parentById[p.id] = p;
  const playerById: Record<string, any> = {};
  for (const p of playerRows) playerById[p.id] = p;

  const activePlayers = playerRows
    .filter((p: any) => p.fields["Active"] === true)
    .map((p: any) => ({ player_record_id: p.id, player_name: p.fields["Player Name"] || "" }))
    .sort((a: any, b: any) => a.player_name.localeCompare(b.player_name));

  const pending = linkRows
    .filter((l: any) => ["Pending", "Needs Review"].includes(linkStatus(l.fields)))
    .map((l: any) => {
      const parent = parentById[(l.fields["Parent / Guardian"] || [])[0]];
      const playerIds: string[] = l.fields["Player"] || [];
      const player = playerIds[0] ? playerById[playerIds[0]] : null;
      return {
        link_id: l.id,
        status: linkStatus(l.fields),
        parent_name: parent ? parent.fields["Parent / Guardian Name"] || "" : "(unknown parent)",
        parent_email: parent ? parent.fields["Email"] || "" : "",
        player_record_id: player ? player.id : "",
        player_name: player ? player.fields["Player Name"] || "" : "",
        relationship: l.fields["Relationship"] || "",
        notes: l.fields["Notes"] || "",
      };
    });

  return { pending, players: activePlayers };
}

async function handleApproveClaim(linkId: string, body: any) {
  const link = await getAirtableRecord(TBL_PARENT_PLAYER_LINKS, linkId);
  if (!link) return jsonResponse({ error: "Claim not found" }, 404);
  if (!["Pending", "Needs Review"].includes(linkStatus(link.fields))) {
    return jsonResponse({ error: `Claim is already ${linkStatus(link.fields)}` }, 400);
  }
  const overridePlayerId = body && body.player_record_id ? String(body.player_record_id) : "";
  const fields: Record<string, unknown> = { [LINK_WRITE_FIELD]: "Verified" };
  if (overridePlayerId) {
    fields["Player"] = [overridePlayerId];
  } else if (!(link.fields["Player"] || []).length) {
    return jsonResponse({ error: "This claim has no player linked yet - pick one before approving." }, 400);
  }
  await updateAirtableRecord(TBL_PARENT_PLAYER_LINKS, linkId, fields);
  return jsonResponse({ ok: true });
}

async function handleRejectClaim(linkId: string, body: any) {
  const link = await getAirtableRecord(TBL_PARENT_PLAYER_LINKS, linkId);
  if (!link) return jsonResponse({ error: "Claim not found" }, 404);
  if (!["Pending", "Needs Review"].includes(linkStatus(link.fields))) {
    return jsonResponse({ error: `Claim is already ${linkStatus(link.fields)}` }, 400);
  }
  const fields: Record<string, unknown> = { [LINK_WRITE_FIELD]: "Rejected" };
  if (body && body.note) {
    fields["Notes"] = ((link.fields["Notes"] || "") + "\n\nRejected: " + String(body.note).slice(0, 500)).trim();
  }
  await updateAirtableRecord(TBL_PARENT_PLAYER_LINKS, linkId, fields);
  return jsonResponse({ ok: true });
}

/**
 * Reuses Player Session Requests exactly as Phase 1 built it - the
 * existing management Session Requests screen picks these up with no
 * changes at all. Server-side enforces the player is actually one of the
 * caller's own Verified children, never an arbitrary player id.
 *
 * Also rejects a request for a session the player already has a Pending
 * request for, and a request for a session the player is already
 * Actively linked to (nothing to request - they're already in) - both
 * checked against the real Player Session Requests / Player Session
 * Links tables, not a separate duplicate-tracking model.
 */
async function handleParentSessionRequest(caller: { userId: string; email: string }, body: any) {
  const parentRecord = await resolveParentRecord(caller.userId, caller.email);
  const playerRecordId = String(body?.player_record_id || "");
  const sessionRecordId = String(body?.session_record_id || "");
  if (!playerRecordId || !sessionRecordId) return jsonResponse({ error: "Player and session are required." }, 400);

  const linkRows = await getAirtableRecords(TBL_PARENT_PLAYER_LINKS);
  if (!verifiedPlayerIds(linkRows, parentRecord.id).has(playerRecordId)) {
    return jsonResponse({ error: "You can only request sessions for your own verified children." }, 403);
  }

  const session = await getAirtableRecord("Sessions", sessionRecordId);
  if (!session || !sessionIsActive(session.fields)) return jsonResponse({ error: "That session is not available." }, 400);

  const [sessionLinks, sessionRequests] = await Promise.all([
    getAirtableRecords("Player Session Links"),
    fetchSessionRequests(),
  ]);
  // Never accept a request nobody can process. An explicit 503 is the
  // honest answer here - silently succeeding would leave a parent
  // believing they had asked for something.
  if (!sessionRequests.available) {
    return jsonResponse({ error: "Session requests are temporarily unavailable. Please contact us and we'll sort it for you." }, 503);
  }
  const existingRequests = sessionRequests.rows;

  const alreadyActive = sessionLinks.some(
    (l: any) =>
      (l.fields["Player"] || []).includes(playerRecordId) &&
      (l.fields["Session"] || []).includes(sessionRecordId) &&
      STILL_ATTENDING.includes(membershipStatus(l.fields))
  );
  if (alreadyActive) return jsonResponse({ error: "This child is already linked to that session." }, 400);

  const alreadyPending = existingRequests.some(
    (r: any) =>
      (r.fields["Player"] || []).includes(playerRecordId) &&
      (r.fields["Requested Session"] || []).includes(sessionRecordId) &&
      r.fields["Status"] === "Pending"
  );
  if (alreadyPending) return jsonResponse({ error: "A request for this session is already pending." }, 400);

  const today = new Date().toISOString().slice(0, 10);
  await createAirtableRecord("Player Session Requests", {
    "Request ID": `REQ-${playerRecordId.slice(-6)}-${Date.now().toString(36).toUpperCase()}`,
    Player: [playerRecordId],
    "Requested Session": [sessionRecordId],
    Status: "Pending",
    "Requested Date": today,
  });
  return jsonResponse({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization");
  const caller = await resolveCaller(authHeader);
  if (!caller) return jsonResponse({ error: "Invalid or expired session" }, 401);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/parent-hub\/?/, "").replace(/\/$/, "");
  const parts = route.split("/").filter(Boolean);

  try {
    // Parent-only routes: verified explicitly here, not just by the
    // frontend hiding buttons for a non-parent role.
    if (route === "me" && req.method === "GET") {
      if (caller.role !== "parent") return jsonResponse({ error: "Parent access required" }, 403);
      return jsonResponse(await handleParentMe(caller));
    }
    if (route === "feedback" && req.method === "GET") {
      if (caller.role !== "parent") return jsonResponse({ error: "Parent access required" }, 403);
      return await handleParentFeedback(caller, url.searchParams.get("player_record_id") || "");
    }
    if (route === "claims" && req.method === "POST") {
      if (caller.role !== "parent") return jsonResponse({ error: "Parent access required" }, 403);
      const body = await req.json().catch(() => ({}));
      return await handleCreateClaim(caller, body);
    }
    if (route === "session-requests" && req.method === "POST") {
      if (caller.role !== "parent") return jsonResponse({ error: "Parent access required" }, 403);
      const body = await req.json().catch(() => ({}));
      return await handleParentSessionRequest(caller, body);
    }

    // Management-only from here.
    if (route === "claims/pending" && req.method === "GET") {
      if (caller.role !== "management") return jsonResponse({ error: "Management access required" }, 403);
      return jsonResponse(await handleListClaims());
    }
    if (parts[0] === "claims" && parts[2] === "approve" && req.method === "POST") {
      if (caller.role !== "management") return jsonResponse({ error: "Management access required" }, 403);
      const body = await req.json().catch(() => ({}));
      return await handleApproveClaim(parts[1], body);
    }
    if (parts[0] === "claims" && parts[2] === "reject" && req.method === "POST") {
      if (caller.role !== "management") return jsonResponse({ error: "Management access required" }, 403);
      const body = await req.json().catch(() => ({}));
      return await handleRejectClaim(parts[1], body);
    }

    return jsonResponse({ error: "Unknown route" }, 404);
  } catch (error) {
    // Deliberately generic. Every authored 4xx above carries its own
    // parent-safe wording; this is the unexpected case, and its real
    // message can name Airtable tables, field names and status codes -
    // internals a parent should never be shown. The detail goes to the
    // function logs instead.
    console.error(error);
    return jsonResponse({ error: "Something went wrong. Please try again." }, 500);
  }
});
