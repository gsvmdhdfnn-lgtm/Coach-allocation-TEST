import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildScheduledCoachNameKeysBySessionId,
  capabilitiesForCoach,
  coachIdentityKeys,
  nameKey,
  resolvePlayerAccess,
  roleCapabilitiesById,
} from "./player-access.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Same "publish to web" CSVs hub-content already reads, needed here for
// the same reason: resolvePlayerAccess() needs to know who's scheduled
// on a session (Sessions) and today's exact cover grants (Changes).
const SESSIONS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQj4giL7oEoZLLfC74Sq97bnUGIdMqnG_ECOkNyRis-Drz4yH1OUssQ-YBRbCR6ajiJBvV05JjzOi8I/pub?gid=349419235&single=true&output=csv";
const CHANGES_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQj4giL7oEoZLLfC74Sq97bnUGIdMqnG_ECOkNyRis-Drz4yH1OUssQ-YBRbCR6ajiJBvV05JjzOi8I/pub?gid=1549675202&single=true&output=csv";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Optional per-request counter, threaded through only from handleCreate/handleUpdate (see their own comments) - every other caller omits it and behaves identically. TEMPORARY: added to diagnose the live "Save Draft" latency/reliability issue; safe to remove once resolved. */
interface Metrics { calls: number }
function bump(metrics?: Metrics) {
  if (metrics) metrics.calls++;
}

async function getAirtableRecords(tableName: string, metrics?: Metrics) {
  const records: any[] = [];
  let offset = "";
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`);
    if (offset) url.searchParams.set("offset", offset);
    bump(metrics);
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Airtable error for ${tableName}: ${response.status} ${message}`);
    }
    const data = await response.json();
    records.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return records;
}

/**
 * DO NOT reintroduce a `SEARCH(id, ARRAYJOIN({LinkField}))` filter here.
 * ARRAYJOIN on a linked-record field joins the linked records' PRIMARY
 * FIELD VALUES (for Feedback Ratings -> Feedback that is the Feedback
 * Title), never their record ids, so such a formula silently matches
 * nothing. It did exactly that here: handleUpdate read back zero
 * existing rating children on every save, so it created a full fresh set
 * each time and deleted none - which is what filled Feedback Ratings
 * with duplicate rows - and handleRecord returned a feedback record with
 * no ratings at all. Rating children are resolved in code against the
 * forward "Feedback" link instead, which does hold real record ids
 * (see ratingsForFeedbackId()).
 */

async function getAirtableRecord(tableName: string, id: string, metrics?: Metrics) {
  bump(metrics);
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${id}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function createAirtableRecord(tableName: string, fields: Record<string, unknown>, metrics?: Metrics) {
  bump(metrics);
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`, {
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

async function updateAirtableRecord(tableName: string, id: string, fields: Record<string, unknown>, metrics?: Metrics) {
  bump(metrics);
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

/** Chunks of up to 10 - Airtable's own limit per create/update/delete call. Returns [] with zero Airtable calls when `records` is empty - callers should never skip calling this "to save a call" themselves; it already does. */
async function airtableBatch(tableName: string, method: "POST" | "PATCH", records: { id?: string; fields: Record<string, unknown> }[], metrics?: Metrics) {
  const out: any[] = [];
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    if (!chunk.length) continue;
    bump(metrics);
    const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`, {
      method,
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      const message = await res.text();
      throw new Error(`Airtable ${method} ${tableName} error: ${res.status} ${message}`);
    }
    const data = await res.json();
    out.push(...(data.records || []));
  }
  return out;
}

