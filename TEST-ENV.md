# Test environment — what exists

Synthetic data only. Nothing here is real. Production untouched.

| | |
|---|---|
| Test Airtable base | `appQktredAuGa1X7e` — Josh Evans Hub — TEST |
| Test Supabase project | `dkqubldmfyeuudecxmvh` — Josh Evans Hub TEST (eu-west-2) |
| Test Supabase URL | `https://dkqubldmfyeuudecxmvh.supabase.co` |
| Test publishable key | `sb_publishable_9B7toOyeF43OyWSiGMz7_g_kv28MsnC` |

## Test accounts (test project only — not in production auth)

Password for all five: `TestHub2026!`

| Email | Hub role | Purpose |
|---|---|---|
| `coach.a@test.invalid` | coach (Lead) | Session A only |
| `coach.b@test.invalid` | coach | Session B only — must never see Session A players |
| `manager@test.invalid` | management | approvals, management screens |
| `parent.a@test.invalid` | parent | one verified child, one pending claim |
| `parent.ended@test.invalid` | parent | ended link — must see nothing, with no grace period |

## Synthetic records

- 2 sessions (TEST-A Monday, TEST-B Thursday), 2 venues
- 3 coaches, staffed so Coach B is on Session B only
- 4 players; memberships: 3 Active, 1 **Paused**, 1 **Ended**
- The ended membership has actual end 12 Sep and scheduled end 30 Sep,
  deliberately different, so former access can be checked against the
  actual date rather than the scheduled one
- 2 parents; links: Verified, Pending, **Ended**
- Framework with 4 items, one coach-only (parents must never see it)
- 2 feedback records: one Published, one unpublished draft

## Secrets still to be entered (test project only)

`AIRTABLE_BASE_ID` = `appQktredAuGa1X7e`
`AIRTABLE_TOKEN`   = the test-only token, scoped to that base alone

The deployed test functions refuse to start if `AIRTABLE_BASE_ID` is a
known production base, or is missing or malformed.

## Sign-in fix — 2026-09-26

Sign-in failed with "Database error querying schema". Cause: creating the
accounts with direct SQL left eight `auth.users` text columns NULL
(`confirmation_token`, `recovery_token`, `email_change_token_new`,
`email_change`, and four phone/reauth equivalents). Supabase's auth
service reads those into non-nullable string fields, so a NULL breaks the
query before any password is checked — which is why the message mentions
the schema rather than the credentials.

Fixed by setting them to empty strings. Test project only; the live
project was not touched.

If more test accounts are ever created by SQL, set those columns to `''`
at insert time rather than leaving them to default.

## Verified end to end — 2026-09-26

Run from inside the test project with `pg_net`, because this sandbox
cannot reach `supabase.co` directly:

- All five accounts sign in: HTTP 200 with an access token.
- `GET /functions/v1/me` → 200, correct role, display name and
  `airtable_person_id`.
- `GET /functions/v1/parent-hub/me` → 200, and it **read the test Airtable
  base**: it returned `PARENT-TEST-001` and resolved both linked children
  by name. The Airtable token and base ID are correct and working.
- `session_requests_available` is `false`, as intended.

### Two findings this proved

1. **The LEGACY rename is reproduced exactly.** `children` is empty and
   `available_sessions` is empty, because the code reads
   `Parent–Player Links.Link Status` and `Sessions.Active`, both now
   `LEGACY —` prefixed. Every link therefore falls through to the default
   "Pending".
2. **An ended parent link discloses the child's name.** Signing in as the
   ended parent returns `children: []` — so no session, schedule or
   feedback data leaks, which is right. But the child's name appears under
   `pending_claims` as "Charlie Clarke — Pending", telling someone whose
   access was removed that a claim is apparently awaiting approval. Same
   root cause: with `Link Status` unreadable, an Ended link is
   indistinguishable from a Pending one. Access is correctly withheld;
   name disclosure is not.

## Sessions repair verified — 2026-09-26

Real calls to `/parent-hub/me` on the test project (parent-hub v3):

