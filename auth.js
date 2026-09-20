import { CFG, DEMO, demoData, esc, hubName, load, render, root, sheet, state, supabaseClient } from './core.js';

export function contrastIsLight(hex){
 var h=String(hex||'').trim().replace(/^#/,'');
 if(h.length===3)h=h.split('').map(function(c){return c+c}).join('');
 if(!/^[0-9a-f]{6}$/i.test(h))return false;
 var r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
 return (0.299*r+0.587*g+0.114*b)/255>0.6;
}

export let CATEGORY_ICON={general:'⌂',trials:'▣',academy:'●',tours:'◎',events:'◆',resources:'▧'};

export function iconForCategory(cat){return CATEGORY_ICON[String(cat||'').trim().toLowerCase()]||'✦'}
/**
 * Any image, whatever size it was uploaded at in Airtable, is shown in a
 * fixed-height box and auto-cropped to fill it (background-size: cover) -
 * nobody ever needs to resize a photo to "fit" before uploading it. The
 * photo sits in its own contained strip rather than behind the text, so
 * a busy photo never fights with the title for legibility.
 */

export function publicPageTile(p,i){
 var hex=window.HubContent&&HubContent.resolveColour?HubContent.resolveColour(p.colour,p.colour_preset):'';
 var validHex=!!hex;
 var hasImage=!!p.image_url;
 var fallback=['','alt','warm'][i%3];
 var isLight=validHex&&contrastIsLight(hex);
 var footerStyle=validHex?' style="background:'+(hex.charAt(0)==='#'?hex:'#'+hex)+'"':'';
 var footerCls='public-tile-footer'+(validHex?'':' '+fallback);
 var photo=hasImage?'<div class="public-tile-photo-box" style="background-image:url(\''+esc(p.image_url)+'\')"></div>':'';
 var cta=esc(p.cta_label||'Register Interest');
 return '<button class="card public-tile'+(isLight?' light-bg':'')+(hasImage?' has-photo':'')+'" data-action="public-detail" data-page="'+esc(p.page_id)+'">'+
  photo+
  '<div class="'+footerCls+'"'+footerStyle+'>'+
   '<div class="public-tile-ring"></div>'+
   '<span class="public-tile-icon">'+iconForCategory(p.category)+'</span>'+
   '<span class="public-tile-copy"><h3>'+esc(p.title)+'</h3><span class="public-tile-cta">'+cta+' →</span></span>'+
  '</div>'+
 '</button>';
}
/**
 * The first card (by Sort Order - normally the General "Welcome" one, but
 * driven purely by order, not by category name) gets a wider, richer
 * treatment above the grid rather than sitting in it as just another
 * tile - it's the one bit of copy every visitor should actually read.
 */

export function publicFeaturedTile(p){
 var hex=window.HubContent&&HubContent.resolveColour?HubContent.resolveColour(p.colour,p.colour_preset):'';
 var validHex=!!hex;
 var hasImage=!!p.image_url;
 var isLight=validHex&&contrastIsLight(hex);
 var footerStyle=validHex?' style="background:'+(hex.charAt(0)==='#'?hex:'#'+hex)+'"':'';
 var footerCls='public-featured-footer'+(validHex?'':' fallback');
 var photo=hasImage?'<div class="public-featured-photo" style="background-image:url(\''+esc(p.image_url)+'\')"></div>':'';
 return '<button class="card public-featured'+(isLight?' light-bg':'')+(hasImage?' has-photo':'')+'" data-action="public-detail" data-page="'+esc(p.page_id)+'">'+
  photo+
  '<div class="'+footerCls+'"'+footerStyle+'>'+
   '<div class="public-tile-ring"></div>'+
   '<h2>'+esc(p.title)+'</h2>'+
   (p.summary?'<p>'+esc(p.summary)+'</p>':'')+
   '<span class="public-featured-enquiry">'+esc(p.cta_label||'Find out more')+' →</span>'+
  '</div>'+
 '</button>';
}
/**
 * Reads an arbitrary Hub Setting's raw value with no text fallback - unlike
 * HubContent.label(key,fallback), which is designed to always show
 * something (falling back to the key name itself as a last resort, useful
 * for a label that's always visible), a quick link with nothing configured
 * should render nothing at all rather than show a literal "instagram_url".
 */
function settingValue(key){
 var settings=window.HubContent&&HubContent.get()&&HubContent.get().settings;
 return (settings&&settings[key])||'';
}
/**
 * Purely decorative (aria-hidden), so the link's own text still carries
 * the meaning for screen readers - stroke uses currentColor so each icon
 * follows the pill's normal/hover colour automatically, same as the text.
 */
var QUICK_LINK_ICONS={
 website:'<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c1.8 1.8 2.8 4 2.8 6.3S9.8 12.5 8 14.3C6.2 12.5 5.2 10.3 5.2 8S6.2 3.5 8 1.7Z"/></svg>',
 instagram:'<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false"><rect x="1.5" y="1.5" width="13" height="13" rx="3.6"/><circle cx="8" cy="8" r="3.3"/><circle cx="11.6" cy="4.4" r=".9" fill="currentColor" stroke="none"/></svg>',
 contact:'<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false"><rect x="1.5" y="3" width="13" height="10" rx="1.8"/><path d="M2 4.2 8 9l6-4.8"/></svg>'
};
/**
 * Optional, organisation-agnostic quick actions shown alongside the hero.
 * Every entry is config-driven and simply doesn't render if left blank -
 * organisation.website already comes back from hub-content unused until
 * now; instagram_url/contact_url are Hub Settings, the same generic
 * key/value mechanism landing_subtitle already uses, so any organisation
 * can fill in the same optional keys (or none) with no code change here.
 * icon just picks which generic glyph fits the label, not anything
 * organisation-specific.
 */
function publicQuickLinks(org){
 var links=[
  {label:'Website',icon:'website',url:org.website||''},
  {label:'Instagram',icon:'instagram',url:settingValue('instagram_url')},
  {label:'Contact Us',icon:'contact',url:settingValue('contact_url')}
 ].filter(function(l){return l.url});
 if(!links.length)return '';
 return '<div class="public-quicklinks">'+links.map(function(l){
  return '<a class="public-quicklink" href="'+esc(l.url)+'" target="_blank" rel="noopener">'+
   '<span class="public-quicklink-icon">'+QUICK_LINK_ICONS[l.icon]+'</span>'+esc(l.label)+
   '</a>';
 }).join('')+'</div>';
}
/**
 * One flat 2-column grid, no per-category headers - matches the reference
 * David shared (a clean 2x2/2x3 menu, not a stack of one-item sections).
 * Cards already arrive from hub-content sorted by their own Sort Order, so
 * that's the only thing controlling the grid's order; category still
 * decides the icon, nothing else. The first card is pulled out to run
 * wide above the grid (see publicFeaturedTile) - everything after it
 * fills the grid below.
 */

export function renderPublicHome(){
 document.getElementById('app').classList.add('auth-mode');
 var org=(window.HubContent&&HubContent.get()&&HubContent.get().organisation)||{};
 var heroSubtitle=(window.HubContent&&HubContent.label('landing_subtitle',org.tagline))||'';
 var pages=state.publicPages||[];
 var featured=pages[0],rest=pages.slice(1);
 root.innerHTML='<div class="public-page">'+
  '<section class="public-hero">'+
   '<h1>'+esc(org.hub_name||'Josh Evans Hub')+'</h1>'+
   (heroSubtitle?'<p class="public-hero-tag">'+esc(heroSubtitle)+'</p>':'')+
   '<div class="public-hero-actions"><button class="secondary-btn" data-action="show-signin">Sign In</button><button class="primary-btn" data-action="show-signup">Register</button></div>'+
   publicQuickLinks(org)+
  '</section>'+
  (featured?'<section class="public-section">'+publicFeaturedTile(featured)+'</section>':'')+
  (rest.length?'<section class="public-section"><div class="public-tile-grid">'+rest.map(function(p,i){return publicPageTile(p,i)}).join('')+'</div></section>':'')+
  (pages.length?'':'<div class="schedule-empty">More information coming soon.</div>')+
 '</div>';
 window.scrollTo(0,0);
}
/**
 * Age Groups on the Public Pages card is a plain comma-separated list set
 * in Airtable, e.g. "U7, U8, U9/10". If it's set, the form offers exactly
 * those as a dropdown - different cards can offer different age bands
 * with no code change. If it's blank, the form just asks for age as free
 * text instead, so this still works before anyone's filled that in.
 */

export function ageGroupField(page){
 var options=String(page.age_groups||'').split(',').map(function(s){return s.trim()}).filter(Boolean);
 if(!options.length)return '<label class="auth-field">Age group<input id="ri-age" placeholder="e.g. 9" autocomplete="off"></label>';
 return '<label class="auth-field">Age group<select id="ri-age"><option value="">Choose one…</option>'+
  options.map(function(o){return '<option value="'+esc(o)+'">'+esc(o)+'</option>'}).join('')+
  '</select></label>';
}

export function renderPublicDetail(pageId,submitted){
 document.getElementById('app').classList.add('auth-mode');
 state.selectedPublicPage=pageId;
 var page=(state.publicPages||[]).find(function(x){return x.page_id===pageId});
 if(!page){renderPublicHome();return}
 if(!submitted)state.riStartedAt=Date.now();
 var img=page.image_url?'<div class="public-detail-img"><img src="'+esc(page.image_url)+'" alt=""></div>':'';
 var cta=(page.cta_label&&page.cta_link)?'<a class="secondary-btn sheet-link-btn" href="'+esc(page.cta_link)+'" target="_blank" rel="noopener">'+esc(page.cta_label)+'</a>':'';
 var formOrThanks=submitted?
  '<div class="ri-done"><span class="ri-done-icon">✓</span><h2>Thanks!</h2><p class="auth-sub">We’ve got your details for '+esc(page.title)+' and will be in touch soon.</p></div>':
  '<h2>Register interest</h2><p class="auth-sub">Leave your details and we’ll be in touch.</p>'+
  '<label class="auth-field">Name<input id="ri-name" autocomplete="name"></label>'+
  '<label class="auth-field">Email<input id="ri-email" type="email" autocomplete="email"></label>'+
  '<label class="auth-field">Phone (optional)<input id="ri-phone" type="tel" autocomplete="tel"></label>'+
  ageGroupField(page)+
  '<label class="auth-field">Notes (optional)<textarea id="ri-notes" rows="3"></textarea></label>'+
  '<input type="text" id="ri-hp" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">'+
  '<p class="auth-error" id="ri-error" hidden></p>'+
  '<button class="primary-btn" data-action="register-interest-submit" data-page="'+esc(page.page_id)+'">Submit</button>';
 var showForm=page.show_register_form!==false;
 var events=(page.events||[]).filter(function(e){return e.photo_url||e.description});
 var eventsHtml=events.length?'<section class="event-list">'+events.map(function(e){
   return '<div class="event-item">'+
    (e.photo_url?'<div class="event-item-photo"><img src="'+esc(e.photo_url)+'" alt=""></div>':'')+
    (e.description?'<p class="event-item-desc">'+esc(e.description)+'</p>':'')+
   '</div>';
  }).join('')+'</section>':'';
 root.innerHTML='<section class="detail-hero public-detail-hero"><button class="back-btn" data-action="show-public">‹ Back</button>'+
  '<h1>'+esc(page.title)+'</h1></section>'+
  '<div class="venue-detail-wrap">'+
  '<section class="card detail-card">'+img+(page.body?'<p>'+esc(page.body)+'</p>':'')+cta+'</section>'+
  eventsHtml+
  (showForm?'<section class="card register-interest-card">'+formOrThanks+'</section>':'')+
  '</div>';
 window.scrollTo(0,0);
}

export function submitRegisterInterest(pageId){
 var page=(state.publicPages||[]).find(function(x){return x.page_id===pageId});
 if(!page)return;
 var nameEl=document.getElementById('ri-name'),emailEl=document.getElementById('ri-email'),phoneEl=document.getElementById('ri-phone'),ageEl=document.getElementById('ri-age'),notesEl=document.getElementById('ri-notes'),hpEl=document.getElementById('ri-hp'),errEl=document.getElementById('ri-error');
 var name=(nameEl&&nameEl.value||'').trim(),email=(emailEl&&emailEl.value||'').trim(),phone=(phoneEl&&phoneEl.value||'').trim(),ageGroup=(ageEl&&ageEl.value||'').trim(),notes=(notesEl&&notesEl.value||'').trim(),hp=(hpEl&&hpEl.value||'').trim();
 if(!name||!email){if(errEl){errEl.textContent='Please add your name and email.';errEl.hidden=false}return}
 if(!ageGroup){if(errEl){errEl.textContent='Please choose an age group.';errEl.hidden=false}return}
 if(errEl)errEl.hidden=true;
 var btn=document.querySelector('[data-action="register-interest-submit"]');
 if(btn){btn.disabled=true;btn.textContent='Sending…'}
 var url=(CFG.contentApiUrl||'').replace(/\/hub-content\/?$/,'/register-interest');
 fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
  name:name,email:email,phone:phone,age_group:ageGroup,notes:notes,
  page_id:page.page_id,page_title:page.title,
  website_hp:hp,started_at:state.riStartedAt
 })})
 .then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data}})})
 .then(function(res){
  if(!res.ok)throw new Error((res.data&&res.data.error)||'Something went wrong. Please try again.');
  renderPublicDetail(pageId,true);
 })
 .catch(function(e){
  if(btn){btn.disabled=false;btn.textContent='Submit'}
  if(errEl){errEl.textContent=e.message||'Something went wrong. Please try again.';errEl.hidden=false}
 });
}

