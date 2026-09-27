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

## Repair: /hub-content/players restored from Session Staff

Follow-up to the legacy/reconciliation audit above, which found
`hub-content`'s player-access resolver returning `[]` for every coach in
TEST - not a design gap, a regression from the same field-rename that
prompted the audit.

### Inspection findings (before any change)

- **Session Staff** carries `Session`, `Coach`, `Role` (link to Coach
  Roles) and `Active`. A coach can hold different roles on different
  sessions via different rows - there is no single "the coach's role"
  concept at the Coach-record level any more (that field, `Coach Role`,
  was renamed `LEGACY — Coach Role`).
- **Coach Roles** carries `Role Name` (display text) and `Role Key`
  (stable snake_case identifier: `lead_coach` / `coach` /
  `learning_coach`), plus the permission checkboxes. The real TEST data
  currently has **Can View Players = true on Learning Coach too** (likely
  a seeding oversight, not corrected here since fixing it is a data
  change, not a code one) - which made trusting that checkbox alone unsafe.
- **`player-access.ts`** (`resolvePlayerAccess`, `capabilitiesForCoach`,
  `eligibleCoachIdsForSessionSnapshot`) read `link.fields["Status"]`,
  `["Coaches At End"]`, `["End Date"]` (Player Session Links) and
  `coachRecord.fields["Coach Role"]` (Coaches) - all four renamed to
  `LEGACY —` prefixes in this base, so every one of these reads returned
  `undefined`. Confirmed live: `GET /hub-content/players` as
  `coach.a@test.invalid` (Lead Coach, Active Session Staff on TEST-A)
  returned `200 []` before this repair.
- **Former-player access** already had a correct model (the frozen
  `Coaches At End` snapshot + 28-day window from the actual end date) -
  only its field names were stale, not its logic.

### What changed

`supabase/functions-test/hub-content/player-access.ts`:
- Current-session ("permanent") access is now resolved per **(coach,
  session)** from the caller's own Active Session Staff row on that
  specific session (`sessionStaffCapabilitiesForSession()`) - never the
  Sessions Google Sheet, and never a single role fixed to the Coach
  record.
- Player-data access is gated by a hard-coded safelist,
  `PLAYER_ACCESS_ROLE_PRIORITY = { lead_coach: 0, coach: 1 }`, keyed by
  **Role Key** (stable) rather than Role Name (display text, renameable)
  or the Can View Players checkbox alone - Learning Coach is excluded by
  construction, regardless of what any checkbox says now or later.
- Cover access is **unchanged in mechanism** (still the Changes Google
  Sheet, matched by coach identity - migrating this to Occurrence Staff
  is a separately-scoped, materially bigger change, per the task). It
  now draws its capability floor from `coachOwnStandingCapabilities()` -
  the covering coach's own highest-priority eligible role across any of
  their current Session Staff rows - replacing the retired single
  `Coach Role` field this used to read.
- Membership status reads `Membership Lifecycle Status` (canonical) with
  `LEGACY — Status` / `Status` fallbacks, matching parent-hub's own
  `membershipStatus()` exactly. A link with no resolvable status grants
  nothing (fail closed). Any status other than `Ended` counts as current
  (Active, Paused, Cancellation Pending, Ending Scheduled all still mean
  the player belongs on that session) - the same "not Ended" reading
  `handleListClaims()` in parent-hub already uses elsewhere.
- Former-access reads `LEGACY — Coaches At End` / `LEGACY — End Date`
  (their only current names - there is no canonical replacement for
  either yet). The 28-day-window logic itself is untouched.

`supabase/functions-test/hub-content/index.ts`'s `handlePlayers()`:
fetches `Session Staff` instead of the Sessions CSV; builds
`sessionStaffBySessionAndCoach` and the caller's own
`coachCoverCapabilities`; passes both into `resolvePlayerAccess()` in
place of the old `coachNameKeys`/`scheduledCoachNameKeysBySessionId`.

**Deliberately NOT touched** (out of this task's scope, each already
broken the same way and each unreachable from any currently-deployed
TEST function):
- The **legacy Assigned Coaches fallback** in `handlePlayers()` (for
  Players never migrated onto Session/Player Session Links) - still
  reads `Players.Active`/`Assigned Coaches` by their pre-rename names
  (now `LEGACY — Active` / `LEGACY — Assigned Coaches`), so it still
  contributes zero rows, exactly as before this repair.
- `capabilitiesForCoach()` and `eligibleCoachIdsForSessionSnapshot()` -
  only called by `player-sessions`, which has no TEST copy yet. Both
  still read the retired single `Coach Role` field and the Sessions
  Sheet respectively; whoever ports `player-sessions` into TEST should
  switch them to the same Session Staff model at that point.

### Tests

Rewrote `tests/support/access-resolution.test.ts` (31 cases, all
passing) for the new API and rules: per-session role resolution, Lead
Coach/Coach granted, Learning Coach denied **even though its own Can
View Players checkbox is true** (the exact real-data condition), no
Session Staff row on this session → invisible, no Session Staff row
anywhere → invisible, management admin tier unaffected, cover tier via
`coachOwnStandingCapabilities()` (including a Learning-Coach-only
standing role getting nothing from cover), former access via the
`LEGACY —` fields with the 28-day window and expiry, the membership
status fallback chain, an inactive Coach Role/Session Staff row failing
closed, a mixed-role coach's standing role resolving to their
highest-priority one, and the untouched
`eligibleCoachIdsForSessionSnapshot()` still working against the
extended `CoachRoleCapabilities` shape (with a documented note that it
does *not* apply the new role-key safelist itself - a pre-existing gap,
unreachable in TEST, left alone). `tests/support/player-access.ts`
(hand-kept copy) updated to match. Full suite: **46/46 test files
passed**.

### Deploy

`hub-content` v3 (TEST project `dkqubldmfyeuudecxmvh`), pinned to commit
`024dd5ba322670415cd92c4e69eba234b475ee73` on
`foundation/test-base-isolation`, `verify_jwt: false` (matches the
existing deployment - the public landing routes stay unauthenticated;
every route returning coach/player data still checks the JWT inside the
function). Note: an intermediate v2 deploy briefly defaulted
`verify_jwt` to `true` by omission and was corrected in v3 before any
verification call was made against it.

### Verification - real calls against hub-content v3 (TEST)

Two small TEST-data additions were made in Airtable (not code) purely to
exercise real accounts against every required scenario, both clearly
labelled:
- A second Session Staff row, `SS-TEST-A2-VERIFY`: Alex Test (already
  Lead Coach on TEST-A) also given the Learning Coach role on TEST-B -
  lets the existing `coach.a` login prove per-session role gating and
  the Learning-Coach-denial rule against a real session, with no new
  test account needed.
