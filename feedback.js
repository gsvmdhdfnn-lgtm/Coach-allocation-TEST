import { esc, playerFeedbackUrl, pushNavState, render, root, state, toast, withAccessToken } from './core.js';
import { playerInitials } from './coach.js';

/** session_id (the Google-Sheet schedule id, e.g. "E01") -> its age group, read from the same schedule source Coach Home/Schedule already use. Not an Airtable field - Airtable's Sessions table only anchors access, the schedule sheet carries the descriptive fields. */
export function ageGroupForSessionId(sessionId){
 var s=(state.sessions||[]).find(function(x){return x.id===sessionId});
 return (s&&s.ageGroup)||'';
}

export function findPlayerRow(playerRecordId,sessionRecordId){
 return (state.players||[]).find(function(p){return p.player_record_id===playerRecordId&&p.session_record_id===sessionRecordId});
}

export function statusPillForTier(tier){return tier==='cover'?'COVER':tier==='former'?'FORMER':'ACTIVE'}

export function accessTextForTier(p){
 if(p.tier==='former')return 'Former player'+(p.access_until?' · access until '+p.access_until:'');
 if(p.tier==='cover')return 'Covering this session';
 if(p.tier==='admin')return 'Current player';
 return 'Current player';
}

/** Airtable always returns a date field as ISO (YYYY-MM-DD) regardless of its own display-format setting. */
export function formatDobLong(iso){
 var m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
 if(!m)return '';
 var d=new Date(+m[1],+m[2]-1,+m[3],12);
 return d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
}

export function formatFeedbackDate(iso){
 var m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/);
 if(!m)return iso||'';
 var d=new Date(+m[1],+m[2]-1,+m[3],12);
 return d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
}

function infoRow(icon,label,helper,value,isMedical){
 return '<div class="pf-row'+(isMedical?' pf-medical':'')+'"><span class="pf-icon">'+icon+'</span><span><b>'+esc(label)+'</b><small>'+esc(helper)+'</small></span><span class="pf-value">'+esc(value)+'</span></div>';
}

function historyKey(playerRecordId,sessionRecordId){return playerRecordId+'|'+sessionRecordId}

