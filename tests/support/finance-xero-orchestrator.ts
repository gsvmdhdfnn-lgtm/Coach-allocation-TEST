/**
 * Test-suite copy of the canonical finance/finance-xero-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts.
 */
/**
 * Xero invoice connector - orchestration (Finance Foundation F9; see
 * TEST-ENV.md "Finance Foundation - F9"). Every route authorises through
 * F1's authorizeFinance() first: View reads, Manage writes.
 *
 * "Send / Issue via Xero" (POST /invoices/{id}/xero-issue, and the safe
 * /xero-retry) is the ONLY path that contacts Xero for an invoice. It is a
 * separate, explicit Management action: reaching Ready (F5) and freezing
 * the invoice (F6, "Awaiting external issue") never call Xero.
 *
 * Under the per-organisation Finance write lock (the lock every Finance
 * write takes - two requests for one invoice can never both run), it
 * resumes the invoice's connector journal from wherever it stopped:
 *
 *   0. preconditions (no external call): Xero-numbered, awaiting (or issued
 *      and unsent, for a send retry), no Hub-only credit notes, connected,
 *      account + every line's VAT mapped.
 *   1. preflight reads: Xero organisation (TEST: must be a DEMO company),
 *      the sales account, the tax types (each rate must equal the Hub's).
 *   2. contact: the linked one; else the one whose ContactNumber is the Hub
 *      client id; else create it (Name + ContactNumber + frozen billing
 *      email). NEVER matched by name. Its email is set to the invoice's
 *      frozen billing email so Xero sends to the address that was reviewed.
 *   3. create (stage creating): if an earlier attempt's outcome is unknown,
 *      look the invoice up in Xero first (its Reference carries the FIV);
 *      otherwise audit the request, then create a DRAFT with a stable
 *      Idempotency-Key. The Xero id is journaled the moment it is known.
 *   4. verify (draft_created): the draft must equal the frozen invoice
 *      exactly; if not, it is deleted in Xero and nothing is issued. Then
 *      authorise it - Xero assigns the official number.
 *   5. record (created): ONE Airtable patch moves the Hub invoice to Issued
 *      with Xero's id / number / dates / status (due date = Xero's issue
 *      date + the FROZEN terms - verified against Xero), audited in one
 *      insert, undone if the audit fails.
 *   6. send (issued): Xero emails it. A send failure never undoes the issue
 *      and a retry only re-sends the SAME Xero invoice.
 *
 * Never two Xero invoices for one Hub invoice: the lock, the journal's
 * primary key + optimistic version, the stable Idempotency-Keys and the
 * look-up-before-recreate rule each prevent it on their own.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { TABLES } from "./finance-commercial-mapping.ts";
import { clientFromRow } from "./finance-commercial-mapping.ts";
import { acquireWriteLock, insertAuditEvents, listForOrganisation, releaseWriteLock } from "./finance-commercial-repository.ts";
import { DraftTxn } from "./finance-invoicing-orchestrator.ts";
import { type Invoice, isIssued, publicInvoice } from "./finance-issue.ts";
import { FV, ISSUE_TABLES } from "./finance-issue-mapping.ts";
import { type IssueDeps, loadInvoice } from "./finance-issue-orchestrator.ts";
import {
  type ContactLink,
  type ExpectedInvoice,
  type InvoiceLink,
  type Problem,
  type SettingsChange,
  type XeroConnection,
  type XeroInvoice,
  ENTITY_CLIENT,
  ENTITY_CONNECTION,
  ENTITY_INVOICE,
  PROVIDER_LABEL,
  XERO_CONTRACT,
  XERO_EVENTS,
  auditLink,
  authoriseKey,
  connectionProblems,
  contactEmailKey,
  contactKey,
  createKey,
  discardKey,
  expectedInvoice,
  invoiceKeyBase,
  invoiceMismatches,
  mappingProblems,
  parseXeroContact,
  parseXeroInvoice,
  publicConfig,
  publicConnection,
  publicXeroState,
  sendKey,
  taxKeyOf,
  xeroAuditEvent,
  xeroInvoicePayload,
} from "./finance-xero.ts";
import { type ProviderFail, type XeroEndpoints, type XeroProvider, endpointsFor, httpXeroProvider, outcomeUnknown } from "./finance-xero-provider.ts";
import {
  deleteContactLink,
  insertContactLink,
  insertInvoiceLink,
  loadConnection,
  loadContactLinks,
  loadInvoiceLink,
  readClientSecret,
  recordConnectionOutcome,
  saveConfig,
  updateInvoiceLink,
} from "./finance-xero-repository.ts";

export interface XeroDeps extends IssueDeps {
  xero?: {
    /** TEST deployment guard: a live connection must reach a Xero DEMO company (never a real organisation). Default true. */
    requireDemoTenant?: boolean;
    timeoutMs?: number;
    endpoints?: (environment: XeroConnection["environment"]) => XeroEndpoints;
  };
}

export type XFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 502 | 503; code: string; error: string; fields?: Record<string, string>; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
const fail = (httpStatus: XFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): XFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is XFail => !!x && typeof x === "object" && (x as any).status === "error";

