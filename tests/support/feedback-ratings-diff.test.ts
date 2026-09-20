// Unit tests for the differential rating-children upsert introduced to
// fix the live "Save Draft" latency/timeout issue: handleUpdate() used
// to delete every existing Feedback Ratings child and recreate all of
// them on every single save, regardless of whether anything changed.
// This is this test file's own copy of the exact diff algorithm now
// deployed in player-feedback/index.ts's handleUpdate() (same
// duplication convention as player-access.ts) - matched by Framework
// Item, never by array position/count.
interface FrameworkItemLike { id: string; name: string; group: string; sortOrder: number }
interface FilteredRating { item: FrameworkItemLike; rating: string; note: string }

function firstLink(fields: Record<string, any>, name: string): string {
  const list = fields[name];
  return Array.isArray(list) && list.length ? list[0] : "";
}

function diffRatings(filtered: FilteredRating[], oldRatings: any[]) {
  const oldByItem = new Map<string, any>();
  for (const r of oldRatings) {
    const itemId = firstLink(r.fields, "Framework Item");
    if (itemId) oldByItem.set(itemId, r);
  }
  const submittedItemIds = new Set(filtered.map((r) => r.item.id));

  const toCreate = filtered.filter((r) => !oldByItem.has(r.item.id));
  const toUpdate = filtered.filter((r) => {
    const existingRow = oldByItem.get(r.item.id);
    if (!existingRow) return false;
    return (existingRow.fields["Rating"] || "") !== r.rating || (existingRow.fields["Notes"] || "") !== r.note;
  });
  const toDelete = oldRatings.filter((r) => {
    const itemId = firstLink(r.fields, "Framework Item");
    return !itemId || !submittedItemIds.has(itemId);
  });
  const unchangedIds = new Set(oldRatings.map((r) => r.id));
  for (const r of toUpdate) unchangedIds.delete(oldByItem.get(r.item.id).id);
  for (const r of toDelete) unchangedIds.delete(r.id);
  const unchanged = oldRatings.filter((r) => unchangedIds.has(r.id));

  return { toCreate, toUpdate, toDelete, unchanged, oldByItem };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const ITEM_WINNERS: FrameworkItemLike = { id: "fi1", name: "Winners", group: "Characteristics", sortOrder: 1 };
const ITEM_MOVERS: FrameworkItemLike = { id: "fi2", name: "Movers", group: "Characteristics", sortOrder: 2 };
const ITEM_PASSING: FrameworkItemLike = { id: "fi3", name: "Passing", group: "Football Pillars", sortOrder: 3 };

function oldRow(id: string, itemId: string, rating: string, notes = "") {
  return { id, fields: { "Framework Item": [itemId], Rating: rating, Notes: notes } };
}

// --- 1. Resaving the exact same draft (no edits) touches nothing --------
{
  const old = [oldRow("recA", "fi1", "Amber"), oldRow("recB", "fi2", "Blue", "note")];
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "Amber", note: "" }, { item: ITEM_MOVERS, rating: "Blue", note: "note" }];
  const diff = diffRatings(submitted, old);
  ck("Identical resubmission creates nothing", diff.toCreate.length === 0, JSON.stringify(diff.toCreate));
  ck("Identical resubmission updates nothing", diff.toUpdate.length === 0, JSON.stringify(diff.toUpdate));
  ck("Identical resubmission deletes nothing", diff.toDelete.length === 0, JSON.stringify(diff.toDelete));
  ck("Identical resubmission leaves both rows unchanged", diff.unchanged.length === 2, String(diff.unchanged.length));
}

// --- 2. Only one rating value changed - only that row is PATCHed --------
{
  const old = [oldRow("recA", "fi1", "Amber"), oldRow("recB", "fi2", "Blue")];
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "Green", note: "" }, { item: ITEM_MOVERS, rating: "Blue", note: "" }];
  const diff = diffRatings(submitted, old);
  ck("Changing one rating updates exactly that one row", diff.toUpdate.length === 1 && diff.toUpdate[0].item.id === "fi1", JSON.stringify(diff.toUpdate));
  ck("The unrelated, unchanged row (fi2) is left alone", diff.unchanged.length === 1 && diff.unchanged[0].id === "recB", JSON.stringify(diff.unchanged));
  ck("Nothing is created or deleted for a pure rating change", diff.toCreate.length === 0 && diff.toDelete.length === 0);
}

// --- 3. Only a note changed (rating identical) - still counts as an update
{
  const old = [oldRow("recA", "fi1", "Amber", "old note")];
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "Amber", note: "new note" }];
  const diff = diffRatings(submitted, old);
  ck("A note-only change is detected and updates the row", diff.toUpdate.length === 1, JSON.stringify(diff.toUpdate));
  ck("A note-only change does not appear as unchanged", diff.unchanged.length === 0);
}

