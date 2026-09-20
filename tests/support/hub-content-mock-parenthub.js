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
// Schedule detail mirrors the real /me shape: the Airtable Session record
// (id/name) joined to its published Sessions-sheet row and Venues record.
// sess3 deliberately has no day/time at all, to exercise "omit the row
// rather than invent a date".
const SESSIONS = [
  { id: 'sess1', name: 'U9/10 Development', day: 'Wednesday', time: '4:00pm - 5:30pm', venue: "City of London Freemen's", address: 'Ashtead, Surrey', coaches: ['David'], age_group: 'U9/10', programme: 'Evening',
    venue_info: { address: 'Park Lane, Ashtead', postcode: 'KT21 1ET', parking: 'Use the main school car park.', meeting_point: 'Astro gate', access: '', notes: '' } },
  { id: 'sess2', name: 'U11/12 Academy', day: 'Thursday', time: '6:00pm - 7:30pm', venue: 'Therfield School', address: 'Leatherhead', coaches: ['David', 'Charlie'], age_group: 'U11/12', programme: 'Evening', venue_info: null },
  { id: 'sess3', name: 'U13/14 Development', day: '', time: '', venue: '', address: '', coaches: [], age_group: '', programme: '', venue_info: null }
];

// Published+Active is the ONLY thing a parent may see - the draft and the
// archived record below must never reach the parent client.
const FEEDBACK = [
  { id: 'fb-pub-1', playerId: 'plyr1', date: '2026-09-20', coach: 'Coach David', published: true, active: true, session_name: 'U9/10 Development',
    keep_doing: 'Being you.', big_focus: 'Hard work.', summary: 'Been a joy to coach this year.',
    ratings: [
      { framework_item_id: 'fi1', name: 'Winners', group: 'Characteristics', sort_order: 1, rating: 'Green', notes: '' },
      { framework_item_id: 'fi2', name: 'Movers', group: 'Characteristics', sort_order: 2, rating: 'Blue', notes: '' },
      { framework_item_id: 'fi3', name: 'Passing & Receiving', group: 'Football Pillars', sort_order: 3, rating: 'Amber', notes: '' }
    ] },
  { id: 'fb-pub-2', playerId: 'plyr1', date: '2026-08-31', coach: 'Demo Coach', published: true, active: true, session_name: 'U9/10 Development',
    keep_doing: 'Great attitude.', big_focus: 'First touch.', summary: 'Second review showing progress.', ratings: [] },
  { id: 'fb-draft', playerId: 'plyr1', date: '2026-09-25', coach: 'Coach David', published: false, active: true, session_name: 'U9/10 Development',
    keep_doing: 'DRAFT-KEEP-DOING', big_focus: 'DRAFT-FOCUS', summary: 'DRAFT-SUMMARY', ratings: [] },
  { id: 'fb-archived', playerId: 'plyr1', date: '2026-07-01', coach: 'Coach David', published: true, active: false, session_name: 'U9/10 Development',
    keep_doing: 'ARCHIVED-KEEP-DOING', big_focus: 'ARCHIVED-FOCUS', summary: 'ARCHIVED-SUMMARY', ratings: [] },
  { id: 'fb-other-child', playerId: 'plyr2', date: '2026-09-19', coach: 'Coach David', published: true, active: true, session_name: 'U11/12 Academy',
    keep_doing: 'OTHER-CHILD-KEEP-DOING', big_focus: 'OTHER-CHILD-FOCUS', summary: 'OTHER-CHILD-SUMMARY', ratings: [] }
];

const FEEDBACK_SETTINGS = {
  framework_name: 'Player Development Framework', intro_text: '',
  blue_label: 'Consistently strong', green_label: 'Often good', amber_label: 'Developing', red_label: 'Needs focus',
  show_keep_doing: true, show_my_focus: true, show_general_feedback: true, per_area_written_feedback: false
};

