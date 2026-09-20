const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

// --- Scenario A: an org with a real featured-card CTA label and all three
// optional quick-link values configured (website/instagram/contact) ---
const ORG_A = {
  hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.',
  website: 'https://joshevanssoccerschool.example.com',
};
const SETTINGS_A = { instagram_url: 'https://instagram.com/joshevanssoccerschool', contact_url: 'mailto:hello@joshevans.example.com' };
const PAGES_A = [
  { page_id: 'PUB-WELCOME', title: 'Welcome to Josh Evans Soccer School', category: 'General', summary: 'Find the right football experience for you.', cta_label: 'Explore Josh Evans', cta_link: '', image_url: '' },
  { page_id: 'PUB-WEEKLY', title: 'Weekly Coaching', category: 'Academy', summary: '', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-CAMPS', title: 'Holiday Camps', category: 'Events', summary: '', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-TRIALS', title: 'Trials & Teams', category: 'Trials', summary: '', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-TOURS', title: 'Events & Tours', category: 'Tours', summary: '', cta_label: '', cta_link: '', image_url: '' },
];

// --- Scenario B: no optional quick-link values configured at all, and the
// featured card has no cta_label set (falls back to generic text) ---
const ORG_B = { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' };
const PAGES_B = [
  { page_id: 'PUB-WELCOME', title: 'Welcome to Josh Evans Soccer School', category: 'General', summary: 'Find the right football experience for you.', cta_label: '', cta_link: '', image_url: '' },
];

function makeServer(org, settings, pages) {
  return http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ organisation: org, settings: settings || {}, features: {} })); }
    if (u === '/hub-content/public-pages') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(pages)); }
    return serveStatic(q, r, u, ROOT);
  });
}

async function withPage(server, port, fn) {
  await new Promise((res) => server.listen(port, res));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ path: path.join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.public-page');
  await fn(page, errs, ctx);
  await b.close();
  server.close();
}

(async () => {
  // --- Scenario A ---
  await withPage(makeServer(ORG_A, SETTINGS_A, PAGES_A), 8211, async (page, errs, ctx) => {
    const ctaText = await page.locator('.public-featured-enquiry').textContent();
    ck('Featured card CTA uses the real cta_label (data-driven, not hardcoded)', ctaText.includes('Explore Josh Evans'), ctaText);

    const links = page.locator('.public-quicklink');
    ck('All 3 configured quick links render', await links.count() === 3);
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    ck('Website quick link uses organisation.website', hrefs.includes('https://joshevanssoccerschool.example.com'), JSON.stringify(hrefs));
    ck('Instagram quick link uses the instagram_url Hub Setting', hrefs.includes('https://instagram.com/joshevanssoccerschool'), JSON.stringify(hrefs));
    ck('Contact Us quick link uses the contact_url Hub Setting', hrefs.includes('mailto:hello@joshevans.example.com'), JSON.stringify(hrefs));

    const supportingTiles = await page.locator('.public-tile').count();
    ck('The 4 non-featured Public Pages still render as supporting cards (unchanged behaviour)', supportingTiles === 4);

    // --- Responsive: mobile (390), tablet (768), desktop (1440) ---
    const widths = { mobile: 390, tablet: 768, desktop: 1440 };
    for (const [name, w] of Object.entries(widths)) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(120);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ck(`No horizontal overflow at ${name} width (${w}px)`, overflow <= 1, 'overflow=' + overflow);
      const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.public-tile-grid')).gridTemplateColumns.split(' ').length);
      if (w >= 760) ck(`Supporting cards use a 3-column grid at ${name} width`, cols === 3, cols);
      else ck(`Supporting cards use a 2-column grid at ${name} width`, cols === 2, cols);
    }
    await page.setViewportSize({ width: 390, height: 900 });

    ck('No console/page errors (scenario A)', errs.length === 0, errs.join(' | '));
  });

  // --- Scenario B: nothing configured - preserves the current landing experience exactly ---
  await withPage(makeServer(ORG_B, {}, PAGES_B), 8211, async (page, errs) => {
    ck('No quick links render at all when nothing is configured (no empty placeholders/gaps)', await page.locator('.public-quicklinks').count() === 0);
    const ctaText = await page.locator('.public-featured-enquiry').textContent();
    ck('Featured card CTA falls back to generic text when cta_label is blank', ctaText.trim().length > 0 && !ctaText.includes('undefined'), ctaText);

    // Auth flow still works exactly as before
    await page.click('[data-action="show-signin"]');
    await page.waitForSelector('.auth-card');
    const h1 = await page.locator('.auth-card h1').textContent();
    ck('Sign In still reachable and unchanged', h1 === 'Sign in', h1);
    await page.click('[data-action="auth-switch"]');
    await page.waitForTimeout(150);
    const submitLabel = await page.locator('[data-action="auth-submit"]').textContent();
    ck('Sign-up flow still reachable and unchanged', submitLabel === 'Create account', submitLabel);
    await page.click('[data-action="show-public"]');
    await page.waitForSelector('.public-page');
    const registerBtn = await page.locator('[data-action="show-signup"]').textContent();
    ck('Public hero "Register" button text is unchanged', registerBtn.trim() === 'Register', registerBtn);
    const signInBtn = await page.locator('[data-action="show-signin"]').textContent();
    ck('Public hero "Sign In" button text is unchanged', signInBtn.trim() === 'Sign In', signInBtn);

    ck('No console/page errors (scenario B)', errs.length === 0, errs.join(' | '));
  });

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(process.exitCode || 0);
})();
