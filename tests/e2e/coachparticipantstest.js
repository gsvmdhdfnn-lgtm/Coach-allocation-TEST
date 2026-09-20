const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };
const PORT = 8211;

const TODAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
// Wide, always-"in progress" time ranges so this test is deterministic
// regardless of the wall-clock time it happens to run at - every row is
// always both "today" and the coach's next occurrence candidate. No
// `participants` column here on purpose - that field lives in Financials
// now, not Sessions, and reaches the Coach Hub only via the separate
// session-participants read model mocked below.
const SESSIONS_CSV = `session_id,session_name,programme,category,age_group,day,time,venue,address,coaches,client,hours
E01,Fourteen Player Session,Evening,Development Centre,U9/10,${TODAY},00:01 - 23:58,Test Venue,Test Address,Tom,,1
E02,Zero Player Session,Evening,Development Centre,U9/10,${TODAY},00:01 - 23:57,Test Venue,Test Address,Tom,,1
E03,Blank Player Session,Evening,Development Centre,U9/10,${TODAY},00:01 - 23:56,Test Venue,Test Address,Tom,,1
`;
// The safe, field-limited read model: session_id + participants only -
// E02 is deliberately 0 and E03 is deliberately absent, to prove both
// render nothing. No revenue/cost/profit fields exist here at all.
const SESSION_PARTICIPANTS = [
  { session_id: 'E01', participants: 14 },
  { session_id: 'E02', participants: 0 },
];

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.png': 'image/png' };

function makeServer() {
  const OVERRIDES = {
    '/config.js': path.join(FIXTURES_DIR, 'config.test.js'),
  };
  return http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/data/Sessions.csv') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end(SESSIONS_CSV); }
    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/hub-content/resources') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([{ resource_id: 'RES-1', title: 'Example Resource', category: 'Session Plans', description: '', thumbnail_url: '', attachment_url: 'https://example.com/plan.pdf', video_url: '', external_link: '', audience: [] }])); }
    if (u === '/hub-content/venues') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([{ venue_id: 'VEN-1', name: 'Test Venue', address: 'Test Address', postcode: '', parking: 'Park on-site.', meeting_point: 'By reception.', access: '', notes: '' }])); }
    if (u === '/hub-content/coach-support') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([{ support_id: 'SUP-1', title: 'Example Support Item', section: 'Our Standards', body: 'Body text.', attachment_url: '', external_link: '' }])); }
    if (u === '/hub-content/public-pages') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([])); }
    if (u === '/hub-content/what-we-offer') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify([])); }
    if (u === '/hub-content/session-participants') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(SESSION_PARTICIPANTS)); }
    if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' }, settings: {}, features: {} })); }
    if (u === '/me') {
      const auth = q.headers['authorization'] || '';
      const email = auth.replace(/^Bearer /, '').replace(/^tok-/, '').replace(/~.*/, '');
      if (!email) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify({ user_id: 'uid-' + email, email: email, organisation_id: 'ORG-JOSHEVANS', role: 'coach', status: 'active', airtable_person_id: null, display_name: 'Tom' }));
    }
    const decoded = decodeURIComponent(u === '/' ? '/index.html' : u);
    const filePath = OVERRIDES[decoded] || path.join(ROOT, decoded);
    fs.readFile(filePath, (err, body) => {
      if (err) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'text/plain' });
      r.end(body);
    });
  });
}

async function signIn(p) {
  await p.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.public-page', { timeout: 8000 });
  await p.click('[data-action="show-signup"]');
  await p.waitForSelector('.auth-card', { timeout: 8000 });
  await p.fill('#auth-email', 'coach-tom@test.com');
  await p.fill('#auth-password', 'password123');
  await p.click('[data-action="auth-submit"]');
  await p.waitForSelector('.coach-home', { timeout: 8000 });
}

