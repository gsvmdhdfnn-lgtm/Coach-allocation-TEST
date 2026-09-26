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
