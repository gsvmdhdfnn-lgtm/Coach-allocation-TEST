/**
 * Official Hub invoice PDF + manual "Sent" - orchestration (Finance
 * Foundation F22; see TEST-ENV.md "Finance Foundation - F22"). Every route
 * authorises through F1's authorizeFinance() first: View reads / downloads,
 * Manage generates / retries / marks Sent. The organisation is the caller's;
 * nothing in a request can choose a tenant, a path or the document's content.
 *
 *   POST /invoices/{FIV}/pdf       (Manage) generate / retry the official PDF
 *   GET  /invoices/{FIV}/pdf       (View)   stream the stored PDF (hash re-verified; audited) - never generates
 *   GET  /invoices/{FIV}/document  (View)   generation status + Sent history + allowed actions (never audited)
 *   POST /invoices/{FIV}/sent      (Manage) record that the official PDF was sent (append-only; never payment)
 *
 * Generation runs under the shared Finance write lock (commercial:{org}) and
 * is idempotent and single-document by construction:
 *   1. the invoice is loaded from its stored, immutable F6 rows and checked
 *      against the official-document contract (Hub authority, issued, full
 *      F22 snapshot) - else 409, nothing written;
 *   2. RESERVE (one transaction): a ready document is ADOPTED (never
 *      re-rendered); a failed / interrupted one is re-armed only for the
 *      SAME snapshot hash; otherwise one new row (unique per invoice);
 *   3. render from the frozen snapshot (+ the organisation logo, embedded
 *      now; a missing / broken logo falls back to the text brand - never
 *      blocks);
 *   4. write the object ONCE to the private bucket (x-upsert false); an
 *      object already there (an earlier attempt that was not recorded) is
 *      adopted as it is - never overwritten;
 *   5. RECORD (one transaction): ready + SHA-256 + size (or failed + code),
 *      with its audit.
 * A failure leaves the invoice issued with its number unchanged; retry
 * renders the same snapshot.
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import { acquireWriteLock, releaseWriteLock } from "./finance-commercial-repository.ts";
import { decodeImage, sha256Hex } from "./finance-pdf.ts";
import { type Fail as IssueFail, type IssueDeps, type LoadedInvoice, loadInvoice } from "./finance-issue-orchestrator.ts";
import {
  type InvoiceDocument,
  type LogoStatus,
  type SentRequest,
  DOCUMENT_CONTRACT,
  DOCUMENT_EVENTS,
  ENTITY_DOCUMENT,
  ENTITY_INVOICE,
  RENDERER_VERSION,
  auditDocument,
  canonicalJson,
  defaultRecipients,
  documentActions,
  documentAuditEvent,
  documentContract,
  fileNameOf,
  generationStatusOf,
  isHubAuthority,
  newDocumentId,
  publicDocument,
  publicSend,
  renderInvoicePdf,
  sentSummary,
  storagePathOf,
  DOCUMENT_BUCKET,
} from "./finance-invoice-documents.ts";
import { DocumentRefusal, downloadDocument, fetchLogo, insertDocumentAudit, loadDocument, loadOrganisationFields, loadSends, logoUrlOf, recordDocument, recordSend, reserveDocument, uploadDocument } from "./finance-invoice-documents-repository.ts";

export interface DocumentDeps extends IssueDeps {
  documents?: { fetchLogo?: (url: string) => Promise<Uint8Array>; logoTimeoutMs?: number };
}
export type DFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 500 | 503; code: string; error: string; details?: Record<string, unknown> };
export type DOk = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> };
export type PdfOk = { status: "ok"; httpStatus: 200; pdf: { bytes: Uint8Array; fileName: string; sha256: string } };
const fail = (httpStatus: DFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): DFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is DFail => !!x && typeof x === "object" && (x as any).status === "error";
/** F6's load refusal as this module's (same status / code / message; field detail carried as details). */
const loadFailed = (x: LoadedInvoice | IssueFail): x is IssueFail => (x as any).status === "error";
const asD = (f: IssueFail): DFail => fail(f.httpStatus, f.code, f.error, f.fields ? { fields: f.fields } : undefined);

const now = (deps: DocumentDeps) => (deps.clock ?? (() => new Date()))();
const hex = (deps: DocumentDeps) => (deps.randomHex ?? (() => crypto.randomUUID()))();
const orgBody = (o: OrganisationContext) => ({ organisationId: o.organisationId, name: o.name });
const lockKey = (o: OrganisationContext) => `commercial:${o.organisationId}`;
const unavailable = () => fail(503, "finance_documents_unavailable", "The invoice document could not be loaded just now - try again");
const utf8 = (s: string) => new TextEncoder().encode(s);

