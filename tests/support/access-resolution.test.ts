// Unit tests for the canonical player-access resolver (see
// tests/support/player-access.ts, a hand-kept copy of the real
// player-access.ts deployed into hub-content/player-feedback/
// player-sessions). Run directly, not through Playwright/HTTP mocks -
// these exercise resolvePlayerAccess()/eligibleCoachIdsForSessionSnapshot()
// with plain Airtable-shaped fixture data, so a mistake in the resolver
// itself fails here even if every HTTP-mocked e2e test still passes.
import {
  buildScheduledCoachNameKeysBySessionId,
  canonicalCoachNameKey,
  capabilitiesForCoach,
  eligibleCoachIdsForSessionSnapshot,
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

const coachRows = [COACH_DAVID, COACH_JOHN, COACH_GEORGE, COACH_SARAH, COACH_OBS, COACH_INACTIVE];

const SESSION_A = { id: "sessA", fields: { "Session ID": "E01", "Session Name": "Monday Academy", Active: true } };
const SESSION_B = { id: "sessB", fields: { "Session ID": "E02", "Session Name": "Wednesday Development Centre", Active: true } };
const sessions = [SESSION_A, SESSION_B];

const PLAYER_1 = { id: "p1", fields: { "Player Name": "Archie", "Player ID": "PLY-1" } };
const PLAYER_2 = { id: "p2", fields: { "Player Name": "Bella", "Player ID": "PLY-2" } };
const players = [PLAYER_1, PLAYER_2];

// David, John and George (via "Jack" -> "Jacko"-style alias is tested
// separately below) are scheduled on E01 per the Sessions Google Sheet.
// Inactive-coach "Ian" is also textually scheduled, to prove Active=false
// still excludes him from the former-access eligibility snapshot.
const sessionsCsvRows = [
  { session_id: "E01", coaches: "David, John, George, Ian" },
  { session_id: "E02", coaches: "Sarah" },
];

const roleCapsById = roleCapabilitiesById(coachRoleRows);
const scheduledCoachNameKeysBySessionId = buildScheduledCoachNameKeysBySessionId(sessionsCsvRows);

const LINK_ACTIVE_1 = { id: "link1", fields: { Player: [PLAYER_1.id], Session: [SESSION_A.id], Status: "Active" } };
const LINK_ACTIVE_2 = { id: "link2", fields: { Player: [PLAYER_2.id], Session: [SESSION_B.id], Status: "Active" } };

function resolveFor(coach: any, links: any[], coverSessionIds = new Set<string>()) {
  const coachNameKey = coach ? coach.fields["Coach Name"].trim().toLowerCase() : "";
  const coachCapabilities = capabilitiesForCoach(coach, roleCapsById);
  return resolvePlayerAccess({
    role: "coach",
    coachRecordId: coach ? coach.id : null,
    coachNameKey,
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
    coachNameKey: "",
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

// --- 12. eligibleCoachIdsForSessionSnapshot (Part 5) ---------------------
{
  const eligible = eligibleCoachIdsForSessionSnapshot("E01", coachRows, scheduledCoachNameKeysBySessionId, roleCapsById);
  ck("Snapshot includes scheduled coaches with Can View Players=true (David, John)", eligible.includes(COACH_DAVID.id) && eligible.includes(COACH_JOHN.id), JSON.stringify(eligible));
  ck("Snapshot excludes a scheduled coach without Can View Players (George)", !eligible.includes(COACH_GEORGE.id), JSON.stringify(eligible));
  ck("Snapshot excludes a coach not scheduled on this session at all (Sarah)", !eligible.includes(COACH_SARAH.id), JSON.stringify(eligible));
  ck("Snapshot excludes an inactive Coach record even if textually scheduled+eligible (Ian)", !eligible.includes(COACH_INACTIVE.id), JSON.stringify(eligible));
  ck("Snapshot is never the whole roster - Observer (not scheduled on E01) is excluded", !eligible.includes(COACH_OBS.id), JSON.stringify(eligible));
}

// --- 13. Coach name matching / aliases (Part 6) ---------------------------
{
  ck("'Jack' on the schedule resolves to the same key as Coach Name 'Jacko'", canonicalCoachNameKey("Jack") === canonicalCoachNameKey("Jacko"), canonicalCoachNameKey("Jack"));
  const withAlias = buildScheduledCoachNameKeysBySessionId([{ session_id: "E09", coaches: "Jack, David" }]);
  ck("buildScheduledCoachNameKeysBySessionId resolves 'Jack' through the alias before storing it", withAlias["E09"].has(canonicalCoachNameKey("Jacko")) && !withAlias["E09"].has("jack"), JSON.stringify([...withAlias["E09"]]));
  ck("Matching is case/whitespace-insensitive, not fragile string equality", canonicalCoachNameKey("  DAVID  ") === canonicalCoachNameKey("david"));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
