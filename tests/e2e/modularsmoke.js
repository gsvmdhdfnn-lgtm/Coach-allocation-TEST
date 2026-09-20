const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const PORT = 8211;

async function freshCtx(b) {
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  return { ctx, p, errs };
}

(async () => {
  await server.start(PORT);
  const b = await chromium.launch({ args: ['--no-sandbox'] });

  // --- Module loading itself: public page with no auth ---
  {
    const { p, errs } = await freshCtx(b);
    await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page', { timeout: 8000 });
    ck('main.js loads as an ES module with no import/circular-dependency errors', errs.length === 0, errs.join(' | '));
  }

  // --- Coach smoke: sign up, schedule, venues, resources, my players, calendar export, logout ---
  {
    const { p, errs } = await freshCtx(b);
    await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page', { timeout: 8000 });
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'coach-tom@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    ck('Coach signup lands on coach home', true);
    await p.click('[data-nav="schedule"]');
    await p.waitForSelector('.coach-schedule', { timeout: 8000 });
    ck('Schedule screen renders (cross-module render() dispatch to coach.js works)', true);
    await p.click('[data-nav="resources"]');
    await p.waitForSelector('.resource-grid', { timeout: 8000 });
    ck('Resources screen renders', true);
    await p.click('[data-nav="players"]');
    await p.waitForSelector('#screen-root > div:not([hidden]) h1:has-text("Player Hub")', { timeout: 8000 });
    ck('Player Hub screen renders', true);
    await p.click('[data-nav="home"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    await p.click('.home-shortcuts button:has-text("Venues")');
    await p.waitForSelector('.venues-page', { timeout: 8000 });
    ck('Venues screen renders (reached via Home shortcut)', true);
    await p.click('.icon-btn[data-action="open-more"]');
    await p.waitForSelector('.more-list', { timeout: 5000 });
    await p.click('.more-row[data-action="logout"]');
    await p.waitForSelector('.public-page', { timeout: 8000 });
    ck('Logout returns to public home', true);
    ck('no console/module errors through the coach flow', errs.length === 0, errs.join(' | '));
  }

  // --- Management smoke: all 4 management screens reachable ---
  {
    const { p, errs } = await freshCtx(b);
    await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page', { timeout: 8000 });
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'mgmt1@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    ck('Management signup lands on coach home (role shell shared)', true);

    await p.click('.icon-btn[data-action="open-more"]');
    await p.click('[data-nav="coach-management"]');
    await p.waitForSelector('#pending-coach-list', { timeout: 8000 });
    ck('Coach Management screen renders', true);

    await p.click('.icon-btn[data-action="open-more"]');
    await p.click('[data-nav="session-requests"]');
    await p.waitForSelector('#session-requests-list', { timeout: 8000 });
    ck('Session Requests screen renders', true);

    await p.click('.icon-btn[data-action="open-more"]');
    await p.click('[data-nav="player-migration"]');
    await p.waitForSelector('#migration-list', { timeout: 8000 });
    ck('Player Migration screen renders', true);

    await p.click('.icon-btn[data-action="open-more"]');
    await p.click('[data-nav="parent-claims"]');
    await p.waitForSelector('#parent-claims-list', { timeout: 8000 });
    ck('Parent Claims screen renders', true);

    ck('no console/module errors through the management flow', errs.length === 0, errs.join(' | '));
  }

  // --- Parent smoke: Parent Hub loads, main-nav hidden ---
  {
    const { p, errs } = await freshCtx(b);
    await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page', { timeout: 8000 });
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.click('[data-action="auth-account-type"][data-type="parent"]');
    await p.fill('#auth-email', 'parent1@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.parent-children-list', { timeout: 8000 });
    ck('Parent signup lands on the Parent Hub', true);
    ck('Main nav hidden for parent role', await p.locator('.main-nav').isHidden());
    ck('no console/module errors through the parent flow', errs.length === 0, errs.join(' | '));
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close();
  process.exit(process.exitCode || 0);
})();
