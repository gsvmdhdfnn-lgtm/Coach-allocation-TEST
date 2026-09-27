// Unit tests for Coaches Slice 7 (coach availability truth layer - see
// TEST-ENV.md). Items 1-18 exercise coach-availability.ts's pure resolver
// directly against plain fixture rows. The orchestrator section mocks
// global fetch (same convention as occurrence-financial-outcomes.test.ts)
// to prove the real repository filtering and input normalisation end to
// end, independent of any real network call.
import {
  dayOfWeekForDate,
  isManagementCaller,
  resolveAvailability,
  ukWallClockFromInstant,
  validateAvailabilityQuery,
  KNOWN_EXCEPTION_TYPES,
  type AvailabilityRecord,
} from "./coach-availability.ts";
import { normaliseAvailabilityInput, resolveCoachAvailability } from "./coach-availability-orchestrator.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const COACH = "recCoachDanny0001";
const OTHER = "recCoachOther0001";

// 2026-10-12 / 10-19 / 10-26 / 11-02 are Mondays; 10-14 and 10-21 Wednesdays; 10-23 Friday.
const MON_A = "2026-10-12";
const MON_B = "2026-10-19";

function rr(id: string, day: string, start: string | null, end: string | null, o: { available?: boolean; active?: boolean; coach?: string } = {}): AvailabilityRecord {
  const fields: Record<string, any> = {
    "Coach": [o.coach ?? COACH],
    "Day of Week": day,
    "Available": o.available ?? true,
    "Active": o.active ?? true,
  };
  if (start != null) fields["Start Time"] = start;
  if (end != null) fields["End Time"] = end;
  return { id, fields };
}

function ex(id: string, type: string | null, startDate: string | null, endDate: string | null, start: string | null = null, end: string | null = null, o: { active?: boolean; coach?: string } = {}): AvailabilityRecord {
  const fields: Record<string, any> = { "Coach": [o.coach ?? COACH], "Active": o.active ?? true };
  if (type != null) fields["Availability Type"] = type;
  if (startDate != null) fields["Start Date"] = startDate;
  if (endDate != null) fields["End Date"] = endDate;
  if (start != null) fields["Start Time"] = start;
  if (end != null) fields["End Time"] = end;
  return { id, fields };
}

function q(date: string, startTime: string, endTime: string, coachId = COACH) {
  return { coachId, date, startTime, endTime };
}

const MON_1720 = rr("recAvailMon17to20", "Monday", "17:00", "20:00");

// --- Sanity: calendar fixtures really are the weekdays the items assume ---
ck("Fixture dates fall on the intended weekdays", dayOfWeekForDate(MON_A) === "Monday" && dayOfWeekForDate(MON_B) === "Monday" && dayOfWeekForDate("2026-10-14") === "Wednesday" && dayOfWeekForDate("2026-10-23") === "Friday",
  [MON_A, MON_B, "2026-10-14", "2026-10-23"].map(dayOfWeekForDate).join(","));

// --- 1-5. Interval containment against one recurring window ---
{
  const r1 = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], []);
  ck("1. Recurring 17:00-20:00 fully contains 18:00-19:00 -> available", r1.status === "available" && r1.reason === "within_recurring_window" && r1.matchedRecordId === "recAvailMon17to20" && r1.source === "recurring", `${r1.status}/${r1.reason}`);

  const r2 = resolveAvailability(q(MON_A, "16:30", "18:00"), [MON_1720], []);
  ck("2. Work starting before availability (16:30-18:00) -> unavailable, partial overlap is not enough", r2.status === "unavailable" && r2.reason === "outside_recurring_windows", `${r2.status}/${r2.reason}`);

  const r3 = resolveAvailability(q(MON_A, "19:30", "20:30"), [MON_1720], []);
  ck("3. Work ending after availability (19:30-20:30) -> unavailable", r3.status === "unavailable" && r3.reason === "outside_recurring_windows", `${r3.status}/${r3.reason}`);

  const r4 = resolveAvailability(q(MON_A, "17:00", "18:00"), [MON_1720], []);
  ck("4. Exact start boundary (work starts 17:00, availability starts 17:00) -> available", r4.status === "available", r4.status);

  const r5 = resolveAvailability(q(MON_A, "19:00", "20:00"), [MON_1720], []);
  ck("5. Exact end boundary (work ends 20:00, availability ends 20:00) -> available", r5.status === "available", r5.status);

  const r5b = resolveAvailability(q(MON_A, "17:00", "20:00"), [MON_1720], []);
  ck("5b. Work exactly equal to the window -> available", r5b.status === "available", r5b.status);

  const r1c = resolveAvailability(q(MON_A, "13:00", "14:00"), [MON_1720], []);
  ck("1c. The brief's own example: Monday 13:00 against 15:00-21:00-style evening availability -> not available", r1c.status === "unavailable", r1c.status);
}

