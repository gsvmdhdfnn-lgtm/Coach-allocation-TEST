import { renderHome, renderMyPlayers, renderResources, renderSchedule, renderSupport, renderVenueDetail, renderVenues, venueKey } from './coach.js';
import { renderCoachManagement, renderManagement, renderParentClaims, renderPlayerMigration, renderSessionRequests } from './management.js';
import { renderParentHub } from './parent.js';

export let CFG=window.APP_CONFIG||{};

export let DEMO=new URLSearchParams(location.search).get('demo')==='1';

export let state={sessions:[],coaches:[],calendar:{},changes:[],terms:[],themes:{},venueInfo:{},resources:[],coachSupport:[],players:[],airtableVenues:{},me:null,role:'coach',screen:'home',week:null,financials:null,unlocked:false,scheduleView:'today',scheduleWeekOffset:0,calendarCursor:null,calendarSelected:null,expandedDay:null,expandedPlayerSession:null,virtualSessions:{},sessionDate:null,selectedVenue:null,venueQuery:'',navStack:[],authScreen:'login',authEmail:'',authError:'',authBusy:false,authAccountType:'staff',publicPages:[],parentHub:null,parentHubLoaded:false};

export let supabaseClient=(!DEMO&&window.supabase&&CFG.supabaseUrl&&CFG.supabasePublishableKey)?window.supabase.createClient(CFG.supabaseUrl,CFG.supabasePublishableKey):null;

export let root=document.getElementById('screen-root');

export let sheet=document.getElementById('sheet'),sheetContent=document.getElementById('sheet-content');

export let DAY_ORDER=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

export let icons={pin:'⌖',clock:'◷',users:'●',calendar:'▣',book:'▤',shield:'◆',phone:'☎',doc:'▧',bell:'◉',gear:'⚙',money:'£',person:'●'};

export function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
/**
 * The one place every "Josh Evans Hub"/"Josh Evans Soccer School" string
 * used in copy (not the bundled logo file, which content-provider.js
 * handles separately) reads the real Hub Name - so copying this codebase
 * for a different organisation only means setting their Hub Name in
 * Airtable, not hunting down hardcoded text across app.js.
 */

export function hubName(){return (window.HubContent&&HubContent.get()&&HubContent.get().organisation&&HubContent.get().organisation.hub_name)||'Josh Evans Hub'}

export function headerKey(s){return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')}

export function parseCsv(text){var rows=[],row=[],field='',q=false;for(var i=0;i<text.length;i++){var c=text[i],n=text[i+1];if(q){if(c==='"'&&n==='"'){field+='"';i++}else if(c==='"'){q=false}else field+=c}else{if(c==='"')q=true;else if(c===','){row.push(field);field=''}else if(c==='\n'){row.push(field);rows.push(row);row=[];field=''}else if(c!=='\r')field+=c}}row.push(field);if(row.some(Boolean))rows.push(row);return rows}

export function objects(text){var rows=parseCsv(text),h=(rows.shift()||[]).map(headerKey);return rows.map(function(r){var o={};h.forEach(function(k,i){if(k)o[k]=(r[i]||'').trim()});return o})}

export function fetchCsv(url,required){
 if(!url||/^PASTE_/.test(url))return Promise.resolve([]);
 var controller=new AbortController();
 var timer=setTimeout(function(){controller.abort()},15000);

 return fetch(url,{cache:'no-store',signal:controller.signal})
  .then(function(r){
   if(!r.ok)throw new Error('Could not load data');
   return r.text();
  })
  .then(objects)
  .catch(function(e){
   if(required)throw e;
   console.warn('Optional data source unavailable; continuing without it.',url,e);
   return [];
  })
  .finally(function(){clearTimeout(timer)});
}
/**
 * Changes (cancellations/cover/extras) is the one "optional" source whose
 * failure isn't safe to hide: fetchCsv()'s silent fallback would show a
 * cancelled or covered session as perfectly normal. So this fetches it
 * directly rather than through fetchCsv(), and sets a flag the screens
 * that depend on it can check and warn about instead of failing quietly.
 */

export function fetchChanges(){
 if(!CFG.changesCsvUrl||/^PASTE_/.test(CFG.changesCsvUrl))return Promise.resolve([]);
 var controller=new AbortController();
 var timer=setTimeout(function(){controller.abort()},15000);
 return fetch(CFG.changesCsvUrl,{cache:'no-store',signal:controller.signal})
  .then(function(r){if(!r.ok)throw new Error('Could not load data');return r.text()})
  .then(objects)
  .catch(function(e){
   console.warn('Changes could not be loaded - failing visibly, not silently.',e);
   state.changesLoadFailed=true;
   return [];
  })
  .finally(function(){clearTimeout(timer)});
}

export function changesWarningBanner(){
 if(!state.changesLoadFailed)return '';
 return '<div class="data-warning"><b>Today’s cancellations and cover couldn’t be loaded.</b> '+
  'What you see below may not reflect a last-minute change. Pull down to refresh and try again.</div>';
}

export function nameKey(s){return String(s||'').trim().toLowerCase().replace(/\s+/g,' ')}

export function splitCoaches(s){return String(s||'').split(',').map(function(x){return x.trim()}).filter(Boolean)}

export function parseDate(s){if(!s)return null;var m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);return m?new Date(+m[1],+m[2]-1,+m[3],12):null}

