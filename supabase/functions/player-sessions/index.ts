import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildScheduledCoachNameKeysBySessionId,
  eligibleCoachIdsForSessionSnapshot,
  roleCapabilitiesById,
} from "./player-access.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Not `!` on purpose: a missing secret degrades handleEndLink's display-
// name matching (see below) rather than breaking every route in this
// function, most of which have nothing to do with it.
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Same public "publish to web" Sessions CSV config.js already points the
// client at - kept in sync by hand if that URL is ever republished.
const SESSIONS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQj4giL7oEoZLLfC74Sq97bnUGIdMqnG_ECOkNyRis-Drz4yH1OUssQ-YBRbCR6ajiJBvV05JjzOi8I/pub?gid=349419235&single=true&output=csv";

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

async function requireManagement(authHeader: string) {
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return { error: jsonResponse({ error: "Invalid or expired session" }, 401) };
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, airtable_person_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return { error: jsonResponse({ error: "Profile not found" }, 404) };
  if (profile.role !== "management") return { error: jsonResponse({ error: "Management access required" }, 403) };
  return { coachRecordId: profile.airtable_person_id || null };
}

async function getAirtableRecords(tableName: string) {
  const records: any[] = [];
  let offset = "";
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`);
    if (offset) url.searchParams.set("offset", offset);
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

async function getAirtableRecord(tableName: string, id: string) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${id}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
  });
  if (!res.ok) return null;
  return res.json();
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

async function createAirtableRecord(tableName: string, fields: Record<string, unknown>) {
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
 * Upserts Sessions from the published Sessions sheet: creates any new
 * session_id, refreshes the name and re-activates one that reappears, and
 * archives (Active=false) any Airtable Session no longer in the sheet -
 * never deletes, so existing Player Session Links/history stay intact.
 * Permanent Coaches is never touched here; that stays a manual link.
 * Also called automatically (throttled) from hub-content on ordinary
 * traffic - this manual route is for an immediate on-demand refresh.
 */
async function syncSessions() {
  const res = await fetch(SESSIONS_CSV_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not fetch the Sessions sheet: ${res.status}`);
  const csvRows = csvObjects(await res.text());

  const existing = await getAirtableRecords("Sessions");
  const existingBySessionId: Record<string, any> = {};
  for (const r of existing) {
    const sid = r.fields["Session ID"];
    if (sid) existingBySessionId[sid] = r;
  }

  const seen = new Set<string>();
  const toCreate: { fields: Record<string, unknown> }[] = [];
  const toUpdate: { id: string; fields: Record<string, unknown> }[] = [];

  for (const row of csvRows) {
    const sessionId = row.session_id;
    if (!sessionId) continue;
    seen.add(sessionId);
    const sessionName = row.session_name || "";
    const record = existingBySessionId[sessionId];
    if (!record) {
      toCreate.push({ fields: { "Session ID": sessionId, "Session Name": sessionName, Active: true } });
    } else if (record.fields["Session Name"] !== sessionName || record.fields["Active"] !== true) {
      toUpdate.push({ id: record.id, fields: { "Session Name": sessionName, Active: true } });
    }
  }

  const toArchive: { id: string; fields: Record<string, unknown> }[] = [];
  for (const sid of Object.keys(existingBySessionId)) {
    if (seen.has(sid)) continue;
    const record = existingBySessionId[sid];
    if (record.fields["Active"] === true) {
      toArchive.push({ id: record.id, fields: { Active: false } });
    }
  }

  await airtableBatch("Sessions", "POST", toCreate);
  await airtableBatch("Sessions", "PATCH", toUpdate);
  await airtableBatch("Sessions", "PATCH", toArchive);

  return { created: toCreate.length, updated: toUpdate.length, archived: toArchive.length };
}

