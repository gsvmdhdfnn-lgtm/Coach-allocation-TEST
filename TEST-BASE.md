# Isolated test environment

Foundation work only. No new features, no live data edits, no production
settings or deployments changed by anything in this document.

## Status

| | |
|---|---|
| Source base (verified) | `apprptFotQuVL1mhs` — Josh Evans Hub |
| Test base | **not created** — blocked, see below |
| Refusal guard | built, 48 assertions passing |
| Guard covers | the test suite, the Airtable client, and every seeding/write path |
| `TEST_BASE_ID` | `null` — so every real base is currently refused |

## The guard

`tests/support/base-guard.js` decides which base may be touched, and
`tests/support/airtable-client.js` is the only route to a real Airtable
request. Nothing in this repo builds an Airtable URL by hand.

It is not an "is TEST set" check. A `TEST` variable pointing at the live
base is the exact accident it exists to stop, and that check would pass
it. Instead:

- `apprptFotQuVL1mhs` (live) and `app6ex6UHY2RRO2Ak` (Master Copy) are
  refused outright, by name, with the reason in the error.
- Anything that is not the one declared test base is refused too, so a
  well-formed typo cannot reach a live base either.
- `TEST_BASE_ID` is `null` until the test base exists, so right now
  **every** real base is refused. The safe default is no base at all.
- The credential comes from `TEST_AIRTABLE_TOKEN`. The production variable
  `AIRTABLE_TOKEN` is never read, not even as a fallback, and a
  `TEST_AIRTABLE_TOKEN` holding the same value as `AIRTABLE_TOKEN` is
  refused — a test run must be physically unable to reach the live base.
- Every request URL is checked immediately before `fetch`, against the
  string actually about to go over the wire. That is the check a mistake
  would otherwise slip past: the first two checks pass strings around,
  this one inspects the real request.
- Clients are frozen, and the base is re-validated on every call, so a
  client cannot be re-pointed after construction.

Refusal is a thrown error. There is no warn-and-continue mode.

## Tables to be created (25)

Derived from the deployed function source and the agreed design, not
guessed. Full spec in `tests/support/test-base-spec.json` (458 fields).

- **Identity & access** — Coaches, Coach Roles, Players, Sessions,
  Player Session Links, Parents & Guardians, Parent–Player Links
- **Staffing (the agreed structure)** — Session Occurrences, Session
  Staff, Occurrence Staff, Staff Role Overrides
- **Feedback** — Feedback, Feedback Ratings, Development Framework,
  Development Framework Settings
- **Configuration** — Hub Settings, Organisation & Branding,
  Feature Controls
- **Content** — Venues, Resources, Coach Support, Public Pages,
  What We Offer, Trial Interest
- **Follow-up** — Player & Parent Requests (the rebuild target for
  session requests; created empty, wired to nothing yet)

`Player Session Requests` is **not** recreated. It no longer exists in the
live base, requests are switched off at the source, and recreating it
would invite the feature back on.

## Design conflicts found — decide these together

The live base has already been restructured toward the agreed design, and
the deployed code has not followed. **The deployed functions read none of
the new canonical fields.** This is why operational tables read as empty.

| Read by deployed code | Now named in Airtable | Canonical replacement |
|---|---|---|
| `Players.Active` | `LEGACY — Active` | **none exists** |
| `Sessions.Active` | `LEGACY — Active` | `Session Lifecycle Status` (Draft/Active/Inactive) |
| `Player Session Links.Status` | `LEGACY — Status` | `Membership Lifecycle Status` (Active/Paused/Cancellation Pending/Ending Scheduled/Ended) |
| `Player Session Links.End Date` | `LEGACY — End Date` | `Scheduled End Date` |
| `Parent–Player Links.Link Status` | `LEGACY — Link Status` | `Link Lifecycle Status` (adds Ended) |
| `Players.Assigned Coaches` | `LEGACY — Assigned Coaches` | `Session Staff` / `Occurrence Staff` |

Four things follow, and none of them should be decided silently:

1. **Players has no replacement for `Active`.** Every other retired field
   got a canonical successor; this one did not. Either Players keeps a
   lifecycle field or the code needs a different rule for "is this child
   current". I have not invented one.
2. **`Membership Lifecycle Status` has five values where the code knows
   two.** The agreed "separate Paused section" lives here — Paused,
   Cancellation Pending and Ending Scheduled are all "not Active" to
   today's code, which would hide a paused child entirely rather than
   showing them in their own section.
3. **`Link Lifecycle Status` adds `Ended`**, which the claim flow has no
   handling for. An ended parent link would currently read as neither
   verified nor pending.
4. **Schema artefacts** that should be tidied before they are copied:
   `Coaches` has two fields both named `Staff Availability Requests`;
   `Sessions` has `Discount Rules` and `Discount Rules 2`; `Session
   Occurrences` has `From field: Replacement Occurrence`.

The test base will mirror the live schema **including** the `LEGACY —`
fields, so tests reproduce production behaviour rather than a cleaner
fiction. A test base that quietly fixed these would make tests pass while
production stayed broken — the worst possible outcome.

## Blocked — two things only you can do

1. **Which workspace.** `create_base` requires a workspace ID, and no tool
   available to me reports which workspace a base belongs to —
   `list_bases` and `search_bases` return neither, and `list_bases` takes
   no workspace filter. Your account has four: `wspTRHQx3BsNtPntl`
   (Workspace 2), `wsppRXNyrv8XLskBv` (My First Workspace),
   `wspt9s5aggTpibAox` (Workspace 3), `wsptMqcZDCUEPhQpA` (Workspace 4).
   In Airtable, open Josh Evans Hub and read the workspace in the sidebar.
   I am not guessing, because **there is no delete-base tool** — a base
   created in the wrong place cannot be removed by me.
2. **A test-only token.** An Airtable personal access token with
   `data.records:read`, `data.records:write` and `schema.bases:write`,
   scoped to the test base **and nothing else**. Export it as
   `TEST_AIRTABLE_TOKEN`. I cannot create tokens.

## Automations and notifications

A base created through the API has no automations, so none can fire. The
build creates tables, fields and records only — it never copies an
automation, a webhook or a notification, and Master Copy is not read or
written at any point. After the base exists, confirm in the Airtable UI
that its Automations tab is empty before seeding.
