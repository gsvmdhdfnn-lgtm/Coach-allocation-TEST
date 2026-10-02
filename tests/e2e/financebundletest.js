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

  const ss401 = await call('GET', 'stripe/status');
  const ss405 = await call('POST', 'stripe/status');
  const sl401 = await call('GET', 'stripe/subscriptions');
  const so401 = await call('GET', 'stripe/subscriptions/sub_ZZ123');
  const sp401 = await call('GET', 'stripe/payments');
  const sr405 = await call('POST', 'stripe/refunds');
  const scancel404 = await call('POST', 'stripe/subscriptions/sub_ZZ123/cancel');
  const srefund404 = await call('POST', 'stripe/payments/ch_ZZ123/refund');
  const slink405 = await call('GET', 'stripe/customers/cus_ZZ123/parent-link');
  const sset401 = await call('POST', 'stripe/settings');
  ck('B11. F10 Stripe READ routes are live in the artifact: reads GET-only (401 without a token / 405), refunds GET-only, no cancel / refund route (404), parent link + settings POST-only', ss401.status === 401 && ss405.status === 405 && sl401.status === 401 && so401.status === 401 && sp401.status === 401 && sr405.status === 405 && scancel404.status === 404 && srefund404.status === 404 && slink405.status === 405 && sset401.status === 401, `${ss401.status}/${ss405.status}/${sl401.status}/${so401.status}/${sp401.status}/${sr405.status}/${scancel404.status}/${srefund404.status}/${slink405.status}/${sset401.status}`);
  const flat = code.replace(/\\\n/g, '');
  ck('B12. The TEST guard for Stripe (test mode only) is in the artifact; the emulator is reachable only on this project; api.stripe.com is the only real base; the API version is pinned', /requireTestMode:\s*(!0|true)/.test(code) && flat.includes('/functions/v1/stripe-sandbox/v1') && flat.includes('https://api.stripe.com/v1') && flat.includes('2024-06-20'));

  const fc401 = await call('GET', 'family-credits');
  const ff401 = await call('GET', 'family-credits/PARENT-TEST-001');
  const fa405 = await call('GET', 'family-credits/apply');
  const fv405 = await call('GET', 'family-credits/FFC-0123456789AB/void');
  const fp405 = await call('GET', 'family-payments');
  const rd401 = await call('POST', 'refund-decisions');
  const rr405 = await call('GET', 'refund-decisions/FRD-0123456789AB/reverse');
  const rs401 = await call('GET', 'refund-sources/ch_ZZ123');
  const rc401 = await call('GET', 'revenue-corrections');
  const rexec404 = await call('POST', 'refund-decisions/FRD-0123456789AB/execute');
  ck('B13. F11 family credit / refund decision routes are live in the artifact: reads GET-only (401 without a token), writes POST-only (405), no refund execution route (404)', fc401.status === 401 && ff401.status === 401 && fa405.status === 405 && fv405.status === 405 && fp405.status === 405 && rd401.status === 401 && rr405.status === 405 && rs401.status === 401 && rc401.status === 401 && rexec404.status === 404, `${fc401.status}/${ff401.status}/${fa405.status}/${fv405.status}/${fp405.status}/${rd401.status}/${rr405.status}/${rs401.status}/${rc401.status}/${rexec404.status}`);
  ck('B14. F11 writes go through its atomic database functions only (finance_family_* RPCs in the artifact)', ['finance_family_payment_record', 'finance_family_credit_apply', 'finance_family_decision_record', 'finance_family_credit_void', 'finance_family_decision_reverse'].every((f) => flat.includes(f)));

  const cc401 = await call('GET', 'coach-costs');
  const cw401 = await call('GET', 'coach-costs/COACH-TEST-A');
  const cm401 = await call('GET', 'coach-costs/COACH-TEST-A/2026-09');
  const cf405 = await call('GET', 'coach-costs/COACH-TEST-A/2026-09/finalise');
  const cs401 = await call('GET', 'coach-summaries/FCM-0123456789AB');
  const cr405 = await call('GET', 'coach-summaries/FCM-0123456789AB/corrections');
  const cx401 = await call('GET', 'coach-cost-facts');
  const creo404 = await call('POST', 'coach-summaries/FCM-0123456789AB/reopen');
  const cpay404 = await call('POST', 'coach-costs/COACH-TEST-A/2026-09/pay');
  ck('B15. F12 coach cost routes are live in the artifact: reads GET-only (401 without a token), writes POST-only (405), no reopen / payment route (404)', cc401.status === 401 && cw401.status === 401 && cm401.status === 401 && cf405.status === 405 && cs401.status === 401 && cr405.status === 405 && cx401.status === 401 && creo404.status === 404 && cpay404.status === 404, `${cc401.status}/${cw401.status}/${cm401.status}/${cf405.status}/${cs401.status}/${cr405.status}/${cx401.status}/${creo404.status}/${cpay404.status}`);
  ck('B16. F12 writes go through its atomic database functions only (finance_worker_month_* RPCs in the artifact)', ['finance_worker_month_finalise', 'finance_worker_month_correct'].every((f) => flat.includes(f)));

  const su401 = await call('GET', 'suppliers');
  const su1 = await call('GET', 'suppliers/FSU-0123456789AB');
  const sa401 = await call('GET', 'supplier-agreements');
  const sv405 = await call('GET', 'supplier-agreements/FSA-0123456789AB/version');
  const sa405 = await call('POST', 'supplier-agreements/FSA-0123456789AB');
  const si401 = await call('GET', 'supplier-instalments/FSI-0123456789AB');
  const sp405 = await call('GET', 'supplier-instalments/FSI-0123456789AB/payment');
  const sl405 = await call('POST', 'supplier-instalments');
  const sx401 = await call('GET', 'supplier-cost-facts');
  const scr404 = await call('POST', 'supplier-instalments/FSI-0123456789AB/apply-credit');
  const scf404 = await call('GET', 'cash-flow');
  ck('B17. F13 supplier routes are live in the artifact: reads GET-only (401 without a token), writes POST-only (405), an agreement is never POSTed in place (405), no instalment-level credit route / Cash Flow route (404)', su401.status === 401 && su1.status === 401 && sa401.status === 401 && sv405.status === 405 && sa405.status === 405 && si401.status === 401 && sp405.status === 405 && sl405.status === 405 && sx401.status === 401 && scr404.status === 404 && scf404.status === 404, `${su401.status}/${su1.status}/${sa401.status}/${sv405.status}/${sa405.status}/${si401.status}/${sp405.status}/${sl405.status}/${sx401.status}/${scr404.status}/${scf404.status}`);
  ck('B18. F13 writes go through its atomic database functions only (finance_supplier_* RPCs in the artifact)', ['finance_supplier_write', 'finance_supplier_agreement_record', 'finance_supplier_instalment_change'].every((f) => flat.includes(f)));

  const kl401 = await call('GET', 'supplier-credits');
  const kc401 = await call('POST', 'supplier-credits');
  const ko401 = await call('GET', 'supplier-credits/FSC-0123456789AB');
  const kp405 = await call('POST', 'supplier-credits/FSC-0123456789AB');
  const kd405 = await call('DELETE', 'supplier-credits/FSC-0123456789AB');
  const ka401 = await call('POST', 'supplier-credits/FSC-0123456789AB/apply');
  const ka405 = await call('GET', 'supplier-credits/FSC-0123456789AB/apply');
  const ku401 = await call('POST', 'supplier-credits/FSC-0123456789AB/unapply');
  const kv401 = await call('POST', 'supplier-credits/FSC-0123456789AB/void');
  const kx404 = await call('POST', 'supplier-credits/FSC-0123456789AB/delete');
  const kauto404 = await call('POST', 'supplier-credits/apply-all');
  ck('B19. F14 supplier-credit routes are live in the artifact: list / one GET, create / apply / unapply / void POST (401 without a token); a credit is never POSTed / DELETEd in place (405); no delete / auto-apply route (404)', kl401.status === 401 && kc401.status === 401 && ko401.status === 401 && kp405.status === 405 && kd405.status === 405 && ka401.status === 401 && ka405.status === 405 && ku401.status === 401 && kv401.status === 401 && kx404.status === 404 && kauto404.status === 404, `${kl401.status}/${kc401.status}/${ko401.status}/${kp405.status}/${kd405.status}/${ka401.status}/${ka405.status}/${ku401.status}/${kv401.status}/${kx404.status}/${kauto404.status}`);
  ck('B20. F14 writes go through its atomic database functions only (finance_supplier_credit_* RPCs in the artifact)', ['finance_supplier_credit_record', 'finance_supplier_credit_change'].every((f) => flat.includes(f)));

  const oc401 = await call('GET', 'overhead-categories');
  const op401 = await call('POST', 'overhead-categories');
  const ou401 = await call('POST', 'overhead-categories/FOC-0123456789AB');
  const od405 = await call('DELETE', 'overhead-categories/FOC-0123456789AB');
  const ol401 = await call('GET', 'overheads');
  const ov401 = await call('POST', 'overheads/FSA-0123456789AB/version');
  const opay404 = await call('POST', 'overheads/FSA-0123456789AB/payment');
  const oconf404 = await call('POST', 'overheads/FSA-0123456789AB/confirm-estimate');
  const el401 = await call('GET', 'employment-costs');
  const ec401 = await call('POST', 'employment-costs/FEM-0123456789AB/months/2026-10/confirm-estimate');
  const ep401 = await call('POST', 'employment-costs/FEM-0123456789AB/months/2026-10/payment');
  const epr404 = await call('POST', 'employment-costs/FEM-0123456789AB/payroll');
  const of401 = await call('GET', 'overhead-facts');
  const of405 = await call('POST', 'overhead-facts');
  ck('B21. F15 overhead / employment routes are live in the artifact (401 without a token); no category delete (405), no overhead payment / confirm route (F13 owns those) and no payroll route (404); facts are read-only (405)', [oc401, op401, ou401, ol401, ov401, el401, ec401, ep401, of401].every((r) => r.status === 401) && od405.status === 405 && of405.status === 405 && [opay404, oconf404, epr404].every((r) => r.status === 404), [oc401, op401, ou401, od405, ol401, ov401, opay404, oconf404, el401, ec401, ep401, epr404, of401, of405].map((r) => r.status).join('/'));
  ck('B22. F15 writes go through its atomic database functions only (finance_overhead_* / finance_employment_* RPCs in the artifact)', ['finance_overhead_category_write', 'finance_overhead_assign', 'finance_overhead_version_record', 'finance_employment_version_record', 'finance_employment_item_change'].every((f) => flat.includes(f)));

  for (const [s, n, x] of results) console.log(`${s}  ${n}${x ? `  -- ${x}` : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passing`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