export function loadPublicHome(){
 document.getElementById('app').classList.add('auth-mode');
 root.innerHTML='<div class="loading">Loading…</div>';
 Promise.all([
  HubContent.load().catch(function(){return null}),
  HubContent.loadPublicPages().catch(function(){return []})
 ]).then(function(all){
  state.publicPages=all[1]||[];
  renderPublicHome();
 });
}

export function renderAuthShell(inner){document.getElementById('app').classList.add('auth-mode');root.innerHTML='<div class="auth-page"><div class="auth-card">'+
 '<img class="auth-logo" src="je-logo.png" alt="'+esc(hubName())+'">'+inner+'</div></div>';window.scrollTo(0,0)}

export function renderAuthMessage(title,body,showLogout,showBack){renderAuthShell('<h1>'+esc(title)+'</h1><p class="auth-sub">'+esc(body)+'</p>'+
 (showLogout?'<button class="secondary-btn" data-action="logout">Log out</button>':'')+
 (showBack?'<button class="auth-switch" data-action="show-public">‹ Back to '+esc(hubName())+'</button>':''))}

export function renderAuth(){
 var mode=state.authScreen==='signup'?'signup':'login';
 var type=state.authAccountType==='parent'?'parent':'staff';
 var err=state.authError?'<p class="auth-error">'+esc(state.authError)+'</p>':'';
 var typePicker=mode!=='signup'?'':(
  '<div class="auth-field"><span>I am a…</span><div class="segmented auth-type-picker">'+
   '<button data-action="auth-account-type" data-type="staff" class="'+(type==='staff'?'is-active':'')+'">Coach</button>'+
   '<button data-action="auth-account-type" data-type="parent" class="'+(type==='parent'?'is-active':'')+'">Parent</button>'+
  '</div></div>'
 );
 var typeNote=mode!=='signup'?'':(type==='parent'?
  '<p class="auth-note">Parent accounts get in straight away — you’ll be matched to your child once that’s set up.</p>':
  '<p class="auth-note">Coach accounts need to be approved by Josh or David before you can sign in.</p>');
 renderAuthShell(
  '<h1>'+(mode==='signup'?'Create your account':'Sign in')+'</h1>'+
  '<p class="auth-sub">'+(mode==='signup'?'For coaches, parents and management at '+esc(hubName())+'.':'Welcome back to '+esc(hubName())+'.')+'</p>'+
  typePicker+
  '<label class="auth-field">Email<input id="auth-email" type="email" autocomplete="email" value="'+esc(state.authEmail||'')+'"></label>'+
  '<label class="auth-field">Password<input id="auth-password" type="password" autocomplete="'+(mode==='signup'?'new-password':'current-password')+'"></label>'+
  err+
  '<button class="primary-btn" data-action="auth-submit" '+(state.authBusy?'disabled':'')+'>'+(state.authBusy?'Please wait…':(mode==='signup'?'Create account':'Sign in'))+'</button>'+
  '<button class="auth-switch" data-action="auth-switch">'+(mode==='signup'?'Already have an account? Sign in':'New here? Create an account')+'</button>'+
  typeNote+
  '<button class="auth-switch" data-action="show-public">‹ Back to '+esc(hubName())+'</button>'
 );
 var first=document.getElementById(state.authEmail?'auth-password':'auth-email');if(first)first.focus()
}

