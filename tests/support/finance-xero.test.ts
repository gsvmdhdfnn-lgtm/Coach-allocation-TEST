/**
 * Finance Foundation F9 - Xero invoice connector.
 * Run: node --experimental-strip-types tests/support/finance-xero.test.ts
 *
 *   LC  lifecycle (awaiting -> issued only after Xero creates it; F7 receivable after)
 *   MP  mapping (frozen lines, contact, PO / reference, VAT / tax types, account, dates; no recalculation)
 *   ID  idempotency + concurrency (duplicate, concurrent, timeout recovery, existing id)
 *   FL  failure / partial success (create failure, send failure, persistence failure, malformed / mismatching Xero)
 *   CT  contacts (reuse, create once, never by name, explicit link)
 *   AC  access (View reads, Manage writes, no grant / coach, module off, tenant)
 *   AU  audit (exact events, failures, no secrets, nothing for reads / refusals)
 *   ST  status / settings / TEST guards
 *   Z   code / drift checks against the canonical finance files
 *
 * The REAL F5 / F6 / F7 code builds and freezes the invoices; the REAL F9
 * HTTP adapter talks to an in-memory fake Xero (identity + Accounting API
 * shapes, Idempotency-Key replay, fault injection, aborting timeouts).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FinanceGrantRow, FINANCE_MODULE_KEY, isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, toStoredFields } from "./finance-settings.ts";
import { TABLES } from "./finance-commercial-mapping.ts";
import { COMMERCIAL_RETRY_DELAYS_MS } from "./finance-commercial-repository.ts";
import { SETTINGS_RETRY_DELAYS_MS } from "./finance-settings-repository.ts";
import { RETRY_DELAYS_MS } from "./finance-repository.ts";
import { type WriteInput, writeCommercial } from "./finance-commercial-orchestrator.ts";
import { BILLING_TABLES } from "./finance-billing-mapping.ts";
import { parseDetails } from "./finance-invoicing.ts";
import { INVOICING_TABLES } from "./finance-invoicing-mapping.ts";
import { type DraftWrite, writeDraft } from "./finance-invoicing-orchestrator.ts";
import { ISSUE_TABLES, buildInvoices } from "./finance-issue-mapping.ts";
import { createCreditNote, issueDraft, readInvoice } from "./finance-issue-orchestrator.ts";
import { RECEIVABLE_TABLES } from "./finance-receivables-mapping.ts";
import { readReceivable } from "./finance-receivables-orchestrator.ts";
import {
  PROVIDER_LABEL,
  XERO_EVENTS,
  invoiceMismatches,
  matchXeroRoute,
  parseContactLink,
  parseXeroAction,
  parseXeroInvoice,
  parseXeroSettings,
  toMinor,
  xeroDate,
  xeroReference,
} from "./finance-xero.ts";
import { endpointsFor } from "./finance-xero-provider.ts";
import { type XeroDeps, EXTERNAL_STATUS_FIELD, issueToXero, linkXeroContact, readXeroInvoiceState, readXeroStatus, updateXeroSettings } from "./finance-xero-orchestrator.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test", "finance");

const R: [string, string, string?][] = [];
let failed = 0;
function ck(name: string, cond: unknown, extra?: string) {
  const ok = !!cond;
  if (!ok) failed++;
  R.push([ok ? "PASS" : "FAIL", name, extra]);
}

const ORG = "ORG-TEST-001";
const ORG_REC = "recYXqi1DTZ8ZECPQ";
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const VIEWER = "aaaaaaaa-e0d4-4257-8121-5f16781e97ba";
const NOGRANT = "bbbbbbbb-e0d4-4257-8121-5f16781e97ba";
const g = (level: unknown): FinanceGrantRow => ({ organisation_id: ORG, access_level: level, revoked_at: null });
const mgr = { userId: MGR, role: "management", active: true, organisationId: ORG };
const viewer = { userId: VIEWER, role: "management", active: true, organisationId: ORG };
const nogrant = { userId: NOGRANT, role: "management", active: true, organisationId: ORG };
const coach = { userId: MGR, role: "coach", active: true, organisationId: ORG };
const parent = { userId: MGR, role: "parent", active: true, organisationId: ORG };

const SETTINGS = { ...EMPTY_SETTINGS, invoiceLegalName: "T Ltd", invoiceAddress: "1 St", vatRegistered: true, vatNumber: "GB1", defaultVatRateBasisPoints: 2000, defaultVatTreatment: "plus_vat" as const, defaultPaymentTermsDays: 30, coachPaymentDayOfFollowingMonth: 7, invoiceNumberAuthority: "xero" as const };
const settingsRow = (s: any) => ({ id: "recSettingsRow001", fields: { Organisation: [ORG_REC], "Finance Settings ID": "FINSET", Revision: 1, ...Object.fromEntries(Object.entries(toStoredFields(s, Object.keys(s) as any)).filter(([, v]) => v !== null)) } });
const SECRET = "test-client-secret-NOT-REAL-9f8e7d";

// ---------------------------------------------------------------------------
// World: Airtable + Supabase (PostgREST) + fake Xero
// ---------------------------------------------------------------------------
type XFault = { op: string; mode: string; n: number };
interface XeroWorld {
  clientId: string;
  secret: string;
  tenantId: string;
  tenantName: string;
  orgClass: string;
  contacts: Record<string, any>[];
  invoices: Record<string, any>[];
  idem: Map<string, { status: number; body: any; at: number }>;
  /** Fake Xero clock in minutes - Xero keeps an Idempotency-Key's response for 6 minutes from the first call. */
  minute: number;
  faults: XFault[];
  calls: { method: string; path: string; key: string | null; status: number }[];
  seq: number;
  tokens: Set<string>;
  tokenRequests: { auth: string; body: string }[];
  emails: string[];
}
interface World {
  grants: Record<string, FinanceGrantRow[]>;
  moduleOn: boolean;
  tables: Record<string, { id: string; fields: Record<string, any> }[]>;
  sb: Record<string, Record<string, any>[]>;
  secret: string | null;
  audit: any[];
  lockHeld: string | null;
  lockMode: "ok" | "busy" | "error";
  settingsLockHeld: string | null;
  failPatchOn?: string;
  auditStatus?: number;
  auditFailOn?: string;
  failedThisRequest?: boolean;
  x: XeroWorld;
}
let world: World;
let calls: { url: string; method: string; body?: any }[] = [];
let recSeq = 0;
let hexSeq = 0;
let NOW = new Date("2026-09-29T12:00:00.000Z");
const ORG_ROW = { id: ORG_REC, fields: { "Organisation ID": ORG, "Organisation Name": "Test Org", Timezone: "Europe/London", Active: true } };
const TENANT = "11111111-2222-4333-8444-555555555555";
const ACCOUNTS = [
  { Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE" },
  { Code: "299", Name: "Old Sales", Type: "REVENUE", Status: "ARCHIVED" },
];
const TAX_RATES = [
  { TaxType: "OUTPUT2", EffectiveRate: 20.0, Status: "ACTIVE" },
  { TaxType: "RROUTPUT", EffectiveRate: 5.0, Status: "ACTIVE" },
  { TaxType: "ZERORATEDOUTPUT", EffectiveRate: 0.0, Status: "ACTIVE" },
  { TaxType: "NONE", EffectiveRate: 0.0, Status: "ACTIVE" },
];
const connRow = (over: Record<string, any> = {}) => ({
  organisation_id: ORG,
  provider: "xero",
  environment: "live",
  auth_method: "client_credentials",
  status: "connected",
  client_id: "cid-test",
  client_secret_id: "99999999-9999-4999-8999-999999999999",
  tenant_id: null,
  tenant_name: null,
  connected_at: "2026-09-29T09:00:00Z",
  connected_by: MGR,
  account_code: "200",
  tax_types: { rate_2000: "OUTPUT2", no_vat: "NONE" },
  config_revision: 1,
  config_updated_at: null,
  config_updated_by: null,
  last_success_at: null,
  last_error_at: null,
  last_error_code: null,
  last_error_message: null,
  ...over,
});

function reset() {
  world = {
    grants: { [MGR]: [g("manage")], [VIEWER]: [g("view")], [NOGRANT]: [] },
    moduleOn: true,
    tables: {
      [TABLES.clients]: [],
      [TABLES.services]: [],
      [TABLES.terms]: [],
      [TABLES.lifecycle]: [],
      "Finance Settings": [settingsRow(SETTINGS)],
      [BILLING_TABLES.overrides]: [],
      [BILLING_TABLES.occurrences]: [],
      [BILLING_TABLES.sessions]: [],
      [INVOICING_TABLES.drafts]: [],
      [INVOICING_TABLES.lines]: [],
      [ISSUE_TABLES.invoices]: [],
      [ISSUE_TABLES.lines]: [],
      [ISSUE_TABLES.creditNotes]: [],
      [RECEIVABLE_TABLES.payments]: [],
      [RECEIVABLE_TABLES.credits]: [],
      [RECEIVABLE_TABLES.applications]: [],
      [RECEIVABLE_TABLES.dueChanges]: [],
    },
    sb: { finance_external_connections: [connRow()], finance_xero_invoice_links: [], finance_xero_contact_links: [] },
    secret: SECRET,
    audit: [],
    lockHeld: null,
    lockMode: "ok",
    settingsLockHeld: null,
    x: { clientId: "cid-test", secret: SECRET, tenantId: TENANT, tenantName: "Demo Company (UK)", orgClass: "DEMO", contacts: [], invoices: [], idem: new Map(), minute: 0, faults: [], calls: [], seq: 0, tokens: new Set(), tokenRequests: [], emails: [] },
  };
  calls = [];
  NOW = new Date("2026-09-29T12:00:00.000Z");
}
const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tableOf = (url: string) => Object.keys(world.tables).find((t) => new URL(url).pathname.split("/")[3] === encodeURIComponent(t));
const clean = (fields: Record<string, any>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== false));
const tick = () => new Promise((r) => setTimeout(r, 0));

