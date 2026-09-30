// Needs Attention deploy artifact (Finance F8a): the committed
// supabase/deploy-artifacts/needs-attention/index.js must be exactly what the
// committed source builds to, must not import anything from GitHub, and
// must boot and route requests. Same method as financebundletest.js.
// Run by tests/run-all.js.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'supabase', 'deploy-artifacts', 'needs-attention');
const ARTIFACT = path.join(DIR, 'index.js');
const results = [];
const ck = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);

(async () => {
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-needs-attention-bundle.mjs'), '--check'], { encoding: 'utf8' });
  ck('B1. Rebuilding from the committed source reproduces the committed artifact + manifest byte for byte', check.status === 0, check.stdout.trim().split('\n').join(' | '));

  const code = fs.readFileSync(ARTIFACT, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  ck('B2. No GitHub / raw.githubusercontent import anywhere in the artifact', !/github/i.test(code));
  ck('B3. The only external import is the jsr supabase-js import the source declares', JSON.stringify(manifest.externalImports) === JSON.stringify(['jsr:@supabase/supabase-js@2']) && (code.match(/from"jsr:[^"]+"/g) || []).length === 1);
  ck('B4. The manifest records the artifact hash and the pinned esbuild version', manifest.artifactSha256 === require('crypto').createHash('sha256').update(code).digest('hex') && manifest.esbuild === require(path.join(ROOT, 'package.json')).devDependencies.esbuild);
  ck('B5. Every needs-attention source file is bundled (none unused)', Array.isArray(manifest.unusedSources) && manifest.unusedSources.length === 0 && manifest.sources.length === 13);

  // Boot the artifact with a stub Deno + supabase-js (no network) and route a few requests.
  let handler = null;
  const env = { AIRTABLE_BASE_ID: 'appQktredAuGa1X7e', SUPABASE_URL: 'https://dkqubldmfyeuudecxmvh.supabase.co' };
  globalThis.Deno = { env: { get: (k) => env[k] ?? `test-${k}` }, serve: (h) => { handler = h; } };
  const stub = 'data:text/javascript,' + encodeURIComponent('export function createClient(){return {auth:{getUser:async()=>({data:{user:null},error:{message:"stub"}})}}}');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nabundle-')), 'index.mjs');
  fs.writeFileSync(tmp, code.replace('"jsr:@supabase/supabase-js@2"', JSON.stringify(stub)));
  await import(pathToFileURL(tmp).href);
  ck('B6. The artifact boots (registers its Deno.serve handler)', typeof handler === 'function');
  const call = (method, p) => handler(new Request(`https://x.supabase.co/functions/v1/needs-attention/${p}`, { method }));
  const opt = await call('OPTIONS', 'cases');
  const cases401 = await call('GET', 'cases');
  const cases405 = await call('POST', 'cases');
  const ex405 = await call('GET', 'exceptions');
  const ex401 = await call('POST', 'exceptions');
  const rv401 = await call('POST', 'exceptions/revoke');
  const unknown = await call('GET', 'nope');
  ck('B7. Routing works: CORS preflight 200, cases GET-only (401 / 405), exceptions POST-only (405 / 401), revoke 401 without a token, unknown 404', opt.status === 200 && cases401.status === 401 && cases405.status === 405 && ex405.status === 405 && ex401.status === 401 && rv401.status === 401 && unknown.status === 404, `${opt.status}/${cases401.status}/${cases405.status}/${ex405.status}/${ex401.status}/${rv401.status}/${unknown.status}`);
  ck('B8. The F8a Finance code is in the artifact (invoice_overdue / ATT-047, finance_access_required, finance_manage_required, grant lookup)', ['invoice_overdue', 'ATT-047', 'finance_access_required', 'finance_manage_required', 'finance_access_grants'].every((s) => code.includes(s)));

  for (const [s, n, x] of results) console.log(`${s}  ${n}${x ? `  -- ${x}` : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passing`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
