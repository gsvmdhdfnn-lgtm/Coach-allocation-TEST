// The claim-matching repair, as its own copy of the logic now in
// functions-test/parent-hub/index.ts (same duplication convention as
// player-access.ts).
//
// The live bug: Players.Active was renamed LEGACY - Active with no
// canonical replacement (the agreed decision is that Player active/
// inactive is derived from current memberships, never a standalone
// field). handleCreateClaim's match filter and handleListClaims' picker
// both still gated on p.fields["Active"] === true, which is undefined
// for every real Player row - so no claim EVER matched a real player,
// and the manual-link picker was always empty.
function normalizeName(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function membershipStatus(f: Record<string, any>): string {
  return selectName(f["Membership Lifecycle Status"]) || selectName(f["LEGACY — Status"]) || selectName(f["Status"]) || "";
}

/** Mirrors handleCreateClaim's matches filter. */
function findMatches(allPlayers: any[], playerName: string, dob: string) {
  const norm = normalizeName(playerName);
  return allPlayers.filter((p) => normalizeName(p.fields["Player Name"]) === norm && p.fields["Date of Birth"] === dob);
}

/** Mirrors handleListClaims' derived active flag and full player list. */
function buildPlayerPicker(playerRows: any[], sessionLinkRows: any[]) {
  const hasOpenMembership = new Set<string>();
  for (const l of sessionLinkRows) {
    if (membershipStatus(l.fields) === "Ended") continue;
    for (const pid of l.fields["Player"] || []) hasOpenMembership.add(pid);
  }
  return playerRows
    .map((p) => ({ player_record_id: p.id, player_name: p.fields["Player Name"] || "", active: hasOpenMembership.has(p.id) }))
    .sort((a, b) => a.player_name.localeCompare(b.player_name));
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// A real player table shaped exactly like the TEST base: no "Active"
// field exists at all, only the retired LEGACY one.
const players = [
  { id: "p1", fields: { "Player Name": "Archie Atkinson", "Date of Birth": "2017-04-12", "LEGACY — Active": true } },
  { id: "p2", fields: { "Player Name": "Dylan Davies", "Date of Birth": "2015-06-30", "LEGACY — Active": true } },
  { id: "p3", fields: { "Player Name": "New Signup", "Date of Birth": "2018-01-01" } }, // no memberships at all yet
];
const sessionLinks = [
  { fields: { Player: ["p1"], "Membership Lifecycle Status": "Active" } },
  { fields: { Player: ["p2"], "Membership Lifecycle Status": "Paused" } },
  // p3 has no session link rows at all.
];

{
  const m = findMatches(players, "Archie Atkinson", "2017-04-12");
  ck("A genuine active player matches by name + DOB, with no Active field present", m.length === 1 && m[0].id === "p1");
}
{
  // A player whose only membership status is irrelevant to matching -
  // matching must not care about membership state at all.
  const noMembershipPlayer = [{ id: "p4", fields: { "Player Name": "No Sessions Yet", "Date of Birth": "2019-03-03" } }];
  const m = findMatches(noMembershipPlayer, "No Sessions Yet", "2019-03-03");
  ck("A player with zero memberships still matches - not treated as deleted or unavailable", m.length === 1);
}
{
  const m = findMatches(players, "archie   atkinson", "2017-04-12");
  ck("Matching is still name-normalized (case/whitespace insensitive)", m.length === 1);
}
{
  const m = findMatches(players, "Archie Atkinson", "2099-01-01");
  ck("A name match with the wrong DOB does not match - DOB is still required", m.length === 0);
}
{
  const picker = buildPlayerPicker(players, sessionLinks);
  ck("Every real player appears in the management picker, not just 'active' ones", picker.length === 3);
  ck("An active-membership player is flagged active: true",
    picker.find((p) => p.player_record_id === "p1")!.active === true);
  ck("A paused-membership player still counts as active (not gone, just paused)",
    picker.find((p) => p.player_record_id === "p2")!.active === true);
  ck("A player with no memberships at all is flagged active: false, but still IN the list",
    picker.find((p) => p.player_record_id === "p3")!.active === false);
}
{
  // An ended membership must not count as "open".
  const ended = [{ id: "p5", fields: { "Player Name": "Former Player", "Date of Birth": "2016-05-05" } }];
  const endedLinks = [{ fields: { Player: ["p5"], "Membership Lifecycle Status": "Ended" } }];
  const picker = buildPlayerPicker(ended, endedLinks);
  ck("A player whose only membership Ended is derived inactive", picker[0].active === false);
  ck("...but is STILL in the picker, not excluded", picker.length === 1);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
