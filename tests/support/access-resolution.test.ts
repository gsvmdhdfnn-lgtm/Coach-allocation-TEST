// Unit tests for the canonical player-access resolver (see
// tests/support/player-access.ts, a hand-kept copy of the real
// player-access.ts deployed into hub-content/player-feedback/
// player-sessions). Run directly, not through Playwright/HTTP mocks -
// these exercise resolvePlayerAccess()/eligibleCoachIdsForSessionSnapshot()
// with plain Airtable-shaped fixture data, so a mistake in the resolver
// itself fails here even if every HTTP-mocked e2e test still passes.
import {
  buildScheduledCoachNameKeysBySessionId,
  capabilitiesForCoach,
  coachIdentityKeys,
  eligibleCoachIdsForSessionSnapshot,
  legacyFallbackPerms,
  resolvePlayerAccess,
  roleCapabilitiesById,
  type CoachRoleCapabilities,
} from "./player-access.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const TODAY = new Date("2026-09-20T12:00:00Z");
function daysAgoIso(n: number): string {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// --- Fixture data ----------------------------------------------------

const ROLE_LEAD = { id: "roleLead", fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Edit Development Plans": true, "Can Record Attendance": true } };
const ROLE_SUPPORT = { id: "roleSupport", fields: { "Role Name": "Support Coach", "Role Key": "support_coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Record Attendance": true } };
const ROLE_LEARNING = { id: "roleLearning", fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true } };
// Synthetic role, not one of the 3 seeded Airtable roles - exists purely to
// prove Can View Players and Can Add Feedback are independent gates.
const ROLE_OBSERVER = { id: "roleObserver", fields: { "Role Name": "Observer", "Role Key": "observer", Active: true, "Can View Players": true } };

const coachRoleRows = [ROLE_LEAD, ROLE_SUPPORT, ROLE_LEARNING, ROLE_OBSERVER];

const COACH_DAVID = { id: "coachDavid", fields: { "Coach Name": "David", Active: true, "Coach Role": [ROLE_LEAD.id] } };
const COACH_JOHN = { id: "coachJohn", fields: { "Coach Name": "John", Active: true, "Coach Role": [ROLE_SUPPORT.id] } };
const COACH_GEORGE = { id: "coachGeorge", fields: { "Coach Name": "George", Active: true, "Coach Role": [ROLE_LEARNING.id] } };
const COACH_SARAH = { id: "coachSarah", fields: { "Coach Name": "Sarah", Active: true, "Coach Role": [ROLE_LEAD.id] } }; // Lead Coach, never scheduled on E01
const COACH_OBS = { id: "coachObs", fields: { "Coach Name": "Olivia", Active: true, "Coach Role": [ROLE_OBSERVER.id] } };
const COACH_INACTIVE = { id: "coachInactive", fields: { "Coach Name": "Ian", Active: false, "Coach Role": [ROLE_LEAD.id] } }; // scheduled+eligible role, but not an Active Coach record
// Mirrors the real production coach: onboarded with an Airtable Coach Name
// that doesn't match the schedule identity at all ("davidcole.surrey"),
// resolved instead via their Supabase profiles.display_name ("David2" here,
// kept distinct from COACH_DAVID's own name to avoid masking a bug).
const COACH_DAVID_ALIAS = { id: "coachDavidAlias", fields: { "Coach Name": "davidcole.surrey", Active: true, "Coach Role": [ROLE_LEAD.id] } };
const COACH_DAVID_ALIAS_DISPLAY_NAME = "David2";

const coachRows = [COACH_DAVID, COACH_JOHN, COACH_GEORGE, COACH_SARAH, COACH_OBS, COACH_INACTIVE, COACH_DAVID_ALIAS];

const SESSION_A = { id: "sessA", fields: { "Session ID": "E01", "Session Name": "Monday Academy", Active: true } };
const SESSION_B = { id: "sessB", fields: { "Session ID": "E02", "Session Name": "Wednesday Development Centre", Active: true } };
const SESSION_C = { id: "sessC", fields: { "Session ID": "E03", "Session Name": "Friday Elite", Active: true } };
const sessions = [SESSION_A, SESSION_B, SESSION_C];

const PLAYER_1 = { id: "p1", fields: { "Player Name": "Archie", "Player ID": "PLY-1" } };
const PLAYER_2 = { id: "p2", fields: { "Player Name": "Bella", "Player ID": "PLY-2" } };
const players = [PLAYER_1, PLAYER_2];

// David, John and George are scheduled on E01 per the Sessions Google
// Sheet. Inactive-coach "Ian" is also textually scheduled, to prove
// Active=false still excludes him from the former-access eligibility
// snapshot. E03 is scheduled under "David2" - the schedule identity that
// only COACH_DAVID_ALIAS's display_name (not its Coach Name) resolves to.
const sessionsCsvRows = [
  { session_id: "E01", coaches: "David, John, George, Ian" },
  { session_id: "E02", coaches: "Sarah" },
  { session_id: "E03", coaches: "David2" },
];

const roleCapsById = roleCapabilitiesById(coachRoleRows);
const scheduledCoachNameKeysBySessionId = buildScheduledCoachNameKeysBySessionId(sessionsCsvRows);

const LINK_ACTIVE_1 = { id: "link1", fields: { Player: [PLAYER_1.id], Session: [SESSION_A.id], Status: "Active" } };
const LINK_ACTIVE_2 = { id: "link2", fields: { Player: [PLAYER_2.id], Session: [SESSION_B.id], Status: "Active" } };

function resolveFor(coach: any, links: any[], coverSessionIds = new Set<string>(), displayName: string | null = null) {
  const coachNameKeys = coachIdentityKeys(coach, displayName);
  const coachCapabilities = capabilitiesForCoach(coach, roleCapsById);
  return resolvePlayerAccess({
    role: "coach",
    coachRecordId: coach ? coach.id : null,
    coachNameKeys,
    coachCapabilities,
    players,
    sessions,
    links,
    scheduledCoachNameKeysBySessionId,
    coverSessionIds,
    today: TODAY,
  });
}

// --- 1. Scheduled Lead Coach + view permission -> visible -------------
{
  const rows = resolveFor(COACH_DAVID, [LINK_ACTIVE_1]);
  const row = rows.find((r) => r.player_record_id === PLAYER_1.id && r.session_record_id === SESSION_A.id);
  ck("Active linked player + scheduled Lead Coach + view permission -> visible", !!row && row.tier === "permanent", JSON.stringify(row));
  ck("Lead Coach gets full edit permissions from their role", !!row && row.can_edit_feedback && row.can_edit_idp && row.can_edit_attendance);
}

// --- 2. Scheduled Support Coach + view permission -> visible -----------
{
  const rows = resolveFor(COACH_JOHN, [LINK_ACTIVE_1]);
  const row = rows.find((r) => r.player_record_id === PLAYER_1.id && r.session_record_id === SESSION_A.id);
  ck("Active linked player + scheduled Support Coach + view permission -> visible", !!row && row.tier === "permanent", JSON.stringify(row));
  ck("Support Coach can edit feedback/attendance but not development plans (role-driven, not tier-driven)", !!row && row.can_edit_feedback === true && row.can_edit_idp === false && row.can_edit_attendance === true, JSON.stringify(row));
}

// --- 3. Scheduled Learning Coach + no view permission -> invisible -----
{
  const rows = resolveFor(COACH_GEORGE, [LINK_ACTIVE_1]);
  const row = rows.find((r) => r.player_record_id === PLAYER_1.id && r.session_record_id === SESSION_A.id);
  ck("Active linked player + scheduled Learning Coach + no view permission -> invisible", !row, JSON.stringify(rows));
}

// --- 4. Player-view permission but NOT scheduled on that session -------
{
  const rows = resolveFor(COACH_SARAH, [LINK_ACTIVE_1]);
  const row = rows.find((r) => r.player_record_id === PLAYER_1.id && r.session_record_id === SESSION_A.id);
  ck("Coach with player permission but NOT scheduled on that session -> invisible", !row, JSON.stringify(rows));
}

// --- 5. Player linked to another session -> invisible -------------------
{
  const rows = resolveFor(COACH_DAVID, [LINK_ACTIVE_2]); // David is scheduled on E01 (sessA), not E02 (sessB)
  const row = rows.find((r) => r.player_record_id === PLAYER_2.id && r.session_record_id === SESSION_B.id);
  ck("Player linked to another session (coach not scheduled there) -> invisible", !row, JSON.stringify(rows));
}

// --- 6. Management -> admin access remains ------------------------------
{
  const rows = resolvePlayerAccess({
    role: "management",
    coachRecordId: null,
    coachNameKeys: new Set<string>(),
    coachCapabilities: null,
    players,
    sessions,
    links: [LINK_ACTIVE_1, LINK_ACTIVE_2],
    scheduledCoachNameKeysBySessionId,
    coverSessionIds: new Set(),
    today: TODAY,
  });
  const row1 = rows.find((r) => r.player_record_id === PLAYER_1.id);
  const row2 = rows.find((r) => r.player_record_id === PLAYER_2.id);
  ck("Management sees both players via admin tier, unaffected by Coach Roles", !!row1 && !!row2 && row1.tier === "admin" && row2.tier === "admin", JSON.stringify(rows));
  ck("Management admin tier keeps full edit permissions", !!row1 && row1.can_edit_feedback && row1.can_edit_idp && row1.can_edit_attendance);
}

// --- 7/8. Date-specific cover ------------------------------------------
{
  // George (Learning Coach, not scheduled on E01) covers session A today.
  const coverSessionIds = new Set([SESSION_A.id]);
  const rowsGeorge = resolveFor(COACH_GEORGE, [LINK_ACTIVE_1], coverSessionIds);
  ck("Date-specific cover + role WITHOUT player permission -> no player access", !rowsGeorge.some((r) => r.player_record_id === PLAYER_1.id), JSON.stringify(rowsGeorge));

  // Sarah (Lead Coach, not scheduled on E01) covers session A today instead.
  const rowsSarah = resolveFor(COACH_SARAH, [LINK_ACTIVE_1], coverSessionIds);
  const row = rowsSarah.find((r) => r.player_record_id === PLAYER_1.id);
  ck("Date-specific cover + permitted role -> appropriate (cover-tier) access", !!row && row.tier === "cover" && row.can_edit_feedback === true, JSON.stringify(row));
}

// --- 9. Former access: Coaches At End + 28-day expiry -------------------
{
  const linkEndedRecent = { id: "linkEnded1", fields: { Player: [PLAYER_1.id], Session: [SESSION_A.id], Status: "Ended", "End Date": daysAgoIso(10), "Coaches At End": [COACH_DAVID.id] } };
  const linkEndedExpired = { id: "linkEnded2", fields: { Player: [PLAYER_1.id], Session: [SESSION_A.id], Status: "Ended", "End Date": daysAgoIso(40), "Coaches At End": [COACH_DAVID.id] } };

  const rowsRecent = resolveFor(COACH_DAVID, [linkEndedRecent]);
  const recentRow = rowsRecent.find((r) => r.player_record_id === PLAYER_1.id);
  ck("Former access within the 28-day window is visible via Coaches At End", !!recentRow && recentRow.tier === "former", JSON.stringify(recentRow));
  ck("Former access is always read-mostly (no edit permissions), regardless of the coach's role", !!recentRow && !recentRow.can_edit_feedback && !recentRow.can_edit_idp && !recentRow.can_edit_attendance);

  const rowsExpired = resolveFor(COACH_DAVID, [linkEndedExpired]);
  ck("Former access expires after 28 days", !rowsExpired.some((r) => r.player_record_id === PLAYER_1.id), JSON.stringify(rowsExpired));

  // A coach who was never in Coaches At End (e.g. reassigned onto the
  // session only after the player left) gets nothing from the snapshot,
  // even though John is otherwise a valid, scheduled Support Coach.
  const rowsJohn = resolveFor(COACH_JOHN, [linkEndedRecent]);
  ck("A coach not captured in Coaches At End never inherits former access", !rowsJohn.some((r) => r.player_record_id === PLAYER_1.id), JSON.stringify(rowsJohn));
}

// --- 10. Can View Players=true but Can Add Feedback=false ---------------
{
  // Olivia (Observer role) isn't textually scheduled on E01 in
  // sessionsCsvRows, so give her cover instead to isolate the capability check.
  const rowsCover = resolveFor(COACH_OBS, [{ id: "linkObs2", fields: { Player: [PLAYER_1.id], Session: [SESSION_A.id], Status: "Active" } }], new Set([SESSION_A.id]));
  const row = rowsCover.find((r) => r.player_record_id === PLAYER_1.id);
  ck("Can View Players=true but Can Add Feedback=false -> player is visible", !!row, JSON.stringify(row));
  ck("...but can_edit_feedback is false, so writing feedback must be rejected server-side", !!row && row.can_edit_feedback === false, JSON.stringify(row));
}

// --- 11. Renaming Role Name does not alter permissions -------------------
{
  const beforeCaps = capabilitiesForCoach(COACH_DAVID, roleCapsById);
  const renamedRoleRow = { id: ROLE_LEAD.id, fields: { ...ROLE_LEAD.fields, "Role Name": "Head Coach (renamed)" } };
  const roleCapsAfterRename = roleCapabilitiesById([renamedRoleRow, ROLE_SUPPORT, ROLE_LEARNING, ROLE_OBSERVER]);
  const afterCaps = capabilitiesForCoach(COACH_DAVID, roleCapsAfterRename);
  ck(
    "Renaming Role Name does not alter permissions (matched by record id, not name)",
    JSON.stringify(beforeCaps) === JSON.stringify(afterCaps) && !!afterCaps?.canViewPlayers && !!afterCaps?.canAddFeedback,
    JSON.stringify({ beforeCaps, afterCaps })
  );
}

// --- 12. eligibleCoachIdsForSessionSnapshot ------------------------------
{
  const eligible = eligibleCoachIdsForSessionSnapshot("E01", coachRows, scheduledCoachNameKeysBySessionId, roleCapsById);
  ck("Snapshot includes scheduled coaches with Can View Players=true (David, John)", eligible.includes(COACH_DAVID.id) && eligible.includes(COACH_JOHN.id), JSON.stringify(eligible));
  ck("Snapshot excludes a scheduled coach without Can View Players (George)", !eligible.includes(COACH_GEORGE.id), JSON.stringify(eligible));
  ck("Snapshot excludes a coach not scheduled on this session at all (Sarah)", !eligible.includes(COACH_SARAH.id), JSON.stringify(eligible));
  ck("Snapshot excludes an inactive Coach record even if textually scheduled+eligible (Ian)", !eligible.includes(COACH_INACTIVE.id), JSON.stringify(eligible));
  ck("Snapshot is never the whole roster - Observer (not scheduled on E01) is excluded", !eligible.includes(COACH_OBS.id), JSON.stringify(eligible));

  // Coaches-At-End snapshot for E03 only resolves COACH_DAVID_ALIAS when
  // its Supabase display_name is supplied - proves eligibleCoachIdsFor-
  // SessionSnapshot's optional displayNameByCoachId parameter actually
  // participates in identity matching, not just resolvePlayerAccess().
  const eligibleE03NoDisplayName = eligibleCoachIdsForSessionSnapshot("E03", coachRows, scheduledCoachNameKeysBySessionId, roleCapsById);
  ck("Without a known display_name, a coach onboarded under an unrelated Coach Name doesn't match the schedule", !eligibleE03NoDisplayName.includes(COACH_DAVID_ALIAS.id), JSON.stringify(eligibleE03NoDisplayName));

  const eligibleE03WithDisplayName = eligibleCoachIdsForSessionSnapshot("E03", coachRows, scheduledCoachNameKeysBySessionId, roleCapsById, { [COACH_DAVID_ALIAS.id]: COACH_DAVID_ALIAS_DISPLAY_NAME });
  ck("With display_name resolved, the same coach is captured in the Coaches At End snapshot", eligibleE03WithDisplayName.includes(COACH_DAVID_ALIAS.id), JSON.stringify(eligibleE03WithDisplayName));
}

// --- 13. Coach identity resolution via display_name (real David scenario) ---
{
  // Mirrors production: an Airtable Coach Name ("davidcole.surrey") that
  // shares nothing with the schedule identity ("David2"), resolved only
  // through the coach's Supabase profiles.display_name - never a
  // hardcoded STATIC_COACH_ALIASES pair.
  const keysNoDisplayName = coachIdentityKeys(COACH_DAVID_ALIAS, null);
  ck("Without display_name, 'davidcole.surrey' does not resolve to the schedule name 'David2'", !keysNoDisplayName.has("david2"), JSON.stringify([...keysNoDisplayName]));

  const keysWithDisplayName = coachIdentityKeys(COACH_DAVID_ALIAS, COACH_DAVID_ALIAS_DISPLAY_NAME);
  ck("With display_name 'David2' supplied, coachIdentityKeys includes it alongside the Coach Name", keysWithDisplayName.has("david2") && keysWithDisplayName.has("davidcole.surrey"), JSON.stringify([...keysWithDisplayName]));

  // End-to-end through resolvePlayerAccess(): scheduled on E03 as
  // "David2", linked player only becomes visible once display_name is
  // known to the resolver, exactly mirroring how resolveCaller() passes
  // profiles.display_name through in the real Edge Functions.
  const linkOnE03 = { id: "linkE03", fields: { Player: [PLAYER_1.id], Session: [SESSION_C.id], Status: "Active" } };
  const rowsNoDisplayName = resolveFor(COACH_DAVID_ALIAS, [linkOnE03], new Set(), null);
  ck("Coach with unrelated Coach Name + no display_name known -> not scheduled, invisible", !rowsNoDisplayName.some((r) => r.player_record_id === PLAYER_1.id), JSON.stringify(rowsNoDisplayName));

  const rowsWithDisplayName = resolveFor(COACH_DAVID_ALIAS, [linkOnE03], new Set(), COACH_DAVID_ALIAS_DISPLAY_NAME);
  const row = rowsWithDisplayName.find((r) => r.player_record_id === PLAYER_1.id);
  ck("Same coach + display_name resolved -> matches the schedule identity, visible as 'permanent'", !!row && row.tier === "permanent", JSON.stringify(row));

  ck("Matching is case/whitespace-insensitive, not fragile string equality", coachIdentityKeys(COACH_DAVID, "  DAVID  ").has(nameKeyOf("david")), true);
}

// tiny local helper - avoids importing nameKey just for this one assertion
function nameKeyOf(s: string): string {
  return s.trim().toLowerCase();
}

// --- 14. legacyFallbackPerms obeys the Coach Role capability model ------
{
  const learningCaps = capabilitiesForCoach(COACH_GEORGE, roleCapsById); // Learning Coach: Can View Players = false
  ck("Learning Coach (Can View Players=false) -> legacyFallbackPerms returns null (no legacy access at all)", legacyFallbackPerms(learningCaps) === null, JSON.stringify(learningCaps));

  const leadCaps = capabilitiesForCoach(COACH_DAVID, roleCapsById); // Lead Coach: all capabilities true
  const leadLegacyPerms = legacyFallbackPerms(leadCaps);
  ck("Lead Coach (Can View Players=true) -> legacyFallbackPerms returns a role-derived permissions object", !!leadLegacyPerms && leadLegacyPerms.can_edit_feedback === true && leadLegacyPerms.can_edit_idp === true && leadLegacyPerms.can_edit_attendance === true, JSON.stringify(leadLegacyPerms));

  const supportCaps = capabilitiesForCoach(COACH_JOHN, roleCapsById); // Support Coach: view/feedback/attendance true, dev plans false
  const supportLegacyPerms = legacyFallbackPerms(supportCaps);
  ck("Support Coach's legacy perms mirror their role exactly (feedback/attendance true, dev plans false)", !!supportLegacyPerms && supportLegacyPerms.can_edit_feedback === true && supportLegacyPerms.can_edit_idp === false && supportLegacyPerms.can_edit_attendance === true, JSON.stringify(supportLegacyPerms));

  ck("No capabilities at all (no linked/active Coach Role) -> legacyFallbackPerms returns null", legacyFallbackPerms(null) === null);

  const noViewCaps: CoachRoleCapabilities = { active: true, canViewPlayers: false, canAddFeedback: true, canEditDevelopmentPlans: true, canRecordAttendance: true };
  ck("Can View Players=false always returns null regardless of other capabilities being true", legacyFallbackPerms(noViewCaps) === null, JSON.stringify(noViewCaps));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