const now = (deps: XeroDeps) => (deps.clock ?? (() => new Date()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_xero_unavailable", "The Xero connection details could not be loaded just now - try again");
/** The Airtable field F9 adds to Finance Invoices: Xero's own status for the invoice, kept apart from the Hub status. */
export const EXTERNAL_STATUS_FIELD = "External Status";
const LIVE_XERO_STATUSES = ["AUTHORISED", "SUBMITTED", "PAID"];

function providerFor(deps: XeroDeps, conn: XeroConnection, secret: string): XeroProvider {
  const endpoints = deps.xero?.endpoints ? deps.xero.endpoints(conn.environment) : endpointsFor(conn.environment, deps.grants.supabaseUrl);
  return httpXeroProvider({ endpoints, clientId: conn.clientId, clientSecret: secret, tenantId: conn.tenantId, timeoutMs: deps.xero?.timeoutMs });
}

/** A provider failure in Management's words (codes stay machine-readable). */
export function providerFailure(f: ProviderFail, doing: string): XFail {
  const v = f.validation.length ? { validation: f.validation } : undefined;
  if (f.kind === "unauthorised") return fail(409, "xero_connection_rejected", `Xero no longer accepts this organisation's connection while ${doing} - it needs reconnecting. Nothing was issued.`);
  if (f.kind === "forbidden") return fail(409, "xero_permission_missing", `The Xero connection is not allowed to do this (${doing}) - check the connection's permissions. ${f.message}`);
  if (f.kind === "rate_limited") return fail(503, "xero_rate_limited", `Xero is busy (rate limit) while ${doing} - try again in a minute`);
  if (f.kind === "rejected") return fail(409, "xero_rejected", `Xero refused this while ${doing}: ${f.message}`, v);
  if (f.kind === "not_found") return fail(409, "xero_record_missing", `Xero could not find a record it needed while ${doing}`);
  if (f.kind === "malformed") return fail(502, "xero_response_invalid", `Xero answered in a way the Hub could not read while ${doing} - try again`);
  return fail(503, "xero_unavailable", `Xero did not respond while ${doing} - try again in a moment`);
}

// ---------------------------------------------------------------------
// Status (View) + live health check
// ---------------------------------------------------------------------

type Preflight = { ok: true; organisation: { name: string | null; class: string | null; isDemo: boolean }; problems: Problem[]; taxChecks: Record<string, unknown>[]; accountCheck: Record<string, unknown> } | { ok: false; fail: XFail };

/** Reads only: organisation (+ TEST demo guard), account code, tax types vs the Hub's rates. */
async function preflight(deps: XeroDeps, p: XeroProvider, conn: XeroConnection, keys: string[]): Promise<Preflight> {
  const org = await p.organisation();
  if (!org.ok) return { ok: false, fail: providerFailure(org, "checking the Xero organisation") };
  const o = org.value;
  const klass = typeof o.Class === "string" ? o.Class : null;
  const isDemo = klass === "DEMO";
  const organisation = { name: typeof o.Name === "string" ? o.Name : null, class: klass, isDemo };
  if ((deps.xero?.requireDemoTenant ?? true) && !isDemo) {
    return { ok: false, fail: fail(409, "xero_tenant_not_test", `This TEST Hub is connected to the Xero organisation "${organisation.name ?? "?"}", which is not a Xero Demo Company. TEST must never issue into a real Xero organisation - nothing was sent. Disconnect it.`, { organisation }) };
  }
  if (o.BaseCurrency && o.BaseCurrency !== "GBP") return { ok: false, fail: fail(409, "xero_currency_mismatch", `The Xero organisation's base currency is ${o.BaseCurrency}; Hub invoices are GBP`) };
  const [acc, tax] = await Promise.all([p.accounts(), p.taxRates()]);
  if (!acc.ok) return { ok: false, fail: providerFailure(acc, "checking the Xero sales account") };
  if (!tax.ok) return { ok: false, fail: providerFailure(tax, "checking the Xero tax rates") };
  const problems: Problem[] = [];
  const code = conn.config.accountCode;
  const account = code ? acc.value.find((a) => a?.Code === code) : undefined;
  const accountCheck = { accountCode: code, found: !!account, status: account?.Status ?? null, type: account?.Type ?? null };
  if (code && (!account || account.Status !== "ACTIVE")) problems.push({ code: "xero_account_code_invalid", message: `Xero has no active account with code ${code}` });
  const taxChecks = keys.map((k) => {
    const t = conn.config.taxTypes[k];
    const rate = tax.value.find((r) => r?.TaxType === t);
    const xeroRate = rate ? Number(rate.EffectiveRate ?? rate.DisplayTaxRate) : null;
    const hubRate = k === "no_vat" ? 0 : Number(k.slice(5)) / 100;
    const matches = !!rate && rate.Status === "ACTIVE" && xeroRate !== null && Math.abs(xeroRate - hubRate) < 1e-9;
    if (t && !matches) problems.push({ code: "xero_tax_type_invalid", message: rate ? `Xero tax type ${t} is ${xeroRate}% (${rate.Status}) but the Hub charges ${hubRate}% on ${k}` : `Xero has no tax type ${t} (mapped for ${k})` });
    return { key: k, taxType: t ?? null, found: !!rate, xeroRatePercent: xeroRate, hubRatePercent: hubRate, matches };
  });
  return { ok: true, organisation, problems, taxChecks, accountCheck };
}

export async function readXeroStatus(deps: XeroDeps, caller: FinanceCaller, check: boolean): Promise<Ok | XFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let conn: XeroConnection | null;
  try {
    conn = await loadConnection(deps.grants, org.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const problems = connectionProblems(conn);
  const body: Record<string, unknown> = {
    contract: XERO_CONTRACT,
    organisation: orgBody(org),
    access: auth.access,
    connection: publicConnection(conn),
    settings: conn ? publicConfig(conn.config) : null,
    readiness: { ready: problems.length === 0, problems },
  };
  if (!check) return { status: "ok", httpStatus: 200, body };
  if (!conn || conn.status !== "connected") return { status: "ok", httpStatus: 200, body: { ...body, check: { ran: false, reason: "not_connected" } } };
  let secret: string | null;
  try {
    secret = await readClientSecret(deps.grants, org.organisationId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!secret) return { status: "ok", httpStatus: 200, body: { ...body, check: { ran: false, reason: "secret_missing" } } };
  const p = providerFor(deps, conn, secret);
  const at = now(deps).toISOString();
  const cs = await p.connections();
  let pf: Preflight;
  let tenant: { tenantId: string; tenantName: string | null } | null = null;
  if (!cs.ok) pf = { ok: false, fail: providerFailure(cs, "checking the connection") };
  else if (cs.value.length !== 1) pf = { ok: false, fail: fail(409, "xero_tenant_ambiguous", `The connection reaches ${cs.value.length} Xero organisations - it must reach exactly one`) };
  else if (conn.tenantId && cs.value[0].tenantId !== conn.tenantId) pf = { ok: false, fail: fail(409, "xero_tenant_changed", "The connection now reaches a different Xero organisation than the one recorded - reconnect it deliberately") };
  else {
    tenant = cs.value[0];
    pf = await preflight(deps, p, conn, Object.keys(conn.config.taxTypes).sort());
  }
  try {
    if (pf.ok && !pf.problems.length) await recordConnectionOutcome(deps.grants, org.organisationId, { ok: true, at, ...(tenant && !conn.tenantId ? { tenantId: tenant.tenantId, tenantName: tenant.tenantName } : {}) });
    else if (!pf.ok) await recordConnectionOutcome(deps.grants, org.organisationId, { ok: false, at, code: pf.fail.code, message: pf.fail.error });
  } catch (e) {
    console.error("Xero health bookkeeping failed", e);
  }
  const check_ = pf.ok
    ? { ran: true, ok: pf.problems.length === 0, at, tenant, organisation: pf.organisation, account: pf.accountCheck, taxTypes: pf.taxChecks, problems: pf.problems, calls: p.callLog().length }
    : { ran: true, ok: false, at, tenant, error: { code: pf.fail.code, message: pf.fail.error }, calls: p.callLog().length };
  return { status: "ok", httpStatus: 200, body: { ...body, check: check_ } };
}

// ---------------------------------------------------------------------
// Writes share the Finance write lock
// ---------------------------------------------------------------------

async function withLock(deps: XeroDeps, caller: FinanceCaller, run: (org: OrganisationContext) => Promise<Ok | XFail>): Promise<Ok | XFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_xero_unavailable", "The change could not be made just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    return await run(org);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_xero_unavailable", "The request could not be completed just now - try again (retrying is always safe)");
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

/** POST /xero/settings - the non-secret mapping (sales account + tax types). Audited; no change = no write. */
export function updateXeroSettings(deps: XeroDeps, caller: FinanceCaller, change: SettingsChange): Promise<Ok | XFail> {
  return withLock(deps, caller, async (org) => {
    const conn = await loadConnection(deps.grants, org.organisationId);
    if (!conn) return fail(409, "xero_not_connected", "Xero is not connected for this organisation - it must be connected before its settings can be chosen");
    const before = publicConfig(conn.config);
    const accountCode = change.accountCode !== undefined ? change.accountCode : conn.config.accountCode;
    const sorted = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b)));
    const taxTypes = sorted(change.taxTypes !== undefined ? change.taxTypes : conn.config.taxTypes);
    const same = accountCode === conn.config.accountCode && JSON.stringify(taxTypes) === JSON.stringify(sorted(conn.config.taxTypes));
    if (same) return { status: "ok", httpStatus: 200, body: { contract: XERO_CONTRACT, organisation: orgBody(org), access: "manage", changed: false, settings: before } };
    const at = now(deps).toISOString();
    if (!(await saveConfig(deps.grants, org.organisationId, conn.config.revision, { accountCode, taxTypes, at, by: caller.userId }))) return fail(409, "finance_commercial_busy", "The Xero settings were changed by someone else just now - reload and try again");
    const after = { accountCode, taxTypes, revision: conn.config.revision + 1, updatedAt: at };
    try {
      await insertAuditEvents(deps.grants, [xeroAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: XERO_EVENTS.settingsUpdated, entityType: ENTITY_CONNECTION, recordId: `${org.organisationId}:xero`, before, after, reason: change.reason, route: "POST /xero/settings" })]);
    } catch (e) {
      console.error(e);
      const undone = await saveConfig(deps.grants, org.organisationId, conn.config.revision + 1, { accountCode: conn.config.accountCode, taxTypes: conn.config.taxTypes, at, by: caller.userId }).catch(() => false);
      return undone ? fail(503, "finance_audit_unavailable", "The Xero settings could not be saved just now (they could not be recorded) - nothing was changed") : fail(500, "finance_xero_unaudited", "The Xero settings were saved but could not be recorded or undone - contact support");
    }
    return { status: "ok", httpStatus: 200, body: { contract: XERO_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, settings: after } };
  });
}

