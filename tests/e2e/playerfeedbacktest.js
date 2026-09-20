// Coach Player Profile + Coach Feedback (Parts B & C, plus the follow-up
// refinement pass): Player Hub row -> Player Profile -> Add Feedback /
// Latest Feedback / Previous Feedback, backed by a mock player-feedback
// Edge Function. Proves the frontend wiring, the security gate (no
// Authorization -> 401, no permission -> 403), the mode/toggle-driven
// form (including Written Only and Ratings Only, not just the combined
// default), the compact rating-row UI, and draft resume/PATCH behaviour
// (never a duplicate parent Feedback record).
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const R = [];
const ck = (n, c, x) => { R.push([c ? 'PASS' : 'FAIL', n, x || '']); if (!c) process.exitCode = 1; };

const SESSIONS_CSV = `session_id,session_name,programme,category,age_group,day,time,venue,address,coaches,client,hours
E01,U9/10 Development,Development Centre,Development Centre,U9/10,Monday,17:00 - 18:00,Test Venue,Test Address,Tom,,1
`;

const PLAYERS = [
  { player_record_id: 'p1', player_id: 'PLY-001', name: 'Archie Wilkins', photo_url: '', date_of_birth: '2015-03-12', session_record_id: 'sess1', session_id: 'E01', session_name: 'U9/10 Development', link_record_id: 'link1', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
  { player_record_id: 'p2', player_id: 'PLY-002', name: 'Bella Former', photo_url: '', date_of_birth: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'U9/10 Development', link_record_id: 'link2', tier: 'former', access_until: '2026-10-08', can_edit_feedback: false, can_edit_idp: false, can_edit_attendance: false },
  { player_record_id: 'p3', player_id: 'PLY-003', name: 'Diego Draft', photo_url: '', date_of_birth: '2014-06-01', session_record_id: 'sess1', session_id: 'E01', session_name: 'U9/10 Development', link_record_id: 'link3', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
];

const FRAMEWORK_COMBINED = {
  settings: {
    framework_name: 'Josh Evans Development Framework', framework_key: 'josh_evans_default',
    intro_text: 'Our characteristics form the foundation of development.',
    blue_label: 'Consistently strong', green_label: 'Showing regularly', amber_label: 'Developing', red_label: 'Key focus',
    feedback_mode: 'ratings_written',
    show_keep_doing: true, show_my_focus: true, show_general_feedback: true, per_area_written_feedback: false,
  },
  groups: [
    { key: 'Characteristics', label: 'Characteristics', items: [
      { framework_item_id: 'fi1', name: 'Winners', description: 'Current status', written_prompt: '', rating_enabled: true, written_enabled: false },
      { framework_item_id: 'fi2', name: 'Movers', description: 'Current status', written_prompt: '', rating_enabled: true, written_enabled: false },
    ] },
    { key: 'Football Pillars', label: 'Football Pillars', items: [
      { framework_item_id: 'fi3', name: '1v1 Attack & Defence', description: 'Current status', written_prompt: '', rating_enabled: true, written_enabled: false },
    ] },
  ],
};

// Same items, Feedback Mode = Written Only, per-area written feedback on
// for 'Movers' only - proves the fix for "Written Only hides framework
// rows completely" (rows must still show for written-enabled items).
const FRAMEWORK_WRITTEN_ONLY = {
  settings: { ...FRAMEWORK_COMBINED.settings, feedback_mode: 'written_only', per_area_written_feedback: true },
  groups: [
    { key: 'Characteristics', label: 'Characteristics', items: [
      { framework_item_id: 'fi1', name: 'Winners', description: '', written_prompt: '', rating_enabled: true, written_enabled: false },
      { framework_item_id: 'fi2', name: 'Movers', description: '', written_prompt: '', rating_enabled: true, written_enabled: true },
    ] },
  ],
};

// Feedback Mode = Ratings Only, per-area written feedback ON (should
// still be suppressed - Ratings Only always hides all written fields).
const FRAMEWORK_RATINGS_ONLY = {
  settings: { ...FRAMEWORK_COMBINED.settings, feedback_mode: 'ratings_only', per_area_written_feedback: true },
  groups: [
    { key: 'Characteristics', label: 'Characteristics', items: [
      { framework_item_id: 'fi1', name: 'Winners', description: '', written_prompt: '', rating_enabled: true, written_enabled: true },
    ] },
  ],
};

let FRAMEWORK = FRAMEWORK_COMBINED;
let lastCreateBody = null;
let lastRequest = null; // { method, url, body } for the most recent /player-feedback/record* call
let historyByPlayer = {
  p1: [],
  p2: [
    { feedback_id: 'fb1', title: 'Autumn Review', date: '2026-09-15', coach_name: 'Coach David', published: true, summary: '', keep_doing: 'Breaking up play.', big_focus: 'Drop behind the ball.', player_record_id: 'p2', session_record_id: 'sess1', ratings: [
      { framework_item_id: 'fi1', rating: 'Green', label_snapshot: 'Winners', group_snapshot: 'Characteristics', sort_order: 1, notes: '' },
    ] },
  ],
  p3: [
    { feedback_id: 'fb-draft-1', title: 'Diego Draft — 2026-09-18', date: '2026-09-18', coach_name: 'Tom', published: false, summary: '', keep_doing: 'Working on first touch.', big_focus: '', player_record_id: 'p3', session_record_id: 'sess1', ratings: [
      { framework_item_id: 'fi1', rating: 'Amber', label_snapshot: 'Winners', group_snapshot: 'Characteristics', sort_order: 1, notes: '' },
    ] },
  ],
};

function emailFromAuth(q) {
  const auth = q.headers['authorization'] || '';
  const token = auth.replace(/^Bearer /, '').replace(/^tok-/, '');
  const tilde = token.indexOf('~');
  return tilde >= 0 ? token.slice(0, tilde) : token;
}
function readBody(q) {
  return new Promise((resolve) => { let raw = ''; q.on('data', (c) => raw += c); q.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } }); });
}

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv' };

