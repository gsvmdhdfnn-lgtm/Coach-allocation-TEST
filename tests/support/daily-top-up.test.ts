// Unit test for the Slice 8 daily-top-up sweep's failure-isolation
// contract (see TEST-ENV.md, Slice 8). Real TEST verification proved the
// happy paths (idempotent rerun, concurrent-overlap safety, Selected
// Dates/One-off/Draft/Inactive handling - all against the real deployed
// function via pg_net). Genuinely forcing ONE Session to throw during a
// real sweep turned out to be impractical without an unreliable network
// race: every Session-level input the generator/orchestrator touch
// (Default Day, Default Start/End Time, dates) is designed to fail
// CLOSED rather than throw (see generator.ts's own header) - the only
// realistic thrown error is an Airtable fetch-level failure (e.g. the
// Session record itself vanishing between the sweep's initial list call
// and its per-Session fetch), and reproducing that live requires winning
// a race against the Edge Function's own execution speed that two
// deliberate live attempts (documented in TEST-ENV.md) did not win.
//
// This file proves the exact same code path deterministically instead,
// by mocking global fetch so ONE of two Active Sessions' individual
// fetchSession() call 404s (simulating that exact "vanished between list
// and fetch" race) while the other succeeds normally - no Airtable/
// Supabase network call is made anywhere in this file.
import { runDailyTopUp } from "./daily-top-up.ts";
import { createSupabaseLockClient } from "./lock-client.ts";
import type { OrchestratorDeps } from "./session-orchestrator.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const BASE_ID = "appFAKE00000000AA";
const BAD_ID = "recAAAAAAAAAAAAAA";
const GOOD_ID = "recBBBBBBBBBBBBBB";
const SUPABASE_URL = "https://fake.supabase.co";

const goodSessionFields = {
  "Session Lifecycle Status": "Active",
  "Schedule Pattern": "Recurring",
  "Default Day": "Monday",
  "Default Start Time": "10:00",
  "Default End Time": "11:00",
  "Start Date": "2020-01-01",
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

let createCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, opts: any = {}) => {
  const u = String(url);
  const method = (opts.method || "GET").toUpperCase();

  // Sessions table - whole-table list (fetchActiveSessions).
  if (/\/Sessions(\?.*)?$/.test(u) && method === "GET") {
    return jsonResponse({
      records: [
        { id: BAD_ID, fields: goodSessionFields },
        { id: GOOD_ID, fields: goodSessionFields },
      ],
    });
  }
  // Sessions/:id - single record fetch (fetchSession, inside generateForSession).
  if (u.endsWith(`/Sessions/${BAD_ID}`) && method === "GET") {
    return jsonResponse({ error: { type: "MODEL_NOT_FOUND" } }, 404);
  }
  if (u.endsWith(`/Sessions/${GOOD_ID}`) && method === "GET") {
    return jsonResponse({ id: GOOD_ID, fields: goodSessionFields });
  }
  // Session Dates - whole-table list, both Sessions' calls hit this.
  if (/\/Session%20Dates(\?.*)?$/.test(u) && method === "GET") {
    return jsonResponse({ records: [] });
  }
  // Session Occurrences - whole-table list (existing occurrences check).
  if (/\/Session%20Occurrences(\?.*)?$/.test(u) && method === "GET") {
    return jsonResponse({ records: [] });
  }
  // Session Occurrences - batch create (only GOOD's shells ever reach this).
  if (/\/Session%20Occurrences$/.test(u) && method === "POST") {
    const body = JSON.parse(opts.body);
    const records = body.records.map(() => ({ id: `recNEWOCC${++createCalls}` }));
    return jsonResponse({ records });
  }
  // Supabase lock RPCs - always succeed; sequential processing means no
  // real concurrency to arbitrate between BAD and GOOD in this test.
  if (u === `${SUPABASE_URL}/rest/v1/rpc/acquire_generation_lock` && method === "POST") {
    return jsonResponse("test-lock-token");
  }
  if (u === `${SUPABASE_URL}/rest/v1/rpc/release_generation_lock` && method === "POST") {
    return jsonResponse(true);
  }
  throw new Error(`Unexpected fetch in daily-top-up.test.ts: ${method} ${u}`);
}) as typeof fetch;

const deps: OrchestratorDeps = {
  airtable: { baseId: BASE_ID, token: "fake-token" },
  lock: createSupabaseLockClient({ supabaseUrl: SUPABASE_URL, serviceRoleKey: "fake-key" }),
};

const NOW = new Date("2026-09-27T12:00:00Z");

const summary = await runDailyTopUp(deps, NOW);

globalThis.fetch = originalFetch;

ck("Both Sessions are considered", summary.considered === 2, JSON.stringify(summary));
ck("The vanished Session is reported failed, not silently dropped", summary.failed === 1, JSON.stringify(summary.failures));
ck("...naming its own record ID", summary.failures[0]?.sessionRecordId === BAD_ID, JSON.stringify(summary.failures));
ck("...with a non-empty error message (never swallowed)", typeof summary.failures[0]?.error === "string" && summary.failures[0].error.length > 0);
ck("The sweep still reaches the LATER Session and generates for it", summary.generated === 1, JSON.stringify(summary));
ck("...creating its occurrence shells", summary.occurrencesCreated > 0, JSON.stringify(summary));
ck("noChanges/skippedLocked stay at 0 - the only two outcomes here are failed and generated", summary.noChanges === 0 && summary.skippedLocked === 0, JSON.stringify(summary));

for (const [status, name, extra] of R) {
  console.log(`${status === "PASS" ? "✓" : "✗"} ${name}${extra ? ` (${extra})` : ""}`);
}
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} checks passed`);
if (failed) process.exit(1);
