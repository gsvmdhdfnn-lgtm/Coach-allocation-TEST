# Edge Function deployment log

Every deployment to `bkkukymqaxawnudoxdjs`, newest first. `verify_jwt` is a
deployment setting rather than code, so it is recorded on every entry — a
redeploy that changes it silently breaks the function.

`ezbr_sha256` is **not** a content fingerprint (see DEPLOYED.md). Content
equality is established only by diffing a dashboard export against the
archived file.

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
