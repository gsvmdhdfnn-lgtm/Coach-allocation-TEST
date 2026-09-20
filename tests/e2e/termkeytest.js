// Pure-logic test for schoolTermRows()/termAllows() (coach.js) - imports the
// real exported functions rather than reproducing them, since they're plain
// JS with no DOM interaction of their own. core.js (which coach.js imports
// from) does touch document/window/location at module-evaluation time, so
// this stubs the minimal shape needed for that top-level code to run, same
// as a browser would provide, without needing a real page or Playwright.
global.window = { APP_CONFIG: {} };
global.location = { search: '' };
global.document = { getElementById: function () { return null; } };

const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const core = await import('../../core.js');
  const coach = await import('../../coach.js');
  const { schoolTermRows, termAllows } = coach;
  const { state } = core;

  // Three distinguishable terms, keyed by different levels of the fallback
  // chain, with non-overlapping date ranges so a wrong match is obvious.
  state.terms = [
    { school: 'North Downs (Leigh)', starts: '2024-09-02', ends: '2025-07-25' }, // term_key-level
    { school: 'North Downs', starts: '2020-01-06', ends: '2020-01-06' },          // client-level
    { school: 'Test Venue', starts: '2030-01-07', ends: '2030-12-30' },           // venue-level
  ];

  // --- Scenario 1: term_key present -> uses the term_key term, even though
  // client alone would resolve to a different (and here, wrong) term. This
  // is exactly the D19 example from the request: client = North Downs,
  // venue = North Downs (Leigh), term_key = North Downs (Leigh).
  const d19 = { id: 'D19', client: 'North Downs', venue: 'North Downs (Leigh)', termKey: 'North Downs (Leigh)' };
  let rows = schoolTermRows(d19);
  ck('term_key present: matches the term_key row, not the client row', rows.length === 1 && rows[0].school === 'North Downs (Leigh)', JSON.stringify(rows));
  ck('term_key present: in-term date (inside the term_key range) allows the session', termAllows(d19, new Date(2024, 9, 7)) === true);
  ck('term_key present: a date only inside the CLIENT term is correctly rejected (proves term_key, not client, decided this)', termAllows(d19, new Date(2020, 0, 6)) === false);

  // --- Scenario 2: blank term_key -> falls back to client
  const blankKeyHasClient = { id: 'X1', client: 'North Downs', venue: 'North Downs (Leigh)', termKey: '' };
  rows = schoolTermRows(blankKeyHasClient);
  ck('blank term_key: falls back to client, not venue', rows.length === 1 && rows[0].school === 'North Downs', JSON.stringify(rows));
  ck('blank term_key: date inside the client term allows the session', termAllows(blankKeyHasClient, new Date(2020, 0, 6)) === true);

  // --- Scenario 3: blank term_key AND blank client -> falls back to venue
  const blankKeyAndClient = { id: 'X2', client: '', venue: 'Test Venue', termKey: '' };
  rows = schoolTermRows(blankKeyAndClient);
  ck('blank term_key and client: falls back to venue', rows.length === 1 && rows[0].school === 'Test Venue', JSON.stringify(rows));
  ck('blank term_key and client: date inside the venue term allows the session', termAllows(blankKeyAndClient, new Date(2030, 5, 15)) === true);

  // --- Scenario 4: existing behaviour unchanged - a session with no
  // term_key column at all (old data, property simply absent) resolves
  // exactly as it did before this change: client, then venue.
  const noTermKeyProperty = { id: 'E01', client: 'North Downs', venue: 'North Downs (Leigh)' };
  rows = schoolTermRows(noTermKeyProperty);
  ck('no term_key property at all: still resolves via client (pre-existing behaviour)', rows.length === 1 && rows[0].school === 'North Downs', JSON.stringify(rows));

  // A session with no client/venue/term_key match at all still runs
  // unrestricted, same as before - no Terms row means no restriction.
  const noMatch = { id: 'E02', client: 'Nowhere FC', venue: 'Nowhere Ground', termKey: '' };
  ck('no matching Terms row at all: session is unrestricted (pre-existing behaviour)', schoolTermRows(noMatch).length === 0 && termAllows(noMatch, new Date(2099, 0, 1)) === true);

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(process.exitCode || 0);
})();