export function mondayOf(d){d=new Date(d||new Date());d.setHours(12,0,0,0);var day=d.getDay()||7;d.setDate(d.getDate()-day+1);return d}

export function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}

export function money(v){var n=Number(v);return isFinite(n)?new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(n):'—'}

export function demoData(){
 state.sessions=[
{id:'E01',programme:'Evening',category:'Development Centre',name:'U9/10 Development',ageGroup:'U9/10',day:'Thursday',time:'17:30 - 18:30',venue:"City of London Freemen's",address:'Ashtead, KT21',coaches:['David','Charlie'],participants:'12'},
{id:'E02',programme:'Evening',category:'Academy',name:'U12 Academy',ageGroup:'U12',day:'Thursday',time:'19:00 - 20:30',venue:"City of London Freemen's",address:'Ashtead, KT21',coaches:['David','Charlie'],participants:'14'},
{id:'E03',programme:'Evening',category:'Development Centre',name:'U13/14 Development',ageGroup:'U13/14',day:'Friday',time:'18:00 - 19:00',venue:'Therfield School',address:'Leatherhead',coaches:['David'],participants:'15'},
{id:'D00',programme:'Day',category:'School',name:'School Coaching',ageGroup:'',day:'Friday',time:'13:00 - 17:30',venue:'School Programme',address:'Surrey',coaches:['David'],participants:''},
{id:'D01',programme:'Day',category:'School',name:"St Peter's After School",ageGroup:'',day:'Friday',time:'16:00 - 17:00',venue:"St Peter's School",address:'Leatherhead',coaches:['David'],participants:'18'},
{id:'E04',programme:'Evening',category:'Development Centre',name:'U8 Development',ageGroup:'U8',day:'Thursday',time:'16:30 - 17:30',venue:"City of London Freemen's",address:'Ashtead, KT21',coaches:['Jack'],participants:'11'}];
 state.me={name:'David',owner:true}; state.week=iso(mondayOf(new Date(2026,8,17)));
 state.themes[state.week]={'development centre':'Receiving to play forward','academy':'Playing through pressure','school':'1v1 attacking'};
 state.calendar[state.week]={label:'Term 1 Week 1',running:true};
 state.financials={E01:{participants:'12',revenue_net:'144',coach_cost:'48',venue_cost:'32',profit:'64'},E02:{participants:'14',revenue_net:'168',coach_cost:'60',venue_cost:'36',profit:'72'}};
 state.unlocked=true;
}

