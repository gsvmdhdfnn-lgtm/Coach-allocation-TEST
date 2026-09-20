const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 420, height: 800 } });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  let sessionsShouldFail = true;
  await p.route('**/data/Sessions.csv', route => sessionsShouldFail ? route.abort('failed') : route.continue());

  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');

  await p.waitForSelector('.error', { timeout: 10000 });
  const errText = await p.$eval('.error', el => el.textContent);
  ck('Shows a friendly message, not raw fetch error text', /weak connection/i.test(errText) && !/AbortError|signal is aborted|TypeError/i.test(errText), errText);
  ck('Has a Try again button', !!(await p.$('[data-action="retry-load"]')));
  ck('Has a way back to the public page (not a dead end)', !!(await p.$('[data-action="show-public"]')));
  await p.screenshot({ path: 'shot-load-error.png' });

  sessionsShouldFail = false;
  await p.click('[data-action="retry-load"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });
  ck('Retry succeeds once the connection recovers', true);

  const backEl = await p.$('[data-action="show-public"]');
  ck('no console/page errors', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
