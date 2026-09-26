// Proves the refusal reaches every real Airtable request - not just the
// test suite's own entry point. Seeding scripts, fixtures and helpers all
// go through createTestAirtableClient, so these assertions are what stands
// between a mistake and the live base.
const {
  API_ROOT,
  TestTokenError,
  readTestToken,
  assertUrlTargetsTestBase,
  createTestAirtableClient,
} = require('../support/airtable-client.js');
const { BaseGuardError, TEST_BASE_ID } = require('../support/base-guard.js');

const LIVE = 'apprptFotQuVL1mhs';
const MASTER = 'app6ex6UHY2RRO2Ak';

const R = [];
let failed = false;
function ck(name, cond, extra) {
  R.push([cond ? 'PASS' : 'FAIL', name, extra || '']);
  if (!cond) failed = true;
}
function refusal(fn) { try { fn(); return null; } catch (e) { return e; } }
async function refusalAsync(fn) { try { await fn(); return null; } catch (e) { return e; } }

// A fetch that records calls and fails the run if it is ever reached with
// a URL outside the test base. Nothing here ever touches the network.
function spyFetch(log) {
  return async function (url) {
    log.push(url);
    return { ok: true, status: 200, json: async () => ({ records: [] }), text: async () => '' };
  };
}

// --- construction is already a refusal point -----------------------------
{
  const e = refusal(() => createTestAirtableClient({ baseId: LIVE, token: 't' }));
  ck('A client cannot be built against the live base', e instanceof BaseGuardError);
  ck('...and says it was refused while creating a client',
    !!e && /creating an Airtable client/.test(e.message));
}
{
  const e = refusal(() => createTestAirtableClient({ baseId: MASTER, token: 't' }));
  ck('A client cannot be built against Master Copy', e instanceof BaseGuardError);
}
{
  const e = refusal(() => createTestAirtableClient({ baseId: 'appAAAAAAAAAAAAAA', token: 't' }));
  ck('A client cannot be built against an undeclared base',
    e instanceof BaseGuardError && /is not the declared test base/.test(e.message));
  ck('...and the declared test base is the one that was created for this',
    TEST_BASE_ID === 'appQktredAuGa1X7e', String(TEST_BASE_ID));
}

// --- the credential ------------------------------------------------------
{
  const e = refusal(() => readTestToken({}));
  ck('A missing TEST_AIRTABLE_TOKEN is refused', e instanceof TestTokenError);
  ck('...and the message says to scope the token to the test base',
    !!e && /scoped to the test base only/.test(e.message));
}
{
  // The live token being exported is normal on a machine that deploys.
  const e = refusal(() => readTestToken({ AIRTABLE_TOKEN: 'pat_live_value' }));
  ck('The production AIRTABLE_TOKEN is never used as a fallback',
    e instanceof TestTokenError && /is not set/.test(e.message));
}
{
  const e = refusal(() => readTestToken({ AIRTABLE_TOKEN: 'pat_same', TEST_AIRTABLE_TOKEN: 'pat_same' }));
  ck('A test token that is really the live token is refused',
    e instanceof TestTokenError && /same value as AIRTABLE_TOKEN/.test(e.message));
}
{
  const t = readTestToken({ TEST_AIRTABLE_TOKEN: '  pat_test_value  ' });
  ck('A genuine test token is accepted and trimmed', t === 'pat_test_value');
}

// --- the URL check, which is what actually goes over the wire ------------
{
  const e = refusal(() => assertUrlTargetsTestBase(API_ROOT + LIVE + '/Players', 'appTESTTESTTEST1', 'GET'));
  ck('A URL aimed at the live base is refused even if the client thinks it is safe',
    e instanceof BaseGuardError);
  ck('...and the refusal quotes the URL it stopped',
    !!e && new RegExp(LIVE).test(e.message));
}
{
  const ok = assertUrlTargetsTestBase(API_ROOT + 'appTESTTESTTEST1/Players', 'appTESTTESTTEST1', 'GET');
  ck('A URL aimed at the declared base passes', ok.indexOf('appTESTTESTTEST1') > 0);
}
['https://api.airtable.com/v0/appTESTTESTTEST1x/Players',
 'https://evil.example.com/v0/appTESTTESTTEST1/Players',
 'https://api.airtable.com/v0/apprptFotQuVL1mhs/Players?x=appTESTTESTTEST1'].forEach(function (u) {
  const e = refusal(() => assertUrlTargetsTestBase(u, 'appTESTTESTTEST1', 'POST'));
  ck('A near-miss URL is refused (' + u.slice(0, 58) + '…)', e instanceof BaseGuardError);
});

// --- every verb, including the seeding writes ----------------------------
// Runs the real request path against the real declared test base, with a
// recording fetch in place of the network. No request leaves this process,
// and every URL is asserted.
(async function () {
  const log = [];
  const client = createTestAirtableClient({
    baseId: TEST_BASE_ID, token: 'pat_test_not_a_real_token', fetch: spyFetch(log),
  });

  await client.list('Players');
  await client.create('Players', [{ fields: { 'Player Name': 'Test Child' } }]);
  await client.update('Players', [{ id: 'rec1', fields: { 'Player Name': 'Test Child 2' } }]);
  await client.remove('Players', ['rec1']);
  ck('Read and all three write verbs go through one request path', log.length === 4, String(log.length));
  ck('...and every single one targeted the declared test base',
    log.every((u) => u.indexOf(API_ROOT + TEST_BASE_ID + '/') === 0));
  ck('...with none of them reaching the live base or Master Copy',
    log.every((u) => u.indexOf(LIVE) === -1 && u.indexOf(MASTER) === -1));
  ck('...and the client records what it sent, for a seeding dry run',
    client.sentRequests().length === 4);

  refusal(() => { client.baseId = LIVE; });
  ck('A built client cannot be re-pointed at the live base afterwards',
    client.baseId === TEST_BASE_ID, client.baseId);

  const e2 = await refusalAsync(() => client.create('', [{ fields: {} }]));
  ck('A write with no table named is refused before any fetch',
    e2 instanceof BaseGuardError && log.length === 4);

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(failed ? 1 : 0);
})();