export function load(){
 if(DEMO){demoData();render();return}
 root.innerHTML='<div class="loading">Loading your hub…</div>';
 accessToken().then(function(token){return Promise.all([
 fetchCsv(CFG.sessionsCsvUrl,true),
 fetchCsv(CFG.calendarCsvUrl,false),
 fetchChanges(),
 fetchCsv(CFG.termsCsvUrl,false),
 fetchCsv(CFG.themesCsvUrl,false),
 HubContent.loadResources().catch(function(){return []}),
 HubContent.loadVenues().catch(function(){return []}),
 HubContent.loadCoachSupport().catch(function(){return []}),
 HubContent.loadPlayers(token).catch(function(){return []})
])}).then(function(all){

  var ss=all[0];state.sessions=ss.map(function(r){return {id:r.session_id,name:r.session_name,programme:r.programme,category:r.category,ageGroup:r.age_group,day:r.day,time:r.time,venue:r.venue,address:r.address,coaches:splitCoaches(r.coaches),client:r.client,hours:r.hours}});
  all[1].forEach(function(r){var d=parseDate(r.week_commencing);if(d)state.calendar[iso(mondayOf(d))]={label:r.label||'',weekNo:r.week_no||'',running:!/^(no|n|0|false)$/i.test(r.running||'yes')}});
  state.changes=all[2];state.terms=all[3];all[4].forEach(function(r){var d=parseDate(r.week_commencing);if(!d)return;var k=iso(mondayOf(d));state.themes[k]=state.themes[k]||{};state.themes[k][nameKey(r.category)]=r.theme||''});
  state.resources=all[5]||[];
  (all[6]||[]).forEach(function(v){if(!v.name)return;state.venueInfo[venueKey(v.name)]={venue:v.name,address:v.address||'',postcode:v.postcode||'',parking:v.parking||'',meetingPoint:v.meeting_point||'',access:v.access||'',notes:v.notes||'',heroImageUrl:v.hero_image_url||'',parkingImageUrl:v.parking_image_url||'',siteMapUrl:v.site_map_url||''}});
  state.coachSupport=all[7]||[];
  state.players=all[8]||[];
  state.week=iso(mondayOf(new Date()));render();
 }).catch(function(e){root.innerHTML='<div class="error"><b>Couldn’t load your Hub.</b><br>This is usually just a weak connection - check your signal and try again.<br>'+
  '<button class="primary-btn error-retry" data-action="retry-load">Try again</button>'+
  '<button class="auth-switch" data-action="show-public">‹ Back to '+esc(hubName())+'</button></div>'})
}

export function setNav(screen){document.querySelectorAll('[data-nav]').forEach(function(b){b.classList.toggle('is-active',b.dataset.nav===screen)})}

export function navSnapshot(){return {screen:state.screen,scheduleView:state.scheduleView,scheduleWeekOffset:state.scheduleWeekOffset,calendarCursor:state.calendarCursor?iso(state.calendarCursor):null,calendarSelected:state.calendarSelected?iso(state.calendarSelected):null,expandedDay:state.expandedDay}}

export function pushNavState(){state.navStack.push(navSnapshot());if(state.navStack.length>20)state.navStack.shift()}

export function syncBackButton(){var b=document.getElementById('app-back');if(b)b.hidden=!state.navStack.length}
/**
 * Switching between the four main tabs is lateral, not a drill-down - it
 * never needs a way "back" since the tabs are always one tap away from
 * each other. Only push nav state when landing on a screen that isn't
 * one of the tabs (Venues/Coach Support reached from a Home shortcut),
 * which is what the back button is actually for.
 */

export function navigateTo(screen){if(screen!==state.screen){if(!TAB_SCREENS[screen])pushNavState();state.screen=screen}render()}

export function goBack(){var p=state.navStack.pop();if(!p){state.screen='home';render();return}state.screen=p.screen;state.scheduleView=p.scheduleView||state.scheduleView;state.scheduleWeekOffset=p.scheduleWeekOffset||0;state.calendarCursor=p.calendarCursor?parseDate(p.calendarCursor):state.calendarCursor;state.calendarSelected=p.calendarSelected?parseDate(p.calendarSelected):state.calendarSelected;state.expandedDay=p.expandedDay||null;render()}
/**
 * The four tab-bar screens stay permanently built in the DOM, one pane
 * each, and switching between them just toggles which pane is hidden -
 * mirrors how the live Hub's setView() works, so tapping a tab is an
 * instant switch rather than a teardown-and-rebuild of the whole screen.
 * Everything reached by drilling into a card (session/venue detail,
 * Coach Support, Management) still fully replaces root, which is what
 * going a level deeper is expected to feel like.
 */

export let panes={};

export let TAB_SCREENS={home:1,schedule:1,resources:1,players:1};

export function ensureTabShell(){
 if(panes.home&&root.contains(panes.home))return;
 root.innerHTML='';
 panes={};
 Object.keys(TAB_SCREENS).forEach(function(name){var d=document.createElement('div');d.hidden=true;root.appendChild(d);panes[name]=d});
}

export function renderIntoPane(name,fn){var saved=root;root=panes[name];fn();root=saved}

export function reRenderSchedule(){renderIntoPane('schedule',renderSchedule)}

export function reRenderMyPlayers(){renderIntoPane('players',renderMyPlayers)}

