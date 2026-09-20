const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock-approve.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });

  // --- Scenario 1: a plain coach never sees the Coach Management entry ---
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page');
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'coach-tom@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-list', { timeout: 5000 });
    const hasRow = await p.$('.more-row:has-text("Coach Management")');
    ck('A plain coach does not see Coach Management in the hamburger menu', hasRow === null);
    ck('no console/page errors (coach)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 2: a management user approves/rejects pending coaches ---
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page');
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'mgmt@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });

    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-row:has-text("Coach Management")', { timeout: 5000 });
    await p.click('.more-row:has-text("Coach Management")');
    await p.waitForSelector('.pending-row', { timeout: 5000 });

    const emails = await p.$$eval('.pending-row b', els => els.map(e => e.textContent));
    ck('All three pending sign-ups are listed', emails.length === 3 && emails.includes('newcoach@test.com') && emails.includes('alreadycoach@test.com') && emails.includes('multi@test.com'), emails.join(', '));

    ck('The back button shows on the Coach Management screen (not a tab)', await p.$eval('#app-back', el => !el.hidden));

    // Approve the clean one - row should disappear
    await p.click('[data-pending-row="uid-newcoach@test.com"] .approve-btn');
    await p.waitForFunction(() => !document.querySelector('[data-pending-row="uid-newcoach@test.com"]'), { timeout: 5000 });
    ck('Approving a clean sign-up removes its row', true);
    const toastText = await p.$eval('#toast', el => el.textContent);
    ck('A confirmation toast is shown', toastText === 'Coach approved', toastText);

    const remaining = await p.$$eval('.pending-row', els => els.length);
    ck('Two pending sign-ups remain after one approval', remaining === 2, String(remaining));

    // Approve the ambiguous one - server flags it (409), row should stay with an inline error
    await p.click('[data-pending-row="uid-multi@test.com"] .approve-btn');
    await p.waitForSelector('[data-pending-row="uid-multi@test.com"] .pending-error:not([hidden])', { timeout: 5000 });
    const errText = await p.$eval('[data-pending-row="uid-multi@test.com"] .pending-error', el => el.textContent);
    ck('A multiple-match conflict shows an inline error instead of silently guessing', /More than one Coach record/.test(errText), errText);
    const stillThere = await p.$('[data-pending-row="uid-multi@test.com"]');
    ck('The flagged row is not removed, since nothing was actually approved', stillThere !== null);
    const btnEnabled = await p.$eval('[data-pending-row="uid-multi@test.com"] .approve-btn', el => !el.disabled && el.textContent === 'Approve');
    ck('The Approve button resets so it can be retried after resolving in Airtable', btnEnabled);

    ck('no console/page errors (management)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
