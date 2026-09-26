// The session-payload repair, as its own copy of the logic now in
// functions-test/parent-hub/index.ts (same duplication convention as
// player-access.ts).
//
// The live gap: sessionPayload built day/time/venue/programme/category/
// age_group by joining each Session to a row in the published Google
// Sheets CSV, keyed by Session ID. Airtable now carries these directly
// on the Sessions record (Default Day, Default Start Time, Default End
// Time, Programme, Category, Age Group) and via a real link to Venues -
// the Sheet is no longer read for any of it. Per the agreed architecture,
// Google Sheets is finance/reporting only.
const EM = "–";

function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}
function buildVenueByRecordId(venueRows: any[]) {
  const out: Record<string, any> = {};
  for (const v of venueRows) {
    if (v.fields["Active"] !== true) continue;
    out[v.id] = v.fields;
  }
  return out;
}
function sessionPayload(session: any, venueByRecordId: Record<string, any>) {
  const dayName = selectName(session.fields["Default Day"]);
  const startTime = String(session.fields["Default Start Time"] || "").trim();
  const endTime = String(session.fields["Default End Time"] || "").trim();
  const time = [startTime, endTime].filter(Boolean).join(` ${EM} `);
  const venueId = firstLink(session.fields, "Venue");
  const venue = venueId ? venueByRecordId[venueId] : null;
  return {
    session_record_id: session.id,
    session_id: session.fields["Session ID"] || "",
    session_name: session.fields["Session Name"] || "",
    programme: session.fields["Programme"] || "",
    category: session.fields["Category"] || "",
    age_group: session.fields["Age Group"] || "",
    day: dayName,
    time,
    venue: venue ? String(venue["Venue Name"] || "") : "",
    address: venue ? String(venue["Address"] || "") : "",
    coaches: [] as string[],
    venue_info: venue
      ? {
          address: venue["Address"] || "",
          postcode: venue["Postcode"] || "",
          parking: venue["Parking"] || "",
          meeting_point: venue["Meeting Point"] || "",
          access: venue["Access"] || "",
          notes: venue["Notes"] || "",
        }
      : null,
  };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const venueRows = [
  { id: "venA", fields: { "Venue Name": "Test Park", Address: "1 Pretend Lane", Postcode: "TE5 7ST",
                          Parking: "Free car park", "Meeting Point": "Blue gate", Access: "Step-free",
                          Notes: "n/a", Active: true } },
  { id: "venInactive", fields: { "Venue Name": "Retired Venue", Active: false } },
];
const venueByRecordId = buildVenueByRecordId(venueRows);

const sessionMonday = {
  id: "sessA",
  fields: {
    "Session ID": "TEST-A",
    "Session Name": "Monday Juniors (TEST A)",
    Programme: "Academy",
    Category: "Evening",
    "Age Group": "U9",
    "Default Day": "Monday",
    "Default Start Time": "17:00",
    "Default End Time": "18:00",
    Venue: ["venA"],
  },
};

{
  const p = sessionPayload(sessionMonday, venueByRecordId);
  ck("session_name comes from the Sessions record", p.session_name === "Monday Juniors (TEST A)");
  ck("day comes from Default Day, not a sheet column", p.day === "Monday");
  ck("time is Default Start Time and Default End Time joined", p.time === `17:00 ${EM} 18:00`, p.time);
  ck("venue comes from the LINKED Venues record, not name-matching", p.venue === "Test Park");
  ck("address comes from the same linked Venues record", p.address === "1 Pretend Lane");
  ck("programme/category/age_group come straight off Sessions",
    p.programme === "Academy" && p.category === "Evening" && p.age_group === "U9");
  ck("venue_info is populated from the linked record",
    !!p.venue_info && p.venue_info.postcode === "TE5 7ST" && p.venue_info.meeting_point === "Blue gate");
  ck("coaches is an empty array - no canonical source wired in this repair",
    Array.isArray(p.coaches) && p.coaches.length === 0);
}
{
  // A singleSelect can come back as a plain string or an {id,name} object -
  // both must resolve the same way.
  const objSelect = { ...sessionMonday, fields: { ...sessionMonday.fields, "Default Day": { id: "sel1", name: "Monday" } } };
  ck("Default Day as an Airtable select object still resolves", sessionPayload(objSelect, venueByRecordId).day === "Monday");
}
{
  // Nothing invented when the source data is missing.
  const bare = { id: "sessBare", fields: { "Session ID": "BARE-1", "Session Name": "Bare Session" } };
  const p = sessionPayload(bare, venueByRecordId);
  ck("Missing Default Day comes back empty, not a placeholder", p.day === "");
  ck("Missing start/end time comes back as an empty time string", p.time === "");
  ck("No Venue link means no venue name", p.venue === "");
  ck("...and venue_info is null, not an object of empty strings", p.venue_info === null);
}
{
  // Only start time set, no end time - must not leave a dangling separator.
  const startOnly = { ...sessionMonday, fields: { ...sessionMonday.fields, "Default End Time": "" } };
  ck("A start time with no end time has no trailing separator",
    sessionPayload(startOnly, venueByRecordId).time === "17:00");
}
{
  // A Venue link pointing at an inactive venue must not resolve - Active
  // is the same gate the rest of the Hub applies to Venues.
  const inactiveVenueSession = { ...sessionMonday, fields: { ...sessionMonday.fields, Venue: ["venInactive"] } };
  const p = sessionPayload(inactiveVenueSession, venueByRecordId);
  ck("A linked but inactive venue does not resolve", p.venue === "" && p.venue_info === null);
}
{
  // A Venue link to a record not present in venueRows (deleted, or the
  // caller only fetched active ones) must degrade, not throw.
  const danglingLink = { ...sessionMonday, fields: { ...sessionMonday.fields, Venue: ["venMissing"] } };
  const p = sessionPayload(danglingLink, venueByRecordId);
  ck("A dangling venue link degrades to empty rather than throwing", p.venue === "" && p.venue_info === null);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