- **parent.a** → 200. `Archie Atkinson`: current session **Monday Juniors
  (TEST A)**, start 2026-09-01; ended **Thursday Juniors (TEST B)** with
  `end_date` **2026-09-12** and `scheduled_end_date` **2026-09-30**
  reported separately. `Dylan Davies`: **paused** on Thursday Juniors,
  `paused_from` 2026-09-15, `returns_on` 2026-10-20, and **not** listed as
  current. `Bella Brown` still under pending claims. `available_sessions`
  now returns 2 where it returned 0.
- **parent.ended** → 200, `children: []`, `pending_claims: []`, and a
  search of the whole payload for the ended child's name returns false.
  The privacy fix still holds.

### Found along the way

1. **Day, time and venue still come from Google Sheets.** `sessionPayload`
   joins each session to the published Sessions CSV, so a session that is
   not in that sheet has blank day/time/venue/programme/age group - which
   is what the test sessions show. Airtable now holds `Default Day`,
   `Default Start Time`, `Default End Time` and a `Venue` link, and none
   of them are read. This contradicts the agreed direction that Airtable
   owns the schedule. Not changed: outside the two fields named for this
   repair.
2. **`Players.Active` is still read in two places** - claim matching in
   `handleCreateClaim`, and the management claim list. That field is now
   `LEGACY — Active` with no canonical replacement, by the agreed
   decision that a player's active state is derived from current
   memberships. The code has not been changed to derive it, so a new
   parent claim currently matches no player and always lands as "Needs
   Review". Not changed: outside this repair's scope.
3. A saved access token expired mid-verification and returned 401. That
   was the test method, not the product; re-signing in resolved it.

### Not yet visible on the phone

`paused_sessions` is returned by the API but no screen renders it yet -
the Parent Sessions screen has no paused section. That is a frontend
change, which is deferred.

## Google Sheets dependency removed from sessionPayload — 2026-09-26

TEST only. Confirmed field mapping before changing anything, as asked:

| Item | Backend source |
|---|---|
| Session name | `Sessions.Session Name` (already a direct field; was always read this way) |
| Default day | `Sessions.Default Day` (singleSelect: Monday…Sunday) |
| Default start/end time | `Sessions.Default Start Time` + `Sessions.Default End Time` (both free-text), joined as one display string |
| Venue | `Sessions.Venue` → linked `Venues` record (Venue Name, Address, Postcode, Parking, Meeting Point, Access, Notes) |
| Programme / Category / Age Group | Also direct `Sessions` fields — these were being taken from the Sheet too although Airtable already carried them; folded into the same repair since the source was already fetched |

Also removed: `SESSIONS_CSV_URL`, the CSV parser, and the Session-ID-keyed
join that matched a Sessions row to a Sheet row. `sessionPayload` no
longer fetches or references the Sheet in any way. Venue resolution now
follows the real Airtable link (`Sessions.Venue` → record id), not a
name-match against a free-text sheet column — a link cannot silently
mismatch the way a name string can.

**Left out of this repair, deliberately:** `coaches` is now `[]`. The old
CSV had a free-text coach-names column; there is no canonical replacement
wired into `sessionPayload`. The canonical source is `Session Staff`
(Session → Coach → Role), which this function does not read. Not fixed
here because it needs its own Airtable fetch and a per-session join, which
goes beyond the four fields asked for. Flagged as a known follow-up.

### Stopped, not built: "Next Session" from dated occurrences

Checked before changing anything. **Parent Home's "Next Session" does not
use `Session Occurrences` at all, in TEST or in the archived production
source.** `nextSessionHtml()` in `parent.js` calls `nextOccurrences(session.day,
1)` — a pure client-side projection of the next calendar date matching the
session's recurring weekday name. It has no concept of a cancelled,
postponed or rescheduled date, because it never reads a dated record.

Resolving "next session" from `Session Occurrences` instead is an
occurrence-level change, not a field-source swap:

1. **No `Session Occurrences` records exist in the test base yet** — none
   were seeded. Whether the live base generates them ahead of each
   session, and how far ahead, is unknown from here and needs answering
   before backend logic can rely on them existing.
