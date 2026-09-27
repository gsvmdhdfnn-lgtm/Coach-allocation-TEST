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
  buildOccurrenceStaffByOccurrenceId,
  buildScheduledCoachNameKeysBySessionId,
  buildSessionStaffByCoachAndSession,
  buildSessionStaffById,
  buildSessionStaffBySessionId,
  capabilitiesForCoach,
  coachIdentityKeys,
  coachOwnStandingCapabilities,
  eligibleCoachIdsForSessionSnapshot,
  legacyFallbackPerms,
  resolveOccurrenceStaffing,
  resolvePlayerAccess,
  roleCapabilitiesById,
  roleCapsByRoleName,
  sessionStaffAppliesOnDate,
  sessionStaffCapabilitiesForSession,
  ukTodayIso,
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
const sessionStaffBySessionAndCoach = buildSessionStaffByCoachAndSession(SESSION_STAFF_ROWS);
const TODAY_ISO = ukTodayIso(TODAY);

const LINK_ARCHIE_A = { id: "link1", fields: { Player: [PLAYER_ARCHIE.id], Session: [SESSION_A.id], "Membership Lifecycle Status": "Active" } };
const LINK_DYLAN_B_PAUSED = { id: "link2", fields: { Player: [PLAYER_DYLAN.id], Session: [SESSION_B.id], "Membership Lifecycle Status": "Paused" } };

function resolveFor(coach: any, links: any[], coverSessionIds = new Set<string>()) {
  const coachCoverCapabilities = coach ? coachOwnStandingCapabilities(coach.id, SESSION_STAFF_ROWS, roleCapsById, TODAY) : null;
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
  const staffCaps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_MORGAN.id, TODAY_ISO, sessionStaffBySessionAndCoach, roleCapsById);
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
  const byCoachSession = buildSessionStaffByCoachAndSession(ssInactiveRole);
  const caps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_UNRELATED.id, TODAY_ISO, byCoachSession, roleCapsById);
  ck("A Role Key matching the safelist but whose Coach Roles record is itself inactive grants nothing", caps === null, JSON.stringify(caps));
}

// --- 12. An inactive (Active=false) Session Staff row is never a candidate, on any date ---
{
  const ssInactiveRow = [{ id: "ssY", fields: { Session: [SESSION_A.id], Coach: [COACH_ALEX.id], Role: [ROLE_LEAD.id], Active: false } }];
  // Coaches Slice 2: the row is still KEPT in the map (an Active=false row
  // isn't erased, just never applicable) - the exclusion happens at lookup
  // time via sessionStaffAppliesOnDate(), uniformly with the date checks.
  const byCoachSession = buildSessionStaffByCoachAndSession(ssInactiveRow);
  ck("buildSessionStaffByCoachAndSession() still indexes an Active=false row (filtering is sessionStaffAppliesOnDate()'s job, not the builder's)", (byCoachSession[SESSION_A.id]?.[COACH_ALEX.id] || []).length === 1, JSON.stringify(byCoachSession));
  const caps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_ALEX.id, TODAY_ISO, byCoachSession, roleCapsById);
  ck("...but it never grants access on any date, Active is an absolute administrative off-switch", caps === null, JSON.stringify(caps));
}

// --- 13. coachOwnStandingCapabilities picks the highest-priority eligible role across sessions, as of today ---
{
  // A coach who is Coach on one session and Lead Coach on another - Lead Coach (priority 0) wins as their standing role.
  const mixedRows = [
    { id: "ssMixed1", fields: { Session: [SESSION_A.id], Coach: ["coachMixed"], Role: [ROLE_COACH.id], Active: true } },
    { id: "ssMixed2", fields: { Session: [SESSION_B.id], Coach: ["coachMixed"], Role: [ROLE_LEAD.id], Active: true } },
  ];
  const standing = coachOwnStandingCapabilities("coachMixed", mixedRows, roleCapsById, TODAY);
  ck("A coach holding both Coach and Lead Coach roles gets Lead Coach as their standing (highest-priority) role", !!standing && standing.roleKey === "lead_coach", JSON.stringify(standing));
}

