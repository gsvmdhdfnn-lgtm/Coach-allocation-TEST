// Unit tests for the pure Session Occurrence generator (Slice 2 - see
// TEST-ENV.md). Run directly, not through Playwright/HTTP mocks - no
// Airtable, no Supabase, no network call anywhere in this file or the
// module it tests. tests/support/session-generator.ts and
// tests/support/schedule-utils.ts are hand-kept copies of the canonical
// supabase/functions-test/session-occurrences/*.ts files.
import { planGeneration, type ExistingOccurrenceRecord, type SessionDateRecord, type SessionRecord } from "./session-generator.ts";
import { addDaysIso, buildUkDateTimeIso, computeOccurrenceKey, isoDateUTC } from "./schedule-utils.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// Fixed "today" throughout - a Saturday, deliberately not the Session's own weekday, so first-candidate-date math is genuinely exercised rather than trivially matching "today".
const TODAY = new Date("2026-09-26T12:00:00Z"); // Saturday

function makeSession(overrides: Record<string, any> = {}): SessionRecord {
  return {
    id: "sessA",
    fields: {
      "Session Lifecycle Status": "Active",
      "Schedule Pattern": "Recurring",
      "Default Day": "Monday",
      "Default Start Time": "17:00",
      "Default End Time": "18:00",
      "Start Date": "2026-09-01",
      ...overrides,
    },
  };
}

function expectedShellKeys(session: SessionRecord, dates: string[]): string[] {
  return dates.map((d) => computeOccurrenceKey(session.id, d));
}

// --- 1. Standard weekly recurring generation ---------------------------
{
  const session = makeSession();
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("Generates some occurrences for a plain Active weekly Recurring session", result.toCreate.length > 0, String(result.toCreate.length));
  const allMondays = result.toCreate.every((s) => {
    const d = new Date(s.date + "T00:00:00Z");
    return d.getUTCDay() === 1; // Monday
  });
  ck("Every generated date is a Monday (the Session's Default Day)", allMondays, JSON.stringify(result.toCreate.map((s) => s.date)));
  const first = result.toCreate[0];
  ck("First occurrence's Start Date & Time matches the Session's Default Start Time, BST/GMT-correct", first.startDateTime === buildUkDateTimeIso(first.date, { h: 17, m: 0 }), first.startDateTime);
  ck("First occurrence's End Date & Time matches the Session's Default End Time", first.endDateTime === buildUkDateTimeIso(first.date, { h: 18, m: 0 }), first.endDateTime);
  ck("Every shell's Occurrence Key is the standard {session}:{date} shape", result.toCreate.every((s) => s.occurrenceKey === computeOccurrenceKey(session.id, s.date)));
  ck("Every shell has Status Scheduled", result.toCreate.every((s) => s.status === "Scheduled"));
}

