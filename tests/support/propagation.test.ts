// Unit tests for the pure Slice 6 recurring-edit propagation planner (see
// TEST-ENV.md). Run directly, not through Playwright/HTTP mocks - no
// Airtable, no Supabase, no network call anywhere in this file or the
// module it tests. tests/support/propagation.ts is a hand-kept copy of
// the canonical supabase/functions-test/session-occurrences/propagation.ts.
import { planRecurringEdit } from "./propagation.ts";
import type { ExistingOccurrenceRecord } from "./session-generator.ts";
import { buildUkDateTimeIso, isFrozen } from "./schedule-utils.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// Fixed "now" throughout - a Saturday, 12:00 UTC.
const NOW = new Date("2026-09-26T12:00:00Z");

function occ(id: string, fields: Record<string, any>): ExistingOccurrenceRecord {
  return { id, fields: { Status: "Scheduled", ...fields } };
}

// =========================================================================
// Freeze (isFrozen) - Slice 6's own required coverage
// =========================================================================
{
  const startedEarlierToday = occ("f1", { "Start Date & Time": "2026-09-26T09:00:00.000Z" });
  ck("An occurrence that already started today is frozen", isFrozen(startedEarlierToday, NOW));
}
{
  const laterToday = occ("f2", { "Start Date & Time": "2026-09-26T15:00:00.000Z" });
  ck("An occurrence starting later today is still eligible (not frozen)", !isFrozen(laterToday, NOW));
}
{
  const completed = occ("f3", { Status: "Completed", "Start Date & Time": "2026-12-01T17:00:00.000Z" });
  ck("Completed is always frozen, even far in the future", isFrozen(completed, NOW));
}
{
  const cancelled = occ("f4", { Status: "Cancelled", "Start Date & Time": "2026-12-01T17:00:00.000Z" });
  ck("Cancelled is always frozen, even far in the future", isFrozen(cancelled, NOW));
}
{
  const postponed = occ("f5", { Status: "Postponed", "Start Date & Time": "2026-12-01T17:00:00.000Z" });
  ck("Postponed is always frozen, even far in the future", isFrozen(postponed, NOW));
}
{
  const pastNeverCompleted = occ("f6", { Status: "Scheduled", "Start Date & Time": "2026-08-01T17:00:00.000Z" });
  ck("A past Scheduled occurrence freezes automatically, even if never manually marked Completed", isFrozen(pastNeverCompleted, NOW));
}
{
  const noConfirmationRegisterEffect = occ("f7", {
    Status: "Scheduled",
    "Start Date & Time": "2026-11-01T17:00:00.000Z",
    "Confirmation State": "Confirmed",
    "Register State": "Completed",
  });
  ck("Confirmation State / Register State never affect freezing - a future Scheduled row stays unfrozen regardless", !isFrozen(noConfirmationRegisterEffect, NOW));
}

