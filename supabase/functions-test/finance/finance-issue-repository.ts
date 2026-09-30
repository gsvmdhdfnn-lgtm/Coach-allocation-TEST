/**
 * Finance invoices + credit notes - repository (Finance Foundation F6; see
 * TEST-ENV.md "Finance Foundation - F6").
 *
 * Reads are by exact id through filterByFormula (one request each, never
 * one per line or per occurrence):
 *   - an invoice by Invoice ID; its lines by Invoice ID; its credit notes by
 *     Invoice ID; invoices by Source Draft ID / Client ID / Replaces Invoice
 *     ID / Correction ID; credit notes by Credit Note ID / Client ID;
 *     drafts by Replaces Invoice ID / Correction ID;
 *   - the issued-line claims for a set of occurrences (1 read per 40).
 * Every formula only narrows; each row is re-checked in code (exact value
 * and organisation). Values placed in a formula are pattern-checked first,
 * so they can never alter it.
 *
 * Writes go through the F5 batched helpers (createRows / patchRows /
 * deleteCreatedRows, batches of 10) and only ever touch the three F6
 * tables and the draft row being issued.
 */
import type { AirtableConfig } from "./repository.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { RECORD_ID_RE } from "./finance-commercial-repository.ts";
import { OCCURRENCE_ID_PATTERN } from "./finance-billing.ts";
import { CLIENT_ID_PATTERN, CORRECTION_ID_PATTERN, DRAFT_ID_PATTERN, INVOICE_ID_PATTERN } from "./finance-invoicing.ts";
import { FI, INVOICING_TABLES } from "./finance-invoicing-mapping.ts";
import { CLAIM_READ_CHUNK, chunk, listByFormula } from "./finance-invoicing-repository.ts";
import { FV, ISSUE_TABLES } from "./finance-issue-mapping.ts";

const field = (name: string) => `{${name}}`;
const inOrg = (r: Row, orgRec: string) => Array.isArray(r.fields?.[FV.org]) && r.fields[FV.org].length === 1 && r.fields[FV.org][0] === orgRec;

/** Rows of `table` whose `name` field is exactly `value` in this organisation. */
async function byExact(config: AirtableConfig, orgRec: string, table: string, name: string, value: string, pattern: RegExp): Promise<Row[]> {
  if (!RECORD_ID_RE.test(orgRec) || !pattern.test(value)) throw new Error(`Finance lookup refused: ${name} is malformed`);
  const rows = await listByFormula(config, table, `${field(name)}='${value}'`);
  return rows.filter((r) => r.fields[name] === value && inOrg(r, orgRec));
}

export const findInvoiceRows = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, ISSUE_TABLES.invoices, FV.invoice.id, invoiceId, INVOICE_ID_PATTERN);
export const listInvoiceRowsBySourceDraft = (c: AirtableConfig, org: string, draftId: string) => byExact(c, org, ISSUE_TABLES.invoices, FV.invoice.sourceDraftId, draftId, DRAFT_ID_PATTERN);
export const listInvoiceRowsByClient = (c: AirtableConfig, org: string, clientId: string) => byExact(c, org, ISSUE_TABLES.invoices, FV.invoice.clientId, clientId, CLIENT_ID_PATTERN);
export const listInvoiceRowsReplacing = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, ISSUE_TABLES.invoices, FV.invoice.replaces, invoiceId, INVOICE_ID_PATTERN);
export const listInvoiceRowsByCorrection = (c: AirtableConfig, org: string, correctionId: string) => byExact(c, org, ISSUE_TABLES.invoices, FV.invoice.correctionId, correctionId, CORRECTION_ID_PATTERN);
export const listInvoiceLineRows = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, ISSUE_TABLES.lines, FV.line.invoiceId, invoiceId, INVOICE_ID_PATTERN);
export const findCreditNoteRows = (c: AirtableConfig, org: string, creditNoteId: string) => byExact(c, org, ISSUE_TABLES.creditNotes, FV.credit.id, creditNoteId, CORRECTION_ID_PATTERN);
export const listCreditNoteRowsForInvoice = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, ISSUE_TABLES.creditNotes, FV.credit.invoiceId, invoiceId, INVOICE_ID_PATTERN);
export const listCreditNoteRowsByClient = (c: AirtableConfig, org: string, clientId: string) => byExact(c, org, ISSUE_TABLES.creditNotes, FV.credit.clientId, clientId, CLIENT_ID_PATTERN);
export const listDraftRowsReplacing = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, INVOICING_TABLES.drafts, FI.draft.replacesInvoiceId, invoiceId, INVOICE_ID_PATTERN);
export const listDraftRowsByCorrection = (c: AirtableConfig, org: string, correctionId: string) => byExact(c, org, INVOICING_TABLES.drafts, FI.draft.correctionId, correctionId, CORRECTION_ID_PATTERN);

/** Every issued invoice line (this organisation) for these occurrences - the permanent claims. */
export async function listInvoiceLineClaimRows(config: AirtableConfig, organisationRecordId: string, occurrenceIds: readonly string[]): Promise<Row[]> {
  if (!RECORD_ID_RE.test(organisationRecordId)) throw new Error("Issued claim lookup refused: organisation record id is malformed");
  const ids = [...new Set(occurrenceIds)];
  if (ids.some((id) => !OCCURRENCE_ID_PATTERN.test(id))) throw new Error("Issued claim lookup refused: occurrence id is malformed");
  const results = await Promise.all(chunk(ids, CLAIM_READ_CHUNK).map((c) => listByFormula(config, ISSUE_TABLES.lines, `OR(${c.map((id) => `${field(FV.line.occurrenceId)}='${id}'`).join(",")})`)));
  const seen = new Set<string>();
  return results.flat().filter((r) => inOrg(r, organisationRecordId) && ids.includes(r.fields[FV.line.occurrenceId]) && !seen.has(r.id) && !!seen.add(r.id));
}