// --- 6-7. Multiple windows, never merged ---
{
  const rows = [rr("recAvailMonMorning", "Monday", "09:00", "12:00"), rr("recAvailMonEvening", "Monday", "16:00", "21:00")];
  const a = resolveAvailability(q(MON_A, "10:00", "11:00"), rows, []);
  const b = resolveAvailability(q(MON_A, "17:00", "18:00"), rows, []);
  ck("6a. Multiple windows same day: 10:00-11:00 resolves available from the morning window", a.status === "available" && a.matchedRecordId === "recAvailMonMorning", `${a.status}/${a.matchedRecordId}`);
  ck("6b. Multiple windows same day: 17:00-18:00 resolves available from the evening window", b.status === "available" && b.matchedRecordId === "recAvailMonEvening", `${b.status}/${b.matchedRecordId}`);

  const gap = resolveAvailability(q(MON_A, "14:00", "15:00"), rows, []);
  ck("7a. The gap between windows (14:00-15:00) does not count as available", gap.status === "unavailable" && gap.reason === "outside_recurring_windows", `${gap.status}/${gap.reason}`);

  const spanning = resolveAvailability(q(MON_A, "11:00", "17:00"), rows, []);
  ck("7b. Work spanning both windows AND the gap is unavailable - windows are never merged", spanning.status === "unavailable", spanning.status);

  const touching = [rr("recAvailMon0912", "Monday", "09:00", "12:00"), rr("recAvailMon1215", "Monday", "12:00", "15:00")];
  const acrossTouch = resolveAvailability(q(MON_A, "11:00", "13:00"), touching, []);
  ck("7c. Even exactly-touching windows (09-12, 12-15) are not merged: 11:00-13:00 is not confirmed available", acrossTouch.status === "unavailable", acrossTouch.status);
}

// --- 8. Normally available + unavailable exception ---
{
  const hol = ex("recExcHolidayMon1", "Unavailable", MON_A, MON_A);
  const onDay = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [hol]);
  const nextWeek = resolveAvailability(q(MON_B, "18:00", "19:00"), [MON_1720], [hol]);
  ck("8a. Normally available Monday + whole-day Unavailable exception on 12 Oct -> unavailable", onDay.status === "unavailable" && onDay.reason === "exception_unavailable" && onDay.source === "exception" && onDay.matchedRecordId === "recExcHolidayMon1", `${onDay.status}/${onDay.reason}`);
  ck("8b. ...and normal Monday availability resumes the following Monday (19 Oct)", nextWeek.status === "available" && nextWeek.source === "recurring", `${nextWeek.status}/${nextWeek.source}`);

  const blankEnd = ex("recExcHolidayMon2", "Unavailable", MON_A, null);
  const be = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [blankEnd]);
  const beNext = resolveAvailability(q(MON_B, "18:00", "19:00"), [MON_1720], [blankEnd]);
  ck("8c. A blank End Date means a single-day exception - applies on its Start Date only", be.status === "unavailable" && beNext.status === "available", `${be.status}/${beNext.status}`);

  const timed = ex("recExcDentist0001", "Unavailable", MON_A, MON_A, "17:00", "18:00");
  const blocked = resolveAvailability(q(MON_A, "17:30", "18:30"), [MON_1720], [timed]);
  const after = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [timed]);
  ck("8d. A timed Unavailable exception blocks work overlapping its window", blocked.status === "unavailable" && blocked.reason === "exception_unavailable", `${blocked.status}/${blocked.reason}`);
  ck("8e. ...but the rest of the day falls through to recurring availability (18:00-19:00 still available; touching the boundary is not overlap)", after.status === "available" && after.source === "recurring", `${after.status}/${after.source}`);
}