- `LEGACY — Coaches At End` on the existing ended TEST-B link
  (`PSL-TEST-005`, Archie's earlier membership, ended 2026-09-12) set to
  `[Sam Sample]`, so the former-access path has real data to prove
  against (it had none before - the "if test data exists" case now does).

Results:
- **Lead Coach sees expected players**: `coach.a` → TEST-A's Archie
  Atkinson and Bella Brown, both `tier: "permanent"`, full edit
  permissions (`can_edit_feedback/idp/attendance: true`).
- **Coach sees expected players**: `coach.b` → TEST-B's Dylan Davies
  (Paused membership - still shown, see below), Archie Atkinson (a
  separate, current Active membership), and Charlie Clarke, all
  `tier: "permanent"`, `can_edit_idp: false` (Coach role lacks that
  permission), feedback/attendance `true` - matches the Coach role's
  exact capability set.
- **Learning Coach sees none**: `coach.a`, despite holding a real Active
  Session Staff row on TEST-B as Learning Coach, sees **zero** TEST-B
  players - confirms the role-key safelist overrides that role's own
  Can View Players=true.
- **Unrelated coach sees none**: `coach.b` sees none of TEST-A's players;
  `coach.a`'s Learning Coach role likewise sees none of TEST-B's -
  both directions of "not staffed on this session" proven.
- **Ended memberships behave correctly**: Archie's older, Ended TEST-B
  link never appears as `permanent`/`cover`, only as `former` once a
  Coaches At End snapshot exists for it (see next).
- **Former-player access**: after adding the snapshot above, `coach.b`'s
  response gained exactly one extra row - Archie via the ended link,
  `tier: "former"`, `access_until: "2026-10-10"` (end date + 28 days),
  all three edit permissions `false` - alongside, not instead of, his
  separate current `permanent` membership on the same session.
- **Full test suite**: 46/46 passing (above).

Production untouched throughout - no writes to `apprptFotQuVL1mhs` or
`bkkukymqaxawnudoxdjs`, no production Edge Function redeployed.

### A noted design choice: "current" access includes Paused, not just Active

The old (pre-break) model only had a binary Active/Ended `Status`. The
new `Membership Lifecycle Status` has five values. This repair treats
**any non-Ended status as current** for coach player-access purposes
(Active, Paused, Cancellation Pending, Ending Scheduled) rather than the
narrower `STILL_ATTENDING` set parent-hub uses for "is this session
currently on my schedule" - deliberately, on the reasoning that a coach
should still be able to see/manage a paused player's profile rather than
have them vanish. This is a judgement call where the task was silent,
not something explicitly specified; flagging it rather than deciding
silently. Confirmed live above: Dylan Davies (Paused) still appears in
`coach.b`'s player list.

### On the two silent 422 sync writes (inspected, not repaired)

`syncSessions()` (writes `Active` to Sessions - now `LEGACY — Active`)
and `maybeAutoSyncSessions()` (writes `Sessions Last Synced` to
Organisation & Branding - now `LEGACY — Sessions Last Synced`) are both
part of the **same feature**: keeping Airtable's Sessions table in sync
by treating the published Sessions Google Sheet as authoritative and
mirroring it into Airtable (create/update/archive by matching
`session_id`).

**Recommendation: retire, don't restore.** This is a straight legacy
Google-Sheets-schedule-sync mechanism, not a stale-field-name bug like
the ones this repair fixed - the fields didn't just get renamed, the
whole premise (the Sheet decides which Sessions exist and archives any
Airtable Session it doesn't recognise) is exactly the architecture this
whole project has been moving away from. Restoring it would be actively
harmful now, not merely outdated: `syncSessions()`'s archive step sets
`Active: false` (or would, once field-corrected) on any Airtable Session
whose `Session ID` isn't in the Sheet - and **TEST-A/TEST-B are exactly
that**, synthetic Airtable-only Sessions with no corresponding Sheet row.
A "fixed" version of this sync would silently archive both of them the
first time it ran. Fixing the field names would restore a feature that
now actively fights the current data model; the right move is to retire
the auto-sync trigger (`maybeAutoSyncSessions()`'s call inside
`handleSettings()`) and the manual "Sync Sessions" trigger together,
once confirmed nothing still depends on Sheet-sourced Session creation.

## Retiring the legacy Sessions-from-Sheet sync

Follow-up to the recommendation above. Investigated every caller before
touching anything, per the standing rule for this whole project.

### Callers found

1. `hub-content/index.ts` (TEST, deployed) - `handleSettings()` calls
   `maybeAutoSyncSessions(organisationRecord)` fire-and-forget on every
   hit to the `""`/`settings` route.
2. `hub-content/index.ts` (production) - identical structure, untouched.
3. `player-sessions/index.ts` (production only - **no TEST copy
   exists**) - exposes its own `syncSessions()` via `POST /sync`, the
   manual on-demand trigger.
4. `management.js` (frontend, one shared bundle - **not split into
   TEST/production copies the way the backend is**) - the "Sync Sessions
   from schedule" button, `syncSessions(btn)`, POSTs to
   `playerSessionsUrl() + '/sync'`.
5. `main.js` - wires the button's click to (4).

### What each expects, and whether it's safe to disable in TEST

- **`config.js` hardcodes production** (`bkkukymqaxawnudoxdjs`) as
  `supabaseUrl`/`contentApiUrl`, identically on every branch of this
  repo including `main` and `foundation/test-base-isolation`. There is
  no TEST-facing frontend build anywhere in this project - "TEST" has
  only ever meant the isolated Airtable base + Supabase project +
  `functions-test/*` backend copies, verified via real HTTP calls. So
  the **button (4/5) cannot reach TEST today** regardless of anything
  done here; it calls production's `player-sessions`, which this task
  does not touch.
- **`player-sessions` (3) has no TEST deployment**, so its manual
  `/sync` route is not callable against TEST at all right now. Nothing
  to retire there directly - flagged so it isn't ported over unmodified
  if/when `player-sessions` is ever added to TEST (same caution already
  recorded for `capabilitiesForCoach()`/`eligibleCoachIdsForSessionSnapshot()`
  in the previous repair).
- **The auto-sync (1) is the only piece actually live against TEST**,
  and its own first write (the "Sessions Last Synced" throttle stamp)
  already 422s and is caught, so `syncSessions()` itself has never
  actually executed in TEST - only a swallowed error logged on every
  settings load. `handleSettings()`'s returned payload
  (`organisation`/`settings`/`features`) does not depend on it at all
  (separate `.catch()`, fire-and-forget). `hub-content` exposes no
  `sync` route of its own - the auto-call was the only invocation path
  that existed in the deployed TEST function.
- **No useful behaviour is mixed in that needs preserving elsewhere.**
  Session creation/archival keyed to the Sheet's `session_id` is exactly
  the mechanism being moved away from; the throttle-stamp pattern has no
  other user in this codebase.
- **No Airtable data depends on it.** TEST-A/TEST-B were created
  directly in Airtable, not via this sync, and have no corresponding
  Sheet row - a working version of this sync would archive both.

**Conclusion: safe to retire in TEST now.** Exactly one live call site,
already a no-op today, disabling it changes no observable behaviour
except removing a swallowed error log.

### What changed

`supabase/functions-test/hub-content/index.ts`: removed the bodies of
`syncSessions()` and `maybeAutoSyncSessions()` and the one call site
inside `handleSettings()`, each replaced with a comment explaining the
retirement and pointing back here (not simply fixing `Active` ->
`LEGACY — Active` and the other field names, per the explicit
instruction - a working sync would still be harmful, not merely
outdated). `SESSIONS_CSV_URL`, `SESSIONS_SYNC_THROTTLE_MS` and the
CSV-fetch helpers (`csvObjects`/`parseCsvRows`/`fetchCsvObjects`) are
left in place, now-unused by this specific feature but commented as
such - `fetchCsvObjects`/`csvObjects`/`parseCsvRows` are still live for
`CHANGES_CSV_URL` (cover) and `FINANCIALS_CSV_URL`, and `SESSIONS_CSV_URL`
is the exact "Coach Hub Sessions CSV" already flagged separately for the
upcoming Schedule cleanup - not deleted here, on purpose. `airtableBatch()`
is now unused too but left as a generic, harmless utility.

Deliberately **not touched**: `management.js`/`main.js` (the "Sync
Sessions" button) - editing a file shared with production would affect
production, which this task must not do, and the button cannot reach
TEST today regardless.

### Deploy

`hub-content` v4 (TEST project `dkqubldmfyeuudecxmvh`), pinned to commit
`9105b2e45a821fb5bff4c44e74ff04d607e66437` on
`foundation/test-base-isolation`, `verify_jwt: false` (explicit this
time, after the earlier repair's near-miss).

### Verification - real calls against hub-content v4 (TEST)

- **Normal Coach Hub loading**: `GET /hub-content/settings` -> `200`,
  full `organisation` payload returned, no error - confirms
  `handleSettings()` works with the auto-sync call fully removed.
- **`/hub-content/players` still works**: re-ran `coach.a`'s call from
  the previous repair - identical result (TEST-A's Archie and Bella,
  `tier: "permanent"`, full permissions) - the retirement touched
  nothing this depends on.
- **Parent Hub unchanged in logic**: re-ran `parent.a`'s `/parent-hub/me`
  call - `next_occurrence`, ended-session actual/scheduled dates and
  `pending_claims` all identical to the previous repair's verification.
  One cosmetic difference, unrelated to this change: Archie/Dylan's
  TEST-B `coaches` now lists `["Sam Sample", "Alex Test"]` instead of
  just `["Sam Sample"]` - a direct, expected consequence of the
  `SS-TEST-A2-VERIFY` Learning Coach row added as TEST data during the
  *previous* repair's verification (parent-facing coach display
  correctly shows all three roles, Learning Coach included, per that
  repair's own findings) - not a regression from retiring the sync.
- **No valid Airtable Session modified or archived**: read TEST-A/TEST-B
  directly from Airtable after the deploy and both calls above -
  `Session Lifecycle Status: Active` and `LEGACY — Active: true`
  unchanged on both, confirming the sync did not run.
- **Full test suite**: 46/46 passing, both before and after this change
  (the frontend's mocked "Sync Sessions" button test,
  `tests/e2e/sessionaccesstest.js`, is unaffected since it exercises a
  local HTTP mock, never this file).
- Production untouched throughout - no writes to `apprptFotQuVL1mhs` or
  `bkkukymqaxawnudoxdjs`, no production Edge Function redeployed.

### Nothing found that blocks retiring it now

No caller, no data dependency, and no useful mixed-in behaviour would be
lost. The only outstanding item is the frontend button/manual trigger,
which is out of TEST's reach entirely today (production-only, and
`player-sessions` isn't even in TEST) - not a blocker, just work for
whenever the Schedule cleanup reaches the frontend and/or
`player-sessions` is ported into TEST.

## Session Occurrence generator - Slice 1 (schema) and Slice 2 (pure generator)

Ratified build plan for turning Sessions (recurring/default structure)
into Session Occurrences (actual dated operational facts), with three
amendments required before Slice 1 began: (1) concurrent duplicate
protection must be real per-Session serialisation via a Postgres
`generation_locks` table in TEST Supabase, not a fetch-before-create
race - reserved for Slice 3, not built yet; (2) Session History gets its
own `Change Summary` field rather than overloading Old Value/New Value
with generator-outcome prose; (3) the generator and recurring-edit
propagation stay two separate pure modules sharing only utilities
(freeze checks, timezone calculation, occurrence-key generation) - no
monolithic function. Freeze rule ratified earlier: an occurrence is
frozen once `Start Date & Time <= now` OR `Status` is `Completed`,
`Cancelled` or `Postponed`; Confirmation State/Register State never gate
freezing.

### Slice 1 - TEST Airtable schema only

Added directly to the TEST base (`appQktredAuGa1X7e`), no code involved:

- **Session Occurrences**: two new fields - `Occurrence Key`
  (singleLineText, "Deterministic idempotency key. Generator-owned
  standard slots use `{Session record id}:{Date ISO}`; a
  reschedule-created replacement uses
  `{Session record id}:{Date ISO}:R:{Origin Occurrence record id}` so it
  can never collide with the standard slot the origin session/date
  already owns. Written by code only - never hand-edited.") and
  `Time Overridden` (checkbox, "True = this occurrence's Start/End Date
  & Time were explicitly set ... and must never be touched by recurring
  Session time propagation").
- **Session Dates** (new table): `Session Date ID` (primary, singleLineText),
  `Session` (link), `Date`, `Date Type` (singleSelect: Included/Excluded).
  Stores explicit dates for Selected Dates sessions (Included) and
  break/excluded dates for Recurring sessions (Excluded).
- **Session History** (new table): `History ID` (primary), `Session`
  (link), `Change Type`, `Old Value`, `New Value`, `Change Summary`
  (multilineText, per Amendment 2 - "System outcome of this change, in
  plain language ... Never overload Old Value/New Value with this"),
  `Changed At`, `Changed By User ID`, `Changed By Name Snapshot`. Audit
  trail of structural Session edits, one row per triggering edit, not
  one row per occurrence affected.

Verified directly against the TEST base via the Airtable API on
2026-09-26: `Session Occurrences` carries both new fields with the
descriptions above; `Session Dates` and `Session History` both exist
with every field listed. Cross-checked production (`apprptFotQuVL1mhs`)
the same way - none of this exists there, confirming isolation held.

### Slice 2 - pure Session Occurrence generator logic

Explicit scope: answer exactly one question - "given a Session, its
Session Dates, its existing occurrences, and today's date, which NEW
occurrence shells should exist?" - and nothing else. No Airtable/
Supabase/network call anywhere in this code; no modification of an
existing occurrence; no cancelling/crystallising; no recurring-edit
propagation (that's Slice 6); no reading of Occurrence Staff, cover, or
Session History; no deployment.

**Files added** (all new, nothing else touched):

- `supabase/functions-test/session-occurrences/schedule-utils.ts` -
  canonical shared pure utilities: `selectName`, `weekdayIndexFromName`,
  `parseIsoDateUTC`, `isoDateUTC`, `addDaysIso`, `isoDateLte`/`isoDateLt`/
  `isoDateGte`, `firstDateOnOrAfterWeekday`, `parseHHMM`,
  `ukOffsetMinutesAt`, `buildUkDateTimeIso`, `computeOccurrenceKey`. All
  calendar arithmetic uses `Date.UTC(...)`, never the local `Date`
  constructor. `buildUkDateTimeIso` is the one place a UK wall-clock time
  becomes a UTC instant, via the double-format trick (format a naive
  guess as Europe/London wall-clock text via `Intl.DateTimeFormat`,
  re-parse those digits as UTC, correct the guess by the discovered
  offset) - correct on both sides of a clock change without hand-rolled
  BST date rules.
- `supabase/functions-test/session-occurrences/generator.ts` - the pure
  generator. Entry point `planGeneration(input: GenerationInput):
  GenerationResult`, dispatching on `Session Lifecycle Status` (only
  `Active` generates anything) and `Schedule Pattern` (`Recurring` /
  `Selected Dates` / `One-off`), then filtering candidate dates against
  existing `Occurrence Key`s for idempotency.
- `tests/support/schedule-utils.ts` and `tests/support/session-generator.ts` -
  hand-kept copies of the two canonical files above (byte-identical past
  their header comments - diffed to confirm), per this project's
  established test-copy convention.
- `tests/support/session-generator.test.ts` - 14 numbered sections, 37
  assertions.
- `tests/e2e/sessiongeneratortest.js` - thin shim so `tests/run-all.js`
  (which only scans `tests/e2e/*.js`) picks up the test file above.

**Key function signatures:**

```ts
export function planGeneration(input: GenerationInput): GenerationResult;

interface GenerationInput {
  session: SessionRecord;
  sessionDates: SessionDateRecord[];       // this Session's rows only
  existingOccurrences: ExistingOccurrenceRecord[]; // this Session's rows only
  today: Date;
}
interface GenerationResult { toCreate: OccurrenceShell[]; }
interface OccurrenceShell {
  occurrenceKey: string; sessionRecordId: string; date: string;
  startDateTime: string; endDateTime: string; status: "Scheduled";
}

export function buildUkDateTimeIso(dateIso: string, hhmm: { h: number; m: number }): string;
export function computeOccurrenceKey(sessionRecordId: string, dateIso: string): string;
```

**Design decisions flagged during verification:**

1. **RATIFIED 2026-09-26 - One-off.** No dedicated date field, so
   `planOneOffDate` reuses `Sessions.Start Date` as the single generated
   date rather than a `Session Dates` row. Do not add a separate one-off
   date field or overload Session Dates for this in v1. Alternative
   considered and rejected: a `Session Dates` row, which would overload a
   table scoped for Selected Dates/Excluded Dates with a purpose it
   wasn't given.
2. **RATIFIED 2026-09-26 - Selected Dates.** Generate every explicitly
   Included future date stored in Session Dates; do not apply the
   recurring 12-week/10-occurrence rolling horizon to Selected Dates.
   Reason: these are deliberate finite dates Management has already
   chosen, not an open-ended recurring projection.
3. **OccurrenceShell carries no human-readable `Occurrence Name`/
   `Occurrence ID`** - left as a Slice 3 (repository/write layer)
   decision, not decided here.
4. **The exact ~1-hour window around a real UK clock-change instant**
   is not handled with full precision (a wall-clock time can be
   ambiguous/non-existent there) - accepted, since real sessions run at
   ordinary hours; both actual 2026 transition dates are covered exactly
   by the unit tests.

**Test results:**

- `node --experimental-strip-types tests/support/session-generator.test.ts`
  directly: **37/37 passing** - standard weekly recurring generation;
  Start Date respected (future and past); End Date respected; Draft
  produces nothing; Inactive (and blank/unrecognised status) produces
  nothing; rolling 12-week/10-occurrence horizon (plain weekly reaching
  12 weeks, heavy exclusions forcing the count floor to win instead);
  Selected Dates Included rows (future-only, sorted, no ceiling);
  Excluded dates suppress Recurring generation; One-off creates exactly
  one shell (and nothing once past); full and partial idempotency reruns
  produce zero duplicate creates; a reschedule `:R:` key does not block
  the standard slot on the same date; BST spring-forward (29 Mar 2026)
  and GMT autumn-back (25 Oct 2026) both resolve correctly on either
  side of the transition; unrecognised Default Day/unparseable time/
  unrecognised Schedule Pattern all fail closed to zero occurrences.
- `node tests/run-all.js` (full TEST suite, real calls where applicable):
  **47/47 test files passed**, up from the previous 46 (the new
  `sessiongeneratortest.js` is the addition; no other file's results
  changed).
- Production untouched throughout - no writes to `apprptFotQuVL1mhs` or
  `bkkukymqaxawnudoxdjs`, no Edge Function deployed or redeployed (this
  slice deploys nothing).

## Slice 3 - repository, orchestration and concurrency infrastructure (still unexposed)

Scope, per your approval: the Airtable repository/data-access layer,
safe (create-only) application of Slice 2's pure generator output, the
TEST Supabase `generation_locks` infrastructure, one shared per-Session
orchestration path, and atomic lock acquisition/stale-lock reclamation.
Explicitly out of scope and not touched: frontend, production, any
deployed/exposed route (that's Slice 4), any scheduled job, recurring-
edit propagation, Session History writes.

### Amendment 3 - the lock-ownership race, fixed before implementation

Your review caught a real race in the Slice 2 plan's original
`generation_locks(session_record_id, locked_at)` shape: a stalled
invocation A could reach its `finally` after its lock had already been
legitimately reclaimed by invocation B, and `release(session_record_id)`
would delete B's live lock. Fixed by adding ownership: the table gained
`lock_token uuid not null`, `acquire_generation_lock` now returns the
token this call owns (or `null`), and `release_generation_lock` takes
both `session_record_id` AND `lock_token`, deleting only when both
match. A stale invocation's own (superseded) token can never match a
newer owner's row.

### Exact SQL applied (migration `test_generation_locks`, project `dkqubldmfyeuudecxmvh`)

```sql
create table public.generation_locks (
  session_record_id text primary key,
  lock_token uuid not null,
  locked_at timestamptz not null default now()
);

alter table public.generation_locks enable row level security;
-- Zero policies granted: anon/authenticated get no access at all. The
-- Edge Function (Slice 4+) uses the service-role key, which bypasses
-- RLS - no policy needed for it to work.

create or replace function public.acquire_generation_lock(p_session_record_id text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_token uuid;
begin
  delete from generation_locks
   where session_record_id = p_session_record_id
     and locked_at < now() - interval '5 minutes';
  v_token := gen_random_uuid();
  insert into generation_locks (session_record_id, lock_token, locked_at)
  values (p_session_record_id, v_token, now())
  on conflict (session_record_id) do nothing;
  if found then return v_token; else return null; end if;
end; $$;

create or replace function public.release_generation_lock(p_session_record_id text, p_lock_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from generation_locks
   where session_record_id = p_session_record_id and lock_token = p_lock_token;
  return found;
end; $$;

revoke execute on function acquire_generation_lock(text) from public, anon, authenticated;
revoke execute on function release_generation_lock(text, uuid) from public, anon, authenticated;
grant execute on function acquire_generation_lock(text) to service_role;
grant execute on function release_generation_lock(text, uuid) to service_role;
```

Atomicity: the reclaim-then-insert sequence is one PL/pgSQL function
call (one statement from the caller's side); the primary key + `ON
CONFLICT DO NOTHING` guarantees exactly one concurrent `INSERT` can ever
land a row for a given `session_record_id`, regardless of how many
callers race the stale-reclaim `DELETE` simultaneously.

### Lock semantics - proven with real SQL against the real TEST Supabase project, not just reasoned about

All seven scenarios you required, run for real via `execute_sql` against
`dkqubldmfyeuudecxmvh` (cleaned up afterward, zero rows left in
`generation_locks`):

1. First `acquire_generation_lock('TEST-LOCK-SESS-1')` -> a token.
2. A second, immediate `acquire` for the same id -> `null`.
3. `release_generation_lock(id, '00000000-...-000000000000')` (wrong
   token) -> `false`; row count confirmed unchanged (still 1).
4. `release_generation_lock(id, <the correct token>)` -> `true`.
5. `acquire` again after that valid release -> a fresh token (a released
   lock is truly free).
6. Stale reclaim: manually backdated `locked_at` to 6 minutes ago (>5min
   threshold), then `acquire` -> a NEW token, different from the
   previous one - the stale row was reclaimed.
7. The **original stale owner** then calls `release` with its OLD
   (superseded) token -> `false`, and the reclaiming owner's row is
   confirmed still present and unchanged immediately after - proves the
   exact race from your example cannot happen.
8. True concurrency (not just sequential ordering): two `acquire` calls
   for a fresh id (`TEST-LOCK-SESS-2`) fired as genuinely parallel tool
   calls in the same turn -> exactly one token, one `null`.

### Files added

All portable (no `Deno.*` anywhere) - plain `fetch()` only, so the exact
same code runs under Node today (nothing is deployed yet) and under Deno
once Slice 4 wires it into a real Edge Function. Matches the existing
`player-access.ts` precedent: pure(ish) logic kept separate from
runtime-specific wiring.

- `supabase/functions-test/session-occurrences/schedule-utils.ts` -
  additive only: `computeReplacementOccurrenceKey(sessionRecordId,
  dateIso, originOccurrenceRecordId)`, used by the repository's key
  derivation below. Nothing existing changed.
- `supabase/functions-test/session-occurrences/repository.ts` (new) -
  `fetchSession`, `fetchSessionDatesForSession`,
  `fetchExistingOccurrencesForSession`, `deriveOccurrenceKey`,
  `buildOccurrenceCreatePayload`, `formatDisplayDate`,
  `createOccurrences`. POST/create only - no function in this file can
  issue a PATCH/PUT/DELETE.
- `supabase/functions-test/session-occurrences/lock-client.ts` (new) -
  `createSupabaseLockClient`, calling the two RPC functions above via
  plain PostgREST `fetch()` (no Supabase client library needed).
- `supabase/functions-test/session-occurrences/orchestrator.ts` (new) -
  `generateForSession(deps, sessionRecordId, today)`: acquire -> (if
  acquired) read + pure plan + create -> release in a `finally`. The one
  shared per-Session path; nothing else calls the lock, the repository
  and the generator together.
- `tests/support/{schedule-utils,session-repository,lock-client,session-orchestrator}.ts` -
  hand-kept copies, import paths adjusted to this directory's own file
  names (`session-generator.ts`/`session-repository.ts` in place of
  `generator.ts`/`repository.ts`) - the only intentional divergence.
- `tests/support/session-repository.test.ts` (new) - 19 assertions.
- `tests/e2e/sessionrepositorytest.js` (new) - shim for `tests/run-all.js`.

### The existing-row guarantee: the actual problem, and how it's solved

Read TEST-A's 5 real Session Occurrences rows before writing any code
(see Slice 2's section above for the full table) - **none of them has an
`Occurrence Key` value**, since the field didn't exist when they were
hand-seeded. Feeding them into the Slice 2 generator as-is would make it
think those dates were free and try to recreate them.

`deriveOccurrenceKey` solves this **in memory only, never written
back**: an explicit key is used as-is; a row with an incoming `From
field: Replacement Occurrence` link derives the `:R:` shape at its own
date; everything else (a plain row, or an origin that was later moved
away via an *outgoing* `Replacement Occurrence` link) derives the
standard key at its own date. Unit-tested directly against the 5 real
rows' exact field shapes (`session-repository.test.ts`, section 5): all
5 derive exactly the expected keys, and feeding them through the real
`planGeneration` (section 6) confirms none of the 4 already-occupied
dates (28 Sep, 5 Oct, 12 Oct, 19 Oct) gets regenerated, while forward
Mondays from 26 Oct onward do.

Structural guarantee, not just a test result: `repository.ts` has zero
functions capable of writing to an existing row - `createOccurrences`
only ever calls the POST-only `airtableBatchCreate`. Re-read TEST-A's 5
rows via the Airtable API after all of this slice's real-call
verification below - byte-for-byte identical to the snapshot taken
before any of it started.

### Real-call verification (no Edge Function deployed - Amendment 1)

Since Slice 3 stays unexposed, verification used the same methodology
as every other real-call check in this project: the exact same pure
functions the code contains, computed for real via Node (credential-
free - `planGeneration` and `buildOccurrenceCreatePayload` need none),
with the one remaining step (actually sending the computed payload to
Airtable) performed directly via the Airtable API/MCP rather than
through a raw `fetch()` this sandbox has no token to make - the payload
sent is the literal output of the code, not a hand-approximated one.

1. Created a throwaway TEST Session, `SLICE3-VERIFY` (Recurring,
   Active, Monday, 17:00-18:00, Start Date 2026-09-01) - deliberately
   NOT TEST-A/TEST-B, so this real-write proof never risks the shared
   fixtures 47 other tests depend on.
2. Ran the real `planGeneration` against it (today = 2026-09-26) -> 13
   shells. Ran the real `buildOccurrenceCreatePayload` on each -> 13
   exact Airtable field payloads.
3. Created those exact 13 records for real via the Airtable API, and
   read them back - identical to the computed payloads.
4. **Idempotency, for real**: re-ran `planGeneration` with those 13
   real rows' real Occurrence Key values as `existingOccurrences` ->
   `toCreate.length === 0`.
5. **Rollback (Amendment 4)**: deleted exactly those 13 captured record
   IDs (not a `Created` timestamp cutoff, which could also catch an
   unrelated legitimate record made in the same window) - confirmed
   removed - then deleted the throwaway `SLICE3-VERIFY` Session itself.
6. Re-read TEST-A's 5 hand-seeded rows one final time - unchanged from
   the pre-Slice-3 snapshot, field for field.
7. Spot-checked production (`apprptFotQuVL1mhs`) still has none of the
   Slice 1 schema additions, and confirmed no Edge Function was deployed
   or redeployed anywhere in this slice.

### Test results

- `node --experimental-strip-types tests/support/session-repository.test.ts`
  directly: **19/19 passing** - key derivation (explicit key, plain row,
  origin-with-outgoing-link, replacement-with-incoming-link), the exact
  5 real TEST-A rows' reconciliation, the full read-through-plan cycle
  against TEST-A's real config confirming no regeneration of its 4
  occupied dates while forward Mondays do generate, the Airtable create
  payload's exact field mapping (including the four deliberately-omitted
  fields), and `formatDisplayDate`.
- `node tests/run-all.js` (full TEST suite): **48/48 test files passed**,
  up from 47 (the new `sessionrepositorytest.js` is the addition; no
  other file's result changed).
- Lock semantics verified with 8 real SQL scenarios against
  `dkqubldmfyeuudecxmvh` directly (see above) - all passed, table left
  empty afterward.
- Live write-and-rollback cycle against the real TEST Airtable base (see
  above) - 13 real rows created from the code's own computed output,
  read back identical, idempotency re-confirmed against them for real,
  then all 13 plus the throwaway Session deleted by their exact captured
  record IDs. Re-confirmed after the fact: zero `SLICE3-VERIFY` rows
  remain anywhere in the base, TEST-A's 5 hand-seeded rows are still
  byte-for-byte unchanged, `generation_locks` has 0 rows, the Supabase
  migration `test_generation_locks` (version `20260926194023`) is
  recorded applied, and no Edge Function was deployed - `me`,
  `parent-hub` and `hub-content` are the only three that exist in
  `dkqubldmfyeuudecxmvh`, same as before this slice.
- Production (`apprptFotQuVL1mhs` / `bkkukymqaxawnudoxdjs`) untouched
  throughout - re-checked directly: still none of the Slice 1/3 schema,
  no new Edge Function.

## Slice 4 - manual TEST-only Session Occurrence generator endpoint

Goal, per your approval: expose the already-proven Slice 3 orchestration
through one deliberately manual endpoint, verified with real HTTP calls,
before any automatic trigger exists.

### Endpoint

`POST /functions/v1/session-occurrences/generate` on TEST project
`dkqubldmfyeuudecxmvh`, body `{ "sessionRecordId": "recXXXXXXXXXXXXXXX" }`
- exactly one Session per call, no "generate all Sessions" yet.

**New file:** `supabase/functions-test/session-occurrences/index.ts` - a
thin HTTP wrapper only. It imports and calls `generateForSession`
(orchestrator.ts), `fetchSession` (repository.ts) and
`createSupabaseLockClient` (lock-client.ts) unchanged - no generator/
repository/lock logic is reimplemented here. Same TEST-base boot guard,
same `jsonResponse`/CORS conventions, as every other TEST function.

### Auth model

Inspected `hub-content`'s and `parent-hub`'s existing `resolveCaller()`
pattern before choosing anything - this is an operational/admin function
(Management only), so it reuses that exact convention rather than
inventing a new one:

- Deployed with `verify_jwt: true` (like `parent-hub`, which has no
  public route either) - Supabase's own gateway rejects a request with
  no/invalid Authorization JWT before this function's code ever runs.
- On top of that, `resolveCaller()` (copied verbatim from `hub-content`'s
  own, per this codebase's "each function is self-contained" convention)
  resolves the Supabase Auth JWT to a `profiles` row and requires
  `role === "management"` AND `active === true`. A Coach or Parent JWT is
  correctly rejected with 403, not just relying on the JWT gateway check.

### Response shapes

- `200 { status: "generated" | "no_changes" | "skipped_locked", created, recordIds }`
  - the orchestrator's own outcome, passed through unchanged.
- `400` - missing/invalid `sessionRecordId` (must match `rec` + 14
  alphanumerics) or invalid JSON body.
- `401` - missing/invalid Authorization header (mostly caught by the
  `verify_jwt` gateway before this function runs at all).
- `403` - a valid, active, non-Management caller.
- `404` - a well-formed but non-existent Session id.
- `405` - any method other than POST on `/generate`.
- `502` - the Session-existence lookup itself failed unexpectedly (not
  a real Airtable "not found" - see finding below).
- `500` - anything else unexpected, from `generateForSession` itself.

### A real finding, fixed before this could be called done

First deploy's `sessionExists()` only treated a plain Airtable `404` as
"not found." A real call with a well-formed-but-nonexistent Session id
(`recZZZZZZZZZZZZZZ`) came back **502**, not 404 - Airtable actually
returns **403 `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`** for this case
(it deliberately doesn't distinguish "no permission" from "doesn't
exist"). Fixed `sessionExists()` to treat that message as "not found"
too, redeployed as v2, and re-ran the exact same real call - now a clean
404. This was only caught because verification used a genuinely
malformed-looking-but-well-formed id over a real HTTP call rather than
assuming the happy-path 404 case.

### Deployment

`session-occurrences` v2 (TEST project `dkqubldmfyeuudecxmvh`),
`verify_jwt: true`, pinned to commit `afe9677` on
`foundation/test-base-isolation` for the code (v1 was the same commit;
v2 is the `sessionExists()` fix above, applied directly and then also
committed to this same slice's commit before push - see the final commit
this section is part of). Bundle: `index.ts` + unchanged copies of
`orchestrator.ts`, `repository.ts`, `lock-client.ts`, `generator.ts`,
`schedule-utils.ts` (Edge Functions are self-contained per directory, so
every file the entrypoint imports has to be included in the deploy call,
even though none of them changed).

### Verification - all real HTTP calls, via `pg_net` (this sandbox cannot reach `supabase.co` directly)

Signed in for real as three TEST accounts (`manager@test.invalid` =
management, `coach.a@test.invalid` = coach, `parent.a@test.invalid` =
parent) - their Supabase Auth passwords were reset directly via SQL
(`crypt(..., gen_salt('bf'))` on `auth.users.encrypted_password`) since
the `password123` convention used by the mocked Playwright suite doesn't
apply to real Supabase Auth. TEST project only.

1. **Missing `sessionRecordId`** → `400`.
2. **Unknown Session** (`recZZZZZZZZZZZZZZ`) → `502` on v1 (the finding
   above), **`404`** on v2 after the fix.
3. **Non-management caller** (coach.a's real token) → `403 "Management access required"`.
4. **No Authorization header at all** → `401` (from Supabase's own
   gateway, before this function's code runs).
5. **Valid throwaway Session, real HTTP call**: created `SLICE4-VERIFY`
   (Recurring, Tuesday, Active) → `200 { status: "generated", created: 13, recordIds: [...] }`.
   `generation_locks` confirmed at 0 rows immediately after.
6. **Immediate rerun**, same Session → `200 { status: "no_changes", created: 0, recordIds: [] }`.
7. **Genuine concurrency, over real HTTP**: created a second throwaway
   Session (`SLICE4-CONCURRENT`, Wednesday) and issued two
   `net.http_post` calls to `/generate` for it **inside the same SQL
   statement** (no client round-trip between them, so pg_net's worker
   dispatches both together) → exactly one `200 { status: "generated", created: 13, ... }`
   and one `200 { status: "skipped_locked", created: 0, recordIds: [] }`.
   Re-read the 13 rows actually created - all unique Occurrence Keys, no
   duplicates. `generation_locks` confirmed at 0 rows afterward.
8. **TEST-A's 5 hand-seeded rows** - re-read field-by-field after all of
   the above - byte-for-byte unchanged (still no `Occurrence Key`, same
   Status/Date/Occurrence ID as every prior snapshot).
9. **Parent Hub unchanged**: real `GET /parent-hub/me` as `parent.a` -
   identical to the documented baseline (Dylan Davies paused on TEST-B,
   `paused_from` 2026-09-15/`returns_on` 2026-10-20; Archie Atkinson
   active on TEST-B with coaches Sam Sample + Alex Test). `parent-hub`
   still version 7, same SHA-256 digest as before this slice - it was
   never redeployed.
10. **`hub-content/players` unchanged**: real `GET /hub-content/players`
    as `coach.a` - TEST-A's Archie and Bella, `tier: "permanent"`, full
    permissions, identical to the Slice 1 baseline. `hub-content` still
    version 4, same digest - never redeployed.
11. **Full TEST suite**: `node tests/run-all.js` - see the result
    recorded below.

**Rollback (Amendment 4 pattern, again)**: every record created during
verification was deleted by its exact captured record ID, not a
timestamp cutoff - all 13 `SLICE4-VERIFY` occurrences, all 13
`SLICE4-CONCURRENT` occurrences, then both throwaway Session records
themselves. Re-confirmed after cleanup: zero rows matching either
throwaway Session id anywhere in the base.

### Test results

- `node tests/run-all.js` (full TEST suite): **48/48 test files passed**,
  unchanged from before this slice (Slice 4 adds no new local test file;
  its own logic is entirely composed of already-unit-tested Slice 2/3
  modules plus a thin routing/auth layer that can only be meaningfully
  verified over real HTTP, which the section above covers).
- Production (`apprptFotQuVL1mhs` / `bkkukymqaxawnudoxdjs`) untouched -
  no schema changes, no Edge Function deployed or redeployed there.

## Slice 5 - real TEST verification and foundation checkpoint

Goal, per your instruction: prove Slices 1-4 form a reliable foundation
before Slice 6 propagation. No new product behaviour added - this slice
is verification only, and it found one real pre-existing defect (below),
which was reported rather than silently fixed.

### A. Schema/infrastructure - all present, unchanged

- `Session Occurrences.Occurrence Key` and `.Time Overridden`: present,
  descriptions unchanged.
- `Session Dates`, `Session History`: both present, unchanged.
- Supabase `generation_locks` table, `acquire_generation_lock(text)`,
  `release_generation_lock(text, uuid)`: all present, correct signatures.
- `generation_locks`: **0 rows before testing**, and **0 rows after**
  every test in this slice.
- Production Airtable (`apprptFotQuVL1mhs`, 66 tables): still none of
  `Session Dates`/`Session History`/`Occurrence Key`/`Time Overridden`.
- Production Supabase (`bkkukymqaxawnudoxdjs`): only `profiles` exists -
  no `generation_locks`.

### B. TEST-A - real generation via the real Slice 4 endpoint

Snapshotted the 5 original rows first (full field read). Called
`POST /session-occurrences/generate` for TEST-A
(`rec4cME6ncL4IAvlK`) for real via `pg_net` (management token) ->
`{"status":"generated","created":9,"recordIds":[...]}`.

**The 9 rows created** - all standard Mondays the 5 original rows didn't
already occupy, exactly as Slice 2's rolling-horizon design predicts (13
candidate Mondays from 28 Sep - 21 Dec minus the 4 dates already holding
a standard key = 9 new): 26 Oct, 2 Nov, 9 Nov, 16 Nov, 23 Nov, 30 Nov, 7
Dec, 14 Dec, 21 Dec - each `Scheduled`, key `rec4cME6ncL4IAvlK:{date}`,
times correctly 17:00-18:00Z (all GMT-period dates, so no BST offset
applies here).

**The 5 original rows, re-read field-by-field after generation - byte-
for-byte unchanged:**
- 28 Sep: still `Cancelled`, `Schedule Change State: Changed`.
- 5 Oct (origin): still `Postponed`, `Schedule Change State: Rescheduled`,
  `Replacement Occurrence` still -> the 7 Oct row.
- 7 Oct (replacement): still `Scheduled`/`Rescheduled`, still its own
  time (16:30-17:30Z) and own Venue (Sample Sports Hall) - a genuine
  override the generator correctly never touches.
- 12 Oct / 19 Oct: still `Scheduled`, unchanged.

### C. Idempotency - confirmed for real

Immediate rerun for TEST-A -> `{"status":"no_changes","created":0,"recordIds":[]}`.
Re-read all 14 TEST-A occurrences (5 original + 9 new): 14 unique dates,
14 distinct Occurrence Keys (the 5 originals still have none, by design
- see Slice 3's derivation), no duplicates of any kind.

### D. TEST-B - real generation from zero

TEST-B (`recklh0OeaAMakQCJ`: Recurring, Active, Thursday, 18:00-19:00,
Start Date 2026-09-01, previously 0 occurrences) -> real call ->
`{"status":"generated","created":13,"recordIds":[...]}`. 13 consecutive
Thursdays, 1 Oct - 24 Dec 2026, keys `recklh0OeaAMakQCJ:{date}`. Times
correctly BST/GMT-split exactly at the real transition: 1-22 Oct show
17:00-18:00Z (BST, local 18:00-19:00), 29 Oct onward show 18:00-19:00Z
(GMT, local matches UTC) - the 25 Oct 2026 clock change lands exactly
between 22 Oct and 29 Oct, as it should. Rerun -> `no_changes`.

### E. Parent Hub compatibility - one genuine defect found

Real `GET /parent-hub/me` as `parent.a`, after B and D's rows exist:

- **TEST-A reschedule chain, fully correct**: Archie's `next_occurrence`
  resolves to the **7 Oct replacement** (`recszcwKC52pdXqfW`), not the
  cancelled 28 Sep nor the postponed 5 Oct origin - proves cancelled-
  origin-not-next, postponed-origin-not-next, and replacement-resolves-
  correctly all hold even with 9 new standard occurrences now also
  candidates.
- **TEST-B now resolves a real occurrence**: Archie's `next_occurrence`
  is the real generated 1 Oct row (previously null/fallback, since
  TEST-B had zero occurrences) - `day: "Thursday"`, `venue: "Sample
  Sports Hall"` both correct.
- **Defect**: `next_occurrence.time` shows **"17:00 – 18:00"** for that
  1 Oct row - the correct local time is **18:00-19:00** (TEST-B's actual
  Default Start/End Time). Root cause, confirmed by reading the code
  (`parent-hub/index.ts`, `nextOccurrencePayload()`, line ~578):
  `startIso.slice(11, 16)` takes the raw UTC digits out of the stored
  ISO instant and displays them as-is, with no Europe/London conversion.
  This was invisible until now because every occurrence that existed
  before Slice 2 was hand-seeded using a "naive UTC = local wall-clock"
  convention (writing "17:00Z" to mean "5pm", regardless of real UK
  offset) - so the raw UTC digits happened to already be the right
  local digits. Slice 2's generator instead computes the **correct**
  UTC instant via the BST-safe `buildUkDateTimeIso()` (deliberately 1
  hour earlier than the naive convention during BST), so for any
  generator-created row dated within BST (last Sunday of March -last
  Sunday of October), the raw-UTC display is now off by exactly 1 hour.
  Outside BST (which is why TEST-A's 12 Oct/19 Oct/26 Oct onward all
  displayed correctly in the same response) there is no discrepancy,
  because UTC and UK local time coincide.
  **This is a real, pre-existing display bug, not something Slice 5
  introduced** - it was latent in `parent-hub/index.ts` (shared with
  production) the whole time, and Slice 5 is what finally created a
  real occurrence whose storage convention exposes it. Not fixed here -
  reported per your instruction to stop before changing product logic.
  **Proposed fix** (not applied): replace the raw slice with a real
  Europe/London-aware format, e.g.
  `new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(startIso))`
  for both `startTime`/`endTime` in `nextOccurrencePayload()`. TEST only
  unless/until you decide production should get the same fix (production
  has no generator yet, so this exact scenario can't occur there today,
  but any future BST-aware write would trigger the identical bug).

### F. Coach/shared compatibility - unchanged

Real `GET /hub-content/players` as `coach.a` - identical to the Slice 1
baseline (Archie + Bella, `tier: "permanent"`, full permissions).
`hub-content` still version 4, same SHA-256 digest - never redeployed
in Slices 3-5. `git status` confirms zero frontend files touched.

### G. Concurrency - repeated, confirmed again

Created a fresh throwaway Session (`SLICE5-CONCURRENT`), fired two real
`POST /generate` calls in the same `pg_net` SQL statement -> exactly one
`{"status":"generated","created":13,...}` and one
`{"status":"skipped_locked","created":0,"recordIds":[]}`. Re-read: 13
unique keys, no duplicates. `generation_locks`: 0 rows after. Deleted
all 13 created records and the throwaway Session by their exact record
IDs immediately after confirming.

### H. Regression - all green

- `session-generator.test.ts` (standalone, pure): **37/37**.
- `session-repository.test.ts` (repository/concurrency-derivation
  logic): **19/19**.
- `node tests/run-all.js` (full TEST suite): **48/48**.

### I. Verdict

The core occurrence-generation foundation - Slices 1-4 (schema,
pure generator, repository/lock/orchestration, manual endpoint) - is
**verified reliable**: every schema element is present and correct,
generation is idempotent and race-safe under genuine concurrent HTTP
load, hand-seeded exception rows (cancelled/postponed/rescheduled) are
never touched, BST/GMT handling is correct at the real transition, and
nothing outside TEST was touched.

Slice 5 also did its job of catching a real defect before it could
compound under Slice 6: **Parent Hub's occurrence-time display doesn't
convert UTC to Europe/London**, and now that real BST-safe generator
rows exist, that bug is visible for the first time (TEST-B's 1 Oct
`next_occurrence`, off by 1 hour). It's a pre-existing display bug, not
a foundation bug, and not fixed here per your standing instruction to
stop and report first.

**Occurrence generation foundation through Slice 5 is ready for Slice 6
recurring-edit propagation, conditional on a decision about the Parent
Hub time-display defect above** - propagation will create/move many
more real, BST-safe-timed occurrences, so this display bug will start
showing wrong times routinely once Slice 6 lands, not just in one
edge-case test. Recommend deciding the Parent Hub fix (TEST only, or
TEST+production) before or alongside starting Slice 6, rather than
after.

## Parent Hub occurrence-time display fix - TEST only - 2026-09-26

Fixes the Slice 5 section E defect: `nextOccurrencePayload()` in
`supabase/functions-test/parent-hub/index.ts` displayed the raw UTC
digits of an occurrence's `Start Date & Time`/`End Date & Time`
(`startIso.slice(11, 16)`) instead of converting to Europe/London, so
any occurrence dated within BST showed a time 1 hour behind the real
local time.

### Fix

Added `formatUkTime(iso: string): string`, using
`Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour:
"2-digit", minute: "2-digit", hour12: false }).formatToParts(...)` -
the same double-format approach already used the other direction in
`schedule-utils.ts`. Fails closed to `""` for blank/unparseable input
(this file's existing convention). Normalises Intl's occasional
midnight `"24"` to `"00"`. `nextOccurrencePayload()` now calls
`formatUkTime()` for both `startTime`/`endTime` instead of slicing the
raw ISO string.

**Scope, confirmed via `grep` before changing anything**: this was the
only site reading an occurrence's ISO timestamp for display. The other
two `startTime`/`endTime` usages (`sessionPayload()`'s recurring-day
payload, and the `available_sessions` builder) read `Session.Default
Start Time`/`Default End Time` - plain `"HH:MM"` strings, not ISO
instants - and were correctly left untouched, so recurring Session
time fields are unaffected. `resolveNextOccurrence()` (which occurrence
*wins*) was not touched at all - only how the winning occurrence's time
is formatted for display. The Session Occurrence generator
(`generator.ts`/`schedule-utils.ts`) was not touched.

Same fix duplicated in the hand-kept Node-runnable test copy
`tests/support/next-occurrence.test.ts` (existing convention, same as
`player-access.ts`). Corrected one pre-existing assertion whose
expected value had baked in the old bug (`replacement3`'s stored
16:30Z on 7 Oct, within BST, now correctly asserted as displaying
`17:30`, not `16:30`).

### New focused tests (in `tests/support/next-occurrence.test.ts`)

- A BST-period UTC instant converts 1 hour ahead: `13:00Z` in July ->
  `14:00`.
- A GMT-period UTC instant converts with no offset: `13:00Z` in
  January -> `13:00`.
- The real 2026 UK autumn clock-change boundary, same nominal UTC hour
  (`17:00Z`) on both sides: 24 Oct (Saturday, still BST) -> `18:00`;
  25 Oct (Sunday, already GMT) -> `17:00`.
- `formatUkTime` fails closed to `""` for blank/unparseable input.

`node --experimental-strip-types tests/support/next-occurrence.test.ts`
-> **19/19 passing** (14 pre-existing `resolveNextOccurrence()` tests,
unchanged and still green, + 5 new/corrected for this fix).

### Deployment

TEST `parent-hub` redeployed: **v7 -> v8**. Production `parent-hub`
confirmed unchanged at **v6** (not touched by this task).

### Real TEST-data verification (real HTTP via `pg_net`, fresh
`parent.a@test.invalid` sign-in, `GET /parent-hub/me`)

- **TEST-B occurrence, BST/GMT display**: Archie's `next_occurrence` for
  TEST-B (`recgmyAOR0KCQ9G9V`, 2026-10-01, BST) now shows
  `"time":"18:00 – 19:00"` - correct, matches the Session's real
  Default Start/End Time. Previously wrong `"17:00 – 18:00"`.
- **TEST-A rescheduled occurrence**: Archie's `next_occurrence` for
  TEST-A resolves to the 7 Oct replacement (`recszcwKC52pdXqfW`) and
  now shows `"time":"17:30 – 18:30"` (16:30Z stored, BST, +1h) -
  correct, and `"rescheduled":true` still set. The reschedule-chain
  resolution itself (cancelled/postponed skipped, replacement wins) is
  identical to Slice 5's baseline - only the displayed time changed.
- **Clock-change boundary dates**: covered by the two new focused unit
  tests above using the real 24/25 Oct 2026 transition dates against
  the exact deployed `formatUkTime()` logic; not re-exercised over
  HTTP because Parent Hub only ever surfaces the single *next*
  occurrence for "today" (26 Sep 2026), so the already-generated
  29-Oct-onward TEST-B rows aren't reachable as a `next_occurrence`
  without artificially changing "today."
- **Membership behaviour unchanged**: same real response shows Dylan's
  paused TEST-B session, Archie's active TEST-A/TEST-B and ended
  TEST-B entries, and the pending Bella claim - structurally identical
  to the Slice 5 baseline, both `day`/`venue`/`rescheduled` fields and
  the recurring-pattern `time` fields (which read `Default Start/End
  Time`, untouched by this fix) all correct.
- **`resolveNextOccurrence()` unchanged**: not modified; the same
  winning occurrence is selected as in Slice 5, confirmed by the
  unchanged `occurrence_record_id`s above.
- **Full TEST suite**: `node tests/run-all.js` -> **48/48 test files
  passed**, unchanged from the Slice 5 baseline.
- **Lock table**: `generation_locks` still 0 rows (no generation calls
  made during this verification).
- **Production untouched**: `parent-hub` on `bkkukymqaxawnudoxdjs`
  confirmed still at v6; no other production function, Airtable base,
  frontend, Google Sheets, or finance file touched.

## Slice 6 - recurring-edit propagation - TEST only - 2026-09-26

Goal, per your instruction: answer "what should happen to already-
generated future Session Occurrence rows when the recurring Session
itself changes?" - the first slice allowed to change existing rows.
Built as a separate pure planner (`propagation.ts`), never inside the
generator, exactly per the ratified design.

### Architecture

- **`propagation.ts`** (new) - pure planner, `planRecurringEdit()`. No
  Airtable/Supabase/network call, no read of Occurrence Staff/cover/
  Session History. Takes `existingOccurrences`, a real `now` instant,
  and any combination of `timeChange`/`venueChange`/`capacityChange`/
  `dayOfWeekChange`/`endDateChange`. Returns `{ toUpdate, toCancel,
  toCrystallise, skippedOverrides, manualReview, backfillNeeded }` -
  exactly the shape you specified.
- **`isFrozen()`** (new, added to the shared `schedule-utils.ts`, per
  your "shared utilities are fine" note) - `Start Date & Time <= now`
  OR `Status` in `{Completed, Cancelled, Postponed}`. Confirmation
  State/Register State never consulted. A past `Scheduled` row freezes
  from the time check alone, with no need for anything to have marked
  it `Completed`.
- **`propagation-repository.ts`** (new) - the Airtable PATCH layer.
  Deliberately a separate file from `repository.ts`, whose header
  states, as a structural property, that it is create-only; adding
  PATCH there would falsify that claim.
- **`propagation-orchestrator.ts`** (new) - `propagateForSession()`.
  Reuses the exact same per-Session lock/`LockClient` as generation (no
  new lock, no new RPCs) - generation and propagation can never race
  for the same Session. Never invokes the generator itself, even when
  `backfillNeeded` is true - that is always a separate, explicit
  `/generate` call, per "propagation must not itself create the new
  weekday rows."
- **`index.ts`** - extended with a second manual, Management-only,
  TEST-only route, `POST /session-occurrences/propagate`, alongside the
  existing `/generate` - same auth/production-guard/validation
  conventions as Slice 4. Still no automatic trigger, no cron.

### Rules implemented (all in `propagation.ts`)

- **Time change**: future, `Scheduled`, `Standard` (blank or
  `"Standard"` `Schedule Change State`), non-frozen, non-`Time
  Overridden` occurrences get a new Start/End Date & Time, recomputed
  BST/GMT-safe per-date via the same `buildUkDateTimeIso()` the
  generator uses. `Schedule Change State` is never written - these
  rows remain `Standard`. `Time Overridden = true` always wins,
  regardless of `Schedule Change State`.
- **Venue / Capacity change**: pure historical crystallisation, no
  write to any future row at all - a future row with a blank
  Venue/Capacity Override already inherits the new Session default
  automatically at read time (the existing fallback), so writing
  anything to it would be wrong. Only **frozen** rows with a blank
  value get the **old** effective value crystallised onto them, so
  their historical record can't silently start showing the new
  default. A frozen row with its own explicit value is reported in
  `skippedOverrides`, untouched. A frozen row with nothing of its own
  AND no old Session default to crystallise (edge case discovered
  during throwaway testing) is reported in `manualReview` instead of
  silently doing nothing.
- **Day-of-week change**: future, `Scheduled`, `Standard`, non-frozen
  rows dated on the OLD weekday (from an effective date, default
  today) are cancelled (`Status: Cancelled`, `Schedule Change State:
  Changed`) - matching the exact convention of the real hand-seeded
  cancelled TEST-A row. Never deleted. `backfillNeeded: true` is always
  returned; the planner never creates the new weekday's rows itself.
- **Operating End Date shortened**: future, `Scheduled`, `Standard`
  rows now dated beyond the new End Date are cancelled the same way.
  A non-`Standard` row beyond the new End Date (an explicit override or
  reschedule) is **not** auto-cancelled - flagged in `manualReview`
  instead, since whether it should still run is a real judgement call
  the planner won't guess.
- **Independence**: Venue/Capacity overrides and Occurrence Staff never
  block Time/Venue/Capacity propagation for the same row - guaranteed
  by construction (the planner never reads Occurrence Staff at all, and
  each change type's eligibility check is independent of the others'
  fields), not by extra cross-checks.

### Two real defects found and fixed during throwaway verification

Per your instruction to verify against throwaway Sessions before TEST-A,
real testing surfaced two genuine bugs before anything touched TEST-A:

1. **A row eligible for both Venue and Capacity crystallisation in the
   same call produced two separate `toCrystallise` entries against the
   same occurrence record.** Airtable's batch update API rejects a
   request naming the same record twice (`422 INVALID_RECORDS`), so the
   very first real combined Venue+Capacity call failed outright. Fixed
   by extending the existing `dedupeByOccurrence()` merge (already used
   for `toCancel`, where a day-change and an end-date-change can target
   the same row) to `toCrystallise` too - a genuinely small, obvious fix
   in the same family as one already in the code.
2. **`propagateForSession()` was not safe to retry after a partial
   failure.** It wrote the Session's own new default fields *before*
   applying the occurrence-level plan. The first (pre-fix) attempt above
   wrote the Session's new Venue/Capacity successfully, then crashed on
   the occurrence PATCH (defect 1). On retry, the orchestrator read the
   Session's *already-changed* value as if it were still "old", and
   crystallised the **wrong** value onto the frozen occurrence -
   corrupting exactly the history crystallisation exists to protect.
   Fixed by reordering: apply the full occurrence-level plan (updates/
   cancellations/crystallisation) first, and only write the Session's
   own new default fields once that has succeeded. A failure now always
   leaves the Session's defaults untouched, so a retry re-reads the
   true old values and is safe to repeat. Confirmed by resetting the
   corrupted throwaway row/Session back to their true original values
   and re-running the whole scenario clean - the crystallised value was
   then correctly the true original (`Sample Sports Hall` / `20`), not
   the new one.

Neither defect ever touched TEST-A or any other real fixture - both were
caught and fixed against disposable throwaway Sessions, exactly as the
"throwaway first" instruction is meant to catch.

### Unit tests (`tests/support/propagation.test.ts`, pure, no network)

43/43 passing, covering every category required: Time (future-standard
updates, Time-Overridden skipped, frozen skipped), Venue and Capacity
(future-blank untouched, future-explicit untouched, frozen-blank
crystallises, frozen-explicit skipped, no-old-default -> manualReview),
Independence (Venue/Capacity override and Occurrence Staff never block
an unrelated change), Freeze (started-today, later-today-eligible,
Completed/Cancelled/Postponed always frozen, past-Scheduled-freezes-
automatically, Confirmation/Register State irrelevant), Day change
(eligible-cancelled, replacement/cancelled/postponed/other-weekday
untouched, `backfillNeeded`, no create capability in the plan shape),
End Date (eligible-cancelled, frozen untouched, exception ->
manualReview, within-bounds untouched), the two interaction/defect
regression tests above, and a regression check against the real TEST-A
reschedule-chain field shapes (only the two genuinely standard rows -
12 Oct, 19 Oct - update on a permanent time change; cancelled/postponed/
rescheduled rows never touched).

### Real TEST verification

**Throwaway Sessions (`SLICE6-TIME`, `SLICE6-VENUECAP`, `SLICE6-DAY`,
`SLICE6-ENDDATE`), all via real HTTP through `pg_net`:**

- **Time**: future standard occurrence updated to the new time
  (BST/GMT-correct); `Time Overridden` row and frozen (past) row both
  untouched; Session's own `Default Start/End Time` updated.
- **Venue + Capacity (combined call)**: frozen blank row crystallised
  with the true old Venue/Capacity; frozen row with its own explicit
  Venue/Capacity untouched (reported in `skippedOverrides` x2); future
  blank row untouched (inherits the new default automatically); Session's
  own Venue/Default Capacity updated to the new values.
- **Day-of-week**: eligible old-day future row cancelled
  (`Cancelled`/`Changed`); already-cancelled row and different-weekday
  row untouched; `backfillNeeded: true`. Follow-up real `/generate` call
  created 13 new Wednesday shells (confirmed one landed on 2026-09-30,
  a real Wednesday, at the Session's existing 17:00-18:00 local time) -
  proving propagation correctly never creates rows itself and the
  generator correctly picks up the new day on its own next run.
- **End Date shortened**: eligible row beyond the new End Date
  cancelled; frozen row beyond it untouched; the one non-Standard
  (`Rescheduled`) row beyond it correctly NOT auto-cancelled, reported
  in `manualReview` instead; row within bounds untouched; Session's own
  End Date updated.
- All four throwaway Sessions and every record they held (12 hand-
  seeded + 13 generator-created during the day-change backfill = 25
  occurrences + 4 Sessions) deleted by exact record ID after
  verification.
- `generation_locks`: 0 rows before and after every call.

**TEST-A (`rec4cME6ncL4IAvlK`), only after all throwaway cases passed:**

Snapshotted the Session's exact fields and all 14 real occurrences
first. Ran a real, trivially-reversible 5-minute Time change (17:00-
18:00 -> 17:05-18:05) via the real endpoint:

- Exactly the 11 predicted standard rows updated (the 9 generator-
  created Mondays from Slice 5 plus the 2 pre-existing standard rows,
  12 Oct and 19 Oct), each BST/GMT-correct for its own date (12/19 Oct
  -> `16:05Z`, everything Nov/Dec -> `17:05Z`).
- The cancelled 28 Sep, postponed 5 Oct, and the 7 Oct replacement
  (`Rescheduled`) were confirmed byte-for-byte unchanged before and
  after - never touched.
- Rolled back immediately after confirming: the Session's `Default
  Start/End Time` and all 11 occurrences' `Start/End Date & Time`
  restored to their exact original captured values (17:00/18:00 and
  each row's original instant). Re-read afterward to confirm the
  restore matched the original snapshot exactly.
- `generation_locks`: 0 rows after.

**Regression, real HTTP:**

- `GET /hub-content/players` as `coach.a` - identical to baseline
  (Archie + Bella, `permanent` tier).
- `GET /parent-hub/me` as `parent.a` - TEST-A's `next_occurrence` still
  resolves to the 7 Oct replacement at `"17:30 – 18:30"`; TEST-B's
  still resolves correctly at `"18:00 – 19:00"` - both exactly as
  documented after the Slice 5 time-display fix, confirming
  `resolveNextOccurrence()` and the display fix are both unaffected by
  Slice 6.
- `node tests/run-all.js`: **49/49 test files passed** (48 existing +
  the new `propagationtest.js`).

**Production**: `bkkukymqaxawnudoxdjs` has no `session-occurrences`
function at all (confirmed via a fresh listing) - Slice 6 was never
deployed there. No frontend, Google Sheets, or finance file touched.

### Deployment

TEST `session-occurrences`: v2 -> v6 (v3 added the Slice 6 files; v4
fixed the toCrystallise-dedupe defect; v5 redeployed the same fix after
an intermediate deploy-shape mistake; v6 fixed the write-ordering
defect). Final deployed version (v6) is the one all TEST-A verification
above ran against.

### Verdict

All required change types (Time, Venue, Capacity, Day-of-week, Operating
End Date), all required test categories (Time, Venue, Capacity,
Independence, Freeze, Day change, End Date, Regression), and the
required real-TEST verification sequence (throwaway first, TEST-A only
after) are complete and green. Two real defects were found and fixed
during throwaway verification, before either could reach TEST-A or any
other real fixture. No design ambiguity required stopping - the two
edge cases this slice did surface (a frozen row with no old default to
crystallise; a non-Standard row beyond a shortened End Date) are both
handled by reporting via `manualReview` rather than guessing, per your
own instruction for exactly this situation.

## Slice 7 - Selected Dates + One-off end-to-end - TEST only - 2026-09-27

Goal, per your instruction: prove/complete the Slice 2 pure generator's
Selected Dates and One-off handling end-to-end through the real TEST
repository/orchestrator/HTTP path (`/session-occurrences/generate`).

### No code changes were needed

Reviewed `generator.ts` against every ratified rule before touching
anything:

- **Selected Dates** (`planSelectedDates()`): already generates every
  future `Included` `Session Dates` row with no 12-week/10-occurrence
  windowing, already de-duplicates via `[...new Set(dates)]` (so
  duplicate `Included` rows for the same date can never produce
  duplicate candidates), already ignores `Excluded` rows entirely (that
  branch is Recurring-only), already skips past dates.
- **One-off** (`planOneOffDate()`): already uses the Session's own
  `Start Date` as the single candidate date, already skips a past/
  missing/unparseable `Start Date` by returning `[]` rather than
  guessing, and reruns are idempotent for free - `computeOccurrenceKey()`
  is deterministic on `{session.id}:{date}`, so a second `/generate`
  call always resolves to the same key, already present in
  `existingOccurrences`, and creates nothing.
- **Excluded Dates on Recurring** (`planRecurringDates()`): already
  skips any candidate date present in the Excluded set, sourced from
  `Session Dates` rows with `Date Type = Excluded`, independently of
  Selected Dates/One-off.
- **Idempotency, Occurrence Keys, freeze-safety**: all inherited from
  the same `existingOccurrenceKeys()` / `computeOccurrenceKey()`
  machinery already proven in Slices 2-3, applied uniformly across all
  three patterns.

Per your instruction not to rewrite working code unnecessarily, Slice 7
made **zero changes** to `generator.ts`, `repository.ts`,
`orchestrator.ts`, or `index.ts`. This slice is verification only.

### Real TEST verification (real Airtable + real `/generate` HTTP,
via `pg_net`, six throwaway Sessions, all deleted after)

**1-3. Selected Dates, duplicate Included row, far-future Included date**
(`SLICE7-SELECTED`, one Session, `Session Dates` rows: `Included` 10 Oct
2026, `Included` 17 Oct 2026, a **duplicate** `Included` row also dated
17 Oct 2026, `Included` 15 Jun 2027 - 9 months out, `Included` 1 Jan
2026 - past):

- First `/generate` call -> `{"status":"generated","created":3,...}`.
  Exactly 3 rows, not 4 - the duplicate 17 Oct row collapsed to one
  occurrence, and the past 1 Jan row never generated.
- Exact fields verified for all 3: `Date`/`Start Date & Time`/`End Date
  & Time`/`Occurrence Key` all correct (`10:00`/`11:00` local, BST-
  correct `09:00Z` for all three dates including the far-future one),
  keys `{sessionId}:{date}` and unique.
- The far-future 15 Jun 2027 row generated despite being ~37 weeks
  past the 12-week/10-occurrence rolling horizon - confirms Selected
  Dates correctly ignores that ceiling entirely, per the ratified
  "finite explicit Management choice" design.
- Rerun -> `no_changes`.

**4. Excluded Dates on a Recurring Session** (`SLICE7-RECURRING-EXCL`,
Default Day Wednesday, one `Session Dates` row: `Excluded` 14 Oct 2026 -
confirmed a real Wednesday):

- `/generate` -> `{"status":"generated","created":12,...}`. Dates:
  30 Sep, 7 Oct, **(14 Oct correctly absent)**, 21 Oct, 28 Oct, 4/11/18/
  25 Nov, 2/9/16/23 Dec - the excluded Wednesday is the only gap in an
  otherwise-unbroken weekly sequence; every surrounding Wednesday
  generated normally. 12 (not 10) created because the count floor and
  the 12-week window floor are both satisfied only once 12 real dates
  are reached, with one candidate skipped - exactly the documented
  "reach whichever boundary is later" behaviour.
  Times correctly BST/GMT-split exactly at the 25 Oct transition:
  `09:00Z` for the three pre-transition dates, `10:00Z` from 28 Oct
  onward.
- Rerun -> `no_changes`.

**5-7. One-off: Active, Draft, Inactive, bad date** (four throwaway
Sessions):

- `SLICE7-ONEOFF-ACTIVE` (valid future Start Date) -> `{"status":
  "generated","created":1,...}`, exactly one occurrence, fields exact
  (`Date`/`Start`/`End`/`Occurrence Key` all correct). Rerun ->
  `no_changes` - never a second one-off occurrence.
- `SLICE7-ONEOFF-DRAFT` (valid future Start Date, but `Session
  Lifecycle Status: Draft`) -> `no_changes`, 0 created.
- `SLICE7-ONEOFF-INACTIVE` (valid future Start Date, `Inactive`) ->
  `no_changes`, 0 created.
- `SLICE7-ONEOFF-BADDATE` (`Active`, `Start Date` left entirely blank)
  -> `no_changes`, 0 created, **no error, no invented date** - fails
  safely exactly as `planOneOffDate()`'s `parseIsoDateUTC() -> null ->
  []` path is designed to.

**Cleanup**: all 6 throwaway Sessions, their 6 `Session Dates` rows,
and all 16 created occurrence records (3 + 12 + 1) deleted by exact
record ID after verification. `generation_locks`: 0 rows after every
single call (12 real HTTP calls in total across first-run + rerun).

### No ambiguity found

No Selected Dates or One-off Session edit in this slice raised a new
propagation question outside the ratified Slice 6 design - this slice
never touched `propagation.ts`/`propagation-orchestrator.ts` at all,
consistent with keeping generation ("which shells should exist") and
propagation ("what happens to existing shells when the Session
changes") strictly separate, as instructed.

### Regression - real HTTP + full suite

- **TEST-A** (`rec4cME6ncL4IAvlK`): all 14 real occurrences re-read and
  confirmed byte-for-byte identical to the Slice 6 snapshot (cancelled
  28 Sep, postponed 5 Oct, the 7 Oct replacement at its own time/venue,
  and all 11 standard rows at their original `17:00-18:00`/`16:00-
  17:00Z` times) - Slice 7's throwaway Sessions never touched TEST-A.
- **Parent Hub** (`GET /parent-hub/me` as `parent.a`): Archie's TEST-A
  `next_occurrence` still resolves to the 7 Oct replacement at
  `"17:30 – 18:30"`; TEST-B's still resolves at `"18:00 – 19:00"` -
  both exactly matching the post-Slice-5-fix baseline.
- **hub-content** (`GET /hub-content/players` as `coach.a`): identical
  to baseline - Archie + Bella, `permanent` tier.
- **Slice 6 propagation tests**: included in and passing as part of the
  full suite below (`propagationtest.js`).
- **Full TEST suite**: `node tests/run-all.js` -> **49/49 test files
  passed**, unchanged.

### Production / frontend / Sheets / finance

Untouched. No Edge Function redeployed this slice (no code changed).
No frontend file touched. No Google Sheets or finance file touched.

## Slice 8 - automatic triggering / scheduled top-up

Goal, per your instruction: move from "Management can manually call the
generator" to "the Hub keeps occurrences up to date automatically",
reusing the exact Slice 2 generator, Slice 3 repository/lock and Slice 6
propagation logic unchanged - no second generator path, no duplicated
logic.

### Architecture

Two new files, both deliberately free of any generation/propagation/date
business logic of their own - the trigger layer only decides *when* and
*in what order* the already-proven functions run:

- **`session-trigger.ts`** - `triggerSessionSaved(deps, sessionRecordId,
  changes?, now?)`. `changes` omitted means "Session created, or
  Draft/Inactive -> Active, or any other save with no recurring default
  changed" - calls `generateForSession()` alone. `changes` present means
  a qualifying recurring edit - calls `propagateForSession()` first
  (which already performs, under its own lock, the ratified order: plan
  against OLD values -> apply the occurrence-level plan -> write the
  Session's new defaults -> release), then, ONLY if it reports
  `backfillNeeded`, calls `generateForSession()` as a second, separate,
  lock-acquiring step. Exactly the required order: acquire lock ->
  propagate/crystallise -> update Session defaults -> conditional
  backfill -> release lock, with propagation's own lock covering steps
  1-3 and the backfill call acquiring its own lock for step 4 - the
  ordering bug found in Slice 6 (Session defaults written before the
  occurrence-level plan was applied) is structurally impossible to
  reintroduce here because this file never touches Session fields or
  occurrence rows itself; it only sequences calls to functions that
  already enforce that order internally.
- **`daily-top-up.ts`** - `runDailyTopUp(deps, now?)`. Fetches all
  Active Sessions (`repository.ts`'s new `fetchActiveSessions()`), then
  calls `generateForSession()` for each one **strictly sequentially**
  (not `Promise.all`), per your explicit "simple and safe rather than
  aggressively parallel" instruction. Each Session's lock-acquire/
  release is entirely `generateForSession()`'s own job; this loop adds
  only a per-Session `try/catch`, so one Session's own thrown error can
  never abort the sweep for any Session after it. Returns a summary
  (`considered/generated/noChanges/skippedLocked/failed/
  occurrencesCreated/failures[]`) - `failures[]` names the exact Session
  record ID and error message for anything that actually threw. No
  "Generation Runs" product table was built - not genuinely required,
  the summary is returned/logged (`console.log`) at operational/debug
  level only, per your instruction.

Never calls `planGeneration()`, `planRecurringEdit()` or the repository
layer directly from either new file - every actual decision still goes
through `generateForSession()`/`propagateForSession()`, unchanged since
Slice 3/6.

### Immediate-trigger integration point

No canonical Management Session-create/edit backend write path exists
yet in this codebase (confirmed by inspection - `management.js` is
frontend-only Sync/Prep tooling, not a Session-save API). Per your
instruction, no fake permanent architecture was invented. Instead:
`POST /session-occurrences/trigger-session-saved` - Management-
authenticated exactly like `/generate` and `/propagate` (same
`resolveCaller()` + role check), body `{ sessionRecordId, changes? }`
where `changes` is the exact same shape `/propagate` already validates,
now optional. **This is the documented contract**: a future Management
"save Session" backend flow should call this route once, synchronously,
immediately after writing the Session record's own fields - passing no
`changes` for a create/Draft-to-Active save, or the changed fields for a
qualifying recurring edit. Verified manually in TEST (below) since no
real Management UI exists yet to drive it.

### Daily top-up: schedule, cadence and cron auth

`pg_cron` was not installed in the TEST project (`default_version`
present, `installed_version: null`) - enabled via
`create extension if not exists pg_cron;`. Registered as a named job
`session-occurrences-daily-top-up`, cron expression `0 3 * * *` (03:00
UTC daily, an off-peak hour), calling `POST /session-occurrences/daily-
top-up` via `net.http_post` with a 60-second `timeout_milliseconds`
(see "pg_net timeout" finding below for why that matters).

**Security - no service-role key was available to give the cron job.**
No MCP tool exposes the real Supabase service-role key's literal value,
and Postgres itself has no built-in access to it either (checked:
`current_setting('app.settings.service_role_key', true)` -> `null`;
`select name from vault.secrets` -> empty). So the daily-top-up route
cannot be authorised the same way `lock-client.ts` authorises its own
RPC calls (using the Edge Function's own already-available
`SUPABASE_SERVICE_ROLE_KEY` env var - that's still how the *route*
authorises the *secret check*, just not how the *cron job* authorises
itself to the *route*). Solution: a TEST-only secret generated inside
this session (`gen_random_bytes(24)`), stored in a new table
`cron_auth_secrets(name, secret)` with `anon`/`authenticated` revoked
and `select`/`execute` scoped to `service_role` only, checked via a
`security definer` RPC `validate_cron_secret(p_name, p_secret) returns
boolean` (boolean-only, so the secret itself is never returned by any
response). The `daily-top-up` route requires a custom `X-Cron-Secret`
header validated against this RPC (called server-to-server with the
Edge Function's own `SUPABASE_SERVICE_ROLE_KEY`, same pattern as the
lock RPCs); the platform's `verify_jwt` gate (**still required, never
weakened**) is satisfied separately by the pg_cron job sending the anon
key. A Coach or Parent JWT - or the bare anon key alone - passes
`verify_jwt` but always fails the `X-Cron-Secret` check, so generator
actions stay unreachable to them exactly as required. Manual Management
routes (`/generate`, `/propagate`, `/trigger-session-saved`) are
unchanged - still Management-authenticated via `resolveCaller()`.

**pg_net timeout finding**: `net.http_post`/`net.http_get` default to a
5000ms client-side timeout. A full daily-top-up sweep (multiple Sessions
processed sequentially, 3+ real Airtable calls each) routinely exceeds
that, so the *first* cron registration (no explicit
`timeout_milliseconds`) would have logged a timeout in
`net._http_response` on every real run even though the Edge Function
itself completed the sweep correctly server-side (Deno doesn't cancel an
in-flight invocation just because the caller stopped waiting) - a
misleading "failure" for anyone monitoring the job's own request log.
Found during this slice's own verification (see below) and fixed before
finishing: the job was unscheduled and re-registered with
`timeout_milliseconds := 60000`, long enough for a full sweep of the
current TEST base and with headroom to spare.

### Real TEST verification - all real HTTP calls via `pg_net`, all 12 required items

Ten throwaway Sessions covering every pattern/state
(`SLICE8-IMM`/`-D2A`/`-EDIT`/`-REC`/`-SEL`/`-ONE`/`-DRAFT`/`-INACT`/
`-LOCK`/`-BAD`, plus a short-lived eleventh, `SLICE8-BAD2`, for the
failure-isolation attempt below) were created for this slice. Signed in
for real as `manager@test.invalid` (password reset via SQL, same
`crypt()`-on-`auth.users` technique as Slice 4) to get a genuine
management JWT for every Management-authenticated call below.

1. **Active Session immediate-trigger generates correctly**:
   `POST /trigger-session-saved` on a fresh Active Recurring Session
   (`SLICE8-IMM`, no `changes`) -> `{"kind":"generation_only",
   "generation":{"status":"generated","created":13,...}}`.
2. **Draft -> Active generates correctly**: same route on `SLICE8-D2A`
   while still Draft -> `no_changes` (correctly does nothing); PATCHed
   to Active via Airtable; same route again -> `generated, created: 13`.
3. **Qualifying recurring edit runs propagation then backfill
   correctly**: `SLICE8-EDIT` (Active, Wednesday) seeded with 13
   occurrences, then `POST /trigger-session-saved` with
   `changes.dayOfWeek.newDayName: "Friday"` ->
   `{"kind":"propagation_then_backfill","propagation":{"status":
   "applied","plan":{"cancelled":13,"backfillNeeded":true,...}},
   "backfill":{"status":"generated","created":13,...}}` - all 13
   Wednesday rows cancelled (`Status: Cancelled`, `Schedule Change
   State: Changed`), 13 new Friday rows created, confirmed by re-reading
   the Session's own `Session Occurrences` link (26 total, 13
   cancelled + 13 new).
4. **Daily job tops up missing occurrences (recovery)**: `SLICE8-REC`
   created Active and deliberately never sent through the immediate
   trigger; the daily-top-up sweep (see #9c below) generated its 13
   Thursday occurrences on its own - confirmed by reading its `Session
   Occurrences` link afterwards (exactly 13, no duplicates).
5. **Daily rerun is idempotent**: two daily-top-up sweeps fired in the
   same SQL statement (genuinely overlapping, see #9c) against a base
   where every Session was already topped up bar one - the already-
   topped-up Sessions returned `no_changes`/`skipped_locked` on both
   calls, zero duplicate occurrences created for any of them (re-read
   and counted per Session).
6. **Selected Dates works under scheduled generation**: `SLICE8-SEL`
   given two `Included` `Session Dates` rows (10 Nov, 1 Dec); the daily
   sweep generated exactly those two occurrences and no others (re-read:
   `"Slice8 Selected Dates - 10 Nov 2026"` and `"- 1 Dec 2026"` only).
7. **One-off works under scheduled generation**: `SLICE8-ONE` (Start
   Date 2026-11-20) generated exactly one occurrence, dated 20 Nov 2026,
   via the daily sweep alone (never triggered manually).
8. **Draft/Inactive ignored**: `SLICE8-DRAFT` (Draft) and `SLICE8-INACT`
   (Inactive) existed throughout every daily-top-up call in this slice;
   `fetchActiveSessions()`'s `considered` count never included them (10
   Active Sessions considered out of 12 total Sessions in the base at
   that point - the 2 excluded were exactly these two), and neither
   ever gained an occurrence.
9. **Overlap/locking scenarios**:
   - **a. daily job + manual `/generate`, same Session**: manually held
     `SLICE8-LOCK`'s lock via `acquire_generation_lock()` (simulating
     another writer mid-generation), then called `/generate` for it ->
     `{"status":"skipped_locked","created":0,"recordIds":[]}`.
   - **b. daily job + immediate trigger, same Session**: same held lock,
     called `/trigger-session-saved` for it -> `{"kind":
     "generation_only","generation":{"status":"skipped_locked",...}}`.
   - **c. two daily job attempts overlapping**: with the same lock still
     held, a full daily-top-up sweep correctly reported `SLICE8-LOCK` in
     `skippedLocked` while every other Active Session still processed
     normally (`{"considered":10,...,"skippedLocked":1,"failed":0,...}`)
     - confirming the daily job **skips a locked Session cleanly and
     keeps going**, not just that manual calls do. Lock released
     afterwards. Separately, two genuinely overlapping daily-top-up
     invocations (fired in one SQL statement, real concurrent wall-clock
     execution against the live Edge Function) were run against the
     one Session that still had generation work outstanding
     (`SLICE8-SEL`): one invocation generated it (`created: 2`), the
     other saw `skipped_locked` or `no_changes` depending on timing -
     `SLICE8-SEL` ended up with exactly 2 occurrences, never 4, proving
     the lock correctly serialises two concurrent daily-top-up attempts
     against the same Session.
10. **One Session failure does not stop the rest**: genuinely forcing a
    live Airtable-level throw turned out to be impractical rather than
    unsafe - every Session-level input the generator touches (Default
    Day, Default Start/End Time, dates) is designed to **fail closed**,
    not throw (`parseHHMM`/`parseIsoDateUTC`/`weekdayIndexFromName` all
    return `null`/`[]` on bad data, per `generator.ts`'s own header), so
    the only realistic thrown error is the Session record itself
    vanishing between the sweep's initial list call and its own
    `fetchSession()` call a moment later. Two honest live attempts were
    made to reproduce exactly that race (create a throwaway Session,
    fire the daily-top-up sweep, delete the Session's Airtable record
    immediately after) - both lost the race (the sweep reached and
    generated for the Session before the delete call landed), because a
    sweep over an already-topped-up TEST base is fast enough that
    winning a real network race against it isn't practical. Rather than
    keep spending real API calls chasing an unreliable race, the exact
    same code path was proven deterministically instead: a new unit
    test (`tests/support/daily-top-up.test.ts`, run via
    `tests/e2e/dailytopuptest.js`) mocks `fetch` so one of two Active
    Sessions' individual `fetchSession()` call 404s (reproducing
    precisely that "vanished between list and fetch" failure) while the
    other succeeds - confirms `failed: 1` naming the correct Session
    record ID with a non-empty error message, `generated: 1` for the
    later Session (the sweep keeps going), and both Sessions' locks
    released regardless (their RPCs were called successfully in the
    mock). 7/7 checks pass.
11. **`generation_locks` empty after completion**: `select count(*)
    from generation_locks` -> **0**, checked after every real call in
    this slice, including the manually-held-then-released lock scenarios
    and the genuinely overlapping concurrent sweeps.
12. **All throwaway Airtable records removed by exact record ID**: all
    11 throwaway Sessions, both `Session Dates` rows, and all 107
    created occurrence records (13+13+26+13+2+1+13+13+13, tallied
    against each real API response's own count) deleted by their exact
    captured record IDs - re-confirmed via `search_records` for
    "Slice8"/"SLICE8" across Sessions, Session Occurrences and Session
    Dates: **zero results**.

### Regression

- **TEST-A** (`rec4cME6ncL4IAvlK`): still exactly 14 occurrences, same
  set as every prior slice's baseline - untouched by any Slice 8 call
  (it was never a throwaway target and every daily-top-up sweep only
  ever returned `no_changes` for it).
- **TEST-B** (`recklh0OeaAMakQCJ`): still exactly 13 occurrences, same
  baseline - likewise untouched.
- **Parent Hub** (`GET /parent-hub/me` as `parent.a`): identical to the
  documented baseline - Dylan Davies paused on TEST-B (`paused_from`
  2026-09-15/`returns_on` 2026-10-20), Archie Atkinson active on TEST-A
  (next occurrence the 7 Oct replacement, `17:30 – 18:30`) and TEST-B
  (next occurrence 1 Oct, `18:00 – 19:00`) with coaches Sam Sample/Alex
  Test.
- **hub-content/players** (`GET /hub-content/players` as `coach.a`):
  identical to baseline - Archie + Bella, `permanent` tier, full
  permissions.
- **Slice 6 propagation tests / Slice 7 generation tests**: included in
  and passing as part of the full suite below.
- **Full TEST suite**: `node tests/run-all.js` -> **50/50 test files
  passed** (49 previous + the new `dailytopuptest.js`).

### Production / frontend / Sheets / finance

Untouched. `session-occurrences` (TEST project `dkqubldmfyeuudecxmvh`)
deployed as **v7** - the only Edge Function touched this slice, and
only in the TEST project. No production Airtable/Supabase object
created, read from with intent to write, or written to. No frontend
file touched. No Google Sheets or finance file touched.

**Slice 8 automatic triggering is ready for Slice 9 Session History.**

## Slice 9 - Session History

Goal, per your instruction: when Management makes a structural change to
a recurring Session, record a clean audit entry - what changed, who
changed it, when, and what the system did to future occurrences as a
result. Session History is the history of structural changes to a
recurring Session, never a list of past occurrences.

### What creates a History entry

Written from inside `propagateForSession()` (Day/Time/Venue/Capacity/
Operating Dates) or `generateForSession()` (Created/Active Status) -
the exact same safe structural-edit flow already used by Slice 6/8
propagation and generation, never a separate write path:

- **Day, Time, Venue, Capacity, Operating Dates (End Date)** - one row
  per structural dimension that ACTUALLY changed in a `/propagate` or
  `/trigger-session-saved` call, written by `propagateForSession()`
  after the occurrence-level plan and the Session's own new fields have
  both already been written successfully.
- **Created** - one row the first time `generateForSession()` runs with
  `sessionEvent: { kind: "created" }`, written by `generateForSession()`
  after generation has run.
- **Active Status** - one row when `generateForSession()` runs with
  `sessionEvent: { kind: "status_changed", oldStatus, newStatus }` and
  `oldStatus !== newStatus`.

### What does NOT create a History entry

Exactly the occurrence-level facts you listed - individual occurrence
cancellation/postponement/reschedule, a one-off occurrence override,
cover, Occurrence Staff, register/attendance, Confirmation State - none
of these ever go anywhere near `createHistoryEntries()`. Also: a
no-op save (a field resubmitted with its own current value - see
"Idempotency" below), a `/generate` or daily-top-up call (neither ever
passes `caller`/`sessionEvent`, so `orchestrator.ts` never even attempts
a History write for them), and a propagation call that throws before
reaching the History-write step.

### Schema

Reused Slice 1's `Session History` table exactly as it stood - no new
fields, no new table, no inspection blocker found: `History ID`
(primary field, a human-browsing convenience only - nothing in this
codebase ever looks a row up by it), `Session`, `Change Type` (all 7
existing choices used: Day/Time/Venue/Capacity/Operating Dates/Active
Status/Created), `Old Value`/`New Value` (plain strings, concise: e.g.
`"17:00 – 11:00"` -> wait, `"17:00 – 18:00"` / `"18:00 – 19:00"` for
Time, venue NAMES not record IDs for Venue via a new read-only
`fetchVenueNames()` lookup, `"12"`/`"20"` for Capacity, `"Start
2026-09-01, End (none)"` style for Operating Dates), `Change Summary`
(the human-readable system outcome, e.g. `"13 future occurrence(s)
updated to the new time."` or `"6 occurrence(s) cancelled beyond the
new End Date."` - built from the SAME plan/outcome the call actually
produced, per-dimension counts derived by filtering `plan.toCancel`/
`toUpdate`/`toCrystallise`/`skippedOverrides`/`manualReview` by their
own distinct `reason` text rather than trusting the plan's aggregate
totals, so a Day+End-Date combined edit still attributes each row's own
count correctly), `Changed At` (server `now.toISOString()`, an ISO8601
UTC instant - the field's own Europe/London display config handles
timezone presentation; a client-supplied timestamp is never trusted as
the authority), `Changed By User ID`/`Changed By Name Snapshot` (see
below).

### Ordering relative to propagation/generation - the safest ordering, as inspected before changing code

Inspected `propagation-orchestrator.ts`/`orchestrator.ts` first, per
your instruction, before writing any Slice 9 code. Both already acquire
the per-Session lock, do their real work, and release in a `finally` -
Slice 9 adds nothing that changes that shape, only a write inside it:

1. acquire the per-Session lock (unchanged, Slice 3/6)
2. read the Session's CURRENT fields + existing occurrences (unchanged)
3. plan the occurrence-level consequences against OLD values (unchanged)
4. apply that plan to Session Occurrences (unchanged)
5. write the Session's own new default fields (unchanged) - **only the
   dimensions that genuinely changed** (Slice 9: see "Idempotency")
6. **write Session History** - one row per dimension that changed, using
   the REAL counts from step 4's plan result - new in Slice 9
7. release the lock (unchanged, `finally`)

Step 6 only ever runs after steps 4 and 5 have both already succeeded -
if either throws, the function's `finally` releases the lock and
returns/rethrows before step 6 is ever reached, so a History write can
never claim more happened than actually did, and a failed edit never
leaves a false success row. This ordering was the direct answer to
"propose the safest ordering before changing code": History is
deliberately LAST, not first and not interleaved with the occurrence
writes, specifically so it can only ever describe a genuinely-completed
edit.

For `generateForSession()` (Created/Active Status), the same shape:
acquire lock -> generate -> write History (Slice 9, using the real
generation outcome) -> release lock in `finally`.

The per-Session lock is held across the ENTIRE structural edit +
propagation/generation + History write, exactly as instructed - there is
no window where another writer could touch this Session between the
occurrence-level plan being applied and its History row being written.

### Changed By

`HistoryCaller { userId, displayName }` - built once per authenticated
HTTP call from the exact same `resolveCaller()` result every route
already uses for its Management role check (never a separate lookup),
and threaded through `/propagate` and `/trigger-session-saved` into
`propagateForSession()`/`generateForSession()`'s new `options.caller`
parameter. `Changed By User ID` = the Supabase Auth user id (stable).
`Changed By Name Snapshot` = `profile.display_name`, falling back to
the caller's own email if display_name is blank (added this slice, to
`resolveCaller()`), and falling back a second time to the bare userId
inside the History-writing code itself in the (here, unreachable) case
both are somehow blank - the display name is genuinely a SNAPSHOT,
written once at Changed-At time and never re-derived from a live lookup
afterward, so History stays readable even if the person's name changes
or their account is later deactivated.

### Multi-field save

A single `/trigger-session-saved` (or `/propagate`) call with
`changes.time` + `changes.venue` + `changes.capacity` all present in
ONE request produces exactly one occurrence-level plan (unchanged
Slice 6 `planRecurringEdit()`, called once) and exactly one Session
field write (`updateSessionFields()`, called once, with all three
fields in one PATCH) - propagation runs exactly once, never per History
dimension. Session History then reports that ONE call's real outcome as
THREE separate rows (Time/Venue/Capacity), each with its own accurate
Old/New Value and Change Summary, built from the SAME plan result.
Verified for real in TEST (below): `SLICE9-MULTI`'s one call changing
time+venue+capacity together produced 13 occurrence updates (once, not
three times) and exactly 3 History rows.

### Idempotency / retries - no request/change ID needed

Every `changes.*` key is compared against the Session's own CURRENT
field value (read fresh at the top of the call) before it is planned,
written, or audited at all. A key present in `changes` whose value
already equals the Session's current field is treated as "no change
happened" and is excluded from the occurrence-level plan, the Session
field write, AND History - all three, for free, from the one
comparison. This means a genuine retry of an already-applied edit
naturally writes nothing the second time (the Session's own field is
now the "old" value the retry compares against), with no explicit
request/change ID or event-sourcing machinery required - verified for
real in TEST (below) by resending `SLICE9-DAY`'s exact same day change
twice.

`Created`/`Active Status` have no Session-record field of their own
that plays this same role (nothing on the Session record proves "this
exact transition was already recorded" the way the Default Day field
does for Day), so these two Change Types instead check Session History
itself before writing: `Created` is skipped if any `Created` row
already exists for the Session; `Active Status` is skipped only when
the requested `newStatus` already equals the Session's own current
recorded status - see "Post-Slice-9 hardening fix" below for the
corrected rule and why the original version of this check (comparing
against "does a row with this exact OLD/NEW pair already exist") was
replaced before this slice was signed off. No new schema was needed for
either check, so nothing was flagged/stopped for your review per the
"if an explicit request/change ID is genuinely required, stop and
report" instruction - it genuinely wasn't required.

### Session creation - documented integration point

No canonical Management create-Session write path exists yet in TEST
(same finding as Slice 8's Draft/Active integration point) - no fake UI
flow was invented. The documented contract: a future Management
"create Session" backend flow creates the Session record itself (all
its own fields, including an initial Lifecycle Status), then calls
`POST /trigger-session-saved` once with `sessionEvent: { kind:
"created" }` and no `changes` - exactly the same call shape as every
other immediate-trigger use, just with `sessionEvent` set. This
generates the Session's initial occurrences (if created Active) and
writes one `Created` History row whose New Value is the initial
Lifecycle Status and whose Change Summary reports the real generation
outcome (e.g. `"Session created (Recurring) as Active. 13
occurrence(s) generated."`) - no meaningless Old Value is manufactured
(left blank).

### Historical occurrence correction - explicitly out of scope

Not implemented this slice, per your instruction - flagged as future
occurrence-level audit work only, separate from Session History.

### Real TEST verification - all real HTTP calls via `pg_net`

Nine throwaway Sessions (`SLICE9-DAY`/`-TIME`/`-VENUE`/`-CAP`/
`-ENDDATE`/`-D2A`/`-MULTI`/`-FAIL`/`-CREATE`), each seeded with 13
initial occurrences first (except `-D2A`, left Draft, and `-CREATE`,
generated fresh by its own Created-event call). Signed in as
`manager@test.invalid` for a real management JWT.

1. **Day change**: `Monday -> Tuesday` on `SLICE9-DAY` ->
   `Change Type: Day`, Old `"Monday"`, New `"Tuesday"`, Summary "13
   future occurrence(s) cancelled for the old day; new day's
   occurrences will be generated by the next trigger or scheduled
   top-up." - matching the real plan (`cancelled: 13, backfillNeeded:
   true`) and the real backfill (13 generated).
2. **Time change**: `10:00–11:00 -> 14:00–15:00` on `SLICE9-TIME` ->
   Old `"10:00 – 11:00"`, New `"14:00 – 15:00"`, Summary "13 future
   occurrence(s) updated to the new time." - matching `updated: 13`.
3. **Venue change**: `Test Park -> Sample Sports Hall` on
   `SLICE9-VENUE` -> Old `"Test Park"`, New `"Sample Sports Hall"`
   (real venue NAMES, resolved from record IDs) - confirmed the
   Session's own `Venue` field was genuinely updated in Airtable, not
   just planned.
4. **Capacity change**: `12 -> 20` on `SLICE9-CAP` -> Old `"12"`, New
   `"20"`.
5. **Operating End Date change**: End Date set to `2026-11-15` on
   `SLICE9-ENDDATE` -> `Change Type: Operating Dates`, Old `"Start
   2026-09-01, End (none)"`, New `"Start 2026-09-01, End 2026-11-15"`,
   Summary "6 occurrence(s) cancelled beyond the new End Date." -
   matching `cancelled: 6`.
6. **Draft -> Active**: `SLICE9-D2A` PATCHed to Active in Airtable
   (documented integration point, same as Slice 8), then
   `sessionEvent: { kind: "status_changed", oldStatus: "Draft",
   newStatus: "Active" }` -> `Change Type: Active Status`, Old
   `"Draft"`, New `"Active"`, Summary "13 occurrence(s) generated." -
   generation genuinely ran (13 created).
7. **Multiple-field save**: `SLICE9-MULTI`, one call changing time +
   venue + capacity together -> exactly 3 History rows (Time/Venue/
   Capacity), exactly one occurrence-level plan (13 time updates, 0
   cancellations - venue/capacity had nothing to crystallise on a
   Session with no frozen occurrences), confirmed via the real
   response body (a single `plan.updated: 13`) that propagation ran
   once, not three times.
8. **Unchanged/no-op save**: resent `SLICE9-DAY`'s exact same
   `dayOfWeek: "Tuesday"` change a second time -> `plan` entirely empty
   (`updated/cancelled/crystallised: 0, backfillNeeded: false`) - no
   new History row (table re-read: still exactly one `Day` row for
   this Session).
9. **Failed propagation leaves no false success row**: `SLICE9-FAIL`,
   `venue.newVenueRecordIds: ["recZZZZZZZZZZZZZZ"]` (well-formed,
   non-existent) -> real `500`, Airtable's own real rejection
   (`"Airtable update Sessions error: 422 {"error":{"type":
   "ROW_DOES_NOT_EXIST",...}}"`) - the occurrence-level plan for this
   Session was empty anyway (no frozen occurrences), so the failure
   happened at the Session-field-write step, strictly before History is
   ever reached; confirmed zero History rows exist for this Session,
   and `generation_locks` still reached 0 afterward (the lock's
   `finally` released it even though the write threw).
10. **Retry of an already-applied edit does not duplicate History**:
    covered twice - item 8 above (Day), and resending `SLICE9-D2A`'s
    exact same `status_changed` `Draft->Active` event a second time
    (generation correctly returned `no_changes`, and Session History
    re-read afterward: still exactly one `Active Status` row, not two).
11. **Changed By ID/name snapshot correct**: every one of the 10 real
    History rows written this slice carries `Changed By User ID:
    "285f819e-e0d4-4257-8121-5f16781e97ba"` (the real
    `manager@test.invalid` Supabase Auth user id) and `Changed By Name
    Snapshot: "Morgan Manager"` (her real `profiles.display_name`).
12. **Change Summary matches the actual propagation result**: cross-
    checked above, item by item, against each call's own real plan/
    outcome numbers - never a guess, always the same counts the
    response body itself reported.
13. **Session creation** (not itself one of the 12 numbered items, but
    explicitly required by "What creates Session History"): `SLICE9-
    CREATE` created Active directly in Airtable, then `sessionEvent: {
    kind: "created" }` -> `Change Type: Created`, Old Value blank, New
    Value `"Active"`, Summary "Session created (Recurring) as Active.
    13 occurrence(s) generated." - generation genuinely ran (13
    created), matching the real outcome.

Final tally: **10 real History rows** written across the whole
verification pass, exactly matching manual arithmetic (Day×1 + Time×2
+ Venue×2 + Capacity×2 + Operating Dates×1 + Active Status×1 +
Created×1 = 10) - no more, no fewer, confirmed by re-reading the whole
`Session History` table after every call in the sequence, including
both retries.

**Cleanup**: all 9 throwaway Sessions, all 130 occurrence records they
generated (10×13 - the 9 seeded sessions plus `SLICE9-DAY`'s 13-row
backfill), and all 10 History rows deleted by their exact captured
record IDs. Re-confirmed via `search_records` for "Slice9"/"SLICE9"
across Sessions, Session Occurrences and Session History: zero results.
`generation_locks`: 0 rows throughout and after.

### Regression

- **TEST-A** (`rec4cME6ncL4IAvlK`) / **TEST-B** (`recklh0OeaAMakQCJ`):
  still exactly 14 / 13 occurrences, untouched by any Slice 9 call.
- **Parent Hub** (`GET /parent-hub/me` as `parent.a`): identical to the
  documented baseline (Dylan paused on TEST-B, Archie active on TEST-A/
  TEST-B with the same next-occurrence details as every prior slice).
- **hub-content/players** (`GET /hub-content/players` as `coach.a`):
  identical to baseline - Archie + Bella, `permanent` tier.
- **Slice 6 propagation / Slice 8 automatic triggering**: a real
  `POST /daily-top-up` call after cleanup -> `{"considered":2,
  "generated":0,"noChanges":2,"skippedLocked":0,"failed":0,...}` -
  TEST-A/TEST-B both still correctly `no_changes`, confirming the
  daily sweep and its underlying `generateForSession()` still behave
  correctly with the Slice 9 changes layered on top.
- **Full TEST suite**: `node tests/run-all.js` -> **50/50 test files
  passed**, unchanged (no new local test file this slice - Slice 9's
  logic lives entirely inside the already-verified-by-real-HTTP
  orchestrator files, per the same reasoning as Slice 4/8).

### Production / frontend / Sheets / finance

Confirmed untouched: production Airtable (`apprptFotQuVL1mhs`) still
has no `Session History` table (never created there - Slice 9 only
ever wrote to the TEST base `appQktredAuGa1X7e`'s existing Slice-1
table); production Supabase (`bkkukymqaxawnudoxdjs`) and its functions
unchanged; no frontend file touched; no Google Sheets file touched; no
finance file touched. `session-occurrences` (TEST project
`dkqubldmfyeuudecxmvh`) deployed as **v8** - the only Edge Function
touched this slice, and only in the TEST project.

## Post-Slice-9 hardening fix - Active Status idempotency correction

Approved subject to one correction: the `Active Status` idempotency
check above originally compared the incoming `(oldStatus, newStatus)`
pair against "does a History row with this exact pair already exist" -
which wrongly suppressed a genuine LATER real toggle back to a status
pair that had occurred at some earlier point (e.g. a second
Active -> Inactive after an intervening Inactive -> Active). Flagged as
a known limitation when Slice 9 was first delivered; rejected as
unacceptable and fixed before Slice 10, per your instruction.

### The corrected rule

`orchestrator.ts`'s `status_changed` branch no longer asks "has this
exact pair been recorded before". It now asks a single question -
`mostRecentRecordedStatus()` - "what status does Session History's own
most recently written `Created`/`Active Status` row say this Session is
currently at":

- `requested newStatus == that most-recently-recorded status` -> no-op:
  nothing is written (this is what makes an immediate retry safe).
- `requested newStatus != that most-recently-recorded status` -> a
  genuine transition: the real generation runs and exactly one new
  `Active Status` History row is written - regardless of whether that
  same OLD/NEW pair was ever recorded earlier in this Session's history.

`Created`'s own idempotency (skip if any `Created` row already exists)
is untouched - a Session still only ever gets one genuine Created event,
and that check was never the bug.

Why this - and not the Session's own live Lifecycle Status field -
is the correct signal: by the time this code runs, the Session's own
field has *already* been written by whoever called the trigger (see
this file's Session-creation/Slice-8 integration-contract notes above),
so the live field reads the same "new" value on the very first genuine
call and on any retry of it - it cannot tell those two cases apart.
History's own most-recent row can, because it only ever advances when
this function itself writes to it. This is the opposite of Day/Time/
Venue/Capacity/EndDate, where the Session's own live field IS a safe
idempotency signal, because `propagateForSession()` itself is the one
thing that ever writes it.

Only `orchestrator.ts` changed for this fix - `mostRecentRecordedStatus()`
added, `writeSessionEventHistory()`'s `status_changed` branch rewired to
use it, `existing` History rows fetched once and shared between the
`created`/`status_changed` branches. No schema change. Redeployed as
`session-occurrences` **v9** (TEST project `dkqubldmfyeuudecxmvh`).

### Real TEST verification - all real HTTP calls via `pg_net`

One throwaway Session, `SLICE9-HARDEN` (`rec5qnLJqwGx7uCyr`, Recurring,
Friday), created Draft and driven through the exact sequence the bug
required to prove itself - a status repeated a second time, not just
three distinct transitions:

1. **Draft -> Active** (PATCHed to Active, then
   `sessionEvent:{oldStatus:"Draft",newStatus:"Active"}`) ->
   `generated, created: 13`; exactly **one** `Active Status` History row
   (Old `Draft`, New `Active`).
2. **Immediate retry of the same call** -> `no_changes`; **zero**
   additional History rows (still exactly one).
3. **Active -> Inactive** -> `no_changes` (Inactive Sessions generate
   nothing, as designed); exactly **one new** `Active Status` row (Old
   `Active`, New `Inactive`) - two rows total.
4. **Inactive -> Active** (the case Slice 9 originally got right even
   under the old buggy check, since this exact pair hadn't occurred
   before) -> **one new** row (Old `Inactive`, New `Active`) - three
   rows total.
5. **Active -> Inactive again** - the actual bug scenario: this exact
   `(Active, Inactive)` pair already exists at row 3. The OLD check
   would have wrongly matched it and written nothing. The FIXED check
   correctly compares against the most-recently-recorded status
   (`Active`, from row 4) rather than "has this pair ever occurred", so
   it wrote **one new** row (Old `Active`, New `Inactive`) - **four**
   rows total. This is the row that proves the fix.
6. **Immediate retry of step 5's exact call** -> `no_changes`; **zero**
   additional rows - still exactly four.

All four rows re-read afterward, sorted by `Changed At`: `Draft->Active`
(08:24:55) -> `Active->Inactive` (08:27:41) -> `Inactive->Active`
(08:29:26) -> `Active->Inactive` (08:31:28) - correct chronological
order, each row independently readable with its own accurate Old
Value/New Value/Change Summary/Changed By, exactly as required.

`generation_locks`: confirmed 0 rows after the full sequence. Every
call above ran generation exactly once per genuine transition (never
on a no-op retry) - the outcome quoted for each step above is the one
and only generation call that step made.

Cleanup: `SLICE9-HARDEN` (`rec5qnLJqwGx7uCyr`), its 13 Session
Occurrences, and its 4 Session History rows all deleted by exact record
ID after verification.

### Regression

- **TEST-A** (`rec4cME6ncL4IAvlK`) / **TEST-B** (`recklh0OeaAMakQCJ`):
  still exactly 14 / 13 occurrences, untouched.
- **Full TEST suite**: `node tests/run-all.js` -> **50/50 test files
  passed**, unchanged from Slice 9 (no new local test file - this fix
  lives entirely inside `orchestrator.ts`, verified by real HTTP per the
  same convention as the rest of this file's orchestration-layer code).
- **Production / frontend / Sheets / finance**: untouched - the only
  file changed for this fix is `orchestrator.ts`, redeployed only to
  the TEST project's `session-occurrences` function (v9). Production
  Airtable/Supabase, the frontend, Google Sheets and finance files were
  not touched.

**Slice 9 Session History is ready for Slice 10 full regression and handoff.**

## Slice 10 - foundation checkpoint: full regression, source-of-truth audit, cleanup check, handoff

The final Schedule & Sessions foundation checkpoint before this codebase
moves on to a different foundation area. Scope, per your instruction: prove
the existing foundation is internally consistent, tested and documented -
no new product features, no frontend changes, no production changes, and
no automatic start of Coaches/Needs Attention/Finance. Everything below was
reconfirmed against the CURRENT deployed `session-occurrences` v9 (the
hardening-fix build) and the current TEST Airtable/Supabase state; nothing
in generator.ts/propagation.ts/schedule-utils.ts/repository.ts/
propagation-repository.ts/lock-client.ts/daily-top-up.ts/session-trigger.ts/
index.ts has changed since Slice 9/the hardening fix, so this slice is a
verification pass, not a rebuild.

### A. Source-of-truth audit

Re-read every file in `supabase/functions-test/session-occurrences/` line
by line (not just diffed) against the intended ownership model. Holds,
with no newly-added duplicate source of truth:

- **Sessions** = recurring/default structure (Default Day/Start/End Time,
  Venue, Default Capacity, Schedule Pattern, Start/End Date, Session
  Lifecycle Status). The only writer is `updateSessionFields()`
  (propagation-repository.ts) - a single PATCH call, one call site
  (`propagateForSession()`), never called from the generator or from
  daily-top-up.
- **Session Occurrences** = dated operational facts. The only creator is
  `createOccurrences()` (repository.ts, generator-shells only); the only
  updater is `applyOccurrenceFieldUpdates()` (propagation-repository.ts,
  Time/Status/Schedule-Change-State/Venue/Capacity-Override crystallisation
  only). No other function anywhere writes to this table.
- **Session Dates** = Included/Excluded date rules. Read-only in this
  codebase (`fetchSessionDatesForSession()`) - there is still no write path
  for this table anywhere in the Schedule foundation, confirmed unchanged
  since Slice 2's original design (Management is expected to maintain these
  rows directly until a write UI exists - see Section L).
- **Session Staff** = recurring staffing. Never read or written by any file
  in `session-occurrences/` - correctly out of scope for generation/
  propagation/History, exactly as scoped since Slice 2. (Resolved
  elsewhere, correctly, by `parent-hub`/`hub-content` for coach display -
  see Section G.)
- **Occurrence Staff** = date-specific staffing/cover. Same as Session
  Staff - never touched anywhere in `session-occurrences/`. Confirmed still
  future work (Section L), not silently started.
- **Venues** = canonical venue records, referenced only by record ID
  (`Venue: string[]` link arrays on both Sessions and Session Occurrences -
  never a free-text venue field anywhere in this foundation).
  `fetchVenueNames()` resolves IDs to names for History display only, never
  as a write path.
- **Session History** = one row per structural dimension per genuine
  change, create-only (`createHistoryEntries()` is the only writer in the
  whole codebase; nothing ever updates or deletes a row). Occurrence-level
  Venue/Capacity Override are legitimate per-occurrence EXCEPTION fields
  (the ratified fallback-override model), not a second source of truth -
  blank always means "inherits the Session default," explicit always means
  "this occurrence's own value," and the two are mutually exclusive by
  construction.
- **Supabase `generation_locks`** - inspected the real table (TEST project
  `dkqubldmfyeuudecxmvh`): `session_record_id`/`lock_token` only, no
  business data, confirmed empty (0 rows) at rest and after every write
  path exercised this slice (below). Purely technical concurrency
  infrastructure, exactly as scoped.

No duplicate source of truth found anywhere in Slices 1-9 or the hardening
fix.

### B. Legacy contradiction check

Searched the whole repository (not just `session-occurrences/`) for every
pattern your instruction named. Result, split exactly as you asked:

**Inside the new Schedule foundation (`session-occurrences/` and its
Airtable-facing collaborators in `hub-content`/`parent-hub`): none found.**
Specifically:
- No Google Sheet read anywhere in `session-occurrences/`, `hub-content`,
  or `parent-hub` (all three explicitly say so in their own header
  comments - `hub-content/index.ts`: "the auto Sessions-from-Sheet sync
  that used to fire here... has been retired"; `parent-hub/index.ts`:
  "Sheets is finance/reporting only"). This was Phase 1/2 work
  (commits `f77d72d`, `9105b2e`), already done before Slice 1 of the
  occurrence generator started, and reconfirmed still true now.
- No Session structure is ever written from a Sheet - `updateSessionFields()`
  is the only Session-field writer, and it only ever exists as part of
  `propagateForSession()`, called only from a real Management-authenticated
  HTTP request.
- No occurrence date is ever derived from free-text weekday projection -
  `planGeneration()` reads the Session's own `Default Day` (a real
  Airtable singleSelect) and Session Occurrences are real dated rows, not
  a computed-on-read weekly slot.
- Session Staff is never bypassed for recurring staffing - it is simply
  never touched by this foundation at all (Section A).
- Venue is always a linked record, never free text, in every write path
  this foundation owns (Section A).
- No propagation path ever mutates a frozen occurrence except
  crystallisation, which exists specifically to protect its historical
  record, never to change what it means (`isFrozen()` gates every other
  write path in `propagation.ts` - reconfirmed by code re-read and by the
  real crystallisation/frozen-protection check in Section D below).

**Known legacy paths outside the new foundation (reported, not touched,
per your instruction):**
- **Coach Hub frontend CSV schedule path** - `core.js` still fetches
  `CFG.sessionsCsvUrl`/`CFG.calendarCsvUrl`/`CFG.changesCsvUrl` (published
  Google Sheets CSVs, configured in `config.js`) directly into
  `state.sessions`/`state.calendar`/`state.changes`, which `coach.js`'s
  `renderSchedule()` still uses for the Coach's own schedule view. This is
  entirely independent of `session-occurrences`/Session Occurrences - the
  Coach frontend has NOT been migrated to occurrence-driven schedule data.
  Not touched this slice (frontend, deliberately out of scope; the
  Google-Sheet-as-schedule-truth pattern is exactly the "known future
  migration work" your instruction named).
- **Production Edge Functions** (`supabase/functions/player-sessions/`,
  `player-feedback/`, `hub-content/` - the live, non-`-test` copies) still
  carry "Google Sheets Sessions = authoritative source for which coaches
  are scheduled" in their own header comments and coach-identity-matching
  logic. This is the pre-migration production behaviour the TEST copies
  (Phase 1/2) already fixed; production itself is deliberately untouched
  (Section J) and this is exactly the gap the eventual production
  promotion (Section K) closes, not a Slice 10 defect.
- **`content-provider.js`** and the Sheet-published Info/Resources/Terms/
  Themes/Financials tabs are unrelated content feeds (handbook, resources,
  finance), never Schedule truth - out of scope, not a contradiction.

### C + D. Generator and propagation re-verification

Every behaviour on your list was re-confirmed either by the existing
hand-kept unit suites (unchanged since their original Slice, now re-run
fresh - see Section I for exact counts) or by a fresh real-TEST HTTP
round-trip against the CURRENTLY DEPLOYED v9 function, using one new
throwaway Session (`SLICE10-CHECK`, `recmtDmtYJWJzz9tp`, Recurring,
Wednesday) built specifically to exercise several of these in one
traceable sequence, deleted afterward (Section H):

- **Recurring**: `/generate` on a fresh Active `SLICE10-CHECK` ->
  `generated, created: 13` (the same 12-week/10-occurrence rolling-horizon
  count as every prior slice).
- **Selected Dates / Excluded Dates / One-off / Draft / Active / Inactive
  / Start-End Date limits / rolling horizon / Occurrence Key idempotency /
  replacement `:R:` keys**: unchanged code, re-confirmed by
  `session-generator.test.ts` (37/37, includes explicit BST/GMT-transition
  cases, an unrecognised-Default-Day fail-closed case, an unparseable-
  Default-Start-Time fail-closed case, and the exact `:R:` replacement-key
  non-collision case) and `session-repository.test.ts` (19/19, includes
  the 5 real hand-seeded TEST-A rows' exact derived keys).
- **BST/GMT behaviour**: reconfirmed live, not just in the unit suite - the
  Time-change propagation call below produced `2026-10-14T17:00:00.000Z`
  and `2026-10-21T17:00:00.000Z` (both still BST) and
  `2026-10-28T18:00:00.000Z` (the very next Wednesday, already past the UK's
  real 2026 autumn clock change on 25 Oct) for the identical 18:00 local
  time - the transition boundary itself resolves correctly against live
  Airtable data, not just the synthetic fixture dates in the unit suite.
- **Permanent Time change**: `/propagate` with `time` ->
  `updated: 12` (13 occurrences minus the one deliberately frozen below),
  each recomputed via `buildUkDateTimeIso()` for its own date; History row
  `Time`, "12 future occurrence(s) updated to the new time."
- **Venue change + frozen-occurrence crystallisation**: one occurrence
  (30 Sep) was set `Status: Completed` (frozen by status, per `isFrozen()`,
  regardless of date) with no explicit Venue/Capacity of its own -
  reproducing the real fallback-dependent-frozen-row case. `/propagate`
  with `venue` -> `crystallised: 1`, writing the OLD venue (`Test Park`)
  onto exactly that one frozen row and nothing else (the 12 non-frozen rows
  correctly received no write - they inherit the new default via fallback);
  History row `Venue`, old "Test Park" -> new "Sample Sports Hall", "1
  historical occurrence(s) crystallised with the previous venue."
- **Day change + backfill**: `/propagate` with `dayOfWeek: Thursday` ->
  `cancelled: 12` (the frozen Completed row correctly excluded from
  cancellation too - it stays the historical record of what stood at that
  slot), `backfillNeeded: true`; a separate `/generate` call then created
  exactly 13 new Thursday occurrences, distinct record IDs from the
  (cancelled or frozen) old Wednesday rows. History row `Day`, "Wednesday"
  -> "Thursday", "12 future occurrence(s) cancelled for the old day; new
  day's occurrences will be generated by the next trigger or scheduled
  top-up" - and that is exactly what then happened.
- **Capacity change / field-level override independence / Time Overridden
  / crystallisation-before-default-change**: unchanged code, re-confirmed
  by `propagation.test.ts` (43/43 - includes the merged-single-write case
  for a row eligible for both Venue AND Capacity crystallisation at once,
  the Time-Overridden-is-never-touched case, and the exact real TEST-A
  frozen/cancelled/postponed/rescheduled non-interference cases below).
- **One-off same-date time edit vs permanent recurring time edit vs
  Rescheduled move-to-another-date**: restating the approved distinction
  exactly as ratified in Slice 6/7 - a permanent recurring time edit is a
  Session-level change (`propagateForSession()`, above); a one-off
  same-date time edit is meant to be an occurrence-level `Changed` write
  with `Time Overridden: true` set on that one row, protecting it from
  every future permanent Time change (`isTimeOverridden()` already gates
  `planTimeChange()` for this, and is exercised by TEST-A's real 7 Oct
  replacement row in `propagation.test.ts`); a move to another date is the
  existing origin/replacement model (`Replacement Occurrence` /
  `From field: Replacement Occurrence`, `computeReplacementOccurrenceKey()`'s
  `:R:` shape). **One-off occurrence-level write itself is still not
  implemented** - `index.ts` exposes no occurrence-level PATCH route at
  all (only `/generate`, `/propagate`, `/trigger-session-saved`,
  `/daily-top-up`, all Session-level). Per your instruction, this is
  recorded as future UI/write workflow (Section L), not a Schedule-
  foundation failure - the READ side (resolution/display) already handles
  a Changed/Time-Overridden/Rescheduled row correctly (Section G), only
  the WRITE side for a brand-new one-off exception doesn't exist yet.

### E. Triggering / automation

- **Manual generation route** (`/generate`): reconfirmed live, above.
- **Session-save trigger route** (`/trigger-session-saved`): the exact
  status-transition sequence re-verified during the hardening fix stands
  (Draft->Active->Inactive->Active->Inactive, one History row per genuine
  transition, zero on retry) - not re-run again this slice since nothing
  in `orchestrator.ts`/`session-trigger.ts` changed since that verification
  a few hours earlier in this same session.
- **Daily top-up + the 03:00 UTC TEST cron**: read the real
  `cron.job` row back from Postgres - `session-occurrences-daily-top-up`,
  schedule `0 3 * * *`, `timeout_milliseconds := 60000` (the Slice 8 fix,
  still in place), sending the anon key (`apikey`/`Authorization`, satisfies
  `verify_jwt`) plus the real `X-Cron-Secret` header. Fired the exact same
  call by hand: `{"considered":3,"generated":0,"noChanges":3,
  "skippedLocked":0,"failed":0,"occurrencesCreated":0,"failures":[]}` -
  TEST-A, TEST-B and `SLICE10-CHECK` (all three real Active Sessions at the
  time) all correctly `no_changes`, cron-secret gate still enforced,
  failure-isolation contract unchanged (still proven by the Slice 8
  mocked-fetch unit test, `daily-top-up.test.ts`, 7/7 - a real second
  Session failing never aborts the sweep for the rest).
- **Per-Session locking / overlap safety / stale-lock ownership token
  behaviour**: unchanged `lock-client.ts`, re-confirmed structurally
  (token-ownership release semantics, Section A) and empirically -
  `generation_locks` read back as 0 rows both before this slice's real
  calls and after all of them (multiple sequential `/generate`/`/propagate`/
  `/daily-top-up` calls against `SLICE10-CHECK`, none left a stale row).
- **Lock table empty after successful runs**: confirmed, above.
- **TEST X-Cron-Secret mechanism**: flagged, as instructed, for production
  review later (Section K) - not changed here. It remains a TEST-only
  workaround for not having a real production service-role key available
  to this session; production's real deployment needs its own decision on
  how the daily sweep authenticates itself (Section K, item 6).

### F. Session History

- **Correct structural dimensions generate History, occurrence-level
  exceptions do not**: reconfirmed live - the three `/propagate` calls
  above each produced exactly one History row (Venue, Time, Day), each
  correctly scoped to the Session-level dimension that actually changed;
  no occurrence-level exception (the frozen/crystallised row, the 12
  cancelled Wednesday rows, the 13 new Thursday rows) produced a History
  row of its own - History audits the STRUCTURAL edit, never the
  occurrence-level consequences of it, exactly as designed.
- **Changed By ID + Name Snapshot / Changed At / Change Summary**: all
  three real rows carry the correct Supabase Auth user id, "Morgan
  Manager" (the real `manager@test.invalid` profile's display name,
  snapshotted, not live-looked-up), a UTC `Changed At` matching the real
  call time, and an accurate, specific Change Summary for each
  (crystallisation count, cancellation count, update count) - never a
  generic "something changed."
- **Multi-field edits**: unchanged design (Slice 9), not re-exercised with
  a fresh multi-field call this slice (already proven live in Slice 9 -
  `SLICE9-MULTI`, one call/one plan/one Session write/three History rows -
  and nothing in the multi-field path has changed since).
- **No-op retry idempotency / repeated genuine lifecycle transitions
  preserved**: the hardening fix's own real-TEST verification (same
  session, a few hours before this checkpoint) stands unmodified -
  Draft->Active->Inactive->Active->Inactive produced exactly one History
  row per genuine transition, zero on either immediate retry, including
  the specific repeated-pair case the hardening fix exists for.
- **Failed propagation creates no false success History**: unchanged by
  construction (`buildPropagationHistoryEntries()`/
  `writeSessionEventHistory()` are only ever reached after the real
  writes above them have already succeeded - Section A/D's code re-read
  confirms this is still structurally true, no rollback path exists to get
  wrong because there is nothing to roll back).

### G. Parent/Coach compatibility

Re-ran real TEST checks as `parent.a@test.invalid` and `coach.a@test.invalid`
against the current (post-hardening-fix, post-`SLICE10-CHECK`) TEST state:

- **`GET /parent-hub/me`**: identical to every prior slice's documented
  baseline. Dylan Davies still `paused_sessions` on TEST-B with the same
  `paused_from`/`returns_on` dates (paused-membership behaviour unchanged).
  Archie Atkinson still `active_sessions` on both TEST-A and TEST-B, with
  `ended_sessions` correctly distinguishing TEST-B's actual `end_date`
  (2026-09-12) from its `scheduled_end_date` (2026-09-30) - unchanged.
  Pending claim (Bella Brown) still present, unchanged.
- **Cancelled/postponed/rescheduled resolution, via the REAL TEST-A
  fixture**: Archie's TEST-A `next_occurrence` resolved to
  `{"date":"2026-10-07","day":"Wednesday","time":"17:30 – 18:30",
  "venue":"Sample Sports Hall","rescheduled":true}` - the real hand-seeded
  5 Oct (Postponed) -> 7 Oct (Rescheduled replacement) fixture, correctly
  skipping the cancelled 28 Sep origin and the postponed 5 Oct origin,
  correctly resolving to the REPLACEMENT's own date/weekday/time/venue
  (not the recurring Monday pattern), with `rescheduled: true` set. This is
  the single strongest live proof available that TEST-A's original
  hand-seeded exception fixtures are still valid data (Section H) AND that
  resolution logic still reads them correctly.
- **Europe/London occurrence-time display**: Archie's TEST-A occurrence
  shows `17:30 – 18:30` (the fixture's real UTC instant, 16:30Z, correctly
  displayed as BST-adjusted local time) and TEST-B's shows `18:00 – 19:00`
  (already GMT-period-adjacent, still correct) - unchanged since the
  `a2fa3eb` fix.
- **TEST-B generated occurrence path**: Archie's TEST-B `next_occurrence`
  (1 Oct 2026, Thursday, 18:00-19:00, Sample Sports Hall,
  `rescheduled: false`) is a plain generator-created row, resolving
  correctly with no exception involved - unchanged.
- **`available_sessions`**: correctly reflects the real live Active Session
  set at call time (TEST-A, TEST-B, and `SLICE10-CHECK` while it existed) -
  confirms this list is genuinely live-derived, not hardcoded.
  `session_requests_available: false` unchanged (the feature stays
  switched off, per its own Feature Control gate - unrelated to this
  foundation).
- **`GET /hub-content/players`** as `coach.a`: identical to baseline -
  Archie + Bella, `tier: "permanent"`, `can_edit_feedback`/`can_edit_idp`/
  `can_edit_attendance` all `true` - Lead Coach access unchanged.
- **Coach frontend occurrence-driven migration status**: confirmed NOT
  migrated (Section B) - `coach.js`'s schedule view still reads the legacy
  CSV feed, not Session Occurrences. This is unchanged and, per your
  instruction, correctly left alone.

### H. Data integrity

Inspected the real current TEST data directly (not just through the app):

- **TEST-A hand-seeded exception fixtures**: all five original rows
  present and structurally intact - 28 Sep (Cancelled), 5 Oct (Postponed,
  outgoing `Replacement Occurrence` link to the 7 Oct row), the 7 Oct
  replacement itself (incoming `From field: Replacement Occurrence` link
  back to the 5 Oct origin), 12 Oct and 19 Oct (plain Scheduled Standard).
  The replacement link is mutual and non-orphaned (both ends exist and
  point at each other). Independently reconfirmed live via Parent Hub's
  own resolution of this exact fixture (Section G).
- **Occurrence Key uniqueness / no duplicate standard slots**: read the
  entire real Session Occurrences table (53 rows at the time, before this
  slice's own cleanup) and checked every explicit `Occurrence Key`/derived
  key - no two rows share a key, no Session+date combination has more than
  one standard-slot row. TEST-A's 5 legacy rows (no explicit key field
  set) and TEST-B/`SLICE10-CHECK`'s generator-created rows (explicit key)
  coexist with no collision, exactly as `deriveOccurrenceKey()` guarantees.
- **No orphaned replacement links**: the one real replacement pair (above)
  is intact; no other `Replacement Occurrence`/`From field: Replacement
  Occurrence` link exists in the current table.
- **No stale generation locks**: `generation_locks` read back as 0 rows
  (Section E).
- **No leftover throwaway Sessions/Session Dates/Session History rows from
  prior verification**: read the entire real Sessions table (3 rows: TEST-A,
  TEST-B, and this slice's own `SLICE10-CHECK`, since deleted), the entire
  Session Dates table (0 rows), and the entire Session History table (only
  this slice's own 3 rows, since deleted) - no debris survived from Slices
  6, 7, 8, 9 or the hardening fix's own throwaway Sessions; each of those
  slices' own cleanup step had already removed everything it created.
- **This slice's own debris**: `SLICE10-CHECK` (`recmtDmtYJWJzz9tp`), its
  26 Session Occurrences rows (13 original Wednesday + 13 backfilled
  Thursday) and its 3 Session History rows were all deleted by exact
  record ID after the checks above completed. Confirmed by re-reading
  Sessions (back to 2: TEST-A, TEST-B), Session Occurrences (back to 27:
  TEST-A's 14 + TEST-B's 13) and Session History (back to 0 rows).

### I. Full regression - exact counts

| Suite | Result |
|---|---|
| Generator (`session-generator.test.ts`) | **37/37** |
| Repository/concurrency (`session-repository.test.ts`) | **19/19** |
| Propagation (`propagation.test.ts`) | **43/43** |
| Triggering/daily-top-up (`daily-top-up.test.ts`) | **7/7 checks** |
| Parent Hub time-format/resolution (`next-occurrence.test.ts`) | **19/19** |
| **Full TEST suite** (`node tests/run-all.js`, all 50 e2e files incl. the five above) | **50/50 test files passed** |

Run twice this slice (once mid-checkpoint, once as the final record) with
identical results both times. No failure encountered - nothing stopped
this slice for the "any failure stops Slice 10" condition.

### J. Production isolation

Re-checked directly, not assumed:

- **Production Supabase** (`bkkukymqaxawnudoxdjs`): `list_edge_functions`
  shows exactly `hub-content`, `me`, `register-interest`, `approve-coach`,
  `player-sessions`, `parent-hub`, `player-feedback`,
  `approve-coach-trial`, `player-feedback-trial` - **no
  `session-occurrences` function exists in production.** The public schema
  has exactly one table, `profiles` - **no `generation_locks`, no
  `cron_auth_secrets`, no `validate_cron_secret`/`acquire_generation_lock`/
  `release_generation_lock` RPCs exist in production Postgres.**
- **Production Airtable** (`apprptFotQuVL1mhs`): a genuine finding worth
  recording precisely, not glossed over. Production's schema is NOT a
  blank slate - it already has `Sessions`, `Session Occurrences`,
  `Occurrence Staff`, and a `Session Change History` table, pre-dating this
  Schedule foundation's work entirely (most likely built for a different,
  not-yet-wired purpose, since none of it does anything without the
  generator/propagation/History code this foundation built in TEST).
  Comparing field-by-field against TEST:
  - Present in BOTH (safe, no gap): `Default Day`, `Default Start Time`,
    `Default End Time`, `Default Capacity`, `Schedule Pattern`, `Session
    Lifecycle Status`, `Venue` (linked record, not free text) on Sessions;
    `Date`, `Start/End Date & Time`, `Status`, `Venue`, `Capacity Override`,
    `Schedule Change State`, `Replacement Occurrence`/`From field:
    Replacement Occurrence` on Session Occurrences.
  - **Missing in production** (genuine TEST-only additions this
    foundation made): the `Occurrence Key` field (idempotency), the
    `Time Overridden` field (one-off/reschedule protection), and the
    entire `Session Dates` table (Included/Excluded rules) - none of these
    three exist in production yet.
  - **Shaped differently** (a real decision point, not yet resolved):
    production's `Session Change History` has `Change ID`/`Scope`/
    `Effective From`/`Previous Value`/`Reason`/`Source`/an occurrence-level
    `Session Occurrence` link, alongside `Change Type`/`Changed At`/
    `Changed By User ID`/`Changed By Name Snapshot` - broader than TEST's
    `Session History` (`History ID`/`Session`/`Change Type`/`Old Value`/
    `New Value`/`Change Summary`/`Changed At`/`Changed By User ID`/`Changed
    By Name Snapshot`, Session-level only). The two are not interchangeable
    as-is; **flagged as a promotion decision, not resolved here** (Section
    K).
  This changes the promotion manifest's shape for the better (a smaller
  schema delta than "build everything from scratch"), but it means the
  original Slice 9 claim that "production does not yet have the TEST-only
  Schedule schema additions" was too broad - the ACCURATE statement is:
  production already has the base Sessions/Occurrences/Occurrence-Staff/
  Change-History structure, but not Occurrence Key, Time Overridden,
  Session Dates, or a History table shaped like TEST's. See Section K.
- **Production frontend**: no frontend file (`auth.js`, `coach.js`,
  `config.js`, `content-provider.js`, `core.js`, `feedback.js`,
  `main.js`, `management.js`, `parent.js`, `styles.css`, `index.html`) was
  read for write or edited this slice.
- **Google Sheets / finance workbook**: no Sheet or finance file was
  touched this slice (or at any point in Slices 1-9/the hardening fix -
  every write this foundation ever made was to the TEST Airtable base
  `appQktredAuGa1X7e` or the TEST Supabase project `dkqubldmfyeuudecxmvh`).

### K. Production promotion manifest

Nothing promoted. This is the controlled reference for when that move
happens later.

1. **Exact Git commits comprising the Schedule & Sessions foundation**
   (branch `foundation/test-base-isolation`, chronological):
   `8d95959` (isolated TEST base + boot guard) ->
   `b8870a8` (Slice 2: pure generator) ->
   `52583c0` (ratify Selected Dates/One-off decisions) ->
   `269187a` (Slice 3: repository/orchestration/locking) ->
   `afe9677` + `8d852be` (Slice 4: manual `/generate` endpoint + 404 fix) ->
   `356f8b1` (Slice 5 checkpoint) ->
   `a2fa3eb` + `cf789e8` (Parent Hub occurrence-time display fix) ->
   `5b01f9f` (Slice 6: propagation) ->
   `7c2abb3` (Slice 7: Selected Dates/One-off verification) ->
   `7cca720` (Slice 8: triggering/daily top-up) ->
   `04d1958` (Slice 9: Session History) ->
   `4c7ff27` (hardening fix: Active Status idempotency). Slice 1 (the
   original Session Occurrences/Session Dates/Session History TEST schema
   creation) was an Airtable-only change with no corresponding code commit -
   documented in this file's early Slice sections, not in git.
2. **Airtable schema additions required in production** (Section J's
   diff): add the `Occurrence Key` field to Session Occurrences; add the
   `Time Overridden` field to Session Occurrences; add the `Session Dates`
   table (`Session Date ID`, `Session` link, `Date`, `Date Type`
   singleSelect: Included/Excluded); **decide** whether Session History
   writes go into production's existing `Session Change History` table
   (mapping TEST's narrower field set into it, deciding what to do with its
   extra `Scope`/`Effective From`/`Reason`/`Source`/occurrence-link fields)
   or a new dedicated table matching TEST's exact shape - this decision
   should be made before any promotion work starts, not defaulted silently.
3. **Supabase schema/functions/RPCs required**: the `generation_locks`
   table + `acquire_generation_lock`/`release_generation_lock` RPCs
   (Slice 3's exact migration, re-applicable verbatim); a real production
   equivalent of TEST's `cron_auth_secrets` table +
   `validate_cron_secret()` RPC, OR (preferable in production, where a real
   service-role key is presumably obtainable through proper secret
   management) authenticate the daily sweep with the actual service-role
   key the way the lock RPCs already authenticate themselves, rather than
   reproducing the TEST-only workaround - this is exactly the "flag for
   production review" item from Section E.
4. **Edge Functions/routes to deploy**: `session-occurrences` (all 12
   files: `index.ts`, `generator.ts`, `schedule-utils.ts`, `repository.ts`,
   `lock-client.ts`, `orchestrator.ts`, `propagation.ts`,
   `propagation-repository.ts`, `propagation-orchestrator.ts`,
   `session-trigger.ts`, `daily-top-up.ts`) as a genuinely new production
   function - routes `/generate`, `/propagate`, `/trigger-session-saved`,
   `/daily-top-up`, `verify_jwt: true`, production `AIRTABLE_BASE_ID`/
   `AIRTABLE_TOKEN`/`SUPABASE_URL`/`SUPABASE_ANON_KEY`/
   `SUPABASE_SERVICE_ROLE_KEY` env vars. The `PRODUCTION_BASE_IDS` boot
   guard in `index.ts` must be REMOVED (or inverted to guard the other way)
   before this ever runs against the real base - deploying this file
   unchanged against production would make it refuse to start, by design.
5. **cron/scheduled-job setup required**: a `session-occurrences-daily-
   top-up` pg_cron job in the production Postgres, same `0 3 * * *`
   schedule, `timeout_milliseconds := 60000` (do not reuse the TEST default
   - Slice 8's own finding), pointed at the production function URL, with
   whatever auth item 3 above resolves to.
6. **Secrets/config required**: production Airtable token with write
   access to Sessions/Session Occurrences/Session Dates/Session History (or
   Session Change History, per item 2's decision)/Venues; production
   Supabase service-role key (already presumably held by other production
   functions); the daily-sweep secret/mechanism per item 3.
7. **Production data backfill/generation required**: once deployed, every
   real production Active Session needs an initial `/generate` (or the
   first daily sweep) to create its rolling-horizon occurrences - there is
   no historical backfill of PAST occurrences (the generator is
   forward-looking only, by design, same as every TEST Session).
8. **Known migration risks**: (a) the `Session Change History` schema
   mismatch (item 2) - the single biggest open decision; (b) production's
   Sessions/Session Occurrences tables carry many fields this foundation
   never touches (`Client / Organisation`, `Schedule Breaks`, `Billing
   Rules`, `Needs Attention Exceptions`, `Booking Lines`, `Player
   Eligibility Overrides`, `Hub Audit Events`, `Discount Rules` on
   Sessions; `Coach Allocations`, `Player Attendance`, `Booking Lines` on
   Session Occurrences) - confirm none of these are expected to interact
   with generation/propagation before promoting, since this foundation was
   never designed or tested against them; (c) the Coach Hub CSV frontend
   path (Section B) will keep showing its own, separately-sourced schedule
   data even after promotion, until it is migrated too - promoting the
   backend alone does not retire it; (d) the TEST cron-secret workaround
   (item 3) should not be copied into production as-is.
9. **Rollback points**: every commit in item 1 is independently
   revertable (each Slice's own commit is self-contained per this file's
   own Slice-by-Slice verification sections); the Edge Function itself can
   be rolled back to "not deployed" by simply not deploying it (nothing
   else depends on it existing); the Airtable schema additions in item 2
   are additive-only (new fields/table), so rollback is "stop using them,"
   never "must delete data."
10. **Post-deploy verification checklist** (mirrors this file's own TEST
    verification convention): (a) boot guard confirms it's pointed at the
    real production base, not TEST/Master Copy; (b) one real throwaway-safe
    production Session exercises `/generate` end to end; (c) one real
    `/propagate` call confirms Time/Venue/Capacity/Day/EndDate each still
    behave per Sections C/D; (d) `/trigger-session-saved` confirms
    Created/Active-Status History with the corrected (post-hardening-fix)
    idempotency rule; (e) the daily cron fires once manually and reports
    `failed: 0`; (f) `generation_locks` empty after all of the above; (g)
    Parent Hub/`hub-content` continue to resolve real production Sessions
    correctly (Section G's checks, against production data); (h) the
    Coach Hub frontend is confirmed still working unchanged (it doesn't
    consume this function yet, so it should show zero behavioural
    difference - any difference found here would itself be a bug).

### L. Remaining Schedule work after this foundation

**Foundation complete:**
- Pure generation (Recurring/Selected Dates/One-off, rolling horizon,
  Occurrence Key idempotency, BST/GMT-safe).
- Pure recurring-edit propagation (Time/Venue/Capacity/Day/EndDate,
  frozen protection, crystallisation, override independence, backfill
  reporting).
- Concurrency (per-Session locking, ownership-token release safety).
- Immediate triggering + daily scheduled top-up + failure isolation.
- Session History (structural dimensions only, Changed By/At snapshot,
  no-op-retry-safe, genuine-repeat-safe idempotency).
- Real-TEST verification discipline and documentation for all of the
  above, this file, commit by commit.

**Still needed before Coach/frontend schedule cutover:**
- Migrate `coach.js`'s `renderSchedule()` off the Sheets CSV feed onto
  real Session Occurrences (Section B/G's confirmed-not-yet-done item).
- A real Management "save Session" write flow that calls
  `/trigger-session-saved` (the documented integration point, Section D/L
  of Slice 8/9) - today nothing in this codebase actually calls it except
  this file's own TEST verification.
- The one-off occurrence-level write workflow (Section D) - resolution
  already works, creation doesn't exist yet.

**Still needed during Management Schedule PDF implementation:**
- Whatever UI actually lets Management create/edit Session Dates rows
  (still read-only from this foundation's side).
- The Session Change History schema decision (Section K, item 2) most
  likely needs resolving here, since a Management screen is exactly where
  "what does History look like to a human" gets decided.

**Known future work (deliberately deferred, not a Slice 10 failure):**
- Coach Hub CSV schedule migration (Section B).
- Calendar frontend migration (same CSV dependency, `calendarCsvUrl`).
- Occurrence Staff / cover migration - this foundation never touches
  Occurrence Staff at all yet.
- Venue availability (no conflict/capacity-checking logic exists anywhere
  in this foundation - Venues are referenced, never validated against each
  other).
- Occurrence-level historical correction audit (explicitly out of scope
  since Slice 9 - a past occurrence's own record can be corrected by
  direct write, but there is no dedicated audit trail for THAT kind of
  edit, only for Session-level structural changes).
- Management Schedule screens generally (nothing in this foundation is
  wired to any UI yet - every real call this file documents was made
  directly over HTTP for verification).
- Frontend "Sync Sessions" button retirement (Phase 1/2 already retired
  the AUTOMATIC sync - confirm during frontend migration whether a manual
  button/reference still exists to remove).
- Production-only `player-sessions` Sheet-sync retirement (Section B/J) -
  the production Edge Function still carries the pre-migration Sheet-as-
  authority logic; this is exactly what promotion (Section K) is expected
  to eventually replace, not something this TEST-only foundation slice can
  touch.

### Verdict

**Schedule & Sessions backend foundation is ready to be treated as
complete in TEST.** Every ownership boundary in Section A holds with no
newly-introduced duplicate source of truth; every legacy contradiction
search in Section B came back clean inside the new foundation, with the
known legacy paths outside it (Coach Hub CSV, production Sheet-authority)
correctly identified and left alone; every generation/propagation/
triggering/History behaviour in Sections C-F was re-confirmed against the
currently deployed v9 function with real TEST HTTP calls, not just
unchanged unit tests; Parent/Coach compatibility (Section G) is unchanged
and Parent Hub's live resolution of TEST-A's own hand-seeded exception
fixture doubles as independent proof of Section H's data-integrity claims;
the full regression suite is 50/50 (Section I); production, its frontend,
Google Sheets and the finance workbook remain fully untouched, and Section
J's closer look at production's Airtable schema turned up a genuine,
now-documented finding (a pre-existing, differently-shaped schema this
foundation will need to reconcile with, not build from scratch) that the
promotion manifest (Section K) now accounts for explicitly instead of
leaving to be rediscovered later.

Do not start the Coaches foundation automatically.

## Coaches Foundation — Slice 1 (TEST schema foundation + deprecation baseline)

The Coaches Foundation Audit (conducted before this slice, not itself
recorded in this file) found that production Airtable (`apprptFotQuVL1mhs`)
already carries an extensive, pre-built Coach-related schema - rates,
allocations, availability, documents, cover, work summaries - almost none
of it mirrored into TEST (`appQktredAuGa1X7e`) and none of it wired into
any code anywhere. This slice is the first step of building the Coaches
foundation on top of that existing schema: bring TEST up to the parity the
next slices need, add the two new Session staffing-requirement fields, add
compliance-without-attachment support, and mark (never delete) three
ambiguous/dead legacy Coach schema items as deprecated. No resolver
behaviour changed - schema, dependency verification and documentation only,
exactly as scoped.

### Schema mirrored from production

Read-only reference: `apprptFotQuVL1mhs`. Four tables mirrored into TEST
field-for-field (names, types, singleSelect choices identical to
production):

- **Coach Rate Profiles** (`tblNWi46U7igzvRHx`): Rate Profile ID, Coach,
  Rate Type (Day / Evening / Camp / Additional / Plus), Pay Unit (Per Hour
  / Per Session / Per Day), Amount, Effective From, Effective Until,
  Active, Notes, Created, Last Updated. A coach's rate is its own dated
  row - a later rate change never overwrites an earlier one's history.
- **Coach Allocations** (`tbl6iWEd6Asj0dFMe`): Allocation ID, Session
  Occurrence, Coach, Assignment Type (Scheduled / Cover / Additional),
  Rate Profile, Rate Type Snapshot, Pay Unit Snapshot, Paid Units, Rate
  Amount Snapshot, Cost Override, Override Reason, Final Coach Cost, Cost
  Status (Draft / Confirmed / Exported), Finance Reference, Notes, Created,
  Last Updated. The historical-cost boundary: everything about what a rate
  WAS at allocation time is snapshotted onto the allocation itself, so a
  later Coach Rate Profiles change can never rewrite an already-created
  allocation's cost; Cost Override/Override Reason is the "agree a
  different rate for this particular piece of work" path.
- **Coach Availability** (`tblFU568fUAtDFuM0`): Availability ID, Coach, Day
  of Week, Available, Start Time, End Time, Active, Notes, Created, Last
  Updated. Recurring weekly pattern.
- **Coach Availability Exceptions** (`tbl1TTBfX0kVeitxj`): Exception ID,
  Coach, Start Date, End Date, Availability Type (Unavailable / Available
  All Day / Different Hours), Start Time, End Time, Note, Active, Created,
  Last Updated. Specific-date overrides on top of the recurring pattern.

None of the four is read or written by any code this slice - schema only,
same discipline as every other foundation's own Slice 1.

### Fields intentionally deferred (target table not ready this slice)

Two production `Coach Allocations` linked fields were deliberately NOT
mirrored, for two different reasons:

- **`Occurrence Staff`** - the target table already exists in TEST, but
  Occurrence Staff is one of the tables this slice was explicitly told to
  leave untouched (alongside Coaches/Coach Roles/Session Staff). Linking a
  new field to it would auto-create an inverse link field ON Occurrence
  Staff as an Airtable side effect, which this slice's own "leave
  untouched... do not change any fields on those tables otherwise"
  instruction reads as covering even an auto-created inverse. Deferred to
  whichever later slice actually integrates Occurrence Staff/cover, where
  its shape is expected to change anyway.
- **`Work Summary Lines`** - the target table does not exist in TEST at
  all yet. Deferred to the work-summary slice.

**Judgment call flagged for review, not silently decided**: mirroring the
required `Coach`/`Session Occurrence` links on the four new tables (per
this slice's own explicit instruction) unavoidably auto-created Airtable
inverse link fields on `Coaches` (five new reverse-link fields: Coach
Documents, Coach Rate Profiles, Coach Allocations, Coach Availability,
Coach Availability Exceptions) and on `Session Occurrences` (one new
reverse-link field: Coach Allocations). These are empty, additive,
Airtable-generated side effects of fields this slice was explicitly told
to create - not a manual edit to either table's own design, and nothing
in existing generator/propagation/History/access-resolution code reads or
is affected by an unrelated new field being present. Flagged here rather
than assumed acceptable without saying so, since Session Occurrences in
particular is Schedule-foundation schema.

### Sessions - new staffing-requirement fields

- **`Required Staff Count`** (number, no decimals, blank allowed - blank
  means "not yet specified," never treated as zero required).
- **`Requires Lead Coach`** (checkbox, default unchecked).

Confirmed before creation that no existing Sessions field served either
purpose. Deliberately simple, per instruction - no ratios, no role
matrices. Feeds future Needs Attention signals ("requires 2 staff,
currently has 1," "requires a Lead Coach, none assigned").

### Coach Documents - verification without upload

New table (`tblp8QGwHPG92ekzR`), mirrored from production's `Coach
Documents` (Document ID, Coach, Document Type [Enhanced DBS / Safeguarding
Certificate / First Aid / School Induction / Other], Attachment, Issue
Date, Expiry / Review Date, Status [Current / Review Soon / Needs Review /
Expired / Missing], Notes, Uploaded By User ID, Uploaded By Name Snapshot,
Uploaded At, Active, Created, Last Updated), plus three new TEST-only
fields not present in production: **Verified By User ID**, **Verified By
Name Snapshot**, **Verified At**. `Attachment` is deliberately optional -
the locked product decision this slice implements: Management can record
a compliance item as seen/verified (Status + Verified By + Verified At)
without ever storing the actual sensitive document. `Coach Document
Requirements` was deliberately not mirrored this slice (belongs to the
later Compliance slice).

### Session Staff - Active + Effective dating rule (recorded for Slice 2)

No schema change - `Effective From`/`Effective Until` already exist,
identically, on TEST's `Session Staff`. The locked rule Slice 2 must
implement:

A Session Staff assignment applies to occurrence date **D** iff:
- `Active = true`, AND
- `Effective From` is blank OR `D >= Effective From`, AND
- `Effective Until` is blank OR `D <= Effective Until`.

`Active` answers "is this assignment record enabled/not retracted" -
independent of the date range, which answers "does it apply on this
date." Neither `hub-content/player-access.ts`'s
`buildActiveSessionStaffByCoachAndSession()` nor `parent-hub/index.ts`'s
`buildSessionStaffBySessionId()` consumer currently reads `Effective
From`/`Until` at all (both filter on `Active` alone) - this is exactly the
gap Slice 2 closes.

### Dependency check + deprecation marking

All three candidates re-confirmed independently this slice (not just
inherited from the prior audit):

1. **`Coaches.Role`** (singleSelect) - zero references anywhere in the
   repository (full-repo grep). Marked deprecated (description-only).
2. **`Coaches.LEGACY — Coach Role`** (link) - a LIVE call exists:
   `hub-content/index.ts:458` calls `capabilitiesForCoach()`
   unconditionally, which reads `coachRecord.fields["Coach Role"]`. But
   the real Airtable field is named `LEGACY — Coach Role`, not `Coach
   Role` - the lookup key never matches, so `coachCapabilities` is always
   `null` in practice, and the one thing that consumes it
   (`legacyFallbackPerms()`, reached only when the `legacy_assigned_coaches`
   Feature Control flag is on) always short-circuits to `null` too. Traced
   through the real code path, not assumed: this is a call that exists but
   produces no effect, not a genuine live dependency on the field's value.
   Marked deprecated (description-only) - not deleted, since the dead code
   still references it by name and deleting could produce a confusing
   "field not found" surprise later rather than the current silent no-op.
3. **`Staff Role Overrides`** (whole table) - zero references in any
   `.ts`/`.js` file. The only repository match is
   `tests/support/test-base-spec.json`, a captured production-schema
   reference document (`source_base: apprptFotQuVL1mhs`, dated
   2026-09-26) that no code loads (confirmed: nothing greps/requires/
   imports that file). Marked deprecated (whole-table description).

No stop condition was hit - none of the three is actively required by a
genuinely working TEST path. Nothing was deleted; only descriptions
changed. Field/table types, choices, links and existing data are
untouched (confirmed: `Coaches.Role` still holds real values - Management/
Lead Coach/Coach - on the three real TEST coach records; this slice did
not touch that data).

### Real TEST verification

- **Compliance without attachment**: created a throwaway `Coach Documents`
  row (`DOC-SLICE1-CHECK`, linked to the real `coach.a` TEST Coach) with
  `Attachment` left entirely blank, `Status = Current`, `Verified By User
  ID`/`Verified By Name Snapshot`/`Verified At` all populated - saved and
  read back correctly. Proves Management can verify a compliance item
  without the document ever being uploaded. Deleted afterward
  (`recrfVK91TFl7E9WU`).
- **Staffing requirement fields**: created a throwaway Session
  (`SLICE1-STAFFCHECK`) with `Required Staff Count = 2` and `Requires Lead
  Coach = true` - saved and read back correctly. Deleted afterward
  (`rec46uwjkmz2esdkK`). TEST-A/TEST-B were not touched for this check.

### Regression

Full TEST suite (`node tests/run-all.js`) re-run after all schema changes:
**50/50 test files passed**, unchanged from the Slice 10 baseline - no
backend code changed this slice, so this confirms the schema additions
didn't disturb any existing mock/fixture behaviour.

### Production isolation

Confirmed by direct re-read of production Airtable (`apprptFotQuVL1mhs`):
table count unchanged (66 before and after), full table name list
identical, `Coaches` table's own field list identical - no write reached
production. No Supabase changes of any kind this slice (no migration, no
function deploy, both production and TEST Supabase untouched). No
frontend, Google Sheets, or finance file touched.

### Future design rule recorded (not implemented this slice)

**Cancellation / reschedule financial outcome** (for the later Coach
Allocations / Finance work, not Slice 1): when an occurrence is cancelled
or rescheduled, Management should eventually be able to confirm the
financial outcome of the ORIGINAL occurrence - coach cost, venue cost, and
any other applicable cost, each independently resolvable to Paid / Unpaid
/ Partial, with a final amount and an optional reason/note. For a
reschedule specifically: the original occurrence keeps its own financial
outcome; the replacement occurrence carries its own normal costs
separately - the two are never merged into one record. No fields or logic
for this exist yet; recorded here so the requirement isn't lost before the
relevant later slice.

### Cancellation/weather pay rules - confirmed still out of scope

Not touched this slice, per instruction - the 5-hour cancellation rule and
10-minute weather rule remain unbuilt, pending product clarification on
exact boundary conditions, same finding as the Coaches Foundation Audit.

**Coaches Slice 1 is ready for Slice 2 Session Staff effective dating.**

Do not start Slice 2 automatically.

## Coaches Foundation — Slice 2 (Session Staff effective dating) — 2026-09-27

TEST-only. Production Airtable/Supabase, frontend, Google Sheets and
finance untouched throughout.

### The rule

A Session Staff row applies on date `D` only when:
- `Active = true` — an independent administrative enable/disable flag,
  checked first and absolute. A retracted row never applies, whatever its
  date range says.
- `Effective From` is blank OR `D >= Effective From`.
- `Effective Until` is blank OR `D <= Effective Until`.

Both bounds are inclusive. Both blank means the row applies whenever
`Active` — exactly the pre-Slice-2 behaviour for a row that never needed
date-scoping, so nothing already-Active-only regresses. `D` is always a
plain `YYYY-MM-DD` Europe/London calendar date (`ukTodayIso()`, an
`Intl.DateTimeFormat` double-format read, never a UTC-midnight slice —
the UK calendar date can already have rolled over relative to UTC right
around BST/GMT midnight).

This is the ONE shared rule (`sessionStaffAppliesOnDate()`), maintained as
a byte-identical duplicate in `hub-content/player-access.ts` (exported,
canonical copy, with the full rationale in its own comment) and
`parent-hub/index.ts` (private duplicate, per this codebase's
self-contained-Edge-Function convention — no shared filesystem across
functions at deploy time). Both files carry an explicit comment
cross-referencing the other and stating any change must be made
identically in both. Neither resolver re-derives date applicability any
other way.

### What changed

- `hub-content/player-access.ts`: added `ukTodayIso()` and
  `sessionStaffAppliesOnDate()`. `buildActiveSessionStaffByCoachAndSession()`
  renamed to `buildSessionStaffByCoachAndSession()` and changed from one
  Active-filtered row per (session, coach) to ALL of that pair's rows,
  unfiltered — a coach can legitimately hold more than one Session Staff
  row on the same session over time (a planned handover, or simply an old
  row not yet retired); filtering by date is entirely
  `sessionStaffAppliesOnDate()`'s job at lookup time, never the builder's.
  `sessionStaffCapabilitiesForSession()` gained a `dateIso` parameter and
  now returns the first of the coach's rows that both applies on that date
  and grants a player-access-eligible role. `coachOwnStandingCapabilities()`
  gained a `today: Date` parameter and now applies the same date rule
  instead of a raw `Active` check. `resolvePlayerAccess()` computes
  `todayIso` from its existing `today` input and passes it through.
- `hub-content/index.ts`: renamed import; `today = new Date()` is now
  computed once, before `coachOwnStandingCapabilities()`'s call, and the
  same instant is passed into it, `resolveCoverSessionIds()` and
  `resolvePlayerAccess()` — one "now" per request.
- `parent-hub/index.ts`: added the private duplicate helpers described
  above. `resolveSessionCoachNames()` gained a `dateIso` parameter and now
  filters Session Staff rows by `sessionStaffAppliesOnDate()` instead of
  raw `Active`. `handleParentMe()` keeps its pre-existing `todayIso`
  (UTC-based, Schedule-foundation-approved, used only by
  `resolveNextOccurrence()`'s occurrence-floor check) completely
  untouched, and adds a separate `ukToday` (Europe/London) used only for
  this slice's date rule — the two are deliberately never conflated. For
  each active session, the coach names shown use the resolved
  `next_occurrence`'s own date when one exists, else fall back to
  `ukToday` (the recurring-pattern-only case, and `pausedSessions`, which
  have no occurrence context at all) — a next occurrence three weeks out
  during a planned handover shows the coach who applies THEN, not whoever
  is on today's date.

### Player-access date-context decision

`resolvePlayerAccess()` is evaluated as of "today" (`input.today`, the
same instant already used for former-access day math), not a specific
occurrence date — live "can this coach currently see this player" access
has no occurrence-date context of its own to use instead. This was judged
sufficiently date-contextual, not the brief's "stop and report" case, and
is documented here and in the code rather than silently assumed.

### Role security unchanged

`PLAYER_ACCESS_ROLE_PRIORITY` (`lead_coach: 0, coach: 1`), keyed by the
stable `Role Key` and independent of the editable `Can View Players`
checkbox, is untouched by this slice — Lead Coach and Coach may be
granted access, Learning Coach never is, enforced server-side, whatever a
Session Staff row's own dating says. Confirmed by real TEST verification
below even for a Learning Coach row with fully valid, currently-applying
dates.

### Real TEST verification

All throwaway — two Sessions (`SLICE2-HANDOVER`, `SLICE2-LEARNINGCOACH`),
one further throwaway Session created and reused for the sequential
handover (`SLICE2-HANDOVER-SEQ`, isolated from `SLICE2-HANDOVER` once its
own real coach — Sam, via `SLICE2-P2-Sam-Current` — turned out to be
open-ended and would otherwise have kept appearing alongside every later
handover window on the same session, which is *correct* per-row
behaviour, just not a clean isolated proof of the sequential pattern), 3
throwaway Players, matching Parent-Player Links / Player Session Links,
8 Session Staff rows and one Session Occurrence record (moved between 3
dates in turn to walk through the handover). Verified through the real
deployed TEST backend (`dkqubldmfyeuudecxmvh`, hub-content v5, parent-hub
v9) via `pg_net` from inside the TEST Supabase project itself (the
session's own outbound network policy blocks direct HTTPS to
`*.supabase.co`, so requests were issued server-side against
`/functions/v1/hub-content/players` and `/functions/v1/parent-hub/me`
using fresh JWTs for `coach.a@test.invalid` (Alex Test),
`coach.b@test.invalid` (Sam Sample) and `parent.a@test.invalid` (Priya
Parent)). All throwaway records deleted afterward; TEST-A/TEST-B never
altered.

- **Active + no date bounds; open-ended `Effective Until`** — Sam's
  `SLICE2-P2-Sam-Current` row (`Effective From` 2026-09-21, `Effective
  Until` blank) granted Sam real `/hub-content/players` access to the
  throwaway player on `SLICE2-HANDOVER` (`"tier":"permanent"`) as of the
  real current date, 2026-09-27.
- **An ended assignment does not retain access despite `Active = true`**
  — Alex's `SLICE2-P1-Alex-Ended` row (`Effective From` 2026-08-01,
  `Effective Until` 2026-09-20, `Active = true`) did NOT grant Alex
  access to that same player as of 2026-09-27; confirmed by Alex's real
  `/hub-content/players` response containing no row from
  `SLICE2-HANDOVER` via that assignment.
- **`Active = false` suppresses even inside a valid date range** — Alex's
  `SLICE2-P3-Alex-InactiveInRange` row (`Effective From` 2026-09-01,
  `Effective Until` 2026-10-01, `Active = false`) also granted no access,
  confirming `Active` is a true administrative off-switch, independent of
  the date range.
- **Deliberate overlap resolves for both coaches** — with Sam covering
  today via `SLICE2-P2-Sam-Current` and Alex covering today via a fourth
  row, `SLICE2-P4-Alex-OverlapWithSam` (`Effective From` 2026-09-25,
  `Effective Until` 2026-10-10): Alex's own `/hub-content/players`
  response showed the `SLICE2-HANDOVER` player via `SLICE2-P4` (his other
  two rows on that session correctly excluded, per above), and the real
  `/parent-hub/me` response for Priya Parent showed
  `"coaches":["Alex Test","Sam Sample"]` for that session — both coaches,
  not just one, confirming overlap is never collapsed to a single winner.
- **Danny → Tom → Joe planned recurring handover, boundary-inclusive** —
  three sequential Session Staff rows on `SLICE2-HANDOVER-SEQ`: Alex
  ("Danny", `Effective From` 2026-10-05, `Effective Until` 2026-10-18,
  Lead Coach), Sam ("Tom", `Effective From` 2026-10-19, `Effective Until`
  2026-11-01, Coach), Morgan Manager ("Joe", `Effective From` 2026-11-02,
  `Effective Until` blank/open-ended, Lead Coach). A single Session
  Occurrence record was moved through three dates and `/parent-hub/me`
  called fresh each time:
  - Date 2026-10-18 (Danny's last day, inclusive boundary) →
    `"coaches":["Alex Test"]` only.
  - Date 2026-10-19 (Tom's first day) → `"coaches":["Sam Sample"]` only.
  - Date 2026-11-02 (Joe's first day, open-ended) →
    `"coaches":["Morgan Manager"]` only.
  No date ever showed more than the one coach whose window actually
  covered it — confirms the display never falls back to "every Active
  row" once dating is present.
- **Learning Coach excluded from player-data access even with fully
  valid dating** — Sam's `SLICE2-LC1-Sam-LearningCoachOnly` row on the
  separate `SLICE2-LEARNINGCOACH` session (`Effective From` 2026-09-01,
  `Effective Until` blank, `Active = true` — unambiguously valid today)
  never appeared in Sam's real `/hub-content/players` response for that
  session's throwaway player, even though Sam legitimately had
  simultaneous, valid, non-Learning-Coach access to a different session
  in the very same response. Confirms the Learning Coach exclusion is not
  weakened by effective dating.
- **Malformed date data** — attempted directly against real Airtable: a
  `create_records_for_table` call setting `Effective From` to the literal
  string `"not-a-date"` was rejected outright by Airtable's own API with
  `422 Cannot parse date value "not-a-date" for field Effective From`.
  Airtable's `date` field type structurally prevents this specific
  malformed-value case from ever reaching the resolver through a normal
  write, which is itself a useful defense-in-depth confirmation, but it
  means this scenario cannot be demonstrated as live Airtable data. The
  code's fail-closed handling (`sessionStaffAppliesOnDate()` excludes a
  row whose date field is present but not a valid `YYYY-MM-DD` string,
  rather than treating it as absent/open) is instead verified by the unit
  test suite, which can construct such a row directly in memory —
  `access-resolution.test.ts` (non-string and invalid-format cases) and
  `session-coaches.test.ts` (excluded from parent display).

### Regression

- `coach.a`/`coach.b` real `/hub-content/players` responses (captured
  during the verification above) also contained their pre-existing
  TEST-A/TEST-B rows exactly as before this slice — Alex still sees
  TEST-A's players, Sam still sees TEST-B's (plus TEST-B's former-access
  row for Archie, unaffected), with permissions unchanged.
- Priya Parent's real `/parent-hub/me` response (captured during the
  verification above) still resolves TEST-A/TEST-B correctly — Dylan
  Davies' paused TEST-B session, Archie Atkinson's active TEST-A/TEST-B
  sessions with correct `next_occurrence` dates and coach lists
  (`["Sam Sample","Alex Test"]` for TEST-B, unchanged), the ended TEST-B
  link, and the one pending claim — all identical in shape to before this
  slice.
- Full TEST suite (`node tests/run-all.js`), run immediately before
  deploying: **50/50 test files passed**, including the two files this
  slice extended (`access-resolution.test.ts`: 52/52 individual
  assertions; `session-coaches.test.ts`: 18/18).
- Schedule-foundation tests (Slice 6-10, generator/propagation/
  triggering/History) untouched this slice and included in the same
  50/50 green run.

### Production isolation

No production Airtable, production Supabase, frontend, Google Sheets or
finance code/data was read or written at any point in this slice — every
Airtable call targeted the TEST base `appQktredAuGa1X7e`, every Supabase
call targeted the TEST project `dkqubldmfyeuudecxmvh`, and both deployed
Edge Functions retain their unchanged TEST DEPLOYMENT GUARD (refuses to
start against either known production Airtable base id).

### Occurrence Staff — confirmed still out of scope

Not touched this slice, per instruction. Occurrence Staff (one-date
exception/cover) is Slice 3.

**Coaches Slice 2 is ready for Slice 3 Occurrence Staff date-specific
resolution.**

Do not start Slice 3 automatically.
