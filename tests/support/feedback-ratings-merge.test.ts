// Regression test for the "load failed" draft-resave bug in
// player-feedback's handleCreate/handleUpdate/handleRecord/handleHistory:
// each of those handlers used to discover a Feedback record's rating
// children by re-reading the Feedback record's own reciprocal
// "Feedback Ratings" link field immediately after writing to it (a
// delete+recreate on PATCH, a create on POST). Airtable back-populates
// that reciprocal field asynchronously, so an immediate re-read is not
// guaranteed fresh - most likely to bite exactly when the same record's
// ratings are churned twice in quick succession (resume a draft, edit
// it, save again), which matches the reported repro precisely.
//
// ratingsForFeedbackId()/withRatingIds() below are this test file's own
// copy of the exact fix deployed to player-feedback/index.ts, kept in
// sync by hand - the same duplication convention already used for
// player-access.ts and framework-select.test.ts's selectName().
function ratingsForFeedbackId(feedbackId: string, ratingRows: any[]): any[] {
  return ratingRows.filter((r: any) => (r.fields["Feedback"] || []).includes(feedbackId));
}
function withRatingIds(record: any, ratingIds: string[]): any {
  return { id: record.id, fields: { ...record.fields, "Feedback Ratings": ratingIds } };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

// --- Simulates Airtable mid-propagation: the Feedback parent's own
// reciprocal field is stale (still lists ids that were just deleted,
// and is missing the ones that were just created), while the rating
// rows' OWN forward "Feedback" link - the side that was actually
// written directly - is already correct.
const FEEDBACK_ID = "recFeedback1";
const staleParent = { id: FEEDBACK_ID, fields: { "Feedback Title": "Archie — 2026-09-20", "Feedback Ratings": ["recOldRating1", "recOldRating2"] } };
const freshRatingRows = [
  // Already deleted at the Airtable level, but the parent's reciprocal
  // field above hasn't caught up to that deletion yet - a naive re-read
  // of the parent would chase these into 404s.
  // (Not included in ratingRows at all, since they no longer exist.)
  { id: "recNewRating1", fields: { Feedback: [FEEDBACK_ID], Rating: "Green", "Label Snapshot": "Winners", "Sort Order": 1, Notes: "" } },
  { id: "recNewRating2", fields: { Feedback: [FEEDBACK_ID], Rating: "Blue", "Label Snapshot": "Movers", "Sort Order": 2, Notes: "Great awareness." } },
  // A rating belonging to a DIFFERENT Feedback record - must never leak in.
  { id: "recOtherRating", fields: { Feedback: ["recFeedbackOther"], Rating: "Red", "Label Snapshot": "Someone Else", "Sort Order": 1, Notes: "" } },
];

const resolved = ratingsForFeedbackId(FEEDBACK_ID, freshRatingRows);
ck("Resolves the record's ratings via their own forward link, ignoring the stale parent field entirely", resolved.length === 2 && resolved.every((r) => r.id === "recNewRating1" || r.id === "recNewRating2"), JSON.stringify(resolved.map((r) => r.id)));
ck("Never includes a rating belonging to a different Feedback record", !resolved.some((r) => r.id === "recOtherRating"));
ck("Does NOT chase the parent's stale/already-deleted rating ids (recOldRating1/2 are correctly absent)", !resolved.some((r) => r.id === "recOldRating1" || r.id === "recOldRating2"));

const merged = withRatingIds(staleParent, resolved.map((r) => r.id));
ck("withRatingIds() overrides the stale reciprocal field with the freshly-resolved ids", JSON.stringify(merged.fields["Feedback Ratings"].sort()) === JSON.stringify(["recNewRating1", "recNewRating2"]), JSON.stringify(merged.fields["Feedback Ratings"]));
ck("withRatingIds() preserves every other field on the record untouched", merged.fields["Feedback Title"] === "Archie — 2026-09-20");
ck("withRatingIds() does not mutate the original record object (no shared-reference surprises)", staleParent.fields["Feedback Ratings"].length === 2, JSON.stringify(staleParent.fields["Feedback Ratings"]));

// --- Empty/edge cases -----------------------------------------------
ck("No ratings at all for this record resolves to an empty list, not an error", ratingsForFeedbackId("recNoRatings", freshRatingRows).length === 0);
ck("A record with a malformed/missing Feedback link on a rating row is simply excluded, never throws", ratingsForFeedbackId(FEEDBACK_ID, [{ id: "recBad", fields: {} }]).length === 0);

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
