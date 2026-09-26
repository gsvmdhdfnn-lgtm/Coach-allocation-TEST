// The Session Occurrences resolution logic, as its own copy of what is
// now in functions-test/parent-hub/index.ts (same duplication convention
// as player-access.ts).
//
// Agreed behaviour (hybrid option C):
//  - Recurring Session data is always the pattern: day, time, venue.
//  - Session Occurrences is the source of truth for actual dated sessions.
//  - A future occurrence, when one exists, is shown as the real next date.
//  - No occurrence generated yet -> no invented calendar date; the
//    recurring pattern is shown instead.
//  - A Cancelled occurrence is never "next".
//  - A Rescheduled occurrence resolves to its Replacement Occurrence.
//  - Occurrence-level time/venue overrides beat the recurring defaults.

function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}
function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}
function buildOccurrencesBySessionId(rows: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const r of rows) {
    const sid = firstLink(r.fields, "Session");
    if (!sid) continue;
    if (!out[sid]) out[sid] = [];
    out[sid].push(r);
  }
  return out;
}
function weekdayName(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return "";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()] || "";
}
function occurrenceVenueName(occ: any, session: any, venueByRecordId: Record<string, any>): string {
  const occVenueId = firstLink(occ.fields, "Venue");
  if (occVenueId && venueByRecordId[occVenueId]) return String(venueByRecordId[occVenueId]["Venue Name"] || "");
  const sessionVenueId = firstLink(session.fields, "Venue");
  if (sessionVenueId && venueByRecordId[sessionVenueId]) return String(venueByRecordId[sessionVenueId]["Venue Name"] || "");
  return "";
}
function resolveNextOccurrence(sessionId: string, occurrencesBySessionId: Record<string, any[]>, occurrenceById: Record<string, any>, todayIso: string): any | null {
  const rows = occurrencesBySessionId[sessionId] || [];
  const seen = new Set<string>();
  const candidates: any[] = [];
  for (const row of rows) {
    const replacementId = firstLink(row.fields, "Replacement Occurrence");
    if (replacementId) {
      const target = occurrenceById[replacementId];
      if (target && !seen.has(target.id)) { seen.add(target.id); candidates.push(target); }
      continue;
    }
    if (!seen.has(row.id)) { seen.add(row.id); candidates.push(row); }
  }
  const usable = candidates.filter((o) => {
    const status = selectName(o.fields["Status"]);
    if (status === "Cancelled" || status === "Postponed") return false;
    const date = o.fields["Date"];
    return typeof date === "string" && date.length > 0 && date >= todayIso;
  });
  usable.sort((a, b) => {
    const da = a.fields["Date"] || "", db = b.fields["Date"] || "";
    if (da !== db) return da < db ? -1 : 1;
    const sa = a.fields["Start Date & Time"] || "", sb = b.fields["Start Date & Time"] || "";
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  return usable[0] || null;
}
function nextOccurrencePayload(occ: any, session: any, venueByRecordId: Record<string, any>) {
  const startIso = String(occ.fields["Start Date & Time"] || "");
  const endIso = String(occ.fields["End Date & Time"] || "");
  const startTime = startIso.length >= 16 ? startIso.slice(11, 16) : "";
  const endTime = endIso.length >= 16 ? endIso.slice(11, 16) : "";
  return {
    occurrence_record_id: occ.id,
    date: occ.fields["Date"] || "",
    day: weekdayName(occ.fields["Date"] || ""),
    time: [startTime, endTime].filter(Boolean).join(" – "),
    venue: occurrenceVenueName(occ, session, venueByRecordId),
    rescheduled: selectName(occ.fields["Schedule Change State"]) === "Rescheduled",
  };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const TODAY = "2026-09-26";
const SESSION_A = { id: "sessA", fields: { Venue: ["venA"] } };
const SESSION_NO_OCC = { id: "sessNone", fields: { Venue: ["venA"] } };
const venueByRecordId = {
  venA: { "Venue Name": "Test Park" },
  venB: { "Venue Name": "Sample Sports Hall" },
};

const cancelled = { id: "occ1", fields: { Session: ["sessA"], Date: "2026-09-28", Status: "Cancelled" } };
const normal4 = { id: "occ4", fields: { Session: ["sessA"], Date: "2026-10-12", Status: "Scheduled", "Start Date & Time": "2026-10-12T17:00:00.000Z", "End Date & Time": "2026-10-12T18:00:00.000Z" } };
const normal5 = { id: "occ5", fields: { Session: ["sessA"], Date: "2026-10-19", Status: "Scheduled", "Start Date & Time": "2026-10-19T17:00:00.000Z", "End Date & Time": "2026-10-19T18:00:00.000Z" } };
const replacement3 = { id: "occ3", fields: { Session: ["sessA"], Date: "2026-10-07", Status: "Scheduled", "Schedule Change State": "Rescheduled", Venue: ["venB"], "Start Date & Time": "2026-10-07T16:30:00.000Z", "End Date & Time": "2026-10-07T17:30:00.000Z" } };
const postponed2 = { id: "occ2", fields: { Session: ["sessA"], Date: "2026-10-05", Status: "Postponed", "Schedule Change State": "Rescheduled", "Replacement Occurrence": ["occ3"] } };

const rows = [cancelled, postponed2, replacement3, normal4, normal5];
const occurrenceById: Record<string, any> = {};
for (const o of rows) occurrenceById[o.id] = o;
const bySession = buildOccurrencesBySessionId(rows);

{
  const next = resolveNextOccurrence("sessA", bySession, occurrenceById, TODAY);
  ck("The cancelled nearest date is skipped entirely", !!next && next.id !== "occ1");
  ck("A rescheduled origin never wins directly", !!next && next.id !== "occ2");
  ck("The replacement occurrence wins as the real next date", !!next && next.id === "occ3", next && next.id);
}
{
  const next = resolveNextOccurrence("sessA", bySession, occurrenceById, TODAY)!;
  const payload = nextOccurrencePayload(next, SESSION_A, venueByRecordId);
  ck("Resolved date is the replacement's own date, not the recurring Monday", payload.date === "2026-10-07");
  ck("Resolved weekday is computed from that real date (Wednesday), not the pattern", payload.day === "Wednesday", payload.day);
  ck("Occurrence-level time OVERRIDES the recurring default", payload.time === "16:30 – 17:30", payload.time);
  ck("Occurrence-level venue OVERRIDES the recurring default", payload.venue === "Sample Sports Hall");
  ck("rescheduled flag is set on the winning occurrence", payload.rescheduled === true);
}
{
  // A session with zero occurrence rows must fall back cleanly, not throw.
  const next = resolveNextOccurrence("sessNone", bySession, occurrenceById, TODAY);
  ck("No occurrences generated yet resolves to null (fallback to pattern)", next === null);
}
{
  // Every candidate exhausted by cancellation/postponement-with-no-replacement.
  const onlyBad = buildOccurrencesBySessionId([
    { id: "x1", fields: { Session: ["sessX"], Date: "2026-10-01", Status: "Cancelled" } },
    { id: "x2", fields: { Session: ["sessX"], Date: "2026-10-08", Status: "Postponed" } },
  ]);
  const byId: Record<string, any> = { x1: onlyBad.sessX[0], x2: onlyBad.sessX[1] };
  ck("Cancelled + unresolved Postponed together still fall back to null, not a wrong date",
    resolveNextOccurrence("sessX", onlyBad, byId, TODAY) === null);
}
{
  // A dangling Replacement Occurrence link (target not fetched/deleted) must degrade, not throw.
  const dangling = buildOccurrencesBySessionId([
    { id: "y1", fields: { Session: ["sessY"], Date: "2026-10-01", Status: "Postponed", "Replacement Occurrence": ["yMissing"] } },
  ]);
  const byId: Record<string, any> = { y1: dangling.sessY[0] };
  ck("A dangling Replacement Occurrence link resolves to null rather than throwing",
    resolveNextOccurrence("sessY", dangling, byId, TODAY) === null);
}
{
  // A past-dated Scheduled occurrence must not be picked as "next".
  const past = buildOccurrencesBySessionId([
    { id: "p1", fields: { Session: ["sessP"], Date: "2026-01-01", Status: "Scheduled" } },
  ]);
  const byId: Record<string, any> = { p1: past.sessP[0] };
  ck("A past date is never returned as the next occurrence, even if Scheduled",
    resolveNextOccurrence("sessP", past, byId, TODAY) === null);
}
{
  // No Venue override set on the occurrence -> falls back to the Session's own venue.
  const noOverride = { id: "occNoVen", fields: { Session: ["sessA"], Date: "2026-11-02", Status: "Scheduled" } };
  ck("With no occurrence-level venue, the Session's own venue is used",
    occurrenceVenueName(noOverride, SESSION_A, venueByRecordId) === "Test Park");
}
{
  // Two future candidates on the same session, no exceptions - earliest wins.
  ck("Among plain future Scheduled occurrences, the earliest date wins",
    resolveNextOccurrence("sessA", bySession, occurrenceById, "2026-10-13")!.id === "occ5");
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
