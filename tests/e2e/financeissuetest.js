// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the Finance Foundation F6 invoice issue + credit-note lifecycle tests.
// The real assertions live in tests/support/finance-issue.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'finance-issue.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
