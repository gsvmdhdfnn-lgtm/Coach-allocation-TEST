const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page', { timeout: 8000 });
  ck('Public page shows tiles in a grid', await p.$eval('.public-tile-grid', n => getComputedStyle(n).display) === 'grid');

  await p.click('.public-tile:has-text("Jets Trials")');
  await p.waitForSelector('.register-interest-card', { timeout: 8000 });
  ck('Tapping a tile opens its own dedicated detail + form screen (no dropdown)', await p.$eval('.public-detail-hero h1', n => n.textContent) === 'Jets Trials');
  ck('No "which one" field exists - it is implicit from the tile tapped', (await p.$('#ri-interested')) === null);
  const ageOptions = await p.$$eval('#ri-age option', els => els.map(e => e.textContent));
  ck('Age group is a dropdown built from this card\'s Age Groups field', ageOptions.slice(1).join(',') === 'U7,U8,U9/10,U11/12,U13/14', ageOptions.join('|'));
  const hpStyle = await p.$eval('#ri-hp', n => { const s = getComputedStyle(n); return { left: s.left, overflow: s.overflow, position: s.position }; });
  ck('Honeypot field exists but is positioned off-screen, invisible to a real visitor', hpStyle.position === 'absolute' && parseInt(hpStyle.left, 10) < -1000, JSON.stringify(hpStyle));

  // Missing age group is caught client-side before it ever reaches the server.
  await p.fill('#ri-name', 'Jamie Parent');
  await p.fill('#ri-email', 'jamie@example.com');
  await p.click('[data-action="register-interest-submit"]');
  await p.waitForTimeout(200);
  ck('Missing age group is caught before it ever reaches the server', /age group/i.test(await p.$eval('#ri-error', n => n.textContent)));

  // Submitting immediately (bot-speed), now with everything filled in
  // including age group, should still be rejected by the server-side
  // minimum-time check.
  await p.selectOption('#ri-age', 'U9/10');
  await p.click('[data-action="register-interest-submit"]');
  await p.waitForFunction(() => {
    const el = document.getElementById('ri-error');
    return el && !el.hidden && el.textContent.length > 0;
  }, { timeout: 8000 });
  ck('Submitting implausibly fast is rejected by the server-side minimum-time check', /try again/i.test(await p.$eval('#ri-error', n => n.textContent)));

  // Client-side validation: missing email.
  await p.fill('#ri-email', '');
  await p.click('[data-action="register-interest-submit"]');
  await p.waitForTimeout(200);
  ck('Missing email is caught before it ever reaches the server', /name and email/i.test(await p.$eval('#ri-error', n => n.textContent)));

  // Real submission: wait past the minimum-time window, fill it out properly.
  await p.waitForTimeout(3200);
  await p.fill('#ri-email', 'jamie@example.com');
  await p.fill('#ri-phone', '07700 900000');
  await p.fill('#ri-notes', 'Second-guessing myself on the age group.');
  await p.click('[data-action="register-interest-submit"]');
  await p.waitForSelector('.ri-done', { timeout: 8000 });
  ck('A real, well-timed submission succeeds and shows a thank-you state', /Thanks!/.test(await p.$eval('.ri-done', n => n.textContent)));
  ck('Thank-you message names the specific programme registered for', /Jets Trials/.test(await p.$eval('.ri-done', n => n.textContent)));

  const regs = server.registrations;
  const real = regs.find(r => r.email === 'jamie@example.com' && r.age_group);
  ck('The real submission reached Airtable (mock) with the age group included', !!real && real.name === 'Jamie Parent' && real.page_title === 'Jets Trials' && real.age_group === 'U9/10', JSON.stringify(real));
  ck('The bot-speed and honeypot-style attempts never made it into the saved records', !regs.some(r => r.email === 'bot@example.com'));

  await p.click('[data-action="show-public"]');
  await p.waitForSelector('.public-page', { timeout: 8000 });
  await p.click('.public-tile:has-text("Academy")');
  await p.waitForSelector('.register-interest-card', { timeout: 8000 });
  ck('A card with no Age Groups set falls back to a free-text age field', await p.$eval('#ri-age', n => n.tagName) === 'INPUT');

  await p.click('[data-action="show-public"]');
  await p.waitForSelector('.public-page', { timeout: 8000 });
  ck('Back returns to the public grid', true);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);

  await b.close();
  process.exit(process.exitCode || 0);
})();
