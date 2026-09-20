// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the differential rating-upsert unit tests. The real assertions
// live in tests/support/feedback-ratings-diff.test.ts (plain TypeScript,
// no Deno-specific APIs), run here via Node's type-stripping, mirroring
// accessresolutiontest.js's shim.
const { spawnSync } = require('child_process');
const path = require('path');

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'feedback-ratings-diff.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
