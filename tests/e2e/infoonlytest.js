const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const ROOT = require('path').join(__dirname, '..', '..');
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};

const PUBLIC_PAGES = [
  { page_id: 'PUB-WELCOME', title: 'Welcome', category: 'General', body: 'Welcome text.', show_register_form: true },
  { page_id: 'PUB-JETS', title: 'Jets Trials', category: 'Trials', summary: 'Info, dates.', body: 'Trial info.', cta_label: 'Find out more', show_register_form: true },
  { page_id: 'PUB-EVENTS', title: 'Upcoming Events', category: 'Events', body: 'Half-Term Camp - 20th Oct. Open Day - 3rd Nov. Details for both are below, no need to register.', show_register_form: false },
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
  await p.waitForSelector('.public-page');

  // Jets Trials (show_register_form: true) - form present, no category badge next to Back
  await p.click('.public-tile:has-text("Jets Trials")');
  await p.waitForSelector('.public-detail-hero');
  ck('Jets Trials still shows the register-interest form', await p.isVisible('.register-interest-card'));
  ck('No category badge cluttering the back button area anymore', !(await p.isVisible('.detail-status')));

  await p.click('[data-action="show-public"]');
  await p.waitForSelector('.public-tile-grid');

  // Upcoming Events (show_register_form: false) - no form, just the info content
  await p.click('.public-tile:has-text("Upcoming Events")');
  await p.waitForSelector('.public-detail-hero');
  ck('Upcoming Events has NO register-interest form', !(await p.isVisible('.register-interest-card')));
  const bodyText = await p.$eval('.detail-card', n => n.textContent);
  ck('Upcoming Events still shows its actual event info content', /Half-Term Camp/.test(bodyText) && /Open Day/.test(bodyText), bodyText);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
