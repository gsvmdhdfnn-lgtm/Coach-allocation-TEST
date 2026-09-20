const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const __ctx = await b.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 });
  await __ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const p = await __ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });

  // Nav pill now says My Players, and its screen renders
  const pillText = await p.$eval('[data-nav="players"]', el => el.textContent.trim());
  ck('Fourth nav tab is now "My Players"', pillText === 'My Players', pillText);
  await p.click('[data-nav="players"]');
  await p.waitForSelector('.page-title h1');
  const playersHeading = await p.$eval('.page-title h1', el => el.textContent);
  ck('My Players screen renders', playersHeading === 'My Players', playersHeading);

  // Hamburger opens the More sheet
  await p.click('[data-action="open-more"]');
  await p.waitForSelector('.sheet .more-row, #sheet .more-row', { timeout: 3000 }).catch(() => {});
  const sheetVisible = await p.$eval('#sheet', el => !el.hidden).catch(() => false);
  ck('Hamburger opens the sheet', sheetVisible);
  const moreRowCount = await p.$$eval('.more-row', els => els.length);
  ck('More sheet has all 6 rows (profile/notifications/management/feedback/contact/logout)', moreRowCount === 6, String(moreRowCount));

  // Tapping Management from inside the sheet navigates AND closes the sheet
  await p.click('.more-row[data-nav="management"]');
  await p.waitForSelector('.locked', { timeout: 5000 });
  const sheetHiddenAfterNav = await p.$eval('#sheet', el => el.hidden).catch(() => true);
  ck('Sheet closes after navigating to Management from it', sheetHiddenAfterNav);
  ck('No nav tab shows active while on Management', await p.$eval('.nav-pill.is-active', el => el === null).catch(() => true) || (await p.$('.nav-pill.is-active')) === null);

  // Back button now matches the landing-page pill style
  await p.click('[data-nav="home"]');
  await p.waitForSelector('.coach-home');
  await p.click('[data-nav="venues"]');
  await p.waitForSelector('.venue-list, .venue-card, [data-action="venue-detail"]', { timeout: 5000 }).catch(() => {});
  const venueCard = await p.$('[data-action="venue-detail"]');
  if (venueCard) {
    await venueCard.click();
    await p.waitForSelector('#app-back:not([hidden])');
    const backText = await p.$eval('#app-back', el => el.textContent.trim());
    ck('Topbar back button now reads "‹ Back"', backText === '‹ Back', backText);
    const backClasses = await p.$eval('#app-back', el => el.className);
    ck('Topbar back button uses the .back-btn pill class', /\bback-btn\b/.test(backClasses), backClasses);
    const backBorder = await p.$eval('#app-back', el => getComputedStyle(el).borderRadius);
    ck('Topbar back button is pill-shaped', parseInt(backBorder) > 50, backBorder);
  } else {
    ck('Found a venue to drill into for the back-button check', false, 'no venue card found');
  }

  ck('no console/page errors', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
