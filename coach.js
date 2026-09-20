import { CFG, DAY_ORDER, accessToken, changesWarningBanner, esc, hubName, icons, iso, mondayOf, money, nameKey, parseDate, playerSessionsUrl, reRenderMyPlayers, root, setNav, sheet, sheetContent, state, toast, withAccessToken } from './core.js';

export function mine(){return state.sessions.filter(function(s){return !state.me||s.coaches.some(function(c){return nameKey(c)===nameKey(state.me.name)})})}

export function dayIndex(day){return DAY_ORDER.indexOf(day)}

export function sessionsForDisplay(){return mine().slice().sort(function(a,b){var d=dayIndex(a.day)-dayIndex(b.day);if(d)return d;return timeStartMinutes(a.time)-timeStartMinutes(b.time)})}

export function todayName(d){d=d||new Date();return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()]}

export function venueKey(v){return nameKey(v)}
/**
 * V1 source is Financials `participants`, keyed by session_id - read
 * through a safe, field-limited backend route (hub-content's
 * session-participants) that strips every other financial column
 * (revenue/cost/profit) before it ever reaches a coach's browser; see
 * core.js's load(), which populates state.participantCounts from it.
 * Deliberately NOT a Sessions/Google Sheets column - that would be a
 * second, manually-maintained number that could drift from Financials.
 * The intended long-term source is an Active Player Session Links
 * count; every display below reads this one helper rather than the
 * state map directly, so swapping the source later means changing what
 * feeds this function, not the Home/Schedule/Session Detail rendering.
 * Read-only throughout - nothing in the Coach Hub ever writes to it. 0
 * and blank both mean "don't show a count", not "show 0".
 */
export function participantCount(s){var n=parseInt(s&&state.participantCounts&&state.participantCounts[s.id],10);return isFinite(n)&&n>0?n:null}
export function participantCountText(s){var n=participantCount(s);return n==null?'':n+' player'+(n===1?'':'s')}

export function themeForAt(s,d){var w=state.themes[iso(mondayOf(d))]||{};return w[nameKey(s.category)]||''}

export function themeFor(s){return themeForAt(s,new Date())}

export function sessionRow(s,accent){return '<button class="session-row" data-session="'+esc(s.id)+'"><span class="session-accent '+(accent||'')+'"></span><span><span class="session-time">'+esc(s.time)+'</span><span class="session-title">'+esc(s.name)+'</span><span class="session-sub">'+esc(s.venue)+'</span></span><span class="chev">›</span></button>'}

export function parseClockPart(raw, fallbackMeridiem){
 var t=String(raw||'').trim().toLowerCase().replace(/\./g,'');
 var m=t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/); if(!m)return null;
 var h=+m[1],min=+(m[2]||0),mer=m[3]||fallbackMeridiem||'';
 if(mer==='pm'&&h<12)h+=12; if(mer==='am'&&h===12)h=0;
 return {minutes:h*60+min,mer:mer};
}

export function timeRange(time){
 var parts=String(time||'').replace(/[–—]/g,'-').split('-');
 var endRaw=(parts[1]||'').trim(), startRaw=(parts[0]||'').trim();
 var endMer=((endRaw.toLowerCase().match(/(am|pm)/)||[])[1])||'';
 var st=parseClockPart(startRaw,endMer), en=parseClockPart(endRaw,st&&st.mer); if(!st)return {start:9999,end:9999};
 if(!en)en={minutes:st.minutes+60};
 if(en.minutes<=st.minutes && !/(am|pm)/i.test(startRaw) && endMer==='pm' && st.minutes<720) st.minutes+=720;
 return {start:st.minutes,end:en.minutes};
}

export function timeStartMinutes(t){return timeRange(t).start}

export function dateAtMinutes(d,mins){var x=new Date(d);x.setHours(Math.floor(mins/60),mins%60,0,0);return x}

export function formatMinutes12(mins){if(!isFinite(mins)||mins>=9999)return '—';var h=Math.floor(mins/60)%24,m=mins%60,mer=h>=12?'PM':'AM',h12=h%12||12;return h12+':'+pad2(m)+' '+mer}

export function formatTimeRange(t){var r=timeRange(t);if(r.start>=9999)return String(t||'—');return formatMinutes12(r.start)+' → '+formatMinutes12(r.end)}

export function sameDay(a,b){return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}

export function weekIsoFor(d){return iso(mondayOf(d))}

export function calendarAllows(d){var c=state.calendar[weekIsoFor(d)];return !c||c.running!==false}

export function schoolTermRows(s){var k=nameKey(s.termKey||s.client||s.venue||'');return (state.terms||[]).filter(function(r){return nameKey(r.school)===k})}

export function termAllows(s,d){var rows=schoolTermRows(s);if(!rows.length)return true;var md=mondayOf(d);return rows.some(function(r){var a=parseDate(r.starts),b=parseDate(r.ends);return (!a||md>=mondayOf(a))&&(!b||md<=mondayOf(b))})}

export function changesForDate(d){var wk=weekIsoFor(d);return (state.changes||[]).filter(function(r){var x=parseDate(r.week_commencing||r.date);return x&&iso(mondayOf(x))===wk})}

