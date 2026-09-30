// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up Needs Attention F8a Finance (invoice_overdue + Finance access) tests. The real assertions
// live in tests/support/needs-attention-finance.test.ts.
const { spawnSync } = require('child_process');
const path = require('path');
const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'needs-attention-finance.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
