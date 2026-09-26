// Live incident 2026-09-26 ~09:08 UK: /parent-hub/me returned 500 because
// handleParentMe read "Player Session Requests" inside its Promise.all and
// that table began returning 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND.
// One unavailable feature took the whole Parent Hub down, and the raw
// Airtable error was printed on the parent's screen.
//
// These scenarios cover the three states that must now be distinguishable:
// the hub loading with requests unavailable, an unexpected backend failure,
// and everything healthy.
const { chromium } = require('playwright');
const path = require('path');
process.env.SP_SERVE = path.join(__dirname, '..', '..');
const server = require('../support/hub-content-mock-parenthub.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const PORT = 8211;
const STUB = path.join(__dirname, '..', 'support', 'auth-stub.js');

// A parent with one verified child already in a session - the ordinary
// state, so the scenarios below differ only by the requests feature.
server.links.push({ id: 'lnk1', parentEmail: 'parent-down@test.com', playerId: 'plyr1', playerName: 'Alfie Test', dob: '2015-05-10', relationship: 'Parent', status: 'Verified', notes: '' });
server.sessionLinks.push({ playerId: 'plyr1', sessionId: 'sess1', status: 'Active' });

const textOf = async (p, sel) => p.$eval(sel, el => el.innerText).catch(() => '');
const seen = async (p, sel, ms) => !!(await p.waitForSelector(sel, { timeout: ms || 8000 }).catch(() => null));

async function parentSession(b, errs) {
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', r => r.fulfill({ path: STUB, contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:' + PORT + '/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  // The parent role comes from the chosen account type, which the auth
  // stub encodes into the token - not from the email address.
  await p.click('[data-action="auth-account-type"][data-type="parent"]');
  await p.fill('#auth-email', 'parent-down@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.ph-hero, .error', { timeout: 10000 });
  return { ctx, p };
}

(async () => {
  const srv = await server.start(PORT);
  const b = await chromium.launch({ args: ['--no-sandbox'] });

  // --- Scenario 1: requests unavailable, hub must still work ---
  {
    server.setRequestsMode('unavailable');
    const errs = [];
    const { ctx, p } = await parentSession(b, errs);

    ck('Parent Home loads even though session requests are unavailable', await seen(p, '.ph-hero'));
    ck('...and does not show the hub-level error', await p.$('.error') === null);
    const home = await textOf(p, '#app');
    ck('The child is still shown', /Alfie/i.test(home), home.slice(0, 120));
    ck('No raw backend detail on Home', !/Airtable|INVALID_PERMISSIONS|403|500/i.test(home));

    await p.click('[data-nav="parent-sessions"]').catch(() => {});
    await seen(p, '.ph-hero');
    const sessions = await textOf(p, '#app');
    ck('Sessions marks requests as temporarily unavailable', /temporarily unavailable/i.test(sessions), sessions.slice(0, 200));
    ck('...rather than silently showing nothing pending', /Awaiting approval/i.test(sessions));
    ck('No raw backend detail on Sessions', !/Airtable|INVALID_PERMISSIONS/i.test(sessions));

    await p.click('[data-action="parent-find-session"]').catch(() => {});
    await p.waitForTimeout(300);
    const sheet = await textOf(p, '#sheet-content');
    ck('Find a session explains it is unavailable', /temporarily unavailable/i.test(sheet), sheet.slice(0, 200));
    ck('...and offers no way to submit a request nobody can process', await p.locator('[data-action="submit-session-request"]').count() === 0);
    ck('no page errors (unavailable case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 2: the exact live failure - /me 500 with a raw Airtable body ---
  {
    server.setRequestsMode('crash');
    const errs = [];
    const { ctx, p } = await parentSession(b, errs);

    ck('An unexpected backend failure shows the hub error', await seen(p, '.error'));
    const shown = await textOf(p, '#app');
    ck('The raw Airtable error is NOT shown to the parent', !/Airtable error for|INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/i.test(shown), shown.slice(0, 200));
    ck('...no table name is leaked', !/Player Session Requests/i.test(shown));
    ck('...no status code is leaked', !/\b403\b|\b500\b/.test(shown));
    ck('A plain-English explanation is shown instead', /weak connection/i.test(shown), shown.slice(0, 160));
    ck('Try again is offered', await p.locator('[data-action="retry-parent-hub"]').count() === 1);
    ck('no page errors (crash case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 3: positive control - everything healthy ---
  {
    server.setRequestsMode('ok');
    const errs = [];
    const { ctx, p } = await parentSession(b, errs);

    ck('A healthy hub still loads normally', await seen(p, '.ph-hero'));
    await p.click('[data-nav="parent-sessions"]').catch(() => {});
    await seen(p, '.ph-hero');
    const sessions = await textOf(p, '#app');
    ck('...and does NOT claim requests are unavailable', !/temporarily unavailable/i.test(sessions));

    await p.click('[data-action="parent-find-session"]').catch(() => {});
    await p.waitForTimeout(300);
    ck('...and the request form is usable again', await p.locator('[data-action="submit-session-request"]').count() === 1);
    ck('no page errors (healthy case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