export function render(){document.getElementById('app').classList.remove('auth-mode');document.getElementById('app').classList.toggle('role-parent',state.role==='parent');setNav(state.screen);if(state.role==='parent'){renderParentHub();syncBackButton();return}if(state.role!=='coach'&&state.role!=='management'){root.innerHTML='<div class="page-title"><h1>'+esc(state.role.charAt(0).toUpperCase()+state.role.slice(1))+' Hub</h1><p>This role shell is ready for its own screens. Coach screens remain separate.</p></div>';syncBackButton();return}if(TAB_SCREENS[state.screen]){ensureTabShell();renderIntoPane(state.screen,{home:renderHome,schedule:renderSchedule,resources:renderResources,players:renderMyPlayers}[state.screen]);Object.keys(panes).forEach(function(k){panes[k].hidden=(k!==state.screen)});window.scrollTo(0,0)}else if(state.screen==='venues')renderVenues();else if(state.screen==='venue-detail')renderVenueDetail(state.selectedVenue);else if(state.screen==='support')renderSupport();else if(state.screen==='management')renderManagement();else if(state.screen==='coach-management')renderCoachManagement();else if(state.screen==='session-requests')renderSessionRequests();else if(state.screen==='player-migration')renderPlayerMigration();else if(state.screen==='parent-claims')renderParentClaims();syncBackButton()}

export function openProfileSheet(){
 var m=state.me||{},roleLabel=(state.role||'coach').replace(/^./,function(c){return c.toUpperCase()});
 sheet.hidden=false;
 sheetContent.innerHTML='<div class="calendar-sheet"><h3>My Profile</h3>'+
  '<div class="venue-info-row"><b>Name</b><span>'+esc(m.name||'Not set yet — ask Josh or David to add this')+'</span></div>'+
  '<div class="venue-info-row"><b>Email</b><span>'+esc(m.email||'—')+'</span></div>'+
  '<div class="venue-info-row"><b>Role</b><span>'+esc(roleLabel)+'</span></div>'+
 '</div>';
}
/**
 * The account/support/management list used to be its own "More" tab.
 * Now reached from the hamburger icon in the top-right corner instead -
 * same rows, same actions, just opened as a sheet rather than a screen,
 * since the tab slot itself now shows My Players.
 */

export function openMoreSheet(){
 var rows=[['●','My Profile',(state.me&&state.me.email)||'Update your details','','profile'],['◉','Notifications','Manage alerts','','coming-soon'],['£','Management & Financials','Restricted access','management',''],['●','Feedback','Share ideas or report an issue','','coming-soon'],['☎','Contact the Office','Get in touch','','coming-soon'],['↪','Log Out','','','logout']];
 if(state.role==='management')rows.splice(3,0,['✓','Coach Management','Approve pending staff sign-ups','coach-management',''],['◉','Session Requests','Approve player session requests','session-requests',''],['▤','Player Migration','Move existing players onto sessions','player-migration',''],['●','Parent Claims','Approve parents’ claims to their child','parent-claims','']);
 sheet.hidden=false;
 sheetContent.innerHTML='<div class="calendar-sheet"><h3>More</h3><div class="card more-list" style="margin-top:6px">'+rows.map(function(r){return '<button class="more-row" '+(r[3]?'data-nav="'+r[3]+'"':'')+(r[4]?' data-action="'+r[4]+'"':'')+'><span class="support-icon">'+r[0]+'</span><span><b>'+r[1]+'</b><small>'+esc(r[2])+'</small></span><span>›</span></button>'}).join('')+'</div></div>';
}

export function approveCoachUrl(){return (CFG.contentApiUrl||'').replace(/\/hub-content\/?$/,'/approve-coach')}

export function playerSessionsUrl(){return (CFG.contentApiUrl||'').replace(/\/hub-content\/?$/,'/player-sessions')}
/** Resolves to the current Supabase access token, or null if signed out/unconfigured. Never rejects. */

export function accessToken(){
 if(!supabaseClient)return Promise.resolve(null);
 return supabaseClient.auth.getSession().then(function(res){return (res&&res.data&&res.data.session&&res.data.session.access_token)||null},function(){return null});
}

export function withAccessToken(){
 return accessToken().then(function(token){
  if(!token)throw new Error('Your session has expired — sign in again.');
  return token;
 });
}

export function parentHubUrl(){return (CFG.contentApiUrl||'').replace(/\/hub-content\/?$/,'/parent-hub')}

export function closeSheet(){sheet.hidden=true;sheetContent.innerHTML='';sheetContent._calendarOptions=null}

export function toast(t){var e=document.getElementById('toast');e.textContent=t;e.hidden=false;setTimeout(function(){e.hidden=true},1800)}
/**
 * Colour is a plain hex string set per-record in Airtable (Public Pages ->
 * Colour). Text automatically switches to dark when that colour is light,
 * so nobody has to also pick a matching text colour - one field, not two.
 */
