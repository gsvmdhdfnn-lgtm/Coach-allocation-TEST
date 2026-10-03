/**
 * Test-suite copy of the canonical finance/finance-invoice-documents-repository.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts; ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Official invoice documents - storage (Finance Foundation F22; see
 * TEST-ENV.md "Finance Foundation - F22"). Service role only.
 *
 *   finance_invoice_documents          ONE row per invoice (unique): status
 *                                      generating / ready / failed, the frozen
 *                                      snapshot hash, storage path, SHA-256,
 *                                      size, logo status. A ready row never
 *                                      changes; no row is ever deleted.
 *   finance_invoice_send_events        append-only manual "Sent" history.
 *   rpc finance_invoice_document_reserve  ONE transaction under the row lock:
 *                                      adopt a ready document, re-arm a failed /
 *                                      interrupted one for the SAME snapshot, or
 *                                      insert a new one.
 *   rpc finance_invoice_document_record   the attempt's outcome + its audit.
 *   rpc finance_invoice_send_record       a Sent event (ready document only) + audit.
 *   rpc finance_invoice_documents_insert_audit  download audit.
 *   Storage bucket finance-documents   PRIVATE (no public URL); objects are
 *                                      written once (x-upsert false) and a
 *                                      database trigger refuses any update or
 *                                      delete. Read back only here, with the
 *                                      service role, after the caller's access
 *                                      and organisation were checked.
 *
 * Every read filters on the caller's organisation and re-checks it on each
 * row. Airtable: the caller's own Organisation & Branding record is read by
 * its record id (for the logo only); the logo itself is fetched from
 * Airtable's attachment host only, with a timeout and a size cap.
 */
import type { AirtableConfig, GrantStoreConfig } from "./finance-repository.ts";
import { CONFIG_TABLES } from "./finance-repository.ts";
import { RECORD_ID_RE, airtableFetch, tableUrl } from "./finance-commercial-repository.ts";
import { type DocStatus, type InvoiceDocument, type LogoStatus, type SendEvent, DOCUMENT_BUCKET } from "./finance-invoice-documents.ts";

export const DOCUMENTS_TABLE = "finance_invoice_documents";
export const SENDS_TABLE = "finance_invoice_send_events";
export const DOCUMENT_RPC = {
  reserve: "finance_invoice_document_reserve",
  record: "finance_invoice_document_record",
  send: "finance_invoice_send_record",
  audit: "finance_invoice_documents_insert_audit",
} as const;