// ----- PostgREST emulation for the F9 tables -----
const PK: Record<string, string[][]> = {
  finance_external_connections: [["organisation_id", "provider"]],
  finance_xero_invoice_links: [["organisation_id", "invoice_id"], ["organisation_id", "xero_invoice_id"]],
  finance_xero_contact_links: [["organisation_id", "client_id"], ["organisation_id", "xero_contact_id"]],
};
function filters(u: URL): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of u.searchParams) if (k !== "select" && k !== "order") out.push([k, v.replace(/^eq\./, "")]);
  return out;
}
const matches = (r: Record<string, any>, fs: [string, string][]) => fs.every(([k, v]) => String(r[k] ?? "") === v);
function violates(table: string, row: Record<string, any>, ignore: Record<string, any> | null) {
  return PK[table].some((cols) => cols.every((c) => row[c] !== null && row[c] !== undefined) && world.sb[table].some((o) => o !== ignore && cols.every((c) => String(o[c]).toLowerCase() === String(row[c]).toLowerCase())));
}
function postgrest(url: string, method: string, body: any, prefer: string): Response {
  const u = new URL(url);
  const table = u.pathname.split("/").pop() as string;
  const rows = world.sb[table];
  if (!rows) return json({ message: "no table" }, 404);
  const fs = filters(u);
  const rep = prefer.includes("return=representation");
  if (method === "GET") return json(rows.filter((r) => matches(r, fs)).map((r) => ({ ...r })));
  if (method === "POST") {
    const ins = Array.isArray(body) ? body : [body];
    for (const r of ins) if (violates(table, r, null)) return json({ code: "23505", message: "duplicate key" }, 409);
    const added = ins.map((r) => ({ created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...r }));
    rows.push(...added);
    return rep ? json(added.map((r) => ({ ...r })), 201) : json(null, 201);
  }
  if (method === "PATCH") {
    const hit = rows.filter((r) => matches(r, fs));
    for (const r of hit) if (violates(table, { ...r, ...body }, r)) return json({ code: "23505", message: "duplicate key" }, 409);
    for (const r of hit) Object.assign(r, body);
    return rep ? json(hit.map((r) => ({ ...r }))) : json(null, 204);
  }
  if (method === "DELETE") {
    world.sb[table] = rows.filter((r) => !matches(r, fs));
    return json(null, 204);
  }
  return json({ message: "bad method" }, 405);
}