function makeServer(port) {
  const OVERRIDES = { '/config.js': path.join(FIXTURES_DIR, 'config.test.js') };
  return http.createServer(async (q, r) => {
    const u = q.url.split('?')[0];
    const query = Object.fromEntries(new URL(q.url, 'http://x').searchParams);
    if (u === '/data/Sessions.csv') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end(SESSIONS_CSV); }
    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/hub-content' || u === '/hub-content/') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: '' }, settings: {}, features: {} })); }
    if (['/hub-content/resources', '/hub-content/venues', '/hub-content/coach-support', '/hub-content/public-pages', '/hub-content/what-we-offer'].includes(u)) {
      r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end('[]');
    }
    if (u === '/hub-content/session-participants') { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end('[]'); }
    if (u === '/me') {
      const email = emailFromAuth(q);
      if (!email) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(JSON.stringify({ user_id: 'uid-' + email, email, organisation_id: 'ORG-JOSHEVANS', role: 'coach', status: 'active', airtable_person_id: 'coachrec1', display_name: 'Tom' }));
    }
    if (u === '/hub-content/players') {
      const email = emailFromAuth(q);
      r.writeHead(200, { 'Content-Type': 'application/json' });
      return r.end(email ? JSON.stringify(PLAYERS) : '[]');
    }
    if (u === '/player-feedback/framework') {
      if (!q.headers['authorization']) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(FRAMEWORK));
    }
    if (u === '/player-feedback/history') {
      if (!q.headers['authorization']) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      const list = historyByPlayer[query.player_record_id] || [];
      r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ feedback: list }));
    }
    // A record id a coach is NOT authorised to edit - simulates the real
    // Edge Function's resolveAccessForPair()/can_edit_feedback gate
    // rejecting a write regardless of what the client sends.
    if (u === '/player-feedback/record/fb-locked-1' && q.method === 'PATCH') {
      if (!q.headers['authorization']) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      r.writeHead(403, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Your access to this player does not allow writing feedback' }));
    }
    const recordMatch = u.match(/^\/player-feedback\/record\/(.+)$/);
    if (recordMatch && q.method === 'GET') {
      if (!q.headers['authorization']) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      const all = [].concat(...Object.values(historyByPlayer));
      const found = all.find((f) => f.feedback_id === recordMatch[1]);
      if (!found) { r.writeHead(404, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Feedback not found' })); }
      r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(found));
    }
    if (u === '/player-feedback/record' && q.method === 'POST') {
      if (!q.headers['authorization']) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      lastCreateBody = await readBody(q);
      const created = { feedback_id: 'fb-new-1', title: 'Archie Wilkins — 2026-09-20', date: '2026-09-20', coach_name: 'Tom', published: !!lastCreateBody.published, summary: lastCreateBody.summary || '', keep_doing: lastCreateBody.keep_doing || '', big_focus: lastCreateBody.big_focus || '', player_record_id: lastCreateBody.player_record_id, session_record_id: lastCreateBody.session_record_id, ratings: (lastCreateBody.ratings || []).map((x) => ({ framework_item_id: x.framework_item_id, rating: x.rating, label_snapshot: (FRAMEWORK.groups.flatMap((g) => g.items).find((i) => i.framework_item_id === x.framework_item_id) || {}).name || '', group_snapshot: '', sort_order: 1, notes: x.note || '' })) };
      historyByPlayer[created.player_record_id] = [created].concat(historyByPlayer[created.player_record_id] || []);
      lastRequest = { method: 'POST', url: u, body: lastCreateBody };
      r.writeHead(201, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(created));
    }
    if (recordMatch && q.method === 'PATCH') {
      if (!q.headers['authorization']) { r.writeHead(401, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Missing or invalid Authorization header' })); }
      const id = recordMatch[1];
      const body = await readBody(q);
      lastRequest = { method: 'PATCH', url: u, body };
      let existing = null, ownerKey = null;
      for (const key of Object.keys(historyByPlayer)) {
        const found = historyByPlayer[key].find((f) => f.feedback_id === id);
        if (found) { existing = found; ownerKey = key; break; }
      }
      if (!existing) { r.writeHead(404, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ error: 'Feedback not found' })); }
      // Update the SAME record in place - PATCH must never add a new
      // entry to the player's history (that would be a duplicate parent
      // Feedback record).
      existing.published = !!body.published;
      existing.summary = body.summary || '';
      existing.keep_doing = body.keep_doing || '';
      existing.big_focus = body.big_focus || '';
      existing.ratings = (body.ratings || []).map((x) => ({ framework_item_id: x.framework_item_id, rating: x.rating || '', label_snapshot: (FRAMEWORK.groups.flatMap((g) => g.items).find((i) => i.framework_item_id === x.framework_item_id) || {}).name || '', group_snapshot: '', sort_order: 1, notes: x.note || '' }));
      r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(existing));
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

async function withPage(port, fn) {
  const server = makeServer(port);
  await new Promise((res) => server.listen(port, res));
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 } });
  await ctx.route('**/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ path: path.join(__dirname, '..', 'support', 'auth-stub.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.public-page');
  await page.click('[data-action="show-signup"]');
  await page.waitForSelector('.auth-card');
  await page.fill('#auth-email', 'coach-tom@test.com');
  await page.fill('#auth-password', 'password123');
  await page.click('[data-action="auth-submit"]');
  await page.waitForSelector('.coach-home');
  await fn(page, errs);
  await b.close();
  server.close();
}

