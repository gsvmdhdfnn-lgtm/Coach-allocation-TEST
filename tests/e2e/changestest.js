const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const PORT = 8211;

/**
 * Every full page reload wipes the auth-stub's in-memory user/session
 * store (it's just page-scoped JS, reset on navigation) - so unlike a
 * real Supabase project, a fresh sign-up on each reload is the only way
 * back into the coach home each time, not a sign-in reusing a prior one.
 */
async function signInFresh(p) {
  await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page', { timeout: 8000 });
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card', { timeout: 8000 });
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });
}

(async () => {
  await server.start(PORT);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // --- Case 1: Changes loads fine -> no warning banner
  await signInFresh(p);
  ck('no warning banner when Changes loads fine', (await p.$('.data-warning')) === null);

  // --- Case 2: Changes fails -> warning banner on Home
  await fetch(`http://localhost:${PORT}/set-changes-fail?fail=1`);
  await signInFresh(p);
  const homeBanner = await p.$eval('.data-warning', n => n.textContent).catch(() => null);
  ck('warning banner shown on Home when Changes fails', !!homeBanner, homeBanner);
  ck('banner text mentions cancellations/cover', /cancellations and cover/i.test(homeBanner || ''), homeBanner);

  // --- Case 2b: banner also shows on Schedule screen
  await p.click('[data-nav="schedule"]');
  await p.waitForSelector('.coach-schedule', { timeout: 8000 });
  ck('warning banner shown on Schedule too', (await p.$('.data-warning')) !== null);

  // --- Case 3: recovers when Changes works again (fresh load)
  await fetch(`http://localhost:${PORT}/set-changes-fail?fail=0`);
  await signInFresh(p);
  ck('banner gone again once Changes loads fine', (await p.$('.data-warning')) === null);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);

  await b.close();
  process.exit(process.exitCode || 0);
})();
