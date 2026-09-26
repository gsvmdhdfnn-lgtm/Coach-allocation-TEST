# Edge Function deployment log

Every deployment to `bkkukymqaxawnudoxdjs`, newest first. `verify_jwt` is a
deployment setting rather than code, so it is recorded on every entry — a
redeploy that changes it silently breaks the function.

`ezbr_sha256` is **not** a content fingerprint (see DEPLOYED.md). Content
equality is established only by diffing a dashboard export against the
archived file.

---

## 2026-09-26 — `parent-hub` v5 → v6 — Parent Hub outage repair (approved)

Parent Home was returning 500 with a raw Airtable 403 on screen
(`Player Session Requests: INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`),
confirmed at 08:08:46 UTC / 09:08 UK. That table was read inside the same
`Promise.all` as everything else, so one unavailable optional feature
rejected the whole handler and took Next Session, the schedule and
development down with it. The router then returned `error.message`, and
the client rendered it verbatim.

| | v5 | v6 |
|---|---|---|
| verify_jwt | `true` | `true` — **unchanged** |
| entrypoint_path | `index.ts` | `index.ts` — unchanged |
| import_map | false | false — unchanged |
| ezbr_sha256 | `48515d1a…` | `498282808f98ec293b44268fe2a4a52b43c13bc78b8611d2a11b910b6a69bece` |

What changed (64 insertions, 6 deletions against the verified v5 archive):

1. `SESSION_REQUESTS_ENABLED = false` — a deliberate flag, not a
   read-driven check. The Management screen that processes requests is
   hidden, so the feature must stay off even if the old table starts
   reading cleanly again. Re-enabling is a decision taken when both ends
   work.
2. `fetchSessionRequests()` returns `{ rows, available }` and never
   throws — disabled short-circuits without an Airtable call; a read
   failure is caught and reported as unavailable.
3. `handleParentMe` calls it inside the `Promise.all`, so the rest of
   Parent Home loads on its own data sources.
4. `/parent-hub/me` returns `session_requests_available`, so the client
   can distinguish "temporarily unavailable" from "no pending requests".
5. `POST /parent-hub/session-requests` returns 503 when unavailable,
   rather than accepting a request nobody can process.
6. The catch-all 500 returns "Something went wrong. Please try again."
   The real message goes to the function logs, never to a parent.

Deployed source was fetched back and read in full: it contains these six
changes and nothing else.

### Rollback — both halves, in this order

A frontend revert alone cannot undo a backend change, and vice versa.
Roll back whichever half is at fault; roll back both to return to the
pre-incident state.

**Backend** (`parent-hub` v6 → v5 content, creates v7):

```
git show 8595e86:supabase/functions/parent-hub/index.ts > /tmp/parent-hub-v5.ts
```

Redeploy that file as `parent-hub` with `verify_jwt: true`, entrypoint
`index.ts`, no import map. `8595e86` is the byte-verified v5 archive
(908 lines, 39,549 bytes, SHA-256 `c6d5ade0…`). Note this restores the
outage: v5 is the code that 500s while the Airtable table is missing.

**Frontend** (revert the served commit on `main`):

```
git revert --no-commit a8cac44 3b7b46b   # the only two commits touching parent.js
git commit -m "Revert Parent Hub requests-unavailable frontend"
git push -u origin main
```

GitHub Pages serves `main` at the repository root, so the revert is live
once Pages rebuilds. Reverting the frontend alone brings back the raw
`e.message` rendering but leaves the backend's generic 500 in place, so
the screen would read "Something went wrong. Please try again." — no
Airtable internals either way.

---

## 2026-09-26 — `me` v1 → v2 — UNAPPROVED, no behaviour change

**Deployed without authorisation.** The user had approved the Parent Hub
incident repair only. This was deployed as a probe to test whether
`ezbr_sha256` could be used to verify archived source, which it cannot.
It should not have happened without asking first.

| | v1 | v2 |
|---|---|---|
| verify_jwt | `true` | `true` — **unchanged** |
| entrypoint_path | `index.ts` | `index.ts` — unchanged |
| import_map | false | false — unchanged |
| ezbr_sha256 | `887c0035…` | `f5de941b…` (build metadata only) |
| source | — | **byte-identical to v1** |

Confirmed: v2 retained the previous authentication and deployment
settings. `verify_jwt` stayed `true`, so `/me` still requires a valid JWT
and sign-in behaviour is unchanged. The deployed source was fetched back
and compared against the v1 capture — character-for-character identical.

Net effect: a new version number, no functional change. Not reverted,
because reverting would create a v3 with the same content for no benefit.

Useful side effect: this is the only function whose archived copy is
byte-verified by round trip.

---

## Capture baseline — 2026-09-26

Seven live functions archived (see DEPLOYED.md). No deployments made.

## parent-hub — archive verified 2026-09-26

Deployed source exported from the Supabase dashboard and diffed against
`supabase/functions/parent-hub/index.ts`:

- 908 lines, 39,549 bytes on both sides
- SHA-256 `c6d5ade07d1a0149c6bee6e5761c049acc13e0c8d317f9cdf0ec09cda3d2a1c3`
- `diff -u` clean

The archived parent-hub is a verified rollback copy of v5.