(async () => {
  const server = makeServer();
  await new Promise((res) => server.listen(PORT, res));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ path: path.join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));

  await signIn(page);

  // --- Coach Home: Next Session ---
  ck('Next Session card shows the highest-priority session (E01) with a participant count', (await page.locator('.next-home-card h1').textContent()) === 'Fourteen Player Session');
  const nextMetaText = await page.locator('.next-home-card .home-meta').allTextContents();
  ck('Next Session card shows "14 players" when participants is present', nextMetaText.some((t) => t.includes('14 players')), JSON.stringify(nextMetaText));
  ck('Next Session card has no editable field for participants (read-only)', await page.locator('.next-home-card input, .next-home-card select').count() === 0);

  // --- Coach Home: Today list ---
  const todayRows = page.locator('.today-home-row');
  ck('All 3 of today\'s sessions render in the Today list', await todayRows.count() === 3, await todayRows.count());
  const todayText = await todayRows.allTextContents();
  ck('Today row shows "14 players" for the session with participants=14', todayText.some((t) => t.includes('14 players')), JSON.stringify(todayText));
  ck('Today row shows nothing extra for participants=0 (no "0 players")', !todayText.some((t) => /\b0 players\b/.test(t)));
  ck('Today row shows nothing extra for a blank participants value', todayText.filter((t) => t.includes('Blank Player Session') && /\d+ players?/.test(t)).length === 0, JSON.stringify(todayText));

  // --- Schedule: Today view ---
  await page.click('[data-nav="schedule"]');
  await page.waitForSelector('.coach-schedule');
  const scheduleCards = page.locator('.schedule-session');
  ck('Schedule (Today view) shows all 3 sessions', await scheduleCards.count() === 3, await scheduleCards.count());
  const scheduleText = await scheduleCards.allTextContents();
  ck('Schedule card shows "14 players" for the session with participants=14', scheduleText.some((t) => t.includes('14 players')), JSON.stringify(scheduleText));
  ck('Schedule cards show no "0 players" anywhere', !scheduleText.some((t) => /\b0 players\b/.test(t)));
  ck('No horizontal overflow on Schedule at 390px', await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);

  // --- Session Detail ---
  await page.click('.schedule-session:has-text("Fourteen Player Session")');
  await page.waitForSelector('.session-detail-wrap');
  const detailRows = await page.locator('.session-info-card .detail-row').allTextContents();
  ck('Session Detail shows a "Players" row with the count when present', detailRows.some((t) => /Players/.test(t) && t.includes('14 players')), JSON.stringify(detailRows));
  ck('Session Detail has no editable field for participants (read-only)', await page.locator('.session-info-card input, .session-info-card select').count() === 0);

  await page.click('[data-action="app-back"]');
  await page.waitForSelector('.coach-schedule');
  await page.click('.schedule-session:has-text("Blank Player Session")');
  await page.waitForSelector('.session-detail-wrap');
  const blankDetailRows = await page.locator('.session-info-card .detail-row').allTextContents();
  ck('Session Detail shows no "Players" row at all when participants is blank', !blankDetailRows.some((t) => /Players/.test(t)), JSON.stringify(blankDetailRows));

  // --- Changes fail-visible behaviour preserved (still exercised end-to-end here) ---
  ck('No Changes warning banner when Changes loads fine', await page.locator('.data-warning').count() === 0);

  // --- Player Hub, Resources, Venues, Coach Support still load ---
  await page.click('[data-nav="players"]');
  await page.waitForSelector('.page-title h1');
  ck('Player Hub (My Players) still loads', (await page.locator('.page-title h1').textContent()) === 'My Players');

  await page.click('[data-nav="resources"]');
  await page.waitForSelector('.resource-grid');
  ck('Resources still loads real content-provider data', await page.locator('.resource-card').count() === 1);

  await page.click('[data-nav="home"]');
  await page.waitForSelector('.coach-home');
  await page.click('.home-shortcuts button:has-text("Venues")');
  await page.waitForSelector('.venues-page');
  ck('Venues still loads real content-provider data', await page.locator('.venue-card').count() === 1);
  await page.click('.venue-card');
  await page.waitForSelector('.venue-detail-wrap');
  ck('Venue detail still shows parking/meeting point info', /Park on-site/.test(await page.locator('.venue-overview-card').textContent()));

  await page.click('[data-action="app-back"]');
  await page.waitForSelector('.venues-page');
  await page.click('[data-nav="home"]');
  await page.waitForSelector('.coach-home');
  await page.click('.home-shortcuts button:has-text("Coach Support")');
  await page.waitForSelector('.resource-grid');
  ck('Coach Support still loads real content-provider data', await page.locator('.resource-card').count() === 1);

  // --- Responsive: tablet/desktop, no overflow ---
  for (const w of [768, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(120);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ck(`No horizontal overflow at ${w}px`, overflow <= 1, 'overflow=' + overflow);
  }

  ck('No console/page errors', errs.length === 0, errs.join(' | '));

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);

  await b.close();
  server.close();
  process.exit(process.exitCode || 0);
})();