export function changeHits(ch,s){if(ch.session_id)return String(ch.session_id).trim()===s.id;if(ch.venue)return venueKey(ch.venue)===venueKey(s.venue);if(ch.client)return nameKey(ch.client)===nameKey(s.client||'');if(ch.coach_out)return s.coaches.some(function(c){return nameKey(c)===nameKey(ch.coach_out)});return false}

export function assignmentStatus(s,d,coach){var hits=changesForDate(d).filter(function(ch){return changeHits(ch,s)}),cancel=false,coveredOut=false,coveredIn=false;hits.forEach(function(ch){var typ=nameKey(ch.type);if(typ==='cancelled'||typ==='canceled')cancel=true;if(typ==='cover'){if(nameKey(ch.coach_out)===nameKey(coach))coveredOut=true;if(nameKey(ch.coach_in)===nameKey(coach))coveredIn=true}});return {cancelled:cancel,coveredOut:coveredOut,coveredIn:coveredIn}}

export function sessionRunsForCoach(s,d){if(!calendarAllows(d)||!termAllows(s,d))return false;var st=assignmentStatus(s,d,state.me?state.me.name:'');var base=s.coaches.some(function(c){return state.me&&nameKey(c)===nameKey(state.me.name)});return !st.cancelled&&((base&&!st.coveredOut)||st.coveredIn)}

export function occurrenceFor(s,d){var r=timeRange(s.time);return {session:s,date:new Date(d),start:dateAtMinutes(d,r.start),end:dateAtMinutes(d,r.end)}}

export function todaysOccurrences(now){now=now||new Date();return state.sessions.filter(function(s){return s.day===todayName(now)&&sessionRunsForCoach(s,now)}).map(function(s){return occurrenceFor(s,now)}).sort(function(a,b){return a.start-b.start})}

export function nextOccurrence(now){now=now||new Date();for(var add=0;add<35;add++){var d=new Date(now);d.setHours(12,0,0,0);d.setDate(d.getDate()+add);var list=state.sessions.filter(function(s){return s.day===todayName(d)&&sessionRunsForCoach(s,d)}).map(function(s){return occurrenceFor(s,d)}).filter(function(o){return add>0||o.end>now}).sort(function(a,b){return a.start-b.start});if(list.length)return list[0]}return null}

export function countdownText(o,now){if(!o)return '';now=now||new Date();if(now>=o.start&&now<o.end)return 'In progress';var ms=o.start-now;if(ms<=0)return 'Starting now';var mins=Math.ceil(ms/60000),days=Math.floor(mins/1440);if(days>0)return 'In '+days+'d '+Math.floor((mins%1440)/60)+'h';var h=Math.floor(mins/60),m=mins%60;return 'In '+(h?h+'h ':'')+m+'m'}

export function greeting(){var h=new Date().getHours();return h<12?'Good morning':h<18?'Good afternoon':'Good evening'}

export function renderHome(){
 var now=new Date(),n=nextOccurrence(now),today=todaysOccurrences(now),ns=n&&n.session;
 root.innerHTML='<div class="coach-home">'+
 changesWarningBanner()+
 (n?'<section class="next-home-card" data-session="'+esc(ns.id)+'" data-date="'+iso(n.date)+'"><div class="next-home-head"><span>NEXT SESSION</span><span class="next-arrow">›</span></div><div class="next-home-body"><h1>'+esc(ns.name)+'</h1><div class="home-meta"><span>'+icons.clock+'</span><b>'+esc(ns.time)+'</b></div><div class="home-meta"><span>'+icons.pin+'</span><span>'+esc(ns.venue)+'</span></div>'+(participantCount(ns)!=null?'<div class="home-meta"><span>'+icons.users+'</span><span>'+esc(participantCountText(ns))+'</span></div>':'')+'<span class="countdown-pill" id="next-countdown" data-start="'+n.start.toISOString()+'" data-end="'+n.end.toISOString()+'">'+esc(countdownText(n,now))+'</span></div></section>':'<section class="next-home-card empty"><div class="next-home-head"><span>NEXT SESSION</span></div><div class="next-home-body"><h1>No upcoming sessions</h1></div></section>')+
 '<section class="today-home"><div class="home-section-title"><h2>TODAY’S SESSIONS</h2><button data-nav="schedule">View all</button></div><div class="today-home-list">'+(today.length?today.map(function(o,i){var s=o.session,pc=participantCountText(s);return '<button class="today-home-row" data-session="'+esc(s.id)+'" data-date="'+iso(o.date)+'"><span class="today-line"></span><span class="today-time">'+esc(s.time.split(/\s*[-–—]\s*/)[0])+'</span><span class="today-copy"><b>'+esc(s.name)+'</b><small>'+esc(s.venue)+(pc?' · '+esc(pc):'')+'</small></span><span class="chev">›</span></button>'}).join(''):'<div class="today-empty">No sessions today.</div>')+'</div></section>'+
 '<section class="home-shortcuts"><button data-nav="schedule"><span>▣</span><b>My Schedule</b></button><button data-nav="resources"><span>▤</span><b>Resources</b></button><button data-nav="venues"><span>⌖</span><b>Venues</b></button><button data-nav="support"><span>▧</span><b>Coach Support</b></button></section>'+
 '</div>';
 startCountdownTicker();
}

