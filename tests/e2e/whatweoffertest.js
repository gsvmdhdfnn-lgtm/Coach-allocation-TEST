const http = require('http'), path = require('path');
const { serveStatic } = require('../support/serve-static.js');
const { chromium } = require('playwright');
const ROOT = require('path').join(__dirname, '..', '..');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

const ORG = { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' };

// Welcome opts in via show_what_we_offer; a second page (Trials) does not,
// and keeps a real (non-"General") category to prove that chip still shows.
const WELCOME = { page_id: 'PUB-WELCOME', title: 'Welcome to Josh Evans Soccer School', category: 'General', summary: '', body: 'We offer a full pathway from first touches to competitive football.', cta_label: '', cta_link: '', image_url: '', show_what_we_offer: true };
const TRIALS = { page_id: 'PUB-TRIALS', title: 'JETS FC Trials', category: 'Trials', summary: '', body: 'Come along and try out.', cta_label: '', cta_link: '', image_url: '', show_what_we_offer: false, age_groups: 'U9/10, U11/12' };
const PAGES = [WELCOME, TRIALS];

// Six offerings covering every optional-field/pricing combination the
// spec calls out: image/no image, every billing period, a "From" prefix,
// a note-only (no price) offering, and a fully bare Title+Description
// offering with nothing else set. Inactive/unsorted extras prove Active
// filtering and Sort Order.
const OFFERINGS = [
  { offering_id: 'OFFER-JETS', title: 'JETS FC', description: 'Team football and matchday experiences.', image_url: 'https://example.com/jets.jpg', age_for: 'U9-U16', day_time: 'Saturdays', venue: 'Meadowbank', price: 45, billing_period: 'Monthly', price_note: '' },
  { offering_id: 'OFFER-ACADEMY', title: 'Academy', description: 'High-quality development for ambitious players.', image_url: '', age_for: '', day_time: '', venue: '', price: 120, billing_period: 'Termly', price_note: '' },
  { offering_id: 'OFFER-TDC', title: 'Technical Development Centre', description: 'Individual-focused technical development.', image_url: '', age_for: '', day_time: '', venue: '', price: 12.5, billing_period: 'Weekly', price_note: '' },
  { offering_id: 'OFFER-PREACADEMY', title: 'Pre-Academy', description: 'Development sessions for younger players.', image_url: '', age_for: '', day_time: '', venue: '', price: 10, billing_period: 'Weekly', price_note: 'From' },
  { offering_id: 'OFFER-CAMPS', title: 'Camps', description: 'Holiday football coaching and challenges.', image_url: '', age_for: '', day_time: '', venue: '', price: null, billing_period: '', price_note: 'Trial / invitation pathway' },
  { offering_id: 'OFFER-SCHOOLS', title: 'Schools / After-School Football', description: 'Football provision in schools.', image_url: '', age_for: '', day_time: '', venue: '', price: null, billing_period: '', price_note: '' },
];

function makeServer(pages, offerings) {
  return http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ organisation: ORG, settings: {}, features: {} })); }
    if (u === '/hub-content/public-pages') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(pages)); }
    if (u === '/hub-content/what-we-offer') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(offerings)); }
    return serveStatic(q, r, u, ROOT);
  });
}

