// Unit tests for the safe Coach Decline flow in approve-coach/index.ts.
// Declining used to write role = "rejected", which the database rejects
// outright: profiles_role_check only permits pending/management/coach/
// parent. A decline now keeps role = "pending" and sets active = false,
// so nothing is destroyed and Approve can restore the account later.
// This is this test file's own copy of the exact logic now deployed
// (same duplication convention as player-access.ts).
interface ProfileRow { user_id: string; role: string; active: boolean; airtable_person_id: string | null; created_at?: string }

// Mirrors handlePending()'s .eq("role","pending").eq("active",true).
// Both conditions matter: a declined signup keeps role "pending", so
// filtering on the role alone would leave it in the approval queue.
function pendingQueue(rows: ProfileRow[]) {
  return rows.filter((r) => r.role === "pending" && r.active === true);
}

// Mirrors handleDecline(): the profile update and the guard in front of it.
function declineProfile(rows: ProfileRow[], targetUserId: string) {
  const profile = rows.find((r) => r.user_id === targetUserId);
  if (!profile) return { status: 404, body: { error: "Profile not found" } };
  if (profile.role !== "pending") {
    return { status: 400, body: { error: `Only a pending coach signup can be declined (current role: "${profile.role}").` } };
  }
  profile.active = false;
  profile.airtable_person_id = null;
  return { status: 200, body: { ok: true, status: "declined" } };
}

// Mirrors handleApprove()'s profile guard and its final profile update.
function approveProfile(rows: ProfileRow[], targetUserId: string, coachRecordId: string) {
  const profile = rows.find((r) => r.user_id === targetUserId);
  if (!profile) return { status: 404, body: { error: "Profile not found" } };
  if (profile.role !== "pending" && profile.role !== "coach") {
    return { status: 400, body: { error: `Refusing to approve a profile with role "${profile.role}" as a coach.` } };
  }
  profile.role = "coach";
  profile.active = true;
  profile.airtable_person_id = coachRecordId;
  return { status: 200, body: { ok: true, airtable_person_id: coachRecordId } };
}

// Mirrors handleApprove()'s Airtable lookup key. Airtable's
// filterByFormula compare is case-sensitive, so a stray capital at
// signup would otherwise miss an existing Coach record and create a
// second one for the same person.
function lookupEmail(rawEmail: string | null | undefined) {
  return String(rawEmail || "").trim().toLowerCase();
}

// Mirrors /me's status field and onSignedIn()'s gate order in auth.js.
// The inactive check runs FIRST: a declined signup still has role
// "pending", so checking the role first would show a declined coach
// "Waiting for approval" instead of "Account not approved".
function meStatus(profile: ProfileRow) {
  return profile.active ? "active" : "inactive";
}
function signInScreen(profile: ProfileRow) {
  if (meStatus(profile) === "inactive") return "Account not approved";
  if (profile.role === "pending") return "Waiting for approval";
  return "hub";
}

const ROLE_CHECK = ["pending", "management", "coach", "parent"];

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}
function profile(over: Partial<ProfileRow> = {}): ProfileRow {
  return { user_id: "u1", role: "pending", active: true, airtable_person_id: null, ...over };
}