export let countdownTimer=null;

export function startCountdownTicker(){if(countdownTimer)clearInterval(countdownTimer);function tick(){var el=document.getElementById('next-countdown');if(!el)return;var o={start:new Date(el.dataset.start),end:new Date(el.dataset.end)};el.textContent=countdownText(o,new Date())}tick();countdownTimer=setInterval(tick,30000)}

export function pad2(n){return String(n).padStart(2,'0')}

export function formatDateLong(d){return d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}

export function formatDateShort(d){return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}

export function addDays(d,n){var x=new Date(d);x.setHours(12,0,0,0);x.setDate(x.getDate()+n);return x}

export function allowedScheduleStart(){return mondayOf(new Date())}

export function allowedScheduleEnd(){return addDays(allowedScheduleStart(),27)}

export function inScheduleWindow(d){var x=new Date(d);x.setHours(12,0,0,0);return x>=allowedScheduleStart()&&x<=allowedScheduleEnd()}

export function academicYearStart(){var n=new Date(),y=n.getMonth()>=8?n.getFullYear():n.getFullYear()-1;return new Date(y,8,1,12)}

export function academicYearEnd(){var s=academicYearStart();return new Date(s.getFullYear()+1,7,31,12)}

export function inCalendarYear(d){var x=new Date(d);x.setHours(12,0,0,0);return x>=academicYearStart()&&x<=academicYearEnd()}

export function coachAssignment(s,d){if(!calendarAllows(d)||!termAllows(s,d))return null;var coach=state.me?state.me.name:'',hits=changesForDate(d).filter(function(ch){return changeHits(ch,s)}),base=s.coaches.some(function(c){return nameKey(c)===nameKey(coach)}),cancel=false,out=false,coverIn=false;hits.forEach(function(ch){var typ=nameKey(ch.type);if(typ==='cancelled'||typ==='canceled')cancel=true;if(typ==='cover'){if(nameKey(ch.coach_out)===nameKey(coach))out=true;if(nameKey(ch.coach_in)===nameKey(coach))coverIn=true}});if(out&&!coverIn)return null;if(cancel&&base)return 'cancelled';if(coverIn)return 'cover';if(base)return 'normal';return null}

export function extraOccurrences(d){var coach=state.me?state.me.name:'';return changesForDate(d).filter(function(ch){if(nameKey(ch.type)!=='extra')return false;if(ch.day&&nameKey(ch.day)!==nameKey(todayName(d)))return false;return nameKey(ch.coach_in||ch.coach||'')===nameKey(coach)}).map(function(ch,i){var s={id:'extra-'+weekIsoFor(d)+'-'+i,name:ch.session_name||'Extra session',programme:'Extra',category:ch.category||'Extra',ageGroup:ch.age_group||'',day:ch.day||todayName(d),time:ch.time||'',venue:ch.venue||ch.client||'Venue TBC',address:'',coaches:[coach],client:ch.client||'',hours:'',note:ch.note||''};state.virtualSessions[s.id]=s;var o=occurrenceFor(s,d);o.status='extra';return o})}

export function scheduleOccurrencesForDate(d){var list=state.sessions.filter(function(s){return s.day===todayName(d)}).map(function(s){var status=coachAssignment(s,d);if(!status)return null;var o=occurrenceFor(s,d);o.status=status;return o}).filter(Boolean);return list.concat(extraOccurrences(d)).sort(function(a,b){return a.start-b.start})}

export function statusLabel(st){return st==='cancelled'?'Cancelled':st==='cover'?'Cover':st==='extra'?'Extra':''}

export function statusClass(st){return st==='cancelled'?'is-cancelled':st==='cover'?'is-cover':st==='extra'?'is-extra':'is-normal'}

export function statusHeading(st){return st==='extra'?'EXTRA SESSION':st==='cover'?'COVER SESSION':st==='cancelled'?'CANCELLED':''}

export function themeForScheduleOccurrence(o){var s=o.session,theme=themeForAt(s,o.date);if(theme||o.status!=='extra')return theme;var match=state.sessions.find(function(base){return nameKey(base.name)===nameKey(s.name)})||state.sessions.find(function(base){return s.venue&&venueKey(base.venue)===venueKey(s.venue)&&base.day===s.day});return match?themeForAt(match,o.date):''}

export function scheduleCard(o,compact){var s=o.session,theme=themeForScheduleOccurrence(o),label=statusLabel(o.status),heading=statusHeading(o.status),pc=participantCountText(s);return '<button class="schedule-session '+statusClass(o.status)+(compact?' compact':'')+'" data-session="'+esc(s.id)+'" data-date="'+iso(o.date)+'"><span class="schedule-accent"></span><span class="schedule-time"><b>'+esc(formatTimeRange(s.time))+'</b></span><span class="schedule-copy">'+(heading?'<span class="schedule-status-heading">'+esc(heading)+'</span>':'')+'<b>'+esc(s.name)+'</b><small>'+esc(s.venue)+(pc?' · '+esc(pc):'')+'</small>'+(compact?'':'<span class="schedule-tags">'+(s.ageGroup?'<i>'+esc(s.ageGroup)+'</i>':'')+(s.category?'<i>'+esc(s.category)+'</i>':'')+(label?'<i class="status-chip">'+esc(label)+'</i>':'')+'</span>')+(theme?'<span class="theme-chip"><strong>Theme:</strong> '+esc(theme)+'</span>':'')+'</span><span class="chev">›</span></button>'}

