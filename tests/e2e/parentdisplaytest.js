// Thin shim so tests/run-all.js (which only scans tests/e2e/*.js) picks
// up the Parent Hub display-rule unit tests. The real assertions live in
// tests/support/parent-display.test.ts (plain TypeScript, no Deno APIs),
// run here via Node's type-stripping, mirroring accessresolutiontest.js.
const { spawnSync } = require('child_process');
const path = require('path');

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', path.join(__dirname, '..', 'support', 'parent-display.test.ts')],
  { stdio: 'inherit' }
);
process.exit(res.status == null ? 1 : res.status);
