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
