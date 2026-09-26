// A failed players read used to be swallowed into an empty list, so a
// connection or permission problem rendered as "No players yet" - the one
// empty state a coach would believe. These scenarios cover the three cases
// the Player Hub now has to tell apart: the read failed, the read
// succeeded with nothing, and the read succeeded with players.
const { chromium } = require('playwright');
const path = require('path');
process.env.SP_SERVE = path.join(__dirname, '..', '..');
const server = require('../support/hub-content-mock-playerserror.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

const STUB = path.join(__dirname, '..', 'support', 'auth-stub.js');

async function signInAsCoach(b, errs) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', route => route.fulfill({ path: STUB, contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page');
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card');
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.coach-home, .hero', { timeout: 8000 });
  return { ctx, p };
}

const openPlayerHub = async (p) => { await p.click('[data-nav="players"]'); await p.waitForSelector('.page-title h1'); };

// Reads a selector's text without hanging when it is missing - a
// regression here should report a readable FAIL, not abort the whole file
// on a 30s locator timeout and lose every result with it.
const textOf = async (p, sel) => p.$eval(sel, el => el.innerText).catch(() => '');
const seen = async (p, sel, ms) => !!(await p.waitForSelector(sel, { timeout: ms || 8000 }).catch(() => null));
// A guarded click still waits Playwright's full 30s default before
// throwing, so a regression would hang the file rather than fail it -
// these attempts are short on purpose.
const tryClick = (p, sel) => p.click(sel, { timeout: 3000 }).catch(() => {});

(async () => {
  const srv = await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });

  // --- Scenario 1: the players read fails ---
  {
    server.setPlayersMode('fail');
    const errs = [];
    const { ctx, p } = await signInAsCoach(b, errs);
    // The rest of the Hub must still load - only the players pane failed.
    ck('A players failure does not stop the rest of the Hub loading', await p.$('.coach-home, .hero') !== null);
    await openPlayerHub(p);

    const paneText = await p.locator('#app').innerText();
    ck('A failed players read does NOT show "No players yet"', !/No players yet/i.test(paneText), paneText.slice(0, 160));
    ck('It shows a clear error instead', await seen(p, '.players-error'));
    const errText = await textOf(p, '.players-error');
    ck('The error names what failed', /Couldn’t load your players/i.test(errText), errText);
    ck('The error does not leak the raw server reason', errText !== '' && !/429|Airtable|rate limited|500/i.test(errText), errText);
    ck('A Try again button is offered', await p.locator('[data-action="retry-players"]').count() === 1);
    ck('No player rows are shown while the read is failing', await p.locator('.player-session-group').count() === 0);
    ck('The Drafts shortcut still works during a players failure', await p.locator('[data-nav="feedback-drafts"]').count() === 1);
    ck('Other tabs still work during a players failure', (await p.click('[data-nav="schedule"]'), await p.waitForSelector('.page-title, .sched-head', { timeout: 5000 }), true));
    ck('no page errors (failure case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 2: retry after the server recovers ---
  {
    server.setPlayersMode('fail');
    const errs = [];
    const { ctx, p } = await signInAsCoach(b, errs);
    await openPlayerHub(p);
    ck('The failure state is reached before retrying', await seen(p, '.players-error'));

    const before = server.playersCalls();
    server.setPlayersMode('ok');
    // Every step is guarded so a regression reports readable FAILs rather
    // than aborting the file on a 30s locator timeout and losing them all.
    await tryClick(p, '[data-action="retry-players"]');
    ck('A successful retry renders the player list', await seen(p, '.player-session-group'));
    ck('Retry re-requests the players list', server.playersCalls() > before, `${before} -> ${server.playersCalls()}`);
    ck('A successful retry clears the error', await p.$('.players-error') === null);
    await tryClick(p, '.player-session-head');
    await seen(p, '.player-row');
    const names = await p.$$eval('.player-row', els => els.map(e => e.innerText)).catch(() => []);
    ck('All three players render after the retry', names.length === 3, String(names.length));
    ck('The former-tier badge still renders after a retry', await p.locator('.player-row:has-text("Ella Frost") .player-tier.is-former').count() === 1);

    // The server's own permission flags must survive the retry path -
    // Player Profile reads can_edit_feedback straight off the row that the
    // retry re-fetched, so drilling in is what actually proves it.
    await tryClick(p, '.player-row:has-text("Ella Frost")');
    await seen(p, '.pf-hero');
    ck('A former-tier player is still read-only after a retry', await p.locator('.pf-add[disabled]').count() === 1);
    ck('...and still shows the FORMER status pill', (await textOf(p, '.pf-status')).trim() === 'FORMER', await textOf(p, '.pf-status'));
    await tryClick(p, '[data-action="app-back"]');
    await seen(p, '.player-row');
    await tryClick(p, '.player-row:has-text("Archie Smith")');
    await seen(p, '.pf-hero');
    ck('A permanent-tier player can still add feedback after a retry', await p.locator('.pf-add:not([disabled])').count() === 1);
    await tryClick(p, '[data-action="app-back"]');
    await seen(p, '.player-row');
    ck('"No players yet" is not shown once players load', !/No players yet/i.test(await p.locator('#app').innerText()));
    ck('no page errors (recovery case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 3: a retry that fails again ---
  {
    server.setPlayersMode('fail');
    const errs = [];
    const { ctx, p } = await signInAsCoach(b, errs);
    await openPlayerHub(p);
    ck('The failure state is reached before retrying again', await seen(p, '.players-error'));
    await tryClick(p, '[data-action="retry-players"]');
    // Wait for the button to come back after the re-render, not just exist.
    await p.waitForFunction(() => {
      const btn = document.querySelector('[data-action="retry-players"]');
      return btn && !btn.disabled;
    }, { timeout: 8000 }).catch(() => {});

    ck('A retry that fails again keeps showing the error', await p.$('.players-error') !== null);
    ck('...and never falls back to "No players yet"', !/No players yet/i.test(await p.locator('#app').innerText()));
    ck('...and leaves Try again usable for another attempt', await p.locator('[data-action="retry-players"]:not([disabled])').count() === 1);
    ck('no page errors (repeat-failure case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 4: a genuine empty list ---
  {
    server.setPlayersMode('empty');
    const errs = [];
    const { ctx, p } = await signInAsCoach(b, errs);
    await openPlayerHub(p);

    ck('A genuinely empty list shows "No players yet"', /No players yet/i.test(await p.locator('#app').innerText()));
    ck('...via the normal empty state, not an error', await p.$('.empty-state') !== null && await p.$('.players-error') === null);
    ck('...with no Try again button', await p.locator('[data-action="retry-players"]').count() === 0);
    ck('no page errors (genuine empty case)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);
  await b.close(); srv.close();
  process.exit(process.exitCode || 0);
})();
