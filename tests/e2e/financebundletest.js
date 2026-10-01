// Finance deploy artifact (F5 correction; F6 routes added): the committed
// supabase/deploy-artifacts/finance/index.js must be exactly what the
// committed source builds to, must not import anything from GitHub, and
// must boot and route requests. Run by tests/run-all.js.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const ARTIFACT = path.join(ROOT, 'supabase', 'deploy-artifacts', 'finance', 'index.js');
const results = [];
const ck = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);

(async () => {
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-finance-bundle.mjs'), '--check'], { encoding: 'utf8' });
  ck('B1. Rebuilding from the committed source reproduces the committed artifact + manifest byte for byte', check.status === 0, check.stdout.trim().split('\n').join(' | '));

  const code = fs.readFileSync(ARTIFACT, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase', 'deploy-artifacts', 'finance', 'manifest.json'), 'utf8'));
  ck('B2. No GitHub / raw.githubusercontent import anywhere in the artifact', !/github/i.test(code));
  ck('B3. The only external import is the jsr supabase-js import the source declares', JSON.stringify(manifest.externalImports) === JSON.stringify(['jsr:@supabase/supabase-js@2']) && (code.match(/from"jsr:[^"]+"/g) || []).length === 1);
  ck('B4. The manifest records the artifact hash and the pinned esbuild version', manifest.artifactSha256 === require('crypto').createHash('sha256').update(code).digest('hex') && manifest.esbuild === require(path.join(ROOT, 'package.json')).devDependencies.esbuild);
  ck('B5. The old GitHub-runtime deploy entry is gone', !fs.existsSync(path.join(ROOT, 'supabase', 'deploy-entries')));

  // Boot the artifact with a stub Deno + supabase-js (no network) and route a few requests.
  let handler = null;
  const env = { AIRTABLE_BASE_ID: 'appQktredAuGa1X7e', SUPABASE_URL: 'https://dkqubldmfyeuudecxmvh.supabase.co' };
  globalThis.Deno = { env: { get: (k) => env[k] ?? `test-${k}` }, serve: (h) => { handler = h; } };
  const stub = 'data:text/javascript,' + encodeURIComponent('export function createClient(){return {auth:{getUser:async()=>({data:{user:null},error:{message:"stub"}})}}}');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finbundle-')), 'index.mjs');
  fs.writeFileSync(tmp, code.replace('"jsr:@supabase/supabase-js@2"', JSON.stringify(stub)));
  await import(pathToFileURL(tmp).href);
  ck('B6. The artifact boots (registers its Deno.serve handler)', typeof handler === 'function');
  const call = (method, p) => handler(new Request(`https://x.supabase.co/functions/v1/finance/${p}`, { method }));
  const opt = await call('OPTIONS', 'access');
  const m405 = await call('GET', 'invoice-drafts/FID-0123456789AB/missing-terms-exceptions');
  const noAuth = await call('POST', 'invoice-drafts/FID-0123456789AB/missing-terms-exceptions');
  const unknown = await call('GET', 'nope');
  ck('B7. Routing works: CORS preflight 200, new exception route is POST-only (405), no token 401, unknown 404', opt.status === 200 && m405.status === 405 && noAuth.status === 401 && unknown.status === 404, `${opt.status}/${m405.status}/${noAuth.status}/${unknown.status}`);
  const issue405 = await call('GET', 'invoice-drafts/FID-0123456789AB/issue');
  const issue401 = await call('POST', 'invoice-drafts/FID-0123456789AB/issue');
  const inv401 = await call('GET', 'invoices/FIV-0123456789AB');
  const cn405 = await call('GET', 'credit-notes/FCN-0123456789AB/replacement-draft');
  const send404 = await call('POST', 'invoices/FIV-0123456789AB/send');
  const f5still = await call('GET', 'invoice-drafts/FID-0123456789AB/refresh');
  ck('B8. F6 routes are live in the artifact: issue POST-only (405 / 401), invoice read 401 without a token, replacement POST-only, no send route (404), F5 draft routes unchanged (405)', issue405.status === 405 && issue401.status === 401 && inv401.status === 401 && cn405.status === 405 && send404.status === 404 && f5still.status === 405, `${issue405.status}/${issue401.status}/${inv401.status}/${cn405.status}/${send404.status}/${f5still.status}`);

  const xs401 = await call('GET', 'xero/status');
  const xs405 = await call('POST', 'xero/status');
  const xset405 = await call('GET', 'xero/settings');
  const xi405 = await call('GET', 'invoices/FIV-0123456789AB/xero-issue');
  const xi401 = await call('POST', 'invoices/FIV-0123456789AB/xero-issue');
  const xr401 = await call('POST', 'invoices/FIV-0123456789AB/xero-retry');
  const xst401 = await call('GET', 'invoices/FIV-0123456789AB/xero');
  const xbad404 = await call('POST', 'invoices/FIV-0123456789AB/xero-delete');
  const xc405 = await call('GET', 'clients/FCL-0123456789AB/xero-contact');
  const f7still = await call('GET', 'invoices/FIV-0123456789AB/payments');
  ck('B9. F9 routes are live in the artifact: xero/status GET-only (401 / 405), xero/settings POST-only, xero-issue / xero-retry POST-only (401 without a token), invoice Xero state 401, unknown xero-* 404, contact link POST-only; F7 payments unchanged (401)', xs401.status === 401 && xs405.status === 405 && xset405.status === 405 && xi405.status === 405 && xi401.status === 401 && xr401.status === 401 && xst401.status === 401 && xbad404.status === 404 && xc405.status === 405 && f7still.status === 401, `${xs401.status}/${xs405.status}/${xset405.status}/${xi405.status}/${xi401.status}/${xr401.status}/${xst401.status}/${xbad404.status}/${xc405.status}/${f7still.status}`);
  ck('B10. The TEST deployment guard for Xero is in the artifact (Demo Company required) and the sandbox is reachable only on this project', /requireDemoTenant:\s*(!0|true)/.test(code) && code.replace(/\\\n/g, '').includes('/functions/v1/xero-sandbox') && code.includes('identity.xero.com/connect/token'));

  for (const [s, n, x] of results) console.log(`${s}  ${n}${x ? `  -- ${x}` : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passing`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
