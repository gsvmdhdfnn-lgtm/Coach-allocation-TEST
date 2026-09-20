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
  await page.waitForSelector('.page-title, .coach-home', { timeout: 8000 });
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

  // --- Parent signs up, lands directly on the Parent Hub ---
  await signUp(page, 'parent1@test.com', 'parent');
  ck('Parent lands on the Parent Hub after signup (no approval wait)', await page.locator('.parent-children-list').count() > 0);
  ck('Main nav (4-pill tab bar) is hidden for parent role', await page.locator('.main-nav').isHidden());
  ck('Hamburger (top-actions) stays visible for parent role', await page.locator('.top-actions').isVisible());
  ck('Empty state shown before any child is linked', (await page.locator('.parent-children-list').innerText()).includes('No children linked'));

  // --- Claim a matched child (Alfie Test) ---
  await page.click('[data-action="open-claim-child"]');
  await page.waitForSelector('#claim-name');
  await page.fill('#claim-name', 'Alfie Test');
  await page.fill('#claim-dob', '2015-05-10');
  await page.click('[data-action="submit-claim"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  let pendingText = await page.locator('.parent-pending-list').innerText();
  ck('Matched claim (Alfie Test) shows as Pending, not auto-verified', pendingText.includes('Alfie Test') && pendingText.includes('Pending'));
  ck('No "Request a session" button exists yet (zero access while pending)', await page.locator('[data-action="open-request-session"]').count() === 0);

  // --- Claim an ambiguous child (Sam Test - two Player records match name+DOB) ---
  await page.click('[data-action="open-claim-child"]');
  await page.waitForSelector('#claim-name');
  await page.fill('#claim-name', 'Sam Test');
  await page.fill('#claim-dob', '2014-01-01');
  await page.click('[data-action="submit-claim"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  pendingText = await page.locator('.parent-pending-list').innerText();
  ck('Ambiguous claim (Sam Test) shows as Needs review', pendingText.includes('Needs review'));

  // --- Claim with no match at all ---
  await page.click('[data-action="open-claim-child"]');
  await page.waitForSelector('#claim-name');
  await page.fill('#claim-name', 'Nobody Real');
  await page.fill('#claim-dob', '1999-01-01');
  await page.click('[data-action="submit-claim"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  pendingText = await page.locator('.parent-pending-list').innerText();
  ck('Unmatched claim also lands as Needs review (never rejected/granted automatically)', (pendingText.match(/Needs review/g) || []).length === 2);

  // --- Switch to a management account and review claims ---
  await logOut(page);
  await signUp(page, 'mgmt1@test.com', 'staff');
  ck('Management account lands on the coach/management shell', await page.locator('.main-nav').isVisible());

  await page.click('.icon-btn[data-action="open-more"]');
  await page.click('[data-nav="parent-claims"]');
  await page.waitForSelector('#parent-claims-list');
  await page.waitForSelector('.request-row', { timeout: 8000 });
  const rows = page.locator('#parent-claims-list .request-row');
  ck('Parent Claims screen lists all 3 pending claims', await rows.count() === 3);

  function claimRow(name) { return page.locator('.request-row').filter({ has: page.locator('b', { hasText: name }) }); }
  const alfieRow = claimRow('Alfie Test');
  ck('Matched claim has no player-picker (already resolved)', await alfieRow.locator('select').count() === 0);
  await alfieRow.locator('[data-action="approve-parent-claim"]').click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  ck('Approving the matched claim removes it from the pending list', await claimRow('Alfie Test').count() === 0);

  const samRow = claimRow('Sam Test');
  await samRow.locator('[data-action="approve-parent-claim"]').click();
  await page.waitForTimeout(300);
  ck('Approving an unresolved claim without picking a player is blocked', await samRow.locator('.request-error:not([hidden])').count() === 1);
  await samRow.locator('select').selectOption({ label: 'Sam Test' });
  await samRow.locator('[data-action="approve-parent-claim"]').click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  ck('Approving after picking a player succeeds and removes the row', await claimRow('Sam Test').count() === 0);

  const nobodyRow = claimRow('Nobody Real');
  await nobodyRow.locator('[data-action="reject-parent-claim"]').click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  ck('Rejecting the unmatched claim removes it from the list', await page.locator('#parent-claims-list .request-row').count() === 0);
  const remaining = await page.locator('#parent-claims-list').innerText();
  ck('Empty state shows once every claim has been actioned', remaining.includes('No parent claims waiting'));

  // --- Back to the parent: the approved child now grants real access ---
  await logOut(page);
  await page.click('[data-action="show-signin"]');
  await page.waitForSelector('.auth-card');
  await page.fill('#auth-email', 'parent1@test.com');
  await page.fill('#auth-password', 'password123');
  await page.click('[data-action="auth-submit"]');
  await page.waitForSelector('.parent-children-list', { timeout: 8000 });
  const childrenText = await page.locator('.parent-children-list').innerText();
  ck('Verified child (Alfie Test) now appears under children', childrenText.includes('Alfie Test'));
  const pendingAfter = await page.locator('.parent-pending-list').innerText().catch(() => '');
  ck('Sam Test moved out of pending into children too', childrenText.includes('Sam Test'));
  ck('Rejected/removed claim (Nobody Real) is gone entirely, not lingering', !((await page.locator('body').innerText()).includes('Nobody Real')));

  // --- Request a session for the now-verified child ---
  await page.locator('.player-row', { hasText: 'Alfie Test' }).locator('[data-action="open-request-session"]').click();
  await page.waitForSelector('#request-session-select');
  await page.selectOption('#request-session-select', { index: 1 });
  await page.click('[data-action="submit-session-request"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  ck('Session request for a verified child is accepted', server.sessionRequests.length === 1 && server.sessionRequests[0].playerId === 'plyr1');

  ck('No console/page errors the whole way through', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close();
  process.exit(process.exitCode || 0);
})();
