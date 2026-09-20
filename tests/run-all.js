#!/usr/bin/env node
/**
 * Runs every Playwright end-to-end test in tests/e2e sequentially (each
 * one starts its own local mock server on a fixed port, so they can't run
 * in parallel without colliding) and prints a combined pass/fail summary.
 * Exit code is non-zero if any test file fails, so this is CI-friendly:
 *   npm test
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const E2E_DIR = path.join(__dirname, 'e2e');
const files = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.js')).sort();

let failed = 0;
const results = [];

for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`);
  const res = spawnSync(process.execPath, [path.join(E2E_DIR, file)], { stdio: 'inherit' });
  const ok = res.status === 0;
  if (!ok) failed++;
  results.push({ file, ok, status: res.status });
}

process.stdout.write('\n' + '='.repeat(60) + '\n');
process.stdout.write(`${files.length - failed}/${files.length} test files passed\n`);
if (failed) {
  process.stdout.write('FAILED: ' + results.filter((r) => !r.ok).map((r) => r.file).join(', ') + '\n');
}
process.exit(failed ? 1 : 0);
