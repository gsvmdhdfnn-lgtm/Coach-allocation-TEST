const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

// Simulates exactly what David described: Tours has no Active card left
// (he switched it off in Airtable), and a brand-new category - "Camps",
// which has never existed in the code - has one Active card switched on.
// Nothing here touches app.js; this is purely what the real Airtable
// endpoint would return after those two edits.
const PUBLIC_PAGES = [
  { page_id: 'PUB-GENERAL-WELCOME', title: 'Welcome to Josh Evans Soccer School', category: 'General', body: 'Welcome text.', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-TRIALS-JETS', title: 'Jets Trials', category: 'Trials', body: 'Trial info.', cta_label: 'Find out more', cta_link: 'https://example.com', image_url: '' },
  { page_id: 'PUB-CAMP-HALFTERM', title: 'Half-Term Camp', category: 'Camps', body: 'A brand new category that has never existed in the code before.', cta_label: '', cta_link: '', image_url: '' }
  // Note: no Tours record at all - the equivalent of David unticking Active on it.
];

const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/hub-content/public-pages') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify(PUBLIC_PAGES)); }
  if (u === '/hub-content') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub' }, settings: {}, features: {} })); }
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
  const text = await p.$eval('.public-page', n => n.textContent);
  const tileCount = await p.$$eval('.public-tile', els => els.length);
  const featuredCount = await p.$$eval('.public-featured', els => els.length);
  ck('No Tours tile appears (no Active Tours card, no code touched)', !/Tours/.test(text), text);
  ck('Brand-new "Camps" category tile appears, unprompted', /Half-Term Camp/.test(text), text);
  ck('Existing General and Trials cards still work normally', /Welcome to Josh Evans/.test(text) && /Jets Trials/.test(text));
  ck('Welcome card runs as the 1 featured tile, the other 2 fill the flat grid below', featuredCount === 1 && tileCount === 2, 'featured='+featuredCount+' tiles='+tileCount);
  ck('no console/page errors', errs.length === 0, errs.join(' | '));
  await p.screenshot({ path: 'shot-toggle-demo.png', fullPage: true });

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