async function handleListRequests() {
  const [requestRows, playerRows, sessionRows] = await Promise.all([
    getAirtableRecords("Player Session Requests"),
    getAirtableRecords("Players"),
    getAirtableRecords("Sessions"),
  ]);
  const playerById: Record<string, any> = {};
  for (const p of playerRows) playerById[p.id] = p;
  const sessionById: Record<string, any> = {};
  for (const s of sessionRows) sessionById[s.id] = s;

  const activeSessions = sessionRows
    .filter((s: any) => s.fields["Active"] === true)
    .map((s: any) => ({ session_record_id: s.id, session_name: s.fields["Session Name"] || "" }))
    .sort((a, b) => a.session_name.localeCompare(b.session_name));

  const pending = requestRows
    .filter((r: any) => r.fields["Status"] === "Pending")
    .map((r: any) => {
      const playerIds: string[] = r.fields["Player"] || [];
      const sessionIds: string[] = r.fields["Requested Session"] || [];
      const player = playerById[playerIds[0]];
      const session = sessionById[sessionIds[0]];
      return {
        request_id: r.id,
        player_record_id: playerIds[0] || "",
        player_name: player ? player.fields["Player Name"] || "" : "(unknown player)",
        session_record_id: sessionIds[0] || "",
        session_name: session ? session.fields["Session Name"] || "" : "(unknown session)",
        requested_date: r.fields["Requested Date"] || "",
      };
    });

  return { pending, sessions: activeSessions };
}

/**
 * Idempotent: creates the Active Player Session Link, or reactivates one
 * that already exists for this exact player+session (e.g. a retried
 * approve, a re-approved former membership, or a migration commit run
 * twice) rather than duplicating it. Shared by request approval and the
 * migration commit - one path for "make this player+session Active",
 * used everywhere a link needs to exist.
 */
async function ensureActiveLink(playerId: string, sessionId: string): Promise<string> {
  const existingLinks = await getAirtableRecords("Player Session Links");
  const existing = existingLinks.find(
    (l: any) => (l.fields["Player"] || []).includes(playerId) && (l.fields["Session"] || []).includes(sessionId)
  );
  const today = new Date().toISOString().slice(0, 10);
  if (existing) {
    if (existing.fields["Status"] !== "Active") {
      await updateAirtableRecord("Player Session Links", existing.id, {
        Status: "Active",
        "Start Date": existing.fields["Start Date"] || today,
        "End Date": null,
        "Coaches At End": [],
      });
    }
    return existing.id;
  }
  const created = await createAirtableRecord("Player Session Links", {
    "Link ID": `LINK-${playerId.slice(-6)}-${sessionId.slice(-6)}-${Date.now().toString(36).toUpperCase()}`,
    Player: [playerId],
    Session: [sessionId],
    Status: "Active",
    "Start Date": today,
  });
  return created.id;
}

/**
 * An optional session_record_id in the body amends which session is
 * being approved before the link is made - the "Amend" action is just
 * this same call with a different session picked in the dropdown first.
 */
async function handleApprove(requestId: string, body: any, reviewerCoachRecordId: string | null) {
  const request = await getAirtableRecord("Player Session Requests", requestId);
  if (!request) return jsonResponse({ error: "Request not found" }, 404);
  if (request.fields["Status"] !== "Pending") {
    return jsonResponse({ error: `Request is already ${request.fields["Status"]}` }, 400);
  }

  const playerIds: string[] = request.fields["Player"] || [];
  if (!playerIds.length) return jsonResponse({ error: "Request has no player linked" }, 400);
  const playerId = playerIds[0];

  const overrideSessionId = body && body.session_record_id ? String(body.session_record_id) : "";
  const requestedSessionIds: string[] = request.fields["Requested Session"] || [];
  const sessionId = overrideSessionId || requestedSessionIds[0] || "";
  if (!sessionId) return jsonResponse({ error: "No session to approve against" }, 400);

  await ensureActiveLink(playerId, sessionId);

  const today = new Date().toISOString().slice(0, 10);
  const reviewFields: Record<string, unknown> = { Status: "Approved", "Reviewed Date": today };
  if (overrideSessionId && overrideSessionId !== requestedSessionIds[0]) {
    reviewFields["Requested Session"] = [sessionId];
  }
  if (reviewerCoachRecordId) reviewFields["Reviewed By"] = [reviewerCoachRecordId];
  await updateAirtableRecord("Player Session Requests", requestId, reviewFields);

  return jsonResponse({ ok: true, session_record_id: sessionId });
}