2. It needs new backend logic: for each session a child is on, fetch its
   `Session Occurrences`, filter to `Date >= today` and a `Status` that is
   not Cancelled, and take the earliest — plus a decision on what happens
   when no such occurrence exists yet for a session (fall back to the
   recurring projection? show nothing?).
3. It is a frontend change too — `nextOccurrences()` would need replacing
   or bypassing, which is out of scope for this TEST-only backend repair
   and was asked not to be touched yet.

**Not built.** Reported per the instruction to stop rather than proceed
into occurrence-level work.

### Verified with real Parent Hub calls — parent-hub v4 (TEST)

- **parent.a** → 200. Archie's current session now reads: day **Monday**,
  time **17:00 – 18:00**, venue **Test Park**, with venue_info populated
  (postcode TE5 7ST, meeting point "Blue gate"). Previously all of these
  were blank.
- `available_sessions` (2 rows) both now carry real day/time/venue instead
  of blanks.
- The verified-link, paused-membership and ended-link-privacy fixes from
  the previous two repairs were re-checked in the same calls and still
  hold: Archie a child, Bella pending, Dylan paused, `parent.ended` sees
  nothing.

## Session Occurrences — hybrid option C, seeded and resolved — 2026-09-26

TEST only. Production Airtable and production Supabase untouched.

### Investigation recap (see prior report for detail)

Production `Session Occurrences` has **zero records** and no automation
generates them. The table's own field design (Status, Schedule Change
State, Replacement Occurrence — though that field didn't exist in TEST
until this repair, added below — Exception Reason, Confirmation State)
already supports everything the agreed behaviour needs; nothing was
missing except records.

### Schema addition (TEST only)

`Session Occurrences.Replacement Occurrence` (self-link, multipleRecordLinks
to Session Occurrences) — present in the live base's schema but had not
been copied into the TEST table when it was first built. Added now because
seeding a genuine reschedule needs it. Nothing else added.

### Seed dataset

**Session A (Monday Juniors, TEST-A)** — five occurrences, deliberately
carrying every exception type in one small set:

| Occurrence | Date | Status | Notes |
|---|---|---|---|
| A1 | Mon 28 Sep | **Cancelled** | Weather. Must never resolve as next. |
| A2 | Mon 5 Oct | **Postponed** | Schedule Change State Rescheduled, `Replacement Occurrence` → A3. Must never resolve as next *itself*. |
| A3 | **Wed 7 Oct** | Scheduled | The real makeup date. Deliberately off-pattern: different weekday, time (16:30–17:30 vs the recurring 17:00–18:00) and venue (Sample Sports Hall vs the recurring Test Park) — proves occurrence data overrides the recurring default. |
| A4 | Mon 12 Oct | Scheduled | Normal, on-pattern. |
| A5 | Mon 19 Oct | Scheduled | Normal, on-pattern. |

**Session B (Thursday Juniors, TEST-B)** — **zero occurrences**,
deliberately, so the no-occurrence fallback path has a real session to
resolve against rather than only a unit-test double.

Archie Atkinson was given a second Active membership on Session B
(alongside his existing Active membership on Session A), so **one real
`/parent-hub/me` call for `parent.a@test.invalid` exercises both paths at
once**: a real resolved occurrence for Session A, and the recurring-pattern
fallback for Session B.

### Backend change (TEST only) — `parent-hub`

Added to `handleParentMe`'s `activeSessions` mapping only (paused and
ended sessions are unaffected — "next session" isn't a meaningful concept
for either):

- `buildOccurrencesBySessionId` — indexes the newly-fetched `Session
  Occurrences` rows by their `Session` link.
- `resolveNextOccurrence(sessionId, …, todayIso)` — the resolution rules,
  in order: an occurrence with a `Replacement Occurrence` link is never a
  candidate itself, its target is considered instead (and a broken link
  degrades to "no candidate," not a throw); `Cancelled` is never a
  candidate; a `Postponed` occurrence with no replacement is not a
  candidate either (nothing confirmed to show); what remains is filtered
  to `Date >= today` and sorted, earliest wins. Deduplicated by record id,
  since a replacement target is normally *also* directly linked to the
  same Session.
