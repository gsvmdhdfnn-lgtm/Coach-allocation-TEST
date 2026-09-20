import { CFG, DEMO, approveCoachUrl, esc, fetchCsv, load, money, parentHubUrl, playerSessionsUrl, root, setNav, state, toast, withAccessToken } from './core.js';

export function renderManagement(){state.screen='management';setNav('management');if(state.unlocked){renderManagementDashboard();return}root.innerHTML='<section class="locked"><div class="page-title"><h1>Management Access</h1><p>Financials & administration. Restricted to authorised users.</p></div><div class="management-card"><h2>🔒 Enter password</h2><p style="color:var(--muted);font-size:12px">This uses the same protected Financials connection as the existing Hub.</p><div class="pw"><input id="pw" type="password" placeholder="Password"><button data-action="unlock">Access</button></div><p id="pw-error" style="color:var(--red);font-size:12px"></p></div><div class="card support-list" style="margin-top:14px;background:rgba(255,255,255,.98);color:var(--ink)"><div class="support-row"><span class="support-icon">▣</span><span><b>Full schedule view</b><small>All coaches, all sessions</small></span><span>›</span></div><div class="support-row"><span class="support-icon">▤</span><span><b>Financial dashboard</b><small>Live and historical data</small></span><span>›</span></div><div class="support-row"><span class="support-icon">●</span><span><b>Coach management</b><small>Hours, rates and costs</small></span><span>›</span></div></div></section>'}

export function renderManagementDashboard(){var fs=state.financials||{};var rows=Object.values(fs),rev=rows.reduce(function(a,r){return a+(+r.revenue_net||0)},0),profit=rows.reduce(function(a,r){return a+(+r.profit||0)},0);root.innerHTML='<section class="locked"><div class="page-title"><h1>Management Dashboard</h1><p>Schedules, financials and administration.</p></div><div class="kpi-grid"><div class="kpi"><small>Sessions</small><b>'+state.sessions.length+'</b></div><div class="kpi"><small>Revenue</small><b>'+money(rev)+'</b></div><div class="kpi"><small>Profit</small><b>'+money(profit)+'</b></div><div class="kpi"><small>Coaches</small><b>'+new Set(state.sessions.flatMap(function(s){return s.coaches})).size+'</b></div></div><div class="card support-list" style="color:var(--ink)"><div class="support-row"><span class="support-icon">▣</span><span><b>Full schedule view</b><small>All coaches, all sessions</small></span><span>›</span></div><div class="support-row"><span class="support-icon">£</span><span><b>Financial dashboard</b><small>Baseline, actual and archive</small></span><span>›</span></div><div class="support-row"><span class="support-icon">●</span><span><b>Coach management</b><small>Hours, rates and costs</small></span><span>›</span></div><div class="support-row"><span class="support-icon">▧</span><span><b>Reports & exports</b><small>P&L, attendance and more</small></span><span>›</span></div></div></section>'}
/**
 * approve-coach is a separate Edge Function/authorisation boundary from the
 * financials password above: it checks the signed-in user's own Supabase
 * profile role==='management' server-side, not this screen's client-side
 * gate (which only saves a management user a wasted trip).
 */

export function renderCoachManagement(){
 state.screen='coach-management';setNav('coach-management');
 if(state.role!=='management'){root.innerHTML='<section class="locked"><div class="page-title"><h1>Coach Management</h1><p>Restricted to management accounts.</p></div><div class="card" style="padding:16px;color:var(--ink);font-size:12px">Your account isn’t set up for management access.</div></section>';return}
 root.innerHTML='<section class="locked"><div class="page-title"><h1>Coach Management</h1><p>Approve staff sign-ups. Approving links or creates their Coach record automatically.</p></div><div id="pending-coach-list"><div class="loading">Loading pending sign-ups…</div></div></section>';
 loadPendingCoaches();
}

