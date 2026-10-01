/**
 * xero-sandbox - TEST ONLY. A small emulator of the Xero identity + Accounting
 * API surface the Finance F9 connector uses, so the connector's REAL HTTP
 * adapter can be live-proven in TEST when no real Xero Demo Company is
 * connected (see TEST-ENV.md "Finance Foundation - F9").
 *
 * It is NOT Xero and proves nothing about Xero itself: invoices it "issues"
 * carry SBX-INV-#### numbers, it never emails anyone (an Email call only
 * records that it would have sent), and the Finance connector labels every
 * invoice issued through it "Xero (TEST sandbox)".
 *
 * Surface (paths relative to /functions/v1/xero-sandbox):
 *   POST /connect/token                 client_credentials (Basic client_id:secret; secret checked by sha256)
 *   GET  /connections                   the one tenant
 *   GET  /api.xro/2.0/Organisation | Accounts | TaxRates
 *   GET  /api.xro/2.0/Contacts?where=ContactNumber=="X"   GET /Contacts/{id}
 *   PUT  /api.xro/2.0/Contacts          POST /Contacts/{id} (email)          - contact names unique (Xero rule)
 *   PUT  /api.xro/2.0/Invoices          GET /Invoices?ContactIDs=&Statuses=&page=   GET /Invoices/{id}
 *   POST /api.xro/2.0/Invoices/{id}     Status DRAFT -> AUTHORISED | DELETED
 *   POST /api.xro/2.0/Invoices/{id}/Email   204 (recorded only - nothing is emailed)
 * Every PUT/POST honours Idempotency-Key (the stored response is replayed).
 * Fault injection: rows in public.xero_sandbox_faults (op, mode, remaining) -
 * fail_400 / fail_500 / timeout / drop_response / missing_number /
 * alter_tax / alter_due_date / email_fail. Every request is logged in
 * public.xero_sandbox_requests (method, path, key, status - no credentials).
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
if (["bkkukymqaxawnudoxdjs"].some((ref) => (SUPABASE_URL || "").includes(ref))) {
  throw new Error("xero-sandbox refusing to start: this is a TEST-only emulator and SUPABASE_URL is the production project.");
}

const ACCOUNTS = [
  { AccountID: "5040915e-8ce7-4177-8d08-fde416232f18", Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE" },
  { AccountID: "e0a9c8ed-5a2b-4e57-8c8e-3d3e0f2b7a11", Code: "260", Name: "Other Revenue", Type: "REVENUE", Status: "ACTIVE" },
  { AccountID: "9a1f6c3e-2b7d-4f0a-a9c1-0d6c5b4e3f21", Code: "299", Name: "Archived Sales", Type: "REVENUE", Status: "ARCHIVED" },
];
const TAX_RATES = [
  { TaxType: "OUTPUT2", Name: "20% (VAT on Income)", EffectiveRate: 20.0, DisplayTaxRate: 20.0, Status: "ACTIVE", CanApplyToRevenue: true },
  { TaxType: "RROUTPUT", Name: "5% (VAT on Income)", EffectiveRate: 5.0, DisplayTaxRate: 5.0, Status: "ACTIVE", CanApplyToRevenue: true },
  { TaxType: "ZERORATEDOUTPUT", Name: "Zero Rated Income", EffectiveRate: 0.0, DisplayTaxRate: 0.0, Status: "ACTIVE", CanApplyToRevenue: true },
  { TaxType: "EXEMPTOUTPUT", Name: "Exempt Income", EffectiveRate: 0.0, DisplayTaxRate: 0.0, Status: "ACTIVE", CanApplyToRevenue: true },
  { TaxType: "NONE", Name: "No VAT", EffectiveRate: 0.0, DisplayTaxRate: 0.0, Status: "ACTIVE", CanApplyToRevenue: true },
];

// ----- tiny PostgREST client (service role) -----
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Accept: "application/json" };
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers as Record<string, string> | undefined) } });
  const t = await res.text();
  if (!res.ok) throw new Error(`sandbox db ${path}: ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const rpc = (fn: string, args: Record<string, unknown>) => db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const enc = encodeURIComponent;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const json = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const validation = (messages: string[]) => ({ ErrorNumber: 10, Type: "ValidationException", Message: "A validation exception occurred", Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msDate = (iso: string) => `/Date(${Date.parse(`${iso}T00:00:00Z`)}+0000)/`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fault = async (op: string): Promise<string | null> => (await rpc("xero_sandbox_take_fault", { p_op: op })) as string | null;
async function logReq(method: string, path: string, key: string | null, status: number, note: string | null = null) {
  await db("xero_sandbox_requests", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ method, path, idempotency_key: key, status, note }) }).catch(() => {});
}

type Out = { status: number; body: unknown };

// ----- documents -----
function present(row: Record<string, any>, contactName: string | null): Record<string, any> {
  const d = row.doc;
  return {
    Type: "ACCREC",
    InvoiceID: row.invoice_id,
    InvoiceNumber: d.InvoiceNumber ?? row.number,
    Reference: d.Reference ?? "",
    Contact: { ContactID: d.ContactID, Name: contactName ?? "" },
    Date: msDate(d.Date),
    DateString: `${d.Date}T00:00:00`,
    DueDate: msDate(d.DueDate),
    DueDateString: `${d.DueDate}T00:00:00`,
    Status: row.status,
    LineAmountTypes: d.LineAmountTypes,
    LineItems: d.LineItems,
    SubTotal: d.SubTotal,
    TotalTax: d.TotalTax,
    Total: d.Total,
    AmountDue: row.status === "PAID" ? 0 : d.Total,
    AmountPaid: 0,
    CurrencyCode: d.CurrencyCode,
    SentToContact: row.emails_sent > 0,
    UpdatedDateUTC: `/Date(${Date.parse(row.updated_at)}+0000)/`,
  };
}
async function contactName(id: string): Promise<string | null> {
  const r = await db(`xero_sandbox_contacts?contact_id=eq.${enc(id)}&select=name`);
  return r?.[0]?.name ?? null;
}
const contactOut = (c: Record<string, any>) => ({ ContactID: c.contact_id, ContactNumber: c.contact_number, Name: c.name, EmailAddress: c.email ?? "", ContactStatus: c.status, UpdatedDateUTC: `/Date(${Date.parse(c.updated_at)}+0000)/` });

// ----- operations (writes go through idempotency) -----
async function createContact(tenant: string, body: any): Promise<Out> {
  const c = body?.Contacts?.[0] ?? body;
  const name = typeof c?.Name === "string" ? c.Name.trim() : "";
  if (!name) return { status: 400, body: validation(["The contact name must be supplied"]) };
  const clash = await db(`xero_sandbox_contacts?tenant_id=eq.${tenant}&status=eq.ACTIVE&select=contact_id,name`);
  if ((clash as any[]).some((x) => x.name.toLowerCase() === name.toLowerCase())) return { status: 400, body: validation([`The contact name ${name} is already assigned to another contact. The contact name must be unique across all active contacts.`]) };
  const rows = await db("xero_sandbox_contacts?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ tenant_id: tenant, name, contact_number: c.ContactNumber ?? null, email: c.EmailAddress ?? null }) });
  return { status: 200, body: { Contacts: [contactOut(rows[0])] } };
}
async function updateContact(tenant: string, id: string, body: any): Promise<Out> {
  const c = body?.Contacts?.[0] ?? body;
  const rows = await db(`xero_sandbox_contacts?tenant_id=eq.${tenant}&contact_id=eq.${enc(id)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ email: c?.EmailAddress ?? null, updated_at: new Date().toISOString() }) });
  if (!rows.length) return { status: 404, body: { Title: "Not Found" } };
  return { status: 200, body: { Contacts: [contactOut(rows[0])] } };
}
async function createInvoice(tenant: string, body: any, f: string | null): Promise<Out> {
  const p = body?.Invoices?.[0] ?? body;
  const errs: string[] = [];
  if (p?.Type !== "ACCREC") errs.push("Only ACCREC invoices are supported by the sandbox");
  const contactId = p?.Contact?.ContactID;
  const contact = contactId ? (await db(`xero_sandbox_contacts?tenant_id=eq.${tenant}&contact_id=eq.${enc(contactId)}&select=*`))[0] : null;
  if (!contact) errs.push("A valid contact must be supplied");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(p?.Date ?? "") ? p.Date : null;
  let due = /^\d{4}-\d{2}-\d{2}$/.test(p?.DueDate ?? "") ? p.DueDate : null;
  if (!date || !due) errs.push("Date and DueDate are required");
  if (p?.LineAmountTypes !== "Exclusive") errs.push("The sandbox supports LineAmountTypes Exclusive only");
  if (!Array.isArray(p?.LineItems) || !p.LineItems.length) errs.push("At least one line item is required");
  const lines = (p?.LineItems ?? []).map((li: any, k: number) => {
    const q = Number(li.Quantity ?? 1);
    const amt = Number(li.LineAmount ?? (li.UnitAmount ?? 0) * q);
    const rate = TAX_RATES.find((t) => t.TaxType === li.TaxType && t.Status === "ACTIVE");
    const acc = ACCOUNTS.find((a) => a.Code === li.AccountCode && a.Status === "ACTIVE");
    if (!rate) errs.push(`Line ${k + 1}: TaxType ${li.TaxType} is not valid`);
    if (!acc) errs.push(`Line ${k + 1}: AccountCode ${li.AccountCode} is not a valid active account`);
    let tax = li.TaxAmount !== undefined ? Number(li.TaxAmount) : round2((amt * (rate?.EffectiveRate ?? 0)) / 100);
    if (k === 0 && f === "alter_tax") tax = round2(tax + 0.01);
    return { LineItemID: crypto.randomUUID(), Description: String(li.Description ?? ""), Quantity: q, UnitAmount: q ? Math.round((amt / q) * 10000) / 10000 : amt, LineAmount: round2(amt), TaxType: li.TaxType ?? null, TaxAmount: round2(tax), AccountCode: li.AccountCode ?? null };
  });
  if (errs.length) return { status: 400, body: validation(errs) };
  if (f === "alter_due_date") due = new Date(Date.parse(`${due}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const sub = round2(lines.reduce((a: number, l: any) => a + l.LineAmount, 0));
  const tax = round2(lines.reduce((a: number, l: any) => a + l.TaxAmount, 0));
  const number = await rpc("xero_sandbox_next_number", {});
  const status = p.Status === "AUTHORISED" ? "AUTHORISED" : "DRAFT";
  const doc = { ContactID: contact.contact_id, Date: date, DueDate: due, Reference: p.Reference ?? "", LineAmountTypes: "Exclusive", LineItems: lines, SubTotal: sub, TotalTax: tax, Total: round2(sub + tax), CurrencyCode: p.CurrencyCode ?? "GBP", InvoiceNumber: number };
  const rows = await db("xero_sandbox_invoices?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ tenant_id: tenant, number, status, doc }) });
  return { status: 200, body: { Invoices: [present(rows[0], contact.name)] } };
}
async function setStatus(tenant: string, id: string, body: any, f: string | null): Promise<Out> {
  const want = (body?.Invoices?.[0] ?? body)?.Status;
  const rows = await db(`xero_sandbox_invoices?tenant_id=eq.${tenant}&invoice_id=eq.${enc(id)}&select=*`);
  if (!rows.length) return { status: 404, body: { Title: "Not Found" } };
  const row = rows[0];
  if (!(row.status === "DRAFT" && (want === "AUTHORISED" || want === "DELETED")) && row.status !== want) return { status: 400, body: validation([`Invoice is ${row.status} - cannot change it to ${want}`]) };
  const upd = await db(`xero_sandbox_invoices?invoice_id=eq.${enc(id)}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: want, updated_at: new Date().toISOString() }) });
  const out = present(upd[0], await contactName(row.doc.ContactID));
  if (f === "missing_number") delete out.InvoiceNumber;
  return { status: 200, body: { Invoices: [out] } };
}
async function emailInvoice(tenant: string, id: string, f: string | null): Promise<Out> {
  const rows = await db(`xero_sandbox_invoices?tenant_id=eq.${tenant}&invoice_id=eq.${enc(id)}&select=*`);
  if (!rows.length) return { status: 404, body: { Title: "Not Found" } };
  const row = rows[0];
  if (!["SUBMITTED", "AUTHORISED", "PAID"].includes(row.status)) return { status: 400, body: validation(["Invoice must be submitted, authorised or paid to be emailed"]) };
  const c = (await db(`xero_sandbox_contacts?contact_id=eq.${enc(row.doc.ContactID)}&select=email`))[0];
  if (!c?.email) return { status: 400, body: validation(["The contact does not have an email address"]) };
  if (f === "email_fail") return { status: 400, body: validation(["Unable to send the invoice: the email could not be delivered (sandbox fault)"]) };
  await db(`xero_sandbox_invoices?invoice_id=eq.${enc(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ emails_sent: row.emails_sent + 1, updated_at: new Date().toISOString() }) });
  return { status: 204, body: null };
}

// ----- auth -----
async function bearer(req: Request): Promise<{ tenant: string } | null> {
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!m) return null;
  const rows = await db(`xero_sandbox_tokens?token=eq.${enc(m[1])}&expires_at=gt.${enc(new Date().toISOString())}&select=tenant_id`);
  return rows.length ? { tenant: rows[0].tenant_id } : null;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/xero-sandbox/, "") || "/";
  const method = req.method.toUpperCase();
  const key = req.headers.get("Idempotency-Key");
  let out: Out;
  let note: string | null = null;
  try {
    if (path === "/connect/token" && method === "POST") {
      const m = /^Basic (.+)$/.exec(req.headers.get("Authorization") ?? "");
      const [id, secret] = m ? atob(m[1]).split(":") : ["", ""];
      const form = new URLSearchParams(await req.text());
      const app = id ? (await db(`xero_sandbox_apps?client_id=eq.${enc(id)}&select=*`))[0] : null;
      const f = await fault("token");
      if (f === "fail_500") out = { status: 500, body: { error: "server_error" } };
      else if (form.get("grant_type") !== "client_credentials" || !app || app.secret_sha256 !== (await sha256(secret ?? ""))) out = { status: 400, body: { error: "invalid_client" } };
      else {
        const token = crypto.randomUUID() + crypto.randomUUID();
        await db("xero_sandbox_tokens", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ token, client_id: app.client_id, tenant_id: app.tenant_id, expires_at: new Date(Date.now() + 1800_000).toISOString() }) });
        out = { status: 200, body: { access_token: token, expires_in: 1800, token_type: "Bearer", scope: "accounting.invoices accounting.contacts accounting.settings.read" } };
      }
      await logReq(method, path, null, out.status);
      return json(out.body, out.status);
    }
    const who = await bearer(req);
    if (!who) {
      await logReq(method, path, key, 401);
      return json({ Title: "Unauthorized", Status: 401, Detail: "AuthenticationUnsuccessful" }, 401);
    }
    const tenant = who.tenant;
    const app = (await db(`xero_sandbox_apps?tenant_id=eq.${tenant}&select=*`))[0];
    if (path === "/connections" && method === "GET") {
      out = { status: 200, body: [{ id: app.tenant_id, tenantId: app.tenant_id, tenantType: "ORGANISATION", tenantName: app.tenant_name }] };
      await logReq(method, path, null, 200);
      return json(out.body, 200);
    }
    if (!path.startsWith("/api.xro/2.0/")) return json({ Title: "Not Found" }, 404);
    if (req.headers.get("xero-tenant-id") !== tenant) {
      await logReq(method, path, key, 403, "tenant header mismatch");
      return json({ Title: "Forbidden", Detail: "AuthorizationUnsuccessful" }, 403);
    }
    const seg = path.slice("/api.xro/2.0/".length).split("/");
    const body = method === "GET" ? null : await req.json().catch(() => null);

    // Reads
    if (method === "GET") {
      if (seg[0] === "Organisation") out = { status: 200, body: { Organisations: [{ OrganisationID: app.tenant_id, Name: app.tenant_name, Class: app.org_class, CountryCode: "GB", BaseCurrency: "GBP", OrganisationType: "COMPANY" }] } };
      else if (seg[0] === "Accounts") out = { status: 200, body: { Accounts: ACCOUNTS } };
      else if (seg[0] === "TaxRates") out = { status: 200, body: { TaxRates: TAX_RATES } };
      else if (seg[0] === "Contacts" && seg[1]) {
        const r = await db(`xero_sandbox_contacts?tenant_id=eq.${tenant}&contact_id=eq.${enc(seg[1])}&select=*`).catch(() => []);
        out = r.length ? { status: 200, body: { Contacts: [contactOut(r[0])] } } : { status: 404, body: { Title: "Not Found" } };
      } else if (seg[0] === "Contacts") {
        const m = /^ContactNumber=="([^"]*)"$/.exec(url.searchParams.get("where") ?? "");
        const r = await db(`xero_sandbox_contacts?tenant_id=eq.${tenant}&status=eq.ACTIVE&select=*${m ? `&contact_number=eq.${enc(m[1])}` : ""}`);
        out = { status: 200, body: { Contacts: r.map(contactOut) } };
      } else if (seg[0] === "Invoices" && seg[1]) {
        const f = await fault("get_invoice");
        if (f === "fail_500") out = { status: 500, body: { Title: "Server error" } };
        else {
          const r = await db(`xero_sandbox_invoices?tenant_id=eq.${tenant}&invoice_id=eq.${enc(seg[1])}&select=*`).catch(() => []);
          out = r.length ? { status: 200, body: { Invoices: [present(r[0], await contactName(r[0].doc.ContactID))] } } : { status: 404, body: { Title: "Not Found" } };
        }
      } else if (seg[0] === "Invoices") {
        const f = await fault("list_invoices");
        const ids = (url.searchParams.get("ContactIDs") ?? "").split(",").filter(Boolean).map((s) => s.toLowerCase());
        const statuses = (url.searchParams.get("Statuses") ?? "").split(",").filter(Boolean);
        const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
        const all = (await db(`xero_sandbox_invoices?tenant_id=eq.${tenant}&select=*&order=created_at.asc`)) as any[];
        const sel = all.filter((r) => (!ids.length || ids.includes(String(r.doc.ContactID).toLowerCase())) && (!statuses.length || statuses.includes(r.status)));
        out = f === "fail_500" ? { status: 500, body: { Title: "Server error" } } : { status: 200, body: { Invoices: await Promise.all(sel.slice((page - 1) * 100, page * 100).map(async (r) => present(r, await contactName(r.doc.ContactID)))) } };
      } else out = { status: 404, body: { Title: "Not Found" } };
      await logReq(method, path, null, out.status);
      return json(out.body, out.status);
    }

    // Writes (idempotent)
    const op = seg[0] === "Contacts" ? (seg[1] ? "update_contact" : "create_contact") : seg[0] === "Invoices" && seg[2] === "Email" ? "email" : seg[0] === "Invoices" && seg[1] ? "authorise" : seg[0] === "Invoices" ? "create_invoice" : null;
    if (!op) return json({ Title: "Not Found" }, 404);
    if (key) {
      if (key.length > 128) return json(validation(["Idempotency-Key must be 128 characters or fewer"]), 400);
      const mine = await rpc("xero_sandbox_claim_key", { p_tenant: tenant, p_key: key, p_method: method, p_path: path });
      if (!mine) {
        const prev = (await db(`xero_sandbox_idempotency?tenant_id=eq.${tenant}&key=eq.${enc(key)}&select=*`))[0];
        if (prev?.status == null) {
          await logReq(method, path, key, 409, "idempotency key in progress");
          return json({ Title: "Conflict", Detail: "A request with this Idempotency-Key is still being processed" }, 409);
        }
        await logReq(method, path, key, prev.status, "idempotent replay");
        return json(prev.body, prev.status);
      }
    }
    const f = op === "update_contact" ? null : await fault(op);
    if (f === "fail_500") out = { status: 500, body: { Title: "Server error" } };
    else if (f === "fail_400") out = { status: 400, body: validation(["Rejected by the sandbox (fault injection)"]) };
    else if (op === "create_contact") out = await createContact(tenant, body);
    else if (op === "update_contact") out = await updateContact(tenant, seg[1], body);
    else if (op === "create_invoice") out = await createInvoice(tenant, body, f);
    else if (op === "authorise") out = await setStatus(tenant, seg[1], body, f);
    else out = await emailInvoice(tenant, seg[1], f);
    if (key) {
      // fail_500 / timeouts are not "results": the key is released so a retry is processed (Xero does not cache 5xx).
      if (f === "fail_500") await db(`xero_sandbox_idempotency?tenant_id=eq.${tenant}&key=eq.${enc(key)}`, { method: "DELETE" });
      else await db(`xero_sandbox_idempotency?tenant_id=eq.${tenant}&key=eq.${enc(key)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: out.status, body: out.body }) });
    }
    if (f === "drop_response") {
      note = "fault drop_response: operation done, response lost";
      await logReq(method, path, key, 502, note);
      return json({ Title: "Bad Gateway", Detail: "upstream connection reset" }, 502);
    }
    if (f === "timeout") {
      note = "fault timeout: operation done, answering after 25s";
      await logReq(method, path, key, out.status, note);
      await sleep(25_000);
      return json(out.body, out.status);
    }
    await logReq(method, path, key, out.status, f ? `fault ${f}` : null);
    return json(out.body, out.status);
  } catch (e) {
    console.error(e);
    await logReq(method, path, key, 500, "sandbox internal error");
    return json({ Title: "Sandbox error" }, 500);
  }
});
