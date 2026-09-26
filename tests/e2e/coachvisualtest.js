const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const PORT = 8211;

const TODAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
// One session, covered (not the coach's own base assignment) so the new
// "Cover" status chip has something real to show on Next Session/Today -
// coachAssignment() (unchanged) is what actually decides this; the test
// just confirms the chip reflects it.
const SESSIONS_CSV = `session_id,session_name,programme,category,age_group,day,time,venue,address,coaches,client,hours
E01,Covered Session,Evening,Development Centre,U9/10,${TODAY},00:01 - 23:58,Test Venue,Test Address,David,,1
`;
const CHANGES_CSV = `week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note
${new Date().toISOString().slice(0, 10)},E01,,,David,Tom,cover,,,,
`;
const SESSION_PARTICIPANTS = [{ session_id: 'E01', participants: 14 }];

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.png': 'image/png' };

function makeServer(opts) {
  opts = opts || {};
  const OVERRIDES = { '/config.js': path.join(FIXTURES_DIR, 'config.test.js') };
  return http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/data/Sessions.csv') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end(opts.sessionsCsv || 'session_id,session_name,programme,category,age_group,day,time,venue,address,coaches,client,hours\n'); }
    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end(opts.changesCsv || 'week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/hub-content/resources') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(opts.resources || [])); }
    if (u === '/hub-content/venues') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(opts.venues || [])); }
    if (u === '/hub-content/coach-support') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(opts.support || [])); }
    if (u === '/hub-content/public-pages') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([])); }
    if (u === '/hub-content/what-we-offer') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([])); }
    // An EMPTY Player Hub means the read succeeded and returned nothing -
    // which is what the Player Hub scenario below is checking. Without
    // this route the request 404s, and a failed read is now (correctly) an
    // error state rather than "No players yet".
    if (u === '/hub-content/players') {
      const auth = q.headers['authorization'] || '';
      if (!auth) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify(opts.players || []));
    }
    if (u === '/hub-content/session-participants') {
      const auth = q.headers['authorization'] || '';
      if (!auth) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify(opts.participants || []));
    }
    if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' }, settings: {}, features: {} })); }
    if (u === '/me') {
      const auth = q.headers['authorization'] || '';
      const email = auth.replace(/^Bearer /, '').replace(/^tok-/, '').replace(/~.*/, '');
      if (!email) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify({ user_id: 'uid-' + email, email: email, organisation_id: 'ORG-JOSHEVANS', role: 'coach', status: 'active', airtable_person_id: null, display_name: 'Tom' }));
    }
    const decoded = decodeURIComponent(u === '/' ? '/index.html' : u);
    const filePath = OVERRIDES[decoded] || path.join(ROOT, decoded);
    fs.readFile(filePath, (err, body) => {
      if (err) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
      r.end(body);
    });
  });
}

async function withPage(opts, fn) {
  const server = makeServer(opts);
  await new Promise((res) => server.listen(PORT, res));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ path: path.join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.public-page');
  await page.click('[data-action="show-signup"]');
  await page.waitForSelector('.auth-card');
  await page.fill('#auth-email', 'coach-tom@test.com');
  await page.fill('#auth-password', 'password123');
  await page.click('[data-action="auth-submit"]');
  await page.waitForSelector('.coach-home');
  await fn(page, errs);
  await b.close();
  server.close();
}

async function noOverflow(page, label) {
  for (const w of [390, 768, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`No horizontal overflow on ${label} at ${w}px`, overflow <= 1, 'overflow=' + overflow);
  }
  await page.setViewportSize({ width: 390, height: 900 });
}

