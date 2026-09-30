// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the Finance Foundation F7 receivables + payments + client credit tests.
// The real assertions live in tests/support/finance-receivables.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'finance-receivables.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
