/**
 * Unit tests for the Parent Hub display rules introduced by the
 * UX/display fix pass. This file's own copy of each rule mirrors what is
 * deployed (same duplication convention as player-access.ts):
 *
 *  - parentFacingCoachName / presentableName  -> parent-hub index.ts
 *  - dedupeNewestByItem                       -> parent-hub handleParentFeedback
 *  - sessionTitle / sessionMetaLines / sessionOptionLabel -> parent.js
 */

// --- parent-facing coach name ----------------------------------------
function presentableName(v: any): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.indexOf("@") >= 0) return "";
  if (!/\s/.test(s) && /[._\d]/.test(s)) return "";
  return s;
}
function parentFacingCoachName(displayName: any, coachName: any): string {
  return presentableName(displayName) || presentableName(coachName) || "Your coach";
}

// --- one rating row per framework item, newest wins --------------------
function dedupeNewestByItem(rows: { itemId: string; createdTime: string; rating: string }[]) {
  const newest = new Map<string, any>();
  for (const rt of rows) {
    const prev = newest.get(rt.itemId);
    if (!prev || String(rt.createdTime || "") > String(prev.createdTime || "")) newest.set(rt.itemId, rt);
  }
  return [...newest.values()];
}

// --- session labelling -------------------------------------------------
interface SessionLike { session_id?: string; session_name?: string; category?: string; programme?: string; venue?: string; day?: string; time?: string; age_group?: string; coaches?: string[] }
function sameText(a: any, b: any) { return String(a || "").trim().toLowerCase().replace(/\s+/g, " ") === String(b || "").trim().toLowerCase().replace(/\s+/g, " "); }
function sessionTitle(s: SessionLike) { return (s && (s.session_name || s.category || s.programme)) || "Session"; }
function sessionMetaLines(s: SessionLike, opts?: { noDay?: boolean; noCoach?: boolean }) {
  if (!s) return [];
  opts = opts || {};
  const title = sessionTitle(s);
  const lines: string[] = [];
  if (s.venue && !sameText(s.venue, title)) lines.push(s.venue);
  const when = [opts.noDay ? "" : s.day, s.time].filter(Boolean).join(" · ");
  if (when) lines.push(when);
  if (s.age_group) lines.push(s.age_group);
  if (!opts.noCoach && (s.coaches || []).length) lines.push("Coach: " + (s.coaches || []).join(", "));
  return lines;
}
function sessionOptionLabel(s: SessionLike) {
  const bits = [s && s.day, s && s.time, s && s.age_group].filter(Boolean);
  return bits.length ? sessionTitle(s) + " — " + bits.join(" · ") : sessionTitle(s);
}
function sessionOptionLabels(list: SessionLike[]) {
  const counts: Record<string, number> = {};
  (list || []).forEach((s) => { const l = sessionOptionLabel(s); counts[l] = (counts[l] || 0) + 1; });
  return (list || []).map((s) => {
    const l = sessionOptionLabel(s);
    return (counts[l] > 1 && s.session_id) ? l + " · " + s.session_id : l;
  });
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// --- 1. Coach name never exposes an internal identifier ---------------
ck("A dotted username is never shown to a parent", parentFacingCoachName("", "davidcole.surrey") === "Your coach", parentFacingCoachName("", "davidcole.surrey"));
ck("The account display name is preferred over the username", parentFacingCoachName("David Cole", "davidcole.surrey") === "David Cole");
ck("An email address is never shown to a parent", parentFacingCoachName("", "david@joshevans.co.uk") === "Your coach");
ck("An email display name falls through to a usable Coach Name", parentFacingCoachName("david@joshevans.co.uk", "Demo Coach") === "Demo Coach");
ck("A normal two-part name passes through untouched", parentFacingCoachName("", "Demo Coach") === "Demo Coach");
ck("A single first name is still a real name and passes", parentFacingCoachName("", "David") === "David");
ck("A username with digits is rejected", parentFacingCoachName("", "dcole92") === "Your coach");
ck("Nothing at all yields the neutral label, never a blank", parentFacingCoachName("", "") === "Your coach");
ck("Whitespace-only is treated as nothing", parentFacingCoachName("   ", "  ") === "Your coach");

// --- 2. Duplicate development rows -------------------------------------
{
  // The shape the live table is actually in: four Winners rows, three
  // Movers rows, one Passing row, for a single feedback record.
  const rows = [
    { itemId: "fi1", createdTime: "2026-09-20T10:00:00.000Z", rating: "Red" },
    { itemId: "fi1", createdTime: "2026-09-20T11:00:00.000Z", rating: "Red" },
    { itemId: "fi1", createdTime: "2026-09-20T12:00:00.000Z", rating: "Green" },
    { itemId: "fi1", createdTime: "2026-09-20T09:00:00.000Z", rating: "Amber" },
    { itemId: "fi2", createdTime: "2026-09-20T10:00:00.000Z", rating: "Amber" },
    { itemId: "fi2", createdTime: "2026-09-20T11:30:00.000Z", rating: "Blue" },
    { itemId: "fi2", createdTime: "2026-09-20T11:00:00.000Z", rating: "Blue" },
    { itemId: "fi3", createdTime: "2026-09-20T10:00:00.000Z", rating: "Amber" },
  ];
  const out = dedupeNewestByItem(rows);
  ck("Every framework item appears exactly once", out.length === 3, String(out.length));
  ck("No duplicate framework item ids survive", new Set(out.map((r) => r.itemId)).size === out.length);
  ck("The most recently saved rating wins (Winners = Green, not Red/Amber)", out.find((r) => r.itemId === "fi1").rating === "Green");
  ck("Newest wins even when the duplicates are out of order (Movers = the 11:30 row)", out.find((r) => r.itemId === "fi2").createdTime === "2026-09-20T11:30:00.000Z");
  ck("An item with a single row is untouched", out.find((r) => r.itemId === "fi3").rating === "Amber");
}
{
  const out = dedupeNewestByItem([]);
  ck("No ratings at all stays empty rather than throwing", out.length === 0);
}

// --- 3. Session labelling where venue names repeat ---------------------
{
  // Two different sessions at the same venue, whose session_name IS the
  // venue - the live "Daneshill" case.
  const a: SessionLike = { session_name: "Daneshill", venue: "Daneshill", day: "Monday", time: "3:30pm - 4:30pm", age_group: "Years 1-2", coaches: ["Tom"] };
  const b: SessionLike = { session_name: "Daneshill", venue: "Daneshill", day: "Thursday", time: "4:30pm - 5:30pm", age_group: "Years 5-6", coaches: ["Tom"] };
  ck("Two same-venue sessions produce different option labels", sessionOptionLabel(a) !== sessionOptionLabel(b), sessionOptionLabel(a) + " // " + sessionOptionLabel(b));
  ck("The option label carries day, time and age group", /Monday/.test(sessionOptionLabel(a)) && /3:30pm/.test(sessionOptionLabel(a)) && /Years 1-2/.test(sessionOptionLabel(a)), sessionOptionLabel(a));
  ck("A venue identical to the title is not repeated underneath it", sessionMetaLines(a).indexOf("Daneshill") === -1, JSON.stringify(sessionMetaLines(a)));
  ck("The coach is omitted from the option label (no markup room)", !/Tom/.test(sessionOptionLabel(a)));
  ck("The coach IS shown in the card meta lines", sessionMetaLines(a).some((l) => l === "Coach: Tom"));
  ck("The picker label is name — day · time · age, with no venue",
    sessionOptionLabel(a) === "Daneshill — Monday · 3:30pm - 4:30pm · Years 1-2", sessionOptionLabel(a));
}

// --- 3b. Genuinely identical options fall back to the Session ID -------
{
  // Same name, day, time AND age group - the picker would otherwise show
  // two entries a parent cannot tell apart at all.
  const a: SessionLike = { session_id: "D13", session_name: "Daneshill", venue: "Daneshill", day: "Monday", time: "3:30pm - 4:30pm", age_group: "Years 1-2" };
  const b: SessionLike = { session_id: "D15", session_name: "Daneshill", venue: "Daneshill", day: "Monday", time: "3:30pm - 4:30pm", age_group: "Years 1-2" };
  const labels = sessionOptionLabels([a, b]);
  ck("Otherwise-identical options are disambiguated by Session ID", labels[0] !== labels[1], JSON.stringify(labels));
  ck("...and each carries its own Session ID", /D13/.test(labels[0]) && /D15/.test(labels[1]), JSON.stringify(labels));
}
{
  // Already distinct - the Session ID must NOT be appended as noise.
  const a: SessionLike = { session_id: "D13", session_name: "Daneshill", day: "Monday", time: "3:30pm - 4:30pm", age_group: "Years 1-2" };
  const b: SessionLike = { session_id: "D15", session_name: "Daneshill", day: "Thursday", time: "4:30pm - 5:30pm", age_group: "Years 5-6" };
  const labels = sessionOptionLabels([a, b]);
  ck("Distinct options are left clean, with no Session ID appended", !/D13|D15/.test(labels.join(" ")), JSON.stringify(labels));
}
{
  const s: SessionLike = { session_name: "U9/10 Development", venue: "City of London Freemen's", day: "Wednesday", time: "4:00pm - 5:30pm", age_group: "U9/10", coaches: ["David"] };
  ck("A distinct venue IS shown beneath the title", sessionMetaLines(s)[0] === "City of London Freemen's", JSON.stringify(sessionMetaLines(s)));
  ck("Meta order is venue, then day/time, then age, then coach",
    JSON.stringify(sessionMetaLines(s)) === JSON.stringify(["City of London Freemen's", "Wednesday · 4:00pm - 5:30pm", "U9/10", "Coach: David"]),
    JSON.stringify(sessionMetaLines(s)));
  ck("noDay drops the day but keeps the time (the date box already shows the day)",
    sessionMetaLines(s, { noDay: true }).indexOf("4:00pm - 5:30pm") >= 0 && !sessionMetaLines(s, { noDay: true }).some((l) => /Wednesday/.test(l)),
    JSON.stringify(sessionMetaLines(s, { noDay: true })));
}
{
  // A session the schedule sheet has no row for: title survives, nothing
  // is invented beneath it.
  const bare: SessionLike = { session_name: "U13/14 Development" };
  ck("A session with no schedule row still has a usable title", sessionTitle(bare) === "U13/14 Development");
  ck("...and produces no invented meta lines", sessionMetaLines(bare).length === 0);
  ck("...and its option label is just the title", sessionOptionLabel(bare) === "U13/14 Development");
}
{
  const noName: SessionLike = { category: "Development Centre", venue: "Therfield" };
  ck("A nameless session falls back to its category rather than the venue", sessionTitle(noName) === "Development Centre");
  ck("Venue is never promoted to the title", sessionTitle({ venue: "Daneshill" }) === "Session");
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
