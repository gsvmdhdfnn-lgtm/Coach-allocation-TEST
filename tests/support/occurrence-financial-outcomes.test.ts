// Unit tests for Coaches Slice 6 (cancellation/reschedule financial
// outcomes - see TEST-ENV.md). Items 1-10 and 16-18 exercise
// financial-outcomes.ts's pure validation/patch-building/auth-predicate
// functions directly. Items 11-15 mock global fetch (same established
// convention as daily-top-up.test.ts/coach-allocations.test.ts) to prove
// the real orchestrator sequencing - upsert, idempotency, safe update,
// and reschedule separation - end to end against an Airtable-shaped
// in-memory store, independent of any real network call. Item 19 (post-
// Slice-6 hardening) proves the per-occurrence lock added afterward
// prevents the exact concurrent-create race real TEST verification hit.
import {
  KNOWN_COACH_OUTCOMES,
  buildCoachOutcomePatch,
  buildParentOutcomePatch,
  buildVenueOutcomePatch,
  isManagementCaller,
  validateCoachOutcomeInput,
  validateParentOutcomeInput,
  validateVenueOutcomeInput,
} from "./financial-outcomes.ts";
import {
  readFinancialOutcomes,
  setCoachOutcome,
  setParentOutcome,
  setVenueOutcome,
} from "./occurrence-financial-outcomes-orchestrator.ts";
import type { LockClient } from "./occurrence-financial-outcomes-lock-client.ts";

/**
 * In-memory LockClient for unit tests - faithfully mirrors the real
 * Postgres RPCs' semantics (atomic acquire, ownership-checked release)
 * without needing a real database. JS's single-threaded event loop makes
 * the Map-based check-and-set below genuinely atomic (no `await` inside
 * acquire()), the same guarantee the real `insert ... on conflict do
 * nothing` gives at the Postgres level - so this fake is a faithful
 * stand-in for proving the ORCHESTRATOR's retry/serialization logic,
 * even though the real RPC round-trip itself is only exercised by real
 * TEST HTTP verification (see TEST-ENV.md).
 */
function createInMemoryLockClient(): LockClient {
  const held = new Map<string, string>();
  let nextToken = 1;
  return {
    async acquire(occurrenceRecordId: string): Promise<string | null> {
      if (held.has(occurrenceRecordId)) return null;
      const token = `tok-${nextToken++}`;
      held.set(occurrenceRecordId, token);
      return token;
    },
    async release(occurrenceRecordId: string, lockToken: string): Promise<boolean> {
      if (held.get(occurrenceRecordId) === lockToken) {
        held.delete(occurrenceRecordId);
        return true;
      }
      return false;
    },
  };
}

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const DECIDED_BY = { userId: "recManagerAAAAAAA", name: "Pat Manager" };
const NOW = "2026-10-05T12:00:00.000Z";

// --- 1. Cancelled occurrence + Coach Paid ---
{
  const patch = buildCoachOutcomePatch({ allocationId: "recAlloc000000001", outcome: "Paid" }, { rateAmountSnapshot: 30, paidUnits: 1 }, DECIDED_BY, NOW);
  ck("1. Coach Paid preserves the intended full payable cost (recalculated from the allocation's own snapshot) and clears any override", patch["Final Coach Cost"] === 30 && patch["Cost Override"] === null, JSON.stringify(patch));
}

// --- 2. Cancelled occurrence + Coach Unpaid ---
{
  const patch = buildCoachOutcomePatch({ allocationId: "recAlloc000000001", outcome: "Unpaid" }, { rateAmountSnapshot: 30, paidUnits: 1 }, DECIDED_BY, NOW);
  ck("2. Coach Unpaid zeroes Final Coach Cost via Cost Override = 0", patch["Final Coach Cost"] === 0 && patch["Cost Override"] === 0, JSON.stringify(patch));
}

