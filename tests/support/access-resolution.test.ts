// Unit tests for the canonical player-access resolver (see
// tests/support/player-access.ts, a hand-kept copy of the real
// player-access.ts deployed into hub-content/player-feedback/
// player-sessions). Run directly, not through Playwright/HTTP mocks -
// these exercise resolvePlayerAccess()/eligibleCoachIdsForSessionSnapshot()
// with plain Airtable-shaped fixture data, so a mistake in the resolver
// itself fails here even if every HTTP-mocked e2e test still passes.
//
// Rewritten for the Session Staff-based repair: current-session access
// no longer comes from the Sessions Google Sheet's free-text `coaches`
// column, it comes from the caller's own Active Session Staff row on
// that specific session. Cover access is unchanged (still Changes-sheet
// based). Membership status now reads Membership Lifecycle Status
// (canonical) with LEGACY-name fallbacks, matching parent-hub's own
// membershipStatus(). Former-access snapshot/end-date fields now read
// their current (LEGACY-prefixed) names.
import {
  buildActiveSessionStaffByCoachAndSession,
  buildScheduledCoachNameKeysBySessionId,
  capabilitiesForCoach,
  coachIdentityKeys,
  coachOwnStandingCapabilities,
  eligibleCoachIdsForSessionSnapshot,
  legacyFallbackPerms,
  resolvePlayerAccess,
  roleCapabilitiesById,
  sessionStaffCapabilitiesForSession,
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
// Mirrors the real TEST Coach Roles data exactly: Lead Coach and Coach
// both have Can View Players=true (Coach lacks Can Edit Development
// Plans); Learning Coach ALSO currently has Can View Players=true in the
// real TEST seed data - included here deliberately, unchanged, to prove
// the resolver denies Learning Coach by its role-key safelist, not by
// trusting that checkbox.

const ROLE_LEAD = { id: "roleLead", fields: { "Role Name": "Lead Coach", "Role Key": "lead_coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Edit Development Plans": true, "Can Record Attendance": true, "Can Send Communications": true, "Can View Player Names": true } };
const ROLE_COACH = { id: "roleCoach", fields: { "Role Name": "Coach", "Role Key": "coach", Active: true, "Can View Players": true, "Can Add Feedback": true, "Can Record Attendance": true, "Can View Player Names": true } };
// Matches the real (arguably mis-seeded) TEST data: Learning Coach has
// Can View Players=true. The resolver must still deny it.
const ROLE_LEARNING = { id: "roleLearning", fields: { "Role Name": "Learning Coach", "Role Key": "learning_coach", Active: true, "Can View Players": true, "Can Record Attendance": true } };
// Inactive role: even a Lead-Coach-equivalent key must fail closed if the role itself is switched off.
const ROLE_LEAD_INACTIVE = { id: "roleLeadInactive", fields: { "Role Name": "Lead Coach (retired)", "Role Key": "lead_coach", Active: false, "Can View Players": true } };

const coachRoleRows = [ROLE_LEAD, ROLE_COACH, ROLE_LEARNING, ROLE_LEAD_INACTIVE];
const roleCapsById = roleCapabilitiesById(coachRoleRows);

const COACH_ALEX = { id: "coachAlex", fields: { "Coach Name": "Alex Test", Active: true } }; // Lead Coach on Session A
const COACH_SAM = { id: "coachSam", fields: { "Coach Name": "Sam Sample", Active: true } }; // Coach on Session B
const COACH_MORGAN = { id: "coachMorgan", fields: { "Coach Name": "Morgan Manager", Active: true } }; // Learning Coach on Session A - must see nothing
const COACH_UNRELATED = { id: "coachUnrelated", fields: { "Coach Name": "Uma Unrelated", Active: true } }; // no Session Staff row anywhere

const coachRows = [COACH_ALEX, COACH_SAM, COACH_MORGAN, COACH_UNRELATED];

const SESSION_A = { id: "sessA", fields: { "Session ID": "TEST-A", "Session Name": "Monday Juniors (TEST A)" } };
const SESSION_B = { id: "sessB", fields: { "Session ID": "TEST-B", "Session Name": "Thursday Juniors (TEST B)" } };
const sessions = [SESSION_A, SESSION_B];

const PLAYER_ARCHIE = { id: "pArchie", fields: { "Player Name": "Archie", "Player ID": "PL-1" } };
const PLAYER_DYLAN = { id: "pDylan", fields: { "Player Name": "Dylan", "Player ID": "PL-2" } };
const players = [PLAYER_ARCHIE, PLAYER_DYLAN];

// Session Staff: Alex leads Session A, Sam coaches Session B, Morgan is a
// Learning Coach on Session A too (same session as Alex, different role) -
// mirrors the real TEST Coaches table (Morgan Manager exists, unlinked in
// the real seed; given a row here specifically to test role-gating).
const SESSION_STAFF_ROWS = [
  { id: "ssAlexA", fields: { Session: [SESSION_A.id], Coach: [COACH_ALEX.id], Role: [ROLE_LEAD.id], Active: true } },
  { id: "ssSamB", fields: { Session: [SESSION_B.id], Coach: [COACH_SAM.id], Role: [ROLE_COACH.id], Active: true } },
  { id: "ssMorganA", fields: { Session: [SESSION_A.id], Coach: [COACH_MORGAN.id], Role: [ROLE_LEARNING.id], Active: true } },
];
const sessionStaffBySessionAndCoach = buildActiveSessionStaffByCoachAndSession(SESSION_STAFF_ROWS);

const LINK_ARCHIE_A = { id: "link1", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id], "Membership Lifecycle Status": "Active" } };
const LINK_DYLAN_B_PAUSED = { id: "link2", fields: { Player: [PLAYER_DYLAN.id], Session: [SESSION_B.id], "Membership Lifecycle Status": "Paused" } };

