/**
 * The refusal guard for anything that talks to a real Airtable base.
 *
 * The rule is NOT "is a TEST variable set". A TEST variable set to the
 * production base ID is exactly the accident this exists to stop, and it
 * would pass that check. So this works the other way round: a base is
 * refused unless it is the one base we have declared as the test base,
 * and it is refused outright if it is a base we know must never be
 * written to by a test run.
 *
 * Failure is loud and immediate. There is no "warn and continue" mode,
 * because a test that silently ran against the live Hub would have
 * already done its damage by the time anyone read the warning.
 */

/**
 * Bases a test run must never touch, with the reason stated so the error
 * message explains itself. Verified 2026-09-26: apprptFotQuVL1mhs is the
 * base the deployed Edge Functions actually read - confirmed by the
 * SHA-256 digest of the AIRTABLE_BASE_ID secret on project
 * bkkukymqaxawnudoxdjs.
 */
const PRODUCTION_BASE_IDS = Object.freeze({
  apprptFotQuVL1mhs: 'Josh Evans Hub - the live base the deployed Hub reads',
  app6ex6UHY2RRO2Ak: 'Master Copy - the template, which must stay untouched',
});

/**
 * The one base a test run is allowed to use: "Josh Evans Hub - TEST"
 * (appQktredAuGa1X7e), created 2026-09-26 in My First Workspace with
 * synthetic data only. While this is null EVERY base is refused - the
 * safe default is "no real base at all", not "any base that is not
 * production".
 */
const TEST_BASE_ID = 'appQktredAuGa1X7e';

const BASE_ID_SHAPE = /^app[A-Za-z0-9]{14}$/;

class BaseGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaseGuardError';
  }
}

/**
 * Throws unless `raw` is the declared test base. Returns the trimmed id
 * on success so callers can use the return value rather than the raw
 * input, and never silently accept a padded string.
 */
function assertTestBase(raw, context) {
  const where = context ? ` (${context})` : '';
  const id = typeof raw === 'string' ? raw.trim() : '';

  if (!id) {
    throw new BaseGuardError(
      `No Airtable base ID was provided${where}. Tests that talk to a real base must be given the test base ID explicitly.`
    );
  }

  // Case-insensitive against the deny list: Airtable IDs are
  // case-sensitive and a wrong-case ID would fail at the API anyway, but
  // a near-miss must be refused here rather than anywhere later.
  const denied = Object.keys(PRODUCTION_BASE_IDS).find(
    (p) => p.toLowerCase() === id.toLowerCase()
  );
  if (denied) {
    throw new BaseGuardError(
      `REFUSING TO RUN${where}: ${id} is ${PRODUCTION_BASE_IDS[denied]}. ` +
        `Tests never run against it, whatever TEST or NODE_ENV is set to.`
    );
  }

  if (!BASE_ID_SHAPE.test(id)) {
    throw new BaseGuardError(
      `REFUSING TO RUN${where}: "${id}" is not a valid Airtable base ID (expected app + 14 alphanumerics).`
    );
  }

  if (!TEST_BASE_ID) {
    throw new BaseGuardError(
      `REFUSING TO RUN${where}: no test base has been declared yet. ` +
        `Set TEST_BASE_ID in tests/support/base-guard.js once the isolated test base exists.`
    );
  }

  if (id !== TEST_BASE_ID) {
    throw new BaseGuardError(
      `REFUSING TO RUN${where}: ${id} is not the declared test base (${TEST_BASE_ID}). ` +
        `An unrecognised base is refused even though it is not a known production base - ` +
        `a typo that happens to be well-formed must not reach a live base.`
    );
  }

  return id;
}

/**
 * For write helpers that already know their base: same refusal, phrased
 * for the call site that is about to create or modify records.
 */
function assertSafeToWrite(raw, context) {
  return assertTestBase(raw, context || 'about to write records');
}

module.exports = {
  PRODUCTION_BASE_IDS,
  TEST_BASE_ID,
  BASE_ID_SHAPE,
  BaseGuardError,
  assertTestBase,
  assertSafeToWrite,
};