/** Fetches (or returns cached) feedback history for one authorised player+session pair. Never trusts a client-side tier - the backend re-resolves access from Airtable on every call. */
export function fetchFeedbackHistory(playerRecordId,sessionRecordId,force){
 var key=historyKey(playerRecordId,sessionRecordId);
 if(!force&&state.fbHistory[key])return Promise.resolve(state.fbHistory[key]);
 return withAccessToken().then(function(token){
  return fetch(playerFeedbackUrl()+'/history?player_record_id='+encodeURIComponent(playerRecordId)+'&session_record_id='+encodeURIComponent(sessionRecordId),{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load feedback history.');return body});
 }).then(function(body){
  var list=body.feedback||[];
  state.fbHistory[key]=list;
  return list;
 });
}

export function fetchFramework(force){
 if(!force&&state.fbFramework)return Promise.resolve(state.fbFramework);
 return withAccessToken().then(function(token){
  return fetch(playerFeedbackUrl()+'/framework',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load the feedback framework.');return body});
 }).then(function(fw){
  state.fbFramework=fw;
  return fw;
 });
}

export function fetchFeedbackRecord(feedbackId){
 return withAccessToken().then(function(token){
  return fetch(playerFeedbackUrl()+'/record/'+encodeURIComponent(feedbackId),{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not load this feedback.');return body});
 });
}

/**
 * The Player Profile screen - the bridge between Player Hub and
 * feedback, per the approved mock-up. Everything in the hero and Player
 * Information card comes from data the Coach Hub already safely loaded
 * (state.players, already access-checked server-side) or is an honest
 * "not currently available" state for the three fields the Players
 * schema genuinely doesn't have yet (Medical/Allergies, Emergency
 * Contact, Player Notes) - never invented. Medical/Allergies keeps the
 * mock-up's red-tinted safety treatment even while unavailable, so a
 * coach never mistakes "we don't have this field yet" for "this player
 * has no medical needs".
 */
export function renderPlayerProfile(playerRecordId,sessionRecordId){
 var p=findPlayerRow(playerRecordId,sessionRecordId);
 if(!p){
  root.innerHTML='<div class="error"><b>Player not found</b><br>This player may no longer be linked to this session.<br><button class="primary-btn error-retry" data-action="app-back">‹ Back</button></div>';
  return;
 }
 state.fbPlayerId=playerRecordId;state.fbSessionRecordId=sessionRecordId;
 var ageGroup=ageGroupForSessionId(p.session_id);
 var dob=p.date_of_birth?formatDobLong(p.date_of_birth):'';
 var avatar=p.photo_url?'<img src="'+esc(p.photo_url)+'" alt="">':'<span>'+esc(playerInitials(p.name))+'</span>';
 var canAdd=p.can_edit_feedback;

 root.innerHTML='<section class="pf-hero"><button class="back-btn" data-action="app-back">‹ Back to '+esc(p.session_name||'session')+'</button>'+
  '<div class="pf-heroTop"><span class="pf-avatar'+(p.photo_url?' has-photo':'')+'">'+avatar+'</span><div><h1>'+esc(p.name)+'</h1><p>'+esc(p.session_name||'')+'</p></div><span class="pf-status">'+statusPillForTier(p.tier)+'</span></div>'+
  '<div class="pf-meta">'+
   '<div><b>Age group</b><span>'+esc(ageGroup||'—')+'</span></div>'+
   '<div><b>Date of birth</b><span>'+esc(dob||'Not recorded')+'</span></div>'+
   '<div><b>Session</b><span>'+esc(p.session_name||'—')+'</span></div>'+
   '<div><b>Access</b><span>'+esc(accessTextForTier(p))+'</span></div>'+
  '</div></section>'+
  '<div class="pf-wrap">'+
  '<div class="pf-head"><h2>Player Information</h2><small>Coach view</small></div>'+
  '<section class="card pf-info-card">'+
   infoRow('🎂','Date of Birth','Age-group and player context',dob||'Not recorded',false)+
   infoRow('❤','Medical / Allergies','Important information coaches should know','Not currently available',true)+
   infoRow('☎','Emergency Contact','Only shown if your access allows it','Not currently available',false)+
   infoRow('ⓘ','Player Notes','Short operational notes, not feedback','Not currently available',false)+
  '</section>'+
  '<div class="pf-head"><h2>Development</h2><small>Feedback &amp; progress</small></div>'+
  '<section class="pf-grid">'+
   '<button class="pf-dev pf-latest" data-action="open-latest-feedback" data-player="'+esc(playerRecordId)+'" data-session-record="'+esc(sessionRecordId)+'"><i>★</i><span><b>Latest Feedback</b><small>Open the most recent feedback available.</small></span></button>'+
   '<button class="pf-dev pf-add" data-action="add-feedback" data-player="'+esc(playerRecordId)+'" data-session-record="'+esc(sessionRecordId)+'"'+(canAdd?'':' disabled title="Your current access does not allow adding feedback"')+'><i>＋</i><span><b>Add Feedback</b><small>Create feedback for this player/session.</small></span></button>'+
   '<button class="pf-dev pf-history" data-action="open-feedback-history" data-player="'+esc(playerRecordId)+'" data-session-record="'+esc(sessionRecordId)+'"><i>≡</i><span><b>Previous Feedback</b><small>View the feedback history.</small></span></button>'+
  '</section>'+
  '<div id="pf-latest-slot"><div class="pf-head"><h2>Latest Feedback</h2><small>Most recent</small></div><div class="loading">Loading feedback…</div></div>'+
  '</div>';

 fetchFeedbackHistory(playerRecordId,sessionRecordId).then(function(list){
  var slot=document.getElementById('pf-latest-slot');
  if(slot){
   if(!list.length){slot.innerHTML='<div class="pf-head"><h2>Latest Feedback</h2><small>Most recent</small></div><div class="empty-state"><span class="empty-state-icon">★</span><b>No feedback yet</b><p>Feedback for this player/session will appear here once added.</p></div>';}
   else{
    var f=list[0];
    slot.innerHTML='<div class="pf-head"><h2>Latest Feedback</h2><small>Most recent</small></div>'+feedbackPreviewCardHtml(f);
   }
  }
  updateAddFeedbackButton(list);
 }).catch(function(e){
  var slot=document.getElementById('pf-latest-slot');
  if(slot)slot.innerHTML='<div class="pf-head"><h2>Latest Feedback</h2><small>Most recent</small></div><div class="empty-state"><span class="empty-state-icon">★</span><b>Couldn’t load feedback</b><p>'+esc(e.message||'Please try again.')+'</p></div>';
 });
}

/** Finds the (at most one expected) unpublished draft for a player+session's feedback history - see startAddFeedback(). */
function findDraftFeedback(list){
 return (list||[]).find(function(f){return !f.published});
}

/** Patches the Player Profile's Add Feedback button to read "Resume Draft" once we know a draft exists - reuses the same fetchFeedbackHistory() call already made for the Latest Feedback panel, no extra request. */
function updateAddFeedbackButton(list){
 var btn=document.querySelector('[data-action="add-feedback"]');
 if(!btn||btn.disabled)return;
 var span=btn.querySelector('span');
 if(!span)return;
 span.innerHTML=findDraftFeedback(list)?'<b>Resume Draft</b><small>Continue your unfinished feedback.</small>':'<b>Add Feedback</b><small>Create feedback for this player/session.</small>';
}

function feedbackPreviewCardHtml(f){
 var p=findPlayerRow(state.fbPlayerId,state.fbSessionRecordId);
 return '<button class="card pf-feedback-card" data-action="view-feedback-record" data-feedback-id="'+esc(f.feedback_id)+'">'+
  '<div class="pf-fb-topline"><h3>'+esc(f.title||'Feedback')+'</h3><span class="pf-pill'+(f.published?'':' is-draft')+'">'+(f.published?'PUBLISHED':'DRAFT')+'</span></div>'+
  (f.keep_doing?'<p><strong>Keep Doing:</strong> '+esc(f.keep_doing)+'</p>':'')+
  (f.big_focus?'<p><strong>My Focus:</strong> '+esc(f.big_focus)+'</p>':'')+
  '<footer>'+esc(f.coach_name||'Coach')+(p?' · '+esc(p.session_name||''):'')+' · '+esc(formatFeedbackDate(f.date))+'</footer>'+
 '</button>';
}

export function fetchCoachDrafts(){
 return withAccessToken().then(function(token){
  return fetch(playerFeedbackUrl()+'/drafts',{headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){
   if(!r.ok)throw new Error(body&&body.error||'Could not load your drafts.');
   return body.drafts||[];
  });
 });
}

export function renderCoachDrafts(){
 state.screen='feedback-drafts';
 root.innerHTML='<div class="page-title"><h1>Drafts</h1><p>Your unfinished player feedback.</p></div>'+
  '<button class="back-btn" data-action="app-back" style="margin:0 2px 12px">‹ Back to Player Hub</button>'+
  '<div id="coach-drafts-list"><div class="loading">Loading drafts…</div></div>';

 fetchCoachDrafts().then(function(drafts){
  var slot=document.getElementById('coach-drafts-list');
  if(!slot)return;
  if(!drafts.length){
   slot.innerHTML='<div class="empty-state"><span class="empty-state-icon">✓</span><b>No drafts waiting</b><p>Feedback you save as a draft will appear here until it is published.</p></div>';
   return;
  }
  slot.innerHTML='<div class="pf-history-list">'+drafts.map(function(d){
   return '<button class="card pf-feedback-card" data-action="continue-feedback-draft" data-feedback-id="'+esc(d.feedback_id)+'">'+
    '<div class="pf-fb-topline"><h3>'+esc(d.player_name||d.title||'Feedback draft')+'</h3><span class="pf-pill is-draft">DRAFT</span></div>'+
    '<p><strong>Session:</strong> '+esc(d.session_name||'Session')+'</p>'+
    (d.date?'<footer>Draft date · '+esc(formatFeedbackDate(d.date))+'</footer>':'')+
    '<div style="margin-top:10px"><span class="primary-btn" style="display:inline-block">Continue Draft</span></div>'+
   '</button>';
  }).join('')+'</div>';
 }).catch(function(e){
  var slot=document.getElementById('coach-drafts-list');
  if(slot)slot.innerHTML='<div class="error"><b>Couldn’t load drafts.</b><br>'+esc(e.message||'')+'</div>';
 });
}

export function continueFeedbackDraft(feedbackId){
 Promise.all([fetchFramework(),fetchFeedbackRecord(feedbackId)]).then(function(results){
  var f=results[1];
  var p=findPlayerRow(f.player_record_id,f.session_record_id);
  if(!p)throw new Error('You no longer have access to this player/session.');
  pushNavState();
  state.fbPlayerId=f.player_record_id;
  state.fbSessionRecordId=f.session_record_id;
  state.fbEditingId=f.feedback_id;
  state.fbDraft=draftFromRecord(f);
  state.fbError='';
  state.screen='feedback-form';
  render();
 }).catch(function(e){
  toast(e.message||'Could not open this draft.');
 });
}

export function openPlayerProfile(playerRecordId,sessionRecordId){
 pushNavState();state.fbPlayerId=playerRecordId;state.fbSessionRecordId=sessionRecordId;state.screen='player-profile';render();
}

export function openLatestFeedback(playerRecordId,sessionRecordId){
 fetchFeedbackHistory(playerRecordId,sessionRecordId).then(function(list){
  if(!list.length){toast('No feedback yet for this player.');return}
  pushNavState();state.fbPlayerId=playerRecordId;state.fbSessionRecordId=sessionRecordId;state.fbRecordId=list[0].feedback_id;state.screen='feedback-record';render();
 }).catch(function(e){toast(e.message||'Could not load feedback.')});
}

export function openFeedbackHistory(playerRecordId,sessionRecordId){
 pushNavState();state.fbPlayerId=playerRecordId;state.fbSessionRecordId=sessionRecordId;state.screen='feedback-history';render();
}

/** An existing draft (unpublished Feedback record) for this player+session is authorised the same way any other feedback is - resolveAccessForPair() on the backend has already gated the history fetch that finds it. Resuming it edits/PATCHes that same record instead of creating a duplicate. */
function draftFromRecord(f){
 var ratings={},notes={};
 (f.ratings||[]).forEach(function(r){
  if(!r.framework_item_id)return;
  if(r.rating)ratings[r.framework_item_id]=r.rating.toLowerCase();
  if(r.notes)notes[r.framework_item_id]=r.notes;
 });
 return {ratings:ratings,notes:notes,keepDoing:f.keep_doing||'',myFocus:f.big_focus||'',summary:f.summary||''};
}

export function startAddFeedback(playerRecordId,sessionRecordId){
 Promise.all([fetchFramework(),fetchFeedbackHistory(playerRecordId,sessionRecordId)]).then(function(results){
  var draft=findDraftFeedback(results[1]);
  pushNavState();
  state.fbPlayerId=playerRecordId;state.fbSessionRecordId=sessionRecordId;
  if(draft){
   state.fbEditingId=draft.feedback_id;
   state.fbDraft=draftFromRecord(draft);
  }else{
   state.fbEditingId=null;
   state.fbDraft={ratings:{},notes:{}};
  }
  state.fbError='';
  state.screen='feedback-form';render();
 }).catch(function(e){toast(e.message||'Could not load the feedback framework.')});
}

export function viewFeedbackRecord(feedbackId){
 pushNavState();state.fbRecordId=feedbackId;state.screen='feedback-record';render();
}

export function renderFeedbackHistory(playerRecordId,sessionRecordId){
 var p=(state.players||[]).find(function(x){return x.player_record_id===playerRecordId&&x.session_record_id===sessionRecordId});
 root.innerHTML='<div class="page-title"><h1>Previous Feedback</h1><p>'+esc(p?p.name:'Feedback history')+'</p></div><button class="back-btn" data-action="app-back" style="margin:0 2px 12px">‹ Back</button><div id="pf-history-slot"><div class="loading">Loading feedback…</div></div>';
 fetchFeedbackHistory(playerRecordId,sessionRecordId).then(function(list){
  var slot=document.getElementById('pf-history-slot');
  if(!slot)return;
  if(!list.length){slot.innerHTML='<div class="empty-state"><span class="empty-state-icon">≡</span><b>No feedback yet</b><p>Feedback for this player/session will appear here once added.</p></div>';return}
  slot.innerHTML='<div class="pf-history-list">'+list.map(feedbackPreviewCardHtml).join('')+'</div>';
 }).catch(function(e){
  var slot=document.getElementById('pf-history-slot');
  if(slot)slot.innerHTML='<div class="empty-state"><span class="empty-state-icon">≡</span><b>Couldn’t load feedback</b><p>'+esc(e.message||'Please try again.')+'</p></div>';
 });
}

export function renderFeedbackRecord(feedbackId){
 root.innerHTML='<div class="page-title"><h1>Feedback</h1></div><button class="back-btn" data-action="app-back" style="margin:0 2px 12px">‹ Back</button><div id="pf-record-slot"><div class="loading">Loading feedback…</div></div>';
 fetchFeedbackRecord(feedbackId).then(function(f){
  var slot=document.getElementById('pf-record-slot');
  if(!slot)return;
  var ratingsHtml='';
  if(f.ratings&&f.ratings.length){
   ratingsHtml='<section class="card pf-ratings-summary"><b>Development Snapshot</b><div class="pf-ratings-grid">'+f.ratings.map(function(r){
    return '<div class="pf-rating-chip pf-rc-'+esc((r.rating||'').toLowerCase())+'"><b>'+esc(r.label_snapshot||'')+'</b><small>'+esc(r.rating||'')+'</small>'+(r.notes?'<p>'+esc(r.notes)+'</p>':'')+'</div>';
   }).join('')+'</div></section>';
  }
  slot.innerHTML=
   '<section class="card pf-feedback-detail">'+
    '<div class="pf-fb-topline"><h3>'+esc(f.title||'Feedback')+'</h3><span class="pf-pill'+(f.published?'':' is-draft')+'">'+(f.published?'PUBLISHED':'DRAFT')+'</span></div>'+
    (f.keep_doing?'<p><strong>Keep Doing:</strong> '+esc(f.keep_doing)+'</p>':'')+
    (f.big_focus?'<p><strong>My Focus:</strong> '+esc(f.big_focus)+'</p>':'')+
    (f.summary?'<p><strong>General Coach Feedback:</strong> '+esc(f.summary)+'</p>':'')+
    '<footer>'+esc(f.coach_name||'Coach')+' · '+esc(formatFeedbackDate(f.date))+'</footer>'+
   '</section>'+ratingsHtml;
 }).catch(function(e){
  var slot=document.getElementById('pf-record-slot');
  if(slot)slot.innerHTML='<div class="error"><b>Couldn’t load this feedback.</b><br>'+esc(e.message||'')+'</div>';
 });
}

/* ------------------------------------------------------------------ *
 * Coach Feedback entry (Add Feedback) - Part C
 * ------------------------------------------------------------------ */

function choiceSwatch(itemId,ratingKey,ratingLabel,selected){
 return '<button type="button" class="fb-choice fb-'+ratingKey+(selected?' fb-selected':'')+'" data-action="rating-choice" data-item="'+esc(itemId)+'" data-rating="'+esc(ratingKey)+'" title="'+esc(ratingLabel)+'" aria-label="'+esc(ratingLabel)+'" aria-pressed="'+(selected?'true':'false')+'">'+(selected?'✓':'')+'</button>';
}

/** Whether this framework item has anything to show at all in the current feedback mode - drives both whether it renders and whether its group renders. Ratings Only: rating control only, no note. Written Only: no rating control, note only when per-area written is on. Combined: either/both, per each item's own toggles. */
function itemHasVisibleControl(item,settings){
 var showsRating=settings.feedback_mode!=='written_only'&&item.rating_enabled;
 var showsNote=settings.feedback_mode!=='ratings_only'&&settings.per_area_written_feedback&&item.written_enabled;
 return showsRating||showsNote;
}

function ratingRowHtml(item,settings,draft,showChoices){
 var hasChoices=showChoices&&item.rating_enabled;
 var rowHtml;
 if(hasChoices){
  var choices=[['blue',settings.blue_label],['green',settings.green_label],['amber',settings.amber_label],['red',settings.red_label]];
  var selected=(draft.ratings[item.framework_item_id]||'').toLowerCase();
  var choicesHtml=choices.map(function(c){return choiceSwatch(item.framework_item_id,c[0],c[1],selected===c[0])}).join('');
  rowHtml='<div class="fb-ratingRow"><div class="fb-ratingLabel" title="'+esc(item.description||'')+'"><b>'+esc(item.name)+'</b></div><div class="fb-choices">'+choicesHtml+'</div></div>';
 }else{
  rowHtml='<div class="fb-ratingRow fb-ratingRow-textOnly"><div class="fb-ratingLabel" title="'+esc(item.description||'')+'"><b>'+esc(item.name)+'</b></div></div>';
 }
 var noteHtml='';
 if(settings.per_area_written_feedback&&item.written_enabled&&settings.feedback_mode!=='ratings_only'){
  noteHtml='<textarea class="fb-area-note" id="fb-note-'+esc(item.framework_item_id)+'" placeholder="Note for '+esc(item.name)+'">'+esc(draft.notes[item.framework_item_id]||'')+'</textarea>';
 }
 return '<div class="fb-item">'+rowHtml+noteHtml+'</div>';
}

/** One colour dot + its single configured label per rating, e.g. "● Consistently strong" - no hardcoded description duplicating whatever the coach configured as the label itself. */
function legendHtml(settings){
 var items=[['blue',settings.blue_label],['green',settings.green_label],['amber',settings.amber_label],['red',settings.red_label]];
 return '<div class="fb-legend">'+items.map(function(c){return '<span class="fb-legend-item"><i class="fb-legend-dot fb-'+c[0]+'"></i>'+esc(c[1])+'</span>'}).join('')+'</div>';
}

export function renderFeedbackForm(){
 var fw=state.fbFramework;
 var p=findPlayerRow(state.fbPlayerId,state.fbSessionRecordId);
 if(!fw||!p){root.innerHTML='<div class="loading">Loading…</div>';return}
 var settings=fw.settings;
 var draft=state.fbDraft||{ratings:{},notes:{}};
 var avatar=p.photo_url?'<img src="'+esc(p.photo_url)+'" alt="">':'<span>'+esc(playerInitials(p.name))+'</span>';
 var showRatings=settings.feedback_mode!=='written_only';
 var showWritten=settings.feedback_mode!=='ratings_only';

 var visibleGroups=fw.groups.map(function(g){
  var visible=g.items.filter(function(i){return itemHasVisibleControl(i,settings)});
  if(!visible.length)return '';
  return '<section class="card fb-group"><div class="fb-groupHead"><b>'+esc(g.label)+'</b><small>'+visible.length+' area'+(visible.length===1?'':'s')+'</small></div>'+
   visible.map(function(i){return ratingRowHtml(i,settings,draft,showRatings)}).join('')+'</section>';
 }).join('');
 var hasVisibleGroups=fw.groups.some(function(g){return g.items.some(function(i){return itemHasVisibleControl(i,settings)})});

 var writtenHtml='';
 if(showWritten){
  var cards=[];
  if(settings.show_keep_doing)cards.push(['keep-doing','Keep Doing','Something '+(p.name.split(' ')[0]||p.name)+' is already doing well and should continue.',draft.keepDoing,true]);
  if(settings.show_my_focus)cards.push(['my-focus','My Focus','The main next step to consistently try to implement.',draft.myFocus,true]);
  if(settings.show_general_feedback)cards.push(['summary','General Coach Feedback','Optional wider context, progress or encouragement.',draft.summary,false]);
  if(cards.length){
   writtenHtml='<div class="fb-sectionTitle"><h2>Written Feedback</h2><p>Coach input</p></div>'+
    cards.map(function(c){return '<section class="card fb-textCard'+(c[4]?' fb-short':'')+'"><label>'+esc(c[1])+'</label><small>'+esc(c[2])+'</small><textarea id="fb-field-'+c[0]+'">'+esc(c[3]||'')+'</textarea></section>'}).join('');
  }
 }

 root.innerHTML='<div class="fb-back">‹ Back to '+esc(p.name)+'</div>'.replace('<div class="fb-back">','<button class="back-btn" data-action="app-back" style="margin:4px 2px 10px">').replace('</div>','</button>')+
  '<section class="fb-hero"><div class="fb-heroTop"><span class="pf-avatar'+(p.photo_url?' has-photo':'')+'">'+avatar+'</span><div><h1>Add Feedback</h1><p>'+esc(p.name)+' · '+esc(p.session_name||'')+'</p></div>'+(ageGroupForSessionId(p.session_id)?'<span class="fb-sessionChip">'+esc(ageGroupForSessionId(p.session_id))+'</span>':'')+'</div></section>'+
  (hasVisibleGroups?'<div class="fb-sectionTitle"><h2>Development Snapshot</h2><p>'+(showRatings?(showWritten?'Ratings + written feedback':'Ratings'):'Written feedback per area')+'</p></div>'+
   '<section class="card fb-intro"><p>'+esc(settings.intro_text||'')+'</p>'+(showRatings?legendHtml(settings):'')+'</section>'+
   visibleGroups:'')+
  writtenHtml+
  (state.fbError?'<p class="auth-error" style="margin:10px 2px 0">'+esc(state.fbError)+'</p>':'')+
  '<div class="fb-actions"><button class="secondary-btn fb-secondary" data-action="cancel-feedback">Cancel</button><button class="primary-btn fb-primary" data-action="save-feedback-draft"'+(state.fbBusy?' disabled':'')+'>Save Draft</button></div>'+
  '<button class="fb-publish" data-action="publish-feedback"'+(state.fbBusy?' disabled':'')+'>Publish Feedback</button>';
}

/** Captures any typed textarea text into state.fbDraft first (so it survives the redraw), then records the choice and redraws to show the new selection. */
export function selectRating(itemId,ratingKey){
 readDraftFromDom();
 state.fbDraft.ratings[itemId]=ratingKey;
 render();
}

export function readDraftFromDom(){
 var d=state.fbDraft||{ratings:{},notes:{}};
 d.keepDoing=(document.getElementById('fb-field-keep-doing')||{}).value;
 d.myFocus=(document.getElementById('fb-field-my-focus')||{}).value;
 d.summary=(document.getElementById('fb-field-summary')||{}).value;
 var fw=state.fbFramework;
 if(fw){
  fw.groups.forEach(function(g){g.items.forEach(function(i){
   var el=document.getElementById('fb-note-'+i.framework_item_id);
   if(el)d.notes[i.framework_item_id]=el.value;
  })});
 }
 state.fbDraft=d;
 return d;
}

function buildSubmitPayload(published){
 var d=readDraftFromDom();
 // Union of items with a rating AND items with a typed note - a Written
 // Only area has no rating at all but must still send its note, so
 // iterating d.ratings' keys alone (as before) silently dropped it.
 var itemIds={};
 Object.keys(d.ratings||{}).forEach(function(k){itemIds[k]=1});
 Object.keys(d.notes||{}).forEach(function(k){if((d.notes[k]||'').trim())itemIds[k]=1});
 var ratings=Object.keys(itemIds).map(function(itemId){
  var r=(d.ratings||{})[itemId];
  return {framework_item_id:itemId,rating:r?capitalize(r):'',note:(d.notes||{})[itemId]||''};
 });
 return {
  player_record_id:state.fbPlayerId,
  session_record_id:state.fbSessionRecordId,
  ratings:ratings,
  keep_doing:d.keepDoing||'',
  big_focus:d.myFocus||'',
  summary:d.summary||'',
  published:!!published,
 };
}
function capitalize(s){return s?s.charAt(0).toUpperCase()+s.slice(1):s}

export function submitFeedback(published){
 if(state.fbBusy)return;
 state.fbBusy=true;state.fbError='';
 var payload=buildSubmitPayload(published);
 var editingId=state.fbEditingId;
 var url=playerFeedbackUrl()+(editingId?'/record/'+encodeURIComponent(editingId):'/record');
 var method=editingId?'PATCH':'POST';
 withAccessToken().then(function(token){
  return fetch(url,{method:method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not save this feedback.');return body});
 }).then(function(body){
  state.fbBusy=false;
  state.fbEditingId=body.feedback_id;
  var key=historyKey(state.fbPlayerId,state.fbSessionRecordId);
  delete state.fbHistory[key];
  toast(published?'Feedback published':'Draft saved');
  state.fbRecordId=body.feedback_id;state.screen='feedback-record';
  render();
 }).catch(function(e){
  state.fbBusy=false;state.fbError=e.message||'Could not save this feedback.';
  render();
 });
}
