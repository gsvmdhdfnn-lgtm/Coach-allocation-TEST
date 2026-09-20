const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock-sessions.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });

  // --- Scenario 1: My Players grouped by session, with tier badges (coach view) ---
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page');
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'coach-tom@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });

    await p.click('[data-nav="players"]');
    await p.waitForSelector('.player-session-group', { timeout: 5000 });
    const heads = await p.$$eval('.player-session-name', els => els.map(e => e.textContent));
    ck('Three session groups shown, sorted by name', JSON.stringify(heads) === JSON.stringify(['Monday Academy', 'Not yet linked to a session', 'Thursday U9/10'].sort()), heads.join(', '));

    // Expand Monday Academy - should show its 3 players (permanent x2, former x1)
    await p.click('.player-session-head:has-text("Monday Academy")');
    await p.waitForSelector('.player-session-group:has-text("Monday Academy") .player-row', { timeout: 5000 });
    const mondayPlayers = await p.$$eval('.player-session-group:has-text("Monday Academy") .player-row b', els => els.map(e => e.textContent));
    ck('Monday Academy expands to show its 3 players', mondayPlayers.length === 3 && mondayPlayers.includes('Archie Smith') && mondayPlayers.includes('Bella Jones') && mondayPlayers.includes('Ella Frost'), mondayPlayers.join(', '));

    const formerBadge = await p.$eval('.player-session-group:has-text("Monday Academy") .player-row:has-text("Ella Frost") .player-tier', el => el.textContent);
    ck('Former-tier player shows a Former badge with the access-until date', /Former coach/.test(formerBadge) && /2026-10-08/.test(formerBadge), formerBadge);

    const noEndButtonForCoach = await p.$('.player-session-group:has-text("Monday Academy") .end-membership-btn');
    ck('A plain coach never sees an End button (management-only action)', noEndButtonForCoach === null);

    // Collapse it again
    await p.click('.player-session-head:has-text("Monday Academy")');
    await p.waitForTimeout(150);
    const mondayCollapsed = await p.$$('.player-session-group:has-text("Monday Academy") .player-row');
    ck('Collapsing Monday Academy hides its players again', mondayCollapsed.length === 0);

    // Expand Thursday U9/10 - cover tier badge
    await p.click('.player-session-head:has-text("Thursday U9/10")');
    await p.waitForSelector('.player-session-group:has-text("Thursday U9/10") .player-row', { timeout: 5000 });
    const coverBadge = await p.$eval('.player-session-group:has-text("Thursday U9/10") .player-tier', el => el.textContent);
    ck('Cover-tier player shows a Cover badge', coverBadge === 'Cover', coverBadge);

    ck('no console/page errors (my players)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 2: management - session requests (amend+approve, reject), and ending a membership ---
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page');
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'mgmt@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });

    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-row:has-text("Session Requests")', { timeout: 5000 });
    await p.click('.more-row:has-text("Session Requests")');
    await p.waitForSelector('.request-row', { timeout: 5000 });

    const names = await p.$$eval('.request-row b', els => els.map(e => e.textContent));
    ck('Both pending requests are listed', names.length === 2 && names.includes('Archie Smith') && names.includes('Bella Jones'), names.join(', '));

    const options = await p.$eval('.request-row .request-session-select', el => el.options.length);
    ck('Session dropdown is populated with active sessions', options === 3, String(options));

    // Amend req1 (originally requested "Monday Academy" = sess1) to "Thursday U9/10" = sess3, then approve
    await p.selectOption('[data-request-row="req1"] .request-session-select', 'sess3');
    await p.click('[data-request-row="req1"] [data-action="approve-session-request"]');
    await p.waitForFunction(() => !document.querySelector('[data-request-row="req1"]'), { timeout: 5000 });
    const approveBody = server.lastApproveBody();
    ck('Amending the session before Approve sends the amended session, not the original request', approveBody && approveBody.session_record_id === 'sess3', JSON.stringify(approveBody));
    const toastText = await p.$eval('#toast', el => el.textContent);
    ck('Confirmation toast shown on approve', toastText === 'Session request approved', toastText);

    // Reject Bella's request, unamended
    await p.click('[data-request-row="req2"] [data-action="reject-session-request"]');
    await p.waitForFunction(() => !document.querySelector('[data-request-row="req2"]'), { timeout: 5000 });
    ck('Rejecting a request removes its row too', true);

    const empty = await p.$eval('#session-requests-list', el => el.textContent);
    ck('Empty state shows once both are handled', /No session requests waiting/.test(empty), empty);

    // Sync Sessions button
    await p.click('[data-action="sync-sessions"]');
    await p.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Synced'), { timeout: 5000 });
    const syncToast = await p.$eval('#toast', el => el.textContent);
    ck('Manual Sync Sessions button reports created/updated/archived counts', /Synced.*1 new.*2 updated.*0 archived/.test(syncToast), syncToast);

    // Management sees the admin-tier player with an End button in My Players
    await p.click('[data-nav="players"]');
    await p.waitForSelector('.player-session-group', { timeout: 5000 });
    await p.click('.player-session-head:has-text("Monday Academy")');
    await p.waitForSelector('.end-membership-btn', { timeout: 5000 });
    const adminBadgeAbsent = await p.$('.player-session-group:has-text("Monday Academy") .player-tier');
    ck('Admin tier shows no Cover/Former badge (management just sees the player)', adminBadgeAbsent === null);
    p.once('dialog', d => d.accept()); // endPlayerSession() guards with a native confirm() - accept it for this test
    await p.click('.end-membership-btn');
    await p.waitForTimeout(200);
    ck('Ending a membership calls the end-link endpoint for the right link', server.endedLinkIds().includes('link1'), JSON.stringify(server.endedLinkIds()));

    ck('no console/page errors (session requests + end membership)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 3: a plain coach never sees management-only hamburger rows ---
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page');
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'coach-jane@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-list', { timeout: 5000 });
    const hasSessionRequests = await p.$('.more-row:has-text("Session Requests")');
    const hasMigration = await p.$('.more-row:has-text("Player Migration")');
    ck('A plain coach does not see Session Requests in the hamburger menu', hasSessionRequests === null);
    ck('A plain coach does not see Player Migration in the hamburger menu', hasMigration === null);
    ck('no console/page errors (plain coach)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 4: Player Migration preview - matched/ambiguous/unmatched, commit only what's confirmed ---
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
    await p.waitForSelector('.public-page');
    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card');
    await p.fill('#auth-email', 'mgmt2@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });

    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-row:has-text("Player Migration")', { timeout: 5000 });
    await p.click('.more-row:has-text("Player Migration")');
    await p.waitForSelector('.migration-row', { timeout: 5000 });

    const matchedChecked = await p.$eval('.migration-row:has-text("Freya Todd") .migration-check', el => el.checked);
    ck('A matched player comes pre-checked, ready to commit', matchedChecked === true);

    const ambiguousChecked = await p.$eval('.migration-row:has-text("George Vance") .migration-check', el => el.checked);
    ck('An ambiguous player is NOT pre-checked - needs a human decision first', ambiguousChecked === false);

    const ambiguousOptions = await p.$eval('.migration-row:has-text("George Vance") .migration-select', el => el.options.length);
    ck('The ambiguous player has both candidate sessions to pick from', ambiguousOptions === 2, String(ambiguousOptions));

    const unmatchedText = await p.$eval('.migration-row-unmatched:has-text("Hana Wills")', el => el.textContent);
    ck('An unmatched player shows the reason, with no checkbox to act on', /No session name resembles/.test(unmatchedText), unmatchedText);
    const unmatchedHasCheckbox = await p.$('.migration-row-unmatched:has-text("Hana Wills") input[type=checkbox]');
    ck('Unmatched row has no checkbox at all', unmatchedHasCheckbox === null);

    // Commit with only the matched row checked (default state) - unmatched/ambiguous must NOT be committed
    await p.click('[data-action="migrate-commit"]');
    await p.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('linked'), { timeout: 5000 });
    let committedBody = server.lastMigrationCommitBody();
    ck('Committing with only the matched row checked commits exactly that one pair', committedBody && committedBody.links.length === 1 && committedBody.links[0].player_record_id === 'p10' && committedBody.links[0].session_record_id === 'sess1', JSON.stringify(committedBody));

    // Now also tick the ambiguous row after picking a candidate, and commit again
    await p.check('.migration-row:has-text("George Vance") .migration-check');
    await p.selectOption('.migration-row:has-text("George Vance") .migration-select', 'sess4');
    await p.click('[data-action="migrate-commit"]');
    await p.waitForTimeout(200);
    committedBody = server.lastMigrationCommitBody();
    ck('Ticking the ambiguous row after picking a candidate includes it in the next commit', committedBody && committedBody.links.some(l => l.player_record_id === 'p11' && l.session_record_id === 'sess4'), JSON.stringify(committedBody));

    ck('no console/page errors (player migration)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