function resolveFor(coach: any, links: any[], coverSessionIds = new Set<string>()) {
  const coachCoverCapabilities = coach ? coachOwnStandingCapabilities(coach.id, SESSION_STAFF_ROWS, roleCapsById) : null;
  return resolvePlayerAccess({
    role: "coach",
    coachRecordId: coach ? coach.id : null,
    coachCoverCapabilities,
    players,
    sessions,
    links,
    sessionStaffBySessionAndCoach,
    roleCapsById,
    coverSessionIds,
    today: TODAY,
  });
}

// --- 1. Lead Coach staffed on the session -> visible, full edit perms ---
{
  const rows = resolveFor(COACH_ALEX, [LINK_ARCHIE_A]);
  const row = rows.find((r) => r.player_record_id === PLAYER_ARCHIE.id && r.session_record_id === SESSION_A.id);
  ck("Lead Coach's own Active Session Staff row grants permanent access", !!row && row.tier === "permanent", JSON.stringify(row));
  ck("Lead Coach gets full edit permissions from their role", !!row && row.can_edit_feedback && row.can_edit_idp && row.can_edit_attendance);
}

// --- 2. Coach role staffed on the session -> visible, partial perms -----
{
  const rows = resolveFor(COACH_SAM, [LINK_DYLAN_B_PAUSED]);
  const row = rows.find((r) => r.player_record_id === PLAYER_DYLAN.id && r.session_record_id === SESSION_B.id);
  ck("Coach role's own Active Session Staff row grants permanent access, even for a Paused membership", !!row && row.tier === "permanent", JSON.stringify(row));
  ck("Coach role can edit feedback/attendance but not development plans (role-driven, not tier-driven)", !!row && row.can_edit_feedback === true && row.can_edit_idp === false && row.can_edit_attendance === true, JSON.stringify(row));
}

// --- 3. Learning Coach staffed on the session -> invisible, by role-key safelist, NOT the checkbox ---
{
  const rows = resolveFor(COACH_MORGAN, [LINK_ARCHIE_A]);
  const row = rows.find((r) => r.player_record_id === PLAYER_ARCHIE.id);
  ck("Learning Coach never receives player access, even though this role's own Can View Players is true", !row, JSON.stringify(rows));
  // Direct check on the gating function itself, isolating the exact rule.
  const staffCaps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_MORGAN.id, sessionStaffBySessionAndCoach, roleCapsById);
  ck("sessionStaffCapabilitiesForSession() returns null for a Learning Coach role despite Can View Players=true on that role", staffCaps === null, JSON.stringify(staffCaps));
}

