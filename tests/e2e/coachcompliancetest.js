// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up Coaches Slice 8's coach-compliance unit tests. The real assertions
// live in tests/support/coach-compliance.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'coach-compliance.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
