// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the Schedule delivery-confirmation writer tests (prerequisite before
// Finance F5). The real assertions live in
// tests/support/occurrence-confirmation.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'occurrence-confirmation.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