// --- Coaches Slice 2: sessionStaffAppliesOnDate() itself, the one shared date rule ---
{
  const base = { Active: true };
  ck("1. Active=true, no date bounds at all -> applies", sessionStaffAppliesOnDate({ fields: { ...base } }, "2026-09-20") === true);
  ck("2. Active=false -> never applies, even with no date bounds", sessionStaffAppliesOnDate({ fields: { Active: false } }, "2026-09-20") === false);
  ck("3. Exactly on Effective From -> applies (inclusive)", sessionStaffAppliesOnDate({ fields: { ...base, "Effective From": "2026-09-07" } }, "2026-09-07") === true);
  ck("4. Exactly on Effective Until -> applies (inclusive)", sessionStaffAppliesOnDate({ fields: { ...base, "Effective Until": "2026-09-20" } }, "2026-09-20") === true);
  ck("5. One day before Effective From -> excluded", sessionStaffAppliesOnDate({ fields: { ...base, "Effective From": "2026-09-07" } }, "2026-09-06") === false);
  ck("6. One day after Effective Until -> excluded", sessionStaffAppliesOnDate({ fields: { ...base, "Effective Until": "2026-09-20" } }, "2026-09-21") === false);
  ck("7. Open-ended Effective From (blank Until) -> applies far in the future", sessionStaffAppliesOnDate({ fields: { ...base, "Effective From": "2026-09-07" } }, "2030-01-01") === true);
  ck("8. Open-ended Effective Until (blank From) -> applies far in the past", sessionStaffAppliesOnDate({ fields: { ...base, "Effective Until": "2026-09-20" } }, "2000-01-01") === true);
  ck("Both bounds set, a date inside the inclusive range -> applies", sessionStaffAppliesOnDate({ fields: { ...base, "Effective From": "2026-09-07", "Effective Until": "2026-09-20" } }, "2026-09-14") === true);
  ck("13a. Malformed Effective From (not YYYY-MM-DD) -> fails closed, excluded rather than treated as open", sessionStaffAppliesOnDate({ fields: { ...base, "Effective From": "not-a-date" } }, "2026-09-20") === false);
  ck("13b. Malformed Effective Until -> fails closed, excluded rather than treated as open", sessionStaffAppliesOnDate({ fields: { ...base, "Effective Until": "20/09/2026" } }, "2026-09-20") === false);
  ck("13c. A non-string Effective From (e.g. a stray number) -> fails closed", sessionStaffAppliesOnDate({ fields: { ...base, "Effective From": 20260907 as any } }, "2026-09-20") === false);
}