function headers(svc: GrantStoreConfig): Record<string, string> {
  return { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/json", Accept: "application/json" };
}
const base = (svc: GrantStoreConfig) => svc.supabaseUrl.replace(/\/+$/, "");
const rest = (svc: GrantStoreConfig, path: string) => `${base(svc)}/rest/v1/${path}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;
const objectUrl = (svc: GrantStoreConfig, path: string) => `${base(svc)}/storage/v1/object/${DOCUMENT_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** A refused document write: the database function's own rule code (f22:...), never a partial write. */
export class DocumentRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function read(svc: GrantStoreConfig, table: string, organisationId: string, filter: string, order: string): Promise<Record<string, any>[]> {
  const res = await fetch(`${rest(svc, table)}?organisation_id=${eq(organisationId)}${filter}&select=*&order=${order}`, { headers: headers(svc) });
  if (!res.ok) throw new Error(`${table} read failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(`${table} read returned an unexpected shape`);
  if (rows.some((r) => r.organisation_id !== organisationId)) throw new Error(`${table} read returned another organisation's row`);
  return rows;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(String(v)).toISOString());
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function documentFromRow(r: Record<string, any>): InvoiceDocument {
  if (!["generating", "ready", "failed"].includes(r.status)) throw new Error("document row has an unknown status");
  return {
    organisationId: r.organisation_id,
    documentId: r.document_id,
    invoiceId: r.invoice_id,
    officialNumber: r.official_number,
    status: r.status as DocStatus,
    snapshotSha256: r.snapshot_sha256,
    rendererVersion: r.renderer_version,
    storageBucket: r.storage_bucket,
    storagePath: r.storage_path,
    sha256: r.sha256 ?? null,
    byteSize: intOrNull(r.byte_size),
    logoStatus: (r.logo_status ?? null) as LogoStatus | null,
    attempts: Number(r.attempts),
    lastErrorCode: r.last_error_code ?? null,
    reservedAt: iso(r.reserved_at) as string,
    reservedBy: r.reserved_by,
    generatedAt: iso(r.generated_at),
    generatedBy: r.generated_by ?? null,
  };
}
export function sendFromRow(r: Record<string, any>): SendEvent {
  return {
    sendId: r.send_id,
    invoiceId: r.invoice_id,
    officialNumber: r.official_number,
    documentId: r.document_id,
    documentSha256: r.document_sha256,
    sentOn: String(r.sent_on).slice(0, 10),
    sentTo: Array.isArray(r.sent_to) ? r.sent_to.map(String) : [],
    note: r.note ?? null,
    recordedBy: r.recorded_by,
    recordedAt: iso(r.recorded_at) as string,
  };
}

/** The invoice's document (null when none). Never another organisation's. */
export async function loadDocument(svc: GrantStoreConfig, organisationId: string, invoiceId: string): Promise<InvoiceDocument | null> {
  const rows = await read(svc, DOCUMENTS_TABLE, organisationId, `&invoice_id=${eq(invoiceId)}&document_type=eq.invoice`, "document_id.asc");
  if (rows.length > 1) throw new Error("more than one document for one invoice");
  const d = rows.length ? documentFromRow(rows[0]) : null;
  if (d && d.invoiceId !== invoiceId) throw new Error("document read returned another invoice's row");
  return d;
}
export async function loadSends(svc: GrantStoreConfig, organisationId: string, invoiceId: string): Promise<SendEvent[]> {
  const rows = await read(svc, SENDS_TABLE, organisationId, `&invoice_id=${eq(invoiceId)}`, "recorded_at.asc,send_id.asc");
  const out = rows.map(sendFromRow);
  if (out.some((s) => s.invoiceId !== invoiceId)) throw new Error("send history read returned another invoice's row");
  return out;
}

async function rpc(svc: GrantStoreConfig, fn: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(rest(svc, `rpc/${fn}`), { method: "POST", headers: headers(svc), body: JSON.stringify(args) });
  const t = await res.text();
  if (!res.ok) {
    let msg = t;
    try {
      msg = JSON.parse(t)?.message ?? t;
    } catch {
      /* raw text */
    }
    const mm = /f22:([a-z_]+)/.exec(String(msg));
    if (mm) throw new DocumentRefusal(mm[1]);
    throw new Error(`Supabase RPC ${fn} failed: ${res.status} ${t}`);
  }
  return t ? JSON.parse(t) : null;
}

export async function reserveDocument(svc: GrantStoreConfig, organisationId: string, d: { documentId: string; invoiceId: string; officialNumber: string; snapshotSha256: string; rendererVersion: string; storagePath: string; reservedAt: string; reservedBy: string }): Promise<{ adopted: boolean; document: InvoiceDocument }> {
  const out = await rpc(svc, DOCUMENT_RPC.reserve, {
    p_org: organisationId,
    p_document: { document_id: d.documentId, invoice_id: d.invoiceId, official_number: d.officialNumber, snapshot_sha256: d.snapshotSha256, renderer_version: d.rendererVersion, storage_path: d.storagePath, reserved_at: d.reservedAt, reserved_by: d.reservedBy },
  });
  if (!out || typeof out !== "object" || !out.row) throw new Error("document reserve returned an unexpected shape");
  const document = documentFromRow(out.row);
  if (document.organisationId !== organisationId || document.invoiceId !== d.invoiceId) throw new Error("document reserve returned another invoice's row");
  return { adopted: out.adopted === true, document };
}

export async function recordDocument(svc: GrantStoreConfig, organisationId: string, documentId: string, result: { status: "ready"; sha256: string; byteSize: number; logoStatus: LogoStatus; generatedAt: string; generatedBy: string } | { status: "failed"; errorCode: string }, events: Record<string, unknown>[]): Promise<InvoiceDocument> {
  const p_result = result.status === "ready" ? { status: "ready", sha256: result.sha256, byte_size: result.byteSize, logo_status: result.logoStatus, generated_at: result.generatedAt, generated_by: result.generatedBy } : { status: "failed", error_code: result.errorCode };
  return documentFromRow(await rpc(svc, DOCUMENT_RPC.record, { p_org: organisationId, p_document_id: documentId, p_result, p_events: events }));
}

export async function recordSend(svc: GrantStoreConfig, organisationId: string, s: { sendId: string; invoiceId: string; officialNumber: string; documentId: string; documentSha256: string; sentOn: string; sentTo: string[]; note: string | null; recordedBy: string; recordedAt: string }, events: Record<string, unknown>[]): Promise<SendEvent> {
  const row = await rpc(svc, DOCUMENT_RPC.send, {
    p_org: organisationId,
    p_send: { send_id: s.sendId, invoice_id: s.invoiceId, official_number: s.officialNumber, document_id: s.documentId, document_sha256: s.documentSha256, sent_on: s.sentOn, sent_to: s.sentTo, note: s.note, recorded_by: s.recordedBy, recorded_at: s.recordedAt },
    p_events: events,
  });
  return sendFromRow(row);
}

export async function insertDocumentAudit(svc: GrantStoreConfig, organisationId: string, events: Record<string, unknown>[]): Promise<void> {
  await rpc(svc, DOCUMENT_RPC.audit, { p_org: organisationId, p_events: events });
}

// ---------------------------------------------------------------------
// Private Storage (service role)
// ---------------------------------------------------------------------

/** Writes the object ONCE. "exists" when an object is already at the path (it is never overwritten). */
export async function uploadDocument(svc: GrantStoreConfig, path: string, bytes: Uint8Array): Promise<"created" | "exists"> {
  const res = await fetch(objectUrl(svc, path), {
    method: "POST",
    headers: { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}`, "Content-Type": "application/pdf", "x-upsert": "false", "cache-control": "no-store" },
    body: bytes,
  });
  const t = await res.text();
  if (res.ok) return "created";
  if (res.status === 409 || /duplicate|already exists/i.test(t)) return "exists";
  throw new Error(`Storage upload failed: ${res.status} ${t.slice(0, 200)}`);
}

/** The stored bytes (null when there is no object at the path). */
export async function downloadDocument(svc: GrantStoreConfig, path: string): Promise<Uint8Array | null> {
  const res = await fetch(objectUrl(svc, path), { headers: { apikey: svc.serviceRoleKey, Authorization: `Bearer ${svc.serviceRoleKey}` } });
  if (res.status === 404) {
    await res.text();
    return null;
  }
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 400 && /not.?found/i.test(t)) return null;
    throw new Error(`Storage download failed: ${res.status} ${t.slice(0, 200)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------
// Logo (Airtable Organisation & Branding "Logo" attachment)
// ---------------------------------------------------------------------

/** The caller's own Organisation & Branding row (by record id; the formula only narrows - the id is re-checked). */
export async function loadOrganisationFields(config: AirtableConfig, recordId: string): Promise<Record<string, unknown>> {
  if (!RECORD_ID_RE.test(recordId)) throw new Error("organisation record id is malformed");
  const url = new URL(tableUrl(config, CONFIG_TABLES.organisations));
  url.searchParams.set("filterByFormula", `RECORD_ID()='${recordId}'`);
  const res = await airtableFetch(url.toString(), { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) throw new Error(`Airtable error for ${CONFIG_TABLES.organisations}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const rows = Array.isArray(data?.records) ? data.records.filter((r: any) => r?.id === recordId) : [];
  if (rows.length !== 1) throw new Error("organisation record could not be read");
  return rows[0].fields ?? {};
}

/** The first Logo attachment's URL (null when none is set). */
export function logoUrlOf(fields: Record<string, unknown>): string | null {
  const a = fields["Logo"];
  if (!Array.isArray(a) || !a.length) return null;
  const u = a[0] && typeof a[0] === "object" ? (a[0] as any).url : null;
  return typeof u === "string" && u ? u : null;
}

export const LOGO_MAX_BYTES = 2_000_000;
const LOGO_HOST_RE = /(^|\.)airtableusercontent\.com$|^dl\.airtable\.com$/;

/** Fetches the logo from Airtable's attachment host only (https, no redirects elsewhere, timeout, size cap). */
export async function fetchLogo(url: string, timeoutMs = 5000): Promise<Uint8Array> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("logo URL is malformed");
  }
  if (u.protocol !== "https:" || !LOGO_HOST_RE.test(u.hostname)) throw new Error("logo URL is not an Airtable attachment");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(u.toString(), { signal: ctl.signal, redirect: "error" });
    if (!res.ok) throw new Error(`logo fetch failed: ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > LOGO_MAX_BYTES) throw new Error("logo larger than 2 MB");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > LOGO_MAX_BYTES) throw new Error("logo larger than 2 MB");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}
