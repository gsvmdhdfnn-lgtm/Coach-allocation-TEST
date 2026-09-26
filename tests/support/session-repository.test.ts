// Unit tests for the Slice 3 repository's pure parts (key derivation and
// the Airtable field-mapping) - no network call anywhere in this file.
// tests/support/session-repository.ts is a hand-kept copy of the
// canonical supabase/functions-test/session-occurrences/repository.ts.
import { buildOccurrenceCreatePayload, deriveOccurrenceKey, formatDisplayDate } from "./session-repository.ts";
import { planGeneration, type ExistingOccurrenceRecord, type SessionRecord } from "./session-generator.ts";
import { computeOccurrenceKey, computeReplacementOccurrenceKey } from "./schedule-utils.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const SESSION_ID = "rec4cME6ncL4IAvlK"; // the real TEST-A Sessions record id

// --- 1. deriveOccurrenceKey: explicit key already present -----------------
{
  const key = deriveOccurrenceKey(SESSION_ID, { id: "occX", fields: { "Occurrence Key": "already-set" } });
  ck("An explicit Occurrence Key value is returned as-is, never re-derived", key === "already-set", key);
}

// --- 2. deriveOccurrenceKey: blank key, no reschedule link (plain row) ----
{
  const key = deriveOccurrenceKey(SESSION_ID, { id: "occY", fields: { Date: "2026-10-12" } });
  ck("A plain row with no Occurrence Key and no reschedule link derives the standard key", key === computeOccurrenceKey(SESSION_ID, "2026-10-12"), key);
}

// --- 3. deriveOccurrenceKey: blank key, OUTGOING "Replacement Occurrence" (an origin that moved away) ---
{
  const key = deriveOccurrenceKey(SESSION_ID, {
    id: "occOrigin",
    fields: { Date: "2026-10-05", "Replacement Occurrence": ["occReplacement"] },
  });
  ck(
    "An origin row (outgoing Replacement Occurrence link) still derives the STANDARD key at its own date - it's the historical record of what stood at that slot",
    key === computeOccurrenceKey(SESSION_ID, "2026-10-05"),
    key
  );
}

// --- 4. deriveOccurrenceKey: blank key, INCOMING "From field: Replacement Occurrence" (a replacement landing here) ---
{
  const key = deriveOccurrenceKey(SESSION_ID, {
    id: "occReplacement",
    fields: { Date: "2026-10-07", "From field: Replacement Occurrence": ["occOrigin"] },
  });
  ck(
    "A replacement row (incoming From field: Replacement Occurrence link) derives the :R: key at ITS OWN date, naming the origin",
    key === computeReplacementOccurrenceKey(SESSION_ID, "2026-10-07", "occOrigin"),
    key
  );
}

// --- 5. Reconciliation against the real TEST-A fixtures (exact field shapes read from Airtable 2026-09-26) ---
const TEST_A_REAL_OCCURRENCES: ExistingOccurrenceRecord[] = [
  { id: "recPIHgDscsUChH7L", fields: { Date: "2026-09-28", Status: "Cancelled" } }, // OCC-TEST-A-01
  { id: "recFBvQzPqYoU1cbk", fields: { Date: "2026-10-05", Status: "Postponed", "Replacement Occurrence": ["recszcwKC52pdXqfW"] } }, // OCC-TEST-A-02 (origin)
  { id: "recszcwKC52pdXqfW", fields: { Date: "2026-10-07", Status: "Scheduled", "From field: Replacement Occurrence": ["recFBvQzPqYoU1cbk"] } }, // OCC-TEST-A-03 (replacement)
  { id: "recUNz3pkZX16724G", fields: { Date: "2026-10-12", Status: "Scheduled" } }, // OCC-TEST-A-04
  { id: "recdzk35NefkF6tuG", fields: { Date: "2026-10-19", Status: "Scheduled" } }, // OCC-TEST-A-05
];
{
  const derivedKeys = TEST_A_REAL_OCCURRENCES.map((o) => deriveOccurrenceKey(SESSION_ID, o));
  const expected = [
    computeOccurrenceKey(SESSION_ID, "2026-09-28"),
    computeOccurrenceKey(SESSION_ID, "2026-10-05"),
    computeReplacementOccurrenceKey(SESSION_ID, "2026-10-07", "recFBvQzPqYoU1cbk"),
    computeOccurrenceKey(SESSION_ID, "2026-10-12"),
    computeOccurrenceKey(SESSION_ID, "2026-10-19"),
  ];
  ck(
    "All 5 real TEST-A rows (none of which has an Occurrence Key value yet) derive exactly the expected keys",
    JSON.stringify(derivedKeys) === JSON.stringify(expected),
    JSON.stringify(derivedKeys)
  );
}

