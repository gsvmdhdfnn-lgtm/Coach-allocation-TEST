const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('./serve-static.js');
const ROOT = process.env.SP_SERVE;
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.csv':'text/csv','.png':'image/png'};

const RESOURCES = [
  { resource_id: 'RES-DEMO-001', title: '1v1 Attacking — Example Resource', category: 'Session Plans', description: 'Example resource so you can see how content will be organised.', thumbnail_url: '', attachment_url: '', video_url: '', external_link: 'https://example.com/plan.pdf', audience: ['Coach'] }
];
const VENUES = [
  { venue_id: 'VEN-FREEMENS', name: "City of London Freemen's", address: 'Ashtead, Surrey', postcode: '', parking: 'Add parking instructions here.', meeting_point: 'Add meeting point here.', access: 'Add access instructions here.', notes: 'Example venue record — replace the placeholder instructions with the real venue details when ready.', hero_image_url: '', parking_image_url: '', site_map_url: '' }
];
const SUPPORT = [
  { support_id: 'SUP-DEMO-001', title: 'Session Standards — Example', section: 'Our Standards', body: 'This is an example Coach Support item. Later, you can edit the wording here and the Hub can display the updated version automatically.', attachment_url: '', external_link: '', audience: ['Coach', 'Management'] }
];
const PUBLIC_PAGES = [
  { page_id: 'PUB-GENERAL-WELCOME', title: 'Welcome to Josh Evans Soccer School', category: 'General', summary: 'Welcome to Josh Evans Soccer School', body: 'Example placeholder welcome text.', colour: '#082e5b', cta_label: '', cta_link: '', image_url: '' },
  { page_id: 'PUB-TRIALS-JETS', title: 'Jets Trials', category: 'Trials', summary: 'Information, dates and registration', body: 'Example placeholder trial info.', colour: '#ffffff', age_groups: 'U7, U8, U9/10, U11/12, U13/14', cta_label: 'Find out more', cta_link: 'https://example.com/jets-trials', image_url: 'je-logo.png' },
  { page_id: 'PUB-ACADEMY', title: 'Academy Programme — Example', category: 'Academy', summary: 'Player development programmes', body: 'Example placeholder academy info.', colour: '#3d7a34', age_groups: '', cta_label: 'Find out more', cta_link: 'https://example.com/academy', image_url: '' }
];

let changesFail = false;
const registrations = [];
module.exports.registrations = registrations;
const MIN_SECONDS_ON_FORM = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
module.exports.start = function (port) {
  const srv = http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/register-interest' && q.method === 'POST') {
      let raw = '';
      q.on('data', (c) => { raw += c; });
      q.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        if (String(body.website_hp || '').trim() !== '') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ ok: true })); }
        const startedAt = Number(body.started_at);
        if (!startedAt || (Date.now() - startedAt) / 1000 < MIN_SECONDS_ON_FORM) { r.writeHead(422, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Please try again.' })); }
        const name = String(body.name || '').trim(), email = String(body.email || '').trim();
        if (!name || !email || !String(body.page_title || '').trim() || !String(body.age_group || '').trim()) { r.writeHead(400, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Name, email, age group and which programme are required.' })); }
        if (!EMAIL_RE.test(email)) { r.writeHead(400, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: "That doesn't look like a valid email address." })); }
        registrations.push(body);
        r.writeHead(200, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (u === '/changes') {
      if (changesFail) { r.writeHead(500); return r.end('boom'); }
      r.writeHead(200, { 'Content-Type': 'text/csv' });
      return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n');
    }
    if (u === '/set-changes-fail') { changesFail = q.url.includes('=1'); r.writeHead(200); return r.end('ok'); }
    if (u === '/hub-content/resources') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify(RESOURCES)); }
    if (u === '/hub-content/venues') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify(VENUES)); }
    if (u === '/hub-content/coach-support') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify(SUPPORT)); }
    if (u === '/hub-content/public-pages') { r.writeHead(200, {'Content-Type':'application/json'}); return r.end(JSON.stringify(PUBLIC_PAGES)); }
    if (u === '/hub-content' || u === '/hub-content/') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' }, settings: {}, features: {} }));
    }
    if (u === '/parent-hub/me') {
      var auth2 = q.headers['authorization'] || '';
      if (!auth2) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Invalid or expired session' })); }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ parent_id: 'PARENT-TEST', children: [], pending_claims: [], available_sessions: [] }));
    }
    if (u === '/me') {
      var auth = q.headers['authorization'] || '';
      var token = auth.replace(/^Bearer /, '').replace(/^tok-/, '');
      var accountType = '';
      var tilde = token.indexOf('~');
      if (tilde >= 0) { accountType = token.slice(tilde + 1); token = token.slice(0, tilde); }
      var email = token;
      if (!email) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      // Mirrors the real handle_new_user() trigger: only 'parent' is
      // honoured from client-supplied signup data, and it auto-activates
      // (no 'pending' step) since a bare parent role has no standing
      // access on its own.
      if (accountType === 'parent') {
        r.writeHead(200, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ user_id: 'uid-'+email, email: email, organisation_id: 'ORG-JOSHEVANS', role: 'parent', status: 'active', airtable_person_id: null, display_name: null }));
      }
      var role = 'pending', displayName = null;
      if (/^pending/.test(email)) { role = 'pending'; }
      else if (/^coach-noname/.test(email)) { role = 'coach'; displayName = null; }
      else if (/^coach/.test(email)) { role = 'coach'; displayName = 'Tom'; }
      else if (/^mgmt/.test(email)) { role = 'management'; }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ user_id: 'uid-'+email, email: email, organisation_id: 'ORG-JOSHEVANS', role: role, status: 'active', airtable_person_id: null, display_name: displayName }));
    }
    return serveStatic(q, r, u, ROOT);
  });
  return new Promise(res => srv.listen(port, () => res(srv)));
};
