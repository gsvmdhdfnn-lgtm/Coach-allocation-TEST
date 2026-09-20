const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

function relLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrastRatio(hexA, hexB) {
  const la = relLuminance(hexA) + 0.05, lb = relLuminance(hexB) + 0.05;
  return la > lb ? la / lb : lb / la;
}
function rgbToHex(rgb) {
  const m = rgb.match(/\d+/g).map(Number);
  return '#' + m.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
}

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  // Reproduces exactly what broke on the live site: Primary and Secondary
  // both set to the identical colour, so the Register button's navy text
  // was landing on a navy-identical background - invisible.
  await p.route('**/hub-content', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ organisation: {
      hub_name: 'Josh Evans Hub',
      primary_colour: '#52b9ef', primary_colour_preset: '',
      secondary_colour: '#52b9ef', secondary_colour_preset: '',
      accent_colour: '#c8ed21', accent_colour_preset: '',
    }, settings: {}, features: {} })
  }));
  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');

  const heroTextColor = await p.$eval('.public-hero h1', n => getComputedStyle(n).color);
  const heroBg = await p.$eval('.public-hero', n => getComputedStyle(n).backgroundColor);
  const heroRatio = contrastRatio(rgbToHex(heroTextColor), rgbToHex(heroBg));
  ck('Hero heading stays readable against a light (lime) accent background', heroRatio >= 3, `text=${heroTextColor} bg=${heroBg} ratio=${heroRatio.toFixed(2)}`);

  const btnTextColor = await p.$eval('[data-action="show-signup"]', n => getComputedStyle(n).color);
  const btnBg = await p.$eval('[data-action="show-signup"]', n => getComputedStyle(n).backgroundColor);
  const btnRatio = contrastRatio(rgbToHex(btnTextColor), rgbToHex(btnBg));
  ck('Register button text stays readable even when Primary and Secondary are the same colour (the real bug)', btnRatio >= 3, `text=${btnTextColor} bg=${btnBg} ratio=${btnRatio.toFixed(2)}`);

  ck('no console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
