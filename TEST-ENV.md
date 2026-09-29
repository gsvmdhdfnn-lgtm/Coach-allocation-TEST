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
financial outcome of the ORIGINAL occurrence for each of coach, parent
and venue, with a final amount and an optional reason/note. For a
reschedule specifically: the original occurrence keeps its own financial
outcome; the replacement occurrence carries its own normal costs
separately - the two are never merged into one record. No fields or logic
for this exist yet; recorded here so the requirement isn't lost before the
relevant later slice.

**Correction (Slice 6):** this note and the "out of scope" note below it
both originally implied a 5-hour cancellation rule and a 10-minute
weather rule were the expected eventual shape of this work, and that all
three outcome families would share one Paid/Unpaid/Partial choice set.
Neither was ever built; both were superseded by the approved model
Coaches Slice 6 actually implemented - explicit per-occurrence Management
decisions, with Coach (Paid/Unpaid/Partial), Parent (Credit/Refund/None)
and Venue (Paid/Credit/None) as three independent choice sets, never
auto-selected by time-before-cancellation, weather, or any other signal.
See the Coaches Foundation — Slice 6 section for the full write-up.

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

## Coaches Foundation — Slice 3 (Occurrence Staff date-specific resolution) — 2026-09-27

TEST-only. Production Airtable/Supabase, frontend, Google Sheets and
finance untouched throughout. Full cover-request workflow (coach
requesting cover, notifications, accept/decline, Management selection,
escalation) deliberately NOT built this slice - Occurrence Staff is made
resolvable as a staffing FACT, not yet a workflow.

### Schema re-read before coding

Occurrence Staff (`tblKL6FzOm4QY7g7J`) was re-inspected fresh in TEST
before any code was written. Actual fields: `Occurrence Staff ID`
(primary text), `Session Occurrence` (link, singular in practice),
`Coach` (link), `Session Staff Source` (link to Session Staff),
`Assignment Type` (single select: Planned / Cover / Additional /
Temporary Role), `Planned Role Snapshot` (plain text), `Actual Role
Snapshot` (plain text), `Attendance` (single select: Planned / Present /
Absent), `Management Confirmed` (checkbox), `Confirmed At` / `Confirmed
By User ID` / `Confirmed By Name Snapshot`, `Notes`, `Created` / `Last
Updated`. No separate Active/Cancelled/Withdrawn checkbox or status field
exists on this table - see "Valid-row rule" below for how that gap is
resolved using only fields that actually exist. Role snapshots are plain
text, NOT links to Coach Roles - `resolveOccurrenceRoleCaps()`/
`roleCapsByRoleName()` resolve a snapshot's text against Coach Roles'
own `Role Name` text.

### The resolution rule

One shared pure function, `resolveOccurrenceStaffing()` (canonical,
`hub-content/player-access.ts`, exported) with a byte-identical private
duplicate `resolveOccurrenceRoster()` in `parent-hub/index.ts` (same
self-contained-Edge-Function convention as every prior slice's shared
logic - each file carries a comment cross-referencing the other, any
change must be made identically in both):

```
resolveOccurrenceStaffing(
  dateIso, sessionStaffRowsForSession, occurrenceStaffRowsForOccurrence,
  roleCapsById, roleCapsByNameMap, sessionStaffById
) -> ResolvedOccurrenceCoach[]   // { coachId, roleCaps, fromOccurrenceStaff }
```

Two layers, always in this order:
1. **Base** - every Session Staff row for the session that applies on
   `dateIso` via `sessionStaffAppliesOnDate()` (Slice 2's rule,
   unchanged) seeds the roster, keyed by coach id.
2. **Overlay** - each *usable* Occurrence Staff row (see valid-row rule)
   linked to the exact Session Occurrence dated `dateIso` is applied on
   top, in Airtable row order:
   - If `Assignment Type = "Cover"` AND `Session Staff Source` resolves
     to a real Session Staff row, that source row's own coach is
     REMOVED from the roster first (unless it's the same coach as the
     covering row - a no-op self-cover).
   - The Occurrence Staff row's own coach is then SET in the roster
     (added if new, replacing any existing entry for that coach id if
     not - "last write wins" for a coach touched by more than one row).

This is called once per (session, date) from both consumers -
`sessionStaffCapabilitiesForSession()` (hub-content, player access) and
`resolveSessionCoachNames()` (parent-hub, display) - via an optional
`occurrenceContext` parameter. Omitted (or no real Session Occurrence
exists dated exactly `dateIso` for that session), both functions are
byte-identical to Slice 2 - nothing about a session with no occurrences,
or a date with no occurrence, changes at all. Never any write back to
Session Staff - the resolver only reads and merges; the underlying
recurring assignment is never mutated by a one-date fact.

### Additive vs replacement behaviour

- **Additive** (`Assignment Type = "Additional"`, or any type without a
  resolvable `Session Staff Source`): the new coach is added alongside
  the existing roster. Nobody is removed. Proven live: Danny (Alex Test,
  Lead Coach, normal Session Staff) plus Joe (Sam Sample) added via one
  Occurrence Staff row on a single dated occurrence -> that occurrence
  resolves Danny + Joe; every other occurrence (and the same session with
  no occurrence context at all) resolves Danny only.
- **Replacement/cover** (`Assignment Type = "Cover"` with a resolvable
  `Session Staff Source`): the source row's coach is removed from the
  roster for that occurrence only, and the covering coach is added/set
  in their place. Proven live: same Danny/Joe pair, `Cover` +
  `Session Staff Source` pointing at Danny's own Session Staff row ->
  that occurrence resolves Joe only (Danny's recurring row is completely
  untouched in Airtable - still Active, still applies on every other
  date); the very next real HTTP call for that same coach against that
  same occurrence-dated day correctly showed NO player-data access for
  Danny, exactly matching the brief's requirement that a coach must not
  "incorrectly retain date-specific player-data access merely because
  his recurring Session Staff row exists" once Occurrence Staff
  explicitly represents he's been replaced.

### Role snapshot precedence (documented and enforced)

`resolveOccurrenceRoleCaps()` resolves an Occurrence Staff row's
operative role in this order, each level failing closed independently -
a present-but-unresolvable value at one level never falls through to a
weaker one:
1. **Actual Role Snapshot** (text) - if non-blank, resolved against
   Coach Roles' `Role Name`. If it doesn't resolve to a real, Active,
   player-access-eligible role, the row grants NO access - it does NOT
   fall through to Planned or Source, even though those might resolve.
2. **Planned Role Snapshot** (text) - used only when Actual is blank.
   Same fail-closed resolution rule.
3. **Linked Session Staff Source's own `Role`** - used only when BOTH
   snapshots are blank. This is the one case where a live link is
   consulted rather than a snapshot, and only as the last resort for a
   Cover row that never had its own snapshot text entered.
4. Null/no access - both snapshots blank and no resolvable Source (or no
   Source at all).

Rationale: the schema clearly intends the snapshot fields for historical
truth (surviving a later Coach Roles catalogue change, or a later change
to the linked Session Staff row's own role) - `Actual` over `Planned`
reflects "what really happened" outranking "what was planned" wherever
both exist, matching every other Actual/Planned pairing already in this
schema (e.g. Confirmed At vs planned timing elsewhere). Live-confirmed:
an `Actual Role Snapshot = "Learning Coach"` together with a conflicting
`Planned Role Snapshot = "Coach"` AND a `Session Staff Source` resolving
to Lead Coach still denied player access - Actual won outright, never
blended with or overridden by the other two signals.

### Session Staff Source

Traces which recurring Session Staff assignment (if any) an
occurrence-specific row originated from - used ONLY for the Cover-removal
mechanic above and as the last-resort role fallback. It is NOT mandatory:
a genuinely standalone one-date addition (the additive case) legitimately
has no Session Staff Source, and no synthetic Session Staff row was ever
created just to populate it. Live-confirmed: a standalone `Additional`
row with `Session Staff Source` left blank and only `Actual Role
Snapshot` set still resolved correctly to full Coach-role access -
Source's absence doesn't gate or otherwise change staffing semantics.
Expected non-blank: a `Cover` row representing an explicit
replacement of a specific recurring assignment. Expected blank: any
standalone `Additional` addition, or a `Cover`/`Temporary Role` row where
the recurring assignment being covered doesn't (or no longer) exists as
a resolvable Session Staff row.

### Player-data access

`resolvePlayerAccess()` (hub-content) now builds, per request, a
`todayIso`-dated `Session record id -> Session Occurrence record id` map
(only for occurrences actually dated exactly today, excluding
Cancelled/Postponed - same "not a live candidate" filter as parent-hub's
own `resolveNextOccurrence()`) and threads it through as
`occurrenceContext` to `sessionStaffCapabilitiesForSession()`. The
existing hard security rule is completely unchanged and re-verified
through the new path: Lead Coach = access, Coach = access, Learning
Coach = never access, regardless of whether the coach's role comes from
a recurring Session Staff row or an Occurrence Staff row. Live-confirmed,
all real `GET /hub-content/players` calls against a throwaway Session
with a Session Occurrence dated exactly today:
- No Occurrence Staff -> normal Session Staff (Lead Coach) resolves;
  unrelated coach has no access.
- Additive `Coach`-role Occurrence Staff row -> the added coach gains
  `tier: "permanent"` access with Coach-level permissions; the existing
  Lead Coach keeps full, unaffected access.
- Same row switched to `Cover` + resolvable `Session Staff Source` ->
  the covering coach resolves with access; the replaced recurring coach
  loses access for that exact call (their own real `/hub-content/players`
  response no longer contained that session's player at all).
- Additive `Learning Coach`-role Occurrence Staff row -> the coach holds
  a real Occurrence Staff row but gets NO player-data access (`null`
  capabilities, excluded entirely), while the unaffected Lead Coach's own
  access is untouched.
- Additive `Lead Coach`-role Occurrence Staff row -> full access
  including `can_edit_idp: true`, same as a recurring Lead Coach.
- `Attendance = "Absent"` on an otherwise-valid Coach-role row -> the row
  is ignored entirely, no access, no roster entry.
- A row with `Coach` linked but no resolvable role at all (both
  snapshots blank, no Source) -> fails closed, no access, matching the
  documented precedence's terminal case.

### Parent-facing coach display

`resolveSessionCoachNames()` (parent-hub) takes the same optional
`occurrenceContext`, built from the session's already-resolved
`next_occurrence` (parent-hub already computes this via
`resolveNextOccurrence()` - no separate floor-scan needed, unlike
hub-content's today-based one). Display logic stays entirely separate
from the player-access permission logic above (different function, no
shared control flow) while both consume the identical
`resolveOccurrenceStaffing()`/`resolveOccurrenceRoster()` merge so they
can never disagree about who's actually staffing a given date.
Live-confirmed via real `GET /parent-hub/me` as `parent.a`, sequential
calls against one throwaway session as its Occurrence Staff row was
mutated and as its near occurrence was cancelled to advance
`next_occurrence`:
- No Occurrence Staff -> `coaches: ["Alex Test"]` (baseline).
- Additive `Coach`-role row -> `coaches: ["Alex Test","Sam Sample"]`
  (both present).
- Same row switched to `Cover` -> `coaches: ["Sam Sample"]` only (Alex
  Test, the replaced coach, dropped from display).
- The covered occurrence then marked Cancelled so the session's `next_
  occurrence` genuinely advances to the following, unrelated occurrence
  -> `coaches: ["Alex Test"]` again, Sam Sample does NOT carry forward -
  live proof of one-date isolation for parent display, not just for
  player access.

### One-date isolation

Structural, not just tested: `occurrenceIdForSessionToday`/
`resolveNextOccurrence()` only ever resolve ONE Session Occurrence record
per session per call, and `occurrenceContextForSession()`/its parent-hub
equivalent only ever pass THAT occurrence's own Occurrence Staff rows
(`buildOccurrenceStaffByOccurrenceId()`, keyed by occurrence record id)
into the resolver. An Occurrence Staff row linked to a different
occurrence is never even fetched into that date's merge - it cannot leak
by construction, not merely by convention. Confirmed live in both
directions above (additive/cover effects present only on the linked
occurrence's date, absent on every other).

### Active/cancelled/invalid Occurrence Staff (valid-row rule)

`isUsableOccurrenceStaffRow(row)`: `Coach` link must be present, AND
`Attendance` must not be `"Absent"`. No Active/Cancelled/Withdrawn field
exists on this table (confirmed by the fresh schema re-read above), so
`Attendance = "Absent"` was chosen as the interpretation of "does not
operationally count" - it is the only existing field whose semantics
already mean exactly that ("this person did not attend/deliver this
occurrence"), not an invented field. No row is ever deleted for going
operationally inactive - the historical record (who was originally
planned, what actually happened) stays in Airtable regardless; the
resolver simply excludes it from the live roster. A row missing its
`Coach` link is likewise excluded outright (never resolves to "nobody" as
a valid entry, never throws). A row that passes the usability check but
whose role can't be resolved (both snapshots blank, no Source) still
occupies a roster slot (`fromOccurrenceStaff: true`, `roleCaps: null`) -
usable for display purposes (the coach's identity is real) but grants no
access, per the role-precedence's fail-closed terminal case. Live-
confirmed: an `Attendance = "Absent"` row with an otherwise fully valid
Coach-role assignment produced zero access and no display effect.

**SUPERSEDED IN PART (2026-09-28):** "the resolver simply excludes it"
was true for the Absent row's own contribution, but the Absent row did
not remove the coach's recurring Session Staff entry. Now it does:
Occurrence Staff Absent removes the recurring staff member from the
effective roster for that occurrence independently of whether cover has
been found. See "Staffing correction — Occurrence Staff Absent".

### Legacy Sheets cover path - deliberately still coexisting

Not retired this slice, per instruction - that is Slice 4's job. The
existing Changes-sheet-based "cover" tier (`resolveCoverSessionIds()`,
`coachCoverCapabilities`, the separate `tier: "cover"` branch in
`resolvePlayerAccess()`) is untouched code, still active, and was
re-verified still working during regression. It reads only from the
Google Sheet and never reads or writes Occurrence Staff, so the two
mechanisms cannot collide or overwrite one another - they resolve
entirely different tiers (`"permanent"` for Occurrence-Staff-driven
results, including the new date-specific overlay, vs `"cover"` for the
Sheet-driven fallback) for entirely different data sources. Both can be
simultaneously true for different sessions in the same coach's response
without conflict, exactly as designed to coexist temporarily.

### Deploy

- `hub-content` v8 (project `dkqubldmfyeuudecxmvh`) - `index.ts` +
  `player-access.ts`. Deployed content downloaded and `diff`'d
  byte-for-byte against the local repo files after deployment; confirmed
  identical. (Two earlier deploy attempts in this slice were caught by
  the same download-and-diff check before being trusted: one had a
  transcription bug in an unrelated tail function, one had a literal
  `"PLACEHOLDER"` stand-in for `player-access.ts` that still deployed
  "successfully" - `deploy_edge_function` validates that imports resolve
  to *a* file, not that the file exports the right names. Both were
  caught and fixed before any real verification traffic was sent.)
- `parent-hub` v11 (same project) - `index.ts` (self-contained, no
  imports). Deployed content likewise downloaded and `diff`'d
  byte-for-byte against the local repo file after deployment; confirmed
  identical.

### Real TEST verification - all 14 required items, all real HTTP calls via `pg_net`

Two throwaway Sessions, `SLICE3-ACCESS` (`rec7woxFlmMoJEwmc`, deleted)
and `SLICE3-DISPLAY` (`recAoWDuYWKegxOvj`, deleted), each with one
Session Staff row (Alex Test/`coach.a`, Lead Coach, Active, no date
bounds) and real Session Occurrences dated relative to the actual test
date (2026-09-27): `SLICE3-ACCESS` had one occurrence dated exactly
today (hub-content's player-access path is today-scoped);
`SLICE3-DISPLAY` had a near occurrence (28 Sep) and a far one (5 Oct)
(parent-hub's display path is next-occurrence-scoped). One throwaway
Player (`SLICE3-PLAYER`, `recBwDlY2PfVwK6fS`, deleted) with an Active
Player Session Link on `SLICE3-ACCESS`; Archie Atkinson (parent.a's
existing verified child) given one additional, temporary Active Player
Session Link onto `SLICE3-DISPLAY` for the display scenarios (deleted
after, no effect on his TEST-A/TEST-B links). A single Occurrence Staff
row per session was created once and then mutated through each state via
real Airtable writes between real HTTP calls, rather than creating a new
row per state, to keep the fixture footprint minimal. `coach.a`,
`coach.b`, `manager`, `parent.a` Supabase Auth passwords were reset via
SQL (`crypt()` on `auth.users`, same technique as prior slices) to sign
in for real JWTs via `pg_net` (this sandbox cannot reach `supabase.co`
directly).

1. **No Occurrence Staff -> normal Session Staff resolves**: real calls
   to both `/hub-content/players` (as `coach.a`) and `/parent-hub/me` (as
   `parent.a`) before any Occurrence Staff row existed showed baseline
   Lead Coach access/display only, on both throwaway sessions.
2. **Additive Occurrence Staff affects only one occurrence**: `Coach`-
   role `Additional` row -> the added coach (Sam Sample) gained access/
   display on the linked occurrence; structurally impossible to affect
   any other occurrence (see "One-date isolation" above).
3. **Replacement/cover resolves the replacement coach**: same row
   switched to `Cover` + resolvable `Session Staff Source` -> Sam Sample
   resolved with access (hub-content) and as sole display name
   (parent-hub) on that occurrence.
4. **Replaced recurring coach does not retain occurrence-specific
   access**: same call - Alex Test's own real `/hub-content/players`
   response no longer contained `SLICE3-ACCESS`'s player at all.
5. **Recurring coach still resolves on surrounding dates**: cancelling
   the covered near occurrence advanced `SLICE3-DISPLAY`'s real `next_
   occurrence` to the unrelated far one, whose display reverted to Alex
   Test only - Sam Sample did not carry forward.
6. **Lead Coach Occurrence Staff gets player access**: `Actual Role
   Snapshot = "Lead Coach"` on an Additional row -> Sam Sample got full
   access including `can_edit_idp: true`.
7. **Coach Occurrence Staff gets player access**: covered under items 2
   and 3 above - `Coach`-role rows granted access in both the additive
   and cover states.
8. **Learning Coach Occurrence Staff does not get player data**:
   `Additional` row with `Planned Role Snapshot = "Learning Coach"` ->
   Sam Sample held a real Occurrence Staff row but got zero access,
   while Alex Test's own unaffected access was reconfirmed in the same
   call.
9. **Parent coach display reflects occurrence-specific replacement**:
   item 3's parent-hub result, `coaches: ["Sam Sample"]` only.
10. **Additive parent display returns both valid coaches**: item 2's
    parent-hub result, `coaches: ["Alex Test","Sam Sample"]`.
11. **Inactive/withdrawn Occurrence Staff ignored**: `Attendance =
    "Absent"` on an otherwise-valid Coach-role row -> zero access, row
    fully ignored.
12. **Invalid/incomplete Occurrence Staff fails closed**: `Coach` linked,
    both role snapshots blank, no `Session Staff Source` -> zero access.
13. **Role snapshot precedence behaves as documented**: `Actual Role
    Snapshot = "Learning Coach"` with a conflicting `Planned Role
    Snapshot = "Coach"` and a `Session Staff Source` resolving to Lead
    Coach -> still zero access (Actual won outright).
14. **Session Staff Source trace does not change staffing semantics**: a
    standalone `Additional` row with `Session Staff Source` left blank,
    only `Actual Role Snapshot` set -> resolved to full Coach-role access
    exactly as with a Source present.

All exact throwaway record ids were captured at creation and deleted by
those exact ids afterward (`SLICE3-ACCESS`/`SLICE3-DISPLAY` Sessions,
their Session Staff/Session Occurrence/Player Session Link rows, the
throwaway Player, and both Occurrence Staff rows) - re-confirmed via
`contains "SLICE3"` searches across Sessions, Session Occurrences,
Occurrence Staff and Players: zero results. TEST-A (`rec4cME6ncL4IAvlK`)
and TEST-B (`recklh0OeaAMakQCJ`) were never targets of any write this
slice; their data was read incidentally as part of the same real
`coach.a`/`coach.b`/`parent.a` HTTP responses used for regression below
and confirmed unchanged.

**Transient flake noted, not a regression**: the very first real
`/hub-content/players` call as `coach.a` (fired seconds after creating
the throwaway fixtures) returned `200 []` - a legitimate empty response,
not an error - while an identical immediate retry, and every subsequent
call, returned the correct TEST-A + throwaway rows. Given the retry and
every later call were consistently correct, and the deployed code's own
logic was independently confirmed correct via the `diff` check above,
this is treated as a one-off Airtable-API-level timing hiccup
immediately after a burst of writes, not a defect in the resolver.

### Regression

- `coach.a`/`coach.b` real `/hub-content/players` responses (captured
  throughout the verification above) continued to show their
  pre-existing TEST-A/TEST-B rows unchanged - Alex still sees TEST-A's
  Archie and Bella, Sam still sees TEST-B's Dylan/Charlie/Archie
  (including Archie's separate former-access row), same tiers and
  permissions as every prior slice's baseline.
- `parent.a`'s real `/parent-hub/me` response continued to show Dylan
  Davies' paused TEST-B session and Archie Atkinson's active TEST-A/
  TEST-B sessions with unchanged `next_occurrence` dates and coach lists
  (`["Sam Sample","Alex Test"]` for TEST-B), the ended TEST-B link, and
  the one pending claim (Bella Brown) - all identical to the Slice 2
  baseline.
- Slice 2's own effective-dated handover (Danny -> Tom -> Joe) and the
  Lead Coach/Coach/Learning Coach security rule were re-run as part of
  the full suite below and remain green, unaffected by Slice 3's
  additions (both are the `occurrenceContext`-omitted code path, byte-
  identical to before this slice).
- Full TEST suite (`node tests/run-all.js`), run after both deploys were
  verified byte-identical: **50/50 test files passed**, including this
  slice's own `access-resolution.test.ts` (**75/75** individual
  assertions) and `session-coaches.test.ts` (**22/22**), plus
  `nextoccurrencetest.js` (19/19) and `sessionaccesstest.js` (28/28)
  covering Parent Hub next-occurrence and `/hub-content/players`
  respectively. Schedule-foundation tests (Slice 6-10:
  `sessiongeneratortest.js`, `propagationtest.js`, `dailytopuptest.js`,
  etc.) remain green in the same run, untouched this slice.

### Production isolation

No production Airtable, production Supabase, frontend, Google Sheets or
finance code/data was read or written at any point in this slice - every
Airtable call targeted the TEST base `appQktredAuGa1X7e`, every Supabase
call targeted the TEST project `dkqubldmfyeuudecxmvh`, and both deployed
Edge Functions retain their unchanged TEST DEPLOYMENT GUARD.

**Coaches Slice 3 is ready for Slice 4 retirement of the Sheets-based
cover access path.**

Do not start Slice 4 automatically.

## Coaches Foundation — Slice 4 (retire legacy Sheets-based cover access) — 2026-09-27

TEST-only. Production Airtable/Supabase, frontend, Google Sheets and
finance untouched throughout. This slice is a controlled retirement/
cutover, not a rebuild - no new cover-request functionality was built.
Google Sheets themselves were never touched; only this TEST backend's
dependency on the published Changes tab for player-data access was
removed.

### Inspection before changing

Every live path involved in the legacy cover mechanism was re-read
before any code changed:
- `coverSessionIds` / `coachCoverCapabilities` - the two `ResolveInput`
  fields feeding the "cover" tier branch inside `resolvePlayerAccess()`
  (hub-content/player-access.ts).
- `resolveCoverSessionIds()` (hub-content/index.ts) - fetched the
  published Changes Google Sheet CSV and matched `type=cover` rows to
  the caller by name, pinned to the exact current date (week_commencing
  + day).
- `coachOwnStandingCapabilities()` (player-access.ts) - gave a covering
  coach some capability floor (their highest-priority role on any OTHER
  session), since the old single "Coach Role" field this used to read
  is itself retired.
- `coachIdentityKeys()` / `STATIC_COACH_ALIASES` (player-access.ts) -
  free-text schedule-name matching.
- `CHANGES_CSV_URL` and its date-parsing helpers
  (`mondayOf`/`parseDateOnly`/`isoDateUTC`/`DAY_OFFSET`, hub-content/
  index.ts) - the Sheet-fetching plumbing.

This inspection also surfaced a **second, distinct** legacy mechanism
that must NOT be touched this slice: the "LEGACY - Assigned Coaches"
fallback (`capabilitiesForCoach()`, `legacyFallbackPerms()`, the
`legacy_assigned_coaches` Feature Control-gated block in
`handlePlayers()`). That path is for players not yet migrated onto
Player Session Links, reads a direct Airtable link (`Assigned Coaches`)
matched against the caller's own `airtablePersonId` - no free-text
matching, no Google Sheet, nothing in the brief's retirement list. It is
untouched, exactly as it was before this slice.

Also confirmed: `coachIdentityKeys()`/`STATIC_COACH_ALIASES`/
`buildScheduledCoachNameKeysBySessionId()` have a SECOND caller besides
the now-removed cover tier -
`eligibleCoachIdsForSessionSnapshot()` (player-sessions' former-player-
snapshot helper, dormant - no TEST copy of player-sessions exists yet).
That is the deciding fact for what got deleted vs retained below.

### What was retired

- **hub-content/player-access.ts**: `coverSessionIds`/
  `coachCoverCapabilities` removed from `ResolveInput`. The access
  decision inside `resolvePlayerAccess()` is now exactly:
  `sessionStaffCapabilitiesForSession()` (Session Staff, optionally
  overlaid by Occurrence Staff - Slice 3) or nothing - no
  `isCovering`/fallback branch exists any more. `tier` is now always
  `"permanent"` on that path (the only other tiers a coach can ever see
  are `"former"`, from the unrelated end-of-membership snapshot). Dead
  function `coachOwnStandingCapabilities()` deleted (its only caller was
  the removed branch).
- **hub-content/index.ts**: `resolveCoverSessionIds()` and its private
  date helpers (`mondayOf`/`parseDateOnly`/`isoDateUTC`/`DAY_OFFSET`)
  deleted. `CHANGES_CSV_URL` constant deleted - this file no longer
  fetches the Changes tab at all (`fetchCsvObjects()`/`csvObjects()`
  themselves are retained; `FINANCIALS_CSV_URL`'s handler still uses
  them). The `coachNameKeys = coachIdentityKeys(...)` call site and the
  `sessionRecordBySessionId` map that only ever fed the cover lookup
  were removed from `handlePlayers()`. Import list trimmed
  (`coachIdentityKeys`, `coachOwnStandingCapabilities`, `nameKey` no
  longer imported here - each is either deleted or has no remaining
  caller in this file).

### What was deliberately retained (and why)

- **`coachIdentityKeys()`, `STATIC_COACH_ALIASES`,
  `buildScheduledCoachNameKeysBySessionId()`, `splitCoachNames()`,
  `nameKey()`** (all in player-access.ts) - still exported, still used,
  but their only remaining live caller in this codebase is now
  `eligibleCoachIdsForSessionSnapshot()`, the former-player-snapshot
  helper documented as its own out-of-scope legacy debt below. Not
  deleted, per the brief's own instruction: "if still used elsewhere,
  leave them, document the remaining caller."
- **`fetchCsvObjects()`/`csvObjects()`/`csvHeaderKey()`/
  `parseCsvRows()`** (hub-content/index.ts) - still used by
  `handleSessionParticipants()` for the unrelated Financials CSV. Only
  `CHANGES_CSV_URL` (the one constant that fed the retired cover lookup)
  was removed; the generic CSV machinery stays.
- **`AccessTier` type's `"cover"` literal** (player-access.ts) - kept in
  the type union even though nothing in this TEST backend produces it
  any more. The frontend (`coach.js`'s `player.tier==='cover'` badge,
  `feedback.js`'s equivalent check) still has display code that reads
  it - out of scope to touch this slice ("do not modify frontend"). A
  value the type permits but no code emits is harmless; removing it
  would be a type-surface change with no behavioural benefit.
- **The LEGACY - Assigned Coaches fallback** (`capabilitiesForCoach()`,
  `legacyFallbackPerms()`) - a different legacy mechanism entirely (see
  "Inspection" above), not part of this slice's retirement list, fully
  untouched.
- **`displayName` on `resolveCaller()`'s return value** (hub-content/
  index.ts) - originally added for the cover tier's identity matching,
  now unused in this file, but left in place since it costs nothing
  extra (already part of the same `profiles` row fetch) and may serve a
  future caller. Its own comment updated to say so.

### Former-player snapshot - remaining Coaches-foundation debt (documented, not touched)

`eligibleCoachIdsForSessionSnapshot()` (player-access.ts) is a SEPARATE
legacy name-matching path around former-player snapshots - it decides,
at the moment a Player Session Link ends, which coaches get captured
into that link's frozen "Coaches At End" list (later read by the
`"former"` tier in `resolvePlayerAccess()`, itself unaffected by this
slice). It still matches coaches against the published Sessions Sheet's
free-text `coaches` column via `coachIdentityKeys()`/
`buildScheduledCoachNameKeysBySessionId()`, not Session Staff. Its own
existing comment already states why: it is only called from
player-sessions' `handleEndLink()`, which has **no TEST copy yet**, so
this function is currently dormant in TEST (never invoked by any
deployed TEST Edge Function) - the Coaches Foundation Audit and Slice 2
both already flagged this as separate, deferred debt. Per this slice's
explicit instruction ("do not silently rewrite that ... unless directly
coupled to the cover-tier removal"), it was NOT touched: it is not
coupled to player access itself (a different link-ending snapshot
concern), and rewriting it to use Session Staff is real design work
(deciding a Session-Staff-based equivalent of "scheduled on this session
per the Sheet") that belongs to whoever ports player-sessions into TEST.
Remains exactly as before, unit-tested, unreferenced by any live route.

### Required backend behaviour after cutover - proven

All via the Slice 3 resolver (`resolveOccurrenceStaffing()`/
`sessionStaffCapabilitiesForSession()`), unchanged this slice, now the
sole staffing source:
- Coach assigned through valid Occurrence Staff (Lead Coach or Coach)
  gets appropriate date-specific access - unit tests items 6/7, real
  TEST Scenario B below.
- Learning Coach via Occurrence Staff gets no player-profile/data access
  - unit test item 8 (re-run, unaffected by this slice's removal).
- A replaced recurring coach does not retain access on the replaced date
  - unit test item 4, real TEST Scenario C below.
- Surrounding dates still resolve from effective-dated Session Staff -
  unit test item 5 (re-run); structurally guaranteed by
  `occurrenceIdForSessionToday`/`buildOccurrenceStaffByOccurrenceId()`
  only ever supplying the ONE occurrence's own rows for a given date, a
  guarantee this slice did not touch.
- A Sheet Changes row by itself grants zero access - new unit test item
  6, real TEST Scenario A below.
- A free-text name/alias match by itself grants zero cover access - new
  unit test item 7.

### Fail-closed confirmation

No fallback path exists any more for a missing/invalid Occurrence Staff
fact. `sessionStaffCapabilitiesForSession()` returns `null` whenever the
coach has no applying Session Staff row AND (no occurrence today, or no
usable/resolvable Occurrence Staff entry for them) - `resolvePlayerAccess()`
then simply `continue`s past that session for that coach, exactly as it
already did for "no access" before this slice; there is no longer a
second branch that could have inferred access from anything else. A
legacy Sheet entry can never become a security fallback because the
function that used to read the Sheet for this purpose no longer exists.

### Parent Hub - confirmed unchanged, no retirement needed

Parent Hub (parent-hub/index.ts) was inspected fresh this slice and
confirmed to have never had a Changes-sheet/free-text cover mechanism of
its own - Slices 2/3 already made it exclusively Session Staff +
Occurrence Staff based (`resolveSessionCoachNames()`/
`resolveOccurrenceRoster()`). Its only fetches are to the Airtable REST
API; no Google Sheets CSV is fetched anywhere in this file (confirmed by
grepping every `fetch(` call site). The only "Cover" strings in this
file are Occurrence Staff's own `Assignment Type = "Cover"` value
(Slice 3's mechanism, unrelated to the retired Sheet tier). **No file in
parent-hub changed this slice; it was not redeployed.** Its
`next_occurrence` resolution and coach display were re-verified live
(see Regression below) and remain correct.

### Focused tests

All ten required items, in `tests/support/access-resolution.test.ts`
(regenerated mirror in `tests/support/player-access.ts`):
1. Occurrence Staff Coach gives date-specific player access - item 7
   (Slice 3 section).
2. Occurrence Staff Lead Coach gives access - item 6.
3. Occurrence Staff Learning Coach does not - item 8.
4. Replacement removes replaced coach access for that occurrence - item
   4.
5. Surrounding occurrence uses Session Staff normally - item 5/5b.
6. Legacy Sheet Changes entry alone gives zero access - **new**, item 6
   (top-level numbering): a plausible `type=cover`/`coach_in`/
   `week_commencing`/`day`/`session_id` row exists as inert fixture data;
   `resolveFor()`'s `ResolveInput` has no field to consume it at all
   (`coverSessionIds`/`coachCoverCapabilities` no longer exist on the
   type), and the coach it names (Sam, on Session A where she holds no
   Session Staff row) resolves zero access.
7. Alias/free-text match alone gives zero cover access - **new**: a
   coach named "Jacko" resolves via `coachIdentityKeys()`/
   `STATIC_COACH_ALIASES`'s `jack -> Jacko` entry (proving the utility
   still works correctly, retained for item 15's dormant path) but,
   holding no Session Staff or Occurrence Staff row anywhere, gets zero
   access via `resolvePlayerAccess()`.
8. Invalid/incomplete Occurrence Staff fails closed - item 12a/12b.
9. Additive Occurrence Staff still works - item 2.
10. Slice 2 effective-dating still works - the Danny/Tom/Joe handover
    section (unchanged, re-run).

Superseded/removed: the two old cover-tier tests ("Covering a session
with no Session Staff row... -> cover tier" and "coach whose only
standing role is Learning Coach gets nothing from covering") could no
longer compile against the new `ResolveInput`/`resolveFor()` shape (no
`coverSessionIds` parameter exists) - replaced by items 6/7 above, which
prove the same "no fallback access" property the retirement itself is
about, rather than the removed mechanism's old behaviour. The
`coachOwnStandingCapabilities()` unit test was retired outright (the
function no longer exists); its numbered slot is marked retired, not
reused, so the file's history against prior slices stays legible.
`access-resolution.test.ts`: **74/74** individual assertions (net -1
after removing two obsolete assertions and one now-dead standing-role
test, adding two new ones). `session-coaches.test.ts` (parent-hub,
untouched): **22/22**, unaffected as expected.

### Deploy

`hub-content` v9 (project `dkqubldmfyeuudecxmvh`) - `index.ts` +
`player-access.ts`. Deployed content downloaded and `diff`'d
byte-for-byte against the local repo files after deployment; confirmed
identical for both files. `parent-hub` was NOT redeployed this slice
(no source change - see "Parent Hub" above); still the same version and
digest as the end of Slice 3.

### Real TEST verification - all three required scenarios, real HTTP via `pg_net`

One throwaway Session, `SLICE4-ACCESS` (`recIBhTYumvbkpVPL`, deleted),
with one Session Staff row (Alex Test/`coach.a`, Lead Coach, Active, no
date bounds), one throwaway Player (`SLICE4-PLAYER`, `recEXCVHQJIHA459K`,
deleted) with an Active Player Session Link, and one Session Occurrence
dated exactly the real test date (2026-09-27, confirmed via a live
`select now()` immediately before creating it). One Occurrence Staff row
was created once and mutated through each scenario's state via real
Airtable writes between real `GET /hub-content/players` calls, same
minimal-footprint convention as Slice 3. `coach.a`/`coach.b`/`parent.a`
signed in fresh for real JWTs via `pg_net` (this sandbox cannot reach
`supabase.co` directly; the Slice 3 JWTs had already expired, so all
three re-authenticated with the same TEST-only password set in Slice 3).

- **A. Old-path-only case**: called `GET /hub-content/players` as
  `coach.b` (Sam Sample) against `SLICE4-ACCESS` BEFORE any Occurrence
  Staff row existed - the functional situation the old Changes-sheet
  mechanism would have represented as a "cover" entry for Sam on this
  session. Real result: Sam's response contained no `SLICE4-ACCESS` row
  at all - **zero cover player access**, exactly as required; there is
  no mechanism left that could have granted it.
- **B. New-path case**: created one Occurrence Staff row (`Coach` = Sam
  Sample, `Assignment Type = "Additional"`, `Attendance = "Planned"`,
  `Planned Role Snapshot = "Coach"`) linked to the occurrence. Real
  result: Sam's next call showed `SLICE4-ACCESS`'s player with
  `tier: "permanent"` and Coach-level permissions (`can_edit_idp:
  false`, `can_edit_feedback`/`can_edit_attendance: true`) -
  **correct date-specific access** via Occurrence Staff alone.
- **C. Replacement case**: same row switched to `Assignment Type =
  "Cover"` with `Session Staff Source` pointing at Alex's own Session
  Staff row. Real result, same call pair: Sam's response still showed
  the player (`tier: "permanent"`); Alex's own real
  `GET /hub-content/players` response no longer contained
  `SLICE4-ACCESS`'s player at all - **replacement has correct access,
  replaced coach does not, for that occurrence**. The Occurrence Staff
  row was then deleted outright (not just reverted) and Alex's real
  `/hub-content/players` response was called a third time: full access
  returned immediately (`can_edit_idp: true`, Lead Coach), proving
  Alex's underlying Session Staff record was never mutated by any step
  of this scenario - **surrounding-date/state isolation holds**, on the
  same live occurrence the replacement had just used.

All exact throwaway record ids were captured at creation and deleted by
those exact ids afterward (Session, Session Staff, Player, Player
Session Link, Session Occurrence, Occurrence Staff) - re-confirmed via
`contains "SLICE4"` searches across all six tables touched: zero
results. TEST-A/TEST-B were never write targets this slice.

### Regression

- Real `GET /hub-content/players` as `coach.a`: TEST-A unchanged (2
  rows, Archie + Bella, as every prior slice's baseline).
- Real `GET /hub-content/players` as `coach.b`: TEST-B unchanged (4
  rows - Archie former, Dylan, Archie permanent, Charlie - identical to
  the Slice 3 baseline).
- Real `GET /parent-hub/me` as `parent.a`: TEST-B's coach display still
  `["Sam Sample","Alex Test"]`; TEST-A's `next_occurrence` still the
  same rescheduled Wednesday 7 Oct entry - identical to the Slice 3
  baseline, confirming Parent Hub (never redeployed this slice) is
  unaffected.
- Slice 2 effective-dating (Danny -> Tom -> Joe handover) and the Lead
  Coach/Coach/Learning Coach security rule re-ran as part of the full
  suite below and remain green - both are code paths this slice did not
  touch.
- Slice 3 Occurrence Staff resolution (additive/cover/precedence/
  fail-closed) re-ran as part of the full suite and remains green - the
  resolver functions themselves (`resolveOccurrenceStaffing()`,
  `sessionStaffCapabilitiesForSession()`'s occurrence-context branch)
  were not modified this slice, only the fallback branch AROUND them was
  removed.
- Full TEST suite (`node tests/run-all.js`), run both before deploying
  (to confirm the rewritten test file was internally consistent) and
  again after deployment: **50/50 test files passed** both times,
  including `access-resolution.test.ts` (74/74) and
  `session-coaches.test.ts` (22/22). Schedule-foundation tests (Slice
  6-10) remain green in the same runs, untouched this slice.

### Production isolation

No production Airtable, production Supabase, frontend, Google Sheets or
finance code/data was read or written at any point in this slice - every
Airtable call targeted the TEST base `appQktredAuGa1X7e`, every Supabase
call targeted the TEST project `dkqubldmfyeuudecxmvh`, `hub-content`
retains its unchanged TEST DEPLOYMENT GUARD, and `parent-hub` was not
touched or redeployed at all. The published Google Sheets themselves
(Sessions and Changes tabs) were never read, written, or otherwise
modified this slice - only this backend's own dependency on fetching the
Changes tab for player access was removed from the code.

**Coaches Slice 4 is ready for Slice 5 rates and historical coach-cost
foundation.**

Do not start Slice 5 automatically.

## Coaches Foundation — Slice 5 (rates + historical coach-cost foundation) — 2026-09-27

TEST-only. Production Airtable, production Supabase, frontend and Google
Sheets untouched throughout. Backend/data-layer foundation only - no
invoicing, payroll, payments, work-summary finalisation, cancellation/
weather rules, or UI were built this slice, per the brief.

### Schema re-read first, nothing invented

Coach Rate Profiles (`tblNWi46U7igzvRHx`) and Coach Allocations
(`tbl6iWEd6Asj0dFMe`), both mirrored schema-only in Slice 1, were
re-read fresh via `get_table_schema`/`list_tables_for_base` before any
code was written. Two facts from that re-read directly shaped the
design below and are the reason several boundaries in this slice are
deliberately narrow rather than "helpful":
- **No precedence/priority field exists** anywhere on Coach Rate
  Profiles - nothing like a "Preferred"/"Priority" flag a resolver
  could use to break a tie between two overlapping Active rows of the
  same Rate Type. This is the reason ambiguity is reported rather than
  silently resolved (see "Ambiguity" below).
- **Allocation ID is a plain `singleLineText`**, not a formula-derived
  key the way Session Occurrences' `Occurrence Key` is (Slice 2). There
  is no schema-level uniqueness constraint Coach Allocations could lean
  on. This is the reason idempotency is an application-level check
  against real Coach+Session Occurrence links, not a hidden convention
  (see "Idempotency" below).

### New Edge Function: `coach-allocations`

A brand-new, isolated TEST Edge Function (project `dkqubldmfyeuudecxmvh`)
- no existing file was modified this slice. Four files, following the
same layering that worked well for Schedule/`session-occurrences`:
- **`coach-rates.ts`** - pure resolution/calculation logic, no
  Airtable/Supabase/network calls anywhere in the file. Directly
  unit-testable against plain fixture data.
- **`repository.ts`** - Airtable I/O only, portable (no `Deno.*`
  anywhere, plain `fetch()` with an explicit `AirtableConfig`), so the
  same file runs unchanged under Node (unit tests, mocked `fetch`) and
  Deno (the real deployed function) - same convention as
  `session-occurrences/repository.ts`.
- **`orchestrator.ts`** - composition layer exposing
  `createCoachAllocationForOccurrence(deps, input)`, the exact function
  name the brief asked for. Sequences validation -> Coach/Occurrence
  existence -> idempotency check -> rate resolution -> cost calculation
  -> create, and turns the outcome into one discriminated union a
  caller can switch on.
- **`index.ts`** - thin Deno HTTP wrapper. Same TEST DEPLOYMENT GUARD
  boilerplate as every other TEST function (refuses to boot against
  either known production Airtable base id). Same
  `resolveCaller()`/`requireManagement()` pattern as `hub-content`/
  `parent-hub`/`session-occurrences` - every route below is
  Management-only.

Routes: `POST /resolve-rate` (resolve only, no write - lets rate
resolution be exercised/verified independent of creating an
allocation), `POST /allocate` (create, snapshotting the resolved
profile), `GET /allocation?id=` (pure read-through, never re-reads
Coach Rate Profiles).

### Rate Profile resolution rule

`rateProfileAppliesOnDate(row, dateIso)` - deliberately the SAME
inclusive-date-range principle as Session Staff's
`sessionStaffAppliesOnDate()` (Slice 2), not re-invented: `Active` is
checked first and is absolute (`Active !== true` excludes the row
regardless of dates); then `Effective From`/`Effective Until` decide
whether an enabled row applies on THIS work date - **both inclusive**,
both independently optional (blank `Effective From` = applies from the
start of time; blank `Effective Until` = applies indefinitely; both
blank = applies whenever Active). Fails closed on malformed data: a
non-blank date string that isn't a valid `"YYYY-MM-DD"` excludes the
row rather than being treated as absent.

`resolveCoachRateProfile(coachId, dateIso, rateType, rateProfileRows)`
filters a Coach's Rate Profile rows by exact Coach match, exact Rate
Type match, and `rateProfileAppliesOnDate`, returning a discriminated
union:
- `{status:"resolved", profile}` - exactly one match.
- `{status:"missing"}` - zero matches. Never a fallback guess.
- `{status:"ambiguous", candidates}` - two or more matches. See
  "Ambiguity" below.

### Rate selection boundary (why Rate Type is a caller-supplied parameter)

The brief explicitly asked whether Rate Type (Day/Evening/Camp/
Additional-Plus) could be inferred automatically from the Session/
Occurrence itself. Sessions' own `Category` field was checked and
confirmed to be free `singleLineText`, not a controlled vocabulary -
its real values (things like "Evening"/"Trials") are used for
public-facing marketing categorisation, with no guarantee of aligning
with Coach Rate Profiles' own Rate Type choice set. Treating it as a
reliable source would be inventing an accounting rule the schema
doesn't actually back, so this slice keeps Rate Type an **explicit
caller-supplied parameter**: "Given Coach + work date + intended Rate
Type, resolve the correct Rate Profile" is exactly what `/resolve-rate`
and `/allocate` do, no more. No hidden time-of-day rule (e.g. "after
5pm = evening") was built.

### Ambiguity - fail-safe, never silently resolved

Because no precedence field exists on the real schema (confirmed
above), two or more Active, date-applicable Rate Profiles of the SAME
Rate Type for the same Coach on the same date resolve to
`{status:"ambiguous", candidates:[...]}` - both/all candidates
returned, neither silently preferred. `/resolve-rate` reports this as
HTTP 409; `/allocate` refuses to create anything and reports the same
candidate list as HTTP 422. Unit test item 14.

### Coach Allocation snapshot rule (the non-negotiable core principle)

`buildAllocationCreatePayload()` (`repository.ts`) is the ONE place the
snapshot is written: `Rate Profile` (link), `Rate Type Snapshot`, `Pay
Unit Snapshot`, and `Rate Amount Snapshot` are copied from the
RESOLVED Rate Profile's fields as **plain values, not live
references**, at the exact moment the allocation is created. A later
edit to that same Rate Profile row can never reach back and change an
already-created allocation - nothing in this Edge Function ever
re-reads a Rate Profile's live `Amount` to answer a question about an
existing allocation (`fetchAllocationById()` reads only the Coach
Allocations table itself). Proven in a unit test (item 10, by mutating
the in-memory profile object AFTER the payload is built) and in real
TEST HTTP verification below (the October Rate Profile's `Amount` was
edited live, after allocation creation, and the allocation's own
snapshot did not move).

### Effective dating

Rate resolution always uses the caller-supplied `workDateIso` (the
occurrence/work date), never "today" - `resolveCoachRateProfile()` has
no other notion of "now" anywhere in it. Verified live: a 28 Sep
occurrence resolved the £25 profile, a 3 Oct occurrence resolved the
£30 profile, from the same two-row Rate Profile set, both boundaries
inclusive (unit test items 3-9; real TEST verification below).

### Pay Unit interpretation

Documented, not enforced as a hard rule (per the brief: "do not
overcomplicate the model" / "stop and report rather than invent
accounting rules"). `PAY_UNIT_INTERPRETATION` in `coach-rates.ts`:
- **Per Hour** - Paid Units represents the number of hours worked.
- **Per Session** - Paid Units is normally 1 (one session's worth of
  work).
- **Per Day** - Paid Units is normally 1 (one day's worth of work).

`calculateStandardCost(rateAmount, paidUnits)` is always
`roundCurrency(rateAmount * paidUnits)` regardless of Pay Unit - Pay
Unit changes what a human is expected to enter for Paid Units, not the
arithmetic. This slice does NOT hard-enforce "Paid Units must be 1" for
Per Session/Per Day, since Management may legitimately need e.g. two
sessions covered in one allocation; enforcing that would itself be
inventing an accounting policy the brief said to avoid. Unit test item
11.

### Override behaviour

`resolveFinalCost({rateAmount, paidUnits, costOverride})` returns
`{standardCost, finalCoachCost, overridden}`. `standardCost` is always
the normal calculation, kept visible even when an override applies
(there is no dedicated schema field for it, so it is surfaced in the
API response, not persisted separately). When `costOverride` is
non-null, `finalCoachCost` is the override (rounded); otherwise it
equals `standardCost`. Critically, an override **never touches** the
Rate Profile snapshot fields - `Rate Profile`/`Rate Type Snapshot`/
`Pay Unit Snapshot`/`Rate Amount Snapshot` stay exactly what the
resolved profile gave; only `Final Coach Cost` changes, and `Cost
Override`/`Override Reason` are written alongside it. The Coach's
underlying Rate Profile row is never edited because of a one-off deal.
`validateCreateAllocationInput()` enforces that a non-null
`costOverride` REQUIRES a non-blank `overrideReason`, failing closed
(a validation-error string, HTTP 400) rather than silently accepting an
unexplained override. Unit test items 12-13; real TEST verification
below.

### Idempotency / uniqueness approach

Because no schema-level uniqueness key exists on Coach Allocations
(confirmed above - `Allocation ID` is plain text, not
formula-derived), the model adopted is **application-level**: at most
one Coach Allocation per (Coach, Session Occurrence) pair.
`fetchAllocationsForCoachAndOccurrence()` queries the real `Coach`/
`Session Occurrence` links already on the table before any create; if
one is found, `createCoachAllocationForOccurrence()` returns
`{status:"existing", recordId}` instead of creating a duplicate - no
write happens at all on the second call. This is an application-level
check against data the schema genuinely provides, not a hidden
convention written into some other field, and is documented here as
exactly that per the brief's "stop and report rather than invent"
instruction. A genuine future need for more than one allocation per
(Coach, Occurrence) pair (e.g. split cost across two Rate Types for one
occurrence) is new product design, not something this function silently
allows. Unit test item 16 (mocked-fetch orchestration test, confirming
only one real Airtable create call happens across two identical calls);
reconfirmed live below against the real deployed function.

### Staffing-vs-financial-allocation boundary

`createCoachAllocationForOccurrence()` is never called automatically
from any Session Staff/Occurrence Staff write path anywhere in this
codebase - creating a paid allocation for a piece of work is always an
explicit, separate call. "Who is operationally assigned" (staffing,
Slices 2-3) and "the financial record for that work" (allocation, this
slice) are related but distinct facts; Slice 5 exposes
`createCoachAllocationForOccurrence(...)` as a clean function but does
not wire it to any staffing write path. If an automatic trigger (e.g.
"creating an Occurrence Staff row of a certain Assignment Type also
creates a Coach Allocation") turns out to be needed, that is a future
integration point requiring its own product decision, not something
this slice inferred.

### Future cancellation/reschedule financial outcome - documented, not implemented

Recorded here as the already-agreed future rule, per the brief, with no
code built against it this slice: when an occurrence is cancelled or
rescheduled, Management should eventually confirm - is the coach being
paid, is the venue being paid, is credit being added to the parent? For
a reschedule specifically: the original occurrence retains its own
financial outcome; the replacement occurrence has its own costs entirely
separately (no cost/outcome is ever transferred or merged between the
two). This belongs to later Coach/Finance logic, not this slice.

**Correction (Slice 6):** the sentence above and the "Unresolved -
deferred to Slice 6" note that originally followed it both implied a
5-hour cancellation rule and a 10-minute weather rule were the expected
shape of that later work. They were superseded before being built.
Coaches Slice 6 implemented the actual approved model instead: explicit
per-occurrence Management decisions (Coach Paid/Unpaid/Partial, Parent
Credit/Refund/None, Venue Paid/Credit/None - not a single shared
Paid/Unpaid/Partial across all three, as this section used to say).
Organisation settings may later suggest defaults, but no universal
automatic payment rule - time-based, weather-based, or otherwise - is
assumed. See the Coaches Foundation — Slice 6 section below for the full
write-up. No automatic 5-hour/weather logic exists anywhere in this
codebase, TEST or production.

### Security

Every `coach-allocations` route is Management-only, using the identical
`resolveCaller()`/role-check convention as every other TEST function's
Management routes - resolves the Supabase Auth JWT to a `profiles` row
and requires `role === "management" && active === true`, else 401/403.
No separate auth path was invented; the platform's own `verify_jwt` stays
required. Verified live below with both a Management JWT (succeeds) and
a Coach JWT (403 "Management access required").

### Focused tests

All 16 required items, in `tests/support/coach-allocations.test.ts`
(mirrors of `coach-rates.ts`/`repository.ts`/`orchestrator.ts` kept by
hand in `tests/support/` under domain-prefixed names, same convention
as `session-repository.ts`/`session-orchestrator.ts`):
1. One Active, applicable, matching-type Rate Profile resolves.
2. `Active = false` is ignored (fails closed to missing).
3. A date one day before `Effective From` is excluded.
4. A date one day after `Effective Until` is excluded.
5. Exactly on `Effective From` resolves (inclusive).
6. Exactly on `Effective Until` resolves (inclusive).
7. Blank `Effective From` applies far in the past (open-ended).
8. Blank `Effective Until` applies far in the future (open-ended).
9. Rate transition: 28 Sep resolves £25, 3 Oct resolves £30, from the
   same two-row set (9a/9b).
10. A later edit to the same Rate Profile object does not alter an
    already-built allocation payload's snapshot/cost.
11. Normal Final Coach Cost = Rate Amount Snapshot x Paid Units.
12. Cost Override changes Final Coach Cost but preserves the rate
    snapshot (12a-d: override applied, standard cost still visible,
    Rate Profile/Rate Amount Snapshot unchanged, Final Coach Cost is
    the override).
13. Override Reason is written through (13a) and required - a blank
    reason with a Cost Override fails validation (13b).
14. Two overlapping Active, same-Rate-Type profiles -> ambiguous,
    neither silently chosen.
15. No applicable Rate Profile for the Coach (15), or none of the
    requested Rate Type (15b) -> fails safely as missing.
16. Duplicate allocation attempt: first call creates (16a), a second
    identical call returns the existing record instead (16b), and only
    ONE real Airtable create call is ever made across both calls
    (16c) - proven via a mocked-`fetch` orchestration test matching
    `daily-top-up.test.ts`'s established convention.

Plus one sanity check that `KNOWN_RATE_TYPES` matches the real TEST
schema's Rate Type choices exactly (Day/Evening/Camp/Additional Plus).
`coach-allocations.test.ts`: **25/25** assertions passing.

### Deploy

`coach-allocations` v1 (project `dkqubldmfyeuudecxmvh`) - all four files
(`index.ts`, `coach-rates.ts`, `orchestrator.ts`, `repository.ts`), a
brand-new function, first deploy. Deployed content downloaded via
`get_edge_function` and `diff`'d byte-for-byte against the local repo
files after deployment; confirmed **identical** for all four files
before any real TEST HTTP verification was trusted, per the discipline
established after Slice 3's "PLACEHOLDER" incident.

### Real TEST verification - all required scenarios, real HTTP via `pg_net`

One throwaway Coach (`SLICE5-TEST Coach X`, `recRuxD2LJchLHMGo`,
deleted), one throwaway Session (`SLICE5-TEST-SESSION`,
`recHhIVw85UEK4MU5`, deleted), two throwaway Coach Rate Profiles
(Evening/Per Hour, exactly the brief's own worked example: £25 through
30 Sep - `recaAnB3UMfaweYS6`, deleted - and £30 from 1 Oct -
`recC1RffzMfyRWAFy`, deleted), and three throwaway Session Occurrences
under that Session (28 Sep `rec57wnWQZngCEAWP`, 3 Oct
`recb1HsDM9jO95BnC`, 5 Oct `recZCZVd7T4iYj1cX`, all deleted). `manager@
test.invalid` re-authenticated for a fresh Management JWT via `pg_net`
(this sandbox cannot reach `supabase.co` directly; the established
password-reset-via-`crypt()` pattern from Slices 3/4 was reused).

- **Rate resolution**: `POST /resolve-rate` for the Coach on 28 Sep,
  Rate Type Evening -> real result `{"status":"resolved",
  "rateProfileRecordId":"recaAnB3UMfaweYS6","amount":25,"payUnit":"Per
  Hour"}` - correctly resolved the September profile, not the October
  one.
- **September allocation**: `POST /allocate` (28 Sep occurrence, Paid
  Units 2) -> real result `{"status":"created",
  "recordId":"recB0m2uwhuEHwCiK","rateProfileRecordId":
  "recaAnB3UMfaweYS6","rateAmountSnapshot":25,"standardCost":50,
  "finalCoachCost":50,"overridden":false}` - **snapshots £25**, exactly
  the brief's required proof.
- **October allocation**: `POST /allocate` (3 Oct occurrence, Paid
  Units 2) -> real result `{"status":"created",
  "recordId":"recjalpeV7IaFRwMk","rateProfileRecordId":
  "recC1RffzMfyRWAFy","rateAmountSnapshot":30,"standardCost":60,
  "finalCoachCost":60,"overridden":false}` - **snapshots £30**, the
  other half of the required proof, correctly chosen by occurrence date
  from the same two-row Rate Profile set used above.
- **Historical snapshot immutability, proven live**: the October Rate
  Profile's `Amount` was then edited directly in Airtable, £30 -> £35
  (`recC1RffzMfyRWAFy`). `GET /allocation?id=recjalpeV7IaFRwMk` was
  called again immediately after: real result still showed `"Rate
  Amount Snapshot":30` and `"Final Coach Cost":60` - **unchanged**,
  proving the allocation never re-derives from the Coach's current Rate
  Profile, exactly the brief's non-negotiable core principle, proven
  against the real deployed function and real Airtable data, not just
  the unit test.
- **Override scenario**: `POST /allocate` for the 5 Oct occurrence
  (Paid Units 1, `costOverride: 40`, `overrideReason: "Covering as a
  favour - agreed flat fee"`) against the now-£35 October profile ->
  real result `{"status":"created","recordId":"recUHoSvFk0BhJ1AJ",
  "rateProfileRecordId":"recC1RffzMfyRWAFy","rateAmountSnapshot":35,
  "standardCost":35,"finalCoachCost":40,"overridden":true}`. A
  follow-up `GET /allocation?id=recUHoSvFk0BhJ1AJ` confirmed the full
  stored record: `Rate Profile` still linked to the October profile,
  `Rate Type Snapshot: "Evening"`, `Pay Unit Snapshot: "Per Hour"`,
  `Rate Amount Snapshot: 35` (the resolved profile's value, untouched by
  the override), `Cost Override: 40`, `Override Reason: "Covering as a
  favour - agreed flat fee"` (persisted), `Final Coach Cost: 40` -
  **normal calculated cost preserved, override applied to Final Coach
  Cost only, rate snapshot and reason both correct**.
- **Idempotency, proven live**: `POST /allocate` was called a second
  time with the exact same September Coach+Occurrence pair. Real result:
  `{"status":"existing","recordId":"recB0m2uwhuEHwCiK"}` - the SAME
  record id as the first call, confirming no duplicate payable work was
  created by a repeated call against the real deployed function.
- **Security, proven live**: the same `/allocate` call that succeeded as
  Management was repeated with a fresh `coach.a@test.invalid` JWT (same
  password-reset-via-`crypt()` pattern). Real result: HTTP 403
  `{"error":"Management access required"}` - a Coach cannot create or
  alter a Coach Allocation.

All exact throwaway record ids were captured at creation and deleted by
those exact ids afterward (Coach Allocations first, then Session
Occurrences, then Coach Rate Profiles, then the Session, then the
Coach) - reconfirmed via a `contains "SLICE5"` search across the Coaches
and Sessions tables: zero results. TEST-A/TEST-B were never write
targets this slice; no Session Occurrence or Coach Allocation outside
the throwaway set above was touched.

### Regression

Full TEST suite (`node tests/run-all.js`), run after deploying and
completing real TEST verification, includes `coach-allocations.test.ts`
(25/25, new this slice) alongside every prior slice's tests -
`access-resolution.test.ts` (Slices 2-4 effective dating/Occurrence
Staff/cover-tier retirement), `session-coaches.test.ts` (Parent Hub),
and the full Schedule-foundation suite (Slices 6-10). Slice 5 added one
brand-new, entirely isolated Edge Function and its own test mirrors -
no existing file (`hub-content`, `parent-hub`, `session-occurrences`,
or any of their test copies) was modified, so no other slice's staffing
or access behaviour could have changed as a side effect. Existing
staffing/access behaviour is unaffected by the introduction of
Finance/cost data, exactly as the brief required.

### Production isolation

No production Airtable, production Supabase, frontend, Google Sheets or
payment/invoice integration was read, written, or otherwise touched at
any point in this slice - every Airtable call targeted the TEST base
`appQktredAuGa1X7e`, every Supabase call targeted the TEST project
`dkqubldmfyeuudecxmvh`, and `coach-allocations` carries the same TEST
DEPLOYMENT GUARD as every other TEST function (refuses to boot against
either known production Airtable base id). This is only the TEST
coach-cost foundation - no invoicing, payroll, or payment system was
integrated.

**Coaches Slice 5 is ready for Slice 6 cancellation/weather pay-rule
decisions and implementation.**

Do not start Slice 6 automatically.

## Coaches Foundation — Slice 6 (cancellation/reschedule financial outcomes) — 2026-09-27

TEST-only. Production Airtable, production Supabase, frontend, Google
Sheets and Stripe untouched throughout. This slice replaces the
previously-discussed idea of hard-coded 5-hour cancellation / 10-minute
weather pay rules with the agreed, simpler model: **when Management
cancels or reschedules a specific occurrence, the Hub records what
actually happens financially for that occurrence, as an explicit
per-occurrence decision.** No automatic cancellation/weather payment
logic was built - see the Slice 5 corrections above, where the old
wording implying that automatic rule was still coming has been fixed.

### Schema re-read first, nothing invented

Session Occurrences, Coach Allocations, and the full production Airtable
schema (66 tables) were re-read fresh before any code or schema change.
Two findings shaped the design:
- **Session Occurrences already has everything needed for the
  cancellation/reschedule states themselves** - `Status`
  (Scheduled/Completed/Cancelled/Postponed) and the `Replacement
  Occurrence`/`From field: Replacement Occurrence` link pair from the
  Schedule foundation slices. Nothing new was added here; Slice 6 reads
  these, never writes them.
- **Production has an extensive Finance layer** (Family Credits, Family
  Credit Applications, Commercial Adjustments, Bookings, Booking Lines,
  Refund Policies, and more) that TEST does not mirror - but every one
  of those tables is an **execution/ledger** layer (real credit
  balances, Draft/Pending/Sent/Applied workflow states, amounts actually
  charged) tied to a Family/Booking, not a simple per-occurrence
  Management *decision*. Using them here would mean building the
  parent wallet/credit ledger the brief explicitly said not to build.
  Production's own Session Occurrences/Coach Allocations tables are
  structurally identical to TEST's (same fields, different ids) - no
  hidden production field for this already exists there either. Per the
  brief's own fallback ("if the current schema genuinely has nowhere
  clean to store these three outcome families, propose the smallest
  additive TEST schema"), a small additive schema was proposed and
  built, documented below.

### Final financial-outcome model

Three independent fact families per occurrence, never inferred from one
another, from occurrence Status, from coach attendance, or from time
before cancellation:
- **Coach outcome** - `Paid` / `Unpaid` / `Partial`.
- **Parent outcome** - `Credit` / `Refund` / `None`.
- **Venue outcome** - `Paid` / `Credit` / `None`.

Each supports an explicit final amount and an optional reason/note where
relevant. These are recorded **decisions**, not executed money movement:
`Parent Outcome = Refund` means "Management has decided a refund is
owed," not that a refund has been sent; `Coach Outcome = Paid` means
"this occurrence should still count as paid work," not that money has
been transferred. No Stripe refund, parent wallet/credit ledger, venue
invoice settlement, coach payment, Xero integration, or finance export
exists anywhere in this slice.

### Occurrence ownership - Coach stays on Coach Allocations, Parent/Venue get one new table

Per the brief's explicit preference ("do not duplicate coach-cost truth
onto Session Occurrences if Coach Allocations can own it cleanly"):
- **Coach outcome** lives on the existing Coach Allocation (Slice 5).
  One new `Coach Outcome` singleSelect field (Paid/Unpaid/Partial) plus
  three small audit fields (`Coach Outcome Decided By User ID`/`...Name
  Snapshot`/`...Decided At`, same "Decided/Confirmed By" convention used
  everywhere else in this schema - Session Occurrences' `Confirmed By`,
  Session History's `Changed By`, etc.). No new coach-cost table.
- **Parent outcome and Venue outcome** live on a brand-new TEST-only
  table, **`Occurrence Financial Outcomes`** - one row per Session
  Occurrence, created only when Management first makes a Parent or Venue
  decision for that occurrence (never auto-created). Both families share
  this one table (Outcome/Amount/Reason/Decided-By-User-ID/Decided-By-
  Name-Snapshot/Decided-At, x2, one set per family) since they are the
  same shape of fact about the same occurrence and splitting them into
  two tables would be "overcomplicating" for no benefit. `Outcome ID` is
  a plain human-label field (same convention as `Allocation ID`/`Rate
  Profile ID`), not a uniqueness key - see Idempotency below.

This is a new TEST-only proposal, confirmed above to have no production
equivalent; it should be reviewed by Finance/Management before any
future production promotion, same as Slice 1's TEST-only Coach Documents
verification fields.

### Reschedule separation rule

The original occurrence's financial outcomes are recorded against its
own record id; the replacement occurrence (linked via the existing
`Replacement Occurrence` field from the Schedule foundation) is a
completely separate Session Occurrence record with its own Coach
Allocations and its own (initially absent) Occurrence Financial
Outcomes row. Nothing in this slice ever reads the original's outcome to
populate the replacement's, or vice versa - `setParentOutcome`/
`setVenueOutcome`/`setCoachOutcome` all take an explicit occurrence/
allocation id and touch only that one record. Proven live below
(Scenario C): after recording Coach=Unpaid/Parent=Refund/Venue=Credit on
a Postponed original, the linked replacement occurrence's combined read
showed zero Coach Allocations and both outcomes null.

### Historical snapshot behaviour (Coach outcome)

Reuses Slice 5's model unchanged. `buildCoachOutcomePatch()` never
touches `Rate Profile`/`Rate Type Snapshot`/`Pay Unit Snapshot`/`Rate
Amount Snapshot` - only `Coach Outcome`/`Cost Override`/`Override
Reason`/`Final Coach Cost`/the new audit fields:
- **Paid** - `Final Coach Cost` is recalculated from THIS allocation's
  own already-stored `Rate Amount Snapshot x Paid Units` (never the
  Coach's current live Rate Profile), `Cost Override` cleared. This is
  the brief's "preserve the intended full payable cost."
- **Unpaid** - `Cost Override = 0`, `Final Coach Cost = 0`, using the
  existing model to represent "no coach cost" without inventing a
  second cost field.
- **Partial** - `Cost Override`/`Final Coach Cost` become the explicit
  Management-agreed amount (required - see Backend/API validation
  below); the rate snapshot basis is untouched. Proven live below
  (Scenario B): a £30 basis allocation given a Partial £15 outcome kept
  `Rate Amount Snapshot = 30` and showed `Final Coach Cost = 15`.

### Idempotency

**Coach outcome** is always an UPDATE to one specific, caller-supplied
`allocationId` - never a create - so repeating or editing a decision is
trivially idempotent/safe by construction; there is no create path to
duplicate.

**Parent/Venue outcome** uses the same application-level uniqueness
pattern as Slice 5's Coach Allocations: at most one Occurrence Financial
Outcomes row per Session Occurrence, enforced by `fetchOutcomeRowForOccurrence()`
being called before every write. If no row exists, one is created; if
one exists, it is updated in place (a genuine upsert, unlike Slice 5's
Coach Allocations, which treats a repeat as a no-op - here Management
may legitimately revise a decision, so the second call must apply the
new values, not just report "already exists"). Proven live and in unit
tests (items 14/15): a repeated identical confirmation updates the same
row and makes zero additional create calls; a later edit (e.g. Venue
Paid £50 -> Credit £30) updates the same row to the new values.

**Known limitation, documented rather than engineered around:** the
check-then-write upsert has the same theoretical race as any
check-then-act pattern without a database-level unique constraint or
transaction - two genuinely *concurrent* writes to the same occurrence's
Parent and Venue outcome (not a sequential repeat/edit, which is what
the brief's idempotency requirement actually describes) could each see
"no existing row" and both create one. This was observed once during
real TEST verification, when this session itself fired Parent-outcome
and Venue-outcome calls in parallel rather than sequentially, and was
resolved by deleting the duplicate and re-issuing the second call
sequentially (a human Management user submitting one decision at a time
would never trigger this). Airtable's REST API has no compare-and-swap
primitive to close this without building real infrastructure, which
would be "a full event-sourcing system" the brief said not to build
this slice; flagged here as a real, narrow limitation for
Finance/Management to weigh if concurrent multi-user editing of the
same occurrence's outcome becomes a real scenario, rather than silently
left undocumented.

**Resolved** - see "Post-Slice-6 hardening — Occurrence Financial
Outcome concurrency" below, closed before Slice 7 began.

### Management-only security

Every `occurrence-financial-outcomes` route (`/coach-outcome`,
`/parent-outcome`, `/venue-outcome`, `/outcomes`) is Management-only,
using `isManagementCaller()` - a small pure predicate in
`financial-outcomes.ts`, called by `index.ts`'s `requireManagement()`
rather than an inline check, so the exact deployed rule is directly
unit-testable (items 16/17) as well as proven live. Coach users cannot
decide whether they are paid; Parent users cannot assign themselves a
refund/credit. Verified live: Management JWT succeeds on all three write
routes; a Coach JWT and a Parent JWT each get 403 `"Management access
required"` on their respective attempts, and the target records were
confirmed unchanged afterward.

### Future organisation-setting defaults

Not built this slice, per the brief ("do not build Settings in this
slice"). Recorded as the agreed future shape: Organisation Settings may
later provide suggested defaults or preselected answers for Coach/
Parent/Venue outcome (e.g. a default Coach outcome for a Weather-tagged
cancellation), but Management confirmation remains the source of truth
for the final outcome - a suggested default is never silently applied
without a Management decision recording it.

### Backend/API

New, entirely isolated Edge Function `occurrence-financial-outcomes` -
no existing function was modified. Same layering as Schedule/Slice 5:
- **`financial-outcomes.ts`** - pure validation/patch-building logic, no
  Airtable/Supabase/network calls. `validateCoachOutcomeInput()`
  requires a valid non-negative `amount` when outcome is `Partial`
  (the brief: "Management provides the agreed partial amount"); a
  garbage amount supplied for Paid/Unpaid still fails closed rather than
  being silently ignored. `validateParentOutcomeInput()`/
  `validateVenueOutcomeInput()` do not require an amount (the brief left
  this open - "if amount/value is required, record it" - so an outcome
  decision can exist before Management has a number to attach) but still
  reject an invalid one if supplied.
- **`repository.ts`** - Airtable I/O only, portable (no `Deno.*`), same
  convention as every other TEST function's repository.
- **`orchestrator.ts`** - `setCoachOutcome`/`setParentOutcome`/
  `setVenueOutcome` (three separate entry points, never one shared
  "setOutcome" that could blur the families together) plus
  `readFinancialOutcomes()`, a combined read-only view (all Coach
  Allocations linked to the occurrence + the Parent/Venue row) that
  never recomputes or infers between families.
- **`index.ts`** - Management-only Deno HTTP wrapper, same TEST
  DEPLOYMENT GUARD as every other TEST function. Routes: `POST
  /coach-outcome`, `POST /parent-outcome`, `POST /venue-outcome`, `GET
  /outcomes?occurrenceId=`.

### Focused tests

All 18 required items plus a positive-control auth check and a
Coach-Outcome-choices sanity check, in
`tests/support/occurrence-financial-outcomes.test.ts` (mirrors of
`financial-outcomes.ts`/`repository.ts`/`orchestrator.ts` kept by hand
in `tests/support/` under domain-prefixed names, same convention as
Slice 5):
1-4. Cancelled occurrence + Coach Paid/Unpaid/Partial with explicit
   amount, and Partial preserves the original rate snapshot (both that
   the snapshot object itself is never mutated and that the payload
   never contains a Rate Amount Snapshot/Rate Profile/Rate Type
   Snapshot/Pay Unit Snapshot key at all).
5-7. Parent Credit/Refund/None - amount/reason recorded independently;
   None needs no amount and carries a null one rather than a stale
   value.
8-10. Venue Paid/Credit/None - same shape as Parent, independent
   validators/patch-builders.
11. All three outcome families coexist independently on one occurrence -
   proven via a mocked-`fetch` orchestration test (see below) that sets
   all three and reads back a combined view showing each exactly as set.
12-13. A rescheduled original retains its own outcomes; the linked
   replacement inherits nothing - proven via the same mocked-orchestration
   harness with two linked occurrence ids.
14. Repeated identical confirmation is idempotent - only one real create
   call across two identical calls, second call updates the same row.
15. Management can update a prior outcome safely - a later edit updates
   the same row (not a new one) and the stored state reflects the latest
   decision.
16-17. Coach/Parent JWT cannot write - `isManagementCaller()` unit-tested
   directly (a Coach-role or Parent-role caller fails; a positive-control
   Management-role/active caller passes, so these aren't vacuously
   true; an inactive Management-role caller still fails).
18. Missing/invalid amounts fail safely where amount is required - Coach
   Partial with a missing/negative/non-numeric amount all fail
   validation; an invalid (negative/NaN) Parent/Venue amount fails even
   though amount isn't strictly required for those families.

Items 11-15 use the same mocked-`fetch` orchestration convention as
Slice 5's idempotency test (item 16) and `daily-top-up.test.ts`, against
an in-memory Airtable-shaped store, so the real orchestrator/repository
code runs end to end without a real network call.
`occurrence-financial-outcomes.test.ts`: **32/32** assertions passing.

### Deploy

`occurrence-financial-outcomes` v1 (project `dkqubldmfyeuudecxmvh`) -
all four files (`index.ts`, `financial-outcomes.ts`, `orchestrator.ts`,
`repository.ts`), a brand-new function, first deploy. Deployed content
downloaded via `get_edge_function` and `diff`'d byte-for-byte against
the local repo files after deployment; confirmed **identical** for all
four files before any real TEST HTTP verification was trusted, per the
discipline established after Slice 3's "PLACEHOLDER" incident.

### Real TEST verification - all four required scenarios, real HTTP via `pg_net`

One throwaway Coach (`SLICE6-TEST Coach Y`, `recCIodJ38Hfy6Bh2`,
deleted), one throwaway Session (`SLICE6-TEST-SESSION`,
`recZd0WJfjIYIPxx6`, deleted), one throwaway Coach Rate Profile
(Evening/£30/hr, `recD93ezNbkBhTilB`, deleted), four throwaway Session
Occurrences (A `recM8B06ch0RFx3MH` Cancelled, B `recWwVQ1DFbo1MekL`
Cancelled, C `rec6SrCTZviEJph2k` Postponed with its `Replacement
Occurrence` link pointing at D, D `recDvvJSevForn7jH` Scheduled - all
deleted), and three real Coach Allocations created via Slice 5's own
`coach-allocations /allocate` route for A/B/C (`recWmxX0jGj0ZfCNL`/
`recWaCiT7pvfVPRG6`/`recw5yD6LTizi6VnV`, each £30 snapshot, all
deleted). `manager@test.invalid` re-authenticated for a fresh Management
JWT via `pg_net`; `coach.a@test.invalid`/`parent.a@test.invalid`
likewise for Scenario D (same established password-reset-via-`crypt()`
pattern).

- **Scenario A - cancellation, all three outcomes independent**:
  occurrence A set to Coach=Paid (`POST /coach-outcome`), Parent=Credit/
  £20/"Weather cancellation - goodwill credit" (`POST /parent-outcome`),
  Venue=Paid/£50 (`POST /venue-outcome`). Real combined `GET /outcomes`
  result: `{"coachAllocations":[{"coachOutcome":"Paid",
  "rateAmountSnapshot":30,"finalCoachCost":30}],"parentOutcome":
  {"outcome":"Credit","amount":20,"reason":"Weather cancellation -
  goodwill credit"},"venueOutcome":{"outcome":"Paid","amount":50}}` -
  all three independently persisted on the one Occurrence Financial
  Outcomes row (`recMOVwBcuSzLnueQ`, deleted).
- **Scenario B - partial coach pay**: occurrence B's allocation (£30
  basis) set to Coach=Partial/£15/"Agreed partial for late
  cancellation". Real result: `{"status":"updated",
  "recordId":"recWaCiT7pvfVPRG6","finalCoachCost":15,
  "costOverride":15}`. The allocation record itself was then read
  directly: `Rate Amount Snapshot: 30` (untouched), `Rate Profile`
  still linked to the original profile, `Rate Type Snapshot: "Evening"`,
  `Pay Unit Snapshot: "Per Hour"` (all untouched), `Cost Override: 15`,
  `Final Coach Cost: 15`, `Coach Outcome: "Partial"`, `Override Reason`
  persisted - **original rate snapshot unchanged, actual final cost
  £15**, exactly the brief's own worked example.
- **Scenario C - reschedule separation**: occurrence C (original,
  Postponed) set to Coach=Unpaid, Parent=Refund/£40, Venue=Credit/£25.
  Real combined read of C: `{"occurrenceStatus":"Postponed",
  "coachAllocations":[{"coachOutcome":"Unpaid","rateAmountSnapshot":30,
  "costOverride":0,"finalCoachCost":0}],"parentOutcome":
  {"outcome":"Refund","amount":40},"venueOutcome":{"outcome":"Credit",
  "amount":25}}`. Real combined read of the linked replacement D (same
  call, immediately after): `{"occurrenceStatus":"Scheduled",
  "coachAllocations":[],"parentOutcome":null,"venueOutcome":null}` -
  **the original keeps its own outcomes; the replacement inherits
  nothing**, exactly as required.
- **Scenario D - permissions**: the same `/coach-outcome` and
  `/parent-outcome` calls that succeeded as Management were repeated
  against occurrence A/allocation A with a fresh `coach.a@test.invalid`
  JWT and a fresh `parent.a@test.invalid` JWT respectively. Real result,
  both: HTTP 403 `{"error":"Management access required"}`. A follow-up
  `GET /outcomes` for occurrence A as Management confirmed the record
  was untouched by either rejected attempt (`Parent Outcome` still
  `Credit`/£20, not the rejected `Refund`/£100 the Parent JWT attempted).

One real concurrency artifact was hit and resolved during this
verification (documented under Idempotency above, not a code defect):
firing Parent-outcome and Venue-outcome for Scenario A in parallel
(rather than sequentially, as a real Management user would) caused both
calls to see "no existing row" and each create one; the duplicate was
deleted and the Venue call re-issued sequentially, which then correctly
updated the Parent call's row.

All exact throwaway record ids were captured at creation and deleted by
those exact ids afterward (Coach Allocations first, then Occurrence
Financial Outcomes rows, then Session Occurrences, then the Coach Rate
Profile, then the Session, then the Coach) - reconfirmed via `contains
"SLICE6"` searches across the Coaches and Sessions tables and a full
listing of Occurrence Financial Outcomes: zero results/rows remaining.
TEST-A/TEST-B were never write targets this slice.

### Regression

Full TEST suite (`node tests/run-all.js`), run after deploying and
completing real TEST verification, includes
`occurrence-financial-outcomes.test.ts` (32/32, new this slice)
alongside every prior slice's tests - `coach-allocations.test.ts`
(Slice 5 rate resolution/historical snapshots/overrides),
`access-resolution.test.ts` (Slices 2-4 effective dating/Occurrence
Staff/cover-tier retirement), `session-coaches.test.ts` (Parent Hub),
and the full Schedule-foundation suite. Slice 6 added one brand-new,
entirely isolated Edge Function, four new fields on Coach Allocations,
and one brand-new table - no existing file (`hub-content`, `parent-hub`,
`session-occurrences`, `coach-allocations`, or any of their test copies)
was modified, so no other slice's staffing, schedule, player-access, or
Parent Hub behaviour could have changed as a side effect.

### Production isolation

No production Airtable, production Supabase, frontend, Google Sheets, or
Stripe was read, written, or otherwise touched at any point in this
slice - every Airtable call targeted the TEST base `appQktredAuGa1X7e`,
every Supabase call targeted the TEST project `dkqubldmfyeuudecxmvh`,
and `occurrence-financial-outcomes` carries the same TEST DEPLOYMENT
GUARD as every other TEST function. No real parent credit/refund was
executed, no real coach payment was executed, no real venue payment was
executed - this slice only records the operational decision that later
Finance/Payments work can safely consume.

**Coaches Slice 6 is ready for Slice 7 coach availability.**

## Post-Slice-6 hardening — Occurrence Financial Outcome concurrency — TEST only — 2026-09-27

Closes the one documented limitation above ("Known limitation, documented
rather than engineered around") before Slice 7 begins. Scope was
deliberately narrow, per the brief: make concurrent writes for the same
Session Occurrence unable to create duplicate financial-outcome records,
without changing the approved Coach/Parent/Venue outcome model and
without touching production/frontend/Sheets/Stripe/Finance execution.
Neither `financial-outcomes.ts` (validation/patch-building) nor
`repository.ts` (Airtable I/O) nor the three-entry-point
`setCoachOutcome`/`setParentOutcome`/`setVenueOutcome` shape was changed
- only the sequencing around the existing Parent/Venue upsert gained a
lock.

### Design choice and why the alternatives were rejected

Three options were inspected before writing any code:

1. **One combined atomic Management write** (a single request carrying
   both Parent and Venue decisions together) - rejected. The brief
   requires "Parent and Venue outcome updates must be able to update
   that same record independently"; a combined-write endpoint would
   either force both decisions to arrive together (violating that
   requirement outright) or still need a second independent-update path
   for the common case of Parent and Venue being decided at different
   times by different people, at which point the combined endpoint
   solves nothing and the race is back.
2. **Reuse `generation_locks` directly** (the existing per-entity lock
   table already used by `session-occurrences`, keyed by
   `session_record_id`) - rejected. That table is semantically scoped to
   Session-occurrence generation, a different domain; storing an
   Occurrence Financial Outcomes/Session-Occurrence id in a column named
   `session_record_id` would be overloading an unrelated id type into an
   existing column for convenience, not "reusing an existing pattern" -
   it would make a future reader unable to trust what that column means.
3. **A new, domain-scoped lock table/RPC pair, same proven shape** -
   chosen. `occurrence_outcome_locks` (keyed by
   `occurrence_record_id text`) plus `acquire_occurrence_outcome_lock`/
   `release_occurrence_outcome_lock` Postgres functions, deliberately
   mirroring `generation_locks`' own proven design one-for-one: an
   atomic `INSERT ... ON CONFLICT (pk) DO NOTHING` for acquire (so
   ownership is decided by a single atomic statement, not a
   check-then-insert race of its own), a `gen_random_uuid()` lock token
   returned to the caller so release is token-matched rather than
   presence-matched (a stale invocation that wakes up after its lock was
   reclaimed can never delete the new owner's lock), and the same
   5-minute self-heal sweep (`delete ... where locked_at < now() -
   interval '5 minutes'`) for a crashed-invocation's lock to expire on
   its own. This is "reuse an existing locking/idempotency pattern"
   taken literally - the exact shape that has already been proven
   correct in this codebase - applied to its own domain rather than
   shared across two unrelated ones.

### What the lock guards, and what it deliberately does not

Only `setParentOutcome`/`setVenueOutcome` acquire the lock, via a new
`withOccurrenceLock()` wrapper in `orchestrator.ts` that serializes the
entire "does a row exist for this occurrence -> update it, else create
one" sequence per occurrence id. `setCoachOutcome` is untouched and
acquires no lock: it always `PATCH`es a caller-supplied `allocationId`
directly, never creates a row and never looks one up by occurrence, so
it has no duplicate-row race by construction - locking it would be
scope creep the brief explicitly warned against ("do not change the
approved Coach/Parent/Venue outcome model").

`withOccurrenceLock()` calls `acquire()` in a bounded retry loop (25
attempts, 40ms apart, ~1s total budget by default) rather than either
blocking forever or dropping a legitimate concurrent Management request
outright - `acquire()` itself returns immediately (null on contention,
same as `generation_locks`' own client), so retrying is the caller's own
choice. If the budget is exhausted, the new `"lock_unavailable"` status
is returned and surfaced as HTTP 409 ("This occurrence's financial
outcome is being updated by another request - please retry") rather than
either silently failing or hanging the request - Management retries
naturally resolve this, and the Postgres-level 5-minute self-heal means
a genuinely stuck lock (e.g. a crashed invocation) cannot wedge the
occurrence permanently.

### Deterministic concurrent-write test

`tests/support/occurrence-financial-outcomes.test.ts` item 19 (5
assertions, 19a-19e) fires `setParentOutcome`/`setVenueOutcome`
concurrently via `Promise.all`, sharing one lock instance and one mocked
`fetch` store with an artificial delay on **both** the mocked
GET-list-existing-row call (30ms) and the mocked POST-create call
(15ms). Both delays were required for the test to be a genuine
reproduction, not a vacuous one: an earlier throwaway sanity script
(never committed) found that delaying only the GET-list call was
insufficient - even against a no-op "always grants" lock, only one row
resulted, because Node's timer/microtask ordering let the first writer's
entire remaining synchronous chain (list response -> existence check ->
an instant mocked create) complete inside the same timer callback before
the second writer's own list-timer had fired to see the store still
empty. Adding a second delay to the mocked create call closes that gap.
The same sanity script confirmed, before the shipped test was finalised,
that this exact harness (a) reliably produces 2 duplicate rows against a
no-op lock and (b) reliably produces exactly 1 row against a real lock
(even the in-memory test fake) - proving the shipped test would have
failed pre-fix and passes post-fix, not merely that it passes now.
Assertions: 19a both concurrent calls succeed (one `created`, one
`updated`) rather than one erroring or being silently dropped; 19b
exactly one Occurrence Financial Outcomes record exists afterward; 19c
only one real create call was ever made; 19d the GET-list endpoint was
hit twice (once per writer's own existence check, serialized one after
the other by the lock, not coincidentally avoided); 19e the single
surviving record carries **both** intended values - the Parent call's
Credit/£20 and the Venue call's Paid/£50, neither lost nor overwritten
by the other.
`occurrence-financial-outcomes.test.ts`: **37/37** assertions passing
(32 from Slice 6 plus this hardening's 5).

### Deploy

`occurrence-financial-outcomes` v2 (project `dkqubldmfyeuudecxmvh`) - all
five files (`index.ts`, `financial-outcomes.ts`, `orchestrator.ts`,
`repository.ts`, and the new `lock-client.ts`). Deployed content
downloaded via `get_edge_function` and `diff`'d byte-for-byte against
the local repo files after deployment; confirmed **identical** for all
five files before any real TEST HTTP verification was trusted, same
discipline as every prior slice's deploy.

### Real TEST concurrency verification, real HTTP via `pg_net`

Fresh Management JWT obtained via the established
password-reset-via-`crypt()` + `pg_net` pattern (`manager@test.invalid`).
One throwaway Session Occurrence created directly (`THROWAWAY -
concurrency hardening verification`, `rectRaanez1kRZyvo`, deleted) - no
Coach, Session, or Coach Allocation needed, since Parent/Venue outcome
writes only require a valid Session Occurrence to exist.

Two `net.http_post` calls (`POST /parent-outcome` Refund/£15/"Concurrency
hardening test - parent leg", `POST /venue-outcome` Credit/£30/
"Concurrency hardening test - venue leg") for the **same** occurrence
were issued together in one SQL statement, neither awaited before the
other fired - the same genuinely-concurrent-wall-clock technique that
originally reproduced the race during Slice 6's own verification. Real
results: `{"status":"created","recordId":"reco9YQFXsylz6N0K"}` and
`{"status":"updated","recordId":"reco9YQFXsylz6N0K"}` - **both calls
resolved to the same record**, one creating it and the other updating
it, rather than each creating its own row. A follow-up `GET /outcomes`
confirmed: `{"parentOutcome":{"outcome":"Refund","amount":15,"reason":
"Concurrency hardening test - parent leg"},"venueOutcome":{"outcome":
"Credit","amount":30,"reason":"Concurrency hardening test - venue
leg"}}` - both values preserved. This was cross-checked directly against
the Airtable table itself (not just the API's own read, which could mask
a duplicate via `.find()`'s first-match behaviour): a filtered
`list_records_for_table` query on Occurrence Financial Outcomes for this
occurrence returned `totalRecordCount: 1`, the single record
`reco9YQFXsylz6N0K` with both `Parent Outcome: Refund`/£15 and `Venue
Outcome: Credit`/£30 stored on it. `occurrence_outcome_locks` was
confirmed empty (`count: 0`) immediately afterward - both locks were
acquired, used, and released cleanly, with nothing left for the 5-minute
self-heal to ever need to claim.

The throwaway Occurrence Financial Outcomes row and Session Occurrence
were deleted by their exact ids immediately after verification.

### Regression

Full TEST suite (`node tests/run-all.js`): **52/52 test files passing**,
exit code 0, including `occurrence-financial-outcomes.test.ts` at 37/37
(re-run standalone to confirm items 19a-19e specifically). This
hardening touched only `occurrence-financial-outcomes`'s own
`orchestrator.ts`/`index.ts` plus its new `lock-client.ts` and a new,
isolated Postgres table/pair of RPC functions - no other Edge Function,
table, or test file was modified, so no other slice's behaviour could
have changed as a side effect.

### Production isolation

No production Airtable, production Supabase, frontend, Google Sheets, or
Stripe was read, written, or otherwise touched. Every Airtable call
targeted the TEST base `appQktredAuGa1X7e`; every Supabase call targeted
the TEST project `dkqubldmfyeuudecxmvh`; `occurrence-financial-outcomes`
carries the same TEST DEPLOYMENT GUARD as every other TEST function.

**Slice 6 concurrency hardening is complete and ready for Slice 7.**

Do not start Slice 7 automatically.

## Coaches Foundation — Slice 7 (coach availability truth layer) — 2026-09-27

Makes coach availability real in the TEST backend. It answers one question
only: **"has this coach said they are nominally available for this UK date
and time?"** It does not rank coaches, recommend cover, assign anyone, send
notifications or suggest staffing. It also does not say whether a coach is
*free* (see "Availability is not the same as free" below).

### Schema used (re-read live from TEST, not redesigned)

Both tables were mirrored from production in Slice 1 and were still empty
in TEST when this slice began. No field was added, renamed or changed.

- **Coach Availability** (`tblFU568fUAtDFuM0`) - recurring weekly pattern:
  `Coach` (link), `Day of Week` (Monday..Sunday), `Available` (checkbox),
  `Start Time`/`End Time` (text, `HH:MM`), `Active` (checkbox), `Notes`.
- **Coach Availability Exceptions** (`tbl1TTBfX0kVeitxj`) - date-specific
  overrides: `Coach` (link), `Start Date`/`End Date` (date),
  `Availability Type` (`Unavailable` / `Available All Day` /
  `Different Hours`), `Start Time`/`End Time` (text), `Active`, `Note`.

No code read these tables before this slice, so there was no existing
semantics to preserve. Every rule below comes from these fields. Where the
schema is silent, the rule takes the conservative reading and is written
down here instead of being silently decided.

### Result states

`GET /coach-availability/resolve` returns exactly one of four states.
`unknown` and `unavailable` are deliberately kept apart because they will
matter differently when Management later searches for cover.

- **`available`**: the coach has said they are available for the whole
  work interval.
- **`unavailable`**: the coach has said they are not available for at
  least part of the interval. This includes a coach who gave hours for
  that day that don't cover the work.
- **`unknown`**: the coach has supplied nothing for that date/day
  (`reason: no_availability_supplied`). This is never collapsed into
  "unavailable", and never treated as "available".
- **`ambiguous`**: the data cannot be trusted to give an answer
  (conflicting exceptions, or a malformed row that could apply). A human
  needs to look. This is never guessed and never resolves to `available`.

Every result also carries `reason`, `source` (`exception` / `recurring` /
`none`), `matchedRecordId`/`matchedWindow`, every applicable row that was
considered, and a `problems` list naming each conflicting or malformed
record id and its issue, for Management/developer diagnosis.

### Recurring availability rule

- Only rows that are `Active` (ticked) **and** linked to this coach count.
  An unticked `Active` (the field is absent in the API response) means the
  row is ignored. Another coach's rows are never read into the result.
- The weekday comes from the UK calendar date.
- `Available` ticked = an availability window. Several windows on the same
  day are supported and are **never merged**, not even when they touch
  exactly (09:00-12:00 and 12:00-15:00 do not make 11:00-13:00 available).
- `Available` unticked = a declared unavailability for that window. With
  no times, it means unavailable all day (the conservative reading). If it
  overlaps the work at all, it wins over any positive window.
- If the coach supplied positive windows that weekday and none contains
  the work -> `unavailable` (`outside_recurring_windows`).
- If there are no positive rows that weekday -> `unknown`, even if the
  coach has rows on other days.

### Interval containment rule

The coach is available only if **one single window fully contains the
whole work interval**: `windowStart <= workStart` and
`workEnd <= windowEnd`. Boundary equality counts (17:00-20:00 availability
covers work 17:00-18:00, 19:00-20:00 and 17:00-20:00). Partial overlap is
never enough (16:30-18:00 and 19:30-20:30 are both unavailable against
17:00-20:00).

Unavailability windows block work on **any** overlap, using half-open
intervals: an unavailability ending at 18:00 does not block work starting
at 18:00.

Times are strict `HH:MM` from 00:00 to 23:59. A work interval must have
end > start and cannot cross midnight.

### Exception precedence

Exceptions whose inclusive `Start Date`..`End Date` range covers the date
are always consulted first:

1. `Available All Day` or `Different Hours` **replaces** the recurring
   pattern for that date entirely. For example, a Different Hours
   09:00-12:00 exception on a normal 17:00-20:00 Monday makes 18:00-19:00
   `unavailable` that Monday. A positive exception on a day the coach
   normally declares unavailable makes that one date available.
2. `Unavailable` with no times -> unavailable all that day. `Unavailable`
   with times blocks only its own window, and the rest of that day falls
   through to the recurring pattern (a 10:00-11:00 appointment does not
   erase evening availability).
3. Date ranges are inclusive at both ends and never leak outside the
   range. A blank `End Date` means a single-day exception.

### Overlapping / conflicting exceptions

There is no precedence field in the schema, so no "latest wins" or other
invented tiebreak is applied. Updated by the post-Slice-7 clarification
(see below): `ambiguous` is returned only when exception rows covering the
same date **genuinely contradict each other in time**.

- **Several non-overlapping Different Hours rows are separate valid
  windows.** For example, 09:00-12:00 + 16:00-20:00 means available in
  either window, and the gap is unavailable. The windows are never merged,
  so exactly-touching windows (09-12 + 12-15) are not a conflict but also
  don't cover 11:00-13:00.
- An `Unavailable` exception whose window **overlaps** a positive window
  -> `ambiguous` (`conflicting_exceptions`). A whole-day `Unavailable`
  overlaps every positive window.
- Two positive windows that **overlap without being identical** ->
  `ambiguous`. Examples: Different Hours 09-12 vs 11-14, or Available All
  Day + any Different Hours. These most likely mean a correction was left
  in place, and neither reading is safe to assume.
- **Not a conflict:**
  - identical duplicates;
  - several `Unavailable` exceptions (they all point the same way);
  - a timed `Unavailable` that sits entirely outside every positive window
    (consistent and redundant, since outside the positive windows is
    already unavailable).
- Conflicts are per date. Where a range overlaps a single-day exception,
  only the shared date is ambiguous.

Every conflicting exception id is listed in `problems`.

### Malformed / incomplete rows fail closed

A malformed row that could apply to the query makes the result
`ambiguous`. It is never silently skipped in a way that could turn the
answer into `available`. This covers:

- garbled or missing times on a positive row;
- end time not after start time;
- a positive recurring row with no times (never assumed to mean all day);
- an `Available All Day` exception that also carries times
  (contradictory);
- a missing `Availability Type`;
- a missing or invalid `Start Date`.

A row that cannot be placed (blank `Day of Week`, unreadable dates) is
treated as possibly applying to every date. A malformed row whose day or
date range is readable only matters on that day or range.

### Europe/London handling

Availability is a local operational schedule, so every comparison uses UK
**wall-clock minutes-of-day on a UK calendar date**. No UTC instant is
ever compared against a recurring window, so a BST/GMT change cannot
shift a window by an hour. The weekday is computed at UTC midnight of the
plain date string, so the host's own timezone cannot shift it either. The
unit tests were re-run under `America/Los_Angeles`, `Pacific/Auckland` and
`UTC` host timezones: 74/74 each time.

Callers can instead pass real instants (`startAt`/`endAt`, e.g. an
occurrence's Start/End Date & Time). These are converted once to
Europe/London wall-clock via `Intl` (not hand-rolled clock-change rules)
before any comparison. Both instants must land on the same UK date.
Supplying both input forms at once is rejected rather than preferring one.

### Availability is not the same as free

A coach can be `available` 17:00-20:00 on a Monday and still already be
coaching another Session at 18:00. Slice 7 deliberately does not consult
Session Staff, Occurrence Staff or Coach Allocations, and does not build
double-booking detection. Deciding that a coach is actually *suitable for
cover* later needs all of:

- this availability answer;
- existing **Session Staff** commitments (Slice 2 effective dating);
- existing **Occurrence Staff** commitments and date-specific overrides
  (Slice 3);
- possibly travel time / venue location between back-to-back commitments;
- compliance (Slice 8: documents/DBS etc).

### Backend/API

A new, entirely isolated Edge Function, `coach-availability`. No existing
function or table was modified. It is **read-only** and makes no Airtable
writes of any kind. No write route was needed to prove the tables end to
end: TEST fixtures were created directly and deleted afterwards.

It uses the same layering as Slices 5/6:

- **`coach-availability.ts`**: pure resolution, validation,
  `ukWallClockFromInstant()` and the `isManagementCaller()` predicate. No
  I/O.
- **`repository.ts`**: Airtable reads only. It fetches all rows and filters
  to the coach by linked record id in code, never via `filterByFormula`
  (inside a formula a link renders as display names, which could match
  the wrong coach by name).
- **`orchestrator.ts`**: normalises input (wall-clock or instants), checks
  the coach exists (a non-existent coach is 404, not `unknown`), loads
  rows and calls the resolver.
- **`index.ts`**: Management-only HTTP wrapper with the same TEST
  DEPLOYMENT GUARD as every other TEST function. Route:
  `GET /resolve?coachId=&date=YYYY-MM-DD&startTime=HH:MM&endTime=HH:MM`
  (or `&startAt=&endAt=` instants).

### Security / organisation isolation

The endpoint is Management-only via `isManagementCaller()`. Coach and
Parent JWTs get 403, and a coach cannot query even their own availability
through this slice. The TEST architecture is one organisation per Airtable
base, so a Management caller can only reach coaches in this base. No
cross-organisation path exists, and none was added.

**Future Covaro boundary**: a multi-organisation deployment must scope the
coach lookup and both availability reads to the caller's organisation
before this route is exposed commercially. Nothing here weakens the
current rules, and no multi-org auth was invented this slice.

### Focused tests

`tests/support/coach-availability.test.ts` (run by the
`tests/e2e/coachavailabilitytest.js` shim): **74/74** assertions passing.
It covers all 18 required items, plus security predicates and orchestrator
end-to-end checks against a mocked Airtable. The mock also fails the test
on any non-GET call, proving the function is read-only.

1-5. Containment: fully inside, starts before, ends after, exact start
boundary, exact end boundary, plus the brief's own 13:00 example.
6-7. Multiple windows, and the gap between them. Spanning the gap is
unavailable, and touching windows are not merged.
8. Normally available + Unavailable exception -> unavailable. The
following Monday resumes. Blank End Date = single day. A timed Unavailable
blocks only its window.
9. Unknown/declared-unavailable + Available All Day -> available on that
date only. Different Hours replaces the recurring pattern. Exception
choices match the live schema.
10-12. Range inclusive on Start Date and End Date, and no leak outside the
range.
13. No rows, other-day rows only, or a non-overlapping declared-off window
-> unknown.
14. Inactive recurring rows, inactive exceptions and an absent `Active`
field are all ignored.
15. Unavailable + Available All Day -> ambiguous (both ids surfaced).
Agreeing Unavailables -> not a conflict. An overlapping range is
ambiguous only on the shared date. (Post-Slice-7 clarification items
15c-15c12 are listed in that section below.)
16. Garbled/blank/reversed times, blank Day of Week, a malformed exception
(missing End Time / Start Date / Type, All Day with times) all fail
closed. A malformed row outside its own day or range does not poison
other dates. Query validation covers impossible dates, end <= start, bad
times and a bad coach id.
17. Another coach's rows (positive, negative or malformed) never affect
this coach.
18. BST and GMT instant conversion, and the UK date rolling forward near
midnight in BST. On clock-change days, 01:30Z on 29 Mar resolves to 02:30
and 01:30Z on 25 Oct to 01:30. A discriminating case: 19:30Z-20:00Z is
20:30 UK in BST (unavailable against 17:00-20:00; a raw UTC comparison
would wrongly say available) but 19:30 in GMT (available). A pair crossing
UK midnight is rejected.

### Deploy

`coach-availability` v1 (project `dkqubldmfyeuudecxmvh`) with all four
files. After deploying, the content was downloaded via `get_edge_function`
and `diff`'d byte-for-byte against the local repo files. All four were
confirmed **identical** before any real TEST HTTP verification was trusted.

### Real TEST verification, real HTTP via `pg_net`

Throwaway fixtures, all deleted afterwards by exact id:

- Coaches `SLICE7-TEST Coach Danny` (`recjZg4JNLEyxmsYe`) and
  `SLICE7-TEST Coach Nobody` (`recWLAXfPXwJPt33P`, no availability rows).
- Danny's recurring rows: Monday 17:00-20:00 (`recWrZnaAAeLkuzbd`),
  Wednesday 09:00-12:00 (`recV5nohSZwji0Dhz`), Wednesday 16:00-21:00
  (`recINRPn8xdPciQLF`).
- Danny's exceptions: Unavailable 12 Oct (`recd7d891aHZ27EOv`), plus a
  deliberately conflicting pair on 26 Oct, Unavailable
  (`rec9iQQHyOy54zYtA`) + Available All Day (`rec6y4MIYdGuTejDU`).

Fifteen real `GET /resolve` calls were made (Management JWT unless noted):

- **Scenario A** (Monday 17:00-20:00): 19 Oct 18:00-19:00 -> `available`
  (`within_recurring_window`, matched `recWrZnaAAeLkuzbd`); 16:00-18:00 ->
  `unavailable` (`outside_recurring_windows`).
- **Scenario B** (Unavailable exception 12 Oct): 12 Oct 18:00-19:00 ->
  `unavailable` (`exception_unavailable`, matched `recd7d891aHZ27EOv`); the
  following Monday 19 Oct -> `available` from recurring.
- **Scenario C**: Nobody, 19 Oct 18:00-19:00 -> `unknown`
  (`no_availability_supplied`), even though Danny has a Monday row. This
  also proves one coach's rows don't leak to another.
- **Scenario D** (Wednesday 09-12 + 16-21, 14 Oct): 10:00-11:00 ->
  `available` (matched the morning row); 14:00-15:00 -> `unavailable`;
  18:00-19:00 -> `available` (matched the evening row).
- **Conflict**: 26 Oct 18:00-19:00 -> `ambiguous`
  (`conflicting_exceptions`), with both exception ids and issues in
  `problems`.
- **Europe/London**: instants 19 Oct 19:30Z-20:00Z -> resolved as
  20:30-21:00 UK -> `unavailable`; 2 Nov 19:30Z-20:00Z -> resolved as
  19:30-20:00 UK -> `available`.
- **Errors/security**: end before start -> HTTP 400; non-existent coach id
  -> HTTP 404; Coach JWT -> HTTP 403 and Parent JWT -> HTTP 403, both
  `"Management access required"`.

Cleanup was reconfirmed: Coach Availability and Coach Availability
Exceptions both list 0 records, and a `contains "SLICE7"` search on Coaches
returns 0. TEST-A/TEST-B and every existing coach were never read targets
for fixtures or write targets.

### Regression

Full TEST suite (`node tests/run-all.js`), run after deployment and real
TEST verification: **53/53 test files passing**, exit code 0, zero `FAIL`
lines (52 prior files plus the new `coachavailabilitytest.js`). Explicitly
reconfirmed per the brief:

- **Slice 6 financial outcomes + concurrency hardening**:
  `occurrencefinancialoutcomestest.js` 37/37.
- **Slice 5 historical allocations**: `coachallocationstest.js` 25/25.
- **Slices 2-4** (Session Staff effective dating, Occurrence Staff, player
  access cleanup): `accessresolutiontest.js` 74/74.
- **Parent Hub**: `parenthubtest.js` 44/44, `parenthubshelltest.js` 65/65,
  `sessioncoachestest.js` 22/22.
- **Schedule foundation**: `sessiongeneratortest.js` 37/37,
  `sessionrepositorytest.js` 19/19, `propagationtest.js` 43/43,
  `nextoccurrencetest.js` 19/19, `dailytopuptest.js` 7/7.
- **Slice 7 itself**: `coachavailabilitytest.js` 74/74.

Slice 7 added one new, entirely isolated, read-only Edge Function and its
test copies. No existing function, table, field or test file was
modified, so staffing, access, cost and financial-outcome behaviour cannot
have changed as a side effect.

### Production isolation

- **Production Airtable**: untouched (not read, not written). Every
  Airtable call targeted the TEST base `appQktredAuGa1X7e`.
- **Production Supabase**: untouched. Every Supabase call targeted the
  TEST project `dkqubldmfyeuudecxmvh`.
- **Frontend**: untouched.
- **Google Sheets**: untouched.
- **Finance execution**: untouched. No Stripe, payments or exports.

`coach-availability` carries the same TEST DEPLOYMENT GUARD as every other
TEST function.

**Coaches Slice 7 is ready for Slice 8 compliance.**

## Post-Slice-7 clarification — multiple Different Hours exceptions — 2026-09-27

Narrow, TEST-only change to `coach-availability`, per product direction.
Two or more **non-conflicting** Different Hours exceptions on the same
date are now separate valid windows, not automatically `ambiguous`.
`ambiguous` is returned only when exception rows covering the same date
genuinely contradict each other in time (full rule under "Overlapping /
conflicting exceptions" in the Slice 7 section above).

All other Slice 7 decisions are unchanged:

- weekly `Available` unticked with no times = unavailable all day;
- weekly `Available` ticked with no times = incomplete, `ambiguous`;
- blank exception `End Date` = single day;
- Available All Day with times = contradictory, `ambiguous`;
- multi-org scoping remains documented future work.

**Code**: one function changed, in `coach-availability.ts`. The blanket
"any positive + any Unavailable" and "more than one distinct positive"
conflict checks were replaced with time-overlap checks, and positive
exceptions now resolve like recurring windows (the work must fit inside
one window, never merged). No other file changed. `coach-availability`
v2 was deployed, downloaded and `diff`'d byte-for-byte: all four files
**identical** to the repo.

**Tests**: `coach-availability.test.ts` is now **85/85**. The old 15c (two
Different Hours -> ambiguous) is replaced by 15c-15c12:

- 09-12 + 16-20: 10:00 available (first window), 14:00 unavailable, 18:00
  available (second window), 11:00-17:00 across the gap unavailable;
- touching windows are not a conflict and not merged;
- overlapping-but-different Different Hours -> ambiguous;
- identical duplicates -> fine;
- Available All Day + Different Hours -> ambiguous;
- a timed Unavailable overlapping a Different Hours window -> ambiguous;
- a timed Unavailable in the gap -> consistent (window still available,
  gap still unavailable);
- whole-day Unavailable + Different Hours -> ambiguous.

**Real TEST verification** (`pg_net`, Management JWT) used throwaway coach
`SLICE7B-TEST Coach DiffHours` (`recYzTxg0pnEyIWJq`) with these exceptions:

- 12 Oct Different Hours 09-12 (`recnoaEkrMPwLOXQB`) and 16-20
  (`rec5gxuSK3fBP4dZA`);
- 19 Oct Different Hours 09-12 (`rec38YB2DnzbshRrx`) and 11-14
  (`rec1xrr5jciPclFUc`);
- 26 Oct Different Hours 16-20 (`recHeAKBwfdkL1oZr`) and whole-day
  Unavailable (`recxAaydodgITPAYv`).

Results:

- 12 Oct 10:00-11:00 -> `available` (`within_exception_hours`, matched
  `recnoaEkrMPwLOXQB`).
- 12 Oct 14:00-15:00 -> `unavailable` (`outside_exception_hours`).
- 12 Oct 18:00-19:00 -> `available` (matched `rec5gxuSK3fBP4dZA`).
- 19 Oct -> `ambiguous` (`conflicting_exceptions`), problems listing both
  overlapping rows.
- 26 Oct -> `ambiguous`, problems listing both rows.

All seven throwaway records were deleted by exact id, and Coach
Availability Exceptions lists 0 records afterwards.

## Coaches Foundation — Slice 8 (compliance / qualifications + coach document submission) — 2026-09-27

Makes coach compliance real in the TEST backend. For each coach it
answers:

- which document types this organisation requires;
- whether each is present and verified/seen;
- its derived status and expiry/review date;
- whether an attachment exists;
- whether Management attention is needed.

It also provides the two write paths into the same Coach Documents
model: coach submission and Management submission/verification (the
mid-slice addendum). No Coach UI, Management screen, Needs Attention,
Settings or cover suitability was built.

### Schema: what was inspected, what was mirrored

- **TEST Coach Documents** (`tblp8QGwHPG92ekzR`) was re-read live and used
  unchanged:
  - Document Type: Enhanced DBS / Safeguarding Certificate / First Aid /
    School Induction / Other;
  - Attachment, Issue Date, Expiry / Review Date;
  - Status: Current / Review Soon / Needs Review / Expired / Missing;
  - Notes, Active;
  - Uploaded By User ID / Name Snapshot / At;
  - Verified By User ID / Name Snapshot / At (TEST-only since Slice 1;
    production Coach Documents has no Verified fields).
- **Production Coach Document Requirements** (`tblEWsmhlpIL3QBVU`) schema
  was inspected **read-only (schema only, no records read)**. Its fields
  are Requirement ID, **Client / School** (link to Clients & Schools),
  Document Type (the same five choices), Required, **Review Lead Days**
  (number), Notes, Active and Created/Last Updated. The Review Lead Days
  description reads: *"Optional number of days before expiry/review that
  the Hub should treat the requirement as approaching review."*
  - It does represent "Enhanced DBS / Safeguarding / First Aid required",
    plus review lead days, **but it is scoped per Client / School**, with
    no explicit organisation-wide marker.
- **Mirrored into TEST (smallest necessary part):** a new TEST table,
  `Coach Document Requirements` (`tblWoG5cd9BtGD2Q0`), with Requirement ID,
  Document Type (same choices), Required, Review Lead Days (same
  description), Notes and Active.
  - The Client / School link was deliberately **not** mirrored: school-
    specific compliance is out of scope, and linking would also have
    auto-created an inverse field on another table.
  - Created/Last Updated were not mirrored either (the create API cannot
    make computed fields, and nothing reads them).
  - Every TEST row is an **organisation-level** requirement. The resolver
    is already promotion-safe: any row that *does* carry a Client /
    School value (production shape) is skipped and counted as
    `schoolScopedRequirementsNotEvaluated`, never widened into an
    org-wide requirement.
- **Needs Attention Settings** (production) has a per-organisation,
  per-rule Warning Threshold. It is a possible *future* org-level default
  but was not used; Review Lead Days is the documented per-document
  source.
- The table was left empty after verification.

### Final compliance model

- **Required** means an Active + Required (+ no Client / School)
  requirement row exists for the Document Type.
- **The current operational record** for a coach + type is the single
  Active Coach Documents row linked to that coach. Inactive rows are
  history: counted (`historicalRecordCount`), never current, never
  deleted.
- **Verified / Seen** is derived; there is no boolean field. A record is
  verified iff **Verified By User ID** is present **and** **Verified At**
  is a valid timestamp. Exactly one of the two is `incomplete` and is
  never treated as verified.
- **The attachment is optional and separate.** An attachment present
  never means verified; an attachment absent never means non-compliant.
  A verified DBS with no attachment and an in-date review date is
  Current.
- **Status is derived, not trusted from the stored Status text.** The
  one exception is a manually stored `Needs Review`, which is honoured
  because it can only make the answer more cautious. The backend never
  writes the Status field.

### Status rules (first match wins)

1. No active record for a required type -> **Missing**.
2. More than one active record for the type -> **Needs Review**
   (`conflicting_active_records`, all ids surfaced, never an arbitrary
   pick).
3. The requirement config is unusable (negative/non-integer Review Lead
   Days, or duplicate requirement rows disagreeing on it) -> **Needs
   Review**.
4. The expiry date has passed -> **Expired** (wins over not-verified).
5. Malformed dates, or Issue Date after expiry -> **Needs Review**.
6. Incomplete verification -> **Needs Review**.
7. Not verified -> **Needs Review** (`not_verified`). This is how every
   new or changed submission lands until Management checks it.
8. Stored Status manually `Needs Review` -> **Needs Review**.
9. No Expiry / Review Date -> **Needs Review** (`missing_expiry_date`);
   an expiry is never invented. Open product question: which document
   types (e.g. School Induction) legitimately have no expiry? Until that
   is modelled, every type fails safe to Needs Review without a date.
10. Days until expiry <= the requirement's Review Lead Days -> **Review
    Soon**. With no Review Lead Days configured, there is no Review Soon
    window at all (nothing hard-coded).
11. Otherwise -> **Current**.

### Expiry boundary (Europe/London)

"Today" is the Europe/London calendar date. All comparisons are
whole-day and host-timezone independent (tests pass under Los Angeles and
Auckland host TZs). A document is **valid through its stated expiry date
and Expired from the following day** (UK midnight):

- on the expiry date: `daysUntilExpiry` 0, still Current / Review Soon;
- the day after: -1, Expired.

Tests also cover BST around midnight (23:30Z on 30 Sep is already 1 Oct
in the UK).

### Needs Attention signals

Each required item carries `status`, `reason` and `needsAttention`
(= required && status != Current). The summary also has `needsAttention`
(any item needs attention, or any data problem such as an unclassified
active document or bad requirement config) and `counts` per status.
Non-required documents appear under `otherDocuments` and never raise
attention. Needs Attention itself is not built.

### Write paths (addendum: coach document submission)

**`POST /submit`** is the single content write path for both roles.

- **Coach:**
  - may create/update **only their own** documents. Their Coaches record
    id comes from `profiles.airtable_person_id` (the same mapping
    hub-content uses), never from the request;
  - a `coachId` for someone else -> 403 `not_own_coach`;
  - `documentId` of another coach's record -> 403 `not_own_document`.
- **Management:** may create for any coach (`coachId` required) or update
  any record.
- **Request body is an allowlist:** documentId, coachId, documentType,
  issueDate, expiryDate, attachments. Anything else is rejected 400. Any
  verification-like field (`Verified By User ID`, `verified`, ...) gets
  the explicit error "only Management can verify, via /verify", so
  **coach self-verification is impossible, not merely ignored**. Status
  and Active cannot be set either.
- **Every submission stamps Uploaded By User ID / Name Snapshot / At**
  from the authenticated caller and server clock. A submission never
  writes any Verified field, so a new submission is unverified and
  resolves to **Needs Review** until Management checks it.
- **Attachments are optional.** They are passed as `https` URLs that
  Airtable fetches itself (its native attachment mechanism). A later
  Coach UI would upload to storage and pass a signed URL.
- **Guard rails:**
  - creating a second active record of a type the coach already has ->
    409 (update it instead);
  - historical (inactive) records are immutable (409);
  - Document Type cannot be changed (400);
  - Issue Date after expiry -> 400.
- **Re-review after a material coach change.** Issue Date, Expiry /
  Review Date and a replacement attachment are material. If the record
  is currently verified (or half-verified), the change is **versioned**:
  - a new active, unverified record is created, carrying the new content
    plus the existing attachment if none was supplied;
  - the old verified record is set **inactive** with its Verified By /
    At left intact as history;
  - the item therefore needs Management review again, and no audit field
    is ever cleared or overwritten.
  - The steps run create first, then retire the old one. If the second
    step fails, both stay active and the resolver reports Needs Review
    (`conflicting_active_records`), never Current (unit-tested).
- **Other update cases:**
  - a coach editing their own **unverified** record -> updated in place;
  - identical resubmission -> `unchanged` (a verified record stays
    verified);
  - **Management edits keep an existing verification**, since
    Management is the reviewing party.

**`POST /verify`** is Management only.

- Writes **only** Verified By User ID / Name Snapshot / At, from the
  authenticated Management caller (Supabase user id + profile
  display_name) and the server clock.
- Idempotent: re-verifying reports `already_verified` and never
  overwrites the original verifier or time.
- Inactive records and half-written verifications are refused (409).

**`GET /summary`** is Management only.

**Reset/revoke of verification is deliberately NOT built.** Clearing
Verified By/At would destroy audit data, and the brief asked to stop and
report before inventing audit behaviour. A coach's material change
already forces re-review non-destructively (versioning). A
Management-initiated "un-verify" needs a product decision on how the
prior verification is preserved, e.g. versioning it the same way, or a
Hub Audit Events style log.

Known minor limitation: two Management users verifying the same
unverified record at the same instant could both write, and the later
one's identity would be recorded. Both are legitimate Management; no lock
was added (none was requested).

### Attachment privacy

No route returns attachment URLs, filenames, ids or sizes. Summaries and
write responses expose only `hasAttachment: true/false`. Tested with a
fixture attachment carrying a secret URL, and confirmed live (no
`url`/`filename` in any response). An attachment-download path, if
ever needed, must be a separate Management-authorised route.

### Security

- `/summary` and `/verify` are Management only; Coach and Parent get 403.
- `/submit` accepts Management, or an active coach with a valid Coaches
  link (own records only). Parents, inactive profiles and unlinked
  coaches get 403.
- Hard backend security is kept separate from future organisation-
  configurable visibility (below).
- TEST DEPLOYMENT GUARD is present.
- Single organisation per base, the same multi-org boundary note as
  Slice 7.

### Future organisation visibility (product rule, documentation only)

Covaro should later let each organisation choose whether coaches can see:

- their own qualification/compliance status;
- expiry dates;
- attachment availability.

This is subject to platform security/data-protection boundaries. Covaro
sets the default visibility, with organisation overrides in Settings &
Configuration. Nothing Coach-facing was built for reading: coach read
access to `/summary` remains 403 until that setting exists.

### Focused tests

`tests/support/coach-compliance.test.ts` (shim
`tests/e2e/coachcompliancetest.js`): **87/87** passing, also under Los
Angeles and Auckland host timezones.

- **All 18 required items**, each asserted explicitly: verified-no-
  attachment Current; attachment ≠ verified; verifier identity from the
  authenticated caller; server-side Verified At; Missing; Current; Review
  Soon at exactly the lead-days boundary; the expiry-day boundary; the
  day after = Expired; incomplete -> Needs Review; inactive/historical
  never current; duplicate active -> Needs Review; no cross-coach
  leakage; Coach/Parent predicate denial; Management verify without
  attachment; Needs Attention signals; no attachment metadata exposure.
- **Requirement-model tests:** school-scoped rows skipped, Required /
  Active unticked ignored, invalid or disagreeing Review Lead Days,
  agreeing duplicates.
- **Addendum tests:**
  - coach-own create (C1);
  - cross-coach create and edit denial (C2/C3);
  - coach self-verification rejected (S3);
  - Management verification (C4);
  - re-review after a material coach edit, plus re-verify (C6);
  - replacement attachment (C7);
  - in-place edit when unverified (C8);
  - Management edit keeps verification (C9);
  - Management create (C10);
  - duplicate / historical / type-change / date-order guard rails
    (C11-C14);
  - supersede partial-failure fails safe (C15);
  - verify idempotency / inactive / half-verified refusals (V1-V3).

### Deploy

`coach-compliance` v2 (project `dkqubldmfyeuudecxmvh`; v1 was the
pre-addendum version with a `/metadata` route, replaced by `/submit`),
four files. The deployed content was downloaded via `get_edge_function`
and compared **mechanically** (`jq` extraction from the saved download
+ `cmp`, no hand transcription): all four byte-identical.

### Real TEST verification, real HTTP via `pg_net`

Fresh JWTs for `manager@test.invalid` (Morgan Manager,
`285f819e-e0d4-4257-8121-5f16781e97ba`), `coach.a@test.invalid` (Alex
Test, own Coaches record `recYZyiLVud7yoNZS`, user
`1bc04193-ee30-4fa3-a5fd-bf7cc0dac504`) and `parent.a@test.invalid`.
Coach-own submission needs a real coach login, so the real TEST coach
Alex Test was used; his documents were confirmed empty before and after.

Throwaway fixtures, all deleted by exact id afterwards:

- requirement rows:
  - Enhanced DBS, lead 45 (`recbkCfwUseVRkXOx`);
  - First Aid, lead 60 (`recNWOdETnLTgpuYJ`);
  - Safeguarding, lead 30 (`recZELLfEnSaupVVS`);
  - School Induction, no lead (`recFCpauEYrNWSIKA`);
- a second coach `SLICE8-TEST Other Coach` (`recWo86Feyd5XX9sx`);
- documents created through `/submit`:
  - DBS `recWolbvkxz1vdOmE`;
  - First Aid `recqOeHuYprTeFo3F`, created by the coach;
  - Safeguarding `rec5S5PCESpWOUGD8`;
  - the other coach's DBS `recgLS8D16EdcEfiP`;
  - the superseding DBS version `recqtf9XWtxw9nOPJ`.

UK today was 2026-09-27.

- **Before verification:** the Management-created DBS and the
  coach-created First Aid were both `Needs Review` / `not_verified`.
- **Scenario A** (DBS without attachment): Management `/verify` recorded
  Morgan Manager's user id + name + server timestamp. The summary showed
  `Current`, verified true, `hasAttachment:false`, expiry 2027-06-30.
- **Scenario B** (nearing expiry, configured Review Lead Days 60): First
  Aid expiring 2026-11-10 (44 days) -> `Review Soon`
  (`within_review_lead_days`).
- **Scenario C:** Safeguarding expired 2026-09-26 -> `Expired`
  (daysUntilExpiry -1).
- **Scenario D:** School Induction required, no record -> `Missing`.
  Summary counts: Current 1, Review Soon 1, Expired 1, Missing 1;
  `needsAttention:true`.
- **Scenario E** (permissions):
  - Management verify: 200;
  - Coach JWT `/verify`: 403;
  - Parent JWT `/verify`: 403;
  - Coach JWT `/summary`: 403.
- **Addendum, live:**
  - coach-own create: 201, unverified;
  - coach self-verification attempt: 400;
  - coach create for another coach: 403 `not_own_coach`;
  - coach edit of another coach's record: 403 `not_own_document` (that
    record was confirmed untouched);
  - parent submit: 403.
- **Re-review after a material coach edit:** the coach changed the
  verified DBS expiry to 2028-06-30 -> `superseded`.
  - New version `recqtf9XWtxw9nOPJ`: active, unverified, Uploaded By =
    the coach.
  - Summary: DBS `Needs Review` / `not_verified`, historicalRecordCount 1.
  - Airtable read directly: the old `recWolbvkxz1vdOmE` is now inactive,
    with Verified By `285f819e...` / Verified At
    `2026-09-27T20:22:31.197Z` and expiry 2027-06-30 all preserved.
  - A no-op resubmission of the verified First Aid -> `unchanged`, still
    verified.

Cleanup reconfirmed: Coach Documents 0, Coach Document Requirements 0,
Coaches `contains "SLICE"` 0.

### Slice 7 clarification (verified before Slice 8 was declared complete)

See "Post-Slice-7 clarification — multiple Different Hours exceptions"
above. It was committed separately (`7358752`) and verified live:

- 09-12 + 16-20 on one date: 10:00 available, 14:00 unavailable, 18:00
  available;
- overlapping Different Hours, and whole-day Unavailable + Different
  Hours, both still `ambiguous`.

The suite below includes `coachavailabilitytest.js` 85/85.

### Regression

Full TEST suite (`node tests/run-all.js`): **54/54 test files passing**,
exit 0, zero `FAIL` lines. Reconfirmed:

- **Slice 7 availability:** `coachavailabilitytest.js` 85/85.
- **Slice 6 financial outcomes + locking:**
  `occurrencefinancialoutcomestest.js` 37/37.
- **Slice 5 rates/allocations:** `coachallocationstest.js` 25/25.
- **Slices 2-4:** `accessresolutiontest.js` 74/74.
- **Parent Hub:** `parenthubtest.js` 44/44, `parenthubshelltest.js`
  65/65, `sessioncoachestest.js` 22/22.
- **Schedule foundation:** `sessiongeneratortest.js` 37/37,
  `sessionrepositorytest.js` 19/19, `propagationtest.js` 43/43,
  `nextoccurrencetest.js` 19/19, `dailytopuptest.js` 7/7.
- **Slice 8:** `coachcompliancetest.js` 87/87.

Slice 8 added one new isolated Edge Function, one new TEST table and
their tests. No existing function, table, field or test was modified.

### Production isolation

- **Production Airtable:** schema read only (Coach Document
  Requirements, Coach Documents, Needs Attention Settings/Rules). No
  record read, nothing written.
- **Production Supabase:** untouched.
- **Frontend:** untouched.
- **Google Sheets:** untouched.
- **Finance:** untouched.

All writes went to TEST base `appQktredAuGa1X7e` / TEST project
`dkqubldmfyeuudecxmvh`.

**Coaches Slice 8 compliance is ready for Slice 9 cover workflow.**

## Coaches Foundation — Slice 9 (cover workflow) — 2026-09-27

A coach asks for cover on one or more dates. Coaches Accept or Decline
each date. Management picks the final coach, and only that pick writes
a date-specific Occurrence Staff (Cover) row. Session Staff is never
touched. TEST-only: production was read for its schema only, and the
frontend, Google Sheets and Finance were not touched.

New TEST Edge Function `coach-cover` (v3, `verify_jwt: true`), layered
like Slices 6-8:

- `cover-workflow.ts` - pure rules and plans.
- `staffing.ts` - the Slice 2/3 resolver, copied verbatim, plus cover
  helpers.
- `coach-availability.ts`, `coach-compliance.ts`, `coach-rates.ts` -
  byte-identical copies of the Slice 7, 8 and 5 modules.
- `repository.ts` - Airtable I/O only.
- `lock-client.ts` - per-date lock RPCs.
- `orchestrator.ts` - composition.
- `index.ts` - auth and HTTP.

### Schema: what was inspected, what was mirrored

Production already has **Cover Request Groups**, **Staff Availability
Requests** and **Cover Responses**. Their schemas were re-read
(production read-only) and only the fields this slice needs were mirrored
into TEST. No parallel tables were invented.

- **Cover Request Groups** `tbl6CfJ4kHdhbnxfv` - one request, one or
  more dates.
  - Fields: Cover Group ID, Requesting Coach, Reason (Illness /
    Personal commitment / Holiday / Work clash / Emergency / Other),
    Handover Note, Status, Requested Via, Active.
  - Status choices: Open / Partially Filled / Filled / Cancelled /
    Resolved Without Cover.
- **Staff Availability Requests** `tbloR6M1OCIepeFNG` - one row per
  cover DATE.
  - Fields: Request ID, Coach, Session Occurrence, Request Type
    ("Cover Request"), Coach Note, Requested Via, Management Note,
    Decision At, Decision By User ID, Decision By Name Snapshot,
    Replacement Coach, Occurrence Staff, Cover Request Group, Cover
    Date Status.
  - Cover Date Status choices: Open / Filled / Cancelled / Resolved
    Without Cover.
  - Not mirrored: production's Session link, LEGACY fields and Coach
    Notified.
- **Cover Responses** `tblScRVSVmzISUF7E` - one row per coach per date.
  - Fields: Cover Response ID, Cover Request Date, Coach, Response
    Status (Invited / Yes / No / Withdrawn), Eligibility / Suitability
    Summary, Normal Rate Snapshot (£), Expected Cost Snapshot (£),
    Response Note, Responded At, Active.
- Airtable auto-created inverse link fields when these links were
  added: 4 on Coaches, 1 on Session Occurrences and 1 on Occurrence
  Staff (plus the Groups↔Requests↔Responses inverses). They are
  additive and read by nothing else. Remember them when promoting.
- **Supabase migration `slice9_cover_date_locks`:**
  - Table `public.cover_date_locks`, RLS enabled.
  - Functions `acquire_cover_date_lock` / `release_cover_date_lock`,
    with the same body shape as `occurrence_outcome_locks`: insert on
    conflict do nothing, a token-owned release, and 5-minute
    self-heal.
  - EXECUTE revoked from public/anon/authenticated and granted to
    `service_role` only (ACL checked:
    `postgres=X/postgres,service_role=X/postgres`).

### Cover request lifecycle

- One **group** holds one or more **dates**. Each date has its own
  status and moves independently:
  - `Open -> Filled` (Management selection);
  - `Open -> Cancelled` (requester or Management);
  - Filled and Cancelled are terminal here.
- Nothing is ever deleted.
- Group Status is **derived** from its dates:
  - any Open and any Filled -> Partially Filled;
  - any Open, none Filled -> Open;
  - else any Filled -> Filled;
  - all Cancelled -> Cancelled;
  - otherwise Resolved Without Cover.
- The stored group Status is rewritten after each change, from a fresh
  read of the group's dates. Reads always re-derive it.
- **Multi-date:** Danny can ask for 10/17/24 Oct in one request; each
  date is filled, left open or cancelled on its own. No coach is ever
  forced to take every date.
- **Creation is all-or-nothing.** Every date must pass before anything
  is written. A date passes when:
  - the occurrence exists and is `Scheduled`;
  - its date is today or later (Europe/London);
  - the coach is **genuinely staffing it now** - Session Staff applying
    on that date, or a usable Occurrence Staff row, via the unchanged
    Slice 3 resolver;
  - that coach has no Open request for that occurrence already.
- Creates are serialised per coach (lock key `create:{coachId}`), so a
  double-submitted form cannot create two Open requests for one date.
- A coach can only request for themselves. The Coaches record comes
  from `profiles.airtable_person_id`. A body naming another coach gets
  a 403; an unassigned occurrence gets a 409.
- Management may create a request on any coach's behalf
  (`Requested Via = Management Hub`).

### Candidate suitability (transparent, rule-based, no ranking)

Every candidate is evaluated with the same world read, **as of the cover
date**. The result is `suitable`, `needs_management_review` or
`unsuitable`, with each finding listed and coded.

**Blockers** (never selectable):

- **Requester / already staffing:** the candidate is the requester, or
  already staffs this occurrence.
- **Inactive:** the Coach record is not Active.
- **Availability (Slice 7):**
  - `unavailable` blocks;
  - `ambiguous` blocks (fails safe);
  - only `available` counts as confirmed.
- **Existing staffing:** an overlap with another occurrence the
  candidate is on (resolved roster, same UK date, half-open time
  intervals; Cancelled/Postponed occurrences ignored).
- **Compliance (Slice 8):** any **required** item that is Missing,
  Expired or Needs Review. Compliance is evaluated as of the cover date,
  so a DBS that expires before the session counts as Expired.
- **Role (Coach Roles Role Key rank: learning_coach < coach <
  lead_coach):**
  - a Learning Coach can never replace a Coach or Lead Coach;
  - a Coach cannot replace a Lead Coach when the Session `Requires Lead
    Coach` and no other Lead Coach would remain (`lead_coach_required`).

**Warnings** (selectable only if Management deliberately sends
`confirmWarnings: true`, never silently):

- availability `unknown` (unknown is **not** available);
- availability or overlap not evaluable (the occurrence has no usable
  times);
- a same-day assignment with unusable times (`overlap_uncertain`);
- the covered role cannot be resolved;
- the candidate holds no current recurring role
  (`role_capability_unknown` - capability is never assumed);
- a Coach replacing a Lead Coach where no lead requirement breaks
  (`role_downgrade`);
- compliance configuration problems.

**Info** (no effect on status):

- compliance **Review Soon** - stays usable, per the product rule;
- no organisation requirements configured.

Required Staff Count is unaffected, because cover is a strict 1:1
swap.

The candidate's role capability is the strongest Session Staff role
they hold on that date (any session).

**Known limitation:** overlap only sees generated Session Occurrences.
Commitments that exist nowhere as occurrences are invisible.

### Rate / expected-cost preview

This is a preview only: no Coach Allocation is created by cover.

- **Rate Type** is never inferred from the Session. It comes from
  either:
  - an explicit Management value (`rateType` on `/select` or
    `/manage/detail`); or
  - the requester's own Coach Allocation(s) for that occurrence, when
    they agree on a single Rate Type Snapshot.
- The candidate's rate then comes from Slice 5's
  `resolveCoachRateProfile`. Paid units:
  - Per Hour -> the occurrence's duration in hours;
  - Per Session / Per Day -> 1.
- The preview is written to Normal Rate Snapshot / Expected Cost
  Snapshot on the response.
- **Never guessed.** The snapshots stay **empty** and the preview says
  `requires_management_review` (with a reason) when any of these hold:
  - no Rate Type (`no_rate_type`);
  - allocations disagree (`ambiguous_rate_type`);
  - unknown type (`invalid_rate_type`);
  - no applicable profile (`no_rate_profile`);
  - overlapping profiles (`ambiguous_rate_profile`);
  - Per Hour without a duration (`duration_unknown`);
  - a bad amount or pay unit.

### Accept / Decline semantics

- Coach-only, and only for themselves: `{requestDateId, response:
  "Accept"|"Decline", note?}` maps to Response Status `Yes` / `No`.
- **An Accept is willingness, never an assignment:** no Occurrence
  Staff is written.
- Several coaches may Accept the same date.
- There is one response per coach per date. Answering again updates the
  coach's own row, never another coach's.
- Each response records a JSON suitability-and-rate snapshot at
  response time. Final selection always re-evaluates.
- A response is refused when:
  - it is the requester's own date (409);
  - the date is not Open (409 `date_not_open`);
  - the date is past;
  - the caller is Management (403).
- Responses run under the per-date lock, so they serialise with
  selection and cancellation.

### Management final selection

`POST /select {requestDateId, responseId, confirmWarnings?, rateType?}`
is Management only. The coach JWT gets a 403.

Inside the per-date lock, with everything **re-read after acquiring
it**:

1. The date must be Open.
   - Filled by the same coach -> `already_filled` (200, idempotent, no
     writes).
   - Filled by someone else -> 409 `already_filled_by_other`.
   - Cancelled / other -> 409.
2. The response must belong to this date, be Active and say `Yes`.
3. Fresh suitability:
   - unsuitable -> 409 `candidate_unsuitable` with the blockers (even
     with `confirmWarnings`);
   - warnings without `confirmWarnings` -> 409
     `warnings_require_confirmation`.
4. The requester must still be staffing the occurrence, otherwise 409
   `requester_no_longer_assigned`.
5. The post-write roster is **simulated with the unchanged Slice 3
   resolver** before anything is written. The plan proceeds only if the
   chosen coach is on and the requester is off; otherwise 409
   `replacement_not_representable`.
6. Writes, in this order:
   - **(a)** one Occurrence Staff row, with these fields:
     - Occurrence Staff ID `COVER-{dateId}` (deterministic, so a retried
       selection reuses its own row instead of adding a second);
     - Session Occurrence = that occurrence only;
     - Coach = the chosen coach;
     - Assignment Type **Cover**;
     - Planned Role Snapshot = the requester's role;
     - Attendance Planned;
     - Management Confirmed, Confirmed At/By/Name;
     - **Session Staff Source = the requester's Session Staff row**
       (the Slice 3 trace that removes the requester from that date
       only).
   - **(b)** any requester Occurrence Staff rows on that occurrence are
     set to `Attendance = Absent` (kept, not deleted).
   - **(c)** the date is set to `Filled`, with Replacement Coach,
     Decision At, Decision By User ID/Name and the Occurrence Staff
     link. It is written last, so a date is never Filled without its
     assignment.
   - **(d)** the group status is refreshed.
7. Other accepted responses are left exactly as they were
   (historical).

- **Session Staff is never written.** The next occurrence falls straight
  back to recurring staffing.
- Airtable updates the Session Staff row's own *Last Updated* stamp
  because it maintains the inverse "Occurrence Staff" link. The
  function itself never PATCHes Session Staff (asserted in unit test
  18).

### Cancellation

- The requester can cancel their own **Open** date; another coach gets
  403 `not_own_request`.
- Management can cancel any Open date.
- A cancel records Cover Date Status `Cancelled`, Decision At/By and an
  optional note. The note is appended to Coach Note (coach) or
  Management Note (Management).
- Repeating a cancel returns a harmless `already_cancelled`.
- **A Filled date cannot be cancelled** (409
  `filled_requires_deliberate_unassignment`, for the requester and for
  Management). The Occurrence Staff assignment stands until a
  deliberate Management un-assignment, which is out of scope for this
  slice.
- Nothing is ever deleted.

### 24-hour unfilled signal

- The signal is derived, with no new field: `unfilledOver24h` is true
  when the date is **Open** and at least 24h (inclusive) has passed
  since the record's own Airtable `createdTime`.
- Filled or Cancelled dates are never flagged; a missing or invalid
  `createdTime` never flags.
- The age is clamped at 0, because `createdTime` has second precision
  from Airtable's clock.
- `GET /manage` returns `unfilledOver24h` and `openForMinutes` per date,
  plus `unfilledOver24hCount`. It accepts `?asOf=` so a boundary can be
  checked deterministically.
- The signal is ready for Needs Attention / notifications. **No
  notification engine was built.**

### Concurrency guarantee

- Every write that changes a cover date (respond, cancel, select) runs
  inside that date's `cover_date_locks` lock.
- Each attempt re-reads the world **after** acquiring the lock, so a
  losing Management selection sees the winner's Filled state and
  returns 409 `already_filled_by_other`. Two final coaches for one date
  are impossible.
- The lock wait budget is 150 × 100ms. One operation re-reads Airtable
  (~2-4s), so Slice 6's ~1s budget was too short: it produced spurious
  "retry" conflicts for simultaneous Accepts. That was found live and
  fixed in v2. A lock still held past the budget returns 409 "please
  retry".
- If a selection fails part-way, the retry is safe: the deterministic
  `COVER-{dateId}` row is patched, not duplicated, and the date is only
  marked Filled after its row exists.
- **Airtable rate limit.** Found live in v2: three concurrent operations
  each fanning out 8 parallel reads got 429s. Nothing was written - both
  failed during the read phase. v3 fixes it three ways:
  - every Airtable call retries 429 with backoff (1/2/4/8/16s; a 429
    was not processed, so retrying even a POST cannot double-write);
  - reads are waves of at most 5;
  - each operation reads only the tables it needs (cancel reads 2,
    create 7, the Management list 5).

### Security

- **Coach:**
  - may create a request for their own genuine assignment;
  - may cancel their own Open dates;
  - may Accept/Decline for themselves only;
  - may view `/mine` (own requests with accept/decline counts, and Open
    dates they could take, with their own suitability).
- **Coaches never see** other coaches' responses, any rates, or
  Management notes.
- **Coaches cannot** finalise, alter another coach's response, set
  rates (rates are computed server-side only), or assign themselves:
  Occurrence Staff is written only by `/select`, which is Management
  only.
- **Management** can do everything:
  - create/adjust;
  - `/manage` list with the 24h signal;
  - `/manage/detail` - all responses with the stored snapshot plus
    fresh suitability/rate, and the current roster;
  - select;
  - cancel.
- **Parent:** 403 on every route.
- An inactive profile, or a coach profile without a valid Coaches link,
  also gets 403.
- **Pre-existing findings, reported and not fixed** (outside this
  slice):
  - `public.cron_auth_secrets` has RLS disabled. Suggested fix:
    `ALTER TABLE "public"."cron_auth_secrets" ENABLE ROW LEVEL
    SECURITY;`
  - the older `occurrence_outcome` / `generation` lock RPCs are still
    executable by anon/authenticated. The new cover lock RPCs are
    service_role only.

### Future notification events (documented contract only - nothing is sent)

`FUTURE_NOTIFICATION_EVENTS` in `cover-workflow.ts`, for the later
Communications system:

- `cover_requested` - group/dates created;
- `cover_response_received` - a coach Accepted/Declined;
- `cover_confirmed` - Management selected; Occurrence Staff written;
- `cover_cancelled` - a date cancelled;
- `cover_unfilled_escalation` - `unfilledOver24h` became true.

No emails, push notifications or branded delivery were built or sent.

### Future compliance rule (recorded, not built)

- Some qualifications never truly expire, but still need Management
  **re-verification**.
- Future compliance configuration should support:
  - **Expiry required: Yes/No**;
  - a **re-verification interval/date** where applicable.
- This must **never** be faked by inventing expiry dates.
- Slice 9 did not change the compliance schema: cover suitability did
  not need these fields, and it uses Slice 8's summary unchanged.

### Focused tests

`tests/support/coach-cover.test.ts` (shim `tests/e2e/coachcovertest.js`)
has **88/88** checks.

It exercises the real orchestrator against an in-memory Airtable (a
mocked global `fetch`) and an in-memory LockClient. Items 1-27 match the
brief:

- 1-3: create, including all-or-nothing and multi-date independence.
- 4-6: Accept/Decline/multiple Accepts.
- 7-13: suitability (unavailable/unknown/ambiguous, overlap and
  uncertain overlap, compliance Missing/Expired/Needs Review, Review
  Soon, role rules including Lead Coach).
- 14-15: rate resolved/missing/ambiguous.
- 16-20: selection, the Occurrence Staff row, replacement only on the
  target date, the next occurrence unchanged, other Accepts preserved.
- 21-22: cancellation.
- 23: the 24h boundary.
- 24: idempotent selection and partial-failure recovery.
- 25: **deterministic concurrency** - two managers, a delayed mock
  fetch, exactly one winner. A control shows that without the lock the
  same race writes two rows.
- 26: a coach cannot finalise.
- 27: Parent has no access.

It also covers:

- 429 retry: a read that stays rate-limited fails before any write;
- per-operation table loading;
- a requester staffed only via an Additional Occurrence Staff row
  (that row is set Absent);
- drift checks:
  - the three copied modules are byte-identical to their canonical
    versions;
  - every chunk of the copied block in `staffing.ts` appears verbatim in
    `hub-content/player-access.ts`;
  - all 5 `tests/support/coach-cover-*.ts` mirrors equal the canonical
    files (only import paths adjusted).

### Deploy

- `coach-cover` v1 went up, then v2 (the 24h clamp and lock budget),
  then v3 (429 retry and narrowed reads).
- Each version was downloaded with `get_edge_function` and compared
  **mechanically** (JSON extraction + `cmp`): all 9 files byte-identical
  to the repo. v3 is what was verified live.

### Real TEST verification, real HTTP via `pg_net`

- **Accounts:** fresh JWTs for `manager@test.invalid`,
  `coach.a@test.invalid`, `coach.b@test.invalid` and
  `parent.a@test.invalid`. Their TEST-only passwords were reset with the
  established `crypt()` pattern.
- **Acting as throwaway coaches:** only two coach logins exist, so
  `coach.a`/`coach.b` had their `profiles.airtable_person_id`
  temporarily pointed at the throwaway coaches (Danny/Joe/Tom/Uma/Nia/
  Bea). They were **restored afterwards** and checked: coach.a ->
  `recYZyiLVud7yoNZS` Alex Test, coach.b -> `rectpAbJCttFzN4XA` Sam
  Sample.
- **Throwaway fixtures** (every one deleted by exact ID afterwards; the
  cover tables and `SLICE9` Coaches/Sessions were re-checked empty):
  - 6 Coaches;
  - 3 Sessions, all Draft so the generator ignores them;
  - 6 Session Occurrences: M1-M5 on Mondays 5 Oct - 2 Nov at
    17:00-18:00 UK (BST and GMT), plus B1, which overlaps M4;
  - 6 Session Staff rows (all role Coach);
  - 5 availability rows (Monday 16:00-21:00);
  - Uma's Unavailable exception for 26 Oct;
  - a temporary org-level Enhanced DBS requirement (lead 30 days);
  - 4 verified DBS documents;
  - 2 rate profiles (Joe Evening £20/hr, Tom Evening £45/session);
  - Danny's Evening allocations for M1/M2.

- **Negatives:**
  - Danny requesting cover for B1 (not his) -> 409 "not assigned";
  - Danny naming Bea as coachId -> 403;
  - Parent create -> 403; Parent `/manage` -> 403;
  - coach `/manage` -> 403;
  - Joe `/select` -> 403;
  - Tom cancelling Danny's date -> 403;
  - Danny cancelling a Filled date -> 409
    `filled_requires_deliberate_unassignment`.
- **A - simple cover:**
  - Danny (coach JWT) asked for M1 -> group + date Open, Requested Via
    Coach Hub.
  - Joe's `/mine` showed the date as `suitable`. Joe Accepted: Yes,
    snapshot £20 / £20 from Danny's Evening allocation.
  - Management selected Joe -> `filled`, Occurrence Staff
    `rec9ysjtdx45FeKrg` (Cover, Joe, Session Staff Source = Danny's
    row, Planned Role Coach, confirmed by Morgan Manager).
  - `/manage/detail`: **M1 roster = Joe only; M2 roster = Danny only**
    (the next occurrence returns to recurring staffing).
- **B - multiple responses:**
  - Joe and Tom Accepted M2 **at the same moment** (both 201,
    serialised by the lock).
  - Management selected Tom -> Occurrence Staff `recz7ArZxEFkjPP5p`,
    £45 per-session preview.
  - Joe's Accept stayed `Yes`/Active (historical).
- **C - multi-date:**
  - One group for M3/M4/M5.
  - M3 filled with Joe. The rate preview was `requires_management_review
    / no_rate_type` because Danny has no allocation for M3 - it did not
    guess.
  - M5 was cancelled by Danny (note recorded). M4 stayed Open.
  - The group derived and stored **Partially Filled**.
- **D - unsuitable candidates on M4:**
  - Uma -> `unsuitable / availability_unavailable`;
  - Nia -> `unsuitable / compliance_blocking` (Enhanced DBS Missing);
  - Bea -> `unsuitable / overlapping_assignment` (B1);
  - Management selecting Uma, even with `confirmWarnings: true` -> 409
    `candidate_unsuitable`.
- **E - concurrency:**
  - Joe and Tom Accepted M4 (both suitable).
  - Two Management `/select` calls (Joe vs Tom) were fired in the same
    instant: Joe won (`filled`, `rect2MekV416kzozG`), and Tom's got 409
    `already_filled_by_other`.
  - Airtable afterwards held **exactly one** Cover row for M4, and
    exactly 4 Cover rows in total (M1-M4, one each).
  - A repeat of the winning selection -> 200 `already_filled`, no
    writes.
  - `cover_date_locks` read back empty.
- **F - 24h boundary:**
  - A fresh Open date had `createdTime` 21:28:45.000Z.
  - `/manage?asOf=` 24h - 1ms -> `openForMinutes` 1439,
    `unfilledOver24h` false, count 0.
  - `asOf` exactly +24h -> 1440, **true**, count 1.
  - Filled/Cancelled dates were never flagged.

**Found live and fixed before sign-off:**

- `openForMinutes` read -1 just after creation (fixed by the clamp).
- The lock budget was too short for simultaneous Accepts.
- Airtable returned 429 under concurrent operations. In v2 two
  selections failed cleanly with nothing written; v3 retries and
  narrows reads.

### Regression

`node tests/run-all.js`: **55/55 test files passed.**

- **Slice 9:** `coachcovertest.js` 88/88 (new).
- **Slice 8:** `coachcompliancetest.js` 87/87.
- **Slice 7:** `coachavailabilitytest.js` 85/85.
- **Slice 6:** `occurrencefinancialoutcomestest.js` 37/37.
- **Slice 5:** `coachallocationstest.js` 25/25.
- **Slices 2-4:** `accessresolutiontest.js` 74/74,
  `sessionaccesstest.js` 28/28.
- **Parent Hub:** `parenthubtest.js` 44/44, `parenthubshelltest.js`
  65/65, `sessioncoachestest.js` 22/22.
- **Schedule foundation:** `sessiongeneratortest.js` 37/37,
  `sessionrepositorytest.js` 19/19, `propagationtest.js` 43/43,
  `nextoccurrencetest.js` 19/19, `dailytopuptest.js` 7/7.

Slice 9 added one new isolated Edge Function, three TEST tables, one
Supabase lock table/RPC pair and their tests. No existing function,
table, field or test was modified.

### Production isolation

- **Production Airtable:** schema read only (Cover Request Groups, Staff
  Availability Requests, Cover Responses). No record read, nothing
  written.
- **Production Supabase:** untouched.
- **Frontend:** untouched.
- **Google Sheets:** untouched.
- **Finance execution:** untouched. No Coach Allocation or cost record
  is created by cover.
- **Notifications:** no emails, push notifications or other messages
  sent.

All writes went to TEST base `appQktredAuGa1X7e` / TEST project
`dkqubldmfyeuudecxmvh`.

**Coaches Slice 9 cover workflow is ready for Slice 10 coach work summaries.**

## Post-Coaches-Slice-9 Supabase security hardening — 2026-09-27

TEST project `dkqubldmfyeuudecxmvh` only. This fixes the two pre-existing
issues flagged during Slice 9 verification. The only changes are
privileges and RLS: no function body, no business logic, no Edge
Function code and no frontend changed. Nothing was redeployed.

### Security issues found (audit before the fix)

**1. `public.cron_auth_secrets`**

- Holds the per-job secret (`name`, `secret`, `created_at`; 1 row) that
  `session-occurrences /daily-top-up` checks through
  `validate_cron_secret(p_name, p_secret)`.
- **RLS was disabled.** This was the Supabase advisor's ERROR-level
  finding.
- The table grants were already only `postgres` + `service_role`. A real
  pre-fix probe of anon/Coach/Parent `GET /rest/v1/cron_auth_secrets`
  returned 401/403 `42501`, so the exposure was latent rather than
  exploited. Any future over-broad grant would still have opened it
  wide.

**2. Legacy lock RPCs**

- `acquire_occurrence_outcome_lock(text)` /
  `release_occurrence_outcome_lock(text, uuid)` were **EXECUTE-able by
  PUBLIC, `anon` and `authenticated`**.
  - Pre-fix real probes: anon, a Coach JWT and a Parent JWT each called
    `POST /rest/v1/rpc/acquire_occurrence_outcome_lock` and got **200
    plus a live lock token**.
  - Anyone could therefore hold any occurrence's financial-outcome lock
    for up to 5 minutes, blocking Management writes (a denial of
    service).
  - The three probe lock rows (`SECPROBE-BEFORE-anon/coach/parent`) were
    deleted by exact key straight away.
- `acquire_generation_lock` / `release_generation_lock` were already
  `service_role`-only. Pre-fix probes: anon 401, Coach/Parent 403. This
  corrects the Slice 9 note, which grouped them in: only the
  occurrence-outcome pair was actually exposed.
- **Tables:** `generation_locks` and `occurrence_outcome_locks` had RLS
  on with no policies (rows hidden, and reads returned `[]`), but still
  granted **all table privileges** (SELECT/INSERT/UPDATE/DELETE/
  **TRUNCATE**/REFERENCES/TRIGGER) to `anon` and `authenticated`.
  TRUNCATE is not governed by RLS.
- The newer `cover_date_locks` table and its cover lock RPCs (Slice 9)
  were already `service_role`-only. They were the reference for this
  fix.

Every legitimate caller already uses the **service-role key**:

- `session-occurrences/lock-client.ts`,
  `occurrence-financial-outcomes/lock-client.ts` and
  `coach-cover/lock-client.ts` call the RPCs with
  `SUPABASE_SERVICE_ROLE_KEY`.
- `session-occurrences` validates the cron secret the same way.
- The pg_cron job (`session-occurrences-daily-top-up`, owner `postgres`)
  only sends an HTTP request carrying the header. It never reads the
  table itself.

So restricting to `service_role` breaks no real flow.

### Hardening applied (migration `post_slice9_security_hardening`)

```sql
alter table public.cron_auth_secrets enable row level security;
revoke all on table public.cron_auth_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.cron_auth_secrets to service_role;
revoke execute on function public.validate_cron_secret(text, text) from public, anon, authenticated;
grant execute on function public.validate_cron_secret(text, text) to service_role;

revoke execute on function public.acquire_occurrence_outcome_lock(text) from public, anon, authenticated;
revoke execute on function public.release_occurrence_outcome_lock(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_occurrence_outcome_lock(text) to service_role;
grant execute on function public.release_occurrence_outcome_lock(text, uuid) to service_role;
-- generation + cover lock pairs: same revoke/grant re-asserted (idempotent)

revoke all on table public.generation_locks from public, anon, authenticated;
revoke all on table public.occurrence_outcome_locks from public, anon, authenticated;
revoke all on table public.cover_date_locks from public, anon, authenticated;
```

- **No RLS policies were added**, deliberately. RLS with zero policies
  denies every RLS-subject role:
  - `service_role` has BYPASSRLS;
  - the `SECURITY DEFINER` lock/secret functions run as their owner
    `postgres`, which is also the table owner, so RLS does not apply to
    them.
- The advisor now shows only the INFO-level "RLS enabled, no policy" on
  these four tables, which is the intended deny-all.
- The secret value is never returned by any client-facing function.
  `validate_cron_secret` returns only a boolean and is `service_role`
  only.

### Who can access what (after)

| Object | anon | authenticated (Coach / Parent / Management JWT) | service_role (Edge Functions) | postgres (owner, pg_cron) |
|---|---|---|---|---|
| `cron_auth_secrets` (RLS on, 0 policies) | no | no | yes (bypasses RLS) | yes |
| `validate_cron_secret()` | no | no | yes | yes |
| `generation_locks` / `occurrence_outcome_locks` / `cover_date_locks` (RLS on, 0 policies) | no | no | yes | yes |
| `acquire_/release_generation_lock` | no | no | yes | yes |
| `acquire_/release_occurrence_outcome_lock` | no | no | yes | yes |
| `acquire_/release_cover_date_lock` | no | no | yes | yes |

Management never calls these directly. Management product actions go
through the Edge Functions, which authenticate the user's JWT and then
use the service-role key for lock infrastructure.

Function ACLs now read `{postgres=X/postgres,service_role=X/postgres}`.
Table ACLs now read `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`.

### Real TEST verification (after), real HTTP via `pg_net`

Fresh JWTs for `manager@test.invalid`, `coach.a@test.invalid` and
`parent.a@test.invalid`. Anon calls used only the publishable key.

**Direct attacks - all 39 probes rejected with `42501 permission
denied`** (anon 401, Coach 403, Parent 403):

- acquire **and** release RPCs for all three lock pairs;
- `validate_cron_secret`;
- `GET` of `cron_auth_secrets` and all three lock tables;
- direct `POST` inserts into `cron_auth_secrets` and
  `occurrence_outcome_locks`.

**Legitimate server flows still work:**

- **Schedule generation:**
  - Management `POST /session-occurrences/generate {TEST-A}` -> 200
    `no_changes`. The lock was acquired and released: a denied RPC is a
    500, a held lock is `skipped_locked`.
  - The **real pg_cron command**, executed verbatim from `cron.job`
    (secret never read or printed), -> `/daily-top-up` 200
    `{considered:2, noChanges:2, skippedLocked:0, failed:0}`. This proves
    both the cron-secret check against the now-RLS-protected table and
    per-Session generation locks for TEST-A and TEST-B.
- **Financial outcomes**, on a throwaway Draft Session
  (`rec9o5zfFTuVXtyqr`) and occurrence (`reclDarVRZ2HDq7vQ`):
  - Management `parent-outcome` (Credit £12.50) -> 201 `created`
    (`rec39EVLNshV5wENF`);
  - `venue-outcome` (Paid £40) -> 200 `updated`, the same row;
  - read-back via `/outcomes` showed both families intact;
  - the Coach JWT on that Management route -> 403, unchanged.
- **Cover workflow:**
  - Management `/coach-cover/cancel` on a non-existent date -> 404
    `request_not_found`, which is reached only inside the cover lock;
  - Management `/manage` -> 200;
  - Coach `/mine` -> 200;
  - Parent -> 403.
- **Ownership-token behaviour is unchanged** for all three pairs, run
  directly as the owner: the first acquire returns a token, a second
  acquire returns null, a release with the wrong token returns false,
  and the owner's release returns true.
- **After verification**, `generation_locks`, `occurrence_outcome_locks`
  and `cover_date_locks` are all **0 rows**, and `cron_auth_secrets`
  still holds its 1 row.
- The throwaway outcome row, occurrence and Session were deleted by
  exact ID.
- The TEST-only passwords of the three accounts remain those set with
  the established `crypt()` pattern during Slice 9.

### Regression

`node tests/run-all.js`: **55/55 test files passed**. Among them:

- `coachcovertest.js` 88/88;
- `occurrencefinancialoutcomestest.js` 37/37;
- `sessiongeneratortest.js` 37/37;
- `propagationtest.js` 43/43;
- `dailytopuptest.js` 7/7;
- `coachcompliancetest.js` 87/87;
- `coachavailabilitytest.js` 85/85;
- `coachallocationstest.js` 25/25;
- `accessresolutiontest.js` 74/74;
- `parenthubtest.js` 44/44.

### Not changed (out of scope, reported only)

- **Advisor WARN:** `public.handle_new_user()` (the signup trigger
  function) is SECURITY DEFINER and EXECUTE-able by anon/authenticated.
- **Advisor WARN:** Auth leaked-password protection is disabled.
- **Root cause for future objects:** the `public` schema's default
  privileges still grant new tables/functions to anon/authenticated.
  Any new infrastructure table or RPC needs an explicit revoke, as this
  migration and Slice 9's did.

### Production isolation

- **Production Supabase:** untouched - no migration, no grants, no
  calls.
- **Production Airtable:** untouched.
- **Frontend:** untouched.
- **Google Sheets:** untouched.
- **Finance:** untouched.
- **Edge Functions:** none redeployed.
- **Notifications:** no emails or notifications sent.

**Post-Slice-9 Supabase security hardening is complete and ready for Coaches Slice 10.**

## Coaches Foundation — Slice 10 (coach work summaries) — 2026-09-27

A Work Summary tells a self-employed coach: "this is the work the Hub
believes you completed in this period, and the amount attached to each
item". **It is not an invoice, a payslip or a payment.** Nothing in this
slice pays anyone, creates an invoice, talks to Stripe or Xero, exports
to banking, or sends email/notifications. Every serialised receipt
carries that disclaimer.

New TEST Edge Function: `supabase/functions-test/coach-work-summaries/`
(v1, byte-verified), with these layers:
- `work-summaries.ts`: pure rules.
- `repository.ts`: Airtable I/O with 429 retry.
- `lock-client.ts`: the per-coach lock.
- `orchestrator.ts`: composition.
- `index.ts`: auth, routing and the TEST deployment guard.

### Schema: production re-read first, mirrored into TEST

Production (`apprptFotQuVL1mhs`) was read schema-only. It already has all
three tables, and none existed in TEST. They were created in TEST
(`appQktredAuGa1X7e`) field-for-field, with names, types, order, formats
and singleSelect choices identical to production. This was verified
programmatically: the production and TEST field lists compare
**IDENTICAL** for all three tables.

- **Coach Work Summaries** (`tbltizyDmpwsRWd27`):
  - Work Summary ID, Coach, Period Start, Period End, Summary Date;
  - **Status** (Not ready / Needs review / Finalised / Queried);
  - Grand Total (£);
  - Query / Reopen Note, Queried At;
  - Finalised By User ID / Name Snapshot / At;
  - Reopened By User ID / Name Snapshot / At;
  - Active, Created, Last Updated;
  - links to Work Summary Lines and Work Summary History.
- **Work Summary Lines** (`tblf2LMu5FwK8mSs8`): Work Summary Line ID,
  Work Summary, Coach Allocation, Group Label Snapshot, Work Date
  Snapshot, Session Name Snapshot, Rate Type Snapshot, Paid Units
  Snapshot, **Rate Amount Snapshot**, **Final Cost Snapshot**, Group Sort
  Order, Line Sort Order, Created.
- **Work Summary History** (`tblMzGIZCaxjnbsM7`): Work Summary History
  ID, Work Summary, **Event Type** (Needs Review / Finalised / Queried /
  Reopened / Re-finalised), Reason / Note, Changed By User ID, Changed By
  Name Snapshot, Changed At, Created.

Inverse links were renamed to their production names:
- Coaches → `Coach Work Summaries`;
- Coach Allocations → `Work Summary Lines`.

No existing TEST field was changed. There is no parallel system: only
the production structure is used, with the production Status and Event
Type choices exactly.

### Ownership model

| Record | Role |
|---|---|
| Coach Allocation | The **financial truth** (Final Coach Cost, Slices 5/6). This function never writes to it. |
| Coach Work Summary | A period grouping of one Coach's allocations. |
| Work Summary Line | A **frozen copy** of one allocation, written at finalisation. |
| Work Summary History | The append-only workflow audit trail. |

### Period rule

- Period Start/End are explicit, inclusive `YYYY-MM-DD` dates. Any range
  up to 366 days is allowed; calendar months are never assumed. A 3-day
  period is unit-tested.
- The **work date is the Session Occurrence `Date`**, never the
  allocation's Created timestamp (unit test E7).
- Both boundaries are inclusive.

### Eligibility (derived from the real schema, not guessed)

Cost Status choices are Draft / Confirmed / Exported. The production
description reads: "Draft can change. Confirmed snapshots the applicable
rate/cost." Occurrence Status choices are Scheduled / Completed /
Cancelled / Postponed. Slice 6's Coach Outcome choices are Paid /
Partial / Unpaid.

An allocation is **eligible** when all of these hold:
- it links this Coach, and only this Coach;
- its occurrence Date is inside the period;
- Cost Status is Confirmed or Exported;
- Final Coach Cost is a finite number ≥ 0;
- if the occurrence is Cancelled or Postponed, a Slice 6 Coach Outcome
  has been decided;
- otherwise, the work date has passed (or the occurrence is Completed).

Anything else **in the period** is **pending**. It is listed with a
reason, never silently dropped. Pending items set the summary to
`Not ready` and block finalisation. The reasons are:
- `cost_not_confirmed`
- `invalid_final_cost`
- `coach_outcome_undecided`
- `not_yet_worked`
- `multiple_coaches`

An allocation for this coach with no dated occurrence cannot be placed
in any period. It is surfaced to Management as `undatedAllocations` and
does not block.

A period that has not ended (`Period End >= today`, Europe/London) is
`Not ready` and cannot be finalised.

### Cancellation compatibility (Slice 6)

The line uses the allocation's Final Coach Cost, which Slice 6 already
sets.

| Outcome | Line |
|---|---|
| Paid | £30 (full cost). |
| Partial | The agreed amount, e.g. £15. The rate snapshot stays £30. |
| **Unpaid** | **Included as a visible £0 line.** This is the documented representation: the coach can see the cancelled session was accounted for. |

The frozen description says why. For example: `U10 Tuesday - Cancelled
(Coach outcome: Unpaid)`.

A cancelled or postponed occurrence with **no** Coach Outcome is never
paid by default. It is `coach_outcome_undecided` (pending), which was
proven live.

### Override compatibility (Slice 5)

A line copies the allocation's own `Rate Amount Snapshot` and
`Final Coach Cost`. For a standard £30 rate with a £40 override, the line
shows `Rate Amount Snapshot = 30` and `Final Cost Snapshot = 40`. This
was proven live, with the allocation created through the real Slice 5
`/allocate` route.

### Snapshot and finalisation

- An **open** summary (Not ready / Needs review, or Queried before ever
  being finalised) has **no line records**. Reads return a computed
  `preview` of lines. `Grand Total` on an open summary is that preview
  total, refreshed by prepare/refresh.
- **Finalise (Management only)**, inside the coach's lock, re-reads
  everything and then:
  1. validates the summary is active, the coach exists, the period is
     valid and has ended, and nothing is pending;
  2. gathers the eligible allocations;
  3. writes one line per allocation using the exact production field
     names;
  4. sets `Grand Total` to the sum, in whole pence, of the **stored
     lines'** Final Cost Snapshots;
  5. sets Status `Finalised`, `Finalised By User ID / Name Snapshot /
     At` and `Summary Date`;
  6. appends a `Finalised` History event (or `Re-finalised` if it was
     finalised before).
- A **finalised** summary is a historical snapshot:
  - reads return the stored lines verbatim;
  - a later Rate Profile or allocation change does not alter it (proven
    live: Rate Profile £30→£50 and allocation £30→£35 left the frozen
    line at £30 and the Grand Total at £175);
  - Management's read shows the difference as `management.drift`, so it
    is never *silently* stale;
  - refresh returns 409 `summary_finalised`;
  - a repeated finalise returns `already_finalised` with zero writes.

### Grand Total

`Grand Total` = Σ `Final Cost Snapshot` over the summary's lines,
added in whole pence. It is recomputed only at (re-)finalisation.

### Query flow (coach)

- A coach may query **their own** summary when it is `Needs review` or
  `Finalised`, with a required note (≤ 2000 chars).
- A query writes only `Status = Queried`, `Query / Reopen Note` and
  `Queried At`, plus a `Queried` History event with the coach as the
  changer. No value, rate or line changes.
- A queried *finalised* summary stays frozen.
- A second open query returns 409. Another coach's summary returns 404.
  Management cannot raise a coach query (403).

Management resolves a query by either:
- **re-finalising**, which records `Resolves query: ...` in the event
  note; or
- **reopening**.

### Reopen and re-finalise (Management)

**Reopen** is allowed only on a frozen summary. It:
- records `Reopened By User ID / Name Snapshot / At`;
- puts the reason in `Query / Reopen Note`;
- sets Status back to `Needs review` (or `Not ready` if anything is now
  pending);
- appends a `Reopened` event whose note preserves the previous
  finalisation, e.g. "Previous finalisation: Grand Total £175.00 across
  7 line(s), finalised … by …".

`Finalised By/At` and the frozen line records are **not erased**.

**Re-finalise** reconciles lines per allocation. It is the smallest
auditable interpretation, because the schema has no line versioning
field:
- an unchanged line is left alone;
- a changed line is **the same record, updated in place**;
- a new eligible allocation gets a new line;
- a line whose allocation is no longer eligible is **unlinked from the
  summary, never deleted** (the record keeps its allocation link and a
  Line ID naming the summary).

The `Re-finalised` event note lists every change with before and after
values (e.g. `final £30.00 -> £35.00`), so History holds the full audit
trail even though lines are updated in place.

### History behaviour

History is append-only; no History row is ever updated or deleted.
Events are written as follows:

| Event | When |
|---|---|
| `Needs Review` | The first time a summary reaches Needs review (prepare or refresh). A summary created as `Not ready` has no event, because production has no Event Type for it. |
| `Finalised` | Finalisation. |
| `Queried` | Coach query. |
| `Reopened` | Management reopen. |
| `Re-finalised` | Finalisation after an earlier finalisation. |

`Work Summary History ID` is deterministic (`WSH-<Work Summary
ID>-<Event>-<Changed At>`). A retried write finds the row it already made
instead of appending a duplicate. A finalise retried after a crash
between the summary write and the History write repairs the missing row
once.

### Idempotency and duplicates

There is no schema-level uniqueness key; `Work Summary ID` is plain
text. The smallest robust approach is:
- **One active summary per coach and exact period.** Prepare for the
  same coach and period returns the existing summary (`reused`, and
  refreshes it if open).
- **Overlap guard.** An active summary with an *overlapping* but
  different period is refused (409 `overlapping_summary`), so the same
  work can never be summarised twice.
- **One line per allocation per summary**, enforced by `reconcileLines`.
  A retried or partial finalisation reuses existing lines.
- **Per-coach lock.** All writes run under a new per-coach lock, re-read
  after acquiring it. The lock is the `work_summary_locks` table plus the
  `acquire_work_summary_lock` / `release_work_summary_lock` RPCs
  (migration `slice10_work_summary_locks`). It uses the same
  token-ownership and 5-minute self-heal pattern as
  `cover_date_locks`, with 150 × 100ms retry.

Unit tests prove:
- 3 concurrent prepares → 1 summary;
- negative control: with no lock → 2 summaries;
- 2 concurrent finalisations → 1 set of lines and 1 Finalised event;
- finalise retried after failures at two different points → no
  duplicate lines.

### Security model

| Caller | Access |
|---|---|
| Coach (active, linked profile) | Own summaries only: list, read, query. Lines without allocation or record ids; no Management block. Another coach's summary returns **404** (existence is not leaked). |
| Management | Everything: list all, read (with drift, stored lines, undated allocations and user ids), prepare, refresh, finalise, reopen. |
| Parent / inactive / unlinked | **403** on every route. |
| anon | No JWT, so the gateway rejects it (`verify_jwt = true`). |

Identity always comes from `profiles`, never from the request body.

The new lock table and RPCs have privileges **explicitly verified**, not
left to Supabase defaults:
- RLS is on, with no policies;
- all rights are revoked from public/anon/authenticated;
- service_role only.

Over real HTTP, anon and a coach JWT calling
`rpc/acquire_work_summary_lock` or `rpc/release_work_summary_lock`, or
selecting from or inserting into `work_summary_locks`, all got
`42501 permission denied` (401/403).

The post-Slice-9 hardening was re-verified: all 9 lock/cron RPCs and 5
lock/secret tables are service_role-only with RLS on.

### Receipt format (serialised only, no PDF or UI)

`summary.receipt` contains:
- `documentType: "Coach Work Summary"`;
- the not-an-invoice/payslip/payment `disclaimer`;
- `coachName`, `period`, `status`, `frozen`;
- `groups[]` (by Group Label), each with `items[]` of `{date,
  description, rateType, paidUnits, rateAmount, finalAmount}` and a
  `subtotal`;
- `grandTotal`.

### Routes (`/functions/v1/coach-work-summaries/...`)

| Route | Who | Purpose |
|---|---|---|
| `GET summaries[?coachId=]` | Coach (own) / Management | List summaries. |
| `GET summary?summaryId=` | Coach (own) / Management | Summary, lines (frozen or preview), pending, history, receipt. |
| `POST prepare {coachId, periodStart, periodEnd}` | Management | Create (201) or reuse (200). |
| `POST refresh {summaryId}` | Management | Recompute an open summary. |
| `POST query {summaryId, note}` | Coach | Query own summary. |
| `POST finalise {summaryId}` | Management | Freeze lines and Grand Total. |
| `POST reopen {summaryId, reason}` | Management | Reopen a finalised summary. |

### Focused tests

`tests/support/coach-work-summaries.test.ts` (shim
`tests/e2e/coachworksummariestest.js`) has **62/62** checks. They run the
real orchestrator against an in-memory Airtable plus an in-memory lock.
The brief's 27 required items are numbered 1-27:

1. create for coach + period
2. only that coach
3. out-of-period excluded
4. Start inclusive
5. End inclusive
6. correct lines
7. Grand Total = lines
8. Rate Profile change doesn't alter the finalised summary
9. allocation change doesn't silently alter it (drift)
10. £40 override
11. Paid £30
12. Partial £15
13. Unpaid £0 line
14. coach reads own
15. coach can't read another's
16. parent denied
17. coach queries own
18. coach can't finalise
19. Management finalises
20. Finalised By/At
21. Queried event
22. Finalised event
23. Reopened audit
24. re-finalise preserves history
25. duplicate summary reused / overlap refused / concurrency
26. duplicate lines prevented (retry, crash, concurrency, pure
    reconcile)
27. stable under repeated reads and retries

The remaining checks cover:
- Draft pending;
- undecided cancellation pending;
- period not ended;
- non-month periods;
- period validation;
- work date vs created time;
- undated allocations;
- receipt shape;
- refresh of a finalised summary refused;
- query on Needs review resolved by finalise;
- query preconditions;
- exact production choices;
- 429 retry;
- no deletes and no allocation writes;
- drift checks (mirrors byte-equal the canonical files, lock RPC names,
  production guard, no payment/invoice/Stripe/Xero/email code).

A strict `tsc` typecheck of the modules is clean. It caught a real bug
(reopen read `.reason` instead of `.note`) before deploy.

### Deploy

`coach-work-summaries` v1 on TEST project `dkqubldmfyeuudecxmvh`, with
`verify_jwt = true`. All 5 deployed files are byte-identical to the
repo (checked with `get_edge_function`).

### Real TEST verification (real HTTP via `pg_net`, throwaway data)

**Throwaway data**, created and then deleted by exact record ID:
- 1 Draft Session with Programme `S10 Throwaway Programme`;
- 9 June-2026 occurrences: 31 May, 1 / 10 / 12 / 13 / 14 / 20 / 30
  June, and 1 July;
- 2 Rate Profiles (coach A £30, coach B £25);
- 10 allocations created through the **real Slice 5 `/allocate`**, with
  Cost Status Confirmed and one £40 override;
- 3 occurrences set to Cancelled, with outcomes recorded through the
  **real Slice 6 `/coach-outcome`** (Paid, Partial £15, Unpaid).

Accounts: Management `manager@test.invalid`, coach A
`coach.a@test.invalid` (Alex Test), coach B `coach.b@test.invalid`,
parent `parent.a@test.invalid`. No profile was repointed.

- **A - ordinary month.**
  - Before the outcomes, prepare for coach A (June) returned 201 `Not
    ready`, with 3 × `coach_outcome_undecided` and 4 eligible lines
    (preview £130).
  - After the outcomes, refresh returned `Needs review` with 7 lines:
    1 Jun £30, 10 Jun £30, 12 Jun Paid £30, 13 Jun Partial £15, 14 Jun
    Unpaid £0, 20 Jun override £40, 30 Jun £30. Total **£175**.
  - 31 May, 1 July and coach B's 10 June allocation were excluded, and
    both boundaries were included.
  - Finalise returned 200 `finalised`. Airtable holds exactly 7 line
    rows with the production snapshot fields, Grand Total 175, Finalised
    By `Morgan Manager` / user id / At, and History `[Needs Review,
    Finalised]`.
- **B - historical stability.**
  - After finalising, the Rate Profile was changed £30→£50 and the 10
    June allocation £30→£35.
  - Two Management reads returned **byte-identical** responses, with the
    frozen 10 June line still £30, Grand Total £175 and receipt total
    £175.
  - `drift` = `[{changed, 10 Jun, frozen 30, current 35}]`.
- **C - Paid / Partial / Unpaid.** Shown in A: £30 / £15 / a visible £0
  line, each described as `- Cancelled (Coach outcome: …)`.
- **D - £40 override.** The 20 June line has Rate Amount Snapshot 30
  and Final Cost Snapshot 40.
- **E - coach query.**
  - Coach A's query returned 200: Status `Queried`, note and Queried At
    set, still frozen, Grand Total unchanged, and a `Queried` History row
    by `Alex Test`.
  - Coach B querying A's summary returned 404. Management's query
    returned 403.
- **F - reopen / re-finalise.**
  - A coach reopen returned 403.
  - Management reopen returned 200 `Needs review`. Reopened By/At were
    set; Finalised At (the original) and the 7 stored lines were kept.
    The preview shows 10 June at £35. The Reopened note preserved
    "Previous finalisation: Grand Total £175.00 across 7 line(s)…".
  - Re-finalise returned 200 `Re-finalised` with `lineChanges {created
    0, updated 1, unchanged 6, detached 0}`. The **same** line record
    (`rectTEyNyN3YlWpkc`) was updated to £35, there are still 7 lines,
    and Grand Total is **£180**.
  - History has 5 rows: `[Needs Review, Finalised, Queried, Reopened,
    Re-finalised]`. The note records `final £30.00 -> £35.00`.
- **Idempotency and concurrency (live).**
  - Two concurrent duplicate prepares both returned `reused` (same
    summary id); an overlapping period (15 Jun–14 Jul) returned 409
    `overlapping_summary`.
  - Two concurrent Management finalisations produced one `finalised`
    (7 lines created) and one `already_finalised`, and exactly 7 line
    rows.
  - The lock table was empty afterwards.
- **G - permissions.**

  | Request | Result |
  |---|---|
  | Coach A reads own | 200, no allocation ids, no Management block |
  | Coach B reads A's | 404 |
  | Coach B list | 0 rows |
  | Coach A list | 1 row |
  | Parent read / list / finalise | 403 |
  | Coach finalise | 403 |
  | anon / coach → lock RPCs and table | 42501 |

**Cleanup.** Every throwaway record was deleted by exact ID:
- 5 History rows, 7 Lines and 1 Summary;
- 10 Allocations, 9 Occurrences, 2 Rate Profiles and 1 Session.

Coach Allocations and Rate Profiles are back to empty, as they were
before. No Occurrence Financial Outcomes row was created.

### Regression

`node tests/run-all.js`: **56/56 test files passed.**

- **Slice 10:** `coachworksummariestest.js` 62/62 (new).
- **Slice 9:** `coachcovertest.js` 88/88.
- **Slice 8:** `coachcompliancetest.js` 87/87.
- **Slice 7:** `coachavailabilitytest.js` 85/85.
- **Slice 6:** `occurrencefinancialoutcomestest.js` 37/37.
- **Slice 5:** `coachallocationstest.js` 25/25.
- **Slices 2-4:** `accessresolutiontest.js` 74/74,
  `sessionaccesstest.js` 28/28.
- **Post-Slice-9 hardening:** re-verified live (above).
- **Parent Hub:** `parenthubtest.js` 44/44, `parenthubshelltest.js`
  65/65, `sessioncoachestest.js` 22/22.
- **Schedule:** `sessiongeneratortest.js` 37/37,
  `sessionrepositorytest.js` 19/19, `propagationtest.js` 43/43,
  `nextoccurrencetest.js` 19/19, `dailytopuptest.js` 7/7.

Slice 10 added:
- one new isolated Edge Function;
- three TEST Airtable tables (plus two renamed inverse link fields);
- one Supabase lock table/RPC pair;
- tests.

No existing function, field or test was modified. No existing function
was redeployed.

### Production isolation

- **Production Airtable:** schema read only. No record read, nothing
  written.
- **Production Supabase:** untouched.
- **Frontend:** untouched.
- **Google Sheets:** untouched.
- **Stripe / Xero / banking:** untouched. No invoices and no payments.
- **Notifications:** no emails or notifications sent.

All writes went to TEST base `appQktredAuGa1X7e` / TEST project
`dkqubldmfyeuudecxmvh`.

**Coaches Slice 10 work summaries are ready for the final Coaches foundation regression and handoff.**

## Coaches Foundation — Final Regression, Audit & Handoff — 2026-09-28

This is audit, verification, cleanup and documentation only. **No code, schema,
Supabase or deployment change was made in this checkpoint.** No genuine regression
or contradiction inside the Coaches foundation was found, so no fix was needed.

### A. Source-of-truth ownership (verified against the code's write map)

Every Coaches table has exactly one owning writer in the TEST backend. No new
duplicate source of truth exists.

| Truth | Table(s) | Only writer in TEST backend | Readers |
|---|---|---|---|
| Coach identity/profile | Coaches | none in Coaches slices (existing admin/approve flows) | all |
| Capability catalogue | Coach Roles | none (config) | hub-content, parent-hub, coach-cover |
| Recurring, date-ranged staffing | Session Staff | none in the backend (Management data entry); **cover never writes it** | hub-content, parent-hub, coach-cover |
| One-date exceptions / cover | Occurrence Staff | coach-cover `/select` only | hub-content, parent-hub, coach-cover |
| Recurring availability | Coach Availability | none (declaration data) | coach-availability, coach-cover |
| Date-specific availability | Coach Availability Exceptions | none (declaration data) | coach-availability, coach-cover |
| Compliance records | Coach Documents | coach-compliance `/submit` + `/verify` only | coach-compliance, coach-cover |
| Organisation requirements | Coach Document Requirements | none (config) | coach-compliance, coach-cover |
| Dated normal rates | Coach Rate Profiles | none (config) | coach-allocations, coach-cover (preview only) |
| **Historical financial truth** | Coach Allocations | coach-allocations `/allocate` (create) + occurrence-financial-outcomes `/coach-outcome` (outcome fields only) | work summaries, outcomes |
| Parent/venue outcome intent | Occurrence Financial Outcomes | occurrence-financial-outcomes only | same |
| Cover workflow | Cover Request Groups / Staff Availability Requests / Cover Responses | coach-cover only | coach-cover |
| Period work summary | Coach Work Summaries / Work Summary Lines / Work Summary History | coach-work-summaries only | coach-work-summaries |

Other facts confirmed:
- `Rate Amount Snapshot` is written only at allocation creation
  (`coach-allocations/repository.ts`). Work Summary Lines copy it; nothing
  recomputes it from a live rate.
- `parent-hub` writes only Parents & Guardians, Parent–Player Links and
  requests, never a Coach table.
- `hub-content` still contains write helpers but has **no live call sites**
  (they were left behind by the retired Sheets sync).

### B. Legacy contradiction audit

**1. Contradictions inside the new Coaches foundation: none found.**
- No free-text coach identity grants access. Every Coaches-slice path keys on
  Coaches record ids and on `profiles.airtable_person_id`.
- No Google Sheets data feeds player access. `CHANGES_CSV_URL` and the cover
  tier are gone (Slice 4).
- No global `Coach.Role` is used by any Coaches-slice path. Capabilities come
  from the Session Staff / Occurrence Staff role link.
- Staff Role Overrides has zero code references.
- Session Staff `Active` + Effective From/Until is applied in hub-content,
  parent-hub and coach-cover (the verbatim copied resolver block is
  drift-tested).
- Occurrence Staff is the only one-date mechanism, and cover writes only
  Occurrence Staff. Session Staff is never changed by cover.
- Learning Coach is denied player data by `Can View Players` = false plus the
  role-priority gate.
- No current rate rewrites a historical allocation cost.
- An attachment is never treated as verification. `Verified By/At` come only
  from the Management caller and the server clock, and a coach submission
  carrying verification fields is rejected.
- Coaches, Parents and anon cannot write allocations, financial outcomes,
  compliance verification or work-summary values. All of those are
  Management-only; the coach query changes workflow fields only.
- No automatic 5-hour, weather or auto-pay logic exists anywhere (grep-verified).

**2. Known legacy paths (dormant, deliberately kept, not breaking the
foundation):**
- **hub-content `legacy_assigned_coaches` fallback.** Gated by a Feature
  Control. It reads `Assigned Coaches` / `Active` / `Coach Role` by
  pre-rename names that are now `LEGACY —`, so it returns nothing. It is
  record-link based (not free text) and still requires `Can View Players`.
  Retire it with the legacy frontend migration.
- **`SESSIONS_CSV_URL`.** Unused constant left over from the retired
  Sessions-from-Sheet sync.
- **`FINANCIALS_CSV_URL`.** Management-only session participant counts read
  from the Finance sheet. This is not coach access; it belongs to future
  Finance work.
- **Production-side copies in `supabase/functions/`** (production hub-content
  and player-feedback) still contain the old Sheets / free-text
  `coachIdentityKeys` logic. They are untouched by design and are replaced
  at promotion.

**3. Known deferred former-player snapshot debt:**
- `eligibleCoachIdsForSessionSnapshot()` still matches coach names against
  the Sessions Google Sheet via `coachIdentityKeys()`. It is exported from
  `hub-content/player-access.ts` but **not called by any TEST function**.
- The 28-day former-coach window reads the frozen
  `LEGACY — Coaches At End` record-id snapshot.
- There is no non-legacy replacement for writing that snapshot yet. It should
  be rebuilt from Session Staff / Occurrence Staff as future work.

**4. Future commercial / multi-org work:** one organisation per Airtable base
today. `profiles.organisation_id` exists but no Coaches function scopes by it.

### C–J. Behavioural regression (all green, see M for counts)

- **C. Staffing** (`accessresolutiontest` 74, `sessionaccesstest` 28,
  `sessioncoachestest` 22) covers:
  - Active + Effective From/Until with inclusive boundaries;
  - the Danny→Tom→Joe handover;
  - overlap / co-coaching;
  - inactive assignment suppression;
  - Lead Coach / Coach access;
  - Learning Coach denial;
  - Occurrence Staff additive vs replacement;
  - one-date isolation, with surrounding occurrences back on recurring truth;
  - role snapshot precedence.
- **D. Player access:**
  - no Sheets fallback;
  - no alias-only grant;
  - Occurrence Staff grants date-specific access;
  - a replaced coach loses that date;
  - Learning Coach excluded;
  - Parent Hub display (`parenthubtest` 44, `parentdisplaytest` 32) stays
    separate from player-access permissions.
  - The former-player snapshot debt is as described in B.3.
- **E. Rates + allocations** (`coachallocationstest` 25):
  - rate resolved by work date, with inclusive boundaries;
  - ambiguous → fails safe (422); inactive rates ignored;
  - snapshots never recalculated;
  - an override keeps the normal snapshot;
  - one allocation per (Coach, Occurrence);
  - Management-only.
- **F. Financial outcomes** (`occurrencefinancialoutcomestest` 37):
  - Coach Paid / Unpaid / Partial, Parent Credit / Refund / None, Venue Paid /
    Credit / None, all explicit Management decisions;
  - no automatic weather/5-hour logic;
  - original and replacement occurrences are separate;
  - Partial keeps the rate snapshot;
  - concurrent Parent/Venue writes → exactly one row;
  - `occurrence_outcome_locks` currently has 0 rows;
  - Coach/Parent → 403.
- **G. Availability** (`coachavailabilitytest` 85):
  - available / unavailable / unknown / ambiguous;
  - full containment with inclusive boundaries;
  - multiple windows;
  - separate Different Hours windows;
  - Unavailable overrides; positive exceptions;
  - inclusive date ranges; conflicts → ambiguous;
  - Europe/London clock;
  - "availability ≠ free" (never consults staffing).
- **H. Compliance** (`coachcompliancetest` 87):
  - verification works without an attachment, and an attachment is not
    verification;
  - verification comes from Management/server only;
  - a coach submits own documents only, cannot self-verify and cannot edit
    another coach's document;
  - a material coach edit creates a new unverified version;
  - Current / Review Soon / Needs Review / Expired / Missing;
  - Review Soon uses the configured Review Lead Days only;
  - a document is valid through its expiry date and expired the next day;
  - duplicate or conflicting current records → fail safe;
  - attachment URLs are never returned.
- **I. Cover** (`coachcovertest` 88):
  - a coach may request cover for their own assignment only; Management may
    raise requests;
  - each date is independent;
  - several coaches can Accept, and Accept ≠ assignment;
  - Management selection writes Occurrence Staff and replaces the requester
    for that occurrence only;
  - unsuitable candidates are flagged: unavailable, ambiguous, conflicting,
    compliance Missing/Expired/Needs Review, role mismatch;
  - Review Soon behaves as documented;
  - the cost preview comes from rates; a missing/ambiguous rate is not
    guessed;
  - cancellation rules; the 24h unfilled signal;
  - one winner under concurrency;
  - the lock is server-only.
- **J. Work summaries** (`coachworksummariestest` 62): the full Slice 10 list.
  The three Slice 10 product decisions are **recorded as accepted**:
  1. Re-finalising updates lines in place, with History recording old and new
     values.
  2. Lines that stop qualifying are unlinked, not deleted.
  3. Overlapping active periods for the same coach are refused, to prevent
     double-counting.

### K. Supabase security checkpoint (live, TEST project `dkqubldmfyeuudecxmvh`)

Privileges were checked live:

| Object | anon | authenticated | service_role | RLS | Rows now |
|---|---|---|---|---|---|
| `acquire_/release_generation_lock` | no | no | yes | - | - |
| `acquire_/release_occurrence_outcome_lock` | no | no | yes | - | - |
| `acquire_/release_cover_date_lock` | no | no | yes | - | - |
| `acquire_/release_work_summary_lock` (Slice 10) | no | no | yes | - | - |
| `validate_cron_secret` | no | no | yes | - | - |
| `generation_locks` / `occurrence_outcome_locks` / `cover_date_locks` / `work_summary_locks` | no | no | yes | on | **0 / 0 / 0 / 0** |
| `cron_auth_secrets` | no | no | yes | on, **0 policies (deny-all)** | - |

Over real HTTP in Slice 10, anon and coach JWTs got `42501` on the
work-summary lock RPCs and table. The legitimate server flow works: live
concurrent finalisation used the lock and released it.

Deployed code was re-verified byte-for-byte against the repo:
- me v2, parent-hub v11, hub-content v9, coach-allocations v1,
  occurrence-financial-outcomes v2, coach-availability v2,
  coach-compliance v2, coach-cover v3 and coach-work-summaries v1 are all
  **identical**.
- session-occurrences v9 (Schedule foundation, not Coaches) differs in
  **comments only**: `repository.ts` has one comment re-wrapped, and
  `daily-top-up.ts` has one doc paragraph present in the deployed copy and
  absent in the repo. There is no behavioural difference. It was left as-is;
  promote from the repo.

All TEST functions have `verify_jwt = true`.

**Remaining Supabase security debt** (reported, not fixed — none is required
for Coaches correctness):
- `handle_new_user()` is SECURITY DEFINER and still EXECUTE-able by
  anon/authenticated.
- Auth leaked-password protection is disabled.
- The `public` schema's default privileges still grant new objects to
  anon/authenticated. Every new table/RPC must explicitly revoke, as all
  Coaches migrations did.
- **Production** `hub-content`, `player-feedback`, `player-feedback-trial` and
  `register-interest` run with `verify_jwt = false` (pre-existing,
  production-side). Promotion should deploy the TEST versions with
  `verify_jwt = true` where they authenticate.

### L. Data integrity (live TEST base `appQktredAuGa1X7e`)

| Table | Rows | State |
|---|---|---|
| Coaches | 3 | baseline (Morgan Manager, Alex Test, Sam Sample) |
| Coach Roles | 3 | Lead Coach / Coach / Learning Coach |
| Session Staff | 3 | `SS-TEST-A1`, `SS-TEST-B1` plus the documented, deliberately kept `SS-TEST-A2-VERIFY` (Alex as Learning Coach on TEST-B, the Learning-Coach-denial fixture) |
| Occurrence Staff | 0 | clean |
| Coach Rate Profiles / Coach Allocations | 0 / 0 | clean |
| Coach Documents / Coach Document Requirements | 0 / 0 | clean |
| Coach Availability / Exceptions | 0 / 0 | clean |
| Occurrence Financial Outcomes | 0 | clean (so no duplicates) |
| Cover Request Groups / Staff Availability Requests / Cover Responses | 0 / 0 / 0 | clean |
| Coach Work Summaries / Lines / History | 0 / 0 / 0 | clean |
| Sessions | 2 | TEST-A, TEST-B, both Active, unchanged |
| Session Occurrences | 27 | all linked to TEST-A/TEST-B, no orphans (the Cancelled 28 Sep / Postponed 5 Oct TEST-A rows are Schedule-foundation fixtures) |

Supabase profiles are as intended:
- `coach.a` → Alex Test `recYZyiLVud7yoNZS`;
- `coach.b` → Sam Sample `rectpAbJCttFzN4XA`;
- `manager` → Morgan Manager;
- the parents are unchanged.

All lock tables are empty. **No debris was found and nothing was deleted in
this checkpoint.**

### M. Full regression

`node tests/run-all.js`: **56/56 test files passed; 1,421 counted checks, 0
FAIL lines.** (`buttonaligntest` passes but prints no count.)

| Area | File | Checks |
|---|---|---|
| Session Staff effective dating / Occurrence Staff / player access | `accessresolutiontest.js` | 74/74 |
| | `sessionaccesstest.js` | 28/28 |
| | `sessioncoachestest.js` | 22/22 |
| | `coachparticipantstest.js` | 27/27 |
| | `playerfeedbacktest.js` | 64/64 |
| Rates / allocations | `coachallocationstest.js` | 25/25 |
| Financial outcomes | `occurrencefinancialoutcomestest.js` | 37/37 |
| Availability | `coachavailabilitytest.js` | 85/85 |
| Compliance | `coachcompliancetest.js` | 87/87 |
| Cover | `coachcovertest.js` | 88/88 |
| Work summaries | `coachworksummariestest.js` | 62/62 |
| Parent Hub | `parenthubtest.js` | 44/44 |
| | `parenthubshelltest.js` | 65/65 |
| | `parentdisplaytest.js` | 32/32 |
| | `parentlinkstatustest.js` | 15/15 |
| Schedule foundation | `sessiongeneratortest.js` | 37/37 |
| | `sessionrepositorytest.js` | 19/19 |
| | `propagationtest.js` | 43/43 |
| | `nextoccurrencetest.js` | 19/19 |
| | `dailytopuptest.js` | 7/7 |
| Production guard | `baseguardtest.js` | 30/30 |

### N. Runtime / Airtable fan-out note (documentation only)

All Coaches functions fetch whole Airtable tables and filter in code. This is
deliberate: `filterByFormula` renders links as display names, so it could
match the wrong coach by name. Cost therefore grows with table size, not with
the size of the question asked.

| Workflow | Reads per request | Writes | Batching/retry today |
|---|---|---|---|
| **coach-cover** | `/mine`, `/respond`, `/manage/detail`, `/select`: all **15 tables**, 3 waves of 5. Create: 7 tables. Cancel: 2. Manage list: 5. | 1–4 single-record writes | waves of 5 + 429 backoff (1/2/4/8/16s); per-cover-date lock |
| **coach-work-summaries** | 1 GET (to pick the lock) + **7 tables**, 2 waves, per mutating op; reads: 7; list: 2 | finalise writes **one request per line** (N lines ⇒ N POSTs), then summary + History | waves of 5 + 429 backoff; per-coach lock; line writes **not** batched (Airtable allows 10/request) |
| **coach-compliance** | 2 whole tables (Documents + Requirements) in parallel, plus coach lookups | 1 | no 429 retry |
| **coach-availability** | 1 GET (coach) + 2 whole tables in parallel | none | no 429 retry |
| **coach-allocations** | 2 GETs + 2 whole tables (Allocations, Rate Profiles) | 1 | no 429 retry |
| **occurrence-financial-outcomes** | 1–2 GETs + 1–2 whole tables | 1 | per-occurrence lock; no 429 retry |
| **hub-content `/players`** | **9 whole tables in parallel** on every coach page load | none | no retry |

Watchpoints for a future Supabase operational migration, in line with the
standing rule that high-frequency, latency- or concurrency-sensitive truth
moves to Supabase:
1. **Cover workflow state and candidate evaluation.** It has the largest
   fan-out, is concurrency-sensitive and is already lock-guarded in Supabase.
2. **hub-content player access.** It is per-page-load and high-frequency, and
   has no retry.
3. **Staffing resolution** (Session Staff + Occurrence Staff), read by three
   functions.
4. **Work-summary finalisation line writes.** Batch them 10 per request
   before a production-size month.
5. Adding 429 retry to compliance, availability, allocations and outcomes is
   a cheap stop-gap if Airtable stays the runtime source.

### O. Production isolation (reconfirmed)

- **Production Airtable `apprptFotQuVL1mhs`:** schema read only, during Slices
  1, 6, 8, 9 and 10 and this checkpoint. No record read, nothing written.
- **Production Supabase `bkkukymqaxawnudoxdjs`:** only read-only listings in
  this checkpoint. The latest migration is `20260919072006
  auto_activate_parent_signups`. The latest function deploy was 2026-09-26
  11:34 UTC (parent-hub v6), before Coaches Slice 1. It has none of the
  Coaches lock tables or functions.
- **Frontend:** `git log cdec215^..HEAD` touches no frontend file and nothing
  in `supabase/functions/`.
- **Google Sheets, Stripe, Xero, live Finance:** untouched.
- **Notifications:** no real emails or notifications sent (none are
  implemented).

### P. Production promotion manifest (NOT executed)

Promotion is a **schema reconciliation**, not table creation. Production
already has every Coaches table except Occurrence Financial Outcomes.

**1. Git commits** (branch `foundation/test-base-isolation`), in order:

| Commit | Change |
|---|---|
| `cdec215a438d984f29be00025f684b6eba046c71` | Slice 1 schema baseline |
| `fd7a91db2634e6318f4329ae0e2bfcfa9b3afc5b` | Slice 2 effective dating |
| `1bb9ad73eb1575eabc47c9fbae28e2fd4229d370` | Slice 3 Occurrence Staff |
| `2cb97079d246f9ed01076b7a6e8d13b21a32cd4a` | Slice 4 Sheets cover retired |
| `0e832677ab433a6f386ea3a03056b43f6c93d104` | Slice 5 rates/allocations |
| `0a813b473b496225f63116d1f525502a80684448` | Slice 6 outcomes |
| `8dfa20cd0ad6c9c2277974a974945df94e6fac64` | Slice 6 concurrency hardening |
| `b73557c60c0f5570cfbcb68dfb95870fbb8c56ce` | Slice 7 availability |
| `735875281a3991cc03853c98af679f9793ca7b3d` | Different Hours clarification |
| `1c652bb54be875149c9c9ca257e4e8578f837f89` | Slice 8 compliance |
| `630a40007095038f3a8152db809369e1fe1f3de5` | Slice 9 cover |
| `edaa90c78e104c2d0962a3447fe0333a97180fa2` | post-Slice-9 security hardening |
| `b3199e4d3e6f6c64b3563fbc1aa405a2e7d904dd` | Slice 10 work summaries |

The Coaches foundation depends on the earlier Schedule foundation commits
(through `43971a7`) being promoted first or together.

**2. Airtable schema additions/changes for production** (a live diff of
production vs TEST):
- **Sessions:** add `Required Staff Count` (number) and `Requires Lead Coach`
  (checkbox). `Session Dates` and `Session History` come with the Schedule
  foundation promotion.
- **Session Occurrences:** `Occurrence Key` and `Time Overridden` come with
  the Schedule foundation promotion. `Occurrence Financial Outcomes` is an
  inverse link created with that table.
- **Coach Allocations:** add `Coach Outcome` (Paid/Unpaid/Partial), `Coach
  Outcome Decided By User ID`, `Coach Outcome Decided By Name Snapshot` and
  `Coach Outcome Decided At`.
- **Coach Documents:** add `Verified By User ID`, `Verified By Name Snapshot`
  and `Verified At`.
- **New table:** `Occurrence Financial Outcomes` (Outcome ID, Session
  Occurrence, Parent/Venue Outcome + Amount + Reason + Decided By User ID /
  Name Snapshot / At, Created, Last Updated).
- **No change needed** (already identical to production): Coach Roles, Session
  Staff, Coach Availability(+Exceptions), Coach Rate Profiles, Coach Work
  Summaries / Lines / History.

**3. Fields needing production decisions:**
- **Production-only fields TEST lacks** — decide whether the code should use
  them:
  - `Occurrence Staff.Covering` / `From field: Covering` (a self-link),
    compared with the TEST cover model, which uses Cover Staff Mode;
  - `Occurrence Staff.Coach Allocations` ↔ `Coach Allocations.Occurrence
    Staff` (a staffing↔cost link; TEST deliberately keeps staffing and
    allocation separate);
  - `Coach Documents.Applies To Schools` and `Coach Document
    Requirements.Client / School` (school-specific compliance — future work,
    not used by the TEST code);
  - `Staff Availability Requests.Session`, `Coach Notified`, and the `LEGACY —
    Standalone Reason / Generic Status` fields.
- **Values:** the Occurrence Financial Outcomes table and the Coach Outcome
  fields are TEST-only proposals needing Finance/Management sign-off. The
  Coach Documents verification fields were proposed in Slice 1.

**4. Supabase migrations for production.** Apply in this order, after
re-reading production grants:

| Migration | Contents |
|---|---|
| `test_generation_locks` | Schedule |
| `occurrence_outcome_locks` | `occurrence_outcome_locks` table + acquire/release RPCs |
| `slice9_cover_date_locks` | `cover_date_locks` table + RPCs |
| `slice10_work_summary_locks` | `work_summary_locks` table + RPCs |
| `post_slice9_security_hardening` | RLS + revokes; cron secret RPC lock-down if the Schedule cron is promoted |

Every lock table and RPC must be service_role-only, with RLS on and explicit
revokes from public/anon/authenticated.

**5. Edge Functions to deploy** (from `supabase/functions-test/*`, dropping
only the TEST deployment guard's TEST-only assumptions):

| Function | Routes |
|---|---|
| `coach-allocations` | `resolve-rate`, `allocate`, `allocation` |
| `occurrence-financial-outcomes` | `coach-outcome`, `parent-outcome`, `venue-outcome`, `outcomes` |
| `coach-availability` | `resolve` |
| `coach-compliance` | `summary`, `verify`, `submit` |
| `coach-cover` | `requests`, `mine`, `respond`, `cancel`, `manage`, `manage/detail`, `select` |
| `coach-work-summaries` | `summaries`, `summary`, `prepare`, `refresh`, `query`, `finalise`, `reopen` |

Also replace the production `hub-content` and `parent-hub` with the TEST
versions, which carry the Slice 2–4 staffing/access logic. All must have
`verify_jwt = true`.

**6. Secrets/config:**
- `AIRTABLE_TOKEN` (production PAT scoped to the production base);
- `AIRTABLE_BASE_ID = apprptFotQuVL1mhs`;
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
  (platform-provided);
- optional `FINANCIALS_CSV_URL`;
- the production cron secret, if the Schedule cron is promoted.

The TEST guard refuses `apprptFotQuVL1mhs` by design, so production copies
need an explicit production variant of that guard (e.g. refuse the TEST base
instead).

**7. Production data backfill/migration:**
- Session Staff rows need correct `Active` / Effective From / Until.
  Occurrence Staff is needed for existing cover.
- Coach Roles need `Can View Players` set correctly.
- Rate Profiles need to be dated, one Active per Coach / Rate Type / date
  (ambiguity fails closed).
- Existing Coach Allocations need `Cost Status` reviewed before any work
  summary.
- Compliance: existing Coach Documents are **unverified** until Management
  verifies them; Requirements need `Review Lead Days`.
- Profiles need `airtable_person_id` → the Coaches record for every coach.
- Players need migrating onto Player Session Links before the
  legacy_assigned_coaches flag can be turned off.

**8. Legacy fields/tables to keep as deprecated vs retire later:**

Keep as deprecated for now:
- `Coaches.Role`
- `Coaches.LEGACY — Coach Role`
- the whole `Staff Role Overrides` table
- `Players.LEGACY — Assigned Coaches` / `LEGACY — Active`
- `Player Session Links.LEGACY — Coaches At End` / `LEGACY — End Date`
- `Staff Availability Requests.LEGACY — *`
- `Sessions.LEGACY — *`

Retire only after the legacy frontend migration and the former-player
snapshot rebuild.

**9. Security hardening that must accompany promotion:**
- service_role-only lock RPCs and tables;
- RLS on `cron_auth_secrets`;
- `verify_jwt = true` on every function;
- revoke `handle_new_user()` EXECUTE from anon/authenticated (check it still
  runs as a trigger);
- enable leaked-password protection;
- alter the `public` default privileges (or keep explicit revokes);
- confirm Management-only routes with real Coach/Parent JWTs.

**10. Known risks:**
- Airtable fan-out and rate limits at production data sizes (see N).
- Schema reconciliation mismatches, especially the production-only Covering /
  Occurrence Staff↔Allocations links.
- Data quality: undated or ambiguous rates fail closed, so allocations get
  blocked until the data is fixed.
- A coach losing access if Session Staff or profile links are incomplete (the
  foundation fails closed).
- The former-player snapshot debt.
- The legacy frontend still calls production hub-content assumptions.

**11. Rollback points:**
- Airtable additions are additive: leave the fields in place and redeploy the
  previous functions.
- Production function versions before promotion:

  | Function | Version |
  |---|---|
  | hub-content | v27 |
  | parent-hub | v6 |
  | player-feedback | v10 |
  | player-sessions | v4 |
  | approve-coach | v2 |
  | me | v2 |
  | register-interest | v2 |

- New functions can be deleted or disabled independently.
- Lock migrations are additive (drop the table + RPCs to roll back).
- The git tag point is `b3199e4`.

**12. Post-deploy verification checklist:**
1. Every function boots against the production base (guard variant correct).
2. `verify_jwt = true` on all functions.
3. anon/authenticated get `42501` on every lock RPC and table.
4. Lock tables have 0 rows after a smoke test.
5. A coach sees players only via Session Staff / Occurrence Staff; Learning
   Coach gets none.
6. Rate resolve on a known coach/date → resolved; an ambiguous fixture → 422.
7. Allocation create is idempotent.
8. Coach/Parent → 403 on financial routes.
9. Compliance summary shows no attachment URLs; a coach cannot verify.
10. Cover request → Accept → select writes exactly one Occurrence Staff row;
    Session Staff is unchanged.
11. Work summary prepare/finalise on a closed past period gives Grand Total =
    Σ lines, reads are stable, and query/reopen writes History.
12. Parent Hub coach display is unchanged for real families.
13. No emails are sent.

### Q. Remaining Coaches work after the foundation

**Foundation complete (TEST):**
- identity and role capabilities;
- effective-dated staffing and one-date Occurrence Staff;
- player-access gating;
- rates and historical allocations;
- cancellation/reschedule outcomes;
- availability;
- compliance status, submission and verification;
- cover workflow;
- work summaries;
- lock infrastructure and security hardening.

**Still needed — Management Coach UI:**
- staffing editor (Session Staff / Occurrence Staff);
- rate profile management;
- allocation creation/review;
- cancellation outcome screens;
- cover management board (24h signal, candidate suitability, final
  selection);
- **compliance verification UI**;
- work-summary prepare / finalise / reopen UI;
- coach directory/profile admin.

**Still needed — Coach Hub UI:**
- **coach self-service profile/onboarding**;
- availability declaration and exceptions;
- **compliance upload UI**;
- cover request/respond;
- my assignments;
- **work-summary Coach UI** (read / query), with **PDF later**.

**Still needed — Communications/notifications:**
- **branded cover emails/notifications** (the event names are already
  defined: `cover_requested`, `cover_response_received`, `cover_confirmed`,
  `cover_cancelled`, `cover_unfilled_escalation`);
- **compliance expiry reminders**;
- work-summary ready/queried notices.

**Still needed — Settings & Configuration:**
- **org-configurable coach visibility**;
- **coach rates visibility setting**;
- Review Lead Days / requirement management UI;
- **school-specific compliance requirements** (production already has
  `Applies To Schools` / `Client / School`);
- **compliance reverification interval/date** for qualifications with no
  true expiry. Do not fake expiry dates; model a separate re-verify date or
  interval.

**Still needed — Finance:**
- export of Confirmed allocations and finalised summaries to Finance;
- Parent credit/refund execution (Stripe);
- venue settlement;
- Xero;
- sign-off of the Occurrence Financial Outcomes model.

**Legacy frontend migration:**
- move `coach.js` / `management.js` off the production hub-content
  assumptions;
- retire the `legacy_assigned_coaches` fallback, `SESSIONS_CSV_URL` and the
  deprecated fields listed in P.8.

**Known future work:**
- **former-player snapshot legacy name-matching debt** (rebuild "Coaches At
  End" from Session Staff / Occurrence Staff);
- **multi-org scoping** by `organisation_id`;
- **Airtable→Supabase runtime migration watchpoints** (N.1–N.5);
- batching work-summary line writes;
- 429 retry for the older Coaches functions;
- resolving the session-occurrences comment drift at promotion.

**Coaches backend foundation is ready to be treated as complete in TEST.**


---

## Needs Attention Foundation — Slice 1 (data foundation) — TEST only — 2026-09-28

**Scope.** Data foundation only: three new TEST Airtable tables, the module
registry rows in the existing Feature Controls table, a reconciled rule
catalogue, the case-identity contract, organisation links, defaults and
semantics. **No code was written or deployed in this slice.** There is no
evaluator, Edge Function, API route, repository, exception write route,
queue UI, Home widget, Settings UI, notification, caching or Supabase
change. Slice 2 owns the engine.

Nothing in production (Airtable `apprptFotQuVL1mhs`, Supabase
`bkkukymqaxawnudoxdjs`) was modified. The production Needs Attention Rules
table was *read* as the reference for the catalogue. Every write targeted
TEST Airtable `appQktredAuGa1X7e`. TEST Supabase `dkqubldmfyeuudecxmvh`
was not changed: still 6 migrations, and profiles are untouched.

### NA1.1 Pre-change verification

- Repo `coach-allocation-test`, branch `foundation/test-base-isolation`,
  HEAD = origin = `9a48545`, clean tree.
- The TEST base schema was byte-for-byte unchanged since the Slice 10
  snapshot: 40 tables, with no Needs Attention tables.
- Feature Controls had 0 rows.
- Organisation & Branding had 1 row, `recYXqi1DTZ8ZECPQ` = `ORG-TEST-001`.
- Coach Roles had 3 rows: lead_coach, coach and learning_coach.

### NA1.2 External Airtable changes (exact)

| Change | ID |
|---|---|
| New table **Needs Attention Rules** (24 own fields + 2 inverse links) | `tblyawQ8vSEN945Qp` |
| New table **Needs Attention Settings** (13 fields), **0 rows** | `tblSbjGJUos0GLIyl` |
| New table **Needs Attention Exceptions** (16 fields), **0 rows** | `tblBbsSsLR32uojsk` |
| 38 rows seeded into Needs Attention Rules (15 Active, 23 Planned) | see NA1.7 |
| 7 rows seeded into **Feature Controls** `tbllQe6blyK0i2ZpA` | see NA1.5 |
| Inverse link fields auto-created by Airtable: Organisation & Branding (`Needs Attention Settings` `fldWyFKhH1GC8c31k`, `Needs Attention Exceptions` `fldlQmagiFi9YmBiT`); Sessions `fldAv1W3BD3h08I0R`; Session Occurrences `fldDYofA0rAI1kG0c`; Coaches `fldqqRW31Fql6MCUk`; Players `fldCVOWOTdrhv1iV3` (each named `Needs Attention Exceptions`) | — |

No other field on any pre-existing table was added, removed, renamed or
retyped. This was verified by script: an ID-level diff against the
pre-change schema. None of these inverse links is written or read by any
function: no handler returns raw record fields to clients, and they are
empty.

### NA1.3 Table definitions

**Needs Attention Rules** (`tblyawQ8vSEN945Qp`) is the platform-level
catalogue, with one row per rule. Primary field: Rule Name.

- Identity fields:
  - `Rule Name` (text)
  - `Rule ID` (text, `ATT-###`)
  - `Rule Key` (text, snake_case, the first segment of every Case Key)
- `Category` (single select): Sessions & Venues, Staffing & Cover,
  Coaches & Compliance, Players & Parents, Development,
  Finance & Billing, Communications, System & Data.
- `Description` (long text): the exact trigger semantics, the anchor and
  the Case Key form.
- Defaults:
  - `Default Enabled` (checkbox)
  - `Default Base Severity` (Normal / Warning / Urgent)
- Thresholds:
  - `Supports Warning Threshold` (checkbox), `Default Warning Threshold`
    (integer), `Default Warning Timing`
  - `Supports Urgent Threshold` (checkbox), `Default Urgent Threshold`
    (integer), `Default Urgent Timing`
  - Both timing fields offer: Hours Before, Days Before, Hours Overdue,
    Days Overdue.
- Behaviour:
  - `Supports Override` (checkbox)
  - `Locked Minimum Severity` (Normal / Warning / Urgent; blank means no
    floor)
  - `Action Label` (text)
  - `Destination Area` (single select): Coaches, Schedule & Sessions,
    Finance, Players & Parents, Development, Communications,
    Settings & System, Needs Attention.
  - `Client Customisable` (checkbox)
- Gating and status:
  - `Required Module` (single select, values equal to Feature Controls
    Feature Keys): module_schedule, module_coaches,
    module_players_parents, module_development, module_finance,
    module_communications, module_system.
  - `Evaluation Status` (Active / Planned / Retired)
- `Sort Order` (integer; equals the ATT number), `Active` (checkbox).
- `Created` (created time), `Last Updated` (last modified time).
- Inverse links: `Needs Attention Settings`, `Needs Attention Exceptions`.

**Needs Attention Settings** (`tblSbjGJUos0GLIyl`) holds optional
per-organisation overrides. It is **intentionally empty**.

- `Setting ID` (text)
- `Organisation` (link to Organisation & Branding `tblKKDnM19PqQ7rtc`)
- `Rule` (link to Needs Attention Rules)
- `Enabled` (checkbox)
- `Base Severity` (Normal / Warning / Urgent)
- `Warning Threshold` (integer), `Warning Timing`
- `Urgent Threshold` (integer), `Urgent Timing`
- `Allow Override` (checkbox)
- `Notes` (long text)
- `Created`, `Last Updated`

Settings was mirrored from production field-for-field: same names, types
and options.

**Needs Attention Exceptions** (`tblBbsSsLR32uojsk`) holds
Management-approved suppressions of one specific case. It is
**intentionally empty**; no exceptions are seeded.

- `Exception ID` (text)
- `Organisation` (link to Organisation & Branding)
- `Rule` (link to Needs Attention Rules)
- **`Case Key`** (text; this is the only matching key)
- Context links:
  - `Session` (Sessions)
  - `Session Occurrence` (Session Occurrences)
  - `Coach` (Coaches)
  - `Player` (Players)
- `Reason` (long text)
- `Approved By User ID` (text), `Approved By Name Snapshot` (text)
- `Approved At`, `Effective Until` (date-time, D/M/YYYY, 24h,
  Europe/London)
- `Active` (checkbox)
- `Created`, `Last Updated`

These are the production Exceptions fields plus `Case Key`. There is **no
Target Type/Target ID pair**. The Case Key is the identity, and the typed
links are for display, navigation and audit only. Case Key plus typed links
is sufficient for every Active rule; where a subject has no typed link, its
record id is carried in the Case Key:

- cover dates (Staff Availability Requests)
- Coach Allocations
- Coach Work Summaries
- Coach Document Requirements

### NA1.4 Semantics (the contract Slice 2 must implement)

**Cases are derived, never stored.** A case is computed at read time from
live TEST data. There is no Cases table, and no case status is persisted.

**Evaluation gate.** A rule is evaluated for an organisation only when all
of the following hold:

1. The Rule's `Active` is Yes. This means the catalogue record itself is
   usable, for example selectable in Settings or Exceptions.
2. `Evaluation Status` is `Active`. This says whether code should evaluate
   the rule:
   - `Planned`: the semantics are agreed but the data or module is not
     ready, so it is never evaluated.
   - `Retired`: it is never evaluated, and the row is kept only for ID
     history.
3. The Required Module is active. A Feature Controls row with
   `Feature Key` = `Required Module` exists **and** `Enabled` = Yes. A
   missing row means the module is **inactive** (fail closed).
4. The effective Enabled is Yes. That is the Settings row's `Enabled` if
   one exists for this Organisation + Rule; otherwise the Rule's
   `Default Enabled`.

`Active` and `Evaluation Status` are deliberately independent, and both are
needed. A Planned rule is a usable catalogue record: an organisation can
pre-configure a Settings row for it. An Active rule could be withdrawn
from the catalogue (`Active` = No) without losing its evaluation history.
They were therefore **not** simplified into one field.

**Inheritance: no Settings row means use the Rule defaults.** This
**replaces** production's "No record means the rule is off", which is
documented on the production Settings table. Inheritance is field by
field: a blank Settings value inherits that one Rule default.
Additionally:

- Settings overrides are ignored for rules whose `Client Customisable` is
  No.
- Effective base severity is never below `Locked Minimum Severity`.
- Settings thresholds are ignored unless the Rule `Supports …Threshold`.
- `Allow Override` on Settings can only narrow the Rule's
  `Supports Override`, never widen it.

**Severity.** Effective severity is the highest of:

- the effective base severity;
- Warning, if the Warning threshold is reached;
- Urgent, if the Urgent threshold is reached;
- the Locked Minimum Severity;
- any fixed state-based severity stated in the rule's Description (for
  example, an Expired compliance item is Urgent).

The timing units anchor as follows:

- **Before** means time remaining until the rule's *event anchor* (for
  example the occurrence Start Date & Time).
- **Overdue** means time elapsed since the rule's *outstanding-since
  anchor* (for example the cover date row being created, or Period End).

Each rule's anchor is named in its Description.

**Home state.** `Clear` when there are no cases after gating and
exceptions. Otherwise it is the highest effective severity across all cases
(Normal < Warning < Urgent).

**Exceptions.** An Exception suppresses exactly one case when all of these
hold:

- `Active` = Yes;
- the Organisation matches;
- the `Case Key` string equals the derived Case Key exactly;
- the Rule equals the Case Key's rule segment;
- the rule supports override and the organisation does not disallow it;
- now < `Effective Until`, where blank means no expiry.

Exceptions are deactivated, never deleted.

### NA1.5 Module registry (Feature Controls)

The existing Feature Controls table is used as the module registry. This
was confirmed safe before seeding:

- **hub-content `/players`** reads only
  `Feature Key = legacy_assigned_coaches`. With no such row it keeps the
  existing default (`true`). **No `legacy_assigned_coaches` row was
  added.**
- **hub-content `/settings`** returns every row as
  `features[Feature Key] = Enabled`.
- **Frontend.** `content-provider.js` merges `features` over its defaults:
  resources, venues, coach_support, player_feedback, development_plans and
  my_players. Its `feature()` accessor is exported but **called nowhere**.
  The `module_*` keys cannot collide with any existing key.
- **Production** functions read the production base, which is not
  affected.

Convention: Feature Key is snake_case with a `module_` prefix, so module
rows can never be confused with UI feature flags. Every row has
Audience = Management and Sort Order 101–107.

| Feature Key | Enabled (TEST) | Record |
|---|---|---|
| `module_schedule` | Yes | `recleeUClmUlKRfJu` |
| `module_coaches` | Yes | `recD6JSqZV7l7391m` |
| `module_players_parents` | Yes | `rec8z5znsvpOz5ieD` |
| `module_development` | Yes | `rec7mwdDoYx5H5RTK` |
| `module_finance` | **No** (Finance not live in TEST) | `recI5wFXcjUfY6BXy` |
| `module_communications` | **No** (not built) | `rec8MzGEXVAPeBiom` |
| `module_system` | Yes | `recs4GKANVtf7iLl4` |

Module gating is an *additional* safeguard on top of Default Enabled and
Evaluation Status.

### NA1.6 Case-key contract (documented only; no code)

```
<ruleKey>|<type>:<recordId>[|<type>:<recordId>...]
e.g. no_lead_coach|occurrence:recXXXXXXXXXXXXXX
     coach_compliance_expiry|coach:recAAA|requirement:recBBB
     cover_open|coverdate:recCCC
     coach_schedule_conflict|coach:recAAA|occurrence:recLOW|occurrence:recHIGH
```

- **Deterministic.** The same underlying situation always yields the same
  string. Segment order is exactly as documented per rule. Where a rule has
  two same-type subjects (conflict pairs), their ids are sorted ascending.
- **Stable.** Only record ids and fixed type tokens are used. **No
  user-facing labels**: no names, Document Type labels, dates in display
  format or status text. This is why compliance keys use the
  `requirement:<Coach Document Requirements id>` record rather than a
  `doctype:FirstAid` label, which would change if the select option were
  renamed. The one non-record segment allowed is an ISO date
  (`date:YYYY-MM-DD`) where the subject is genuinely a date with no record
  (Planned `expected_occurrence_missing`).
- **Specific.** One case per actionable subject, never per group.
- **Organisation-safe in context.** Keys are evaluated and matched only
  within one organisation, and Exceptions also carry the Organisation
  link. Airtable record ids are unique within this base only. For
  multi-organisation Covaro the key must be scoped by organisation, for
  example matched together with the Organisation link or prefixed with
  `org:<Organisation ID>|` at storage time. *Decided in NA2.5:*
  Organisation is a separate mandatory scope, and the Case Key stays
  org-free.
- Type tokens in use: `occurrence`, `coach`, `requirement`, `coverdate`,
  `allocation`, `summary`, `session`, `venue`, `player`, `claim`,
  `request`, `playerlink`, `parentlink`, `profile`, plus Planned
  placeholders.

### NA1.7 Reconciled catalogue — 38 rules (15 Active, 23 Planned, 0 Retired rows)

**Active (Evaluation Status = Active) — 15**

| ID | Rule Key | Category | Required Module | Default Enabled | Base Severity | Warning | Urgent | Override | Destination / Action |
|---|---|---|---|---|---|---|---|---|---|
| ATT-001 | `no_lead_coach` | Staffing & Cover | module_coaches | Yes | Normal | 72 Hours Before | 24 Hours Before | Yes | Schedule & Sessions / Review Staffing |
| ATT-002 | `learning_coach_only` | Staffing & Cover | module_coaches | Yes | Warning | — | 48 Hours Before | Yes | Schedule & Sessions / Review Staffing |
| ATT-005 | `session_understaffed` | Staffing & Cover | module_coaches | Yes | Normal | 72 Hours Before | 24 Hours Before | Yes | Schedule & Sessions / Review Staffing |
| ATT-011 | `coach_compliance_expiry` | Coaches & Compliance | module_coaches | Yes | Warning | — | — | Yes | Coaches / Review Compliance |
| ATT-012 | `coach_schedule_conflict` | Staffing & Cover | module_coaches | Yes | Warning | — | 48 Hours Before | Yes | Schedule & Sessions / Review Conflict |
| ATT-013 | `session_no_coach` | Staffing & Cover | module_coaches | Yes | Warning | — | 48 Hours Before | Yes | Schedule & Sessions / Assign Staff |
| ATT-014 | `assigned_coach_unavailable` | Staffing & Cover | module_coaches | Yes | Warning | — | 48 Hours Before | Yes | Schedule & Sessions / Review Staffing |
| ATT-018 | `venue_missing` | Sessions & Venues | module_schedule | Yes | Normal | 7 Days Before | 48 Hours Before | Yes | Schedule & Sessions / Assign Venue |
| ATT-031 | `non_compliant_coach_assigned` | Coaches & Compliance | module_coaches | Yes | Warning (lock Warning) | — | 48 Hours Before | No | Coaches / Review Compliance |
| ATT-041 | `cover_open` | Staffing & Cover | module_coaches | Yes | Normal | 48 Hours Overdue *(was 24; corrected in NA2.3)* | 24 Hours Before | No | Coaches / Resolve Cover |
| ATT-042 | `compliance_verification_pending` | Coaches & Compliance | module_coaches | Yes | Normal | — | — | No | Coaches / Review Compliance |
| ATT-043 | `coach_outcome_pending` | Coaches & Compliance | module_coaches | Yes | Normal | 48 Hours Overdue | — | No | Coaches / Record Coach Outcome |
| ATT-044 | `work_summary_queried` | Coaches & Compliance | module_coaches | Yes | Normal | 3 Days Overdue | — | No | Coaches / Review Query |
| ATT-045 | `work_summary_ready_to_finalise` | Coaches & Compliance | module_coaches | Yes | Normal | 3 Days Overdue | — | No | Coaches / Finalise Summary |
| ATT-046 | `work_summary_blocked` | Coaches & Compliance | module_coaches | Yes | Normal | 3 Days Overdue | — | No | Coaches / Resolve Pending Items |

**Planned (Evaluation Status = Planned) — 23**

| ID | Rule Key | Category | Required Module | Default Enabled | Base Severity | Warning | Urgent | Override | Destination / Action |
|---|---|---|---|---|---|---|---|---|---|
| ATT-006 | `occurrence_awaiting_confirmation` | Sessions & Venues | module_schedule | No | Normal | 24 Hours Overdue | — | Yes | Schedule & Sessions / Confirm Session |
| ATT-008 | `coach_signup_pending` | Coaches & Compliance | module_coaches | No | Normal | 2 Days Overdue | — | Yes | Coaches / Review Coach Signup |
| ATT-009 | `parent_claim_pending` | Players & Parents | module_players_parents | No | Normal | 2 Days Overdue | — | Yes | Players & Parents / Review Parent Claim |
| ATT-010 | `player_session_request_pending` | Players & Parents | module_players_parents | No | Normal | 2 Days Overdue | — | Yes | Players & Parents / Review Session Request |
| ATT-015 | `staffing_change_unconfirmed` | Staffing & Cover | module_coaches | No | Normal | 24 Hours Overdue | — | Yes | Schedule & Sessions / Confirm Staffing |
| ATT-017 | `venue_unavailable` | Sessions & Venues | module_schedule | No | Warning | — | 48 Hours Before | Yes | Schedule & Sessions / Review Venue |
| ATT-019 | `session_membership_issue` | Players & Parents | module_players_parents | No | Normal | — | — | Yes | Players & Parents / Review Membership |
| ATT-020 | `register_incomplete` | Players & Parents | module_players_parents | No | Normal | 24 Hours Overdue | — | Yes | Players & Parents / Complete Register |
| ATT-021 | `development_review_due` | Development | module_development | No | Normal | 7 Days Overdue | — | Yes | Development / Review Development |
| ATT-022 | `communication_outstanding` | Communications | module_communications | No | Normal | — | — | Yes | Communications / Send Communication |
| ATT-023 | `communication_failed` | Communications | module_communications | No | Warning | — | — | Yes | Communications / Review Delivery |
| ATT-024 | `invoicing_period_ready` | Finance & Billing | module_finance | No | Normal | — | — | Yes | Finance / Review Invoicing |
| ATT-025 | `finance_sync_failed` | Finance & Billing | module_finance | No | Warning | — | — | No | Finance / Review Finance Sync |
| ATT-026 | `payment_revenue_mismatch` | Finance & Billing | module_finance | No | Normal | — | — | Yes | Finance / Review Payment |
| ATT-027 | `system_sync_failed` | System & Data | module_system | No | Warning | — | — | No | Settings & System / Review System Health |
| ATT-029 | `parent_player_access_incomplete` | Players & Parents | module_players_parents | No | Normal | — | — | Yes | Players & Parents / Review Access |
| ATT-030 | `safeguarding_action_open` | Coaches & Compliance | module_safeguarding *(was module_players_parents; NA2.4)* | No | Urgent (lock Urgent) | — | — | No | Needs Attention / Review Safeguarding |
| ATT-032 | `session_change_not_propagated` | System & Data | module_system | No | Warning | — | — | No | Settings & System / Review Sync |
| ATT-033 | `player_information_incomplete` | Players & Parents | module_players_parents | No | Normal | — | — | Yes | Players & Parents / Review Player |
| ATT-034 | `session_billing_setup_missing` | Finance & Billing | module_finance | No | Normal | — | — | Yes | Finance / Review Billing Setup |
| ATT-035 | `session_over_capacity` | Sessions & Venues | module_players_parents | No | Normal | — | — | Yes | Schedule & Sessions / Review Capacity |
| ATT-036 | `data_housekeeping_failed` | System & Data | module_system | No | Normal | — | — | No | Settings & System / Review Housekeeping |
| ATT-038 | `expected_occurrence_missing` | System & Data | module_system | No | Warning | — | — | Yes | Schedule & Sessions / Review Session |

**New rules (not in production):**

- `cover_open` (ATT-041)
- `compliance_verification_pending` (ATT-042)
- `coach_outcome_pending` (ATT-043)
- `work_summary_queried` (ATT-044)
- `work_summary_ready_to_finalise` (ATT-045)
- `work_summary_blocked` (ATT-046)

**Rewritten semantics:**

- `no_lead_coach`
- `session_understaffed`
- `session_no_coach`
- `learning_coach_only`
- `coach_compliance_expiry`
- `non_compliant_coach_assigned`
- `coach_schedule_conflict`
- `assigned_coach_unavailable`
- `venue_missing`

These are rewritten against the real TEST resolvers (Slices 3/7/8/9). Full
text is in each row's Description.

**Production rules NOT seeded in TEST.** Their ATT numbers are reserved and
never reused.

| Prod ID | Rule Key | Why |
|---|---|---|
| ATT-003 | `cover_requested` | Merged into `cover_open` (one case per cover date) |
| ATT-004 | `cover_unresolved` | Merged into `cover_open` |
| ATT-007 | `session_change_followup` | Vague; superseded by the specific `coach_outcome_pending` |
| ATT-016 | `coach_cost_exception` | Superseded by `work_summary_blocked` (unconfirmed/invalid cost blocks the summary); any further cost/profitability signal belongs to Finance |
| ATT-028 | `required_setup_missing` | Vague catch-all — not activated, not seeded (no rules just for completeness) |
| ATT-040 | `duplicate_active_record` | Vague catch-all — not seeded; specific duplicate checks (e.g. conflicting compliance records) are already covered by specific rules |
| ATT-037 | `occurrence_during_break` | Retired — no Schedule Break concept in the TEST model (exclusions are applied by the generator) |
| ATT-039 | `operating_period_missing` | Retired — no Operating Period concept in the TEST model |

The brief said "Retire / do not seed". These were therefore **not
seeded**, not even as `Retired` rows. The `Retired` Evaluation Status value
exists for future retirements of rules that have been seeded. The
verification script asserts that none of these keys or IDs is present.

### NA1.8 Defaults

- **Default Enabled = Yes** for all 15 Active rules: the reliable core
  operational rules backed by live TEST data and existing resolvers.
- **Default Enabled = No** for all 23 Planned rules. Their modules are
  either not ready (Finance and Communications are also module-disabled)
  or their source data is not driven yet:
  - Confirmation State, Register State, venue availability, the
    safeguarding log, run logs;
  - Supabase profiles, which are blocked on the organisation-ID
    prerequisite.
- **Locked minimum severities** (kept from production):
  - `non_compliant_coach_assigned` = Warning;
  - Planned `safeguarding_action_open` = Urgent.
- **Compliance.** `coach_compliance_expiry` has **no** Warning/Urgent
  threshold. Review Soon comes only from each requirement's own
  `Review Lead Days`. Severity: Review Soon = Warning; Expired = Urgent
  (fixed, state-based).
- **Override** is off for:
  - `cover_open` (resolve or cancel instead);
  - `compliance_verification_pending`;
  - `non_compliant_coach_assigned`;
  - `coach_outcome_pending`;
  - the three work-summary rules.

  These all need a real action, not an acceptance. Override is on for the
  staffing, venue, schedule-conflict and unavailability rules, where
  Management may knowingly accept a situation.
- All other default thresholds are in the NA1.7 table. They are sensible
  starting values, customisable per organisation via Settings.

### NA1.9 Staffing, cover and look-ahead semantics

- **Roles.** The session roles are Lead Coach, Coach, Learning Coach and
  Volunteer (Volunteer is deferred; see NA1.10).
  - **Counting staff** = active resolved roster members whose Role Key is
    `lead_coach` or `coach`.
  - Learning Coach does not count.
  - A role that cannot be resolved does not count. This fails safe: it
    can only *raise* a staffing case, never hide one.
- **Resolved staffing.** This is the Coaches Slice 3 resolver:
  effective-dated Session Staff applying on the occurrence Date, plus that
  occurrence's Occurrence Staff exceptions (cover replacement, addition,
  absence).
- **No Lead Coach (3.1).** Raised only when the Session's
  `Requires Lead Coach` = Yes **and** the resolved roster has ≥1 member
  but no active `lead_coach`.
- **Understaffing (3.2).** Based only on `Required Staff Count`, with no
  ratios. Raised when counting staff ≥1 and < Required Staff Count. A
  blank or 0 count means no case.
- **Capacity vs staffing (3.3).** Capacity is separate
  (`session_over_capacity`, Planned). **Overstaffing is allowed and never
  raises a case.** A future profitability warning belongs to the Finance
  module, not to Needs Attention staffing rules.
- **Zero-staff precedence (3.5).** When the resolved roster is empty,
  **only** `session_no_coach` is raised. `no_lead_coach`,
  `session_understaffed` and `learning_coach_only` are suppressed for that
  occurrence.
- **Lead required + Learning Coach only.** *Resolved:* the locked
  precedence is in NA2.2. Only `no_lead_coach` is raised.
- **Cover (3.6/3.7).** There is exactly **one** case per cover date:
  `cover_open`, keyed on the Staff Availability Requests row with
  `Cover Date Status` = Open. Its severity model:
  - **Normal** when raised.
  - **Warning** once the request has been open ≥ Warning threshold, i.e.
    request age measured from the cover date row's created time.
    *Superseded:* the default is now locked at **48 hours** (NA2.3). The
    original provisional default was 24 hours.
  - **Urgent** when the occurrence starts within the Urgent threshold
    (default 24 **Hours Before**). This is driven by time until the
    session, not by request age.

  Cover workflow code was not changed.
- **Look-ahead (3.8).** The default look-ahead is **14 days** for staffing
  rules and the other forward-looking occurrence rules. The Rules model
  has **no clean field** for this: the Warning/Urgent thresholds are
  escalation points, not an evaluation window, and repurposing them would
  change their meaning. So no field was added or repurposed. The 14 days
  is documented here and in each affected rule's Description as an
  **evaluator constant for Slice 2**. If it needs to become configurable,
  add a dedicated field (for example `Default Look-ahead Days`) in a later
  slice.

### NA1.10 Volunteer — NOT added (deferred, reported)

A `Volunteer` Coach Roles row was **not** added, and Coach Roles is
unchanged at 3 rows. This does not trigger the brief's STOP condition,
because the player-data path does not treat "anything not Learning Coach"
as full access. It is still not the safe data-only extension the brief
required:

- **Player data: safe.** In `hub-content/player-access.ts`,
  `PLAYER_ACCESS_ROLE_PRIORITY = { lead_coach, coach }` is an allow-list.
  A `volunteer` role key would get **no** player access.
- **Cover suitability: not safe.** `coach-cover/staffing.ts` has
  `ROLE_RANK = { learning_coach:1, coach:2, lead_coach:3 }`, and an
  unknown key has rank `null`. So in `evaluateSuitability`:
  - a Volunteer candidate gets only a `role_capability_unknown`
    **warning**;
  - a Learning Coach gets a hard `role_insufficient` **blocker**.

  With `confirmWarnings: true`, Management could therefore select a
  Volunteer to cover a Coach or Lead Coach. The confirm step then writes an
  Occurrence Staff Cover row with `Planned Role Snapshot` = the
  *requester's* role (`cover-workflow.ts`). The Volunteer would then
  **inherit Coach-level player access for that date**, contradicting
  decision 3.4 ("no automatic player-data access").
- **Parent display.** `parent-hub` would show a Volunteer's name after
  the known roles. This is harmless but unplanned.

Fixing the cover path means changing cover code, which was out of scope
("do not alter cover code"). **Prerequisite before adding Volunteer:**
cover suitability must treat `volunteer` as a hard blocker for replacing
counting roles, for example by giving it rank 0 below Learning Coach.
The staffing-count semantics in NA1.9 already treat an unknown or
Volunteer role as non-counting, so the Needs Attention rules need no change
when Volunteer is added.

### NA1.11 Organisation identity

- **Canonical organisation (TEST Airtable).** Organisation & Branding
  `recYXqi1DTZ8ZECPQ`, Organisation ID **`ORG-TEST-001`**, "Josh Evans
  Soccer School (TEST)", Europe/London. Settings and Exceptions link to
  this record through their `Organisation` field.
- **Known mismatch (NOT fixed in Slice 1).** All 6 TEST Supabase
  `profiles` rows carry `organisation_id = 'ORG-JOSHEVANS'`, and the
  frontend default is also `ORG-JOSHEVANS`. The Airtable canonical ID is
  `ORG-TEST-001`. Supabase profile organisation IDs were deliberately not
  modified.
- **Prerequisite for Slice 2 organisation enforcement.** Before the
  evaluator scopes anything by the caller's `profiles.organisation_id`,
  the two identifiers must be reconciled: re-point TEST profiles to
  `ORG-TEST-001`, or add an explicit mapping. Otherwise every
  organisation-scoped lookup will find no Settings/Exceptions (fail
  closed) or, worse, be bypassed. *The audit is in NA2.1. The profiles
  were aligned to `ORG-TEST-001` in NA3.*

### NA1.12 Verification

- **Schema, catalogue and isolation (scripted).** A script checked the
  live schema (`get_table_schema`) and all 38 live rule records against the
  seeding spec: **1,302 checks, 0 failures**. It covered:
  - every field name and type, the exact option lists and the link
    targets;
  - Organisation links point to TEST `tblKKDnM19PqQ7rtc`;
  - Exceptions date-time format and time zone;
  - no Target Type/ID fields, and no Cases table;
  - an ID-level diff showing pre-existing tables unchanged apart from the
    6 inverse links;
  - the row count (38), Rule Key and Rule ID unique, keys snake_case;
  - every field of every row equals the spec;
  - every Active rule has category, description, severity, destination,
    action, module and status, and is default-enabled;
  - no Planned rule is default-enabled, and no retired/merged key or ID is
    present;
  - exactly one cover rule (`cover_open`);
  - the new Coaches-derived rules are Active;
  - compliance has no second threshold;
  - thresholds pair with their timings and appear only when supported;
  - base severity ≥ locked minimum;
  - every Description documents its Case Key form.
- **Settings and Exceptions.** Both have 0 rows. The Case Key and audit
  fields (`Created`, `Last Updated`, `Approved …`) are present.
- **Feature Controls.** Exactly the 7 `module_*` rows above; no
  `legacy_assigned_coaches` row.
- **hub-content, live via pg_net.**
  - `/players` (coach A JWT) returned 200 and was **byte-identical** before
    and after: md5 `685b11e7…`, 771 bytes.
  - `/settings` returned 200. The payload **minus `features`** was
    identical before and after (md5 `c4aa115a…`). `features` went from `{}`
    to the 7 `module_*` booleans, which no frontend code reads.
- **Volunteer.** Not added; Coach Roles is still 3 rows (see NA1.10).
- **Regression.** `node tests/run-all.js` passed **56/56 files, 1,416
  PASS, 0 FAIL**. That is identical, check for check, to the
  post-Coaches-handoff baseline.

### NA1.13 Not built (Slice 2+)

- No evaluator, Edge Function (`supabase/functions-test/needs-attention`
  does not exist), repository, API route or exception write route.
- No queue UI, Home widget, Settings UI or notifications.
- No Finance, Players/Parents, Communications or Development logic.
- No Supabase tables, storage or caching.

**Prerequisites before Slice 2:** these were worked through in the
**Pre-Slice-2 Technical Prep** section below (NA2). The outcome of each
item is recorded there.


---

## Needs Attention — Pre-Slice-2 Technical Prep — TEST only — 2026-09-28

**Scope.** A narrow prerequisite pass before Slice 2. The only changes are
TEST Airtable catalogue values, one Feature Controls row and
documentation. **No code was changed or deployed.** There is no
evaluator, repository, Edge Function, API or UI. TEST Supabase was **not**
modified (see NA2.1). Production was only *read*: its
`profiles.organisation_id` default, its signup trigger and its
Organisation & Branding row. This section supersedes the Slice 1 items it
names. Those items are marked in place in the Slice 1 section.

**Pre-checks.**
- Branch `foundation/test-base-isolation`; HEAD = origin = `9c7ed15`;
  clean tree.
- The Slice 1 tables and the 38-rule catalogue are present.
- The 7 `module_*` Feature Controls rows are present.
- Settings and Exceptions are empty.

### NA2.1 Organisation identity — audit and outcome (APPLIED later; see NA3)

**Where `organisation_id` / `ORG-JOSHEVANS` / `ORG-TEST-001` are used in
TEST:**

| Place | Use | Behavioural dependency |
|---|---|---|
| `profiles.organisation_id` column | `text NOT NULL DEFAULT 'ORG-JOSHEVANS'` | Stores the value only |
| `public.handle_new_user()` (trigger `on_auth_user_created` on `auth.users`) | **Hard-codes** `'ORG-JOSHEVANS'` for every new signup | Signup path |
| RLS on `profiles` | `Users can read own profile`: `auth.uid() = user_id` | None (org not referenced) |
| Other public functions (the 9 lock RPCs, `validate_cron_secret`) | — | None (org not referenced) |
| `supabase/functions-test/me/index.ts` | Selects and **echoes** `organisation_id` | None (never compared) |
| The other 9 TEST functions (coach-*, hub-content, parent-hub, session-occurrences, occurrence-financial-outcomes) | Select `role, airtable_person_id, active, display_name` only | **None** |
| `hub-content /settings` | Returns the Airtable `Organisation ID` of the Active Organisation & Branding row (`ORG-TEST-001` in TEST) | Display only |
| Frontend `content-provider.js` | `organisation_id: 'ORG-JOSHEVANS'` as a **fallback default** only, overridden by `/settings`. No frontend code reads `/me`'s `organisation_id` | None |
| Test mocks (`tests/support/hub-content-mock*.js`, 3 e2e tests) | Mock `/me` returns `ORG-JOSHEVANS` | None (the frontend never reads it) |

The 10 deployed TEST functions are exactly the 10 in `functions-test`.

**Answers.**

1. **Which functions depend on the profile organisation value?** None
   behaviourally. `me` only echoes it. No auth, RLS, role or Airtable
   lookup compares it.
2. **Would changing TEST profiles to `ORG-TEST-001` alter auth or access?**
   No, for existing users.
3. **Is `ORG-JOSHEVANS` hard-coded?** Yes, in two TEST runtime places:
   - the `handle_new_user()` signup trigger;
   - the `profiles.organisation_id` column default.

   It is also the frontend fallback default and appears in test mocks;
   neither is behavioural.
4. **Do TEST and production assume the same ID?** Production is
   internally consistent: Airtable Organisation ID = `ORG-JOSHEVANS`, all
   profiles = `ORG-JOSHEVANS`, and the same trigger and default. Only TEST
   Airtable was deliberately renamed to `ORG-TEST-001`. TEST Supabase
   still mirrors production.
5. **Do tests rely on the current value?** No. The mocks carry it, but no
   assertion or frontend path reads it.

**Why the profiles were NOT aligned in this task.** Updating the 6 profile
rows alone would re-split the identity at the very next TEST signup: the
trigger and the column default would keep minting `ORG-JOSHEVANS`. That is
a worse state than today. A correct alignment therefore also changes the
**auth signup trigger** and a **column default**. That is beyond the
permitted "profile organisation IDs only", and the brief requires a STOP
for auth-path changes. No workaround or dual-ID compatibility logic was
added.

**Smallest prerequisite plan: one TEST-only migration.** It was
subsequently **approved and applied** as migration
`test_org_id_alignment_org_test_001`; see NA3.

```sql
-- TEST ONLY (dkqubldmfyeuudecxmvh). NEVER apply to production (bkkukymqaxawnudoxdjs),
-- whose Airtable Organisation ID genuinely is ORG-JOSHEVANS.
begin;
alter table public.profiles alter column organisation_id set default 'ORG-TEST-001';
create or replace function public.handle_new_user()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  insert into public.profiles (user_id, organisation_id, role, active)
  values (
    new.id,
    'ORG-TEST-001',
    case when new.raw_user_meta_data ->> 'account_type' = 'parent' then 'parent' else 'pending' end,
    true
  );
  return new;
end;
$function$;
update public.profiles set organisation_id = 'ORG-TEST-001' where organisation_id = 'ORG-JOSHEVANS';
commit;
```

- **Expected impact:** none on auth or access (per answers 1–2). `/me`
  would echo `ORG-TEST-001`.
- **Verification after applying it:**
  - all 6 profiles are `ORG-TEST-001`;
  - `/me`, `/players`, parent-hub and a coach-* route work for
    Management, Coach and Parent;
  - a throwaway signup gets `ORG-TEST-001` (then delete it);
  - the production default and trigger are unchanged;
  - full regression passes.
- **Promotion note:** this migration is TEST-specific and must be
  excluded from any production promotion. The long-term Covaro design
  (deriving the organisation at signup from the hub or tenant context
  instead of a literal) is out of scope.
- **Not changed:** the frontend fallback default and the test mocks.
  Both are shared with production and non-behavioural.

### NA2.2 Staffing precedence — LOCKED

This applies per occurrence, after resolving staffing.
- **Counting** staff = Lead Coach + Coach.
- **Non-counting** = Learning Coach, unresolvable roles, and future
  Volunteer.

| Resolved roster | Requires Lead Coach | Raise | Suppress |
|---|---|---|---|
| Empty (0 staff of any role) | any | `session_no_coach` only | `session_understaffed`, `no_lead_coach`, `learning_coach_only` |
| ≥1 staff, 0 counting (Learning Coach / non-counting only) | Yes | `no_lead_coach` only | `learning_coach_only` (and `session_understaffed`, which needs counting ≥1) |
| ≥1 staff, 0 counting | No / blank | `learning_coach_only` only | `session_understaffed` (needs counting ≥1) |
| ≥1 counting, no Lead Coach | Yes | `no_lead_coach` | — |
| ≥1 counting, below Required Staff Count | any | `session_understaffed` | — |

The descriptions of `no_lead_coach`, `learning_coach_only` and
`session_understaffed` in the TEST catalogue now state this precedence.

**LOCKED (confirmed after NA2):** if a session requires a Lead Coach, has
at least one Coach, has no Lead Coach, **and** is below Required Staff
Count, raise **both** `no_lead_coach` and `session_understaffed`. These
are two distinct actionable problems, so neither suppresses the other.
The last two rows of the table above are therefore cumulative.

### NA2.3 Cover severity — LOCKED

`cover_open` (ATT-041) catalogue defaults:
- **Base: Normal** when cover is first requested.
- **Warning:** Default Warning Threshold changed from **24 to 48**,
  `Hours Overdue`, measured from the cover date row's created time.
- **Urgent:** 24 `Hours Before` the occurrence start while cover is
  still unconfirmed (unchanged).
- **If Warning and Urgent both apply, Urgent wins.** Effective severity
  is the highest applicable.

**Known technical debt (deliberately not changed):** the Coaches Slice 9
`unfilledSignal()` in `coach-cover/cover-workflow.ts` still flags a cover
date as unfilled once it has been Open ≥ **24h** since creation. That is a
cover-workflow signal, **not** the Needs Attention severity rule. The
evaluator must use the `cover_open` catalogue thresholds and must not
reuse `unfilledSignal()` for severity. Cover code was not altered.

### NA2.4 Safeguarding — dedicated future module

- `safeguarding_action_open` (ATT-030):
  - Required Module changed from `module_players_parents` to
    **`module_safeguarding`**. A new Required Module choice was added
    (`selL1xeRqBpp8EtsP`).
  - Evaluation Status stays **Planned**, Default Enabled **No**, Locked
    Minimum **Urgent**.
  - The description states it is not part of Players & Parents.
- Feature Controls row `module_safeguarding` (`recwDhVDM9IubLIrM`):
  **Enabled = No**, Audience Management, Sort 108.
  - **Why this is safe:** it follows the same analysis as NA1.5.
    hub-content `/settings` now returns `module_safeguarding: false`;
    `/players` only reads `legacy_assigned_coaches`; the frontend's
    `feature()` is never called.
- **Activation preconditions:** the rule and module must stay inactive
  until a safeguarding source of truth exists and permissions, restricted
  visibility and audit requirements are designed. No safeguarding
  workflow was built.

### NA2.5 Case Key organisation scoping — contract

- **Case Key stays a clean, org-free business key**, for example
  `no_lead_coach|occurrence:recABC` (the NA1.6 grammar is unchanged).
- **Case identity = (Organisation, Rule, Case Key).** Organisation is a
  separate, mandatory scope:
  - it is carried on every derived case;
  - it is the `Organisation` link on every Settings and Exceptions row.
- **Evaluation scope.** The evaluator resolves exactly one organisation
  per run. It takes the caller's `profiles.organisation_id` and maps it to
  the single Active Organisation & Branding row with that
  `Organisation ID`. Zero or several matching rows means fail closed: no
  cases and an explicit error, never "all orgs". It then reads only that
  organisation's Settings and Exceptions.
- **An exception suppresses a case only if all of these hold:**
  - `Organisation` = the evaluated organisation;
  - `Rule` = the case's rule;
  - the `Rule`'s `Rule Key` equals the Case Key's first segment;
  - `Case Key` equals the case's key exactly (string equality);
  - `Active` = Yes;
  - `Effective Until` is blank or in the future;
  - the rule supports override and the organisation does not disallow
    it.
- Case Keys are **never** compared across organisations. Any future
  shared store or cache must key on `(organisation record id, Case Key)`.
  The organisation is not embedded in the Case Key, because the
  organisation scope makes that unnecessary.
- Not implemented yet (Slice 2).

### NA2.6 Work Summary effective status — contract

**Finding.** Stored `Status` is rewritten only by `applyRefresh()`
(`coach-work-summaries/orchestrator.ts`). That runs on
prepare/refresh/finalise paths; `readSummary`/`listSummaries` do not
refresh. A summary can therefore sit at a stale `Not ready` after its
pending items were resolved, or at a stale `Needs review` after a new
pending item appeared.

**Contract for the evaluator.** Recompute, and never mutate.
Needs Attention must derive the *effective* status with the **same pure
functions** the Work Summary code uses. They are all already exported
from `coach-work-summaries/work-summaries.ts`:
- `isActive`, `summaryStatus`, `summaryPeriod`;
- `classifyAllocation`, `openStatusFor`, `ukToday`.

```
effectiveStatus(summary, allocations, occurrences, sessions, now):
  if !isActive(summary)                → no case
  stored = summaryStatus(summary); period = summaryPeriod(summary); if either is null → no case
  if stored == "Finalised"             → "Finalised"
  if stored == "Queried"               → "Queried"      // applyRefresh never moves Queried
  today   = ukToday(now)
  pending = allocations where classifyAllocation({allocation, occurrence, session}, coachId, period, today).kind == "pending"
  return openStatusFor(pending.length, period, today)   // identical to applyRefresh's `next`
```

This mapping mirrors `applyRefresh()` line for line.
- `work_summary_queried` ⇔ effective `Queried`.
- `work_summary_ready_to_finalise` ⇔ effective `Needs review`.
- `work_summary_blocked` ⇔ effective `Not ready` **and** `period.end <
  today`.

**Rules for the evaluator:**
- Do not patch `Status`, `Grand Total`, lines or History.
- Do not write a second status algorithm.
- Following repo convention, the Slice 2 function carries a verbatim copy
  of `work-summaries.ts` with a drift test.

**One tiny, optional, no-behaviour-change refactor for Slice 2:** the
10-line `evaluate()` loop in `orchestrator.ts` is currently private. Move
it into `work-summaries.ts` as an exported pure helper, so the evaluator
and `applyRefresh()` share the loop too. This needs a
`coach-work-summaries` redeploy and byte-verification. It is **not**
required now, and nothing was changed in this task.

### NA2.7 Volunteer — prerequisite (still deferred)

**Exact access gap.**

1. `coach-cover/staffing.ts:166` has
   `ROLE_RANK = { learning_coach:1, coach:2, lead_coach:3 }`. `roleRank()`
   returns `null` for any other key, including `volunteer`.
2. `coach-cover/orchestrator.ts:187` takes `candidateRole` from
   `coachRoleCapabilityOnDate()`. That is the strongest ranked role the
   candidate holds on that date, so a Volunteer-only candidate gets
   `null`.
3. `coach-cover/cover-workflow.ts:296` turns a `null` candidate role into
   only the **warning** `role_capability_unknown`. A Learning Coach gets
   the **blocker** `role_insufficient` (line 304).
4. With `confirmWarnings: true`, confirm writes an Occurrence Staff Cover
   row with `"Planned Role Snapshot": roleName`. That is the
   **requester's** role (`cover-workflow.ts:500`).
5. `hub-content/player-access.ts:545` resolves occurrence access from
   that snapshot. `PLAYER_ACCESS_ROLE_PRIORITY` (line 383) then grants
   Coach-level player access for that date.

**Recommended smallest future fix.** Add `volunteer: 0` to `ROLE_RANK`
(and the hand-kept test copy `tests/support/coach-cover-staffing.ts`).
- A Volunteer candidate then has a *known* rank below Learning Coach.
  `evaluateSuitability()` returns the hard `role_insufficient` blocker
  for any covered role, so they can never be selected, even with
  `confirmWarnings`.
- No other logic changes. The rank is compared with `<`/`>` and tested
  with `!= null`, so a value of `0` is safe.
- A person who is Volunteer on one session but Coach on another keeps
  their strongest role for that date. That is consistent with the
  "different role on another session" model.

This was preferred over a full role-capability engine or a change to
the confirm path.

**To add Volunteer later (one small slice):**
- the `ROLE_RANK` change above, redeployed and byte-verified, with a
  suitability test (Volunteer → `unsuitable`/`role_insufficient`);
- a Coach Roles row with Role Key `volunteer` and all capability boxes
  off;
- a player-access test (volunteer → no access, which the allow-list
  already guarantees);
- optionally, `"Volunteer": 3` in parent-hub `ROLE_DISPLAY_PRIORITY`
  (display order only).

Staffing counts need no change: Volunteer is already non-counting under
NA2.2. Volunteer has no automatic coach cost, because allocations are
created explicitly and not derived from role.

**Related pre-existing debt (not Volunteer-specific):** a candidate with
*no* current recurring role also gets only `role_capability_unknown`.
Once confirmed, they inherit the requester's role. This was Slice 9's
deliberate "Management review" design. Revisit it together with the
Volunteer slice: for example, make `role_capability_unknown` a blocker
when the covered role grants player access.

**Status: Volunteer remains deferred.** The fix touches cover code and
needs a redeploy, which is outside this task.

### NA2.8 Verification

- **Catalogue (scripted).** The Slice 1 verifier was re-run against live
  records and schema with the updated spec: **1,304 checks, 0 failures**.
  - A spec diff shows exactly 7 intended value changes across 5 rules:
    - descriptions of `no_lead_coach`, `learning_coach_only` and
      `session_understaffed`;
    - `cover_open`'s warning threshold and description;
    - `safeguarding_action_open`'s module and description.
  - `cover_open` Warning = 48 Hours Overdue; Urgent = 24 Hours Before.
  - Safeguarding: Planned, Default Enabled No, `module_safeguarding`,
    lock Urgent.
  - Still exactly 15 Active and 15 default-enabled rules, so no rule was
    accidentally activated.
  - Settings and Exceptions are still empty.
- **Feature Controls.** 8 rows. `module_safeguarding` is **disabled**,
  and there is no `legacy_assigned_coaches` row.
- **Live hub-content via pg_net.**
  - `/players` (coach A) returned 200 and is **byte-identical** to the
    Slice 1 baseline (md5 `685b11e7…`).
  - `/settings` returned 200. The payload minus `features` is unchanged
    (md5 `c4aa115a…`); `features` gained `module_safeguarding: false`.
  - `/me` returned 200 for Management and Parent, still
    `ORG-JOSHEVANS`.
- **Supabase.** Not modified: still 6 migrations, and profiles are
  unchanged. Production was read-only.
- **Regression.** `node tests/run-all.js`: **56/56 files, 1,416 PASS,
  0 FAIL**, identical check for check to the Slice 1 run.

### NA2.9 Slice 2 readiness

Cleared: staffing precedence (NA2.2), cover severity (NA2.3), safeguarding
classification (NA2.4), the Case Key scoping contract (NA2.5), the Work
Summary contract (NA2.6), and the Volunteer prerequisite, documented and
deferred (NA2.7).

**Still blocking Slice 2:** TEST organisation alignment (NA2.1).
*Update: cleared in NA3. All pre-Slice-2 prerequisites are now cleared.*


---

## TEST Organisation ID Alignment (ORG-JOSHEVANS → ORG-TEST-001) — TEST only — 2026-09-28

### NA3.1 What was applied

Migration **`test_org_id_alignment_org_test_001`** was applied to TEST
Supabase `dkqubldmfyeuudecxmvh` only. The migration count went from 6 to
7. It is exactly the SQL in NA2.1:

1. The `public.profiles.organisation_id` default changed from
   `'ORG-JOSHEVANS'` to **`'ORG-TEST-001'`**.
2. `public.handle_new_user()` was replaced. The only change is the
   literal, from `'ORG-JOSHEVANS'` to **`'ORG-TEST-001'`**. It is still
   `SECURITY DEFINER` with `search_path public`, and the role logic is
   unchanged: `parent` if `account_type = parent`, otherwise `pending`.
   The trigger `on_auth_user_created` on `auth.users` is still enabled.
3. All 6 profiles were updated from `ORG-JOSHEVANS` to **`ORG-TEST-001`**.
   Roles and active flags are unchanged: 2 coach, 1 management and
   3 parent, all active.

No compatibility logic accepting both IDs was added. No Edge Function,
frontend, test or Airtable change was needed or made.

**TEST now uses one organisation identity everywhere:**
- Supabase profiles, the column default and the signup trigger;
- Airtable Organisation & Branding `recYXqi1DTZ8ZECPQ`;
- Needs Attention Settings and Exceptions, through that record.

**Production is not affected and must never receive this migration.**
Production was re-read before and after, and is unchanged:
- default `ORG-JOSHEVANS`;
- trigger md5 `fd119c28…`;
- 6 profiles, all `ORG-JOSHEVANS`;
- 6 migrations.

Production correctly keeps `ORG-JOSHEVANS`, which is its real Airtable
Organisation ID. Exclude this migration from any production promotion
manifest.

### NA3.2 Verification

**Database.**
- The column default is `'ORG-TEST-001'`.
- All 6 profiles are `ORG-TEST-001`; 0 have any other value.
- 0 public functions and 0 column defaults still contain
  `ORG-JOSHEVANS`, and no RLS policy references an organisation.
- `supabase/functions-test/` contains no `ORG-JOSHEVANS`.

**Signup trigger, proven without side effects.** Two throwaway
`auth.users` rows were inserted inside a DO block that ends by raising an
exception, so everything was rolled back:
- the coach-style signup produced `ORG-TEST-001` with role `pending`;
- the parent signup (`account_type = parent`) produced `ORG-TEST-001`
  with role `parent`.

Afterwards, 0 probe users remained, and there are still 6 `auth.users`
and 6 profiles.

**Live auth and access** (pg_net; real password logins for
`manager@`, `coach.a@` and `parent.a@test.invalid`). Every one of the 10
TEST functions accepted its caller:

| Caller | Call | Result |
|---|---|---|
| Management / Coach / Parent | `me` | 200, role correct, `organisation_id = ORG-TEST-001` |
| Coach | `hub-content/players` | 200, **byte-identical** to the baseline (md5 `685b11e7…`) |
| Management | `hub-content/session-participants` | 200 |
| Parent | `parent-hub/me` | 200 (children returned) |
| Parent | `parent-hub/feedback` (no params) | 400 validation: auth passed |
| Management | `parent-hub/claims/pending` | 200 |
| Management | `coach-compliance/summary` | 200 |
| Management | `coach-availability/resolve` (no params) | 400 validation: auth passed |
| Management | `coach-allocations/allocation` (no id) | 400 validation: auth passed |
| Management | `occurrence-financial-outcomes/outcomes` (no id) | 400 validation: auth passed |
| Management | `coach-cover/manage` | 200 |
| Coach | `coach-cover/mine` | 200 |
| Coach | `coach-cover/manage` | **403**, so role gating is unchanged |
| Management / Coach | `coach-work-summaries/summaries` | 200 / 200 |
| Management | `session-occurrences/generate` `{}` | 400 validation: auth passed, nothing generated |

Each "400 validation" handler authenticates the caller before validating
input, so a 400 proves access was granted. Some calls first hit pg_net's
5-second default timeout while 18 Airtable-backed requests ran
concurrently. They were re-issued with a 30-second timeout and returned
200. This was a probe timing artefact, not an access failure.

**Regression.** `node tests/run-all.js`: **56/56 files, 1,416 PASS,
0 FAIL**. That is identical, check for check, to the pre-migration run.
The test mocks still carry `ORG-JOSHEVANS` in their mocked `/me`
payloads. No code or assertion reads that value, and the mocks are shared
with production behaviour, so they were deliberately left unchanged.

### NA3.3 Staffing rule locked (for the future evaluator)

If a session **requires a Lead Coach**, has **at least one Coach**, has
**no Lead Coach**, and is also **below Required Staff Count**, raise
**both** `no_lead_coach` and `session_understaffed` (see NA2.2).

### NA3.4 Status

All pre-Slice-2 prerequisites are now cleared. **Slice 2 has not
started.** No evaluator, API, UI or other change was made.


---

## Needs Attention Foundation — Slice 2 (core engine + read-only API) — TEST only — 2026-09-28

**Scope.** Slice 2 builds the reusable engine and a Management-only
read-only API. **No real domain rule is implemented**: no staffing, cover,
compliance, availability, conflict, Work Summary, Finance, Parent/Player
or safeguarding evaluator. It also adds no exception or Settings writes,
UI, notifications, polling, caching or Supabase storage. Live TEST
therefore returns **Clear**. Production is untouched.

Pre-checks passed before any change:
- HEAD = origin = `378ec8a`; clean tree.
- All 6 profiles and the column default are `ORG-TEST-001`, with 7
  migrations.
- There is 1 Active organisation (`ORG-TEST-001`), 8 Feature Controls
  rows, and empty Settings and Exceptions.

### NA4.1 Architecture — `supabase/functions-test/needs-attention/`

| File | Role |
|---|---|
| `needs-attention.ts` | **Pure engine**, no I/O. Contains: catalogue parsing and dedupe (`buildCatalogue`); organisation resolution (`resolveOrganisation`); module gating (`moduleState`); Settings scoping and inheritance (`settingsForOrganisation`, `resolveEffectiveConfig`); severity (`thresholdReached`, `computeSeverity`); case identity (`buildCaseKey`, `parseCaseKey`, `scopedCaseIdentity`); exception matching (`matchException`); the evaluator contract and registry drift check (`validateRegistry`); planning (`planEvaluation`); case building (`materialiseCases`); `summarise` and `sortCases` |
| `repository.ts` | **Read-only** Airtable access, with no create/update/delete path. `createReader()` lists each table **at most once per request** (a memoised promise per table) and counts list operations and page requests per table. `loadConfig()` loads the 5 config tables in one wave. It has the usual 429 backoff |
| `registry.ts` | The **code-side evaluator registry** `IMPLEMENTED_EVALUATORS`, which is **empty** in Slice 2 |
| `orchestrator.ts` | `getCases()` runs these steps in order: role check → load config → resolve organisation (fail closed) → plan → load the union of runnable evaluators' sources → evaluate → identity, severity and exceptions → summary, ordering and payload |
| `index.ts` | Thin HTTP layer: the TEST production-base guard, Supabase JWT → profile (`role, active, organisation_id`), Management-only, GET `/cases` only, rejection of tenant parameters |

**Tests.** The hand-kept copies `tests/support/needs-attention-{engine,
repository,registry,orchestrator}.ts` have drift checks D1 (byte-identical
apart from import paths). The test file is
`tests/support/needs-attention.test.ts` (99 checks), with shim
`tests/e2e/needsattentiontest.js`. The registry drift fixture is
`tests/support/needs-attention-catalogue.fixture.json`, a snapshot of the
38 TEST rules.

### NA4.2 Endpoint contract (deployed: `needs-attention` v1, `verify_jwt` on)

| Request | Result |
|---|---|
| `GET /cases` | Full queue: `{engine, organisation, generatedAt, complete, summary, cases[], configIssues[]}` |
| `GET /cases?view=summary` | `{engine, organisation, generatedAt, complete, summary}` (for Home) |
| `GET /cases?caseKey=<key>` | `{…, caseKey, exists, suppressed, case, rule:{ruleKey, ruleId, evaluated, skipReason}, configIssues}`. Only that rule is evaluated; an unknown rule gives `skipReason: "unknown_rule"` |
| `&debug=1` | Adds `diagnostics: {rulesInCatalogue, evaluated[], skipped[{ruleKey, ruleId, reason, detail}], sourcesLoaded, reads{lists, pages}, suppressedCases[]}` |
| No / invalid JWT | 401 |
| Coach / Parent / pending / inactive | 403 `Management access required` (checked before any Airtable read) |
| `?organisation=…` (and `organisationId`, `organisation_id`, `org`, `orgId`, `tenant`, …) | **400 `tenant_param_rejected`** |
| Invalid `caseKey` / `view` | 400 |
| Non-GET | 405 |
| Other routes | 404 |
| Profile organisation matches no Active organisation / several | **409 `organisation_not_found` / `organisation_ambiguous`** |
| Evaluator throws | 200 with `complete: false` and a `configIssues` entry `evaluator_error`; other rules' cases are still returned |
| Config table read fails | 500. It is never a silent partial "Clear" |

**Live Clear response** (`GET /cases`, Management, TEST):

```json
{"engine":"needs-attention-slice-2",
 "organisation":{"organisationId":"ORG-TEST-001","name":"Josh Evans Soccer School (TEST)","timezone":"Europe/London"},
 "generatedAt":"2026-09-28T14:05:27.968Z","complete":true,
 "summary":{"state":"Clear","total":0,"counts":{"Normal":0,"Warning":0,"Urgent":0},"suppressed":0},
 "cases":[],"configIssues":[]}
```

**Case shape** (from the synthetic test evaluator; the frontend needs no
extra lookups):

```json
{"caseKey":"syn_alpha|occurrence:recA0000000000002","ruleId":"ATT-901","ruleKey":"syn_alpha",
 "ruleName":"Synthetic Alpha","category":"Staffing & Cover","module":"module_alpha",
 "severity":"Normal","severityReason":"base Normal","title":"Later","detail":"d2",
 "actionLabel":"Review Staffing",
 "destination":{"area":"Schedule & Sessions","route":"/schedule/occurrence","params":{"occurrenceId":"recA0000000000002"}},
 "targetIds":{"occurrenceId":"recA0000000000002"},"relatedIds":{"coachIds":["recC0000000000001"]},
 "anchorTime":"<ISO event anchor>","exceptionAllowed":true}
```

**Ordering:** severity (Urgent first), then rule Sort Order, then the
earliest anchor time (cases without one last), then Case Key.

### NA4.3 Organisation resolution and security

- The organisation comes **only** from the authenticated caller's
  Supabase `profiles.organisation_id`.
- It must exactly match (no aliases, no case-folding) the
  `Organisation ID` of **exactly one Active** Organisation & Branding row.
  Otherwise the request returns 409 and evaluates nothing.
- The old `ORG-JOSHEVANS` is not accepted.
- Tenant-looking query parameters are refused outright.
- Settings and Exceptions are considered only when they link **exactly**
  that one organisation (and exactly one Rule).
- Management-only means role `management` **and** `active`.

### NA4.4 Settings inheritance and module gating (as built)

**Effective config** (`resolveEffectiveConfig`):
- No Settings row → the Rule's defaults.
- A row on a **Client Customisable** rule overrides field by field. A
  blank value inherits that Rule default.
- A row on a non-customisable rule is ignored, with
  `settingsIgnoredReason = rule_not_client_customisable`.
- `Enabled` and `Allow Override` are checkboxes, so an existing row always
  states them explicitly.
- Thresholds exist only if the rule `Supports …Threshold`.
- The effective override permission is `Supports Override` AND (the row's
  `Allow Override` if a row exists, otherwise true). A row can narrow it,
  never widen it.
- Two rows for one rule (or a row linking several organisations or rules)
  → ignored, the defaults apply, and a `settings_conflict` /
  `settings_row_invalid` config issue is reported.

**Gate order.** The first failing check becomes the skip reason:

1. `inactive` (catalogue row not Active)
2. `retired`
3. `planned`
4. `invalid_status`
5. `not_implemented` (no registered evaluator)
6. `registry_mismatch`
7. `module_off` (the Feature Controls row is disabled, **missing**, or
   conflicting)
8. `disabled` (Default Enabled off, no Settings row)
9. `settings_disabled`

A skipped rule's domain sources are **never loaded**.

### NA4.5 Case identity and exception matching

- `buildCaseKey(ruleKey, subjects)` produces `ruleKey|type:id[|type:id…]`.
  - The engine never reorders segments.
  - Types are snake_case. Ids are record ids or ISO dates: no `|`, no
    whitespace, no labels.
  - An evaluator's duplicate keys are deduplicated and invalid ones
    dropped; both are reported.
- Organisation-scoped identity is `scopedCaseIdentity(orgRecordId,
  ruleKey, caseKey)`. Two organisations with the same Case Key never
  collide.
- `matchException` suppresses a case only if **all** of these hold. Any
  unreadable value fails safe, so the case stays visible.
  - `Active`;
  - exactly this organisation;
  - exactly this rule;
  - the Case Key's rule segment equals the rule's key;
  - an exact Case Key string;
  - `Effective Until` is blank or strictly after now (expiring exactly
    now no longer suppresses);
  - the effective override is allowed.
- Suppressed cases are excluded from `cases` and counted in
  `summary.suppressed`. They are listed only in `debug` diagnostics.
- There are **no** exception writes yet.

### NA4.6 Severity model (generic)

Final severity is the highest of:
- the base severity (Settings or default);
- Warning, if the Warning threshold is reached;
- Urgent, if the Urgent threshold is reached;
- the evaluator's fixed `stateSeverity`;
- the Locked Minimum.

`severityReason` explains which of these applied.
- **Before** timings compare the time remaining to `anchors.event`:
  reached when `event − now ≤ span`.
- **Overdue** timings compare the time elapsed since
  `anchors.outstandingSince`: reached when `now − since ≥ span`.
- **Boundaries are inclusive.** Days are fixed 24-hour spans.
- A missing anchor means that threshold cannot escalate. The engine never
  guesses.
- The engine holds no rule-specific timing. Each evaluator supplies the
  anchors and the Rule row supplies the thresholds.

Locked rule semantics for later slices are unchanged: staffing precedence
(NA2.2/NA3.3), cover Normal / Warning at 48h unresolved / Urgent within
24h of the session, where Urgent wins (NA2.3; `unfilledSignal()` is **not**
the severity engine), safeguarding (NA2.4), Volunteer (NA2.7) and Work
Summary recomputation (NA2.6).

### NA4.7 Evaluator registry and drift protection

An evaluator registration is
`{ruleKey, ruleId, sources: [Airtable table names], evaluate(ctx) → CandidateCase[]}`.
The context `ctx` holds `now`, `organisation` (record id, ID, name,
timezone) and the frozen `sources` it declared. A `CandidateCase` holds:
- `subjects` (these build the Case Key);
- `title` and `detail`;
- `anchors` (`event` / `outstandingSince`), `anchorTime` and
  `stateSeverity`;
- `destination` (`route` and `params`; the area comes from the Rule);
- `targetIds` and `relatedIds`.

`validateRegistry` reports:
- duplicate registrations;
- an evaluator with no catalogue row;
- a wrong Rule ID;
- an invalid key.

It runs at request time, reported as `registry_*` config issues, with the
rule skipped as `registry_mismatch`. It also runs in unit tests against
the fixture. Active catalogue rules with **no** evaluator are expected:
they are skipped as `not_implemented`.

### NA4.8 Performance and read model

- **Per request:** the 5 config tables are listed exactly once each, in
  one parallel wave. After that, the union of runnable evaluators'
  sources is loaded once each, in waves of at most 5.
- **Live TEST (debug):** 5 list operations and 5 page requests (one per
  config table). The catalogue has 38 rules, of which 23 are `planned`
  and 15 `not_implemented`. **0 domain sources** were loaded and 0
  evaluators ran.
- **Unit-proven:**
  - config tables are listed once (paging counted separately);
  - a source shared by two evaluators is listed once;
  - a module-off evaluator's source is never read;
  - list operations = 5 + distinct runnable sources, so there are no
    per-rule queries;
  - Coach, Parent and inactive callers cause 0 reads;
  - an organisation failure evaluates nothing and loads no source.
- There is no caching and no Supabase storage.
- The Exceptions table is read whole on each request. That is fine at
  TEST scale. A later slice may filter it server-side; link fields render
  as names in `filterByFormula`, so the filter would need to be on
  `Case Key` or a lookup.

### NA4.9 Verification

- **Unit tests:** `needs-attention.test.ts` has 99/99 checks. They cover:
  - defaults and inheritance (1–10);
  - modules (11–14);
  - Evaluation Status (15–21);
  - registry drift (22–28);
  - severity, including inclusive boundaries, Urgent winning and locked
    minimums (29–42);
  - exceptions (43–54);
  - summary (55–58);
  - identity (59–63);
  - organisation and security (64–70);
  - the API contract (71–82);
  - a TEST-catalogue equivalent returning Clear (83–85);
  - performance (86–90);
  - drift and read-only checks (D1–D6).

  A mutation check (three injected bugs: inclusive boundary, expiry
  boundary, module conflict) produced 5 failures, confirming the suite
  catches regressions. A strict `tsc` typecheck is clean.
- **Full regression:** `node tests/run-all.js` gives **57/57 files, 1,515
  PASS, 0 FAIL**: the previous 56 files / 1,416 plus the new file / 99.
  Every earlier check still passes.
- **Deployment:** `needs-attention` **v1** in TEST, `verify_jwt` on. All 5
  deployed files are **byte-identical** to the repo.
- **Live checks** (pg_net, real password logins):
  - Management `/cases` → 200 Clear, `complete: true`, `ORG-TEST-001`,
    no config issues.
  - `view=summary` → 200 Clear.
  - `debug=1` → 38 skipped (23 planned, 15 not_implemented), 0 sources,
    5 lists and 5 pages.
  - A `caseKey` of `no_lead_coach|occurrence:…` → `exists: false`,
    `skipReason: not_implemented`.
  - Coach and Parent → 403. No auth → 401. An invalid bearer → 401
    (gateway).
  - `?organisation=ORG-JOSHEVANS` and `?organisationId=X` → 400
    `tenant_param_rejected`.
  - POST → 405. A bad `caseKey` → 400. `/exceptions` → 404.
  - **Fail-closed.** The TEST manager's `organisation_id` was temporarily
    set to `ORG-FAILCLOSED-PROBE`: `/cases` → **409
    `organisation_not_found`**. It was restored immediately to
    `ORG-TEST-001`, and all 6 profiles were then confirmed as
    `ORG-TEST-001`, with `/cases` Clear again.
  - **Existing functions still healthy:** `/me` (Management and Parent,
    `ORG-TEST-001`) returned 200. hub-content `/players` (coach A)
    returned 200 and is **byte-identical** to the baseline. coach-cover
    `/manage`, coach-compliance `/summary` and coach-work-summaries
    `/summaries` all returned 200.

### NA4.10 Not implemented, and the Slice 3 handoff

**Not implemented:** every real rule evaluator. Also exception POST and
revoke, Settings editing, UI, Home widget, notifications, polling,
caching, Supabase case storage, Volunteer and safeguarding.

**Slice 3 handoff (staffing rules first):**

1. Add evaluators for `no_lead_coach`, `learning_coach_only`,
   `session_understaffed` and `session_no_coach` to `registry.ts`,
   **with the exact Rule IDs** (ATT-001, ATT-002, ATT-005, ATT-013).
   Declare their shared `sources`:
   - Session Occurrences, Sessions, Session Staff, Occurrence Staff and
     Coach Roles;
   - these are loaded once and shared.
2. Implement the locked precedence **as one staffing pass per
   occurrence**, so suppression across the four rules is decided in one
   place. Two ways to do this:
   - one shared pure helper that each evaluator calls;
   - a shared memoised per-request staffing computation.

   Precedence (NA2.2 / NA3.3):
   - zero staff → `session_no_coach` only;
   - Learning Coach only + Lead required → `no_lead_coach` only;
   - Learning Coach only + no Lead required → `learning_coach_only`;
   - Coach(es), Lead required, no Lead, below Required Staff Count →
     both `no_lead_coach` and `session_understaffed`.
3. Reuse the Coaches Slice 3 roster resolver **verbatim**, with a drift
   test, as every other function does.
4. Use `anchors.event` = the occurrence start, a 14-day look-ahead, the
   `Europe/London` organisation timezone, and a Case Key of
   `<rule>|occurrence:<id>`.
5. Update `needs-attention-catalogue.fixture.json` only if the catalogue
   changes.
6. Later slices: `cover_open` (48h Warning / 24h Urgent anchors; do not
   reuse `unfilledSignal()`), compliance, availability and conflicts,
   then Work Summaries (recompute per NA2.6).
7. Exception write routes must record the Organisation link, the Rule
   link, the exact Case Key and the approver.

**Remaining risks for later slices:**
- Airtable rate limits once several domain tables load per request.
  Waves of 5 and 429 backoff exist, but real-rule latency should be
  measured in Slice 3.
- The Exceptions table is read whole on every request.
- `configIssues` is visible to Management; a future UI must decide how to
  present it.

## Needs Attention Foundation — Slice 3 (occurrence staffing rules) — TEST only — 2026-09-28

> **Partly superseded by NA6 (Slice 3.1 follow-up correction, `needs-attention` v4).** Where NA5 and NA6 differ, NA6 wins. The superseded parts are marked inline below: unknown-role handling (NA5.2), the Coach Active flag (NA5.3), `learning_coach_only` severity (NA5.4), and the read count (NA5.5).

**Scope.** Slice 3 implements exactly four evaluators: `session_no_coach`
(ATT-013), `no_lead_coach` (ATT-001), `learning_coach_only` (ATT-002) and
`session_understaffed` (ATT-005). It adds none of the following:
- cover, compliance, availability or conflict rules;
- Work Summary, exception writes, Settings, UI or notifications;
- Finance, Players/Parents, Development or safeguarding;
- Volunteer, ratios, profitability, Supabase storage or caching.

Production is untouched. `player-access` behaviour is unchanged: the
resolver is **copied** with a drift test, not edited.

Pre-checks passed before any change:
- HEAD = origin = `dafce41` on `foundation/test-base-isolation`;
- `needs-attention` v1 is live and returns Clear;
- the catalogue holds 38 rules (15 Active, 23 Planned);
- all 6 profiles are `ORG-TEST-001`.

### NA5.1 Architecture

| File | Change |
|---|---|
| `needs-attention/staffing.ts` | **New.** (1) A byte-identical COPIED block of the roster resolver (`resolveOccurrenceStaffing` and helpers), from `hub-content/player-access.ts` via `coach-cover/staffing.ts`. (2) The Needs Attention staffing analysis: eligibility, 14-day window, role counting, `staffingFindings()` precedence, the memoised shared pass, case building. (3) `STAFFING_EVALUATORS`: the 4 registrations |
| `needs-attention/registry.ts` | `IMPLEMENTED_EVALUATORS = [...STAFFING_EVALUATORS]`. Exactly 4 rules |
| `needs-attention/needs-attention.ts` | `ENGINE_VERSION = "needs-attention-slice-3"`. A generic optional `context` object on `CandidateCase`, passed through to every case (`{}` when absent). No rule-specific logic |
| `index.ts`, `orchestrator.ts`, `repository.ts` | Unchanged (byte-identical to v1) |

**One shared staffing pass.**
- All four registrations declare the same `sources`: Session
  Occurrences, Sessions, Session Staff, Occurrence Staff and Coach Roles.
  The engine therefore lists each table **once** per request.
- Each evaluator calls `sharedStaffingPass(ctx)`. This is memoised per
  request (a WeakMap keyed on the loaded occurrences array), so the
  indexing and per-occurrence analysis run **once**.
- `staffingFindings(analysis)` decides every rule for an occurrence in
  one place. Each evaluator then keeps only the findings for its own key.
- There are no per-rule or per-occurrence queries.

### NA5.2 Locked precedence (as implemented)

> **Superseded in part (NA6.2).** An unknown-role-only roster no longer raises `learning_coach_only`. Precedence is now decided on **valid** staff only: an active Coach with a recognised active role. Unknown roles become `configIssues`. The precedence table itself is unchanged.

`staffingFindings()` runs once per eligible occurrence. Counting staff is
Lead Coach + Coach; Learning Coach never counts.

| Roster on the occurrence | Requires Lead Coach | Raised |
|---|---|---|
| Nobody (0 staff) | any | `session_no_coach` **only** |
| Learning Coach(es) only | Yes | `no_lead_coach` **only** |
| Learning Coach(es) only | No | `learning_coach_only` |
| ≥1 Coach, no Lead, counting < Required Staff Count | Yes | `no_lead_coach` **and** `session_understaffed` |
| ≥1 Coach, no Lead, counting ≥ Required, or Required blank | Yes | `no_lead_coach` |
| Lead present, counting < Required | any | `session_understaffed` |
| Counting ≥ Required, or Required blank, with Lead where required | — | nothing |
| Counting > Required (overstaffed) | — | nothing (allowed) |

Rules:
- `no_lead_coach` is raised only when Requires Lead Coach = Yes and there
  are 0 Lead Coaches (and the roster is not empty).
- `learning_coach_only` is raised only when counting staff = 0 and Lead
  is not required.
- `session_understaffed` is raised only when counting staff ≥ 1 and
  counting staff < Required Staff Count. With 0 counting staff, the
  higher-precedence rule already covers the gap.

**Role counting.**
- A roster member's role comes from the resolver's role capabilities, via
  its `Role Key`, taken from an **active** Coach Roles row:
  - `lead_coach` → Lead Coach;
  - `coach` → Coach;
  - `learning_coach` → Learning Coach.
- A missing or inactive role, or an unrecognised key, is "unrecognised".
  It is listed in the summary and **never counts**. Fail-safe consequence:
  a roster of only unrecognised roles, with Lead not required, raises
  `learning_coach_only` ("no counting coach"). This is unit-tested (P13
  and P14) and flagged for review.
- **Volunteer is not introduced.** No role key, count or wording
  references it (drift test DR5).

**Required Staff Count.**
- Only integers ≥ 0 are accepted.
- Blank, or any non-integer value, means **no requirement**, so
  `session_understaffed` is never raised.
- 0 is a real value, and it is never understaffed.
- No ratios are used.

### NA5.3 Timing, eligibility and resolution

> **Superseded in part (NA6.3).** The Coach record's `Active` flag IS now consulted. Inactive coaches never satisfy future staffing.

**Horizon.** A fixed `STAFFING_WINDOW_DAYS = 14` constant. There is no
Settings field, and it uses the organisation timezone (`Europe/London`
in TEST).

**Window test:**
- If the occurrence has a usable `Start Date & Time`, it is eligible when
  `now < start ≤ now + 14×24h`.
- Otherwise it falls back to `Date`, which must be between the local
  today and local today + 14 days.
- Past or already-started occurrences are excluded, as are those beyond
  the horizon.
- Undated occurrences are excluded.

**Eligibility.** This follows the real Schedule model and is checked in
order. The first failure excludes the occurrence:
1. Occurrence `Status` must be `Scheduled`. Cancelled, Postponed and
   Completed are excluded.
2. It must have no outgoing `Replacement Occurrence` link. An occurrence
   that has been superseded is excluded even if its Status was not
   updated; the **replacement** occurrence is evaluated normally.
3. It must be linked to a Session.
4. The Session's `Session Lifecycle Status` must be `Active`. This is the
   same rule the occurrence generator uses. As a result, lingering
   Scheduled occurrences of a Draft or Inactive session do not alert.
   Flagged for review.
5. It must fall inside the window.

**Resolution** uses the copied resolver:
- **Session Staff** apply if the row is `Active` and the occurrence date
  is within Effective From and Until (inclusive). This gives the handover
  boundary.
- **Occurrence Staff** override per occurrence:
  - an `Absent` row is ignored; **SUPERSEDED (2026-09-28):** an
    `Absent` row now removes its coach from that occurrence, with or
    without cover (see "Staffing correction — Occurrence Staff Absent");
  - a `Cover` row with a `Session Staff Source` replaces that source
    coach **on that occurrence only**;
  - other rows add a coach;
  - the role comes from Actual, then Planned Role Snapshot (by name),
    then the source row's Role.

The Coach record's own `Active` flag is not consulted, consistent with
the resolver.

### NA5.4 Case contract

> **Superseded in part (NA6.4).** `learning_coach_only` is now Normal / Warning 72h / Urgent 24h, and the context carries new fields.

- **Case Key:** `<ruleKey>|occurrence:<occurrenceRecordId>`, for example
  `no_lead_coach|occurrence:recRu1tEFQqD783iY`. When one occurrence
  raises two rules, it has two distinct keys.
- **Anchors:** `anchors.event` is the occurrence start, so the generic
  Slice 2 severity engine applies the catalogue thresholds unchanged.

  | Rule | Base | Warning | Urgent |
  |---|---|---|---|
  | `session_no_coach` | Warning | — | 48h before |
  | `no_lead_coach` | Normal | 72h before | 24h before |
  | `learning_coach_only` | Warning | — | 48h before |
  | `session_understaffed` | Normal | 72h before | 24h before |

**Payload.** The frontend needs no extra lookups:

- `title` is `"<Rule title> - <Session name>"`.
- `detail` is `"<Tue 6 Oct 2026, 10:00> - <reason> Staff: <summary>."`.
- `destination` is `{area: "Schedule & Sessions", route:
  "schedule/occurrence-staffing", params: {occurrenceId, sessionId}}`.
  This is a logical route for the future UI.
- `targetIds` is `{occurrenceId, sessionId, venueId?}`. The venue comes
  from the occurrence Venue, else the Session Venue.
- `relatedIds.coachIds` lists the resolved roster.
- `context` contains:
  - `sessionName`, `occurrenceName`;
  - `date`, `start`, `end`, `startLocal`;
  - `staffingSummary` (e.g. "1 Lead Coach, 1 Learning Coach");
  - `totalStaff`, `leadCoaches`, `coaches`, `learningCoaches`,
    `unrecognisedRoles` and `countingStaff`;
  - `requiredStaffCount` (`null` when blank) and `requiresLeadCoach`.

`startLocal` uses the runtime ICU `en-GB` short month. The Deno edge
runtime prints September as "Sept", for example "Tue 29 Sept 2026, 10:00".
This is cosmetic only.

### NA5.5 Reads and performance

> **Superseded (NA6.5).** There are now 11 list operations per request, because the Coaches table was added.

- **Per request:**
  - 5 config tables, each listed once;
  - 5 staffing tables, each listed once;
  - **10 list operations** in total, with no duplicates.

  In live TEST each list was 1 page, so there were 10 page requests.
- **Gated off:** if `module_coaches` is off, or the rules are disabled or
  planned, the staffing tables are **not read** (unit G1). Coach, Parent
  and inactive callers still cause 0 reads.
- **Live latency** (`function_edge_logs.execution_time_ms`, `needs-attention` v2):

  | Call | State | Time |
  |---|---|---|
  | First call after deploy (cold start) | Clear | 2,438 ms |
  | Warm call | 11 cases | 1,195 ms |
  | Warm call | Clear | 1,350 ms |

  - For comparison, the Slice 2 warm Clear with 5 reads was about
    1,030 ms. The 5 extra staffing lists add roughly 0.2–0.3 s. The
    cases themselves add nothing measurable.
  - Log ingestion is sampled, so only these three calls have timing rows.

### NA5.6 Verification

**Unit tests.**
- `needs-attention-staffing.test.ts` is **70/70**. It covers:
  - precedence P1–P14, counting R1–R2, window W1–W7 and eligibility
    E1–E4;
  - end-to-end scenarios S1–S18, where one mocked request gives 7 cases,
    one pass and 10 reads, and the payload is checked;
  - severity V1–V3, override/absent/additional O1–O3 and handover H1–H3;
  - cancelled / postponed / replacement / window / inactive C1–C8;
  - gating G1–G3;
  - drift DR1–DR5: the resolver chunks match `player-access.ts`, the
    block is identical to `coach-cover`, registry IDs match the fixture,
    the sources are shared, there is no Volunteer, and the window is 14.
- `needs-attention.test.ts` is **100/100**. It was updated so that:
  - the registry is exactly the 4 staffing rules;
  - the engine is slice-3;
  - `context` is required on cases;
  - the TEST-equivalent run evaluates 4 and skips 34 (11
    not_implemented, 23 planned), with 10 list operations.
- Mutation checks: all 5 injected bugs were caught.
- Strict `tsc` is clean.

**Full regression.** `node tests/run-all.js` gives **58/58 files, 1,586
PASS, 0 FAIL**. That is the previous 57 / 1,515, plus the new staffing
file (70) and one new check in the engine file.

**Deployment.** `needs-attention` **v2** is in TEST, with `verify_jwt` on.
All 6 deployed files are **byte-identical** to the repo (sha256
verified). No other function was deployed.

**Live verification** used real HTTP via `pg_net`, a Management JWT and
**throwaway** records prefixed `NA-S3-PROBE`:
- 13 Sessions and 16 Session Staff rows;
- 22 Session Occurrences and 1 Occurrence Staff row.

The live queue was Clear before creating them. It then returned **exactly
the 11 predicted cases** (`Urgent`, 1 Urgent / 5 Warning / 5 Normal),
with `complete: true` and no config issues:

| Probe | Setup | Live result |
|---|---|---|
| 01 zero staff | Lead req, Required 2, nobody; tomorrow 10:00 | `session_no_coach` only, **Urgent** (48h threshold) |
| 02 LC only + Lead req | 1 Learning Coach | `no_lead_coach` only, Warning (72h) — `?caseKey=learning_coach_only|occurrence:…` → `exists:false` |
| 03 LC only, no Lead req | 1 Learning Coach | `learning_coach_only` only |
| 04 Coach + Lead req + under | 1 Coach, Required 2 | `no_lead_coach` **and** `session_understaffed` |
| 05 fully staffed | Lead + Coach, Required 2 | nothing (`?caseKey=session_understaffed|…` → `exists:false`) |
| 06 understaffed | Lead only, Required 2 | `session_understaffed` only |
| 07 LC not counted | Lead + Learning Coach, Required 2 | `session_understaffed` (counting 1) |
| 08 blank Required | 1 Coach, Required blank | nothing |
| 09 overstaffed | Lead + 2 Coaches, Required 1 | nothing |
| 10 Occurrence Staff override | Lead Alex + Coach Sam; on 4 Oct a Cover row (Morgan, Actual Role "Coach", source = Alex's row) | 3 Oct: nothing. 4 Oct only: `no_lead_coach` (2 Coaches, roster Sam + Morgan) |
| 11 Session Staff handover | Alex until 5 Oct, Sam from 7 Oct | 5 Oct nothing, **6 Oct `session_no_coach`**, 7 Oct nothing |
| 12 eligibility (zero staff) | past (today 12:00Z), inside (+14d, 12 Oct 13:00Z), beyond (12 Oct 22:00Z), Cancelled, Postponed, Scheduled-with-Replacement-link → replacement 6 Oct | only **inside** and **replacement** raised `session_no_coach` |
| 13 Draft Session | zero staff, Scheduled occurrence | nothing |

Endpoint checks:
- `?view=summary` → Urgent, 11.
- `?caseKey=no_lead_coach|occurrence:<O04>` → `exists: true`.
- `debug=1` → 4 evaluated (3 / 4 / 3 / 1 candidates), 34 skipped, 10
  lists and 10 pages.
- Coach and Parent → 403. `?organisation=ORG-JOSHEVANS` → 400
  `tenant_param_rejected`.

**Cleanup.** All **52 probe records were deleted by exact ID**, children
first. Afterwards:
- 0 `NA-S3-PROBE` occurrences remain;
- Sessions = TEST-A and TEST-B only;
- Session Staff = the original 3 rows;
- Occurrence Staff = 0;
- the TEST base has no automations, so no side effects fired.

`/cases` returned **Clear** again with 10 lists.

**Other functions** were re-checked live after cleanup:
- `/me` returned 200 for Management and Parent (`ORG-TEST-001`).
- hub-content `/players` (coach A) returned 200 and is
  **byte-identical** to the baseline (md5 `685b11e7…`, 771 bytes).
- parent-hub `/me` returned 200.
- coach-cover `/manage` returned 200.
- coach-compliance `/summary?coachId=` returned 200.
- coach-work-summaries `/summaries` returned 200.

### NA5.7 Deferred, flagged, and Slice 4 remaining

**Flagged for review:**

> Items 1 and 3 below were resolved by NA6.
- A roster of only unrecognised roles raises `learning_coach_only`
  (fail-safe).
- Occurrences of non-Active sessions are excluded, following the
  generator's rule.
- The Coach record's `Active` flag is not consulted (resolver parity).
- Destination routes are logical routes. The UI does not exist yet.

**Deferred:**
- **Volunteer** is not introduced (NA1.10 / NA2.7 unchanged).
- The Exceptions table is still read whole on each request.

**Slice 4 remaining** (not started):
- `cover_open`, with 48h Warning / 24h Urgent anchors per NA2.3; do not
  reuse `unfilledSignal()`;
- compliance (`coach_compliance_expiry`,
  `compliance_verification_pending`, `non_compliant_coach_assigned`);
- `assigned_coach_unavailable` and `coach_schedule_conflict`;
- Work Summary rules (NA2.6);
- `coach_outcome_pending` and `venue_missing`;
- exception write and revoke routes, Settings editing, UI.

Each later slice appends its registrations. Staffing sources are already
loaded once, so later rules that share them add no reads.

## Needs Attention — Slice 3.1 follow-up correction (staffing semantics + severity defaults) — TEST only — 2026-09-28

**Scope.** This is a correction to Slice 3 only. It changes three things:
- unknown or missing staffing roles;
- inactive Coaches;
- the four staffing severity defaults.

No new rule, no Slice 4 work, no production, UI, cover, compliance,
availability or Work Summary change. The locked precedence is unchanged.
The shared resolver (`player-access` / `coach-cover` / the Needs Attention
copied block) is **untouched**, and the drift tests still prove it
byte-identical.

Pre-checks passed:
- HEAD = origin = `ac5a0d7`; clean tree;
- deployed `needs-attention` v2 was byte-identical to the repo;
- the catalogue held exactly the NA5.4 values.

### NA6.1 What changed (files)

| File | Change |
|---|---|
| `needs-attention/staffing.ts` | **Analysis layer only.** It filters after the resolver (see NA6.2 and NA6.3), adds `Coaches` to the shared staffing sources, adds `staffingIssues()`, and adds new context/relatedIds fields. The COPIED resolver block is unchanged |
| `needs-attention/needs-attention.ts` | A generic optional `reportIssue(issue)` on `EvaluatorContext`. `ENGINE_VERSION = "needs-attention-slice-3.1"` |
| `needs-attention/orchestrator.ts` | Collects evaluator-reported issues into `configIssues`. Identical reports (same code, record and detail) are kept **once**, because the four staffing evaluators share one pass and each reports the same issues. A reported issue never creates a case and never sets `complete: false` |
| `registry.ts`, `repository.ts`, `index.ts` | Unchanged |

No new Needs Attention rule was created. Data problems use the existing
`configIssues` mechanism.

### NA6.2 Unknown or missing staffing roles (locked)

An unknown or missing role is a **configuration problem**. It is never
guessed, never treated as a Learning Coach, and never counted.

Each resolved assignment is classified, in this order:

| Status | Condition | Effect |
|---|---|---|
| `coach_not_found` | The linked Coach id is not in the Coaches table | Ignored + config issue `staffing_coach_not_found` |
| `inactive_coach` | Coach record `Active` is not ticked | Ignored (NA6.3). **No** config issue, because it is valid historical data. Its role is not examined |
| `unknown_role` | Active coach, but the role is missing (no Role link), inactive, not one of `lead_coach` / `coach` / `learning_coach`, or an Occurrence Staff role snapshot that matches no Coach Roles row | Ignored + config issue `staffing_role_unrecognised` |
| `valid` | Active coach + recognised active role | Counted: Lead Coach / Coach / Learning Coach |

**Precedence runs on VALID staff only** (`total` = the valid count):
- **0 valid** → `session_no_coach` only;
- Lead required with no valid Lead → `no_lead_coach`;
- valid staff are Learning Coaches only, and Lead is not required →
  `learning_coach_only`;
- 1 ≤ counting (valid Lead + valid Coach) < Required Staff Count →
  `session_understaffed`.

It follows that:
- an unknown role only → `session_no_coach` (never `learning_coach_only`),
  plus a config issue;
- Coach + unknown role with Required 2 → counting 1 →
  `session_understaffed`, plus a config issue;
- Learning Coach + unknown role with no Lead required →
  `learning_coach_only` (the only recognised role is Learning Coach), plus
  a config issue.

**Config issue shape:** `{code, recordId: <occurrence id>, detail}`.
- The detail names the session, the local time, the occurrence and the
  coach id.
- It names the role when there is one (`role "X", which is inactive or
  not a recognised staffing role`). Otherwise it says *"a missing or
  unresolvable role (no Role link, or a role snapshot that matches no Coach
  Roles row)"*.
- It always ends: *"The assignment is ignored for staffing - it is not
  counted and not treated as a Learning Coach."*

Issues appear in `/cases` and in `?caseKey=` responses (not in
`view=summary`, as before).

**Case payload additions:**
- `context.assignedStaff` (resolved assignments before filtering);
- `context.inactiveCoachesIgnored`;
- `context.unknownCoachRecords`;
- the existing `context.unrecognisedRoles`;
- `context.totalStaff`, which now means **valid** staff;
- `relatedIds.coachIds` (valid staff only);
- `relatedIds.ignoredCoachIds` (present only when something was ignored).

The staffing summary reads, for example:
- "no valid staff (ignored: 1 with an unrecognised role)";
- "1 Coach (ignored: 1 inactive coach)".

A `session_no_coach` detail says "No **valid** staff are assigned" when
assignments exist but none are valid.

### NA6.3 Inactive Coaches (locked, future staffing only)

An assignment whose Coaches record `Active` is not ticked never satisfies
future staffing:
- it does not count toward Required Staff Count;
- an inactive Lead Coach does not satisfy Requires Lead Coach;
- an inactive Learning Coach is not valid Learning Coach staffing.

This applies wherever the coach comes from: Session Staff, or Occurrence
Staff (Cover / Additional).

The filter is applied in the **Needs Attention analysis layer, after the
shared resolver**:
- no historical Session Staff or Occurrence Staff row is rewritten (writes
  are impossible — the repository is read-only);
- `player-access` behaviour is unchanged.

**Read cost:** one extra list of the Coaches table per request. There is
no per-coach or per-occurrence query.

### NA6.4 Final staffing severity defaults (TEST catalogue, updated in Airtable)

| Rule | Default Base | Warning | Urgent | Locked Minimum |
|---|---|---|---|---|
| `session_no_coach` (ATT-013) | **Warning** — as soon as it is in the 14-day window | — (not supported) | **48 Hours Before** | none |
| `no_lead_coach` (ATT-001) | Normal | 72 Hours Before | 24 Hours Before | none |
| `session_understaffed` (ATT-005) | Normal | 72 Hours Before | 24 Hours Before | none |
| `learning_coach_only` (ATT-002) | **Normal** (was Warning) | **72 Hours Before** (was unsupported) | **24 Hours Before** (was 48) | none |

- Only the `learning_coach_only` row's values changed: `Default Base
  Severity`, `Supports Warning Threshold`, the Warning threshold and
  timing, and the Urgent threshold.
- The Logic/Definition text of all four rows was updated to describe
  valid-staff semantics.
- These values are **configurable defaults** (Client Customisable
  Settings still override field by field). None is hard-coded in the
  evaluator.
- The NA1.7 catalogue row for ATT-002 is superseded by this table.
- Cover timing is unchanged.

### NA6.5 Reads and performance

- **Per request:**
  - 5 config tables + **6** staffing tables (Session Occurrences, Sessions,
    Session Staff, Occurrence Staff, Coach Roles, **Coaches**);
  - = **11 list operations**, each table exactly once, with no duplicates
    and no per-occurrence or per-rule queries;
  - live TEST: 11 lists / 11 pages.
- With the existing wave size of 5, the staffing sources now load in **two
  waves** (5 + 1). Airtable allows about 5 requests per second, so the
  wave size was not raised.
- **Live latency** (`function_edge_logs.execution_time_ms`; log ingestion
  is sampled, so not every call has a row):

  | Call | Version | State | Time |
  |---|---|---|---|
  | Cold, first call after deploy | v4 | 20 cases | 4,529 ms |
  | Cold, first call after deploy | v3 | 20 cases | 2,759 ms |
  | Warm, 4 concurrent calls | v3 | 20 cases | 2,235–3,108 ms (contending for Airtable) |
  | Warm, `debug=1` | v4 | Clear | 1,552 ms |
  | Warm, plain | v4 | Clear | 1,459 ms |

  - The v2 warm Clear was 1,350 ms, so the Coaches read costs roughly
    **+0.1–0.2 s** warm.
- There is no caching.

### NA6.6 Verification

**Unit tests:**
- `needs-attention-staffing.test.ts`: **100/100** (was 70). The changes:
  - P13/P14 are rewritten: unknown-only → `session_no_coach`;
  - P15/P16 added (inactive-only; Learning Coach alongside unknown roles);
  - R1–R6: valid/unknown/inactive/missing classification, issues, and
    that an inactive coach is filtered before role checks;
  - **U1–U10**, unknown roles end to end:
    - no-role and inactive-role, and an unresolvable snapshot "Helper";
    - Coach + unknown, Learning Coach + unknown;
    - the issue is emitted once per bad assignment, even with four
      evaluators;
    - `staffing_coach_not_found`;
    - config issues never make the queue incomplete;
    - `caseKey` lookup still reports them;
  - **I1–I8**, inactive coaches:
    - inactive-only; active + inactive with Required 2;
    - inactive Lead + active Coach; inactive Learning Coach only;
    - an inactive Cover replacing the active Lead on one occurrence;
    - source data untouched; no config issue; Coaches read once;
  - **V4–V9**, exact boundaries:
    - `session_no_coach` Warning in the window and at 48 h + 1 ms,
      Urgent at exactly 48 h;
    - `no_lead_coach`, `session_understaffed` and `learning_coach_only`:
      Normal at 72 h + 1 ms, Warning at exactly 72 h and at 24 h + 1 ms,
      Urgent at exactly 24 h;
    - no locked minimum;
  - S12 and DR4 now expect 11 reads and 6 sources.
- `needs-attention.test.ts`: **102/102** (was 100). 81a/81b cover issue
  de-duplication across evaluators and that issues are never cases; 71 is
  now engine slice-3.1; 85 expects 11 reads including Coaches.
- **Mutation checks:** every injected bug fails the suite:
  - unknown counted as staff;
  - inactive not filtered;
  - missing coach treated as present;
  - no issue de-duplication;
  - unknown role not flagged;
  - no unknown-role issue.
- Strict `tsc` is clean.

**Full regression:** `node tests/run-all.js` → **58/58 files, 1,618
PASS, 0 FAIL** (Slice 3 baseline: 58 files / 1,586).

**Deployment:** `needs-attention` **v4** in TEST (`verify_jwt` on).
- All 6 files are **byte-identical** to the repo (staffing `1d806bae…`,
  engine `d77ce9c6…`, orchestrator `bdaaa1c6…`; the other 3 are unchanged
  from v2).
- v3 was deployed first. v4 only improved the wording of the
  unknown-role config issue: an unresolvable snapshot had been described
  as "no role".
- No other function was deployed.

**Live verification** used real HTTP via `pg_net`, a Management JWT and
throwaway `NA-S31-PROBE` records:
- 1 inactive probe Coach;
- 13 Sessions, 16 Session Staff rows;
- 21 Occurrences, 1 Occurrence Staff row.

TEST was Clear before. The v4 `/cases` returned **exactly the 20 predicted
cases**: `Urgent`, 4 Urgent / 9 Warning / 7 Normal, `complete: true`. It
also returned exactly **4** `staffing_role_unrecognised` config issues,
reported once each.

| Probe | Setup | Live result |
|---|---|---|
| 01 | Alex with **no role**, Required 2 | `session_no_coach` only (Warning); summary "no valid staff (ignored: 1 with an unrecognised role)"; `?caseKey=learning_coach_only|…` → `exists:false` |
| 02 | Sam Coach + Alex no role, Required 2 | `session_understaffed` (counting 1) + issue |
| 03 | Alex Learning Coach + Morgan no role | `learning_coach_only` + issue |
| 04 | Occurrence Staff "Helper" snapshot only | `session_no_coach` + issue ("missing or unresolvable role") |
| 05 | Inactive coach only | `session_no_coach`; "(ignored: 1 inactive coach)"; no issue |
| 06 | Sam Coach + inactive Coach, Required 2 | `session_understaffed` (counting 1) |
| 07 | Inactive Lead + Sam Coach, Lead required | `no_lead_coach` |
| 08 | Inactive Learning Coach only | `session_no_coach`; `?caseKey=learning_coach_only|…` → `exists:false` |
| 09 | Zero staff at ~18 h / ~66 h / ~10 d | Urgent / Warning / Warning |
| 10 | `no_lead_coach` (Coach only) at ~18 h / ~66 h / ~114 h | Urgent / Warning / Normal |
| 11 | `session_understaffed` (Lead only, Required 2), same times | Urgent / Warning / Normal |
| 12 | `learning_coach_only`, same times | Urgent / Warning / **Normal** (new default) |
| 13 | Valid Lead + Coach, Required 2 | nothing (existing valid behaviour intact) |

**Cleanup.** All 52 probe records were deleted by exact ID, children
first. Afterwards:
- Coaches = the original 3;
- Sessions = TEST-A and TEST-B;
- Session Staff = the original 3;
- Occurrence Staff = 0;
- 0 `NA-S3*` occurrences.

`/cases` → **Clear**, 0 config issues, 11 lists.

**Other functions** after cleanup:
- `/me` returned 200 for Management and Parent.
- hub-content `/players` (coach A) returned 200, **md5 `685b11e7…`,
  byte-identical**.
- parent-hub `/me` returned 200 (md5 unchanged from Slice 3).
- coach-cover `/manage`, coach-compliance `/summary?coachId=` and
  coach-work-summaries `/summaries` all returned 200.
- needs-attention as Coach or Parent returned 403.

### NA6.7 Still flagged / deferred

- Occurrences of non-Active sessions are still excluded (the generator's
  rule, NA5.3).
- Destination routes are still logical routes.
- Volunteer is still deferred.
- The Exceptions table is still read whole.
- `learning_coach_only`'s `a.learningCount > 0` guard is logically
  implied by `total > 0 && qualifying === 0`. It is kept explicit for
  readability (mutation M7 is equivalent).
- Slice 4 has not been started.

## Needs Attention Foundation — Slice 4 (`cover_open`, one case per cover date) — TEST only — 2026-09-28

**Scope.** Exactly one new rule, `cover_open` (ATT-041). It replaces
production's `cover_requested` + `cover_unresolved` pair, so no
requested/unresolved duplicate can exist. There is no exception POST or
revoke, no compliance, non-compliant-coach, availability, conflict, Work
Summary, Settings, Finance, Players/Parents, Development, safeguarding or
Volunteer rule. There is no notification, UI, caching or Supabase case
storage, and no production change.

**The cover workflow (`coach-cover`) is untouched.** It was not edited or
redeployed.

Pre-checks passed:
- HEAD = origin = `b39a97c`;
- deployed `needs-attention` v4 was byte-identical to the repo;
- the ATT-041 catalogue row held the NA2.3 values.

### NA7.1 What changed (files)

| File | Change |
|---|---|
| `needs-attention/cover.ts` | **New.** The `cover_open` evaluator and one shared cover analysis pass. It contains one COPIED block (`COVER_DATE_STATUSES` + `deriveGroupStatus`, verbatim from `coach-cover/cover-workflow.ts`, drift-tested) |
| `needs-attention/registry.ts` | `IMPLEMENTED_EVALUATORS = [...STAFFING_EVALUATORS, COVER_EVALUATOR]` |
| `needs-attention/needs-attention.ts` | `ENGINE_VERSION = "needs-attention-slice-4"` (only change) |
| `index.ts`, `orchestrator.ts`, `repository.ts`, `staffing.ts` | Unchanged. The generic engine already loads the union of runnable sources once each |

Tests:
- New `tests/support/needs-attention-cover.test.ts` (56 checks) with its
  shim `tests/e2e/needsattentioncovertest.js`, plus the hand-kept copy
  `tests/support/needs-attention-cover.ts`.
- The engine test (103 checks) and the staffing test (100 checks) were
  updated. The staffing test now registers `STAFFING_EVALUATORS` only, so
  its read counts stay staffing-only.

### NA7.2 Source of truth, and what "needs attention" means

- **The cover date** is one **Staff Availability Requests** row, created
  by `coach-cover POST /requests`, one per requested occurrence. A
  multi-date request is one **Cover Request Groups** row plus N date rows.
- **A case exists while that row's own `Cover Date Status` is `Open`.**
  This is the same test the workflow applies before it accepts a
  response, a selection or a cancellation. Needs Attention never
  re-derives cover state from anything else.
- **Terminal states:**
  - `Filled` (Management selected a cover coach: `/select` writes the
    Cover Occurrence Staff row, then sets Filled + Replacement Coach);
  - `Cancelled` (`/cancel`);
  - `Resolved Without Cover`.

  Each terminal state makes the case disappear on the next evaluation.
  There is **no** dismiss or complete action; the case resolves only
  through the real workflow.
- **What does NOT resolve a case:**
  - A coach's `Accept` (Response Status `Yes`) is only willingness; the
    workflow never treats it as cover, so the case stays.
  - The same applies to `Decline`, `Invited` or `Withdrawn`, and to
    inactive responses (`Active` unchecked is ignored entirely).
- **`Resolved Without Cover`** is a valid workflow state (it is in
  `COVER_DATE_STATUSES`), but **no `coach-cover` route writes it today**.
  It is set in Airtable directly. Needs Attention honours it; adding a
  route for it is workflow work, not Needs Attention work.
- **An Open date that can no longer be acted on gives no case:**
  - its occurrence is `Cancelled` or `Postponed`;
  - or the occurrence has already started (`Start <= now`);
  - or, for a date-only occurrence, its Date is before today in
    Europe/London.

  This follows the catalogue's "not Cancelled/Postponed", and the
  workflow refuses to act on a past date.
- **Fail visible:**
  - An Open date whose occurrence link is missing or unreadable still
    gives a case (it cannot escalate on session time), plus the config
    issue `cover_occurrence_missing`.
  - An occurrence with no Start time gives a case that cannot go Urgent,
    plus `cover_occurrence_untimed`.
  - A row with no created time gives `cover_request_time_unknown`.

  These use the existing `configIssues` mechanism (`reportIssue`); none
  creates an extra case.
- **No look-ahead window.** Unlike staffing (14 days), every Open
  future-or-today date is a case, however far out.

### NA7.3 One case per date, grouping, key

- **Case Key:** `cover_open|coverdate:<Staff Availability Requests record id>`.
  - It is the dedicated per-date record, so it is stable while the date
    is unresolved.
  - It contains no names, titles or dates.
  - The organisation is a separate scope, as in every other rule.
  - A lookup with `?caseKey=` works as for staffing.
- **Grouping** (the shared parent is the Cover Request Group link):
  - `targetIds.coverRequestGroupId`, `context.coverRequestGroupId`
    and `destination.params.groupId`;
  - `context.groupStatus` is derived from **all** sibling date statuses
    with the copied `deriveGroupStatus`. Live verification saw "Partially
    Filled" with dates A Filled / B Open / C Cancelled / D Resolved
    Without Cover;
  - `context.siblingDates` / `siblingOpenDates` (excluding itself) and
    `relatedIds.siblingRequestDateIds`.

  A UI can group by `coverRequestGroupId` and still show one row per
  date.
- **The Cover Request Groups table is deliberately not read.**
  - The group ID comes from the date row's own link.
  - Status is derived from the sibling date rows, which are already
    loaded.
  - The group's `Reason` / notes are personal data that Needs Attention
    does not need.

### NA7.4 Severity (catalogue-driven; the engine computes it)

The catalogue row ATT-041 (set in NA2.3, unchanged here):
- base **Normal**;
- **Warning** = 48 Hours Overdue;
- **Urgent** = 24 Hours Before;
- the highest level wins, so Urgent beats Warning.

The evaluator only supplies two anchors:
- `anchors.outstandingSince` = the date row's Airtable `createdTime`.
  This is the **request age**; Warning applies when `now - created >= 48h`.
- `anchors.event` = the occurrence `Start Date & Time`. This is the
  **session time**; Urgent applies when `start - now <= 24h`.

They are two independent clocks:
- A request made 3 weeks ahead turns Warning after 2 days, then Urgent
  on the day before.
- A request made 10 hours before the session is **Urgent immediately**,
  and the reason says so. Live verification confirmed this:
  `base Normal; Urgent threshold reached (24h before event)`.

Boundary tests (fixed "now"):
- start = now + 24h + 1ms → not Urgent; exactly 24h → Urgent;
- created = now − 48h + 1ms → not Warning; exactly 48h → Warning;
- both conditions → Urgent (Urgent wins);
- untimed occurrence → never Urgent, still Warning by age.

Times are formatted in Europe/London, e.g. `Sun 4 Oct 2026, 11:00`.

**`unfilledSignal()` status.**
- `coach-cover/cover-workflow.ts` `unfilledSignal(status, createdTime,
  now)` returns `Open && now - createdTime >= 24h`.
- It is used **only** by `coach-cover`'s `dateView`, which feeds `GET
  /manage` fields `unfilledOver24h` and `unfilledOver24hCount`.
- No frontend file references it (checked by repo grep).
- Needs Attention **does not call it and does not use its 24h
  threshold**. The cover drift test CV2 asserts this, and CV4 asserts
  coach-cover still has its own 24h flag unchanged.
- The two can differ on purpose. `/manage`'s flag is a legacy list
  hint; Needs Attention severity is the locked 48h/24h model.
- Retiring or aligning `unfilledSignal` is a separate decision; it was
  not changed.

### NA7.5 Payload and destination

Each case carries:
- **Identity:** `ruleKey`, `ruleId`, `caseKey`, `module` =
  `module_coaches`, and `category`.
- **`severity`, `severityReason`** and `anchorTime`.
- **`title`:** `Cover needed - <Session name>`.
- **`detail`:** when, who requested, request age, how many accepted or
  declined, and the multi-date note.
- **`targetIds`:** `requestDateId`, `occurrenceId`, `sessionId` and
  `coverRequestGroupId`.
- **`relatedIds`:** `requesterCoachIds`, `acceptedCoachIds` and
  `siblingRequestDateIds`.
- **`context`:**
  - status: `coverDateStatus`, `requestId`, `coverRequestGroupId`,
    `groupStatus`, `siblingDates` and `siblingOpenDates`;
  - requester and responses: `requesterCoachId`, `requesterName`,
    `requestedAt`, `openForMinutes`, `openForHours`,
    `acceptedResponses`, `declinedResponses`, and `selectedCoachId`
    (always null while Open);
  - occurrence: `occurrenceId`, `occurrenceName`, `occurrenceStatus`,
    `sessionId`, `sessionName`, `date`, `start`, `end` and
    `startLocal`.
- **`actionLabel`:** "Resolve Cover" (catalogue).
- **`destination`:**
  `{ area: "Coaches", route: "coaches/cover-request-date", params: { requestDateId, groupId, occurrenceId } }`.

**The destination is a placeholder logical route.** There is no
Management cover UI yet. The route names the exact date; the UI slice
maps it to a screen, e.g. `coach-cover GET /manage/detail?requestDateId=`.

**Not exposed:**
- the cover reason;
- handover or coach notes;
- response notes;
- rates;
- the names of accepting coaches (IDs only);
- any contact data.

### NA7.6 Reads and performance

- **One shared cover pass per request** (memoised). Each of the five cover
  tables is indexed once, and there are no per-date queries.
  `Session Occurrences`, `Sessions` and `Coaches` are **shared with
  staffing** and loaded once.
- **Final read count with every rule on: 13 list reads.**
  - 5 config: Organisation & Branding, Feature Controls, Rules,
    Settings, Exceptions;
  - 6 staffing: Session Occurrences, Sessions, Session Staff,
    Occurrence Staff, Coach Roles, Coaches;
  - 2 cover-only: Staff Availability Requests, Cover Responses.

  Every table is read once (13 pages live). This was 11 before Slice 4.
  The domain tables still load in 2 waves of 5.
- **Module off** (`module_coaches` disabled): no cover or staffing table
  is read (test G1).
- **Cover disabled in Settings:** the two cover-only tables are not read
  (G2).
- **A `caseKey` lookup** reads only that rule's sources: 10 lists, and no
  staffing-only tables (G3).

Live latency (`function_edge_logs` `execution_time_ms`; logs are sampled):

| Call | Latency |
|---|---|
| Cold, first call after deploy | 5.14 s |
| Warm full `/cases?debug=1` with 7 live cases | 1.41–1.52 s |
| Warm `?caseKey=` lookups | 1.30–1.57 s |
| Warm `view=summary` | 1.61 s |
| Warm **Clear** after cleanup | 1.59–1.76 s |

Three calls fired in parallel ran 1.73–1.96 s each. The Slice 3.1
baseline was a warm Clear of 1.46–1.55 s with 11 lists, so the two extra
lists cost about 0.1–0.2 s.

### NA7.7 Staffing interaction (both rules stand alone)

Cover and staffing are separate concerns, and neither suppresses the
other.

- **While a date is Open,** the requester still staffs the occurrence.
  The workflow only swaps staff at selection, so staffing sees the same
  truth as before.
- **If staffing is also wrong,** both cases coexist. Live, an inactive
  requester on a Required-1 session gave `cover_open` **and**
  `session_no_coach`.
- **After selection,** the Cover Occurrence Staff row puts the
  replacement on the occurrence. On the next evaluation `cover_open`
  disappears because the date is Filled, and `session_no_coach` also
  disappears because the replacement is valid staff. Neither rule knows
  about the other.
- **Disabling `cover_open`** leaves staffing cases intact (I4).

### NA7.8 Verification

**Unit tests** (`needs-attention-cover.test.ts`, 56 checks):
- E1–E6 eligibility;
- V1–V11 severity boundaries;
- L1–L6 lifecycle: accepted only → stays; Filled / Cancelled /
  Resolved Without Cover → gone; inactive response ignored;
- M1–M8 multi-date mixed outcomes and grouping;
- K1–K3 identity;
- P1–P4 payload and privacy;
- F1–F2 fail visible;
- R1–R4 reads;
- G1–G3 gating;
- I1–I4 staffing interaction;
- CV1–CV5 drift, no `unfilledSignal` use, catalogue fixture = ATT-041,
  and read-only.

**Full suite:** 59 files / **1,675 PASS / 0 FAIL**. The baseline was 58 /
1,618 / 0.

**Deploy:** `needs-attention` **v5** (`verify_jwt` true, 7 files).
- `ezbr_sha256` `c08ae0f41ca7df0cb07b9601d843151a8e7e788048c056ca61c729db55d0479a`.
- Every deployed file is byte-identical to the repo (sha256 per file).
- `coach-cover` was not redeployed.

**Live end-to-end** (prefix `NA-S4-PROBE`, through the real
`coach-cover` routes via pg_net). The probe set was:
- one inactive probe coach;
- 3 sessions, all Required 1 and Lead not required;
- 6 occurrences at 07:00 BST, so they avoid real sessions;
- 3 Session Staff rows.

| Step | Action | Result |
|---|---|---|
| 0 | Baseline | Clear; 5 evaluated; 13 lists |
| 1 | Management `POST /requests` for the inactive coach (O1), and Alex `POST /requests` for 4 dates A–D. Alex also requested one date **~13h ahead** (U) | **6 `cover_open` cases, one per date**. O1 also has `session_no_coach` (coexist). U is **Urgent** ("24h before event"); the rest are Normal. 4 cases share `coverRequestGroupId`, each "Part of a 4-date request (3 other dates still open)". 13 lists |
| 2 | Sam `POST /respond` Accept on O1 and A, Decline on B | All still present. The detail reads "1 coach accepted - choose the cover coach" and "No coach has accepted yet (1 declined)"; `acceptedCoachIds` = [Sam] |
| 3 | Management `POST /select` (confirmWarnings) on O1 and A; Alex `POST /cancel` on C; D set to `Resolved Without Cover` in Airtable | O1, A, C and D cases gone. **`session_no_coach` on O1 gone as well** (Sam's Cover OS row). Only B remains (group "Partially Filled", 0 other open) and U (Urgent). `caseKey` lookup of O1 → `exists: false`. `/manage` agrees on all 6 statuses; stored group status = derived |
| 4 | `view=summary` | Urgent, total 2 (1 Normal, 1 Urgent) |
| 5 | Coach or Parent on `/cases` | 403 |

**Warning (48h request age) was not produced live.** Airtable sets
`createdTime` itself, so a 48h-old request cannot be made on demand. It
is covered by the V-series unit boundaries instead.

**Cleanup:** all 27 probe records were deleted by exact ID:
- 3 Cover Responses, 2 Cover Occurrence Staff rows, 6 date rows and 3
  groups;
- 3 Session Staff rows, 6 occurrences, 3 sessions and 1 coach.

The workflow writes only groups, dates, responses and Occurrence Staff
(verified in code). `cover_date_locks` is empty.

`/cases` → **Clear**, 0 config issues, 13 lists.

**Other functions after cleanup:**
- `/me` returned 200 for Management, Coach and Parent.
- hub-content `/players` (coach A) returned 200, **md5 `685b11e7…`,
  unchanged**; `session-participants` returned 200.
- coach-cover `/manage` returned 200 (0 dates) and `/mine` returned 200.
  Coach on `/manage` got 403.
- coach-compliance `/summary` and coach-work-summaries (Management and
  Coach) returned 200.
- parent-hub `/claims/pending` returned 200, and `/feedback` returned
  the expected 400.
- The no-param validation 400s were unchanged.
- parent-hub `/me` returned 500 **once**. That burst of 23 parallel calls
  hit an Airtable `429 RATE_LIMIT_REACHED` (function log). Alone, it
  returned 200. This is not a regression.

### NA7.9 Flagged, deferred, and what Slice 5 still needs

- **Destination is still a logical placeholder route**
  (`coaches/cover-request-date`), because there is no Management cover
  UI.
- **Nothing in the workflow writes `Resolved Without Cover`.** It is
  honoured, but only set by hand.
- **`unfilledSignal()` / `/manage unfilledOver24h` (24h) is not aligned
  with the Needs Attention 48h Warning.** It was left unchanged by
  design (NA7.4).
- **Warning by request age depends on Airtable `createdTime`.** An
  imported or back-filled date row would start its clock at import
  time.
- **A cover date whose occurrence has started drops out even while
  Open.** This is the workflow's own past-date rule; the workflow cannot
  act on it either.
- **Still carried from NA6.7:**
  - the non-Active-session occurrence exclusion (staffing only);
  - Volunteer is deferred;
  - the Exceptions table is read whole.
- **Slice 5 has not been started.** Remaining catalogue rules (not
  implemented, reported as `skipped: not_implemented`/`planned`) include
  `compliance_verification_pending`, `non_compliant_coach_assigned`,
  `coach_schedule_conflict`, `coach_outcome_pending`,
  `work_summary_ready_to_finalise` and `venue_missing`. Exception
  POST/revoke, the UI and notifications also remain.

## Needs Attention Foundation — Slice 5 (Management exception write path) — TEST only — 2026-09-28

**Scope.** Management can approve an **exact-case** exception for a real,
currently derived Needs Attention case, and can revoke it later.

An exception means "Management deliberately accepted this exact situation
for this reason". It is **not**:
- a delete;
- a "mark complete" or "dismiss";
- a source-data change;
- a rule switch-off;
- an unaudited hide.

The rule and its source truth are untouched. The evaluator simply
suppresses the matching case while the exception is in force.

**Not in scope:** Settings editing, broad or session-wide scopes, new rules
(compliance, availability, conflicts, Work Summary), Finance,
Players/Parents, safeguarding, Volunteer, notifications, UI, case
assignment, dismiss/complete, the Supabase migration, caching and
production.

**Pre-checks passed:**
- HEAD = origin = `8e3f59c`;
- deployed v5 was byte-identical to the repo;
- the live queue was Clear;
- Needs Attention Exceptions held 0 rows;
- no exception-write code existed (GET-only index).

**Stop and approval.** Proper revoke audit could not be achieved with the
existing schema: there were no revoke fields in TEST or production. Work
stopped, the smallest schema improvement was proposed, and it was approved
before any change.

### NA8.1 Schema and migration changes (TEST only)

**Airtable Needs Attention Exceptions** (`tblBbsSsLR32uojsk`) gains **4
additive fields**. Nothing was removed or renamed.

| Field | Type | ID |
|---|---|---|
| `Revoked At` | dateTime, D/M/YYYY 24h, Europe/London (same format as `Approved At`) | `fldk7PBqx6jpz4DLc` |
| `Revoked By User ID` | singleLineText | `fld7E8B1DCNJVdsM9` |
| `Revoked By Name Snapshot` | singleLineText | `fldli8SEkX9kICHBG` |
| `Revoke Reason` | multilineText | `fld9ikRX6a08AoYFi` |

**Promotion note:** production's Exceptions table needs the same 4
fields, plus `Case Key` (NA1.3).

**Supabase migration `na_slice5_needs_attention_exception_locks`**
(TEST project `dkqubldmfyeuudecxmvh`) is the same shape as
`cover_date_locks`:
- Table `public.needs_attention_exception_locks`:
  - `exception_key text primary key`, `lock_token uuid`, `locked_at timestamptz`;
  - RLS enabled;
  - privileges revoked from public/anon/authenticated and granted to
    `service_role`.
- Functions `acquire_needs_attention_exception_lock(p_exception_key)` and
  `release_needs_attention_exception_lock(p_exception_key, p_lock_token)`:
  - SECURITY DEFINER, `search_path=public`;
  - insert-on-conflict-do-nothing, token-owned release, 5-minute self-heal;
  - EXECUTE for `service_role` only. The ACL checked out as
    `postgres=X/postgres,service_role=X/postgres`, identical to the cover
    lock.

This is not a generic lock framework: one narrow table for one purpose.

### NA8.2 Files

| File | Change |
|---|---|
| `needs-attention/exceptions.ts` | **New. Pure policy, no I/O:** body validation, create decision, storage-neutral field sets, owned-exception lookup, API view |
| `needs-attention/lock-client.ts` | **New.** coach-cover's lock client, copied, with only the RPC names changed (drift test Z2) |
| `needs-attention/orchestrator.ts` | `evaluate()` extracted, so GET and the write routes share one evaluation. Adds `createException` / `revokeException` (per-case `withLock`) |
| `needs-attention/repository.ts` | Adds the only write path: `createExceptionRecord` / `updateExceptionRecord`, hard-wired to the Exceptions table. Reads unchanged |
| `needs-attention/index.ts` | Routes `POST /exceptions` and `POST /exceptions/revoke`. Profile adds `display_name` + auth email (audit snapshot only). Lock client uses the service-role key |
| `needs-attention/needs-attention.ts` | `ExceptionRow` also parses the approver id and the 4 revoke fields. **Matching unchanged.** `ENGINE_VERSION = needs-attention-slice-5` |
| `registry.ts`, `staffing.ts`, `cover.ts` | Unchanged |

Tests:
- **New:** `tests/support/needs-attention-exceptions.test.ts` (76 checks),
  its shim `tests/e2e/needsattentionexceptionstest.js`, and copies
  `needs-attention-exceptions.ts` / `needs-attention-lock-client.ts`.
- `needs-attention.test.ts` (now 106 checks) evolves the drift checks:
  - D3: GET on /cases and POST only on the two exception routes;
  - D4: Airtable writes only in repository.ts, only to Exceptions, no
    DELETE anywhere;
  - D4b: the service-role key is used only by the lock client;
  - D5: `display_name` is selected.

### NA8.3 Exception lifecycle

**Create — `POST /exceptions`**, Management only.

Body: `{ caseKey, reason, effectiveUntil? }` and **nothing else**.
- Any tenant key (`organisation`, `org`, `tenant`, …) → 400
  `tenant_param_rejected`, as does a tenant query parameter.
- Any other key (`rule`, `ruleKey`, `approvedBy`, `approvedAt`,
  `sessionId`, `active`, …) → 400 `unexpected_field`. Such values are
  refused, not silently ignored.

Steps:
1. Authenticate Management. Coach, Parent, pending or inactive → 403; no
   or invalid token → 401.
2. Validate the body:
   - `caseKey` must parse;
   - `reason` must be non-empty after trimming and at most 2000 characters;
   - `effectiveUntil`, if present, must be an ISO date-time **with an
     explicit `Z` or offset**. Bare dates and zone-less times are
     ambiguous, so they are refused. It must also be strictly in the
     future, and is normalised to UTC.
3. Take the lock on `<profile organisation id>|<Case Key>`. The Case Key
   starts with the rule key, so this is Organisation + Rule + Case Key.
4. Inside the lock, **re-evaluate the case's rule for the caller's
   organisation**, using the same `evaluate()` as GET.
5. `decideCreate` then applies, in order:
   - rule unknown or not evaluated (module off, disabled, planned…) → 404
     `case_not_found`;
   - an exception already in force for this org + key (the case is
     suppressed, or an Active, unexpired row exists) → 409
     `exception_exists`, returning that exception;
   - case not currently derived → 404 `case_not_found` (guessed keys, or
     a problem already resolved at source). If the rule's evaluator
     failed → 409 `evaluation_incomplete`;
   - Rule `Supports Override` off → 403 `override_not_supported`;
   - effective `Allow Override` off (Settings) → 403
     `override_disabled_by_settings`.
6. Write **one** row. Every value is server-derived:
   - `Exception ID` = `NAEX-<UTC yyyymmddhhmmss>-<first 8 of the owned
     lock token>`;
   - `Organisation` = the caller's resolved org record;
   - `Rule` = the case's rule record;
   - `Case Key`;
   - `Session` / `Session Occurrence` / `Coach` / `Player` links from the
     **real case's** `targetIds`, well-formed record ids only;
   - `Reason` (trimmed);
   - `Approved By User ID` = auth user id;
   - `Approved By Name Snapshot` = profile `display_name`, else email,
     else user id;
   - `Approved At` = server now;
   - `Effective Until`;
   - `Active` = true.
7. Respond 201 with the exception view and the case's suppression state.
   That state is computed by running the **same `matchException`** the
   queue uses against the written row. The response also carries the read
   counts and `writes: 1`.

**Exact-case scope.**
- Suppression still needs the Slice 2 match: exactly one org link = the
  org, exactly one rule link = the rule, the exact Case Key string, the
  key's rule segment = the rule, Active, unexpired, and override allowed.
- Typed links are context and audit only. A Session link never
  suppresses other occurrences, other sessions or other rules. A
  session-level key such as `no_lead_coach|session:…` is refused as
  `case_not_found`.
- Broader scopes are deferred.

**Revoke — `POST /exceptions/revoke`**, Management only.

Body: `{ exceptionId, reason }`. `exceptionId` accepts the Exception ID or
the record id; a revoke reason is required.
1. Read Organisation & Branding + Exceptions (2 lists) and locate the row
   **owned by the caller's organisation**: exactly one org link equal to
   the caller's. Anything else → 404 `exception_not_found`, whether it
   belongs to another org or doesn't exist.
2. Under the same per-case lock, re-read Exceptions (1 list). An inactive
   row → 409 `already_revoked`, with nothing changed.
3. PATCH **only**:
   - `Active` = false;
   - `Revoked At` = server now;
   - `Revoked By User ID` and `Revoked By Name Snapshot` from the profile;
   - `Revoke Reason`.

   Approval fields are never rewritten, and nothing is deleted. There is
   no delete route.
4. Outside the lock, re-evaluate the rule and report `case.visibleAgain`
   with a reason: `problem_still_present`, `problem_no_longer_present`, or
   `another_exception_in_force`.

**Expiry** is read-time only. The matcher already treats `Effective Until
<= now` as not in force, so the case reappears at the exact instant; the
unit boundary is `until - 1ms` suppressed, `until` visible. No job flips
`Active`, and the stored row is never touched. An expired row is not "in
force", so a new exception can be approved afterwards.

**Re-approval** after a revoke or expiry creates a **new** row; the old one
stays as history.

### NA8.4 Duplicate and concurrency protection

- Airtable has no unique constraint, and a check-then-write inside one
  request would race.
- Create and revoke are therefore serialised per `<org>|<Case Key>` by the
  Supabase lock. The duplicate check (engine suppression + `inForceFor`)
  runs **inside** the lock, on a fresh read.
- A second simultaneous request waits (100 x 100 ms budget), then sees the
  first row → 409 `exception_exists`. After the budget it gets 409
  `lock_busy`.
- Different cases never block each other.
- Unit control test U4: with a lock that always grants, the same race
  **does** write two rows. The lock is what prevents it.
- Live: two simultaneous POSTs gave exactly one 201 and one 409 (the 409
  returned the winner's exception), and one row was stored.

### NA8.5 Override rules

- Rule `Supports Override` (catalogue, platform-level) AND the effective
  organisation `Allow Override` (Settings; it can only narrow) must both
  be on.
- Locked or safety rules cannot be excepted merely because the caller is
  Management.
- No severity, Locked Minimum or rule protection changed.
- In the TEST catalogue:
  - the staffing rules are overrideable;
  - **`cover_open` (ATT-041) is not**, and the server refuses it (live
    403). The cover date stays Open and the cover workflow is untouched.
- The read side is unchanged: if `Allow Override` is later switched off,
  existing exceptions stop suppressing (unit O4).

### NA8.6 Audit (permanently retained)

- Every exception row is kept forever. Revoke sets `Active` false and
  fills the four revoke fields.
- Approval audit:
  - Exception ID, Organisation, Rule, Case Key, context links;
  - Reason;
  - Approved By User ID and Name Snapshot;
  - Approved At, Effective Until.

  It is written once and never edited: names are snapshots, not links to
  a changing profile.
- Revoke audit: Revoked At, Revoked By User ID and Name Snapshot, Revoke
  Reason.
- Airtable `Created` / `Last Updated` remain as metadata.
- Approver and revoker identity come only from the authenticated
  profile. Client-sent names are refused (`unexpected_field`).
- Responses carry only the audit identity (user id + name snapshot). No
  email, contact data or case payload is exposed beyond the existing GET
  contract.

### NA8.7 Security summary

- Coach, Parent, pending and inactive users → 403 on both routes. No auth
  → 401.
- The organisation comes from the profile only. A tenant key in the body
  or query → 400.
- A client-supplied rule, approver, timestamps or target ids → 400.
- Guessed or non-existent Case Keys → 404.
- Another organisation's exception cannot be seen or revoked (404).
- An exception written by another organisation's Management links only
  that organisation and never suppresses ours (unit S5–S7).
- Domain data is one tenant per Airtable base in TEST, so cross-org
  isolation is enforced at the exception layer: write link, read match,
  owned lookup.
- The service-role key is used only for the two lock RPCs.

### NA8.8 Later Supabase migration notes

- `exceptions.ts` is **pure** (drift check Z1): validation, decisions and
  storage-neutral field sets, keyed by logical field names.
- The orchestrator only composes. The Airtable-specific pieces a Supabase
  repository must replace are:
  1. `repository.ts` `createExceptionRecord` / `updateExceptionRecord`
     (Airtable REST POST/PATCH) and the list reader;
  2. `parseException` field-name mapping (Airtable field names, link
     arrays, absent-when-false checkboxes);
  3. record-id formats (`rec…`) used by `contextLinksFromCase` and
     `updateExceptionRecord`;
  4. Airtable `createdTime` / `lastModifiedTime` as metadata;
  5. the per-request whole-table reads of Exceptions (fine at TEST
     scale).
- With Postgres, the lock table can become a **partial unique index** on
  `(organisation_id, rule_id, case_key) where active`, plus a transaction
  that first deactivates that key's already-expired rows. The deactivation
  is needed because a partial index cannot reference `now()`, so expiry
  cannot live in the index predicate. The duplicate rule stays identical;
  only the enforcement moves into the database.

### NA8.9 Performance

| Operation | Reads (lists) | Writes | Lock RPCs | Live latency (sampled edge logs) |
|---|---|---|---|---|
| GET `/cases` (unchanged) | 13 | 0 | 0 | warm Clear **1.34–1.37 s** (Slice 4: 1.59–1.76 s; no regression) |
| POST `/exceptions` (staffing rule) | 11: 5 config + 6 staffing sources, the case's rule only. A cover case would be 10 | 1 POST | 2 (acquire + release) | 201 in **1.93 s / 1.99 s** |
| POST `/exceptions/revoke` | 14: 2 locate + 1 fresh Exceptions read under the lock + 11 re-evaluation | 1 PATCH | 2 | 200 in **2.30 s**, including the "visible again" re-evaluation |
| Rejections before any read (validation, auth, role) | 0 | 0 | 0 | 0.18–0.40 s |
| Rejections needing an evaluation (guessed key, override refused) | 11 | 0 | 2 | 1.44–1.65 s |

The write routes reuse `evaluate()` unchanged. There is no caching and no
per-rule query. Only the case's own rule's sources are read, via the
`onlyRuleKey` plan.

### NA8.10 Verification

**Unit** (`needs-attention-exceptions.test.ts`, 76 checks, real
orchestrator and registry):
- P1–P16 pure policy: body validation, reason, expiry and timezone
  handling, tenant, rule and approver fields refused, ID format, context
  links, revoke field set, owned lookup, in-force.
- C0–C14 valid create:
  - server-derived identity and audit;
  - exactly one POST to Exceptions and no other write;
  - source data unchanged;
  - exact suppression, with the same rule on another occurrence of the
    same session, another session, and another rule on the same
    occurrence all still visible;
  - lookup and debug; lock key and release.
- U1–U5 duplicates and concurrency: 409 plus existing; simultaneous
  creates give exactly 1 + 1; different cases in parallel; the
  broken-lock control writes 2; `lock_busy`.
- R1–R12 revoke:
  - audit fields and approval snapshot untouched, a single PATCH;
  - the case returns; `already_revoked`; re-approval creates a new row;
  - revoke by record id; foreign or unknown → 404;
  - fixed source → `visibleAgain` false.
- X1–X5 expiry: stored as a UTC instant; `until - 1ms` suppressed;
  exactly `until` visible; no cleanup write; re-approval after expiry.
- E1–E6 genuineness: guessed key, unknown rule, session-level key,
  already fixed at source, module off, evaluator failure.
- O0–O4 overrides: `cover_open` refused with the source untouched;
  Settings Allow Override off refused; Allow Override on allowed; the
  read side ignores exceptions once override is off.
- S1–S7 permissions and organisation: coach, parent, pending and inactive
  → 403; no org → 409; unknown org → 409; another org's exception links
  only its org, doesn't suppress ours, and can't be revoked by us.
- M1 created rows match via the unchanged Slice 2 matcher; Z1–Z4 drift:
  pure module, lock client = cover's, both routes locked, no delete path.

**Deliberate-failure check:** 14 mutations were injected into the
copies, and all 14 are caught (the suite exits non-zero):
- the Supports Override, Allow Override, duplicate and case-exists checks;
- a per-call lock key;
- a past expiry accepted;
- revoke rewriting Approved At, or ignoring already-inactive rows;
- any body key accepted;
- an inclusive expiry boundary;
- the owned lookup across orgs, and a foreign record id;
- a client approver id;
- dropped context links.

**Full suite:** 60 files / **1,754 PASS / 0 FAIL**. The baseline was 59 /
1,675; the delta is the new 76-check file plus 3 evolved engine drift
checks.

**Deploy:** `needs-attention` **v6** (`verify_jwt` true, 9 files).
- `ezbr_sha256` `630c039070a9272c92189b493b34302629b5b2be3c795bd0ddba30c04973ba9c`.
- Every deployed file is byte-identical to the repo (sha256 per file).
- No other function was redeployed.

**Live lifecycle** (prefix `NA-S5-PROBE`, real routes via pg_net). The
probe set was two sessions, one requiring a Lead Coach with Alex staffed
as Coach, and three occurrences.

| Step | Result |
|---|---|
| Baseline | `no_lead_coach` on O1 and O2, plus `cover_open` on OC (Alex requested cover through coach-cover) |
| Security battery | Parent / Coach create → 403. Coach revoke → 403. No auth → 401. Body `organisation` → 400 `tenant_param_rejected`. Body `ruleKey` → 400 `unexpected_field`. Query `?organisation=` → 400. Guessed key → 404. Blank reason, past expiry, zone-less expiry → 400. GET on `/exceptions` → 405. Unknown revoke id → 404. Nothing was written |
| Cover exception | 403 `override_not_supported`. The cover date stayed Open |
| **Create** O1 | 201 `NAEX-20260928182947-445C0D9F`. Org, rule, Session and Occurrence links all server-derived. Approver "Morgan Manager" from the profile. `case.suppressed` true |
| **Suppressed** | Queue: O1 gone; O2 and cover still visible; `summary.suppressed` = 1; lookup `exists:false, suppressed:true`. Source Session Staff unchanged (still Coach) |
| **Race** on O2 | Two simultaneous POSTs → one 201 + one 409 `exception_exists` returning the same exception; one row stored. `effectiveUntil "2026-09-28T19:36:00+01:00"` was stored as `18:36:00.000Z` |
| **Revoke** O1 | 200. Active off. Revoked At / By / Name / Reason stored. Approval fields unchanged. `visibleAgain: true` (`problem_still_present`) |
| **Case returns** | Lookup `exists:true, suppressed:false`. A repeat revoke → 409 `already_revoked` |
| Settings | A temporary `no_lead_coach` Settings row with Allow Override off → create 403 `override_disabled_by_settings`. The row was deleted straight away |
| **Expiry** | 18:31:51 O2 still suppressed. At 18:36:16 O2 was visible with `suppressed` = 0 and no write: the row was still Active with Last Updated unchanged since creation |
| **Actual fix** | SS01 role set to Lead Coach → both `no_lead_coach` cases disappeared legitimately; only the unrelated probe `cover_open` remained |
| Timing probe | A second create (201) and revoke (200, `visibleAgain: true`) on a throwaway occurrence, for latency |

**Cleanup** by exact ID, 16 records:
- 3 exceptions and 1 Settings row;
- 1 cover date and 1 cover group;
- 3 Session Staff rows, 4 occurrences and 3 sessions.

Afterwards Exceptions and Settings hold 0 rows,
`needs_attention_exception_locks` and `cover_date_locks` are empty, and
`/cases` → **Clear**, 0 config issues, 13 lists.

**Regression after cleanup:**
- `/me` returned 200 for Management, Coach and Parent.
- hub-content `/players` returned 200, **md5 `685b11e7…`, unchanged**.
- parent-hub `/me` and `/claims/pending` returned 200.
- coach-compliance `/summary`, coach-cover `/manage` and
  coach-work-summaries all returned 200.
- session-occurrences `/generate {}` returned 400 (validation,
  unchanged).
- needs-attention as Coach or Parent returned 403; `view=summary`
  returned 200; a tenant parameter returned 400.

### NA8.11 Deferred, flagged, and what Slice 6 still needs

- **Exact-case only.** Broader scopes (session-wide, coach-wide, "until
  the end of term") are deliberately deferred. They would need a scope
  field and matcher change, not just links.
- **No inactive-Management live probe.** No inactive Management user
  exists in TEST. It is covered by unit S1 and by the same `index.ts`
  guard that the Coach and Parent 403s exercised live.
- **Revoke re-evaluation cost.** Revoke re-evaluates the rule to report
  `visibleAgain` (about +1.3 s). The revoke itself is complete before
  that step, and a failure there never undoes it.
- **Prior rows are not updated.** If an organisation later turns Allow
  Override off, existing rows remain Active but stop suppressing (by
  design, read side).
- **Still carried:** logical destination routes; no UI; Exceptions and
  Settings tables read whole (fine at TEST scale); Volunteer deferred.
- **Slice 6 has not been started.** Remaining work includes:
  - the next rule families (compliance / non-compliant coach /
    availability / conflicts / outcome / Work Summary / venue);
  - Settings editing;
  - UI and notifications;
  - the production promotion, which must add the 4 revoke fields,
    `Case Key` and the lock table.

## Needs Attention Foundation — Slice 6 (coach compliance rules) — TEST only — 2026-09-28

**Scope.** Three catalogue rules are now evaluated, reusing the existing
Coaches Slice 8 compliance domain without redesigning it:

| Rule Key | Rule ID | Management-facing name |
|---|---|---|
| `coach_compliance_expiry` | ATT-011 | Coach compliance expiring or expired |
| `compliance_verification_pending` | ATT-042 | **Compliance needs Management review** |
| `non_compliant_coach_assigned` | ATT-031 | Non-compliant coach assigned |

`compliance_verification_pending` is the stable machine key. Its current
Management-facing meaning is **"Compliance needs Management review"**: it
covers every existing Needs Review reason, not only submitted-but-unverified
documents, and the exact reason travels in the payload.

**Not in scope:** availability, schedule conflicts, Work Summary, the
Settings editor, Finance, Parent/Player, Development, communications, the
safeguarding workflow (`safeguarding_action_open` stays Planned), Volunteer,
UI, notifications, caching, the Supabase migration, broad exception scopes
and production. Slice 7 has not been started.

**Pre-checks passed:**
- HEAD = origin = `ed4dd5e`, clean tree;
- deployed needs-attention v6 was byte-identical to the repo (9 files);
- the live queue was Clear (5 evaluated, 13 lists, 0 config issues);
- the compliance domain was unchanged since Coaches Slice 8 (`1c652bb`).

**Stop and approval.** The brief's narrower reading of "verification
pending" and its assumption of non-expiring qualifications did not match
the existing domain. Work stopped before any code was written, a mapping
was reported, and these decisions were approved:

1. ATT-042 covers **all** existing Needs Review reasons, keyed per coach +
   requirement, with the exact reason in the payload.
2. **No separate Missing-document rule.** Missing compliance only becomes a
   Needs Attention case through ATT-031, when the coach has eligible
   upcoming work.
3. **No non-expiring semantics.** A verified document with no Expiry /
   Review Date stays Needs Review (`missing_expiry_date`), exactly as the
   domain already resolves it. Explicit non-expiring requirements are
   future compliance / Settings work.
4. Identities: ATT-011 and ATT-042 per coach + requirement; ATT-031 per
   occurrence + coach, listing all failing requirements in one case.
5. ATT-011 stays overridable (Supports Override = Yes, unchanged).
6. ATT-031 stays minimum Warning and escalates to Urgent within 48 hours
   of the occurrence. Missing / Expired are **not** automatically Urgent
   outside that timing.
7. **Rejected does not exist** in the verification workflow (Management can
   only verify). It is documented here only; no workflow was invented.

No catalogue row, Supports Override flag or Settings row was changed.

### NA9.1 Files

| File | Change |
|---|---|
| `needs-attention/compliance.ts` | **New.** The three evaluators, one shared compliance pass, case shaping. Pure (no I/O) |
| `needs-attention/registry.ts` | Registers `COMPLIANCE_EVALUATORS` after staffing and cover |
| `needs-attention/needs-attention.ts` | `ENGINE_VERSION` = `needs-attention-slice-6` (nothing else) |
| `tests/support/needs-attention-compliance.ts` | Hand-kept copy (generated like the other copies; D1 drift-checked) |
| `tests/support/needs-attention-compliance.test.ts` + `tests/e2e/needsattentioncompliancetest.js` | **New**, 80 checks |
| `tests/support/needs-attention.test.ts` | Registry / engine-version / reads / drift checks evolved for Slice 6 |
| other `tests/support/needs-attention-*.ts` copies | Header line only (lists `compliance`) |

`coach-compliance` and `coach-cover` were **not** changed or redeployed.
The repository, orchestrator, exceptions, lock client and index are
unchanged.

### NA9.2 One interpretation of compliance

`compliance.ts` carries a block **copied verbatim** from
`coach-compliance/coach-compliance.ts`: the requirement resolver, the
verification reader, the status precedence (`resolveDocumentType`) and
`summarizeCompliance`. The test DR1 asserts every chunk still appears
byte-for-byte in the canonical file; DR2 asserts the same against
coach-cover's copy. Nothing below the block re-derives a status; it only
maps the resolved status of each **required** item to a rule.

| Resolved status (reason) | Coach-level rule | Assignment rule (ATT-031) |
|---|---|---|
| Current (`verified_and_in_date`) | none | not blocking |
| Review Soon (`within_review_lead_days`) | ATT-011, state severity **Warning** | not blocking (as in coach-cover) |
| Expired (`expiry_date_passed`) | ATT-011, state severity **Urgent** | blocking |
| Needs Review: `not_verified`, `incomplete_verification`, `conflicting_active_records`, `invalid_requirement_config`, `malformed_dates`, `issue_date_after_expiry`, `manual_review_flag`, `missing_expiry_date` | ATT-042 (Normal), reason in payload | blocking |
| Missing (`no_active_record`) | **none** (decision 2) | blocking |

- The blocking set is the exact line coach-cover's `evaluateSuitability`
  uses (`BLOCKING_COMPLIANCE`, drift test DR3).
- Only **Required**, Active, organisation-level requirement rows count
  (domain rule). School-scoped rows are not evaluated and are reported as
  the config issue `compliance_school_requirements_not_evaluated`.
- Only coaches whose Coach record is **Active** are evaluated. Historical
  (inactive) documents are never current and never raise a case.
- Coach-level rules resolve compliance **as of today** (Europe/London, the
  same `ukToday` as the coach-compliance endpoint).
- ATT-031 resolves compliance **as of the occurrence date**, exactly as
  coach-cover's suitability check does (`summarizeCompliance(..., dateIso)`).
  A document that is Review Soon today but will have expired by the
  session therefore already blocks that session.
- An unknown status (none exist today) would be reported as
  `compliance_status_unmapped`, never forced into a rule.

### NA9.3 Case identity

| Rule | Case Key |
|---|---|
| ATT-011 | `coach_compliance_expiry\|coach:<Coach id>\|requirement:<Coach Document Requirements id>` |
| ATT-042 | `compliance_verification_pending\|coach:<Coach id>\|requirement:<Coach Document Requirements id>` |
| ATT-031 | `non_compliant_coach_assigned\|occurrence:<Session Occurrence id>\|coach:<Coach id>` |

- Keys use the catalogue forms.
- When several active required rows exist for one Document Type, the key
  uses the **lowest record id** (deterministic); all ids are in
  `relatedIds.requirementIds`. Adding a new row with a lower id for the
  same type would re-key that type's cases; that is acceptable and noted.
- Keys never contain a document id, so replacing, superseding or verifying
  a document keeps the same case identity (test I4).
- An item has exactly one status, so ATT-011 and ATT-042 never both fire
  for the same coach + requirement. ATT-031 coexists with them by design
  (different subject: the assignment).

### NA9.4 Severity (catalogue-driven; unchanged engine)

- **ATT-011:** base Warning; fixed state severity Review Soon = Warning,
  Expired = Urgent. No thresholds, so no second timing system on top of
  Review Lead Days.
- **ATT-042:** base Normal; no escalation.
- **ATT-031:** base Warning, Locked Minimum Warning, Urgent 48 Hours
  Before (anchor = occurrence start). A Settings Base Severity of Normal
  cannot lower it (A14). No state severity.

### NA9.5 Payload and destinations

- **ATT-011 / ATT-042 context:** coachId, coachName, documentType,
  requirementId, complianceStatus, reviewReason + reviewReasonText,
  documentId, issueDate, expiryDate, daysUntilExpiry, reviewLeadDays,
  verificationState (`verified` / `not_verified` / `incomplete` / null),
  verifiedAt, conflictingRecords, historicalRecords, complianceAsOf.
- **ATT-031 context:** coachId, coachName, coachRole, assignedVia
  (Session Staff / Occurrence Staff), session, occurrence, date,
  start/end, startLocal, complianceAsOf (the session date),
  failingRequirements, missing / expired / needsReview counts, and
  failingSummary. `relatedIds` carries failingRequirementIds and
  failingDocumentIds.
- **No attachment data** (URL, filename or presence flag) and no document
  contents ever enter a case (test P1).
- **Destination:** area "Coaches" and action "Review Compliance" (from the
  catalogue). The route **`coaches/compliance`** is a **placeholder**:
  there is no Management compliance screen yet. Its params are coachId +
  requirementId + documentType (+ documentId), or coachId + occurrenceId +
  sessionId for ATT-031.

### NA9.6 Who is "assigned" (ATT-031)

- Assignment comes **only** from the shared staffing pass (`staffing.ts`,
  one pass per request):
  - Session Staff effective dates;
  - the Occurrence Staff merge, including Cover replacement and Absent
    rows;
  - eligible occurrences only: Scheduled, not superseded, Active session,
    inside the 14-day window.
- Inactive coaches are excluded, as are missing Coach records (already a
  staffing config issue).
- An **active coach with an unrecognised role** is still physically
  assigned, so is still checked (A16). The staffing rules ignore that
  person for counting, but compliance does not.

### NA9.7 Exceptions / override

- ATT-011 supports override: an exact-case exception suppresses that coach
  + requirement case. The exception row links the Coach (server-derived).
- ATT-042 and ATT-031 do not support override: create returns 403
  `override_not_supported` and nothing is written.
- An excepted ATT-011 case never hides the coach's ATT-031 assignment
  cases (E2, and verified live).

### NA9.8 Gating, reads and performance

- `module_coaches` off → no compliance rule runs and **no domain table is
  read** (config tables only; G1, and verified live).
- The coach-level rules read Coach Documents, Coach Document Requirements
  and Coaches. ATT-031 adds the staffing tables. The engine loads the
  union **once each**: a full request is **15 lists** (13 before + Coach
  Documents + Coach Document Requirements).
- Disabling all three rules drops the two compliance tables (G2). A
  caseKey lookup of an ATT-011 case reads 8 tables (G4).
- One compliance pass and one staffing pass per request (R1, R3).
  Per-coach summaries are memoised per (coach, date) in memory. There are
  no per-coach, per-document or per-occurrence queries, no caching across
  requests, and no concurrency change (still 5).
- **Latency** (function edge logs, `execution_time_ms`):

  | State | Timings |
  |---|---|
  | First call after deploy (cold) | 4.95 s |
  | Warm, with probe compliance data (9–14 cases) | 1.44 / 1.78 / 1.36 / 1.41 / 1.39 s (`debug=1`: 1.74) |
  | Warm, Clear after cleanup | 1.49 / 1.35 s (`debug=1`: 1.62) |
  | `view=summary` | 1.79 s |
  | caseKey lookup (8 lists) | 1.56 s |
  | Module off (5 lists) | 1.06 s |
  | Exception create 201 / refused 403 | 2.69 s / ~1.6 s |

  Two extra lists stay within the 1.3–1.7 s Slice 5 baseline. There was
  no caching and no concurrency change.

### NA9.9 Separation for the later Supabase migration

`compliance.ts` is pure: the resolver block plus mapping and shaping, over
plain row objects. It uses no fetch, Deno or writes (DR4). A Supabase
repository only needs to supply the same three row sets.

### NA9.10 Verification

**Unit** (`needs-attention-compliance.test.ts`, **80 checks**, real
orchestrator and registry):
- M1–M6 mapping;
- X1–X11 expiry / review soon: boundaries, today = valid, inactive coach,
  history, Europe/London date;
- V1–V10 review reasons: all eight reasons, and verification clears the
  case;
- CI1–CI6 config issues;
- A1–A16 assignment: one case per occurrence × coach; 48h inclusive
  Urgent; Missing only via assignment; as-of the occurrence date; inactive,
  effective-dated, window, cancelled and past excluded; cover replacement;
  Occurrence Staff add; Absent; locked minimum vs Settings; unknown role;
- I1–I6 identity;
- O1–O2 overlap;
- G1–G4 gating;
- E1–E5 exceptions;
- P1–P3 payload privacy;
- R1–R3 reads;
- U1–U2 and DR1–DR5 drift / purity;
- SG1 safeguarding boundary.

`needs-attention.test.ts` was evolved: checks 27, 71, 84, 85, D1, D4 and
D6 now cover the compliance files, with 1 extra D1 check, giving 107.

**Deliberate-failure check:** 14 mutations were injected into the copy,
and **all 14 are caught**:
- Missing mapped to review;
- Expired made Warning;
- assignment resolved as of today;
- inactive coaches included;
- the highest requirement id used for the key;
- Review Soon made blocking;
- inactive coaches evaluated;
- unknown-role coaches excluded;
- a per-requirement ATT-031 key;
- an attachment flag leaked;
- a state-Urgent on ATT-031;
- no shared pass;
- the UTC date used for today;
- coach-level issues not reported. That last one was initially missed; it
  is now caught by CI6.

**Full suite:** 61 files / **1,835 PASS / 0 FAIL**. The baseline was 60 /
1,754; the delta is the new 80-check file plus 1 extra D1 check.

**Deploy:** `needs-attention` **v7** (`verify_jwt` true, **10 files**).
- `ezbr_sha256` `cc1fa6d87ee19560ec2b13d9df8b6e1697501d387e8cc04a4ed4463a82aeceec`.
- Every deployed file is byte-identical to the repo (sha256 per file).
- No other function was redeployed.

**Live** (prefix `NA-S6-PROBE`, real routes via pg_net; documents were
submitted and verified through the real coach-compliance `/submit` and
`/verify`). "Today" was 2026-09-28 (Europe/London).

| Step | Action | Result |
|---|---|---|
| 0 | Baseline on v7 | Clear; 8 evaluated; **15 lists**, each once; 0 config issues |
| 1 | 2 requirement rows (Enhanced DBS 30 lead days, First Aid 14); 3 probe coaches (Pat, Quinn active; Rae inactive); no documents | **No coach-level case** for anyone: Missing is not a coach-level case. **6 ATT-031 cases** for the real TEST coaches Alex and Sam on real TEST-A / TEST-B occurrences in the window ("Enhanced DBS: Missing; First Aid: Missing"), Warning. Probe coaches are unassigned, so they get nothing |
| 2 | Submit Pat DBS (expiry +10d) and Pat First Aid; Quinn DBS (expired yesterday); Rae DBS (expired). Verify Pat DBS and Quinn DBS | ATT-011 Pat DBS **Warning** ("expires on 2026-10-08 (in 10 days)", `base Warning; state Warning`). ATT-011 Quinn DBS **Urgent** (`state Urgent`). ATT-042 Pat First Aid **Normal**, `not_verified`, "submitted and awaiting Management verification". Rae is inactive, so no case. Quinn First Aid is Missing and unassigned, so no case |
| 3 | Probe session with OB (+34h), OA (+5d) and OC (+12d); Session Staff Quinn + Rae; Occurrence Staff Pat on OA and OC | ATT-031: Quinn × OB **Urgent** (48h), Quinn × OA / OC Warning (Expired + Missing, 2 items). Pat × OA Warning (First Aid Needs Review; Occurrence Staff). Pat × OC Warning with **DBS Expired as of 2026-10-10** plus First Aid. Rae (inactive) → none. No staffing cases. Quinn's ATT-011 and ATT-031 coexist |
| 4 | Exceptions | ATT-011 Quinn DBS → **201**, suppressed, row links Coach = Quinn. ATT-042 → **403** `override_not_supported`. ATT-031 → **403** |
| 5 | Verify Pat First Aid through `/verify` | ATT-042 case **gone**. Pat × OA **gone**. Pat × OC remains with only "Enhanced DBS: Expired". Quinn's ATT-011 is suppressed while Quinn's ATT-031 cases stay visible |
| 6 | `module_coaches` Enabled off (then restored) | Clear; all 8 rules `module_off`; **only the 5 config tables read** |
| 7 | Security and lookup | Coach and Parent on `/cases` → 403; Coach `POST /exceptions` → 403. caseKey lookup of an ATT-011 case → exists, **8 lists**. `view=summary` → Urgent, 11 cases, 1 suppressed |

**Cleanup** by exact ID, **21 records**:
- 1 exception;
- 2 Occurrence Staff and 2 Session Staff rows;
- 3 occurrences and 1 session;
- 4 Coach Documents and 2 requirement rows;
- 3 coaches.

`module_coaches` was restored to Enabled, `needs_attention_exception_locks`
is empty, and `/cases` → **Clear**, 8 evaluated, 15 lists (each once),
0 config issues.

**Regression after cleanup:** all returned 200:
- `/me` for Management, Coach and Parent;
- hub-content `/players`, **md5 `685b11e7…` unchanged**;
- parent-hub `/me` and `/claims/pending`;
- coach-compliance `/summary`;
- coach-cover `/manage`.

### NA9.11 Deferred, flagged, and what Slice 7 still needs

- **Missing on an unassigned active coach raises nothing** (decision 2).
  It surfaces only through ATT-031 once the coach is assigned in the
  window.
- **Non-expiring requirements do not exist.** A verified no-expiry
  document is Needs Review (ATT-042) and blocks assignment (ATT-031).
  Future compliance / Settings work.
- **No Rejected state** in the verification workflow (documented only).
- **School-scoped requirements** are not evaluated. This is the same as
  the coach-compliance endpoint, and is reported as a config issue.
- **`coaches/compliance`** is a placeholder route; there is no UI.
- **Relative wording in ATT-031:** failingSummary phrases ("expired on
  2026-09-27 (3 days ago)") are relative to the **session date**. The
  detail text says so ("as of the session date").
- **Requirement key choice:** the lowest record id per Document Type (see
  NA9.3).
- **Still carried:** exact-case exceptions only; tables read whole (fine
  at TEST scale); Volunteer deferred.
- **Slice 7 has not been started.** Remaining work includes:
  - availability, schedule conflicts, outcome, Work Summary and venue rules;
  - Settings editing;
  - UI and notifications;
  - the production promotion. Production must carry the compliance
    requirement data model (Coach Document Requirements already exists
    there) plus everything NA8.11 lists.

---

## Needs Attention Foundation — Slice 7 (coach availability and schedule conflicts) — TEST only — 2026-09-28

**Scope.** Two catalogue rules are now evaluated:

| Rule Key | Rule ID | Management-facing name |
|---|---|---|
| `assigned_coach_unavailable` | ATT-014 | Assigned coach unavailable |
| `coach_schedule_conflict` | ATT-012 | Coach scheduling conflict |

**Not in scope:** the Work Summary rules (ATT-043 to 046 stay
`not_implemented`), the Settings UI, Finance, Players / Parents,
safeguarding, notifications, caching, the Supabase migration and
production. Slice 8 has not been started.

**Pre-checks passed:**
- HEAD = origin = `544ec2b`, clean tree;
- deployed needs-attention v7 was byte-identical to the repo;
- the live queue was Clear (8 evaluated, 15 lists);
- the availability domain was unchanged since Coaches Slice 7 (`7358752`),
  and coach-cover's copy of the resolver is identical;
- the TEST availability tables were empty.

**Stop and approval.** Two points in the catalogue did not match the
foundation, so work stopped before any code was written:
- The ATT-014 description said "unavailable or ambiguous", but the
  resolver keeps Ambiguous separate.
- ATT-012 did not say whether both occurrences must be eligible.

These decisions were approved:

1. ATT-014 raises **only** when the existing resolver returns
   `unavailable`. Ambiguous never creates a case; it is surfaced as the
   config issue `availability_ambiguous`.
2. **Every** `unavailable` result counts. That includes an explicit
   Unavailable exception, a declared-unavailable weekly row, and work
   outside the hours the coach supplied (`outside_recurring_windows` /
   `outside_exception_hours`). Unknown stays no case.
3. For ATT-012, **both** occurrences in a pair must pass the normal
   Slice 3 eligible-occurrence filter.

Only the two catalogue **Description** texts were updated to say this. No
severity, Supports Override flag, locked minimum, threshold, key format or
Settings row was changed.

### NA10.1 Files

| File | Change |
|---|---|
| `needs-attention/coach-schedule.ts` | **New.** Copied availability resolver block, one availability pass, one conflict pass, both evaluators, case shaping. Pure (no I/O) |
| `needs-attention/registry.ts` | Registers `COACH_SCHEDULE_EVALUATORS` after compliance |
| `needs-attention/needs-attention.ts` | `ENGINE_VERSION` = `needs-attention-slice-7` (nothing else) |
| `tests/support/needs-attention-coach-schedule.ts` | Hand-kept copy (generated like the other copies; D1 drift-checked) |
| `tests/support/needs-attention-coach-schedule.test.ts` + `tests/e2e/needsattentioncoachscheduletest.js` | **New**, 55 checks |
| `tests/support/needs-attention.test.ts` | Registry / engine-version / reads / drift checks evolved for Slice 7 (108 checks) |
| `tests/support/needs-attention-compliance.test.ts` | Fixture catalogue gains ATT-012 / ATT-014 and the two availability tables; R1 / R3 expect 17 lists |
| other `tests/support/needs-attention-*.ts` copies | Header line only (lists `coach-schedule`) |

`coach-availability`, `coach-cover` and `coach-compliance` were **not**
changed or redeployed. The repository, orchestrator, staffing pass,
exceptions, lock client and index are unchanged.

### NA10.2 Availability semantics (ATT-014): one resolver

- `coach-schedule.ts` carries a block **copied verbatim** from
  `coach-availability/coach-availability.ts`: the row readers, the
  weekly-window logic, dated-exception precedence, the Europe/London wall
  clock and `resolveAvailability`.
- Test DR1 asserts every chunk still appears byte-for-byte in the
  canonical file; DR2 asserts the same against coach-cover's copy.
- Nothing below the block decides availability; it only acts on the
  resolver's status.

| Resolver status (reason) | ATT-014 |
|---|---|
| `available` | nothing |
| `unavailable`: `exception_unavailable`, `outside_exception_hours`, `declared_unavailable_recurring`, `outside_recurring_windows` | **case**; the reason code and text travel in the payload |
| `unknown` (`no_availability_supplied`) | **nothing** ("not marked available" is not unavailable) |
| `ambiguous`: `malformed_exception`, `conflicting_exceptions`, `malformed_recurring_availability` | **no case**; config issue `availability_ambiguous` naming the coach, the occurrence and the problem rows |

- The requested window is the occurrence's real Start / End Date & Time,
  converted to the UK wall clock. It must fall on one UK date with
  end > start.
- If the times are missing, reversed or cross midnight, no timing is
  invented. The coach × occurrence is reported as
  `availability_not_evaluable` and no case is raised.
- Only coaches who **count as assigned** are evaluated: the staffing pass
  status is `valid` or `unknown_role`. Inactive coaches and missing Coach
  records never produce a case.

### NA10.3 Conflict semantics (ATT-012)

- Assignments come from the shared staffing pass, per coach, across
  **eligible** occurrences only (decision 3):
  - Scheduled;
  - not superseded;
  - Session Lifecycle Active;
  - inside the 14-day window.
- Overlap uses **half-open intervals on the real instants**: two
  occurrences overlap when `aStart < bEnd && bStart < aEnd`.
  - Back-to-back (one ends 17:00, the next starts 17:00) is **not** a
    conflict.
  - A 1-minute overlap is.
  - This is the same rule coach-cover uses (drift test DR3).
- An occurrence with missing or invalid times is never paired. When the
  coach has another assignment on the same UK date, the config issue
  `conflict_not_evaluable` is raised instead.
- The conflict pass needs **no** availability data. ATT-012 sources are
  the 6 staffing tables only.
- Unavailable and conflict cases **coexist**: neither suppresses the
  other (test I1, and verified live).

### NA10.4 Case identity and duplicate prevention

| Rule | Case Key |
|---|---|
| ATT-014 | `assigned_coach_unavailable\|occurrence:<Session Occurrence id>\|coach:<Coach id>` |
| ATT-012 | `coach_schedule_conflict\|coach:<Coach id>\|occurrence:<lower id>\|occurrence:<higher id>` |

- These are the catalogue key formats, unchanged.
- Pairs are formed per coach over occurrence ids sorted ascending, with
  i < j. There is therefore **no mirror duplicate** (A/B vs B/A).
- The key order is **id order, not time order**. Test K2 covers the case
  where the lower id starts later.
- A triple overlap gives exactly its unique pairs: 3 cases for 3
  mutually overlapping occurrences (T1). That is acceptable at the
  expected volume; no grouping was invented.
- Keys hold only record ids, so edits to times or names keep the same
  identity while the overlap persists.

### NA10.5 Severity and exceptions

- Both rules take severity from the catalogue only:
  - base **Warning**;
  - **Urgent 48 Hours Before**, inclusive, anchored to the occurrence
    start. For a conflict, the anchor is the earlier start.
  - no locked minimum and no state severity.
- Tests: V1 checks the 48h escalation and V2 the exact boundary.
  Verified live: about 82h out gives Warning.
- Both rules keep **Supports Override = Yes** (unchanged). An exact-case
  exception suppresses exactly that key (Slice 5 path, unchanged). The
  exception row links Coach + Session Occurrence, derived server-side.
- If the organisation turns Allow Override off, the result is 403
  `override_disabled_by_settings` (X4).

### NA10.6 Payload and placeholder destinations

- **ATT-014 context:**
  - coachId / Name / Role, and assignedVia;
  - session and occurrence ids / names;
  - date, start / end, and startLocal;
  - `availabilityStatus`, `availabilityReason` + text,
    `availabilitySource` (exception / recurring);
  - `availabilityRecordId` (when a single row decided it),
    `availabilityWindow`, `requestedWindow`, `availabilityDate`.
- **ATT-012 context:**
  - coach;
  - occurrence / session ids and names A / B;
  - start / end A / B, and roles A / B;
  - `overlapStart` / `overlapEnd` / `overlapMinutes`.
  - `relatedIds` lists both sessions and occurrences.
- **No player data** and no availability notes enter a case (P1).
- **Destination:** area "Schedule & Sessions", actions "Review Staffing" /
  "Review Conflict" (catalogue). The routes are **placeholders**; no
  screen exists yet:
  - `schedule/occurrence-staffing` (params: occurrenceId, sessionId,
    coachId);
  - `coaches/schedule-conflict` (params: coachId, occurrenceIdA,
    occurrenceIdB).
- No "resolve" action exists. A case clears only when the data changes or
  an exception is approved.

### NA10.7 Staffing interaction and Occurrence Staff

- Both passes consume the **memoised shared staffing pass**. The dated
  merge decides who is evaluated:
  - Session Staff effective dates;
  - Occurrence Staff additions;
  - Cover rows with a Session Staff Source, which remove the source coach
    from that occurrence.
- An Absent Occurrence Staff row is not an assignment. It is ignored by
  the shared resolver (see NA10.10). **SUPERSEDED IN PART (2026-09-28):**
  the Absent row also removes that coach from the occurrence, so an
  absent recurring coach is neither checked for availability nor paired
  for conflicts (see "Staffing correction — Occurrence Staff Absent").
- Staffing cases are identical with the Slice 7 rules on or off (S1).
- Verified live: a Cover on OB (Quinn replacing Pat) removed Pat's
  conflict and created Quinn's OA / OB conflict.

### NA10.8 Gating, reads and performance

- `module_coaches` off: neither rule runs and **no availability or
  staffing table is read** (5 config lists; G1, and verified live).
- ATT-014 disabled: the two availability tables are not read (G2). A
  caseKey lookup of a conflict reads 5 config + 6 staffing tables (G3).
- A full request is **17 lists**: 15 before, plus Coach Availability and
  Coach Availability Exceptions.
  - Each table is read once.
  - There is one availability pass (availability grouped by coach in
    memory) and one conflict pass.
  - There are no per-coach or per-occurrence queries, no caching and no
    concurrency change.
- **Latency** (function edge logs, `execution_time_ms`):

  | State | Timings |
  |---|---|
  | First call after deploy (cold) | 5.59 s (`debug=1`) |
  | Cold again, after about 6 min idle | 6.94 s |
  | Warm, Clear (17 lists) | 1.93 / 1.69 / 1.73 s (`debug=1`: 1.63) |
  | Warm, with 3 Slice 7 cases (latency re-probe) | 1.56 s; 2.33 s for the first call after a 5-min gap (`debug=1`) |

  The Slice 6 figures were Clear 1.35–1.49 s and cases 1.36–1.78 s.
  Two more lists add roughly 0.2 s on a warm call. The live probe's own
  calls (20:18–20:25Z) never reached the log stream for **any**
  function, so those timings were not captured. A short re-probe (same
  prefix, 8 records, deleted) supplied the with-cases figure. There was
  no caching and no concurrency change.

### NA10.9 Verification

**Unit** (`needs-attention-coach-schedule.test.ts`, **55 checks**, real
orchestrator and registry):
- AV1–AV5 resolver outcomes;
- WC1–WC2 wall clock / untimed;
- OV1–OV2 overlap;
- U1–U11 unavailable (explicit, outside-hours, Available All Day
  override, Unknown, Ambiguous → config issue, inactive coach, inactive
  exception row, payload, severity);
- C1–C5 conflicts (overlap, back-to-back, different coaches, key,
  payload);
- I1 coexistence;
- R1–R2 reads;
- P1 privacy;
- K1–K2 identity;
- O1–O4 Occurrence Staff (Cover, removal, addition, Absent);
- E1–E2 eligibility of both occurrences;
- T1 triple overlap;
- N1 untimed;
- V1–V2 severity;
- S1 staffing unchanged;
- G1–G4 gating;
- X1–X4 exceptions;
- DR1–DR5 drift / purity / catalogue.

**Deliberate-failure check:** 14 mutations were injected into the copy; **13 are caught**:
- Ambiguous raises a case;
- Unknown raises a case;
- closed-interval overlap. This was first injected into the identical line
  in the copied `windowsOverlap`; retargeted at `intervalsOverlap`, it is
  caught by OV1, C2 and C4;
- inactive coaches counted;
- the pair key sorted by start time. This was initially missed; it is now
  caught by K2;
- mirror duplicates;
- the ambiguous issue dropped;
- invented end times;
- UTC used as the wall clock;
- the conflict rule made to need availability tables;
- the anchor on the later start;
- only explicit Unavailable counted;
- the untimed issue dropped.

**M10** (availability memo removed) is not caught and cannot be. The pass
has a single consumer (ATT-014), so the memo does not change behaviour; it
is kept only for symmetry with the other shared passes.

**Full suite:** 62 files / **1,891 PASS / 0 FAIL**. The baseline was 61 /
1,835; the delta is the new 55-check file plus 1 extra D1 check.

**Deploy:** `needs-attention` **v8** (`verify_jwt` true, **11 files**).
- `ezbr_sha256` `ddef9599696ecf7b9d74c57b597bcbf2ab025d4c07470053d48ec52af9aa4a48`.
- Every deployed file is byte-identical to the repo: coach-schedule
  `d368d2df705a…`, needs-attention `c81ca423b833…`, registry
  `e580947f256b…`; the others are unchanged.
- No other function was redeployed.

**Live** (prefix `NA-S7-PROBE`, real routes via pg_net; "today"
2026-09-28, Europe/London). The probe set-up:
- coaches Pat and Quinn (both active);
- sessions SA and SB;
- OA Fri 2 Oct 07:00–08:00 BST and OB 07:45–08:45 BST;
- Session Staff: Pat on SA and SB, Quinn on SA;
- Pat's weekly Friday availability 06:00–10:00;
- Pat's dated exception on 2 Oct: Unavailable.

| Step | Action | Result |
|---|---|---|
| 0 | Baseline on v8 | Clear; 10 evaluated; **17 lists**, each once; 0 config issues |
| 1 | Probe set-up above | **3 cases**: ATT-014 Pat × OA and Pat × OB (`exception_unavailable`, record id = the exception), plus ATT-012 Pat OA/OB (overlap 07:45–08:00, 15 min). All Warning (about 82h out). **Quinn (Unknown) → no case** |
| 2 | Pat's exception changed to Available All Day; Quinn given two contradictory exceptions for 2 Oct | Pat's two unavailable cases **gone**; the conflict remains. Quinn: **no case**, config issue `availability_ambiguous` naming both exception rows |
| 2b | Quinn's pair deleted; Quinn given weekly Friday 09:00–10:00 | ATT-014 Quinn × OA with reason **`outside_recurring_windows`** (decision 2). Weekly row then deleted, so Quinn is back to Unknown |
| 3 | Occurrence Staff Cover on OB: Quinn replaces Pat's SB row | Pat's conflict **gone**; **Quinn OA/OB conflict** appears. Quinn Unknown → no unavailable case. Cover row then deleted |
| 4 | Exact-case exception on Pat's conflict | **201**; queue Clear, **suppressed 1**. Then revoked (200) |
| 5 | OB moved to 07:00–08:00Z (back-to-back with OA 06:00–07:00Z) | **Clear**, no conflict |
| 5b | OB moved to 06:59–07:59Z (1-minute overlap) | Conflict returns, `overlapMinutes` 1, unsuppressed (proves the revoke) |
| 6 | `module_coaches` Enabled off (then restored at once) | Clear; ATT-012 / ATT-014 (and all coach rules) `module_off`; **only the 5 config tables read** |

**Cleanup** by exact ID, **17 records**, plus 3 rows created and deleted
mid-probe:
- 2 coaches, 2 sessions and 2 occurrences;
- 3 Session Staff rows;
- 1 Coach Availability row and 1 exception row;
- 1 Needs Attention Exception;
- the mid-probe rows: Quinn's 2 exceptions, Quinn's weekly row and the
  cover row.

A later latency re-probe (NA10.8) added and deleted **8 more** records:
1 coach, 2 sessions, 2 occurrences, 2 Session Staff rows and 1 exception.

Prefix searches on all touched tables return 0.
`needs_attention_exception_locks` is empty. `module_coaches` is Enabled. `/cases` → **Clear**, 10 evaluated, 17 lists (each once),
0 config issues.

**Regression after cleanup:** all returned 200:
- `/me` for Management, Coach and Parent;
- hub-content `/players`, **md5 `685b11e7…` unchanged**;
- parent-hub `/me` and `/claims/pending`;
- coach-compliance `/summary`;
- coach-cover `/manage`.

Every response hash except coach-cover's (which carries a timestamp)
equals an earlier baseline.

### NA10.10 Separation, flags, and the Slice 8 handoff

- **Supabase migration:** `coach-schedule.ts` is pure: the resolver
  block plus passes and shaping over plain rows. It uses no fetch, Deno
  or writes (DR4). A Supabase repository only needs to supply the same
  8 row sets (6 staffing + 2 availability) in the same field shapes. The
  resolver reads:
  - Day of Week, Available, Start / End Time, Active;
  - Start / End Date, Availability Type, Active.
- **Absent without cover:** an Occurrence Staff row with Attendance =
  Absent is ignored by the shared resolver. A recurring coach marked
  Absent **without** a Cover row is therefore still treated as assigned,
  and could raise ATT-014 / ATT-012. This is the existing Slice 3 rule
  shared with every staffing rule; it was not changed here.
  **SUPERSEDED (2026-09-28):** see "Staffing correction — Occurrence
  Staff Absent". An Absent row now removes the coach from that
  occurrence, with or without cover, so this limitation no longer exists.
- **Outside-hours cases** have no single `availabilityRecordId` (the
  weekly rows as a whole decided it); the reason code says so.
- **Conflict detail order** follows the key (id order), not time order.
  Start times are in the payload.
- **Triple overlaps** produce one case per pair (3 for 3), which is
  acceptable at the expected volume.
- **Placeholder routes:** `schedule/occurrence-staffing` and
  `coaches/schedule-conflict`; there is no UI.
- **Still carried:** exact-case exceptions only; tables read whole (fine
  at TEST scale); Volunteer deferred.
- **Slice 8 has not been started.** Remaining work includes:
  - the Work Summary rules (ATT-043 to 046);
  - outcome and venue rules;
  - Settings editing;
  - UI and notifications;
  - the production promotion. Production must carry the availability
    tables plus everything NA9.11 lists.

---

## Staffing correction — Occurrence Staff Absent — TEST only — 2026-09-28

A correction to the shared staffing resolver, made before Needs Attention
Slice 8. No Slice 8 work was done. Production was not touched.

### The rule (locked)

**Occurrence Staff Absent removes the recurring staff member from the
effective roster for that occurrence independently of whether cover has
been found.**

- Absent means that coach is not working that occurrence.
- A separate Cover (or Additional) Occurrence Staff row may then add the
  replacement coach. The absence never depends on a cover existing.
- Session Staff is never changed. The removal applies to that one
  occurrence only; every other date keeps the recurring roster.
- On that occurrence an absent coach:
  - does not count toward Required Staff Count;
  - does not satisfy Requires Lead Coach;
  - is not treated as assigned for compliance checks (ATT-031);
  - raises no availability case (ATT-014);
  - creates no schedule conflict (ATT-012);
  - gets no player access through the recurring assignment.

### Root cause

`isUsableOccurrenceStaffRow` (Coaches Slice 3) skips an Absent row, so the
row contributed nothing. But the recurring coach enters the roster from
**Session Staff**, and only a usable **Cover** row with a Session Staff
Source removed them. So an Absent row on its own removed nobody. Absence
therefore only took effect once a Cover row existed.

### Resolver change (final semantics)

`resolveOccurrenceStaffing(date, sessionStaff, occurrenceStaff, …)`:

1. **Base:** Session Staff rows that apply on the date (Active + Effective
   From/Until), each coach with its Role. Unchanged.
2. **Overlay:** each usable Occurrence Staff row (Coach linked, not
   Absent). A Cover row with a resolvable Session Staff Source removes the
   source coach, and every usable row sets its coach with role Actual >
   Planned Snapshot > the source's Role. Unchanged.
3. **Absence (new):** every coach with an Absent row (Coach linked,
   Attendance = Absent) on that occurrence is removed from the roster, last,
   whatever steps 1–2 produced.

Nothing else changed:
- role semantics, effective dates, cover selection and the Cover
  replacement are all unchanged;
- no role or permission was widened.

`isAbsentOccurrenceStaffRow` plus the removal loop were added
identically to:
- `hub-content/player-access.ts` (canonical);
- the comment-free copied blocks in `coach-cover/staffing.ts` and
  `needs-attention/staffing.ts`;
- the parent-display twin `resolveOccurrenceRoster` in
  `parent-hub/index.ts`.

**Cover workflow (coach-cover).** `resolveRequesterAssignment` now finds
the requester through the corrected roster. If the requester is not on the
roster, it looks again with **only the requester's own Absent rows**
ignored, and only when a Session Staff row applies to them on that date.
- This reproduces exactly the old answer for "marked Absent, no cover
  yet", so creating and filling a cover still works for a coach who has
  already been marked Absent.
- It stays null when:
  - a Cover row has already replaced the coach;
  - there is no applying Session Staff row;
  - the coach was only ever on an Occurrence Staff row and is now Absent.

  In those cases the date remains `requester_no_longer_assigned`, as
  before.

### Superseded wording

Each place below is marked **SUPERSEDED** in place:
- Coaches Slice 3 "valid-row rule";
- NA Slice 3 resolution ("an Absent row is ignored");
- NA10.7 ("ignored by the shared resolver");
- NA10.10 "Absent without cover" limitation.

The NA staffing test **O3** used to expect no case for "Lead Absent, no
cover". It now expects `no_lead_coach` on that occurrence (it carries a
SUPERSEDED comment). `learning_coach_only` stays suppressed there because
a Lead is required.

### Affected functions (deployed TEST, byte-verified: every file sha matches the repo)

| Function | Version | ezbr_sha256 |
|---|---|---|
| parent-hub | v12 | `4c8a7345f8746b26014032c6586cd6974c9380dcc43a95e2829099314ebb6f99` |
| hub-content | v10 | `c73af8c37c410e2635e90757fb111b421d422efe8c55c04a5b4d3ce4ea0fe7fb` |
| coach-cover | v4 | `ce359f64ab527a31bdd341d38b8e3e46c0ff0a41219042b7aa998ad528834910` |
| needs-attention | v9 | `adadf66908eea1c04d2012d491f0d3c20d131fb8d5450cafbcc6db17019dd92a` |

No other function was redeployed. `ENGINE_VERSION` is unchanged
(`needs-attention-slice-7`).

### Tests

New `tests/support/staffing-absent.test.ts` (38 checks; e2e shim
`tests/e2e/staffingabsenttest.js`):
- **Resolver:**
  - Coach Absent with no cover is removed;
  - Lead Absent no longer satisfies Lead;
  - Absent + Cover gives only the replacement;
  - other dates are unchanged;
  - A6: all three TS resolvers agree on every scenario.
- **Player access (9a–9f):** Absent removes occurrence access. Cover grants
  it to the replacement only. The other date is unchanged.
- **Cover workflow (10a–10h):** the requester fallback, `checkRequestDate`,
  `planSelection` fill, and the post-fill / OS-only / other-occurrence
  cases.
- **Real NA orchestrator** over an in-memory, read-only Airtable:
  - staffing, ATT-031, ATT-014 and ATT-012 exclude the absent coach and
    use the replacement;
  - there are zero write attempts.
- **Drift DR1–DR3:**
  - the test copies match the canonical files;
  - all four implementations contain the identical Absent function and
    removal loop;
  - the session-coaches copy matches parent-hub.

`session-coaches.test.ts` adds parent-display checks AB1–AB3. The existing
drift tests (coach-cover D2/D3, NA DR1/DR2) pass unchanged.

**Mutation check:** 6/6 mutations were caught:
- the removal loop deleted from each of the 4 copies;
- the requester fallback removed;
- the session-coaches copy's removal step removed.

Full suite: **63 files / 1,932 PASS / 0 FAIL**. The baseline was 62 /
1,891; the difference is +38 new checks and +3 AB checks. O3 was changed,
not added.

### Live TEST verification (prefix `ABS-PROBE`, real deployed routes via pg_net)

Setup:
- Session A: Required Staff Count 2, Requires Lead Coach. Lena (Lead) and
  Cal (Coach) as Session Staff.
- Occurrences: O1 (Fri 2 Oct, 17:00–18:00 UK) and O2 (Mon 5 Oct).
- Session B: O3 on 2 Oct, 17:30–18:30 UK (overlaps O1), with Lena and
  Cora as Session Staff.
- Lena and Cora both have an Unavailable exception on 2 Oct.
- One temporary required Enhanced DBS requirement, so that ATT-031 is
  observable.

| Step | Result |
|---|---|
| 1. Before | No staffing case. ATT-014 Lena O1, Lena O3, Cora O3. ATT-012 Lena O1/O3. ATT-031 Lena + Cal on O1 and O2, Lena + Cora on O3 |
| 2. Lena **Absent** on O1, no cover | `no_lead_coach` and `session_understaffed` on O1 (staff "1 Coach", counting 1, coachIds [Cal]). All of Lena's O1 cases gone: ATT-014 O1, ATT-012 O1/O3, ATT-031 O1. O2 and O3 unchanged |
| 3. Add **Cover** Cora for Lena on O1 | Staffing cases clear. Cora now carries ATT-014 O1 (via Occurrence Staff, Lead Coach), ATT-012 O1/O3 and ATT-031 O1. Nothing references Lena on O1. O2 unchanged |

During the probe, 6 ATT-031 cases for the existing TEST coaches were
raised by the temporary requirement, as in NA Slice 6. They were stable
across all three steps.

**Cleanup:** all 17 probe records were deleted (3 coaches, 2 sessions,
3 occurrences, 4 Session Staff, 2 Occurrence Staff, 2 exceptions and 1
requirement). `/cases?debug=1` then returned:
- **Clear**, complete, 0 cases, 0 config issues;
- 10 rules evaluated, 17 tables each listed once.

**Regression:** these all returned 200:
- `/me` for manager, coach and parent;
- hub-content `/players` (md5 `685b11e7…`, unchanged);
- parent-hub `/me` and `/claims/pending`;
- coach-compliance `/summary`;
- coach-cover `/manage`.

### Follow-up flagged (not changed)

> **SUPERSEDED / RESOLVED (2026-09-28)** by "Staffing correction — Cover
> replacement stays in force when the cover coach is Absent" below: the
> replaced recurring coach no longer reappears. This paragraph is kept as
> the historical record of what was flagged.

If a **Cover** row is itself marked Absent (the cover coach did not
attend), that Cover row is unusable, so it no longer removes its source
coach. The recurring coach it replaced therefore reappears on the roster
unless they also have their own Absent row. This is pre-existing
behaviour. The cover workflow's own writes are unaffected: it sets only
the requester's rows Absent. The behaviour should be decided explicitly
before production.

## Staffing correction — Cover replacement stays in force when the cover coach is Absent — TEST only — 2026-09-28

A small follow-up to the Occurrence Staff Absent correction (9816e94). It
resolves the "Follow-up flagged" edge case above. No Needs Attention
Slice 8 work was done. Production was not touched. Session Staff was
never mutated.

### The rule (locked)

**A cover/replacement remains the displacement decision for that occurrence even if the replacement coach later becomes Absent; the original recurring coach does not automatically return.**

- Once a recurring coach has been replaced by a Cover row for an
  occurrence, that replacement decision stays in force for that
  occurrence.
- If the cover coach later becomes Absent, the cover coach is removed. The
  original recurring coach does **not** come back, and the slot is unfilled
  unless another valid replacement is added.
- The replacement relationship and the absence state are handled
  independently. Reversing a replacement never depends on whether the
  replacement coach is currently valid, active or absent.

### Root cause

In the overlay loop, `if (!isUsableOccurrenceStaffRow(row)) continue;` ran
**before** the Cover displacement. A Cover row that was itself marked
Absent was therefore skipped entirely, so it no longer removed its Session
Staff Source coach, and the replaced recurring coach reappeared.

- Cover row Planned plus a separate Absent row for the cover coach was
  already correct (empty roster). Only the single-row form (the Cover row's
  own Attendance = Absent) brought the recurring coach back.
- The cover workflow never writes Absent onto a Cover row (it only sets the
  requester's own rows Absent at fill time), so no workflow depended on the
  old order.

### Resolver change (final semantics)

`resolveOccurrenceStaffing` (and parent-hub's `resolveOccurrenceRoster`):

1. **Base:** Session Staff rows that apply on the date. Unchanged.
2. **Overlay:** for each Occurrence Staff row with a linked Coach:
   - **Displacement (moved before the usability gate):** if it is a Cover
     row whose Session Staff Source resolves, remove the source coach
     (unless it is the same coach), **whatever the row's Attendance**.
   - **Addition:** then, only if the row is usable (not Absent), set its
     coach with role Actual > Planned snapshot > the source's Role.
     Unchanged.
3. **Absence:** remove every coach with an Absent row. Unchanged.

Unchanged edge cases:
- a Cover row with no linked Coach is ignored entirely;
- a Cover row whose source does not resolve removes nobody;
- a same-coach Cover row is a role override, not a removal;
- Additional / Temporary Role rows never displace anyone.

The identical reorder was applied to all four copies:
- `hub-content/player-access.ts` (canonical);
- the copied blocks in `coach-cover/staffing.ts` and
  `needs-attention/staffing.ts`;
- `parent-hub/index.ts` `resolveOccurrenceRoster`.

The test mirrors were updated to match (`tests/support/player-access.ts`,
`coach-cover-staffing.ts`, `needs-attention-staffing.ts`, and the
session-coaches copy).

`resolveRequesterAssignment` (coach-cover) is unchanged. A recurring coach
displaced by a Cover row, including one whose cover coach is now Absent,
stays null, so no cover request can be raised for them on that date. A
working cover coach can still request cover. Filling it sets their Cover
row Absent and adds a new Cover row citing the original Session Staff
source, so the roster becomes the new cover coach only.

### Affected functions (deployed TEST, byte-verified: every file sha matches the repo)

| Function | Version | ezbr_sha256 |
|---|---|---|
| hub-content | v11 | `885c5bc24e207641d751926db255ed5117b41717e0ea03eae4b687231a54c3d3` |
| parent-hub | v13 | `fe98e9ae44b1e265764702dcedf387d9f398d980d73b03b57be6ba852fdd81a6` |
| needs-attention | v10 | `b5b581716536f41d7652990799a92b3aef7400193cd1feb898b8745c479c9824` |
| coach-cover | v5 | `b828fa5c2ae2a5c97b273e2936d68bac22ce393aab45195298621065d8999e4c` |

Only these four functions contain a resolver copy that changed. No other
function was redeployed. `ENGINE_VERSION` is unchanged
(`needs-attention-slice-7`). verify_jwt stays true for all four.

### Tests

New `tests/support/cover-absent.test.ts` (42 checks; e2e shim
`tests/e2e/coverabsenttest.js`). Fixture: Danny is the only recurring Lead
on a session that Requires Lead Coach (Required Staff Count 1). Sam and Joe
are cover coaches. OA is Mon 5 Oct, OB is 12 Oct, and OX is another
session overlapping OA.

- **Resolver (0–5b):**
  - cover replaces Danny;
  - the cover coach Absent (single-row and two-row forms) leaves Danny
    removed and the roster empty;
  - a second cover (either order) gives Joe only;
  - other dates and occurrences are unchanged.
- **10a:** the hub-content, coach-cover and needs-attention resolvers agree
  on every scenario.
- **Existing behaviour (9a–9f):**
  - unresolvable source;
  - same-coach override;
  - Additional rows;
  - an Absent non-Cover row;
  - a coachless Cover row.
- **Player access (8a–8e):**
  - the absent cover coach gets no access;
  - Danny does not regain access;
  - Joe gets exactly the Lead role;
  - the other date is unchanged.
- **Cover workflow (9g–9l):**
  - Danny and absent Sam are not requesters;
  - a working Sam is;
  - the fill writes a new Cover row citing Danny's source;
  - the post-fill roster is Joe only;
  - a normal recurring requester is unchanged.
- **Real NA orchestrator over in-memory Airtable (NA0, NA1, 6, 7a–7e, 5c,
  6b, 4c, NA2):**
  - `session_no_coach` on OA only;
  - no ATT-031, ATT-014 or ATT-012 for Danny or Sam on OA;
  - OX cases remain;
  - OB unchanged;
  - the second cover resolves the case;
  - zero writes.
- **Drift (10b–10d):**
  - the player-access mirror equals the canonical file;
  - all four copies and the session-coaches copy displace before the
    usability gate, and none keeps the old order;
  - the overlay loop is byte-identical in hub-content, coach-cover and
    needs-attention.

`session-coaches.test.ts` adds parent-display checks CV1–CV3:
- an absent cover shows no names;
- a second cover shows only Joe;
- another date shows Danny.

**Mutation check:** 8/8 mutations were caught. Reverting to the old order
in each function copy and in each test copy made at least one check fail.

Full suite: **64 files / 1,977 PASS / 0 FAIL**. The baseline was 63 /
1,932; the difference is +42 new checks and +3 CV checks.

### Live TEST verification (prefix `CVA-PROBE`, real deployed routes via pg_net)

Setup:
- Session A: Required Staff Count 1, Requires Lead Coach, with Danny
  (Lead) as Session Staff.
- Occurrences: O1 (Fri 2 Oct, 17:00–18:00 UK) and O2 (Mon 5 Oct).
- Session B: O3 on 2 Oct, 17:30–18:30 (overlaps O1), with Danny (Lead)
  and Sam (Coach).
- Danny and Sam both have an Unavailable exception on 2 Oct.
- One temporary required Enhanced DBS requirement, so that ATT-031 is
  observable.
- Archie (parent.a's child) was given one temporary Player Session Link on
  Session A, so that parent-hub's display for O1 (the next occurrence) is
  observable.

| Step | Needs Attention (probe cases) | parent-hub coaches (SA, next = 2 Oct) |
|---|---|---|
| 1. Before | No staffing case. Danny: ATT-012 O1/O3, ATT-014 O1 + O3, ATT-031 O1/O2/O3. Sam: ATT-014 O3, ATT-031 O3 | `["CVA-PROBE Danny"]` |
| 2. **Cover** Sam for Danny on O1 (source = Danny's SA Session Staff row) | No staffing case. All of Danny's O1 cases gone. Sam now carries ATT-012 O1/O3, ATT-014 O1, ATT-031 O1. O2/O3 unchanged | `["CVA-PROBE Sam"]` |
| 3. Sam's **Cover row set Attendance = Absent** | `session_no_coach` on O1 ("No staff are assigned"). **Danny does not reappear**: no ATT-012/014/031 for Danny on O1. Sam's O1 cases gone. O2 (Danny ATT-031) and O3 unchanged | `[]` |
| 4. Add a second **Cover** row: Joe for Danny on O1 | Staffing case resolved. Joe carries ATT-031 O1. Still nothing for Danny or Sam on O1. O2/O3 unchanged | `["CVA-PROBE Joe"]` |

All calls returned 200 with `complete: true`. The 6 ATT-031 cases for
existing TEST coaches (raised by the temporary requirement, as in NA
Slice 6) were stable across all four steps.

**coach-cover (v5), after step 4:** `POST /requests` (manager) asking
cover for Danny on O1 returned **409 `invalid_dates`** ("The coach is not
assigned to this occurrence"), with nothing created. Danny stays
displaced in the cover workflow as well.

**hub-content player access (v11), run on 29 Sep after UK midnight.**
hub-content applies Occurrence Staff only to an occurrence dated today
(UK). Setup:
- a third probe Session C with Alex Test (coach.a) as Lead Session Staff;
- occurrence O4 dated 29 Sep;
- a temporary Player Session Link for Archie on Session C.

`GET /hub-content/players` as coach.a:

| Step | Archie @ CVA-PROBE-SC in coach.a's rows | parent-hub SC coaches (next = 29 Sep) |
|---|---|---|
| Before (no Occurrence Staff) | present, `permanent`, Lead (`can_edit_idp: true`) | – |
| Cover Sam for Alex on O4 (source = Alex's SC Session Staff row) | **gone** | – |
| Sam's Cover row set **Absent** | **still gone**: Alex does not regain access through his recurring row | `[]` |
| Second Cover (Joe) added | still gone (Joe now holds the slot) | `["CVA-PROBE Joe"]` |

coach.a's TEST-A rows (Archie, Bella) were unchanged throughout.

**Cleanup:** all 23 probe records were deleted by their exact ids:
- 3 coaches;
- 3 sessions;
- 4 occurrences;
- 4 Session Staff rows;
- 4 Occurrence Staff rows;
- 2 exceptions;
- 1 requirement;
- 2 Player Session Links.

`CVA-PROBE` searches across Sessions, Coaches, Occurrence Staff and
Session Occurrences return nothing. `/cases?debug=1` then returned:
- **Clear**, complete, 0 cases, 0 config issues;
- 10 rules evaluated, 17 tables each read once.

**Regression:** these all returned 200:
- `/me` for manager, coach and parent;
- hub-content `/players` (md5 `685b11e7…`, unchanged);
- parent-hub `/me` and `/claims/pending`;
- coach-compliance `/summary`;
- coach-cover `/manage` (0 dates, 0 groups).

---

## Needs Attention Foundation — Slice 8 (coach outcome and Work Summary rules) — TEST only — 2026-09-29

**Scope.** Four catalogue rules are now evaluated:

| Rule Key | Rule ID | Case title prefix | Action Label | Warning (catalogue) |
|---|---|---|---|---|
| `coach_outcome_pending` | ATT-043 | Coach outcome needed | Record Coach Outcome | 48 Hours Overdue |
| `work_summary_queried` | ATT-044 | Work summary queried | Review Query | 3 Days Overdue |
| `work_summary_ready_to_finalise` | ATT-045 | Work summary ready to finalise | Finalise Summary | 3 Days Overdue |
| `work_summary_blocked` | ATT-046 | Work summary blocked | Resolve Pending Items | 3 Days Overdue |

All four are Active, module `module_coaches`, base severity Normal, no
Urgent threshold, Destination Area Coaches, **Supports Override = No**.
None of these catalogue values was changed.

**Not in scope:**
- Finance: invoices, payroll, payments, revenue, parent refunds, venue
  credits, margin, VAT, finance sync and school invoicing.
- Parent and Venue financial outcomes (Occurrence Financial Outcomes are
  never read).
- A generic `session_change_followup` rule.
- The Settings UI, Players / Parents, safeguarding, notifications, caching
  and the Supabase migration.
- Production. Slice 9 has not been started.

**Pre-checks passed:**
- HEAD = origin = `108673b`, clean tree;
- deployed coach-work-summaries, occurrence-financial-outcomes and
  needs-attention v10 were byte-identical to the repo;
- the live queue was Clear: 10 rules evaluated, 0 config issues, the four
  Slice 8 rules skipped as `not_implemented`;
- the TEST Coach Work Summaries and Coach Allocations tables were empty.

**Mapping check (no STOP needed).** Every stored Work Summary status and
every coach-side outcome state maps onto exactly one of the four rules,
or onto "no case", without inventing a state. This is the NA2.6 contract
(below) applied as written.

### NA11.1 Files

| File | Change |
|---|---|
| `needs-attention/work-summaries.ts` | **New.** Two verbatim copied blocks from coach-work-summaries (`work-summaries.ts` statuses/constants/`classifyAllocation`/`isFrozen`/`openStatusFor`; `orchestrator.ts` `evaluate()` loop), the NA2.6 effective-status mapping, one shared Work Summary pass, one shared coach-outcome pass, four evaluators and case shaping. Pure (no I/O) |
| `needs-attention/registry.ts` | Registers `WORK_SUMMARY_EVALUATORS` after the Slice 7 rules |
| `needs-attention/needs-attention.ts` | `ENGINE_VERSION` = `needs-attention-slice-8` (nothing else) |
| `tests/support/needs-attention-work-summaries.ts` | Hand-kept copy (import paths only; D1 drift-checked) |
| `tests/support/needs-attention-work-summaries.test.ts` + `tests/e2e/needsattentionworksummariestest.js` | **New**, 80 checks |
| `tests/support/needs-attention.test.ts` | Registry / engine version / reads / drift checks evolved for Slice 8 (109 checks) |
| `tests/support/needs-attention-compliance.test.ts`, `needs-attention-coach-schedule.test.ts` | Fixture catalogue gains ATT-043 to 046 and the two Work Summary tables; R1 / R3 expect 19 lists |
| `tests/support/needs-attention-engine.ts`, `needs-attention-registry.ts` | Regenerated copies |

coach-work-summaries, occurrence-financial-outcomes and every other
function were **not** changed or redeployed. The repository,
orchestrator, exceptions, lock client and index are unchanged.

### NA11.2 Effective status: recomputed, never trusted (NA2.6)

Stored `Coach Work Summaries.Status` is only rewritten by the domain's
prepare / refresh / finalise routes, so it can be stale. Needs Attention
recomputes the status exactly as `applyRefresh()` would and **never
writes anything back**:

```
effective = Finalised                              if stored = Finalised
          = Queried                                if stored = Queried
          = openStatusFor(pending, period, today)  otherwise
openStatusFor = Not ready if pending > 0 or Period End >= today, else Needs review
```

- `pending` comes from the domain's own `classifyAllocation`, run over the
  coach's allocations through the copied `evaluate()` loop. The pending
  reasons, in order, are multiple_coaches, cost_not_confirmed,
  invalid_final_cost, coach_outcome_undecided and not_yet_worked. Undated
  allocations are listed but never block.
- `today` is the domain's `ukToday()` (Europe/London), the same date the
  finalise route checks.
- A stored status that disagrees with the effective one is flagged
  `storedStatusStale: true` in the payload and noted in the detail text.
  It is never used to decide the rule.

### NA11.3 Rule mapping: one case per summary at most

| Effective status | Period | Rule |
|---|---|---|
| Queried | any | `work_summary_queried` |
| Needs review | ended | `work_summary_ready_to_finalise` |
| Not ready | ended (Period End < today) | `work_summary_blocked` |
| Not ready | still in progress | no case (`period_in_progress`) |
| Finalised | — | no case (skipped) |

- **Queried** clears when the query is resolved at source: finalised,
  reopened (status back to open, recomputed), or the row deactivated.
- **Ready** is the effective Needs review state. It is never inferred from
  the calendar alone: the period must have ended **and** nothing may be
  pending.
- **Blocked** needs an ended period and pending items. It is never raised
  for a period still in progress.
- Because each summary has exactly one effective status, one summary can
  never carry two contradictory cases (tests I1 / M3, live step 5).
- **Skipped:** inactive summaries (`Active` unticked), Finalised, and rows
  with no Coach, no valid Period Start/End or an unrecognised Status. The
  last group is reported as config issue `work_summary_invalid`; it is
  never forced into a rule.
- **Frozen** (Queried after finalisation, not reopened) is reported in
  the payload (`frozen`, `previouslyFinalised`). It raises the same queried
  case.
- Inactive **coaches** still get their summaries evaluated (the decision
  is still owed); `coachActive` is in the payload. A summary linking a
  coach missing from Coaches gets config issue
  `work_summary_coach_missing`, and the case is still shown.

### NA11.4 Coach outcome boundary (ATT-043)

- **Source of truth:** `Coach Allocations.Coach Outcome` (Coaches Slice 6).
- **Trigger:** classifyAllocation's own two lines, copied and
  drift-tested. The linked Session Occurrence Status is **Cancelled or
  Postponed**, and Coach Outcome is not one of **Paid / Partial / Unpaid**.
  An unrecognised stored outcome counts as undecided and is quoted in the
  detail.
- **Coach side only.** Parent and Venue outcomes live in Occurrence
  Financial Outcomes (Finance). That table and its Lines / History are
  never read (tests RD2 / DR8, live read list).
- **Rescheduled** (`Schedule Change State`) alone is **not** a trigger:
  the occurrence still runs. A Postponed occurrence with a replacement
  still needs this date's coach decision; the replacement id is in the
  payload.
- One case per **(occurrence, coach)**:
  - an allocation linked to several coaches raises one case per coach, plus
    config issue `coach_outcome_allocation_multiple_coaches`;
  - duplicate undecided allocations for the same pair become one case
    listing both, plus `coach_outcome_duplicate_allocations`;
  - an allocation with no coach gives config issue
    `coach_outcome_allocation_no_coach` and no case.
- **Clears** as soon as a recognised outcome is stored, or the occurrence
  is no longer Cancelled / Postponed.

### NA11.5 Case identity

- `coach_outcome_pending|occurrence:<occurrence id>|coach:<coach id>`.
  The catalogue description previously said "allocation"; it now documents
  this key. That was the only catalogue text change.
- `work_summary_queried|summary:<summary record id>`
- `work_summary_ready_to_finalise|summary:<summary record id>`
- `work_summary_blocked|summary:<summary record id>`

Keys use record ids only (never labels or dates), so they stay stable
across renames and status changes. A summary moving from blocked to ready
changes rule and therefore key. That is intended: it is a different thing
to do.

### NA11.6 Severity and exceptions

Severity uses the generic engine and catalogue thresholds; no rule timing
lives in the engine.

| Rule | `outstandingSince` anchor |
|---|---|
| ATT-043 | Occurrence Start Date & Time. If untimed: 00:00 local on its Date |
| ATT-044 | `Queried At`. If missing: config issue `work_summary_query_time_unknown`, and the case stays Normal |
| ATT-045 / 046 | 00:00 local on the day after Period End (`periodEndedAt`, DST-correct) |

Boundaries are inclusive (tests O16 / R9).

All four rules have **Supports Override = No**. An exception create for
any Slice 8 case returns **403 `override_not_supported`**: tests E1 to E3,
and live for all four keys. The flags were not changed to simplify
testing. The Slice 5 behaviour for overrideable rules is unchanged (E3:
`session_no_coach` still 201).

### NA11.7 Payload and placeholder destinations

- **Work Summary cases:**
  - `destination.route` `coaches/work-summary`, params `{summaryId,
    coachId}`;
  - `targetIds` `{summaryId, coachId}`;
  - `relatedIds` `{pendingAllocationIds, undatedAllocationIds}`.
  - Context:
    - summary and Work Summary ID;
    - coach id / name / active;
    - period start / end / `periodEndedAt`;
    - stored and effective status, `storedStatusStale`, `frozen`,
      `previouslyFinalised`, `finalisedAt`, `reopenedAt`;
    - `queriedAt` and `queryNote` (queried rule only; note capped at 280
      characters);
    - `pendingCount` plus one count per pending reason;
    - `eligibleCount`, `undatedCount`, `canFinaliseNow`, `evaluatedAsOf`.
- **Coach outcome cases:**
  - `destination.route` `coaches/occurrence-financial-outcome`, params
    `{occurrenceId, coachId, allocationId (when single)}`;
  - `targetIds` add `sessionId` / `allocationId`.
  - Context:
    - occurrence / session names, status, Schedule Change State,
      replacement id;
    - date, start and local start;
    - coach name / active;
    - `allocationCount`, `currentCoachOutcome`, `outcomeOptions`
      ("Paid, Partial, Unpaid");
    - `costStatus` and `finalCoachCost` of that one allocation.
- **No totals.** No Grand Total, line totals, rates or other financial
  aggregates enter any case (R5 / P1).
- **Wording:**
  - "nothing is pending" (no work in the period);
  - "its 1 item of work is resolved";
  - "all N items of work are resolved";
  - the query date is shown in the organisation timezone.
- **Placeholder routes.** Both routes are placeholders: there is no UI
  yet, and no "mark complete" action exists. Cases disappear only when the
  source data is fixed.

### NA11.8 Gating, reads and performance

- **Gating.** The rules run only when `module_coaches` is enabled and each
  rule's effective Enabled is on. When they do not run, Coach Work
  Summaries and Coach Allocations are **not read** at all (tests G1 to G6).
- **Reads.** Coach Work Summaries and Coach Allocations are new sources.
  Session Occurrences, Sessions and Coaches are shared with the staffing
  rules and loaded once. A full request is now **19 list operations**
  (5 config + 14 domain), each table once. A single-rule `caseKey` lookup
  is 10.
- **Passes.** One shared Work Summary pass and one shared coach-outcome
  pass per request (memoised). Allocations are indexed by coach once.
  There are no per-summary, per-coach or per-occurrence queries (RD1 to
  RD4).
- **Live latency** (function edge logs, `execution_time_ms`, v12):

  | Call | Latency |
  |---|---|
  | First call after deploy | 2.94 s |
  | Warm full queue (`debug=1`) | 1.56 / 1.58 / 1.69 / 1.82 s |
  | Single-rule lookups | 1.20 / 1.31 s |
  | Coach 403 | 0.33 s |

  That is in line with Slice 7 (about 1.56 s warm with 17 lists).
- **429 watchpoint.** No 429 was seen. The 19 lists still go in waves of
  5 with the existing backoff, but real-scale Airtable volume remains a
  watchpoint until the Supabase migration.

### NA11.9 Verification

**Unit tests**
- `needs-attention-work-summaries.test.ts`: **80 / 80**.
  - Pure mapping: M1 to M6.
  - Queried: Q1 to Q9.
  - Ready: R1 to R10, including stale in both directions, the inclusive
    3-day boundary and the wording.
  - Blocked: B1 to B5; exclusions: X1 to X3.
  - Coach outcome: O1 to O16, including Rescheduled, Paid / Partial /
    Unpaid, the Parent/Venue boundary, duplicates and the 48 h boundary.
  - Identity: I1 to I4; payload: P1; reads and purity: RD1 to RD4.
  - Gating and lookups: G1 to G6; exceptions: E1 to E3; drift and
    boundaries: DR1 to DR8.
- `needs-attention.test.ts` 109 / 109; compliance 80 / 80; coach-schedule
  55 / 55.
- **Full suite: 65 / 65 files, 2,058 PASS, 0 FAIL.** The baseline was 64
  files / 1,977.

**Mutation check.** Ten mutants were applied to the tested copy:
- stored status trusted;
- blocked while the period is open;
- inactive summaries evaluated;
- Rescheduled triggers an outcome;
- Partial not accepted;
- queried case anchored on period end;
- summary key uses the coach id;
- the "0 items" wording regression;
- query date read as UTC;
- the Finalised skip removed.

**9 / 9 behavioural mutants are caught.** The Finalised skip is an
equivalent mutant: a Finalised summary maps to no rule either way. The
UTC mutant was first missed; Q9 was added for it.

**Deploys.** needs-attention **v11** was the first Slice 8 deploy. The
live probe then showed "all 0 items of work are resolved" and a UTC query
date, which were fixed. **v12** is current: 12 files, `verify_jwt` true,
ezbr `ca98c9cf6f667f4deeb76b627e45d9efdbf1b47a6be041cb4e2f8a92a1c2f563`.
**Byte-verified: every file matches the repo.**

**Live TEST verification** (prefix `S8-PROBE`, real deployed routes via
pg_net, manager token; "today" 2026-09-29 Europe/London).

Probe set:
- coach `S8-PROBE Wendy` and session `S8-PROBE-S1`;
- O1: 18 Aug, Completed;
- O2: 25 Aug, Cancelled;
- A1: O1, Cost Status Draft;
- A2: O2, Confirmed £30, no Coach Outcome;
- WSQ: 1–7 Aug, Queried, note, Queried At 20 Sep;
- WSR: 8–14 Aug, stored "Not ready", nothing pending;
- WSB: 15–21 Aug, stored "Needs review", A1 pending.

| Step | Result |
|---|---|
| 1. Queried | `work_summary_queried|summary:<WSQ>`, Review Query, `coaches/work-summary`, note + date in payload; Warning (about 9 days > 3) |
| 3. Ready | `work_summary_ready_to_finalise|summary:<WSR>` although stored "Not ready" (`storedStatusStale` true); Warning |
| 4. Blocked | `work_summary_blocked|summary:<WSB>` although stored "Needs review": "1 item still pending (1 cost not confirmed)"; no ready case for WSB |
| 6. Coach outcome | `coach_outcome_pending|occurrence:<O2>|coach:<Wendy>`, Record Coach Outcome, `coaches/occurrence-financial-outcome` with allocationId; Warning (> 48 h) |
| Exceptions | all four keys → **403 `override_not_supported`**; nothing written |
| 2. Resolve queried (Finalised) | queried case gone |
| 5. Fix blocked (A1 Confirmed + £30) | blocked case gone; WSB is now ready (stored "Needs review", not stale): never both |
| 7. Coach Outcome = Paid | coach outcome case gone |
| v12 re-check | wording "nothing is pending" / "its 1 item of work is resolved" |
| Query after finalise, Queried At 28 Sep 23:30Z | queried case, text "on 29 Sep 2026" (London date), `frozen` and `previouslyFinalised` true, Normal (< 3 days) |
| Reopen (status Not ready, Reopened At set) | queried case gone; recomputed ready (stored "Not ready" stale, `frozen` false) |
| Deactivate WSR | its case disappears |
| 8. Stale status | covered by steps 3, 4 and the reopen: the stored value never decided a rule |
| `caseKey` lookups | resolved queried key `exists: false`; new ready key `exists: true`; 10 lists each |
| Coach token on `/cases` | 403 |

Every full request read 19 lists, 14 rules were evaluated and there were
0 config issues.

**9. Cleanup:** all 9 probe records were deleted by id (3 summaries,
2 allocations, 2 occurrences, 1 session, 1 coach). The final queue is
**Clear**: 14 evaluated, 19 lists, 0 config issues, every Slice 8 rule 0
candidates. Needs Attention Exceptions is unchanged.

**Regression (live):**
- `/me` 200 for management, coach and parent;
- hub-content `/players` 200, md5 `685b11e7…` unchanged;
- parent-hub `/me` and `/claims/pending` 200;
- coach-compliance `/summary?coachId=recYZyiLVud7yoNZS` 200;
- coach-cover `/manage` 200;
- coach-work-summaries `/summaries` 200;
- occurrence-financial-outcomes `/outcomes` answers (400 without
  `occurrenceId`, as designed).

### NA11.10 Separation for the later Supabase migration

`work-summaries.ts` is pure: copied domain functions, passes and shaping
over plain rows. It has no fetch, Deno or writes (RD4 / D4).

- **Reads to replace.** Coach Work Summaries and Coach Allocations become
  repository queries returning the same field shapes:
  - Work Summary ID, Coach, Period Start / End, Status, Active, Queried
    At, Query / Reopen Note, Finalised At, Reopened At;
  - Allocation ID, Coach, Session Occurrence, Cost Status, Final Coach
    Cost, Coach Outcome, Rate Type Snapshot, Paid Units, Rate Amount
    Snapshot.

  The Session Occurrences / Sessions / Coaches rows are shared.
- **Copies to delete.** When coach-work-summaries itself moves, the
  copied blocks should be replaced by one shared import. Until then the
  drift tests keep them byte-identical.
- **Not migrated here.** No schema, table or migration was created.

### NA11.11 Deferred, flagged, and the Slice 9 handoff

- **Finalised drift not raised.** A Finalised summary whose allocations
  changed after finalisation raises no case. The frozen lines are the
  record; reconciling them is a Finance / reopen workflow question, not
  a Slice 8 rule.
- **`evaluate()` stays copied.** Moving the domain's `evaluate()` loop
  into coach-work-summaries/work-summaries.ts, so it can be copied from
  one file, was left alone: the domain function was not touched.
- **Catalogue text only.** The four Description texts were updated to the
  implemented behaviour, with the ATT-043 key documented as occurrence +
  coach. No severity, threshold, override flag, locked minimum or Settings
  row was changed.
- **Placeholder routes** `coaches/work-summary` and
  `coaches/occurrence-financial-outcome` await the Management UI.
- **Still carried:** tables read whole (fine at TEST scale), exact-case
  exceptions only, Airtable 429 watchpoint.
- **Slice 9 has not been started.**

## Needs Attention Foundation — FINAL (Slice 9: performance, contract freeze and handoff) — TEST only — 2026-09-29

> **FOUNDATION COMPLETE IN TEST — READY FOR FINANCE FOUNDATION.**
> This marks the Needs Attention foundation complete and frozen **in TEST**.
> It does **not** mean the foundation is production-ready. Nothing here has
> been promoted, and production was not touched (read-only throughout).

Slice 9 added no rule family, activated no Planned rule and changed no
evaluator. No code defect was found, so `needs-attention` was **not
redeployed**. It stays at **v12**, byte-identical to
`supabase/functions-test/needs-attention/` at `3298c0c`. This slice added:

- one audit test (`tests/support/needs-attention-foundation.test.ts`, 77
  checks, with its e2e shim);
- a snapshot of the live catalogue
  (`tests/support/needs-attention-catalogue.snapshot.json`);
- this section.

### NA12.1 Active catalogue (frozen v1)

There are 38 catalogue rows: **14 Active** and **24 Planned**, with 0
Retired. (This was corrected on 2026-09-29, see NA12.15. It was
previously 15 Active / 23 Planned, with `venue_missing` Active.) The
snapshot is compared, row by row, with the code-side registry by
CAT1–CAT13. There were 0 mismatches against the live base.

**Frozen status definition.**

- **Active** means a live evaluator exists and the Needs Attention engine
  evaluates the rule. Every Active row has a registered evaluator, and
  every registered evaluator has an Active row (CAT3/CAT4).
- **Planned** means designed and catalogued for future implementation,
  but not evaluated.
- **Retired** means intentionally no longer used.

The engine's `not_implemented` skip reason remains as a safety net for an
Active row without an evaluator. No catalogue row triggers it.

All evaluated rules require `module_coaches`, and every rule is Client
Customisable. W = default Warning threshold, U = default Urgent threshold.
"Before" is measured to the event, "Overdue" from outstanding-since.

| Rule | Key | Base | W | U | Override | Destination route | Case key |
|---|---|---|---|---|---|---|---|
| ATT-001 | no_lead_coach | Normal | 72h Before | 24h Before | Yes | schedule/occurrence-staffing | `occurrence:X` |
| ATT-002 | learning_coach_only | Normal | 72h Before | 24h Before | Yes | schedule/occurrence-staffing | `occurrence:X` |
| ATT-005 | session_understaffed | Normal | 72h Before | 24h Before | Yes | schedule/occurrence-staffing | `occurrence:X` |
| ATT-013 | session_no_coach | Warning | – | 48h Before | Yes | schedule/occurrence-staffing | `occurrence:X` |
| ATT-014 | assigned_coach_unavailable | Warning | – | 48h Before | Yes | schedule/occurrence-staffing | `occurrence:X\|coach:Y` |
| ATT-012 | coach_schedule_conflict | Warning | – | 48h Before | Yes | coaches/schedule-conflict | `coach:X\|occurrence:A\|occurrence:B` (A<B) |
| ATT-011 | coach_compliance_expiry | Warning (state) | – | – | Yes | coaches/compliance | `coach:X\|requirement:Y` |
| ATT-031 | non_compliant_coach_assigned | Warning (locked minimum) | – | 48h Before | No | coaches/compliance | `occurrence:X\|coach:Y` |
| ATT-042 | compliance_verification_pending | Normal (state) | – | – | No | coaches/compliance | `coach:X\|requirement:Y` |
| ATT-041 | cover_open | Normal | 48h Overdue | 24h Before | No | coaches/cover-request-date | `coverdate:X` |
| ATT-043 | coach_outcome_pending | Normal | 48h Overdue | – | No | coaches/occurrence-financial-outcome | `occurrence:X\|coach:Y` |
| ATT-044 | work_summary_queried | Normal | 3d Overdue | – | No | coaches/work-summary | `summary:X` |
| ATT-045 | work_summary_ready_to_finalise | Normal | 3d Overdue | – | No | coaches/work-summary | `summary:X` |
| ATT-046 | work_summary_blocked | Normal | 3d Overdue | – | No | coaches/work-summary | `summary:X` |

- **Severity.** ATT-011 uses state severity: Review Soon is Warning,
  Expired is Urgent. ATT-042 is always Normal.
- **Anchors.** 8 rules use a Before threshold and need an event anchor. 5
  rules (cover, outcome, the three Work Summary rules) use Overdue and need
  an outstanding-since anchor. CAT7 and CAT8 enforce both.
- **Source gating.** Every evaluator runs only when its catalogue row is
  Active and Evaluation Status is Active. It also needs a registered
  evaluator that matches the catalogue, `module_coaches` on (exactly one
  Enabled row), and effective Enabled. The first failing gate becomes the
  skip reason.
- **`venue_missing` (ATT-018)** is **Planned**. It is deferred to the
  Venue foundation, which will implement its evaluator and set it Active.
  It is skipped as `planned`. Its key, description, severity, module,
  thresholds, route and override flag are unchanged.

**Planned / deferred (24 rows, never evaluated):**

- **Schedule:** ATT-006, 017, 018 (`venue_missing`, Venue foundation).
- **Coaches:** ATT-008, 015.
- **Players & Parents:** ATT-009, 010, 019, 020, 029, 033, 035.
- **Development:** ATT-021.
- **Communications:** ATT-022, 023.
- **Finance:** ATT-024, 025, 026, 034.
- **System:** ATT-027, 032, 036, 038.
- **Safeguarding:** ATT-030 (disabled module; must stay off until a
  safeguarding source of truth exists).

The catalogue audit found **no contradiction** between the catalogue and
the evaluators. No catalogue text, severity, threshold or flag was
changed.

### NA12.2 Frozen v1 API contract

The contract is `GET /needs-attention/cases`, with engine
`needs-attention-slice-8`.

**Access.**

- Management only (active profile with role `management`). Otherwise 403.
- No token → 401.
- Unknown route → 404; wrong method → 405.

**Full view.** Always present:

- `engine`
- `organisation{organisationId,name,timezone}`
- `generatedAt`
- `complete`
- `summary{state,total,counts{Normal,Warning,Urgent},suppressed}`
- `cases[]`
- `configIssues[]`

`?debug=1` adds `diagnostics{rulesInCatalogue, evaluated[], skipped[],
sourcesLoaded[], reads{lists,pages}, suppressedCases[]}`. Diagnostics are
internal and not part of the UI contract.

**Summary view (`?view=summary`).** `engine, organisation, generatedAt,
complete, summary`. There is no case data, but it is a full evaluation,
so it costs the same reads.

**Single case (`?caseKey=…`).** `engine, organisation, generatedAt,
complete, caseKey, exists, suppressed, case|null, rule{ruleKey, ruleId,
evaluated, skipReason}, configIssues`.

- Only the configuration and that one rule's sources are read.
- A missing case returns `exists:false` with 200, not 404.

**Case object.** There are exactly 17 fields.

- Always:
  - `caseKey, ruleId, ruleKey, ruleName, category, module`
  - `severity, severityReason`
  - `title, detail`
  - `anchorTime`
  - `exceptionAllowed`
- Navigation / action: `actionLabel`, `destination{area,route,params}`.
- Identity:
  - `targetIds` holds the key subjects;
  - `relatedIds` is optional context links.
- Rule-specific: `context`, which holds scalars only.

**Ordering.** Severity descending, then catalogue Sort Order, then
`anchorTime`, then `caseKey`.

**Summary state.** Clear / Normal / Warning / Urgent (the highest
severity).

`complete:false` appears only when a source failed to load. Affected
rules then report a config issue instead of silently returning nothing.

### NA12.3 Stable identity

Case identity is organisation + rule + caseKey `ruleKey|type:id[|type:id]`.
Subjects are Airtable record ids only: never names, dates or indexes.

- **Conflict pairs** are sorted, so A/B and B/A give the same key.
- **Coach-level compliance** is keyed by requirement, not document, so
  replacing a document does not create a new case.
- **Cover** is keyed by the request-date row.
- **Work Summary** is keyed by the summary row.

The keys stay the same when titles, detail, severity or time change
(ID1–ID8). Mutations KEY1 (reversed pair order) and KEY2 (separator) are
both caught.

### NA12.4 Precedence and intentional coexistence

**Staffing.** Locked NA2.2 precedence, decided on valid staff only:

- 0 valid staff → `session_no_coach` only;
- Lead required and none present → `no_lead_coach`;
- all staff are Learning Coaches and Lead is not required →
  `learning_coach_only`;
- counting staff ≥1 but below the Required Staff Count →
  `session_understaffed`. This can coexist with `no_lead_coach`.

**Intentional coexistence.** These are separate problems with separate
actions, and are not collapsed:

- ATT-031 (non-compliant) + ATT-014 (unavailable) + ATT-012 (conflict)
  on the same coach and occurrence;
- ATT-011 (coach-level expiry) + ATT-031 (assignment-level);
- `cover_open` on a fully staffed occurrence (cover stays separate from
  staffing);
- `coach_outcome_pending` + `work_summary_blocked` (the pending outcome is
  one of the block reasons).

**Mutual exclusion.** A Work Summary raises at most one of queried, ready
or blocked. Cancelled and past occurrences never raise staffing,
availability, conflict or assignment cases. PRE1–PRE10 cover all of this.

### NA12.5 Module gating (live, 2026-09-29)

`module_coaches` (`recD6JSqZV7l7391m`) was set Enabled off in TEST, with
probe data loaded (135 open cases). Result:

- all 14 rules skipped `module_off`;
- 0 cases, state Clear;
- **only the 5 configuration tables read**, with no domain table read;
- `configIssues: []`.

The flag was switched back on and confirmed (`Enabled=true`). A missing
row or several conflicting rows also fail closed (G1–G8).

### NA12.6 Security model

- **Caller.** The caller is resolved from the Supabase JWT into
  `profiles(active, role, organisation_id)`, and must be Management.
- **Organisation.** It comes from the profile server-side. Any
  tenant-looking query parameter (`organisation`, `organisationId`,
  `org`, `tenant`, …) → 400 `tenant_param_rejected`. So does a
  tenant-looking key in an exception body. Unknown body fields → 400.
- **Exceptions and Settings** must link exactly one Organisation, and it
  must be the caller's. Anything else suppresses nothing and cannot be
  revoked (404 `exception_not_found`).

Live probes (TEST), all as expected:

| Probe | Status |
|---|---|
| coach and parent on `/cases`, `/exceptions`, `/exceptions/revoke` (6 calls) | 403 |
| `?organisationId=`, `?tenant=`, `?org=` on POST, `organisationId` in body | 400 |
| exception for a non-existent case | 404 `case_not_found` |
| revoke an unknown exception id | 404 `exception_not_found` |
| no Authorization | 401 |
| caseKey lookup for a missing case | 200 `exists:false` |

Diagnostics carry only record ids, counts and rule keys, and appear only
for Management. SEC1–SEC9 cover this offline.

**Domain-table isolation.** Today it is **per Airtable base**: one base
per organisation. Settings and Exceptions are org-scoped by link. The
Supabase migration must add explicit organisation filtering to every
repository query (see NA12.10).

### NA12.7 Exceptions (live, 2026-09-29)

The live run, on probe cases:

1. Create on `session_no_coach` → 201. The case was suppressed at once,
   with audit fields approvedBy/At and reason stored.
2. Duplicate → 409 `exception_exists`, returning the existing row.
3. `cover_open`, ATT-031, ATT-046 and ATT-042 → 403
   `override_not_supported`.
4. A second exception with `effectiveUntil` 3 minutes ahead: suppressed
   until 10:29:50Z, visible again from 10:29:54Z.
5. A temporary Settings row with Allow Override **off** on
   `session_no_coach`: both live exceptions stopped suppressing
   (`exceptionAllowed:false`, no config noise). The row was then deleted.
6. Revoke → 200, with revoked{at, by, reason} kept. The case was visible
   again at once.

Scope:

- **Exact case only:** the key must match and the Rule link must match the
  key's rule.
- There is no rule-wide, coach-wide or date-range scope.
- A current real case is required to create one.

**Frozen behaviour (minor debt).** With Allow Override off and an old
Active row still present, create returns 409 `exception_exists`, not 403.
The message says "already has an exception in force", although that row
no longer suppresses. EXC9 records this, and it is listed in NA12.13.

### NA12.8 Performance (live synthetic volume, TEST)

**Data.** 170 prefixed `NA9-PERF` rows were created:

- 12 coaches;
- 10 sessions and 56 occurrences;
- 15 Session Staff and 6 Occurrence Staff;
- 12 Coach Availability rows and 4 Availability Exceptions;
- 1 Requirement and 9 Coach Documents;
- 5 cover request-dates;
- 16 Work Summaries and 24 Allocations.

This gave **135 open cases**: all 14 rules fired, 2 Urgent, 96 Warning,
37 Normal. Every row was deleted afterwards, by id.

Latency is shown as bounds. Function-edge logs are sampled: 5 of about 40
requests were logged. The bounds use Cloudflare's arrival stamp and the
1-second `Date` header, so each is ±1 s. The logged `execution_time_ms` is
exact.

| Call | Result | Latency |
|---|---|---|
| Cold full queue (`debug`) | 200, 135 cases, 19 lists | 1.8–2.8 s |
| Warm full queue ×3 | 200 each | 2.2–3.2 / 1.2–2.2 (logged **1,645 ms**) / 1.35–2.35 s |
| Summary view ×2 | 200, 313 bytes | 0.7–1.7 / 0.83–1.83 s |
| Lookup `cover_open` | 200, 10 lists | 0.86–1.86 s |
| Lookup ATT-031 | 200, 13 lists | 1.07–2.07 s |
| Parallel burst ×5 | all 200, identical 215,007 bytes | 2.1–4.1 s each |
| Exception create | 201 | logged 1,814 ms |
| Auth rejections (403/400) | – | 0.25–1.25 s (logged 772 ms) |

- **Reads.** A full request made **19 list calls, each table exactly once,
  one page each** (every table under 100 rows).
- **Duplicate work.** Shared passes (staffing, compliance, cover, Work
  Summary, outcome) are memoised per request.
- **No per-record queries.**
- **Errors.** No 429s, no 5xx, no timeouts and no function errors,
  including the burst of 5 × 19 = 95 Airtable calls.
- **Offline.** 187 occurrences / 44 coaches → 341 cases in about 160 ms
  in memory, with every pass run once (PERF1–PERF3).

**Watchpoints (not defects; no optimisation made):**

1. **Airtable rate limit.** Each full request makes 19 Airtable calls (in
   waves of 5), and Airtable allows about 5 requests/s per base. The
   repository retries 429 with 1/2/4/8/16 s backoff. Concurrent full
   refreshes are the risk, so the UI should poll `view=summary` for the
   badge.
2. **Payload.** About 1.55 KB per case: 135 cases ≈ 210 KB.
3. **Pages.** Tables are read whole. Each table over 100 rows adds a
   page per 100.

All three are addressed by the Supabase move (indexed, filtered queries).

### NA12.9 Airtable read map

All tables are read with `list` (whole table, 100/page), once per request.

**Always read (configuration):**

| Table | Purpose | Future Supabase query |
|---|---|---|
| Needs Attention Rules | Catalogue | `na_rules` (global) |
| Needs Attention Settings | Per-org settings | `na_settings where org_id=?` |
| Needs Attention Exceptions | Per-org exceptions | `na_exceptions where org_id=? and active and not revoked` |
| Feature Controls | Module flags | `feature_controls where org_id=? and key like 'module_%'` |
| Organisation & Branding | Organisation + timezone | `organisations where id=?` |

**Read when an evaluator that needs it runs (all gated by
`module_coaches`):**

| Table | Read by | Future Supabase query |
|---|---|---|
| Session Occurrences | staffing ×4, ATT-014, ATT-012, ATT-031, cover, ATT-043, WS ×3 | `occurrences where org_id=? and start between window` |
| Sessions | same as Session Occurrences | `sessions where org_id=?` (joined) |
| Coaches | all 14 | `coaches where org_id=?` |
| Session Staff | staffing ×4, ATT-014, ATT-012, ATT-031 | `session_staff where org_id=? and date overlaps window` |
| Occurrence Staff | as Session Staff | `occurrence_staff where occurrence_id in (…)` |
| Coach Roles | as Session Staff | `coach_roles` (small) |
| Coach Availability | ATT-014 | `coach_availability where coach_id in (…)` |
| Coach Availability Exceptions | ATT-014 | `coach_availability_exceptions where date in window` |
| Coach Documents | ATT-011, ATT-042, ATT-031 | `coach_documents where org_id=?` |
| Coach Document Requirements | ATT-011, ATT-042, ATT-031 | `document_requirements where org_id=? and active` |
| Staff Availability Requests | cover_open | `cover_request_dates where org_id=? and status='Open'` |
| Cover Responses | cover_open | `cover_responses where request_date_id in (…)` |
| Coach Work Summaries | WS ×3 | `work_summaries where org_id=? and active and status<>'Finalised'` |
| Coach Allocations | ATT-043, WS ×3 | `coach_allocations where org_id=? and occurrence in window` |

A single-case lookup reads the configuration plus only that rule's
sources: cover 10 lists, staffing 11, ATT-031 13. With the module off,
only the 5 configuration tables are read.

### NA12.10 Supabase migration contract (handoff only — nothing migrated)

**Pure logic moves unchanged.** These files have no fetch, Deno or writes:

- engine: `needs-attention.ts`
- `staffing.ts`, `coach-schedule.ts`, `compliance.ts`, `cover.ts`,
  `work-summaries.ts`
- `exceptions.ts` (the validation and matching half)

**Replace.** `repository.ts` (Airtable list/create/update) becomes a
repository with the same `Reader` shape (`list`/`listMany` returning
`{id, fields, createdTime}`). The alternative is to adapt the evaluators
to typed rows, one pass at a time, with the offline tests as the oracle.

**Copied helpers.** These are kept byte-identical by drift tests and should
become shared imports when their owning functions move:

- the staffing resolver (hub-content / parent-hub copies);
- compliance status;
- cover state;
- Work Summary open-status and outcome-required logic;
- coach-availability matching.

**createdTime dependencies.** `cover_open` uses the request-date row's
Airtable `createdTime` as its outstanding-since (Warning) anchor. The new
table needs a real `created_at`. No other rule reads `createdTime`.

**Organisation scoping.**

- Today domain isolation comes from one base per organisation. Every
  migrated query **must** filter by `organisation_id`, derived from the
  caller's profile, never from the request.
- Settings and Exceptions keep their exactly-one-organisation rule.
- The case key stays organisation-free. Identity is organisation + rule +
  key.

**Locks.**

- Exception create/revoke is serialised per org + case key through the
  `needs_attention_exception_locks` RPC lock.
- A database unique partial index — (org, case_key) where active and not
  revoked — can replace it.
- Reads take no lock.

**Not done here.** No schema, table, migration or repository code was
written.

### NA12.11 Regression and mutation confidence

**Tests.**

- Full suite: **66 files, 2,135 PASS / 0 FAIL** (the 2,058 baseline + 77
  new foundation checks).
- Needs Attention alone: 8 test files, all green.

**Targeted mutations (Slice 9).** Each was applied to the test mirror,
the affected NA tests were run, and the file was restored. **12 of 12
caught:**

| Mutation | Caught by |
|---|---|
| ORG1 an exception from another org suppresses | exceptions, foundation, engine |
| ORG2 another org's Settings row applied | foundation, engine |
| GATE1 module gate ignored | all 8 NA files |
| KEY1 conflict pair order reversed | coach-schedule, engine |
| KEY2 case-key separator changed | all |
| OVR1 Settings can widen override | compliance, work-summaries, engine |
| OVR2 exceptions match with override off | exceptions, foundation, engine |
| STAFF1 no-coach also raises no-lead | staffing (22), cover, foundation, engine |
| COVER1 overdue anchored on session start | cover, engine |
| COMP1 "today" computed in UTC | compliance, engine |
| COMP2 expired on the expiry date itself | compliance, engine |
| WS1 stored Work Summary status trusted | work-summaries (6), engine |

### NA12.12 Live smoke test after cleanup (2026-09-29, v12)

| Check | Result |
|---|---|
| Needs Attention (Management) | 200, **Clear**, 14 evaluated, 19 lists, 0 config issues |
| Needs Attention as coach / parent | 403 / 403 |
| `/me` (Management, coach, parent) | 200 each |
| hub-content `/players` (coach.a) | 200, md5 `685b11e7…` (unchanged) |
| parent-hub `/me`, `/claims/pending` | 200 |
| coach-compliance `/summary?coachId=recYZyiLVud7yoNZS` | 200 |
| coach-cover `/manage` | 200 |
| coach-work-summaries `/summaries` | 200 |
| occurrence-financial-outcomes `/outcomes` | 400 without `occurrenceId` (as designed) |

Cleanup removed 170 probe rows, 2 probe exceptions and 1 temporary
Settings row. `module_coaches` was restored on. No TEST configuration was
left changed.

### NA12.13 Known future debt (carried, not fixed)

- `venue_missing` (ATT-018) is Planned. Its evaluator is deferred to the
  Venue foundation, which should set it Active only when the evaluator
  ships.
- The 409-vs-403 wording when Allow Override is off and an old Active
  exception row exists (NA12.7).
- Tables are read whole, with no per-request window filter. This is fine
  at TEST scale and is removed by the Supabase move.
- There is an Airtable 429 watchpoint for concurrent full refreshes. The UI
  should poll `view=summary`.
- The full payload is about 1.55 KB per case. A paged or filtered view can
  come with the Management UI.
- The placeholder routes need to be built by the Management UI:
  - `schedule/occurrence-staffing`
  - `coaches/schedule-conflict`
  - `coaches/cover-request-date`
  - `coaches/compliance`
  - `coaches/occurrence-financial-outcome`
  - `coaches/work-summary`
- Finalised Work Summary drift raises no case (a Finance / reopen
  question).
- Copied helpers should become shared imports once their functions move.
- Domain org-scoping is per base today. It must become an explicit filter
  in Supabase.
- Function-edge logs are sampled, so future latency work needs in-function
  timing.

### NA12.14 Version / checkpoint

| Item | Value |
|---|---|
| Branch | `foundation/test-base-isolation` |
| Code checkpoint | `3298c0c` (Slice 8). Slice 9 commit adds tests and docs only |
| Deployed TEST `needs-attention` | **v12**, byte-identical to the repo, not redeployed in Slice 9 |
| Engine string | `needs-attention-slice-8` (frozen v1 contract) |
| TEST Airtable / Supabase / org | `appQktredAuGa1X7e` / `dkqubldmfyeuudecxmvh` / `ORG-TEST-001` |
| Production | Untouched (read-only) |

**FOUNDATION COMPLETE IN TEST — READY FOR FINANCE FOUNDATION.** Finance,
Parent/Player, venue, safeguarding, notifications, the Management and
Settings UIs, the Supabase migration and production promotion were **not**
started.

### NA12.15 Catalogue status correction — `venue_missing` Active → Planned (2026-09-29)

`venue_missing` / ATT-018 (`recADoSNML2AfAPvt`) was **Active** with no
evaluator, and was skipped as `not_implemented`. That contradicts the
frozen status meaning, under which Active means a live evaluator exists.

**Change.** Its Evaluation Status was changed from Active to **Planned**
in TEST Airtable. That was the only field changed. Key, description,
severity, module, thresholds, route, override, Default Enabled and Sort
Order are unchanged. No evaluator was added. Engine and registry code are
unchanged, and `needs-attention` stays at **v12**, not redeployed.

**Repository mirrors.** These were updated to the corrected status:

- `needs-attention-catalogue.snapshot.json` and
  `needs-attention-catalogue.fixture.json`;
- the foundation test: CAT4 now requires the Active rows to be exactly the
  14 registered evaluators, CAT5 expects 24 Planned, and the new CAT13
  pins `venue_missing` as Planned and otherwise unchanged. COV2 expects
  all 24 skips to be `planned`;
- `needs-attention.test.ts` #84: 24 planned, 0 not_implemented.

**Final counts.** 38 rows: **14 Active** (all with live evaluators),
**24 Planned**, 0 Retired. There are 0 catalogue/registry mismatches.

**Live TEST, before and after.**

- Before: Clear, 14 evaluated, skipped = 23 planned + 1 not_implemented
  (`venue_missing`), 19 lists, 0 config issues.
- After: Clear, the same 14 evaluated, skipped = **24 planned**, 0
  not_implemented, 19 lists, 0 config issues.
- A `caseKey` lookup for `venue_missing` returns
  `rule.evaluated:false, skipReason:"planned"` and `exists:false`.
- No new case appeared.

**Regression.** Full suite 66/66 files, 2,136 PASS / 0 FAIL (baseline
2,135 plus CAT13).

**FOUNDATION COMPLETE IN TEST — READY FOR FINANCE FOUNDATION** still
stands. This is a consistency correction only, not production readiness.

## Finance Foundation — F1 (Finance access + core API boundary) — TEST only — 2026-09-29

This is the first Finance implementation slice. It builds only the secure
access boundary that every later Finance slice authorises through.

It creates **no Finance business records**. There are no clients, rules,
VAT, invoices, payments, costs, Stripe, Xero, Sheets, Needs Attention
evaluators or UI. Production was not touched.

### FIN1.1 Access semantics (locked)

- **Three states:** none, `view` and `manage`. Finance access is
  **separate from Management**: a Management profile with no grant has
  no Finance access.
- **Eligibility:** only an **active Management** profile may use a grant.
  Coach, Parent, pending and inactive profiles are always refused, even
  when they hold a grant row.
- **`view`** permits Finance read actions. **`manage`** permits read and
  write.
- **When a grant counts:** only when it is unrevoked **and** its
  `organisation_id` equals the caller's own profile `organisation_id`.
- **Fails closed, never guessed:** no grant, an unknown or malformed
  level, two active grants, or a grant for another organisation all
  resolve to *none*.
- **External accountant / bookkeeper access** (non-Management) is
  deferred.

### FIN1.2 Supabase storage: `public.finance_access_grants`

Migration: `finance_f1_finance_access_grants`, TEST project
`dkqubldmfyeuudecxmvh` only. This is **not** the Airtable → Supabase
migration: only access/security facts live here, which matches the
existing rule that Supabase holds identity and permissions.

| Column | Rule |
|---|---|
| `id` | uuid primary key |
| `user_id` | uuid → `auth.users(id)`, on delete cascade (same as `profiles`) |
| `organisation_id` | text, non-blank. Explicit organisation ownership (future multi-org) |
| `access_level` | text, `CHECK (access_level in ('view','manage'))`. Malformed values cannot be stored |
| `granted_at`, `granted_by`, `grant_note` | audit (who / when / why); `granted_by` is required |
| `revoked_at`, `revoked_by`, `revoke_note` | revocation audit. `revoked_at` and `revoked_by` are both set, or both empty |

- **One active grant per user and organisation.** A unique partial index
  on `(user_id, organisation_id) WHERE revoked_at IS NULL` enforces it.
- **Grants are immutable** (trigger `finance_access_grants_immutable` →
  `finance_access_grants_guard()`):
  - user, organisation, level and granted-by fields cannot be changed;
  - only the revocation fields can be set, and only once;
  - a revoked grant can never be changed or re-activated.
  - To change a level: revoke the old grant and insert a new one. The full
    history stays in the table.
- **Security pattern** (same as the lock tables):
  - RLS is on, with **no policies** and **no anon/authenticated grants**,
    so only the service role can read it.
  - The `finance` function reads it server-side, filtered only by the
    authenticated caller's user id (checked to be a UUID first).
  - The expected advisor note is `rls_enabled_no_policy` (INFO), the same
    as for every lock table.
- **Why a table, not a `profiles` column:** it gives audit history
  (who/when, revocations), explicit per-organisation ownership, and
  immutable rows. `profiles` itself is unchanged.
- **Assigning access:** for now this is done by SQL with the service
  role. A Management-facing grant UI or API is deferred.

### FIN1.3 Organisation and module rules

- **Organisation.** It is **always** the caller's Supabase
  `profiles.organisation_id`. It must match exactly one Active
  "Organisation & Branding" row, using the same `resolveOrganisation()`
  as Needs Attention (copied, and drift-checked byte-identical).
- **Tenant selectors are refused, never ignored.** Any query parameter or
  body key that could select an organisation, tenant or Airtable base
  returns 400 `tenant_param_rejected`:
  - `organisation*`, `organization*`, `org*`, `tenant*`, `base*`,
    `airtableBase*`, compared case-insensitively.
  - F1 routes also accept no other query parameters or body fields
    (400 `unexpected_parameter` / `unexpected_field`).
- **Module.** The existing Feature Controls key `module_finance`, read
  with the same `moduleState()` as Needs Attention. Missing, disabled or
  conflicting → Finance fails closed for every caller, read and write.
  There is no second toggle.
- **Isolation today is per Airtable base**, as for the rest of TEST. The
  Feature Controls and Organisation rows are the base's own. The grant's
  `organisation_id` gives the organisation boundary that the Supabase move
  will rely on.

### FIN1.4 API contract — TEST Edge Function `finance`

**Code layout** (`supabase/functions-test/finance/`):
- `finance-access.ts`: pure policy.
- `repository.ts`: read-only; Airtable config and the grant store.
- `orchestrator.ts`: `authorizeFinance()`.
- `index.ts`: HTTP wrapper and production boot guards.

Deployed **v1**, `verify_jwt: true`.

**Routes:**

| Route | Requirement | 200 body |
|---|---|---|
| `GET /finance/access` | Finance read | `{contract:"finance-access-v1", organisation:{organisationId,name}, module:{key:"module_finance",enabled:true}, access:"view"\|"manage", capabilities:{read,manage}}` |
| `POST /finance/write-check` | Finance manage | `{contract:"finance-access-v1", action:"manage", authorized:true, persisted:false}` |

`write-check` is an authorisation probe only. It writes nothing anywhere.
Later Finance write routes will call the same `authorizeFinance(…,
"manage")`.

**Decision order** (the first failure wins):

| Step | Check | On failure |
|---|---|---|
| 1 | Route and method | 404 / 405 |
| 2 | Authentication | 401 (the gateway rejects invalid JWTs first) |
| 3 | Active Management profile | 403 `management_required` |
| 4 | Tenant or unexpected query/body keys | 400 |
| 5 | Valid grant for the caller's own organisation | 403 `finance_access_denied` |
| 6 | Organisation resolves | 409 `organisation_not_found` / `organisation_ambiguous` |
| 7 | `module_finance` enabled | 403 `finance_module_disabled` |
| 8 | Requirement met | 403 `finance_manage_required` |

- A grant-store or Airtable read failure returns 503
  (`finance_access_unavailable` / `finance_config_unavailable`). It never
  assumes access.
- A 500 returns only `"Unexpected error"`, with no internals.
- **What is never exposed:** user ids, grant rows, who granted, the
  service key, Airtable record or base ids, timezone, or any other
  organisation.
- **Production boot guards:** the function refuses to start if
  `AIRTABLE_BASE_ID` is a production base (`apprptFotQuVL1mhs`,
  `app6ex6UHY2RRO2Ak`), or if `SUPABASE_URL` is the production project
  (`bkkukymqaxawnudoxdjs`).

### FIN1.5 Live TEST verification (2026-09-29, `finance` v1)

**Identities:**
- `manager@test.invalid` (Management, ORG-TEST-001). It is the only TEST
  Management identity, so its grants were cycled.
- `coach.a@test.invalid`.
- `parent.a@test.invalid`.

| # | Case | Result |
|---|---|---|
| 1 | No auth / invalid JWT | 401 / 401 |
| 2 | Management, no grant (read and write) | 403 `finance_access_denied` |
| 3 | Coach / Parent | 403 `management_required` |
| 4 | Management + View, **module off** | 403 `finance_module_disabled` |
| 5 | Management + View, module on | GET 200 `access:"view"`, read true / manage false. POST write-check 403 `finance_manage_required` |
| 6 | Management + Manage | GET 200 `access:"manage"`, read and manage true. POST 200 `authorized:true, persisted:false` |
| 7 | Coach **holding** a Manage grant | GET and POST 403 `management_required` |
| 8 | `?organisationId=ORG-TEST-999`, `?tenant=`, `?baseId=apprptFotQuVL1mhs`, body `organisation_id`, body `airtableBaseId` | 400 `tenant_param_rejected` (all five) |
| 9 | `?debug=1` / body `{"amount":1}` | 400 `unexpected_parameter` / `unexpected_field` |
| 10 | Wrong method / unknown route | 405 / 404 |
| 11 | Manage grants for ORG-TEST-001 **and** ORG-TEST-999 | 200; the response is still ORG-TEST-001 (no switching) |
| 12 | Only the ORG-TEST-999 grant active | 403 `finance_access_denied` (another organisation's grant gives nothing) |
| 13 | Database: duplicate active grant / level `admin` / edit level in place / un-revoke | rejected (unique index / CHECK / immutability trigger ×2) |
| 14 | Manage, module **off** | GET and POST 403 `finance_module_disabled` |
| 15 | Module restored on | GET 200 `manage`, POST 200 |
| 16 | Needs Attention after `module_finance` on | Clear, 14 evaluated, 24 planned, 0 config issues (unchanged) |

**Resting state, deliberately restored:**
- **`module_finance` is Enabled in TEST.** Before F1 it was disabled
  ("NOT live in TEST"). It is now the switch for the TEST Finance API.
  Its Feature Controls description was updated to say so. The Planned
  finance Needs Attention rules still do not evaluate.
- **`finance_access_grants`:** exactly one active grant, the
  `manager@test.invalid` / ORG-TEST-001 / `manage` TEST baseline. It was
  granted by "F1 live verification".
- The four probe grants stay as **revoked** history, with reasons:
  - the View grant (moved to Manage);
  - the first Manage grant (revoked for the cross-organisation proof);
  - the ORG-TEST-999 grant;
  - the Coach grant.
- No profile was changed, and no other Airtable row was touched.

### FIN1.6 Tests and regression

- **`tests/support/finance-access.test.ts`: 56 checks.** Sections:
  - A: policy.
  - T: tenant and request shape.
  - O: organisation and module.
  - R: orchestrator over a mocked grant store and Airtable.
  - C: response contract, no leaks.
  - Z: drift and code checks. Support copies are byte-identical to the
    canonical files, `resolveOrganisation`/`moduleState` are identical to
    Needs Attention's, and the checks also cover read-only repository, the
    production guards, only two routes, and no Josh Evans naming.
- Test shim: `tests/e2e/financeaccesstest.js`.
- Support copies: `finance-access.ts`, `finance-repository.ts`,
  `finance-orchestrator.ts`.
- **Mutation check:** 10 of 10 security mutations were caught:
  - revoked grants counted;
  - organisation filter removed;
  - View can manage;
  - ambiguous grants allowed;
  - inactive profile allowed;
  - any role allowed;
  - module gate removed;
  - query tenant check removed;
  - grant user filter removed;
  - malformed level accepted.
- No shared helper was modified; Needs Attention code is unchanged.
- **Full suite:** `npm test` gives **67/67 files, 2,192 PASS / 0 FAIL**
  (the 2,136 baseline plus 56 new F1 checks).

### FIN1.7 Deferred (later Finance slices)

- **A Management-facing grant UI/API.** Today grants are assigned by
  service-role SQL. Assigning access will need its own Finance Manage
  (or admin) control and audit.
- **Finance audit events for Finance actions** (F2). The grant table
  audits access changes only.
- **Non-Management Finance users** (external accountant/bookkeeper).
- **Moving `module_finance` / organisation config to Supabase** with the
  platform organisation layer. Isolation is per base until then.
- **A TEST-facing frontend.** There is no Finance UI.

## Finance Foundation — F2 (Finance Settings + money/VAT kernel + Finance audit trail) — TEST only — 2026-09-29

F2 adds three things, all TEST only:
- organisation **Finance Settings**, read and managed through the existing
  `finance` function;
- a pure **money / VAT / effective-dating kernel** for later slices;
- an **append-only Finance audit trail**, written for every Finance
  Settings change.

F2 creates no clients, services, billing rules, invoices, payments, credits,
Coach Cost reporting, suppliers, cash-flow or month records, no Stripe, Xero or
Sheets integration, no Finance UI, and no Needs Attention evaluators.
**Production was not touched.**

### FIN2.1 Pre-implementation audit (findings)

- **Git:** branch `foundation/test-base-isolation`, HEAD `22eabc4` equal to
  origin, clean tree.
- **F1 (`finance` v1):** `authorizeFinance()` is reused unchanged. F1
  `finance-access.ts`, `orchestrator.ts` and `repository.ts` are
  byte-unchanged; `repository.ts` stays read-only.
- **Organisation & Branding** already owns the Organisation Name, Hub Name,
  Logo, Website, Support Email and Timezone. F2 therefore stores only
  Finance-specific identity (legal name, invoice address, company number) and
  duplicates none of these.
- **Feature Controls:** `module_finance` is Enabled (F1 baseline).
- **Existing tables:** TEST had no Finance or settings table apart from Hub
  Settings (generic key rows) and Needs Attention Settings.
- **Production (read only):** no Finance Settings scaffold exists. It has
  `Billing Rules` (a later slice) and `Hub Audit Events` / `Restricted Audit
  Details`, a family and booking oriented audit with record links. Neither was
  copied; F2 is Finance-scoped and organisation-keyed.
- **History patterns:** Session History and Work Summary History are Airtable
  rows that can be edited. The Needs Attention exception audit never edits the
  approval snapshot. Airtable cannot enforce append-only, so the Finance audit
  lives in Supabase with trigger-enforced immutability.
- **Money today:** Coach Allocations and Occurrence Financial Outcomes use
  float pounds with `roundCurrency()` (`Math.round((n+ε)*100)/100`). They are
  not refactored in F2 (see FIN2.9).
- **Effective dating today:** `coach-rates.ts` `rateProfileAppliesOnDate`
  uses an inclusive From/Until and reports two matches as ambiguous. F2's
  helper keeps that rule and makes it generic. `coach-rates.ts` is untouched.

### FIN2.2 Finance Settings: ownership, storage, fields

**Storage.** A new TEST Airtable table, **`Finance Settings`**
(`tblbQDDt3cgQmfCwB`), is transitional operational storage. It is not in
production, Google Sheets or `config.js`.
- **Ownership:** one row per organisation, owned through its `Organisation`
  link to exactly one Organisation & Branding row.
- The row id `FINSET-<Organisation ID>` is only a label.
- Zero rows means "not configured", which is a normal state. Two or more rows,
  or a row linked to more than one organisation, fails closed with 409.
- Airtable added the reverse link field on Organisation & Branding. It is
  additive, and `resolveOrganisation` ignores it.

**Fields.** Settings use the API names below. The stored Airtable field is in
brackets.

| Field | Rule |
|---|---|
| `invoiceLegalName` (Invoice Legal Name) | text ≤ 200. Required |
| `invoiceAddress` (Invoice Address) | multiline ≤ 500 chars, ≤ 8 lines. Required |
| `companyNumber` (Company Number) | optional, letters/digits/space/hyphen ≤ 20 |
| `vatRegistered` (VAT Registration: Registered / Not registered) | true / false. Required |
| `vatNumber` (VAT Number) | letters/digits/space ≤ 20. Required when registered; must be empty when not |
| `defaultVatRateBasisPoints` (Default VAT Rate (Basis Points)) | integer 0–10000 (2000 = 20%). Required when registered; empty when not. **No rate is ever assumed** |
| `defaultVatTreatment` (Default VAT Treatment: Plus VAT / VAT Included / No VAT) | `plus_vat` \| `vat_included` \| `no_vat`. Required when registered. When not registered it must be empty or `no_vat` (the effective default is then `no_vat`). It is the organisation **default only**; per-service treatment arrives in F3 |
| `defaultPaymentTermsDays` (Default Payment Terms (Days)) | integer 0–365. Required |
| `coachPaymentDayOfFollowingMonth` (Coach Payment Day) | integer **1–31** (corrected; see FIN2.11): coaches are paid on day N of the month after the work. In a shorter month the date resolves to that month's last day (`resolveCoachPaymentDate`). The stored day never changes. 0, negatives, >31 and non-integers are refused. There is no bundling (F12). Required |

**Meta fields.** `Revision`, `Last Changed By User ID` and `Last Changed At`
are written by the API only.

**Stored values are validated on every read** with the same validators as
input. An unknown select label, a fractional rate, day 32 or 7.5, or a cross-field
contradiction makes the row 409 `finance_settings_invalid`, naming the
field. It is never treated as blank.

**Known limit.** A person with TEST Airtable access can still edit the row
directly, bypassing the API and its audit. The table description says so. The
fix is moving Settings to Supabase with the platform organisation layer.

### FIN2.3 Completeness

`completeness = { complete, requiredTotal, requiredComplete, missing[] }`.

- **Required:** legal name, invoice address, VAT registration state, payment
  terms and coach payment day. If VAT registered, also the VAT number, default
  rate and default treatment. So the total is 5 when not registered and 8 when
  registered.
- `complete` also requires the cross-field rules to hold.
- Optional items (company number) and integrations (Stripe/Xero/Sheets) never
  reduce completeness. No credentials are stored.
- `effectiveDefaultVat(settings)`, exported for F3, returns:
  - `{no_vat, 0}` when not registered;
  - the configured treatment and rate when registered;
  - `null` while unknown. It never guesses a rate.

### FIN2.4 Money, VAT and rounding (`finance-money.ts`, pure)

**Money.**
- Integer **minor units** (pence), GBP.
- Decimal input is parsed **only from strings** (`"12.34"`, at most 2 dp; no
  numbers, commas, symbols or exponents).
- Bounded at ±£1,000,000,000.00, so every product stays exact.
- `formatMinor`, `sumMinor` and `isMinor` throw or refuse on fractional values.

**Rates** are integer basis points. `parseRatePercent("17.5")` gives 1750.

**VAT** (`calculateVat({amountMinor, treatment, rateBasisPoints})`):

| Treatment | Input | VAT | Other figure |
|---|---|---|---|
| `plus_vat` | net | round(net × r / 10000) | gross = net + VAT |
| `vat_included` | gross | round(gross × r / (10000 + r)) | net = gross − VAT |
| `no_vat` | amount | 0 | net = gross = amount; a non-zero rate is refused (`rate_with_no_vat`) |

- **The one rounding rule:** round half away from zero, to the penny, applied
  once, to the VAT figure only. It is computed with BigInt, so there are no
  floats.
- Net and gross are then integer arithmetic, so **gross = net + VAT exactly,
  always**. This is tested over 7 rates × 472 amounts × 2 treatments.
- Negative amounts (future credits) mirror positive ones.
- Plus/included without a rate fails; it never defaults to 20%.
- The kernel is not exposed over HTTP: there is no debug or VAT endpoint.

### FIN2.5 Effective-date contract (`finance-effective-dating.ts`, pure)

- `resolveEffective(entries, date)` works on `YYYY-MM-DD` real calendar dates.
- `effectiveFrom` is required and inclusive. `effectiveUntil` is optional and
  inclusive (open-ended when absent). An until before its from is invalid.
- Results:
  - exactly one match → `resolved`;
  - none → `none` (no nearest or fallback guess);
  - more than one → `ambiguous` with all matches. It **never picks the newest.**
  - any malformed entry or query date → `invalid` for the whole set. A broken
    row is never skipped.
- `findOverlaps(entries)` lets write paths reject overlapping sets before
  storing them.
- This is a library for F3 onwards. Nothing in the deployed function imports it
  yet, so the bundler omits it from the `finance` deployment.

### FIN2.6 Finance audit contract (Supabase `public.finance_audit_events`)

**Migration** `finance_f2_audit_events_and_settings_lock`:

- **Columns:**
  - `id` uuid;
  - `organisation_id`;
  - `actor_user_id` (no FK, so the audit survives user deletion);
  - `event_type` (`domain.action`);
  - `entity_type`;
  - `record_id`;
  - `occurred_at`;
  - `before` / `after` jsonb objects (at least one present);
  - `reason` (≤ 500);
  - `context` jsonb.
- **Immutable:**
  - a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement
    trigger raise `42501 … append-only`;
  - `occurred_at` is forced to the database clock on insert, so it cannot be
    backdated;
  - live proof: UPDATE, DELETE and TRUNCATE were all refused.
- **Access:**
  - RLS is on, with no policies, and everything is revoked from
    anon/authenticated. Only the service role can write it.
  - Live: anon REST read → 401; Manager-JWT REST read and insert → 403.
  - It is never returned by the API (audit internals are not exposed).
- **Settings events:**
  - `finance_settings.created` (before `null`) or `finance_settings.updated`;
  - entity `finance_settings`; `record_id` is the Airtable row id;
  - before/after = `{revision, settings}`;
  - context = `{source:"finance-api", route:"POST /settings", contract, changedFields[]}`;
  - reason is the caller's optional `reason`.
- **Exactly one event per effective write.** Reads, no-op updates and rejected
  updates write none.
- **Write order:**
  1. The Airtable write happens first.
  2. The audit insert follows.
  3. If the audit insert fails, the Airtable change is **undone**: the patch is
     reverted to the before values and revision, or a newly created row is
     deleted. The caller gets 503 `finance_audit_unavailable`.
  4. If the undo also fails, the caller gets 500 `finance_settings_unaudited`
     and a loud log line. It is never reported as success.
- **Concurrency:** `finance_settings_locks` plus the
  `acquire/release_finance_settings_lock` RPCs (the same shape as the Needs
  Attention exception locks; service_role EXECUTE only; 5-minute stale expiry)
  serialise writes per organisation. A second concurrent write gets 409
  `finance_settings_busy`, proven live.

### FIN2.7 API — TEST Edge Function `finance` v3 (`verify_jwt: true`)

**Deployments:**
- v2 was deployed with `PATCH /settings`.
- **v3 is current.** The update moved to `POST /settings` because `pg_net`
  (the only live HTTP path from this environment) supports only
  GET/POST/DELETE. The semantics are unchanged: a partial update.
- v3 was byte-verified by read-back: 8/8 bundled files are identical to the
  repo.

| Route | Requirement | Result |
|---|---|---|
| `GET /access`, `POST /write-check` | unchanged (F1) | unchanged |
| `GET /settings` | Finance read (View or Manage) | `{contract:"finance-settings-v1", organisation:{organisationId,name}, access, configured, revision, updatedAt, settings:{9 fields}, completeness}` |
| `POST /settings` | Finance manage | body `{settings:{…fields to change}, reason?}` → the same body plus `changed:true\|false` |

- **Order:** 404/405 → 401 → 403 `management_required` → query check (400) →
  body parse (400) → `authorizeFinance` (403/409/503) → lock (409/503) → load
  (409/503) → cross-field (400) → write → audit.
- **Rejected with 400:**
  - `tenant_param_rejected`: tenant keys at the top level, inside `settings`,
    or in the query;
  - `unexpected_field`: unknown or dangerous keys (`revision`, `recordId`,
    `__proto__`, credentials…);
  - `invalid_settings`: any invalid value; all field errors are returned
    together and nothing is written;
  - `invalid_body`: an empty `settings` object.
- **GET distinguishes three states:**
  - not configured → 200 `configured:false`;
  - stored data invalid or ambiguous → 409;
  - store unavailable → 503.
- **Never returned:** Airtable record or base ids, user ids, the actor, audit
  rows or ids, grant rows, or service keys.

### FIN2.8 Live TEST verification (2026-09-29, `finance` v3, real HTTP via `pg_net`)

Fresh JWTs for `manager@test.invalid`, `coach.a@test.invalid` and
`parent.a@test.invalid` (TEST-only passwords reset with the established
`crypt()` pattern).

| # | Case | Result |
|---|---|---|
| 1 | Manage, GET before any config | 200 `configured:false`, revision 0, 0/5 |
| 2 | Manage, first valid POST (legal name, address, terms 30) | 200 `changed:true`, rev 1, 3/5. Exactly 1 `finance_settings.created` event (org, actor, before null, after, reason, changed fields); lock released |
| 3 | F1 `GET /access` / `POST /write-check` | 200 / 200 (unchanged) |
| 4 | Cross-field invalid (not registered + VAT number + day 7) | 400 `invalid_settings` {vatNumber}. Airtable row unchanged (no day 7 written); audit count still 1 |
| 5 | Invalid values (day 31, rate 20.5) / unknown `revision` | 400 `invalid_settings` (both fields) / 400 `unexpected_field`. At the time day 31 was outside the old 1–28 range; it is now valid (FIN2.11), and 32 is the rejected case |
| 6 | Tenant: `?organisationId=`, body `organisationId`, `settings.baseId` | 400 `tenant_param_rejected` ×3 |
| 7 | No-op update (same values, padded text) | 200 `changed:false`, rev 1, no event |
| 8 | Two simultaneous updates | one 200 (rev 2, 1 event), one 409 `finance_settings_busy`; no lock left |
| 9 | **View** grant: GET / POST | 200 `access:"view"` / 403 `finance_manage_required` (no event) |
| 10 | **No grant**: GET / POST | 403 `finance_access_denied` ×2 |
| 11 | Coach / Parent: GET / POST | 403 `management_required` ×4 |
| 12 | No auth / DELETE method | 401 / 405 |
| 13 | **Module off**: GET / POST | 403 `finance_module_disabled` ×2; module restored ON |
| 14 | Baseline write (Manage) | 200 rev 3, **complete 8/8** |
| 15 | Audit immutability (SQL UPDATE / DELETE / TRUNCATE) | all refused `42501 append-only` |
| 16 | Audit/lock via client roles (anon read, Manager read/insert, Manager lock RPC) | 401 / 403 / 403 / 403 |
| 17 | Needs Attention after F2 | 200, Clear, 0 cases, `complete:true` (unchanged) |

VAT and money are proven by the unit tests (FIN2.9), not over HTTP.

**Resting baseline (deliberate):**
- `module_finance` is **Enabled**.
- `finance_access_grants`: exactly one active grant, `manager@test.invalid` /
  ORG-TEST-001 / **manage** (re-granted by "F2 live verification").
- The F2 proofs left two more revoked rows as history: the F1 baseline manage
  grant (revoked for the View proof) and the F2 View probe.
- **Finance Settings for ORG-TEST-001** (`FINSET-ORG-TEST-001`, revision 3,
  complete 8/8):

  | Setting | Value |
  |---|---|
  | Legal name | "Test Coaching Organisation Ltd (TEST)" |
  | Invoice address | "1 Test Street / Test Town / TE1 1ST" |
  | Company number | none |
  | VAT | Registered, VAT number `GBTEST000000`, default rate 2000 bp, default treatment `vat_included` |
  | Payment terms | 30 days |
  | Coach payment day | **7** |

  These are **TEST placeholders chosen for F3**, not real organisation data
  and not product decisions.
- **Audit trail:** 3 events (created rev 1; updated rev 2, the concurrency
  probe; updated rev 3, the baseline).
- The temporary `f2probe` SQL helper schema was dropped. No probe grants or
  settings remain active.

### FIN2.9 Tests and regression

- **`tests/support/finance-kernel.test.ts`: 47 checks.**
  - M, money: parsing, bounds, formatting, sums, round-trip.
  - V, VAT: all treatments, custom rates, half rounding, zero amount, zero
    rate, negatives, reconciliation sweep, invalid input, no assumed rate.
  - E, effective dating: before first, exact from, between, exact until,
    after end, open end, gap, overlap → ambiguous, malformed, leap years.
- **`tests/support/finance-settings.test.ts`: 80 checks.**
  - S: domain and completeness.
  - P: body parsing, including `__proto__`.
  - G: GET access matrix, missing/invalid/ambiguous/unavailable, isolation,
    reads write nothing.
  - U: update: one write plus one event, before/after, no-op, cross-field,
    lock busy/error, write failure, audit failure with undo for patch and
    create, undo failure, invalid stored state, isolation, Coach.
  - C: contract, no leaks.
  - Z: drift and code checks: support copies identical; pure files are pure;
    no hard-coded rate; no float rounding; the audit table is insert-only in
    code; no client timestamp; routes; F1 files untouched; no Josh Evans /
    Stripe / Xero / credentials.
- **F1 test Z8** was updated to the new ROUTES shape: F1 routes unchanged,
  plus `settings` GET/POST. F1 is still **56/56**.
- **Shims:** `tests/e2e/financekerneltest.js`, `tests/e2e/financesettingstest.js`.
- **Support copies:** `finance-money.ts`, `finance-effective-dating.ts`,
  `finance-settings.ts`, `finance-settings-repository.ts`,
  `finance-settings-orchestrator.ts`.
- **Mutation check: 18/18 caught** by behavioural checks (drift checks
  excluded):
  - half-down rounding;
  - included-VAT formula;
  - numbers accepted as money;
  - no_vat ignoring a rate;
  - overlap picking the first match;
  - exclusive until;
  - malformed entries skipped;
  - cross-field rule off;
  - VAT detail not required;
  - unknown fields accepted;
  - malformed stored value read as blank;
  - no-op writing;
  - created row not undone;
  - View can update;
  - lock never released;
  - busy lock ignored;
  - rows not filtered by organisation;
  - audit skipped.
- **Full suite (final code, `finance` v3):** `npm test` gives **69/69 files, 2,319 PASS / 0 FAIL**. That is the 2,192 F1 baseline plus 47 kernel checks plus 80 Settings checks.

### FIN2.10 Deferred (later Finance slices)

- **Per-service VAT treatment, clients, services and billing rules (F3).**
  They will use `calculateVat`, `effectiveDefaultVat` and `resolveEffective`.
- **Invoice-facing identity beyond F2:** invoice/accounts email (Organisation
  & Branding's Support Email is not duplicated), bank/remittance details,
  invoice numbering. These belong to the invoicing slice.
- **Coach payment bundling (F12).** F2 stores only the day.
- **A Finance audit read API/UI** (who changed what). Nothing reads the audit
  over HTTP today.
- **Moving Finance Settings from Airtable to Supabase.** Until then, direct
  Airtable edits bypass the audit (FIN2.2).
- **Migrating Coach Allocations / Occurrence Financial Outcomes off float
  `roundCurrency`** to integer pence, and `coach-rates.ts` to the shared
  effective-dating helper. Neither was broadly refactored in F2.
- **Optimistic concurrency** (client-sent `revision`) for the future UI. The
  server lock prevents lost updates between concurrent writes, but not stale
  forms.

### FIN2.11 Correction: Coach payment day 1–31 (2026-09-29, `finance` v4)

**Product decision.** The Coach payment day supports **1–31**. When the
configured day does not exist in a month, the payment falls on that month's
**last valid calendar day**. The 1–28 limit in the original F2 was never a
locked decision.

**Exact change.** Only these parts of F2 changed:

- **`finance-settings.ts`:**
  - `COACH_PAYMENT_DAY_MIN = 1` and `COACH_PAYMENT_DAY_MAX = 31`;
  - the field validator now accepts 1–31 and still refuses 0, negatives, >31,
    non-integers, strings, booleans, arrays and objects;
  - stored values are validated the same way on read, so a stored 32 or 7.5
    returns 409.
- **New pure helper `resolveCoachPaymentDate(configuredDay, year, month)`:**
  - returns `{ok, day, date:"YYYY-MM-DD"}`, where `day = min(configuredDay,
    daysInMonth(year, month))`;
  - `daysInMonth` uses normal Gregorian month lengths and leap years
    (`setUTCFullYear(year, month, 0)`); no month is hard-coded, and it avoids
    `Date.UTC` treating years 0–99 as 1900s;
  - an invalid day, month (outside 1–12) or year (outside 1–9999) is refused;
  - it is pure, so the stored configured day is never altered. A stored 31 stays
    31 and resolves to 28 or 29 in February and 30 in April, June, September
    and November.
  - Choosing the target month ("the month after the work") and any bundling
    belong to the caller (F12).
- **Airtable field description:** the `Coach Payment Day` description (TEST)
  now says 1–31 with the last-day fallback.
- **Unchanged:** Settings shape, API, audit, lock, completeness and all other
  validation.

**Tests (`tests/support/finance-settings.test.ts`, 80 → 92 checks).**
- New section D (12 checks):
  - day 1; day 7 in every month of 2026 and 2028; day 28;
  - 29, 30 and 31 against February in non-leap and leap years;
  - 30-day months with 31; 31-day months with 31;
  - the century rule (1900/2100/100 not leap, 2000/4 leap);
  - invalid day (0 / −1 / 32 / 7.5 / NaN / "7" / null);
  - invalid month and year;
  - the stored day is unchanged after resolution.
- P9 is rewritten: 1, 7, 28, 29, 30 and 31 are accepted; 0, −1, 32, 7.5, "7",
  true, [7] and {} are refused. P8, S13 and U19 now use 32 or 7.5 as the invalid
  day.
- **Mutations:** 6/6 new mutations caught:
  - range back to 28;
  - 32 accepted;
  - no short-month fallback;
  - hard-coded 28-day February;
  - naive leap rule;
  - fractional day accepted by the helper.
- The original 18 F2 mutations are still 18/18.
- The kernel (47) and F1 (56) checks are unchanged.
- **Full suite:** `npm test` gives **69/69 files, 2,331 PASS / 0 FAIL** (2,319 + 12).

**Deploy.** `finance` v4 was byte-verified by read-back: 8/8 bundled files are
identical to the repo.

**Live verification (v4, real HTTP via `pg_net`, `manager@test.invalid`
Manage).**

| Case | Result |
|---|---|
| day 32 | 400 `invalid_settings` "must be between 1 and 31" (no write, no event) |
| day 7.5 | 400 `invalid_settings` "must be a whole number or null" |
| day 29 | 200, rev 4 |
| day 30 | 200, rev 5 |
| day 31 | 200, rev 6 |
| restore day 7 | 200, rev 7, complete 8/8 |

- Each accepted change wrote exactly one `finance_settings.updated` event, with
  the correct before and after day.
- No lock was left, and the temporary `f2probe` helper schema was dropped.

**Resting baseline.**
- Finance Settings are unchanged except for the revision, which is now **7**.
- The Coach payment day is back at **7**.
- The audit trail has 7 events. The four new ones (revs 4–7) are the probe and
  its restore. The table is append-only, so they are permanent history.
- The grants and `module_finance` are unchanged.

## Finance Foundation — F3 (Clients, Client Services, effective-dated commercial terms) — TEST only — 2026-09-29

**Scope.** F3 adds the Finance-owned commercial setup:
- **Clients:** the external customers or payers, such as a school.
- **Client Services:** what is delivered to a client.
- **Commercial terms:** effective-dated terms per service.

The work is only in the TEST repo, TEST Airtable (`appQktredAuGa1X7e`) and TEST
Supabase (`dkqubldmfyeuudecxmvh`). Production Airtable, production Supabase,
Sessions data, Google Sheets, Stripe, Xero and legacy Financials were not
touched.

F3 does **not** resolve billing per occurrence, and it creates no invoices,
payments, credits, Coach costs, cash flow or Needs Attention rules. Nothing in
F3 is Actual Revenue.

### FIN3.1 Pre-implementation audit (read-only findings)

- **Production `Clients & Schools` and `Billing Rules` are empty.** Nothing
  needs migrating.
  - `Billing Rules` does not fit the locked model: it links straight to
    Sessions/PSLs, uses a float currency, and has no VAT, quantity or service
    layer.
  - It is **not** reused.
- **Production Sessions have commercial fields:** Commercial Model (Parent
  Bookable / School-Client Contract / Internal), Billing Model (7 options),
  Finance Key, and Client/Organisation and Billing Rules links.
  - Production PSLs hold commercial snapshots.
  - What We Offer has Price, Billing Period and Price Note.
  - In TEST only 2 Sessions carry a value (Commercial Model = Parent Bookable).
- **No code reads the Session commercial fields.** The only "Client / School"
  reference in code is compliance scoping.
- **Decision:** F3 creates new TEST-only "Finance …" tables, named so that a
  Client can never be confused with the platform tenant (`organisation_id`).
  The existing Session fields are left alone and marked transitional
  (FIN3.7).

### FIN3.2 Models (domain: `finance-commercial.ts`, pure)

**Client** (`clientId` = `FCL-` + 12 upper-case hex)
- **Fields:**
  - `name`;
  - `status`: `active` / `inactive`;
  - `billingContactName`;
  - `billingEmail`, stored lower-case;
  - `billingCcEmails`: at most 5, de-duplicated;
  - `paymentTermsDaysOverride`: 0–365, or null to use the Settings default;
  - `poRequired`;
  - `revision`, `updatedAt`.
- A Client is **not** the tenant. The tenant always comes from the caller's
  profile.
- **Rules:**
  - Names are unique per organisation (case-insensitive, trimmed). A clash
    returns 409 `duplicate_client_name`.
  - An inactive client stays readable, but cannot take new services (409
    `client_inactive`).

**Client Service** (`serviceId` = `FSV-…`)
- **Fields:** `clientId`, `name`, `status`, `revision`, `updatedAt`.
- **Lifecycle:** `active` ⇄ `paused` → `ended`.
  - **Ended is terminal and frozen.** Reopening, renaming or changing the terms
    returns 409 `service_ended`.
  - An ended service stays readable, with its full history.
- Names are unique within a client (409 `duplicate_service_name`).

**Commercial terms** (`termsId` = `FCT-…`): one effective-dated segment per
row.

| Field | Values / rule |
|---|---|
| `payer` | `client` ("Client / school pays") or `parent` ("Parents pay") |
| `chargeType` | `fixed_per_session` ("Fixed amount per session"), `per_player`, `subscription`, `other` |
| `amount` | Decimal **string** in, integer **pence** stored (F2 `parseMoney`); 0 to £100,000 per unit |
| `vatTreatment` / `vatRatePercent` | F2 treatments `plus_vat` / `vat_included` / `no_vat`; rate stored as basis points; `no_vat` ⇒ rate 0 |
| `defaultBillableQuantity` | **Required for `per_player`**, 0–10,000. Refused for the other types |
| `subscriptionFrequency` | `weekly` / `monthly` / `termly`. Required for `subscription`, refused otherwise |
| `otherDescription` | ≤100 chars. Required for `other` (e.g. "per term fee"), refused otherwise |
| `effectiveFrom` / `effectiveUntil` | Inclusive real dates. `until` null = open-ended |

**VAT use.**
- An explicit value in the request wins. On a change, the previous terms are
  used next. Only then does the Finance Settings default apply
  (`effectiveDefaultVat`).
- The Settings default is a **pre-fill only**: the resolved treatment and rate
  are **stored on the terms row**. A later change to Settings never re-prices
  existing terms.
- No rate is ever assumed. If there is no default and no explicit VAT, the
  request is 400.
- An organisation recorded as **not VAT registered** can only use `no_vat`.
- All VAT figures come from the F2 kernel (`calculateVat`). F3 has no VAT maths
  of its own (drift check Z4).

**Default billable quantity** is part of the terms segment, so it is
effective-dated. Changing 18 → 20 from a date keeps 18 before that date (test
ED7). If a change moves a service away from `per_player`, the inherited
quantity is dropped. An explicit quantity on a non-per-player type is refused.

### FIN3.3 Effective dating and history protection

- Uses F2's `resolveEffective` / `findOverlaps` / `entryError`. F3 has no
  resolver of its own.
- **A change applies from a date onward.** `POST
  /services/{id}/commercial/changes {effectiveFrom, changes, reason}`:
  - sets the current open segment's `Effective Until` to `effectiveFrom − 1
    day`;
  - opens a new segment from `effectiveFrom`, with the changed fields merged on
    top of the current terms.
- **History is never rewritten:**
  - `effectiveFrom` must be **today or later**, with today taken in the
    organisation's timezone (`Europe/London`). Otherwise 409
    `backdated_change_not_allowed`.
  - It must also be **after** the current segment's start. Otherwise 409
    `change_overlaps_current_terms`.
  - The only edit ever made to an existing terms row is its `Effective Until`
    (code check Z7). Every other field of an old row is immutable.
- **Stored history is validated on every read and write:**
  - segments must be well-formed, non-overlapping, and only the latest may be
    open-ended;
  - anything else is 409 `commercial_terms_overlap` / `commercial_terms_invalid`;
  - the newest segment is never picked silently.
- **Other rules:**
  - A change identical to the current terms returns 200 `changed:false`, with
    nothing written.
  - Initial setup on a service that already has terms is 409
    `commercial_terms_exist`.
  - Initial setup may use any real date, including a past one, because it
    records terms already agreed. Only **changes** are forward-only.

### FIN3.4 Plain-language summaries

`describeTerms` produces the one-liner Management sees. These three are real
live API output:
- `£50 + VAT per delivered session`
- `£9 per player · 18 billable · £162 expected per session`
- `£25 inc. VAT per delivered session`

The other two charge types are covered by unit test CM3, which asserts
`£30 inc. VAT per month` for a subscription and `£1,250.50 + VAT · per term fee`
for other.

Each terms object also carries `illustrativeAmount {basis, amount, net, vat,
gross}` from the F2 kernel. For example, £50 + VAT is net 50.00, VAT 10.00,
gross 60.00. This is **an illustration of the terms only**: it is not expected
revenue for any occurrence (F4) and never Actual Revenue.

### FIN3.5 Storage (TEST Airtable, transitional)

**Tables** (TEST base only; all link to Organisation & Branding):
- **`Finance Clients` (`tblT55ZsoCkDtTY5y`):** Finance Client ID, Organisation,
  Client Name, Status, Billing Contact Name, Billing Email, Billing CC Emails,
  Payment Terms Override (Days), PO Required, Revision, Last Changed By User ID,
  Last Changed At.
- **`Finance Client Services` (`tblleT60Kw9voiOEj`):** Finance Service ID,
  Organisation, Client (link), Service Name, Status, Revision, Last Changed
  By/At.
- **`Finance Commercial Terms` (`tblXbmrM9A8VXJFSp`):** Commercial Terms ID,
  Organisation, Service (link), Effective From, Effective Until, Payer, Charge
  Type, Amount (Minor Units), VAT Treatment, VAT Rate (Basis Points), Default
  Billable Quantity, Subscription Frequency, Other Description, Created By User
  ID, Created At.

**Schema changes:**
- The Organisation links added reverse-link fields on Organisation & Branding.
  These are additive only.
- `finance-commercial-mapping.ts` is the only code that knows these field
  names.

**How rows are read:**
- Each row is validated on read with the input rules.
- A row that fails validation, links to 0 or several organisations, links to a
  parent outside the organisation, or duplicates an id makes the whole
  commercial dataset **409 `commercial_data_invalid`**. Bad rows are never
  skipped.
- **Direct Airtable edits bypass audit and history protection.** This is the
  same known limitation as F2 Settings (FIN2.2) and ends with the Supabase
  move.

**Supabase migration `finance_f3_write_locks`:**
- adds `public.finance_write_locks` (RLS on, service_role only);
- adds `acquire_finance_write_lock(p_lock_key)` /
  `release_finance_write_lock(p_lock_key, p_lock_token)`;
- EXECUTE is granted to service_role only, and a stale lock expires after 5
  minutes;
- F3 uses the key `commercial:<organisationId>`, so all writes for an
  organisation are serialised.

### FIN3.6 API — TEST Edge Function `finance` v5 (`verify_jwt: true`)

| Method | Path | Access | Result |
|---|---|---|---|
| GET | `/clients` | View/Manage | clients + service cards (`currentSummary`) + `today` |
| POST | `/clients` | Manage | `{client:{…}, reason?}` → 201 |
| GET | `/clients/{FCL}` | View/Manage | client + full services (current, history) |
| POST | `/clients/{FCL}` | Manage | `{client:{…changed}, reason?}` → 200 (or `changed:false`) |
| POST | `/clients/{FCL}/services` | Manage | `{service:{name}, commercial?:{effectiveFrom,…}, reason?}` → 201 |
| GET | `/services/{FSV}[?on=YYYY-MM-DD]` | View/Manage | service + `commercial {configured, today, current, history[], onDate?}` |
| POST | `/services/{FSV}` | Manage | `{service:{name?/status?}, reason?}` |
| POST | `/services/{FSV}/commercial` | Manage | initial terms → 201 |
| POST | `/services/{FSV}/commercial/changes` | Manage | `{effectiveFrom, changes:{…}, reason?}` → 201 |
| GET | `/commercial/options` | View/Manage | Active services of Active clients with current terms (for Session creation) |

**Rules:**
- **Order of checks:**
  1. 404 / 405 for the route;
  2. 401 without auth;
  3. 403 `management_required`;
  4. 400 for the query or body;
  5. authorisation via F1 `authorizeFinance`: `read` for GET, `manage` for
     POST.
- F1's `/access` and `/write-check` and F2's `/settings` are unchanged.
- **Input:** tenant selectors anywhere (query, top level, nested) give 400
  `tenant_param_rejected`. Unknown keys give 400 `unexpected_field` /
  `unexpected_parameter`. Malformed ids give 404. `on` is accepted only on the
  service read.
- **Output:**
  - Only opaque public ids (`FCL-`/`FSV-`/`FCT-`) are returned. Airtable
    record ids, user ids and audit internals never are.
  - Enum values (`plus_vat`, `per_player`…) are always paired with plain
    labels and the summary.
  - Amounts are returned as decimal text.
- **Error codes:**
  - 409: `duplicate_client_name`, `duplicate_service_name`, `client_inactive`,
    `service_ended`, `commercial_terms_exist`, `backdated_change_not_allowed`,
    `change_overlaps_current_terms`, `commercial_data_invalid`,
    `finance_commercial_busy`.
  - 503: stores unavailable.
  - 500 `finance_commercial_unaudited`: only if the audit and the undo both
    fail.

**Write path** (`finance-commercial-orchestrator.ts`):
1. authorise (Manage);
2. take the organisation write lock;
3. load and validate the organisation's clients, services and terms;
4. validate the request against that snapshot;
5. do the Airtable writes, each one registered with its undo;
6. write **one** audit insert (a PostgREST array, so it is atomic) for every
   event of the request;
7. release the lock (always).

If step 5 or 6 fails, every write of the request is undone: rows it created are
deleted and patched rows are restored. The caller then gets 503.

### FIN3.7 Session relationship (Finance owns commercial, Schedule owns the Session)

- **TEST `Sessions`:** new field **`Finance Service ID`** (`fldciYOlVZ9yVDf59`,
  text).
  - It holds the opaque `FSV-` reference that a future Session-creation flow
    sets after choosing from `GET /commercial/options`.
  - Finance **never writes Sessions** (drift checks SE3 / Z5).
  - The Session shows the read-only summary; price fields are never copied onto
    it.
- **Existing Session fields:** `Commercial Model` (`fldgLc3JRKuaudPB8`),
  `Billing Model` (`fldftnAxnGkrA2erA`) and `Finance Key`
  (`fldmWZ2gW9pTS07zV`) now have descriptions marking them
  **transitional/deprecated for new logic**. No data changed. Production Session
  fields were not touched.
- **Options:** list only Active services of Active clients; paused and ended
  services are excluded. A service whose terms start in the future shows
  `commercial: null` until they start.

### FIN3.8 Access and security (reuses F1 exactly)

- **Access rules:**
  - View: reads. Manage: reads and writes.
  - No grant: 403 `finance_access_denied`.
  - Coach / Parent: 403 `management_required`, even when holding a grant.
  - Module off: 403 `finance_module_disabled`.
- **The organisation always comes from the caller's profile:**
  - rows are filtered to the caller's Organisation & Branding record;
  - a parent link into another organisation's rows cannot resolve;
  - tenant keys are refused.
- **Isolation:** another organisation's client/service ids return 404.

### FIN3.9 Audit (F2 `public.finance_audit_events`, append-only)

**Event types** (`record_id` is the public opaque id):

| Entity | Events |
|---|---|
| `finance_client` | `.created` / `.updated` |
| `finance_client_service` | `.created` / `.updated` |
| `finance_commercial_terms` | `.created` / `.changed` |

**What each event holds:**
- the organisation, actor, before and after, reason, and `context {source,
  contract, route, changedFields, effectiveFrom, inline}`;
- `occurred_at` is the database clock;
- a change event's `before` holds the current segment, and its `after` holds
  the closed segment plus the next one.

**When events are written:**
- A service created with inline terms writes 2 events in one insert.
- Rejected, denied and no-op requests write **no** event.
- If the audit fails, the writes are undone (FIN3.6).

### FIN3.10 Live TEST verification (2026-09-29, `finance` v5, real HTTP via `pg_net`)

**Deploy.** v5 was byte-verified by read-back: **13/13** bundled files are
identical to the repo.

**Callers:** `manager@test.invalid` (Manage unless noted), `coach.a`, `parent.a`.

| # | Case | Result |
|---|---|---|
| 1 | Manage GET clients / options (empty) | 200, `[]` |
| 2 | Coach / Parent GET + POST | 403 `management_required` ×4 |
| 3 | No auth | 401 |
| 4 | Tenant query / tenant top-level / tenant nested (`org_id`) | 400 `tenant_param_rejected` ×3 |
| 5 | Bad id / wrong method / unknown query | 404 / 405 / 400 |
| 6 | Create client "TEST Parkside Primary (F3)" | 201 `FCL-3A8982D46528`, rev 1 |
| 7 | Service "TEST PPA cover (F3)" + inline terms from 2026-09-01 | 201 `FSV-D2E140F8755D`; **"£50 + VAT per delivered session"**; net 50.00 / VAT 10.00 / gross 60.00 |
| 8 | Service "TEST After-school club (F3)", then `/commercial` | 201 `FSV-B2A5C5275835`; **"£9 per player · 18 billable · £162 expected per session"**; No VAT |
| 9 | Service "TEST Holiday camp - parent paid (F3)", no VAT given | 201 `FSV-6D4E564C6E9E`; Settings pre-fill → VAT included 20%; "£25 inc. VAT per delivered session" (20.83 + 4.17); period upcoming |
| 10 | Change PPA to £55 from 2026-11-01 | 201; old segment until 2026-10-31, new `FCT-46A785F5686C` upcoming; current still £50 |
| 11 | `?on=2026-10-15` / `2026-11-15` / `2026-08-01` / `2026-02-30` | £50 + VAT / £55 + VAT (net 55, VAT 11, gross 66) / `null` / 400 |
| 12 | List / options / client read | 200, 3 services, only public ids and labels |
| 13 | Float amount / per-player without quantity / unknown field / bad payer | 400 ×4 |
| 14 | Backdated change (2026-09-15) | 409 `backdated_change_not_allowed` |
| 15 | Overlapping change (from 2026-11-01 again) | 409 `change_overlaps_current_terms` |
| 16 | Duplicate client name (different case) | 409 `duplicate_client_name` |
| 17 | Initial terms on a service with terms | 409 `commercial_terms_exist` |
| 18 | 3 simultaneous writes | 1 processed (409 backdated), 2 × 409 `finance_commercial_busy` |
| 19 | **View** grant: 3 reads / 3 writes | 200 (`access:view`, `?on` resolves £55) / 403 `finance_manage_required` ×3 |
| 20 | **No grant**: reads and write | 403 `finance_access_denied` ×3 |
| 21 | **`module_finance` off**: reads and write | 403 `finance_module_disabled` ×3; then restored ON |
| 22 | After restore: clients / access / settings | 200; Manage; Settings complete 8/8, Coach payment day 7 |
| 23 | Needs Attention `/cases` | 200, **Clear**, 0 cases, 0 config issues |

**No partial writes and no false audit events:**
- Audit events went from 7 to **15**: exactly the 8 successful writes (client
  created; 3 services created; 4 terms created/changed).
- Rows 13–21 wrote nothing.
- Airtable holds exactly 1 client, 3 services and 4 terms rows.
- `finance_write_locks` is empty.

**Cleanup:**
- **Grants:** the View proof grant was revoked, and a single Manage grant was
  restored for `manager@test.invalid`. There is 1 active grant.
- **Probe:** the temporary `f2probe` schema was dropped.
- **Passwords:** the three TEST users' passwords were reset for the probe (TEST
  only).

### FIN3.11 Resting TEST data (kept on purpose for F4)

All names start with "TEST" and end with "(F3)"; they are fixtures, not real
customers.

| Record | Id | Terms |
|---|---|---|
| Client TEST Parkside Primary (F3) | `FCL-3A8982D46528` | contact "TEST Business Manager", `billing.parkside@test.invalid`, CC `head.parkside@test.invalid`, 30 days, PO required |
| TEST PPA cover (F3) | `FSV-D2E140F8755D` | £50 + VAT 20% per session 2026-09-01 → 2026-10-31; £55 + VAT from 2026-11-01 |
| TEST After-school club (F3) | `FSV-B2A5C5275835` | £9 per player × 18, No VAT, client pays, from 2026-09-01 |
| TEST Holiday camp - parent paid (F3) | `FSV-6D4E564C6E9E` | £25 VAT included 20%, parents pay, from 2026-10-01 |

- **Why keep it:** this covers what F4 occurrence billing needs to resolve:
  fixed, per-player, a future price change across a date boundary, a
  parent-paid service, and all three VAT treatments.
- **Audit:** the 8 F3 audit events are permanent (append-only).
- **Settings:** Finance Settings are unchanged, at revision 7.

### FIN3.12 Tests and regression

- **`tests/support/finance-commercial.test.ts`: 86 checks.**

| Section | Checks | Covers |
|---|---|---|
| A | 6 | access matrix |
| T | 6 | tenant keys, unknown fields, bodies, query and routes |
| CL | 13 | clients: create, update, duplicate, inactive, no-op, isolation, invalid or multi-organisation rows |
| SV | 8 | multiple services, per-service payer, duplicate, pause/resume, ended frozen |
| CM | 14 | charge types, VAT pre-fill and override, no assumed rate, unregistered organisation, validation, pence, labels |
| ED | 13 | future change, earlier date, boundaries, old row untouched, backdated, overlap, quantity dating, identical no-op, charge-type switch, stored overlap, timezone "today" |
| AU | 12 | event shapes, one insert, no event on rejection, undo on audit failure and mid-write failure, undo failure → 500, lock release and busy |
| SE | 3 | options for Session creation, opaque ids, Sessions never touched |
| Z | 11 | drift and code checks |

- **Shim and support copies:**
  - shim: `tests/e2e/financecommercialtest.js`;
  - `finance-commercial.ts` and `finance-commercial-mapping.ts` are identical
    copies;
  - the repository and orchestrator copies differ only in the adjusted import.
- **Mutation check: 18/18 caught.**
  - The mutations:
    - backdated change allowed;
    - change on/before the current start allowed;
    - closed segment overlapping by a day;
    - stored overlap not detected;
    - inherited quantity kept;
    - unregistered organisation charging VAT;
    - expected amount ignoring quantity;
    - nested tenant key not rejected;
    - rows not filtered by organisation;
    - multi-organisation row accepted;
    - View can write;
    - audit failure not rolled back;
    - ended service editable;
    - inactive client takes services;
    - identical change writes a segment;
    - lock never released;
    - duplicate client names allowed;
    - options including paused services.
  - The lock-release mutant is caught by the suite's crash line (`X0`).
- **Other Finance suites (unchanged):** F1 56/56, F2 kernel 47/47, F2 Settings
  92/92.
- **Full suite (final code, `finance` v5):** `npm test` gives **70/70 files,
  2,417 PASS / 0 FAIL** (2,331 + 86). Schedule, Coaches, Needs Attention,
  Parent Hub and the F1/F2 suites are all green.

### FIN3.13 Deferred (later Finance slices — not started)

- **F4 occurrence billing resolution:** which terms apply to each delivered
  occurrence, actual billable quantity, expected revenue. F3 only illustrates.
- **Session linkage:**
  - writing `Finance Service ID` from the Session creation/edit flow;
  - the Session UI showing the summary;
  - retiring `Commercial Model` / `Billing Model` / `Finance Key`.
- **Later Finance work:** invoices, numbering, payments, credits, Stripe, Xero,
  Coach Costs, suppliers, overheads, Cash Flow, Month Report, Finance Needs
  Attention evaluators and all Finance UI.
- **Storage and API follow-ups:**
  - moving clients, services and terms (and Settings) from Airtable to
    Supabase, which ends the direct-edit audit bypass;
  - a Finance audit read API/UI;
  - optimistic concurrency (client-sent `revision`) for stale forms;
  - `GET /commercial/options` showing upcoming terms for services that have
    not started yet.
- **Client fields for later slices:** client billing address and Xero contact
  mapping, which belong to invoicing.
