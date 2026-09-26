// The parent-link repair, as its own copy of the logic now in
// functions-test/parent-hub/index.ts (same duplication convention as
// player-access.ts).
//
// The live failure: Airtable renamed "Link Status" to "LEGACY — Link
// Status" and added the canonical "Link Lifecycle Status". The code read
// only the old name, got undefined for every row, and defaulted it to
// "Pending" - so a Verified link never granted access, and an Ended link
// was indistinguishable from a pending claim and still surfaced the
// child's name.
const LEGACY = "LEGACY — Link Status";
const CANON = "Link Lifecycle Status";

function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function linkStatus(fields: Record<string, any>): string {
  return selectName(fields[CANON]) || selectName(fields[LEGACY]) || selectName(fields["Link Status"]) || "Pending";
}
function isEndedLink(fields: Record<string, any>): boolean {
  return linkStatus(fields) === "Ended";
}

/** Mirrors verifiedPlayerIds: only Verified links of THIS parent grant anything. */
function verifiedPlayerIds(rows: any[], parentId: string): Set<string> {
  const ids = new Set<string>();
  for (const l of rows) {
    if (!(l.fields["Parent / Guardian"] || []).includes(parentId)) continue;
    if (linkStatus(l.fields) !== "Verified") continue;
    for (const pid of l.fields["Player"] || []) ids.add(pid);
  }
  return ids;
}

/** Mirrors handleParentMe's loop: Ended is dropped before anything is built. */
function buildParentMe(rows: any[], parentId: string, nameOf: (id: string) => string) {
  const children: any[] = [];
  const pendingClaims: any[] = [];
  for (const link of rows) {
    if (!(link.fields["Parent / Guardian"] || []).includes(parentId)) continue;
    if (isEndedLink(link.fields)) continue;
    const status = linkStatus(link.fields);
    const playerId = (link.fields["Player"] || [])[0];
    if (status === "Verified" && playerId) children.push({ name: nameOf(playerId) });
    else pendingClaims.push({ player_name: playerId ? nameOf(playerId) : "Claim submitted", status });
  }
  return { children, pending_claims: pendingClaims };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const PARENT = "recParentA";
const EX = "recParentEnded";
const names: Record<string, string> = { recArchie: "Archie Atkinson", recBella: "Bella Brown", recCharlie: "Charlie Clarke" };
const nameOf = (id: string) => names[id] || "";

// Exactly the shape of the test base: canonical field set, legacy field
// left behind with a stale value.
const rows = [
  { id: "l1", fields: { "Parent / Guardian": [PARENT], Player: ["recArchie"], [CANON]: "Verified", [LEGACY]: "Verified" } },
  { id: "l2", fields: { "Parent / Guardian": [PARENT], Player: ["recBella"], [CANON]: "Pending", [LEGACY]: "Pending" } },
  { id: "l3", fields: { "Parent / Guardian": [EX], Player: ["recCharlie"], [CANON]: "Ended", [LEGACY]: "Verified" } },
];

{
  const ids = verifiedPlayerIds(rows, PARENT);
  ck("A Verified link is now recognised and grants access", ids.has("recArchie"));
  ck("A Pending link still grants nothing", !ids.has("recBella"));
  ck("An Ended link grants nothing, even though its legacy value says Verified",
    !verifiedPlayerIds(rows, EX).has("recCharlie"));
}
{
  const me = buildParentMe(rows, PARENT, nameOf);
  ck("The verified child appears as a child, not a claim", me.children.length === 1 && me.children[0].name === "Archie Atkinson");
  ck("The pending claim is still shown", me.pending_claims.length === 1 && me.pending_claims[0].player_name === "Bella Brown");
  ck("...and is still labelled Pending", me.pending_claims[0].status === "Pending");
}
{
  // The disclosure this repair exists for.
  const me = buildParentMe(rows, EX, nameOf);
  ck("The ended parent gets no children", me.children.length === 0);
  ck("...and no claim row either", me.pending_claims.length === 0);
  const blob = JSON.stringify(me);
  ck("...so the child's name appears nowhere in the response", blob.indexOf("Charlie") === -1, blob);
}
{
  // Ordering matters: canonical wins over a stale legacy value.
  ck("Canonical Ended beats a stale legacy Verified", linkStatus(rows[2].fields) === "Ended");
  ck("A row with only the legacy field still reads correctly",
    linkStatus({ [LEGACY]: "Verified" }) === "Verified");
  ck("A row with only the pre-rename name still reads correctly",
    linkStatus({ "Link Status": "Verified" }) === "Verified");
  ck("A row with nothing set defaults to Pending, never Verified",
    linkStatus({}) === "Pending");
  ck("An Airtable {id,name} select object is handled, not stringified",
    linkStatus({ [CANON]: { id: "sel1", name: "Verified" } }) === "Verified");
}
{
  // An ended link must not block the parent claiming that child again.
  const open = rows.filter((l) =>
    (l.fields["Parent / Guardian"] || []).includes(EX) &&
    !["Rejected", "Ended"].includes(linkStatus(l.fields)));
  ck("An ended link no longer blocks a fresh claim for that child", open.length === 0);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
