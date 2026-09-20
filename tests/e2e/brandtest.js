const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

// Distinctive test palette - nothing close to the default navy/blue/lime,
// so any leftover hardcoded colour would be obvious in the checks below.
const ORG = {
  hub_name: 'Test Club Hub',
  tagline: 'Testing the brand colours.',
  primary_colour: '#7a1fa2',   // purple
  secondary_colour: '#ffb300', // amber
  accent_colour: '#e64a19',    // orange
};

const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ organisation: ORG, settings: {}, features: {} })); }
  if (u === '/hub-content/public-pages') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify([])); }
  return serveStatic(q, r, u, ROOT);
});

(async () => {
  await new Promise(res => srv.listen(8211, res));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page', { timeout: 8000 });

  const navyVar = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--navy').trim());
  ck('--navy custom property is overridden to the primary colour', navyVar === '#7a1fa2', navyVar);

  const heroBg = await p.$eval('.public-hero', n => getComputedStyle(n).backgroundColor);
  ck('Public hero background is flat and uses the new accent colour, not the old hardcoded navy gradient', heroBg === 'rgb(230, 74, 25)', heroBg);

  const registerBtnBg = await p.$eval('[data-action="show-signup"]', n => getComputedStyle(n).backgroundColor);
  ck('Hero Register button uses the new secondary (lime) colour', registerBtnBg === 'rgb(255, 179, 0)', registerBtnBg);

  const themeColor = await p.$eval('meta[name="theme-color"]', n => n.getAttribute('content'));
  ck('Mobile browser theme-color meta tag also updates', themeColor === '#7a1fa2', themeColor);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