export function loadPendingCoaches(){
 var listEl=document.getElementById('pending-coach-list');
 withAccessToken().then(function(token){
  return fetch(approveCoachUrl()+'/pending',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load pending sign-ups.');return body});
 }).then(function(list){
  if(document.getElementById('pending-coach-list'))renderPendingCoachList(list);
 }).catch(function(e){
  if(listEl)listEl.innerHTML='<div class="error"><b>Couldn’t load pending sign-ups.</b><br>'+esc(e.message||'')+'</div>';
 });
}

export function renderPendingCoachList(list){
 var listEl=document.getElementById('pending-coach-list');
 if(!listEl)return;
 if(!list||!list.length){listEl.innerHTML='<div class="schedule-empty">No staff sign-ups waiting for approval.</div>';return}
 listEl.innerHTML='<div class="card pending-list">'+list.map(function(u){
  var when=u.created_at?new Date(u.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'';
  return '<div class="pending-row" data-pending-row="'+esc(u.user_id)+'">'+
   '<span><b>'+esc(u.email||'(no email on file)')+'</b><small>Signed up '+esc(when)+'</small><small class="pending-error" hidden></small></span>'+
   '<button class="primary-btn approve-btn" data-action="approve-coach" data-user-id="'+esc(u.user_id)+'">Approve</button>'+
  '</div>';
 }).join('')+'</div>';
}

export function approveCoach(userId,btn){
 var row=btn.closest('.pending-row'),errEl=row&&row.querySelector('.pending-error');
 btn.disabled=true;btn.textContent='Approving…';
 if(errEl){errEl.hidden=true;errEl.textContent=''}
 withAccessToken().then(function(token){
  return fetch(approveCoachUrl(),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({user_id:userId})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not approve this coach.');return body});
 }).then(function(){
  toast('Coach approved');
  if(row)row.remove();
  var list=document.querySelector('.pending-list');
  if(list&&!list.children.length)renderPendingCoachList([]);
 }).catch(function(e){
  btn.disabled=false;btn.textContent='Approve';
  if(errEl){errEl.hidden=false;errEl.textContent=e.message||'Could not approve this coach.'}
 });
}
/**
 * Management-only: review Pending Player Session Requests (created by a
 * parent choosing sessions for their child - Phase 2, not built yet; for
 * now these are created directly in Airtable for testing). Approving
 * creates the real Active Player Session Link; nothing here ever writes
 * one directly - see the player-sessions Edge Function.
 */

export function renderSessionRequests(){
 state.screen='session-requests';setNav('session-requests');
 if(state.role!=='management'){root.innerHTML='<section class="locked"><div class="page-title"><h1>Session Requests</h1><p>Restricted to management accounts.</p></div><div class="card" style="padding:16px;color:var(--ink);font-size:12px">Your account isn’t set up for management access.</div></section>';return}
 root.innerHTML='<section class="locked"><div class="page-title"><h1>Session Requests</h1><p>Approve, reject or amend which session a player has requested.</p></div>'+
  '<button class="secondary-btn" data-action="sync-sessions" style="margin-bottom:12px">Sync Sessions from schedule</button>'+
  '<div id="session-requests-list"><div class="loading">Loading requests…</div></div></section>';
 loadSessionRequests();
}

export function loadSessionRequests(){
 var listEl=document.getElementById('session-requests-list');
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/requests',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load session requests.');return body});
 }).then(function(body){
  if(document.getElementById('session-requests-list'))renderSessionRequestsList(body.pending||[],body.sessions||[]);
 }).catch(function(e){
  if(listEl)listEl.innerHTML='<div class="error"><b>Couldn’t load session requests.</b><br>'+esc(e.message||'')+'</div>';
 });
}

export function renderSessionRequestsList(pending,sessions){
 var listEl=document.getElementById('session-requests-list');
 if(!listEl)return;
 if(!pending.length){listEl.innerHTML='<div class="schedule-empty">No session requests waiting for review.</div>';return}
 var options=sessions.map(function(s){return '<option value="'+esc(s.session_record_id)+'">'+esc(s.session_name)+'</option>'}).join('');
 listEl.innerHTML='<div class="card request-list">'+pending.map(function(req){
  var when=req.requested_date?new Date(req.requested_date).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'';
  return '<div class="request-row" data-request-row="'+esc(req.request_id)+'">'+
   '<div><b>'+esc(req.player_name)+'</b><small>Requested '+esc(when)+'</small><small class="request-error" hidden></small></div>'+
   '<select class="request-session-select">'+options.replace('value="'+esc(req.session_record_id)+'"','value="'+esc(req.session_record_id)+'" selected')+'</select>'+
   '<div class="request-actions">'+
    '<button class="primary-btn approve-btn" data-action="approve-session-request" data-request-id="'+esc(req.request_id)+'">Approve</button>'+
    '<button class="secondary-btn reject-btn" data-action="reject-session-request" data-request-id="'+esc(req.request_id)+'">Reject</button>'+
   '</div>'+
  '</div>';
 }).join('')+'</div>';
}