async function handleReject(requestId: string, body: any, reviewerCoachRecordId: string | null) {
  const request = await getAirtableRecord("Player Session Requests", requestId);
  if (!request) return jsonResponse({ error: "Request not found" }, 404);
  if (request.fields["Status"] !== "Pending") {
    return jsonResponse({ error: `Request is already ${request.fields["Status"]}` }, 400);
  }
  const today = new Date().toISOString().slice(0, 10);
  const fields: Record<string, unknown> = { Status: "Rejected", "Reviewed Date": today };
  if (reviewerCoachRecordId) fields["Reviewed By"] = [reviewerCoachRecordId];
  if (body && body.note) fields["Note"] = String(body.note).slice(0, 1000);
  await updateAirtableRecord("Player Session Requests", requestId, fields);
  return jsonResponse({ ok: true });
}

/**
 * Ends an Active Player Session Link: a player has left that session.
 * Snapshots into "Coaches At End" the coaches ELIGIBLE at this moment for
 * this session - scheduled on it per the live Sessions Google Sheet
 * (the authoritative schedule source, not the manually-maintained
 * Permanent Coaches link) AND currently holding a Coach Role with Can
 * View Players = true. That frozen snapshot, not whoever coaches the
 * session later or Permanent Coaches, is what former-coach access checks
 * against afterwards - see player-access.ts's resolvePlayerAccess().
 */
async function handleEndLink(linkId: string) {
  const link = await getAirtableRecord("Player Session Links", linkId);
  if (!link) return jsonResponse({ error: "Link not found" }, 404);
  if (link.fields["Status"] !== "Active") {
    return jsonResponse({ error: `Link is already ${link.fields["Status"]}` }, 400);
  }
  const sessionIds: string[] = link.fields["Session"] || [];
  const session = sessionIds[0] ? await getAirtableRecord("Sessions", sessionIds[0]) : null;
  const sessionIdText: string = session ? session.fields["Session ID"] || "" : "";

  const [coachRows, coachRoleRows, sessionsCsvRows] = await Promise.all([
    getAirtableRecords("Coaches"),
    getAirtableRecords("Coach Roles"),
    fetchCsvObjects(SESSIONS_CSV_URL),
  ]);
  const roleCapsById = roleCapabilitiesById(coachRoleRows);
  const scheduledCoachNameKeysBySessionId = buildScheduledCoachNameKeysBySessionId(sessionsCsvRows);

  // Coach display_name (set once at account approval - see
  // player-access.ts's file header) lets a coach onboarded under a
  // different Coach Name than their schedule identity (e.g.
  // "davidcole.surrey" vs "David") still be captured correctly here.
  // RLS only lets a caller read their own profile row, so this snapshot
  // needs the service-role key already used by approve-coach for the
  // same reason (reading across multiple accounts' profiles); if that
  // secret is ever unavailable, this degrades to Coach Name/static-alias
  // matching only rather than failing the whole end-link action.
  const displayNameByCoachId: Record<string, string | null> = {};
  if (SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: profileRows, error } = await service
        .from("profiles")
        .select("airtable_person_id, display_name")
        .not("airtable_person_id", "is", null);
      if (error) throw error;
      for (const p of profileRows || []) {
        if (p.airtable_person_id) displayNameByCoachId[p.airtable_person_id as string] = (p.display_name as string) || null;
      }
    } catch (e) {
      console.error("Could not resolve coach display names for the Coaches At End snapshot", e);
    }
  }

  const coachesAtEnd = sessionIdText
    ? eligibleCoachIdsForSessionSnapshot(sessionIdText, coachRows, scheduledCoachNameKeysBySessionId, roleCapsById, displayNameByCoachId)
    : [];

  const today = new Date().toISOString().slice(0, 10);
  await updateAirtableRecord("Player Session Links", linkId, {
    Status: "Ended",
    "End Date": today,
    "Coaches At End": coachesAtEnd,
  });
  return jsonResponse({ ok: true, coaches_at_end: coachesAtEnd.length });
}

