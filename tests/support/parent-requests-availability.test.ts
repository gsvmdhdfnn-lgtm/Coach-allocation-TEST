// Unit tests for the parent-hub containment fix. This is this test file's
// own copy of the exact logic now in parent-hub/index.ts (same duplication
// convention as player-access.ts).
//
// The live failure on 2026-09-26: "Player Session Requests" began returning
// 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND, it was read inside
// handleParentMe's Promise.all, so one unavailable table rejected the whole
// handler and took the entire Parent Hub down.
const RAW = 'Airtable error for Player Session Requests: 403 {"error":{"type":"INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"}}';

// Mirrors SESSION_REQUESTS_ENABLED + fetchSessionRequests(). Availability
// is a deliberate flag AND a contained read - not just "did the read
// succeed" - because the Management side that processes requests is
// hidden. If the old table's 403 cleared on its own, a read-driven check
// would silently re-open the parent form into a queue nobody reads.
async function fetchSessionRequests(read: () => Promise<any[]>, enabled: boolean): Promise<{ rows: any[]; available: boolean }> {
  if (!enabled) return { rows: [], available: false };
  try {
    return { rows: await read(), available: true };
  } catch {
    return { rows: [], available: false };
  }
}

// The value actually shipped in this release.
const SHIPPED_ENABLED = false;

// Mirrors handleParentMe's gather step: everything else still rejects
// normally, so a genuine outage is still an error - only the optional
// requests read is contained.
async function gather(readRequests: () => Promise<any[]>, enabled = true) {
  const [core, sessionRequests] = await Promise.all([
    Promise.resolve({ children: [{ name: "Alfie" }] }),
    fetchSessionRequests(readRequests, enabled),
  ]);
  return { ...core, session_requests_available: sessionRequests.available, requests: sessionRequests.rows };
}

// Mirrors handleParentSessionRequest's new guard.
async function submitRequest(readRequests: () => Promise<any[]>, enabled = true) {
  const sessionRequests = await fetchSessionRequests(readRequests, enabled);
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

{
  // The case that matters if the 403 clears by itself: the old table reads
  // perfectly, and the answer must STILL be "unavailable" everywhere,
  // because the Management side that processes requests is hidden.
  const res = await gather(ok, false);
  ck("A readable table does NOT re-enable the feature while it is switched off", res.session_requests_available === false);
  ck("...and no request rows are surfaced", res.requests.length === 0);
  ck("...while the rest of the hub payload is unaffected", res.children.length === 1);
  const sub = await submitRequest(ok, false);
  ck("...and submitting is still refused with 503", sub.status === 503, String(sub.status));
  ck("...with the same parent-facing wording as the unreadable case", /temporarily unavailable/i.test(sub.body.error as string));
}
{
  // The shipped configuration, stated explicitly so a future change to
  // the flag has to change this test deliberately.
  const res = await gather(ok, SHIPPED_ENABLED);
  const sub = await submitRequest(ok, SHIPPED_ENABLED);
  ck("As shipped, the flag reports unavailable even on a healthy read", res.session_requests_available === false);
  ck("As shipped, submission is refused", sub.status === 503);
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? "  -- " + x : ""}`).join("\n"));
console.log(`\n${R.filter((r) => r[0] === "PASS").length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