// ---------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------

type EvFn = (eventType: string, entityType: string, recordId: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason: string | null, context?: Record<string, unknown>) => ReturnType<typeof xeroAuditEvent>;

/** Links client -> Xero contact (unique both ways) and audits it; the link is removed again if the audit fails. */
async function linkContact(deps: XeroDeps, org: OrganisationContext, clientId: string, contact: { contactId: string; name: string }, method: ContactLink["method"], userId: string, at: string, ev: EvFn, reason: string | null, context: Record<string, unknown>): Promise<XFail | null> {
  const elsewhere = await loadContactLinks(deps.grants, org.organisationId, { xeroContactId: contact.contactId });
  if (elsewhere.some((l) => l.clientId !== clientId)) return fail(409, "xero_contact_linked_elsewhere", `The Xero contact "${contact.name}" is already linked to another Hub client (${elsewhere[0].clientId}) - one Xero contact never serves two clients`);
  if (elsewhere.some((l) => l.clientId === clientId)) return null;
  const ins = await insertContactLink(deps.grants, { organisationId: org.organisationId, clientId, xeroContactId: contact.contactId, method, linkedAt: at, linkedBy: userId });
  if (ins === "conflict") return fail(409, "xero_contact_linked_elsewhere", "This client or this Xero contact was linked by someone else just now - reload and try again");
  try {
    await insertAuditEvents(deps.grants, [ev(XERO_EVENTS.contactLinked, ENTITY_CLIENT, clientId, null, { xeroContactId: contact.contactId, xeroContactName: contact.name, method }, reason, context)]);
  } catch (e) {
    console.error(e);
    await deleteContactLink(deps.grants, org.organisationId, clientId, contact.contactId).catch((x) => console.error("contact link compensation failed", x));
    return fail(503, "finance_audit_unavailable", "The Xero contact could not be linked just now (it could not be recorded) - nothing was sent");
  }
  return null;
}

type ResolvedContact = { contactId: string; method: ContactLink["method"] | "existing_link"; created: boolean; emailUpdated: boolean };

