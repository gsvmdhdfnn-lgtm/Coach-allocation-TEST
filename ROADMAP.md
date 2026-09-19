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

## Standing rule

**Nothing organisation-specific gets hardcoded.** If it's not obviously
reusable for a second customer, it belongs in Airtable/Supabase config, not
in code. This is the difference between "duplicate this for a new customer
in a day" and "rewrite it." Every phase below gets checked against this,
the same way the live Coaches Hub holds itself to "no Sheets API" and
"changing the schedule means editing the sheet."

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

## Known gaps (confirmed by reading the actual code, not guessed)

- Coach identity comes from `?role=`/`?coach=` in the URL — no real login.
- `hub-content` doesn't yet serve Resources/Venues/Coach Support/Players/
  Feedback — only organisation/settings/features. `content-provider.js`'s
  `loadResources()` etc. would hit routes that don't exist yet.
- Resources and Coach Support screens are hardcoded sample arrays sitting
  directly in `app.js`, not reading from the Resources/Coach Support tables
  that already exist in Airtable.
- Venues still reads the old Google Sheets CSV (`venueInfoCsvUrl`), not the
  new Airtable Venues table (which has richer fields — Hero Image, Parking
  Image, Site Map — that aren't used anywhere yet).
- Two CSS files: `style.css` (1,174 lines, the old Coach Schedule
  stylesheet, unused) and `styles.css` (138 lines, what's actually loaded).
  Harmless, but exactly the sort of clutter that causes someone to edit the
  wrong file later.
- Calendar/Changes/Terms/Themes/Venue info are all fetched as "optional" —
  if the request fails, the app carries on silently. For Terms that's the
  safe default (unrestricted). For **Changes specifically it's a real
  risk**: a failed fetch means a cancellation or cover silently doesn't
  apply, so a coach could be shown a session as normal when it's actually
  covered or cancelled.
- No way to promote a `pending` signup today short of editing the Supabase
  table directly.
- Parent, real Management (as a role, not the shared-password sub-screen),
  and Player have no screens at all yet.
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

- Extend `hub-content` to serve Resources, Venues and Coach Support from
  Airtable; point those screens at it instead of the hardcoded arrays / old
  Sheets CSV.
- Go through every Coach screen against that real data and tighten it to
  the same bar as Financials/Schedule on the live Coaches Hub — proof
  positive of what "done" already looks like, not a vague "make it nicer."
- Real Supabase Auth: login screens for Coach/Parent/Management, replacing
  `?role=`/`?coach=` as the source of truth. Login screens get the same UI
  care as everything else — a coach will actually see this screen.
- A way to approve a `pending` signup — manual for now (flipped in
  Supabase/Airtable directly), just needs to not be a dead end.
- Fix the Changes silent-failure risk.
- Delete the orphaned `style.css`.

### Phase 1 — Coach submissions

The first real write path: proves the Hub → Edge Function → Airtable
direction works before more gets built on it. Two instances of the same
shape (coach submits something, it lands in Airtable, sits pending review):

- **Player feedback** — a button on a player's profile, a form, Save writes
  a new Feedback record via the Edge Function. Respects `Published`
  (defaults to unpublished/draft — a coach's rough notes never leak to a
  parent before review).
- **Holiday requests** — same write pattern, new table. A coach requests
  time off; it sits pending until Management acts on it (Phase 3).

### Phase 2 — Parent login + matching

- Signup → enter child's name + DOB → backend returns **MATCHED / CREATED /
  NEEDS_REVIEW**, never matched on name alone (exactly what the `Date of
  Birth` field on Players was already designed for).
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

### Phase 4 — Public pages

Programmes, Locations, Trials & Events, General info — no login needed,
for people who aren't signed up yet. Nothing above depends on this; good
fill-in-the-gaps work, not a blocker to anything else.

## Open questions

- **Custom domain and hosting** (`JoshEvansHub.com`, possibly Hostinger) —
  not urgent, no dependency on any phase above.
- **How a `pending` signup actually gets approved** long-term — manual in
  Phase 0, could reasonably become part of Management's review queue in
  Phase 3 rather than staying a direct database edit forever.
- **Multi-tenancy** — deliberately not building shared infrastructure for
  it yet (see "Where this came from" above), but worth revisiting once
  there's a genuine second customer rather than a hypothetical one.
