// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks up
// the parent-hub requests-availability unit tests. The real assertions live
// in tests/support/parent-requests-availability.test.ts, run here via
// Node's type-stripping, mirroring coachdeclinetest.js's shim.
const { spawnSync } = require('child_process');
const path = require('path');

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'parent-requests-availability.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
