# Josh Evans Hub — what's done, what's next, what's still a question

Kept current as we go. The point of it is that nothing agreed in a
conversation gets lost, and that anyone picking this up later — David, Josh,
or me in a fresh session — can see where things stand without re-reading
everything.

Last updated: 19 September 2026

---

## Where this came from

This repo (`coach-allocation-test`) is a from-scratch rebuild of the Coaches
Hub into a full multi-role **Josh Evans Hub** — coaches, parents, players and
management, all in one place. Nothing here touches the live Coaches Hub
repo or site; they are entirely separate.

The plan was worked out over several days across parallel conversations
(here and with ChatGPT) before landing on this version. Worth recording
because it explains a few design choices below:

- **Notion was the original plan for content** (Resources, Handbook,
  Venues, player development records), with Supabase for accounts and
  permissions. **Settled on Airtable instead** — a better fit for what
  this actually needs: structured records with stable IDs and real
  relationships (player ↔ feedback ↔ coach, parent ↔ child), which is
  Airtable's core model, not something bolted onto a wiki.
- **The end goal is a sellable product**, not just a tool for Josh Evans
  Soccer School — "easy to pick up and use for another company who might
  want the same feature." This is why `Organisation & Branding`,
  `Hub Settings` and `Feature Controls` exist in Airtable already: wording,
  branding and which features are switched on should differ per
  organisation without touching code. The practical near-term path is a
  **duplicated instance per customer** (new Supabase project, new Airtable
  base, same code) rather than building shared multi-tenant infrastructure
  before there's a second real customer — but only if the standing rule
  below is actually held to.
- **David's own bar, stated directly**: *"I don't want anything to become
  more difficult later with the code... simple the better, especially if
  it becomes a player/parent/coaches/management hub."* Airtable is the
  lever for changing the Hub's content; the code should not need touching
  for that.

## Standing rules — the backend contract

Reviewed against a separate written review (19 Sept) and agreed as a
rulebook every phase follows, not a phase of its own. This is what makes
**"nail the Coach UI first" safe rather than risky** — the reason it
won't cost extra work later is that every phase, starting with Phase 0,
is built on top of these rules from day one, not bolted on after:

- **Nothing organisation-specific gets hardcoded.** If it's not obviously
  reusable for a second customer, it belongs in Airtable/Supabase config,
  not in code — the difference between "duplicate this for a new customer
  in a day" and "rewrite it."
- **The frontend never talks to Airtable directly** — always through a
  secure Edge Function.
- **The frontend never decides permissions from hidden buttons, URL
  parameters or a user-supplied role.** This is the precise, permanent fix
  for the `?role=`/`?coach=` hack — not just replacing it once, but the
  rule that stops anything like it coming back.
- **Supabase Auth, RLS and secure Edge Functions are the only authority
  for access.** Airtable stores operational people, relationships and
  content — never passwords or security decisions.
- **Google Sheets stays the source of truth for schedule and financials**
  unless deliberately migrated later.
- **Every private endpoint identifies the user from the authenticated
  Supabase session.** The browser never supplies a trusted `user_id`,
  coach name or role — the server always checks, every time.
- **Every organisation-scoped request resolves `organisation_id` on the
  backend**, never from anything the client sends — matters directly for
  the sellable-product goal.
- **Stable IDs are permanent once linked.** Never reused, never repurposed.
- **Parent access requires a verified Parent–Player relationship** (the
  `Link Status` field on Parent–Player Links is where that gets confirmed).
- **Parent-visible feedback and development plans must be `Published`
  before they can be returned** — enforced by the API itself, not just
  hidden in the UI, so a parent can never see a draft by asking the
  backend directly.
- **Every write carries an audit trail**: `created_by_user_id`,
  `created_by_role`, `created_at`, `last_updated_at`. Cheap to add from day
  one, expensive to retrofit once real records exist — starts applying the
  moment Phase 1 begins writing.
- **Test-first, always.** Backend, auth and permission changes are tried in
  the TEST environment first; schema changes are recorded as migrations
  where possible; a security check runs after any RLS change; a new
  endpoint is tested for both the correct role *and* that the wrong role
  is denied; live code doesn't change until TEST behaviour is confirmed.
