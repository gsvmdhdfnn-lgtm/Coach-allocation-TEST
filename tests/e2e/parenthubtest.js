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
  await page.waitForSelector('.page-title, .coach-home, .ph-hero', { timeout: 8000 });
}
async function logOut(page) {
  await page.click('.icon-btn[data-action="open-more"]');
  await page.waitForSelector('.more-row[data-action="logout"]');
  await page.click('.more-row[data-action="logout"]');
  await page.waitForSelector('.public-page', { timeout: 8000 });
}
async function signIn(page, email) {
  await page.click('[data-action="show-public"]').catch(() => {});
  await page.click('[data-action="show-signin"]');
  await page.waitForSelector('.auth-card');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', 'password123');
  await page.click('[data-action="auth-submit"]');
  await page.waitForSelector('.page-title, .coach-home, .ph-hero', { timeout: 8000 });
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
  ck('Parent lands on the Parent Hub after signup (no approval wait)', await page.locator('.ph-hero').count() > 0);
  ck('Coach tab bar is hidden for parent role', await page.locator('.coach-nav').isHidden());
  ck('Parent tab bar is shown for parent role', await page.locator('.parent-nav').isVisible());
  ck('Hamburger (top-actions) stays visible for parent role', await page.locator('.top-actions').isVisible());
  ck('Empty state shown before any child is linked', (await page.locator('#screen-root').innerText()).includes('No children linked'));

  // --- A parent with no child still gets the NORMAL Home, not a
  // standalone "add a child" holding screen ---
  const noChildHome = await page.locator('#screen-root').innerText();
  ck('No-child Home keeps the normal Next Session section', /Next Session/.test(noChildHome), noChildHome.slice(0, 200));
  ck('Next Session explains what adding a child unlocks', /Add your child to see schedule and session information/.test(noChildHome));
  ck('No-child Home keeps the normal Recent Feedback section', /Recent Feedback/.test(noChildHome));
  ck('No-child Home offers a clear Add a Child action', await page.locator('[data-action="open-claim-child"]').count() === 1);
  ck('No Back button on the no-child Home (it is a top-level tab)', await page.locator('#app-back').isHidden());
  // The other tabs are reachable and keep their own structure too.
  await page.click('.parent-nav [data-nav="parent-sessions"]');
  await page.waitForSelector('.ph-hero', { timeout: 8000 });
  ck('No-child Sessions tab still shows the Sessions structure', /Upcoming Sessions/.test(await page.locator('#screen-root').innerText()));
  await page.click('.parent-nav [data-nav="parent-development"]');
  await page.waitForSelector('.ph-hero', { timeout: 8000 });
  ck('No-child Development tab still shows the Development structure', /Latest Feedback/.test(await page.locator('#screen-root').innerText()));
  await page.click('.parent-nav [data-nav="parent-home"]');
  await page.waitForSelector('.ph-hero', { timeout: 8000 });

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
  ck('No session-request route exists yet (zero access while pending)', await page.locator('[data-action="open-request-session"], [data-action="parent-find-session"]').count() === 0);

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
  ck('Management account lands on the coach/management shell', await page.locator('.coach-nav').isVisible());

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
  // The children list now lives on More -> Children & Access rather than
  // the old flat parent hub screen.
  await page.waitForSelector('.ph-hero', { timeout: 8000 });
  await page.click('.parent-nav [data-nav="parent-more"]');
  await page.waitForSelector('.ph-menu-row[data-action="parent-children"]', { timeout: 8000 });
  await page.click('.ph-menu-row[data-action="parent-children"]');
  await page.waitForSelector('.parent-children-list', { timeout: 8000 });
  const childrenText = await page.locator('.parent-children-list').innerText();
  ck('Verified child (Alfie Test) now appears under children', childrenText.includes('Alfie Test'));
  ck('Sam Test moved out of pending into children too', childrenText.includes('Sam Test'));
  ck('Rejected/removed claim (Nobody Real) is gone entirely, not lingering', !((await page.locator('body').innerText()).includes('Nobody Real')));

  // --- Request a session for the now-verified child ---
  await page.click('.parent-nav [data-nav="parent-sessions"]');
  await page.waitForSelector('[data-action="parent-find-session"]', { timeout: 8000 });
  await page.click('[data-action="parent-find-session"]');
  await page.waitForSelector('#request-session-select');
  await page.selectOption('#request-session-select', { index: 1 });
  await page.click('[data-action="submit-session-request"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  ck('Session request for a verified child is accepted', server.sessionRequests.length === 1 && server.sessionRequests[0].playerId === 'plyr1');

  // --- Phase 2 hardening: server-side duplicate/role checks, bypassing the
  // UI entirely (raw requests against the mock's own local port) - these
  // prove the backend itself rejects the bad request, not just that the
  // frontend never offers a way to send one.
  const parentToken = 'tok-parent1@test.com~parent';
  async function callParentHub(path, method, token, body) {
    const res = await fetch(`http://localhost:${PORT}/parent-hub${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // --- Duplicate parent claim rejected server-side ---
  let res = await callParentHub('/claims', 'POST', parentToken, { player_name: 'Alfie Test', date_of_birth: '2015-05-10', relationship: 'Parent' });
  ck('Duplicate claim for an already-claimed child is rejected (400, clear message)', res.status === 400 && /already submitted a claim/i.test(res.body.error || ''), JSON.stringify(res.body));
  ck('Duplicate claim does not create a second link for that child', server.links.filter(l => l.parentEmail === 'parent1@test.com' && l.playerId === 'plyr1').length === 1);

  // --- Duplicate pending session request rejected server-side ---
  res = await callParentHub('/session-requests', 'POST', parentToken, { player_record_id: 'plyr1', session_record_id: 'sess2' });
  ck('Duplicate pending session request is rejected (400, clear message)', res.status === 400 && /already pending/i.test(res.body.error || ''), JSON.stringify(res.body));
  ck('Duplicate pending request does not create a second request row', server.sessionRequests.filter(r => r.playerId === 'plyr1' && r.sessionId === 'sess2').length === 1);

  // --- Requesting a session the child is already actively linked to is rejected ---
  server.sessionLinks.push({ playerId: 'plyr1', sessionId: 'sess1', status: 'Active' });
  res = await callParentHub('/session-requests', 'POST', parentToken, { player_record_id: 'plyr1', session_record_id: 'sess1' });
  ck('Requesting a session the child is already actively linked to is rejected (400, clear message)', res.status === 400 && /already linked/i.test(res.body.error || ''), JSON.stringify(res.body));

  // --- Non-parent accounts are blocked from every parent-only route, server-side ---
  const mgmtToken = 'tok-mgmt1@test.com';
  res = await callParentHub('/me', 'GET', mgmtToken);
  ck('A management account cannot call the parent-only /me route (403)', res.status === 403);
  res = await callParentHub('/claims', 'POST', mgmtToken, { player_name: 'X', date_of_birth: '2020-01-01' });
  ck('A management account cannot submit a parent claim (403)', res.status === 403);
  res = await callParentHub('/session-requests', 'POST', mgmtToken, { player_record_id: 'plyr1', session_record_id: 'sess2' });
  ck('A management account cannot submit a parent session request (403)', res.status === 403);
  const coachToken = 'tok-coach-someone@test.com';
  res = await callParentHub('/me', 'GET', coachToken);
  ck('A plain coach account cannot call the parent-only /me route either (403)', res.status === 403);

  // --- The read model reports active sessions and pending request status correctly ---
  res = await callParentHub('/me', 'GET', parentToken);
  const alfie = (res.body.children || []).find(c => c.name === 'Alfie Test');
  ck('Active sessions are returned on the child', !!alfie && alfie.active_sessions.some(s => s.session_record_id === 'sess1'));
  ck('Pending request status is returned on the child', !!alfie && alfie.pending_requests.some(s => s.session_record_id === 'sess2'));

  // --- Full second parent: request-sheet UI correctly excludes an active
  // session, marks a pending one as unavailable, and still offers a third,
  // genuinely eligible session for submission.
  await logOut(page);
  await signUp(page, 'parent2@test.com', 'parent');
  await page.click('[data-action="open-claim-child"]');
  await page.waitForSelector('#claim-name');
  await page.fill('#claim-name', 'Bea Test');
  await page.fill('#claim-dob', '2016-02-20');
  await page.click('[data-action="submit-claim"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);

  await logOut(page);
  await signIn(page, 'mgmt1@test.com');
  await page.click('.icon-btn[data-action="open-more"]');
  await page.click('[data-nav="parent-claims"]');
  await page.waitForSelector('.request-row', { timeout: 8000 });
  await page.locator('.request-row').filter({ has: page.locator('b', { hasText: 'Bea Test' }) }).locator('[data-action="approve-parent-claim"]').click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);

  // Seed active/pending state directly (same effect as real prior activity)
  // before parent2 ever loads their hub for the first time.
  server.sessionLinks.push({ playerId: 'plyr2', sessionId: 'sess1', status: 'Active' });
  server.sessionRequests.push({ id: 'seed1', playerId: 'plyr2', sessionId: 'sess2', parentEmail: 'parent2@test.com', status: 'Pending' });

  await logOut(page);
  await page.click('[data-action="show-signin"]');
  await page.waitForSelector('.auth-card');
  await page.fill('#auth-email', 'parent2@test.com');
  await page.fill('#auth-password', 'password123');
  await page.click('[data-action="auth-submit"]');
  await page.waitForSelector('.ph-hero', { timeout: 8000 });
  // Session requests now start from the Sessions tab's "Find Another
  // Session", rather than a per-child button on the old flat hub screen.
  await page.click('.parent-nav [data-nav="parent-sessions"]');
  await page.waitForSelector('[data-action="parent-find-session"]', { timeout: 8000 });
  await page.click('[data-action="parent-find-session"]');
  await page.waitForSelector('.calendar-sheet');
  const sheetHtml = await page.locator('#sheet-content').innerHTML();
  ck('Active session (U9/10 Development) is not offered as an option at all', !sheetHtml.includes('U9/10 Development'));
  const pendingOption = page.locator('#request-session-select option[value="sess2"]');
  ck('Pending session (U11/12 Academy) is shown but disabled, clearly labelled', (await pendingOption.getAttribute('disabled')) !== null && (await pendingOption.textContent()).includes('already requested'));
  const eligibleOption = page.locator('#request-session-select option[value="sess3"]');
  ck('The genuinely eligible third session is still offered, not disabled', await eligibleOption.count() === 1 && (await eligibleOption.getAttribute('disabled')) === null);
  await page.selectOption('#request-session-select', 'sess3');
  await page.click('[data-action="submit-session-request"]');
  await page.waitForSelector('#toast:not([hidden])');
  await page.waitForTimeout(400);
  ck('Submitting the eligible session succeeds', server.sessionRequests.some(r => r.playerId === 'plyr2' && r.sessionId === 'sess3'));

  ck('No console/page errors the whole way through', errs.length === 0, errs.join(' | '));
  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close();
  process.exit(process.exitCode || 0);
})();
