// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up Needs Attention Slice 6 compliance tests. The real assertions
// live in tests/support/needs-attention-compliance.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'needs-attention-compliance.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