// --- 4. Coach eligible role but NOT staffed on this session, no cover -> invisible ---
{
  const rows = resolveFor(COACH_SAM, [LINK_ARCHIE_A]); // Sam is Coach on Session B, not staffed on Session A at all
  const row = rows.find((r) => r.player_record_id === PLAYER_ARCHIE.id && r.session_record_id === SESSION_A.id);
  ck("An eligible-role coach with no Session Staff row on this specific session -> invisible", !row, JSON.stringify(rows));
}

// --- 5. Unrelated coach, no Session Staff row anywhere -> invisible -----
{
  const rows = resolveFor(COACH_UNRELATED, [LINK_ARCHIE_A, LINK_DYLAN_B_PAUSED]);
  ck("A coach with no Session Staff row on any session sees nothing", rows.length === 0, JSON.stringify(rows));
}

// --- 6. Management -> admin access remains, canonical status ------------
{
  const rows = resolvePlayerAccess({
    role: "management",
    coachRecordId: null,
    coachCoverCapabilities: null,
    players,
    sessions,
    links: [LINK_ARCHIE_A, LINK_DYLAN_B_PAUSED],
    sessionStaffBySessionAndCoach,
    roleCapsById,
    coverSessionIds: new Set(),
    today: TODAY,
  });
  const row1 = rows.find((r) => r.player_record_id === PLAYER_ARCHIE.id);
  const row2 = rows.find((r) => r.player_record_id === PLAYER_DYLAN.id);
  ck("Management sees both players (Active and Paused) via admin tier, unaffected by Coach Roles", !!row1 && !!row2 && row1.tier === "admin" && row2.tier === "admin", JSON.stringify(rows));
  ck("Management admin tier keeps full edit permissions", !!row1 && row1.can_edit_feedback && row1.can_edit_idp && row1.can_edit_attendance);
}

// --- 7. Cover: an eligible coach's own standing role grants cover-tier access ---
{
  // Sam (Coach on Session B) covers Session A today, where they hold no Session Staff row.
  const coverSessionIds = new Set([SESSION_A.id]);
  const rows = resolveFor(COACH_SAM, [LINK_ARCHIE_A], coverSessionIds);
  const row = rows.find((r) => r.player_record_id === PLAYER_ARCHIE.id);
  ck("Covering a session with no Session Staff row there uses the coach's own standing role -> cover tier", !!row && row.tier === "cover", JSON.stringify(row));
  ck("Cover-tier permissions mirror the covering coach's own standing role (Coach: feedback/attendance, not dev plans)", !!row && row.can_edit_feedback === true && row.can_edit_idp === false, JSON.stringify(row));
}

// --- 8. Cover: a coach with no eligible standing role anywhere -> no cover access ---
{
  // Morgan (Learning Coach only, everywhere) covers Session B today.
  const coverSessionIds = new Set([SESSION_B.id]);
  const rows = resolveFor(COACH_MORGAN, [LINK_DYLAN_B_PAUSED], coverSessionIds);
  ck("A coach whose only standing role is Learning Coach gets nothing from covering, even though they're marked as covering today", rows.length === 0, JSON.stringify(rows));
}