// --- 9. Normally unknown/unavailable + positive exception ---
{
  const allDay = ex("recExcWedAllDay01", "Available All Day", "2026-10-14", "2026-10-14");
  const wed = resolveAvailability(q("2026-10-14", "18:00", "19:00"), [MON_1720], [allDay]);
  const nextWed = resolveAvailability(q("2026-10-21", "18:00", "19:00"), [MON_1720], [allDay]);
  ck("9a. No Wednesday pattern + Available All Day exception on 14 Oct -> available", wed.status === "available" && wed.reason === "exception_available_all_day", `${wed.status}/${wed.reason}`);
  ck("9b. ...for that date only - the following Wednesday is back to unknown", nextWed.status === "unknown", nextWed.status);

  const declaredOff = rr("recAvailWedOff001", "Wednesday", null, null, { available: false });
  const overridesOff = resolveAvailability(q("2026-10-14", "18:00", "19:00"), [declaredOff], [allDay]);
  const offOtherWed = resolveAvailability(q("2026-10-21", "18:00", "19:00"), [declaredOff], [allDay]);
  ck("9c. Normally declared unavailable Wednesday (Available unticked) + Available All Day exception -> available on that date", overridesOff.status === "available" && overridesOff.source === "exception", `${overridesOff.status}/${overridesOff.source}`);
  ck("9d. ...and still unavailable every other Wednesday", offOtherWed.status === "unavailable" && offOtherWed.reason === "declared_unavailable_recurring", `${offOtherWed.status}/${offOtherWed.reason}`);

  const diff = ex("recExcDiffHours01", "Different Hours", MON_A, MON_A, "09:00", "12:00");
  const inDiff = resolveAvailability(q(MON_A, "10:00", "11:00"), [MON_1720], [diff]);
  const recurringReplaced = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [diff]);
  ck("9e. Different Hours exception: work inside its hours -> available", inDiff.status === "available" && inDiff.reason === "within_exception_hours", `${inDiff.status}/${inDiff.reason}`);
  ck("9f. Different Hours REPLACES the recurring pattern for that date - normal 18:00-19:00 is not available that Monday", recurringReplaced.status === "unavailable" && recurringReplaced.reason === "outside_exception_hours", `${recurringReplaced.status}/${recurringReplaced.reason}`);

  ck("9g. Exception types match the real TEST schema choices (Unavailable, Available All Day, Different Hours)", JSON.stringify(KNOWN_EXCEPTION_TYPES) === JSON.stringify(["Unavailable", "Available All Day", "Different Hours"]));
}

// --- 10-12. Inclusive date-range exception ---
{
  const range = ex("recExcRange190to23", "Unavailable", "2026-10-19", "2026-10-23");
  const rows = [
    MON_1720,
    rr("recAvailFri17to20", "Friday", "17:00", "20:00"),
    rr("recAvailSun17to20", "Sunday", "17:00", "20:00"),
    rr("recAvailSat17to20", "Saturday", "17:00", "20:00"),
  ];
  const first = resolveAvailability(q("2026-10-19", "18:00", "19:00"), rows, [range]);
  const last = resolveAvailability(q("2026-10-23", "18:00", "19:00"), rows, [range]);
  const before = resolveAvailability(q("2026-10-18", "18:00", "19:00"), rows, [range]);
  const afterR = resolveAvailability(q("2026-10-24", "18:00", "19:00"), rows, [range]);
  const nextMon = resolveAvailability(q("2026-10-26", "18:00", "19:00"), rows, [range]);
  ck("10. Date-range exception is inclusive on its Start Date (19 Oct) -> unavailable", first.status === "unavailable" && first.reason === "exception_unavailable", `${first.status}/${first.reason}`);
  ck("11. Date-range exception is inclusive on its End Date (23 Oct) -> unavailable", last.status === "unavailable" && last.reason === "exception_unavailable", `${last.status}/${last.reason}`);
  ck("12. The exception does not leak outside its range (18 Oct, 24 Oct, 26 Oct all resolve from recurring)", before.status === "available" && afterR.status === "available" && nextMon.status === "available", `${before.status}/${afterR.status}/${nextMon.status}`);
}

