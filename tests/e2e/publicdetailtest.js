const http = require('http'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

const ORG = { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' };

// Scenario A: a fully-configured page - image, summary, colour, category,
// age groups, CTA, events and the register form all present at once.
const PAGES_A = [
  { page_id: 'PUB-WELCOME', title: 'Welcome', category: 'General', summary: 'Intro', cta_label: '', cta_link: '', image_url: '' },
  {
    page_id: 'PUB-TOURS', title: 'Football Tours', category: 'Tours',
    summary: 'Unforgettable trips for our academy squads.',
    body: 'Every summer we take a squad overseas to play against clubs across Europe.',
    cta_label: 'Ask about the next tour', cta_link: 'https://example.com/tours',
    image_url: 'https://example.com/tours-hero.jpg',
    colour: '#0b3e78', colour_preset: '',
    age_groups: 'U11/12, U13/14',
    show_register_form: true,
    events: [
      { photo_url: 'https://example.com/tour1.jpg', description: 'Barcelona 2025' },
      { photo_url: '', description: '' },
      { photo_url: 'https://example.com/tour2.jpg', description: '' },
    ],
  },
];

// Scenario B: the bare minimum a Public Page record can be - no image, no
// summary, no colour, no category, no age groups, no CTA, no events, and
// the register form explicitly turned off. The page should still render
// a complete-looking single column, not a broken/empty shell.
const PAGES_B = [
  { page_id: 'PUB-WELCOME', title: 'Welcome', category: 'General', summary: '', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-EVENTS', title: 'Upcoming Events', category: '', summary: '', body: '', cta_label: '', cta_link: '', image_url: '', show_register_form: false, events: [] },
];

function makeServer(pages) {
  return http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ organisation: ORG, settings: {}, features: {} })); }
    if (u === '/hub-content/public-pages') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(pages)); }
    return serveStatic(q, r, u, ROOT);
  });
}

async function withPage(pages, port, fn) {
  const server = makeServer(pages);
  await new Promise((res) => server.listen(port, res));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ path: path.join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.public-page');
  await fn(page, errs);
  await b.close();
  server.close();
}

(async () => {
  // --- Scenario A: fully-configured page ---
  await withPage(PAGES_A, 8211, async (page, errs) => {
    await page.click('.public-tile:has-text("Football Tours")');
    await page.waitForSelector('.public-detail-hero');

    const heroBg = await page.$eval('.public-detail-hero', (n) => getComputedStyle(n).backgroundColor);
    ck('Hero uses the page\'s configured colour, not a generic default', heroBg === 'rgb(11, 62, 120)', heroBg);

    const summary = await page.$eval('.public-detail-hero p', (n) => n.textContent);
    ck('Configured summary is shown in the hero', summary === 'Unforgettable trips for our academy squads.', summary);

    ck('Configured image renders', await page.locator('.public-detail-img img').count() === 1);

    const body = await page.$eval('.detail-card p', (n) => n.textContent);
    ck('Configured body text renders in the content card', body.includes('overseas'), body);

    const chips = await page.locator('.detail-info-chip').allTextContents();
    ck('Category chip is shown', chips.some((c) => c.includes('Tours')), JSON.stringify(chips));
    ck('Age Groups chip is shown, combining the configured list', chips.some((c) => c.includes('U11/12') && c.includes('U13/14')), JSON.stringify(chips));

    const cta = page.locator('.public-detail-cta');
    ck('CTA button uses the configured label', (await cta.textContent()).trim() === 'Ask about the next tour');
    ck('CTA button uses the configured link, not a hardcoded one', await cta.getAttribute('href') === 'https://example.com/tours');

    const eventItems = await page.locator('.event-item').count();
    ck('Only events with a photo or description render (2 of 3), the empty slot is skipped entirely', eventItems === 2, eventItems);

    ck('Register-interest form still renders when Show Register Form is true', await page.locator('.register-interest-card').count() === 1);

    // Responsive: two-column layout kicks in at desktop once there is
    // real side content (CTA/events/form), stacks at mobile.
    const mobileDisplay = await page.$eval('.public-detail-grid', (n) => getComputedStyle(n).display);
    ck('Content and CTA/events/form stack in one column on mobile', mobileDisplay === 'flex', mobileDisplay);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(120);
    const desktopDisplay = await page.$eval('.public-detail-grid', (n) => getComputedStyle(n).display);
    ck('Content/details and CTA/events/form split into two columns at desktop', desktopDisplay === 'grid', desktopDisplay);
    const overflowDesktop = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('No horizontal overflow at desktop width (1280px)', overflowDesktop <= 1, 'overflow=' + overflowDesktop);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(120);
    const overflowMobile = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('No horizontal overflow at mobile width (390px)', overflowMobile <= 1, 'overflow=' + overflowMobile);

    ck('No console/page errors (scenario A)', errs.length === 0, errs.join(' | '));
  });

  // --- Scenario B: a bare-minimum page still looks complete ---
  await withPage(PAGES_B, 8211, async (page, errs) => {
    await page.click('.public-tile:has-text("Upcoming Events")');
    await page.waitForSelector('.public-detail-hero');

    ck('No summary paragraph when summary is blank (no empty gap)', await page.locator('.public-detail-hero p').count() === 0);
    ck('No image block when image_url is blank', await page.locator('.public-detail-img').count() === 0);
    ck('No info chip row when category and age groups are both blank', await page.locator('.detail-info-row').count() === 0);
    ck('No CTA button when cta_label/cta_link are blank', await page.locator('.public-detail-cta').count() === 0);
    ck('No event cards when no events are configured', await page.locator('.event-item').count() === 0);
    ck('No register form when Show Register Form is explicitly false', await page.locator('.register-interest-card').count() === 0);
    ck('With nothing in the side column, the page falls back to a single column, not an empty grid', await page.locator('.public-detail-grid').count() === 0);

    const cardVisible = await page.locator('.detail-card').isVisible();
    ck('The content card itself still renders and is visible - the page never looks empty/broken', cardVisible);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('No horizontal overflow at mobile width with a minimal page', overflow <= 1, 'overflow=' + overflow);

    await page.click('[data-action="show-public"]');
    await page.waitForSelector('.public-page');
    ck('Back returns to the public landing grid', true);

    ck('No console/page errors (scenario B)', errs.length === 0, errs.join(' | '));
  });

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(process.exitCode || 0);
})();
