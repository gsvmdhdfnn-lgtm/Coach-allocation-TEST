/**
 * Parent / Player Hub - Phase 1 shell.
 *
 * Covers the three things the phase must not get wrong:
 *   1. Parent vs Coach navigation - a parent gets their own four tabs and
 *      none of the Coach ones, and a coach is completely unaffected.
 *   2. Linked-child access - a parent only ever sees a Verified child,
 *      and the server refuses feedback for anyone else's child even when
 *      the client asks for it directly.
 *   3. Published + Active feedback visibility - drafts and archived
 *      feedback never reach a parent, for their own child or any other.
 */
const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock-parenthub.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const PORT = 8211;

async function signUp(page, email, type) {
  await page.click('[data-action="show-public"]').catch(() => {});
  await page.click('[data-action="show-signup"]');
  await page.waitForSelector('.auth-card');
  await page.click('[data-action="auth-account-type"][data-type="' + type + '"]');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', 'password123');
  await page.click('[data-action="auth-submit"]');
  await page.waitForSelector('.ph-hero, .coach-home, .page-title', { timeout: 8000 });
}
async function logOut(page) {
  await page.click('.icon-btn[data-action="open-more"]');
  await page.waitForSelector('.more-row[data-action="logout"]');
  await page.click('.more-row[data-action="logout"]');
  await page.waitForSelector('.public-page', { timeout: 8000 });
}