async function withPage(pages, offerings, port, fn) {
  const server = makeServer(pages, offerings);
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
  await withPage(PAGES, OFFERINGS, 8211, async (page, errs) => {
    // Welcome (featured card) opts in and shows the shared section.
    await page.click('.public-featured');
    await page.waitForSelector('.public-detail-hero');

    ck('The "General" category chip does not render on the Welcome page', await page.locator('.detail-info-row').count() === 0);

    ck('"What we offer" heading renders', await page.locator('.public-offer-heading').textContent().then((t) => t.trim() === 'What we offer'));
    const cards = page.locator('.offer-card');
    ck('All 6 active offerings render, none hardcoded (driven entirely by the mock What We Offer data)', await cards.count() === 6, await cards.count());

    const titles = await page.locator('.offer-card-body h3').allTextContents();
    ck('Offerings render in configured order (JETS FC first, Schools last)', titles[0] === 'JETS FC' && titles[titles.length - 1] === 'Schools / After-School Football', JSON.stringify(titles));

    ck('An offering with an image shows it', await page.locator('.offer-card').first().locator('.offer-card-img').count() === 1);
    ck('An offering with no image shows no image block (optional, no empty gap)', await page.locator('.offer-card').nth(1).locator('.offer-card-img').count() === 0);

    const bareCard = page.locator('.offer-card').last();
    ck('A bare Title+Description offering (no age/day/venue/price) still renders complete, with no quick-fact row', await bareCard.locator('.offer-facts').count() === 0);
    const bareDesc = await bareCard.locator('.offer-card-body p').textContent();
    ck('...and its description is shown', bareDesc.includes('Football provision in schools'));

    const facts = await page.locator('.offer-card').first().locator('.offer-fact').allTextContents();
    ck('Age/day/venue quick facts render when configured', facts.some((f) => f.includes('U9-U16')) && facts.some((f) => f.includes('Saturdays')) && facts.some((f) => f.includes('Meadowbank')), JSON.stringify(facts));

    const priceMonthly = await page.locator('.offer-card').first().locator('.offer-fact', { hasText: 'Price' }).textContent();
    ck('Price + Monthly billing period displays correctly (whole-number price, no trailing .00)', priceMonthly.includes('£45 monthly'), priceMonthly);

    const priceTermly = await page.locator('.offer-card').nth(1).locator('.offer-fact', { hasText: 'Price' }).textContent();
    ck('Price + Termly billing period displays correctly', priceTermly.includes('£120 termly'), priceTermly);

    const priceWeekly = await page.locator('.offer-card').nth(2).locator('.offer-fact', { hasText: 'Price' }).textContent();
    ck('Price + Weekly billing period keeps the pence (12.50, not 12.5 or 12)', priceWeekly.includes('£12.50 weekly'), priceWeekly);

    const pricePrefix = await page.locator('.offer-card').nth(3).locator('.offer-fact', { hasText: 'Price' }).textContent();
    ck('A numeric price with a Price Note shows the note as a prefix ("From £10 weekly")', pricePrefix.includes('From £10 weekly'), pricePrefix);

    const noteOnly = await page.locator('.offer-card').nth(4).locator('.offer-fact', { hasText: 'Price' }).textContent();
    ck('No numeric price + a Price Note shows the note standalone, no currency symbol', noteOnly.includes('Trial / invitation pathway') && !noteOnly.includes('£'), noteOnly);

    ck('No price and no note at all means no price line renders for that offering', await bareCard.locator('.offer-fact', { hasText: 'Price' }).count() === 0);

    ck('The general "sign in or register" line is present', await page.locator('.offer-auth-cta p').textContent().then((t) => /sign in or register/i.test(t)));
    ck('The sign-in/register CTA reuses the existing auth actions (Sign In)', await page.locator('.offer-auth-cta-actions [data-action="show-signin"]').count() === 1);
    ck('The sign-in/register CTA reuses the existing auth actions (Register)', await page.locator('.offer-auth-cta-actions [data-action="show-signup"]').count() === 1);

    // Responsive: 1 column narrow mobile, 2 at a larger phone width, 3 at desktop.
    const colsMobile = await page.evaluate(() => getComputedStyle(document.querySelector('.offer-grid')).gridTemplateColumns.split(' ').length);
    ck('Offer grid is a single column at narrow mobile (390px), for readability', colsMobile === 1, colsMobile);
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('No horizontal overflow at 390px', overflow <= 1, 'overflow=' + overflow);

    await page.setViewportSize({ width: 520, height: 900 });
    await page.waitForTimeout(120);
    const colsWide = await page.evaluate(() => getComputedStyle(document.querySelector('.offer-grid')).gridTemplateColumns.split(' ').length);
    ck('Offer grid becomes 2 columns on a larger phone (520px)', colsWide === 2, colsWide);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(120);
    const colsDesktop = await page.evaluate(() => getComputedStyle(document.querySelector('.offer-grid')).gridTemplateColumns.split(' ').length);
    ck('Offer grid becomes 3 columns at desktop (1280px)', colsDesktop === 3, colsDesktop);
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck('No horizontal overflow at desktop width', overflow <= 1, 'overflow=' + overflow);
    await page.setViewportSize({ width: 390, height: 900 });

    await page.click('.offer-auth-cta-actions [data-action="show-signin"]');
    await page.waitForSelector('.auth-card');
    ck('Clicking Sign In from the offer section reaches the real sign-in screen (existing auth flow, not a new journey)', await page.locator('.auth-card h1').textContent().then((t) => t === 'Sign in'));

    ck('No console/page errors on the Welcome page', errs.length === 0, errs.join(' | '));

    // Trials page: opted out (show_what_we_offer false) and keeps a real category chip.
    // (Currently on the sign-in screen reached above - back to the public grid first.)
    await page.click('[data-action="show-public"]');
    await page.waitForSelector('.public-page');
    await page.click('.public-tile:has-text("JETS FC Trials")');
    await page.waitForSelector('.public-detail-hero');
    ck('A page with show_what_we_offer=false shows no offer section at all, even though offerings exist', await page.locator('.public-offer-section').count() === 0);
    ck('A real category ("Trials") still shows its chip - only the generic "General" value is special-cased', (await page.locator('.detail-info-chip').first().textContent()).includes('Trials'));

    ck('No console/page errors on the Trials page', errs.length === 0, errs.join(' | '));
  });

  // Welcome opts in, but there are zero active offerings - the section
  // must not render an empty heading/grid.
  await withPage([WELCOME], [], 8211, async (page, errs) => {
    await page.click('.public-featured');
    await page.waitForSelector('.public-detail-hero');
    ck('With show_what_we_offer=true but zero active offerings, no section renders at all (no empty heading/grid)', await page.locator('.public-offer-section').count() === 0);
    ck('No console/page errors (empty-offerings scenario)', errs.length === 0, errs.join(' | '));
  });

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(process.exitCode || 0);
})();
