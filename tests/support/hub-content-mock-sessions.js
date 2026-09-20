// Patched mock simulating the session-based player-access system:
// hub-content's /players route (Authorization-gated, tier-tagged, grouped
// by session) and the player-sessions function (sync, requests list,
// approve/reject/amend, end-link, migration preview/commit).
const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('./serve-static.js');
const ROOT = process.env.SP_SERVE;
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.csv':'text/csv','.png':'image/png'};

let pendingRequests = [
  { request_id: 'req1', player_record_id: 'p1', player_name: 'Archie Smith', session_record_id: 'sess1', session_name: 'Monday Academy', requested_date: '2026-09-10' },
  { request_id: 'req2', player_record_id: 'p2', player_name: 'Bella Jones', session_record_id: 'sess2', session_name: 'Wednesday Development Centre', requested_date: '2026-09-11' }
];
const sessionsList = [
  { session_record_id: 'sess1', session_name: 'Monday Academy' },
  { session_record_id: 'sess2', session_name: 'Wednesday Development Centre' },
  { session_record_id: 'sess3', session_name: 'Thursday U9/10' }
];
let lastApproveBody = null;
let endedLinkIds = [];
let lastMigrationCommitBody = null;

function emailFromAuth(q) {
  var auth = q.headers['authorization'] || '';
  var token = auth.replace(/^Bearer /, '').replace(/^tok-/, '');
  var tilde = token.indexOf('~');
  return tilde >= 0 ? token.slice(0, tilde) : token;
}

module.exports.lastApproveBody = () => lastApproveBody;
module.exports.endedLinkIds = () => endedLinkIds;
module.exports.lastMigrationCommitBody = () => lastMigrationCommitBody;

module.exports.start = function (port) {
  const srv = http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/hub-content' || u === '/hub-content/') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' }, settings: {}, features: {} }));
    }
    if (u === '/hub-content/resources' || u === '/hub-content/venues' || u === '/hub-content/coach-support' || u === '/hub-content/public-pages') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify([]));
    }
    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/me') {
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      var role = /^mgmt/.test(email) ? 'management' : (/^coach/.test(email) ? 'coach' : 'pending');
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ user_id: 'uid-'+email, email: email, organisation_id: 'ORG-JOSHEVANS', role: role, status: 'active', airtable_person_id: 'coachrec1', display_name: role === 'coach' || role === 'management' ? 'Tom' : null }));
    }
    if (u === '/hub-content/players') {
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(200, {'Content-Type':'application/json'}); return r.end('[]'); }
      var role = /^mgmt/.test(email) ? 'management' : 'coach';
      var rows = role === 'management' ? [
        { player_record_id: 'p1', player_id: 'PLY-001', name: 'Archie Smith', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link1', tier: 'admin', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true }
      ] : [
        { player_record_id: 'p1', player_id: 'PLY-001', name: 'Archie Smith', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link1', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
        { player_record_id: 'p2', player_id: 'PLY-002', name: 'Bella Jones', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link2', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
        { player_record_id: 'p3', player_id: 'PLY-003', name: 'Charlie Day', photo_url: '', session_record_id: 'sess3', session_id: 'E04', session_name: 'Thursday U9/10', link_record_id: 'link3', tier: 'cover', access_until: null, can_edit_feedback: true, can_edit_idp: false, can_edit_attendance: true },
        { player_record_id: 'p4', player_id: 'PLY-004', name: 'Dylan Ray', photo_url: '', session_record_id: '', session_id: '', session_name: 'Not yet linked to a session', link_record_id: '', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
        { player_record_id: 'p5', player_id: 'PLY-005', name: 'Ella Frost', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link5', tier: 'former', access_until: '2026-10-08', can_edit_feedback: false, can_edit_idp: false, can_edit_attendance: false }
      ];
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify(rows));
    }
    if (u === '/player-sessions/requests' && q.method === 'GET') {
      var email = emailFromAuth(q);
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ pending: pendingRequests, sessions: sessionsList }));
    }
    if (u === '/player-sessions/sync' && q.method === 'POST') {
      var email = emailFromAuth(q);
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ created: 1, updated: 2, archived: 0 }));
    }
    if (u === '/player-sessions/migration/preview' && q.method === 'GET') {
      var email = emailFromAuth(q);
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({
        matched: [{ player_record_id: 'p10', player_name: 'Freya Todd', team_session_text: 'Monday Academy', session_record_id: 'sess1', session_name: 'Monday Academy' }],
        ambiguous: [{ player_record_id: 'p11', player_name: 'George Vance', team_session_text: 'U9/10', candidates: [{ session_record_id: 'sess3', session_name: 'Thursday U9/10' }, { session_record_id: 'sess4', session_name: 'Saturday U9/10 Extra' }] }],
        unmatched: [{ player_record_id: 'p12', player_name: 'Hana Wills', team_session_text: 'Some Old Group', reason: 'No session name resembles "Some Old Group"' }]
      }));
    }
    if (u === '/player-sessions/migration/commit' && q.method === 'POST') {
      var email = emailFromAuth(q);
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      let raw = '';
      q.on('data', (c) => { raw += c; });
      q.on('end', () => {
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) {}
        lastMigrationCommitBody = body;
        var links = Array.isArray(body.links) ? body.links : [];
        r.writeHead(200, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ ok: true, committed: links.length }));
      });
      return;
    }
    var endMatch = u.match(/^\/player-sessions\/links\/([^/]+)\/end$/);
    if (endMatch && q.method === 'POST') {
      var email = emailFromAuth(q);
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      endedLinkIds.push(endMatch[1]);
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ ok: true, coaches_at_end: 1 }));
    }
    var approveMatch = u.match(/^\/player-sessions\/requests\/([^/]+)\/approve$/);
    var rejectMatch = u.match(/^\/player-sessions\/requests\/([^/]+)\/reject$/);
    if ((approveMatch || rejectMatch) && q.method === 'POST') {
      var email = emailFromAuth(q);
      if (!/^mgmt/.test(email)) { r.writeHead(403, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Management access required' })); }
      let raw = '';
      q.on('data', (c) => { raw += c; });
      q.on('end', () => {
        var id = (approveMatch || rejectMatch)[1];
        var idx = pendingRequests.findIndex(function (p) { return p.request_id === id; });
        if (idx === -1) { r.writeHead(404, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Request not found' })); }
        if (approveMatch) {
          let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) {}
          lastApproveBody = body;
        }
        pendingRequests.splice(idx, 1);
        r.writeHead(200, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    return serveStatic(q, r, u, ROOT);
  });
  return new Promise(res => srv.listen(port, () => res(srv)));
};