export function authSubmit(){
 var emailEl=document.getElementById('auth-email'),pwEl=document.getElementById('auth-password');
 var email=(emailEl&&emailEl.value||'').trim(),password=pwEl&&pwEl.value||'';
 state.authEmail=email;
 if(!email||!password){state.authError='Enter your email and password.';renderAuth();return}
 if(!supabaseClient){state.authError='Sign-in is not configured.';renderAuth();return}
 state.authBusy=true;state.authError='';renderAuth();
 var mode=state.authScreen==='signup'?'signup':'login';
 /**
  * Explicit emailRedirectTo, not the Supabase project's default Site URL -
  * derived from the page's own location (not hardcoded) so it's always
  * exactly where this copy of the Hub is actually being served from,
  * subdirectory included (e.g. https://…github.io/Coach-allocation-TEST/),
  * and never drifts if the repo/Pages path ever changes. Must also be on
  * the project's Redirect URLs allow-list in Supabase, or Supabase falls
  * back to the Site URL regardless of what's passed here.
  */
 var op=mode==='signup'?supabaseClient.auth.signUp({email:email,password:password,options:{data:{account_type:state.authAccountType==='parent'?'parent':'staff'},emailRedirectTo:location.origin+location.pathname}}):supabaseClient.auth.signInWithPassword({email:email,password:password});
 op.then(function(res){
  state.authBusy=false;
  if(res.error){state.authError=res.error.message||'Something went wrong. Please try again.';renderAuth();return}
  var session=res.data&&res.data.session;
  if(session){onSignedIn(session);return}
  if(mode==='signup'){renderAuthMessage('Check your email','We’ve sent a confirmation link to '+email+'. Follow it, then come back here and sign in.',false,true);return}
  state.authError='Could not sign you in. Please try again.';renderAuth();
 }).catch(function(){state.authBusy=false;state.authError='Something went wrong. Please try again.';renderAuth()});
}

