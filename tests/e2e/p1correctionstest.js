// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the whole-backend audit P1 correction tests (active-profile
// enforcement + serialised Parent identity). The real assertions live in
// tests/support/p1-corrections.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'p1-corrections.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
