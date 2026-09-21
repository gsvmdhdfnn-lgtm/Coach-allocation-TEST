import { closeSheet, esc, hubName, navigateTo, parentHubUrl, pushNavState, root, sheet, sheetContent, state, syncBackButton, toast, withAccessToken } from './core.js';
import { playerInitials } from './coach.js';

/**
 * PARENT / PLAYER HUB - Phase 1 shell.
 *
 * Deliberately separate from the Coach screens rather than a role-branch
 * inside them: a parent is view-only and sees strictly less, so sharing
 * the Coach feedback/player components would mean one missed branch
 * leaking an edit control or another family's child. Everything here
 * reads from parent-hub's own endpoints, which re-derive access from the
 * parent's Verified links server-side on every call - nothing trusts a
 * player id, session id or capability supplied by this client.
 *
 * Structured so the four tabs absorb later phases without new top-level
 * navigation: bookings/payments and account live under More, Session
 * Updates and Resources hang off Sessions, and multiple children swap
 * through activeChild() rather than duplicating screens.
 */

const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The next `count` dates for a weekly session, derived from the schedule's
 * own day-of-week. Returns [] for a session whose sheet row has no day, so
 * the caller omits the section rather than inventing a date.
 */
export function nextOccurrences(dayName, count) {
  var di = DAY_INDEX[String(dayName || '').trim().toLowerCase()];
  if (di === undefined) return [];
  var out = [], d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((di - d.getDay() + 7) % 7));
  for (var i = 0; i < count; i++) { out.push(new Date(d)); d.setDate(d.getDate() + 7); }
  return out;
}