// --- Coaches Slice 2: planned recurring handover through the real resolver (Danny -> Tom -> Joe) ---
{
  const COACH_DANNY = { id: "coachDanny", fields: { "Coach Name": "Danny Handover" } };
  const COACH_TOM = { id: "coachTom", fields: { "Coach Name": "Tom Handover" } };
  const COACH_JOE = { id: "coachJoe", fields: { "Coach Name": "Joe Handover" } };
  const handoverRows = [
    { id: "ssDanny", fields: { Session: [SESSION_A.id], Coach: [COACH_DANNY.id], Role: [ROLE_LEAD.id], Active: true, "Effective From": "2026-09-07", "Effective Until": "2026-09-20" } },
    { id: "ssTom", fields: { Session: [SESSION_A.id], Coach: [COACH_TOM.id], Role: [ROLE_LEAD.id], Active: true, "Effective From": "2026-09-21", "Effective Until": "2026-10-04" } },
    { id: "ssJoe", fields: { Session: [SESSION_A.id], Coach: [COACH_JOE.id], Role: [ROLE_LEAD.id], Active: true, "Effective From": "2026-10-05" } },
  ];
  const byCoachSession = buildSessionStaffByCoachAndSession(handoverRows);
  const capsOn = (coachId: string, dateIso: string) => sessionStaffCapabilitiesForSession(SESSION_A.id, coachId, dateIso, byCoachSession, roleCapsById);

  ck("9a. 14 Sep (inside Danny's window) -> Danny has access, Tom/Joe do not", !!capsOn(COACH_DANNY.id, "2026-09-14") && !capsOn(COACH_TOM.id, "2026-09-14") && !capsOn(COACH_JOE.id, "2026-09-14"));
  ck("9b. 20 Sep (Danny's own Effective Until, inclusive) -> still Danny", !!capsOn(COACH_DANNY.id, "2026-09-20") && !capsOn(COACH_TOM.id, "2026-09-20"));
  ck("9c. 21 Sep (Tom's own Effective From, inclusive) -> Tom, no longer Danny", !capsOn(COACH_DANNY.id, "2026-09-21") && !!capsOn(COACH_TOM.id, "2026-09-21"));
  ck("9d. 28 Sep (inside Tom's window) -> Tom only", !!capsOn(COACH_TOM.id, "2026-09-28") && !capsOn(COACH_DANNY.id, "2026-09-28") && !capsOn(COACH_JOE.id, "2026-09-28"));
  ck("9e. 5 Oct (Joe's open-ended start) -> Joe, no longer Tom", !!capsOn(COACH_JOE.id, "2026-10-05") && !capsOn(COACH_TOM.id, "2026-10-05"));
  ck("9f. Far future (Joe open-ended) -> still Joe", !!capsOn(COACH_JOE.id, "2030-01-01"));

  // --- 10. Deliberate overlap: Danny + Tom both valid for one shared date ---
  const overlapRows = [
    { id: "ssDannyOverlap", fields: { Session: [SESSION_B.id], Coach: [COACH_DANNY.id], Role: [ROLE_LEAD.id], Active: true, "Effective From": "2026-09-07", "Effective Until": "2026-09-21" } },
    { id: "ssTomOverlap", fields: { Session: [SESSION_B.id], Coach: [COACH_TOM.id], Role: [ROLE_COACH.id], Active: true, "Effective From": "2026-09-15", "Effective Until": "2026-09-28" } },
  ];
  const byCoachSessionOverlap = buildSessionStaffByCoachAndSession(overlapRows);
  const overlapCapsOn = (coachId: string, dateIso: string) => sessionStaffCapabilitiesForSession(SESSION_B.id, coachId, dateIso, byCoachSessionOverlap, roleCapsById);
  ck("10. On the shared overlap date (20 Sep), BOTH Danny and Tom resolve - overlap is valid, not rejected", !!overlapCapsOn(COACH_DANNY.id, "2026-09-20") && !!overlapCapsOn(COACH_TOM.id, "2026-09-20"));

  // --- 11 (reconfirmed in the handover/overlap context): Learning Coach still excluded regardless of dating ---
  const learningHandoverRows = [
    { id: "ssLearningDated", fields: { Session: [SESSION_A.id], Coach: [COACH_MORGAN.id], Role: [ROLE_LEARNING.id], Active: true, "Effective From": "2026-09-07", "Effective Until": "2026-09-20" } },
  ];
  const byCoachSessionLearning = buildSessionStaffByCoachAndSession(learningHandoverRows);
  ck("11. A Learning Coach row that is perfectly date-valid still grants no player access", sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_MORGAN.id, "2026-09-14", byCoachSessionLearning, roleCapsById) === null);
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

// --- Coaches Slice 3: Occurrence Staff date-specific resolution ---
// Danny holds a normal, open-ended Session Staff row on SESSION_A. Every
// block below builds its own throwaway occurrence id and its own
// Occurrence Staff row set - never shared across blocks - so "only
// affects one occurrence" is provable by simply never passing one
// block's rows into another block's resolveOccurrenceStaffing() call.
const roleCapsByNameMap = roleCapsByRoleName(coachRoleRows);
const COACH_JOE_OS = { id: "coachJoeOS", fields: { "Coach Name": "Joe Occurrence" } };
const SS_DANNY_NORMAL = { id: "ssOccDanny", fields: { Session: [SESSION_A.id], Coach: [COACH_ALEX.id], Role: [ROLE_LEAD.id], Active: true } };
const sessionStaffRowsForSessionA = [SS_DANNY_NORMAL];
const sessionStaffByIdOS = buildSessionStaffById(sessionStaffRowsForSessionA);
const DATE = "2026-10-10";