export function approveSessionRequest(requestId,btn){
 var row=btn.closest('.request-row'),errEl=row&&row.querySelector('.request-error'),select=row&&row.querySelector('.request-session-select');
 var sessionId=select?select.value:'';
 row.querySelectorAll('button').forEach(function(b){b.disabled=true});
 btn.textContent='Approving…';
 if(errEl){errEl.hidden=true;errEl.textContent=''}
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/requests/'+encodeURIComponent(requestId)+'/approve',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({session_record_id:sessionId})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not approve this request.');return body});
 }).then(function(){
  toast('Session request approved');
  if(row)row.remove();
  var list=document.querySelector('.request-list');
  if(list&&!list.children.length)renderSessionRequestsList([],[]);
 }).catch(function(e){
  row.querySelectorAll('button').forEach(function(b){b.disabled=false});
  btn.textContent='Approve';
  if(errEl){errEl.hidden=false;errEl.textContent=e.message||'Could not approve this request.'}
 });
}

export function rejectSessionRequest(requestId,btn){
 var row=btn.closest('.request-row'),errEl=row&&row.querySelector('.request-error');
 row.querySelectorAll('button').forEach(function(b){b.disabled=true});
 btn.textContent='Rejecting…';
 if(errEl){errEl.hidden=true;errEl.textContent=''}
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/requests/'+encodeURIComponent(requestId)+'/reject',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not reject this request.');return body});
 }).then(function(){
  toast('Session request rejected');
  if(row)row.remove();
  var list=document.querySelector('.request-list');
  if(list&&!list.children.length)renderSessionRequestsList([],[]);
 }).catch(function(e){
  row.querySelectorAll('button').forEach(function(b){b.disabled=false});
  btn.textContent='Reject';
  if(errEl){errEl.hidden=false;errEl.textContent=e.message||'Could not reject this request.'}
 });
}

export function syncSessions(btn){
 var originalText=btn.textContent;
 btn.disabled=true;btn.textContent='Syncing…';
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/sync',{method:'POST',headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Sync failed.');return body});
 }).then(function(body){
  toast('Synced — '+(body.created||0)+' new, '+(body.updated||0)+' updated, '+(body.archived||0)+' archived');
  loadSessionRequests();
 }).catch(function(e){
  toast(e.message||'Sync failed');
 }).finally(function(){
  btn.disabled=false;btn.textContent=originalText;
 });
}
/** Re-fetches just the players list (not the whole hub) and re-renders My Players. */

export function renderPlayerMigration(){
 state.screen='player-migration';setNav('player-migration');
 if(state.role!=='management'){root.innerHTML='<section class="locked"><div class="page-title"><h1>Player Migration</h1><p>Restricted to management accounts.</p></div><div class="card" style="padding:16px;color:var(--ink);font-size:12px">Your account isn’t set up for management access.</div></section>';return}
 root.innerHTML='<section class="locked"><div class="page-title"><h1>Player Migration</h1><p>Preview which existing players can be linked onto the new session system before anything is committed.</p></div><div id="migration-list"><div class="loading">Loading preview…</div></div></section>';
 loadMigrationPreview();
}

export function loadMigrationPreview(){
 var listEl=document.getElementById('migration-list');
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/migration/preview',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load migration preview.');return body});
 }).then(function(body){
  if(document.getElementById('migration-list'))renderMigrationPreviewBody(body);
 }).catch(function(e){
  if(listEl)listEl.innerHTML='<div class="error"><b>Couldn’t load migration preview.</b><br>'+esc(e.message||'')+'</div>';
 });
}

