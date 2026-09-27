// Unit tests for Coaches Slice 5 (rates + historical coach-cost
// foundation - see TEST-ENV.md). Run directly, not through Playwright/
// HTTP mocks (except item 16, which mocks global fetch to prove the
// idempotency check without a real Airtable call) - these exercise
// coach-rates.ts/coach-allocations-repository.ts/
// coach-allocations-orchestrator.ts directly, so a mistake in the
// resolver/cost/snapshot logic itself fails here even if a real TEST
// HTTP call still happens to look right.
import {
  KNOWN_RATE_TYPES,
  resolveCoachRateProfile,
  resolveFinalCost,
  validateCreateAllocationInput,
  type CoachRateProfileRecord,
} from "./coach-rates.ts";
import { buildAllocationCreatePayload } from "./coach-allocations-repository.ts";
import { createCoachAllocationForOccurrence } from "./coach-allocations-orchestrator.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const COACH_DANNY = "coachDanny";
const COACH_OTHER = "coachOther";

function rateProfile(id: string, overrides: Partial<CoachRateProfileRecord["fields"]> = {}): CoachRateProfileRecord {
  return {
    id,
    fields: {
      Coach: [COACH_DANNY],
      "Rate Type": "Evening",
      "Pay Unit": "Per Hour",
      Amount: 25,
      Active: true,
      ...overrides,
    },
  };
}

// --- 1. One active matching rate resolves ---
{
  const rows = [rateProfile("rpA")];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-09-20", "Evening", rows);
  ck("1. One Active, applicable, matching-type Rate Profile resolves", r.status === "resolved" && r.status === "resolved" && r.profile.id === "rpA", JSON.stringify(r));
}

