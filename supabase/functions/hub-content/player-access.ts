/**
 * Centralised player-access resolution.
 *
 * CANONICAL SOURCE. Supabase Edge Functions deployed through this tooling
 * are each self-contained (no shared filesystem across functions), so this
 * exact file is copied verbatim into every function that needs it
 * (hub-content, player-feedback, player-sessions, and later IDP/attendance
 * functions once built). Every screen that needs to know "can this coach
 * see this player, and what can they do" calls resolvePlayerAccess()
 * rather than re-deriving its own check - if the rules ever change, this
 * is the one function to edit, then redeploy it into each copy.
 *
 * LOCKED DATA RESPONSIBILITIES (do not blur these):
 *  - Google Sheets Sessions = authoritative source for which coaches are
 *    scheduled on a session (the `coaches` column).
 *  - Airtable Player Session Links = authoritative source for which
 *    players belong to a session (Status=Active / Ended).
 *  - Airtable Coach Roles (via each Coach's "Coach Role" link) =
 *    authoritative source for what a scheduled/covering coach is
 *    permitted to access/do. A coach being scheduled or covering NEVER
 *    grants player access on its own - Can View Players must also be
 *    true, every time, server-side. Nothing here trusts a client-
 *    supplied coach/session relationship, role, or capability.
 *
 * COACH IDENTITY (schedule name matching): the Sessions Google Sheet
 * names coaches in free text (e.g. "David"), which does not have to equal
 * an Airtable Coach's own "Coach Name" field (e.g. a coach onboarded as
 * "davidcole.surrey"). Rather than hardcoding per-person name pairs in
 * code, coachIdentityKeys() below draws on two already-existing, reusable
 * identity sources, configured once per coach (never per session):
 *   1. The coach's own Supabase profiles.display_name, set once when
 *      their account is approved - this is the authenticated account's
 *      own human-facing name, exactly the kind of thing the schedule
 *      uses, and requires no new Airtable field.
 *   2. STATIC_COACH_ALIASES, a small hand-maintained fallback for a
 *      schedule name that doesn't match either the Coach Name or any
 *      known display_name (mirrors config.js's own `coachAliases`).
 * A coach found through neither simply doesn't match any session - this
 * resolver fails closed, it never guesses.
 */

export type AccessTier = "admin" | "permanent" | "cover" | "former";

export interface PlayerAccessRow {
  player_record_id: string;
  player_id: string;
  name: string;
  photo_url: string;
  date_of_birth: string;
  session_record_id: string;
  session_id: string;
  session_name: string;
  link_record_id: string;
  tier: AccessTier;
  access_until: string | null;
  can_edit_feedback: boolean;
  can_edit_idp: boolean;
  can_edit_attendance: boolean;
}

const FORMER_ACCESS_DAYS = 28;

const ADMIN_PERMS = { can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true };
/** A former coach is always read-mostly, regardless of what their role could once do - this floor is unchanged by the Coach Role capability model. */
const FORMER_PERMS = { can_edit_feedback: false, can_edit_idp: false, can_edit_attendance: false };

function attachmentUrl(fields: Record<string, any>, fieldName: string): string {
  const list = fields[fieldName];
  if (!Array.isArray(list) || !list.length) return "";
  return list[0].url || "";
}

function daysSince(today: Date, past: Date): number {
  const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const b = Date.UTC(past.getFullYear(), past.getMonth(), past.getDate());
  return Math.floor((a - b) / 86400000);
}