const REFUSALS: Record<string, [409 | 404, string, string]> = {
  snapshot_changed: [409, "document_snapshot_changed", "An official document for this invoice was started from different data - nothing was generated; this needs investigation"],
  document_not_ready: [409, "pdf_not_ready", "Generate the official PDF first - Sent records exactly which document was sent"],
  document_mismatch: [409, "document_mismatch", "The official document changed while this was being recorded - nothing was recorded"],
  document_not_found: [404, "document_not_found", "This invoice has no official document"],
  document_not_generating: [409, "document_not_generating", "This document's generation was already recorded"],
};
function refusalFail(e: unknown): DFail | null {
  if (!(e instanceof DocumentRefusal)) return null;
  const [s, code, msg] = REFUSALS[e.code] ?? [409, e.code, "The change was refused by the document ledger's rules - nothing was changed"];
  return fail(s, code, msg);
}

async function withLock<T>(deps: DocumentDeps, org: OrganisationContext, run: () => Promise<T | DFail>): Promise<T | DFail> {
  let token: string | null;
  try {
    token = await acquireWriteLock(deps.grants, lockKey(org));
  } catch (e) {
    console.error(e);
    return fail(503, "finance_documents_unavailable", "The change could not be made just now - try again");
  }
  if (!token) return fail(409, "finance_commercial_busy", "Finance is being changed by someone else right now - try again in a moment");
  try {
    return await run();
  } finally {
    try {
      await releaseWriteLock(deps.grants, lockKey(org), token);
    } catch (e) {
      console.error("Finance write lock release failed (expires on its own)", e);
    }
  }
}

function contractFail(r: { code: string; error: string; httpStatus: 404 | 409; missing?: string[] }): DFail {
  return fail(r.httpStatus, r.code, r.error, r.missing ? { missing: r.missing } : undefined);
}

// ---------------------------------------------------------------------
// Generate / retry
// ---------------------------------------------------------------------

/** The logo for this generation: embedded when it can be fetched + decoded; otherwise the text brand (never blocks). */
async function logoFor(deps: DocumentDeps, org: OrganisationContext): Promise<{ image: Awaited<ReturnType<typeof decodeImage>> | null; status: LogoStatus; reason: string | null }> {
  let url: string | null;
  try {
    url = logoUrlOf(await loadOrganisationFields(deps.airtable, org.recordId));
  } catch (e) {
    console.error(e);
    return { image: null, status: "unavailable", reason: "organisation branding could not be read" };
  }
  if (!url) return { image: null, status: "none", reason: null };
  try {
    const bytes = await (deps.documents?.fetchLogo ?? ((u: string) => fetchLogo(u, deps.documents?.logoTimeoutMs)))(url);
    const img = await decodeImage(bytes);
    return img.ok ? { image: img, status: "embedded", reason: null } : { image: null, status: "unavailable", reason: img.reason };
  } catch (e) {
    return { image: null, status: "unavailable", reason: String((e as Error).message).slice(0, 120) };
  }
}

type GenResult = { httpStatus: 200 | 201; outcome: "generated" | "already_generated"; document: InvoiceDocument; logoReason: string | null };

