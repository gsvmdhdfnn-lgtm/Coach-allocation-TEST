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
