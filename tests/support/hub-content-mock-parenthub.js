const http = require('http'), fs = require('fs'), path = require('path');
const { serveStatic } = require('./serve-static.js');
const ROOT = process.env.SP_SERVE;
const T = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.csv':'text/csv','.png':'image/png'};

const PLAYERS = [
  { id: 'plyr1', name: 'Alfie Test', dob: '2015-05-10' },
  { id: 'plyr2', name: 'Bea Test', dob: '2016-02-20' },
  { id: 'plyr3-dup-a', name: 'Sam Test', dob: '2014-01-01' },
  { id: 'plyr3-dup-b', name: 'Sam Test', dob: '2014-01-01' } // deliberate ambiguous-name pair (different id, same name+dob is NOT how ambiguity is triggered here - see note below)
];
// Ambiguity in the real function is "more than one Player matches name+DOB
// exactly" - simulate that directly with two same name+dob records above.
const SESSIONS = [
  { id: 'sess1', name: 'U9/10 Development' },
  { id: 'sess2', name: 'U11/12 Academy' }
];

let linkSeq = 1;
const links = []; // {id, parentEmail, playerId, playerName, dob, relationship, status, notes}
const sessionRequests = [];

function roleForEmail(email) {
  if (/^pending/.test(email)) return 'pending';
  if (/^mgmt/.test(email)) return 'management';
  return 'coach';
}
function callerFromAuth(header) {
  var token = (header || '').replace(/^Bearer /, '').replace(/^tok-/, '');
  var accountType = ''; var tilde = token.indexOf('~');
  if (tilde >= 0) { accountType = token.slice(tilde + 1); token = token.slice(0, tilde); }
  var email = token;
  var role = accountType === 'parent' ? 'parent' : roleForEmail(email);
  return { email: email, role: role };
}
function readJson(q) {
  return new Promise((resolve) => {
    let raw = ''; q.on('data', c => raw += c); q.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
  });
}
function send(r, status, body) { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(body)); }

