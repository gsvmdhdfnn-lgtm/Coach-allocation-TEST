# Test-only copies of the Edge Functions

These are the archived production functions with two test-only changes,
deployed to the **test** Supabase project (`dkqubldmfyeuudecxmvh`) against
the **test** Airtable base (`appQktredAuGa1X7e`).

1. **A boot guard.** Each function refuses to start if `AIRTABLE_BASE_ID`
   is a known production base, or is missing or malformed. A boot failure
   is loud and harmless; a silent write to the live base is not.
2. **`parent-hub` uses the test base's table IDs.** The production copy
   hardcodes the live base's IDs for Parents & Guardians and
   Parent–Player Links. That is a portability problem in its own right —
   a function naming table IDs cannot be pointed at another base without
   editing its source. Flagged here rather than silently fixed in
   production.

Nothing else differs from the archive in `supabase/functions/`.

## How they are deployed

The deployed function in the test project is a one-line loader that
imports the file in this folder from raw.githubusercontent.com, **pinned
to a commit SHA** so it can never drift when a branch moves.

This is deliberate, and test-only. The MCP deployment tool takes source
as text, which would mean retyping ~2,200 lines; a transcription slip
would put drifted code in the test backend and defeat the point of
testing the real thing. Importing by pinned URL makes the deployed code
provably identical to the reviewed file. Production continues to be
deployed with its source inline.
