# F22 TEST logo fixtures

Clearly labelled TEST-only branding fixtures used by the F22 live proof
(TEST-ENV.md, FIN22.12+). Neither is a real brand.

- `zztest-f22-logo.png` - 360x120 8-bit RGB non-interlaced PNG ("TEST LOGO").
  Used to prove logo embedding in the official invoice PDF.
- `zztest-f22-broken-logo.png` - deliberately NOT an image (plain text with a
  .png name). Used to prove the broken-logo fallback (text branding, never blocks).

They reach the renderer only as Airtable attachments on the TEST
Organisation & Branding record (the renderer fetches logos from Airtable's
attachment host only).