// ----- fake Xero -----
const guid = () => {
  const h = (++world.x.seq).toString(16).padStart(12, "0");
  return `aaaaaaaa-bbbb-4ccc-8ddd-${h}`;
};
const xv = (messages: string[]) => ({ ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }] });
const r2 = (n: number) => Math.round(n * 100) / 100;
function takeFault(op: string): string | null {
  const f = world.x.faults.find((x) => x.op === op && x.n > 0);
  if (!f) return null;
  f.n--;
  return f.mode;
}
const presentInv = (d: Record<string, any>) => ({ ...JSON.parse(JSON.stringify(d)), Contact: { ContactID: d.Contact.ContactID, Name: world.x.contacts.find((c) => c.ContactID === d.Contact.ContactID)?.Name ?? "" } });
function xeroOp(op: string, path: string[], body: any, query: URLSearchParams, f: string | null): { status: number; body: any } {
  const X = world.x;
  if (op === "create_contact") {
    const c = body?.Contacts?.[0];
    if (X.contacts.some((o) => o.ContactStatus === "ACTIVE" && o.Name.toLowerCase() === String(c?.Name).toLowerCase())) return { status: 400, body: xv([`The contact name ${c.Name} is already assigned to another contact. The contact name must be unique across all active contacts.`]) };
    const nc = { ContactID: guid(), Name: c.Name, ContactNumber: c.ContactNumber ?? null, EmailAddress: c.EmailAddress ?? "", ContactStatus: "ACTIVE" };
    X.contacts.push(nc);
    return { status: 200, body: { Contacts: [{ ...nc }] } };
  }
  if (op === "update_contact") {
    const c = X.contacts.find((o) => o.ContactID === path[1]);
    if (!c) return { status: 404, body: { Title: "Not Found" } };
    c.EmailAddress = body?.Contacts?.[0]?.EmailAddress ?? c.EmailAddress;
    return { status: 200, body: { Contacts: [{ ...c }] } };
  }
  if (op === "create_invoice") {
    const p = body?.Invoices?.[0];
    const contact = X.contacts.find((c) => c.ContactID === p?.Contact?.ContactID);
    const errs: string[] = [];
    if (!contact) errs.push("A valid contact must be supplied");
    const lines = (p?.LineItems ?? []).map((li: any, k: number) => {
      if (!TAX_RATES.some((t) => t.TaxType === li.TaxType)) errs.push(`TaxType ${li.TaxType} is not valid`);
      if (!ACCOUNTS.some((a) => a.Code === li.AccountCode && a.Status === "ACTIVE")) errs.push(`AccountCode ${li.AccountCode} is not valid`);
      let tax = Number(li.TaxAmount);
      if (k === 0 && f === "alter_tax") tax = r2(tax + 0.01);
      return { LineItemID: guid(), Description: li.Description, Quantity: li.Quantity, UnitAmount: Math.round((li.LineAmount / li.Quantity) * 10000) / 10000, LineAmount: li.LineAmount, TaxAmount: tax, TaxType: li.TaxType, AccountCode: li.AccountCode };
    });
    if (errs.length) return { status: 400, body: xv(errs) };
    const due = f === "alter_due_date" ? new Date(Date.parse(`${p.DueDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : p.DueDate;
    const sub = r2(lines.reduce((a: number, l: any) => a + l.LineAmount, 0));
    const tax = r2(lines.reduce((a: number, l: any) => a + l.TaxAmount, 0));
    const d = {
      Type: "ACCREC",
      InvoiceID: guid(),
      InvoiceNumber: `INV-${String(X.invoices.length + 1).padStart(4, "0")}`,
      Reference: p.Reference,
      Contact: { ContactID: contact.ContactID },
      Date: `/Date(${Date.parse(`${p.Date}T00:00:00Z`)}+0000)/`,
      DateString: `${p.Date}T00:00:00`,
      DueDate: `/Date(${Date.parse(`${due}T00:00:00Z`)}+0000)/`,
      DueDateString: `${due}T00:00:00`,
      Status: p.Status,
      LineAmountTypes: p.LineAmountTypes,
      LineItems: lines,
      SubTotal: sub,
      TotalTax: tax,
      Total: r2(sub + tax),
      CurrencyCode: p.CurrencyCode,
      SentToContact: false,
    };
    X.invoices.push(d);
    return { status: 200, body: { Invoices: [presentInv(d)] } };
  }
  if (op === "set_status") {
    const d = X.invoices.find((i) => i.InvoiceID === path[1]);
    if (!d) return { status: 404, body: { Title: "Not Found" } };
    const want = body?.Invoices?.[0]?.Status;
    if (!(d.Status === "DRAFT" && (want === "AUTHORISED" || want === "DELETED")) && d.Status !== want) return { status: 400, body: xv([`Invoice is ${d.Status}`]) };
    d.Status = want;
    if (f === "alter_due_date") d.DueDateString = `${new Date(Date.parse(d.DueDateString.slice(0, 10) + "T00:00:00Z") + 86400000).toISOString().slice(0, 10)}T00:00:00`;
    const out = presentInv(d);
    if (f === "missing_number") delete out.InvoiceNumber;
    return { status: 200, body: { Invoices: [out] } };
  }
  if (op === "email") {
    const d = X.invoices.find((i) => i.InvoiceID === path[1]);
    if (!d) return { status: 404, body: { Title: "Not Found" } };
    if (!["AUTHORISED", "SUBMITTED", "PAID"].includes(d.Status)) return { status: 400, body: xv(["Invoice must be authorised to be emailed"]) };
    if (f === "email_fail") return { status: 400, body: xv(["Unable to send the invoice (fault)"]) };
    d.SentToContact = true;
    X.emails.push(d.InvoiceID);
    return { status: 204, body: null };
  }
  return { status: 404, body: { Title: "Not Found" } };
}
async function xeroFetch(url: string, init: any): Promise<Response> {
  const X = world.x;
  const u = new URL(url);
  const method = (init.method || "GET").toUpperCase();
  const h = init.headers ?? {};
  const key: string | null = h["Idempotency-Key"] ?? null;
  const log = (status: number) => X.calls.push({ method, path: u.pathname, key, status });
  if (u.hostname === "identity.xero.com" && u.pathname === "/connect/token") {
    X.tokenRequests.push({ auth: h.Authorization, body: String(init.body) });
    const ok = h.Authorization === `Basic ${btoa(`${X.clientId}:${X.secret}`)}` && String(init.body) === "grant_type=client_credentials";
    const f = takeFault("token");
    if (f === "fail_500") return (log(500), json({}, 500));
    if (!ok) return (log(400), json({ error: "invalid_client" }, 400));
    const t = `tok-${X.tokens.size + 1}-${"z".repeat(10)}`;
    X.tokens.add(t);
    log(200);
    return json({ access_token: t, expires_in: 1800, token_type: "Bearer" });
  }
  const bearer = /^Bearer (.+)$/.exec(h.Authorization ?? "")?.[1];
  if (!bearer || !X.tokens.has(bearer)) return (log(401), json({ Title: "Unauthorized" }, 401));
  if (u.pathname === "/connections") return (log(200), json([{ id: "c1", tenantId: X.tenantId, tenantType: "ORGANISATION", tenantName: X.tenantName }]));
  if (!u.pathname.startsWith("/api.xro/2.0/")) return (log(404), json({}, 404));
  if (h["xero-tenant-id"] !== X.tenantId) return (log(403), json({ Title: "Forbidden" }, 403));
  const seg = u.pathname.slice("/api.xro/2.0/".length).split("/");
  const body = init.body ? JSON.parse(init.body) : null;
  if (method === "GET") {
    let out: { status: number; body: any };
    if (seg[0] === "Organisation") out = { status: 200, body: { Organisations: [{ Name: X.tenantName, Class: X.orgClass, BaseCurrency: "GBP" }] } };
    else if (seg[0] === "Accounts") out = { status: 200, body: { Accounts: ACCOUNTS } };
    else if (seg[0] === "TaxRates") out = { status: 200, body: { TaxRates: TAX_RATES } };
    else if (seg[0] === "Contacts" && seg[1]) {
      const c = X.contacts.find((o) => o.ContactID === seg[1]);
      out = c ? { status: 200, body: { Contacts: [{ ...c }] } } : { status: 404, body: { Title: "Not Found" } };
    } else if (seg[0] === "Contacts") {
      const m = /^ContactNumber=="([^"]*)"$/.exec(u.searchParams.get("where") ?? "");
      out = { status: 200, body: { Contacts: X.contacts.filter((c) => c.ContactStatus === "ACTIVE" && (!m || c.ContactNumber === m[1])).map((c) => ({ ...c })) } };
    } else if (seg[0] === "Invoices" && seg[1]) {
      const d = X.invoices.find((i) => i.InvoiceID === seg[1]);
      out = d ? { status: 200, body: { Invoices: [presentInv(d)] } } : { status: 404, body: { Title: "Not Found" } };
    } else if (seg[0] === "Invoices") {
      const f = takeFault("list_invoices");
      const ids = (u.searchParams.get("ContactIDs") ?? "").split(",");
      const st = (u.searchParams.get("Statuses") ?? "").split(",");
      const page = Number(u.searchParams.get("page") ?? "1");
      const sel = X.invoices.filter((i) => ids.includes(i.Contact.ContactID) && st.includes(i.Status));
      out = f === "fail_500" ? { status: 500, body: {} } : { status: 200, body: { Invoices: sel.slice((page - 1) * 100, page * 100).map(presentInv) } };
    } else out = { status: 404, body: {} };
    log(out.status);
    return json(out.body, out.status);
  }
  const op = seg[0] === "Contacts" ? (seg[1] ? "update_contact" : "create_contact") : seg[2] === "Email" ? "email" : seg[1] ? "set_status" : "create_invoice";
  if (key && X.idem.has(key) && X.minute - X.idem.get(key)!.at >= 6) X.idem.delete(key);
  if (key && X.idem.has(key)) {
    const prev = X.idem.get(key)!;
    log(prev.status);
    X.calls[X.calls.length - 1].key = `${key} (replay)`;
    return json(prev.body, prev.status);
  }
  const faultOp = op === "set_status" ? "authorise" : op;
  const f = op === "update_contact" ? null : takeFault(faultOp);
  if (f === "fail_500") return (log(500), json({ Title: "Server error" }, 500));
  if (f === "fail_400") {
    // A definite rejection is a result: Xero replays it for the same key until the key expires.
    if (key) X.idem.set(key, { status: 400, body: xv(["Rejected (fault)"]), at: X.minute });
    return (log(400), json(xv(["Rejected (fault)"]), 400));
  }
  const out = xeroOp(op, seg, body, u.searchParams, f);
  if (key) X.idem.set(key, { ...out, at: X.minute });
  if (f === "drop_response") return (log(502), json({ Title: "Bad Gateway" }, 502));
  if (f === "timeout") {
    log(-1);
    return new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }
  log(out.status);
  return json(out.body, out.status);
}

globalThis.fetch = (async (input: any, init: any = {}) => {
  await tick();
  const url = String(input);
  const method = (init.method || "GET").toUpperCase();
  if (url.startsWith("https://identity.xero.com/") || url.startsWith("https://api.xero.com/")) return xeroFetch(url, init);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, method, body });
  const prefer = (init.headers?.Prefer ?? "") as string;
  if (url.includes("/rest/v1/finance_access_grants")) {
    const m = /^eq\.(.+)$/.exec(new URL(url).searchParams.get("user_id") || "");
    return json(m ? world.grants[m[1]] ?? [] : []);
  }
  if (url.includes("/rpc/acquire_finance_write_lock")) {
    if (world.lockMode === "error") return json({ message: "boom" }, 500);
    if (world.lockMode === "busy" || world.lockHeld) return json(null);
    world.lockHeld = "22222222-2222-4222-8222-222222222222";
    return json(world.lockHeld);
  }
  if (url.includes("/rpc/release_finance_write_lock")) {
    const ok = body?.p_lock_token === world.lockHeld && body?.p_lock_key === `commercial:${ORG}`;
    if (ok) world.lockHeld = null;
    return json(ok);
  }
  if (url.includes("/rpc/acquire_finance_settings_lock")) {
    if (world.settingsLockHeld) return json(null);
    world.settingsLockHeld = "33333333-3333-4333-8333-333333333333";
    return json(world.settingsLockHeld);
  }
  if (url.includes("/rpc/release_finance_settings_lock")) {
    const ok = body?.p_lock_token === world.settingsLockHeld;
    if (ok) world.settingsLockHeld = null;
    return json(ok);
  }
  if (url.includes("/rpc/finance_xero_client_secret")) {
    const c = world.sb.finance_external_connections.find((r) => r.organisation_id === body?.p_organisation_id && r.status === "connected");
    return json(c ? world.secret : null);
  }
  if (url.includes("/rest/v1/finance_audit_events") && method === "POST") {
    const evs = Array.isArray(body) ? body : [body];
    if (world.auditStatus && (!world.auditFailOn || evs.some((e: any) => e.event_type === world.auditFailOn))) {
      world.failedThisRequest = true;
      return json({ message: "audit down" }, world.auditStatus);
    }
    const rows = evs.map((e: any, i: number) => ({ id: `aud-${world.audit.length + i + 1}`, ...e }));
    world.audit.push(...rows);
    return json(rows.map((r: any) => ({ id: r.id })), 201);
  }
  if (url.includes("/rest/v1/finance_external_connections") || url.includes("/rest/v1/finance_xero_")) return postgrest(url, method, body, prefer);
  if (url.startsWith("https://api.airtable.com/")) {
    if (url.includes(encodeURIComponent("Organisation & Branding"))) return json({ records: [ORG_ROW] });
    if (url.includes(encodeURIComponent("Feature Controls"))) return json({ records: [{ id: "recI5wFXcjUfY6BXy", fields: { "Feature Key": FINANCE_MODULE_KEY, ...(world.moduleOn ? { Enabled: true } : {}) } }] });
    const t = tableOf(url);
    if (!t) return json({ records: [] });
    const rows = world.tables[t];
    const id = new URL(url).pathname.split("/")[4];
    if (method === "GET") {
      if (id) {
        const rec = rows.find((r) => r.id === id);
        return rec ? json(rec) : json({ error: "NOT_FOUND" }, 404);
      }
      return json({ records: rows });
    }
    if (method === "POST") {
      const recs = body.records.map((r: any) => ({ id: `rec${String(++recSeq).padStart(14, "0")}`, fields: clean(r.fields) }));
      rows.push(...recs);
      return json({ records: recs });
    }
    if (method === "PATCH") {
      const isUndo = world.failedThisRequest;
      if (world.failPatchOn === t && !isUndo) {
        world.failedThisRequest = true;
        return json({ error: "boom" }, 422);
      }
      const ups = id ? [{ id, fields: body.fields }] : body.records;
      const out = [];
      for (const u of ups) {
        const rec = rows.find((r) => r.id === u.id);
        if (!rec) return json({ error: "NOT_FOUND" }, 404);
        for (const [k, v] of Object.entries(u.fields)) {
          if (v === null || v === false) delete rec.fields[k];
          else rec.fields[k] = v;
        }
        out.push(rec);
      }
      return json(id ? out[0] : { records: out });
    }
    if (method === "DELETE") {
      const ids = id ? [id] : new URL(url).searchParams.getAll("records[]");
      world.tables[t] = rows.filter((r) => !ids.includes(r.id));
      return json({ records: ids.map((x) => ({ deleted: true, id: x })) });
    }
  }
  return json({ error: "unexpected url" }, 598);
}) as typeof fetch;

const deps: XeroDeps = {
  airtable: { baseId: "appQktredAuGa1X7e", token: "pat-test" },
  grants: { supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "service-role-test" },
  clock: () => NOW,
  randomHex: () => (++hexSeq).toString(16).padStart(12, "0") + "a".repeat(20),
  xero: { requireDemoTenant: true, timeoutMs: 40 },
};
const fresh = () => {
  world.failedThisRequest = false;
};
const W = (input: WriteInput, caller: any = mgr) => (fresh(), writeCommercial(deps, caller, input) as Promise<any>);
const DW = (input: DraftWrite, caller: any = mgr) => (fresh(), writeDraft(deps, caller, input) as Promise<any>);

function addSession(recId: string, sessionId: string, financeServiceId: string | null) {
  world.tables[BILLING_TABLES.sessions].push({ id: recId, fields: { "Session ID": sessionId, "Session Name": `${sessionId} name`, ...(financeServiceId ? { "Finance Service ID": financeServiceId } : {}) } });
}
function addOcc(sessionRec: string, date: string) {
  const id = `${sessionRec}:${date}`;
  world.tables[BILLING_TABLES.occurrences].push({
    id: `recOcc${String(world.tables[BILLING_TABLES.occurrences].length).padStart(11, "0")}`,
    fields: { "Occurrence ID": id, Session: [sessionRec], Date: date, "Start Date & Time": `${date}T14:30:00.000Z`, "End Date & Time": `${date}T15:30:00.000Z`, Status: "Scheduled", "Confirmation State": "Confirmed" },
  });
  return id;
}
const PPA = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 5000, vatTreatment: "plus_vat" as const };
const AFTER = { payer: "client" as const, chargeType: "per_player" as const, amountMinor: 900, vatTreatment: "no_vat" as const, defaultBillableQuantity: 18 };
const BREAKFAST = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 6000, vatTreatment: "vat_included" as const };
const STANNES = { payer: "client" as const, chargeType: "fixed_per_session" as const, amountMinor: 4500, vatTreatment: "plus_vat" as const };
const S = { ppa: "recSessPPA0000001", after: "recSessAFT0000001", breakfast: "recSessBRK0000001", stannes: "recSessSTA0000001" };

async function seed() {
  reset();
  const pk = (await W({ route: "clients.create", client: { name: "TEST Parkside Primary", billingEmail: "billing.parkside@test.invalid", paymentTermsDaysOverride: 30, poRequired: true }, reason: null })).body.client.clientId as string;
  const sa = (await W({ route: "clients.create", client: { name: "TEST St Anne's", billingEmail: "office@stannes.test" }, reason: null })).body.client.clientId as string;
  const mk = async (clientId: string, name: string, input: any) => (await W({ route: "services.create", clientId, name, initial: { effectiveFrom: "2026-09-01", input }, reason: null })).body.service.serviceId as string;
  const ids = { parkside: pk, stannes: sa, ppa: await mk(pk, "PPA", PPA), after: await mk(pk, "After-school", AFTER), breakfast: await mk(pk, "Breakfast club", BREAKFAST), sa: await mk(sa, "PPA", STANNES) };
  addSession(S.ppa, "TEST-PPA", ids.ppa);
  addSession(S.after, "TEST-AFTER", ids.after);
  addSession(S.breakfast, "TEST-BREAKFAST", ids.breakfast);
  addSession(S.stannes, "TEST-STANNES", ids.sa);
  calls = [];
  world.audit = [];
  return ids;
}
/** F5 draft -> Ready -> F6 freeze (Xero authority): the awaiting invoice body. */
async function freeze(clientId: string, occs: [string, string][], from = "2026-09-01", to = "2026-09-30") {
  for (const [s, d] of occs) addOcc(s, d);
  const d = (await DW({ route: "draft.create", req: { clientId, from, to } })).body;
  let rev = d.draft.revision;
  if (d.draft.po.required) {
    const p = parseDetails('{"poNumber":"PO-77"}', isTenantKey) as any;
    rev = (await DW({ route: "draft.details", draftId: d.draft.draftId, req: p.req })).body.draft.revision;
  }
  const r = await DW({ route: "draft.ready", draftId: d.draft.draftId, revision: rev, reason: null });
  if (r.status !== "ok") throw new Error(`fixture ready: ${r.code} ${r.error}`);
  const i = (fresh(), (await issueDraft(deps, mgr, d.draft.draftId, r.body.draft.revision, null)) as any);
  if (i.status !== "ok") throw new Error(`fixture freeze: ${i.code} ${i.error}`);
  return i.body;
}
const xi = (invoiceId: string, caller: any = mgr) => (fresh(), issueToXero(deps, caller, invoiceId, "issue", null) as Promise<any>);
const xr = (invoiceId: string, caller: any = mgr) => (fresh(), issueToXero(deps, caller, invoiceId, "retry", null) as Promise<any>);
const xs = (invoiceId: string, caller: any = mgr) => readXeroInvoiceState(deps, caller, invoiceId) as Promise<any>;
const status = (check = false, caller: any = mgr) => readXeroStatus(deps, caller, check) as Promise<any>;
const rec = (invoiceId: string) => readReceivable(deps, mgr, invoiceId, null) as Promise<any>;
const invRow = (invoiceId: string) => world.tables[ISSUE_TABLES.invoices].find((r) => r.fields["Invoice ID"] === invoiceId)!;
const link = (invoiceId: string) => world.sb.finance_xero_invoice_links.find((r) => r.invoice_id === invoiceId);
const xcalls = (method: string, re: RegExp) => world.x.calls.filter((c) => c.method === method && re.test(c.path));
const creates = () => xcalls("PUT", /\/Invoices$/).filter((c) => !String(c.key).endsWith("(replay)"));
const liveXero = () => world.x.invoices.filter((i) => i.Status !== "DELETED");
const types = () => world.audit.map((e) => e.event_type);
const TODAY = "2026-09-29";

async function main() {
  for (const a of [RETRY_DELAYS_MS, SETTINGS_RETRY_DELAYS_MS, COMMERCIAL_RETRY_DELAYS_MS]) a.splice(0, a.length, 1, 1, 1, 1, 1);

  // ===== LC. Lifecycle =====
  {
    const ids = await seed();
    const before = world.x.calls.length;
    const fz = await freeze(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"]]);
    const inv = fz.invoice;
    ck("LC0. Ready (F5) and the F6 freeze never contact Xero (the two-step flow): no Xero call, invoice awaiting external issue", world.x.calls.length === before && inv.status === "awaiting_external_issue" && inv.receivable === false);
    const r0 = await rec(inv.invoiceId);
    ck("LC5. Before Xero confirms, the awaiting invoice is not a receivable (no due date)", r0.body.receivable.receivable === false && r0.body.receivable.reason === "awaiting_external_issue");
    world.audit = [];
    const r = await xi(inv.invoiceId);
    const row = invRow(inv.invoiceId).fields;
    const x = liveXero();
    ck("LC1 / LC6. An awaiting Xero-authority invoice is sent to Xero: 201 issued_and_sent; Hub status Issued only now, with Xero's id / official number / dates / status", r.httpStatus === 201 && r.body.outcome === "issued_and_sent" && r.body.invoice.status === "issued" && x.length === 1 && row.Status === "Issued" && row["External Invoice ID"] === x[0].InvoiceID && row["External Invoice Number"] === "INV-0001" && row["External Provider"] === "Xero" && row[EXTERNAL_STATUS_FIELD] === "AUTHORISED" && row["Invoice Date"] === TODAY && row["Due Date"] === "2026-10-29" && row["Issued By User ID"] === MGR && !!row["Issued At"], `${r.httpStatus} ${r.code ?? ""} ${r.error ?? ""}`);
    ck("LC6b. The public invoice shows Xero's number as the official number next to the unchanged FIV reference", r.body.invoice.numbering.officialNumber === "INV-0001" && r.body.invoice.numbering.internalReference === inv.invoiceId && r.body.invoice.external.provider === "Xero");
    const r1 = await rec(inv.invoiceId);
    ck("LC7. F7 unchanged: the invoice is now a receivable - 222.00 outstanding, due 2026-10-29 (Xero date + frozen 30 days)", r1.body.receivable.receivable === true && r1.body.receivable.amounts.outstanding === "222.00" && r1.body.receivable.dueDate === "2026-10-29" && r1.body.receivable.invoiceDate === TODAY);
    const xb = x[0];
    ck("LC6c. Xero holds it AUTHORISED and it was emailed by Xero (SentToContact)", xb.Status === "AUTHORISED" && xb.SentToContact === true && world.x.emails.length === 1);
    const again = await xi(inv.invoiceId);
    ck("LC4 / ID15. A repeated Send / Issue on an issued invoice: 409 invoice_already_issued, no Xero invoice created or email sent again", again.httpStatus === 409 && again.code === "invoice_already_issued" && creates().length === 1 && world.x.emails.length === 1 && liveXero().length === 1);
    // LC2: Hub authority
    world.tables["Finance Settings"][0] = settingsRow({ ...SETTINGS, invoiceNumberAuthority: "hub", invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001 });
    const hub = (await freeze(ids.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    const xc = world.x.calls.length;
    world.audit = [];
    const h = await xi(hub.invoiceId);
    ck("LC2. A Hub-authority (Hub-issued) invoice is refused: 409 xero_not_issue_authority, no Xero call, no audit", h.httpStatus === 409 && h.code === "xero_not_issue_authority" && world.x.calls.length === xc && world.audit.length === 0);
    const nf = await xi("FIV-00000000DEAD");
    const m1 = matchXeroRoute("invoices/FID-0000000000AA/xero-issue", "POST");
    ck("LC3. Not an invoice: an unknown FIV -> 404 invoice_not_found; a draft id (FID) never matches the route (only frozen invoices can be sent)", nf.httpStatus === 404 && nf.code === "invoice_not_found" && m1?.status === "not_found");
  }

  // ===== MP. Mapping =====
  {
    const ids = await seed();
    world.sb.finance_external_connections[0].tax_types = { rate_2000: "OUTPUT2", no_vat: "NONE" };
    const inv = (await freeze(ids.parkside, [[S.ppa, "2026-09-10"], [S.after, "2026-09-10"], [S.breakfast, "2026-09-10"]])).invoice;
    // MP14: change the client's terms AFTER the freeze - the Xero invoice must still use the frozen 30 days
    await W({ route: "client.update", clientId: ids.parkside, patch: { paymentTermsDaysOverride: 45, billingEmail: "new.address@test.invalid" }, reason: null });
    const r = await xi(inv.invoiceId);
    const d = liveXero()[0];
    const frozenLines = world.tables[ISSUE_TABLES.lines].filter((l) => l.fields["Invoice ID"] === inv.invoiceId).sort((a, b) => a.fields.Sequence - b.fields.Sequence);
    const sent = d.LineItems;
    ck("MP8. The Xero invoice carries exactly the frozen lines: same count, order, description, quantity, net (LineAmount) and VAT (TaxAmount); totals equal the frozen invoice", r.httpStatus === 201 && sent.length === 3 && frozenLines.length === 3 && sent.every((li: any, k: number) => li.Description === frozenLines[k].fields.Description && li.Quantity === frozenLines[k].fields.Quantity && toMinor(li.LineAmount) === frozenLines[k].fields["Net (Minor Units)"] && toMinor(li.TaxAmount) === frozenLines[k].fields["VAT (Minor Units)"]) && toMinor(d.Total) === toMinor(inv.totals.gross), `${r.code ?? ""} ${JSON.stringify(sent.map((l: any) => [l.LineAmount, l.TaxAmount]))}`);
    ck("MP8b. Totals: Xero SubTotal / TotalTax / Total = the frozen net / VAT / gross", toMinor(d.SubTotal) === toMinor(inv.totals.net) && toMinor(d.TotalTax) === toMinor(inv.totals.vat) && toMinor(d.Total) === toMinor(inv.totals.gross), JSON.stringify(inv.totals));
    ck("MP11. VAT mapping: 20% plus-VAT and VAT-included lines -> OUTPUT2 (VAT-included sent as its frozen net + VAT, Exclusive), no-VAT -> NONE; every line on the configured sales account 200", d.LineAmountTypes === "Exclusive" && sent.every((l: any) => (l.LineAmount === 162 ? l.TaxType === "NONE" && l.TaxAmount === 0 : l.TaxType === "OUTPUT2" && l.LineAmount === 50 && l.TaxAmount === 10)) && sent.every((l: any) => l.AccountCode === "200"), sent.map((l: any) => `${l.TaxType}/${l.LineAmount}/${l.TaxAmount}`).join(" "));
    ck("MP10. PO / reference: Reference = frozen PO + the Hub FIV reference (traceable, not truncated)", d.Reference === `PO-77 | ${inv.invoiceId}` && xeroReference({ invoiceId: inv.invoiceId, poNumber: null }) === inv.invoiceId);
    ck("MP13 / MP14. Dates: Date = the Hub's issue day, DueDate = Date + the FROZEN 30 days (the client's later 45-day change is ignored); Hub due date = Xero's", d.DateString.startsWith(TODAY) && d.DueDateString.startsWith("2026-10-29") && invRow(inv.invoiceId).fields["Due Date"] === "2026-10-29");
    const c = world.x.contacts[0];
    ck("MP9. Contact: created once with the frozen client name, ContactNumber = the Hub client id, email = the invoice's FROZEN billing email (not the later-changed one); link stored", world.x.contacts.length === 1 && c.Name === "TEST Parkside Primary" && c.ContactNumber === ids.parkside && c.EmailAddress === "billing.parkside@test.invalid" && world.sb.finance_xero_contact_links.length === 1 && world.sb.finance_xero_contact_links[0].xero_contact_id === c.ContactID && d.Contact.ContactID === c.ContactID);
    const created = xcalls("PUT", /\/Invoices$/).length;
    const payloadStatus = (world.x.idem.get(`hub:${ORG}:${inv.invoiceId}:g1:create`) as any)?.body?.Invoices?.[0]?.Status;
    ck("MP8c. Created as a DRAFT, verified, then authorised (Xero assigns the number); no InvoiceNumber is sent by the Hub", created === 1 && payloadStatus === "DRAFT" && xcalls("POST", /\/Invoices\/[^/]+$/).length === 1);
    // MP12: missing config blocks before any external call
    const ids2 = await seed();
    world.sb.finance_external_connections[0].account_code = null;
    const a = (await freeze(ids2.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    const n0 = world.x.calls.length;
    world.audit = [];
    const ra = await xi(a.invoiceId);
    world.sb.finance_external_connections[0].account_code = "200";
    world.sb.finance_external_connections[0].tax_types = { no_vat: "NONE" };
    const rb = await xi(a.invoiceId);
    ck("MP12. Missing sales account or a line's VAT mapping: 409 xero_not_ready naming what to choose, BEFORE any Xero call (not even a token); nothing written or audited", ra.httpStatus === 409 && ra.code === "xero_not_ready" && /sales account/.test(ra.error) && rb.code === "xero_not_ready" && /VAT at 20%/.test(rb.error) && world.x.calls.length === n0 && world.x.tokenRequests.length === 0 && !link(a.invoiceId) && world.audit.length === 0);
    world.sb.finance_external_connections[0].tax_types = { rate_2000: "RROUTPUT", no_vat: "NONE" };
    const rc = await xi(a.invoiceId);
    world.sb.finance_external_connections[0].tax_types = { rate_2000: "OUTPUT2", no_vat: "NONE" };
    world.sb.finance_external_connections[0].account_code = "299";
    const rd = await xi(a.invoiceId);
    ck("MP12b. A mapping that Xero contradicts (20% mapped to a 5% Xero tax type; an archived account) is refused by the read-only preflight: no contact, no invoice created", rc.code === "xero_not_ready" && /5% .*20%|is 5/.test(rc.error) && rd.code === "xero_not_ready" && /no active account with code 299/.test(rd.error) && creates().length === 0 && world.x.contacts.length === 0, `${rc.error} | ${rd.error}`);
  }

  // ===== ID. Idempotency + concurrency =====
  {
    const ids = await seed();
    const a = (await freeze(ids.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    const [p1, p2] = await Promise.all([xi(a.invoiceId), xi(a.invoiceId)]);
    const okOne = [p1, p2].filter((p) => p.status === "ok");
    const busy = [p1, p2].filter((p) => p.code === "finance_commercial_busy");
    ck("ID16. Two simultaneous Send / Issue calls: exactly one succeeds, the other gets 409 busy; ONE Xero invoice, one email", okOne.length === 1 && busy.length === 1 && liveXero().length === 1 && creates().length === 1 && world.x.emails.length === 1, `${p1.code ?? p1.httpStatus} ${p2.code ?? p2.httpStatus}`);
    // ID17: create times out after Xero created it -> retry recovers by reference, never re-creates
    const b = (await freeze(ids.parkside, [[S.ppa, "2026-09-12"]])).invoice;
    world.x.faults.push({ op: "create_invoice", mode: "timeout", n: 1 });
    world.audit = [];
    const t1 = await xi(b.invoiceId);
    const lk1 = link(b.invoiceId);
    const r0 = await rec(b.invoiceId);
    ck("ID17a. Create times out (Xero did create it): 503 xero_create_outcome_unknown; Hub stays awaiting (not a receivable); journal 'creating', 1 attempt", t1.httpStatus === 503 && t1.code === "xero_create_outcome_unknown" && invRow(b.invoiceId).fields.Status === "Awaiting external issue" && r0.body.receivable.receivable === false && lk1?.stage === "creating" && lk1?.create_attempts === 1 && liveXero().length === 2, `${t1.code}`);
    const creates0 = creates().length;
    const t2 = await xr(b.invoiceId);
    ck("ID17b. Retry finds the invoice in Xero by its reference (no second create) and completes: 201 issued, recovery audited", t2.httpStatus === 201 && t2.body.outcome === "issued_and_sent" && creates().length === creates0 && liveXero().length === 2 && types().includes(XERO_EVENTS.recovered) && invRow(b.invoiceId).fields.Status === "Issued", `${t2.code ?? ""} ${t2.error ?? ""}`);
    // drop_response variant + idempotent replay when the lookup finds nothing yet
    const c = (await freeze(ids.parkside, [[S.ppa, "2026-09-13"]])).invoice;
    world.x.faults.push({ op: "create_invoice", mode: "drop_response", n: 1 });
    const d1 = await xi(c.invoiceId);
    const before = liveXero().length;
    world.x.faults.push({ op: "list_invoices", mode: "fail_500", n: 1 });
    const d2 = await xr(c.invoiceId);
    const d3 = await xr(c.invoiceId);
    ck("ID17c. Lost create response: 503 (outcome unknown); a retry while Xero cannot be searched stops (503) instead of re-creating; the next retry recovers - still ONE Xero invoice", d1.httpStatus === 503 && d1.code === "xero_create_outcome_unknown" && d2.httpStatus === 503 && d3.httpStatus === 201 && liveXero().length === before && invRow(c.invoiceId).fields["External Invoice Number"] === liveXero().find((x) => x.Reference === `PO-77 | ${c.invoiceId}`)?.InvoiceNumber);
    // ID18: Xero id already journaled -> never re-created
    const e = (await freeze(ids.parkside, [[S.ppa, "2026-09-14"]])).invoice;
    world.failPatchOn = ISSUE_TABLES.invoices;
    const e1 = await xi(e.invoiceId);
    world.failPatchOn = undefined;
    const lk = { ...link(e.invoiceId) } as any;
    const statusAfterFail = invRow(e.invoiceId).fields.Status;
    const cr = creates().length;
    const e2 = await xr(e.invoiceId);
    ck("ID18 / FL22. Xero created + approved it but the Hub could not record it: 503 xero_issue_recording_failed (journal 'created' with the Xero id + number); retry records it with NO Xero create / approve call", e1.httpStatus === 503 && e1.code === "xero_issue_recording_failed" && lk?.stage === "created" && !!lk?.xero_invoice_number && statusAfterFail === "Awaiting external issue" && e2.httpStatus === 201 && creates().length === cr && invRow(e.invoiceId).fields["External Invoice Number"] === lk?.xero_invoice_number, `${e1.code} ${e2.code ?? ""} ${e2.error ?? ""} stage=${lk?.stage}`);
    ck("ID18b. One Hub invoice -> at most one Xero invoice: every journal row has a distinct Xero id, and Xero holds exactly one live invoice per frozen reference", new Set(world.sb.finance_xero_invoice_links.map((l) => l.xero_invoice_id)).size === world.sb.finance_xero_invoice_links.length && new Set(liveXero().map((x) => x.Reference)).size === liveXero().length);
  }

  // ===== FL. Failure / partial success =====
  {
    const ids = await seed();
    const a = (await freeze(ids.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    world.x.faults.push({ op: "create_invoice", mode: "fail_400", n: 1 });
    world.audit = [];
    const f1 = await xi(a.invoiceId);
    ck("FL19. Xero refuses the create: 409 xero_rejected with Xero's message; Hub stays awaiting; journal records the error; retry is safe", f1.httpStatus === 409 && f1.code === "xero_rejected" && invRow(a.invoiceId).fields.Status === "Awaiting external issue" && link(a.invoiceId)?.last_error_code === "xero_rejected" && liveXero().length === 0 && types().join(",") === [XERO_EVENTS.contactLinked, XERO_EVENTS.createRequested, XERO_EVENTS.createFailed].join(","), types().join(","));
    const f2 = await xr(a.invoiceId);
    ck("FL19b. ... a retry inside Xero's 6-minute key window gets the same rejection replayed (same key): 409 xero_rejected, still nothing in Xero, Hub still awaiting", f2.httpStatus === 409 && f2.code === "xero_rejected" && liveXero().length === 0 && invRow(a.invoiceId).fields.Status === "Awaiting external issue");
    world.x.minute += 6;
    const f3 = await xr(a.invoiceId);
    ck("FL19c. ... after the key expires the retry looks first (nothing there), then creates once: 201", f3.httpStatus === 201 && liveXero().length === 1);
    // FL20 / FL21: send failure
    const b = (await freeze(ids.parkside, [[S.ppa, "2026-09-12"]])).invoice;
    world.x.faults.push({ op: "email", mode: "email_fail", n: 1 });
    world.audit = [];
    const s1 = await xi(b.invoiceId);
    const st = await xs(b.invoiceId);
    ck("FL21. Create OK but send failed: 201 issued_send_failed - the Xero invoice exists and the Hub IS Issued (receivable); send state send_failed with a retry action", s1.httpStatus === 201 && s1.body.outcome === "issued_send_failed" && invRow(b.invoiceId).fields.Status === "Issued" && st.body.xero.send.status === "send_failed" && st.body.xero.stage === "issued" && st.body.xero.nextAction === "retry_send" && (await rec(b.invoiceId)).body.receivable.receivable === true);
    const cr = creates().length;
    const s2 = await xr(b.invoiceId);
    ck("FL20. Send retry sends the SAME Xero invoice (new key after a definite failure); never creates another: 200 sent", s2.httpStatus === 200 && s2.body.outcome === "sent" && creates().length === cr && world.x.emails.filter((x) => x === link(b.invoiceId)?.xero_invoice_id).length === 1 && link(b.invoiceId)?.send_status === "sent" && link(b.invoiceId)?.send_key_generation === 2);
    const s3 = await xr(b.invoiceId);
    ck("FL20b. Nothing left to retry once sent: 409 xero_nothing_to_retry", s3.code === "xero_nothing_to_retry");
    // FL23: malformed response (no official number) -> safe failure, retry re-reads
    const c = (await freeze(ids.parkside, [[S.ppa, "2026-09-13"]])).invoice;
    world.x.faults.push({ op: "authorise", mode: "missing_number", n: 1 });
    const m1 = await xi(c.invoiceId);
    const cStatusAfterFail = invRow(c.invoiceId).fields.Status;
    const cr2 = creates().length;
    const m2 = await xr(c.invoiceId);
    ck("FL23. Xero answers without an official number: 502 xero_response_invalid, Hub stays awaiting; the retry re-reads Xero (no new create) and completes", m1.httpStatus === 502 && m1.code === "xero_response_invalid" && cStatusAfterFail === "Awaiting external issue" && m2.httpStatus === 201 && creates().length === cr2, `${m1.code} ${m2.code ?? ""} ${m2.error ?? ""} ${m2.httpStatus} creates=${creates().length}/${cr2}`);
    // Xero recalculates -> draft discarded, nothing issued
    const d = (await freeze(ids.parkside, [[S.ppa, "2026-09-14"]])).invoice;
    world.x.faults.push({ op: "create_invoice", mode: "alter_tax", n: 1 });
    world.audit = [];
    const v1 = await xi(d.invoiceId);
    const discarded = world.x.invoices.filter((i) => i.Reference === `PO-77 | ${d.invoiceId}`);
    ck("FL23b. Xero does not reproduce the frozen VAT (1p off): 409 xero_invoice_mismatch naming it; the Xero DRAFT is deleted, nothing approved / sent / issued", v1.httpStatus === 409 && v1.code === "xero_invoice_mismatch" && /line 1 VAT/.test(v1.error) && discarded.length === 1 && discarded[0].Status === "DELETED" && world.x.emails.indexOf(discarded[0].InvoiceID) < 0 && invRow(d.invoiceId).fields.Status === "Awaiting external issue" && types().includes(XERO_EVENTS.draftDiscarded));
    const v2 = await xr(d.invoiceId);
    ck("FL23c. ... retry starts a new generation (new key) and issues a matching invoice: one live Xero invoice for it", v2.httpStatus === 201 && world.x.invoices.filter((i) => i.Reference === `PO-77 | ${d.invoiceId}` && i.Status !== "DELETED").length === 1 && link(d.invoiceId)?.generation === 2);
    const e = (await freeze(ids.parkside, [[S.ppa, "2026-09-15"]])).invoice;
    world.x.faults.push({ op: "create_invoice", mode: "alter_due_date", n: 1 });
    const dd = await xi(e.invoiceId);
    ck("FL23d. Xero alters the due date: explicit mismatch (never guessed), nothing issued", dd.code === "xero_invoice_mismatch" && /due date/.test(dd.error) && invRow(e.invoiceId).fields.Status === "Awaiting external issue");
    // Xero changes the invoice while approving it -> needs review, never recorded / sent
    const h = (await freeze(ids.parkside, [[S.ppa, "2026-09-17"]])).invoice;
    world.x.faults.push({ op: "authorise", mode: "alter_due_date", n: 1 });
    world.audit = [];
    const nr1 = await xi(h.invoiceId);
    const nr2 = await xr(h.invoiceId);
    const hx = liveXero().find((x) => x.Reference === `PO-77 | ${h.invoiceId}`);
    ck("FL23e. Xero approves an invoice that no longer matches (due date moved): 409 xero_needs_review; journal needs_review with the mismatch; Hub stays awaiting; never sent; a retry does not touch Xero again", nr1.code === "xero_needs_review" && link(h.invoiceId)?.stage === "needs_review" && /due date/.test(JSON.stringify(link(h.invoiceId)?.mismatches)) && invRow(h.invoiceId).fields.Status === "Awaiting external issue" && hx?.Status === "AUTHORISED" && world.x.emails.indexOf(hx?.InvoiceID) < 0 && nr2.code === "xero_needs_review" && types().includes(XERO_EVENTS.mismatchDetected), `${nr1.code} ${nr2.code}`);
    // audit failure on the issued transition -> undone, retry completes
    const f = (await freeze(ids.parkside, [[S.ppa, "2026-09-16"]])).invoice;
    world.auditStatus = 500;
    world.auditFailOn = XERO_EVENTS.issueConfirmed;
    const au1 = await xi(f.invoiceId);
    world.auditStatus = undefined;
    world.auditFailOn = undefined;
    const fStatusAfterFail = invRow(f.invoiceId).fields.Status;
    const au2 = await xr(f.invoiceId);
    ck("FL22b. The issued transition cannot be audited: the Hub patch is undone (still awaiting), 503; the retry records it without re-creating", au1.httpStatus === 503 && fStatusAfterFail === "Awaiting external issue" && au2.httpStatus === 201 && invRow(f.invoiceId).fields.Status === "Issued", `${au1.code} ${au2.code ?? ""} ${au2.error ?? ""}`);
  }

  // ===== CT. Contacts =====
  {
    const ids = await seed();
    const a = (await freeze(ids.parkside, [[S.ppa, "2026-09-10"]])).invoice;
    world.x.faults.push({ op: "create_invoice", mode: "fail_400", n: 1 });
    await xi(a.invoiceId);
    const contactCreates1 = xcalls("PUT", /\/Contacts$/).length;
    await xr(a.invoiceId);
    ck("CT25. A new contact is created ONCE: a later retry reuses the stored link (no second contact)", contactCreates1 === 1 && xcalls("PUT", /\/Contacts$/).length === 1 && world.x.contacts.length === 1);
    const b = (await freeze(ids.parkside, [[S.ppa, "2026-09-11"]])).invoice;
    const n = xcalls("GET", /\/Contacts$/).length;
    await xi(b.invoiceId);
    ck("CT24. A mapped contact is reused for the client's next invoice (read by id, no search, no create)", xcalls("PUT", /\/Contacts$/).length === 1 && xcalls("GET", /\/Contacts$/).length === n && liveXero().every((x) => x.Contact.ContactID === world.x.contacts[0].ContactID));
    // matched by ContactNumber (an earlier link was lost) - never by name
    const ids2 = await seed();
    world.x.contacts.push({ ContactID: "cccccccc-0000-4000-8000-000000000001", Name: "Parkside (accounts name)", ContactNumber: ids2.parkside, EmailAddress: "billing.parkside@test.invalid", ContactStatus: "ACTIVE" });
    const c = (await freeze(ids2.parkside, [[S.ppa, "2026-09-10"]])).invoice;
    await xi(c.invoiceId);
    ck("CT24b. A Xero contact already carrying the Hub client id as ContactNumber is matched (whatever its name) and linked", world.x.contacts.length === 1 && world.sb.finance_xero_contact_links[0]?.method === "matched_contact_number" && liveXero()[0].Contact.ContactID === "cccccccc-0000-4000-8000-000000000001");
    // CT26: a DIFFERENT Xero contact with the same name
    const ids3 = await seed();
    world.x.contacts.push({ ContactID: "dddddddd-0000-4000-8000-000000000002", Name: "TEST St Anne's", ContactNumber: null, EmailAddress: "someone.else@test.invalid", ContactStatus: "ACTIVE" });
    const d = (await freeze(ids3.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    world.audit = [];
    const r = await xi(d.invoiceId);
    ck("CT26. A same-NAME Xero contact is never bound: 409 xero_contact_name_conflict; no link, no invoice, the other contact untouched", r.httpStatus === 409 && r.code === "xero_contact_name_conflict" && world.sb.finance_xero_contact_links.length === 0 && liveXero().length === 0 && world.x.contacts[0].EmailAddress === "someone.else@test.invalid" && !types().includes(XERO_EVENTS.createRequested));
    const lv = await linkXeroContact(deps, viewer, ids3.stannes, "dddddddd-0000-4000-8000-000000000002", "It is the same school");
    const lm = (await linkXeroContact(deps, mgr, ids3.stannes, "dddddddd-0000-4000-8000-000000000002", "Confirmed with the bursar: same school")) as any;
    const r2 = await xi(d.invoiceId);
    ck("CT26b. Management links the right Xero contact explicitly (View cannot): audited; Send then uses it, with the invoice's frozen billing email set on the contact", lv.httpStatus === 403 && lm.httpStatus === 201 && world.sb.finance_xero_contact_links[0].method === "linked_by_manager" && r2.httpStatus === 201 && liveXero()[0].Contact.ContactID === "dddddddd-0000-4000-8000-000000000002" && world.x.contacts[0].EmailAddress === "office@stannes.test" && types().includes(XERO_EVENTS.contactLinked));
    const dup = (await linkXeroContact(deps, mgr, ids3.parkside, "dddddddd-0000-4000-8000-000000000002", "x")) as any;
    ck("CT26c. One Xero contact can never serve two Hub clients: 409 xero_contact_linked_elsewhere", dup.code === "xero_contact_linked_elsewhere");
  }

  // ===== AC. Access =====
  {
    const ids = await seed();
    const a = (await freeze(ids.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    world.audit = [];
    const n0 = world.x.calls.length;
    const vs = await status(false, viewer);
    const vx = await xs(a.invoiceId, viewer);
    const vi = await xi(a.invoiceId, viewer);
    const vr = await xr(a.invoiceId, viewer);
    const vset = await updateXeroSettings(deps, viewer, { accountCode: "260", reason: null });
    ck("AC27. Finance View reads the connection + invoice Xero state; issue / retry / settings -> 403 finance_manage_required; no Xero call", vs.httpStatus === 200 && vs.body.access === "view" && vx.httpStatus === 200 && vx.body.xero.nextAction === "issue" && vi.code === "finance_manage_required" && vr.code === "finance_manage_required" && vset.code === "finance_manage_required" && world.x.calls.length === n0);
    const ng = await xi(a.invoiceId, nogrant);
    const ngs = await status(false, nogrant);
    const co = await xi(a.invoiceId, coach);
    const pa = await xs(a.invoiceId, parent);
    ck("AC29. No Finance grant -> 403 finance_access_denied (issue and status); Coach / Parent -> 403 management_required", ng.code === "finance_access_denied" && ngs.code === "finance_access_denied" && co.code === "management_required" && pa.code === "management_required");
    world.moduleOn = false;
    const mo = await xi(a.invoiceId);
    const ms = await status();
    world.moduleOn = true;
    ck("AC30. module_finance off -> 403 finance_module_disabled for issue and status", mo.code === "finance_module_disabled" && ms.code === "finance_module_disabled");
    const t1 = parseXeroAction('{"organisationId":"ORG-OTHER"}', isTenantKey) as any;
    const t2 = parseXeroSettings('{"accountCode":"200","organisation_id":"x"}', isTenantKey) as any;
    const t3 = parseContactLink('{"contactId":"dddddddd-0000-4000-8000-000000000002","reason":"x","tenantId":"t"}', isTenantKey) as any;
    ck("AC31. Tenant override rejected in every F9 body: 400 tenant_param_rejected", t1.code === "tenant_param_rejected" && t2.code === "tenant_param_rejected" && t3.code === "tenant_param_rejected");
    const ok = await xi(a.invoiceId);
    ck("AC28. Finance Manage issues (and the earlier refusals wrote nothing and audited nothing)", ok.httpStatus === 201 && world.audit.filter((e) => e.actor_user_id !== MGR).length === 0);
    ck("AC31b. The organisation is always the caller's own: every journal / link / audit row is ORG-TEST-001", world.sb.finance_xero_invoice_links.every((l) => l.organisation_id === ORG) && world.sb.finance_xero_contact_links.every((l) => l.organisation_id === ORG) && world.audit.every((e) => e.organisation_id === ORG));
  }

  // ===== AU. Audit =====
  {
    const ids = await seed();
    const a = (await freeze(ids.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    world.audit = [];
    await status(false);
    await status(true);
    await xs(a.invoiceId);
    ck("AU35a. Reads (status, live health check, invoice Xero state) create no audit", world.audit.length === 0);
    await xi(a.invoiceId);
    ck("AU32. Exact success events, in order: contact linked, create requested, Xero invoice created, external issue confirmed, sent", types().join(",") === [XERO_EVENTS.contactLinked, XERO_EVENTS.createRequested, XERO_EVENTS.created, XERO_EVENTS.issueConfirmed, XERO_EVENTS.sent].join(","), types().join(","));
    const conf = world.audit.find((e) => e.event_type === XERO_EVENTS.issueConfirmed);
    ck("AU32b. The confirmation records before (awaiting, no dates) / after (issued, Xero dates, number, provider, status) and the actor", conf.before.status === "awaiting_external_issue" && conf.before.invoiceDate === null && conf.after.status === "issued" && conf.after.dueDate === "2026-10-29" && conf.after.officialNumber === "INV-0001" && conf.after.externalStatus === "AUTHORISED" && conf.actor_user_id === MGR && conf.context.contract === "finance-xero-v1");
    const all = JSON.stringify(world.audit) + JSON.stringify(world.sb);
    ck("AU34. No secret, token or Authorization value anywhere in audit or connector storage", !all.includes(SECRET) && !/tok-\d/.test(all) && !/Bearer|Basic /.test(all));
    const b = (await freeze(ids.stannes, [[S.stannes, "2026-09-12"]])).invoice;
    world.audit = [];
    world.x.faults.push({ op: "create_invoice", mode: "timeout", n: 1 }, { op: "email", mode: "email_fail", n: 1 });
    await xi(b.invoiceId);
    await xr(b.invoiceId);
    await xr(b.invoiceId);
    ck("AU33. Failure / retry events are recorded: create requested + outcome unknown; then recovered + created + confirmed + send failed; then sent", types().join(",") === [XERO_EVENTS.createRequested, XERO_EVENTS.createOutcomeUnknown, XERO_EVENTS.recovered, XERO_EVENTS.created, XERO_EVENTS.issueConfirmed, XERO_EVENTS.sendFailed, XERO_EVENTS.sent].join(","), types().join(","));
    world.audit = [];
    await xi(b.invoiceId);
    await xi(a.invoiceId, viewer);
    world.sb.finance_external_connections[0].status = "disconnected";
    const c = (await freeze(ids.stannes, [[S.stannes, "2026-09-13"]])).invoice;
    world.audit = [];
    const nc = await xi(c.invoiceId);
    ck("AU35b. Refused calls (already issued, View, not connected) create no audit and no Xero call", world.audit.length === 0 && nc.code === "xero_not_connected");
  }

  // ===== ST. Status / settings / guards =====
  {
    const ids = await seed();
    const s0 = await status();
    ck("ST1. Status (View): connected, environment, mapping, readiness; never the client secret / vault id", s0.httpStatus === 200 && s0.body.connection.connected === true && s0.body.settings.accountCode === "200" && s0.body.readiness.ready === true && !JSON.stringify(s0.body).includes(SECRET) && !JSON.stringify(s0.body).includes("99999999-9999"));
    const s1 = await status(true);
    ck("ST2. Live health check (read-only): token + connection + organisation (DEMO) + account + tax types all verified; tenant recorded on the connection", s1.body.check.ok === true && s1.body.check.organisation.isDemo === true && s1.body.check.account.found === true && s1.body.check.taxTypes.every((t: any) => t.matches) && world.sb.finance_external_connections[0].tenant_id === TENANT && !!world.sb.finance_external_connections[0].last_success_at);
    world.x.orgClass = "STANDARD";
    const a = (await freeze(ids.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    const g1 = await xi(a.invoiceId);
    const s2 = await status(true);
    world.x.orgClass = "DEMO";
    ck("ST3. TEST guard: a connection that reaches a real (non-Demo) Xero organisation is refused before anything is created; recorded as the connection's last error", g1.httpStatus === 409 && g1.code === "xero_tenant_not_test" && creates().length === 0 && world.x.contacts.length === 0 && s2.body.check.error.code === "xero_tenant_not_test" && world.sb.finance_external_connections[0].last_error_code === "xero_tenant_not_test");
    world.secret = "wrong";
    world.x.secret = "different";
    const bad = await xi(a.invoiceId);
    world.x.secret = SECRET;
    world.secret = SECRET;
    ck("ST4. Credentials Xero refuses: 409 xero_connection_rejected ('needs reconnecting'); nothing created", bad.code === "xero_connection_rejected" && creates().length === 0);
    world.audit = [];
    const u1 = (await updateXeroSettings(deps, mgr, { taxTypes: { rate_2000: "OUTPUT2", rate_500: "RROUTPUT", no_vat: "NONE" }, reason: "5% VAT line expected" })) as any;
    const u2 = (await updateXeroSettings(deps, mgr, { taxTypes: { rate_2000: "OUTPUT2", rate_500: "RROUTPUT", no_vat: "NONE" }, reason: null })) as any;
    ck("ST5. Settings (Manage): saved with a revision + one audit event; an identical update changes nothing and audits nothing", u1.httpStatus === 200 && u1.body.changed === true && world.sb.finance_external_connections[0].config_revision === 2 && u2.body.changed === false && world.audit.length === 1 && world.audit[0].event_type === XERO_EVENTS.settingsUpdated, `${u1.code ?? ""} ${u1.error ?? ""} ${JSON.stringify(u2.body ?? u2)}`);
    const pv = parseXeroSettings('{"taxTypes":{"rate_20":"output 2"}}', isTenantKey) as any;
    const pk = parseXeroSettings('{"taxTypes":{"standard":"OUTPUT2"}}', isTenantKey) as any;
    ck("ST6. Settings validation: tax keys must be no_vat / rate_<bp>, values Xero codes", pv.code === "invalid_input" && pk.code === "invalid_input");
    ck("ST7. Sandbox endpoints are only ever this project's xero-sandbox function; live endpoints are Xero's; the sandbox is labelled on the invoice", endpointsFor("sandbox", "https://dkqubldmfyeuudecxmvh.supabase.co").api === "https://dkqubldmfyeuudecxmvh.supabase.co/functions/v1/xero-sandbox/api.xro/2.0" && endpointsFor("live", "x").api === "https://api.xero.com/api.xro/2.0" && endpointsFor("live", "x").token === "https://identity.xero.com/connect/token" && PROVIDER_LABEL.sandbox === "Xero (TEST sandbox)");
    ck("ST8. Pure parsing: Xero MS dates and DateStrings; exact money only", xeroDate(null, "/Date(1790726400000+0000)/") === "2026-09-30" && xeroDate("2026-10-01T00:00:00", null) === "2026-10-01" && toMinor(12.34) === 1234 && toMinor(0.1 + 0.2) === 30 && toMinor(12.345) === undefined && toMinor("7.50") === 750);
    const pi = parseXeroInvoice({ InvoiceID: "nope" }) as any;
    ck("ST9. A malformed Xero invoice is refused by the parser (never guessed)", pi.ok === false);
    ck("ST10. Route ownership: F9 claims only its own paths", matchXeroRoute("invoices/FIV-000000000001/xero-issue", "POST")?.status === "match" && matchXeroRoute("invoices/FIV-000000000001/xero-issue", "GET")?.status === "method" && matchXeroRoute("invoices/FIV-000000000001/payments", "POST") === null && matchXeroRoute("clients/FCL-000000000001/credits", "GET") === null && matchXeroRoute("xero/status", "GET")?.status === "match");
    // Legacy awaiting invoice that carries Hub credit notes (pre-Xero-authority TEST data)
    const ids2 = await seed();
    world.tables["Finance Settings"][0] = settingsRow({ ...SETTINGS, invoiceNumberAuthority: "hub", invoiceNumberPrefix: "INV-", invoiceNumberNext: 1001 });
    const h = (await freeze(ids2.stannes, [[S.stannes, "2026-09-11"]])).invoice;
    const cn = (await createCreditNote(deps, mgr, h.invoiceId, null, "legacy")) as any;
    const row = invRow(h.invoiceId);
    Object.assign(row.fields, { Status: "Awaiting external issue", "Issue Authority": "External accounting", "Invoice Number Authority": "Xero", "Hub Invoice Number": null, "Hub Invoice Sequence": null, "Invoice Date": null, "Due Date": null, "Issued At": null, "Issued By User ID": null });
    for (const k of Object.keys(row.fields)) if (row.fields[k] === null) delete row.fields[k];
    const lr = (await readInvoice(deps, mgr, h.invoiceId)) as any;
    const lg = await xi(h.invoiceId);
    ck("ST11. A (legacy) awaiting invoice carrying Hub credit notes is refused: sending it would make Xero and the Hub disagree (Xero credit notes not built)", cn.httpStatus === 201 && lr.httpStatus === 200 && lr.body.invoice.status === "awaiting_external_issue" && lg.code === "xero_issue_has_credit_notes" && creates().length === 0, `${lr.code ?? ""} ${lg.code}`);
    const mm = invoiceMismatches({ invoiceId: "x", number: "1", status: "DRAFT", type: "ACCREC", date: "2026-09-29", dueDate: "2026-10-29", reference: "R", contactId: "c", currency: "GBP", lineAmountTypes: "Exclusive", netMinor: 100, vatMinor: 20, grossMinor: 120, sentToContact: false, lines: [{ description: "d", quantity: 1, netMinor: 100, vatMinor: 20, taxType: "OUTPUT2", accountCode: "200" }] }, { contactId: "c", date: "2026-09-29", dueDate: "2026-10-29", reference: "R", currency: "GBP", lines: [{ description: "d", quantity: 1, netMinor: 100, vatMinor: 20, taxType: "OUTPUT2", accountCode: "200" }], netMinor: 100, vatMinor: 20, grossMinor: 120 });
    ck("ST12. Identical Xero invoice -> no mismatches", mm.length === 0);
  }

  // ===== Z. Code / drift =====
  {
    const code = (f: string) => readFileSync(join(CANON, f), "utf8");
    const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    ck("Z1. finance-xero.ts is pure (no fetch / Deno / Supabase / Airtable)", !/fetch\(|Deno\.|createClient|api\.airtable\.com/.test(noComments(code("finance-xero.ts"))));
    ck("Z2. Only the provider adapter talks HTTP to Xero; no token / secret is ever logged", /fetch\(/.test(code("finance-xero-provider.ts")) && !/fetch\(/.test(noComments(code("finance-xero-orchestrator.ts"))) && !/console\.(log|error)\([^)]*(secret|token)/i.test(code("finance-xero-provider.ts") + code("finance-xero-orchestrator.ts")));
    const orch = noComments(code("finance-xero-orchestrator.ts"));
    ck("Z3. Reads authorise View, writes Manage, via F1 authorizeFinance; the shared Finance write lock", /authorizeFinance\(deps, caller, "read"\)/.test(orch) && /authorizeFinance\(deps, caller, "manage"\)/.test(orch) && /acquireWriteLock\(deps\.grants, lockKey\(org\)\)/.test(orch) && /`commercial:\$\{o\.organisationId\}`/.test(orch));
    ck("Z4. The ONLY Hub invoice write is the single external-issue patch (no line / credit note / payment write)", (orch.match(/txn\.patch\(/g) || []).length === 1 && /txn\.patch\(ISSUE_TABLES\.invoices/.test(orch) && !/txn\.create\(/.test(orch));
    const idx = code("index.ts");
    ck("Z5. index.ts routes F9 first, then F7, F6, F5, F4, F3; keeps F1-F2; TEST guard requires a Xero Demo Company", idx.indexOf("matchXeroRoute(route") > 0 && idx.indexOf("matchXeroRoute(route") < idx.indexOf("matchReceivablesRoute(route") && idx.indexOf("matchReceivablesRoute(route") < idx.indexOf("matchIssueRoute(route") && /requireDemoTenant: true/.test(idx) && /"write-check"/.test(idx));
    const shared = ["finance-billing-mapping.ts", "finance-billing.ts", "finance-commercial-mapping.ts", "finance-commercial.ts", "finance-effective-dating.ts", "finance-invoicing-mapping.ts", "finance-invoicing.ts", "finance-issue-mapping.ts", "finance-issue.ts", "finance-lifecycle.ts", "finance-money.ts", "finance-settings.ts"];
    ck("Z6. No F9 code in the 12 Finance modules shared with Needs Attention (so the NA bundle is unchanged)", shared.every((f) => !/xero-orchestrator|finance-xero/.test(code(f))));
    const copy = (f: string, swaps: [string, string][] = []) => {
      let c = code(f);
      for (const [a, b] of swaps) c = c.replace(a, b);
      return readFileSync(join(HERE, f), "utf8").endsWith(c);
    };
    ck("Z7. Test copies match the canonical finance files (only import paths swapped)", copy("finance-xero.ts") && copy("finance-xero-provider.ts") && copy("finance-xero-repository.ts", [['"./repository.ts"', '"./finance-repository.ts"']]) && copy("finance-xero-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]) && copy("finance-issue-orchestrator.ts", [['"./orchestrator.ts"', '"./finance-orchestrator.ts"']]));
    ck("Z8. No Josh Evans naming / account codes hard-coded in F9 code", !/josh|evans/i.test(["finance-xero.ts", "finance-xero-provider.ts", "finance-xero-repository.ts", "finance-xero-orchestrator.ts"].map(code).join("\n")) && !/"200"|OUTPUT2/.test(noComments(code("finance-xero-orchestrator.ts") + code("finance-xero.ts"))));
    ck("Z9. No payment sync, Stripe, credit-note sync or Needs Attention code in F9", !/Payments\b|stripe|CreditNotes|needs_attention|needsAttention|finance_sync_failed/i.test(["finance-xero.ts", "finance-xero-provider.ts", "finance-xero-repository.ts", "finance-xero-orchestrator.ts"].map((f) => noComments(code(f))).join("\n")));
  }

  for (const [s, n, x] of R) console.log(`${s}  ${n}${x ? `  (${x})` : ""}`);
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
