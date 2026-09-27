// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up Coaches Slice 10 work-summary unit tests. The real assertions
// live in tests/support/coach-work-summaries.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'coach-work-summaries.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