export function scheduleTabs(){return '<div class="schedule-tabs"><button data-action="schedule-view" data-view="today" class="'+(state.scheduleView==='today'?'is-active':'')+'">Today</button><button data-action="schedule-view" data-view="week" class="'+(state.scheduleView==='week'?'is-active':'')+'">This Week</button><button data-action="schedule-view" data-view="calendar" class="'+(state.scheduleView==='calendar'?'is-active':'')+'">Calendar</button></div>'}

export function renderTodaySchedule(){var d=new Date(),list=scheduleOccurrencesForDate(d);return '<section class="schedule-panel"><div class="schedule-date-heading"><h2>'+esc(formatDateLong(d))+'</h2><span>'+list.length+' session'+(list.length===1?'':'s')+'</span></div><div class="schedule-list">'+(list.length?list.map(function(o){return scheduleCard(o,false)}).join(''):'<div class="schedule-empty">No sessions today.</div>')+'</div></section><button class="calendar-action" data-action="calendar-options" data-scope="day" data-date="'+iso(d)+'">▣ Add to Calendar <span>⌄</span></button>'}

export function workingDaysForWeek(weekStart){var out=[];for(var i=0;i<7;i++){var d=addDays(weekStart,i),list=scheduleOccurrencesForDate(d);if(list.length)out.push({date:d,list:list})}return out}
/**
 * A quick "did anything change from the base rota this week" read, before
 * anyone has to open each day to find out. Counts cancelled/cover/extra
 * occurrences across the week's sessions (normal ones aren't a change).
 * Kept as one small status line, not a big warning block - most weeks
 * have nothing to report and that should read as reassuring, not alarming.
 */

export function weekChangesSummary(days){
 var counts={cancelled:0,cover:0,extra:0};
 days.forEach(function(g){g.list.forEach(function(o){if(counts[o.status]!=null)counts[o.status]++})});
 var total=counts.cancelled+counts.cover+counts.extra;
 if(!total)return '<div class="week-changes is-clear"><span class="week-changes-head">✓ No changes this week</span></div>';
 var parts=[];
 if(counts.cancelled)parts.push(counts.cancelled+' cancelled session'+(counts.cancelled===1?'':'s'));
 if(counts.cover)parts.push(counts.cover+' cover session'+(counts.cover===1?'':'s'));
 if(counts.extra)parts.push(counts.extra+' extra session'+(counts.extra===1?'':'s'));
 if(total===1)return '<div class="week-changes is-alert"><span class="week-changes-head">⚠ '+esc(parts[0])+' this week</span></div>';
 return '<div class="week-changes is-alert"><span class="week-changes-head">⚠ '+total+' changes this week</span>'+parts.map(function(p){return '<span class="week-changes-line">'+esc(p)+'</span>'}).join('')+'</div>';
}

export function renderWeekSchedule(){var start=addDays(allowedScheduleStart(),state.scheduleWeekOffset*7),end=addDays(start,6),days=workingDaysForWeek(start),today=new Date(),isCurrent=state.scheduleWeekOffset===0;return weekChangesSummary(days)+'<section class="week-nav"><button data-action="week-shift" data-dir="-1" '+(state.scheduleWeekOffset===0?'disabled':'')+'>‹</button><b>'+esc(formatDateShort(start))+' – '+esc(formatDateShort(end))+'</b><button data-action="week-shift" data-dir="1" '+(state.scheduleWeekOffset===3?'disabled':'')+'>›</button></section><section class="week-stack">'+(days.length?days.map(function(g){var key=iso(g.date),open=(isCurrent&&sameDay(g.date,today))||state.expandedDay===key;return '<article class="week-day '+(open?'is-open':'')+'"><button class="week-day-head" data-action="toggle-day" data-date="'+key+'"><span><b>'+esc(formatDateLong(g.date))+'</b><small>'+g.list.length+' session'+(g.list.length===1?'':'s')+'</small></span><span>'+(open?'⌃':'⌄')+'</span></button>'+(open?'<div class="week-day-list">'+g.list.map(function(o){return scheduleCard(o,true)}).join('')+'</div>':'')+'</article>'}).join(''):'<div class="schedule-empty">No sessions this week.</div>')+'</section><button class="calendar-action" data-action="calendar-options" data-scope="week" data-date="'+iso(start)+'">▣ Add this week to Calendar <span>⌄</span></button>'}

export function monthName(d){return d.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}

export function monthGrid(cursor,selected){var y=cursor.getFullYear(),m=cursor.getMonth(),first=new Date(y,m,1,12),startOffset=(first.getDay()+6)%7,days=new Date(y,m+1,0).getDate(),cells='';for(var i=0;i<startOffset;i++)cells+='<span class="cal-cell is-blank"></span>';for(var day=1;day<=days;day++){var d=new Date(y,m,day,12),allowed=inCalendarYear(d),list=allowed?scheduleOccurrencesForDate(d):[],sel=selected&&sameDay(d,selected);cells+='<button class="cal-cell '+(allowed?'':'is-disabled')+(sel?' is-selected':'')+'" '+(allowed?'data-action="select-date" data-date="'+iso(d)+'"':'disabled')+'><b>'+day+'</b>'+(list.length?'<i></i>':'')+'</button>'}return cells}