- **Failures fail visibly, never silently** — the same fix already applied
  to the Changes tab's silent-failure risk, generalised: an important
  schedule or permission failure should never quietly show incomplete or
  wrong data.

## Done so far

- **Coach experience UI built** — Home, Schedule (Today/This Week/Calendar
  tabs), Venues, session detail, Coach Support, Resources, More, and a
  Management sub-screen. A genuine native-app-feeling shell: sticky top
  bar, bottom nav, bottom sheets, toasts, add-to-calendar downloads. More
  polished in places than the live Coaches Hub already.
- **Supabase project connected** (`profiles` table: `user_id`,
  `organisation_id`, `role` [pending/management/coach/parent], `active`,
  `airtable_person_id`). RLS is on, with exactly one policy — a user can
  read their own row. A trigger (`on_auth_user_created` →
  `handle_new_user()`) auto-creates a `pending` profile on signup. Nobody
  can self-promote their own role, on purpose. Security has already had
  real, deliberate hardening passes — migrations named
  `lock_down_security_definer_functions` and
  `strengthen_profile_identity_links`, not just defaults left in place.
- **One Edge Function, `hub-content`** — the Airtable token lives server-side
  (`Deno.env.get`), never exposed to the browser. Right architecture.
  Currently only serves organisation branding, Hub Settings labels and
  Feature Controls toggles.
- **Airtable base built out** — 13 tables: Venues, Resources, Coach Support,
  Players, Feedback, Coaches, Hub Settings, Admin Guide, Organisation &
  Branding, Feature Controls, Development Plans, Parents & Guardians,
  Parent–Player Links. Stable IDs everywhere (`VEN-`, `PLY-`, `COA-` style).
  Feedback and Development Plans are append-only by design — a new record
  per review rather than overwriting, so history is never lost, same
  principle as the P&L archive on the live Hub. `Published` flags gate what
  a parent/player ever sees. An `Admin Guide` table documents the whole
  system in plain English for whoever edits it day to day. `Date of Birth`
  on Players exists specifically so a parent-entered child can be safely
  matched — "do not use name alone for matching."
- **`content-provider.js`** — a clean frontend pattern
  (`HubContent.load...()`) already pointed at the direction this needs to
  go: the browser calls named loader functions, never Airtable directly.
  Also does live label substitution (an Airtable `idp_label` row can rename
  "IDP" to "Targets" everywhere in the Hub, no code change) — this is
  already the config-driven pattern the standing rule above asks for.
- **`hub-content` extended** to also serve Resources, Venues and Coach
  Support from Airtable (with an empty-primary-field guard after a stray
  blank Venues row was found live). Resources/Venues/Coach Support screens
  now read real Airtable data instead of hardcoded sample arrays or the old
  Sheets CSV. Changes now fails visibly (a banner), not silently. Orphaned
  `style.css` deleted.
