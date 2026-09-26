# Deployed Edge Functions — capture of 2026-09-26

Supabase Edge Function source has never lived in this repository: it existed
only inside Supabase, so backend changes had no diff, no review surface and
no rollback artefact. This directory is that missing baseline.

**This is an archive, not a build input.** Nothing here is deployed from the
repo. Redeploying means taking a file from here and pushing it to Supabase
deliberately.

Project ref: `bkkukymqaxawnudoxdjs`

## What was live at capture

| Function | Version | verify_jwt | ezbr_sha256 | Archived |
|---|---|---|---|---|
| hub-content | 27 | false | `930eb214fb6da5b770a17a1ec554ced581d8308acc8796907f7654c9e71a514b` | yes |
| player-feedback | 10 | false | `fc3a00bd9b7deefd9c158a9884e9d57e97a8cdfe97df08acf45452a489de96ff` | yes |
| player-sessions | 4 | true | `69b3319328b82ef8bf4c34438b4b6405e0e1b5a485e835277764f1edcf8a18d4` | yes |
| parent-hub | 5 (now 6) | true | `48515d1a9eb4de651269de312d66b5d84f67c63bc255b2b3bb95973646dde1bc` | yes, **byte-verified** |
| approve-coach | 2 | true | `f308dfbdf6e26fe6c4bc186d66cc9020ffa4f12b1755b1fc16ff8f8cc1f9dc41` | yes |
| me | 1 (now 2) | true | `887c003554d43c69023c19393e31a0f504daf37e9f3cb4cdf0c7bf1463915b71` | yes, **byte-verified** |
| register-interest | 2 | false | `1936e0dbc250e4d0ea1550b51df41d9f2e56fa11af8fc65e91fd87937842056a` | yes |
| approve-coach-trial | 1 | true | `81d3871ace407c2fb1cde2af2324520e90bea5a11b26f5ba4abb10fbd8851c71` | **no** |
| player-feedback-trial | 1 | false | `4a9a0c39634c9f19ded679371a20599eba45939a5e5654dcdfae9db7a99c08a5` | **no** |

### ezbr_sha256 is NOT a content fingerprint

Do not use it to check whether a file matches what is deployed. Proven on
2026-09-26: `me` was redeployed with **byte-identical** source and the hash
changed from `887c0035...` to `f5de941b...`, while fetching the new version
back returned source character-for-character identical to v1. The hash
therefore includes build/version metadata. It is recorded above only to
identify a specific deployment, never to compare content.

A consequence worth knowing: that round trip **did** prove this archive's
`me/index.ts` is byte-correct, because the deployed source came back
identical to the capture. No other function has been verified that way.

`verify_jwt` is a deployment setting, not code. It must be set correctly on
every redeploy — `hub-content`, `player-feedback` and `register-interest`
are **false** because they authenticate inside the function body; forcing
them to true would break them.

### The two trial functions

Orphaned once `main` stopped referencing them (commit `8cb3c54`) and
scheduled for deletion. Deliberately not archived: neither holds unique
logic. `player-feedback-trial` is a branch of the production function
without its later fixes, and `approve-coach-trial` contains the
`role = "rejected"` write that violates `profiles_role_check` and was the
original Coach Decline bug. Their metadata is recorded above so they can be
identified. Say if you want them archived before deletion.

## Dependencies

`player-access.ts` is the shared access resolver. Edge Functions are
self-contained, so it is **copied** into each function that imports it —
hub-content, player-feedback and player-sessions. All three copies are
byte-identical, and identical to `tests/support/player-access.ts` apart
from that file's test-suite header comment.

**Redeploying any one of them means redeploying that function's own copy.**
Changing the resolver means changing it in three places plus the test copy.

## Credentials

Scanned before committing: **no credential-shaped strings**. Every secret is
read at runtime via `Deno.env.get()` — `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`,
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`FINANCIALS_CSV_URL`.

Two Google "publish to web" CSV URLs are hardcoded (Sessions gid=349419235,
Changes gid=1549675202). They are already public and already present in
`config.js`, so committing them adds no exposure — noted so the decision is
explicit rather than assumed.

## Verification

- `hub-content` (both files) and `player-feedback` (both files) were
  extracted programmatically from the API response and **byte-diffed**
  against the live deployment.
- `approve-coach` was diffed against the live deployment when it was
  deployed as v2 earlier in this session.
- `me` is **byte-verified** — redeployed from this archive and fetched
  back identical (see the ezbr_sha256 note above).
- `parent-hub` is **byte-verified** — the deployed v5 source was exported
  from the Supabase dashboard and diffed clean against the archived file
  (908 lines, 39,549 bytes, SHA-256 `c6d5ade0…`). It is a valid rollback
  copy of v5; the working copy in this tree is now the repaired v6, so
  roll back from commit `8595e86` rather than from the tip (see
  CHANGELOG.md).
- `player-sessions` and `register-interest` were transcribed from the same
  API responses and syntax-checked. **This is not proof of byte-equality
  with the deployment**, and they must not be described as verified
  rollback copies until diffed against the deployed source.
- All ten files pass a TypeScript syntax check. A syntax check establishes
  only that the file parses, never that it matches what is running.

To verify one properly: export the deployed source from the Supabase
dashboard (Edge Functions -> the function -> Code) and diff it against the
file here. The MCP tooling can read a deployed body back, but only into the
model's own context - it cannot write it to disk, so it can confirm that
specific expected changes are present and nothing else has drifted, and it
cannot stand in for a mechanical byte-diff.

`register-interest/index.ts` has no import or export statement, so Node's
`--check` treats it as CommonJS and will not strip TypeScript syntax; it was
verified with a temporary prepended import. The archived file is unmodified.

## Known-broken at capture

Recorded so the baseline is not mistaken for a healthy system. The first
two bullets were repaired in `parent-hub` v6 on 2026-09-26 (see
CHANGELOG.md); the rest still stand.

- **`Player Session Requests` returns 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND.**
  `parent-hub` `handleParentMe` reads it inside a `Promise.all`, so the
  **entire Parent Hub fails to load** (confirmed in production 2026-09-26
  ~09:08 UK). `player-sessions` `handleListRequests` and `parent-hub`
  `handleParentSessionRequest` hit the same wall.
- Raw Airtable error text reaches the parent's screen, because `parent-hub`
  returns `error.message` and the client renders it verbatim.
- Several field names the code reads and writes are now prefixed
  `LEGACY —` in Airtable. Reads fail closed; writes would fail with 422.

## Rollback

1. Copy the function's directory contents.
2. Deploy to Supabase with the **exact `verify_jwt` above**.
3. Include the function's own `player-access.ts` where present.
4. Confirm the new version number and re-read the deployed source to check
   for transcription drift before declaring the rollback good.