// --- 6. End-to-end: real TEST-A config + real derived keys through the real pure generator, zero network ---
{
  const session: SessionRecord = {
    id: SESSION_ID,
    fields: {
      "Session Lifecycle Status": "Active",
      "Schedule Pattern": "Recurring",
      "Default Day": "Monday",
      "Default Start Time": "17:00",
      "Default End Time": "18:00",
      "Start Date": "2026-09-01",
    },
  };
  const existingOccurrences: ExistingOccurrenceRecord[] = TEST_A_REAL_OCCURRENCES.map((o) => ({
    id: o.id,
    fields: { ...o.fields, "Occurrence Key": deriveOccurrenceKey(SESSION_ID, o) },
  }));
  const today = new Date("2026-09-26T12:00:00Z");
  const result = planGeneration({ session, sessionDates: [], existingOccurrences, today });

  const alreadyExistingDates = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];
  const regenerated = result.toCreate.filter((s) => alreadyExistingDates.includes(s.date));
  ck(
    "None of the 4 dates TEST-A already has a standard occurrence for gets regenerated",
    regenerated.length === 0,
    JSON.stringify(result.toCreate.map((s) => s.date))
  );
  ck(
    "Forward Mondays beyond the existing rows ARE generated (26 Oct onward)",
    result.toCreate.some((s) => s.date === "2026-10-26"),
    JSON.stringify(result.toCreate.map((s) => s.date))
  );
  ck(
    "2026-10-07 (the replacement's own Wednesday landing date) is untouched either way - it was never a candidate Monday date",
    !result.toCreate.some((s) => s.date === "2026-10-07")
  );
}

// --- 7. buildOccurrenceCreatePayload: exact field mapping -------------------
{
  const session: SessionRecord = { id: SESSION_ID, fields: { "Session Name": "Monday Juniors (TEST A)" } };
  const shell = {
    occurrenceKey: computeOccurrenceKey(SESSION_ID, "2026-11-02"),
    sessionRecordId: SESSION_ID,
    date: "2026-11-02",
    startDateTime: "2026-11-02T17:00:00.000Z",
    endDateTime: "2026-11-02T18:00:00.000Z",
    status: "Scheduled" as const,
  };
  const payload = buildOccurrenceCreatePayload(shell, session);
  ck("Session is written as a link array to the shell's sessionRecordId", JSON.stringify(payload.Session) === JSON.stringify([SESSION_ID]));
  ck("Date/Start/End/Status/Occurrence Key are passed through unchanged", payload.Date === shell.date && payload["Start Date & Time"] === shell.startDateTime && payload["End Date & Time"] === shell.endDateTime && payload.Status === shell.status && payload["Occurrence Key"] === shell.occurrenceKey);
  ck("Occurrence ID reuses the Occurrence Key (approved v1 decision - no separate sequential scheme)", payload["Occurrence ID"] === shell.occurrenceKey);
  ck("Occurrence Name matches the existing hand-seeded display convention", payload["Occurrence Name"] === "Monday Juniors (TEST A) - 2 Nov 2026", String(payload["Occurrence Name"]));
  ck("No Venue field is written - left for Session-default fallback", !("Venue" in payload));
  ck("No Capacity Override field is written - left for Session-default fallback", !("Capacity Override" in payload));
  ck("No Confirmation State field is written", !("Confirmation State" in payload));
  ck("No Register State field is written", !("Register State" in payload));
}

// --- 8. formatDisplayDate -----------------------------------------------
{
  ck("Single-digit day, no leading zero", formatDisplayDate("2026-11-02") === "2 Nov 2026", formatDisplayDate("2026-11-02"));
  ck("Double-digit day", formatDisplayDate("2026-09-28") === "28 Sep 2026", formatDisplayDate("2026-09-28"));
  ck("January abbreviation", formatDisplayDate("2027-01-04") === "4 Jan 2027", formatDisplayDate("2027-01-04"));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