async function generateLocked(deps: DocumentDeps, org: OrganisationContext, userId: string, l: LoadedInvoice, route: string, reason: string | null, trigger: "issue" | "manual"): Promise<GenResult | DFail> {
  const inv = l.invoice.value;
  const c = documentContract(inv, l.lines);
  if (!c.ok) return contractFail(c);
  const snapshotSha256 = await sha256Hex(utf8(canonicalJson(c.input)));
  const number = c.input.officialNumber;
  const storagePath = storagePathOf(org.organisationId, inv.invoiceId, number);
  const at = now(deps).toISOString();
  let reserved: { adopted: boolean; document: InvoiceDocument };
  try {
    reserved = await reserveDocument(deps.grants, org.organisationId, { documentId: newDocumentId("FDC", hex(deps)), invoiceId: inv.invoiceId, officialNumber: number, snapshotSha256, rendererVersion: RENDERER_VERSION, storagePath, reservedAt: at, reservedBy: userId });
  } catch (e) {
    const r = refusalFail(e);
    if (r) return r;
    console.error(e);
    return fail(503, "finance_documents_unavailable", "The PDF could not be generated just now - the invoice stays issued; try again");
  }
  const doc = reserved.document;
  if (reserved.adopted) return { httpStatus: 200, outcome: "already_generated", document: doc, logoReason: null };
  if (doc.storagePath !== storagePath || doc.snapshotSha256 !== snapshotSha256 || doc.officialNumber !== number) return fail(500, "document_integrity_failed", "The document record does not match this invoice - nothing was generated; this needs investigation");

  const ev = (eventType: string, after: Record<string, unknown>) =>
    documentAuditEvent({ organisationId: org.organisationId, actorUserId: userId, eventType, entityType: ENTITY_DOCUMENT, recordId: doc.documentId, before: auditDocument(doc), after, reason, route, context: { invoiceId: inv.invoiceId, officialNumber: number, trigger, bucket: DOCUMENT_BUCKET } });

  let errorCode: string | null = null;
  let bytes: Uint8Array | null = null;
  const logo = await logoFor(deps, org);
  let logoStatus: LogoStatus = logo.status;
  try {
    bytes = renderInvoicePdf(c.input, logo.image && logo.image.ok ? logo.image.image : null).bytes;
  } catch (e) {
    console.error(e);
    errorCode = "render_failed";
  }
  if (bytes) {
    try {
      const put = await uploadDocument(deps.grants, storagePath, bytes);
      if (put === "exists") {
        // An earlier attempt stored this object but was not recorded: adopt it as it is (never overwritten).
        const existing = await downloadDocument(deps.grants, storagePath);
        if (!existing || existing.length < 5 || new TextDecoder().decode(existing.subarray(0, 5)) !== "%PDF-") errorCode = "stored_object_invalid";
        else {
          bytes = existing;
          const hasImage = new TextDecoder().decode(existing).includes("/Subtype /Image");
          logoStatus = hasImage ? "embedded" : logoStatus === "embedded" ? "unavailable" : logoStatus;
        }
      }
    } catch (e) {
      console.error(e);
      errorCode = "storage_failed";
    }
  }
  if (errorCode || !bytes) {
    const code = errorCode ?? "render_failed";
    try {
      await recordDocument(deps.grants, org.organisationId, doc.documentId, { status: "failed", errorCode: code }, [ev(DOCUMENT_EVENTS.generationFailed, { ...auditDocument({ ...doc, status: "failed", lastErrorCode: code }) })]);
    } catch (e) {
      console.error(e);
    }
    return fail(503, "pdf_generation_failed", `The official PDF could not be generated (${code}) - the invoice stays issued as ${number}; retry generating the PDF`, { pdfGenerationStatus: "failed", errorCode: code });
  }
  const sha256 = await sha256Hex(bytes);
  try {
    const ready = await recordDocument(deps.grants, org.organisationId, doc.documentId, { status: "ready", sha256, byteSize: bytes.length, logoStatus, generatedAt: at, generatedBy: userId }, [
      ev(DOCUMENT_EVENTS.generated, { ...auditDocument({ ...doc, status: "ready", sha256, byteSize: bytes.length, logoStatus, lastErrorCode: null }), logoFallbackReason: logo.reason }),
    ]);
    return { httpStatus: 201, outcome: "generated", document: ready, logoReason: logo.reason };
  } catch (e) {
    const r = refusalFail(e);
    if (r) return r;
    console.error(e);
    return fail(503, "pdf_generation_unrecorded", `The PDF was stored but could not be recorded - the invoice stays issued as ${number}; retry (the stored PDF is adopted, never replaced)`, { pdfGenerationStatus: "generating" });
  }
}

/** POST /invoices/{FIV}/pdf - generate (or retry) the official PDF. Manage only. */
export async function generateInvoiceDocument(deps: DocumentDeps, caller: FinanceCaller, invoiceId: string, reason: string | null): Promise<DOk | DFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const r = await withLock(deps, org, async () => {
    const l = await loadInvoice(deps, org, invoiceId);
    if (loadFailed(l)) return asD(l);
    return generateLocked(deps, org, caller.userId, l, `POST /invoices/${invoiceId}/pdf`, reason, "manual");
  });
  if (isFail(r)) return r;
  return { status: "ok", httpStatus: r.httpStatus, body: { contract: DOCUMENT_CONTRACT, organisation: orgBody(org), access: "manage", outcome: r.outcome, changed: r.outcome === "generated", invoiceId, pdfGenerationStatus: r.document.status, document: publicDocument(r.document), ...(r.logoReason ? { logoFallback: r.logoReason } : {}) } };
}

/**
 * Called by the F6 Hub-authority issue AFTER the issue has committed and its
 * lock was released. Never fails the issue: the result is only reported
 * (pdfGenerationStatus ready / failed / generating) and can be retried.
 */