export function formatLongDate(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
export function formatDayDate(d) { return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ' · ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }

/** "2026-09-20" -> "20 September 2026". Returns '' for a blank/unparseable date rather than "Invalid Date". */
export function formatIsoDate(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return formatLongDate(new Date(+m[1], +m[2] - 1, +m[3], 12));
}

function sameText(a, b) { return String(a || '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b || '').trim().toLowerCase().replace(/\s+/g, ' '); }

/**
 * The session/programme name is always the identifier a parent sees.
 * Several real sessions share a venue - the schedule currently has three
 * separate "Daneshill" entries - so the venue can never be the title on
 * its own, and everything that actually tells two of them apart (day,
 * time, age group) has to travel with it.
 */
export function sessionTitle(s) {
  return (s && (s.session_name || s.category || s.programme)) || 'Session';
}

/**
 * Venue, day/time, age group and coach, in that order, as separate
 * lines. A blank field is dropped, and a venue that merely repeats the
 * title is dropped too rather than printed twice.
 */
export function sessionMetaLines(s, opts) {
  if (!s) return [];
  opts = opts || {};
  var title = sessionTitle(s), lines = [];
  if (s.venue && !sameText(s.venue, title)) lines.push(s.venue);
  var when = [opts.noDay ? '' : s.day, s.time].filter(Boolean).join(' · ');
  if (when) lines.push(when);
  if (s.age_group) lines.push(s.age_group);
  if (!opts.noCoach && (s.coaches || []).length) lines.push('Coach: ' + s.coaches.join(', '));
  return lines;
}

/** Single-line form for a <select> option, which can't carry markup. */
export function sessionOptionLabel(s) {
  var bits = sessionMetaLines(s, { noCoach: true });
  return bits.length ? sessionTitle(s) + ' — ' + bits.join(' · ') : sessionTitle(s);
}

export function activeChild() {
  var children = (state.parentHub && state.parentHub.children) || [];
  if (!children.length) return null;
  return children.find(function (c) { return c.player_record_id === state.parentChildId; }) || children[0];
}

/** Never implies a single programme when the child is on several - the strip summarises instead of naming just the first. */
export function childSubtitle(child) {
  var sessions = (child && child.active_sessions) || [];
  if (!sessions.length) return 'No active session yet';
  if (sessions.length > 1) return sessions.length + ' programmes';
  var s = sessions[0];
  return [sessionTitle(s), s.age_group].filter(Boolean).join(' · ');
}

function avatarHtml(child) {
  if (child && child.photo_url) return '<span class="ph-avatar has-photo"><img src="' + esc(child.photo_url) + '" alt=""></span>';
  return '<span class="ph-avatar">' + esc(playerInitials((child && child.name) || '')) + '</span>';
}

function heroHtml(eyebrow, title, blurb, stripTitle, stripSub, child) {
  return '<section class="ph-hero">' +
    '<div class="ph-eyebrow">' + esc(eyebrow) + '</div>' +
    '<h1>' + esc(title) + '</h1>' +
    (blurb ? '<p>' + esc(blurb) + '</p>' : '') +
    (stripTitle ? '<div class="ph-strip">' + avatarHtml(child) + '<div><b>' + esc(stripTitle) + '</b><small>' + esc(stripSub || '') + '</small></div></div>' : '') +
    '</section>';
}

function sectionHead(title, aside) {
  return '<div class="ph-section-head"><h2>' + esc(title) + '</h2>' + (aside ? '<span>' + esc(aside) + '</span>' : '') + '</div>';
}

function emptyCard(title, body) {
  return '<section class="card ph-empty"><b>' + esc(title) + '</b><p>' + esc(body) + '</p></section>';
}

export function renderParentHub() {
  if (!state.parentHubLoaded) { root.innerHTML = '<div class="loading">Loading your hub…</div>'; loadParentHub(); return; }
  renderParentHome();
}

export function loadParentHub() {
  withAccessToken().then(function (token) {
    return fetch(parentHubUrl() + '/me', { headers: { Authorization: 'Bearer ' + token } });
  }).then(function (r) {
    return r.json().catch(function () { return {} }).then(function (body) { if (!r.ok) throw new Error(body && body.error || 'Could not load your hub.'); return body });
  }).then(function (body) {
    state.parentHub = body; state.parentHubLoaded = true;
    if (state.role === 'parent') renderParentScreen();
  }).catch(function (e) {
    root.innerHTML = '<div class="error"><b>Couldn’t load your hub.</b><br>' + esc(e.message || '') + '<br><button class="primary-btn error-retry" data-action="retry-parent-hub">Try again</button></div>';
  });
}

/** Router for every parent screen - core.js render() hands off here so Coach/Management routing stays untouched. */
export function renderParentScreen() {
  if (!state.parentHubLoaded) { renderParentHub(); return; }
  var s = state.screen;
  if (s === 'parent-sessions') return renderParentSessions();
  if (s === 'parent-session-detail') return renderParentSessionDetail(state.parentSessionId);
  if (s === 'parent-development') return renderParentDevelopment();
  if (s === 'parent-feedback-detail') return renderParentFeedbackDetail(state.parentFeedbackId);
  if (s === 'parent-more') return renderParentMore();
  if (s === 'parent-children') return renderParentChildren();
  if (s === 'parent-policy') return renderParentPolicy(state.parentPolicy);
  return renderParentHome();
}

/** Shown on every tab until a claim is approved - a parent with no Verified child has nothing to show, and must not be left on a blank screen. */
function noChildHtml() {
  var pending = (state.parentHub && state.parentHub.pending_claims) || [];
  return heroHtml('Parent & Player Hub', 'Welcome', 'Link your child to see their sessions and development.', '', '', null) +
    (pending.length
      ? sectionHead('Your claims') + '<section class="card parent-pending-list">' + pending.map(parentClaimRowHtml).join('') + '</section>' +
        emptyCard('Waiting for approval', 'We’ll let you know once this has been confirmed. You’ll then see their sessions and published feedback here.')
      : emptyCard('No children linked yet', 'Claim your child to see their sessions, coach feedback and development in one place.')) +
    '<button class="primary-btn" data-action="open-claim-child" style="margin-top:14px">+ Claim a Child</button>';
}

// ---------------------------------------------------------------- HOME

export function renderParentHome() {
  state.screen = 'parent-home';
  var child = activeChild();
  if (!child) { root.innerHTML = noChildHtml(); return; }

  var session = (child.active_sessions || [])[0] || null;
  var latest = latestFeedback(child.player_record_id);

  root.innerHTML =
    heroHtml('Parent & Player Hub', 'Welcome back', 'A quick view of what matters most right now.', child.name, childSubtitle(child), child) +
    nextSessionHtml(session) +
    updatesHtml() +
    recentFeedbackHtml(latest);

  if (!state.parentFeedbackLoaded) loadParentFeedback(child.player_record_id);
}

function nextSessionHtml(session) {
  if (!session) {
    return sectionHead('Next Session') +
      emptyCard('No session booked yet', 'Once your child is on a session it’ll show here with the time, venue and coach.') +
      '<button class="secondary-btn" data-action="parent-find-session">Find a session</button>';
  }
  var dates = nextOccurrences(session.day, 1);
  // The date line already carries the day, so the meta lines drop it.
  var meta = dates.length ? sessionMetaLines(session, { noDay: true }) : sessionMetaLines(session);
  return sectionHead('Next Session', 'View all') +
    '<section class="ph-next">' +
    '<span class="ph-pill">UPCOMING</span>' +
    '<h3>' + esc(sessionTitle(session)) + '</h3>' +
    '<div class="ph-next-meta">' +
    (dates.length ? '<div>' + esc(formatDayDate(dates[0])) + '</div>' : '') +
    meta.map(function (l) { return '<div>' + esc(l) + '</div>' }).join('') +
    '</div>' +
    '<button class="primary-btn" data-action="parent-session-detail" data-session="' + esc(session.session_record_id) + '">View session</button>' +
    '</section>';
}

/**
 * Session Updates has no data source yet, so this renders nothing at all
 * rather than an empty shell or invented notice. Kept as its own function
 * reading state.parentUpdates so adding the real source later is a data
 * change, not a layout change.
 */
function updatesHtml() {
  var updates = (state.parentHub && state.parentHub.updates) || state.parentUpdates || [];
  if (!updates.length) return '';
  return sectionHead('Updates', updates.length + ' active') +
    updates.map(function (u) {
      return '<section class="card ph-update"><h3>' + esc(u.title || '') + '</h3><p>' + esc(u.body || '') + '</p>' +
        (u.meta ? '<div class="ph-update-meta">' + esc(u.meta) + '</div>' : '') + '</section>';
    }).join('');
}

function recentFeedbackHtml(latest) {
  if (!state.parentFeedbackLoaded) {
    return sectionHead('Recent Feedback') + '<section class="card ph-empty"><b>Loading feedback…</b></section>';
  }
  if (!latest) {
    return sectionHead('Recent Feedback') +
      emptyCard('No published feedback yet', 'When a coach publishes feedback for your child, it will appear here.');
  }
  return sectionHead('Recent Feedback', 'View development') +
    '<section class="card ph-feedback">' +
    '<b>Published ' + esc(formatIsoDate(latest.date)) + '</b>' +
    feedbackSnippetHtml(latest) +
    '<button class="secondary-btn" data-action="parent-feedback-detail" data-feedback="' + esc(latest.feedback_id) + '">View feedback</button>' +
    '</section>';
}

function feedbackSnippetHtml(f) {
  var parts = [];
  if (f.keep_doing) parts.push('<b>Keep Doing:</b> ' + esc(f.keep_doing));
  if (f.big_focus) parts.push('<b>My Focus:</b> ' + esc(f.big_focus));
  if (!parts.length && f.summary) parts.push(esc(f.summary));
  return parts.length ? '<p>' + parts.join('<br>') + '</p>' : '';
}

// ------------------------------------------------------------ SESSIONS

export function renderParentSessions() {
  state.screen = 'parent-sessions';
  var child = activeChild();
  if (!child) { root.innerHTML = noChildHtml(); return; }
  var sessions = child.active_sessions || [];
  var ended = child.ended_sessions || [];
  var pending = child.pending_requests || [];

  root.innerHTML =
    heroHtml(child.name, 'Sessions', 'Everything you need to know about where they are going and when.',
      (child.active_sessions || []).length === 1 ? 'Current programme' : 'Your programmes', childSubtitle(child), child) +
    (sessions.length ? sectionHead('Upcoming Sessions', 'Next 3') + '<section class="card">' + upcomingRowsHtml(sessions) + '</section>'
      : sectionHead('Upcoming Sessions') + emptyCard('No active sessions', 'Once a session request is approved, upcoming dates will show here.')) +
    (pending.length ? sectionHead('Awaiting approval') + '<section class="card">' + pending.map(function (p) {
      var requested = (state.parentHub && state.parentHub.available_sessions || []).find(function (a) { return a.session_record_id === p.session_record_id }) || p;
      var lines = sessionMetaLines(requested, { noCoach: true });
      return '<div class="ph-row"><div class="ph-datebox ph-datebox-muted"><small>REQ</small><b>·</b></div>' +
        '<div><div class="ph-row-title">' + esc(sessionTitle(requested)) + '</div><div class="ph-row-sub">' +
        (lines.length ? lines.map(esc).join('<br>') + '<br>' : '') +
        'Requested ' + esc(formatIsoDate(p.requested_date) || 'recently') + ' · waiting for approval</div></div><div></div></div>';
    }).join('') + '</section>' : '') +
    sectionHead('Find Another Session') +
    '<section class="card ph-feedback"><b>Looking for another session?</b>' +
    '<p>Browse the other programmes we run. We’ll pass your request to the office to confirm a place.</p>' +
    '<button class="primary-btn" data-action="parent-find-session">Find a session</button></section>' +
    sectionHead('Past & Current') +
    '<div class="ph-grid2">' +
    // Named individually rather than collapsed into one "current
    // programme" - a child can be on several at once.
    '<div class="ph-mini"><b>' + (sessions.length === 1 ? 'Current programme' : 'Your programmes') + '</b><small>' +
    (sessions.length ? sessions.map(function (s) { return esc(sessionTitle(s)) }).join('<br>') : 'None yet') + '</small></div>' +
    '<div class="ph-mini"><b>Previous sessions</b><small>' + esc(ended.length ? ended.length + ' completed' : 'None yet') + '</small></div>' +
    '</div>';
}

/** Next three dates across every session the child is on, soonest first. */
function upcomingRowsHtml(sessions) {
  var rows = [];
  sessions.forEach(function (s) {
    nextOccurrences(s.day, 3).forEach(function (d) { rows.push({ date: d, session: s }); });
  });
  rows.sort(function (a, b) { return a.date - b.date });
  if (!rows.length) {
    // A session with no day on the schedule sheet still deserves a row -
    // just without a fabricated date.
    return sessions.map(function (s) {
      return '<button class="ph-row" data-action="parent-session-detail" data-session="' + esc(s.session_record_id) + '">' +
        '<div class="ph-datebox ph-datebox-muted"><small>—</small><b>·</b></div>' +
        '<div><div class="ph-row-title">' + esc(sessionTitle(s)) + '</div><div class="ph-row-sub">' + sessionMetaLines(s).map(esc).join('<br>') + '</div></div>' +
        '<div class="ph-chev">›</div></button>';
    }).join('');
  }
  return rows.slice(0, 3).map(function (r) {
    var s = r.session;
    // The date box carries the day, so it isn't repeated in the sub-lines.
    var sub = sessionMetaLines(s, { noDay: true }).map(esc).join('<br>');
    return '<button class="ph-row" data-action="parent-session-detail" data-session="' + esc(s.session_record_id) + '">' +
      '<div class="ph-datebox"><small>' + esc(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][r.date.getDay()]) + '</small><b>' + r.date.getDate() + '</b><em>' + esc(MONTHS[r.date.getMonth()].slice(0, 3).toUpperCase()) + '</em></div>' +
      '<div><div class="ph-row-title">' + esc(s.session_name) + '</div><div class="ph-row-sub">' + sub + '</div></div>' +
      '<div class="ph-chev">›</div></button>';
  }).join('');
}

export function renderParentSessionDetail(sessionRecordId) {
  state.screen = 'parent-session-detail';
  var child = activeChild();
  var session = ((child && child.active_sessions) || []).find(function (s) { return s.session_record_id === sessionRecordId });
  if (!session) {
    root.innerHTML = '<div class="page-title"><h1>Session</h1></div>' + emptyCard('Session not available', 'We couldn’t find this session for your child.');
    return;
  }
  var dates = nextOccurrences(session.day, 3);
  var v = session.venue_info || {};

  // Only rows the real schedule/venue records actually carry - a blank
  // field is omitted entirely rather than shown as "—" or filled in.
  var rows = [
    ['Day', session.day],
    ['Time', session.time],
    ['Venue', session.venue],
    ['Address', v.address || session.address],
    ['Postcode', v.postcode],
    ['Age group', session.age_group],
    ['Coach', (session.coaches || []).join(', ')],
    ['Programme', session.programme],
    ['Meeting point', v.meeting_point],
    ['Parking', v.parking],
    ['Access', v.access],
    ['Notes', v.notes]
  ].filter(function (r) { return r[1] });

  root.innerHTML =
    '<section class="ph-detail-hero">' +
    (dates.length ? '<div class="ph-eyebrow">' + esc(formatDayDate(dates[0])) + '</div>' : '') +
    '<h1>' + esc(sessionTitle(session)) + '</h1>' +
    '<p>' + esc([session.venue, session.age_group].filter(Boolean).join(' · ')) + '</p>' +
    '</section>' +
    sectionHead('Session Details') +
    '<section class="card ph-detail-list">' +
    rows.map(function (r) { return '<div class="ph-detail-row"><small>' + esc(r[0]) + '</small><b>' + esc(r[1]) + '</b></div>' }).join('') +
    '</section>' +
    (dates.length > 1 ? sectionHead('Next Dates') + '<section class="card ph-detail-list">' +
      dates.slice(1).map(function (d, i) {
        return '<div class="ph-detail-row"><small>' + (i === 0 ? 'Next session' : 'Following') + '</small><b>' + esc(formatLongDate(d) + (session.time ? ' · ' + session.time : '')) + '</b></div>';
      }).join('') + '</section>' : '') +
    sectionHead('Booking') +
    '<section class="card ph-feedback"><b>Active place</b><p>' + esc(child.name) + ' is enrolled on this session.</p></section>';
}

// --------------------------------------------------------- DEVELOPMENT

export function feedbackFor(playerRecordId) {
  var d = state.parentFeedback && state.parentFeedback[playerRecordId];
  return d || null;
}
export function latestFeedback(playerRecordId) {
  var d = feedbackFor(playerRecordId);
  return (d && d.feedback && d.feedback[0]) || null;
}

export function loadParentFeedback(playerRecordId) {
  if (!playerRecordId) return;
  withAccessToken().then(function (token) {
    return fetch(parentHubUrl() + '/feedback?player_record_id=' + encodeURIComponent(playerRecordId), { headers: { Authorization: 'Bearer ' + token } });
  }).then(function (r) {
    return r.json().catch(function () { return {} }).then(function (body) { if (!r.ok) throw new Error(body && body.error || 'Could not load feedback.'); return body });
  }).then(function (body) {
    state.parentFeedback = state.parentFeedback || {};
    state.parentFeedback[playerRecordId] = body;
    state.parentFeedbackLoaded = true;
    if (state.role === 'parent') renderParentScreen();
  }).catch(function (e) {
    state.parentFeedbackLoaded = true;
    state.parentFeedbackError = e.message || 'Could not load feedback.';
    if (state.role === 'parent') renderParentScreen();
  });
}

export function renderParentDevelopment() {
  state.screen = 'parent-development';
  var child = activeChild();
  if (!child) { root.innerHTML = noChildHtml(); return; }
  if (!state.parentFeedbackLoaded) {
    root.innerHTML = heroHtml(child.name, 'Development', '', '', '', child) + '<div class="loading">Loading feedback…</div>';
    loadParentFeedback(child.player_record_id);
    return;
  }
  var data = feedbackFor(child.player_record_id) || { feedback: [], settings: {} };
  var list = data.feedback || [];
  var latest = list[0] || null;
  var previous = list.slice(1);

  root.innerHTML =
    heroHtml(child.name, 'Development', 'Published coach feedback and where their development is right now.',
      latest ? 'Latest review' : 'No reviews yet',
      latest ? [formatIsoDate(latest.date), latest.coach_name].filter(Boolean).join(' · ') : 'Published feedback will appear here', child) +
    (latest
      ? sectionHead('Latest Feedback', 'Published') +
        '<section class="card ph-feedback"><b>' + esc(child.name + ' — ' + formatIsoDate(latest.date)) + '</b>' +
        fullFeedbackBodyHtml(latest) +
        '<button class="primary-btn" data-action="parent-feedback-detail" data-feedback="' + esc(latest.feedback_id) + '">Open full feedback</button></section>'
      : sectionHead('Latest Feedback') + emptyCard('No published feedback yet', 'When a coach publishes feedback for your child, it will appear here.')) +
    currentDevelopmentHtml(latest, data.settings || {}) +
    (previous.length
      ? sectionHead('Previous Feedback', 'History') + '<section class="card">' + previous.map(function (f) {
          return '<button class="ph-history" data-action="parent-feedback-detail" data-feedback="' + esc(f.feedback_id) + '">' +
            '<div><b>' + esc(formatIsoDate(f.date)) + '</b><small>' + esc([f.coach_name ? 'Coach: ' + f.coach_name : '', 'Published'].filter(Boolean).join(' · ')) + '</small></div>' +
            '<div class="ph-chev">›</div></button>';
        }).join('') + '</section>'
      : '');
}

/**
 * The rating snapshot from the most recent published feedback, grouped by
 * the framework's own groups. Shows an empty state rather than an empty
 * grid when the latest feedback carries no parent-visible ratings (e.g. a
 * written-only framework, or every area hidden from parents).
 */
function currentDevelopmentHtml(latest, settings) {
  var ratings = (latest && latest.ratings) || [];
  if (!ratings.length) {
    return sectionHead('Current Development') +
      emptyCard('Not available yet', 'Once a coach publishes a review with development ratings, their current snapshot will show here.');
  }
  var order = [], byGroup = {};
  ratings.forEach(function (r) {
    var g = r.group || 'Development';
    if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
    byGroup[g].push(r);
  });
  return sectionHead('Current Development', 'Latest review') +
    '<section class="card ph-snapshot">' +
    order.map(function (g) {
      return '<div class="ph-group-label">' + esc(g) + '</div>' +
        byGroup[g].map(function (r) { return rateRowHtml(r, settings) }).join('');
    }).join('') +
    legendHtml(settings) +
    '</section>';
}

function rateRowHtml(r, settings) {
  var colours = [['blue', settings.blue_label || 'Blue'], ['green', settings.green_label || 'Green'], ['amber', settings.amber_label || 'Amber'], ['red', settings.red_label || 'Red']];
  var picked = String(r.rating || '').toLowerCase();
  return '<div class="ph-rate"><b>' + esc(r.name) + '</b>' +
    colours.map(function (c) {
      return '<i class="ph-dot ph-' + c[0] + (picked === c[0] ? ' is-selected' : '') + '" title="' + esc(c[1]) + '" aria-label="' + esc(c[1]) + '"></i>';
    }).join('') +
    '</div>' +
    (r.notes ? '<div class="ph-rate-note">' + esc(r.notes) + '</div>' : '');
}

function legendHtml(settings) {
  var colours = [['blue', settings.blue_label || 'Blue'], ['green', settings.green_label || 'Green'], ['amber', settings.amber_label || 'Amber'], ['red', settings.red_label || 'Red']];
  return '<div class="ph-legend">' + colours.map(function (c) {
    return '<span class="ph-legend-item"><i class="ph-legend-dot ph-' + c[0] + '"></i>' + esc(c[1]) + '</span>';
  }).join('') + '</div>';
}

function fullFeedbackBodyHtml(f) {
  var parts = [];
  if (f.keep_doing) parts.push('<b>Keep Doing:</b><br>' + esc(f.keep_doing));
  if (f.big_focus) parts.push('<b>My Focus:</b><br>' + esc(f.big_focus));
  if (f.summary) parts.push('<b>General Coach Feedback:</b><br>' + esc(f.summary));
  return parts.length ? '<p>' + parts.join('<br><br>') + '</p>' : '<p class="ph-muted">This review focuses on the development ratings below.</p>';
}

export function renderParentFeedbackDetail(feedbackId) {
  state.screen = 'parent-feedback-detail';
  var child = activeChild();
  var data = child ? feedbackFor(child.player_record_id) : null;
  var f = ((data && data.feedback) || []).find(function (x) { return x.feedback_id === feedbackId });
  if (!f) {
    root.innerHTML = '<div class="page-title"><h1>Feedback</h1></div>' + emptyCard('Feedback not available', 'This feedback isn’t available to view.');
    return;
  }
  root.innerHTML =
    '<section class="ph-detail-hero">' +
    '<div class="ph-eyebrow">' + esc([formatIsoDate(f.date), f.coach_name ? 'Coach: ' + f.coach_name : ''].filter(Boolean).join(' · ')) + '</div>' +
    '<h1>' + esc(child.name) + '</h1>' +
    (f.session_name ? '<p>' + esc(f.session_name) + '</p>' : '') +
    '</section>' +
    sectionHead('Coach Feedback') +
    '<section class="card ph-feedback">' + fullFeedbackBodyHtml(f) + '</section>' +
    currentDevelopmentHtml(f, (data && data.settings) || {});
}

// ---------------------------------------------------------------- MORE

/**
 * The six policy areas are the agreed information architecture, so each
 * one keeps its row even before the organisation has published its
 * wording. Tapping through says plainly that it isn't published yet and
 * points at the office rather than showing invented policy text - a
 * fabricated safeguarding or refund policy would be worse than an honest
 * gap. Wire each key to real content once it exists.
 */
export const PARENT_POLICIES = [
  ['safeguarding', 'Safeguarding', 'How we keep children safe'],
  ['cancellation', 'Cancellation & Refund', 'Bookings, cancellations and refunds'],
  ['terms', 'Terms & Conditions', 'The terms that apply to our sessions'],
  ['privacy', 'Privacy', 'How we handle your data'],
  ['photography', 'Photography / Media', 'Photo and video permissions'],
  ['conduct', 'Codes of Conduct / Parent Guidance', 'What we ask of players and parents']
];

function supportEmail() {
  var org = (window.HubContent && HubContent.get() && HubContent.get().organisation) || {};
  return org.support_email || '';
}

function menuRowHtml(icon, title, sub, action, data) {
  return '<button class="ph-menu-row"' + (action ? ' data-action="' + esc(action) + '"' : '') + (data || '') + '>' +
    '<span class="ph-menu-icon">' + icon + '</span>' +
    '<span><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span>' +
    '<span class="ph-chev">›</span></button>';
}

export function renderParentMore() {
  state.screen = 'parent-more';
  var child = activeChild();
  var children = (state.parentHub && state.parentHub.children) || [];

  root.innerHTML =
    heroHtml('Parent & Player Hub', 'More', 'Payments, account access, support and policies.',
      child ? child.name : 'Your account', child ? 'Verified linked child' : 'No children linked yet', child) +

    sectionHead('Payments & Bookings') +
    '<section class="card ph-empty"><b>Coming soon</b>' +
    '<p>Paying for sessions and managing bookings will live here. For now, payments are handled by the office as usual.</p></section>' +

    sectionHead('Family & Account') +
    '<section class="card ph-menu">' +
    menuRowHtml('●', 'Children & Access', children.length ? children.length + ' linked' : 'Claim your child', 'parent-children') +
    menuRowHtml('⚙', 'Account', 'Your profile and sign-in', 'profile') +
    '</section>' +

    sectionHead('Help & Support') +
    '<section class="card ph-menu">' +
    menuRowHtml('?', 'Contact / Support', supportEmail() || 'Get in touch with the office', 'parent-support') +
    '</section>' +

    sectionHead('Policies & Information') +
    '<section class="card ph-menu">' +
    PARENT_POLICIES.map(function (p) {
      return menuRowHtml('▤', p[1], p[2], 'parent-policy', ' data-policy="' + esc(p[0]) + '"');
    }).join('') +
    '</section>';
}

export function renderParentChildren() {
  state.screen = 'parent-children';
  var children = (state.parentHub && state.parentHub.children) || [];
  var pending = (state.parentHub && state.parentHub.pending_claims) || [];
  root.innerHTML =
    '<div class="page-title"><h1>Children &amp; Access</h1><p>The children linked to your account.</p></div>' +
    (children.length ? '<section class="card ph-menu parent-children-list">' + children.map(parentChildRowHtml).join('') + '</section>'
      : emptyCard('No children linked yet', 'Claim your child so you can see their sessions and published feedback.')) +
    (pending.length ? sectionHead('Pending claims') + '<section class="card parent-pending-list">' + pending.map(parentClaimRowHtml).join('') + '</section>' : '') +
    '<button class="primary-btn" data-action="open-claim-child" style="margin-top:14px">+ Claim a Child</button>';
}

export function renderParentPolicy(key) {
  state.screen = 'parent-policy';
  var policy = PARENT_POLICIES.find(function (p) { return p[0] === key }) || ['', 'Policies', ''];
  var email = supportEmail();
  root.innerHTML =
    '<div class="page-title"><h1>' + esc(policy[1]) + '</h1><p>' + esc(policy[2]) + '</p></div>' +
    '<section class="card ph-empty"><b>Not published here yet</b>' +
    '<p>This policy hasn’t been added to the Hub yet. The office can give you the current version' +
    (email ? ' — email ' + esc(email) + '.' : '.') + '</p></section>';
}

export function openParentSupport() {
  var email = supportEmail();
  sheet.hidden = false;
  sheetContent.innerHTML = '<div class="calendar-sheet"><h3>Contact / Support</h3>' +
    '<p>Questions about sessions, payments or your account — the office is the quickest route.</p>' +
    (email ? '<div class="venue-info-row"><b>Email</b><span>' + esc(email) + '</span></div>' : '<p class="ph-muted">No support contact has been added to the Hub yet.</p>') +
    '</div>';
}

// -------------------------------------------- claims & session requests

export function parentChildRowHtml(c) {
  var sessions = (c.active_sessions || []).map(function (s) { return s.session_name }).join(', ');
  return '<div class="ph-menu-row"><span class="ph-menu-icon">' + (c.photo_url ? '<img src="' + esc(c.photo_url) + '" alt="">' : esc(playerInitials(c.name))) + '</span>' +
    '<span><b>' + esc(c.name) + '</b><small>' + esc(['Verified', c.relationship, sessions].filter(Boolean).join(' · ')) + '</small></span>' +
    '<span></span></div>';
}

export function parentClaimStatusLabel(status) { return status === 'Needs Review' ? 'Needs review' : status === 'Rejected' ? 'Rejected' : 'Pending' }

export function parentClaimRowHtml(c) {
  var cls = c.status === 'Rejected' ? 'is-former' : 'is-cover';
  return '<div class="request-row"><div><b>' + esc(c.player_name || 'Claim submitted') + '</b><small class="player-tier ' + cls + '">' + esc(parentClaimStatusLabel(c.status)) + '</small></div></div>';
}

export function openClaimChildSheet() {
  sheet.hidden = false;
  sheetContent.innerHTML = '<div class="calendar-sheet"><h3>Claim a Child</h3><p>We’ll match this to their player record. Management will confirm it before you get access.</p>' +
    '<div class="parent-form">' +
    '<label class="auth-field">Child’s full name<input id="claim-name" autocomplete="off"></label>' +
    '<label class="auth-field">Date of birth<input id="claim-dob" type="date"></label>' +
    '<label class="auth-field">Relationship<select id="claim-relationship"><option value="Parent">Parent</option><option value="Guardian">Guardian</option><option value="Grandparent">Grandparent</option><option value="Carer">Carer</option><option value="Other">Other</option></select></label>' +
    '<p class="auth-error" id="claim-error" hidden></p>' +
    '<button class="primary-btn" data-action="submit-claim">Submit claim</button>' +
    '</div></div>';
}

export function submitClaim(btn) {
  var nameEl = document.getElementById('claim-name'), dobEl = document.getElementById('claim-dob'), relEl = document.getElementById('claim-relationship'), errEl = document.getElementById('claim-error');
  var name = (nameEl && nameEl.value || '').trim(), dob = (dobEl && dobEl.value || '').trim(), relationship = relEl && relEl.value || 'Parent';
  if (!name || !dob) { if (errEl) { errEl.textContent = 'Please add your child’s name and date of birth.'; errEl.hidden = false } return }
  if (errEl) errEl.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…' }
  withAccessToken().then(function (token) {
    return fetch(parentHubUrl() + '/claims', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ player_name: name, date_of_birth: dob, relationship: relationship }) });
  }).then(function (r) {
    return r.json().catch(function () { return {} }).then(function (body) { if (!r.ok) throw new Error(body && body.error || 'Could not submit this claim.'); return body });
  }).then(function () {
    closeSheet(); toast('Claim submitted — management will confirm it');
    state.parentHubLoaded = false; loadParentHub();
  }).catch(function (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit claim' }
    if (errEl) { errEl.textContent = e.message || 'Could not submit this claim.'; errEl.hidden = false }
  });
}

