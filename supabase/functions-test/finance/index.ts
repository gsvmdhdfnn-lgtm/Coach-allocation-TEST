/**
 * Finance - access boundary + core API (Finance Foundation F1-F7; see
 * TEST-ENV.md "Finance Foundation - F1" / "- F2" / "- F3" / "- F4" / "- F5" / "- F6" / "- F7"). Thin HTTP
 * wrapper, same convention as the Coaches / Needs Attention functions:
 * policy lives in finance-access.ts / finance-settings.ts /
 * finance-money.ts / finance-commercial.ts (pure), reads and writes in the
 * *repository.ts files, composition in the *orchestrator.ts files. This file only
 * authenticates, checks request shape, maps outcomes to HTTP responses, and
 * boot-refuses against production.
 *
 * Routes (every one requires an active Management profile holding a Finance
 * grant for their own organisation, with module_finance enabled):
 *   GET   /access        Finance read   -> { contract, organisation, module, access, capabilities }   (F1, unchanged)
 *   POST  /write-check   Finance manage -> authorisation probe only; persists NOTHING                 (F1, unchanged)
 *   GET   /settings      Finance read   -> organisation Finance Settings + completeness               (F2)
 *   POST  /settings      Finance manage -> { settings: {...changed fields}, reason? }; partial update, one audited write (F2)
 *
 * F3 commercial setup (Finance read = GET, Finance manage = POST):
 *   GET  /clients                               POST /clients
 *   GET  /clients/{FCL-id}                      POST /clients/{FCL-id}            (update)
 *                                               POST /clients/{FCL-id}/services   (+ optional inline commercial setup)
 *   GET  /services/{FSV-id}[?on=YYYY-MM-DD]     POST /services/{FSV-id}           (name / status)
 *                                               POST /services/{FSV-id}/commercial          (initial setup)
 *                                               POST /services/{FSV-id}/commercial/changes  (apply from a date)
 *   GET  /commercial/options                    (active services + summaries, for Session creation)
 *
 * F4 occurrence billing resolution (Finance read = GET, Finance manage = POST):
 *   GET  /occurrences/{Occurrence ID}/billing                       resolve one occurrence
 *   GET  /sessions/{Session ID}/billing?from=YYYY-MM-DD&to=YYYY-MM-DD  resolve a Session's occurrences (<= 93 days)
 *   POST /occurrences/{Occurrence ID}/billing-overrides             { override: { kind, quantity? | amount? }, reason, supersedes? }
 *   POST /occurrences/{Occurrence ID}/billing-overrides/{FOB-id}/remove   { reason }
 *   Expected / billable value only - never revenue received, never an invoice.
 *
 * F5 client invoice drafts + review (Finance read = GET, Finance manage = POST):
 *   GET  /invoicing/eligible?clientId=FCL-..&from=YYYY-MM-DD&to=YYYY-MM-DD   eligible, unclaimed work (<= 93 days)
 *   GET  /invoice-drafts?clientId=FCL-..            the client's drafts
 *   POST /invoice-drafts                            { clientId, from, to } -> draft built automatically from eligible work
 *   GET  /invoice-drafts/{FID-id}                   draft + lines + review (blockers / warnings)
 *   POST /invoice-drafts/{FID-id}/refresh           { reason? }  open Draft only
 *   POST /invoice-drafts/{FID-id}/details           { poNumber?, poOverrideReason?, paymentTermsDays?, reason? }
 *   POST /invoice-drafts/{FID-id}/ready             { revision, reason? }  blocked while any blocker remains
 *   POST /invoice-drafts/{FID-id}/reopen            { reason }  Ready for issue -> Draft
 *   POST /invoice-drafts/{FID-id}/lines/{FIL-id}/exclude       { reason }  this invoice only
 *   POST /invoice-drafts/{FID-id}/lines/{FIL-id}/restore       { reason? }
 *   POST /invoice-drafts/{FID-id}/lines/{FIL-id}/not-billable  { reason }  delegates to the F4 override
 *   Draft / Ready for issue only; issuing is F6 (below).
 *
 * F6 invoice issue + credit notes + corrections (Finance read = GET, Finance manage = POST):
 *   POST /invoice-drafts/{FID-id}/issue             { revision, reason? }  Ready draft -> immutable invoice
 *   GET  /invoices?clientId=FCL-..                  the client's invoices
 *   GET  /invoices/{FIV-id}                         invoice + lines + credit notes + links + history
 *   GET  /invoices/{FIV-id}/credit-notes            its credit notes
 *   POST /invoices/{FIV-id}/credit-notes            { lineIds?, reason }  credit whole lines (all remaining if omitted)
 *   GET  /credit-notes/{FCN-id}                     credit note + links
 *   POST /credit-notes/{FCN-id}/replacement-draft   { reason }  start the replacement draft (F5) for the credited work
 *   No sending, PDF, payment, overdue, Stripe or accounting-system routes here (payments + overdue: F7 below).
 *
 * F7 receivables + payments received + client credit (Finance read = GET, Finance manage = POST):
 *   GET  /receivables[?clientId=FCL-..][&asOf=YYYY-MM-DD]   issued invoices' derived receivable state + summary
 *   GET  /invoices/{FIV-id}/receivable[?asOf=]              one invoice: state + payments + credit applications + due date history
 *   GET  /invoices/{FIV-id}/payments                        payment history
 *   POST /invoices/{FIV-id}/payments                        { amount | settleRemaining: true, receivedDate, method?, reference?, reason? }  Mark as Received
 *   POST /invoices/{FIV-id}/due-date                        { dueDate, reason }  deliberate move (original kept)
 *   POST /payments/{FPY-id}/reverse                         { reason }  payment recorded in error (full amount)
 *   POST /payments/{FPY-id}/overpayment-credit              { amount, reason }  keep extra cash as client credit
 *   POST /credit-notes/{FCN-id}/client-credit               { amount, reason }  keep an already-paid correction as client credit
 *   GET  /clients/{FCL-id}/credits                          the client's credits
 *   GET  /client-credits/{FCC-id}                           one credit + its applications
 *   POST /client-credits/{FCC-id}/applications              { invoiceId, amount, reason? }  apply to the same client's issued invoice
 *   POST /client-credits/{FCC-id}/void                      { reason }  only while unapplied
 *   POST /client-credit-applications/{FCA-id}/reverse       { reason }  unapply
 *   GET  /receipts?from=YYYY-MM-DD&to=YYYY-MM-DD            trusted cash receipts (the Actual Revenue fact)
 *   No reminders, Xero / Stripe sync, Cash Flow, Month Report or Needs Attention routes (F8 / F9 / later).
 *
 * F9 Xero invoice connector (Finance read = GET, Finance manage = POST):
 *   GET  /xero/status[?check=1]                     connection + mapping readiness; check=1 also runs a live, read-only health check
 *   POST /xero/settings                             { accountCode?, taxTypes?, reason? }  non-secret mapping (audited)
 *   GET  /invoices/{FIV-id}/xero                    the invoice's Xero state (stage, official number, send state, last error)
 *   POST /invoices/{FIV-id}/xero-issue              { reason? }  Send / Issue via Xero: create (draft -> verify -> authorise), record Issued, send
 *   POST /invoices/{FIV-id}/xero-retry              { reason? }  safe retry: resume create / finish recording / re-send - never a second Xero invoice
 *   POST /clients/{FCL-id}/xero-contact             { contactId, reason }  link an existing Xero contact explicitly (never by name)
 *   Reaching Ready (F5) and the F6 freeze never contact Xero: only these explicit Management actions do.
 *
 * F10 Stripe READ connector (Finance read = GET, Finance manage = POST); Stripe stays the payment authority:
 *   GET  /stripe/status[?check=1]                   connection + readiness; check=1 also reads the Stripe account (read-only)
 *   GET  /stripe/subscriptions[?customer=cus_..]     every subscription (all statuses, all pages): Hub state + raw status, plan,
 *                                                   next EXPECTED collection, latest collection, customer -> parent mapping
 *   GET  /stripe/subscriptions/{sub_..}             one subscription + recent collections + Stripe's upcoming-invoice preview
 *   GET  /stripe/payments[?from&to][&customer]       charges in a local-date window (<= 93 days): receipt only when succeeded,
 *                                                   fee / net from Stripe's balance transaction only, refunds, failures
 *   GET  /stripe/refunds[?from&to]                  refunds already in Stripe (read only)
 *   POST /stripe/customers/{cus_..}/parent-link     { parentId, reason }  explicit customer -> Hub parent link (never by name / email)
 *   POST /stripe/settings                           { feeEstimate: { percentBasisPoints, fixedMinor } | null, reason? }  estimate for FUTURE charges
 *   No route creates, changes, cancels, retries or refunds anything in Stripe, or records a Stripe payment as an F7 Finance Payment.
 *
 * No auth -> 401. Coach / Parent / pending / inactive -> 403. The organisation
 * is ALWAYS the caller's own Supabase profile organisation_id - any
 * tenant-looking query parameter or body key is rejected with 400, never
 * ignored.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { type FinanceCaller, FINANCE_CONTRACT, buildAccessBody, checkEmptyBody, checkQueryKeys, isFinanceEligible, isTenantKey } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { parseUpdateBody } from "./finance-settings.ts";
import { type SettingsDeps, getFinanceSettings, updateFinanceSettings } from "./finance-settings-orchestrator.ts";
import {
  checkCommercialQuery,
  matchCommercialRoute,
  parseClientCreate,
  parseClientUpdate,
  parseInitialTerms,
  parseServiceCreate,
  parseServiceUpdate,
  parseTermsChange,
} from "./finance-commercial.ts";
import { type CommercialDeps, type WriteInput, readCommercial, writeCommercial } from "./finance-commercial-orchestrator.ts";
import { checkRangeQuery, matchBillingRoute, parseOverrideCreate, parseOverrideRemove } from "./finance-billing.ts";
import { readOccurrenceBilling, readSessionBilling, writeOverride } from "./finance-billing-orchestrator.ts";
import { checkInvoicingQuery, matchInvoicingRoute, parseDetails, parseDraftCreate, parseReady, parseReasonBody, parseTermsException } from "./finance-invoicing.ts";
import { listClientDrafts, markLineNotBillable, readDraft, readEligibleWork, writeDraft } from "./finance-invoicing-orchestrator.ts";
import { checkInvoiceListQuery, matchIssueRoute, parseCreditNote, parseIssue, parseReplacement } from "./finance-issue.ts";
import { createCreditNote, issueDraft, listInvoiceCreditNotes, listInvoices, readCreditNote, readInvoice, startReplacementDraft } from "./finance-issue-orchestrator.ts";
import { checkReceiptsQuery, checkReceivablesQuery, matchReceivablesRoute, parseApplication, parseCreditCreate, parseDueDateChange, parsePayment, parseRequiredReason } from "./finance-receivables.ts";
import { matchXeroRoute, parseContactLink, parseXeroAction, parseXeroSettings } from "./finance-xero.ts";
import { type XeroDeps, issueToXero, linkXeroContact, readXeroInvoiceState, readXeroStatus, updateXeroSettings } from "./finance-xero-orchestrator.ts";
import { matchStripeRoute, parseParentLink, parseStripeQuery, parseStripeSettings } from "./finance-stripe.ts";
import { type StripeDeps, linkStripeCustomer, listStripePayments, listStripeRefunds, listStripeSubscriptions, readStripeStatus, readStripeSubscription, updateStripeSettings } from "./finance-stripe-orchestrator.ts";
import {
  applyClientCredit,
  changeDueDate,
  creditFromCreditNote,
  creditFromOverpayment,
  listClientCredits,
  listInvoicePayments,
  listReceipts,
  listReceivables,
  readClientCredit,
  readReceivable,
  recordPayment,
  reverseApplication,
  reversePayment,
  voidClientCredit,
} from "./finance-receivables-orchestrator.ts";

const AIRTABLE_TOKEN = Deno.env.get("AIRTABLE_TOKEN")!;
const AIRTABLE_BASE_ID = Deno.env.get("AIRTABLE_BASE_ID")!;

// ---------------------------------------------------------------------
// TEST DEPLOYMENT GUARD. This copy runs only in the test Supabase
// project against the test Airtable base. If AIRTABLE_BASE_ID is ever a
// known production base, or SUPABASE_URL is the production project, the
// function refuses to start at all - a boot failure is loud and harmless,
// a Finance decision made against live data is not.
// ---------------------------------------------------------------------
const PRODUCTION_BASE_IDS: Record<string, string> = {
  apprptFotQuVL1mhs: "Josh Evans Hub - the live base",
  app6ex6UHY2RRO2Ak: "Master Copy - the template",
};
if (PRODUCTION_BASE_IDS[AIRTABLE_BASE_ID]) {
  throw new Error(
    `TEST function refusing to start: AIRTABLE_BASE_ID is ${AIRTABLE_BASE_ID} (${PRODUCTION_BASE_IDS[AIRTABLE_BASE_ID]}). ` +
      `A test deployment must never point at a production base.`
  );
}
if (!/^app[A-Za-z0-9]{14}$/.test(AIRTABLE_BASE_ID || "")) {
  throw new Error("TEST function refusing to start: AIRTABLE_BASE_ID is missing or malformed.");
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
/** Service role, used ONLY for public.finance_access_grants (read), public.finance_audit_events (append) and the finance_settings_locks / finance_write_locks RPCs - all RLS on, no client grants. */
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PRODUCTION_SUPABASE_REFS = ["bkkukymqaxawnudoxdjs"];
if (PRODUCTION_SUPABASE_REFS.some((ref) => (SUPABASE_URL || "").includes(ref))) {
  throw new Error("TEST function refusing to start: SUPABASE_URL is the production project.");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Same shape/logic as every other TEST function's resolveCaller() - copied, not shared, per the "each Edge Function is self-contained" convention. */
async function resolveCaller(authHeader: string | null): Promise<FinanceCaller | null> {
  if (!authHeader) return null;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return null;
  const { data: profile, error: profileError } = await userClient
    .from("profiles")
    .select("role, active, organisation_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileError || !profile) return null;
  return {
    userId: userData.user.id,
    role: typeof profile.role === "string" ? profile.role : null,
    active: profile.active === true,
    organisationId: typeof profile.organisation_id === "string" ? profile.organisation_id : null,
  };
}

const deps: SettingsDeps & CommercialDeps & XeroDeps & StripeDeps = {
  airtable: { baseId: AIRTABLE_BASE_ID, token: AIRTABLE_TOKEN },
  grants: { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY },
  // TEST DEPLOYMENT GUARD (F9): a live Xero connection must reach a Xero Demo Company - TEST never issues into a real Xero organisation.
  xero: { requireDemoTenant: true },
  // TEST DEPLOYMENT GUARD (F10): only a test-mode Stripe key / account is ever read here - never live payment data.
  stripe: { requireTestMode: true },
};

const ROUTES: Record<string, string[]> = { access: ["GET"], "write-check": ["POST"], settings: ["GET", "POST"] };

function commercialResponse(res: { status: string; httpStatus: number; body?: unknown; error?: string; code?: string; fields?: Record<string, string>; details?: Record<string, unknown> }) {
  if (res.status === "ok") return jsonResponse(res.body, res.httpStatus);
  return jsonResponse({ error: res.error, code: res.code, ...(res.fields ? { fields: res.fields } : {}), ...(res.details ? { details: res.details } : {}) }, res.httpStatus);
}

/** F3 routes: same order as F1/F2 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleCommercial(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchCommercialRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const query = checkCommercialQuery(url.searchParams, match.queryAllowed, isTenantKey);
  if (!query.ok) return jsonResponse({ error: query.error, code: query.code, ...(query.fields ? { fields: query.fields } : {}) }, 400);

  const r = match.route;
  if (req.method === "GET") return commercialResponse(await readCommercial(deps, caller, r, query.on));

  const raw = await req.text();
  let input: WriteInput;
  if (r.name === "clients.create") {
    const p = parseClientCreate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    input = { route: r.name, client: p.client, reason: p.reason };
  } else if (r.name === "client.update") {
    const p = parseClientUpdate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    input = { route: r.name, clientId: r.params.clientId, patch: p.patch, reason: p.reason };
  } else if (r.name === "services.create") {
    const p = parseServiceCreate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    input = { route: r.name, clientId: r.params.clientId, name: p.name, initial: p.initial, reason: p.reason };
  } else if (r.name === "service.update") {
    const p = parseServiceUpdate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    input = { route: r.name, serviceId: r.params.serviceId, patch: p.patch, effectiveFrom: p.effectiveFrom, reason: p.reason };
  } else if (r.name === "terms.create") {
    const p = parseInitialTerms(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    input = { route: r.name, serviceId: r.params.serviceId, req: p.req, reason: p.reason };
  } else if (r.name === "terms.change") {
    const p = parseTermsChange(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    input = { route: r.name, serviceId: r.params.serviceId, req: p.req, reason: p.reason };
  } else {
    return jsonResponse({ error: "Unknown route" }, 404);
  }
  return commercialResponse(await writeCommercial(deps, caller, input));
}

/** F4 routes: same order as F3 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleBilling(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchBillingRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const r = match.route;
  if (r.name === "session.billing") {
    const q = checkRangeQuery(url.searchParams, isTenantKey);
    if (!q.ok) return commercialResponse({ status: "error", ...q });
    return commercialResponse(await readSessionBilling(deps, caller, r.params.sessionId, q.from, q.to));
  }
  const query = checkCommercialQuery(url.searchParams, [], isTenantKey);
  if (!query.ok) return jsonResponse({ error: query.error, code: query.code, ...(query.fields ? { fields: query.fields } : {}) }, 400);
  if (r.name === "occurrence.billing") return commercialResponse(await readOccurrenceBilling(deps, caller, r.params.occurrenceId));
  const raw = await req.text();
  if (r.name === "override.create") {
    const p = parseOverrideCreate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await writeOverride(deps, caller, { route: "override.create", occurrenceId: r.params.occurrenceId, req: p.req }));
  }
  const p = parseOverrideRemove(raw, isTenantKey);
  if (!p.ok) return commercialResponse({ status: "error", ...p });
  return commercialResponse(await writeOverride(deps, caller, { route: "override.remove", occurrenceId: r.params.occurrenceId, overrideId: r.params.overrideId, reason: p.reason }));
}

/** F5 routes: same order as F3/F4 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleInvoicing(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchInvoicingRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const r = match.route;
  if (r.name === "eligible.read" || r.name === "drafts.list") {
    const q = checkInvoicingQuery(url.searchParams, r.name === "eligible.read", isTenantKey);
    if (!q.ok) return commercialResponse({ status: "error", ...q });
    if (r.name === "eligible.read") return commercialResponse(await readEligibleWork(deps, caller, q.clientId, q.from, q.to));
    return commercialResponse(await listClientDrafts(deps, caller, q.clientId));
  }
  const query = checkCommercialQuery(url.searchParams, [], isTenantKey);
  if (!query.ok) return jsonResponse({ error: query.error, code: query.code, ...(query.fields ? { fields: query.fields } : {}) }, 400);
  if (r.name === "draft.read") return commercialResponse(await readDraft(deps, caller, r.params.draftId));
  const raw = await req.text();
  if (r.name === "draft.create") {
    const p = parseDraftCreate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await writeDraft(deps, caller, { route: "draft.create", req: p.req }));
  }
  if (r.name === "draft.details") {
    const p = parseDetails(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await writeDraft(deps, caller, { route: "draft.details", draftId: r.params.draftId, req: p.req }));
  }
  if (r.name === "draft.ready") {
    const p = parseReady(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await writeDraft(deps, caller, { route: "draft.ready", draftId: r.params.draftId, revision: p.revision, reason: p.reason }));
  }
  if (r.name === "draft.terms_exception") {
    const p = parseTermsException(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await writeDraft(deps, caller, { route: "draft.terms_exception", draftId: r.params.draftId, occurrenceIds: p.occurrenceIds, reason: p.reason }));
  }
  const required = r.name === "draft.reopen" || r.name === "line.exclude" || r.name === "line.not_billable";
  const p = parseReasonBody(raw, required, isTenantKey);
  if (!p.ok) return commercialResponse({ status: "error", ...p });
  if (r.name === "draft.refresh") return commercialResponse(await writeDraft(deps, caller, { route: "draft.refresh", draftId: r.params.draftId, reason: p.reason }));
  if (r.name === "draft.reopen") return commercialResponse(await writeDraft(deps, caller, { route: "draft.reopen", draftId: r.params.draftId, reason: p.reason as string }));
  if (r.name === "line.exclude") return commercialResponse(await writeDraft(deps, caller, { route: "line.exclude", draftId: r.params.draftId, lineId: r.params.lineId, reason: p.reason as string }));
  if (r.name === "line.restore") return commercialResponse(await writeDraft(deps, caller, { route: "line.restore", draftId: r.params.draftId, lineId: r.params.lineId, reason: p.reason }));
  return commercialResponse(await markLineNotBillable(deps, caller, r.params.draftId, r.params.lineId, p.reason as string));
}

/** F6 routes: same order as F3-F5 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleIssue(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchIssueRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const r = match.route;
  if (r.name === "invoices.list") {
    const q = checkInvoiceListQuery(url.searchParams, isTenantKey);
    if (!q.ok) return commercialResponse({ status: "error", ...q });
    return commercialResponse(await listInvoices(deps, caller, q.clientId));
  }
  const query = checkCommercialQuery(url.searchParams, [], isTenantKey);
  if (!query.ok) return jsonResponse({ error: query.error, code: query.code, ...(query.fields ? { fields: query.fields } : {}) }, 400);
  if (r.name === "invoice.read") return commercialResponse(await readInvoice(deps, caller, r.params.invoiceId));
  if (r.name === "invoice.credit_notes") return commercialResponse(await listInvoiceCreditNotes(deps, caller, r.params.invoiceId));
  if (r.name === "credit_note.read") return commercialResponse(await readCreditNote(deps, caller, r.params.creditNoteId));
  const raw = await req.text();
  if (r.name === "draft.issue") {
    const p = parseIssue(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await issueDraft(deps, caller, r.params.draftId, p.revision, p.reason));
  }
  if (r.name === "invoice.credit_note_create") {
    const p = parseCreditNote(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await createCreditNote(deps, caller, r.params.invoiceId, p.lineIds, p.reason));
  }
  if (r.name !== "credit_note.replacement") return jsonResponse({ error: "Unknown route" }, 404);
  const p = parseReplacement(raw, isTenantKey);
  if (!p.ok) return commercialResponse({ status: "error", ...p });
  return commercialResponse(await startReplacementDraft(deps, caller, r.params.creditNoteId, p.reason));
}

/** F7 routes: same order as F3-F6 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleReceivables(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchReceivablesRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const r = match.route;
  if (r.name === "receivables.list" || r.name === "invoice.receivable") {
    const q = checkReceivablesQuery(url.searchParams, r.name === "receivables.list", isTenantKey);
    if (!q.ok) return commercialResponse({ status: "error", ...q });
    if (r.name === "receivables.list") return commercialResponse(await listReceivables(deps, caller, q.clientId, q.asOf));
    return commercialResponse(await readReceivable(deps, caller, r.params.invoiceId, q.asOf));
  }
  if (r.name === "receipts.list") {
    const q = checkReceiptsQuery(url.searchParams, isTenantKey);
    if (!q.ok) return commercialResponse({ status: "error", ...q });
    return commercialResponse(await listReceipts(deps, caller, q.from, q.to));
  }
  const query = checkCommercialQuery(url.searchParams, [], isTenantKey);
  if (!query.ok) return jsonResponse({ error: query.error, code: query.code, ...(query.fields ? { fields: query.fields } : {}) }, 400);
  if (r.name === "invoice.payments") return commercialResponse(await listInvoicePayments(deps, caller, r.params.invoiceId));
  if (r.name === "client.credits") return commercialResponse(await listClientCredits(deps, caller, r.params.clientId));
  if (r.name === "client_credit.read") return commercialResponse(await readClientCredit(deps, caller, r.params.creditId));
  const raw = await req.text();
  if (r.name === "invoice.payment_create") {
    const p = parsePayment(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await recordPayment(deps, caller, r.params.invoiceId, p.req));
  }
  if (r.name === "invoice.due_date") {
    const p = parseDueDateChange(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await changeDueDate(deps, caller, r.params.invoiceId, p.dueDate, p.reason));
  }
  if (r.name === "credit_note.client_credit" || r.name === "payment.overpayment_credit") {
    const p = parseCreditCreate(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    if (r.name === "credit_note.client_credit") return commercialResponse(await creditFromCreditNote(deps, caller, r.params.creditNoteId, p.amountMinor, p.reason));
    return commercialResponse(await creditFromOverpayment(deps, caller, r.params.paymentId, p.amountMinor, p.reason));
  }
  if (r.name === "client_credit.apply") {
    const p = parseApplication(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await applyClientCredit(deps, caller, r.params.creditId, p.invoiceId, p.amountMinor, p.reason));
  }
  const p = parseRequiredReason(raw, isTenantKey, r.name === "client_credit.void" ? "voided" : "reversed");
  if (!p.ok) return commercialResponse({ status: "error", ...p });
  if (r.name === "payment.reverse") return commercialResponse(await reversePayment(deps, caller, r.params.paymentId, p.reason));
  if (r.name === "client_credit.void") return commercialResponse(await voidClientCredit(deps, caller, r.params.creditId, p.reason));
  if (r.name === "application.reverse") return commercialResponse(await reverseApplication(deps, caller, r.params.applicationId, p.reason));
  return jsonResponse({ error: "Unknown route" }, 404);
}

/** F9 routes: same order as F3-F7 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleXero(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchXeroRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const r = match.route;
  const keys = [...url.searchParams.keys()];
  if (r.name === "xero.status") {
    if (keys.some(isTenantKey)) return jsonResponse({ error: "The organisation is taken from your profile and cannot be chosen in the request", code: "tenant_param_rejected" }, 400);
    if (keys.some((k) => k !== "check") || keys.length > 1) return jsonResponse({ error: `Unexpected query parameter(s): ${keys.filter((k) => k !== "check").join(", ") || "check (repeated)"}`, code: "unexpected_parameter" }, 400);
    const c = url.searchParams.get("check");
    if (c !== null && !["1", "true", "0", "false"].includes(c)) return jsonResponse({ error: "check must be 1 / true / 0 / false", code: "invalid_query" }, 400);
    return commercialResponse(await readXeroStatus(deps, caller, c === "1" || c === "true"));
  }
  const q = checkQueryKeys(keys);
  if (!q.ok) return jsonResponse({ error: q.error, code: q.code }, 400);
  if (r.name === "invoice.xero_state") return commercialResponse(await readXeroInvoiceState(deps, caller, r.params.invoiceId));
  const raw = await req.text();
  if (r.name === "xero.settings") {
    const p = parseXeroSettings(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await updateXeroSettings(deps, caller, p));
  }
  if (r.name === "client.xero_contact") {
    const p = parseContactLink(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await linkXeroContact(deps, caller, r.params.clientId, p.contactId, p.reason));
  }
  const p = parseXeroAction(raw, isTenantKey);
  if (!p.ok) return commercialResponse({ status: "error", ...p });
  return commercialResponse(await issueToXero(deps, caller, r.params.invoiceId, r.name === "invoice.xero_issue" ? "issue" : "retry", p.reason));
}

/** F10 routes: same order as F3-F9 - 404/405, 401, 403 management_required, 400 query/body, then authorisation inside the orchestrator. */
async function handleStripe(req: Request, url: URL, match: NonNullable<ReturnType<typeof matchStripeRoute>>): Promise<Response> {
  if (match.status === "not_found") return jsonResponse({ error: "Unknown route" }, 404);
  if (match.status === "method") return jsonResponse({ error: `Method not allowed - use ${match.allowed.join(" or ")}` }, 405);
  const caller = await resolveCaller(req.headers.get("Authorization"));
  if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
  if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);
  const r = match.route;
  const q = parseStripeQuery(r.name, url.searchParams, isTenantKey);
  if (!q.ok) return commercialResponse({ status: "error", ...q });
  if (r.name === "stripe.status") return commercialResponse(await readStripeStatus(deps, caller, q.check === true));
  if (r.name === "stripe.subscriptions") return commercialResponse(await listStripeSubscriptions(deps, caller, { customer: q.customer }));
  if (r.name === "stripe.subscription") return commercialResponse(await readStripeSubscription(deps, caller, r.params.subscriptionId));
  if (r.name === "stripe.payments") return commercialResponse(await listStripePayments(deps, caller, { from: q.from, to: q.to, customer: q.customer }));
  if (r.name === "stripe.refunds") return commercialResponse(await listStripeRefunds(deps, caller, { from: q.from, to: q.to }));
  const raw = await req.text();
  if (r.name === "stripe.settings") {
    const p = parseStripeSettings(raw, isTenantKey);
    if (!p.ok) return commercialResponse({ status: "error", ...p });
    return commercialResponse(await updateStripeSettings(deps, caller, p));
  }
  const p = parseParentLink(raw, isTenantKey);
  if (!p.ok) return commercialResponse({ status: "error", ...p });
  return commercialResponse(await linkStripeCustomer(deps, caller, r.params.customerId, p.parentId, p.reason));
}

/** Path segments URL-decoded (an Occurrence ID contains ":"); null when a segment is not valid percent-encoding. */
function decodedPath(route: string): string | null {
  try {
    return route.split("/").map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/finance\/?/, "").replace(/\/$/, "");

  try {
    const decoded = decodedPath(route);
    if (decoded === null) return jsonResponse({ error: "Unknown route" }, 404);
    // F10 first: it owns only stripe/..., and returns null for the rest.
    const stripe = matchStripeRoute(route, req.method);
    if (stripe) return await handleStripe(req, url, stripe);

    // F9 next: it owns only xero/..., invoices/{id}/xero[-*] and clients/{id}/xero-contact, and returns null for the rest.
    const xero = matchXeroRoute(route, req.method);
    if (xero) return await handleXero(req, url, xero);

    // F7 next: it owns only its own sub-paths (invoices/{id}/payments, clients/{id}/credits, ...) and returns null for the rest.
    const receivables = matchReceivablesRoute(route, req.method);
    if (receivables) return await handleReceivables(req, url, receivables);

    // F6 next: invoice-drafts/{id}/issue is F6's, every other invoice-drafts path stays F5's.
    const issue = matchIssueRoute(route, req.method);
    if (issue) return await handleIssue(req, url, issue);

    const invoicing = matchInvoicingRoute(route, req.method);
    if (invoicing) return await handleInvoicing(req, url, invoicing);

    const billing = matchBillingRoute(decoded, req.method);
    if (billing) return await handleBilling(req, url, billing);

    const commercial = matchCommercialRoute(route, req.method);
    if (commercial) return await handleCommercial(req, url, commercial);

    const methods = ROUTES[route];
    if (!methods) return jsonResponse({ error: `Unknown route: ${route}` }, 404);
    if (!methods.includes(req.method)) return jsonResponse({ error: `Method not allowed - use ${methods.join(" or ")}` }, 405);
    const caller = await resolveCaller(req.headers.get("Authorization"));
    if (!caller) return jsonResponse({ error: "Missing or invalid Authorization header" }, 401);
    if (!isFinanceEligible(caller).ok) return jsonResponse({ error: "Management access required", code: "management_required" }, 403);

    const query = checkQueryKeys([...url.searchParams.keys()]);
    if (!query.ok) return jsonResponse({ error: query.error, code: query.code }, 400);

    if (route === "write-check") {
      const body = checkEmptyBody(await req.text());
      if (!body.ok) return jsonResponse({ error: body.error, code: body.code }, 400);
      const out = await authorizeFinance(deps, caller, "manage");
      if (out.status !== "ok") return jsonResponse({ error: out.error, code: out.code }, out.httpStatus);
      return jsonResponse({ contract: FINANCE_CONTRACT, action: "manage", authorized: true, persisted: false }, 200);
    }

    if (route === "settings" && req.method === "POST") {
      const parsed = parseUpdateBody(await req.text(), isTenantKey);
      if (!parsed.ok) return jsonResponse({ error: parsed.error, code: parsed.code, ...(parsed.fields ? { fields: parsed.fields } : {}) }, 400);
      const res = await updateFinanceSettings(deps, caller, parsed);
      if (res.status !== "ok") return jsonResponse({ error: res.error, code: res.code, ...(res.fields ? { fields: res.fields } : {}) }, res.httpStatus);
      return jsonResponse(res.body, 200);
    }

    if (route === "settings") {
      const res = await getFinanceSettings(deps, caller);
      if (res.status !== "ok") return jsonResponse({ error: res.error, code: res.code }, res.httpStatus);
      return jsonResponse(res.body, 200);
    }

    const out = await authorizeFinance(deps, caller, "read");
    if (out.status !== "ok") return jsonResponse({ error: out.error, code: out.code }, out.httpStatus);
    return jsonResponse(buildAccessBody(out.organisation, out.access), 200);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: "Unexpected error" }, 500);
  }
});