async function airtableDelete(tableName: string, ids: string[], metrics?: Metrics) {
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    if (!chunk.length) continue;
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`);
    chunk.forEach((id) => url.searchParams.append("records[]", id));
    bump(metrics);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    if (!res.ok) {
      const message = await res.text();
      throw new Error(`Airtable delete ${tableName} error: ${res.status} ${message}`);
    }
  }
}

function mondayOf(d: Date): Date {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date;
}
function parseDateOnly(s: string): Date | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const DAY_OFFSET: Record<string, number> = {
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
};
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
 * Airtable's REST API returns a singleSelect field's value as the plain
 * option-name string (e.g. "Characteristics") - never an {id,name,color}
 * object; that shape only appears in some Airtable UI/automation
 * contexts, not here. Handles both defensively so a future field-type
 * change degrades gracefully instead of silently losing every row's
 * Group/Feedback Mode again.
 */
function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

/** Same identity-set-aware, exact-date cover resolution as hub-content's copy. */
async function resolveCoverSessionIds(
  coachNameKeys: Set<string>,
  sessionRecordBySessionId: Record<string, string>,
  today: Date
): Promise<Set<string>> {
  const result = new Set<string>();
  if (!coachNameKeys.size) return result;
  const rows = await fetchCsvObjects(CHANGES_CSV_URL);
  const todayIso = isoDateUTC(today);
  for (const r of rows) {
    if (nameKey(r.type) !== "cover") continue;
    if (!coachNameKeys.has(nameKey(r.coach_in))) continue;
    const wc = parseDateOnly(r.week_commencing);
    if (!wc) continue;
    const dayOffset = DAY_OFFSET[nameKey(r.day)];
    if (dayOffset == null) continue;
    const coveredDate = mondayOf(wc);
    coveredDate.setUTCDate(coveredDate.getUTCDate() + dayOffset);
    if (isoDateUTC(coveredDate) !== todayIso) continue;
    const sessionRecordId = sessionRecordBySessionId[r.session_id];
    if (sessionRecordId) result.add(sessionRecordId);
  }
  return result;
}

interface Caller { role: string; airtablePersonId: string | null; active: boolean; userId: string; email: string; displayName: string | null }

async function resolveCaller(authHeader: string | null): Promise<Caller | null> {
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
    email: userData.user.email || "",
    displayName: profile.display_name || null,
  };
}

/**
 * Resolves exactly what this caller can currently do for this specific
 * player+session pair - never a global "can this coach see this player"
 * check. Access via one session must never leak rights to another, so
 * every read/write route below re-derives this fresh from Airtable and
 * the live Sessions Google Sheet rather than trusting anything the
 * client claims about its own schedule, role or tier.
 *
 * Still reads Players/Coaches/Sessions/Player Session Links/Coach Roles
 * in full (unchanged from before) - this is the shared, LOCKED
 * access-resolution architecture also duplicated into hub-content and
 * player-sessions; narrowing ITS reads is out of scope for this pass
 * (see the handleUpdate()/handleCreate() comments for what was actually
 * optimised). Its own 5-6 Airtable calls already run concurrently via
 * Promise.all, so its wall-clock cost is bounded by the slowest single
 * call, not their sum - the optimisation below is about not making the
 * REST of the request wait for this stage to finish before starting.
 */
async function resolveAccessForPair(caller: Caller, playerRecordId: string, sessionRecordId: string, metrics?: Metrics) {
  const [playerRows, coachRows, sessionRows, linkRows, coachRoleRows, sessionsCsvRows] = await Promise.all([
    getAirtableRecords("Players", metrics),
    getAirtableRecords("Coaches", metrics),
    getAirtableRecords("Sessions", metrics),
    getAirtableRecords("Player Session Links", metrics),
    getAirtableRecords("Coach Roles", metrics),
    fetchCsvObjects(SESSIONS_CSV_URL),
  ]);
  const coachRecordById: Record<string, any> = {};
  for (const c of coachRows) coachRecordById[c.id] = c;
  const sessionRecordBySessionId: Record<string, string> = {};
  for (const s of sessionRows) {
    const sid = s.fields["Session ID"];
    if (sid) sessionRecordBySessionId[sid] = s.id;
  }

  const roleCapsById = roleCapabilitiesById(coachRoleRows);
  const callerCoachRecord = caller.airtablePersonId ? coachRecordById[caller.airtablePersonId] : null;
  const coachNameKeys = coachIdentityKeys(callerCoachRecord, caller.displayName);
  const coachCapabilities = capabilitiesForCoach(callerCoachRecord, roleCapsById);
  const scheduledCoachNameKeysBySessionId = buildScheduledCoachNameKeysBySessionId(sessionsCsvRows);

  const today = new Date();
  const coverSessionIds =
    caller.role === "management" ? new Set<string>() : await resolveCoverSessionIds(coachNameKeys, sessionRecordBySessionId, today);

  const rows = resolvePlayerAccess({
    role: caller.role,
    coachRecordId: caller.airtablePersonId,
    coachNameKeys,
    coachCapabilities,
    players: playerRows,
    sessions: sessionRows,
    links: linkRows,
    scheduledCoachNameKeysBySessionId,
    coverSessionIds,
    today,
  });

  const row = rows.find((r) => r.player_record_id === playerRecordId && r.session_record_id === sessionRecordId);
  return { row: row || null, coachName: callerCoachRecord ? callerCoachRecord.fields["Coach Name"] || "" : "" };
}

type FeedbackMode = "ratings_written" | "written_only" | "ratings_only";

function normalizeMode(name: string): FeedbackMode {
  const n = nameKey(name);
  if (n.indexOf("written only") >= 0) return "written_only";
  if (n.indexOf("ratings only") >= 0) return "ratings_only";
  return "ratings_written";
}

interface FrameworkItem {
  id: string;
  name: string;
  group: string;
  sortOrder: number;
  ratingEnabled: boolean;
  writtenEnabled: boolean;
  description: string;
  writtenPrompt: string;
}

async function loadFrameworkAndSettings(metrics?: Metrics) {
  const [frameworkRows, settingsRows] = await Promise.all([
    getAirtableRecords("Development Framework", metrics),
    getAirtableRecords("Development Framework Settings", metrics),
  ]);

  const settingsRecord = settingsRows.find((r: any) => r.fields["Active"] === true) || settingsRows[0] || null;
  const sf = settingsRecord ? settingsRecord.fields : {};
  const settings = {
    framework_name: sf["Framework Name"] || "",
    framework_key: sf["Framework Key"] || "",
    intro_text: sf["Intro Text"] || "",
    blue_label: sf["Blue Label"] || "Blue",
    green_label: sf["Green Label"] || "Green",
    amber_label: sf["Amber Label"] || "Amber",
    red_label: sf["Red Label"] || "Red",
    feedback_mode: normalizeMode(selectName(sf["Feedback Mode"])),
    show_keep_doing: sf["Show Keep Doing"] === true,
    show_my_focus: sf["Show My Focus"] === true,
    show_general_feedback: sf["Show General Coach Feedback"] === true,
    per_area_written_feedback: sf["Per-Area Written Feedback"] === true,
  };

  const items: FrameworkItem[] = frameworkRows
    .filter((r: any) => r.fields["Active"] === true && r.fields["Visible to Coach"] === true && r.fields["Name"])
    .map((r: any) => ({
      id: r.id,
      name: r.fields["Name"] || "",
      group: selectName(r.fields["Group"]),
      sortOrder: typeof r.fields["Sort Order"] === "number" ? r.fields["Sort Order"] : 9999,
      ratingEnabled: r.fields["Rating Enabled"] === true,
      writtenEnabled: r.fields["Written Feedback Enabled"] === true,
      description: r.fields["Description"] || "",
      writtenPrompt: r.fields["Written Prompt"] || "",
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return { settings, items };
}

function groupedItems(items: FrameworkItem[]) {
  const order: string[] = [];
  const byGroup: Record<string, FrameworkItem[]> = {};
  for (const item of items) {
    const key = item.group || "Other";
    if (!byGroup[key]) { byGroup[key] = []; order.push(key); }
    byGroup[key].push(item);
  }
  return order.map((key) => ({ key, label: key, items: byGroup[key] }));
}

async function handleFramework() {
  const { settings, items } = await loadFrameworkAndSettings();
  return {
    settings,
    groups: groupedItems(items).map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.map((i) => ({
        framework_item_id: i.id,
        name: i.name,
        description: i.description,
        written_prompt: i.writtenPrompt,
        rating_enabled: i.ratingEnabled,
        written_enabled: i.writtenEnabled,
      })),
    })),
  };
}

/** First linked record id, or "". */
function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

async function buildFeedbackPayload(record: any, ratingsById: Record<string, any>) {
  const f = record.fields;
  const ratingIds: string[] = f["Feedback Ratings"] || [];
  const ratings = ratingIds
    .map((id) => ratingsById[id])
    .filter(Boolean)
    .map((r: any) => ({
      framework_item_id: firstLink(r.fields, "Framework Item"),
      rating: r.fields["Rating"] || "",
      label_snapshot: r.fields["Label Snapshot"] || "",
      group_snapshot: r.fields["Group Snapshot"] || "",
      sort_order: typeof r.fields["Sort Order"] === "number" ? r.fields["Sort Order"] : 9999,
      notes: r.fields["Notes"] || "",
    }))
    .sort((a, b) => a.sort_order - b.sort_order);

  return {
    feedback_id: record.id,
    title: f["Feedback Title"] || "",
    date: f["Feedback Date"] || "",
    coach_name: f["Coach Name"] || "",
    published: f["Published"] === true,
    summary: f["Summary"] || "",
    keep_doing: f["Keep Doing"] || "",
    big_focus: f["Big Focus"] || "",
    player_record_id: firstLink(f, "Player"),
    session_record_id: firstLink(f, "Session"),
    ratings,
  };
}

/**
 * Feedback Ratings rows belonging to one Feedback record, resolved via
 * each rating's OWN "Feedback" link field - never via the Feedback
 * record's reciprocal "Feedback Ratings" field. Airtable back-populates
 * that reciprocal field asynchronously, so reading it immediately after
 * writing the forward link is not reliably fresh. The forward "Feedback"
 * field on each Feedback Ratings row, by contrast, was itself the thing
 * directly written, so it's always current the moment that write's
 * response comes back. `ratingRows` is the whole Feedback Ratings
 * table; callers narrow it to one feedback record through this helper.
 */
function ratingsForFeedbackId(feedbackId: string, ratingRows: any[]): any[] {
  return ratingRows.filter((r: any) => (r.fields["Feedback"] || []).includes(feedbackId));
}

/** Shallow-copies `record` with its own "Feedback Ratings" field overridden - lets buildFeedbackPayload() enumerate a ratings list resolved via ratingsForFeedbackId() instead of the record's own (possibly stale) reciprocal field. */
function withRatingIds(record: any, ratingIds: string[]): any {
  return { id: record.id, fields: { ...record.fields, "Feedback Ratings": ratingIds } };
}

/**
 * Feedback history for one authorised player+session pair. A legacy
 * Feedback record with no Session link at all (predates this feature) is
 * still included for that player - it just can't be tied to a specific
 * session, so it's treated as visible under any session the coach can
 * currently see this player through, same as before this feature existed.
 */
async function handleHistory(caller: Caller, playerRecordId: string, sessionRecordId: string) {
  const { row } = await resolveAccessForPair(caller, playerRecordId, sessionRecordId);
  if (!row) return { error: jsonResponse({ error: "No access to this player for this session" }, 403) };

  const [feedbackRows, ratingRows] = await Promise.all([
    getAirtableRecords("Feedback"),
    getAirtableRecords("Feedback Ratings"),
  ]);

  const matches = feedbackRows.filter((r: any) => {
    if (r.fields["Active"] !== true) return false;
    const playerIds: string[] = r.fields["Player"] || [];
    if (!playerIds.includes(playerRecordId)) return false;
    const sessionIds: string[] = r.fields["Session"] || [];
    if (!sessionIds.length) return true;
    return sessionIds.includes(sessionRecordId);
  });

  const list = await Promise.all(matches.map((r: any) => {
    const ratings = ratingsForFeedbackId(r.id, ratingRows);
    const ratingsById: Record<string, any> = {};
    for (const rt of ratings) ratingsById[rt.id] = rt;
    return buildFeedbackPayload(withRatingIds(r, ratings.map((rt) => rt.id)), ratingsById);
  }));
  list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { list };
}

/**
 * The signed-in coach's own active, unpublished drafts.
 * A draft is only returned while the coach still has current write access
 * to that exact player/session pair. This keeps Drafts convenient without
 * weakening the existing access model.
 */
async function handleDrafts(caller: Caller) {
  const feedbackRows = await getAirtableRecords("Feedback");
  const ownDrafts = feedbackRows.filter((r: any) =>
    r.fields["Active"] === true &&
    r.fields["Published"] !== true &&
    String(r.fields["Coach User ID"] || "") === caller.userId
  );

  const checked = await Promise.all(ownDrafts.map(async (r: any) => {
    const playerRecordId = firstLink(r.fields, "Player");
    const sessionRecordId = firstLink(r.fields, "Session");
    if (!playerRecordId || !sessionRecordId) return null;

    const { row } = await resolveAccessForPair(caller, playerRecordId, sessionRecordId);
    if (!row || !row.can_edit_feedback) return null;

    return {
      feedback_id: r.id,
      title: r.fields["Feedback Title"] || "Feedback draft",
      date: r.fields["Feedback Date"] || "",
      player_record_id: playerRecordId,
      session_record_id: sessionRecordId,
      player_name: row.name || "Player",
      session_name: row.session_name || "Session",
    };
  }));

  const drafts = checked.filter(Boolean);
  drafts.sort((a: any, b: any) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { drafts };
}

async function handleRecord(caller: Caller, feedbackId: string) {
  const record = await getAirtableRecord("Feedback", feedbackId);
  if (!record || record.fields["Active"] !== true) return { error: jsonResponse({ error: "Feedback not found" }, 404) };
  const playerRecordId = firstLink(record.fields, "Player");
  const sessionRecordId = firstLink(record.fields, "Session");
  if (!playerRecordId) return { error: jsonResponse({ error: "Feedback not found" }, 404) };

  if (sessionRecordId) {
    const { row } = await resolveAccessForPair(caller, playerRecordId, sessionRecordId);
    if (!row) return { error: jsonResponse({ error: "No access to this player for this session" }, 403) };
  } else if (caller.role !== "management") {
    // Legacy record with no Session link - fall back to "can this coach
    // see this player at all, in any session" rather than a specific pair.
    const [playerRows, coachRows, sessionRows, linkRows, coachRoleRows, sessionsCsvRows] = await Promise.all([
      getAirtableRecords("Players"),
      getAirtableRecords("Coaches"),
      getAirtableRecords("Sessions"),
      getAirtableRecords("Player Session Links"),
      getAirtableRecords("Coach Roles"),
      fetchCsvObjects(SESSIONS_CSV_URL),
    ]);
    const coachRecordById: Record<string, any> = {};
    for (const c of coachRows) coachRecordById[c.id] = c;
    const sessionRecordBySessionId: Record<string, string> = {};
    for (const s of sessionRows) { const sid = s.fields["Session ID"]; if (sid) sessionRecordBySessionId[sid] = s.id; }
    const roleCapsById = roleCapabilitiesById(coachRoleRows);
    const callerCoachRecord = caller.airtablePersonId ? coachRecordById[caller.airtablePersonId] : null;
    const coachNameKeys = coachIdentityKeys(callerCoachRecord, caller.displayName);
    const coachCapabilities = capabilitiesForCoach(callerCoachRecord, roleCapsById);
    const scheduledCoachNameKeysBySessionId = buildScheduledCoachNameKeysBySessionId(sessionsCsvRows);
    const coverSessionIds = await resolveCoverSessionIds(coachNameKeys, sessionRecordBySessionId, new Date());
    const rows = resolvePlayerAccess({
      role: caller.role, coachRecordId: caller.airtablePersonId, coachNameKeys, coachCapabilities,
      players: playerRows, sessions: sessionRows, links: linkRows,
      scheduledCoachNameKeysBySessionId, coverSessionIds, today: new Date(),
    });
    if (!rows.some((r) => r.player_record_id === playerRecordId)) {
      return { error: jsonResponse({ error: "No access to this player" }, 403) };
    }
  }

  // Resolved via each rating's own "Feedback" link, not this record's
  // reciprocal field - see ratingsForFeedbackId()'s comment - and read
  // in full rather than through a linked-field formula, which cannot
  // match on record id (see the note where that helper used to live).
  const ratings = ratingsForFeedbackId(feedbackId, await getAirtableRecords("Feedback Ratings"));
  const ratingsById: Record<string, any> = {};
  for (const r of ratings) ratingsById[r.id] = r;
  return { payload: await buildFeedbackPayload(withRatingIds(record, ratings.map((r) => r.id)), ratingsById) };
}

interface WritePayload {
  player_record_id?: string;
  session_record_id?: string;
  ratings?: { framework_item_id: string; rating: string; note?: string }[];
  keep_doing?: string;
  big_focus?: string;
  summary?: string;
  published?: boolean;
}

const VALID_RATINGS = new Set(["Blue", "Green", "Amber", "Red"]);

/**
 * Filters a submitted write payload down to exactly what the LIVE
 * framework/settings currently allow - client-submitted config/IDs are
 * never trusted. Ratings for an inactive/hidden item, an item with
 * Rating Enabled off, or any rating at all when the mode is Written
 * Feedback Only are all silently dropped, never stored. Written fields
 * are dropped the same way when their own Show toggle is off or the mode
 * is Ratings Only. Per-area notes only survive when Per-Area Written
 * Feedback is on AND the specific item has Written Feedback Enabled AND
 * the mode isn't Ratings Only.
 */
function filterWritePayload(body: WritePayload, settings: any, items: FrameworkItem[]) {
  const itemsById: Record<string, FrameworkItem> = {};
  for (const i of items) itemsById[i.id] = i;
  const mode: FeedbackMode = settings.feedback_mode;

  const ratings: { item: FrameworkItem; rating: string; note: string }[] = [];
  if (mode !== "written_only" && Array.isArray(body.ratings)) {
    for (const entry of body.ratings) {
      const item = entry && itemsById[entry.framework_item_id];
      if (!item || !item.ratingEnabled) continue;
      const rating = String(entry.rating || "");
      if (!VALID_RATINGS.has(rating)) continue;
      let note = "";
      if (mode !== "ratings_only" && settings.per_area_written_feedback && item.writtenEnabled) {
        note = String(entry.note || "").slice(0, 2000);
      }
      ratings.push({ item, rating, note });
    }
  }

  // Written-only mode still allows per-area notes even though there are
  // no ratings to attach them to - filterWritePayload's ratings loop
  // above is skipped entirely when mode === "written_only", so per-area
  // notes for that mode are collected here instead, keyed the same way
  // (one Feedback Ratings child per item, rating left blank).
  if (mode === "written_only" && settings.per_area_written_feedback && Array.isArray(body.ratings)) {
    for (const entry of body.ratings) {
      const item = entry && itemsById[entry.framework_item_id];
      if (!item || !item.writtenEnabled) continue;
      const note = String((entry && entry.note) || "").slice(0, 2000);
      if (!note) continue;
      ratings.push({ item, rating: "", note });
    }
  }

  // One entry per framework item, whatever the client sent - a payload
  // that repeated an item would otherwise become two rating rows for it.
  const ratingsByItem = new Map<string, { item: FrameworkItem; rating: string; note: string }>();
  for (const r of ratings) ratingsByItem.set(r.item.id, r);

  const writtenAllowed = mode !== "ratings_only";
  return {
    ratings: [...ratingsByItem.values()],
    keep_doing: writtenAllowed && settings.show_keep_doing ? String(body.keep_doing || "").slice(0, 4000) : "",
    big_focus: writtenAllowed && settings.show_my_focus ? String(body.big_focus || "").slice(0, 4000) : "",
    summary: writtenAllowed && settings.show_general_feedback ? String(body.summary || "").slice(0, 8000) : "",
  };
}

async function resolveCoachRecordName(caller: Caller, metrics?: Metrics): Promise<{ id: string[]; name: string }> {
  if (!caller.airtablePersonId) return { id: [], name: caller.email || "Coach" };
  const record = await getAirtableRecord("Coaches", caller.airtablePersonId, metrics);
  return { id: [caller.airtablePersonId], name: (record && record.fields["Coach Name"]) || caller.email || "Coach" };
}

/** Common Feedback Ratings fields shared by both a fresh create and an update PATCH - explicit `Rating`/`Notes` (never conditionally omitted) so an update that clears a value to "" actually clears it in Airtable, rather than a PATCH leaving the old value untouched (Airtable PATCH is a partial update: an omitted key is left alone, not cleared). */
function ratingFields(feedbackId: string, r: { item: FrameworkItem; rating: string; note: string }) {
  return {
    Feedback: [feedbackId],
    "Framework Item": [r.item.id],
    Rating: r.rating || null,
    "Label Snapshot": r.item.name,
    "Group Snapshot": r.item.group,
    "Sort Order": r.item.sortOrder,
    Notes: r.note || "",
  };
}

async function handleCreate(caller: Caller, body: WritePayload) {
  const t0 = Date.now();
  const metrics: Metrics = { calls: 0 };
  const timings: Record<string, number> = {};

  const playerRecordId = String(body.player_record_id || "");
  const sessionRecordId = String(body.session_record_id || "");
  if (!playerRecordId || !sessionRecordId) return jsonResponse({ error: "player_record_id and session_record_id are required" }, 400);

  // Access check, framework/settings, and the caller's own Coach record
  // name are all independent of each other - fetched concurrently rather
  // than as three sequential stages.
  const tReads = Date.now();
  const [{ row }, { settings, items }, coach] = await Promise.all([
    resolveAccessForPair(caller, playerRecordId, sessionRecordId, metrics),
    loadFrameworkAndSettings(metrics),
    resolveCoachRecordName(caller, metrics),
  ]);
  timings.reads_ms = Date.now() - tReads;

  if (!row) return jsonResponse({ error: "No access to this player for this session" }, 403);
  if (!row.can_edit_feedback) return jsonResponse({ error: "Your access to this player does not allow writing feedback" }, 403);

  const filtered = filterWritePayload(body, settings, items);
  const today = new Date().toISOString().slice(0, 10);
  const stamp = crypto.randomUUID().split("-")[0].toUpperCase();

  const tCreate = Date.now();
  const created = await createAirtableRecord("Feedback", {
    "Feedback Title": `${row.name} — ${today}`,
    "Feedback ID": `FDB-${stamp}`,
    "Feedback Date": today,
    "Coach Name": coach.name,
    "Coach User ID": caller.userId,
    Summary: filtered.summary,
    "Keep Doing": filtered.keep_doing,
    "Big Focus": filtered.big_focus,
    Published: body.published === true,
    Active: true,
    Player: [playerRecordId],
    Coach: coach.id,
    Session: [sessionRecordId],
  }, metrics);
  timings.create_feedback_ms = Date.now() - tCreate;

  const tRatings = Date.now();
  const createdRatings = filtered.ratings.length
    ? await airtableBatch(
        "Feedback Ratings",
        "POST",
        filtered.ratings.map((r) => ({
          fields: { "Rating ID": `RTG-${crypto.randomUUID().split("-")[0].toUpperCase()}`, ...ratingFields(created.id, r) },
        })),
        metrics
      )
    : [];
  timings.create_ratings_ms = Date.now() - tRatings;
  timings.total_ms = Date.now() - t0;

  console.log(JSON.stringify({ instrumentation: "handleCreate", feedback_id: created.id, timings, airtable_calls: metrics.calls, ratings_created: createdRatings.length }));

  // Built entirely from what we already know locally - created (Airtable's
  // own create response, immediately authoritative for the record it just
  // made) and createdRatings (same, for its children) - rather than
  // re-reading the Feedback parent to discover its rating children via
  // the reciprocal link. See ratingsForFeedbackId()'s comment for why
  // that reread is unsafe.
  const ratingsById: Record<string, any> = {};
  for (const r of createdRatings) ratingsById[r.id] = r;
  const record = withRatingIds(created, createdRatings.map((r) => r.id));
  return jsonResponse(await buildFeedbackPayload(record, ratingsById), 201);
}

async function handleUpdate(caller: Caller, feedbackId: string, body: WritePayload) {
  const t0 = Date.now();
  const metrics: Metrics = { calls: 0 };
  const timings: Record<string, number> = {};

  const tExisting = Date.now();
  const existing = await getAirtableRecord("Feedback", feedbackId, metrics);
  timings.get_existing_ms = Date.now() - tExisting;
  if (!existing || existing.fields["Active"] !== true) return jsonResponse({ error: "Feedback not found" }, 404);

  const playerRecordId = firstLink(existing.fields, "Player");
  if (!playerRecordId) return jsonResponse({ error: "Feedback not found" }, 404);
  // The record's own Session link wins when present; a legacy record with
  // none can only be upgraded onto a session the caller can actually
  // prove access to right now (never trusted blindly from the client).
  const sessionRecordId = firstLink(existing.fields, "Session") || String(body.session_record_id || "");
  if (!sessionRecordId) return jsonResponse({ error: "session_record_id is required for a legacy record" }, 400);

  // Access check, framework/settings, and this record's own current
  // rating children are all independent of each other once we know
  // player/session ids - fetched concurrently instead of three
  // sequential stages (the original cause of the live latency: every
  // one of these used to `await` in turn before the next could even
  // start). The rating children are read in full and matched in code on
  // their own forward "Feedback" link - a linked-field formula cannot
  // match on record id, and silently returning nothing here is precisely
  // what made every save recreate the whole set.
  const tReads = Date.now();
  const [{ row }, { settings, items }, allRatingRows] = await Promise.all([
    resolveAccessForPair(caller, playerRecordId, sessionRecordId, metrics),
    loadFrameworkAndSettings(metrics),
    getAirtableRecords("Feedback Ratings", metrics),
  ]);
  const oldRatings = ratingsForFeedbackId(feedbackId, allRatingRows);
  timings.reads_ms = Date.now() - tReads;

  if (!row) return jsonResponse({ error: "No access to this player for this session" }, 403);
  if (!row.can_edit_feedback) return jsonResponse({ error: "Your access to this player does not allow writing feedback" }, 403);

  const filtered = filterWritePayload(body, settings, items);

  // Differential upsert: match existing rating children to the submitted
  // payload by Framework Item (never by array position/count) - only
  // PATCH a row whose rating or note actually changed, only CREATE a row
  // for an item that has none yet, only DELETE a row for an item no
  // longer present in the submission. An item resubmitted with the exact
  // same rating/note is left completely untouched: no Airtable call at
  // all for it. Replaces the old "delete every existing rating, then
  // recreate everything from scratch on every single save" behaviour,
  // which churned every row every time regardless of whether anything
  // about it had changed.
  //
  // Duplicate collapse: a framework item may already have SEVERAL rows
  // (the formula bug above created a fresh set on every save). One of
  // them is the current value - the most recently created - and the rest
  // are superseded copies of the same item on the same feedback record.
  // The newest is kept and updated; the surplus is deleted, so the
  // record converges on exactly one row per item. Nothing ambiguous is
  // discarded: every row removed here is another row for the SAME
  // (Feedback, Framework Item) pair whose current value is preserved in
  // the keeper.
  const oldRowsByItem = new Map<string, any[]>();
  for (const r of oldRatings) {
    const itemId = firstLink(r.fields, "Framework Item");
    if (!itemId) continue;
    if (!oldRowsByItem.has(itemId)) oldRowsByItem.set(itemId, []);
    oldRowsByItem.get(itemId)!.push(r);
  }
  const oldByItem = new Map<string, any>();
  const supersededRows: any[] = [];
  for (const [itemId, rows] of oldRowsByItem) {
    const sorted = rows.slice().sort((a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || "")));
    const keeper = sorted[sorted.length - 1];
    oldByItem.set(itemId, keeper);
    for (const r of sorted) if (r.id !== keeper.id) supersededRows.push(r);
  }
  const submittedItemIds = new Set(filtered.ratings.map((r) => r.item.id));

  const toCreate = filtered.ratings.filter((r) => !oldByItem.has(r.item.id));
  const toUpdate = filtered.ratings.filter((r) => {
    const existingRow = oldByItem.get(r.item.id);
    if (!existingRow) return false;
    return (existingRow.fields["Rating"] || "") !== r.rating || (existingRow.fields["Notes"] || "") !== r.note;
  });
  // Rows for an item no longer submitted at all, plus every superseded
  // duplicate. A row with no Framework Item link is orphaned and can
  // never be matched or shown, so it goes too.
  const supersededIds = new Set(supersededRows.map((r) => r.id));
  const toDelete = oldRatings.filter((r) => {
    if (supersededIds.has(r.id)) return true;
    const itemId = firstLink(r.fields, "Framework Item");
    return !itemId || !submittedItemIds.has(itemId);
  });
  const deletedIds = new Set(toDelete.map((r) => r.id));
  const unchangedIds = new Set(oldRatings.map((r) => r.id));
  for (const r of toUpdate) unchangedIds.delete(oldByItem.get(r.item.id).id);
  for (const id of deletedIds) unchangedIds.delete(id);
  const unchangedRows = oldRatings.filter((r) => unchangedIds.has(r.id));

  const updateFields: Record<string, unknown> = {
    Summary: filtered.summary,
    "Keep Doing": filtered.keep_doing,
    "Big Focus": filtered.big_focus,
    Published: body.published === true,
  };
  if (!firstLink(existing.fields, "Session")) updateFields["Session"] = [sessionRecordId];

  // The Feedback parent's own field update and each of the three rating
  // operations are independent writes (disjoint record ids) - run
  // concurrently rather than as four sequential `await`s. A batch call
  // for an empty set (nothing to update/create/delete) makes zero
  // Airtable requests, not an empty no-op call.
  const tWrite = Date.now();
  const [, updatedRows, createdRows] = await Promise.all([
    updateAirtableRecord("Feedback", feedbackId, updateFields, metrics),
    toUpdate.length
      ? airtableBatch("Feedback Ratings", "PATCH", toUpdate.map((r) => ({ id: oldByItem.get(r.item.id).id, fields: ratingFields(feedbackId, r) })), metrics)
      : Promise.resolve([] as any[]),
    toCreate.length
      ? airtableBatch("Feedback Ratings", "POST", toCreate.map((r) => ({ fields: { "Rating ID": `RTG-${crypto.randomUUID().split("-")[0].toUpperCase()}`, ...ratingFields(feedbackId, r) } })), metrics)
      : Promise.resolve([] as any[]),
    toDelete.length ? airtableDelete("Feedback Ratings", toDelete.map((r) => r.id), metrics) : Promise.resolve(undefined),
  ]);
  timings.write_ms = Date.now() - tWrite;
  timings.total_ms = Date.now() - t0;

  console.log(JSON.stringify({
    instrumentation: "handleUpdate",
    feedback_id: feedbackId,
    timings,
    airtable_calls: metrics.calls,
    rating_diff: { unchanged: unchangedRows.length, updated: toUpdate.length, created: toCreate.length, deleted: toDelete.length, duplicates_collapsed: supersededRows.length },
  }));

  // Built from what we already know locally (existing's unchanged
  // fields + updateFields we just wrote + unchangedRows/updatedRows/
  // createdRows) rather than re-reading the Feedback parent's reciprocal
  // link field - see ratingsForFeedbackId()'s comment.
  const ratingsById: Record<string, any> = {};
  for (const r of unchangedRows) ratingsById[r.id] = r;
  for (const r of updatedRows) ratingsById[r.id] = r;
  for (const r of createdRows) ratingsById[r.id] = r;
  const finalRatingIds = [...unchangedRows.map((r) => r.id), ...updatedRows.map((r) => r.id), ...createdRows.map((r) => r.id)];

  const record = withRatingIds({ id: feedbackId, fields: { ...existing.fields, ...updateFields } }, finalRatingIds);
  return jsonResponse(await buildFeedbackPayload(record, ratingsById));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!caller.active || (caller.role !== "coach" && caller.role !== "management")) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/player-feedback\/?/, "").replace(/\/$/, "");
  const parts = route.split("/").filter(Boolean);

  try {
    if (route === "framework" && req.method === "GET") return jsonResponse(await handleFramework());

    if (route === "drafts" && req.method === "GET") {
      return jsonResponse(await handleDrafts(caller));
    }

    if (route === "history" && req.method === "GET") {
      const playerRecordId = url.searchParams.get("player_record_id") || "";
      const sessionRecordId = url.searchParams.get("session_record_id") || "";
      if (!playerRecordId || !sessionRecordId) return jsonResponse({ error: "player_record_id and session_record_id are required" }, 400);
      const result = await handleHistory(caller, playerRecordId, sessionRecordId);
      if ("error" in result) return result.error;
      return jsonResponse({ feedback: result.list });
    }

    if (parts[0] === "record" && parts[1] && req.method === "GET") {
      const result = await handleRecord(caller, parts[1]);
      if ("error" in result) return result.error;
      return jsonResponse(result.payload);
    }

    if (route === "record" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as WritePayload;
      return await handleCreate(caller, body);
    }

    if (parts[0] === "record" && parts[1] && req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as WritePayload;
      return await handleUpdate(caller, parts[1], body);
    }

    return jsonResponse({ error: `Unknown route: ${route}` }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