export function renderMigrationPreviewBody(data){
 var listEl=document.getElementById('migration-list');
 if(!listEl)return;
 var matched=data.matched||[],ambiguous=data.ambiguous||[],unmatched=data.unmatched||[];
 if(!matched.length&&!ambiguous.length&&!unmatched.length){listEl.innerHTML='<div class="schedule-empty">Every current player is already linked to a session — nothing to migrate.</div>';return}
 var html='';
 if(matched.length){
  html+='<div class="migration-section"><h3>Matched ('+matched.length+')</h3><p>Exact match to a session name — ready to link.</p><div class="card migration-card">'+matched.map(function(m){
   return '<label class="migration-row"><input type="checkbox" class="migration-check" data-player="'+esc(m.player_record_id)+'" data-session="'+esc(m.session_record_id)+'" checked><span><b>'+esc(m.player_name)+'</b><small>→ '+esc(m.session_name)+'</small></span></label>';
  }).join('')+'</div></div>';
 }
 if(ambiguous.length){
  html+='<div class="migration-section"><h3>Needs a pick ('+ambiguous.length+')</h3><p>More than one session looks close — choose the right one, then tick to include.</p><div class="card migration-card">'+ambiguous.map(function(m){
   var options=(m.candidates||[]).map(function(c){return '<option value="'+esc(c.session_record_id)+'">'+esc(c.session_name)+'</option>'}).join('');
   return '<div class="migration-row migration-row-ambiguous"><input type="checkbox" class="migration-check" data-player="'+esc(m.player_record_id)+'"><span><b>'+esc(m.player_name)+'</b><small>Team/Session: "'+esc(m.team_session_text)+'"</small></span><select class="migration-select">'+options+'</select></div>';
  }).join('')+'</div></div>';
 }
 if(unmatched.length){
  html+='<div class="migration-section"><h3>No match ('+unmatched.length+')</h3><p>Nothing close enough — fix the Team / Session text or add the session first, then come back.</p><div class="card migration-card">'+unmatched.map(function(m){
   return '<div class="migration-row migration-row-unmatched"><span><b>'+esc(m.player_name)+'</b><small>'+esc(m.reason)+'</small></span></div>';
  }).join('')+'</div></div>';
 }
 if(matched.length||ambiguous.length){
  html+='<button class="primary-btn" data-action="migrate-commit" style="margin-top:4px">Migrate Selected</button>';
 }
 listEl.innerHTML=html;
}

export function commitMigration(btn){
 var rows=document.querySelectorAll('#migration-list .migration-check:checked'),links=[];
 rows.forEach(function(cb){
  var row=cb.closest('.migration-row'),select=row.querySelector('.migration-select');
  var sessionId=select?select.value:cb.dataset.session;
  if(sessionId)links.push({player_record_id:cb.dataset.player,session_record_id:sessionId});
 });
 if(!links.length){toast('Nothing selected to migrate');return}
 var originalText=btn.textContent;
 btn.disabled=true;btn.textContent='Migrating…';
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/migration/commit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({links:links})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Migration failed.');return body});
 }).then(function(body){
  toast((body.committed||0)+' player'+(body.committed===1?'':'s')+' linked to their session'+(body.committed===1?'':'s'));
  loadMigrationPreview();
 }).catch(function(e){
  toast(e.message||'Migration failed');
 }).finally(function(){
  btn.disabled=false;btn.textContent=originalText;
 });
}
/**
 * Parent Hub: children (Verified claims), pending/rejected claims (zero
 * access, surfaced so a parent can see where a claim stands) and the
 * Request a session action, which reuses Phase 1's Player Session
 * Requests system untouched - the management Session Requests screen
 * picks these up with no changes. Claiming a child never links a Player
 * directly; only management's approval (Management Parent Claims screen)
 * sets a link to Verified.
 */

export function renderParentClaims(){
 state.screen='parent-claims';setNav('parent-claims');
 if(state.role!=='management'){root.innerHTML='<section class="locked"><div class="page-title"><h1>Parent Claims</h1><p>Restricted to management accounts.</p></div><div class="card" style="padding:16px;color:var(--ink);font-size:12px">Your account isn’t set up for management access.</div></section>';return}
 root.innerHTML='<section class="locked"><div class="page-title"><h1>Parent Claims</h1><p>Approve or reject a parent’s claim to their child. A claim with no clear match needs a player picked before it can be approved.</p></div><div id="parent-claims-list"><div class="loading">Loading claims…</div></div></section>';
 loadParentClaims();
}