// --- 13. No availability supplied -> unknown ---
{
  const none = resolveAvailability(q(MON_A, "18:00", "19:00"), [], []);
  ck("13a. No recurring row and no exception -> unknown, not unavailable", none.status === "unknown" && none.reason === "no_availability_supplied" && none.source === "none", `${none.status}/${none.reason}`);

  const otherDayOnly = resolveAvailability(q(MON_A, "18:00", "19:00"), [rr("recAvailTue15to21", "Tuesday", "15:00", "21:00")], []);
  ck("13b. A coach with only Tuesday rows is unknown (not unavailable) on a Monday", otherDayOnly.status === "unknown", otherDayOnly.status);

  const morningOff = resolveAvailability(q(MON_A, "18:00", "19:00"), [rr("recAvailMonAMOff1", "Monday", "09:00", "12:00", { available: false })], []);
  ck("13c. Only a non-overlapping declared-unavailable window that day -> still unknown for the evening", morningOff.status === "unknown", morningOff.status);
}

// --- 14. Inactive rows ignored ---
{
  const inactive = resolveAvailability(q(MON_A, "18:00", "19:00"), [rr("recAvailMonInact1", "Monday", "17:00", "20:00", { active: false })], []);
  ck("14a. An inactive recurring row is ignored -> unknown, not available", inactive.status === "unknown" && inactive.consideredRecurring.length === 0, `${inactive.status}/${inactive.consideredRecurring.length}`);

  const inactiveEx = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [ex("recExcInactive001", "Unavailable", MON_A, MON_A, null, null, { active: false })]);
  ck("14b. An inactive exception is ignored -> recurring availability applies", inactiveEx.status === "available" && inactiveEx.consideredExceptions.length === 0, `${inactiveEx.status}`);

  const noActiveField: AvailabilityRecord = { id: "recAvailNoActive1", fields: { "Coach": [COACH], "Day of Week": "Monday", "Available": true, "Start Time": "17:00", "End Time": "20:00" } };
  const unticked = resolveAvailability(q(MON_A, "18:00", "19:00"), [noActiveField], []);
  ck("14c. A row whose Active checkbox is unticked (field absent in the API response) counts as inactive", unticked.status === "unknown", unticked.status);
}

