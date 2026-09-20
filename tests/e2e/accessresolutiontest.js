// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the player-access resolver's unit tests. The real assertions live in
// tests/support/access-resolution.test.ts (plain TypeScript, no Deno-
// specific APIs), run here via Node's type-stripping so the exact
// canonical resolver logic is tested directly, not through an HTTP mock.
const { spawnSync } = require('child_process');
const path = require('path');

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'access-resolution.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