(async () => {
  // --- Scenario A: a covered session today, with a participant count,
  // and empty Library/Venues/Coach Support - proves the branded empty
  // states, the new nav labels, and the Cover status chip together. ---
  await withPage({ sessionsCsv: SESSIONS_CSV, changesCsv: CHANGES_CSV, participants: SESSION_PARTICIPANTS }, async (page, errs) => {
    // Nav labels renamed
    ck('Main nav reads "Library", not "Resources"', (await page.locator('.main-nav [data-nav="resources"]').textContent()).trim() === 'Library');
    ck('Main nav reads "Player Hub", not "My Players"', (await page.locator('.main-nav [data-nav="players"]').textContent()).trim() === 'Player Hub');

    // Part A: quick-action cards + Coach Support tagline carry a data-driven
    // colour preset (defaults, since no Hub Settings override is mocked here).
    const tints = await page.locator('.home-shortcuts button').evaluateAll(els => els.map(e => e.dataset.tint));
    ck('Quick-action cards default to Blue/Lime/Green/Navy presets', JSON.stringify(tints) === JSON.stringify(['blue', 'lime', 'green', 'navy']), tints.join(','));

    // Next Session: age group chip, Cover status chip, participant count all present together
    ck('Next Session shows the age group chip', (await page.locator('.next-home-tag').textContent()) === 'U9/10');
    ck('Next Session header shows a Cover status chip', (await page.locator('.home-status-chip.is-header').textContent()) === 'Cover');
    ck('Next Session still shows the participant count', (await page.locator('.next-home-card').textContent()).includes('14 players'));

    // Today's row shows the same Cover status chip inline
    const todayText = await page.locator('.today-home-row').textContent();
    ck('Today row shows a Cover status chip for the same session', /Cover/.test(todayText) && /14 players/.test(todayText), todayText);

    ck('No horizontal overflow test setup baseline reachable (Home)', await page.locator('.coach-home').count() === 1);
    await noOverflow(page, 'Home');

    // Library (empty) - the four tab screens stay permanently built in the
    // DOM as hidden panes (see core.js's ensureTabShell), so once more than
    // one has been visited, an unscoped ".page-title h1"/".empty-state"
    // matches every pane's copy, not just the visible one. Scope to the
    // one pane that isn't hidden, same pattern modularsmoke.js uses.
    const visiblePane = '#screen-root > div:not([hidden])';
    await page.click('.main-nav [data-nav="resources"]');
    await page.waitForSelector(`${visiblePane} .page-title h1`);
    ck('Library page title is "Library"', (await page.locator(`${visiblePane} .page-title h1`).textContent()) === 'Library');
    ck('Empty Library shows the branded empty state, not a bare grey box', await page.locator(`${visiblePane} .empty-state`).count() === 1);
    ck('Empty Library empty-state text does not name Airtable', !/airtable/i.test(await page.locator(`${visiblePane} .empty-state`).textContent()));
    await noOverflow(page, 'Library (empty)');

    // Player Hub (empty)
    await page.click('.main-nav [data-nav="players"]');
    await page.waitForSelector(`${visiblePane} .page-title h1`);
    ck('Player Hub page title is "Player Hub"', (await page.locator(`${visiblePane} .page-title h1`).textContent()) === 'Player Hub');
    ck('Empty Player Hub shows the branded empty state', await page.locator(`${visiblePane} .empty-state`).count() === 1);
    await noOverflow(page, 'Player Hub (empty)');

    // Coach Support (empty), reached via the Home shortcut - not a tab
    // screen, so it fully replaces #screen-root (no pane ambiguity here).
    await page.click('.main-nav [data-nav="home"]');
    await page.waitForSelector('.coach-home');
    await page.click('.home-shortcuts button:has-text("Coach Support")');
    await page.waitForSelector('.page-title h1');
    ck('Empty Coach Support shows the branded empty state, not a bare grey box', await page.locator('.empty-state').count() === 1);
    ck('Empty Coach Support empty-state text does not name Airtable', !/airtable/i.test(await page.locator('.empty-state').textContent()));
    ck('Coach Support tagline defaults to the Navy preset', (await page.locator('.quote-card').getAttribute('data-tint')) === 'navy');
    await noOverflow(page, 'Coach Support (empty)');

    ck('No console/page errors (scenario A)', errs.length === 0, errs.join(' | '));
  });

  // --- Scenario B: genuinely nothing scheduled today, no next session at
  // all - the Home empty state must not invent information. ---
  await withPage({ participants: [] }, async (page, errs) => {
    ck('No Next Session -> the card says so, not a blank/error state', (await page.locator('.next-home-card h1').textContent()) === 'No upcoming sessions');
    const emptyToday = await page.locator('.today-home .empty-state').textContent();
    ck('No sessions today shows the branded empty state', /No sessions today/.test(emptyToday), emptyToday);
    ck('With no next session at all, the empty state does not invent one', !/Your next session is/.test(emptyToday), emptyToday);

    await noOverflow(page, 'Home (fully empty)');
    ck('No console/page errors (scenario B)', errs.length === 0, errs.join(' | '));
  });

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(process.exitCode || 0);
})();