// --- 15. Conflicting overlapping exceptions -> ambiguous ---
{
  const off = ex("recExcConflictOff", "Unavailable", MON_A, MON_A);
  const on = ex("recExcConflictOn1", "Available All Day", MON_A, MON_A);
  const c1 = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [off, on]);
  const ids = c1.problems.map((p) => p.recordId).sort();
  ck("15a. Unavailable + Available All Day on the same date -> ambiguous, never a silent pick", c1.status === "ambiguous" && c1.reason === "conflicting_exceptions", `${c1.status}/${c1.reason}`);
  ck("15b. ...and both conflicting exception ids are surfaced for diagnosis", JSON.stringify(ids) === JSON.stringify(["recExcConflictOff", "recExcConflictOn1"].sort()), JSON.stringify(ids));

  // Post-Slice-7 clarification: non-overlapping Different Hours rows are separate valid windows.
  const h1 = ex("recExcDiffHoursA1", "Different Hours", MON_A, MON_A, "09:00", "12:00");
  const h2 = ex("recExcDiffHoursB1", "Different Hours", MON_A, MON_A, "16:00", "20:00");
  const w10 = resolveAvailability(q(MON_A, "10:00", "11:00"), [MON_1720], [h1, h2]);
  const w14 = resolveAvailability(q(MON_A, "14:00", "15:00"), [MON_1720], [h1, h2]);
  const w18 = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [h1, h2]);
  const wSpan = resolveAvailability(q(MON_A, "11:00", "17:00"), [MON_1720], [h1, h2]);
  ck("15c. Two non-overlapping Different Hours (09-12, 16-20): 10:00 available from the first window", w10.status === "available" && w10.reason === "within_exception_hours" && w10.matchedRecordId === "recExcDiffHoursA1", `${w10.status}/${w10.matchedRecordId}`);
  ck("15c2. ...14:00 (the gap) unavailable", w14.status === "unavailable" && w14.reason === "outside_exception_hours" && w14.problems.length === 0, `${w14.status}/${w14.reason}`);
  ck("15c3. ...18:00 available from the second window", w18.status === "available" && w18.matchedRecordId === "recExcDiffHoursB1", `${w18.status}/${w18.matchedRecordId}`);
  ck("15c4. ...and the two windows are never merged: 11:00-17:00 spanning the gap is unavailable", wSpan.status === "unavailable", wSpan.status);

  const touchA = ex("recExcTouchA00001", "Different Hours", MON_A, MON_A, "09:00", "12:00");
  const touchB = ex("recExcTouchB00001", "Different Hours", MON_A, MON_A, "12:00", "15:00");
  const touch = resolveAvailability(q(MON_A, "11:00", "13:00"), [], [touchA, touchB]);
  ck("15c5. Exactly-touching Different Hours windows are not a conflict, but are not merged either (11:00-13:00 unavailable)", touch.status === "unavailable" && touch.reason === "outside_exception_hours", `${touch.status}/${touch.reason}`);

  const ovA = ex("recExcOverlapA001", "Different Hours", MON_A, MON_A, "09:00", "12:00");
  const ovB = ex("recExcOverlapB001", "Different Hours", MON_A, MON_A, "11:00", "14:00");
  const ov = resolveAvailability(q(MON_A, "09:30", "10:30"), [], [ovA, ovB]);
  ck("15c6. Overlapping but different Different Hours windows (09-12 vs 11-14) genuinely contradict -> ambiguous", ov.status === "ambiguous" && ov.reason === "conflicting_exceptions" && ov.problems.length === 2, `${ov.status}/${ov.problems.length}`);

  const dupA = ex("recExcDupHoursA01", "Different Hours", MON_A, MON_A, "09:00", "12:00");
  const dupB = ex("recExcDupHoursB01", "Different Hours", MON_A, MON_A, "09:00", "12:00");
  const dup = resolveAvailability(q(MON_A, "10:00", "11:00"), [], [dupA, dupB]);
  ck("15c7. Identical duplicate Different Hours rows are not a conflict -> available", dup.status === "available", dup.status);

  const allDayPlusHours = resolveAvailability(q(MON_A, "10:00", "11:00"), [], [ex("recExcAllDayMix01", "Available All Day", MON_A, MON_A), h1]);
  ck("15c8. Available All Day + Different Hours on the same date still contradict -> ambiguous", allDayPlusHours.status === "ambiguous", allDayPlusHours.status);

  const timedOffInside = resolveAvailability(q(MON_A, "10:00", "11:00"), [], [h1, h2, ex("recExcTimedOffIn1", "Unavailable", MON_A, MON_A, "10:30", "11:30")]);
  ck("15c9. A timed Unavailable overlapping a Different Hours window genuinely contradicts it -> ambiguous", timedOffInside.status === "ambiguous", timedOffInside.status);

  const timedOffGap = ex("recExcTimedOffGap", "Unavailable", MON_A, MON_A, "13:00", "14:00");
  const gapOk = resolveAvailability(q(MON_A, "18:00", "19:00"), [], [h1, h2, timedOffGap]);
  const gapBlocked = resolveAvailability(q(MON_A, "13:00", "14:00"), [], [h1, h2, timedOffGap]);
  ck("15c10. A timed Unavailable sitting in the gap between Different Hours windows is consistent, not a conflict (18:00 available)", gapOk.status === "available" && gapOk.problems.length === 0, gapOk.status);
  ck("15c11. ...and the gap itself stays unavailable", gapBlocked.status === "unavailable", gapBlocked.status);

  const wholeDayOffPlusHours = resolveAvailability(q(MON_A, "18:00", "19:00"), [], [h2, ex("recExcWholeDayOff", "Unavailable", MON_A, MON_A)]);
  ck("15c12. A whole-day Unavailable + any Different Hours on the same date -> ambiguous", wholeDayOffPlusHours.status === "ambiguous", wholeDayOffPlusHours.status);

  const dup1 = ex("recExcDupHolA0001", "Unavailable", MON_A, MON_A);
  const dup2 = ex("recExcDupHolB0001", "Unavailable", MON_A, MON_A);
  const c3 = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [dup1, dup2]);
  ck("15d. Two agreeing Unavailable exceptions are not a conflict -> unavailable", c3.status === "unavailable", c3.status);

  const range = ex("recExcRangeWeek01", "Unavailable", "2026-10-19", "2026-10-23");
  const midOn = ex("recExcMidWeekOn01", "Available All Day", "2026-10-21", "2026-10-21");
  const onOverlap = resolveAvailability(q("2026-10-21", "18:00", "19:00"), [], [range, midOn]);
  const offOverlap = resolveAvailability(q("2026-10-20", "18:00", "19:00"), [], [range, midOn]);
  ck("15e. Overlapping ranges conflict only on the dates they both cover: 21 Oct ambiguous", onOverlap.status === "ambiguous", onOverlap.status);
  ck("15f. ...while 20 Oct (covered by the range only) is simply unavailable", offOverlap.status === "unavailable", offOverlap.status);
}