// --- 2. Start Date respected --------------------------------------------
{
  // Start Date far in the future - generation must not produce anything before it, even though today is earlier.
  const session = makeSession({ "Start Date": "2027-01-04" }); // a Monday
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  const beforeStart = result.toCreate.filter((s) => s.date < "2027-01-04");
  ck("No occurrence is generated before the Session's own Start Date", beforeStart.length === 0, JSON.stringify(beforeStart));
  ck("The earliest generated date is exactly the Start Date itself (it falls on the right weekday)", result.toCreate[0]?.date === "2027-01-04", result.toCreate[0]?.date);
}
{
  // Start Date in the past - generation must never backfill; it only ever looks forward from today.
  const session = makeSession({ "Start Date": "2020-01-01" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  const beforeToday = result.toCreate.filter((s) => s.date < isoDateUTC(TODAY));
  ck("A Start Date long in the past never produces a backfilled/past occurrence - generation is always forward from today", beforeToday.length === 0, JSON.stringify(beforeToday));
}

// --- 3. End Date respected -----------------------------------------------
{
  // End Date lands soon, before even 10 occurrences or 12 weeks would otherwise be reached.
  const session = makeSession({ "End Date": "2026-10-15" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  const afterEnd = result.toCreate.filter((s) => s.date > "2026-10-15");
  ck("No occurrence is generated after the Session's own End Date, even though that cuts the window short of 12 weeks/10 occurrences", afterEnd.length === 0, JSON.stringify(result.toCreate.map((s) => s.date)));
  ck("At least one occurrence is still generated within the shortened window", result.toCreate.length > 0);
}

// --- 4. Draft produces nothing --------------------------------------------
{
  const session = makeSession({ "Session Lifecycle Status": "Draft" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("A Draft Session generates zero occurrences", result.toCreate.length === 0, JSON.stringify(result.toCreate));
}

// --- 5. Inactive produces nothing new -------------------------------------
{
  const session = makeSession({ "Session Lifecycle Status": "Inactive" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("An Inactive Session generates zero NEW occurrences", result.toCreate.length === 0, JSON.stringify(result.toCreate));
}
{
  // Blank/unrecognised status must fail closed the same way - never treated as Active by default.
  const session = makeSession({ "Session Lifecycle Status": undefined });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("A Session with no Session Lifecycle Status set generates nothing (fail closed, never assumed Active)", result.toCreate.length === 0);
}

// --- 6. Rolling 12-week / 10-occurrence horizon ---------------------------
{
  const session = makeSession();
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("A plain weekly session generates at least 10 occurrences", result.toCreate.length >= 10, String(result.toCreate.length));
  const lastDate = result.toCreate[result.toCreate.length - 1].date;
  const twelveWeeksOut = addDaysIso(isoDateUTC(TODAY), 84);
  ck("The last generated date reaches at least 12 weeks ahead (the window that wins for a weekly cadence)", lastDate >= twelveWeeksOut, `${lastDate} vs ${twelveWeeksOut}`);
}
{
  // Heavy exclusions push "next 10 real occurrences" past the 12-week mark - the count floor must win here instead.
  const session = makeSession();
  const todayIso = isoDateUTC(TODAY);
  // Exclude every Monday for the first 20 weeks, forcing the generator well past 12 weeks to find 10 real dates.
  const sessionDates: SessionDateRecord[] = [];
  let cursor = "2026-09-28"; // first Monday on/after Start Date
  for (let i = 0; i < 20; i++) {
    sessionDates.push({ id: `sd${i}`, fields: { "Date Type": "Excluded", Date: cursor } });
    cursor = addDaysIso(cursor, 7);
  }
  const result = planGeneration({ session, sessionDates, existingOccurrences: [], today: TODAY });
  ck("Heavy exclusions still yield at least 10 real occurrences (the count floor wins over the time floor when needed)", result.toCreate.length >= 10, String(result.toCreate.length));
  const twelveWeeksOut = addDaysIso(todayIso, 84);
  ck("...and those 10 land well past the plain 12-week mark, since every earlier date was excluded", result.toCreate[0].date > twelveWeeksOut, result.toCreate[0]?.date);
}

// --- 7. Selected Dates Included rows --------------------------------------
{
  const session = makeSession({ "Schedule Pattern": "Selected Dates", "Default Day": undefined });
  const sessionDates: SessionDateRecord[] = [
    { id: "sd1", fields: { "Date Type": "Included", Date: "2026-10-03" } },
    { id: "sd2", fields: { "Date Type": "Included", Date: "2026-11-14" } },
    { id: "sd3", fields: { "Date Type": "Included", Date: "2020-01-01" } }, // past - must be skipped
  ];
  const result = planGeneration({ session, sessionDates, existingOccurrences: [], today: TODAY });
  const dates = result.toCreate.map((s) => s.date).sort();
  ck("Selected Dates generates exactly the future Included dates, sorted", JSON.stringify(dates) === JSON.stringify(["2026-10-03", "2026-11-14"]), JSON.stringify(dates));
  ck("A past Included date is skipped, not backfilled", !dates.includes("2020-01-01"));
  ck("Selected Dates applies no 12-week/10-occurrence ceiling - a far-future Included date is still generated", dates.includes("2026-11-14"));
}

// --- 8. Excluded dates suppress Recurring generation ----------------------
{
  const session = makeSession();
  const sessionDates: SessionDateRecord[] = [
    { id: "sd1", fields: { "Date Type": "Excluded", Date: "2026-09-28" } }, // the very first candidate Monday
  ];
  const result = planGeneration({ session, sessionDates, existingOccurrences: [], today: TODAY });
  ck("The excluded first Monday does not appear in the generated dates", !result.toCreate.some((s) => s.date === "2026-09-28"), JSON.stringify(result.toCreate.map((s) => s.date)));
  ck("The next (non-excluded) Monday is generated instead", result.toCreate.some((s) => s.date === "2026-10-05"), JSON.stringify(result.toCreate.map((s) => s.date)));
}

// --- 9. One-off creates exactly one shell ---------------------------------
{
  const session = makeSession({ "Schedule Pattern": "One-off", "Default Day": undefined, "Start Date": "2026-11-02" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("A One-off Session generates exactly one occurrence, on its Start Date", result.toCreate.length === 1 && result.toCreate[0].date === "2026-11-02", JSON.stringify(result.toCreate));
}
{
  const session = makeSession({ "Schedule Pattern": "One-off", "Default Day": undefined, "Start Date": "2020-01-01" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("A One-off Session whose date has already passed generates nothing", result.toCreate.length === 0, JSON.stringify(result.toCreate));
}

// --- 10. Rerunning with existing Occurrence Keys produces zero duplicate creates ---
{
  const session = makeSession();
  const first = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("First run produces some shells to seed the rerun test", first.toCreate.length > 0);
  const existingOccurrences: ExistingOccurrenceRecord[] = first.toCreate.map((s, i) => ({
    id: `occ${i}`,
    fields: { "Occurrence Key": s.occurrenceKey, Session: [session.id], Date: s.date },
  }));
  const second = planGeneration({ session, sessionDates: [], existingOccurrences, today: TODAY });
  ck("Rerunning with all of the first run's shells now marked existing produces zero new creates", second.toCreate.length === 0, JSON.stringify(second.toCreate));
}
{
  // Partial idempotency: some already exist, some don't (e.g. window has grown since last run).
  const session = makeSession();
  const first = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  const alreadyExisting: ExistingOccurrenceRecord[] = first.toCreate.slice(0, 3).map((s, i) => ({
    id: `occ${i}`,
    fields: { "Occurrence Key": s.occurrenceKey },
  }));
  const rerun = planGeneration({ session, sessionDates: [], existingOccurrences: alreadyExisting, today: TODAY });
  ck("Only the genuinely missing shells are created when some already exist", rerun.toCreate.length === first.toCreate.length - 3, `expected ${first.toCreate.length - 3}, got ${rerun.toCreate.length}`);
  ck("None of the newly-created shells duplicate an already-existing key", rerun.toCreate.every((s) => !alreadyExisting.some((e) => e.fields["Occurrence Key"] === s.occurrenceKey)));
}

// --- 11. A reschedule replacement's :R: key does not block the standard slot ---
{
  const session = makeSession();
  const standardDate = "2026-10-05"; // the second candidate Monday
  // A reschedule replacement landed on this SAME session+date, under a distinctly-shaped key - per design, this must never be confused with, or suppress, the standard slot for that date.
  const existingOccurrences: ExistingOccurrenceRecord[] = [
    { id: "occReplacement", fields: { "Occurrence Key": `${session.id}:${standardDate}:R:occOrigin1`, Session: [session.id], Date: standardDate } },
  ];
  const result = planGeneration({ session, sessionDates: [], existingOccurrences, today: TODAY });
  ck("The standard slot for a date already carrying a reschedule-replacement (:R:) row is still generated", result.toCreate.some((s) => s.date === standardDate && s.occurrenceKey === computeOccurrenceKey(session.id, standardDate)), JSON.stringify(result.toCreate.map((s) => s.date)));
}

// --- 12. BST spring clock change ------------------------------------------
{
  const session = makeSession({ "Default Day": "Sunday", "Start Date": "2026-03-01" });
  const today = new Date("2026-03-01T12:00:00Z");
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today });
  const beforeChange = result.toCreate.find((s) => s.date === "2026-03-22"); // GMT side (spring-forward is 29 Mar 2026)
  const afterChange = result.toCreate.find((s) => s.date === "2026-03-29"); // BST side
  ck("Occurrence the Sunday before the spring clock change resolves to GMT (17:00 local = 17:00Z)", !!beforeChange && beforeChange.startDateTime === "2026-03-22T17:00:00.000Z", beforeChange?.startDateTime);
  ck("Occurrence the Sunday of/after the spring clock change resolves to BST (17:00 local = 16:00Z)", !!afterChange && afterChange.startDateTime === "2026-03-29T16:00:00.000Z", afterChange?.startDateTime);
}

// --- 13. GMT autumn clock change -------------------------------------------
{
  const session = makeSession({ "Default Day": "Sunday", "Start Date": "2026-10-01" });
  const today = new Date("2026-10-01T12:00:00Z");
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today });
  const beforeChange = result.toCreate.find((s) => s.date === "2026-10-18"); // BST side (autumn clocks-back is 25 Oct 2026)
  const afterChange = result.toCreate.find((s) => s.date === "2026-10-25"); // GMT side
  ck("Occurrence the Sunday before the autumn clock change resolves to BST (17:00 local = 16:00Z)", !!beforeChange && beforeChange.startDateTime === "2026-10-18T16:00:00.000Z", beforeChange?.startDateTime);
  ck("Occurrence the Sunday of/after the autumn clock change resolves to GMT (17:00 local = 17:00Z)", !!afterChange && afterChange.startDateTime === "2026-10-25T17:00:00.000Z", afterChange?.startDateTime);
}

// --- 14. Defensive/fail-closed cases ----------------------------------------
{
  const session = makeSession({ "Default Day": "Notaday" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("An unrecognised Default Day fails closed to zero occurrences, rather than guessing", result.toCreate.length === 0);
}
{
  const session = makeSession({ "Default Start Time": "not a time" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("An unparseable Default Start Time fails closed to zero occurrences, rather than writing a broken shell", result.toCreate.length === 0);
}
{
  const session = makeSession({ "Schedule Pattern": "Something Else" });
  const result = planGeneration({ session, sessionDates: [], existingOccurrences: [], today: TODAY });
  ck("An unrecognised Schedule Pattern generates nothing", result.toCreate.length === 0);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