export function renderCalendarSchedule(){var today=new Date(),ayStart=academicYearStart(),ayEnd=academicYearEnd();if(!state.calendarCursor)state.calendarCursor=new Date(today.getFullYear(),today.getMonth(),1,12);if(!state.calendarSelected||!inCalendarYear(state.calendarSelected))state.calendarSelected=new Date(today.getFullYear(),today.getMonth(),today.getDate(),12);var cursor=state.calendarCursor,sel=state.calendarSelected,list=scheduleOccurrencesForDate(sel),prev=new Date(cursor.getFullYear(),cursor.getMonth()-1,1,12),next=new Date(cursor.getFullYear(),cursor.getMonth()+1,1,12),canPrev=new Date(prev.getFullYear(),prev.getMonth()+1,0,12)>=ayStart,canNext=next<=ayEnd;return '<section class="calendar-card"><div class="calendar-head"><button data-action="month-shift" data-dir="-1" '+(canPrev?'':'disabled')+'>‹</button><b>'+esc(monthName(cursor))+'</b><button data-action="month-shift" data-dir="1" '+(canNext?'':'disabled')+'>›</button></div><div class="calendar-year-note">Academic year · September '+ayStart.getFullYear()+' – August '+ayEnd.getFullYear()+'</div><div class="calendar-weekdays"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="calendar-grid">'+monthGrid(cursor,sel)+'</div></section><section class="schedule-panel calendar-results"><div class="schedule-date-heading"><h2>'+esc(formatDateLong(sel))+'</h2><span>'+list.length+' session'+(list.length===1?'':'s')+'</span></div><div class="schedule-list">'+(list.length?list.map(function(o){return scheduleCard(o,true)}).join(''):'<div class="schedule-empty">No sessions on this date.</div>')+'</div></section><button class="calendar-action" data-action="calendar-options" data-scope="day" data-date="'+iso(sel)+'">▣ Add selected date to Calendar <span>⌄</span></button>'}

export function renderSchedule(){state.virtualSessions={};var body=state.scheduleView==='week'?renderWeekSchedule():state.scheduleView==='calendar'?renderCalendarSchedule():renderTodaySchedule();root.innerHTML='<div class="coach-schedule">'+changesWarningBanner()+'<div class="page-title schedule-title"><h1>Schedule</h1><p>Today and This Week show the current week plus the next 3 weeks. Calendar covers the full academic year.</p></div>'+scheduleTabs()+body+'</div>'}

export function findSession(id){return state.sessions.find(function(s){return s.id===id})||state.virtualSessions[id]}

export function venueDetailsFor(s){var direct=state.venueInfo[venueKey(s.venue)]||null;if(direct)return direct;var alias=(CFG.venueAliases||{})[s.venue];if(alias&&state.venueInfo[venueKey(alias)])return state.venueInfo[venueKey(alias)];return {venue:s.venue,address:s.address||'',postcode:'',parking:'',meetingPoint:'',access:'',notes:''}}

export function sessionNoteFor(s,d){if(s.note)return s.note;var notes=changesForDate(d).filter(function(ch){return changeHits(ch,s)&&ch.note}).map(function(ch){return ch.note.trim()}).filter(Boolean);return notes[0]||''}

export function renderSession(id,dateIso){var s=findSession(id);if(!s)return;var d=dateIso?parseDate(dateIso):(state.sessionDate?parseDate(state.sessionDate):new Date());state.sessionDate=iso(d);state.screen='session';setNav('schedule');var fin=state.unlocked&&state.financials&&state.financials[s.id],theme=themeForAt(s,d),status=s.id.indexOf('extra-')===0?'extra':(coachAssignment(s,d)||'normal'),vd=venueDetailsFor(s),note=sessionNoteFor(s,d),others=s.coaches.filter(function(c){return !state.me||nameKey(c)!==nameKey(state.me.name)}),address=[vd.address||s.address||'',vd.postcode||''].filter(Boolean).join(', '),statusHead=statusHeading(status);
 var pc=participantCountText(s);
 root.innerHTML='<section class="detail-hero session-detail-hero"><button class="back-btn" data-action="app-back">‹ Back</button>'+(statusHead?'<span class="detail-status '+statusClass(status)+'">'+esc(statusHead)+'</span>':'')+'<h1>'+esc(s.name)+'</h1><p>'+esc(s.category||s.programme||'Session')+'</p></section>'+
 '<div class="session-detail-wrap"><section class="card detail-card session-info-card"><div class="detail-row"><span class="detail-icon">▣</span><span><b>Date</b><small>'+esc(formatDateLong(d))+'</small></span></div><div class="detail-row"><span class="detail-icon">◷</span><span><b>Start → Finish</b><small>'+esc(formatTimeRange(s.time))+'</small></span></div><div class="detail-row"><span class="detail-icon">⌖</span><span><b>Venue</b><small>'+esc(s.venue)+(address?'<br>'+esc(address):'')+'</small></span></div><div class="detail-row"><span class="detail-icon">●</span><span><b>Coaching with</b><small>'+esc(others.length?others.join(' & '):'You are the only coach listed')+'</small></span></div>'+(theme?'<div class="detail-row theme-row"><span class="detail-icon">◎</span><span><b>Theme</b><small>'+esc(theme)+'</small></span></div>':'')+(pc?'<div class="detail-row"><span class="detail-icon">'+icons.users+'</span><span><b>Players</b><small>'+esc(pc)+'</small></span></div>':'')+'</section>'+
 '<section class="card detail-notes"><div class="detail-section-head"><span class="detail-icon">✎</span><b>Notes</b></div><p>'+esc(note||'No additional notes for this session.')+'</p></section>'+
 '<section class="detail-actions"><button class="primary-btn" data-action="calendar-session" data-session="'+esc(s.id)+'" data-date="'+iso(d)+'">▣ Add to Calendar</button><button class="secondary-btn" data-action="venue-detail" data-venue="'+esc(s.venue)+'">⌖ Venue Details</button></section></div>'+
 (fin?'<div class="financial-mini"><b>Session Financials <small>(Management only)</small></b><div class="fm-row"><span>Participants</span><span>'+esc(fin.participants||'—')+'</span></div><div class="fm-row"><span>Revenue</span><span>'+money(fin.revenue_net||fin.revenue_gross)+'</span></div><div class="fm-row"><span>Coach cost</span><span>'+money(fin.coach_cost)+'</span></div><div class="fm-row"><span>Venue cost</span><span>'+money(fin.venue_cost)+'</span></div><div class="fm-row profit"><span>Profit</span><span>'+money(fin.profit)+'</span></div></div>':'')}

