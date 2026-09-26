// The refusal guard that stops any test run reaching a real Airtable base
// it should not. Plain CommonJS rather than a type-stripping shim, because
// the guard itself is plain JS and needs no transform.
const {
  PRODUCTION_BASE_IDS,
  BaseGuardError,
  assertTestBase,
  assertSafeToWrite,
  TEST_BASE_ID,
} = require('../support/base-guard.js');

const R = [];
let failed = false;
function ck(name, cond, extra) {
  R.push([cond ? 'PASS' : 'FAIL', name, extra || '']);
  if (!cond) failed = true;
}
/** Returns the thrown error, or null if the call unexpectedly succeeded. */
function refusal(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

// --- the case this whole file exists for --------------------------------
{
  // Verified 2026-09-26 as the base the deployed Edge Functions read.
  const e = refusal(() => assertTestBase('apprptFotQuVL1mhs'));
  ck('The live Josh Evans Hub base is refused', e instanceof BaseGuardError);
  ck('...and the refusal names the base so the message explains itself',
    !!e && /apprptFotQuVL1mhs/.test(e.message));
  ck('...and says which base it is, not just "denied"',
    !!e && /live base the deployed Hub reads/.test(e.message));
}
{
  const e = refusal(() => assertTestBase('app6ex6UHY2RRO2Ak'));
  ck('Master Copy is refused too - a template is not a test base', e instanceof BaseGuardError);
  ck('...and the refusal says it must stay untouched',
    !!e && /must stay untouched/.test(e.message));
}
{
  // The exact accident the guard exists for: an environment variable
  // named for testing, pointing at production. A "is TEST set" check
  // would let this through.
  process.env.TEST_AIRTABLE_BASE_ID = 'apprptFotQuVL1mhs';
  process.env.NODE_ENV = 'test';
  const e = refusal(() => assertTestBase(process.env.TEST_AIRTABLE_BASE_ID, 'from TEST_AIRTABLE_BASE_ID'));
  ck('A TEST variable set to the production base is still refused', e instanceof BaseGuardError);
  ck('...and the refusal says the environment does not excuse it',
    !!e && /whatever TEST or NODE_ENV is set to/.test(e.message));
  ck('...and names where the bad value came from',
    !!e && /from TEST_AIRTABLE_BASE_ID/.test(e.message));
  delete process.env.TEST_AIRTABLE_BASE_ID;
}
{
  // Case variation must not slip past the deny list.
  const e = refusal(() => assertTestBase('APPRPTFOTQUVL1MHS'));
  ck('A wrong-case production base ID is refused, not merely malformed',
    e instanceof BaseGuardError && /live base the deployed Hub reads/.test(e.message));
}
{
  // Padding must not defeat an exact string comparison.
  const e = refusal(() => assertTestBase('  apprptFotQuVL1mhs\n'));
  ck('Surrounding whitespace does not smuggle the production base through',
    e instanceof BaseGuardError && /live base the deployed Hub reads/.test(e.message));
}

// --- the declared test base ----------------------------------------------
{
  ck('A test base is declared', TEST_BASE_ID === 'appQktredAuGa1X7e', String(TEST_BASE_ID));
  ck('...and it is not one of the bases on the deny list',
    !Object.keys(PRODUCTION_BASE_IDS).includes(TEST_BASE_ID));
  ck('...and it is accepted', assertTestBase(TEST_BASE_ID) === TEST_BASE_ID);
  const e = refusal(() => assertTestBase('appAAAAAAAAAAAAAA'));
  ck('An unknown but well-formed base is still refused',
    e instanceof BaseGuardError && /is not the declared test base/.test(e.message));
  ck('...and the refusal explains that a well-formed typo is not enough',
    !!e && /must not reach a live base/.test(e.message));
}
['', '   ', null, undefined, 0, {}].forEach(function (v) {
  const e = refusal(() => assertTestBase(v));
  ck('A missing base ID is refused, never defaulted (' + JSON.stringify(v) + ')',
    e instanceof BaseGuardError && /No Airtable base ID was provided/.test(e.message));
});
['app123', 'apprptFotQuVL1mhsX', 'tblrptFotQuVL1mhs', 'https://airtable.com/apprptFotQuVL1mhs'].forEach(function (v) {
  const e = refusal(() => assertTestBase(v));
  ck('A malformed base ID is refused (' + v + ')', e instanceof BaseGuardError);
});

// --- the write path uses the same refusal --------------------------------
{
  const e = refusal(() => assertSafeToWrite('apprptFotQuVL1mhs'));
  ck('The write helper refuses the production base as well', e instanceof BaseGuardError);
  ck('...and its default context says a write was about to happen',
    !!e && /about to write records/.test(e.message));
}

// --- the deny list is data, and stays honest ------------------------------
{
  const ids = Object.keys(PRODUCTION_BASE_IDS);
  ck('Both known real bases are on the deny list', ids.length === 2, ids.join(', '));
  ck('...every entry states a reason', ids.every((k) => !!PRODUCTION_BASE_IDS[k]));
  ck('...and the list cannot be edited at runtime to open a hole',
    (function () {
      try { PRODUCTION_BASE_IDS.apprptFotQuVL1mhs = ''; } catch (e) { /* strict mode throws */ }
      return PRODUCTION_BASE_IDS.apprptFotQuVL1mhs !== '';
    })());
}

console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
process.exit(failed ? 1 : 0);