// --- 1. No Occurrence Staff at all -> identical to plain Session Staff resolution (Slice 2 unchanged) ---
{
  const withEmptyContext = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_ALEX.id, DATE, sessionStaffBySessionAndCoach, roleCapsById, {
    occurrenceStaffRows: [],
    sessionStaffRowsForSession: sessionStaffRowsForSessionA,
    sessionStaffById: sessionStaffByIdOS,
    roleCapsByNameMap,
  });
  const withNoContext = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_ALEX.id, DATE, sessionStaffBySessionAndCoach, roleCapsById);
  ck("1. No Occurrence Staff rows for the occurrence -> resolves identically to plain Session Staff (Slice 2)", withEmptyContext?.roleKey === "lead_coach" && withEmptyContext?.roleKey === withNoContext?.roleKey, JSON.stringify({ withEmptyContext, withNoContext }));
}

// --- 2 & 5. Additive Occurrence Staff affects only its own occurrence; recurring coach still resolves elsewhere ---
{
  const occAdditive = { occurrenceStaffRows: [{ id: "osJoeAdd", fields: { Coach: [COACH_JOE_OS.id], "Session Occurrence": ["occAdditive"], "Assignment Type": "Additional", Attendance: "Planned", "Planned Role Snapshot": "Coach" } }], sessionStaffRowsForSession: sessionStaffRowsForSessionA, sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap };

  const rosterOnTarget = resolveOccurrenceStaffing(DATE, sessionStaffRowsForSessionA, occAdditive.occurrenceStaffRows, roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("2a. Additive occurrence: target occurrence resolves BOTH the recurring coach and the added one", rosterOnTarget.length === 2 && rosterOnTarget.some((r) => r.coachId === COACH_ALEX.id) && rosterOnTarget.some((r) => r.coachId === COACH_JOE_OS.id), JSON.stringify(rosterOnTarget));

  const joeCapsOnTarget = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_JOE_OS.id, DATE, sessionStaffBySessionAndCoach, roleCapsById, occAdditive);
  ck("2b. The additive coach gets player access on the target occurrence", !!joeCapsOnTarget && joeCapsOnTarget.roleKey === "coach", JSON.stringify(joeCapsOnTarget));

  const rosterOnOtherOccurrence = resolveOccurrenceStaffing(DATE, sessionStaffRowsForSessionA, [], roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("2c/5. A DIFFERENT occurrence (no Occurrence Staff rows passed) resolves Danny only - the additive row never leaked out", rosterOnOtherOccurrence.length === 1 && rosterOnOtherOccurrence[0].coachId === COACH_ALEX.id, JSON.stringify(rosterOnOtherOccurrence));
  const joeCapsElsewhere = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_JOE_OS.id, DATE, sessionStaffBySessionAndCoach, roleCapsById, { occurrenceStaffRows: [], sessionStaffRowsForSession: sessionStaffRowsForSessionA, sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap });
  ck("2d. The additive coach has NO access on a different occurrence", joeCapsElsewhere === null, JSON.stringify(joeCapsElsewhere));
  const dannyCapsElsewhere = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_ALEX.id, DATE, sessionStaffBySessionAndCoach, roleCapsById);
  ck("5. The recurring coach still resolves on surrounding dates/occurrences, unaffected by another occurrence's addition", !!dannyCapsElsewhere && dannyCapsElsewhere.roleKey === "lead_coach");
}

// --- 3 & 4. Cover/replacement: replacement coach resolves, replaced coach loses occurrence-specific access ---
{
  const occCover = {
    occurrenceStaffRows: [{ id: "osJoeCover", fields: { Coach: [COACH_JOE_OS.id], "Session Occurrence": ["occCover"], "Assignment Type": "Cover", "Session Staff Source": [SS_DANNY_NORMAL.id], "Actual Role Snapshot": "Lead Coach" } }],
    sessionStaffRowsForSession: sessionStaffRowsForSessionA,
    sessionStaffById: sessionStaffByIdOS,
    roleCapsByNameMap,
  };
  const roster = resolveOccurrenceStaffing(DATE, sessionStaffRowsForSessionA, occCover.occurrenceStaffRows, roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("3a. Cover resolves ONLY the covering coach for that occurrence - the replaced coach is removed, not merely shadowed", roster.length === 1 && roster[0].coachId === COACH_JOE_OS.id, JSON.stringify(roster));

  const joeCaps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_JOE_OS.id, DATE, sessionStaffBySessionAndCoach, roleCapsById, occCover);
  ck("3b. The covering coach gets player-data access on the target occurrence", !!joeCaps && joeCaps.roleKey === "lead_coach", JSON.stringify(joeCaps));

  const dannyCapsReplaced = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_ALEX.id, DATE, sessionStaffBySessionAndCoach, roleCapsById, occCover);
  ck("4. The replaced recurring coach does NOT retain access on the occurrence they were covered on, even though their Session Staff row is still Active", dannyCapsReplaced === null, JSON.stringify(dannyCapsReplaced));

  const dannyCapsSurrounding = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_ALEX.id, DATE, sessionStaffBySessionAndCoach, roleCapsById);
  ck("5b. The replaced coach still resolves normally on every OTHER occurrence/date", !!dannyCapsSurrounding && dannyCapsSurrounding.roleKey === "lead_coach");
}