// --- 4. A brand-new item is added alongside two unchanged ones ----------
{
  const old = [oldRow("recA", "fi1", "Amber"), oldRow("recB", "fi2", "Blue")];
  const submitted: FilteredRating[] = [
    { item: ITEM_WINNERS, rating: "Amber", note: "" },
    { item: ITEM_MOVERS, rating: "Blue", note: "" },
    { item: ITEM_PASSING, rating: "Red", note: "" },
  ];
  const diff = diffRatings(submitted, old);
  ck("A newly-added item is created", diff.toCreate.length === 1 && diff.toCreate[0].item.id === "fi3", JSON.stringify(diff.toCreate));
  ck("The two pre-existing unchanged items are untouched", diff.unchanged.length === 2, String(diff.unchanged.length));
  ck("Nothing is updated or deleted when only adding a new item", diff.toUpdate.length === 0 && diff.toDelete.length === 0);
}

// --- 5. An item is removed from the submission - only it is deleted -----
{
  const old = [oldRow("recA", "fi1", "Amber"), oldRow("recB", "fi2", "Blue")];
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "Amber", note: "" }];
  const diff = diffRatings(submitted, old);
  ck("Dropping an item from the submission deletes only that item's row", diff.toDelete.length === 1 && diff.toDelete[0].id === "recB", JSON.stringify(diff.toDelete));
  ck("The still-submitted item remains unchanged", diff.unchanged.length === 1 && diff.unchanged[0].id === "recA");
  ck("Nothing is created or updated when only removing an item", diff.toCreate.length === 0 && diff.toUpdate.length === 0);
}

// --- 6. Mixed: one unchanged, one changed, one new, one removed ---------
{
  const old = [oldRow("recA", "fi1", "Amber"), oldRow("recB", "fi2", "Blue"), oldRow("recC", "fi3", "Red")];
  const submitted: FilteredRating[] = [
    { item: ITEM_WINNERS, rating: "Amber", note: "" }, // unchanged
    { item: ITEM_MOVERS, rating: "Green", note: "" },  // changed
    // fi3 dropped entirely -> delete
    { item: { id: "fi4", name: "New Area", group: "Characteristics", sortOrder: 4 }, rating: "Blue", note: "" }, // new
  ];
  const diff = diffRatings(submitted, old);
  ck("Mixed scenario: exactly one unchanged", diff.unchanged.length === 1 && diff.unchanged[0].id === "recA", JSON.stringify(diff.unchanged));
  ck("Mixed scenario: exactly one updated", diff.toUpdate.length === 1 && diff.toUpdate[0].item.id === "fi2", JSON.stringify(diff.toUpdate));
  ck("Mixed scenario: exactly one created", diff.toCreate.length === 1 && diff.toCreate[0].item.id === "fi4", JSON.stringify(diff.toCreate));
  ck("Mixed scenario: exactly one deleted", diff.toDelete.length === 1 && diff.toDelete[0].id === "recC", JSON.stringify(diff.toDelete));
}

// --- 7. Clearing an existing rating (transition to no rating) is an update, not silently ignored ---
{
  const old = [oldRow("recA", "fi1", "Amber")];
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "", note: "a written-only note" }];
  const diff = diffRatings(submitted, old);
  ck("Clearing a rating (mode change to written-only) is detected as an update", diff.toUpdate.length === 1, JSON.stringify(diff.toUpdate));
}

// --- 8. Matching is by Framework Item id, never by array position -------
{
  // Old rows stored in a different order than the new submission -
  // matching must still be correct by id, not index.
  const old = [oldRow("recB", "fi2", "Blue"), oldRow("recA", "fi1", "Amber")];
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "Amber", note: "" }, { item: ITEM_MOVERS, rating: "Green", note: "" }];
  const diff = diffRatings(submitted, old);
  ck("Order-independent matching: fi1 (unchanged) correctly identified regardless of array position", diff.unchanged.length === 1 && diff.unchanged[0].id === "recA", JSON.stringify(diff.unchanged));
  ck("Order-independent matching: fi2's real change (Blue->Green) correctly detected despite position", diff.toUpdate.length === 1 && diff.toUpdate[0].item.id === "fi2", JSON.stringify(diff.toUpdate));
}

// --- 9. Empty submission with prior ratings deletes everything, creates nothing ---
{
  const old = [oldRow("recA", "fi1", "Amber"), oldRow("recB", "fi2", "Blue")];
  const diff = diffRatings([], old);
  ck("Submitting zero ratings deletes all prior rows", diff.toDelete.length === 2);
  ck("Submitting zero ratings creates/updates nothing", diff.toCreate.length === 0 && diff.toUpdate.length === 0 && diff.unchanged.length === 0);
}

// --- 10. No prior ratings, fresh submission creates everything, deletes nothing ---
{
  const submitted: FilteredRating[] = [{ item: ITEM_WINNERS, rating: "Amber", note: "" }, { item: ITEM_MOVERS, rating: "Blue", note: "" }];
  const diff = diffRatings(submitted, []);
  ck("First-ever save (no prior ratings) creates every submitted item", diff.toCreate.length === 2);
  ck("First-ever save updates/deletes/unchanged are all empty", diff.toUpdate.length === 0 && diff.toDelete.length === 0 && diff.unchanged.length === 0);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
