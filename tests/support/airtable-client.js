/**
 * The ONLY way anything in this repo is allowed to talk to a real Airtable
 * base. Test functions, seeding scripts, fixtures and one-off helpers all
 * go through here, so the refusal in base-guard.js sits in front of every
 * request rather than only in front of the test suite.
 *
 * Three things are checked before a request is built, and again before it
 * is sent:
 *
 *  1. the base is the declared test base (base-guard.js refuses anything
 *     else, production first);
 *  2. the credential came from TEST_AIRTABLE_TOKEN - the production
 *     variable name AIRTABLE_TOKEN is never read, so a shell that has the
 *     live token exported cannot lend it to a test run;
 *  3. the URL about to be fetched actually points at that base. The first
 *     two checks pass a string around; this one checks the thing that is
 *     really about to go over the wire, which is what a mistake would
 *     otherwise slip past.
 */
const { assertTestBase, BaseGuardError } = require('./base-guard.js');

const API_ROOT = 'https://api.airtable.com/v0/';

/** Write verbs, listed so the guard can say plainly what it stopped. */
const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

class TestTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestTokenError';
  }
}

/**
 * Reads the test credential. Deliberately does NOT fall back to
 * AIRTABLE_TOKEN: the live token being present in the environment is the
 * normal case on a machine that deploys, and a fallback would quietly use
 * it. A token that can reach the live base is refused even for a read.
 */
function readTestToken(env) {
  const e = env || process.env;
  const token = typeof e.TEST_AIRTABLE_TOKEN === 'string' ? e.TEST_AIRTABLE_TOKEN.trim() : '';
  if (!token) {
    throw new TestTokenError(
      'REFUSING TO RUN: TEST_AIRTABLE_TOKEN is not set. Create an Airtable personal access token ' +
        'scoped to the test base only, and export it as TEST_AIRTABLE_TOKEN. ' +
        'AIRTABLE_TOKEN (the production variable) is never read by tests.'
    );
  }
  if (token === (e.AIRTABLE_TOKEN || '').trim()) {
    throw new TestTokenError(
      'REFUSING TO RUN: TEST_AIRTABLE_TOKEN holds the same value as AIRTABLE_TOKEN. ' +
        'The test token must be a separate token scoped to the test base only, ' +
        'so that a test run physically cannot reach the live base.'
    );
  }
  return token;
}

/**
 * Last line of defence: the URL itself. Called immediately before every
 * fetch, on the exact string being requested.
 */
function assertUrlTargetsTestBase(url, baseId, method) {
  const prefix = API_ROOT + baseId + '/';
  if (typeof url !== 'string' || url.indexOf(prefix) !== 0) {
    throw new BaseGuardError(
      `REFUSING TO SEND ${method || 'GET'}: the request URL does not target the test base ${baseId}. ` +
        `Refusing rather than sending: ${String(url).slice(0, 120)}`
    );
  }
  return url;
}

/**
 * Builds a client bound to one base. `baseId` is validated here and again
 * on every call, so re-pointing a client after construction cannot work.
 * The returned object is frozen for the same reason.
 */
function createTestAirtableClient(options) {
  const opts = options || {};
  const baseId = assertTestBase(opts.baseId, 'creating an Airtable client');
  const token = opts.token || readTestToken(opts.env);
  const fetchImpl = opts.fetch || globalThis.fetch;
  const sent = [];

  async function request(method, tablePath, { query, body } = {}) {
    // Re-checked per call, not just at construction.
    assertTestBase(baseId, `${method} ${tablePath}`);
    if (!tablePath) throw new BaseGuardError('REFUSING TO SEND: no table was named.');

    let url = API_ROOT + baseId + '/' + encodeURIComponent(tablePath);
    if (query && Object.keys(query).length) {
      const q = new URLSearchParams();
      Object.keys(query).forEach((k) => { if (query[k] != null) q.set(k, String(query[k])); });
      const s = q.toString();
      if (s) url += '?' + s;
    }
    assertUrlTargetsTestBase(url, baseId, method);

    sent.push({ method, url });
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable ${method} ${tablePath} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  return Object.freeze({
    baseId,
    /** Everything the seeding scripts need, all funnelled through request(). */
    list: (table, query) => request('GET', table, { query }),
    create: (table, records) => request('POST', table, { body: { records } }),
    update: (table, records) => request('PATCH', table, { body: { records } }),
    remove: (table, ids) => request('DELETE', table, { query: { 'records[]': ids } }),
    /** Exposed so tests can assert what a seeding run would really send. */
    sentRequests: () => sent.slice(),
  });
}

module.exports = {
  API_ROOT,
  WRITE_METHODS,
  TestTokenError,
  readTestToken,
  assertUrlTargetsTestBase,
  createTestAirtableClient,
};