// --- 6 & 7. Lead Coach / Coach via Occurrence Staff both get player access ---
{
  const occLead = { occurrenceStaffRows: [{ id: "osLeadOnly", fields: { Coach: ["coachLeadOnly"], "Session Occurrence": ["occLead"], "Assignment Type": "Additional", "Actual Role Snapshot": "Lead Coach" } }], sessionStaffRowsForSession: [], sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap };
  const leadCaps = sessionStaffCapabilitiesForSession(SESSION_A.id, "coachLeadOnly", DATE, {}, roleCapsById, occLead);
  ck("6. A Lead Coach staffed purely via Occurrence Staff (no Session Staff row at all) gets player access", !!leadCaps && leadCaps.roleKey === "lead_coach", JSON.stringify(leadCaps));

  const occCoach = { occurrenceStaffRows: [{ id: "osCoachOnly", fields: { Coach: ["coachCoachOnly"], "Session Occurrence": ["occCoach"], "Assignment Type": "Additional", "Actual Role Snapshot": "Coach" } }], sessionStaffRowsForSession: [], sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap };
  const coachCaps = sessionStaffCapabilitiesForSession(SESSION_A.id, "coachCoachOnly", DATE, {}, roleCapsById, occCoach);
  ck("7. A Coach staffed purely via Occurrence Staff gets player access", !!coachCaps && coachCaps.roleKey === "coach", JSON.stringify(coachCaps));
}

// --- 8. Learning Coach via Occurrence Staff still gets no player-data access ---
{
  const occLearning = { occurrenceStaffRows: [{ id: "osLearning", fields: { Coach: [COACH_MORGAN.id], "Session Occurrence": ["occLearning"], "Assignment Type": "Additional", "Actual Role Snapshot": "Learning Coach" } }], sessionStaffRowsForSession: [], sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap };
  const morganCaps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_MORGAN.id, DATE, {}, roleCapsById, occLearning);
  ck("8. A Learning Coach staffed via Occurrence Staff still gets no player-data access", morganCaps === null, JSON.stringify(morganCaps));
  // Confirmed at the roster level too: Morgan IS in the resolved roster (they ARE staffing/showable), just with a role that never grants access.
  const roster = resolveOccurrenceStaffing(DATE, [], occLearning.occurrenceStaffRows, roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("8b. Morgan still resolves in the raw roster (usable for display) even though access is denied", roster.length === 1 && roster[0].coachId === COACH_MORGAN.id && roster[0].roleCaps?.roleKey === "learning_coach", JSON.stringify(roster));
}

