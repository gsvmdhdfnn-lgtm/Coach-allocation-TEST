
(function(){
'use strict';
var CFG=window.APP_CONFIG||{};
var DEMO=new URLSearchParams(location.search).get('demo')==='1';
var state={sessions:[],coaches:[],calendar:{},changes:[],terms:[],themes:{},venueInfo:{},resources:[],coachSupport:[],airtableVenues:{},me:null,role:'coach',screen:'home',week:null,financials:null,unlocked:false,scheduleView:'today',scheduleWeekOffset:0,calendarCursor:null,calendarSelected:null,expandedDay:null,virtualSessions:{},sessionDate:null,selectedVenue:null,venueQuery:'',navStack:[],authScreen:'login',authEmail:'',authError:'',authBusy:false,authAccountType:'staff',publicPages:[]};
var supabaseClient=(!DEMO&&window.supabase&&CFG.supabaseUrl&&CFG.supabasePublishableKey)?window.supabase.createClient(CFG.supabaseUrl,CFG.supabasePublishableKey):null;
var root=document.getElementById('screen-root');
var sheet=document.getElementById('sheet'),sheetContent=document.getElementById('sheet-content');
var DAY_ORDER=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
var icons={pin:'⌖',clock:'◷',users:'●',calendar:'▣',book:'▤',shield:'◆',phone:'☎',doc:'▧',bell:'◉',gear:'⚙',money:'£',person:'●'};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function headerKey(s){return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')}
function parseCsv(text){var rows=[],row=[],field='',q=false;for(var i=0;i<text.length;i++){var c=text[i],n=text[i+1];if(q){if(c==='"'&&n==='"'){field+='"';i++}else if(c==='"'){q=false}else field+=c}else{if(c==='"')q=true;else if(c===','){row.push(field);field=''}else if(c==='\n'){row.push(field);rows.push(row);row=[];field=''}else if(c!=='\r')field+=c}}row.push(field);if(row.some(Boolean))rows.push(row);return rows}
function objects(text){var rows=parseCsv(text),h=(rows.shift()||[]).map(headerKey);return rows.map(function(r){var o={};h.forEach(function(k,i){if(k)o[k]=(r[i]||'').trim()});return o})}
function fetchCsv(url,required){
 if(!url||/^PASTE_/.test(url))return Promise.resolve([]);
 var controller=new AbortController();
 var timer=setTimeout(function(){controller.abort()},8000);

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
function fetchChanges(){
 if(!CFG.changesCsvUrl||/^PASTE_/.test(CFG.changesCsvUrl))return Promise.resolve([]);
 var controller=new AbortController();
 var timer=setTimeout(function(){controller.abort()},8000);
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
function changesWarningBanner(){
 if(!state.changesLoadFailed)return '';
 return '<div class="data-warning"><b>Today’s cancellations and cover couldn’t be loaded.</b> '+
  'What you see below may not reflect a last-minute change. Pull down to refresh and try again.</div>';
}
function nameKey(s){return String(s||'').trim().toLowerCase().replace(/\s+/g,' ')}
function splitCoaches(s){return String(s||'').split(',').map(function(x){return x.trim()}).filter(Boolean)}
function parseDate(s){if(!s)return null;var m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);return m?new Date(+m[1],+m[2]-1,+m[3],12):null}
function mondayOf(d){d=new Date(d||new Date());d.setHours(12,0,0,0);var day=d.getDay()||7;d.setDate(d.getDate()-day+1);return d}
function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function money(v){var n=Number(v);return isFinite(n)?new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(n):'—'}
function demoData(){
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
function load(){
 if(DEMO){demoData();render();return}
 root.innerHTML='<div class="loading">Loading your hub…</div>';
 Promise.all([
 fetchCsv(CFG.sessionsCsvUrl,true),
 fetchCsv(CFG.calendarCsvUrl,false),
 fetchChanges(),
 fetchCsv(CFG.termsCsvUrl,false),
 fetchCsv(CFG.themesCsvUrl,false),
 HubContent.loadResources().catch(function(){return []}),
 HubContent.loadVenues().catch(function(){return []}),
 HubContent.loadCoachSupport().catch(function(){return []})
]).then(function(all){

  var ss=all[0];state.sessions=ss.map(function(r){return {id:r.session_id,name:r.session_name,programme:r.programme,category:r.category,ageGroup:r.age_group,day:r.day,time:r.time,venue:r.venue,address:r.address,coaches:splitCoaches(r.coaches),client:r.client,hours:r.hours}});
  all[1].forEach(function(r){var d=parseDate(r.week_commencing);if(d)state.calendar[iso(mondayOf(d))]={label:r.label||'',weekNo:r.week_no||'',running:!/^(no|n|0|false)$/i.test(r.running||'yes')}});
  state.changes=all[2];state.terms=all[3];all[4].forEach(function(r){var d=parseDate(r.week_commencing);if(!d)return;var k=iso(mondayOf(d));state.themes[k]=state.themes[k]||{};state.themes[k][nameKey(r.category)]=r.theme||''});
  state.resources=all[5]||[];
  (all[6]||[]).forEach(function(v){if(!v.name)return;state.venueInfo[venueKey(v.name)]={venue:v.name,address:v.address||'',postcode:v.postcode||'',parking:v.parking||'',meetingPoint:v.meeting_point||'',access:v.access||'',notes:v.notes||'',heroImageUrl:v.hero_image_url||'',parkingImageUrl:v.parking_image_url||'',siteMapUrl:v.site_map_url||''}});
  state.coachSupport=all[7]||[];
  state.week=iso(mondayOf(new Date()));render();
 }).catch(function(e){root.innerHTML='<div class="error"><b>Could not load the Hub.</b><br>'+esc(e.message)+'</div>'})
}
function mine(){return state.sessions.filter(function(s){return !state.me||s.coaches.some(function(c){return nameKey(c)===nameKey(state.me.name)})})}
function dayIndex(day){return DAY_ORDER.indexOf(day)}
function sessionsForDisplay(){return mine().slice().sort(function(a,b){var d=dayIndex(a.day)-dayIndex(b.day);if(d)return d;return timeStartMinutes(a.time)-timeStartMinutes(b.time)})}
function todayName(d){d=d||new Date();return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]}
function venueKey(v){return nameKey(v)}
function themeForAt(s,d){var w=state.themes[iso(mondayOf(d))]||{};return w[nameKey(s.category)]||''}
function themeFor(s){return themeForAt(s,new Date())}
function sessionRow(s,accent){return '<button class="session-row" data-session="'+esc(s.id)+'"><span class="session-accent '+(accent||'')+'"></span><span><span class="session-time">'+esc(s.time)+'</span><span class="session-title">'+esc(s.name)+'</span><span class="session-sub">'+esc(s.venue)+'</span></span><span class="chev">›</span></button>'}
function parseClockPart(raw, fallbackMeridiem){
 var t=String(raw||'').trim().toLowerCase().replace(/\./g,'');
 var m=t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/); if(!m)return null;
 var h=+m[1],min=+(m[2]||0),mer=m[3]||fallbackMeridiem||'';
 if(mer==='pm'&&h<12)h+=12; if(mer==='am'&&h===12)h=0;
 return {minutes:h*60+min,mer:mer};
}
function timeRange(time){
 var parts=String(time||'').replace(/[–—]/g,'-').split('-');
 var endRaw=(parts[1]||'').trim(), startRaw=(parts[0]||'').trim();
 var endMer=((endRaw.toLowerCase().match(/(am|pm)/)||[])[1])||'';
 var st=parseClockPart(startRaw,endMer), en=parseClockPart(endRaw,st&&st.mer); if(!st)return {start:9999,end:9999};
 if(!en)en={minutes:st.minutes+60};
 if(en.minutes<=st.minutes && !/(am|pm)/i.test(startRaw) && endMer==='pm' && st.minutes<720) st.minutes+=720;
 return {start:st.minutes,end:en.minutes};
}
function timeStartMinutes(t){return timeRange(t).start}
function dateAtMinutes(d,mins){var x=new Date(d);x.setHours(Math.floor(mins/60),mins%60,0,0);return x}
function formatMinutes12(mins){if(!isFinite(mins)||mins>=9999)return '—';var h=Math.floor(mins/60)%24,m=mins%60,mer=h>=12?'PM':'AM',h12=h%12||12;return h12+':'+pad2(m)+' '+mer}
function formatTimeRange(t){var r=timeRange(t);if(r.start>=9999)return String(t||'—');return formatMinutes12(r.start)+' → '+formatMinutes12(r.end)}
function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}
function weekIsoFor(d){return iso(mondayOf(d))}
function calendarAllows(d){var c=state.calendar[weekIsoFor(d)];return !c||c.running!==false}
function schoolTermRows(s){var k=nameKey(s.client||s.venue||'');return (state.terms||[]).filter(function(r){return nameKey(r.school)===k})}
function termAllows(s,d){var rows=schoolTermRows(s);if(!rows.length)return true;var md=mondayOf(d);return rows.some(function(r){var a=parseDate(r.starts),b=parseDate(r.ends);return (!a||md>=mondayOf(a))&&(!b||md<=mondayOf(b))})}
function changesForDate(d){var wk=weekIsoFor(d);return (state.changes||[]).filter(function(r){var x=parseDate(r.week_commencing||r.date);return x&&iso(mondayOf(x))===wk})}
function changeHits(ch,s){if(ch.session_id)return String(ch.session_id).trim()===s.id;if(ch.venue)return venueKey(ch.venue)===venueKey(s.venue);if(ch.client)return nameKey(ch.client)===nameKey(s.client||'');if(ch.coach_out)return s.coaches.some(function(c){return nameKey(c)===nameKey(ch.coach_out)});return false}
function assignmentStatus(s,d,coach){var hits=changesForDate(d).filter(function(ch){return changeHits(ch,s)}),cancel=false,coveredOut=false,coveredIn=false;hits.forEach(function(ch){var typ=nameKey(ch.type);if(typ==='cancelled'||typ==='canceled')cancel=true;if(typ==='cover'){if(nameKey(ch.coach_out)===nameKey(coach))coveredOut=true;if(nameKey(ch.coach_in)===nameKey(coach))coveredIn=true}});return {cancelled:cancel,coveredOut:coveredOut,coveredIn:coveredIn}}
function sessionRunsForCoach(s,d){if(!calendarAllows(d)||!termAllows(s,d))return false;var st=assignmentStatus(s,d,state.me?state.me.name:'');var base=s.coaches.some(function(c){return state.me&&nameKey(c)===nameKey(state.me.name)});return !st.cancelled&&((base&&!st.coveredOut)||st.coveredIn)}
function occurrenceFor(s,d){var r=timeRange(s.time);return {session:s,date:new Date(d),start:dateAtMinutes(d,r.start),end:dateAtMinutes(d,r.end)}}
function todaysOccurrences(now){now=now||new Date();return state.sessions.filter(function(s){return s.day===todayName(now)&&sessionRunsForCoach(s,now)}).map(function(s){return occurrenceFor(s,now)}).sort(function(a,b){return a.start-b.start})}
function nextOccurrence(now){now=now||new Date();for(var add=0;add<35;add++){var d=new Date(now);d.setHours(12,0,0,0);d.setDate(d.getDate()+add);var list=state.sessions.filter(function(s){return s.day===todayName(d)&&sessionRunsForCoach(s,d)}).map(function(s){return occurrenceFor(s,d)}).filter(function(o){return add>0||o.end>now}).sort(function(a,b){return a.start-b.start});if(list.length)return list[0]}return null}
function countdownText(o,now){if(!o)return '';now=now||new Date();if(now>=o.start&&now<o.end)return 'In progress';var ms=o.start-now;if(ms<=0)return 'Starting now';var mins=Math.ceil(ms/60000),days=Math.floor(mins/1440);if(days>0)return 'In '+days+'d '+Math.floor((mins%1440)/60)+'h';var h=Math.floor(mins/60),m=mins%60;return 'In '+(h?h+'h ':'')+m+'m'}
function greeting(){var h=new Date().getHours();return h<12?'Good morning':h<18?'Good afternoon':'Good evening'}
function setNav(screen){document.querySelectorAll('[data-nav]').forEach(function(b){b.classList.toggle('is-active',b.dataset.nav===screen)})}
function navSnapshot(){return {screen:state.screen,scheduleView:state.scheduleView,scheduleWeekOffset:state.scheduleWeekOffset,calendarCursor:state.calendarCursor?iso(state.calendarCursor):null,calendarSelected:state.calendarSelected?iso(state.calendarSelected):null,expandedDay:state.expandedDay}}
function pushNavState(){state.navStack.push(navSnapshot());if(state.navStack.length>20)state.navStack.shift()}
function syncBackButton(){var b=document.getElementById('app-back');if(b)b.hidden=!state.navStack.length}
function navigateTo(screen){if(screen!==state.screen){pushNavState();state.screen=screen}render()}
function goBack(){var p=state.navStack.pop();if(!p){state.screen='home';render();return}state.screen=p.screen;state.scheduleView=p.scheduleView||state.scheduleView;state.scheduleWeekOffset=p.scheduleWeekOffset||0;state.calendarCursor=p.calendarCursor?parseDate(p.calendarCursor):state.calendarCursor;state.calendarSelected=p.calendarSelected?parseDate(p.calendarSelected):state.calendarSelected;state.expandedDay=p.expandedDay||null;render()}
/**
 * The four tab-bar screens stay permanently built in the DOM, one pane
 * each, and switching between them just toggles which pane is hidden -
 * mirrors how the live Hub's setView() works, so tapping a tab is an
 * instant switch rather than a teardown-and-rebuild of the whole screen.
 * Everything reached by drilling into a card (session/venue detail,
 * Coach Support, Management) still fully replaces root, which is what
 * going a level deeper is expected to feel like.
 */
var panes={};
var TAB_SCREENS={home:1,schedule:1,resources:1,more:1};
function ensureTabShell(){
 if(panes.home&&root.contains(panes.home))return;
 root.innerHTML='';
 panes={};
 Object.keys(TAB_SCREENS).forEach(function(name){var d=document.createElement('div');d.hidden=true;root.appendChild(d);panes[name]=d});
}
function renderIntoPane(name,fn){var saved=root;root=panes[name];fn();root=saved}
function reRenderSchedule(){renderIntoPane('schedule',renderSchedule)}
function render(){document.getElementById('app').classList.remove('auth-mode');setNav(state.screen);if(state.role!=='coach'){root.innerHTML='<div class="page-title"><h1>'+esc(state.role.charAt(0).toUpperCase()+state.role.slice(1))+' Hub</h1><p>This role shell is ready for its own screens. Coach screens remain separate.</p></div>';syncBackButton();return}if(TAB_SCREENS[state.screen]){ensureTabShell();renderIntoPane(state.screen,{home:renderHome,schedule:renderSchedule,resources:renderResources,more:renderMore}[state.screen]);Object.keys(panes).forEach(function(k){panes[k].hidden=(k!==state.screen)});window.scrollTo(0,0)}else if(state.screen==='venues')renderVenues();else if(state.screen==='venue-detail')renderVenueDetail(state.selectedVenue);else if(state.screen==='support')renderSupport();else if(state.screen==='management')renderManagement();syncBackButton()}
function renderHome(){
 var now=new Date(),n=nextOccurrence(now),today=todaysOccurrences(now),ns=n&&n.session;
 root.innerHTML='<div class="coach-home">'+
 changesWarningBanner()+
 (n?'<section class="next-home-card" data-session="'+esc(ns.id)+'" data-date="'+iso(n.date)+'"><div class="next-home-head"><span>NEXT SESSION</span><span class="next-arrow">›</span></div><div class="next-home-body"><h1>'+esc(ns.name)+'</h1><div class="home-meta"><span>'+icons.clock+'</span><b>'+esc(ns.time)+'</b></div><div class="home-meta"><span>'+icons.pin+'</span><span>'+esc(ns.venue)+'</span></div><span class="countdown-pill" id="next-countdown" data-start="'+n.start.toISOString()+'" data-end="'+n.end.toISOString()+'">'+esc(countdownText(n,now))+'</span></div></section>':'<section class="next-home-card empty"><div class="next-home-head"><span>NEXT SESSION</span></div><div class="next-home-body"><h1>No upcoming sessions</h1></div></section>')+
 '<section class="today-home"><div class="home-section-title"><h2>TODAY’S SESSIONS</h2><button data-nav="schedule">View all</button></div><div class="today-home-list">'+(today.length?today.map(function(o,i){var s=o.session;return '<button class="today-home-row" data-session="'+esc(s.id)+'" data-date="'+iso(o.date)+'"><span class="today-line"></span><span class="today-time">'+esc(s.time.split(/\s*[-–—]\s*/)[0])+'</span><span class="today-copy"><b>'+esc(s.name)+'</b><small>'+esc(s.venue)+'</small></span><span class="chev">›</span></button>'}).join(''):'<div class="today-empty">No sessions today.</div>')+'</div></section>'+
 '<section class="home-shortcuts"><button data-nav="schedule"><span>▣</span><b>My Schedule</b></button><button data-nav="resources"><span>▤</span><b>Resources</b></button><button data-nav="venues"><span>⌖</span><b>Venues</b></button><button data-nav="support"><span>▧</span><b>Coach Support</b></button></section>'+
 '</div>';
 startCountdownTicker();
}
var countdownTimer=null;
function startCountdownTicker(){if(countdownTimer)clearInterval(countdownTimer);function tick(){var el=document.getElementById('next-countdown');if(!el)return;var o={start:new Date(el.dataset.start),end:new Date(el.dataset.end)};el.textContent=countdownText(o,new Date())}tick();countdownTimer=setInterval(tick,30000)}
function pad2(n){return String(n).padStart(2,'0')}
function formatDateLong(d){return d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
function formatDateShort(d){return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}
function addDays(d,n){var x=new Date(d);x.setHours(12,0,0,0);x.setDate(x.getDate()+n);return x}
function allowedScheduleStart(){return mondayOf(new Date())}
function allowedScheduleEnd(){return addDays(allowedScheduleStart(),27)}
function inScheduleWindow(d){var x=new Date(d);x.setHours(12,0,0,0);return x>=allowedScheduleStart()&&x<=allowedScheduleEnd()}
function academicYearStart(){var n=new Date(),y=n.getMonth()>=8?n.getFullYear():n.getFullYear()-1;return new Date(y,8,1,12)}
function academicYearEnd(){var s=academicYearStart();return new Date(s.getFullYear()+1,7,31,12)}
function inCalendarYear(d){var x=new Date(d);x.setHours(12,0,0,0);return x>=academicYearStart()&&x<=academicYearEnd()}
function coachAssignment(s,d){if(!calendarAllows(d)||!termAllows(s,d))return null;var coach=state.me?state.me.name:'',hits=changesForDate(d).filter(function(ch){return changeHits(ch,s)}),base=s.coaches.some(function(c){return nameKey(c)===nameKey(coach)}),cancel=false,out=false,coverIn=false;hits.forEach(function(ch){var typ=nameKey(ch.type);if(typ==='cancelled'||typ==='canceled')cancel=true;if(typ==='cover'){if(nameKey(ch.coach_out)===nameKey(coach))out=true;if(nameKey(ch.coach_in)===nameKey(coach))coverIn=true}});if(out&&!coverIn)return null;if(cancel&&base)return 'cancelled';if(coverIn)return 'cover';if(base)return 'normal';return null}
function extraOccurrences(d){var coach=state.me?state.me.name:'';return changesForDate(d).filter(function(ch){if(nameKey(ch.type)!=='extra')return false;if(ch.day&&nameKey(ch.day)!==nameKey(todayName(d)))return false;return nameKey(ch.coach_in||ch.coach||'')===nameKey(coach)}).map(function(ch,i){var s={id:'extra-'+weekIsoFor(d)+'-'+i,name:ch.session_name||'Extra session',programme:'Extra',category:ch.category||'Extra',ageGroup:ch.age_group||'',day:ch.day||todayName(d),time:ch.time||'',venue:ch.venue||ch.client||'Venue TBC',address:'',coaches:[coach],client:ch.client||'',hours:'',note:ch.note||''};state.virtualSessions[s.id]=s;var o=occurrenceFor(s,d);o.status='extra';return o})}
function scheduleOccurrencesForDate(d){var list=state.sessions.filter(function(s){return s.day===todayName(d)}).map(function(s){var status=coachAssignment(s,d);if(!status)return null;var o=occurrenceFor(s,d);o.status=status;return o}).filter(Boolean);return list.concat(extraOccurrences(d)).sort(function(a,b){return a.start-b.start})}
function statusLabel(st){return st==='cancelled'?'Cancelled':st==='cover'?'Cover':st==='extra'?'Extra':''}
function statusClass(st){return st==='cancelled'?'is-cancelled':st==='cover'?'is-cover':st==='extra'?'is-extra':'is-normal'}
function statusHeading(st){return st==='extra'?'EXTRA SESSION':st==='cover'?'COVER SESSION':st==='cancelled'?'CANCELLED':''}
function themeForScheduleOccurrence(o){var s=o.session,theme=themeForAt(s,o.date);if(theme||o.status!=='extra')return theme;var match=state.sessions.find(function(base){return nameKey(base.name)===nameKey(s.name)})||state.sessions.find(function(base){return s.venue&&venueKey(base.venue)===venueKey(s.venue)&&base.day===s.day});return match?themeForAt(match,o.date):''}
function scheduleCard(o,compact){var s=o.session,theme=themeForScheduleOccurrence(o),label=statusLabel(o.status),heading=statusHeading(o.status);return '<button class="schedule-session '+statusClass(o.status)+(compact?' compact':'')+'" data-session="'+esc(s.id)+'" data-date="'+iso(o.date)+'"><span class="schedule-accent"></span><span class="schedule-time"><b>'+esc(formatTimeRange(s.time))+'</b></span><span class="schedule-copy">'+(heading?'<span class="schedule-status-heading">'+esc(heading)+'</span>':'')+'<b>'+esc(s.name)+'</b><small>'+esc(s.venue)+'</small>'+(compact?'':'<span class="schedule-tags">'+(s.ageGroup?'<i>'+esc(s.ageGroup)+'</i>':'')+(s.category?'<i>'+esc(s.category)+'</i>':'')+(label?'<i class="status-chip">'+esc(label)+'</i>':'')+'</span>')+(theme?'<span class="theme-chip"><strong>Theme:</strong> '+esc(theme)+'</span>':'')+'</span><span class="chev">›</span></button>'}
function scheduleTabs(){return '<div class="schedule-tabs"><button data-action="schedule-view" data-view="today" class="'+(state.scheduleView==='today'?'is-active':'')+'">Today</button><button data-action="schedule-view" data-view="week" class="'+(state.scheduleView==='week'?'is-active':'')+'">This Week</button><button data-action="schedule-view" data-view="calendar" class="'+(state.scheduleView==='calendar'?'is-active':'')+'">Calendar</button></div>'}
function renderTodaySchedule(){var d=new Date(),list=scheduleOccurrencesForDate(d);return '<section class="schedule-panel"><div class="schedule-date-heading"><h2>'+esc(formatDateLong(d))+'</h2><span>'+list.length+' session'+(list.length===1?'':'s')+'</span></div><div class="schedule-list">'+(list.length?list.map(function(o){return scheduleCard(o,false)}).join(''):'<div class="schedule-empty">No sessions today.</div>')+'</div></section><button class="calendar-action" data-action="calendar-options" data-scope="day" data-date="'+iso(d)+'">▣ Add to Calendar <span>⌄</span></button>'}
function workingDaysForWeek(weekStart){var out=[];for(var i=0;i<7;i++){var d=addDays(weekStart,i),list=scheduleOccurrencesForDate(d);if(list.length)out.push({date:d,list:list})}return out}
function renderWeekSchedule(){var start=addDays(allowedScheduleStart(),state.scheduleWeekOffset*7),end=addDays(start,6),days=workingDaysForWeek(start),today=new Date(),isCurrent=state.scheduleWeekOffset===0;return '<section class="week-nav"><button data-action="week-shift" data-dir="-1" '+(state.scheduleWeekOffset===0?'disabled':'')+'>‹</button><b>'+esc(formatDateShort(start))+' – '+esc(formatDateShort(end))+'</b><button data-action="week-shift" data-dir="1" '+(state.scheduleWeekOffset===3?'disabled':'')+'>›</button></section><section class="week-stack">'+(days.length?days.map(function(g){var key=iso(g.date),open=(isCurrent&&sameDay(g.date,today))||state.expandedDay===key;return '<article class="week-day '+(open?'is-open':'')+'"><button class="week-day-head" data-action="toggle-day" data-date="'+key+'"><span><b>'+esc(formatDateLong(g.date))+'</b><small>'+g.list.length+' session'+(g.list.length===1?'':'s')+'</small></span><span>'+(open?'⌃':'⌄')+'</span></button>'+(open?'<div class="week-day-list">'+g.list.map(function(o){return scheduleCard(o,true)}).join('')+'</div>':'')+'</article>'}).join(''):'<div class="schedule-empty">No sessions this week.</div>')+'</section><button class="calendar-action" data-action="calendar-options" data-scope="week" data-date="'+iso(start)+'">▣ Add this week to Calendar <span>⌄</span></button>'}
function monthName(d){return d.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}
function monthGrid(cursor,selected){var y=cursor.getFullYear(),m=cursor.getMonth(),first=new Date(y,m,1,12),startOffset=(first.getDay()+6)%7,days=new Date(y,m+1,0).getDate(),cells='';for(var i=0;i<startOffset;i++)cells+='<span class="cal-cell is-blank"></span>';for(var day=1;day<=days;day++){var d=new Date(y,m,day,12),allowed=inCalendarYear(d),list=allowed?scheduleOccurrencesForDate(d):[],sel=selected&&sameDay(d,selected);cells+='<button class="cal-cell '+(allowed?'':'is-disabled')+(sel?' is-selected':'')+'" '+(allowed?'data-action="select-date" data-date="'+iso(d)+'"':'disabled')+'><b>'+day+'</b>'+(list.length?'<i></i>':'')+'</button>'}return cells}
function renderCalendarSchedule(){var today=new Date(),ayStart=academicYearStart(),ayEnd=academicYearEnd();if(!state.calendarCursor)state.calendarCursor=new Date(today.getFullYear(),today.getMonth(),1,12);if(!state.calendarSelected||!inCalendarYear(state.calendarSelected))state.calendarSelected=new Date(today.getFullYear(),today.getMonth(),today.getDate(),12);var cursor=state.calendarCursor,sel=state.calendarSelected,list=scheduleOccurrencesForDate(sel),prev=new Date(cursor.getFullYear(),cursor.getMonth()-1,1,12),next=new Date(cursor.getFullYear(),cursor.getMonth()+1,1,12),canPrev=new Date(prev.getFullYear(),prev.getMonth()+1,0,12)>=ayStart,canNext=next<=ayEnd;return '<section class="calendar-card"><div class="calendar-head"><button data-action="month-shift" data-dir="-1" '+(canPrev?'':'disabled')+'>‹</button><b>'+esc(monthName(cursor))+'</b><button data-action="month-shift" data-dir="1" '+(canNext?'':'disabled')+'>›</button></div><div class="calendar-year-note">Academic year · September '+ayStart.getFullYear()+' – August '+ayEnd.getFullYear()+'</div><div class="calendar-weekdays"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="calendar-grid">'+monthGrid(cursor,sel)+'</div></section><section class="schedule-panel calendar-results"><div class="schedule-date-heading"><h2>'+esc(formatDateLong(sel))+'</h2><span>'+list.length+' session'+(list.length===1?'':'s')+'</span></div><div class="schedule-list">'+(list.length?list.map(function(o){return scheduleCard(o,true)}).join(''):'<div class="schedule-empty">No sessions on this date.</div>')+'</div></section><button class="calendar-action" data-action="calendar-options" data-scope="day" data-date="'+iso(sel)+'">▣ Add selected date to Calendar <span>⌄</span></button>'}
function renderSchedule(){state.virtualSessions={};var body=state.scheduleView==='week'?renderWeekSchedule():state.scheduleView==='calendar'?renderCalendarSchedule():renderTodaySchedule();root.innerHTML='<div class="coach-schedule">'+changesWarningBanner()+'<div class="page-title schedule-title"><h1>Schedule</h1><p>Today and This Week show the current week plus the next 3 weeks. Calendar covers the full academic year.</p></div>'+scheduleTabs()+body+'</div>'}
function findSession(id){return state.sessions.find(function(s){return s.id===id})||state.virtualSessions[id]}
function venueDetailsFor(s){var direct=state.venueInfo[venueKey(s.venue)]||null;if(direct)return direct;var alias=(CFG.venueAliases||{})[s.venue];if(alias&&state.venueInfo[venueKey(alias)])return state.venueInfo[venueKey(alias)];return {venue:s.venue,address:s.address||'',postcode:'',parking:'',meetingPoint:'',access:'',notes:''}}
function sessionNoteFor(s,d){if(s.note)return s.note;var notes=changesForDate(d).filter(function(ch){return changeHits(ch,s)&&ch.note}).map(function(ch){return ch.note.trim()}).filter(Boolean);return notes[0]||''}
function renderSession(id,dateIso){var s=findSession(id);if(!s)return;var d=dateIso?parseDate(dateIso):(state.sessionDate?parseDate(state.sessionDate):new Date());state.sessionDate=iso(d);state.screen='session';setNav('schedule');var fin=state.unlocked&&state.financials&&state.financials[s.id],theme=themeForAt(s,d),status=s.id.indexOf('extra-')===0?'extra':(coachAssignment(s,d)||'normal'),vd=venueDetailsFor(s),note=sessionNoteFor(s,d),others=s.coaches.filter(function(c){return !state.me||nameKey(c)!==nameKey(state.me.name)}),address=[vd.address||s.address||'',vd.postcode||''].filter(Boolean).join(', '),statusHead=statusHeading(status);
 root.innerHTML='<section class="detail-hero session-detail-hero"><button class="back-btn" data-action="app-back">‹ Back</button>'+(statusHead?'<span class="detail-status '+statusClass(status)+'">'+esc(statusHead)+'</span>':'')+'<h1>'+esc(s.name)+'</h1><p>'+esc(s.category||s.programme||'Session')+'</p></section>'+
 '<div class="session-detail-wrap"><section class="card detail-card session-info-card"><div class="detail-row"><span class="detail-icon">▣</span><span><b>Date</b><small>'+esc(formatDateLong(d))+'</small></span></div><div class="detail-row"><span class="detail-icon">◷</span><span><b>Start → Finish</b><small>'+esc(formatTimeRange(s.time))+'</small></span></div><div class="detail-row"><span class="detail-icon">⌖</span><span><b>Venue</b><small>'+esc(s.venue)+(address?'<br>'+esc(address):'')+'</small></span></div><div class="detail-row"><span class="detail-icon">●</span><span><b>Coaching with</b><small>'+esc(others.length?others.join(' & '):'You are the only coach listed')+'</small></span></div>'+(theme?'<div class="detail-row theme-row"><span class="detail-icon">◎</span><span><b>Theme</b><small>'+esc(theme)+'</small></span></div>':'')+'</section>'+
 '<section class="card detail-notes"><div class="detail-section-head"><span class="detail-icon">✎</span><b>Notes</b></div><p>'+esc(note||'No additional notes for this session.')+'</p></section>'+
 '<section class="detail-actions"><button class="primary-btn" data-action="calendar-session" data-session="'+esc(s.id)+'" data-date="'+iso(d)+'">▣ Add to Calendar</button><button class="secondary-btn" data-action="venue-detail" data-venue="'+esc(s.venue)+'">⌖ Venue Details</button></section></div>'+
 (fin?'<div class="financial-mini"><b>Session Financials <small>(Management only)</small></b><div class="fm-row"><span>Participants</span><span>'+esc(fin.participants||'—')+'</span></div><div class="fm-row"><span>Revenue</span><span>'+money(fin.revenue_net||fin.revenue_gross)+'</span></div><div class="fm-row"><span>Coach cost</span><span>'+money(fin.coach_cost)+'</span></div><div class="fm-row"><span>Venue cost</span><span>'+money(fin.venue_cost)+'</span></div><div class="fm-row profit"><span>Profit</span><span>'+money(fin.profit)+'</span></div></div>':'')}
function canonicalVenueName(name){var alias=(CFG.venueAliases||{})[name];return alias||name}
function venueInfoForName(name){var direct=state.venueInfo[venueKey(name)];if(direct)return direct;var canon=canonicalVenueName(name),via=state.venueInfo[venueKey(canon)];if(via)return via;return {venue:canon||name,address:'',postcode:'',parking:'',meetingPoint:'',access:'',notes:''}}
function sameVenueName(a,b){return venueKey(canonicalVenueName(a))===venueKey(canonicalVenueName(b))}
function venueListData(){var map={};state.sessions.forEach(function(s){if(!s.venue)return;var name=canonicalVenueName(s.venue),k=venueKey(name),info=venueInfoForName(s.venue);if(!map[k])map[k]={name:name,address:info.address||s.address||'',postcode:info.postcode||'',sourceNames:[]};if(map[k].sourceNames.indexOf(s.venue)<0)map[k].sourceNames.push(s.venue)});Object.keys(state.venueInfo).forEach(function(k){var info=state.venueInfo[k];if(!info||!info.venue)return;var name=canonicalVenueName(info.venue),kk=venueKey(name);if(!map[kk])map[kk]={name:name,address:info.address||'',postcode:info.postcode||'',sourceNames:[info.venue]}});return Object.values(map).sort(function(a,b){return a.name.localeCompare(b.name)})}
function coachSessionsAtVenueThisWeek(name){var start=mondayOf(new Date()),list=[];for(var i=0;i<7;i++){var d=addDays(start,i);scheduleOccurrencesForDate(d).forEach(function(o){if(sameVenueName(o.session.venue,name))list.push(o)})}return list.sort(function(a,b){return a.start-b.start})}
function renderVenues(){var q=nameKey(state.venueQuery||''),vs=venueListData().filter(function(v){return !q||nameKey(v.name+' '+v.address+' '+v.postcode).indexOf(q)>=0});root.innerHTML='<div class="venues-page"><div class="page-title"><h1>Venues</h1><p>Arrival information, access details and your sessions at each venue.</p></div><div class="search"><input id="venue-search" value="'+esc(state.venueQuery||'')+'" placeholder="Search venues…" autocomplete="off"></div><div class="venue-list">'+(vs.length?vs.map(function(v){var count=coachSessionsAtVenueThisWeek(v.name).length,address=[v.address,v.postcode].filter(Boolean).join(', ');return '<button class="card venue-card venue-card-v1" data-action="venue-detail" data-venue="'+esc(v.name)+'"><span class="venue-pin">⌖</span><span class="venue-card-copy"><h3>'+esc(v.name)+'</h3><p>'+esc(address||'Venue information')+'</p><small>'+count+' of your session'+(count===1?'':'s')+' here this week</small></span><span class="chev">›</span></button>'}).join(''):'<div class="schedule-empty">No venues match your search.</div>')+'</div></div>'}
function venueInfoRows(info){var rows=[['Parking',info.parking],['Where to meet',info.meetingPoint],['Access',info.access],['Useful notes',info.notes]];return rows.filter(function(r){return r[1]}).map(function(r){return '<div class="venue-info-row"><b>'+esc(r[0])+'</b><span>'+esc(r[1])+'</span></div>'}).join('')}
function renderVenueDetail(name){if(!name){state.screen='venues';renderVenues();return}state.selectedVenue=name;state.screen='venue-detail';setNav('home');var info=venueInfoForName(name),fallback=state.sessions.find(function(s){return sameVenueName(s.venue,name)}),address=info.address||(fallback&&fallback.address)||'',postcode=info.postcode||'',where=[address,postcode].filter(Boolean).join(', '),week=coachSessionsAtVenueThisWeek(name),query=where||name,rows=venueInfoRows(info);root.innerHTML='<section class="detail-hero venue-detail-hero"><button class="back-btn" data-action="app-back">‹ Back</button><span class="venue-detail-icon">⌖</span><h1>'+esc(canonicalVenueName(name))+'</h1><p>'+esc(where||'Venue information')+'</p></section><div class="venue-detail-wrap"><section class="card venue-overview-card"><div class="venue-address-block"><span class="detail-icon">⌖</span><span><b>Address</b><small>'+esc(where||'Address not yet added')+'</small></span></div>'+(rows||'<div class="venue-info-empty">Parking, meeting point, access and notes can be added on the Venues table in Airtable.</div>')+'</section><a class="primary-btn venue-directions" href="https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(query)+'" target="_blank" rel="noopener">⌖ Get Directions</a><section class="venue-week"><div class="home-section-title"><h2>YOUR SESSIONS HERE THIS WEEK</h2><span>'+week.length+'</span></div><div class="card venue-week-list">'+(week.length?week.map(function(o){var s=o.session,heading=statusHeading(o.status);return '<button class="venue-week-session" data-session="'+esc(s.id)+'" data-date="'+iso(o.date)+'"><span class="venue-week-date"><b>'+esc(o.date.toLocaleDateString('en-GB',{weekday:'short'}))+'</b><small>'+esc(formatDateShort(o.date))+'</small></span><span><i>'+esc(formatTimeRange(s.time))+'</i><b>'+esc(s.name)+'</b>'+(heading?'<small>'+esc(heading)+'</small>':'')+'</span><span class="chev">›</span></button>'}).join(''):'<div class="venue-no-sessions">You have no sessions at this venue this week.</div>')+'</div></section></div>'}

function renderResources(){
 var list=state.resources||[];
 root.innerHTML='<div class="page-title"><h1>Resources</h1><p>Session plans, curriculum, drills and useful documents.</p></div><div class="resource-grid">'+
  (list.length?list.map(function(r,i){
   var href=r.attachment_url||r.external_link||r.video_url||'';
   var img=r.thumbnail_url?'<img src="'+esc(r.thumbnail_url)+'" alt="">':'';
   var gradient=['','alt','warm'][i%3];
   var body='<div class="resource-img'+(img?' has-image':' '+gradient)+'">'+(img||esc(r.title))+'</div><div class="resource-body">'+
    (r.category?'<span class="pill blue">'+esc(r.category)+'</span>':'')+'<h3>'+esc(r.title)+'</h3>'+
    (r.description?'<p>'+esc(r.description)+'</p>':'')+'</div>';
   return href?'<a class="card resource-card" href="'+esc(href)+'" target="_blank" rel="noopener">'+body+'</a>':'<article class="card resource-card">'+body+'</article>';
  }).join(''):'<div class="schedule-empty">Nothing here yet — add a resource in Airtable and it appears here automatically.</div>')+
 '</div>';
}
function renderSupport(){
 var list=state.coachSupport||[];
 root.innerHTML='<div class="page-title"><h1>Coach Support Centre</h1><p>Everything you need to be the best version of yourself as a coach.</p></div><div class="card support-list">'+
  (list.length?list.map(function(s){
   return '<button class="support-row" data-action="support-detail" data-support="'+esc(s.support_id)+'"><span class="support-icon">'+icons.book+'</span><span><b>'+esc(s.title)+'</b>'+(s.section?'<small>'+esc(s.section)+'</small>':'')+'</span><span>›</span></button>';
  }).join(''):'<div class="schedule-empty">Nothing here yet — add an item to the Coach Support table in Airtable.</div>')+
 '</div><div class="quote-card card" style="margin-top:14px"><strong>“Better people make better players.”</strong></div>';
}
function openSupportDetail(id){
 var s=(state.coachSupport||[]).find(function(x){return x.support_id===id});
 if(!s)return;
 sheet.hidden=false;
 sheetContent.innerHTML='<div class="calendar-sheet"><h3>'+esc(s.title)+'</h3>'+
  (s.section?'<p>'+esc(s.section)+'</p>':'')+
  '<p class="support-sheet-body">'+esc(s.body||'')+'</p>'+
  (s.external_link?'<a class="primary-btn sheet-link-btn" href="'+esc(s.external_link)+'" target="_blank" rel="noopener">Open link</a>':'')+
  (s.attachment_url?'<a class="secondary-btn sheet-link-btn" href="'+esc(s.attachment_url)+'" target="_blank" rel="noopener">Open attachment</a>':'')+
 '</div>';
}
function openProfileSheet(){
 var m=state.me||{},roleLabel=(state.role||'coach').replace(/^./,function(c){return c.toUpperCase()});
 sheet.hidden=false;
 sheetContent.innerHTML='<div class="calendar-sheet"><h3>My Profile</h3>'+
  '<div class="venue-info-row"><b>Name</b><span>'+esc(m.name||'Not set yet — ask Josh or David to add this')+'</span></div>'+
  '<div class="venue-info-row"><b>Email</b><span>'+esc(m.email||'—')+'</span></div>'+
  '<div class="venue-info-row"><b>Role</b><span>'+esc(roleLabel)+'</span></div>'+
 '</div>';
}
function renderMore(){var rows=[['●','My Profile',(state.me&&state.me.email)||'Update your details','','profile'],['◉','Notifications','Manage alerts','','coming-soon'],['£','Management & Financials','Restricted access','management',''],['●','Feedback','Share ideas or report an issue','','coming-soon'],['☎','Contact the Office','Get in touch','','coming-soon'],['↪','Log Out','','','logout']];root.innerHTML='<div class="page-title"><h1>More</h1><p>Your account, support and management access.</p></div><div class="card more-list">'+rows.map(function(r){return '<button class="more-row" '+(r[3]?'data-nav="'+r[3]+'"':'')+(r[4]?' data-action="'+r[4]+'"':'')+'><span class="support-icon">'+r[0]+'</span><span><b>'+r[1]+'</b><small>'+esc(r[2])+'</small></span><span>›</span></button>'}).join('')+'</div>'}
function renderManagement(){state.screen='management';setNav('more');if(state.unlocked){renderManagementDashboard();return}root.innerHTML='<section class="locked"><div class="page-title"><h1>Management Access</h1><p>Financials & administration. Restricted to authorised users.</p></div><div class="management-card"><h2>🔒 Enter password</h2><p style="color:var(--muted);font-size:12px">This uses the same protected Financials connection as the existing Hub.</p><div class="pw"><input id="pw" type="password" placeholder="Password"><button data-action="unlock">Access</button></div><p id="pw-error" style="color:var(--red);font-size:12px"></p></div><div class="card support-list" style="margin-top:14px;background:rgba(255,255,255,.98);color:var(--ink)"><div class="support-row"><span class="support-icon">▣</span><span><b>Full schedule view</b><small>All coaches, all sessions</small></span><span>›</span></div><div class="support-row"><span class="support-icon">▤</span><span><b>Financial dashboard</b><small>Live and historical data</small></span><span>›</span></div><div class="support-row"><span class="support-icon">●</span><span><b>Coach management</b><small>Hours, rates and costs</small></span><span>›</span></div></div></section>'}
function renderManagementDashboard(){var fs=state.financials||{};var rows=Object.values(fs),rev=rows.reduce(function(a,r){return a+(+r.revenue_net||0)},0),profit=rows.reduce(function(a,r){return a+(+r.profit||0)},0);root.innerHTML='<section class="locked"><div class="page-title"><h1>Management Dashboard</h1><p>Schedules, financials and administration.</p></div><div class="kpi-grid"><div class="kpi"><small>Sessions</small><b>'+state.sessions.length+'</b></div><div class="kpi"><small>Revenue</small><b>'+money(rev)+'</b></div><div class="kpi"><small>Profit</small><b>'+money(profit)+'</b></div><div class="kpi"><small>Coaches</small><b>'+new Set(state.sessions.flatMap(function(s){return s.coaches})).size+'</b></div></div><div class="card support-list" style="color:var(--ink)"><div class="support-row"><span class="support-icon">▣</span><span><b>Full schedule view</b><small>All coaches, all sessions</small></span><span>›</span></div><div class="support-row"><span class="support-icon">£</span><span><b>Financial dashboard</b><small>Baseline, actual and archive</small></span><span>›</span></div><div class="support-row"><span class="support-icon">●</span><span><b>Coach management</b><small>Hours, rates and costs</small></span><span>›</span></div><div class="support-row"><span class="support-icon">▧</span><span><b>Reports & exports</b><small>P&L, attendance and more</small></span><span>›</span></div></div></section>'}
function b64(b){var bin=atob(String(b).replace(/\s+/g,'')),o=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)o[i]=bin.charCodeAt(i);return o}
function unlock(pw){if(DEMO){state.unlocked=true;renderManagementDashboard();return}var f=CFG.financials;if(!f||!f.ciphertext){document.getElementById('pw-error').textContent='Financial connection is not configured.';return}crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']).then(function(base){return crypto.subtle.deriveKey({name:'PBKDF2',salt:b64(f.salt),iterations:f.iterations||250000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['decrypt'])}).then(function(key){return crypto.subtle.decrypt({name:'AES-GCM',iv:b64(f.iv)},key,b64(f.ciphertext))}).then(function(buf){return fetchCsv(new TextDecoder().decode(buf).trim())}).then(function(rows){state.financials={};rows.forEach(function(r){if(r.session_id)state.financials[r.session_id]=r});state.unlocked=true;renderManagementDashboard()}).catch(function(){document.getElementById('pw-error').textContent='Incorrect password.'})}
function icsStamp(d){return d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate())+'T'+pad2(d.getHours())+pad2(d.getMinutes())+'00'}
function makeCalendarFile(occurrences,label){if(!occurrences.length){toast('No sessions to add');return}var lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Josh Evans Hub//Coach Schedule//EN'];occurrences.forEach(function(o){var s=o.session;lines.push('BEGIN:VEVENT','UID:'+encodeURIComponent(s.id+'-'+iso(o.date))+'@joshevanshub','DTSTART:'+icsStamp(o.start),'DTEND:'+icsStamp(o.end),'SUMMARY:'+String(s.name||'Session').replace(/[,;]/g,' '),'LOCATION:'+String(s.venue||'').replace(/[,;]/g,' '),'DESCRIPTION:Josh Evans Coach Hub','END:VEVENT')});lines.push('END:VCALENDAR');var blob=new Blob([lines.join('\r\n')],{type:'text/calendar'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(label||'josh-evans-schedule').replace(/[^a-z0-9]+/gi,'-')+'.ics';a.click();setTimeout(function(){URL.revokeObjectURL(url)},1000);toast('Calendar file created')}
function occurrenceByIdDate(id,dateIso){var d=parseDate(dateIso),s=findSession(id);return s&&d?occurrenceFor(s,d):null}
function openCalendarOptions(scope,dateIso){var d=parseDate(dateIso)||new Date(),opts=[];if(scope==='week'){var list=[];for(var i=0;i<7;i++)list=list.concat(scheduleOccurrencesForDate(addDays(d,i)).filter(function(o){return o.status!=='cancelled'}));opts.push({label:'Add this visible week',count:list.length,list:list,file:'coach-week-'+iso(d)})}else{var day=scheduleOccurrencesForDate(d).filter(function(o){return o.status!=='cancelled'});opts.push({label:'Add selected day',count:day.length,list:day,file:'coach-day-'+iso(d)});var wk=mondayOf(d),week=[];for(var j=0;j<7;j++)week=week.concat(scheduleOccurrencesForDate(addDays(wk,j)).filter(function(o){return o.status!=='cancelled'}));opts.push({label:'Add whole week',count:week.length,list:week,file:'coach-week-'+iso(wk)})}sheet.hidden=false;sheetContent.innerHTML='<div class="calendar-sheet"><h3>Add to Calendar</h3><p>Choose what you want to add.</p>'+opts.map(function(o,i){return '<button data-action="calendar-download" data-option="'+i+'"><span><b>'+esc(o.label)+'</b><small>'+o.count+' session'+(o.count===1?'':'s')+'</small></span><span>›</span></button>'}).join('')+'</div>';sheetContent._calendarOptions=opts}
function closeSheet(){sheet.hidden=true;sheetContent.innerHTML='';sheetContent._calendarOptions=null}
function toast(t){var e=document.getElementById('toast');e.textContent=t;e.hidden=false;setTimeout(function(){e.hidden=true},1800)}
/**
 * Colour is a plain hex string set per-record in Airtable (Public Pages ->
 * Colour). Text automatically switches to dark when that colour is light,
 * so nobody has to also pick a matching text colour - one field, not two.
 */
function contrastIsLight(hex){
 var h=String(hex||'').trim().replace(/^#/,'');
 if(h.length===3)h=h.split('').map(function(c){return c+c}).join('');
 if(!/^[0-9a-f]{6}$/i.test(h))return false;
 var r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);
 return (0.299*r+0.587*g+0.114*b)/255>0.6;
}
var CATEGORY_ICON={general:'⌂',trials:'▣',academy:'●',tours:'◎',events:'◆',resources:'▧'};
function iconForCategory(cat){return CATEGORY_ICON[String(cat||'').trim().toLowerCase()]||'✦'}
/**
 * Any image, whatever size it was uploaded at in Airtable, is shown in a
 * fixed-height box and auto-cropped to fill it (background-size: cover) -
 * nobody ever needs to resize a photo to "fit" before uploading it. The
 * photo sits in its own contained strip rather than behind the text, so
 * a busy photo never fights with the title for legibility.
 */
function publicPageTile(p,i){
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
function publicFeaturedTile(p){
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
   '<span class="public-featured-enquiry">For general enquiries, click here</span>'+
  '</div>'+
 '</button>';
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
function renderPublicHome(){
 document.getElementById('app').classList.add('auth-mode');
 var org=(window.HubContent&&HubContent.get()&&HubContent.get().organisation)||{};
 var pages=state.publicPages||[];
 var featured=pages[0],rest=pages.slice(1);
 root.innerHTML='<div class="public-page">'+
  '<section class="public-hero">'+
   '<h1>'+esc(org.hub_name||'Josh Evans Hub')+'</h1>'+
   (org.tagline?'<p class="public-hero-tag">'+esc(org.tagline)+'</p>':'')+
   '<div class="public-hero-actions"><button class="secondary-btn" data-action="show-signin">Sign In</button><button class="primary-btn" data-action="show-signup">Register</button></div>'+
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
function ageGroupField(page){
 var options=String(page.age_groups||'').split(',').map(function(s){return s.trim()}).filter(Boolean);
 if(!options.length)return '<label class="auth-field">Age group<input id="ri-age" placeholder="e.g. 9" autocomplete="off"></label>';
 return '<label class="auth-field">Age group<select id="ri-age"><option value="">Choose one…</option>'+
  options.map(function(o){return '<option value="'+esc(o)+'">'+esc(o)+'</option>'}).join('')+
  '</select></label>';
}
function renderPublicDetail(pageId,submitted){
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
function submitRegisterInterest(pageId){
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
function loadPublicHome(){
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
function renderAuthShell(inner){document.getElementById('app').classList.add('auth-mode');root.innerHTML='<div class="auth-page"><div class="auth-card">'+
 '<img class="auth-logo" src="je-logo.png" alt="Josh Evans Soccer School">'+inner+'</div></div>';window.scrollTo(0,0)}
function renderAuthMessage(title,body,showLogout,showBack){renderAuthShell('<h1>'+esc(title)+'</h1><p class="auth-sub">'+esc(body)+'</p>'+
 (showLogout?'<button class="secondary-btn" data-action="logout">Log out</button>':'')+
 (showBack?'<button class="auth-switch" data-action="show-public">‹ Back to Josh Evans Soccer School</button>':''))}
function renderAuth(){
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
  '<p class="auth-sub">'+(mode==='signup'?'For coaches, parents and management at Josh Evans Soccer School.':'Welcome back to the Josh Evans Hub.')+'</p>'+
  typePicker+
  '<label class="auth-field">Email<input id="auth-email" type="email" autocomplete="email" value="'+esc(state.authEmail||'')+'"></label>'+
  '<label class="auth-field">Password<input id="auth-password" type="password" autocomplete="'+(mode==='signup'?'new-password':'current-password')+'"></label>'+
  err+
  '<button class="primary-btn" data-action="auth-submit" '+(state.authBusy?'disabled':'')+'>'+(state.authBusy?'Please wait…':(mode==='signup'?'Create account':'Sign in'))+'</button>'+
  '<button class="auth-switch" data-action="auth-switch">'+(mode==='signup'?'Already have an account? Sign in':'New here? Create an account')+'</button>'+
  typeNote+
  '<button class="auth-switch" data-action="show-public">‹ Back to Josh Evans Soccer School</button>'
 );
 var first=document.getElementById(state.authEmail?'auth-password':'auth-email');if(first)first.focus()
}
function authSubmit(){
 var emailEl=document.getElementById('auth-email'),pwEl=document.getElementById('auth-password');
 var email=(emailEl&&emailEl.value||'').trim(),password=pwEl&&pwEl.value||'';
 state.authEmail=email;
 if(!email||!password){state.authError='Enter your email and password.';renderAuth();return}
 if(!supabaseClient){state.authError='Sign-in is not configured.';renderAuth();return}
 state.authBusy=true;state.authError='';renderAuth();
 var mode=state.authScreen==='signup'?'signup':'login';
 var op=mode==='signup'?supabaseClient.auth.signUp({email:email,password:password,options:{data:{account_type:state.authAccountType==='parent'?'parent':'staff'}}}):supabaseClient.auth.signInWithPassword({email:email,password:password});
 op.then(function(res){
  state.authBusy=false;
  if(res.error){state.authError=res.error.message||'Something went wrong. Please try again.';renderAuth();return}
  var session=res.data&&res.data.session;
  if(session){onSignedIn(session);return}
  if(mode==='signup'){renderAuthMessage('Check your email','We’ve sent a confirmation link to '+email+'. Follow it, then come back here and sign in.',false,true);return}
  state.authError='Could not sign you in. Please try again.';renderAuth();
 }).catch(function(){state.authBusy=false;state.authError='Something went wrong. Please try again.';renderAuth()});
}
function onSignedIn(session){
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
function init(){
 if(DEMO){demoData();render();return}
 if(!supabaseClient){renderAuthMessage('Sign-in is not configured','Add supabaseUrl and supabasePublishableKey to config.js.',false);return}
 renderAuthMessage('Loading','One moment…',false);
 supabaseClient.auth.getSession().then(function(res){
  var session=res.data&&res.data.session;
  if(session)onSignedIn(session);else loadPublicHome()
 });
 supabaseClient.auth.onAuthStateChange(function(event){
  if(event==='SIGNED_OUT'){state.me=null;state.role='coach';state.screen='home';state.authScreen='login';state.authEmail='';state.authError='';state.authAccountType='staff';loadPublicHome()}
 });
}
document.addEventListener('click',function(e){var nav=e.target.closest('[data-nav]');if(nav){if(document.getElementById('app').classList.contains('auth-mode'))return;navigateTo(nav.dataset.nav);return}var ss=e.target.closest('[data-session]');if(ss&&!ss.dataset.action){pushNavState();renderSession(ss.dataset.session,ss.dataset.date);syncBackButton();return}var a=e.target.closest('[data-action]');if(!a)return;var act=a.dataset.action;if(act==='app-back'){goBack();return}if(act==='venue-detail'){pushNavState();state.selectedVenue=a.dataset.venue;renderVenueDetail(a.dataset.venue);syncBackButton();return}if(act==='unlock')unlock(document.getElementById('pw').value);if(act==='schedule-view'){state.scheduleView=a.dataset.view;state.expandedDay=null;reRenderSchedule()}if(act==='week-shift'){state.scheduleWeekOffset=Math.max(0,Math.min(3,state.scheduleWeekOffset+(+a.dataset.dir||0)));state.expandedDay=null;reRenderSchedule()}if(act==='toggle-day'){state.expandedDay=state.expandedDay===a.dataset.date?null:a.dataset.date;reRenderSchedule()}if(act==='select-date'){state.calendarSelected=parseDate(a.dataset.date);reRenderSchedule()}if(act==='month-shift'){var c=state.calendarCursor||new Date();state.calendarCursor=new Date(c.getFullYear(),c.getMonth()+(+a.dataset.dir||0),1,12);reRenderSchedule()}if(act==='calendar-options')openCalendarOptions(a.dataset.scope,a.dataset.date);if(act==='calendar-session'){var o=occurrenceByIdDate(a.dataset.session,a.dataset.date);if(o)makeCalendarFile([o],o.session.name)}if(act==='calendar-download'){var opts=sheetContent._calendarOptions||[],o=opts[+a.dataset.option];if(o){makeCalendarFile(o.list,o.file);closeSheet()}}if(act==='support-detail')openSupportDetail(a.dataset.support);if(act==='profile'){openProfileSheet();return}if(act==='coming-soon'){toast('Coming soon');return}if(act==='close-sheet')closeSheet();if(act==='theme')toast('Theme is pulled from the Themes sheet');if(act==='auth-submit'){authSubmit();return}if(act==='auth-switch'){state.authScreen=state.authScreen==='signup'?'login':'signup';state.authError='';renderAuth();return}if(act==='auth-account-type'){state.authAccountType=a.dataset.type==='parent'?'parent':'staff';renderAuth();return}if(act==='show-signin'){state.authScreen='login';state.authError='';renderAuth();return}if(act==='show-signup'){state.authScreen='signup';state.authError='';renderAuth();return}if(act==='show-public'){if(state.publicPages&&state.publicPages.length)renderPublicHome();else loadPublicHome();return}if(act==='public-detail'){renderPublicDetail(a.dataset.page);return}if(act==='register-interest-submit'){submitRegisterInterest(a.dataset.page);return}if(act==='logout'){if(DEMO||!supabaseClient){location.reload();return}supabaseClient.auth.signOut();return}});
document.addEventListener('input',function(e){if(e.target&&e.target.id==='venue-search'){state.venueQuery=e.target.value;renderVenues();var i=document.getElementById('venue-search');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length)}}});
document.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target&&(e.target.id==='auth-email'||e.target.id==='auth-password')){e.preventDefault();authSubmit()}});
init();
})();