/** The invoice client's Xero contact: linked, else matched by ContactNumber = Hub client id, else created. Never by name. */
async function resolveContact(deps: XeroDeps, org: OrganisationContext, p: XeroProvider, inv: Invoice, userId: string, at: string, ev: EvFn): Promise<ResolvedContact | XFail> {
  const links = await loadContactLinks(deps.grants, org.organisationId, { clientId: inv.clientId });
  let contact: ReturnType<typeof parseXeroContact> = null;
  let method: ResolvedContact["method"] = "existing_link";
  let created = false;
  if (links.length) {
    const c = await p.getContact(links[0].xeroContactId);
    if (!c.ok) return providerFailure(c, "reading the client's Xero contact");
    contact = c.value ? parseXeroContact(c.value) : null;
    if (!contact || contact.status === "ARCHIVED") return fail(409, "xero_contact_unavailable", `The Xero contact linked to ${inv.clientName} is missing or archived in Xero - restore it in Xero or link the right contact. Nothing was sent.`, { xeroContactId: links[0].xeroContactId });
  } else {
    const f = await p.findContactsByNumber(inv.clientId);
    if (!f.ok) return providerFailure(f, "looking for the client's Xero contact");
    const matches = f.value.map(parseXeroContact).filter((c) => c && c.contactNumber === inv.clientId) as NonNullable<ReturnType<typeof parseXeroContact>>[];
    if (matches.length > 1) return fail(409, "xero_contact_ambiguous", `Xero has ${matches.length} contacts carrying this client's Hub id - link the right one explicitly. Nothing was sent.`, { xeroContactIds: matches.map((m) => m.contactId) });
    if (matches.length === 1) {
      contact = matches[0];
      method = "matched_contact_number";
    } else {
      const c = await p.createContact({ name: inv.clientName, contactNumber: inv.clientId, email: inv.billingEmail }, contactKey(org.organisationId, inv.clientId));
      if (!c.ok) {
        if (c.kind === "rejected" && c.validation.concat(c.message).some((m) => /already (assigned|exists)|name.*(in use|taken|unique)/i.test(m))) {
          return fail(409, "xero_contact_name_conflict", `Xero already has a different contact called "${inv.clientName}". The Hub never links contacts by name - link the right Xero contact to this client explicitly, or rename one of them. Nothing was sent.`, { validation: c.validation });
        }
        return providerFailure(c, "creating the client's Xero contact");
      }
      contact = parseXeroContact(c.value);
      if (!contact) return fail(502, "xero_response_invalid", "Xero created the contact but its answer could not be read - try again (the Hub will find it by the client's id)");
      method = "created";
      created = true;
    }
    const l = await linkContact(deps, org, inv.clientId, contact, method as ContactLink["method"], userId, at, ev, null, { invoiceId: inv.invoiceId, created });
    if (l) return l;
  }
  let emailUpdated = false;
  if ((contact.email ?? "").toLowerCase() !== inv.billingEmail.toLowerCase()) {
    const u = await p.updateContactEmail(contact.contactId, inv.billingEmail, contactEmailKey(org.organisationId, inv.clientId, inv.billingEmail));
    if (!u.ok) return providerFailure(u, "setting the invoice's billing email on the Xero contact");
    emailUpdated = true;
  }
  return { contactId: contact.contactId, method, created, emailUpdated };
}

/** POST /clients/{id}/xero-contact - Management links an EXISTING Xero contact explicitly (the resolution for a name conflict). */
export function linkXeroContact(deps: XeroDeps, caller: FinanceCaller, clientId: string, contactId: string, reason: string): Promise<Ok | XFail> {
  return withLock(deps, caller, async (org) => {
    const rows = await listForOrganisation(deps.airtable, TABLES.clients, org.recordId);
    const parsed = rows.map(clientFromRow).find((c) => c.ok && c.stored.value.clientId === clientId);
    if (!parsed || !parsed.ok) return fail(404, "client_not_found", `No client ${clientId} in your organisation`);
    const client = parsed.stored.value;
    if ((await loadContactLinks(deps.grants, org.organisationId, { clientId })).length) return fail(409, "xero_contact_already_linked", `${client.name} is already linked to a Xero contact - nothing was changed`);
    const conn = await loadConnection(deps.grants, org.organisationId);
    if (connectionProblems(conn).some((p) => p.code === "xero_not_connected")) return fail(409, "xero_not_connected", "Xero is not connected for this organisation");
    const secret = await readClientSecret(deps.grants, org.organisationId);
    if (!secret) return fail(409, "xero_not_connected", "Xero is not connected for this organisation");
    const p = providerFor(deps, conn as XeroConnection, secret);
    const pf = await preflightOrg(deps, p);
    if (pf) return pf;
    const c = await p.getContact(contactId);
    if (!c.ok) return providerFailure(c, "reading the Xero contact");
    const contact = c.value ? parseXeroContact(c.value) : null;
    if (!contact) return fail(404, "xero_contact_not_found", "Xero has no contact with that id");
    if (contact.status === "ARCHIVED") return fail(409, "xero_contact_unavailable", "That Xero contact is archived");
    const at = now(deps).toISOString();
    const route = `POST /clients/${clientId}/xero-contact`;
    const ev: EvFn = (eventType, entityType, recordId, before, after, r, context = {}) => xeroAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, entityType, recordId, before, after, reason: r, route, context });
    const l = await linkContact(deps, org, clientId, contact, "linked_by_manager", caller.userId, at, ev, reason, { xeroContactNumber: contact.contactNumber });
    if (l) return l;
    return { status: "ok", httpStatus: 201, body: { contract: XERO_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, clientId, xeroContact: { contactId: contact.contactId, name: contact.name, method: "linked_by_manager" } } };
  });
}

/** Organisation-only preflight (TEST demo guard) for routes that do not need the mapping. */
async function preflightOrg(deps: XeroDeps, p: XeroProvider): Promise<XFail | null> {
  const org = await p.organisation();
  if (!org.ok) return providerFailure(org, "checking the Xero organisation");
  if ((deps.xero?.requireDemoTenant ?? true) && org.value.Class !== "DEMO") return fail(409, "xero_tenant_not_test", "This TEST Hub is connected to a Xero organisation that is not a Demo Company - nothing was done");
  return null;
}

// ---------------------------------------------------------------------
// The issued transition (one Airtable patch)
// ---------------------------------------------------------------------