module.exports.links = links;
module.exports.sessionRequests = sessionRequests;
module.exports.start = function (port) {
  const srv = http.createServer(async (q, r) => {
    const u = q.url.split('?')[0];
    const auth = q.headers['authorization'] || '';
    const caller = callerFromAuth(auth);

    if (u === '/changes') { r.writeHead(200, { 'Content-Type': 'text/csv' }); return r.end('week_commencing,session_id,venue,client,coach_out,coach_in,type,day,time,session_name,note\n'); }
    if (u === '/hub-content/resources' || u === '/hub-content/venues' || u === '/hub-content/coach-support' || u === '/hub-content/public-pages') { return send(r, 200, []); }
    if (u === '/hub-content' || u === '/hub-content/') return send(r, 200, { organisation: { hub_name: 'Josh Evans Hub', tagline: '' }, settings: {}, features: {} });
    if (u === '/me') {
      if (!auth) return send(r, 401, { error: 'Missing Authorization header' });
      return send(r, 200, { user_id: 'uid-' + caller.email, email: caller.email, organisation_id: 'ORG-JOSHEVANS', role: caller.role, status: 'active', airtable_person_id: null, display_name: null });
    }

    if (u === '/parent-hub/me' && q.method === 'GET') {
      const mine = links.filter(l => l.parentEmail === caller.email);
      const children = mine.filter(l => l.status === 'Verified').map(l => ({ link_id: l.id, player_record_id: l.playerId, player_id: l.playerId, name: l.playerName, photo_url: '', relationship: l.relationship }));
      const pendingClaims = mine.filter(l => l.status !== 'Verified').map(l => ({ link_id: l.id, player_name: l.playerName || 'Claim submitted', status: l.status, relationship: l.relationship }));
      const availableSessions = SESSIONS.map(s => ({ session_record_id: s.id, session_name: s.name }));
      return send(r, 200, { parent_id: 'PARENT-' + caller.email, children, pending_claims: pendingClaims, available_sessions: availableSessions });
    }
    if (u === '/parent-hub/claims' && q.method === 'POST') {
      const body = await readJson(q);
      const name = String(body.player_name || '').trim(), dob = String(body.date_of_birth || '').trim(), relationship = String(body.relationship || 'Parent').trim();
      if (!name || !dob) return send(r, 400, { error: "Child's name and date of birth are required." });
      const norm = name.trim().toLowerCase().replace(/\s+/g, ' ');
      const matches = PLAYERS.filter(p => p.name.trim().toLowerCase().replace(/\s+/g, ' ') === norm && p.dob === dob);
      const id = 'link' + (linkSeq++);
      if (matches.length === 1) {
        links.push({ id, parentEmail: caller.email, playerId: matches[0].id, playerName: matches[0].name, dob, relationship, status: 'Pending', notes: '' });
        return send(r, 200, { ok: true, status: 'Pending' });
      }
      const note = matches.length === 0 ? `No matching active Player record found for "${name}", DOB ${dob}.` : `Matched ${matches.length} Player records (ambiguous) for "${name}", DOB ${dob}.`;
      links.push({ id, parentEmail: caller.email, playerId: '', playerName: '', dob, relationship, status: 'Needs Review', notes: note, claimedName: name });
      return send(r, 200, { ok: true, status: 'Needs Review' });
    }
    if (u === '/parent-hub/session-requests' && q.method === 'POST') {
      const body = await readJson(q);
      const playerId = String(body.player_record_id || ''), sessionId = String(body.session_record_id || '');
      if (!playerId || !sessionId) return send(r, 400, { error: 'Player and session are required.' });
      const owns = links.some(l => l.parentEmail === caller.email && l.playerId === playerId && l.status === 'Verified');
      if (!owns) return send(r, 403, { error: 'You can only request sessions for your own verified children.' });
      const session = SESSIONS.find(s => s.id === sessionId);
      if (!session) return send(r, 400, { error: 'That session is not available.' });
      sessionRequests.push({ playerId, sessionId, parentEmail: caller.email });
      return send(r, 200, { ok: true });
    }
    if (u === '/parent-hub/claims/pending' && q.method === 'GET') {
      if (caller.role !== 'management') return send(r, 403, { error: 'Management access required' });
      const pending = links.filter(l => l.status === 'Pending' || l.status === 'Needs Review').map(l => ({
        link_id: l.id, status: l.status, parent_name: l.parentEmail, parent_email: l.parentEmail,
        player_record_id: l.playerId || '', player_name: l.playerName || (l.claimedName ? l.claimedName + ' (unmatched)' : ''), relationship: l.relationship, notes: l.notes || ''
      }));
      return send(r, 200, { pending, players: PLAYERS.map(p => ({ player_record_id: p.id, player_name: p.name })) });
    }
    const approveMatch = u.match(/^\/parent-hub\/claims\/([^/]+)\/approve$/);
    if (approveMatch && q.method === 'POST') {
      if (caller.role !== 'management') return send(r, 403, { error: 'Management access required' });
      const link = links.find(l => l.id === approveMatch[1]);
      if (!link) return send(r, 404, { error: 'Claim not found' });
      if (link.status === 'Verified' || link.status === 'Rejected') return send(r, 400, { error: `Claim is already ${link.status}` });
      const body = await readJson(q);
      if (body.player_record_id) {
        const p = PLAYERS.find(pp => pp.id === body.player_record_id);
        link.playerId = body.player_record_id; link.playerName = p ? p.name : '';
      } else if (!link.playerId) {
        return send(r, 400, { error: 'This claim has no player linked yet - pick one before approving.' });
      }
      link.status = 'Verified';
      return send(r, 200, { ok: true });
    }
    const rejectMatch = u.match(/^\/parent-hub\/claims\/([^/]+)\/reject$/);
    if (rejectMatch && q.method === 'POST') {
      if (caller.role !== 'management') return send(r, 403, { error: 'Management access required' });
      const link = links.find(l => l.id === rejectMatch[1]);
      if (!link) return send(r, 404, { error: 'Claim not found' });
      if (link.status === 'Verified' || link.status === 'Rejected') return send(r, 400, { error: `Claim is already ${link.status}` });
      link.status = 'Rejected';
      return send(r, 200, { ok: true });
    }

    return serveStatic(q, r, u, ROOT);
  });
  return new Promise(res => srv.listen(port, () => res(srv)));
};