export function loadParentClaims(){
 var listEl=document.getElementById('parent-claims-list');
 withAccessToken().then(function(token){
  return fetch(parentHubUrl()+'/claims/pending',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load parent claims.');return body});
 }).then(function(body){
  if(document.getElementById('parent-claims-list'))renderParentClaimsList(body.pending||[],body.players||[]);
 }).catch(function(e){
  if(listEl)listEl.innerHTML='<div class="error"><b>Couldn’t load parent claims.</b><br>'+esc(e.message||'')+'</div>';
 });
}

export function renderParentClaimsList(pending,players){
 var listEl=document.getElementById('parent-claims-list');
 if(!listEl)return;
 if(!pending.length){listEl.innerHTML='<div class="schedule-empty">No parent claims waiting for review.</div>';return}
 var options='<option value="">Choose a player…</option>'+players.map(function(p){return '<option value="'+esc(p.player_record_id)+'">'+esc(p.player_name)+'</option>'}).join('');
 listEl.innerHTML='<div class="card request-list">'+pending.map(function(c){
  var needsPick=!c.player_record_id;
  return '<div class="request-row" data-claim-row="'+esc(c.link_id)+'">'+
   '<div><b>'+esc(c.player_name||'Claim needs a player match')+'</b><small>'+esc(c.parent_name||'')+(c.parent_email?' · '+c.parent_email:'')+'</small><small class="player-tier '+(c.status==='Needs Review'?'is-cover':'')+'">'+esc(c.status)+(c.relationship?' · '+c.relationship:'')+'</small>'+(c.notes?'<small>'+esc(c.notes)+'</small>':'')+'<small class="request-error" hidden></small></div>'+
   (needsPick?'<select class="request-session-select claim-player-select">'+options+'</select>':'')+
   '<div class="request-actions">'+
    '<button class="primary-btn approve-btn" data-action="approve-parent-claim" data-link-id="'+esc(c.link_id)+'">Approve</button>'+
    '<button class="secondary-btn reject-btn" data-action="reject-parent-claim" data-link-id="'+esc(c.link_id)+'">Reject</button>'+
   '</div>'+
  '</div>';
 }).join('')+'</div>';
}

export function approveParentClaim(linkId,btn){
 var row=btn.closest('.request-row'),errEl=row&&row.querySelector('.request-error'),select=row&&row.querySelector('.claim-player-select');
 if(select&&!select.value){if(errEl){errEl.hidden=false;errEl.textContent='Pick a player before approving.'}return}
 row.querySelectorAll('button').forEach(function(b){b.disabled=true});
 btn.textContent='Approving…';
 if(errEl){errEl.hidden=true;errEl.textContent=''}
 withAccessToken().then(function(token){
  return fetch(parentHubUrl()+'/claims/'+encodeURIComponent(linkId)+'/approve',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(select?{player_record_id:select.value}:{})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not approve this claim.');return body});
 }).then(function(){
  toast('Claim approved');
  if(row)row.remove();
  var list=document.querySelector('#parent-claims-list .request-list');
  if(list&&!list.children.length)renderParentClaimsList([],[]);
 }).catch(function(e){
  row.querySelectorAll('button').forEach(function(b){b.disabled=false});
  btn.textContent='Approve';
  if(errEl){errEl.hidden=false;errEl.textContent=e.message||'Could not approve this claim.'}
 });
}

export function rejectParentClaim(linkId,btn){
 var row=btn.closest('.request-row'),errEl=row&&row.querySelector('.request-error');
 row.querySelectorAll('button').forEach(function(b){b.disabled=true});
 btn.textContent='Rejecting…';
 if(errEl){errEl.hidden=true;errEl.textContent=''}
 withAccessToken().then(function(token){
  return fetch(parentHubUrl()+'/claims/'+encodeURIComponent(linkId)+'/reject',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not reject this claim.');return body});
 }).then(function(){
  toast('Claim rejected');
  if(row)row.remove();
  var list=document.querySelector('#parent-claims-list .request-list');
  if(list&&!list.children.length)renderParentClaimsList([],[]);
 }).catch(function(e){
  row.querySelectorAll('button').forEach(function(b){b.disabled=false});
  btn.textContent='Reject';
  if(errEl){errEl.hidden=false;errEl.textContent=e.message||'Could not reject this claim.'}
 });
}

export function b64(b){var bin=atob(String(b).replace(/\s+/g,'')),o=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)o[i]=bin.charCodeAt(i);return o}

export function unlock(pw){if(DEMO){state.unlocked=true;renderManagementDashboard();return}var f=CFG.financials;if(!f||!f.ciphertext){document.getElementById('pw-error').textContent='Financial connection is not configured.';return}crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']).then(function(base){return crypto.subtle.deriveKey({name:'PBKDF2',salt:b64(f.salt),iterations:f.iterations||250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['decrypt'])}).then(function(key){return crypto.subtle.decrypt({name:'AES-GCM',iv:b64(f.iv)},key,b64(f.ciphertext))}).then(function(buf){return fetchCsv(new TextDecoder().decode(buf).trim())}).then(function(rows){state.financials={};rows.forEach(function(r){if(r.session_id)state.financials[r.session_id]=r});state.unlocked=true;renderManagementDashboard()}).catch(function(){document.getElementById('pw-error').textContent='Incorrect password.'})}