export function canonicalVenueName(name){var alias=(CFG.venueAliases||{})[name];return alias||name}

export function venueInfoForName(name){var direct=state.venueInfo[venueKey(name)];if(direct)return direct;var canon=canonicalVenueName(name),via=state.venueInfo[venueKey(canon)];if(via)return via;return {venue:canon||name,address:'',postcode:'',parking:'',meetingPoint:'',access:'',notes:''}}

export function sameVenueName(a,b){return venueKey(canonicalVenueName(a))===venueKey(canonicalVenueName(b))}

export function venueListData(){var map={};state.sessions.forEach(function(s){if(!s.venue)return;var name=canonicalVenueName(s.venue),k=venueKey(name),info=venueInfoForName(s.venue);if(!map[k])map[k]={name:name,address:info.address||s.address||'',postcode:info.postcode||'',sourceNames:[]};if(map[k].sourceNames.indexOf(s.venue)<0)map[k].sourceNames.push(s.venue)});Object.keys(state.venueInfo).forEach(function(k){var info=state.venueInfo[k];if(!info||!info.venue)return;var name=canonicalVenueName(info.venue),kk=venueKey(name);if(!map[kk])map[kk]={name:name,address:info.address||'',postcode:info.postcode||'',sourceNames:[info.venue]}});return Object.values(map).sort(function(a,b){return a.name.localeCompare(b.name)})}

export function coachSessionsAtVenueThisWeek(name){var start=mondayOf(new Date()),list=[];for(var i=0;i<7;i++){var d=addDays(start,i);scheduleOccurrencesForDate(d).forEach(function(o){if(sameVenueName(o.session.venue,name))list.push(o)})}return list.sort(function(a,b){return a.start-b.start})}

export function renderVenues(){var q=nameKey(state.venueQuery||''),vs=venueListData().filter(function(v){return !q||nameKey(v.name+' '+v.address+' '+v.postcode).indexOf(q)>=0});root.innerHTML='<div class="venues-page"><div class="page-title"><h1>Venues</h1><p>Arrival information, access details and your sessions at each venue.</p></div><div class="search"><input id="venue-search" value="'+esc(state.venueQuery||'')+'" placeholder="Search venues…" autocomplete="off"></div><div class="venue-list">'+(vs.length?vs.map(function(v){var count=coachSessionsAtVenueThisWeek(v.name).length,address=[v.address,v.postcode].filter(Boolean).join(', ');return '<button class="card venue-card venue-card-v1" data-action="venue-detail" data-venue="'+esc(v.name)+'"><span class="venue-pin">⌖</span><span class="venue-card-copy"><h3>'+esc(v.name)+'</h3><p>'+esc(address||'Venue information')+'</p><small>'+count+' of your session'+(count===1?'':'s')+' here this week</small></span><span class="chev">›</span></button>'}).join(''):'<div class="schedule-empty">No venues match your search.</div>')+'</div></div>'}

export function venueInfoRows(info){var rows=[['Parking',info.parking],['Where to meet',info.meetingPoint],['Access',info.access],['Useful notes',info.notes]];return rows.filter(function(r){return r[1]}).map(function(r){return '<div class="venue-info-row"><b>'+esc(r[0])+'</b><span>'+esc(r[1])+'</span></div>'}).join('')}

