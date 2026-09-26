// Patched copy of hub-content-mock.js that also simulates the approve-coach
// Edge Function (GET /approve-coach/pending, POST /approve-coach, POST
// /approve-coach/decline), so the new Coach Management screen can be
// exercised end to end without hitting the real deployed function
// (blocked by sandbox network egress).
const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('./serve-static.js');
const ROOT = process.env.SP_SERVE;
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.csv':'text/csv','.png':'image/png'};

let pending = [
  { user_id: 'uid-newcoach@test.com', email: 'newcoach@test.com', created_at: '2026-09-10T10:00:00Z' },
  { user_id: 'uid-alreadycoach@test.com', email: 'alreadycoach@test.com', created_at: '2026-09-08T09:00:00Z' },
  { user_id: 'uid-multi@test.com', email: 'multi@test.com', created_at: '2026-09-05T08:00:00Z' }
];

function emailFromAuth(q) {
  var auth = q.headers['authorization'] || '';
  var token = auth.replace(/^Bearer /, '').replace(/^tok-/, '');
  var tilde = token.indexOf('~');
  return tilde >= 0 ? token.slice(0, tilde) : token;
}

module.exports.start = function (port) {
  const srv = http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/hub-content' || u === '/hub-content/') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' }, settings: {}, features: {} }));
    }
    if (u === '/hub-content/resources' || u === '/hub-content/venues' || u === '/hub-content/coach-support' || u === '/hub-content/public-pages' || u === '/hub-content/players') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify([]));
    }
    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/me') {
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      var role = /^mgmt/.test(email) ? 'management' : (/^coach/.test(email) ? 'coach' : 'pending');
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ user_id: 'uid-'+email, email: email, organisation_id: 'ORG-JOSHEVANS', role: role, status: 'active', airtable_person_id: null, display_name: role === 'coach' || role === 'management' ? 'Tom' : null }));
    }
    if (u === '/approve-coach/pending' && q.method === 'GET') {
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify(pending));
    }
    if (u === '/approve-coach' && q.method === 'POST') {
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      let raw = '';
      q.on('data', (c) => { raw += c; });
      q.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        var userId = String(body.user_id || '');
        if (userId === 'uid-multi@test.com') { r.writeHead(409, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'More than one Coach record has the email multi@test.com - resolve manually in Airtable before approving.' })); }
        var idx = pending.findIndex(function (p) { return p.user_id === userId; });
        if (idx === -1) { r.writeHead(404, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Profile not found' })); }
        pending.splice(idx, 1);
        r.writeHead(200, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ ok: true, airtable_person_id: 'recFAKE123' }));
      });
      return;
    }
    if (u === '/approve-coach/decline' && q.method === 'POST') {
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      let rawD = '';
      q.on('data', (c) => { rawD += c; });
      q.on('end', () => {
        let body = {};
        try { body = JSON.parse(rawD || '{}'); } catch (e) {}
        var userId = String(body.user_id || '');
        // Mirrors handleDecline()'s guard: only a pending signup can be
        // declined, and an already-approved coach is refused outright.
        if (userId === 'uid-alreadycoach@test.com' && !pending.some(function (p) { return p.user_id === userId; })) {
          r.writeHead(400, {'Content-Type':'application/json'});
          return r.end(JSON.stringify({ error: 'Only a pending coach signup can be declined (current role: "coach").' }));
        }
        var idx = pending.findIndex(function (p) { return p.user_id === userId; });
        if (idx === -1) { r.writeHead(404, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Profile not found' })); }
        // The profile is deactivated, never deleted and never given a
        // 'rejected' role, so it simply drops out of the pending queue.
        pending.splice(idx, 1);
        r.writeHead(200, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ ok: true, status: 'declined' }));
      });
      return;
    }
    return serveStatic(q, r, u, ROOT);
  });
  return new Promise(res => srv.listen(port, () => res(srv)));
};