// =========================================================================
// Time change
// =========================================================================
{
  const futureStandard = occ("t1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z" });
  const timeOverridden = occ("t2", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z", "Time Overridden": true });
  const frozenPast = occ("t3", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z", "End Date & Time": "2026-09-01T18:00:00.000Z" });

  const plan = planRecurringEdit({
    existingOccurrences: [futureStandard, timeOverridden, frozenPast],
    now: NOW,
    timeChange: { newStartTime: { h: 19, m: 0 }, newEndTime: { h: 20, m: 0 } },
  });

  const t1Update = plan.toUpdate.find((u) => u.occurrenceRecordId === "t1");
  ck("A future standard occurrence gets a new Start/End Date & Time", !!t1Update, JSON.stringify(plan.toUpdate));
  ck("...recomputed BST/GMT-safe via the same buildUkDateTimeIso() the generator uses", t1Update?.fields["Start Date & Time"] === buildUkDateTimeIso("2026-11-02", { h: 19, m: 0 }) && t1Update?.fields["End Date & Time"] === buildUkDateTimeIso("2026-11-02", { h: 20, m: 0 }));
  ck("Time Overridden = true does not update", !plan.toUpdate.some((u) => u.occurrenceRecordId === "t2"));
  ck("A frozen (past) occurrence does not update", !plan.toUpdate.some((u) => u.occurrenceRecordId === "t3"));
}

// =========================================================================
// Venue change (crystallisation only - future occurrences inherit via
// the existing blank-Venue read-time fallback, so nothing is EVER
// written for them by this planner)
// =========================================================================
{
  const futureBlank = occ("v1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z" });
  const futureExplicit = occ("v2", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", Venue: ["recVenueX"] });
  const frozenBlank = occ("v3", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z" });
  const frozenExplicit = occ("v4", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z", Venue: ["recVenueY"] });

  const plan = planRecurringEdit({
    existingOccurrences: [futureBlank, futureExplicit, frozenBlank, frozenExplicit],
    now: NOW,
    venueChange: { oldVenueRecordIds: ["recOldVenue"] },
  });

  ck("A future occurrence with blank Venue is touched by nothing at all - it inherits the new Session default automatically at read time", !plan.toUpdate.some((u) => u.occurrenceRecordId === "v1") && !plan.toCrystallise.some((u) => u.occurrenceRecordId === "v1"));
  ck("A future occurrence with an explicit Venue stays untouched", !plan.toCrystallise.some((u) => u.occurrenceRecordId === "v2") && !plan.skippedOverrides.some((s) => s.occurrenceRecordId === "v2"));
  const v3Crystal = plan.toCrystallise.find((u) => u.occurrenceRecordId === "v3");
  ck("A frozen occurrence with blank Venue crystallises the OLD effective Venue before the Session default changes", !!v3Crystal && JSON.stringify(v3Crystal.fields["Venue"]) === JSON.stringify(["recOldVenue"]), JSON.stringify(v3Crystal));
  ck("A frozen occurrence with its OWN explicit Venue is reported as skipped, not crystallised", plan.skippedOverrides.some((s) => s.occurrenceRecordId === "v4") && !plan.toCrystallise.some((u) => u.occurrenceRecordId === "v4"));
}
{
  // Historical crystallisation edge case: the Session had no OLD default to begin with.
  const frozenBlankNoOldDefault = occ("v5", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z" });
  const plan = planRecurringEdit({
    existingOccurrences: [frozenBlankNoOldDefault],
    now: NOW,
    venueChange: { oldVenueRecordIds: [] },
  });
  ck("A frozen fallback-dependent row with no OLD default Venue to crystallise is flagged for manual review, not silently left as if handled", plan.manualReview.some((m) => m.occurrenceRecordId === "v5") && !plan.toCrystallise.some((u) => u.occurrenceRecordId === "v5"));
}

// =========================================================================
// Capacity change - identical model to Venue, different field
// =========================================================================
{
  const futureBlank = occ("c1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z" });
  const futureExplicit = occ("c2", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "Capacity Override": 8 });
  const frozenBlank = occ("c3", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z" });
  const frozenExplicit = occ("c4", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z", "Capacity Override": 12 });

  const plan = planRecurringEdit({
    existingOccurrences: [futureBlank, futureExplicit, frozenBlank, frozenExplicit],
    now: NOW,
    capacityChange: { oldCapacity: 20 },
  });

  ck("A future occurrence with blank Capacity Override inherits the new Session default automatically - nothing written", !plan.toUpdate.some((u) => u.occurrenceRecordId === "c1") && !plan.toCrystallise.some((u) => u.occurrenceRecordId === "c1"));
  ck("A future occurrence with an explicit Capacity Override stays untouched", !plan.toCrystallise.some((u) => u.occurrenceRecordId === "c2"));
  const c3Crystal = plan.toCrystallise.find((u) => u.occurrenceRecordId === "c3");
  ck("A frozen occurrence with blank Capacity Override crystallises the OLD effective Capacity before the Session default changes", !!c3Crystal && c3Crystal.fields["Capacity Override"] === 20, JSON.stringify(c3Crystal));
  ck("A frozen occurrence with its OWN explicit Capacity Override is reported as skipped, not crystallised", plan.skippedOverrides.some((s) => s.occurrenceRecordId === "c4") && !plan.toCrystallise.some((u) => u.occurrenceRecordId === "c4"));
}

// =========================================================================
// Independence - overrides/cover never block an unrelated propagation type
// =========================================================================
{
  const venueOverrideEligibleForTime = occ("i1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z", Venue: ["recVenueZ"] });
  const capacityOverrideEligibleForTime = occ("i2", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z", "Capacity Override": 6 });
  const occurrenceStaffPresent = occ("i3", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z", "Occurrence Staff": ["recCoachX"] });

  const plan = planRecurringEdit({
    existingOccurrences: [venueOverrideEligibleForTime, capacityOverrideEligibleForTime, occurrenceStaffPresent],
    now: NOW,
    timeChange: { newStartTime: { h: 19, m: 0 }, newEndTime: { h: 20, m: 0 } },
  });

  ck("A Venue override does not block an eligible occurrence's time update", plan.toUpdate.some((u) => u.occurrenceRecordId === "i1"));
  ck("A Capacity Override does not block an eligible occurrence's time update", plan.toUpdate.some((u) => u.occurrenceRecordId === "i2"));
  ck("Occurrence Staff / cover does not block Time propagation - the planner never reads that field", plan.toUpdate.some((u) => u.occurrenceRecordId === "i3"));
}
{
  // Capacity Override present must not block Venue crystallisation, and vice versa - independent fields.
  const frozenCapacityOverrideBlankVenue = occ("i4", { Date: "2026-09-01", "Start Date & Time": "2026-09-01T17:00:00.000Z", "Capacity Override": 10 });
  const plan = planRecurringEdit({
    existingOccurrences: [frozenCapacityOverrideBlankVenue],
    now: NOW,
    venueChange: { oldVenueRecordIds: ["recOldVenue"] },
  });
  ck("A Capacity Override does not block Venue crystallisation for the same frozen occurrence", plan.toCrystallise.some((u) => u.occurrenceRecordId === "i4" && JSON.stringify(u.fields["Venue"]) === JSON.stringify(["recOldVenue"])));
}

// =========================================================================
// Day-of-week change
// =========================================================================
{
  const oldDayFuture = occ("d1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z" }); // Monday
  const rescheduledReplacementSameDate = occ("d2", { Date: "2026-11-02", "Schedule Change State": "Rescheduled", "Start Date & Time": "2026-11-02T17:00:00.000Z" });
  const cancelledRow = occ("d3", { Date: "2026-11-09", Status: "Cancelled", "Start Date & Time": "2026-11-09T17:00:00.000Z" }); // also Monday
  const postponedRow = occ("d4", { Date: "2026-11-16", Status: "Postponed", "Start Date & Time": "2026-11-16T17:00:00.000Z" }); // also Monday
  const differentWeekday = occ("d5", { Date: "2026-11-03", "Start Date & Time": "2026-11-03T17:00:00.000Z" }); // Tuesday

  const plan = planRecurringEdit({
    existingOccurrences: [oldDayFuture, rescheduledReplacementSameDate, cancelledRow, postponedRow, differentWeekday],
    now: NOW,
    dayOfWeekChange: { oldWeekdayIndex: 1, effectiveFromDateIso: "2026-09-26" }, // Monday
  });

  const d1Cancel = plan.toCancel.find((u) => u.occurrenceRecordId === "d1");
  ck("An eligible old-day standard future row is cancelled, not deleted", !!d1Cancel && d1Cancel.fields["Status"] === "Cancelled", JSON.stringify(d1Cancel));
  ck("A rescheduled replacement on the same date/weekday is untouched", !plan.toCancel.some((u) => u.occurrenceRecordId === "d2"));
  ck("An already-cancelled row is untouched (frozen by status)", !plan.toCancel.some((u) => u.occurrenceRecordId === "d3"));
  ck("A postponed row is untouched (frozen by status)", !plan.toCancel.some((u) => u.occurrenceRecordId === "d4"));
  ck("A row on a different weekday is untouched", !plan.toCancel.some((u) => u.occurrenceRecordId === "d5"));
  ck("backfillNeeded is returned true - a separate generator call is needed to create the new weekday's shells", plan.backfillNeeded === true);
  ck("The plan itself never creates anything - there is no create-capable field in the returned shape", !("toCreate" in plan));
}

// =========================================================================
// Operating End Date shortened
// =========================================================================
{
  const beyondStandard = occ("e1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z" });
  const beyondButFrozenByStatus = occ("e2", { Date: "2026-11-02", Status: "Cancelled", "Start Date & Time": "2026-11-02T17:00:00.000Z" });
  const beyondException = occ("e3", { Date: "2026-11-09", "Schedule Change State": "Rescheduled", "Start Date & Time": "2026-11-09T17:00:00.000Z" });
  const withinBounds = occ("e4", { Date: "2026-10-15", "Start Date & Time": "2026-10-15T17:00:00.000Z" });

  const plan = planRecurringEdit({
    existingOccurrences: [beyondStandard, beyondButFrozenByStatus, beyondException, withinBounds],
    now: NOW,
    endDateChange: { newEndDateIso: "2026-10-31" },
  });

  ck("A future eligible row beyond the shortened End Date is cancelled", plan.toCancel.some((u) => u.occurrenceRecordId === "e1"));
  ck("A frozen row beyond the shortened End Date is untouched, not cancelled", !plan.toCancel.some((u) => u.occurrenceRecordId === "e2"));
  ck("An explicit exception row (non-Standard) beyond the shortened End Date is NOT auto-cancelled - flagged for manual review instead", !plan.toCancel.some((u) => u.occurrenceRecordId === "e3") && plan.manualReview.some((m) => m.occurrenceRecordId === "e3"));
  ck("A row still within the new End Date is untouched", !plan.toCancel.some((u) => u.occurrenceRecordId === "e4") && !plan.manualReview.some((m) => m.occurrenceRecordId === "e4"));
}

// =========================================================================
// Interaction: a frozen row eligible for BOTH Venue and Capacity
// crystallisation in the same call must produce ONE merged toCrystallise
// entry, not two separate ones against the same record - Airtable's
// batch update API rejects a request naming the same record twice, so
// this is a real write-time defect, not just tidiness (found via real
// TEST verification, see TEST-ENV.md).
// =========================================================================
{
  const frozenBlankBoth = occ("y1", { Date: "2026-08-03", "Start Date & Time": "2026-08-03T16:00:00.000Z" });
  const plan = planRecurringEdit({
    existingOccurrences: [frozenBlankBoth],
    now: NOW,
    venueChange: { oldVenueRecordIds: ["recOldVenue"] },
    capacityChange: { oldCapacity: 20 },
  });
  const entriesForRow = plan.toCrystallise.filter((u) => u.occurrenceRecordId === "y1");
  ck("A row eligible for both Venue and Capacity crystallisation produces exactly ONE merged entry, not two", entriesForRow.length === 1, JSON.stringify(entriesForRow));
  ck("...and that merged entry carries both fields", entriesForRow[0]?.fields["Venue"]?.[0] === "recOldVenue" && entriesForRow[0]?.fields["Capacity Override"] === 20, JSON.stringify(entriesForRow[0]));
}

// =========================================================================
// Interaction: a simultaneous Day-of-week change and Time change must not
// both target the same row - cancellation wins, the row is retired, not
// kept running at a new time.
// =========================================================================
{
  const oldDayFuture = occ("x1", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z" }); // Monday
  const plan = planRecurringEdit({
    existingOccurrences: [oldDayFuture],
    now: NOW,
    timeChange: { newStartTime: { h: 19, m: 0 }, newEndTime: { h: 20, m: 0 } },
    dayOfWeekChange: { oldWeekdayIndex: 1, effectiveFromDateIso: "2026-09-26" },
  });
  ck("A row cancelled by a simultaneous day-of-week change is NOT also updated by the time change - cancellation wins", plan.toCancel.some((u) => u.occurrenceRecordId === "x1") && !plan.toUpdate.some((u) => u.occurrenceRecordId === "x1"));
}
{
  const beyondNewEndDate = occ("x2", { Date: "2026-11-02", "Start Date & Time": "2026-11-02T17:00:00.000Z", "End Date & Time": "2026-11-02T18:00:00.000Z" });
  const plan = planRecurringEdit({
    existingOccurrences: [beyondNewEndDate],
    now: NOW,
    timeChange: { newStartTime: { h: 19, m: 0 }, newEndTime: { h: 20, m: 0 } },
    endDateChange: { newEndDateIso: "2026-10-31" },
  });
  ck("A row cancelled by a simultaneous End Date change is NOT also updated by the time change - cancellation wins", plan.toCancel.some((u) => u.occurrenceRecordId === "x2") && !plan.toUpdate.some((u) => u.occurrenceRecordId === "x2"));
}

// =========================================================================
// Regression: the real TEST-A reschedule-chain fixtures (exact field
// shapes read from Airtable 2026-09-26) must plan correctly through a
// permanent Time change - only the two genuinely standard rows update.
// =========================================================================
{
  const TEST_A_REAL_OCCURRENCES: ExistingOccurrenceRecord[] = [
    { id: "recPIHgDscsUChH7L", fields: { Date: "2026-09-28", Status: "Cancelled", "Schedule Change State": "Changed", "Start Date & Time": "2026-09-28T17:00:00.000Z", "End Date & Time": "2026-09-28T18:00:00.000Z" } },
    { id: "recFBvQzPqYoU1cbk", fields: { Date: "2026-10-05", Status: "Postponed", "Schedule Change State": "Rescheduled", "Start Date & Time": "2026-10-05T17:00:00.000Z", "End Date & Time": "2026-10-05T18:00:00.000Z" } },
    { id: "recszcwKC52pdXqfW", fields: { Date: "2026-10-07", Status: "Scheduled", "Schedule Change State": "Rescheduled", Venue: ["recOiQR9Ff6DqjIaC"], "Start Date & Time": "2026-10-07T16:30:00.000Z", "End Date & Time": "2026-10-07T17:30:00.000Z" } },
    { id: "recUNz3pkZX16724G", fields: { Date: "2026-10-12", Status: "Scheduled", "Start Date & Time": "2026-10-12T17:00:00.000Z", "End Date & Time": "2026-10-12T18:00:00.000Z" } },
    { id: "recdzk35NefkF6tuG", fields: { Date: "2026-10-19", Status: "Scheduled", "Start Date & Time": "2026-10-19T17:00:00.000Z", "End Date & Time": "2026-10-19T18:00:00.000Z" } },
  ];
  const plan = planRecurringEdit({
    existingOccurrences: TEST_A_REAL_OCCURRENCES,
    now: NOW,
    timeChange: { newStartTime: { h: 18, m: 0 }, newEndTime: { h: 19, m: 0 } },
  });
  const updatedIds = plan.toUpdate.map((u) => u.occurrenceRecordId).sort();
  ck(
    "Only the two genuinely standard TEST-A rows (12 Oct, 19 Oct) update on a permanent recurring time change",
    JSON.stringify(updatedIds) === JSON.stringify(["recUNz3pkZX16724G", "recdzk35NefkF6tuG"].sort()),
    JSON.stringify(updatedIds)
  );
  ck("The cancelled 28 Sep origin is never touched", !plan.toUpdate.some((u) => u.occurrenceRecordId === "recPIHgDscsUChH7L"));
  ck("The postponed 5 Oct origin is never touched", !plan.toUpdate.some((u) => u.occurrenceRecordId === "recFBvQzPqYoU1cbk"));
  ck("The 7 Oct replacement (Rescheduled, its own time) is never touched, even though its own Time Overridden flag happens to be unset in the real data - Schedule Change State alone already protects it", !plan.toUpdate.some((u) => u.occurrenceRecordId === "recszcwKC52pdXqfW"));
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
