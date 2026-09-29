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
 *  - Airtable Session Staff (Session <-> Coach <-> Role) = authoritative
 *    source for which coach currently has a standing place on a session,
 *    and what ROLE they hold there. This replaced the published Sessions
 *    Google Sheet's free-text `coaches` column as the access authority -
 *    the Sheet is no longer consulted for this at all.
 *  - Coaches Slice 2 (see TEST-ENV.md): a Session Staff row's `Active`
 *    checkbox is an independent administrative enable/disable flag, never
 *    "applies forever" - whether an enabled row applies on a given date is
 *    decided separately by its `Effective From`/`Effective Until` (both
 *    inclusive, both optional), via the one shared rule in
 *    sessionStaffAppliesOnDate() below. This is what makes a planned
 *    recurring handover (Danny weeks 1-2, Tom weeks 3-4, Joe weeks 5-7)
 *    work as successive Session Staff rows on the SAME Session, resolved
 *    correctly per date, with no fake Sessions and no per-date Occurrence
 *    Staff rows - and it is the only place either resolver in this
 *    codebase (this file's player-access tier, and parent-hub/index.ts's
 *    coach-display tier) is allowed to decide "does this assignment apply
 *    today/on this date" - never re-derived separately in either file.
 *  - Airtable Player Session Links = authoritative source for which
 *    players belong to a session (Membership Lifecycle Status, canonical;
 *    `LEGACY -` / original names read only as compatibility fallbacks).
 *  - Airtable Coach Roles (via a Session Staff row's own "Role" link) =
 *    authoritative source for what a coach is permitted to access/do ON
 *    THAT SESSION. A coach can legitimately hold different roles on
 *    different sessions - capabilities are resolved per (coach, session)
 *    pair, never once globally per coach. Lead Coach and Coach may be
 *    granted player-data access; Learning Coach never is - enforced here
 *    directly via PLAYER_ACCESS_ROLES, not left to the Can View Players
 *    checkbox alone, since that checkbox is an editable Airtable value
 *    and this is a hard product rule, not a preference. A coach being
 *    staffed or covering NEVER grants player access on its own - the
 *    role must also be in PLAYER_ACCESS_ROLES AND Can View Players must
 *    be true, every time, server-side.
 *
 * Coaches Slice 3 (see TEST-ENV.md): for a session that has a Session
 * Occurrence dated exactly `today`, that occurrence's own Occurrence
 * Staff rows now participate directly in the "permanent" tier below, via
 * resolveOccurrenceStaffing() - a one-date exception (additive coach, or
 * an explicit Cover replacing a named Session Staff coach for that one
 * occurrence only) on top of the effective-dated Session Staff roster,
 * never mutating the underlying Session Staff records and never bleeding
 * onto any other date. When a session has no occurrence dated `today` -
 * the overwhelming majority of calls, since most sessions don't happen
 * every single day - this tier falls back to plain Session-Staff-only
 * resolution, byte-identical to Slice 2.
 *
 * COACHES SLICE 4 - LEGACY "cover" TIER RETIRED. Before this slice, a
 * separate AccessTier "cover" existed for a coach covering a session they
 * held NO Session Staff row on at all, resolved from the published
 * Changes Google Sheet and matched by free-text coach identity (see
 * coachIdentityKeys() below). Slice 3 proved Occurrence Staff as the real
 * per-occurrence staffing/cover source; Slice 4 removed the Changes-sheet
 * mechanism from this function's access decision ENTIRELY - it is no
 * longer fetched, matched, or consulted here, and a Sheet row or a
 * free-text name/alias match can no longer grant or remove player-data
 * access on its own. Occurrence Staff always resolves into the
 * "permanent" tier (it is scoped to a specific Session's specific
 * occurrence, exactly like Session Staff), even when it represents a
 * cover assignment in the everyday sense (Assignment Type = "Cover") -
 * see Slice 3's own comment on resolveOccurrenceStaffing() below. This
 * fails CLOSED: if a session has no occurrence dated today, or that
 * occurrence has no usable Occurrence Staff row for a coach, that coach
 * simply gets no access to it - never a fallback inference from anything
 * Sheet-derived. The `AccessTier` type still includes `"cover"` (the
 * frontend - coach.js, feedback.js - still has display code that reads
 * `tier === "cover"`, out of scope to touch this slice) but nothing in
 * this TEST backend produces it any more; see TEST-ENV.md ("Coaches
 * Foundation - Slice 4") for the full cutover record.
 *
 * COACH IDENTITY (schedule name matching) - RETAINED, but its only
 * remaining live caller in this file is now
 * eligibleCoachIdsForSessionSnapshot() below, a separate, already-dormant
 * former-player-snapshot path (used by player-sessions' handleEndLink,
 * which has no TEST copy yet - see that function's own comment) that
 * this slice deliberately does NOT touch or rewrite, per its own
 * out-of-scope note. coachIdentityKeys() draws on two reusable identity
 * sources, configured once per coach (never per session):
 *   1. The coach's own Supabase profiles.display_name, set once when
 *      their account is approved.
 *   2. STATIC_COACH_ALIASES, a small hand-maintained fallback for a
 *      schedule name that doesn't match either the Coach Name or any
 *      known display_name (mirrors config.js's own `coachAliases`).
 * A coach found through neither simply doesn't match any session - this
 * resolver fails closed, it never guesses. Left in place rather than
 * removed because it is still referenced (see "Cleanup discipline" in
 * TEST-ENV.md's Slice 4 write-up for the full reasoning).
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

export function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Today's Europe/London calendar date as "YYYY-MM-DD" - Coaches Slice 2.
 * Never a UTC-midnight slice: near midnight UTC, the UK's own calendar
 * date can already be tomorrow (BST) or still be today when UTC has
 * rolled over - a naive `toISOString().slice(0,10)` would silently apply
 * or drop a Session Staff assignment a day early/late right at that
 * boundary. Uses the same Intl double-format technique as this codebase's
 * other UK-local date/time helpers (parent-hub/index.ts's formatUkTime(),
 * session-occurrences/schedule-utils.ts's ukOffsetMinutesAt()) rather than
 * hand-rolled BST rules.
 */
export function ukTodayIso(now: Date = new Date()): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * THE one shared rule (Coaches Slice 2, see TEST-ENV.md) for "does this
 * Session Staff row apply on this date" - used by every resolver in this
 * codebase that needs to know, never re-derived separately.
 *
 * `Active` is an independent administrative enable/disable flag, checked
 * first and absolute: a retracted (Active=false) row never applies,
 * regardless of what its date range says. `Effective From`/`Effective
 * Until` then decide whether an ENABLED row applies on THIS particular
 * date - both inclusive, both optional (blank From = applies from the
 * start of time; blank Until = applies indefinitely; both blank = applies
 * whenever Active, exactly the pre-Slice-2 behaviour for a row that never
 * needed date-scoping). Plain "YYYY-MM-DD" string comparison is safe and
 * deliberate, matching session-occurrences/schedule-utils.ts's own
 * isoDateLte()/isoDateGte() convention - lexicographic order equals
 * chronological order for this exact format.
 *
 * Overlap is never resolved here - deliberate co-coaching, a Lead Coach
 * and a Coach both covering the same date, or even two rows for the same
 * coach, are all valid and this function answers "does THIS ONE row
 * apply", nothing more; a caller checking several rows for the same
 * session/date simply calls this once per row and keeps every row that
 * returns true.
 *
 * Fails closed on malformed data: a non-blank Effective From/Until that
 * isn't a valid "YYYY-MM-DD" string is never treated as absent (which
 * would silently widen an intended boundary into an open-ended range) -
 * the whole row is excluded instead. This is a data problem to fix in
 * Airtable, never something for this function to guess past or for any
 * caller to auto-correct.
 */
export function sessionStaffAppliesOnDate(row: { fields: Record<string, any> }, dateIso: string): boolean {
  if (row.fields["Active"] !== true) return false;
  const from = row.fields["Effective From"];
  if (from != null && from !== "") {
    if (typeof from !== "string" || !ISO_DATE_ONLY_RE.test(from)) return false;
    if (dateIso < from) return false;
  }
  const until = row.fields["Effective Until"];
  if (until != null && until !== "") {
    if (typeof until !== "string" || !ISO_DATE_ONLY_RE.test(until)) return false;
    if (dateIso > until) return false;
  }
  return true;
}

/**
 * Airtable's REST API returns a singleSelect as the plain option-name
 * string, never an {id,name,color} object - handled defensively both ways
 * here too, same reasoning and the same helper shape as parent-hub's own
 * selectName() (duplicated rather than imported, per this file's own
 * "no shared filesystem across functions" convention).
 */
export function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

/**
 * A Player Session Link's membership status. `Membership Lifecycle
 * Status` is canonical; `LEGACY - Status` and the pre-rename `Status`
 * are read only as compatibility fallbacks, in that order - the exact
 * pattern parent-hub's membershipStatus() already established. Reading
 * the plain `Status` name alone (what this file did until this repair)
 * returns undefined for every row against the current TEST schema, which
 * is why /hub-content/players returned zero rows for every coach.
 */
function membershipStatus(fields: Record<string, any>): string {
  return (
    selectName(fields["Membership Lifecycle Status"]) ||
    selectName(fields["LEGACY — Status"]) ||
    selectName(fields["Status"]) ||
    ""
  );
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
 *
 * RETAINED after Coaches Slice 4 (see file header): its only remaining
 * live caller is eligibleCoachIdsForSessionSnapshot() below, the dormant
 * former-player-snapshot path - no longer used for current-session
 * access (Session Staff resolves that directly by linked Coach record)
 * or for the retired Changes-sheet cover tier.
 */
export const STATIC_COACH_ALIASES: Record<string, string> = {
  jack: "Jacko",
};

/**
 * Every name a specific coach could plausibly appear under on a schedule
 * published in free text: their Airtable Coach Name, their Supabase
 * account's display_name (set once at approval), and any
 * STATIC_COACH_ALIASES entry whose canonical target is their own Coach
 * Name. RETAINED after Coaches Slice 4 (see file header) purely for
 * eligibleCoachIdsForSessionSnapshot() below's former-player-snapshot
 * matching - no longer called for current-session or cover-tier access.
 * `displayName` is optional - pass it when known (always available for
 * the authenticated caller via their own profile; for other coaches,
 * e.g. building a Coaches-At-End snapshot, pass it when resolved, omit
 * otherwise - falls back to Coach Name + static aliases only).
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
 * Sheet. Retained only for eligibleCoachIdsForSessionSnapshot() below
 * (used by player-sessions, which has no TEST copy yet) - no longer read
 * by resolvePlayerAccess()'s current-session tier, which uses Session
 * Staff directly. Left untouched rather than removed, so this file keeps
 * working the moment player-sessions is ported into TEST; it will need
 * its own Session Staff-based repair at that point.
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
  /** Coach Roles' own "Role Name" (singleLineText, display wording only - e.g. "Lead Coach"). Never matched against for access control; see roleKey. */
  roleName: string;
  /** Coach Roles' own "Role Key" (singleLineText, e.g. "lead_coach") - the STABLE identifier this file gates access on, so renaming a role's display "Role Name" in Airtable can never silently change who has player access. */
  roleKey: string;
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
      roleName: String(r.fields["Role Name"] || ""),
      roleKey: String(r.fields["Role Key"] || ""),
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

/**
 * Only these two roles may ever be granted player-data access, whatever
 * a Coach Roles row's own Can View Players checkbox says - a hard product
 * rule (Learning Coach must never receive player profile/data access),
 * checked here directly rather than trusted to an editable Airtable
 * value alone. Keyed by Role Key (stable), not Role Name (display text,
 * renameable) - renaming "Lead Coach" to "Head Coach" in Airtable must
 * never silently strip everyone with that role of player access. The
 * order (0, 1) is also this file's role-priority order - RETIRED
 * (Coaches Slice 4) `coachOwnStandingCapabilities()` used to consult it
 * for a coach's single best "standing" role across sessions; nothing
 * else in this file currently reads the ordering, only membership in the
 * map itself (isPlayerAccessRole() below), but it is kept as an ordered
 * map rather than simplified to a plain allowlist in case a future
 * caller needs it again.
 */
const PLAYER_ACCESS_ROLE_PRIORITY: Record<string, number> = { lead_coach: 0, coach: 1 };

function isPlayerAccessRole(caps: CoachRoleCapabilities | null): boolean {
  return !!caps && caps.active && caps.canViewPlayers === true && Object.prototype.hasOwnProperty.call(PLAYER_ACCESS_ROLE_PRIORITY, caps.roleKey);
}

/**
 * Session RECORD id -> Coach RECORD id -> ALL of that coach's own Session
 * Staff rows for that session - Coaches Slice 2: a coach can legitimately
 * have more than one row on the same session over time (a planned
 * recurring handover, or simply an old row someone forgot to retire), so
 * this keeps every row rather than collapsing to one, and leaves the
 * question of which row(s) actually apply to sessionStaffAppliesOnDate()
 * at lookup time - never decided here, and never by an `Active` filter at
 * this stage (a row's own Active/date-range validity is entirely that
 * function's job, applied uniformly). A coach can also hold different
 * roles on different sessions (Lead Coach on one, Learning Coach on
 * another), so this is still keyed per session, never once globally per
 * coach.
 */
export function buildSessionStaffByCoachAndSession(sessionStaffRows: any[]): Record<string, Record<string, any[]>> {
  const map: Record<string, Record<string, any[]>> = {};
  for (const row of sessionStaffRows) {
    const sessionId = firstLink(row.fields, "Session");
    const coachId = firstLink(row.fields, "Coach");
    if (!sessionId || !coachId) continue;
    if (!map[sessionId]) map[sessionId] = {};
    if (!map[sessionId][coachId]) map[sessionId][coachId] = [];
    map[sessionId][coachId].push(row);
  }
  return map;
}

/**
 * Session RECORD id -> ALL Session Staff rows for that session, any coach,
 * unfiltered - Coaches Slice 3. A flat companion to
 * buildSessionStaffByCoachAndSession() above (which is keyed by coach
 * too): resolveOccurrenceStaffing() below needs the WHOLE roster for a
 * session at once, to build the base map it then layers Occurrence Staff
 * on top of - it does not know which coach it's looking for in advance.
 */
export function buildSessionStaffBySessionId(sessionStaffRows: any[]): Record<string, any[]> {
  const map: Record<string, any[]> = {};
  for (const row of sessionStaffRows) {
    const sessionId = firstLink(row.fields, "Session");
    if (!sessionId) continue;
    if (!map[sessionId]) map[sessionId] = [];
    map[sessionId].push(row);
  }
  return map;
}

/** Session Staff RECORD id -> its own row - Coaches Slice 3, for resolving an Occurrence Staff row's "Session Staff Source" link back to the row (and coach) it traces to. */
export function buildSessionStaffById(sessionStaffRows: any[]): Record<string, any> {
  const map: Record<string, any> = {};
  for (const row of sessionStaffRows) map[row.id] = row;
  return map;
}

/** Occurrence RECORD id -> ALL Occurrence Staff rows linked to that exact occurrence - Coaches Slice 3. Never grouped or looked up by date or by Session: an Occurrence Staff row affects only the one occurrence it links to. */
export function buildOccurrenceStaffByOccurrenceId(occurrenceStaffRows: any[]): Record<string, any[]> {
  const map: Record<string, any[]> = {};
  for (const row of occurrenceStaffRows) {
    const occurrenceId = firstLink(row.fields, "Session Occurrence");
    if (!occurrenceId) continue;
    if (!map[occurrenceId]) map[occurrenceId] = [];
    map[occurrenceId].push(row);
  }
  return map;
}

/**
 * Coach Roles RECORD id -> capabilities, indexed by "Role Name" text -
 * Coaches Slice 3, deliberately a SECOND index alongside
 * roleCapabilitiesById()'s by-id one (built from the exact same rows).
 * Occurrence Staff's "Planned Role Snapshot"/"Actual Role Snapshot"
 * fields are plain text (singleLineText), not links, so they can only
 * ever be resolved back to a real Coach Roles record by matching text -
 * the same "snapshot the display value, look up by name" pattern this
 * codebase already uses elsewhere (Feedback Ratings' Label/Group
 * Snapshot, parent-hub's own ROLE_DISPLAY_PRIORITY keyed by Role Name).
 * Exact, case-sensitive match against Airtable's own "Role Name" text -
 * a typo'd or since-retired snapshot value resolves to nothing here
 * (undefined), which callers must treat as unresolved/fail-closed, never
 * as "no role restriction".
 */
export function roleCapsByRoleName(coachRoleRows: any[]): Record<string, CoachRoleCapabilities> {
  const map: Record<string, CoachRoleCapabilities> = {};
  for (const r of coachRoleRows) {
    const name = String(r.fields["Role Name"] || "");
    if (!name) continue;
    map[name] = {
      active: r.fields["Active"] === true,
      roleName: name,
      roleKey: String(r.fields["Role Key"] || ""),
      canViewPlayers: r.fields["Can View Players"] === true,
      canAddFeedback: r.fields["Can Add Feedback"] === true,
      canEditDevelopmentPlans: r.fields["Can Edit Development Plans"] === true,
      canRecordAttendance: r.fields["Can Record Attendance"] === true,
    };
  }
  return map;
}

/**
 * Whether an Occurrence Staff row counts as staffing at all - Coaches
 * Slice 3. Two requirements, both fail-closed:
 *  - a linked Coach (an Occurrence Staff row with no Coach cannot
 *    resolve to anyone, so it is simply invisible - never an error, never
 *    a wildcard).
 *  - `Attendance` is not "Absent". Occurrence Staff has NO "Active" or
 *    "Cancelled" checkbox of its own (unlike Session Staff) - the schema
 *    was inspected fresh for this slice and confirmed to have no such
 *    field. `Attendance` (Planned / Present / Absent) is this table's
 *    only field whose value can plausibly mean "this coach's assignment
 *    for this occurrence does not stand" - Absent is read that way here.
 *    This is a documented INTERPRETATION of a schema that has no explicit
 *    withdrawn/cancelled flag, not an invented field; see TEST-ENV.md.
 *    Historical rows are never deleted for this - an Absent row simply
 *    stops resolving as staffing, its own record is untouched.
 *
 * SUPERSEDED IN PART (Staffing Absent correction, 2026-09-28): an Absent
 * row still never ADDS anyone, but it is no longer merely "ignored" - it
 * now also REMOVES its coach from the occurrence's resolved roster; see
 * isAbsentOccurrenceStaffRow() and resolveOccurrenceStaffing() below.
 * Cover-replacement correction (2026-09-28): "usable" now gates only
 * whether a row ADDS its coach; a Cover row's displacement of the coach it
 * replaces applies even when the Cover row itself is Absent.
 */
function isUsableOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {
  if (!firstLink(row.fields, "Coach")) return false;
  if (selectName(row.fields["Attendance"]) === "Absent") return false;
  return true;
}

/**
 * Staffing Absent correction (2026-09-28, see TEST-ENV.md): an Occurrence
 * Staff row with a linked Coach and `Attendance = "Absent"` means THAT
 * coach is not working THIS occurrence - whether they are recurring
 * Session Staff or were added by Occurrence Staff, and whether or not
 * cover has been found. resolveOccurrenceStaffing() removes every such
 * coach from the roster as its final step. Before this correction an
 * Absent row was only ignored, so a recurring coach stayed on the roster
 * until a Cover row naming their Session Staff row replaced them.
 */
function isAbsentOccurrenceStaffRow(row: { fields: Record<string, any> }): boolean {
  return !!firstLink(row.fields, "Coach") && selectName(row.fields["Attendance"]) === "Absent";
}

/**
 * The role that actually applied for ONE Occurrence Staff row - Coaches
 * Slice 3. Precedence, each level fail-closed on its own (a level that is
 * non-blank but does not resolve to a real Coach Roles record returns
 * null immediately; it never falls through to a weaker signal, matching
 * this codebase's existing malformed-date convention of excluding rather
 * than guessing past a present-but-bad value):
 *  1. `Actual Role Snapshot` - what actually applied, confirmed after the
 *     fact. The most specific, most authoritative signal this table has.
 *  2. `Planned Role Snapshot` - the intended role, before/absent an
 *     actual confirmation.
 *  3. The linked `Session Staff Source` row's own Role - used only when
 *     BOTH snapshot fields are blank, meaning this occurrence row never
 *     bothered restating a role of its own and is deferring entirely to
 *     the recurring assignment it traces back to.
 *  4. Neither snapshot filled in AND no (or no resolvable) Session Staff
 *     Source - null. This occurrence row's role cannot be determined; it
 *     is fail-closed to "no access" everywhere below, though it may still
 *     be shown for DISPLAY purposes by a caller that only needs a name
 *     (see parent-hub/index.ts's own duplicate of this logic).
 *
 * These snapshot fields exist so historical truth survives later changes
 * to the Coach Roles catalogue or to the linked Session Staff row's own
 * Role - this function NEVER re-derives a role live from Session Staff
 * Source once a snapshot is present; the snapshot always wins once it
 * exists, by design.
 */
function resolveOccurrenceRoleCaps(
  row: { fields: Record<string, any> },
  sourceRow: any | null,
  roleCapsByName: Record<string, CoachRoleCapabilities>,
  roleCapsById: Record<string, CoachRoleCapabilities>
): CoachRoleCapabilities | null {
  const actual = String(row.fields["Actual Role Snapshot"] || "").trim();
  if (actual) return roleCapsByName[actual] ?? null;
  const planned = String(row.fields["Planned Role Snapshot"] || "").trim();
  if (planned) return roleCapsByName[planned] ?? null;
  if (sourceRow) {
    const roleId = firstLink(sourceRow.fields, "Role");
    if (roleId) return roleCapsById[roleId] ?? null;
  }
  return null;
}

export interface ResolvedOccurrenceCoach {
  coachId: string;
  roleCaps: CoachRoleCapabilities | null;
  /** True when this coach's entry came from (or was role-overridden by) an Occurrence Staff row, rather than being pure Session Staff. */
  fromOccurrenceStaff: boolean;
}

/**
 * THE one shared merge algorithm (Coaches Slice 3, see TEST-ENV.md) for
 * "who is actually staffing this ONE occurrence" - used by every resolver
 * in this codebase that needs to know, duplicated identically into
 * parent-hub/index.ts per this file's own "no shared filesystem"
 * convention (see that file's own copy for the cross-reference comment).
 *
 * Two layers, in order:
 *  1. BASE: every Session Staff row for the session that applies on
 *     `dateIso` (sessionStaffAppliesOnDate(), Coaches Slice 2, unchanged) -
 *     exactly what would resolve with no Occurrence Staff involved at
 *     all, keyed by coach id.
 *  2. OVERLAY: each Occurrence Staff row for this exact occurrence with a
 *     linked Coach is applied on top, in the order given:
 *       - Cover-replacement correction (2026-09-28): the Cover
 *         DISPLACEMENT below is decided for every Cover row with a linked
 *         Coach, whatever its own Attendance. A replacement decision stays
 *         in force for this occurrence even if the replacement coach is
 *         later marked Absent - the replaced recurring coach does NOT come
 *         back. Only the step that ADDS the row's own coach requires a
 *         USABLE row (isUsableOccurrenceStaffRow()). SUPERSEDES the earlier
 *         order, which skipped an Absent Cover row entirely and so let the
 *         replaced coach reappear.
 *       - `Assignment Type = "Cover"` with a `Session Staff Source` that
 *         resolves to a real Session Staff row: that source row's own
 *         coach is REMOVED from the base roster first (unless it is the
 *         same coach as this Occurrence Staff row's own Coach, in which
 *         case there is nothing to remove) - this is the schema's
 *         explicit representation of "this coach has been replaced for
 *         this occurrence", per the Coaches Slice 3 brief. A `Cover` row
 *         whose Session Staff Source does not resolve (blank, or a
 *         broken link) still ADDS its own coach - unambiguous that this
 *         person is staffing, even though who exactly they replace is
 *         unknown; nobody is removed in that case.
 *       - Every usable row (Cover, Additional, Planned or Temporary
 *         Role alike) then SETS this row's own Coach into the roster
 *         with the role resolved by resolveOccurrenceRoleCaps() - an
 *         Additional/Planned row simply adds a new entry; a Temporary
 *         Role (or any row) for a coach who already has a base entry
 *         OVERWRITES that entry's role for this occurrence only, which
 *         is exactly a same-coach role override and needs no special
 *         case beyond "last write wins" for that coach id.
 *
 *  3. ABSENCE (Staffing Absent correction, 2026-09-28): finally, every
 *     coach with an Absent row for this occurrence
 *     (isAbsentOccurrenceStaffRow()) is REMOVED from the roster, whatever
 *     added them (Session Staff or an Occurrence Staff row) and whether
 *     or not a Cover row exists. Absent therefore wins over any other row
 *     for the same coach on the same occurrence (fail-closed). A Cover /
 *     Additional row for a DIFFERENT coach is what adds the replacement.
 *     This SUPERSEDES the earlier "an Absent row is simply ignored" reading,
 *     under which a recurring coach stayed on the roster unless a Cover row
 *     cited their Session Staff row.
 *
 * This never mutates a Session Staff row and never looks at any
 * Occurrence Staff row outside the one occurrence being resolved - a
 * one-date exception can never bleed onto another date or another
 * session by construction, since `occurrenceStaffRowsForOccurrence` is
 * always pre-filtered by the caller to one occurrence's own rows.
 *
 * Overlap among ADDITIONS is never resolved here, same as Session Staff:
 * two Occurrence Staff rows for two different coaches on the same
 * occurrence both resolve (see buildOccurrenceStaffByOccurrenceId() -
 * both rows are simply present in `occurrenceStaffRowsForOccurrence` and
 * each SETS its own coach id independently).
 */
export function resolveOccurrenceStaffing(
  dateIso: string,
  sessionStaffRowsForSession: any[],
  occurrenceStaffRowsForOccurrence: any[],
  roleCapsById: Record<string, CoachRoleCapabilities>,
  roleCapsByNameMap: Record<string, CoachRoleCapabilities>,
  sessionStaffById: Record<string, any>
): ResolvedOccurrenceCoach[] {
  const roster = new Map<string, ResolvedOccurrenceCoach>();

  for (const row of sessionStaffRowsForSession) {
    if (!sessionStaffAppliesOnDate(row, dateIso)) continue;
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;
    const roleId = firstLink(row.fields, "Role");
    const caps = roleId ? roleCapsById[roleId] ?? null : null;
    roster.set(coachId, { coachId, roleCaps: caps, fromOccurrenceStaff: false });
  }

  for (const row of occurrenceStaffRowsForOccurrence) {
    const coachId = firstLink(row.fields, "Coach");
    if (!coachId) continue;

    const assignmentType = selectName(row.fields["Assignment Type"]);
    const sourceId = firstLink(row.fields, "Session Staff Source");
    const sourceRow = sourceId ? sessionStaffById[sourceId] ?? null : null;

    if (assignmentType === "Cover" && sourceRow) {
      const sourceCoachId = firstLink(sourceRow.fields, "Coach");
      if (sourceCoachId && sourceCoachId !== coachId) roster.delete(sourceCoachId);
    }

    if (!isUsableOccurrenceStaffRow(row)) continue;
    const caps = resolveOccurrenceRoleCaps(row, sourceRow, roleCapsByNameMap, roleCapsById);
    roster.set(coachId, { coachId, roleCaps: caps, fromOccurrenceStaff: true });
  }

  for (const row of occurrenceStaffRowsForOccurrence) {
    if (isAbsentOccurrenceStaffRow(row)) roster.delete(firstLink(row.fields, "Coach"));
  }

  return [...roster.values()];
}

/**
 * A coach's capabilities FOR ONE SESSION ON ONE DATE, from whichever of
 * their own Session Staff rows on that session actually applies on
 * `dateIso` (sessionStaffAppliesOnDate() - Active + Effective From/Until,
 * Coaches Slice 2) - never a role fixed to the Coach record, and never
 * decided from `Active` alone any more. Returns null (no access) when the
 * coach has no row that applies on this date, the applying row's Role
 * doesn't resolve, the role isn't Active, Can View Players is false, or
 * the role isn't in PLAYER_ACCESS_ROLE_PRIORITY (Learning Coach, or
 * anything unrecognised) - fail closed in every case. If more than one of
 * the coach's rows applies on the same date (a genuine overlap, or a
 * data-entry duplicate), the first one found that grants access wins -
 * this only ever needs ONE applicable row to grant the coach access, not
 * every one of them.
 *
 * `occurrenceContext` (Coaches Slice 3, optional) - when the session has
 * a real Session Occurrence dated exactly `dateIso`, pass its Occurrence
 * Staff rows here so a one-date exception participates in this decision
 * too, via resolveOccurrenceStaffing(). Omitted (or the session has no
 * occurrence on this date), this function is byte-identical to Slice 2.
 * A coach explicitly replaced via Occurrence Staff `Cover` for this exact
 * occurrence is excluded here even though their Session Staff row is
 * still Active and in range - the occurrence-specific fact wins. The same
 * now applies to a coach with an Absent Occurrence Staff row for this
 * occurrence, with or without a Cover row (Staffing Absent correction,
 * 2026-09-28): no occurrence-specific access through the recurring row.
 */
export function sessionStaffCapabilitiesForSession(
  sessionId: string,
  coachId: string,
  dateIso: string,
  sessionStaffBySessionAndCoach: Record<string, Record<string, any[]>>,
  roleCapsById: Record<string, CoachRoleCapabilities>,
  occurrenceContext?: {
    occurrenceStaffRows: any[];
    sessionStaffRowsForSession: any[];
    sessionStaffById: Record<string, any>;
    roleCapsByNameMap: Record<string, CoachRoleCapabilities>;
  } | null
): CoachRoleCapabilities | null {
  if (occurrenceContext) {
    const roster = resolveOccurrenceStaffing(
      dateIso,
      occurrenceContext.sessionStaffRowsForSession,
      occurrenceContext.occurrenceStaffRows,
      roleCapsById,
      occurrenceContext.roleCapsByNameMap,
      occurrenceContext.sessionStaffById
    );
    const entry = roster.find((r) => r.coachId === coachId);
    if (!entry) return null;
    return isPlayerAccessRole(entry.roleCaps) ? entry.roleCaps : null;
  }

  const rows = (sessionStaffBySessionAndCoach[sessionId] || {})[coachId] || [];
  for (const row of rows) {
    if (!sessionStaffAppliesOnDate(row, dateIso)) continue;
    const roleId = firstLink(row.fields, "Role");
    const caps = roleId ? roleCapsById[roleId] : null;
    if (isPlayerAccessRole(caps)) return caps;
  }
  return null;
}

/**
 * RETIRED (Coaches Slice 4) - `coachOwnStandingCapabilities()` used to
 * give a coach covering a session they held no Session Staff row on
 * (matched via the Changes-sheet cover tier) some capability floor,
 * derived from their highest-priority role on any OTHER session. Its
 * only caller was the `coverSessionIds`/`coachCoverCapabilities` branch
 * of resolvePlayerAccess() below, which Slice 4 removed entirely - a
 * coach's capabilities are now only ever resolved for the specific
 * session (and, for a dated occurrence, the specific date) they're
 * actually being asked about, via sessionStaffCapabilitiesForSession()
 * (Session Staff, optionally overlaid by Occurrence Staff - Slice 3).
 * See TEST-ENV.md ("Coaches Foundation - Slice 4") for the full cutover
 * record.
 */

/**
 * A coach's own current capabilities from the single legacy "Coach Role"
 * link on their Coach record (never the display-only singleSelect "Role"
 * field). Retained only for the legacy Assigned Coaches fallback in
 * hub-content/index.ts and eligibleCoachIdsForSessionSnapshot() below -
 * both already-broken, out-of-scope paths this repair deliberately does
 * not touch (see TEST-ENV.md). NOT used by resolvePlayerAccess() any
 * more; sessionStaffCapabilitiesForSession() above replaces it there.
 * "Coach Role" was itself renamed to "LEGACY - Coach Role" in the same
 * schema migration that broke the fields this repair fixes, so this
 * function currently always returns null too - left exactly as-is
 * because fixing it is a different task (see report).
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
  players: any[];
  sessions: any[];
  links: any[];
  /** Session RECORD id -> Coach RECORD id -> that coach's Session Staff rows on that session, from buildSessionStaffByCoachAndSession(). */
  sessionStaffBySessionAndCoach: Record<string, Record<string, any[]>>;
  /** Coach Roles record id -> capabilities, from roleCapabilitiesById(). */
  roleCapsById: Record<string, CoachRoleCapabilities>;
  today: Date;
  /**
   * Coaches Slice 3, all optional - omitted (or leave any one undefined)
   * and this function is byte-identical to Slice 2, no Occurrence Staff
   * involved anywhere. Session RECORD id -> the Session Occurrence RECORD
   * id dated exactly `today` for that session, only for sessions that
   * have one (from the caller's own occurrence-floor read - see
   * hub-content/index.ts).
   */
  occurrenceIdForSessionToday?: Record<string, string>;
  /** Occurrence RECORD id -> its Occurrence Staff rows, from buildOccurrenceStaffByOccurrenceId(). */
  occurrenceStaffByOccurrenceId?: Record<string, any[]>;
  /** Session RECORD id -> ALL Session Staff rows for that session, from buildSessionStaffBySessionId(). */
  sessionStaffBySessionId?: Record<string, any[]>;
  /** Session Staff RECORD id -> its own row, from buildSessionStaffById(). */
  sessionStaffById?: Record<string, any>;
  /** Coach Roles Role Name text -> capabilities, from roleCapsByRoleName(). */
  roleCapsByNameMap?: Record<string, CoachRoleCapabilities>;
}

/**
 * Returns one row per (player, session) the caller can currently see.
 * A player linked to two sessions the caller has different relationships
 * to appears twice, once per session, each with its own tier - access is
 * always evaluated per session membership, never globally per player.
 *
 * Current-session access (tier "permanent") is resolved from whichever of
 * the caller's own Session Staff rows on THAT session actually applies
 * TODAY (Coaches Slice 2 - Active + Effective From/Until, via
 * sessionStaffAppliesOnDate() inside sessionStaffCapabilitiesForSession(),
 * checked fresh via `input.today` on every call), optionally overlaid by
 * that session's own Occurrence Staff for a Session Occurrence dated
 * exactly today (Coaches Slice 3 - resolveOccurrenceStaffing(), a
 * one-date addition or replacement) - Lead Coach and Coach roles only,
 * Learning Coach never. A coach whose assignment has ended (or not yet
 * started) gets no access here even if the row is still Active, exactly
 * the "an ended assignment must not retain current access merely because
 * the row is still Active" rule Slice 2 exists to enforce. Coaches Slice
 * 4 RETIRED the separate Changes-sheet "cover" tier that used to exist
 * here (a coach covering a session they held no Session Staff row on,
 * matched by free-text schedule name) - that Sheet-derived mechanism no
 * longer grants or removes access at all; Occurrence Staff (Slice 3) is
 * now the only route to a one-date addition or replacement, and this
 * function fails closed (no access) whenever it's missing or
 * unresolvable rather than falling back to anything Sheet-derived. See
 * TEST-ENV.md ("Coaches Foundation - Slice 4") for the cutover record.
 *
 * A Player Session Link with any status other than "Ended" counts as
 * current for this purpose (Active, Paused, Cancellation Pending, Ending
 * Scheduled all still mean the player genuinely belongs on that session -
 * the same "not Ended" reading handleListClaims() in parent-hub already
 * uses for "does this player currently belong anywhere"). A link with no
 * resolvable status at all grants nothing, fail closed.
 *
 * Former-coach access is unchanged in shape: it is still evaluated
 * against the link's own frozen "Coaches At End" snapshot (now read from
 * its current field name, LEGACY - Coaches At End - see
 * membershipStatus()'s own comment for why there is no non-legacy
 * replacement for this yet), not live scheduling or a coach's current
 * role - so a coach reassigned onto the session later never inherits a
 * former player's 28-day window, a coach later demoted to a non-viewing
 * role doesn't retroactively lose access they were already granted for
 * that window, and a coach moved off the session doesn't lose access to
 * players who left while they were still on it.
 */
export function resolvePlayerAccess(input: ResolveInput): PlayerAccessRow[] {
  const {
    role,
    coachRecordId,
    players,
    sessions,
    links,
    sessionStaffBySessionAndCoach,
    roleCapsById,
    today,
    occurrenceIdForSessionToday,
    occurrenceStaffByOccurrenceId,
    sessionStaffBySessionId,
    sessionStaffById,
    roleCapsByNameMap,
  } = input;
  const todayIso = ukTodayIso(today);

  /**
   * Coaches Slice 3: built once per session, only when every piece needed
   * to resolve Occurrence Staff was actually supplied AND this session
   * has a real occurrence dated `todayIso` - otherwise undefined, and the
   * "permanent" tier below falls back to plain Session Staff, exactly
   * Slice 2. Kept as a small memoised lookup rather than rebuilt per
   * player/link, since the same session is looked at many times over the
   * loop below.
   */
  const occurrenceContextCache = new Map<
    string,
    { occurrenceStaffRows: any[]; sessionStaffRowsForSession: any[]; sessionStaffById: Record<string, any>; roleCapsByNameMap: Record<string, CoachRoleCapabilities> } | null
  >();
  function occurrenceContextForSession(sessionId: string) {
    if (occurrenceContextCache.has(sessionId)) return occurrenceContextCache.get(sessionId)!;
    let context = null;
    if (occurrenceIdForSessionToday && occurrenceStaffByOccurrenceId && sessionStaffBySessionId && sessionStaffById && roleCapsByNameMap) {
      const occurrenceId = occurrenceIdForSessionToday[sessionId];
      if (occurrenceId) {
        context = {
          occurrenceStaffRows: occurrenceStaffByOccurrenceId[occurrenceId] || [],
          sessionStaffRowsForSession: sessionStaffBySessionId[sessionId] || [],
          sessionStaffById,
          roleCapsByNameMap,
        };
      }
    }
    occurrenceContextCache.set(sessionId, context);
    return context;
  }

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
    // Coach Roles model (management isn't a "coach" in this sense) -
    // just reading the link's status canonically now.
    for (const link of links) {
      const status = membershipStatus(link.fields);
      if (!status || status === "Ended") continue;
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

  for (const link of links) {
    const sessionIds: string[] = link.fields["Session"] || [];
    const playerIds: string[] = link.fields["Player"] || [];
    const status = membershipStatus(link.fields);
    if (!status) continue;

    for (const sid of sessionIds) {
      const session = sessionById[sid];
      if (!session) continue;

      if (status !== "Ended") {
        // A coach merely being staffed must NEVER grant access if their
        // role/capabilities prohibit it - checked before anything else,
        // every call, every session. Coaches Slice 4: this is now the
        // ONLY route to access - Session Staff, optionally overlaid by
        // that session's Occurrence Staff for an occurrence dated exactly
        // today (Slice 3). No Changes-sheet fallback exists any more; a
        // coach with no staffCaps here simply gets no access to this
        // session, full stop - fail closed, never inferred from anything
        // Sheet-derived.
        const caps = sessionStaffCapabilitiesForSession(sid, coachRecordId, todayIso, sessionStaffBySessionAndCoach, roleCapsById, occurrenceContextForSession(sid));
        if (!caps) continue;

        const tier: AccessTier = "permanent";
        const perms = { can_edit_feedback: caps.canAddFeedback, can_edit_idp: caps.canEditDevelopmentPlans, can_edit_attendance: caps.canRecordAttendance };
        for (const pid of playerIds) pushRow(pid, sid, link.id, tier, null, perms);
      } else {
        const coachesAtEnd: string[] = link.fields["LEGACY — Coaches At End"] || [];
        if (!coachesAtEnd.includes(coachRecordId)) continue;
        const endDateStr: string = link.fields["LEGACY — End Date"];
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
 * main resolver used to), AND currently holding a role with Can View
 * Players = true. Never the whole roster, and never based on Permanent
 * Coaches.
 *
 * NOT updated to Session Staff in this repair - it is only called from
 * player-sessions' handleEndLink, which has no TEST copy yet (see
 * capabilitiesForCoach()'s own comment). Whoever ports player-sessions
 * into TEST should switch this to sessionStaffCapabilitiesForSession()
 * at the same time, for the same reason the main resolver just was.
 *
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
