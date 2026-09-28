// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the Staffing Absent correction tests. The real assertions live in
// tests/support/staffing-absent.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'staffing-absent.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