(async () => {
  await server.start(PORT);
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.public-page');

  // ---- A parent with a Verified child, seeded before first load -------
  server.links.push({ id: 'seedlink', parentEmail: 'ph1@test.com', playerId: 'plyr1', playerName: 'Alfie Test', dob: '2015-05-10', relationship: 'Parent', status: 'Verified', notes: '' });
  server.sessionLinks.push({ playerId: 'plyr1', sessionId: 'sess1', status: 'Active' });

  await signUp(page, 'ph1@test.com', 'parent');
  await page.waitForSelector('.ph-hero', { timeout: 8000 });

  // --- 1. Parent vs Coach navigation ---------------------------------
  ck('Parent sees the parent tab bar', await page.locator('.parent-nav').isVisible());
  ck('Parent does NOT see the Coach tab bar', await page.locator('.coach-nav').isHidden());
  // Nav pills are uppercased by CSS, so compare case-insensitively.
  const tabs = (await page.locator('.parent-nav .nav-pill').allInnerTexts()).map(s => s.trim().toLowerCase());
  ck('Parent tabs are exactly Home / Sessions / Development / More', JSON.stringify(tabs) === JSON.stringify(['home', 'sessions', 'development', 'more']), JSON.stringify(tabs));
  ck('No Coach-only nav target is reachable from the parent tab bar', await page.locator('.parent-nav [data-nav="schedule"], .parent-nav [data-nav="players"], .parent-nav [data-nav="resources"]').count() === 0);

  // The hamburger must not offer staff screens to a parent.
  await page.click('.icon-btn[data-action="open-more"]');
  await page.waitForSelector('.more-row[data-action="logout"]');
  // innerText for the human-readable label (innerHTML would escape the
  // ampersand to &amp; and never match), innerHTML for the nav targets.
  const moreSheetText = await page.locator('#sheet-content').innerText();
  const moreHtml = await page.locator('#sheet-content').innerHTML();
  ck('Parent More sheet does not expose Management & Financials', !/Management & Financials/.test(moreSheetText), moreSheetText);
  ck('Parent More sheet has no management nav targets', !/data-nav="(management|coach-management|session-requests|player-migration|parent-claims)"/.test(moreHtml));
  await page.click('[data-action="close-sheet"]');

  // --- HOME -----------------------------------------------------------
  const homeText = await page.locator('#screen-root').innerText();
  ck('Home shows the verified child', homeText.includes('Alfie Test'));
  ck('Home shows Next Session with real schedule data', /Next Session/.test(homeText) && /U9\/10 Development/.test(homeText));
  ck('Next Session shows the real day/time from the schedule', /Wednesday/.test(homeText) && /4:00pm/.test(homeText));
  ck('Next Session shows the real coach', /Coach: David/.test(homeText));
  ck('Updates section is hidden entirely when there are no updates', !/Updates/.test(homeText));
  ck('Home shows Recent Feedback from the published record', /Recent Feedback/.test(homeText) && /Being you\./.test(homeText));

  // --- 3. Published + Active feedback visibility -----------------------
  ck('A coach DRAFT never appears for a parent', !/DRAFT-KEEP-DOING|DRAFT-FOCUS|DRAFT-SUMMARY/.test(homeText));
  ck('An ARCHIVED (Active=false) record never appears for a parent', !/ARCHIVED-KEEP-DOING|ARCHIVED-FOCUS/.test(homeText));

  // --- DEVELOPMENT ----------------------------------------------------
  await page.click('.parent-nav [data-nav="parent-development"]');
  await page.waitForSelector('.ph-snapshot, .ph-empty', { timeout: 8000 });
  const devText = await page.locator('#screen-root').innerText();
  ck('Development shows Latest Feedback', /Latest Feedback/.test(devText) && /Being you\./.test(devText));
  ck('Development shows Current Development ratings snapshot', /Current Development/.test(devText) && /Winners/.test(devText));
  ck('Rating snapshot is grouped by the framework groups', /Characteristics/i.test(devText) && /Football Pillars/i.test(devText));
  ck('Rating legend uses the configured labels, not raw colours', /Consistently strong/.test(devText) && /Developing/.test(devText));
  ck('Development shows Previous Feedback history', /Previous Feedback/.test(devText) && /31 August 2026/.test(devText));
  ck('Draft/archived feedback is absent from Development too', !/DRAFT-|ARCHIVED-/.test(devText));

  // Parent is view-only: none of the coach entry controls exist.
  ck('No coach feedback entry controls anywhere on Development',
    await page.locator('[data-action="add-feedback"], [data-action="save-feedback-draft"], [data-action="publish-feedback"], [data-action="rating-choice"]').count() === 0);
  const selectedDots = await page.locator('.ph-dot.is-selected').count();
  ck('The published ratings render as selected dots', selectedDots === 3, String(selectedDots));

  // --- No duplicate development rows ----------------------------------
  // The mock feeds SIX rating rows covering only THREE framework items
  // (the live table carries the same duplicates), so this fails loudly if
  // the dedupe regresses.
  const rateNames = await page.locator('.ph-rate b').allInnerTexts();
  const trimmedNames = rateNames.map(s => s.trim());
  ck('Each development item renders exactly once', trimmedNames.length === new Set(trimmedNames).size, JSON.stringify(trimmedNames));
  ck('...and all three distinct items are present', trimmedNames.length === 3, JSON.stringify(trimmedNames));
  ck('Winners appears once, not four times', trimmedNames.filter(n => n === 'Winners').length === 1, JSON.stringify(trimmedNames));
  ck('The newest saved rating wins for a de-duplicated item (Winners = Green)',
    await page.locator('.ph-rate', { hasText: 'Winners' }).locator('.ph-dot.ph-green.is-selected').count() === 1);
  ck('No rating row is merely hidden by CSS rather than removed',
    await page.locator('.ph-rate').evaluateAll(els => els.every(e => getComputedStyle(e).display !== 'none')));

  // --- Parent-facing coach name ----------------------------------------
  const devHtmlForName = await page.locator('#screen-root').innerText();
  ck('A system-style username is never shown to a parent', !/davidcole\.surrey/.test(devHtmlForName), devHtmlForName.slice(0, 160));
  ck('The proper coach name is shown instead', /David Cole/.test(devHtmlForName));
  ck('No email address leaks into the parent view', !/@/.test(devHtmlForName), devHtmlForName.slice(0, 160));

  // --- SESSIONS -------------------------------------------------------
  await page.click('.parent-nav [data-nav="parent-sessions"]');
  await page.waitForSelector('.ph-row, .ph-empty', { timeout: 8000 });
  const sessText = await page.locator('#screen-root').innerText();
  ck('Sessions lists the child’s real session', /U9\/10 Development/.test(sessText));
  ck('Sessions keeps the wording "Find Another Session"', /Find Another Session/.test(sessText));
  ck('Sessions shows Past & Current', /Past & Current/.test(sessText));

  // --- SESSION DETAIL --------------------------------------------------
  await page.click('.ph-row[data-action="parent-session-detail"]');
  await page.waitForSelector('.ph-detail-hero', { timeout: 8000 });
  const detailText = await page.locator('#screen-root').innerText();
  ck('Session detail shows the session name', /U9\/10 Development/.test(detailText));
  ck('Session detail shows real venue and address', /City of London Freemen/.test(detailText) && /Park Lane, Ashtead/.test(detailText));
  ck('Session detail shows real venue extras (parking / meeting point)', /main school car park/.test(detailText) && /Astro gate/.test(detailText));
  ck('Session detail shows the real coach', /David/.test(detailText));
  ck('Session detail invents nothing for absent fields (no empty dashes)', !/—\s*$/m.test(detailText));
  ck('Back button is available from session detail', await page.locator('#app-back').isVisible());

  // --- Back button belongs to drill-downs only -------------------------
  for (const tab of ['parent-home', 'parent-sessions', 'parent-development', 'parent-more']) {
    await page.click('.parent-nav [data-nav="' + tab + '"]');
    await page.waitForTimeout(150);
    ck('No Back button on the top-level ' + tab + ' tab', await page.locator('#app-back').isHidden());
  }
  // Drilling in again still offers Back, and returning to a tab clears it.
  await page.click('.parent-nav [data-nav="parent-sessions"]');
  await page.waitForSelector('.ph-row[data-action="parent-session-detail"]', { timeout: 8000 });
  await page.click('.ph-row[data-action="parent-session-detail"]');
  await page.waitForSelector('.ph-detail-hero', { timeout: 8000 });
  ck('Back returns on a drill-down after visiting the tabs', await page.locator('#app-back').isVisible());
  await page.click('#app-back');
  await page.waitForSelector('.ph-hero', { timeout: 8000 });
  ck('Back from session detail lands on a tab with no Back button left', await page.locator('#app-back').isHidden());

  // --- Session labelling where venue names repeat ----------------------
  await page.click('.parent-nav [data-nav="parent-sessions"]');
  await page.waitForSelector('[data-action="parent-find-session"]', { timeout: 8000 });
  await page.click('[data-action="parent-find-session"]');
  await page.waitForSelector('#request-session-select', { timeout: 8000 });
  const optionLabels = await page.locator('#request-session-select option').allInnerTexts();
  const daneshill = optionLabels.map(s => s.trim()).filter(s => /Daneshill/.test(s));
  ck('Both same-venue sessions are offered', daneshill.length === 2, JSON.stringify(optionLabels));
  ck('The two "Daneshill" sessions are NOT identical entries', daneshill.length === 2 && daneshill[0] !== daneshill[1], JSON.stringify(daneshill));
  ck('Same-venue options are distinguished by day/time/age group',
    daneshill.every(l => /Monday|Thursday/.test(l)) && daneshill.some(l => /Years 1-2/.test(l)) && daneshill.some(l => /Years 5-6/.test(l)),
    JSON.stringify(daneshill));
  ck('An option never repeats the venue when it is already the title',
    !daneshill.some(l => (l.match(/Daneshill/g) || []).length > 1), JSON.stringify(daneshill));
  await page.click('[data-action="close-sheet"]');
  await page.waitForTimeout(150);

  // --- MORE ------------------------------------------------------------
  await page.click('.parent-nav [data-nav="parent-more"]');
  await page.waitForSelector('.ph-menu', { timeout: 8000 });
  const moreText = await page.locator('#screen-root').innerText();
  ck('More shows Payments & Bookings as an honest placeholder', /Payments & Bookings/.test(moreText) && /Coming soon/.test(moreText));
  ck('More does not invent a payment amount', !/£\d/.test(moreText));
  ck('More shows Family & Account', /Family & Account/.test(moreText) && /Children & Access/.test(moreText) && /Account/.test(moreText));
  ck('More shows Help & Support', /Help & Support/.test(moreText) && /Contact \/ Support/.test(moreText));
  const policies = ['Safeguarding', 'Cancellation & Refund', 'Terms & Conditions', 'Privacy', 'Photography / Media', 'Codes of Conduct'];
  ck('More lists all six policy areas', policies.every(p => moreText.includes(p)), moreText.slice(0, 200));

  // A policy with no published content says so rather than inventing text.
  await page.click('.ph-menu-row[data-policy="safeguarding"]');
  await page.waitForSelector('.ph-empty', { timeout: 8000 });
  const policyText = await page.locator('#screen-root').innerText();
  ck('An unpublished policy says so plainly instead of showing invented wording', /Not published here yet/.test(policyText));

  // --- 2. Linked-child access -----------------------------------------
  // Directly ask the API for another child's feedback, bypassing the UI.
  const otherChild = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8211/parent-hub/feedback?player_record_id=plyr2', { headers: { Authorization: 'Bearer tok-ph1@test.com~parent' } });
    return { status: r.status, body: await r.text() };
  });
  ck('Server refuses feedback for a child this parent has not claimed', otherChild.status === 403, String(otherChild.status));
  ck('...and leaks none of that child’s feedback in the refusal', !/OTHER-CHILD/.test(otherChild.body));

  // A Pending (unapproved) claim must not grant access either.
  server.links.push({ id: 'pendinglink', parentEmail: 'ph1@test.com', playerId: 'plyr2', playerName: 'Bea Test', dob: '2016-02-20', relationship: 'Parent', status: 'Pending', notes: '' });
  const pendingChild = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8211/parent-hub/feedback?player_record_id=plyr2', { headers: { Authorization: 'Bearer tok-ph1@test.com~parent' } });
    return { status: r.status, body: await r.text() };
  });
  ck('A Pending (not yet approved) claim grants no feedback access', pendingChild.status === 403, String(pendingChild.status));
  ck('...and still leaks nothing', !/OTHER-CHILD/.test(pendingChild.body));

  // A coach must not be able to reach the parent endpoint at all.
  const asCoach = await page.evaluate(async () => {
    const r = await fetch('http://localhost:8211/parent-hub/feedback?player_record_id=plyr1', { headers: { Authorization: 'Bearer tok-coach@test.com' } });
    return r.status;
  });
  ck('A non-parent role is refused by the parent feedback endpoint', asCoach === 403, String(asCoach));

  // --- Coach is completely unaffected ----------------------------------
  await logOut(page);
  await signUp(page, 'coach-nav@test.com', 'staff');
  // Wait for real Coach content - both nav elements always exist in the
  // DOM (only their visibility differs), so waiting on .coach-nav would
  // return while the parent shell was still on screen.
  await page.waitForSelector('.coach-home, .hero', { timeout: 10000 });
  ck('Coach still sees the Coach tab bar', await page.locator('.coach-nav').isVisible());
  ck('Coach does NOT see the parent tab bar', await page.locator('.parent-nav').isHidden());
  const coachTabs = (await page.locator('.coach-nav .nav-pill').allInnerTexts()).map(s => s.trim().toLowerCase());
  ck('Coach tabs are unchanged (Home/Schedule/Library/Player Hub)', JSON.stringify(coachTabs) === JSON.stringify(['home', 'schedule', 'library', 'player hub']), JSON.stringify(coachTabs));
  await page.click('.icon-btn[data-action="open-more"]');
  await page.waitForSelector('.more-row[data-action="logout"]');
  const coachMore = await page.locator('#sheet-content').innerText();
  ck('Coach More sheet still offers Management & Financials', /Management & Financials/.test(coachMore), coachMore);
  await page.click('[data-action="close-sheet"]');

  ck('No console/page errors the whole way through', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close();
  process.exit(process.exitCode || 0);
})();