// --- 16. Malformed/incomplete rows fail closed ---
{
  const garbled = rr("recAvailGarbled01", "Monday", "5pm", "20:00");
  const m1 = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720, garbled], []);
  ck("16a. A garbled time on a same-day recurring row -> ambiguous, never 'available' even though another row would contain the work", m1.status === "ambiguous" && m1.reason === "malformed_recurring_availability" && m1.problems.some((p) => p.recordId === "recAvailGarbled01"), `${m1.status}/${m1.reason}`);

  const blankTimes = resolveAvailability(q(MON_A, "18:00", "19:00"), [rr("recAvailNoTimes01", "Monday", null, null)], []);
  ck("16b. A positive (Available ticked) row with no times is incomplete -> ambiguous, never assumed 'all day'", blankTimes.status === "ambiguous", blankTimes.status);

  const reversed = resolveAvailability(q(MON_A, "18:00", "19:00"), [rr("recAvailReversed1", "Monday", "20:00", "17:00")], []);
  ck("16c. End Time before Start Time -> ambiguous", reversed.status === "ambiguous", reversed.status);

  const tueGarbled = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720, rr("recAvailTueGarbl1", "Tuesday", "abc", "21:00")], []);
  ck("16d. A malformed Tuesday row does not poison a Monday query", tueGarbled.status === "available", tueGarbled.status);

  const noDay = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720, rr("recAvailNoDay0001", "", "09:00", "12:00")], []);
  ck("16e. A row with a blank Day of Week could apply to any day -> ambiguous (fail closed)", noDay.status === "ambiguous", noDay.status);

  const exMissingEnd = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [ex("recExcNoEndTime01", "Different Hours", MON_A, MON_A, "09:00", null)]);
  ck("16f. A Different Hours exception missing its End Time -> ambiguous", exMissingEnd.status === "ambiguous" && exMissingEnd.reason === "malformed_exception", `${exMissingEnd.status}/${exMissingEnd.reason}`);

  const exNoStartDate = resolveAvailability(q(MON_B, "18:00", "19:00"), [MON_1720], [ex("recExcNoStartDt01", "Unavailable", null, null)]);
  ck("16g. An exception with no Start Date cannot be placed, so it fails closed for any date", exNoStartDate.status === "ambiguous", exNoStartDate.status);

  const exBadType = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [ex("recExcNoType0001", null, MON_A, MON_A)]);
  ck("16h. An exception with no Availability Type -> ambiguous", exBadType.status === "ambiguous", exBadType.status);

  const exAllDayWithTimes = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [ex("recExcAllDayTimes", "Available All Day", MON_A, MON_A, "09:00", "10:00")]);
  ck("16i. Available All Day carrying Start/End Time is contradictory -> ambiguous", exAllDayWithTimes.status === "ambiguous", exAllDayWithTimes.status);

  const exOutOfRange = resolveAvailability(q(MON_B, "18:00", "19:00"), [MON_1720], [ex("recExcBadOther01", "Different Hours", MON_A, MON_A, "09:00", null)]);
  ck("16j. A malformed exception with readable dates only fails closed inside its own range (19 Oct unaffected)", exOutOfRange.status === "available", exOutOfRange.status);

  ck("16k. Query validation rejects an impossible date", typeof validateAvailabilityQuery(q("2026-02-30", "18:00", "19:00")) === "string");
  ck("16l. Query validation rejects end <= start", typeof validateAvailabilityQuery(q(MON_A, "19:00", "19:00")) === "string" && typeof validateAvailabilityQuery(q(MON_A, "20:00", "19:00")) === "string");
  ck("16m. Query validation rejects out-of-range/garbled times", typeof validateAvailabilityQuery(q(MON_A, "25:00", "26:00")) === "string" && typeof validateAvailabilityQuery(q(MON_A, "6pm", "7pm")) === "string");
  ck("16n. Query validation rejects a malformed coachId", typeof validateAvailabilityQuery(q(MON_A, "18:00", "19:00", "Danny")) === "string");
  ck("16o. A well-formed query passes validation", validateAvailabilityQuery(q(MON_A, "18:00", "19:00")) === null);
}