let linkSeq = 1;
let requestSeq = 1;
const links = []; // {id, parentEmail, playerId, playerName, dob, relationship, status, notes}
const sessionRequests = []; // {id, playerId, sessionId, parentEmail, status}
const sessionLinks = []; // {playerId, sessionId, status: 'Active'|'Ended'} - pre-seed via module.exports.sessionLinks.push(...) in a test

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
module.exports.sessionLinks = sessionLinks;
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

    // Parent-only routes - mirrors the real deployed parent-hub function's
    // explicit role check, not just the frontend hiding buttons.
    if ((u === '/parent-hub/me' || u === '/parent-hub/claims' || u === '/parent-hub/session-requests' || u === '/parent-hub/feedback') && caller.role !== 'parent') {
      return send(r, 403, { error: 'Parent access required' });
    }

    if (u === '/parent-hub/me' && q.method === 'GET') {
      const mine = links.filter(l => l.parentEmail === caller.email);
      const sessionPayload = (id) => {
        const s = SESSIONS.find(x => x.id === id) || {};
        return {
          session_record_id: id, session_id: id, session_name: s.name || '',
          programme: s.programme || '', category: '', age_group: s.age_group || '',
          day: s.day || '', time: s.time || '', venue: s.venue || '', address: s.address || '',
          coaches: s.coaches || [], venue_info: s.venue_info || null
        };
      };
      const children = mine.filter(l => l.status === 'Verified').map(l => ({
        link_id: l.id, player_record_id: l.playerId, player_id: l.playerId, name: l.playerName, photo_url: '', relationship: l.relationship,
        active_sessions: sessionLinks.filter(sl => sl.playerId === l.playerId && sl.status === 'Active').map(sl => Object.assign(sessionPayload(sl.sessionId), { start_date: '2026-09-01' })),
        ended_sessions: sessionLinks.filter(sl => sl.playerId === l.playerId && sl.status === 'Ended').map(sl => ({ session_record_id: sl.sessionId, session_name: (SESSIONS.find(s => s.id === sl.sessionId) || {}).name || '', end_date: '2026-06-30' })),
        pending_requests: sessionRequests.filter(sr => sr.playerId === l.playerId && sr.status === 'Pending').map(sr => ({ request_id: sr.id, session_record_id: sr.sessionId, session_name: (SESSIONS.find(s => s.id === sr.sessionId) || {}).name || '', requested_date: '2026-01-01' })),
      }));
      const pendingClaims = mine.filter(l => l.status !== 'Verified').map(l => ({ link_id: l.id, player_name: l.playerName || 'Claim submitted', status: l.status, relationship: l.relationship }));
      const availableSessions = SESSIONS.map(s => ({ session_record_id: s.id, session_name: s.name, day: s.day || '', time: s.time || '', venue: s.venue || '', age_group: s.age_group || '', programme: s.programme || '' }));
      return send(r, 200, { parent_id: 'PARENT-' + caller.email, children, pending_claims: pendingClaims, available_sessions: availableSessions });
    }
    // Mirrors the real function's three gates: parent role (above), the
    // player must be one of THIS caller's Verified children, and only
    // Published + Active feedback is ever returned.
    if (u === '/parent-hub/feedback' && q.method === 'GET') {
      const playerId = new URLSearchParams(q.url.split('?')[1] || '').get('player_record_id') || '';
      if (!playerId) return send(r, 400, { error: 'player_record_id is required' });
      const owns = links.some(l => l.parentEmail === caller.email && l.playerId === playerId && l.status === 'Verified');
      if (!owns) return send(r, 403, { error: 'You can only view feedback for your own verified children.' });
      const feedback = FEEDBACK
        .filter(f => f.playerId === playerId && f.published === true && f.active === true)
        .map(f => ({
          feedback_id: f.id, date: f.date, title: '', coach_name: f.coach, session_name: f.session_name,
          summary: FEEDBACK_SETTINGS.show_general_feedback ? f.summary : '',
          keep_doing: FEEDBACK_SETTINGS.show_keep_doing ? f.keep_doing : '',
          big_focus: FEEDBACK_SETTINGS.show_my_focus ? f.big_focus : '',
          ratings: f.ratings || []
        }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return send(r, 200, { settings: FEEDBACK_SETTINGS, feedback });
    }
    if (u === '/parent-hub/claims' && q.method === 'POST') {
      const body = await readJson(q);
      const name = String(body.player_name || '').trim(), dob = String(body.date_of_birth || '').trim(), relationship = String(body.relationship || 'Parent').trim();
      if (!name || !dob) return send(r, 400, { error: "Child's name and date of birth are required." });
      const norm = name.trim().toLowerCase().replace(/\s+/g, ' ');
      const matches = PLAYERS.filter(p => p.name.trim().toLowerCase().replace(/\s+/g, ' ') === norm && p.dob === dob);

      // Same duplicate check as the real function: this parent's own
      // non-Rejected links, compared by the linked player's real name+dob,
      // or (for a not-yet-resolved claim) by re-parsing the same note text
      // this route itself writes below.
      const myOpenLinks = links.filter(l => l.parentEmail === caller.email && l.status !== 'Rejected');
      const alreadyClaimed = myOpenLinks.some(l => {
        if (l.playerId) {
          const p = PLAYERS.find(pp => pp.id === l.playerId);
          return !!p && p.name.trim().toLowerCase().replace(/\s+/g, ' ') === norm && p.dob === dob;
        }
        const m = /Parent-entered claim: "([^"]*)", DOB (\S+)/.exec(l.notes || '');
        return !!m && m[1].trim().toLowerCase().replace(/\s+/g, ' ') === norm && m[2] === dob;
      });
      if (alreadyClaimed) return send(r, 400, { error: "You've already submitted a claim for this child." });

      const id = 'link' + (linkSeq++);
      if (matches.length === 1) {
        links.push({ id, parentEmail: caller.email, playerId: matches[0].id, playerName: matches[0].name, dob, relationship, status: 'Pending', notes: '' });
        return send(r, 200, { ok: true, status: 'Pending' });
      }
      const note = matches.length === 0
        ? `Parent-entered claim: "${name}", DOB ${dob} - no matching active Player record found. Find or create the Player, link them on this record, then approve.`
        : `Parent-entered claim: "${name}", DOB ${dob} - matched ${matches.length} Player records (ambiguous).`;
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
      const alreadyActive = sessionLinks.some(sl => sl.playerId === playerId && sl.sessionId === sessionId && sl.status === 'Active');
      if (alreadyActive) return send(r, 400, { error: 'This child is already linked to that session.' });
      const alreadyPending = sessionRequests.some(sr => sr.playerId === playerId && sr.sessionId === sessionId && sr.status === 'Pending');
      if (alreadyPending) return send(r, 400, { error: 'A request for this session is already pending.' });
      sessionRequests.push({ id: 'req' + (requestSeq++), playerId, sessionId, parentEmail: caller.email, status: 'Pending' });
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
