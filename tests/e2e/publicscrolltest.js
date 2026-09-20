const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 420, height: 250 } });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');

  // Scroll down the landing grid, then tap a tile - should land at the top
  // of the detail screen, not wherever the grid happened to be scrolled.
  await p.evaluate(() => window.scrollTo(0, 300));
  const scrolledBefore = await p.evaluate(() => window.scrollY);
  await p.click('.public-tile:has-text("Jets Trials")');
  await p.waitForSelector('.public-detail-hero');
  const afterDetail = await p.evaluate(() => window.scrollY);
  ck('Grid was actually scrolled before tapping a tile (test is meaningful)', scrolledBefore > 0, scrolledBefore);
  ck('Tapping a tile lands at the top of its detail screen', afterDetail === 0, afterDetail);

  // Scroll down on the detail screen, then hit Back - should land at the
  // top of the grid again, not partway down.
  await p.evaluate(() => window.scrollTo(0, 150));
  await p.click('[data-action="show-public"]');
  await p.waitForSelector('.public-tile-grid');
  const afterBack = await p.evaluate(() => window.scrollY);
  ck('Back to the grid also resets to the top', afterBack === 0, afterBack);

  await p.setViewportSize({ width: 420, height: 900 });
  // Sign In / Register toggle
  await p.click('[data-action="show-signin"]');
  await p.waitForSelector('.auth-card');
  await p.evaluate(() => window.scrollTo(0, 100));
  await p.click('[data-action="auth-switch"]');
  await p.waitForTimeout(100);
  const afterSwitch = await p.evaluate(() => window.scrollY);
  ck('Switching Sign In <-> Register resets scroll to top', afterSwitch === 0, afterSwitch);

  await p.click('[data-action="show-public"]');
  await p.waitForSelector('.public-tile-grid');
  ck('Landing page still reachable and intact after all of the above', await p.isVisible('.public-hero'));

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