// --- 17. Another coach's rows never leak ---
{
  const otherRows = [rr("recAvailOtherMon1", "Monday", "17:00", "20:00", { coach: OTHER })];
  const otherEx = [ex("recExcOtherAllDay", "Available All Day", MON_A, MON_A, null, null, { coach: OTHER })];
  const r = resolveAvailability(q(MON_A, "18:00", "19:00"), otherRows, otherEx);
  ck("17a. Another coach's recurring row and positive exception never make this coach available", r.status === "unknown" && r.consideredRecurring.length === 0 && r.consideredExceptions.length === 0, r.status);

  const otherBlock = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720], [ex("recExcOtherOff001", "Unavailable", MON_A, MON_A, null, null, { coach: OTHER })]);
  ck("17b. Another coach's Unavailable exception never blocks this coach", otherBlock.status === "available", otherBlock.status);

  const otherGarbled = resolveAvailability(q(MON_A, "18:00", "19:00"), [MON_1720, rr("recAvailOtherBad1", "Monday", "zz", "20:00", { coach: OTHER })], []);
  ck("17c. Another coach's malformed row never makes this coach ambiguous", otherGarbled.status === "available", otherGarbled.status);
}

// --- 18. Europe/London / BST-GMT ---
{
  const bst = ukWallClockFromInstant("2026-10-19T17:00:00.000Z");
  const gmt = ukWallClockFromInstant("2026-11-02T18:00:00.000Z");
  ck("18a. A BST instant converts to UK wall-clock (17:00Z on 19 Oct -> 18:00 UK)", bst?.date === "2026-10-19" && bst?.time === "18:00", JSON.stringify(bst));
  ck("18b. A GMT instant converts unchanged (18:00Z on 2 Nov -> 18:00 UK)", gmt?.date === "2026-11-02" && gmt?.time === "18:00", JSON.stringify(gmt));

  const lateBst = ukWallClockFromInstant("2026-10-19T23:30:00.000Z");
  ck("18c. Near midnight during BST, the UK calendar date (and so the weekday) moves forward (23:30Z Mon -> 00:30 Tue)", lateBst?.date === "2026-10-20" && lateBst?.time === "00:30" && dayOfWeekForDate(lateBst!.date) === "Tuesday", JSON.stringify(lateBst));

  const springForward = ukWallClockFromInstant("2026-03-29T01:30:00.000Z");
  const autumnBack = ukWallClockFromInstant("2026-10-25T01:30:00.000Z");
  ck("18d. Clock-change days: 01:30Z on 29 Mar -> 02:30 BST; 01:30Z on 25 Oct -> 01:30 GMT", springForward?.time === "02:30" && autumnBack?.time === "01:30", `${JSON.stringify(springForward)} ${JSON.stringify(autumnBack)}`);

  // Discriminating case: naive UTC comparison would say "available" here, UK wall-clock says not.
  const bstQuery = normaliseAvailabilityInput({ coachId: COACH, startAt: "2026-10-19T19:30:00Z", endAt: "2026-10-19T20:00:00Z" });
  const gmtQuery = normaliseAvailabilityInput({ coachId: COACH, startAt: "2026-11-02T19:30:00Z", endAt: "2026-11-02T20:00:00Z" });
  const bstRes = "query" in bstQuery ? resolveAvailability(bstQuery.query, [MON_1720], []) : null;
  const gmtRes = "query" in gmtQuery ? resolveAvailability(gmtQuery.query, [MON_1720], []) : null;
  ck("18e. BST: 19:30Z-20:00Z is really 20:30-21:00 UK -> outside Monday 17:00-20:00 -> unavailable (a raw UTC comparison would wrongly say available)", bstRes?.status === "unavailable" && bstRes?.startTime === "20:30", `${bstRes?.startTime}-${bstRes?.endTime} ${bstRes?.status}`);
  ck("18f. GMT: the same UTC clock times are 19:30-20:00 UK -> available", gmtRes?.status === "available" && gmtRes?.startTime === "19:30", `${gmtRes?.startTime}-${gmtRes?.endTime} ${gmtRes?.status}`);

  const crossMidnight = normaliseAvailabilityInput({ coachId: COACH, startAt: "2026-10-19T22:30:00Z", endAt: "2026-10-19T23:30:00Z" });
  ck("18g. An instant pair crossing UK midnight (23:30-00:30 BST) is rejected rather than silently truncated", "error" in crossMidnight, JSON.stringify(crossMidnight));

  const both = normaliseAvailabilityInput({ coachId: COACH, date: MON_A, startTime: "18:00", endTime: "19:00", startAt: "2026-10-12T17:00:00Z" });
  ck("18h. Supplying both wall-clock and instant inputs is rejected, never silently preferring one", "error" in both);

  const wall = normaliseAvailabilityInput({ coachId: COACH, date: MON_A, startTime: "18:00", endTime: "19:00" });
  ck("18i. Wall-clock input is taken as UK local time with no conversion at all", "query" in wall && wall.query.startTime === "18:00" && wall.query.date === MON_A);
}

