# Isolated test environment

Test-environment work only. Live data, production settings and deployments
are unchanged. Master Copy is untouched — never read, never written.

## Status

| | |
|---|---|
| Source base (verified by digest) | `apprptFotQuVL1mhs` — Josh Evans Hub |
| **Test base** | **`appQktredAuGa1X7e` — "Josh Evans Hub — TEST"** |
| Workspace | `wsppRXNyrv8XLskBv` — My First Workspace |
| Tables | 25 of 25 created |
| Records | none yet — seeding waits for the token and the isolation checks |
| Automations | none, and none can be created by this build |
| `TEST_BASE_ID` in the guard | set to the test base |
| `TEST_AIRTABLE_TOKEN` | **not yet created — see below** |

**Automated tests passing is not the same as a working test environment.**
The tests below prove the guard refuses the live base. They do not prove
the Hub works against the test base: no records exist, no Supabase project
points at it, and nothing has been signed into. That is the remaining work.

## Creating the test-only token

1. Airtable → your account menu → **Builder hub** → **Personal access tokens**
   → **Create new token**.
2. Name it something unmistakable, e.g. `hub-test-base-only`.
3. **Scopes** — add exactly these three, nothing else:
   `data.records:read`, `data.records:write`, `schema.bases:write`.
4. **Access** — click *Add a base* and select **Josh Evans Hub — TEST**
   only. Do **not** select "All current and future bases", and do not add
   Josh Evans Hub or Master Copy. This is what makes the isolation real:
   even a bug cannot reach the live base with a token that has no grant
   for it.
5. Create the token and copy it **once** — Airtable will not show it again.

Configuring it securely:

- Put it in your shell profile or a local `.env` that is **not** committed:
  `export TEST_AIRTABLE_TOKEN='pat...'`
- Never set it as `AIRTABLE_TOKEN`. That name is the production variable
  and the test client refuses to read it.
- Never paste the token into a chat, a commit, an Airtable record or a
  GitHub issue. If it is ever exposed, delete it in the Builder hub and
  create a new one — a token scoped to one empty test base is cheap to
  replace.
- The repo's `.gitignore` already excludes `.env`.

The client refuses to start without it, refuses if it equals
`AIRTABLE_TOKEN`, and refuses any URL that is not the test base.

## Carried-forward decisions, and how the schema reflects them

- **Player "Active" is derived from current memberships.** No new player
  lifecycle field was introduced. `Players.LEGACY — Active` is carried
  across for parity with the live base and marked retired in its own
  field description; nothing new was invented to replace it.
- **Paused memberships appear separately and read-only.**
  `Membership Lifecycle Status` carries Paused as its own value, distinct
  from Ended.
- **Cancellation Pending and Ending Scheduled stay visible** while the
  player is still attending — they are separate values, not collapsed
  into Ended.
- **`Scheduled End Date` is not the actual end date.** Its field
  description says so explicitly, as does `LEGACY — End Date`, and
  `Session Staff.Former Access Until` records that it is derived from the
  actual end. The distinction is preserved in the schema, not just in
  discussion.

## Two findings that must stay separate

1. **Renamed fields explain empty Hub results.** The deployed code reads
   `Players.Active`, `Sessions.Active`, `Player Session Links.Status` /
   `End Date` and `Parent–Player Links.Link Status` — all now
   `LEGACY —` prefixed. Reads of those fields return nothing, so the Hub
   renders empty.
2. **They do not explain the zero-record unfiltered reads.** Reading
   Players, Coaches, Sessions, Player Session Links and Feedback with no
   filter returned zero records. A renamed *field* cannot cause that: an
   unfiltered table read returns rows whatever the fields are called.
   Something else is true about those tables and it is still unexplained.
   These two findings are not to be merged.

## Left alone deliberately

The duplicate and oddly named fields (`Coaches` with two
`Staff Availability Requests`, `Sessions` with `Discount Rules 2`,
`Session Occurrences` with `From field: Replacement Occurrence`) are
**unchanged in the live base** and nothing has been proposed for them.
They are also absent from the test base — but because their tables or
links are out of scope for the coach and parent journeys, not because
they were cleaned up. Their relationships and usage still need
establishing before any cleanup is proposed.

## Ended parent–player links

The design already answers most of this, so it is not an open question:
`Link Lifecycle Status` carries **Ended** alongside Pending / Verified /
Needs Review / Rejected, with `Ended At`, `Ended By User ID`,
`Ended By Name Snapshot` and `End Reason` beside it, and
`Player & Parent Requests` carries an **Access removal** request type.
The intended rule is therefore: a parent's access ends through an explicit,
recorded end event rather than by deletion; an Ended link is not Verified,
so it grants no access from that moment.

Two things are genuinely undecided, and only these:

1. **Does an ended parent keep a read-only window** (as a former player
   keeps 21 days), or does access stop immediately?
2. **Does the ended child still appear in that parent's own Hub** as
   history, or disappear entirely?

## What the API could not create

Faithfully copied: field types, select choices and colours, date and time
formats, currency, linked relationships, and both formulas
(`Sessions.LEGACY — Effective Lifecycle Status`,
`Session Occurrences.Display Status`).

Not copied, with reasons:

- **Links to out-of-scope tables** (Families, Bookings, Booking Lines,
  Hub Audit Events, Discount Rules, Coach Allocations, Player Attendance,
  Emergency Contacts, Policy Acceptances, Billing Rules, Clients &
  Schools, Schedule Breaks, Needs Attention, Session Change History,
  Staff Availability Requests, Coach Rate Profiles, Coach Availability,
  Cover Requests/Responses, Coach Documents, Coach Work Summaries,
  Development Plans, Eligibility Rules). Those tables are finance and
  wider-operations, not the coach and parent journeys, so neither they
  nor the links to them were created.
- **Views, interfaces and automations.** A base created through the API
  has none, which is the point: no automation can fire and no external
  notification can be sent from this base.

## Running the checks

```
cd coach-allocation-test && git checkout foundation/test-base-isolation
node tests/e2e/baseguardtest.js        # 30 assertions
node tests/e2e/airtableclienttest.js   # 22 assertions
node tests/run-all.js                  # whole suite
```

The one worth seeing yourself:

```
TEST_AIRTABLE_TOKEN=x node -e "require('./tests/support/airtable-client.js').createTestAirtableClient({baseId:'apprptFotQuVL1mhs'})"
```

It refuses, naming the live base, before any network call is made.