/** Exactly the fields F9 changes on the invoice row: Hub status, Xero's dates / id / number / status, Issued At / By, revision. */
export function externalIssueFields(i: Invoice, externalStatus: string | null): Record<string, unknown> {
  const x = FV.invoice;
  return {
    [x.status]: i.status === "awaiting_external_issue" ? "Awaiting external issue" : "Issued",
    [x.date]: i.invoiceDate,
    [x.due]: i.dueDate,
    [x.issuedAt]: i.issuedAt,
    [x.issuedBy]: i.issuedBy,
    [x.extProvider]: i.externalProvider,
    [x.extId]: i.externalInvoiceId,
    [x.extNumber]: i.externalInvoiceNumber,
    [EXTERNAL_STATUS_FIELD]: externalStatus,
    [x.revision]: i.revision,
    [x.changedBy]: i.updatedBy,
    [x.changedAt]: i.updatedAt,
  };
}

// ---------------------------------------------------------------------
// Send / Issue via Xero (+ retry)
// ---------------------------------------------------------------------

export function issueToXero(deps: XeroDeps, caller: FinanceCaller, invoiceId: string, mode: "issue" | "retry", reason: string | null): Promise<Ok | XFail> {
  return withLock(deps, caller, (org) => runIssue(deps, caller, org, invoiceId, mode, reason));
}