- **Real Supabase Auth is live**: one shared email + password screen
  (sign in / create account, no role picker — role is never user-chosen)
  replaces `?role=`/`?coach=` as the source of truth. A new `me` Edge
  Function (`verify_jwt: true`) resolves the authenticated session's own
  `profiles` row — never a client-supplied user id — into
  `{ user_id, email, organisation_id, role, status, airtable_person_id,
  display_name }`. `profiles` gained a `display_name` column: the coach's
  name exactly as it appears on the Sessions tab, set manually by whoever
  approves a `pending` signup (not self-service — a wrong or self-chosen
  name could expose another coach's sessions). It's what `mine()` matches
  against, since schedule filtering is Sheets-name-based, not
  Airtable-ID-based. A signed-in `pending` user sees a plain "waiting for
  approval" screen with a log-out button, nothing else.

## Known gaps (confirmed by reading the actual code, not guessed)

- No way to promote a `pending` signup, or set their `display_name`, today
  short of editing the Supabase table directly. Works, isn't a dead end,
  but is still a manual step for David/Josh every time.
- Parent, real Management (as a role, not the shared-password sub-screen),
  and Player have no screens at all yet — they land on a generic "X Hub"
  placeholder after signing in.
- Only Supabase's global "leaked password protection" advisory is
  outstanding — everything else security-wise came back clean on review.

## The phases

### Phase 0 — Nail the Coach experience

This is the design language everything else inherits, so it happens once,
properly, before anything else builds on top of it. Deliberately paired
with real data rather than done as pure visual polish — real content is
what actually stress-tests a layout (a resource card with no thumbnail, a
long title, an empty category); polishing against hardcoded sample arrays
would mean redoing it once real content lands anyway.

- [x] Extend `hub-content` to serve Resources, Venues and Coach Support from
  Airtable; point those screens at it instead of the hardcoded arrays / old
  Sheets CSV.
- [x] Fix the Changes silent-failure risk.
- [x] Delete the orphaned `style.css`.
- [x] Real Supabase Auth: one shared email + password screen (sign in /
  create account), replacing `?role=`/`?coach=` as the source of truth.
  Deliberately *not* three role-specific logins — the backend contract
  says role is never user-chosen, it's always resolved server-side after
  authentication.
- [x] A `/me` endpoint (Edge Function `me`, `verify_jwt: true`) — the
  single clean answer to "who is logged in, what organisation, what
  role": authenticated user (from the Supabase session, never the
  client), `organisation_id`, `role`, `status` (active/inactive),
  `airtable_person_id`, and `display_name` (added once real integration
  showed `/me` needed it — see "Done so far"). Everything role-gated later
  reads from this instead of re-checking identity in multiple places.
- [x] A way to approve a `pending` signup — manual for now (role and
  `display_name` set directly in the Supabase table editor), just needs to
  not be a dead end. A `pending` user who signs in sees a plain "waiting
  for approval" screen.
- [x] Only coach and management signups sit in the `pending` queue. The
  signup screen asks "I am a… Coach/Management or Parent"; picking Parent
  activates the account immediately, no approval step. Safe to let someone
  self-declare this because a bare `parent` role carries no standing
  access today (same placeholder shell as everyone else), and real child
  data will later be gated by the separate verified Parent–Player match
  (Phase 2), not by this step. The signup's own claim is only ever trusted
  for that one, least-privileged outcome — `handle_new_user()` allowlists
  literally the value `'parent'` and anything else (including a tampered
  claim of `'management'`) still falls through to `pending`.
- [x] Go through every Coach screen against that real data and tighten it
  to the same bar as Financials/Schedule on the live Coaches Hub. Found and
  fixed while doing this:
  - The bottom nav and profile icon sat visibly underneath the login
    screen the whole time, and were still clickable — tapping the logo
    while logged out called straight into the coach home screen with no
    data loaded, skipping the login gate entirely. Now hidden (CSS) *and*
    blocked (the nav click handler checks auth state before doing
    anything), so a future stray nav element can't reopen the same hole.
  - The Coach Support detail sheet and its "Open link"/"Open attachment"
    buttons were styled with inline `style=` attributes instead of real
    classes — exactly the kind of patchwork that reads as unfinished.
    Moved to proper CSS.
  - "My Profile", "Notifications", "Feedback" and "Contact the Office" on
    the More screen did nothing when tapped. My Profile now opens a real
    sheet (name/email/role, straight from `/me`); the other three give a
    "Coming soon" toast instead of a dead tap, until Phase 1 gives them
    something real to do.
  - The data-loading and error states (shown while fetching Sessions/
    Airtable data) were unstyled browser-default text. Given a proper
    spinner and an error card matching the rest of the Hub.
  - Resource cards without a thumbnail all used the same blue gradient;
    now cycle through the three gradients that already existed in CSS but
    were only ever used by the old hardcoded sample data.
