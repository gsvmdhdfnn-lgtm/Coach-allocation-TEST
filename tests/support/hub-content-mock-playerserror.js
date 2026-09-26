// Mock whose /hub-content/players route can be switched between failing,
// succeeding with no players, and succeeding with players - the three
// cases the Player Hub has to tell apart. Everything else answers
// normally, so a players failure is isolated and the rest of the Hub
// still loads (which is the point: only that one pane should show an
// error).
const http = require('http');
const { serveStatic } = require('./serve-static.js');
const ROOT = process.env.SP_SERVE;

// 'fail' -> 500, 'empty' -> 200 [], 'ok' -> 200 with players.
let playersMode = 'ok';
let playersCalls = 0;

const PLAYERS = [
  { player_record_id: 'p1', player_id: 'PLY-001', name: 'Archie Smith', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link1', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
  { player_record_id: 'p2', player_id: 'PLY-002', name: 'Bella Jones', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link2', tier: 'permanent', access_until: null, can_edit_feedback: true, can_edit_idp: true, can_edit_attendance: true },
  // Former tier, no write access - proves the retry path preserves the
  // server's own permission flags rather than re-deriving them client-side.
  { player_record_id: 'p5', player_id: 'PLY-005', name: 'Ella Frost', photo_url: '', session_record_id: 'sess1', session_id: 'E01', session_name: 'Monday Academy', link_record_id: 'link5', tier: 'former', access_until: '2026-10-08', can_edit_feedback: false, can_edit_idp: false, can_edit_attendance: false }
];

function emailFromAuth(q) {
  var auth = q.headers['authorization'] || '';
  var token = auth.replace(/^Bearer /, '').replace(/^tok-/, '');
  var tilde = token.indexOf('~');
  return tilde >= 0 ? token.slice(0, tilde) : token;
}

module.exports.setPlayersMode = (m) => { playersMode = m; };
module.exports.playersCalls = () => playersCalls;

module.exports.start = function (port) {
  const srv = http.createServer((q, r) => {
    const u = q.url.split('?')[0];
    if (u === '/hub-content' || u === '/hub-content/') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ organisation: { hub_name: 'Josh Evans Hub', tagline: 'Better people make better players.' }, settings: {}, features: {} }));
    }
    if (u === '/hub-content/players') {
      playersCalls++;
      if (playersMode === 'fail') {
        r.writeHead(500, {'Content-Type':'application/json'});
        return r.end(JSON.stringify({ error: 'Airtable error for Players: 429 rate limited' }));
      }
      var email = emailFromAuth(q);
      if (!email) { r.writeHead(200, {'Content-Type':'application/json'}); return r.end('[]'); }
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify(playersMode === 'empty' ? [] : PLAYERS));
    }
    if (u === '/hub-content/session-participants') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify([{ session_id: 'E01', participants: '12' }]));
    }
    if (u === '/hub-content/resources' || u === '/hub-content/venues' || u === '/hub-content/coach-support' || u === '/hub-content/public-pages') {
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify([]));
    }
    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/me') {
      var email2 = emailFromAuth(q);
      if (!email2) { r.writeHead(401, {'Content-Type':'application/json'}); return r.end(JSON.stringify({ error: 'Missing Authorization header' })); }
      var role = /^mgmt/.test(email2) ? 'management' : 'coach';
      r.writeHead(200, {'Content-Type':'application/json'});
      return r.end(JSON.stringify({ user_id: 'uid-'+email2, email: email2, organisation_id: 'ORG-JOSHEVANS', role: role, status: 'active', airtable_person_id: 'recCoach1', display_name: 'Tom' }));
    }
    return serveStatic(q, r, u, ROOT);
  });
  return new Promise(res => srv.listen(port, () => res(srv)));
};
