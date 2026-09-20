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
  await p.waitForSelector('.public-page');
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  await p.click('[data-action="auth-account-type"][data-type="parent"]');
  await p.fill('#auth-email', 'redirect-check@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.page-title', { timeout: 8000 });

  const redirectTo = await p.evaluate(() => window.__lastSignUpEmailRedirectTo);
  ck('signUp is called with an explicit emailRedirectTo', !!redirectTo, redirectTo);
  ck('emailRedirectTo matches this page\'s own origin+pathname exactly', redirectTo === 'http://localhost:8211/index.html', redirectTo);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close();
  process.exit(process.exitCode || 0);
})();
