// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the Settings / Config S1-a tests (shared organisation context,
// module contract, Settings & System overview, hub-content /settings).
// The real assertions live in tests/support/settings-system.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'settings-system.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