// --- 9. Former access: LEGACY - Coaches At End / LEGACY - End Date, 28-day expiry ---
{
  const linkEndedRecent = { id: "linkEnded1", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id], "Membership Lifecycle Status": "Ended", "LEGACY — End Date": daysAgoIso(10), "LEGACY — Coaches At End": [COACH_ALEX.id] } };
  const linkEndedExpired = { id: "linkEnded2", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id], "Membership Lifecycle Status": "Ended", "LEGACY — End Date": daysAgoIso(40), "LEGACY — Coaches At End": [COACH_ALEX.id] } };

  const rowsRecent = resolveFor(COACH_ALEX, [linkEndedRecent]);
  const recentRow = rowsRecent.find((r) => r.player_record_id === PLAYER_ARCHIE.id);
  ck("Former access within the 28-day window is visible via LEGACY - Coaches At End", !!recentRow && recentRow.tier === "former", JSON.stringify(recentRow));
  ck("Former access is always read-mostly (no edit permissions), regardless of the coach's role", !!recentRow && !recentRow.can_edit_feedback && !recentRow.can_edit_idp && !recentRow.can_edit_attendance);

  const rowsExpired = resolveFor(COACH_ALEX, [linkEndedExpired]);
  ck("Former access expires after 28 days", !rowsExpired.some((r) => r.player_record_id === PLAYER_ARCHIE.id), JSON.stringify(rowsExpired));

  // A coach not captured in the snapshot (e.g. Sam, who was never on Session A) gets nothing, even though they hold an eligible role elsewhere.
  const rowsSam = resolveFor(COACH_SAM, [linkEndedRecent]);
  ck("A coach not captured in LEGACY - Coaches At End never inherits former access", !rowsSam.some((r) => r.player_record_id === PLAYER_ARCHIE.id), JSON.stringify(rowsSam));

  // A coach reassigned onto the session AFTER the player left never inherits the window either, even with a live Session Staff row there now.
  const linkEndedNoSam = { id: "linkEnded3", fields: { Player: [PLAYER_DYLAN.id], Session: [SESSION_B.id], "Membership Lifecycle Status": "Ended", "LEGACY — End Date": daysAgoIso(5), "LEGACY — Coaches At End": [] } };
  const rowsSamOwnSession = resolveFor(COACH_SAM, [linkEndedNoSam]);
  ck("Being currently staffed on the session does not substitute for being in the Coaches At End snapshot", !rowsSamOwnSession.some((r) => r.player_record_id === PLAYER_DYLAN.id), JSON.stringify(rowsSamOwnSession));
}

// --- 10. Membership status fallback chain (canonical -> LEGACY -> pre-rename) ---
{
  const linkCanonicalOnly = { id: "lc1", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id], "Membership Lifecycle Status": "Cancellation Pending" } };
  const rowsCanonical = resolveFor(COACH_ALEX, [linkCanonicalOnly]);
  ck("Cancellation Pending (canonical field) still counts as current, not Ended", rowsCanonical.some((r) => r.player_record_id === PLAYER_ARCHIE.id && r.tier === "permanent"), JSON.stringify(rowsCanonical));

  const linkLegacyOnly = { id: "lc2", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id], "LEGACY — Status": "Active" } };
  const rowsLegacy = resolveFor(COACH_ALEX, [linkLegacyOnly]);
  ck("A base with only LEGACY - Status set (no canonical field) still resolves via fallback", rowsLegacy.some((r) => r.player_record_id === PLAYER_ARCHIE.id && r.tier === "permanent"), JSON.stringify(rowsLegacy));

  const linkNoStatus = { id: "lc3", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id] } };
  const rowsNoStatus = resolveFor(COACH_ALEX, [linkNoStatus]);
  ck("A link with no resolvable status at all grants nothing (fail closed)", rowsNoStatus.length === 0, JSON.stringify(rowsNoStatus));
}

// --- 11. An inactive Coach Role fails closed even with a matching Role Key ---
{
  const ssInactiveRole = [{ id: "ssX", fields: { Session: [SESSION_A.id], Coach: [COACH_UNRELATED.id], Role: [ROLE_LEAD_INACTIVE.id], Active: true } }];
  const byCoachSession = buildActiveSessionStaffByCoachAndSession(ssInactiveRole);
  const caps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_UNRELATED.id, byCoachSession, roleCapsById);
  ck("A Role Key matching the safelist but whose Coach Roles record is itself inactive grants nothing", caps === null, JSON.stringify(caps));
}

// --- 12. An inactive Session Staff row is never a candidate --------------
{
  const ssInactiveRow = [{ id: "ssY", fields: { Session: [SESSION_A.id], Coach: [COACH_ALEX.id], Role: [ROLE_LEAD.id], Active: false } }];
  const byCoachSession = buildActiveSessionStaffByCoachAndSession(ssInactiveRow);
  ck("buildActiveSessionStaffByCoachAndSession() excludes Active=false rows entirely", Object.keys(byCoachSession).length === 0, JSON.stringify(byCoachSession));
}