/** Case/whitespace-insensitive name comparison key. */
export function nameKey(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function splitCoachNames(coachesColumnValue: string): string[] {
  return String(coachesColumnValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Small hand-maintained fallback for a schedule name that isn't a coach's
 * Coach Name or their Supabase display_name - mirrors config.js's
 * `coachAliases` object exactly (kept in sync by hand). Written "name as
 * it appears on the schedule": "the coach's own Coach Name". Prefer
 * fixing this via the coach's display_name (set once at approval) or
 * Coach Name over adding entries here where possible - this exists for
 * the cases neither covers.
 */
export const STATIC_COACH_ALIASES: Record<string, string> = {
  jack: "Jacko",
};

/**
 * Every name a specific coach could plausibly appear under on the
 * published Sessions/Changes sheets: their Airtable Coach Name, their
 * Supabase account's display_name (set once at approval - see the
 * file-level comment above), and any STATIC_COACH_ALIASES entry whose
 * canonical target is their own Coach Name. `displayName` is optional -
 * pass it when known (always available for the authenticated caller via
 * their own profile; for other coaches, e.g. building a Coaches-At-End
 * snapshot, pass it when resolved, omit otherwise - falls back to
 * Coach Name + static aliases only).
 */
export function coachIdentityKeys(coachRecord: any, displayName?: string | null): Set<string> {
  const set = new Set<string>();
  if (coachRecord) {
    const primary = nameKey(coachRecord.fields?.["Coach Name"]);
    if (primary) {
      set.add(primary);
      for (const [aliasKey, target] of Object.entries(STATIC_COACH_ALIASES)) {
        if (nameKey(target) === primary) set.add(aliasKey);
      }
    }
  }
  const dn = nameKey(displayName || "");
  if (dn) set.add(dn);
  return set;
}

function namesIntersect(a: Set<string>, b: Set<string> | undefined): boolean {
  if (!a.size || !b || !b.size) return false;
  for (const k of a) if (b.has(k)) return true;
  return false;
}

/**
 * Session ID (text, e.g. "E01") -> the set of normalised coach name keys
 * scheduled on it, read verbatim from the published Sessions Google
 * Sheet - the authoritative source for "who is scheduled on this
 * session", replacing Airtable Sessions -> Permanent Coaches as the
 * runtime authority. No alias resolution happens here on purpose: the
 * schedule text is kept exactly as published, and matching instead asks
 * "does this specific coach's own identity set include any of these
 * names" (see coachIdentityKeys()) - so a name that matches nobody's
 * Coach Name, display_name, or alias simply matches nobody, rather than
 * silently resolving to the wrong coach.
 */
export function buildScheduledCoachNameKeysBySessionId(
  sessionsCsvRows: Record<string, string>[]
): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const row of sessionsCsvRows) {
    const sid = row.session_id;
    if (!sid) continue;
    if (!map[sid]) map[sid] = new Set();
    for (const name of splitCoachNames(row.coaches)) {
      map[sid].add(nameKey(name));
    }
  }
  return map;
}

export interface CoachRoleCapabilities {
  active: boolean;
  canViewPlayers: boolean;
  canAddFeedback: boolean;
  canEditDevelopmentPlans: boolean;
  canRecordAttendance: boolean;
}

/** Coach Roles Airtable records -> capabilities keyed by record id. */
export function roleCapabilitiesById(coachRoleRows: any[]): Record<string, CoachRoleCapabilities> {
  const map: Record<string, CoachRoleCapabilities> = {};
  for (const r of coachRoleRows) {
    map[r.id] = {
      active: r.fields["Active"] === true,
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

/**
 * A coach's own current capabilities, resolved via their linked Coach
 * Role - never via the legacy singleSelect Role field (display wording
 * only, preserved for backward compatibility, never a permissions
 * source). No role linked, or the linked role isn't Active, means no
 * capabilities at all (fail closed), not full access.
 */
export function capabilitiesForCoach(
  coachRecord: any,
  roleCapsById: Record<string, CoachRoleCapabilities>
): CoachRoleCapabilities | null {
  if (!coachRecord) return null;
  const roleIds: string[] = coachRecord.fields["Coach Role"] || [];
  const caps = roleIds[0] ? roleCapsById[roleIds[0]] : null;
  return caps && caps.active ? caps : null;
}

/**
 * The legacy "Assigned Coaches" fallback (for a player not yet migrated
 * onto the Session/Player Session Links system) must obey exactly the
 * same Coach Role capability model as everything else - it is a
 * different SOURCE of player rows, never a different set of RULES. No
 * capabilities, or Can View Players = false, means no legacy access at
 * all (null); otherwise the same role-derived edit permissions apply as
 * everywhere else - a legacy row is never automatically fully editable.
 */
export function legacyFallbackPerms(
  coachCapabilities: CoachRoleCapabilities | null
): { can_edit_feedback: boolean; can_edit_idp: boolean; can_edit_attendance: boolean } | null {
  if (!coachCapabilities || coachCapabilities.canViewPlayers !== true) return null;
  return {
    can_edit_feedback: coachCapabilities.canAddFeedback,
    can_edit_idp: coachCapabilities.canEditDevelopmentPlans,
    can_edit_attendance: coachCapabilities.canRecordAttendance,
  };
}

export interface ResolveInput {
  role: string;
  coachRecordId: string | null;
  /** Every name this caller could appear under on the schedule - see coachIdentityKeys(). */
  coachNameKeys: Set<string>;
  /** The caller's own resolved role capabilities - null means no capabilities at all. */
  coachCapabilities: CoachRoleCapabilities | null;
  players: any[];
  sessions: any[];
  links: any[];
  /** Session ID (text) -> scheduled coach name keys, from buildScheduledCoachNameKeysBySessionId(). */
  scheduledCoachNameKeysBySessionId: Record<string, Set<string>>;
  /** Airtable Session RECORD ids the caller is covering today (date-specific, from the Changes sheet) - unchanged mechanism. */
  coverSessionIds: Set<string>;
  today: Date;
}

/**
 * Returns one row per (player, session) the caller can currently see.
 * A player linked to two sessions the caller has different relationships
 * to appears twice, once per session, each with its own tier - access is
 * always evaluated per session membership, never globally per player.
 *
 * Current-session access (tier "permanent") no longer depends on the
 * manually-maintained Sessions -> Permanent Coaches Airtable link; it is
 * resolved from the Sessions Google Sheet's own `coaches` column, matched
 * against every name this caller is known to appear under (see
 * coachIdentityKeys()). Being scheduled or covering NEVER grants a row on
 * its own - the caller's Coach Role must also have Can View Players =
 * true, checked fresh on every call, never trusted from the client.
 *
 * Former-coach access is unchanged in shape: it is still evaluated
 * against the link's own frozen "Coaches At End" snapshot (see
 * player-sessions' handleEndLink), not live scheduling or a coach's
 * current role - so a coach reassigned onto the session later never
 * inherits a former player's 28-day window, a coach later demoted to a
 * non-viewing role doesn't retroactively lose access they were already
 * granted for that window, and a coach moved off the session doesn't
 * lose access to players who left while they were still on it.
 */
export function resolvePlayerAccess(input: ResolveInput): PlayerAccessRow[] {
  const {
    role,
    coachRecordId,
    coachNameKeys,
    coachCapabilities,
    players,
    sessions,
    links,
    scheduledCoachNameKeysBySessionId,
    coverSessionIds,
    today,
  } = input;

  const sessionById: Record<string, any> = {};
  for (const s of sessions) sessionById[s.id] = s;
  const playerById: Record<string, any> = {};
  for (const p of players) playerById[p.id] = p;

  const rows: PlayerAccessRow[] = [];
  const seen = new Set<string>();

  function pushRow(
    playerRecordId: string,
    sessionRecordId: string,
    linkRecordId: string,
    tier: AccessTier,
    accessUntil: string | null,
    perms: { can_edit_feedback: boolean; can_edit_idp: boolean; can_edit_attendance: boolean }
  ) {
    const key = playerRecordId + "|" + sessionRecordId + "|" + tier;
    if (seen.has(key)) return;
    seen.add(key);
    const player = playerById[playerRecordId];
    const session = sessionById[sessionRecordId];
    if (!player || !session) return;
    rows.push({
      player_record_id: playerRecordId,
      player_id: player.fields["Player ID"] || "",
      name: player.fields["Player Name"] || "",
      photo_url: attachmentUrl(player.fields, "Profile Photo"),
      date_of_birth: player.fields["Date of Birth"] || "",
      session_record_id: sessionRecordId,
      session_id: session.fields["Session ID"] || "",
      session_name: session.fields["Session Name"] || "",
      link_record_id: linkRecordId,
      tier,
      access_until: accessUntil,
      ...perms,
    });
  }

  if (role === "management") {
    // Management keeps its existing admin behaviour, unaffected by the
    // Coach Roles model (management isn't a "coach" in this sense).
    for (const link of links) {
      if (link.fields["Status"] !== "Active") continue;
      const sessionIds: string[] = link.fields["Session"] || [];
      const playerIds: string[] = link.fields["Player"] || [];
      for (const sid of sessionIds) {
        if (!sessionById[sid]) continue;
        for (const pid of playerIds) pushRow(pid, sid, link.id, "admin", null, ADMIN_PERMS);
      }
    }
    return rows;
  }

  if (!coachRecordId) return rows;

  const canView = !!coachCapabilities && coachCapabilities.canViewPlayers === true;
  const currentPerms = coachCapabilities
    ? {
        can_edit_feedback: coachCapabilities.canAddFeedback,
        can_edit_idp: coachCapabilities.canEditDevelopmentPlans,
        can_edit_attendance: coachCapabilities.canRecordAttendance,
      }
    : null;

  for (const link of links) {
    const sessionIds: string[] = link.fields["Session"] || [];
    const playerIds: string[] = link.fields["Player"] || [];
    const status = link.fields["Status"];

    for (const sid of sessionIds) {
      const session = sessionById[sid];
      if (!session) continue;

      if (status === "Active") {
        // A coach merely being scheduled/covering must NEVER grant
        // access if their role/capabilities prohibit it - checked
        // before anything else, every call.
        if (!canView || !currentPerms) continue;

        const sessionIdText = session.fields["Session ID"] || "";
        const scheduledNames = scheduledCoachNameKeysBySessionId[sessionIdText];
        const isScheduled = namesIntersect(coachNameKeys, scheduledNames);
        const isCovering = coverSessionIds.has(sid);
        if (!isScheduled && !isCovering) continue;

        const tier: AccessTier = isScheduled ? "permanent" : "cover";
        for (const pid of playerIds) pushRow(pid, sid, link.id, tier, null, currentPerms);
      } else if (status === "Ended") {
        const coachesAtEnd: string[] = link.fields["Coaches At End"] || [];
        if (!coachesAtEnd.includes(coachRecordId)) continue;
        const endDateStr: string = link.fields["End Date"];
        if (!endDateStr) continue;
        const end = new Date(endDateStr + "T00:00:00Z");
        const since = daysSince(today, end);
        if (since < 0 || since > FORMER_ACCESS_DAYS) continue;
        const until = new Date(end);
        until.setUTCDate(until.getUTCDate() + FORMER_ACCESS_DAYS);
        const accessUntil = until.toISOString().slice(0, 10);
        for (const pid of playerIds) pushRow(pid, sid, link.id, "former", accessUntil, FORMER_PERMS);
      }
    }
  }

  return rows;
}

/**
 * Coaches (Active Airtable Coach records) eligible to be captured in a
 * Player Session Link's "Coaches At End" snapshot for a given session at
 * the moment its membership ends: scheduled on that session per the live
 * Sessions Google Sheet (matched via coachIdentityKeys(), same as the
 * main resolver), AND currently holding a role with Can View Players =
 * true. Never the whole roster, and never based on Permanent Coaches.
 * `displayNameByCoachId` is optional, resolved by the caller (e.g. via a
 * service-role profiles lookup) when available - a coach with no known
 * display_name still matches via their Coach Name/static aliases alone.
 * Returns Airtable Coach record ids.
 */
export function eligibleCoachIdsForSessionSnapshot(
  sessionIdText: string,
  coachRows: any[],
  scheduledCoachNameKeysBySessionId: Record<string, Set<string>>,
  roleCapsById: Record<string, CoachRoleCapabilities>,
  displayNameByCoachId?: Record<string, string | null | undefined>
): string[] {
  const scheduledNames = scheduledCoachNameKeysBySessionId[sessionIdText];
  if (!scheduledNames || !scheduledNames.size) return [];
  const out: string[] = [];
  for (const c of coachRows) {
    if (c.fields["Active"] !== true) continue;
    const keys = coachIdentityKeys(c, displayNameByCoachId ? displayNameByCoachId[c.id] : null);
    if (!namesIntersect(keys, scheduledNames)) continue;
    const caps = capabilitiesForCoach(c, roleCapsById);
    if (!caps || !caps.canViewPlayers) continue;
    out.push(c.id);
  }
  return out;
}
