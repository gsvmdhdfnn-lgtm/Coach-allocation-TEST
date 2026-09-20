const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

// A card with ONLY a preset chosen (no Custom Colour hex at all) - the
// easy path David asked for - plus one with BOTH set, to prove custom
// hex still wins when present.
const PUBLIC_PAGES = [
  { page_id: 'PUB-PRESET-ONLY', title: 'Preset Only Card', category: 'General', summary: 'No hex typed anywhere.', body: '', colour: '', colour_preset: 'Forest Green', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-BOTH-SET', title: 'Both Set Card', category: 'General', summary: 'Custom hex should win over the preset.', body: '', colour: '#e64a19', colour_preset: 'Navy', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-NEITHER-SET', title: 'Neither Set Card', category: 'General', summary: 'Falls back to the old gradient cycle.', body: '', colour: '', colour_preset: '', cta_label: '', cta_link: '', image_url: '' }
];

const ORG = {
  hub_name: 'Josh Evans Hub', tagline: '',
  primary_colour: '', primary_colour_preset: 'Teal',
  secondary_colour: '', secondary_colour_preset: '',
  accent_colour: '', accent_colour_preset: 'Amber',
};

const srv = http.createServer((q, r) => {
  const u = q.url.split('?')[0];
  if (u === '/hub-content/public-pages') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify(PUBLIC_PAGES)); }
  if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ organisation: ORG, settings: {}, features: {} })); }
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
  await p.waitForSelector('.public-tile-grid', { timeout: 8000 });

  // Preset Only Card is the first record (General/index 0), so it now
  // runs as the featured tile above the grid, not inside it.
  const presetOnlyBg = await p.$eval('.public-featured:has-text("Preset Only Card") .public-featured-footer', n => getComputedStyle(n).backgroundColor);
  ck('Preset-only card resolves to the Forest Green preset hex (#1d4a39)', presetOnlyBg === 'rgb(29, 74, 57)', presetOnlyBg);

  const bothSetBg = await p.$eval('.public-tile:has-text("Both Set Card") .public-tile-footer', n => getComputedStyle(n).backgroundColor);
  ck('Custom hex wins over preset when both are set (orange, not navy)', bothSetBg === 'rgb(230, 74, 25)', bothSetBg);

  const neitherClass = await p.$eval('.public-tile:has-text("Neither Set Card") .public-tile-footer', n => n.className);
  ck('Card with neither set still falls back to the old gradient cycle, not broken', /public-tile-footer/.test(neitherClass) && !/light-bg/.test(neitherClass), neitherClass);

  const navyVar = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--navy').trim());
  ck('Whole-app Primary Colour Preset (Teal) applies with no hex typed anywhere', navyVar === '#0f8a82', navyVar);

  const accentHero = await p.$eval('.public-hero', n => getComputedStyle(n).backgroundColor);
  ck('Whole-app Accent Colour Preset (Amber) applies to the hero background', accentHero === 'rgb(230, 132, 31)', accentHero);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
