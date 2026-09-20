# Coach-allocation-TEST
To test in a URL

## Running the test suite

The Playwright end-to-end suite lives in `tests/` and exercises the real
`index.html`/`core.js`/`auth.js`/`coach.js`/`management.js`/`parent.js`/`main.js`
against local mock servers - it never touches production Supabase, Airtable
or Google Sheets.

```bash
npm install                # installs the pinned Playwright version
npx playwright install chromium   # downloads the matching browser (first run only)
npm test                   # runs every test file in tests/e2e, sequentially
```

`npm test` runs `tests/run-all.js`, which executes each file in `tests/e2e/`
in turn (they share fixed local ports, so they can't run in parallel) and
prints a combined pass/fail summary. It exits non-zero if any file fails,
so it's safe to wire into CI as-is.

Structure:
- `tests/e2e/` — the test files themselves (22 files covering auth, coach
  screens, management screens, the Parent Hub, branding/white-label, and a
  smoke test across all three roles)
- `tests/support/` — the local mock HTTP servers and a Supabase auth stub
  these tests run against
- `tests/fixtures/` — test-only config (points at the local mock server
  instead of production) and sample CSV data
- `tests/run-all.js` — the test runner
