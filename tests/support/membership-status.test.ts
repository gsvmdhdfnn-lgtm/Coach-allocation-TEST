// The membership/session repair, as its own copy of the logic now in
// functions-test/parent-hub/index.ts.
//
// The live failure: Airtable renamed "Status" to "LEGACY — Status" on
// Player Session Links and "Active" to "LEGACY — Active" on Sessions,
// adding canonical Membership Lifecycle Status and Session Lifecycle
// Status. The code read only the old names, so no membership ever matched
// "Active" and a verified child showed no sessions at all.
const LEG_STATUS = "LEGACY — Status";
const LEG_ACTIVE = "LEGACY — Active";
const LEG_END = "LEGACY — End Date";

function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function membershipStatus(f: Record<string, any>): string {
  return selectName(f["Membership Lifecycle Status"]) || selectName(f[LEG_STATUS]) || selectName(f["Status"]) || "";
}
const STILL_ATTENDING = ["Active", "Cancellation Pending", "Ending Scheduled"];
function sessionIsActive(f: Record<string, any>): boolean {
  const canonical = selectName(f["Session Lifecycle Status"]);
  if (canonical) return canonical === "Active";
  if (typeof f[LEG_ACTIVE] === "boolean") return f[LEG_ACTIVE] === true;
  return f["Active"] === true;
}
function split(rows: any[]) {
  return {
    active: rows.filter((l) => STILL_ATTENDING.includes(membershipStatus(l.fields))),
    paused: rows.filter((l) => membershipStatus(l.fields) === "Paused"),
    ended: rows.filter((l) => membershipStatus(l.fields) === "Ended"),
  };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const rows = [
  { id: "m-active", fields: { "Membership Lifecycle Status": "Active", [LEG_STATUS]: "Active" } },
  { id: "m-paused", fields: { "Membership Lifecycle Status": "Paused", [LEG_STATUS]: "Active",
                              "Pause Start Date": "2026-09-15", "Pause Return Date": "2026-10-20" } },
  { id: "m-cancelling", fields: { "Membership Lifecycle Status": "Cancellation Pending", [LEG_STATUS]: "Active" } },
  { id: "m-ending", fields: { "Membership Lifecycle Status": "Ending Scheduled", [LEG_STATUS]: "Active" } },
  { id: "m-ended", fields: { "Membership Lifecycle Status": "Ended", [LEG_STATUS]: "Ended",
                             [LEG_END]: "2026-09-12", "Scheduled End Date": "2026-09-30" } },
];

{
  const s = split(rows);
  ck("An Active membership is a current session", s.active.some((l) => l.id === "m-active"));
  ck("Cancellation Pending stays with current sessions - still attending",
    s.active.some((l) => l.id === "m-cancelling"));
  ck("Ending Scheduled stays with current sessions - still attending",
    s.active.some((l) => l.id === "m-ending"));
  ck("Paused is NOT a current session", !s.active.some((l) => l.id === "m-paused"));
  ck("Paused gets its own bucket", s.paused.length === 1 && s.paused[0].id === "m-paused");
  ck("Ended is NOT a current session", !s.active.some((l) => l.id === "m-ended"));
  ck("Ended gets its own bucket", s.ended.length === 1 && s.ended[0].id === "m-ended");
  ck("Nothing is counted twice", s.active.length + s.paused.length + s.ended.length === rows.length);
}
{
  // The distinction that must not be collapsed.
  const ended = rows.find((r) => r.id === "m-ended")!.fields;
  const actual = ended[LEG_END] || ended["End Date"] || "";
  ck("The ended date reported is the ACTUAL end, not the scheduled one", actual === "2026-09-12", actual);
  ck("...and the scheduled end is reported separately, not instead",
    ended["Scheduled End Date"] === "2026-09-30" && ended["Scheduled End Date"] !== actual);
}
{
  // Reading the old name alone is what broke it.
  ck("Reading only the retired name finds no active membership",
    rows.filter((l) => l.fields["Status"] === "Active").length === 0);
  ck("A row with only the retired field still reads correctly",
    membershipStatus({ [LEG_STATUS]: "Active" }) === "Active");
  ck("A row with only the pre-rename name still reads correctly",
    membershipStatus({ "Status": "Active" }) === "Active");
  ck("Canonical beats a stale legacy value",
    membershipStatus({ "Membership Lifecycle Status": "Paused", [LEG_STATUS]: "Active" }) === "Paused");
  ck("An unset membership is not treated as active",
    !STILL_ATTENDING.includes(membershipStatus({})));
}
{
  ck("A session with canonical status Active is open",
    sessionIsActive({ "Session Lifecycle Status": "Active" }));
  ck("A session with canonical status Inactive is not open",
    !sessionIsActive({ "Session Lifecycle Status": "Inactive", [LEG_ACTIVE]: true }));
  ck("Draft is not open either", !sessionIsActive({ "Session Lifecycle Status": "Draft" }));
  ck("A session with only the retired checkbox still reads correctly",
    sessionIsActive({ [LEG_ACTIVE]: true }) && !sessionIsActive({ [LEG_ACTIVE]: false }));
  ck("A session with only the pre-rename checkbox still reads correctly",
    sessionIsActive({ "Active": true }));
  ck("A session with nothing set is not open", !sessionIsActive({}));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