// --- 13. coachOwnStandingCapabilities picks the highest-priority eligible role across sessions ---
{
  // A coach who is Coach on one session and Lead Coach on another - Lead Coach (priority 0) wins as their standing role.
  const mixedRows = [
    { id: "ssMixed1", fields: { Session: [SESSION_A.id], Coach: ["coachMixed"], Role: [ROLE_COACH.id], Active: true } },
    { id: "ssMixed2", fields: { Session: [SESSION_B.id], Coach: ["coachMixed"], Role: [ROLE_LEAD.id], Active: true } },
  ];
  const standing = coachOwnStandingCapabilities("coachMixed", mixedRows, roleCapsById);
  ck("A coach holding both Coach and Lead Coach roles gets Lead Coach as their standing (highest-priority) role", !!standing && standing.roleKey === "lead_coach", JSON.stringify(standing));
}

// --- 14. legacyFallbackPerms obeys the Coach Role capability model (legacy Assigned Coaches path, unchanged) ---
{
  const learningCapsViaLegacyLink = capabilitiesForCoach({ fields: { "Coach Role": [ROLE_LEARNING.id] } }, roleCapsById);
  const leadCapsViaLegacyLink = capabilitiesForCoach({ fields: { "Coach Role": [ROLE_LEAD.id] } }, roleCapsById);
  ck("legacyFallbackPerms still derives permissions from whatever Coach Role capabilities it's given", !!legacyFallbackPerms(leadCapsViaLegacyLink), JSON.stringify(leadCapsViaLegacyLink));
  ck("No capabilities at all -> legacyFallbackPerms returns null", legacyFallbackPerms(null) === null);
  const noViewCaps: CoachRoleCapabilities = { active: true, roleName: "X", roleKey: "x", canViewPlayers: false, canAddFeedback: true, canEditDevelopmentPlans: true, canRecordAttendance: true };
  ck("Can View Players=false always returns null regardless of other capabilities being true", legacyFallbackPerms(noViewCaps) === null, JSON.stringify(noViewCaps));
  // Confirms this deliberately-untouched path is unaffected by this repair's role-key safelist (legacyFallbackPerms only ever checks canViewPlayers, by design - see its own comment in player-access.ts).
  ck("(unchanged) legacyFallbackPerms does not itself apply the current-session role-key safelist", !!legacyFallbackPerms(learningCapsViaLegacyLink) === (learningCapsViaLegacyLink?.canViewPlayers === true));
}

// --- 15. eligibleCoachIdsForSessionSnapshot (unchanged, Sheet-based) still works against the new CoachRoleCapabilities shape ---
{
  const sessionsCsvRows = [{ session_id: "TEST-A", coaches: "Alex Test, Morgan Manager" }];
  const scheduledCoachNameKeysBySessionId = buildScheduledCoachNameKeysBySessionId(sessionsCsvRows);
  const alexWithLegacyRoleLink = { id: COACH_ALEX.id, fields: { ...COACH_ALEX.fields, "Coach Role": [ROLE_LEAD.id] } };
  const morganWithLegacyRoleLink = { id: COACH_MORGAN.id, fields: { ...COACH_MORGAN.fields, "Coach Role": [ROLE_LEARNING.id] } };
  const eligible = eligibleCoachIdsForSessionSnapshot("TEST-A", [alexWithLegacyRoleLink, morganWithLegacyRoleLink], scheduledCoachNameKeysBySessionId, roleCapsById);
  ck("Snapshot includes a scheduled coach with Can View Players=true via the legacy Coach Role link (Alex)", eligible.includes(COACH_ALEX.id), JSON.stringify(eligible));
  // Note: this untouched function only checks canViewPlayers, not the role-key safelist - Morgan (Learning Coach, Can View Players=true in this fixture) is therefore still included here. This is a pre-existing, out-of-scope gap in eligibleCoachIdsForSessionSnapshot itself (see its own comment in player-access.ts) - documented, not fixed, by this repair.
  ck("(documented gap, not fixed here) the untouched snapshot helper does not apply the role-key safelist, unlike resolvePlayerAccess()", eligible.includes(COACH_MORGAN.id), JSON.stringify(eligible));
}

// --- 16. coachIdentityKeys still resolves cover-tier identity (unchanged mechanism) ---
{
  const keys = coachIdentityKeys(COACH_SAM, "Sam2");
  ck("coachIdentityKeys still includes both Coach Name and a supplied display_name (cover-tier matching unchanged)", keys.has("sam sample") && keys.has("sam2"), JSON.stringify([...keys]));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
