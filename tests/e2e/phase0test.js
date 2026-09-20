const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page', { timeout: 8000 });
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card', { timeout: 8000 });
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });

  // --- Resources: real data, not the old hardcoded 6-card array
  await p.click('[data-nav="resources"]');
  await p.waitForSelector('.resource-grid', { timeout: 8000 });
  const resTitles = await p.$$eval('.resource-card h3', els => els.map(e => e.textContent));
  ck('Resources shows exactly the 1 real Airtable record', resTitles.length === 1, resTitles.join('|'));
  ck('Resources title is the real one, not a hardcoded sample',
    resTitles[0] === '1v1 Attacking — Example Resource', resTitles[0]);
  ck('Resource card links to the real external_link',
    (await p.getAttribute('.resource-card', 'href')) === 'https://example.com/plan.pdf');

  // --- Coach Support: reached via the Home shortcut, real data
  await p.click('[data-nav="home"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });
  await p.click('.home-shortcuts button:has-text("Coach Support")');
  await p.waitForSelector('.resource-grid', { timeout: 8000 });
  const supTitles = await p.$$eval('.resource-card h3', els => els.map(e => e.textContent));
  ck('Coach Support shows exactly the 1 real Airtable record', supTitles.length === 1, supTitles.join('|'));
  ck('Support title is the real one', supTitles[0] === 'Session Standards — Example', supTitles[0]);
  await p.click('.resource-card');
  await p.waitForSelector('#sheet:not([hidden])', { timeout: 5000 });
  const sheetText = await p.$eval('#sheet-content', n => n.textContent);
  ck('Support sheet shows the real body text', /example Coach Support item/.test(sheetText), sheetText);
  await p.click('.sheet-backdrop');

  // --- Venues: reached via the Home shortcut, real Airtable venue data
  await p.click('[data-nav="home"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });
  await p.click('.home-shortcuts button:has-text("Venues")');
  await p.waitForSelector('.venues-page', { timeout: 8000 });
  const venueNames = await p.$$eval('.venue-card-copy h3', els => els.map(e => e.textContent));
  ck('Venues shows the real Airtable venue', venueNames.includes("City of London Freemen's"), venueNames.join('|'));
  await p.click('.venue-card-v1');
  await p.waitForSelector('.venue-detail-wrap', { timeout: 8000 });
  const venueDetailText = await p.$eval('.venue-overview-card', n => n.textContent);
  ck('Venue detail shows real parking/meeting-point/access from Airtable',
    /Add parking instructions here/.test(venueDetailText) && /Add meeting point here/.test(venueDetailText),
    venueDetailText);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);

  await b.close();
  process.exit(process.exitCode || 0);
})();
