const { chromium } = require('playwright');
process.env.SP_SERVE = require('path').join(__dirname, '..', '..');
const server = require('../support/hub-content-mock.js');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

async function gotoPublic(p) {
  await p.goto('http://localhost:8211/index.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page', { timeout: 8000 });
}
async function gotoSignIn(p) {
  await gotoPublic(p);
  await p.click('[data-action="show-signin"]');
  await p.waitForSelector('.auth-card', { timeout: 8000 });
}
async function gotoRegister(p) {
  await gotoPublic(p);
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card', { timeout: 8000 });
}

(async () => {
  await server.start(8211);
  const b = await chromium.launch({ args: ['--no-sandbox'] });

  // --- Scenario 0: public home is the default landing page, no login needed ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await gotoPublic(p);
    ck('Public home is the default screen, not the login form', (await p.$('.auth-card')) === null);
    ck('Bottom nav and profile icon are hidden on the public page', !(await p.isVisible('.main-nav')) && !(await p.isVisible('.top-actions')));
    const heroText = await p.$eval('.public-hero', n => n.textContent);
    ck('Shows the org hub name and tagline', /Josh Evans Hub/.test(heroText) && /Better people make better players/.test(heroText), heroText);
    const pageText = await p.$eval('.public-page', n => n.textContent);
    ck('Shows real Public Pages content grouped by category (Trials/Academy/General)', /Jets Trials/.test(pageText) && /Academy Programme/.test(pageText) && /Welcome to Josh Evans/.test(pageText), pageText.slice(0, 300));
    ck('Has both Sign In and Register buttons', await p.isVisible('[data-action="show-signin"]') && await p.isVisible('[data-action="show-signup"]'));

    await p.click('.brand-lockup');
    await p.waitForTimeout(150);
    ck('Tapping the logo on the public page does not do anything unexpected (still public)', (await p.$('.public-page')) !== null);

    await p.click('[data-action="show-signin"]');
    await p.waitForSelector('.auth-card', { timeout: 8000 });
    ck('Sign In button opens the login form', await p.$eval('.auth-card h1', n => n.textContent) === 'Sign in');
    await p.click('[data-action="show-public"]');
    await p.waitForSelector('.public-page', { timeout: 8000 });
    ck('"Back to Josh Evans Soccer School" returns to the public page from login', true);

    await p.click('[data-action="show-signup"]');
    await p.waitForSelector('.auth-card', { timeout: 8000 });
    ck('Register button opens the signup form directly', await p.$eval('.auth-card h1', n => n.textContent) === 'Create your account');
    ck('no console/page errors (public home)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 1: sign up a pending user (no confirmation required) ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await gotoSignIn(p);
    ck('Bottom nav and profile icon are hidden while logged out', !(await p.isVisible('.main-nav')) && !(await p.isVisible('.top-actions')));
    await p.click('.brand-lockup');
    await p.waitForTimeout(150);
    ck('Tapping the logo while logged out does not bypass the login screen', await p.$eval('.auth-card h1', n => n.textContent) === 'Sign in');
    await p.click('[data-action="auth-switch"]');
    ck('Switches to signup screen', await p.$eval('.auth-card h1', n => n.textContent) === 'Create your account');
    await p.fill('#auth-email', 'pending@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForFunction(() => document.querySelector('.auth-card h1')?.textContent === 'Waiting for approval', { timeout: 8000 });
    ck('New signup with no display_name/role yet shows waiting-for-approval screen', true);
    ck('no console/page errors (signup)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 1b: parent signup skips the pending queue; staff signup defaults to needing approval ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await gotoRegister(p);
    ck('Account type picker defaults to Coach/Management', await p.$eval('[data-action="auth-account-type"][data-type="staff"]', n => n.className.includes('is-active')));
    ck('Default note warns staff accounts need approval', /need to be approved/.test(await p.$eval('.auth-note', n => n.textContent)));
    await p.click('[data-action="auth-account-type"][data-type="parent"]');
    ck('Selecting Parent updates the active pill', await p.$eval('[data-action="auth-account-type"][data-type="parent"]', n => n.className.includes('is-active')));
    ck('Parent note says accounts get in straight away', /straight away/.test(await p.$eval('.auth-note', n => n.textContent)));
    await p.fill('#auth-email', 'parent-jane@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.page-title', { timeout: 8000 });
    ck('signUp was called with account_type: parent', await p.evaluate(() => window.__lastSignUpAccountType) === 'parent');
    ck('Parent signup lands straight in on the real Parent Hub (no waiting-for-approval screen, no generic role placeholder)', await p.locator('.parent-children-list').count() === 1);
    ck('no console/page errors (parent signup)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 2: wrong password on login shows an error, not a crash ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await gotoSignIn(p);
    await p.fill('#auth-email', 'nobody@test.com');
    await p.fill('#auth-password', 'wrong');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.auth-error', { timeout: 8000 });
    ck('Invalid credentials shows an inline error, stays on login', /Invalid login credentials/.test(await p.$eval('.auth-error', n => n.textContent)));
    ck('no console/page errors (bad login)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 3: approved coach signs in, sees real hub, then logs out ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await gotoRegister(p);
    await p.fill('#auth-email', 'coach-tom@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    ck('Approved coach with display_name lands on the real coach home', true);
    ck('Bottom nav and profile icon reappear once signed in', await p.isVisible('.main-nav') && await p.isVisible('.top-actions'));

    await p.click('[data-nav="schedule"]');
    await p.waitForSelector('.schedule-tabs', { timeout: 8000 });
    await p.click('[data-action="schedule-view"][data-view="week"]');
    await p.waitForSelector('.week-stack', { timeout: 8000 });
    await p.click('.week-day-head:has-text("Monday")');
    await p.waitForSelector('.week-day-list', { timeout: 8000 });
    const bodyText = await p.$eval('.week-stack', n => n.textContent);
    ck('Schedule reflects the display_name-matched Sessions.csv row (E01/Tom)', /U9\/10 Development/.test(bodyText), bodyText.slice(0, 200));

    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-list', { timeout: 8000 });
    ck('My Profile row shows the signed-in email', (await p.$eval('.more-list', n => n.textContent)).includes('coach-tom@test.com'));

    await p.click('.more-row:has-text("My Profile")');
    await p.waitForSelector('#sheet:not([hidden])', { timeout: 5000 });
    const profileText = await p.$eval('#sheet-content', n => n.textContent);
    ck('My Profile sheet shows name/email/role', /Tom/.test(profileText) && /coach-tom@test\.com/.test(profileText) && /Coach/.test(profileText), profileText);
    await p.click('.sheet-backdrop');
    await p.waitForSelector('#sheet', { state: 'hidden', timeout: 5000 });

    await p.click('[data-action="open-more"]');
    await p.waitForSelector('.more-row:has-text("Feedback")', { timeout: 5000 });
    await p.click('.more-row:has-text("Feedback")');
    await p.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
    ck('Feedback row gives a "Coming soon" toast instead of doing nothing', (await p.$eval('#toast', n => n.textContent)) === 'Coming soon');

    await p.click('.more-row:has-text("Log Out")');
    await p.waitForSelector('.public-page', { timeout: 8000 });
    ck('Logging out returns to the public home page, not a bare login form', true);
    ck('no console/page errors (coach flow)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 4: coach approved but display_name not yet set by admin -
  //     should not crash, should just show zero "mine" sessions ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await gotoRegister(p);
    await p.fill('#auth-email', 'coach-noname@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForSelector('.coach-home', { timeout: 8000 });
    ck('Coach with role=coach but no display_name still loads the hub without crashing', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  // --- Scenario 5: the dead-end "check your email" screen now has a way back ---
  {
    const ctx = await b.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.route("**/supabase-js@2/dist/umd/supabase.js", route => route.fulfill({ path: require('path').join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { window.__TEST_REQUIRE_CONFIRM = true; });
    await gotoRegister(p);
    await p.fill('#auth-email', 'confirm-me@test.com');
    await p.fill('#auth-password', 'password123');
    await p.click('[data-action="auth-submit"]');
    await p.waitForFunction(() => document.querySelector('.auth-card h1')?.textContent === 'Check your email', { timeout: 8000 });
    ck('Signup requiring email confirmation shows the check-your-email screen', true);
    ck('Check-your-email screen has a way back to the public page (not a dead end)', await p.isVisible('[data-action="show-public"]'));
    await p.click('[data-action="show-public"]');
    await p.waitForSelector('.public-page', { timeout: 8000 });
    ck('That back link actually returns to the public home', true);
    ck('no console/page errors (email confirmation dead-end fix)', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter(r => r[0] === 'PASS').length}/${R.length} passing`);

  await b.close();
  process.exit(process.exitCode || 0);
})();