// --- 11. Inactive/withdrawn (Attendance = Absent) Occurrence Staff never resolves as staffing ---
{
  const occWithdrawn = [{ id: "osWithdrawn", fields: { Coach: [COACH_UNRELATED.id], "Session Occurrence": ["occWithdrawn"], "Assignment Type": "Additional", Attendance: "Absent", "Planned Role Snapshot": "Coach" } }];
  const roster = resolveOccurrenceStaffing(DATE, sessionStaffRowsForSessionA, occWithdrawn, roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("11. Attendance=Absent Occurrence Staff row is ignored entirely, base Session Staff roster is untouched", roster.length === 1 && roster[0].coachId === COACH_ALEX.id, JSON.stringify(roster));
  const caps = sessionStaffCapabilitiesForSession(SESSION_A.id, COACH_UNRELATED.id, DATE, {}, roleCapsById, { occurrenceStaffRows: occWithdrawn, sessionStaffRowsForSession: [], sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap });
  ck("11b. ...and grants no access either", caps === null, JSON.stringify(caps));
}

// --- 12. Invalid/incomplete Occurrence Staff fails closed ---
{
  const noCoachRow = [{ id: "osNoCoach", fields: { "Session Occurrence": ["occBad"], "Assignment Type": "Additional", "Planned Role Snapshot": "Coach" } }];
  const rosterNoCoach = resolveOccurrenceStaffing(DATE, [], noCoachRow, roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("12a. An Occurrence Staff row with no linked Coach never resolves to anyone", rosterNoCoach.length === 0, JSON.stringify(rosterNoCoach));

  const unresolvableRoleRow = [{ id: "osBadRole", fields: { Coach: ["coachGhost"], "Session Occurrence": ["occBad"], "Assignment Type": "Additional" } }];
  const caps = sessionStaffCapabilitiesForSession(SESSION_A.id, "coachGhost", DATE, {}, roleCapsById, { occurrenceStaffRows: unresolvableRoleRow, sessionStaffRowsForSession: [], sessionStaffById: sessionStaffByIdOS, roleCapsByNameMap });
  ck("12b. A Coach with no snapshot role and no resolvable Session Staff Source fails closed - no player access", caps === null, JSON.stringify(caps));
}

// --- 13. Role snapshot precedence: Actual > Planned > Session Staff Source's Role, each level fail-closed on its own ---
{
  const rowActualWins = { fields: { "Actual Role Snapshot": "Coach", "Planned Role Snapshot": "Lead Coach" } };
  const rosterActual = resolveOccurrenceStaffing(DATE, [], [{ id: "osPrecA", fields: { ...rowActualWins.fields, Coach: ["coachPrecA"], "Session Occurrence": ["occPrec"] } }], roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("13a. Actual Role Snapshot takes precedence over Planned when both are present", rosterActual[0]?.roleCaps?.roleKey === "coach", JSON.stringify(rosterActual));

  const rosterPlanned = resolveOccurrenceStaffing(DATE, [], [{ id: "osPrecB", fields: { "Planned Role Snapshot": "Lead Coach", Coach: ["coachPrecB"], "Session Occurrence": ["occPrec"] } }], roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("13b. Planned Role Snapshot is used when Actual is blank", rosterPlanned[0]?.roleCaps?.roleKey === "lead_coach", JSON.stringify(rosterPlanned));

  const sourceRow = { id: "ssPrecSource", fields: { Coach: ["someoneElse"], Role: [ROLE_COACH.id] } };
  const sessionStaffByIdWithSource = { [sourceRow.id]: sourceRow };
  const rosterSource = resolveOccurrenceStaffing(DATE, [], [{ id: "osPrecC", fields: { Coach: ["coachPrecC"], "Session Occurrence": ["occPrec"], "Session Staff Source": [sourceRow.id] } }], roleCapsById, roleCapsByNameMap, sessionStaffByIdWithSource);
  ck("13c. The linked Session Staff Source's own Role is used only when BOTH snapshot fields are blank", rosterSource[0]?.roleCaps?.roleKey === "coach", JSON.stringify(rosterSource));

  const rosterTypo = resolveOccurrenceStaffing(DATE, [], [{ id: "osPrecD", fields: { Coach: ["coachPrecD"], "Session Occurrence": ["occPrec"], "Actual Role Snapshot": "Head Coach (not a real role)" } }], roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("13d. A non-blank but unresolvable Actual Role Snapshot fails closed - never falls through to Planned/Source", rosterTypo[0]?.roleCaps === null, JSON.stringify(rosterTypo));
}

// --- 14. Session Staff Source is optional for a genuinely standalone one-date addition ---
{
  const standaloneRow = [{ id: "osStandalone", fields: { Coach: ["coachStandalone"], "Session Occurrence": ["occStandalone"], "Assignment Type": "Additional", "Planned Role Snapshot": "Coach" } }];
  const roster = resolveOccurrenceStaffing(DATE, [], standaloneRow, roleCapsById, roleCapsByNameMap, sessionStaffByIdOS);
  ck("14. A standalone Additional row with no Session Staff Source at all still resolves normally - the link is not mandatory", roster.length === 1 && roster[0].coachId === "coachStandalone" && roster[0].roleCaps?.roleKey === "coach", JSON.stringify(roster));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