{
  // The bug that broke Decline in production: "rejected" is not a role
  // the database will accept, so it must never be written.
  ck("'rejected' is not an allowed profiles role", ROLE_CHECK.indexOf("rejected") === -1);
  const rows = [profile({ user_id: "u1", airtable_person_id: "recCoach1" })];
  declineProfile(rows, "u1");
  ck("Declining keeps role 'pending', never 'rejected'", rows[0].role === "pending", rows[0].role);
  ck("Declining writes a role the constraint allows", ROLE_CHECK.indexOf(rows[0].role) !== -1);
  ck("Declining deactivates the profile", rows[0].active === false);
  ck("Declining clears the Airtable person link", rows[0].airtable_person_id === null);
}
{
  const rows = [
    profile({ user_id: "u1" }),
    profile({ user_id: "u2" }),
    profile({ user_id: "u3", role: "coach" }),
  ];
  ck("The pending queue starts with both pending signups", pendingQueue(rows).length === 2);
  declineProfile(rows, "u2");
  const queue = pendingQueue(rows);
  ck("A declined signup drops out of the pending queue", queue.length === 1 && queue[0].user_id === "u1", JSON.stringify(queue.map((r) => r.user_id)));
  ck("An approved coach is not in the pending queue either", queue.every((r) => r.role === "pending"));
}
{
  // The queue filter is what hides a decline - role alone would not,
  // because a declined profile is still role "pending".
  const declined = profile({ active: false });
  ck("A declined profile still matches on role", declined.role === "pending");
  ck("...and is hidden only by the active filter", pendingQueue([declined]).length === 0);
}
{
  const rows = [profile({ user_id: "u1" })];
  const res = approveProfile(rows, "u1", "recCoach9");
  ck("Approve still works on a fresh pending signup", res.status === 200);
  ck("Approving promotes the role to 'coach'", rows[0].role === "coach");
  ck("Approving sets active = true", rows[0].active === true);
  ck("Approving links the Airtable Coach record", rows[0].airtable_person_id === "recCoach9");
  ck("An approved coach leaves the pending queue", pendingQueue(rows).length === 0);
}
{
  // Decline must stay reversible: nothing is deleted, so re-approving
  // is the restore path.
  const rows = [profile({ user_id: "u1", airtable_person_id: "recCoach1" })];
  declineProfile(rows, "u1");
  const res = approveProfile(rows, "u1", "recCoach1");
  ck("A declined signup can still be approved afterwards", res.status === 200);
  ck("Re-approving reactivates the account", rows[0].active === true && rows[0].role === "coach");
  ck("Re-approving restores the Airtable link", rows[0].airtable_person_id === "recCoach1");
}
{
  const rows = [profile({ user_id: "u1", role: "coach", airtable_person_id: "recCoach1" })];
  const res = declineProfile(rows, "u1");
  ck("Declining an already-approved coach is refused", res.status === 400, String(res.status));
  ck("...and leaves the coach untouched", rows[0].active === true && rows[0].airtable_person_id === "recCoach1");
  const mgmt = [profile({ user_id: "u2", role: "management" })];
  ck("Declining a management profile is refused", declineProfile(mgmt, "u2").status === 400);
  ck("...and management stays active", mgmt[0].active === true);
}
{
  ck("Declining an unknown user is a 404", declineProfile([], "nope").status === 404);
  const rows = [profile({ user_id: "u1" })];
  declineProfile(rows, "u1");
  const again = declineProfile(rows, "u1");
  ck("Declining twice is idempotent, not an error", again.status === 200, String(again.status));
  ck("...and the profile is still declined, not corrupted", rows[0].active === false && rows[0].role === "pending");
}
{
  const declined = profile({ active: false });
  ck("/me reports a declined profile as inactive", meStatus(declined) === "inactive");
  ck("A declined coach sees 'Account not approved'", signInScreen(declined) === "Account not approved", signInScreen(declined));
  ck("A still-pending coach sees 'Waiting for approval'", signInScreen(profile()) === "Waiting for approval");
  ck("An approved coach reaches the hub", signInScreen(profile({ role: "coach" })) === "hub");
  ck("A declined coach never reaches the hub", signInScreen(declined) !== "hub");
  ck("A deactivated ex-coach is also kept out", signInScreen(profile({ role: "coach", active: false })) === "Account not approved");
  ck("A parent profile is unaffected by the gate", signInScreen(profile({ role: "parent" })) === "hub");
}
{
  ck("Approve lowercases the signup email for the Airtable lookup", lookupEmail("David.Cole@Example.com") === "david.cole@example.com");
  ck("...and trims surrounding whitespace", lookupEmail("  Sam@Example.COM  ") === "sam@example.com");
  ck("...and tolerates a missing email", lookupEmail(null) === "" && lookupEmail(undefined) === "");
  ck("An already-lowercase email is unchanged", lookupEmail("sam@example.com") === "sam@example.com");
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