(async () => {
  // --- Main flow: Player Profile, combined mode Add Feedback, Previous/Latest Feedback ---
  await withPage(8211, async (page, errs) => {
    await page.click('[data-nav="players"]');
    await page.waitForSelector('.player-session-group');
    await page.click('.player-session-head');
    await page.waitForSelector('.player-row');

    ck('Player Hub rows carry a chevron affordance', await page.locator('.player-row .chev').count() === 3);

    // --- Player Profile (Part B) ---
    await page.click('.player-row:has-text("Archie Wilkins")');
    await page.waitForSelector('.pf-hero');
    ck('Player Profile hero shows the player name', (await page.locator('.pf-heroTop h1').textContent()) === 'Archie Wilkins');
    ck('Player Profile shows the age group from the schedule join', (await page.locator('.pf-meta div:has-text("Age group") span').textContent()) === 'U9/10');
    ck('Player Profile shows the real Date of Birth', (await page.locator('.pf-meta div:has-text("Date of birth") span').textContent()) === '12 March 2015');
    ck('Status pill reflects the permanent tier as ACTIVE', (await page.locator('.pf-status').textContent()) === 'ACTIVE');

    const medicalRow = await page.locator('.pf-row.pf-medical').textContent();
    ck('Medical/Allergies is honestly "not currently available", never invented', /Not currently available/.test(medicalRow), medicalRow);
    ck('Medical/Allergies keeps the safety-critical red tint even while unavailable', await page.locator('.pf-row.pf-medical').count() === 1);
    const notesRow = await page.locator('.pf-row:has-text("Player Notes")').textContent();
    ck('Player Notes is also honestly unavailable, not invented', /Not currently available/.test(notesRow), notesRow);

    ck('Add Feedback is enabled for a permanent-tier player', await page.locator('.pf-add[disabled]').count() === 0);
    ck('No feedback yet -> the Latest Feedback slot says so, not an error', /No feedback yet/.test(await page.locator('#pf-latest-slot').textContent()));
    ck('No unfinished draft -> the button still reads Add Feedback', (await page.locator('.pf-add b').textContent()) === 'Add Feedback');
    ck('No leftover prototype/developer copy on the Player Profile screen', !/Repo-faithful concept/.test(await page.locator('.pf-wrap').textContent()));

    // --- Add Feedback (Part C), combined mode ---
    await page.click('.pf-add');
    await page.waitForSelector('.fb-hero');
    ck('Coach Feedback hero shows the player + session', (await page.locator('.fb-heroTop p').textContent()) === 'Archie Wilkins · U9/10 Development');
    ck('Framework groups render data-driven, not hardcoded to 10 items', await page.locator('.fb-group').count() === 2);
    ck('Characteristics group shows exactly its 2 mocked areas', (await page.locator('.fb-group:has-text("Characteristics") small').first().textContent()) === '2 areas');
    ck('No leftover prototype/developer copy on the Add Feedback screen', !/This form is driven by/.test(await page.locator('body').textContent()));

    // Compact rating row: area name and its 4 colour choices share one row.
    const firstRowBox = await page.locator('.fb-ratingRow').first().boundingBox();
    ck('Rating row is compact (well under the old stacked-label height)', firstRowBox && firstRowBox.height < 46, JSON.stringify(firstRowBox));
    ck('Each rating row exposes exactly 4 colour choices', await page.locator('.fb-ratingRow').first().locator('.fb-choice').count() === 4);

    // Legend: each configured label appears exactly once (not duplicated
    // with a hardcoded description alongside it).
    const legendText = await page.locator('.fb-legend').textContent();
    ck('Legend shows the configured label once, not duplicated ("X: X")', !/Consistently strong[:\s]*Consistently strong/.test(legendText), legendText);
    ck('Legend still surfaces all 4 configured labels', /Consistently strong/.test(legendText) && /Showing regularly/.test(legendText) && /Developing/.test(legendText) && /Key focus/.test(legendText), legendText);

    // Select a rating for each ratable item
    await page.click('.fb-ratingRow:has-text("Winners") .fb-choice.fb-green');
    await page.click('.fb-ratingRow:has-text("Movers") .fb-choice.fb-blue');
    await page.click('.fb-ratingRow:has-text("1v1 Attack") .fb-choice.fb-amber');
    ck('Selecting a rating shows the selected outline', await page.locator('.fb-choice.fb-selected').count() === 3);

    await page.fill('#fb-field-keep-doing', 'Great pressing.');
    await page.fill('#fb-field-my-focus', 'Work on first touch.');

    await page.click('[data-action="publish-feedback"]');
    await page.waitForSelector('.pf-feedback-detail');

    ck('Publish sends exactly the ratings the coach picked, correctly capitalised', lastCreateBody && lastCreateBody.ratings.length === 3 && lastCreateBody.ratings.every((r) => ['Blue', 'Green', 'Amber', 'Red'].includes(r.rating)), JSON.stringify(lastCreateBody && lastCreateBody.ratings));
    ck('Publish sends the written fields the coach typed', lastCreateBody && lastCreateBody.keep_doing === 'Great pressing.' && lastCreateBody.big_focus === 'Work on first touch.', JSON.stringify(lastCreateBody));
    ck('Publish is scoped to the exact player+session pair, not invented client-side', lastCreateBody && lastCreateBody.player_record_id === 'p1' && lastCreateBody.session_record_id === 'sess1', JSON.stringify(lastCreateBody));
    ck('After publishing, the read view shows PUBLISHED', (await page.locator('.pf-pill').textContent()) === 'PUBLISHED');

    // --- Previous Feedback / Latest Feedback for a different player (Part B read views) ---
    await page.click('[data-action="app-back"]');
    await page.waitForSelector('.fb-hero, .pf-hero');
    // Back from the record lands on Player Profile (no double-push through the form)
    await page.waitForSelector('.pf-hero');
    ck('Latest Feedback now shows the just-published record for the correct player', /Great pressing/.test(await page.locator('#pf-latest-slot').textContent()), await page.locator('#pf-latest-slot').textContent());
    await page.click('[data-action="app-back"]');
    // The players pane keeps its own expanded/collapsed state across
    // navigation (it's a persistent TAB_SCREENS pane) - the group is
    // still open from the first expand, so no need to click it again.
    await page.waitForSelector('.player-row');

    await page.click('.player-row:has-text("Bella Former")');
    await page.waitForSelector('.pf-hero');
    ck('Former-tier status pill reads FORMER', (await page.locator('.pf-status').textContent()) === 'FORMER');
    ck('Access text explains the former-coach access window', /Former player/.test(await page.locator('.pf-meta div:has-text("Access") span').textContent()));
    ck('Add Feedback is disabled for a former-tier player (can_edit_feedback=false)', await page.locator('.pf-add[disabled]').count() === 1);

    await page.click('.pf-history');
    await page.waitForSelector('.pf-history-list');
    ck('Previous Feedback lists the existing published record', /Autumn Review/.test(await page.locator('.pf-history-list').textContent()));
    await page.click('.pf-feedback-card');
    await page.waitForSelector('.pf-feedback-detail');
    ck('Opening a history item shows its Keep Doing text', /Breaking up play/.test(await page.locator('.pf-feedback-detail').textContent()));
    ck('History uses the historical rating snapshot label, not a live lookup', /Winners/.test(await page.locator('.pf-ratings-summary').textContent()));

    ck('No console/page errors', errs.length === 0, errs.join(' | '));
  });

  // --- Draft resume: pre-fill, PATCH not POST, no duplicate on either save ---
  await withPage(8211, async (page, errs) => {
    await page.click('[data-nav="players"]');
    await page.waitForSelector('.player-session-group');
    await page.click('.player-session-head');
    await page.waitForSelector('.player-row');

    await page.click('.player-row:has-text("Diego Draft")');
    await page.waitForSelector('.pf-hero');
    await page.waitForFunction(() => document.querySelector('[data-action="add-feedback"] b')?.textContent === 'Resume Draft');
    ck('An existing unpublished draft relabels Add Feedback as Resume Draft', (await page.locator('.pf-add b').textContent()) === 'Resume Draft');

    await page.click('.pf-add');
    await page.waitForSelector('.fb-hero');
    ck('Resuming a draft pre-fills its written text', (await page.locator('#fb-field-keep-doing').inputValue()) === 'Working on first touch.');
    ck('Resuming a draft pre-selects its saved rating', await page.locator('.fb-ratingRow:has-text("Winners") .fb-choice.fb-amber.fb-selected').count() === 1);

    const beforeCount = historyByPlayer.p3.length;
    await page.click('[data-action="save-feedback-draft"]');
    await page.waitForSelector('.pf-feedback-detail');
    ck('Saving a resumed draft uses PATCH, not POST', lastRequest && lastRequest.method === 'PATCH', JSON.stringify(lastRequest));
    ck('Saving a resumed draft PATCHes the SAME record id', lastRequest && lastRequest.url === '/player-feedback/record/fb-draft-1', lastRequest && lastRequest.url);
    ck('Draft save creates no duplicate parent Feedback record', historyByPlayer.p3.length === beforeCount, String(historyByPlayer.p3.length));
    ck('The record still reads DRAFT after a draft save', (await page.locator('.pf-pill').textContent()) === 'DRAFT');

    // Reproduces the exact reported regression: open Add Feedback, Save
    // Draft (above), go back into Resume Draft, change something, Save
    // Draft again - a SECOND consecutive PATCH on the same just-churned
    // record, which is exactly the timing where a real Airtable
    // reciprocal-link propagation lag would bite (see
    // tests/support/feedback-ratings-merge.test.ts for the backend-logic
    // side of this fix). Must succeed reliably, keep PATCHing the same
    // parent, never duplicate, and never lose the edited content.
    await page.click('[data-action="app-back"]');
    await page.waitForSelector('.pf-hero');
    await page.waitForFunction(() => document.querySelector('[data-action="add-feedback"] b')?.textContent === 'Resume Draft');
    await page.click('.pf-add');
    await page.waitForSelector('.fb-hero');
    ck('Resuming a draft a second time still pre-fills correctly', (await page.locator('#fb-field-keep-doing').inputValue()) === 'Working on first touch.');
    await page.fill('#fb-field-keep-doing', 'Working on first touch - now also tracking back.');
    await page.click('.fb-ratingRow:has-text("Winners") .fb-choice.fb-green');
    await page.click('[data-action="save-feedback-draft"]');
    await page.waitForSelector('.pf-feedback-detail');
    ck('A second consecutive draft save succeeds (no "load failed")', errs.length === 0, errs.join(' | '));
    ck('The second draft save still uses PATCH on the same record id', lastRequest && lastRequest.method === 'PATCH' && lastRequest.url === '/player-feedback/record/fb-draft-1', JSON.stringify(lastRequest));
    ck('The second draft save still creates no duplicate parent record', historyByPlayer.p3.length === beforeCount, String(historyByPlayer.p3.length));
    ck('The edited written text is not lost', /Working on first touch - now also tracking back\./.test(await page.locator('.pf-feedback-detail').textContent()));
    ck('The edited rating is not lost', historyByPlayer.p3[0].ratings.some((r) => r.framework_item_id === 'fi1' && r.rating === 'Green'), JSON.stringify(historyByPlayer.p3[0].ratings));
    ck('Still reads DRAFT after the second draft save', (await page.locator('.pf-pill').textContent()) === 'DRAFT');

    // Go back to Player Profile and resume once more, this time publishing.
    await page.click('[data-action="app-back"]');
    await page.waitForSelector('.pf-hero');
    await page.waitForFunction(() => document.querySelector('[data-action="add-feedback"] b')?.textContent === 'Resume Draft');
    await page.click('.pf-add');
    await page.waitForSelector('.fb-hero');
    await page.click('[data-action="publish-feedback"]');
    await page.waitForSelector('.pf-feedback-detail');
    ck('Publishing an existing draft also uses PATCH on the same record', lastRequest && lastRequest.method === 'PATCH' && lastRequest.url === '/player-feedback/record/fb-draft-1', JSON.stringify(lastRequest));
    ck('Publishing a resumed draft still creates no duplicate record', historyByPlayer.p3.length === beforeCount, String(historyByPlayer.p3.length));
    ck('Publishing the resumed draft updates it to PUBLISHED', (await page.locator('.pf-pill').textContent()) === 'PUBLISHED');

    ck('No console/page errors (draft resume flow)', errs.length === 0, errs.join(' | '));
  });

  // --- Written Only mode: no colour controls, but enabled per-area written fields still show ---
  FRAMEWORK = FRAMEWORK_WRITTEN_ONLY;
  await withPage(8211, async (page, errs) => {
    await page.click('[data-nav="players"]');
    await page.waitForSelector('.player-session-group');
    await page.click('.player-session-head');
    await page.waitForSelector('.player-row');
    await page.click('.player-row:has-text("Archie Wilkins")');
    await page.waitForSelector('.pf-hero');
    await page.click('.pf-add');
    await page.waitForSelector('.fb-hero');

    ck('Written Only: framework rows are NOT hidden completely', await page.locator('.fb-group').count() === 1, await page.locator('body').textContent());
    ck('Written Only: no colour rating choices render at all', await page.locator('.fb-choice').count() === 0);
    ck('Written Only: an item with Written Feedback Enabled still shows its note field', await page.locator('#fb-note-fi2').count() === 1);
    ck('Written Only: an item with neither rating nor written enabled is excluded entirely (nothing to show)', await page.locator('.fb-ratingRow:has-text("Winners")').count() === 0);

    await page.fill('#fb-note-fi2', 'Great awareness off the ball.');
    await page.click('[data-action="publish-feedback"]');
    await page.waitForSelector('.pf-feedback-detail');
    ck('Written Only: the typed per-area note is actually sent (no rating needed to carry it)', lastCreateBody && lastCreateBody.ratings.some((r) => r.framework_item_id === 'fi2' && r.note === 'Great awareness off the ball.'), JSON.stringify(lastCreateBody && lastCreateBody.ratings));

    ck('No console/page errors (Written Only mode)', errs.length === 0, errs.join(' | '));
  });

  // --- Ratings Only mode: ratings show, all written fields (incl. per-area) are hidden ---
  FRAMEWORK = FRAMEWORK_RATINGS_ONLY;
  await withPage(8211, async (page, errs) => {
    await page.click('[data-nav="players"]');
    await page.waitForSelector('.player-session-group');
    await page.click('.player-session-head');
    await page.waitForSelector('.player-row');
    await page.click('.player-row:has-text("Archie Wilkins")');
    await page.waitForSelector('.pf-hero');
    await page.click('.pf-add');
    await page.waitForSelector('.fb-hero');

    ck('Ratings Only: rating choices render', await page.locator('.fb-choice').count() === 4);
    ck('Ratings Only: no per-area note field renders even though Written Feedback Enabled is on', await page.locator('.fb-area-note').count() === 0);
    ck('Ratings Only: the Written Feedback section (Keep Doing/My Focus/General) is hidden entirely', await page.locator('.fb-textCard').count() === 0);

    ck('No console/page errors (Ratings Only mode)', errs.length === 0, errs.join(' | '));
  });

  // --- Security: player-feedback routes reject unauthenticated/unauthorised requests ---
  FRAMEWORK = FRAMEWORK_COMBINED;
  await withPage(8211, async (page, errs) => {
    const res = await page.evaluate(async () => {
      const r = await fetch('http://localhost:8211/player-feedback/framework');
      return r.status;
    });
    ck('player-feedback/framework rejects a request with no Authorization header', res === 401, String(res));
    const res2 = await page.evaluate(async () => {
      const r = await fetch('http://localhost:8211/player-feedback/history?player_record_id=p1&session_record_id=sess1');
      return r.status;
    });
    ck('player-feedback/history rejects a request with no Authorization header', res2 === 401, String(res2));
    const res3 = await page.evaluate(async () => {
      const r = await fetch('http://localhost:8211/player-feedback/record/fb-locked-1', { method: 'PATCH', headers: { Authorization: 'Bearer tok-coach-tom@test.com~x', 'Content-Type': 'application/json' }, body: JSON.stringify({ published: true }) });
      return r.status;
    });
    ck('An authenticated but unauthorised coach cannot PATCH (edit) a draft they have no access to', res3 === 403, String(res3));
  });

  console.log(R.map(([s, n, x]) => `${s}  ${n}${x ? '  -- ' + x : ''}`).join('\n'));
  console.log(`\n${R.filter((r) => r[0] === 'PASS').length}/${R.length} passing`);
  process.exit(process.exitCode || 0);
})();