/**
 * A session the child is already actively linked to is never offered here
 * at all (nothing to request - they're already in). A session with a
 * Pending request already showing on this child (from parent-hub's /me,
 * itself read from the real Player Session Requests table, not a
 * separate tracked list) stays visible but disabled, labelled, so it's
 * clear why it can't be picked again rather than silently vanishing.
 */
export function openRequestSessionSheet(playerId, playerName) {
  var child = ((state.parentHub && state.parentHub.children) || []).find(function (c) { return c.player_record_id === playerId }) || activeChild() || {};
  playerId = playerId || child.player_record_id;
  playerName = playerName || child.name || '';
  var all = (state.parentHub && state.parentHub.available_sessions) || [];
  var activeIds = {}; (child.active_sessions || []).forEach(function (s) { activeIds[s.session_record_id] = true });
  var pendingIds = {}; (child.pending_requests || []).forEach(function (s) { pendingIds[s.session_record_id] = true });
  var requestable = all.filter(function (s) { return !activeIds[s.session_record_id] });
  var pickedFirst = false;
  var options = requestable.map(function (s) {
    var pending = !!pendingIds[s.session_record_id];
    var selectAttr = (!pending && !pickedFirst) ? (pickedFirst = true, ' selected') : '';
    return '<option value="' + esc(s.session_record_id) + '"' + (pending ? ' disabled' : '') + selectAttr + '>' + esc(sessionOptionLabel(s)) + (pending ? ' (already requested)' : '') + '</option>';
  }).join('');
  var anySelectable = pickedFirst;
  sheet.hidden = false;
  sheetContent.innerHTML = '<div class="calendar-sheet"><h3>Find a session</h3><p>For ' + esc(playerName) + '. Management will approve, reject or amend this request.</p>' +
    '<div class="parent-form">' +
    (anySelectable ? '<label class="auth-field">Session<select id="request-session-select">' + options + '</select></label>' : '<p class="auth-sub">' + (requestable.length ? 'A request is already pending for every remaining session.' : 'No sessions are available to request right now.') + '</p>') +
    '<p class="auth-error" id="request-session-error" hidden></p>' +
    (anySelectable ? '<button class="primary-btn" data-action="submit-session-request" data-player-id="' + esc(playerId) + '">Request session</button>' : '') +
    '</div></div>';
}

export function submitSessionRequest(playerId, btn) {
  var select = document.getElementById('request-session-select'), errEl = document.getElementById('request-session-error');
  var sessionId = select ? select.value : '';
  if (!sessionId) { if (errEl) { errEl.textContent = 'Please choose a session.'; errEl.hidden = false } return }
  if (errEl) errEl.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…' }
  withAccessToken().then(function (token) {
    return fetch(parentHubUrl() + '/session-requests', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ player_record_id: playerId, session_record_id: sessionId }) });
  }).then(function (r) {
    return r.json().catch(function () { return {} }).then(function (body) { if (!r.ok) throw new Error(body && body.error || 'Could not send this request.'); return body });
  }).then(function () {
    closeSheet(); toast('Session request sent — waiting for approval');
    state.parentHubLoaded = false; loadParentHub();
  }).catch(function (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Request session' }
    if (errEl) { errEl.textContent = e.message || 'Could not send this request.'; errEl.hidden = false }
  });
}
