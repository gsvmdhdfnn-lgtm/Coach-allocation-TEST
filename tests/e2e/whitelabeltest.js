const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

const CUSTOM_LOGO = 'https://example.com/other-club-logo.png';
const ORG = { hub_name: 'Riverside FC Hub', tagline: '', logo_url: CUSTOM_LOGO };

const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ organisation: ORG, settings: {}, features: {} })); }
  if (u === '/hub-content/public-pages') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end('[]'); }
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

  const topbarLogoSrc = await p.$eval('.brand-lockup img', el => el.getAttribute('src'));
  ck('Top bar logo swaps to the Airtable Logo URL', topbarLogoSrc === CUSTOM_LOGO, topbarLogoSrc);

  const title = await p.title();
  ck('Document title uses the real Hub Name', title === 'Riverside FC Hub', title);

  const heroH1 = await p.$eval('.public-hero h1', el => el.textContent);
  ck('Public landing hero heading uses the real Hub Name', heroH1 === 'Riverside FC Hub', heroH1);

  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  const authLogoSrc = await p.$eval('.auth-logo', el => el.getAttribute('src'));
  ck('Auth screen logo also swaps to the Airtable Logo URL', authLogoSrc === CUSTOM_LOGO, authLogoSrc);

  const subtitle = await p.$eval('.auth-sub', el => el.textContent);
  ck('Sign-up subtitle uses the real Hub Name, not Josh Evans', subtitle.includes('Riverside FC Hub') && !/Josh Evans/i.test(subtitle), subtitle);

  const backBtn = await p.$eval('.auth-card [data-action="show-public"]', el => el.textContent);
  ck('Back link uses the real Hub Name, not Josh Evans', backBtn.includes('Riverside FC Hub') && !/Josh Evans/i.test(backBtn), backBtn);

  await p.click('[data-action="auth-switch"]');
  await p.waitForTimeout(150);
  const signinSub = await p.$eval('.auth-sub', el => el.textContent);
  ck('Sign-in subtitle also uses the real Hub Name', signinSub.includes('Riverside FC Hub') && !/Josh Evans/i.test(signinSub), signinSub);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