export async function generateAfterIssue(deps: DocumentDeps, org: OrganisationContext, userId: string, invoiceId: string): Promise<Record<string, unknown>> {
  try {
    const r = await withLock(deps, org, async () => {
      const l = await loadInvoice(deps, org, invoiceId);
      if (loadFailed(l)) return asD(l);
      return generateLocked(deps, org, userId, l, `POST /invoice-drafts/{id}/issue -> pdf`, null, "issue");
    });
    if (isFail(r)) return { pdfGenerationStatus: (r.details?.pdfGenerationStatus as string) ?? "pending", code: r.code, error: r.error, retry: `POST /invoices/${invoiceId}/pdf` };
    return { pdfGenerationStatus: r.document.status, document: publicDocument(r.document), ...(r.logoReason ? { logoFallback: r.logoReason } : {}) };
  } catch (e) {
    console.error(e);
    return { pdfGenerationStatus: "pending", code: "finance_documents_unavailable", error: "The PDF was not generated - the invoice is issued; retry generating the PDF", retry: `POST /invoices/${invoiceId}/pdf` };
  }
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

/** GET /invoices/{FIV}/document - status + Sent history + allowed actions. View; never audited; never generates. */
export async function readInvoiceDocument(deps: DocumentDeps, caller: FinanceCaller, invoiceId: string): Promise<DOk | DFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const l = await loadInvoice(deps, org, invoiceId);
  if (loadFailed(l)) return asD(l);
  const inv = l.invoice.value;
  const c = documentContract(inv, l.lines);
  let doc: InvoiceDocument | null = null;
  let sends: Awaited<ReturnType<typeof loadSends>> = [];
  try {
    [doc, sends] = await Promise.all([loadDocument(deps.grants, org.organisationId, invoiceId), loadSends(deps.grants, org.organisationId, invoiceId)]);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  return {
    status: "ok",
    httpStatus: 200,
    body: {
      contract: DOCUMENT_CONTRACT,
      organisation: orgBody(org),
      access: auth.access,
      invoiceId,
      officialNumber: inv.numberAuthority === "hub" ? inv.hubInvoiceNumber : inv.externalInvoiceNumber,
      numberAuthority: inv.numberAuthority,
      issueAuthority: inv.issueAuthority,
      invoiceStatus: inv.status,
      eligibility: c.ok ? { eligible: true } : { eligible: false, code: c.code, reason: c.error, ...(c.missing ? { missing: c.missing } : {}) },
      pdfGenerationStatus: generationStatusOf(doc, c),
      document: doc ? publicDocument(doc) : null,
      delivery: sentSummary(sends),
      payment: { note: "Payment is recorded separately (receivables) - generating, downloading or sending an invoice never marks it paid" },
      actions: documentActions(auth.access, c.ok, doc),
    },
  };
}

/** GET /invoices/{FIV}/pdf - the stored official PDF, its SHA-256 re-verified before a byte is served. View; audited; never generates. */
export async function downloadInvoicePdf(deps: DocumentDeps, caller: FinanceCaller, invoiceId: string): Promise<PdfOk | DFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  let doc: InvoiceDocument | null;
  try {
    doc = await loadDocument(deps.grants, org.organisationId, invoiceId);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!doc) {
    // Say why there is nothing (and 404 for an invoice that is not this organisation's) - never generate here.
    const l = await loadInvoice(deps, org, invoiceId);
    if (loadFailed(l)) return asD(l);
    const c = documentContract(l.invoice.value, l.lines);
    if (!c.ok) return contractFail(c);
    return fail(409, "pdf_not_generated", "The official PDF has not been generated yet - Finance Manage can generate it", { pdfGenerationStatus: "pending" });
  }
  if (doc.status === "generating") return fail(409, "pdf_generating", "The official PDF is being generated - try again in a moment", { pdfGenerationStatus: "generating" });
  if (doc.status === "failed") return fail(409, "pdf_generation_failed", "The official PDF could not be generated - Finance Manage can retry", { pdfGenerationStatus: "failed", errorCode: doc.lastErrorCode });
  // The path is never trusted: it must be exactly the one derived from this organisation + invoice + number.
  if (doc.storageBucket !== DOCUMENT_BUCKET || doc.storagePath !== storagePathOf(org.organisationId, doc.invoiceId, doc.officialNumber) || doc.invoiceId !== invoiceId) return fail(500, "pdf_integrity_failed", "The stored document's location does not match this invoice - it was not served");
  let bytes: Uint8Array | null;
  try {
    bytes = await downloadDocument(deps.grants, doc.storagePath);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
  if (!bytes) return fail(500, "pdf_missing", "The stored PDF could not be found - it was not served; this needs investigation");
  const sha = await sha256Hex(bytes);
  if (sha !== doc.sha256 || bytes.length !== doc.byteSize) return fail(500, "pdf_integrity_failed", "The stored PDF does not match its recorded SHA-256 - it was not served; this needs investigation");
  try {
    await insertDocumentAudit(deps.grants, org.organisationId, [
      documentAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: DOCUMENT_EVENTS.downloaded, entityType: ENTITY_DOCUMENT, recordId: doc.documentId, before: null, after: { documentId: doc.documentId, invoiceId, officialNumber: doc.officialNumber, sha256: sha, byteSize: bytes.length }, reason: null, route: `GET /invoices/${invoiceId}/pdf`, context: { access: auth.access } }),
    ]);
  } catch (e) {
    console.error(e);
    return fail(503, "finance_audit_unavailable", "The download could not be recorded just now - try again");
  }
  return { status: "ok", httpStatus: 200, pdf: { bytes, fileName: fileNameOf(doc.officialNumber), sha256: sha } };
}