// --- Security predicate ---
ck("S1. A Coach-role caller fails the Management-only predicate", !isManagementCaller({ role: "coach", active: true }));
ck("S2. A Parent-role caller fails the Management-only predicate", !isManagementCaller({ role: "parent", active: true }));
ck("S3. An active Management caller passes (positive control); inactive Management and no caller fail", isManagementCaller({ role: "management", active: true }) && !isManagementCaller({ role: "management", active: false }) && !isManagementCaller(null));

// --- Orchestrator end to end against a mocked Airtable ---
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installMockFetch(store: { coaches: Set<string>; recurring: AvailabilityRecord[]; exceptions: AvailabilityRecord[] }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (method !== "GET") throw new Error(`coach-availability must be read-only, saw ${method} ${u}`);
    const coachMatch = u.match(/\/Coaches\/(rec[A-Za-z0-9]+)$/);
    if (coachMatch) return store.coaches.has(coachMatch[1]) ? jsonResponse({ id: coachMatch[1], fields: { "Coach Name": "X" } }) : jsonResponse({ error: "NOT_FOUND" }, 404);
    if (/\/Coach%20Availability%20Exceptions(\?.*)?$/.test(u)) return jsonResponse({ records: store.exceptions });
    if (/\/Coach%20Availability(\?.*)?$/.test(u)) return jsonResponse({ records: store.recurring });
    throw new Error(`Unexpected fetch in coach-availability test: ${method} ${u}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const AIRTABLE = { baseId: "appFAKE00000000AA", token: "fake" };

async function testOrchestrator() {
  const store = {
    coaches: new Set([COACH, OTHER]),
    recurring: [MON_1720, rr("recAvailOtherMon2", "Monday", "09:00", "10:00", { coach: OTHER })],
    exceptions: [ex("recExcOtherOff002", "Unavailable", MON_A, MON_A, null, null, { coach: OTHER })],
  };
  const restore = installMockFetch(store);
  try {
    const ok = await resolveCoachAvailability({ airtable: AIRTABLE }, { coachId: COACH, date: MON_A, startTime: "18:00", endTime: "19:00" });
    ck("O1. Orchestrator resolves end to end through the real repository (and filters out the other coach's rows)", ok.status === "resolved" && ok.result.status === "available" && ok.result.consideredExceptions.length === 0, JSON.stringify(ok.status === "resolved" ? ok.result.status : ok));

    const missing = await resolveCoachAvailability({ airtable: AIRTABLE }, { coachId: "recCoachMissing01", date: MON_A, startTime: "18:00", endTime: "19:00" });
    ck("O2. A coach id that does not exist -> coach_not_found, not 'unknown'", missing.status === "coach_not_found", missing.status);

    const bad = await resolveCoachAvailability({ airtable: AIRTABLE }, { coachId: COACH, date: MON_A, startTime: "19:00", endTime: "18:00" });
    ck("O3. Invalid query -> validation_error before any Airtable call", bad.status === "validation_error", bad.status);

    const other = await resolveCoachAvailability({ airtable: AIRTABLE }, { coachId: OTHER, date: MON_A, startTime: "09:00", endTime: "10:00" });
    ck("O4. The other coach resolves from its own rows only (own Unavailable exception wins)", other.status === "resolved" && other.result.status === "unavailable" && other.result.reason === "exception_unavailable", other.status === "resolved" ? other.result.reason : other.status);
  } finally {
    restore();
  }
}

async function main() {
  await testOrchestrator();
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
  console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
  process.exit(failed ? 1 : 0);
}

main();
