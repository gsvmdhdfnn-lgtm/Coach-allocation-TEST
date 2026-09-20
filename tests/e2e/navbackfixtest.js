const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock-sessions.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
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

  // Tab-to-tab switching should never show a back button
  for (const tab of ['players', 'resources', 'schedule', 'home']) {
    await p.click(`[data-nav="${tab}"]`);
    await p.waitForTimeout(250);
    const backHidden = await p.$eval('#app-back', el => el.hidden);
    ck(`No back button after switching to ${tab} tab`, backHidden, String(backHidden));
    const activeCount = await p.$$eval('.nav-pill.is-active', els => els.length);
    ck(`Exactly one active tab after switching to ${tab}`, activeCount === 1, String(activeCount));
    const activeTab = await p.$eval('.nav-pill.is-active', el => el.dataset.nav);
    ck(`The active tab is actually ${tab}`, activeTab === tab, activeTab);
  }

  // Drilling into a non-tab screen (Venues, via Home shortcut) SHOULD show a back button, and it should work
  await p.click('[data-nav="home"]');
  await p.waitForSelector('.home-shortcuts');
  await p.click('.home-shortcuts [data-nav="venues"]');
  await p.waitForTimeout(250);
  const backShownForVenues = await p.$eval('#app-back', el => !el.hidden);
  ck('Back button DOES show after drilling into Venues from a Home shortcut', backShownForVenues);
  await p.click('#app-back');
  await p.waitForTimeout(250);
  const backScreen = await p.evaluate(() => document.querySelector('.coach-home') ? 'home' : (document.querySelector('.venue-list, .venues-page') ? 'venues' : 'other'));
  ck('Tapping back from Venues returns to Home', backScreen === 'home', backScreen);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