- [x] A full Playwright pass over the real login flow (signup — both
  account types, wrong password, pending, approved coach, log out, My
  Profile, the nav-bypass fix) — 33 checks passing against a local mock
  that mirrors the real Edge Functions' response shapes. Still needs a
  real pass once this is running somewhere that can reach
  `*.supabase.co` (this sandbox can't reach it directly).

### Parallel track — Trial interest / enquiries

Doesn't depend on Phase 0's auth work at all, so it can be built alongside
it rather than waiting — and it's probably the fastest thing here to
deliver real business value (capturing genuine leads) regardless of how
the rest of the Hub progresses.

- A public Hub screen, **no login** — name, email, phone, which one
  (Jets / Academy / the tour we're running), an optional note. Has to stay
  genuinely public: a prospective parent has never used the Hub before and
  shouldn't need an account just to ask about a trial.
- A new Airtable table, **Trial Interest** — Name, Email, Phone,
  Interested In, Notes, Status (New/Contacted/Booked/Declined), Created
  time.
- A small, dedicated Edge Function (separate from `hub-content`, since this
  is a write) that takes the submission and writes it to Airtable
  server-side — same pattern as everywhere else: the browser never talks
  to Airtable directly.
- **Email notification via an Airtable automation** — "when a record is
  created in Trial Interest, email the office" — confirmed as the
  approach: zero code, and the wording or who it goes to can be changed
  directly in Airtable later without touching anything built here.
- **Spam protection, without requiring any account** — this is not the
  same problem as auth, and doesn't need it:
  - a honeypot field, invisible to a real visitor (hidden with CSS) but
    filled in by dumb bots that complete every field they see — anything
    arriving in it means silently discard the submission;
  - a basic rate limit by IP address — not identifying anyone, just
    noticing many submissions from one place in a short window isn't a
    person;
  - a minimum-time check — reject anything submitted implausibly fast
    after the form loaded.
  - If spam still gets through despite that: Cloudflare Turnstile (a
    modern, mostly invisible CAPTCHA) as the next step up — only added if
    actually needed, not built in from day one.

### Phase 1 — Coach submissions

The first real write path: proves the Hub → Edge Function → Airtable
direction works before more gets built on it. Two instances of the same
shape (coach submits something, it lands in Airtable, sits pending review):

- **Player feedback** — a button on a player's profile, a form, Save writes
  a new Feedback record via the Edge Function. Respects `Published`
  (defaults to unpublished/draft — a coach's rough notes never leak to a
  parent before review).
- **Holiday requests** — same write pattern, new table (coach, dates,
  status). A coach requests time off; it sits pending until Management
  acts on it — the full cover flow is worked out under Phase 3 below.

### Phase 2 — Parent login + matching

- Signup → enter child's name + DOB → backend returns **MATCHED / CREATED /
  NEEDS_REVIEW**, never matched on name alone (exactly what the `Date of
  Birth` field on Players was already designed for). The exact rule for
  each result, so the matching logic stays predictable rather than growing
  ad-hoc exceptions:
  | Result | Rule |
  | --- | --- |
  | `MATCHED` | Exact name + exact DOB + exactly one active matching player |
  | `CREATED` | No existing player matches the supplied name and DOB |
  | `NEEDS_REVIEW` | More than one possible match, conflicting data, or an ambiguous existing record |

  Normal signups should be automatic; only genuinely unusual cases get
  surfaced to Management, rather than risking a wrong parent-to-child link.
- `Parent–Player Links`' `Link Status` field is where a `NEEDS_REVIEW` match
  gets approved before that parent gets access to that child's records.
- Parent sees only **published** feedback and development plans — never
  drafts.
- Parent can submit their own feedback to the school (a session, a coach,
  general) — same submit-and-sit-pending shape as Phase 1.

### Phase 3 — Management, for real

- Real Supabase Auth login (`role='management'`), replacing the shared
  Financials password reused from the live Hub.
- Financials: reuse the live Coaches Hub's Baseline/Actual/Grouping logic
  rather than rebuild term-aware accuracy work that's already built and
  tested there.
- **A review queue** — holiday requests and parent feedback land here to be
  approved/actioned. This is the piece that actually delivers "mostly used
  Hub-side" — approving something in the Hub is what keeps David and Josh
  out of Airtable day to day for routine decisions.
- **Holiday cover, fully worked out (agreed 19 Sept)** — deliberately never
  writes to Google Sheets, on purpose, not as a limitation:
  1. Approve a holiday request → the Hub works out exactly which sessions
     it affects and suggests who's free to cover each one — the fiddly
     part, not the typing.
  2. Pick a coach for a session → they get emailed an Accept/Decline
     link — no calling, no texting, the thing this was built to remove.
  3. **They accept** → Management is notified it's confirmed → types the
     one row into the Changes tab by hand, ~20 seconds. Deliberately
     manual: the alternative is a new write-path into the live schedule
     for a step that costs almost nothing to do by hand, in exchange for
     breaking the rule that only David/Josh ever edit Google Sheets,
     directly, with zero exceptions.
  4. **They decline** → Management is notified → that session goes back
     to "needs cover" → pick someone else, same email loop.
  5. **Escape hatch** — if nobody accepts after a couple of tries, mark
     the session as "needs a phone call" instead of looping forever.
     Automation stops where it should, not where it's forced to.

  **Build this as a reusable pattern, not a holiday-only one-off** — strip
  "holiday" out and it's a general shape: *assign someone to something →
  they confirm or decline → decline loops back to picking someone else →
  escape hatch if nobody accepts.* Nothing above is actually specific to
  holidays. Likely future reuses: same-day sickness cover, one-off session
  swaps, staffing a trial or tour. Build it for holiday cover first,
  exactly as scoped — but keep the Airtable table and Edge Function
  worded generically (an "assignment" with a reason, not a table literally
  called "Holiday Cover") so pointing the same mechanism at a different
  trigger later is reuse, not a rebuild. Same discipline as the standing
  rule about not hardcoding anything organisation-specific, applied to
  features instead of branding.

### Phase 4 — Public pages

Programmes, Locations, Trials & Events, General info — no login needed,
for people who aren't signed up yet. Nothing above depends on this; good
fill-in-the-gaps work, not a blocker to anything else.

- [x] **Pulled forward and built** (David's own call — this is now the
  actual front door of the Hub, not a fill-in-later page): hitting the
  Hub URL with no session lands on a **public home page**, no login at
  all — org name/logo/tagline, then Trials/Academy/Tours/Events/General
  cards, each from a new Airtable table (**Public Pages** — Title, Page
  ID, Category, Body, CTA Label, CTA Link, Image, Active, Sort Order),
  seeded with placeholder rows David can replace directly in Airtable
  whenever real copy is ready. A new public `hub-content` route
  (`public-pages`) serves it, same trust level and same `verify_jwt:
  false` as Resources/Venues/Coach Support already had.
  - **Sign In** and **Register** buttons on that page are the only way
    into the account flow — Register goes straight to the existing
    Coach/Parent picker from Phase 0. Every auth screen (including the
    "check your email" confirmation screen, which used to be a genuine
    dead end with no way out) now has a "‹ Back to Josh Evans Soccer
    School" link back to the public page.
  - Logging out lands back on the public page too, not a bare login
    form — consistent with "this is the front door" rather than
    treating login as the default state.
  - One real dependency to flag: if the Supabase project has "confirm
    email" switched on (the default), Register doesn't drop someone
    straight into the app on the first click — they hit the check-email
    screen first. That's a toggle in the Supabase dashboard, not
    something set here.
- [ ] Trial Interest capture form (see the parallel track below) isn't
  wired into these cards yet — today "Find out more" is just a plain
  link (blank until a real `CTA Link` is added in Airtable). Hooking a
  register-interest form to a specific card is natural follow-up work
  once that track is built.

### Phase 5 — Productisation

Promoted from a vague "open question" to a real final milestone: the
explicit point where the Hub can be considered genuinely reusable for a
second organisation, not just hoped to be. Checklist:

- A new Supabase project can be created cleanly for a new customer.
- A new Airtable base can be provisioned from the same structure.
- Organisation branding and settings can be swapped without touching code.
- Secrets and keys are organisation-specific, never shared between
  customers.
- The same frontend code runs unmodified for another organisation.
- No Josh Evans-specific names, IDs or assumptions remain hardcoded
  anywhere in the reusable app logic.

Deliberately not building shared multi-tenant infrastructure ahead of this
— the practical near-term path stays "duplicate the instance," per
"Where this came from" above — but this is the checklist that decides
when that duplication is actually clean rather than a scramble.

## Open questions

- **Custom domain and hosting** (`JoshEvansHub.com`, possibly Hostinger) —
  not urgent, no dependency on any phase above.
- **How a `pending` signup actually gets approved** long-term — manual in
  Phase 0, could reasonably become part of Management's review queue in
  Phase 3 rather than staying a direct database edit forever.