// ---------------------------------------------------------------------
// Mark as Sent
// ---------------------------------------------------------------------

/** POST /invoices/{FIV}/sent - record a manual send of the official PDF (append-only; resends allowed). Manage only; never payment. */
export async function markInvoiceSent(deps: DocumentDeps, caller: FinanceCaller, invoiceId: string, req: SentRequest): Promise<DOk | DFail> {
  const auth = await authorizeFinance(deps, caller, "manage");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const r = await withLock(deps, org, async (): Promise<DOk | DFail> => {
    const l = await loadInvoice(deps, org, invoiceId);
    if (loadFailed(l)) return asD(l);
    const inv = l.invoice.value;
    if (!isHubAuthority(inv)) return fail(409, "xero_invoice_document", "This invoice is issued and sent by Xero - its delivery is not recorded in the Hub");
    let doc: InvoiceDocument | null;
    let sends: Awaited<ReturnType<typeof loadSends>>;
    try {
      [doc, sends] = await Promise.all([loadDocument(deps.grants, org.organisationId, invoiceId), loadSends(deps.grants, org.organisationId, invoiceId)]);
    } catch (e) {
      console.error(e);
      return unavailable();
    }
    if (!doc || doc.status !== "ready" || !doc.sha256) return fail(409, "pdf_not_ready", "Generate the official PDF first - Sent records exactly which document was sent");
    const atDate = now(deps);
    const today = todayIn(org.timezone, atDate);
    const sentOn = req.sentOn ?? today;
    if (sentOn > today) return fail(400, "sent_on_in_future", `sentOn cannot be after today (${today})`);
    if (inv.invoiceDate && sentOn < inv.invoiceDate) return fail(400, "sent_before_issue", `sentOn cannot be before the invoice was issued (${inv.invoiceDate})`);
    const sentTo = req.sentTo ?? defaultRecipients(inv);
    if (!sentTo.length) return fail(400, "recipients_missing", "Give sentTo - the invoice has no frozen billing email");
    const sendId = newDocumentId("FSE", hex(deps));
    const at = atDate.toISOString();
    const after = { sendId, sentOn, sentTo, note: req.note, documentId: doc.documentId, documentSha256: doc.sha256, officialNumber: doc.officialNumber, timesSent: sends.length + 1 };
    let saved;
    try {
      saved = await recordSend(deps.grants, org.organisationId, { sendId, invoiceId, officialNumber: doc.officialNumber, documentId: doc.documentId, documentSha256: doc.sha256, sentOn, sentTo, note: req.note, recordedBy: caller.userId, recordedAt: at }, [
        documentAuditEvent({ organisationId: org.organisationId, actorUserId: caller.userId, eventType: DOCUMENT_EVENTS.sent, entityType: ENTITY_INVOICE, recordId: invoiceId, before: { timesSent: sends.length }, after, reason: req.note, route: `POST /invoices/${invoiceId}/sent`, context: { invoiceStatus: inv.status, paymentUnchanged: true } }),
      ]);
    } catch (e) {
      const rf = refusalFail(e);
      if (rf) return rf;
      console.error(e);
      return fail(503, "finance_documents_unavailable", "The send could not be recorded just now - nothing was recorded; try again");
    }
    return {
      status: "ok",
      httpStatus: 201,
      body: {
        contract: DOCUMENT_CONTRACT,
        organisation: orgBody(org),
        access: "manage",
        changed: true,
        outcome: "sent_recorded",
        invoiceId,
        invoiceStatus: inv.status,
        send: publicSend(saved),
        delivery: sentSummary([...sends, saved]),
        payment: { note: "Recorded as sent only - the invoice's payment state is unchanged (payments are recorded separately)" },
      },
    };
  });
  return r;
}