export function onSignedIn(session){
 renderAuthMessage('Loading your hub','One moment…',false);
 var meUrl=(CFG.contentApiUrl||'').replace(/\/hub-content\/?$/,'/me');
 fetch(meUrl,{headers:{Authorization:'Bearer '+session.access_token},cache:'no-store'})
  .then(function(r){if(!r.ok)throw new Error('Could not load your profile ('+r.status+').');return r.json()})
  .then(function(me){
   state.role=(me.role||'pending').toLowerCase();
   state.me={name:me.display_name||'',email:me.email||'',userId:me.user_id,airtablePersonId:me.airtable_person_id};
   if(state.role==='pending'){renderAuthMessage('Waiting for approval','Thanks for signing up. Josh or David will approve your account shortly — come back and refresh once you’ve heard from them.',true);return}
   load();
  })
  .catch(function(e){renderAuthMessage('Could not load your profile',e.message||'Please try again.',true)});
}

export function init(){
 if(DEMO){demoData();render();return}
 if(!supabaseClient){renderAuthMessage('Sign-in is not configured','Add supabaseUrl and supabasePublishableKey to config.js.',false);return}
 renderAuthMessage('Loading','One moment…',false);
 supabaseClient.auth.getSession().then(function(res){
  var session=res.data&&res.data.session;
  if(session)onSignedIn(session);else loadPublicHome()
 });
 supabaseClient.auth.onAuthStateChange(function(event){
  if(event==='SIGNED_OUT'){state.me=null;state.role='coach';state.screen='home';state.authScreen='login';state.authEmail='';state.authError='';state.authAccountType='staff';state.parentHub=null;state.parentHubLoaded=false;loadPublicHome()}
 });
}