export function renderVenueDetail(name){if(!name){state.screen='venues';renderVenues();return}state.selectedVenue=name;state.screen='venue-detail';setNav('home');var info=venueInfoForName(name),fallback=state.sessions.find(function(s){return sameVenueName(s.venue,name)}),address=info.address||(fallback&&fallback.address)||'',postcode=info.postcode||'',where=[address,postcode].filter(Boolean).join(', '),week=coachSessionsAtVenueThisWeek(name),query=where||name,rows=venueInfoRows(info);root.innerHTML='<section class="detail-hero venue-detail-hero"><button class="back-btn" data-action="app-back">‹ Back</button><span class="venue-detail-icon">⌖</span><h1>'+esc(canonicalVenueName(name))+'</h1><p>'+esc(where||'Venue information')+'</p></section><div class="venue-detail-wrap"><section class="card venue-overview-card"><div class="venue-address-block"><span class="detail-icon">⌖</span><span><b>Address</b><small>'+esc(where||'Address not yet added')+'</small></span></div>'+(rows||'<div class="venue-info-empty">Parking, meeting point, access and notes can be added on the Venues table in Airtable.</div>')+'</section><a class="primary-btn venue-directions" href="https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(query)+'" target="_blank" rel="noopener">⌖ Get Directions</a><section class="venue-week"><div class="home-section-title"><h2>YOUR SESSIONS HERE THIS WEEK</h2><span>'+week.length+'</span></div><div class="card venue-week-list">'+(week.length?week.map(function(o){var s=o.session,heading=statusHeading(o.status);return '<button class="venue-week-session" data-session="'+esc(s.id)+'" data-date="'+iso(o.date)+'"><span class="venue-week-date"><b>'+esc(o.date.toLocaleDateString('en-GB',{weekday:'short'}))+'</b><small>'+esc(formatDateShort(o.date))+'</small></span><span><i>'+esc(formatTimeRange(s.time))+'</i><b>'+esc(s.name)+'</b>'+(heading?'<small>'+esc(heading)+'</small>':'')+'</span><span class="chev">›</span></button>'}).join(''):'<div class="venue-no-sessions">You have no sessions at this venue this week.</div>')+'</div></section></div>'}

export function renderResources(){
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

export function renderSupport(){
 var list=state.coachSupport||[];
 var org=(window.HubContent&&HubContent.get()&&HubContent.get().organisation)||{};
 var title=(window.HubContent&&HubContent.label('coach_support_title','Coach Support Centre'))||'Coach Support Centre';
 var subtitle=(window.HubContent&&HubContent.label('coach_support_subtitle','Everything you need to be the best version of yourself as a coach.'))||'Everything you need to be the best version of yourself as a coach.';
 root.innerHTML='<div class="page-title"><h1>'+esc(title)+'</h1><p>'+esc(subtitle)+'</p></div><div class="resource-grid">'+
  (list.length?list.map(function(s,i){
   var gradient=['','alt','warm'][i%3];
   return '<button class="card resource-card" data-action="support-detail" data-support="'+esc(s.support_id)+'"><div class="resource-img icon-only '+gradient+'">'+icons.doc+'</div><div class="resource-body">'+(s.section?'<span class="pill blue">'+esc(s.section)+'</span>':'')+'<h3>'+esc(s.title)+'</h3></div></button>';
  }).join(''):'<div class="schedule-empty">Nothing here yet — add an item to the Coach Support table in Airtable.</div>')+
 '</div>'+(org.tagline?'<div class="quote-card card" style="margin-top:14px"><strong>“'+esc(org.tagline)+'”</strong></div>':'');
}

export function openSupportDetail(id){
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

export function playerInitials(name){var parts=String(name||'').trim().split(/\s+/);return (((parts[0]||'')[0]||'')+((parts[1]||'')[0]||'')).toUpperCase()}

export function playerTierBadge(p){
 if(p.tier==='cover')return '<small class="player-tier is-cover">Cover</small>';
 if(p.tier==='former')return '<small class="player-tier is-former">Former coach'+(p.access_until?' · access until '+esc(p.access_until):'')+'</small>';
 return '';
}

export function playerRowHtml(p){
 var avatar=p.photo_url?'<img src="'+esc(p.photo_url)+'" alt="">':'<span>'+esc(playerInitials(p.name))+'</span>';
 var endBtn=(state.role==='management'&&p.link_record_id)?'<button class="secondary-btn end-membership-btn" data-action="end-player-session" data-link-id="'+esc(p.link_record_id)+'">End</button>':'';
 return '<div class="player-row" data-player-row="'+esc(p.link_record_id||'')+'"><span class="player-avatar'+(p.photo_url?' has-photo':'')+'">'+avatar+'</span><span><b>'+esc(p.name)+'</b>'+playerTierBadge(p)+'</span>'+endBtn+'</div>';
}
/**
 * Grouped by session, not one flat list - each row from the players API
 * already carries its session_id/session_name/tier (resolved server-side
 * by the centralised player-access logic: Player Session Links + a
 * session's Permanent Coaches + this week's cover, with the legacy
 * Assigned Coaches link only as a fallback for anything not yet migrated
 * onto the new system). A player linked to two sessions appears once per
 * session, so grouping by session_record_id (falling back to session_name
 * for a legacy/unmigrated row, which has no session id) is exactly right.
 */

export function renderMyPlayers(){
 var rows=state.players||[];
 var groups={},order=[];
 rows.forEach(function(p){
  var key=p.session_record_id||('legacy:'+p.session_name);
  if(!groups[key]){groups[key]={name:p.session_name||'Session',players:[]};order.push(key)}
  groups[key].players.push(p);
 });
 order.sort(function(a,b){return groups[a].name.localeCompare(groups[b].name)});
 root.innerHTML='<div class="page-title"><h1>My Players</h1><p>Players linked to your sessions.</p></div>'+
  (order.length?'<div class="card player-session-list">'+order.map(function(key){
    var g=groups[key],open=state.expandedPlayerSession===key;
    return '<div class="player-session-group">'+
     '<button class="player-session-head" data-action="toggle-player-session" data-key="'+esc(key)+'"><span>'+esc(g.name)+'</span><span class="player-session-count">'+g.players.length+(open?' ▾':' ▸')+'</span></button>'+
     (open?g.players.map(playerRowHtml).join(''):'')+
    '</div>';
   }).join('')+'</div>':'<div class="schedule-empty">No players linked to your sessions yet.</div>');
}

export function reloadPlayers(){
 return accessToken().then(function(token){return HubContent.loadPlayers(token)}).then(function(rows){state.players=rows||[];reRenderMyPlayers()}).catch(function(){});
}
/**
 * Management-only: a player has left this session. Snapshots the
 * session's current Permanent Coaches into the link's "Coaches At End"
 * server-side, which is what former-coach access checks from then on -
 * see handleEndLink in the player-sessions function.
 */

export function endPlayerSession(linkId,btn){
 if(!confirm('End this player’s membership in this session? Their current coach(es) keep 28 days of access after this.'))return;
 btn.disabled=true;btn.textContent='Ending…';
 withAccessToken().then(function(token){
  return fetch(playerSessionsUrl()+'/links/'+encodeURIComponent(linkId)+'/end',{method:'POST',headers:{Authorization:'Bearer '+token}});
 }).then(function(r){
  return r.json().catch(function(){return {}}).then(function(body){if(!r.ok)throw new Error(body&&body.error||'Could not end this membership.');return body});
 }).then(function(){
  toast('Membership ended — former access starts now');
  reloadPlayers();
 }).catch(function(e){
  btn.disabled=false;btn.textContent='End';
  toast(e.message||'Could not end this membership.');
 });
}
/**
 * Preview-first migration for existing players onto the new session
 * system: nothing is linked until Migrate Selected is pressed, and only
 * for the exact rows checked. Matched rows (one exact session-name match)
 * come pre-checked; ambiguous rows (more than one plausible session) need
 * a pick from the dropdown before they'll count; unmatched rows are
 * informational only, nothing to select.
 */

export function icsStamp(d){return d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate())+'T'+pad2(d.getHours())+pad2(d.getMinutes())+'00'}

export function makeCalendarFile(occurrences,label){if(!occurrences.length){toast('No sessions to add');return}var hn=hubName();var lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//'+hn+'//Coach Schedule//EN'];occurrences.forEach(function(o){var s=o.session;lines.push('BEGIN:VEVENT','UID:'+encodeURIComponent(s.id+'-'+iso(o.date))+'@joshevanshub','DTSTART:'+icsStamp(o.start),'DTEND:'+icsStamp(o.end),'SUMMARY:'+String(s.name||'Session').replace(/[,;]/g,' '),'LOCATION:'+String(s.venue||'').replace(/[,;]/g,' '),'DESCRIPTION:'+hn,'END:VEVENT')});lines.push('END:VCALENDAR');var blob=new Blob([lines.join('\r\n')],{type:'text/calendar'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(label||hn+'-schedule').replace(/[^a-z0-9]+/gi,'-')+'.ics';a.click();setTimeout(function(){URL.revokeObjectURL(url)},1000);toast('Calendar file created')}

export function occurrenceByIdDate(id,dateIso){var d=parseDate(dateIso),s=findSession(id);return s&&d?occurrenceFor(s,d):null}

export function openCalendarOptions(scope,dateIso){var d=parseDate(dateIso)||new Date(),opts=[];if(scope==='week'){var list=[];for(var i=0;i<7;i++)list=list.concat(scheduleOccurrencesForDate(addDays(d,i)).filter(function(o){return o.status!=='cancelled'}));opts.push({label:'Add this visible week',count:list.length,list:list,file:'coach-week-'+iso(d)})}else{var day=scheduleOccurrencesForDate(d).filter(function(o){return o.status!=='cancelled'});opts.push({label:'Add selected day',count:day.length,list:day,file:'coach-day-'+iso(d)});var wk=mondayOf(d),week=[];for(var j=0;j<7;j++)week=week.concat(scheduleOccurrencesForDate(addDays(wk,j)).filter(function(o){return o.status!=='cancelled'}));opts.push({label:'Add whole week',count:week.length,list:week,file:'coach-week-'+iso(wk)})}sheet.hidden=false;sheetContent.innerHTML='<div class="calendar-sheet"><h3>Add to Calendar</h3><p>Choose what you want to add.</p>'+opts.map(function(o,i){return '<button data-action="calendar-download" data-option="'+i+'"><span><b>'+esc(o.label)+'</b><small>'+o.count+' session'+(o.count===1?'':'s')+'</small></span><span>›</span></button>'}).join('')+'</div>';sheetContent._calendarOptions=opts}
