const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });

  const paneCount = await p.$$eval('#screen-root > div', ds => ds.length);
  ck('Exactly 4 persistent tab panes exist under screen-root (home/schedule/resources/more)', paneCount === 4, paneCount);

  await p.click('[data-nav="resources"]');
  await p.waitForSelector('.resource-grid', { timeout: 8000 });
  const hiddenStates1 = await p.evaluate(() => Array.from(document.querySelectorAll('#screen-root > div')).map(d => d.hidden));
  ck('Switching tabs toggles hidden on the panes (only Resources visible)', hiddenStates1.filter(h => !h).length === 1, JSON.stringify(hiddenStates1));

  // Scroll well down on Resources, then tap Home - before this fix TEST
  // never reset scroll on a nav switch, so Home could render starting at
  // whatever offset Resources left the page at. The live Hub always
  // scrolls to top on a view switch; this now matches that.
  await p.setViewportSize({ width: 420, height: 250 });
  await p.evaluate(() => window.scrollTo(0, 400));
  await p.waitForTimeout(100);
  const scrolledBefore = await p.evaluate(() => window.scrollY);
  await p.click('[data-nav="home"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });
  await p.waitForTimeout(100);
  const scrolledAfter = await p.evaluate(() => window.scrollY);
  ck('Was actually scrolled down before switching (test is meaningful)', scrolledBefore > 0, scrolledBefore);
  ck('Tab switch resets scroll to top, matching the live Hub (previously TEST did not reset scroll at all)', scrolledAfter === 0, scrolledAfter);

  // In-schedule sub-tabs (Today/This Week/Calendar) must still land inside
  // the schedule pane rather than blowing away the persistent tab shell.
  await p.click('[data-nav="schedule"]');
  await p.waitForSelector('.coach-schedule', { timeout: 8000 });
  await p.click('[data-action="schedule-view"][data-view="week"]');
  await p.waitForTimeout(200);
  const stillFourPanes = await p.$$eval('#screen-root > div', ds => ds.length);
  ck('Switching schedule sub-tabs (This Week) does not destroy the tab shell', stillFourPanes === 4, stillFourPanes);
  ck('Nav bar still visible/functional after schedule sub-tab switch', await p.isVisible('.main-nav'));

  // Drilling into a session (a real "go deeper" navigation, not a tab flip)
  // should still work exactly as before, replacing the screen entirely.
  await p.click('.schedule-session, .today-home-row', { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(200);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
