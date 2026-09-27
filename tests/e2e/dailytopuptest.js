// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks up
// the Slice 8 daily-top-up failure-isolation unit test. The real
// assertions live in tests/support/daily-top-up.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'daily-top-up.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