function normalizeText(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Preview only - commits nothing. Only Players with zero existing
 * Player Session Links at all (never touched by the new system, whether
 * Active or Ended) are considered - anything already migrated is left
 * alone. Matches are grouped: matched (exactly one session whose name
 * equals the player's Team/Session text, safe to pre-check), ambiguous
 * (one or more sessions whose name partially overlaps - needs a human
 * to actually pick), unmatched (nothing close at all).
 */
async function handleMigrationPreview() {
  const [playerRows, sessionRows, linkRows] = await Promise.all([
    getAirtableRecords("Players"),
    getAirtableRecords("Sessions"),
    getAirtableRecords("Player Session Links"),
  ]);

  const linkedPlayerIds = new Set<string>();
  for (const l of linkRows) {
    for (const pid of l.fields["Player"] || []) linkedPlayerIds.add(pid);
  }

  const activeSessions = sessionRows.filter((s: any) => s.fields["Active"] === true);

  const matched: any[] = [];
  const ambiguous: any[] = [];
  const unmatched: any[] = [];

  for (const p of playerRows) {
    if (p.fields["Active"] !== true) continue;
    if (linkedPlayerIds.has(p.id)) continue;

    const teamText: string = p.fields["Team / Session"] || "";
    const norm = normalizeText(teamText);
    const base = { player_record_id: p.id, player_name: p.fields["Player Name"] || "", team_session_text: teamText };

    if (!norm) {
      unmatched.push({ ...base, reason: "No Team / Session text set on the Player record" });
      continue;
    }

    const exact = activeSessions.filter((s: any) => normalizeText(s.fields["Session Name"]) === norm);
    if (exact.length === 1) {
      matched.push({ ...base, session_record_id: exact[0].id, session_name: exact[0].fields["Session Name"] || "" });
      continue;
    }

    const partial = activeSessions.filter((s: any) => {
      const sn = normalizeText(s.fields["Session Name"]);
      return sn && (sn.includes(norm) || norm.includes(sn));
    });
    if (partial.length >= 1) {
      ambiguous.push({
        ...base,
        candidates: partial.map((s: any) => ({ session_record_id: s.id, session_name: s.fields["Session Name"] || "" })),
      });
      continue;
    }

    unmatched.push({ ...base, reason: `No session name resembles "${teamText}"` });
  }

  return { matched, ambiguous, unmatched };
}

/** Commits exactly the pairs given - nothing is inferred or auto-picked here. */
async function handleMigrationCommit(body: any) {
  const pairs: { player_record_id?: string; session_record_id?: string }[] = Array.isArray(body?.links) ? body.links : [];
  const valid = pairs.filter((p) => p.player_record_id && p.session_record_id);
  if (!valid.length) return jsonResponse({ error: "No valid player/session pairs to commit" }, 400);
  for (const pair of valid) {
    await ensureActiveLink(String(pair.player_record_id), String(pair.session_record_id));
  }
  return jsonResponse({ ok: true, committed: valid.length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
  const auth = await requireManagement(authHeader);
  if ("error" in auth) return auth.error;

  const pathname = new URL(req.url).pathname;
  const route = pathname.replace(/^.*\/player-sessions\/?/, "").replace(/\/$/, "");
  const parts = route.split("/").filter(Boolean);

  try {
    if (route === "sync" && req.method === "POST") return jsonResponse(await syncSessions());
    if (route === "requests" && req.method === "GET") return jsonResponse(await handleListRequests());
    if (parts[0] === "requests" && parts[2] === "approve" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return await handleApprove(parts[1], body, auth.coachRecordId);
    }
    if (parts[0] === "requests" && parts[2] === "reject" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return await handleReject(parts[1], body, auth.coachRecordId);
    }
    if (parts[0] === "links" && parts[2] === "end" && req.method === "POST") {
      return await handleEndLink(parts[1]);
    }
    if (route === "migration/preview" && req.method === "GET") return jsonResponse(await handleMigrationPreview());
    if (route === "migration/commit" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return await handleMigrationCommit(body);
    }
    return jsonResponse({ error: "Unknown route" }, 404);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
