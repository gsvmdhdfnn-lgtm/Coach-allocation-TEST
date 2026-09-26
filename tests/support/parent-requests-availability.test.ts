// Unit tests for the parent-hub containment fix. This is this test file's
// own copy of the exact logic now in parent-hub/index.ts (same duplication
// convention as player-access.ts).
//
// The live failure on 2026-09-26: "Player Session Requests" began returning
// 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND, it was read inside
// handleParentMe's Promise.all, so one unavailable table rejected the whole
// handler and took the entire Parent Hub down.
const RAW = 'Airtable error for Player Session Requests: 403 {"error":{"type":"INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"}}';

// Mirrors fetchSessionRequests(): contains the failure instead of propagating it.
async function fetchSessionRequests(read: () => Promise<any[]>): Promise<{ rows: any[]; available: boolean }> {
  try {
    return { rows: await read(), available: true };
  } catch {
    return { rows: [], available: false };
  }
}

// Mirrors handleParentMe's gather step: everything else still rejects
// normally, so a genuine outage is still an error - only the optional
// requests read is contained.
async function gather(readRequests: () => Promise<any[]>) {
  const [core, sessionRequests] = await Promise.all([
    Promise.resolve({ children: [{ name: "Alfie" }] }),
    fetchSessionRequests(readRequests),
  ]);
  return { ...core, session_requests_available: sessionRequests.available, requests: sessionRequests.rows };
}

// Mirrors handleParentSessionRequest's new guard.
async function submitRequest(readRequests: () => Promise<any[]>) {
  const sessionRequests = await fetchSessionRequests(readRequests);
  if (!sessionRequests.available) {
    return { status: 503, body: { error: "Session requests are temporarily unavailable. Please contact us and we'll sort it for you." } };
  }
  return { status: 200, body: { ok: true } };
}

// Mirrors the router's catch-all.
function catchAllResponse(error: Error) {
  return { status: 500, body: { error: "Something went wrong. Please try again." } };
}

const ok = async () => [{ id: "req1" }];
const dead = async () => { throw new Error(RAW); };

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

{
  const res = await gather(dead);
  ck("An unavailable requests table no longer rejects the whole handler", !!res);
  ck("...the Parent Hub payload is still built", Array.isArray(res.children) && res.children.length === 1);
  ck("...and the feature reports itself unavailable", res.session_requests_available === false);
  ck("...with an empty rather than partial request list", res.requests.length === 0);
}
{
  const res = await gather(ok);
  ck("A healthy requests table reports available", res.session_requests_available === true);
  ck("...and its rows come through", res.requests.length === 1);
}
{
  // The distinction the client depends on: "none pending" and "cannot
  // tell you" must never be the same value.
  const healthyButEmpty = await gather(async () => []);
  const broken = await gather(dead);
  ck("An empty list is NOT reported as unavailable", healthyButEmpty.session_requests_available === true);
  ck("...and is distinguishable from the unavailable case", healthyButEmpty.session_requests_available !== broken.session_requests_available);
}
{
  const down = await submitRequest(dead);
  ck("Submitting while unavailable is refused with 503", down.status === 503, String(down.status));
  ck("...and never silently succeeds", down.body.error !== undefined);
  ck("...with no backend detail in the message", !/Airtable|403|INVALID_PERMISSIONS/i.test(down.body.error as string));
  const up = await submitRequest(ok);
  ck("Submitting while healthy still works", up.status === 200);
}
{
  const res = catchAllResponse(new Error(RAW));
  ck("The catch-all never returns the raw error", !/Airtable|403|INVALID_PERMISSIONS|Player Session Requests/i.test(res.body.error));
  ck("...and stays a 500", res.status === 500);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