// --- 3. Cancelled occurrence + Coach Partial with explicit amount ---
{
  const validationError = validateCoachOutcomeInput({ allocationId: "recAlloc000000001", outcome: "Partial", amount: 15 });
  const patch = buildCoachOutcomePatch({ allocationId: "recAlloc000000001", outcome: "Partial", amount: 15 }, { rateAmountSnapshot: 30, paidUnits: 1 }, DECIDED_BY, NOW);
  ck("3. Coach Partial with an explicit amount validates cleanly and sets Final Coach Cost/Cost Override to that amount", validationError === null && patch["Final Coach Cost"] === 15 && patch["Cost Override"] === 15, JSON.stringify(patch));
}

// --- 4. Coach partial preserves original rate snapshot ---
{
  const snapshot = { rateAmountSnapshot: 30, paidUnits: 1 };
  const patch = buildCoachOutcomePatch({ allocationId: "recAlloc000000001", outcome: "Partial", amount: 15, reason: "Cancelled - agreed partial" }, snapshot, DECIDED_BY, NOW);
  ck(
    "4a. The £30 basis snapshot object itself is never mutated by building a Partial patch",
    snapshot.rateAmountSnapshot === 30 && snapshot.paidUnits === 1,
    JSON.stringify(snapshot)
  );
  ck(
    "4b. The patch never contains a Rate Amount Snapshot/Rate Profile/Rate Type Snapshot/Pay Unit Snapshot key at all - those fields are structurally untouched",
    !("Rate Amount Snapshot" in patch) && !("Rate Profile" in patch) && !("Rate Type Snapshot" in patch) && !("Pay Unit Snapshot" in patch),
    JSON.stringify(patch)
  );
  ck("4c. Final Coach Cost is the actual £15 partial amount, distinct from the £30 basis", patch["Final Coach Cost"] === 15, JSON.stringify(patch));
}

// --- 5-7. Parent outcome: Credit / Refund / None ---
{
  const credit = buildParentOutcomePatch({ occurrenceId: "recOcc00000000001", outcome: "Credit", amount: 20, reason: "Weather cancellation" }, DECIDED_BY, NOW);
  ck("5. Parent Credit records the outcome, amount and reason independently", credit["Parent Outcome"] === "Credit" && credit["Parent Outcome Amount"] === 20 && credit["Parent Outcome Reason"] === "Weather cancellation", JSON.stringify(credit));

  const refund = buildParentOutcomePatch({ occurrenceId: "recOcc00000000001", outcome: "Refund", amount: 20 }, DECIDED_BY, NOW);
  ck("6. Parent Refund records the outcome and amount", refund["Parent Outcome"] === "Refund" && refund["Parent Outcome Amount"] === 20, JSON.stringify(refund));

  const validationErrorNone = validateParentOutcomeInput({ occurrenceId: "recOcc00000000001", outcome: "None" });
  const none = buildParentOutcomePatch({ occurrenceId: "recOcc00000000001", outcome: "None" }, DECIDED_BY, NOW);
  ck("7. Parent None validates with no amount required, and the patch carries a null amount rather than a stale one", validationErrorNone === null && none["Parent Outcome"] === "None" && none["Parent Outcome Amount"] === null, JSON.stringify(none));
}

// --- 8-10. Venue outcome: Paid / Credit / None ---
{
  const paid = buildVenueOutcomePatch({ occurrenceId: "recOcc00000000001", outcome: "Paid", amount: 50 }, DECIDED_BY, NOW);
  ck("8. Venue Paid records the outcome and amount", paid["Venue Outcome"] === "Paid" && paid["Venue Outcome Amount"] === 50, JSON.stringify(paid));

  const credit = buildVenueOutcomePatch({ occurrenceId: "recOcc00000000001", outcome: "Credit", amount: 25, reason: "Venue agreed to carry over" }, DECIDED_BY, NOW);
  ck("9. Venue Credit records the outcome, amount and reason", credit["Venue Outcome"] === "Credit" && credit["Venue Outcome Amount"] === 25 && credit["Venue Outcome Reason"] === "Venue agreed to carry over", JSON.stringify(credit));

  const validationErrorNone = validateVenueOutcomeInput({ occurrenceId: "recOcc00000000001", outcome: "None" });
  const none = buildVenueOutcomePatch({ occurrenceId: "recOcc00000000001", outcome: "None" }, DECIDED_BY, NOW);
  ck("10. Venue None validates with no amount required, and the patch carries a null amount", validationErrorNone === null && none["Venue Outcome"] === "None" && none["Venue Outcome Amount"] === null, JSON.stringify(none));
}