- `nextOccurrencePayload` — builds `{ occurrence_record_id, date, day,
  time, venue, rescheduled }` from the winning occurrence's **own** date,
  start/end time and venue link (falling back to the Session's own venue
  only when the occurrence didn't set one) — this is what makes
  occurrence-level overrides win, simply by being read first.
- Each `active_sessions[]` entry now carries `next_occurrence: {...} |
  null`. `null` means no occurrence has been generated yet; the existing
  `day`/`time`/`venue` fields (already on the object, from the prior
  repair) remain the recurring pattern for the client to fall back to.
  Nothing was removed from the payload — this is additive.

**Frontend: not changed.** `next_occurrence` is present in the API
response but nothing in `parent.js` reads it yet — Parent Home still
shows the recurring pattern for every session, exactly as before this
repair. A future frontend change would read `next_occurrence` when
present and show it in place of the weekday projection; not done here
per the instruction to hold off unless required simply to expose the
field, and simply returning it in the JSON satisfies that.

### Verified with real Parent Hub calls — parent-hub v5 (TEST)

`parent.a@test.invalid`, one `/parent-hub/me` call, Archie's two active
sessions:

- **Session A** → `next_occurrence`: date **2026-10-07** (Wednesday — not
  the recurring Monday), time **16:30 – 17:30** (not the recurring
  17:00–18:00), venue **Sample Sports Hall** (not the recurring Test
  Park), `rescheduled: true`. The nearest date (28 Sep, Cancelled) and the
  reschedule origin (5 Oct, Postponed) were both correctly skipped.
- **Session B** → `next_occurrence: null`. Zero occurrence rows exist for
  it, and the response still carries its recurring pattern (`day:
  "Thursday"`, `time: "18:00 – 19:00"`, `venue: "Sample Sports Hall"`)
  unchanged from the prior repair.

Also re-checked in the same call: Bella still Pending, `parent.ended`
still sees nothing, Dylan still Paused — none of the earlier repairs
regressed.

### Left for a separate report, not built here

Per the instruction, the production occurrence **generator** — how
occurrences should be created automatically, how far ahead, how Selected
Dates / One-off sessions should behave, and how a reschedule/cancellation
should update them operationally — is a separate report, not built or
proposed in code here.

### Flagged, not touched: Coach Hub's Google Sheets "Changes" tab

`coach.js` computes the Coach-side "Today's Schedule" / cover / extra
sessions from a **second, parallel exception system**: a published
Google Sheets "Changes" tab (`changesCsvUrl`), read client-side and
merged with the same weekday-only projection Parent Hub used to use. It
is not connected to `Session Occurrences` / `Occurrence Staff` in any
way. This is legacy schedule logic that will eventually need migrating
to the Airtable occurrence model, per the same architecture decision that
moved Parent Hub off the Sessions CSV. Left untouched, as asked.

## Players.Active removed from the claim flow — 2026-09-26

TEST only. Production untouched.

### Where it was read (full inspection, before changing anything)

Two live reads in the claim flow, both in `parent-hub`:

1. `handleCreateClaim`'s `matches` filter — `p.fields["Active"] === true &&
   name-match && DOB-match`. Since `Players.Active` no longer exists as a
   field (only `LEGACY — Active` does, and Players has no canonical
   replacement - the earlier finding stands), this clause was always
   `undefined === true`, i.e. always false. **Every real claim in TEST
   was matching zero players and landing as "Needs Review", regardless of
   whether the name and date of birth were correct.**
2. `handleListClaims`' `activePlayers` list, built for management's
   manual-link picker when resolving an ambiguous claim - same filter,
   same always-false result. **The picker was always empty.**

No other `Players.Active` reads exist anywhere in `parent-hub`. (Five
other `fields["Active"]` reads remain in the file - Sessions via
`sessionIsActive`, Venues, Development Framework, Development Framework
Settings, Feedback - all genuine, non-retired fields on those tables,
correctly left alone.)

### Confirmed replacement rule

Player Active/Inactive is derived, never stored: **a Player counts as
active while at least one of their Player Session Links has a
`Membership Lifecycle Status` other than `Ended`** - Active, Paused,
Cancellation Pending and Ending Scheduled all count, because all four
mean the player currently belongs somewhere (Paused is included here
deliberately, unlike the narrower `STILL_ATTENDING` set used for "next
session" - this is "does this player currently belong anywhere", not
"are they in today's session"). A Player with zero Player Session Links
at all - never yet placed on a session - reads as inactive by the same
rule.

That derived value is **informational only**. It is never used to
exclude a Player from matching or from the picker - an inactive Player
is not deleted or unavailable.

### What changed

- **`handleCreateClaim`**: the `Active` clause is removed from the match
  filter entirely. Matching is now name + Date of Birth alone, exactly as
  the Players table's own field description already specifies, with no
  gate on membership state at all - a player between memberships, or one
  never yet placed on a session, is still matchable.
- **`handleListClaims`**: now also fetches `Player Session Links`, derives
  `active: boolean` per player using the rule above, and lists **every**
  real Player (not a filtered subset) - each one now carries the derived
  flag as a hint for management, never as an exclusion. The frontend
  picker (`management.js`) only reads `player_record_id` and
  `player_name`, so this is additive and needed no frontend change.
- **Duplicate protection** (`alreadyClaimed` in `handleCreateClaim`) was
  never gated on `Active` and is untouched.
- **No new data exposed before verification**: `handleCreateClaim`'s
  response to the parent is still only `{ ok, status }` - no player
  fields are echoed back, unchanged. `handleListClaims` was already
  management-only (403 for any other role) and stays that way; the only
  addition there is one boolean per player, not new private fields.

### Verified with real Parent Hub calls — parent-hub v6 (TEST)

- **New claim for an existing, currently-active Player** (Dylan Davies,
  correct name + DOB, submitted via a fresh test parent account): now
  resolves to **`status: "Pending"` with exactly one match** - previously
  this landed as `Needs Review` with zero matches, every time.
- **New claim for an existing Player with no current membership**
  (synthetic player added with no Player Session Links at all, to prove
  bullet 3 for real): also resolves to **`status: "Pending"`, matched** -
  confirming an inactive/never-enrolled Player is not treated as
  unavailable.
- **Bella Brown** - still `Pending`, unaffected (her claim was already
  Pending from before this fix; re-checked, not re-created).
- **Archie Atkinson** - still connected as a verified child on both his
  sessions, unaffected.
- **`parent.ended@test.invalid`** - still sees nothing; the ended-link
  privacy fix is unaffected by this change.
- **Session logic** (current/paused/ended, and `next_occurrence`) -
  re-checked in the same calls, unaffected.
- **Duplicate protection** - resubmitting the same name+DOB for the same
  parent still returns "You've already submitted a claim for this
  child."

Tests: 45/45 files. New `claim-player-matching.test.ts` (10) covers a
real match with no Active field present, a zero-membership player still
matching, name normalization, DOB mismatch, every player appearing in the
picker regardless of derived status, and Paused vs Ended membership
deriving the flag correctly.

### Flagged, not touched

Nothing else in `parent-hub` reads a retired Player field. The frontend
claim picker doesn't yet show the new `active` hint (nothing asked for
it, and nothing broke by adding it unused) - available if management
ever wants "currently between sessions" shown in that dropdown.

### Full verification results — real calls against parent-hub v6 (TEST)

- **New claim, existing active Player** (Dylan Davies, via a fresh test
  parent) - matched, `status: "Pending"`. Previously: zero matches,
  always `Needs Review`, regardless of correct name/DOB.
- **New claim, existing Player with zero memberships** (Freya Foster, a
  genuine Player created with no Player Session Links at all) - also
  matched, `status: "Pending"` - confirms an inactive/never-enrolled
  Player is not treated as deleted or unavailable.
- **Duplicate protection** - re-submitting Bella Brown's claim as
  `parent.a`, whose claim for her was already Pending, correctly returned
  **400 "You've already submitted a claim for this child."**
- **Bella Brown** - still `Pending` (confirmed by the duplicate-rejection
  above finding her existing claim).
- **Archie Atkinson** - still a verified, connected child for `parent.a`.
- **`parent.ended@test.invalid`** - still sees `children: []`,
  `pending_claims: []`, and the ended child's name appears nowhere in the
  response. Privacy fix intact.
- **Session logic** - `parent.a`'s response still carries Dylan's paused
  session and Archie's resolved `next_occurrence`, unaffected by this
  change.
- **Management picker** - now lists all 5 real Players (previously would
  have listed 0), each with a correctly derived `active` flag: Archie,
  Bella, Charlie and Dylan `true` (each has at least one non-Ended
  membership - Dylan's is Paused, which still counts); Freya `false` (no
  memberships at all) - matching the confirmed rule exactly.

### Flagged, unrelated to this change - a pre-existing race in `resolveParentRecord`

While verifying, two near-simultaneous claim requests for a **brand-new**
parent (their very first-ever calls, fired concurrently as part of my own
test harness) each independently found "no existing Parent record for
this Supabase user" and created **two separate Parents & Guardians
records** for the same person, seconds apart. A claim submitted after
that point resolved against whichever of the two records the identity
lookup happened to return, so a "duplicate" looked, from that record's
side, like a first submission.

This is **not caused by, and not fixed by, this repair** -
`resolveParentRecord` is unrelated code I did not touch. It is a
find-or-create race: two concurrent first-ever requests for the same new
user can both miss each other's not-yet-queryable write. A real browser
submitting claims one at a time would not normally hit this window, and
re-running the same duplicate check sequentially against an established
parent (above) showed duplicate protection working correctly. Flagged as
a separate, pre-existing finding rather than fixed here - out of this
repair's scope.

## Repair: Parent Hub coach display now resolves from Session Staff

### Inspection findings (before any change)

- **Session Staff** (`tblkngM72cQNllOux`) is the canonical recurring
  staffing relationship: `Session` (link to Sessions), `Coach` (link to
  Coaches), `Role` (link to Coach Roles), `Active` (checkbox). Both TEST
  Sessions already had exactly one Active Session Staff row each:
  `SS-TEST-A1` (TEST-A -> Alex Test -> Lead Coach) and `SS-TEST-B1`
  (TEST-B -> Sam Sample -> Coach).
- **Coaches** carries the display name in `Coach Name`. Several retired
  fields sit alongside it (see "Flagged" below) but none of them held the
  coach's session assignment even before this repair - `Coach Name` was
  always the right field, `parent-hub` just never read Session Staff to
  reach it.
- **Coach Roles** (`tblGoag0ywrXqpClD`) holds `Role Name` (Lead Coach /
  Coach / Learning Coach) plus six permission checkboxes. None of those
  checkboxes are read anywhere in `parent-hub` today, including `Can View
  Player Names` - that flag governs what a Learning **Coach** may see
  about **players**, in the coach-facing screens, not what a **parent**
  may see about a coach's own name. It is a different flag for a
  different direction of visibility, not a parent-facing gate.
- **Conclusion: Learning Coach is shown to parents.** There is no
  product rule anywhere in the schema or the codebase that hides it -
  the only plausible candidate flag doesn't apply to this direction. All
  three roles display, ordered Lead Coach -> Coach -> Learning Coach.

### What changed

`supabase/functions-test/parent-hub/index.ts` - `handleParentMe` now
also fetches `Session Staff`, `Coaches` and `Coach Roles`, and both the
`activeSessions` and `pausedSessions` payload blocks call a new
`resolveSessionCoachNames()` instead of the sessionPayload default `[]`:

- Reads only `Active: true` Session Staff rows for the session.
- Dedupes by the **Coach record id**, never by name text - two
  different coaches who happen to share a name both still appear.
- Orders by role: Lead Coach, then Coach, then Learning Coach, then
  anything unrecognised.
- Drops unpresentable names (login/email-style) via the same
  `presentableName()` helper used everywhere else in this file.

`availableSessions` and `endedSessions` are unchanged (neither carries a
`coaches` field; out of scope). Occurrence-specific cover (Occurrence
Staff) was **not** wired into `next_occurrence` - resolving it needs a
new fetch, a new session-id/occurrence-id index, and a decision on how
`Assignment Type`/`Attendance` on Occurrence Staff should affect display,
none of which the current data model makes trivial. Kept separate, per
the task's own instruction.

### Tests

New `tests/support/session-coaches.test.ts` (11 cases, all passing):
real resolution from Session Staff for both TEST sessions' exact data,
role-priority ordering, Learning Coach inclusion, dedup by Coach id vs.
by name text (two different coaches sharing a name both appear),
Active:false rows excluded, zero-Session-Staff sessions return `[]`,
login/email/blank names dropped, a dangling Coach link degrades to `[]`
rather than throwing, an unrecognised Role still displays (last).

Full suite: **46/46 test files passed** (45 pre-existing + this one).

### Deploy

`parent-hub` v7 (TEST project `dkqubldmfyeuudecxmvh`), pinned to commit
`d69e102a6d38f4c0241d41788d17dcfd64d00512` on
`foundation/test-base-isolation`.

### Verification - real calls against parent-hub v7 (TEST)

- **Archie's sessions return the correct coach names**: TEST-A ->
  `["Alex Test"]` (his Lead Coach), TEST-B -> `["Sam Sample"]` (its
  Coach). Both match the live Session Staff rows exactly.
- **No duplicate coach names** in either list (nor anywhere else in the
  response).
- **Session role relationship stays intact**: Alex Test is Lead Coach on
  TEST-A only, Sam Sample is Coach on TEST-B only - matches the seeded
  staffing exactly, nothing crossed over.
- **Dylan's paused TEST-B session** also now carries `coaches: ["Sam
  Sample"]` - the pausedSessions block resolves the same way.
- **Bella/Archie/ended-link behaviour unchanged**: `pending_claims` still
  shows Bella Brown `Pending`; Archie's ended TEST-B entry (from an
  earlier membership) still carries no `coaches` key and its
  `end_date`/`scheduled_end_date` are untouched;
  `parent.ended@test.invalid` still returns `children: []`,
  `pending_claims: []` - no name or coach data leaks for an ended link.
- **Session lifecycle / next_occurrence logic still pass**: Archie's
  TEST-A `next_occurrence` still resolves to the rescheduled
  2026-10-07/Wednesday/16:30–17:30 occurrence exactly as before; TEST-B's
  `next_occurrence` is still `null` (no occurrence generated yet).
- **Full test suite**: 46/46 passing (above).

Production untouched throughout - no writes to `apprptFotQuVL1mhs` or
`bkkukymqaxawnudoxdjs`, no production Edge Function redeployed.

### Flagged, not touched - remaining retired coach/schedule fields

None of these are read anywhere in `parent-hub` (verified by inspection
while making this change) - listed here only because the task asked to
flag, not fix, anything else retired:

- `Coaches.LEGACY — Player Session Requests`, `LEGACY — Schedule
  Aliases`, `LEGACY — Sessions`, `LEGACY — Coach Role`, `LEGACY —
  Session Occurrences`, `LEGACY — Players`
- `Coach Roles.LEGACY — Coaches` (retired direct role link; Session
  Staff carries the role now)
- `Sessions.LEGACY — Source Coach Names`, `LEGACY — Permanent Coaches`
- `Session Occurrences.LEGACY — Source Assigned Coach Names`, `LEGACY —
  Assigned Coaches` (Occurrence Staff is canonical)
- `Players.LEGACY — Assigned Coaches` - already flagged in an earlier
  repair; still gated behind a Feature Control flag, still not read by
  this file.