async function runIssue(deps: XeroDeps, caller: FinanceCaller, org: OrganisationContext, invoiceId: string, mode: "issue" | "retry", reason: string | null): Promise<Ok | XFail> {
  const route = `POST /invoices/${invoiceId}/xero-${mode}`;
  const atDate = now(deps);
  const at = atDate.toISOString();
  const today = todayIn(org.timezone, atDate);
  const ev: EvFn = (eventType, entityType, recordId, before, after, r, context = {}) => xeroAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType, entityType, recordId, before, after, reason: r, route, context });
  const done = (httpStatus: 200 | 201, outcome: string, message: string, inv: Invoice, link: InvoiceLink, extra: Record<string, unknown> = {}): Ok => ({
    status: "ok",
    httpStatus,
    body: { contract: XERO_CONTRACT, organisation: orgBody(org), access: "manage", changed: true, outcome, message, invoice: publicInvoice(inv), xero: publicXeroState(link), ...extra },
  });

  const loaded = await loadInvoice(deps, org, invoiceId);
  if ("status" in loaded) return loaded;
  const l = loaded;
  let inv = l.invoice.value;
  if (inv.numberAuthority !== "xero") return fail(409, "xero_not_issue_authority", `${invoiceId} was issued in the Hub (official number ${inv.hubInvoiceNumber}) - it is not sent through Xero; nothing was sent`);
  let link = await loadInvoiceLink(deps.grants, org.organisationId, invoiceId);
  const journal = async (expected: InvoiceLink, patch: Partial<InvoiceLink>): Promise<InvoiceLink> => {
    const next = await updateInvoiceLink(deps.grants, expected, { ...patch, updatedAt: now(deps).toISOString() });
    if (!next) throw new BusyError();
    return next;
  };
  const errorPatch = (stage: string, code: string, message: string) => ({ lastErrorStage: stage, lastErrorCode: code, lastErrorMessage: message.slice(0, 500), lastErrorAt: at });
  const clearError = { lastErrorStage: null, lastErrorCode: null, lastErrorMessage: null, lastErrorAt: null };

  try {
    // ----- already issued: only a send retry is possible -----
    if (isIssued(inv)) {
      if (link && link.stage === "created" && link.xeroInvoiceId === inv.externalInvoiceId) link = await journal(link, { stage: "issued" }); // the journal missed its last step
      if (!link || link.stage !== "issued" || link.xeroInvoiceId !== inv.externalInvoiceId) return fail(409, "invoice_already_issued", `${invoiceId} is already issued (${inv.externalInvoiceNumber ?? "no Xero record"}) - nothing was sent to Xero`);
      if (mode === "issue") return fail(409, "invoice_already_issued", `${invoiceId} is already issued through Xero as ${inv.externalInvoiceNumber} - nothing was created or sent again`, { xero: publicXeroState(link) });
      if (link.sendStatus === "sent") return fail(409, "xero_nothing_to_retry", `${inv.externalInvoiceNumber} is issued and was already sent by Xero - there is nothing to retry`, { xero: publicXeroState(link) });
      const conn = await loadConnection(deps.grants, org.organisationId);
      const secret = conn?.status === "connected" ? await readClientSecret(deps.grants, org.organisationId) : null;
      if (!conn || !secret) return fail(409, "xero_not_connected", "Xero is not connected, so the invoice cannot be sent - reconnect Xero first");
      const p = providerFor(deps, conn, secret);
      const pf = await preflightOrg(deps, p);
      if (pf) return pf;
      const s = await send(p, link);
      if (s.sent) return done(200, "sent", `${inv.externalInvoiceNumber} was sent by Xero`, inv, s.link);
      return { ...fail(502, "xero_send_failed", `Xero did not send ${inv.externalInvoiceNumber}: ${s.message} The invoice is issued; retry to send it again - no new invoice will be created.`), details: { xero: publicXeroState(s.link) } };
    }

    // ----- awaiting external issue -----
    if (mode === "retry" && !link) return fail(409, "xero_issue_not_started", `${invoiceId} has not been sent to Xero yet - use Send / Issue via Xero`);
    if (link?.stage === "issued") return fail(409, "xero_issue_data_invalid", `${invoiceId} is awaiting in the Hub but its Xero journal says issued - the data must be corrected first; nothing was sent`);
    if (link?.stage === "needs_review") return fail(409, "xero_needs_review", `Xero holds invoice ${link.xeroInvoiceNumber ?? link.xeroInvoiceId} for ${invoiceId}, but it does not match the frozen Hub invoice - it needs reviewing in Xero; the Hub invoice stays awaiting`, { xero: publicXeroState(link) });
    if (l.notes.length) return fail(409, "xero_issue_has_credit_notes", `${invoiceId} carries Hub credit notes (${l.notes.map((n: { creditNoteId: string }) => n.creditNoteId).join(", ")}) from before Xero authority - sending it would make Xero and the Hub disagree. It needs Xero credit-note handling (not built yet); nothing was sent.`);
    const conn = await loadConnection(deps.grants, org.organisationId);
    const problems = connectionProblems(conn);
    if (conn && !problems.length) problems.push(...mappingProblems(conn, l.lines));
    if (problems.length) return fail(409, problems[0].code === "xero_not_connected" ? "xero_not_connected" : "xero_not_ready", `Xero is not ready for this invoice - ${problems.map((p) => p.message).join("; ")}. Nothing was sent.`, { problems });
    const c = conn as XeroConnection;
    if (link && link.environment !== c.environment) return fail(409, "xero_environment_changed", "This invoice was started against a different Xero connection - it needs reviewing; nothing was sent");
    const secret = await readClientSecret(deps.grants, org.organisationId);
    if (!secret) return fail(409, "xero_not_connected", "Xero is not connected for this organisation - nothing was sent");
    const p = providerFor(deps, c, secret);
    const pf = await preflight(deps, p, c, [...new Set(l.lines.map(taxKeyOf))].sort());
    if (!pf.ok || pf.problems.length) {
      const f = pf.ok ? fail(409, "xero_not_ready", `Xero is not ready for this invoice - ${pf.problems.map((x) => x.message).join("; ")}. Nothing was sent.`, { problems: pf.problems }) : pf.fail;
      await recordConnectionOutcome(deps.grants, org.organisationId, { ok: false, at, code: f.code, message: f.error }).catch((e) => console.error(e));
      return f;
    }
    await recordConnectionOutcome(deps.grants, org.organisationId, { ok: true, at }).catch((e) => console.error(e));

    // ----- journal -----
    if (!link) {
      link = await insertInvoiceLink(deps.grants, {
        organisationId: org.organisationId,
        invoiceId,
        clientId: inv.clientId,
        environment: c.environment,
        idempotencyKey: invoiceKeyBase(org.organisationId, invoiceId),
        generation: 1,
        stage: "creating",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroStatus: null,
        xeroContactId: null,
        xeroDate: null,
        xeroDueDate: null,
        createAttempts: 0,
        sendStatus: "not_sent",
        sendAttempts: 0,
        sendKeyGeneration: 1,
        sentAt: null,
        lastErrorStage: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        mismatches: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      if (!link) throw new BusyError();
    }

    // ----- contact -----
    const contact = await resolveContact(deps, org, p, inv, caller.userId, at, ev);
    if (isFail(contact)) {
      link = await journal(link, errorPatch("contact", contact.code, contact.error));
      return contact;
    }

    // The issue date is fixed by the first create attempt of this generation, so a repeated request is byte-identical (idempotent).
    const plannedDate = link.createAttempts > 0 && link.xeroDate ? link.xeroDate : today;
    let expected: ExpectedInvoice = expectedInvoice(inv, l.lines, c, contact.contactId, plannedDate);
    let xinv: XeroInvoice | null = null;
    let recovered = false;

    // ----- create (or find the earlier attempt's invoice) -----
    if (link.stage === "creating") {
      let raw: Record<string, any> | null = null;
      if (link.createAttempts > 0) {
        const found = await p.listContactInvoices(contact.contactId);
        if (!found.ok) {
          const f = providerFailure(found, "looking in Xero for the invoice an earlier attempt may have created");
          link = await journal(link, errorPatch("create", f.code, f.error));
          return f;
        }
        const mine = found.value.filter((x) => x?.Type === "ACCREC" && x?.Reference === expected.reference && x?.Status !== "DELETED" && x?.Status !== "VOIDED");
        if (mine.length > 1) {
          link = await journal(link, { stage: "needs_review", xeroInvoiceId: String(mine[0].InvoiceID).toLowerCase(), mismatches: [`Xero holds ${mine.length} invoices with reference ${expected.reference}`], ...errorPatch("create", "xero_duplicate_found", "More than one Xero invoice carries this invoice's reference") });
          return fail(409, "xero_duplicate_found", `Xero holds ${mine.length} invoices for ${invoiceId} - they need reviewing in Xero; nothing more was created`, { xeroInvoiceIds: mine.map((x) => x.InvoiceID) });
        }
        if (mine.length === 1) {
          raw = mine[0];
          recovered = true;
        }
      }
      if (!raw) {
        try {
          await insertAuditEvents(deps.grants, [ev(XERO_EVENTS.createRequested, ENTITY_INVOICE, invoiceId, null, { reference: expected.reference, invoiceDate: expected.date, dueDate: expected.dueDate, grossMinor: expected.grossMinor, lineCount: expected.lines.length }, reason, { attempt: link.createAttempts + 1, generation: link.generation, idempotencyKey: createKey(link), xeroContactId: contact.contactId, contactResolution: contact.method, contactCreated: contact.created, contactEmailUpdated: contact.emailUpdated, environment: c.environment })]);
        } catch (e) {
          console.error(e);
          return fail(503, "finance_audit_unavailable", "The request could not be recorded just now, so Xero was not contacted - nothing was sent");
        }
        link = await journal(link, { createAttempts: link.createAttempts + 1, xeroDate: plannedDate, xeroContactId: contact.contactId });
        const r = await p.createInvoice(xeroInvoicePayload(expected), createKey(link));
        if (!r.ok) {
          const unknown = outcomeUnknown(r);
          const f = unknown
            ? fail(503, "xero_create_outcome_unknown", `Xero did not confirm whether it created the invoice (${r.message}). Retry: the Hub will look for it in Xero first and will never create a second one. The Hub invoice stays awaiting.`)
            : providerFailure(r, "creating the invoice");
          link = await journal(link, errorPatch("create", f.code, f.error));
          await insertAuditEvents(deps.grants, [ev(unknown ? XERO_EVENTS.createOutcomeUnknown : XERO_EVENTS.createFailed, ENTITY_INVOICE, invoiceId, null, { code: f.code, message: f.error, providerStatus: r.status, validation: r.validation }, reason, { attempt: link.createAttempts, generation: link.generation })]).catch((e) => console.error(e));
          return f;
        }
        raw = r.value;
      }
      const parsed = parseXeroInvoice(raw);
      if (!parsed.ok) {
        link = await journal(link, errorPatch("create", "xero_response_invalid", parsed.error));
        return fail(502, "xero_response_invalid", `${parsed.error}. Retry: the Hub will look the invoice up in Xero; no second invoice will be created.`);
      }
      xinv = parsed.invoice;
      link = await journal(link, { stage: "draft_created", xeroInvoiceId: xinv.invoiceId, xeroStatus: xinv.status, xeroContactId: contact.contactId, ...clearError });
    }

    // ----- verify, then authorise -----
    if (link.stage === "draft_created") {
      if (!xinv) {
        const g = await p.getInvoice(link.xeroInvoiceId as string);
        if (!g.ok) {
          const f = providerFailure(g, "reading the Xero invoice");
          link = await journal(link, errorPatch("verify", f.code, f.error));
          return f;
        }
        const parsed = g.value ? parseXeroInvoice(g.value) : null;
        if (!parsed || !parsed.ok || parsed.invoice.status === "DELETED" || parsed.invoice.status === "VOIDED") {
          link = await journal(link, { stage: "needs_review", mismatches: ["The Xero invoice this Hub invoice was being created as is missing, deleted or voided in Xero"], ...errorPatch("verify", "xero_invoice_missing", "The Xero invoice is missing, deleted or voided") });
          return fail(409, "xero_needs_review", `The Xero invoice for ${invoiceId} is missing, deleted or voided in Xero - it needs reviewing; nothing was issued`, { xero: publicXeroState(link) });
        }
        xinv = parsed.invoice;
      }
      if (xinv.status === "DRAFT") {
        const mm = invoiceMismatches(xinv, expected);
        if (mm.length) {
          const d = await p.setInvoiceStatus(xinv.invoiceId, "DELETED", discardKey(link));
          if (!d.ok) {
            link = await journal(link, { mismatches: mm, ...errorPatch("verify", "xero_draft_cleanup_failed", `The Xero draft did not match and could not be deleted: ${d.message}`) });
            return fail(502, "xero_draft_cleanup_failed", `Xero did not reproduce ${invoiceId} exactly and its draft could not be deleted (${d.message}) - retry; nothing was issued`, { mismatches: mm });
          }
          const discarded = xinv.invoiceId;
          link = await journal(link, { stage: "creating", xeroInvoiceId: null, xeroStatus: null, generation: link.generation + 1, createAttempts: 0, xeroDate: null, mismatches: mm, ...errorPatch("verify", "xero_invoice_mismatch", "Xero did not reproduce the frozen invoice exactly") });
          await insertAuditEvents(deps.grants, [ev(XERO_EVENTS.draftDiscarded, ENTITY_INVOICE, invoiceId, null, { discardedXeroInvoiceId: discarded, mismatches: mm }, reason, { generation: link.generation - 1 })]).catch((e) => console.error(e));
          return fail(409, "xero_invoice_mismatch", `Xero did not reproduce ${invoiceId} exactly, so its draft was deleted in Xero and nothing was issued: ${mm.join("; ")}`, { mismatches: mm });
        }
        const a = await p.setInvoiceStatus(xinv.invoiceId, "AUTHORISED", authoriseKey(link));
        if (!a.ok) {
          const f = outcomeUnknown(a) ? fail(503, "xero_authorise_outcome_unknown", `Xero did not confirm the invoice was approved (${a.message}). Retry: the Hub will check it in Xero first.`) : providerFailure(a, "approving the invoice in Xero");
          link = await journal(link, errorPatch("authorise", f.code, f.error));
          return f;
        }
        const pa = parseXeroInvoice(a.value);
        if (!pa.ok) {
          link = await journal(link, errorPatch("authorise", "xero_response_invalid", pa.error));
          return fail(502, "xero_response_invalid", `${pa.error}. Retry: the Hub will re-read the invoice in Xero.`);
        }
        xinv = pa.invoice;
      }
      if (!LIVE_XERO_STATUSES.includes(xinv.status) || !xinv.number) {
        link = await journal(link, errorPatch("authorise", "xero_response_invalid", `Xero reports status ${xinv.status} and number ${xinv.number ?? "(none)"}`));
        return fail(502, "xero_response_invalid", `Xero did not confirm an approved invoice with an official number (status ${xinv.status}, number ${xinv.number ?? "none"}). Retry: the Hub will re-read it.`);
      }
      const mm = invoiceMismatches(xinv, expected);
      if (mm.length) {
        link = await journal(link, { stage: "needs_review", xeroStatus: xinv.status, xeroInvoiceNumber: xinv.number, mismatches: mm, ...errorPatch("verify", "xero_invoice_mismatch", "The approved Xero invoice does not match the frozen Hub invoice") });
        await insertAuditEvents(deps.grants, [ev(XERO_EVENTS.mismatchDetected, ENTITY_INVOICE, invoiceId, null, { xeroInvoiceId: xinv.invoiceId, xeroInvoiceNumber: xinv.number, mismatches: mm }, reason)]).catch((e) => console.error(e));
        return fail(409, "xero_needs_review", `Xero approved invoice ${xinv.number} but it does not match ${invoiceId} (${mm.join("; ")}) - it needs reviewing in Xero; the Hub invoice stays awaiting and nothing was sent`, { mismatches: mm });
      }
      link = await journal(link, { stage: "created", xeroInvoiceNumber: xinv.number, xeroStatus: xinv.status, xeroDate: xinv.date, xeroDueDate: xinv.dueDate, mismatches: null, ...clearError });
    }

    // ----- record: Awaiting external issue -> Issued (one patch + one audit insert) -----
    let transitioned = false;
    if (link.stage === "created") {
      const before = inv;
      const after: Invoice = {
        ...inv,
        status: "issued",
        invoiceDate: link.xeroDate,
        dueDate: link.xeroDueDate,
        issuedAt: at,
        issuedBy: caller.userId,
        externalProvider: PROVIDER_LABEL[link.environment],
        externalInvoiceId: link.xeroInvoiceId,
        externalInvoiceNumber: link.xeroInvoiceNumber,
        revision: inv.revision + 1,
        updatedBy: caller.userId,
        updatedAt: at,
      };
      const txn = new DraftTxn(deps);
      try {
        await txn.patch(ISSUE_TABLES.invoices, [{ id: l.invoice.recordId, fields: externalIssueFields(after, link.xeroStatus), restore: externalIssueFields(before, null) }]);
      } catch (e) {
        console.error(e);
        await txn.rollback();
        link = await journal(link, errorPatch("record", "xero_issue_recording_failed", "Xero created the invoice but the Hub could not record it yet"));
        return fail(503, "xero_issue_recording_failed", `Xero created invoice ${link.xeroInvoiceNumber}, but the Hub could not record it just now. Retry to finish - no second invoice will be created.`, { xero: publicXeroState(link) });
      }
      const events = [
        ...(recovered ? [ev(XERO_EVENTS.recovered, ENTITY_INVOICE, invoiceId, null, { xeroInvoiceId: link.xeroInvoiceId, reference: expected.reference }, reason, { generation: link.generation })] : []),
        ev(XERO_EVENTS.created, ENTITY_INVOICE, invoiceId, null, auditLink(link), reason, { environment: link.environment, providerLabel: PROVIDER_LABEL[link.environment] }),
        ev(
          XERO_EVENTS.issueConfirmed,
          ENTITY_INVOICE,
          invoiceId,
          { status: before.status, invoiceDate: null, dueDate: null, issuedAt: null, officialNumber: null, revision: before.revision },
          { status: after.status, invoiceDate: after.invoiceDate, dueDate: after.dueDate, issuedAt: after.issuedAt, officialNumber: after.externalInvoiceNumber, externalProvider: after.externalProvider, externalInvoiceId: after.externalInvoiceId, externalStatus: link.xeroStatus, paymentTermsDays: after.paymentTermsDays, revision: after.revision },
          reason,
          { receivable: true }
        ),
      ];
      try {
        await insertAuditEvents(deps.grants, events);
      } catch (e) {
        console.error(e);
        if (!(await txn.rollback())) return fail(500, "finance_invoices_unaudited", `Xero created ${link.xeroInvoiceNumber} and the Hub recorded it, but it could not be audited or undone - contact support before changing this invoice again`);
        link = await journal(link, errorPatch("record", "finance_audit_unavailable", "The Hub could not record the Xero invoice in the audit trail"));
        return fail(503, "finance_audit_unavailable", `Xero created invoice ${link.xeroInvoiceNumber}, but the Hub could not record it just now. Retry to finish - no second invoice will be created.`);
      }
      inv = after;
      transitioned = true;
      try {
        link = await journal(link, { stage: "issued", ...clearError });
      } catch (e) {
        console.error("Xero journal could not be advanced to issued (the next request repairs it)", e);
        return done(201, "issued_send_pending", `${link.xeroInvoiceNumber} is issued; Xero has not sent it yet - retry to send`, inv, { ...link, stage: "issued" });
      }
    }

    // ----- send -----
    const s = await send(p, link);
    if (s.sent) return done(transitioned ? 201 : 200, "issued_and_sent", `Issued through Xero as ${inv.externalInvoiceNumber} and sent by Xero to ${inv.billingEmail}`, inv, s.link, { delivery: { to: inv.billingEmail, ccNotSentByXero: inv.billingCcEmails } });
    return done(transitioned ? 201 : 200, "issued_send_failed", `Issued through Xero as ${inv.externalInvoiceNumber}, but Xero did not send it: ${s.message} Retry to send it - no new invoice will be created.`, inv, s.link);
  } catch (e) {
    if (e instanceof BusyError) return fail(409, "xero_issue_busy", `${invoiceId} is being sent to Xero by another request right now - wait a moment and reload`);
    throw e;
  }

  async function send(p: XeroProvider, lk: InvoiceLink): Promise<{ sent: boolean; link: InvoiceLink; message: string }> {
    const r = await p.emailInvoice(lk.xeroInvoiceId as string, sendKey(lk));
    if (r.ok) {
      const next = await journal(lk, { sendStatus: "sent", sentAt: now(deps).toISOString(), sendAttempts: lk.sendAttempts + 1, ...clearError });
      try {
        await insertAuditEvents(deps.grants, [ev(XERO_EVENTS.sent, ENTITY_INVOICE, invoiceId, { sendStatus: lk.sendStatus }, { sendStatus: "sent", sentAt: next.sentAt, xeroInvoiceNumber: lk.xeroInvoiceNumber, to: inv.billingEmail }, reason, { attempt: next.sendAttempts })]);
      } catch (e) {
        console.error("Xero send audit failed (the send happened and is journaled)", e);
      }
      return { sent: true, link: next, message: "" };
    }
    const unknown = outcomeUnknown(r);
    const message = unknown ? `Xero did not confirm the email (${r.message}).` : `${r.message}.`;
    // An unknown outcome keeps the SAME key, so a retry can never send twice; a definite failure moves to a fresh key.
    const next = await journal(lk, { sendStatus: "send_failed", sendAttempts: lk.sendAttempts + 1, sendKeyGeneration: unknown ? lk.sendKeyGeneration : lk.sendKeyGeneration + 1, ...errorPatch("send", unknown ? "xero_send_outcome_unknown" : "xero_send_failed", message) });
    await insertAuditEvents(deps.grants, [ev(XERO_EVENTS.sendFailed, ENTITY_INVOICE, invoiceId, { sendStatus: lk.sendStatus }, { sendStatus: "send_failed", xeroInvoiceNumber: lk.xeroInvoiceNumber, providerStatus: r.status, outcomeUnknown: unknown, validation: r.validation }, reason, { attempt: next.sendAttempts })]).catch((e) => console.error(e));
    return { sent: false, link: next, message };
  }
}

class BusyError extends Error {}

// ---------------------------------------------------------------------
// GET /invoices/{id}/xero (View)
// ---------------------------------------------------------------------

export async function readXeroInvoiceState(deps: XeroDeps, caller: FinanceCaller, invoiceId: string): Promise<Ok | XFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const l = await loadInvoice(deps, org, invoiceId);
  if ("status" in l) return l;
  let link: InvoiceLink | null;
  let conn: XeroConnection | null;
  try {
    [link, conn] = await Promise.all([loadInvoiceLink(deps.grants, org.organisationId, invoiceId), loadConnection(deps.grants, org.organisationId)]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  const inv = l.invoice.value;
  const p = publicInvoice(inv);
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: XERO_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      invoice: { invoiceId, status: p.status, statusLabel: p.statusLabel, numbering: p.numbering, external: p.external, receivable: p.receivable, invoiceDate: p.invoiceDate, dueDate: p.dueDate, totals: p.totals, client: { clientId: inv.clientId, name: inv.clientName, billingEmail: inv.billingEmail } },
      sentThroughXero: inv.numberAuthority === "xero",
      xero: inv.numberAuthority === "xero" ? publicXeroState(link) : null,
      connection: publicConnection(conn),
    },
  };
}