// ---------------------------------------------------------------------
// Mocked-fetch orchestration harness for items 11-15 - an in-memory
// Airtable-shaped store, matched by URL/method exactly like
// daily-top-up.test.ts/coach-allocations.test.ts's established
// convention, so the REAL orchestrator functions run end to end.
// ---------------------------------------------------------------------
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

function makeStore() {
  return {
    occurrences: new Map<string, Record<string, any>>(),
    allocations: new Map<string, Record<string, any>>(),
    outcomeRows: new Map<string, Record<string, any>>(),
    outcomeCreateCalls: 0,
    outcomeListCalls: 0,
    nextOutcomeId: 1,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `listDelayMs`/`createDelayMs` (both default 0) add an artificial delay
 * before the Occurrence Financial Outcomes LIST/CREATE responses - only
 * item 19 sets these, to widen the check-then-write race window the same
 * way real Airtable network latency did during Slice 6's real TEST
 * verification (both the existence-check AND the create call are real
 * network round trips there). Confirmed necessary on BOTH legs: with only
 * the LIST call delayed, this mock's instant CREATE response let the
 * first writer's full sequence finish inside a single Node timer
 * callback, accidentally preventing the second writer's list-check from
 * ever landing in the open window - delaying CREATE too closes that gap
 * and makes the race genuinely, deterministically reproducible without a
 * real lock (verified separately against a no-op lock before this test
 * was written). Items 11-15 leave both at 0 - they don't need them and it
 * would only slow those down for no benefit, since they call these
 * functions sequentially.
 */
function installMockFetch(store: ReturnType<typeof makeStore>, listDelayMs = 0, createDelayMs = 0) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;

    const occMatch = u.match(/\/Session%20Occurrences\/(rec[A-Za-z0-9]+)$/);
    if (occMatch && method === "GET") {
      const rec = store.occurrences.get(occMatch[1]);
      return rec ? jsonResponse({ id: occMatch[1], fields: rec }) : jsonResponse({ error: "NOT_FOUND" }, 404);
    }

    const allocByIdMatch = u.match(/\/Coach%20Allocations\/(rec[A-Za-z0-9]+)$/);
    if (allocByIdMatch && method === "GET") {
      const rec = store.allocations.get(allocByIdMatch[1]);
      return rec ? jsonResponse({ id: allocByIdMatch[1], fields: rec }) : jsonResponse({ error: "NOT_FOUND" }, 404);
    }
    if (allocByIdMatch && method === "PATCH") {
      const existing = store.allocations.get(allocByIdMatch[1]) || {};
      store.allocations.set(allocByIdMatch[1], { ...existing, ...body.fields });
      return jsonResponse({ id: allocByIdMatch[1], fields: store.allocations.get(allocByIdMatch[1]) });
    }
    if (/\/Coach%20Allocations(\?.*)?$/.test(u) && method === "GET") {
      return jsonResponse({ records: [...store.allocations.entries()].map(([id, fields]) => ({ id, fields })) });
    }

    const outcomeByIdMatch = u.match(/\/Occurrence%20Financial%20Outcomes\/(rec[A-Za-z0-9]+)$/);
    if (outcomeByIdMatch && method === "PATCH") {
      const existing = store.outcomeRows.get(outcomeByIdMatch[1]) || {};
      store.outcomeRows.set(outcomeByIdMatch[1], { ...existing, ...body.fields });
      return jsonResponse({ id: outcomeByIdMatch[1], fields: store.outcomeRows.get(outcomeByIdMatch[1]) });
    }
    if (/\/Occurrence%20Financial%20Outcomes(\?.*)?$/.test(u) && method === "GET") {
      store.outcomeListCalls++;
      if (listDelayMs > 0) await sleep(listDelayMs);
      return jsonResponse({ records: [...store.outcomeRows.entries()].map(([id, fields]) => ({ id, fields })) });
    }
    if (/\/Occurrence%20Financial%20Outcomes$/.test(u) && method === "POST") {
      if (createDelayMs > 0) await sleep(createDelayMs);
      store.outcomeCreateCalls++;
      const id = `recOutcomeRow${String(store.nextOutcomeId++).padStart(6, "0")}`;
      store.outcomeRows.set(id, { ...body.records[0].fields });
      return jsonResponse({ records: [{ id }] });
    }

    throw new Error(`Unexpected fetch in financial-outcomes test: ${method} ${u}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const AIRTABLE = { baseId: "appFAKE00000000AA", token: "fake" };

// --- 11. All three outcome families can coexist independently ---
async function testItem11() {
  const store = makeStore();
  const restore = installMockFetch(store);
  try {
    const occId = "recOcc11000000001";
    const allocId = "recAlloc110000001";
    store.occurrences.set(occId, { Status: "Cancelled" });
    store.allocations.set(allocId, { "Session Occurrence": [occId], "Rate Amount Snapshot": 30, "Paid Units": 1 });

    const lock = createInMemoryLockClient();
    await setCoachOutcome({ airtable: AIRTABLE }, { allocationId: allocId, outcome: "Paid" }, DECIDED_BY);
    await setParentOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Credit", amount: 20 }, DECIDED_BY);
    await setVenueOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "None" }, DECIDED_BY);

    const view = await readFinancialOutcomes({ airtable: AIRTABLE }, occId);
    ck(
      "11. Coach/Parent/Venue outcomes coexist independently on the same occurrence - setting one never overwrote another",
      view!.coachAllocations[0].coachOutcome === "Paid" &&
        view!.coachAllocations[0].finalCoachCost === 30 &&
        view!.parentOutcome!.outcome === "Credit" &&
        view!.parentOutcome!.amount === 20 &&
        view!.venueOutcome!.outcome === "None",
      JSON.stringify(view)
    );
  } finally {
    restore();
  }
}

// --- 12/13. Reschedule: original retains its own outcomes, replacement inherits nothing ---
async function testItem12and13() {
  const store = makeStore();
  const restore = installMockFetch(store);
  try {
    const originalId = "recOccOriginal001";
    const replacementId = "recOccReplace0001";
    store.occurrences.set(originalId, { Status: "Postponed", "Replacement Occurrence": [replacementId] });
    store.occurrences.set(replacementId, { Status: "Scheduled" });

    const lock = createInMemoryLockClient();
    await setParentOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: originalId, outcome: "Refund", amount: 40 }, DECIDED_BY);
    await setVenueOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: originalId, outcome: "Credit", amount: 10 }, DECIDED_BY);

    const originalView = await readFinancialOutcomes({ airtable: AIRTABLE }, originalId);
    ck(
      "12. The rescheduled original retains its own Parent/Venue outcomes",
      originalView!.parentOutcome!.outcome === "Refund" && originalView!.parentOutcome!.amount === 40 && originalView!.venueOutcome!.outcome === "Credit",
      JSON.stringify(originalView)
    );

    const replacementView = await readFinancialOutcomes({ airtable: AIRTABLE }, replacementId);
    ck(
      "13. The replacement occurrence inherits nothing - no Parent/Venue outcome row and no Coach Allocations exist for it, even though the original has both",
      replacementView!.parentOutcome === null && replacementView!.venueOutcome === null && replacementView!.coachAllocations.length === 0,
      JSON.stringify(replacementView)
    );
  } finally {
    restore();
  }
}

// --- 14. Repeated identical confirmation is idempotent ---
async function testItem14() {
  const store = makeStore();
  const restore = installMockFetch(store);
  try {
    const occId = "recOcc14000000001";
    store.occurrences.set(occId, { Status: "Cancelled" });

    const lock = createInMemoryLockClient();
    const first = await setParentOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Credit", amount: 20, reason: "Weather" }, DECIDED_BY);
    const second = await setParentOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Credit", amount: 20, reason: "Weather" }, DECIDED_BY);

    ck("14a. The first confirmation creates a row", first.status === "created");
    ck("14b. Repeating the exact same confirmation updates the SAME row rather than creating another", second.status === "updated" && second.recordId === first.recordId, JSON.stringify({ first, second }));
    ck("14c. Only one real create call was ever made to Occurrence Financial Outcomes, even though the function was called twice with identical input", store.outcomeCreateCalls === 1, String(store.outcomeCreateCalls));
  } finally {
    restore();
  }
}

// --- 15. Management can update a prior outcome safely ---
async function testItem15() {
  const store = makeStore();
  const restore = installMockFetch(store);
  try {
    const occId = "recOcc15000000001";
    store.occurrences.set(occId, { Status: "Cancelled" });

    const lock = createInMemoryLockClient();
    const first = await setVenueOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Paid", amount: 50 }, DECIDED_BY);
    const second = await setVenueOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Credit", amount: 30, reason: "Venue agreed to a credit instead" }, DECIDED_BY);

    ck("15a. Editing a prior decision updates the SAME row, not a new one", second.status === "updated" && second.recordId === first.recordId, JSON.stringify({ first, second }));
    ck("15b. Only one real create call was ever made, across the original decision and its later edit", store.outcomeCreateCalls === 1, String(store.outcomeCreateCalls));

    const view = await readFinancialOutcomes({ airtable: AIRTABLE }, occId);
    ck("15c. The stored state reflects the LATEST decision (Credit/£30), not the original (Paid/£50)", view!.venueOutcome!.outcome === "Credit" && view!.venueOutcome!.amount === 30, JSON.stringify(view!.venueOutcome));
  } finally {
    restore();
  }
}

// --- 19. Post-Slice-6 hardening: concurrent Parent+Venue writes to the
// same occurrence never create duplicate records ---
//
// This is a deterministic reconstruction of the exact race real TEST
// verification hit in Slice 6: Parent-outcome and Venue-outcome fired
// for the SAME occurrence at (near-)the same instant, rather than one
// after the other. Artificial delays on both the mocked LIST call and
// the mocked CREATE call widen the check-then-write window the same way
// real Airtable network latency did on both legs - confirmed necessary
// on both (not just LIST) by running this exact scenario against a
// no-op "always grants" lock before writing this test: with only LIST
// delayed, this mock's instant CREATE let the first writer finish inside
// one Node timer callback, accidentally closing the window; delaying
// CREATE too reliably reproduced 2 rows without a real lock, and exactly
// 1 with one - confirming both that the race is genuine and that this
// test would have caught it. Both calls below share ONE lock client
// instance (mirroring index.ts constructing a single module-level
// lockClient shared by every request), and use a short retryDelayMs so
// the test stays fast while still exercising several real contention/
// retry cycles.
async function testItem19() {
  const store = makeStore();
  const restore = installMockFetch(store, /* listDelayMs */ 30, /* createDelayMs */ 15);
  try {
    const occId = "recOcc19000000001";
    store.occurrences.set(occId, { Status: "Cancelled" });
    const lock = createInMemoryLockClient();
    const lockOpts = { maxAttempts: 50, retryDelayMs: 5 };

    const [parentResult, venueResult] = await Promise.all([
      setParentOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Credit", amount: 20, reason: "Weather - parent credit" }, DECIDED_BY, undefined, lockOpts),
      setVenueOutcome({ airtable: AIRTABLE, lock }, { occurrenceId: occId, outcome: "Paid", amount: 50 }, DECIDED_BY, undefined, lockOpts),
    ]);

    ck(
      "19a. Both concurrent calls succeeded (one created, one updated the same row) rather than one being dropped or erroring",
      (parentResult.status === "created" || parentResult.status === "updated") && (venueResult.status === "created" || venueResult.status === "updated"),
      JSON.stringify({ parentResult, venueResult })
    );
    ck(
      "19b. Exactly ONE Occurrence Financial Outcomes record exists for the occurrence after both concurrent writes - the lock prevented the duplicate-create race",
      store.outcomeRows.size === 1,
      `outcomeRows.size = ${store.outcomeRows.size}`
    );
    ck(
      "19c. Only one real create call was ever made to Occurrence Financial Outcomes, even though two writers raced for it",
      store.outcomeCreateCalls === 1,
      String(store.outcomeCreateCalls)
    );
    ck(
      "19d. The lock genuinely serialized the two writers rather than the mock coincidentally avoiding the race - the LIST endpoint was hit twice (once per writer's own existence check, one after the other)",
      store.outcomeListCalls === 2,
      String(store.outcomeListCalls)
    );

    const view = await readFinancialOutcomes({ airtable: AIRTABLE }, occId);
    ck(
      "19e. The single surviving record has BOTH intended values preserved - the Parent call's Credit/£20 AND the Venue call's Paid/£50, neither lost nor overwritten by the other",
      view!.parentOutcome!.outcome === "Credit" && view!.parentOutcome!.amount === 20 && view!.venueOutcome!.outcome === "Paid" && view!.venueOutcome!.amount === 50,
      JSON.stringify(view)
    );
  } finally {
    restore();
  }
}

// --- 16/17. Coach/Parent JWT cannot write ---
{
  ck("16. A Coach-role caller fails the Management-only predicate", isManagementCaller({ role: "coach", active: true }) === false);
  ck("17. A Parent-role caller fails the Management-only predicate", isManagementCaller({ role: "parent", active: true }) === false);
  ck("...and a Management-role, active caller passes it (positive control, so 16/17 aren't vacuously true)", isManagementCaller({ role: "management", active: true }) === true);
  ck("...and an inactive Management-role caller still fails (active flag is checked too)", isManagementCaller({ role: "management", active: false }) === false);
  ck("...and no caller at all fails", isManagementCaller(null) === false);
}

// --- 18. Missing/invalid amounts fail safely where amount is required ---
{
  const missing = validateCoachOutcomeInput({ allocationId: "recAlloc000000001", outcome: "Partial" });
  ck("18a. Coach Partial with a missing amount fails validation", typeof missing === "string" && /amount/.test(missing), String(missing));

  const negative = validateCoachOutcomeInput({ allocationId: "recAlloc000000001", outcome: "Partial", amount: -5 });
  ck("18b. Coach Partial with a negative amount fails validation", typeof negative === "string", String(negative));

  const nonNumeric = validateCoachOutcomeInput({ allocationId: "recAlloc000000001", outcome: "Partial", amount: "fifteen" as any });
  ck("18c. Coach Partial with a non-numeric amount fails validation", typeof nonNumeric === "string", String(nonNumeric));

  const parentInvalid = validateParentOutcomeInput({ occurrenceId: "recOcc00000000001", outcome: "Credit", amount: -1 });
  ck("18d. An invalid (negative) Parent Outcome amount fails validation even though amount isn't strictly required for Credit", typeof parentInvalid === "string", String(parentInvalid));

  const venueInvalid = validateVenueOutcomeInput({ occurrenceId: "recOcc00000000001", outcome: "Paid", amount: NaN });
  ck("18e. An invalid (NaN) Venue Outcome amount fails validation", typeof venueInvalid === "string", String(venueInvalid));

  ck("Coach Outcome choices match the real TEST schema (Paid, Unpaid, Partial)", JSON.stringify(KNOWN_COACH_OUTCOMES) === JSON.stringify(["Paid", "Unpaid", "Partial"]));
}

async function main() {
  await testItem11();
  await testItem12and13();
  await testItem14();
  await testItem15();
  await testItem19();

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
  console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
  process.exit(failed ? 1 : 0);
}

main();
