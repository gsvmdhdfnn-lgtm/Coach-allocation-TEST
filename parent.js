import { closeSheet, esc, hubName, load, parentHubUrl, root, sheet, sheetContent, state, toast, withAccessToken } from './core.js';
import { playerInitials } from './coach.js';

export function renderParentHub(){
 state.screen='parent-home';
 if(!state.parentHubLoaded){root.innerHTML='<div class="loading">Loading your hub…</div>';loadParentHub();return}
 var d=state.parentHub||{},children=d.children||[],pending=d.pending_claims||[];
 root.innerHTML='<div class="page-title"><h1>'+esc(hubName())+'</h1><p>Your children and session requests.</p></div>'+
  '<section class="card parent-children-list">'+
   (children.length?children.map(parentChildRowHtml).join(''):'<div class="schedule-empty">No children linked to your account yet. Use Claim a Child below to get started.</div>')+
  '</section>'+
  (pending.length?'<div class="page-title" style="margin-top:18px"><h2 style="font-size:16px;margin:0">Pending claims</h2></div><section class="card parent-pending-list">'+pending.map(parentClaimRowHtml).join('')+'</section>':'')+
  '<button class="primary-btn" data-action="open-claim-child" style="margin-top:16px">+ Claim a Child</button>';
}

export function loadParentHub(){
 withAccessToken().then(function(token){
  return fetch(parentHubUrl()+'/me',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load your hub.');return body});
 }).then(function(body){
  state.parentHub=body;state.parentHubLoaded=true;
  if(state.role==='parent')renderParentHub();
 }).catch(function(e){
  root.innerHTML='<div class="error"><b>Couldn’t load your hub.</b><br>'+esc(e.message||'')+'<br><button class="primary-btn error-retry" data-action="retry-parent-hub">Try again</button></div>';
 });
}

export function parentChildRowHtml(c){
 var avatar=c.photo_url?'<img src="'+esc(c.photo_url)+'" alt="">':'<span>'+esc(playerInitials(c.name))+'</span>';
 return '<div class="player-row"><span class="player-avatar'+(c.photo_url?' has-photo':'')+'">'+avatar+'</span><span><b>'+esc(c.name)+'</b>'+(c.relationship?'<small class="player-tier">'+esc(c.relationship)+'</small>':'')+'</span><button class="secondary-btn" data-action="open-request-session" data-player-id="'+esc(c.player_record_id)+'" data-player-name="'+esc(c.name)+'">Request a session</button></div>';
}

export function parentClaimStatusLabel(status){return status==='Needs Review'?'Needs review':status==='Rejected'?'Rejected':'Pending'}

export function parentClaimRowHtml(c){
 var cls=c.status==='Rejected'?'is-former':'is-cover';
 return '<div class="request-row"><div><b>'+esc(c.player_name||'Claim submitted')+'</b><small class="player-tier '+cls+'">'+esc(parentClaimStatusLabel(c.status))+'</small></div></div>';
}

export function openClaimChildSheet(){
 sheet.hidden=false;
 sheetContent.innerHTML='<div class="calendar-sheet"><h3>Claim a Child</h3><p>We’ll match this to their player record. Management will confirm it before you get access.</p>'+
  '<div class="parent-form">'+
  '<label class="auth-field">Child’s full name<input id="claim-name" autocomplete="off"></label>'+
  '<label class="auth-field">Date of birth<input id="claim-dob" type="date"></label>'+
  '<label class="auth-field">Relationship<select id="claim-relationship"><option value="Parent">Parent</option><option value="Guardian">Guardian</option><option value="Grandparent">Grandparent</option><option value="Carer">Carer</option><option value="Other">Other</option></select></label>'+
  '<p class="auth-error" id="claim-error" hidden></p>'+
  '<button class="primary-btn" data-action="submit-claim">Submit claim</button>'+
  '</div></div>';
}

export function submitClaim(btn){
 var nameEl=document.getElementById('claim-name'),dobEl=document.getElementById('claim-dob'),relEl=document.getElementById('claim-relationship'),errEl=document.getElementById('claim-error');
 var name=(nameEl&&nameEl.value||'').trim(),dob=(dobEl&&dobEl.value||'').trim(),relationship=relEl&&relEl.value||'Parent';
 if(!name||!dob){if(errEl){errEl.textContent='Please add your child’s name and date of birth.';errEl.hidden=false}return}
 if(errEl)errEl.hidden=true;
 if(btn){btn.disabled=true;btn.textContent='Submitting…'}
 withAccessToken().then(function(token){
  return fetch(parentHubUrl()+'/claims',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({player_name:name,date_of_birth:dob,relationship:relationship})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not submit this claim.');return body});
 }).then(function(){
  closeSheet();toast('Claim submitted — management will confirm it');
  state.parentHubLoaded=false;loadParentHub();
 }).catch(function(e){
  if(btn){btn.disabled=false;btn.textContent='Submit claim'}
  if(errEl){errEl.textContent=e.message||'Could not submit this claim.';errEl.hidden=false}
 });
}

export function openRequestSessionSheet(playerId,playerName){
 var sessions=(state.parentHub&&state.parentHub.available_sessions)||[];
 var options=sessions.map(function(s){return '<option value="'+esc(s.session_record_id)+'">'+esc(s.session_name)+'</option>'}).join('');
 sheet.hidden=false;
 sheetContent.innerHTML='<div class="calendar-sheet"><h3>Request a session</h3><p>For '+esc(playerName)+'. Management will approve, reject or amend this request.</p>'+
  '<div class="parent-form">'+
  (sessions.length?'<label class="auth-field">Session<select id="request-session-select">'+options+'</select></label>':'<p class="auth-sub">No sessions are available to request right now.</p>')+
  '<p class="auth-error" id="request-session-error" hidden></p>'+
  (sessions.length?'<button class="primary-btn" data-action="submit-session-request" data-player-id="'+esc(playerId)+'">Request session</button>':'')+
  '</div></div>';
}

export function submitSessionRequest(playerId,btn){
 var select=document.getElementById('request-session-select'),errEl=document.getElementById('request-session-error');
 var sessionId=select?select.value:'';
 if(!sessionId){if(errEl){errEl.textContent='Please choose a session.';errEl.hidden=false}return}
 if(errEl)errEl.hidden=true;
 if(btn){btn.disabled=true;btn.textContent='Sending…'}
 withAccessToken().then(function(token){
  return fetch(parentHubUrl()+'/session-requests',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({player_record_id:playerId,session_record_id:sessionId})});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not send this request.');return body});
 }).then(function(){
  closeSheet();toast('Session request sent — waiting for approval');
 }).catch(function(e){
  if(btn){btn.disabled=false;btn.textContent='Request session'}
  if(errEl){errEl.textContent=e.message||'Could not send this request.';errEl.hidden=false}
 });
}
/**
 * Management-only: approve, reject or (for a zero/multi-match claim) pick
 * the right player before approving a parent's claim to a child. Mirrors
 * the Coach Management / Session Requests screens exactly. Nothing here
 * ever grants access itself - approving just sets the Parent-Player
 * Links row to Verified, which is the only thing the parent-hub /me
 * endpoint (and the Player Session Requests it feeds) checks.
 */