// --- 2. Inactive rate ignored ---
{
  const rows = [rateProfile("rpInactive", { Active: false })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-09-20", "Evening", rows);
  ck("2. Active=false Rate Profile is ignored (fails closed to missing, not silently skipped-and-guessed)", r.status === "missing", JSON.stringify(r));
}

// --- 3. Before Effective From excluded ---
{
  const rows = [rateProfile("rpFrom", { "Effective From": "2026-10-01" })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-09-30", "Evening", rows);
  ck("3. A date one day before Effective From is excluded", r.status === "missing", JSON.stringify(r));
}

// --- 4. After Effective Until excluded ---
{
  const rows = [rateProfile("rpUntil", { "Effective Until": "2026-09-30" })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-10-01", "Evening", rows);
  ck("4. A date one day after Effective Until is excluded", r.status === "missing", JSON.stringify(r));
}

// --- 5. From boundary inclusive ---
{
  const rows = [rateProfile("rpFromInc", { "Effective From": "2026-10-01" })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-10-01", "Evening", rows);
  ck("5. Exactly on Effective From resolves (inclusive)", r.status === "resolved", JSON.stringify(r));
}

// --- 6. Until boundary inclusive ---
{
  const rows = [rateProfile("rpUntilInc", { "Effective Until": "2026-09-30" })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-09-30", "Evening", rows);
  ck("6. Exactly on Effective Until resolves (inclusive)", r.status === "resolved", JSON.stringify(r));
}

// --- 7. Open-ended From (blank Effective From, only Until set) ---
{
  const rows = [rateProfile("rpOpenFrom", { "Effective Until": "2026-12-31" })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2000-01-01", "Evening", rows);
  ck("7. Blank Effective From applies far in the past", r.status === "resolved", JSON.stringify(r));
}

// --- 8. Open-ended Until (blank Effective Until, only From set) ---
{
  const rows = [rateProfile("rpOpenUntil", { "Effective From": "2026-01-01" })];
  const r = resolveCoachRateProfile(COACH_DANNY, "2030-01-01", "Evening", rows);
  ck("8. Blank Effective Until applies far in the future", r.status === "resolved", JSON.stringify(r));
}

// --- 9. Rate transition £25 -> £30 chooses correctly by occurrence date ---
{
  const rows = [
    rateProfile("rpSep", { Amount: 25, "Effective From": "2026-09-01", "Effective Until": "2026-09-30" }),
    rateProfile("rpOct", { Amount: 30, "Effective From": "2026-10-01" }),
  ];
  const sepResult = resolveCoachRateProfile(COACH_DANNY, "2026-09-28", "Evening", rows);
  const octResult = resolveCoachRateProfile(COACH_DANNY, "2026-10-03", "Evening", rows);
  ck("9a. 28 Sep resolves the £25 profile", sepResult.status === "resolved" && sepResult.profile.fields["Amount"] === 25, JSON.stringify(sepResult));
  ck("9b. 3 Oct resolves the £30 profile", octResult.status === "resolved" && octResult.profile.fields["Amount"] === 30, JSON.stringify(octResult));
}

// --- 10. A later Rate Profile edit does not alter an existing allocation snapshot ---
{
  const profile = rateProfile("rpMutable", { Amount: 25 });
  const costResult = resolveFinalCost({ rateAmount: profile.fields["Amount"], paidUnits: 2 });
  const payload = buildAllocationCreatePayload(
    {
      coachId: COACH_DANNY,
      sessionOccurrenceId: "occFixed",
      workDateIso: "2026-09-20",
      rateType: "Evening",
      assignmentType: "Scheduled",
      paidUnits: 2,
    },
    profile,
    costResult
  );
  // The Rate Profile row is now edited "later" - same object Slice 1's
  // Airtable-mirrored data model would represent as an updated Amount.
  profile.fields["Amount"] = 30;
  ck(
    "10. The already-built allocation payload's Rate Amount Snapshot/Final Coach Cost stay at the original £25, unaffected by the later edit to the same Rate Profile object",
    payload["Rate Amount Snapshot"] === 25 && payload["Final Coach Cost"] === 50,
    JSON.stringify(payload)
  );
}

// --- 11. Normal Final Coach Cost calculation correct ---
{
  const r = resolveFinalCost({ rateAmount: 25, paidUnits: 3 });
  ck("11. Final Coach Cost = Rate Amount Snapshot x Paid Units for the normal case", r.finalCoachCost === 75 && r.overridden === false, JSON.stringify(r));
}

// --- 12. Cost Override changes Final Coach Cost but preserves rate snapshot ---
{
  const profile = rateProfile("rpOverride", { Amount: 30 });
  const costResult = resolveFinalCost({ rateAmount: 30, paidUnits: 1, costOverride: 40 });
  ck("12a. Cost Override changes Final Coach Cost to the override value", costResult.finalCoachCost === 40 && costResult.overridden === true, JSON.stringify(costResult));
  ck("12b. The standard calculated cost is still preserved (visible), separate from the override", costResult.standardCost === 30, JSON.stringify(costResult));
  const payload = buildAllocationCreatePayload(
    { coachId: COACH_DANNY, sessionOccurrenceId: "occOv", workDateIso: "2026-10-05", rateType: "Evening", assignmentType: "Cover", paidUnits: 1, costOverride: 40, overrideReason: "Covering as a favour" },
    profile,
    costResult
  );
  ck("12c. The allocation payload's Rate Profile link/Rate Amount Snapshot are the ORIGINAL resolved profile, never overwritten by the override", payload["Rate Profile"]?.[0] === "rpOverride" && payload["Rate Amount Snapshot"] === 30, JSON.stringify(payload));
  ck("12d. Final Coach Cost in the payload is the override, not the standard calculation", payload["Final Coach Cost"] === 40, JSON.stringify(payload));
}

// --- 13. Override Reason preserved ---
{
  const profile = rateProfile("rpReason", { Amount: 30 });
  const costResult = resolveFinalCost({ rateAmount: 30, paidUnits: 1, costOverride: 40 });
  const payload = buildAllocationCreatePayload(
    { coachId: COACH_DANNY, sessionOccurrenceId: "occReason", workDateIso: "2026-10-05", rateType: "Evening", assignmentType: "Cover", paidUnits: 1, costOverride: 40, overrideReason: "Covering as a favour" },
    profile,
    costResult
  );
  ck("13a. Override Reason is written through to the payload", payload["Override Reason"] === "Covering as a favour", JSON.stringify(payload));
  const missingReasonError = validateCreateAllocationInput({
    coachId: "recAAAAAAAAAAAAAA",
    sessionOccurrenceId: "recBBBBBBBBBBBBBB",
    workDateIso: "2026-10-05",
    rateType: "Evening",
    assignmentType: "Cover",
    paidUnits: 1,
    costOverride: 40,
    overrideReason: "",
  });
  ck("13b. A Cost Override with a blank Override Reason fails validation - required, not optional", typeof missingReasonError === "string" && /overrideReason/.test(missingReasonError), String(missingReasonError));
}

// --- 14. Ambiguous overlapping same-type rates fail safely ---
{
  const rows = [
    rateProfile("rpOverlapA", { Amount: 25, "Effective From": "2026-09-01", "Effective Until": "2026-10-15" }),
    rateProfile("rpOverlapB", { Amount: 27, "Effective From": "2026-10-01", "Effective Until": "2026-10-31" }),
  ];
  const r = resolveCoachRateProfile(COACH_DANNY, "2026-10-10", "Evening", rows);
  ck(
    "14. Two Active, date-applicable, same-Rate-Type profiles overlapping on the same date -> reported as ambiguous, neither silently chosen (no precedence field exists on the real schema)",
    r.status === "ambiguous" && r.status === "ambiguous" && r.candidates.length === 2,
    JSON.stringify(r)
  );
}

// --- 15. Missing applicable rate fails safely ---
{
  const r = resolveCoachRateProfile(COACH_OTHER, "2026-09-20", "Evening", [rateProfile("rpForDanny")]);
  ck("15. No applicable Rate Profile for this Coach -> fails safely as missing, never a fallback guess", r.status === "missing", JSON.stringify(r));
  const r2 = resolveCoachRateProfile(COACH_DANNY, "2026-09-20", "Camp", [rateProfile("rpEveningOnly")]);
  ck("15b. No applicable Rate Profile of the requested Rate Type -> also missing", r2.status === "missing", JSON.stringify(r2));
}

// --- KNOWN_RATE_TYPES sanity: matches the real TEST schema's Rate Type choices exactly ---
{
  ck("Rate Type choices match the real TEST schema (Day, Evening, Camp, Additional / Plus)", JSON.stringify(KNOWN_RATE_TYPES) === JSON.stringify(["Day", "Evening", "Camp", "Additional / Plus"]));
}

// --- 16. Duplicate allocation attempt does not create duplicate payable work ---
{
  const BASE_ID = "appFAKE00000000AA";
  const COACH_ID = "recCoachDDDDDDDDD";
  const OCC_ID = "recOccurrenceEEEE";
  const RATE_PROFILE_ID = "recRateProfileFFF";
  const ALLOC_ID = "recAllocationGGGG";

  let createCalls = 0;
  let existingAllocations: any[] = [];

  function jsonResponse(body: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();

    if (u.endsWith(`/Coaches/${COACH_ID}`) && method === "GET") return jsonResponse({ id: COACH_ID, fields: { "Coach Name": "Danny Handover" } });
    if (u.endsWith(`/Session%20Occurrences/${OCC_ID}`) && method === "GET") return jsonResponse({ id: OCC_ID, fields: { Date: "2026-09-20" } });
    if (/\/Coach%20Allocations(\?.*)?$/.test(u) && method === "GET") return jsonResponse({ records: existingAllocations });
    if (/\/Coach%20Rate%20Profiles(\?.*)?$/.test(u) && method === "GET") {
      return jsonResponse({ records: [{ id: RATE_PROFILE_ID, fields: { Coach: [COACH_ID], "Rate Type": "Evening", "Pay Unit": "Per Hour", Amount: 25, Active: true } }] });
    }
    if (/\/Coach%20Allocations$/.test(u) && method === "POST") {
      createCalls++;
      existingAllocations = [{ id: ALLOC_ID, fields: { Coach: [COACH_ID], "Session Occurrence": [OCC_ID] } }];
      return jsonResponse({ records: [{ id: ALLOC_ID }] });
    }
    throw new Error(`Unexpected fetch in duplicate-allocation test: ${method} ${u}`);
  }) as typeof fetch;

  try {
    const params = {
      coachId: COACH_ID,
      sessionOccurrenceId: OCC_ID,
      workDateIso: "2026-09-20",
      rateType: "Evening",
      assignmentType: "Scheduled",
      paidUnits: 1,
    };
    const first = await createCoachAllocationForOccurrence({ airtable: { baseId: BASE_ID, token: "fake" } }, params);
    const second = await createCoachAllocationForOccurrence({ airtable: { baseId: BASE_ID, token: "fake" } }, params);
    ck("16a. First call for a (Coach, Session Occurrence) pair creates an allocation", first.status === "created", JSON.stringify(first));
    ck("16b. A second call for the SAME (Coach, Session Occurrence) pair returns the existing allocation instead of creating another", second.status === "existing" && (second as any).recordId === ALLOC_ID, JSON.stringify(second));
    ck("16c. Only ONE real create call was ever made to Coach Allocations, even though the function was called twice", createCalls === 1, String(createCalls));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
