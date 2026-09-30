/**
 * Finance receivables + payments + client credit - repository (Finance
 * Foundation F7; see TEST-ENV.md "Finance Foundation - F7").
 *
 * Reads are by exact id through filterByFormula (one request each, never
 * one per payment / application):
 *   - payment entries (payments + reversals) by Invoice ID or by Payment Entry ID;
 *   - client credits by Client Credit ID, Client ID or Source Invoice ID;
 *   - credit application entries (applications + reversals) by Invoice ID,
 *     Client Credit ID or Application Entry ID;
 *   - due date changes by Invoice ID;
 *   - whole-organisation reads (receivables list / receipts) through the
 *     shared F3 listForOrganisation.
 * Every formula only narrows; each row is re-checked in code (exact value
 * and organisation). Values placed in a formula are pattern-checked first,
 * so they can never alter it.
 *
 * Writes go through the F5 batched helpers (via DraftTxn) and only ever
 * touch the four F7 tables - never an invoice, line or credit note row.
 */
import type { AirtableConfig } from "./repository.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { RECORD_ID_RE, listForOrganisation } from "./finance-commercial-repository.ts";
import { listByFormula } from "./finance-invoicing-repository.ts";
import { ISSUE_TABLES } from "./finance-issue-mapping.ts";
import { FR, RECEIVABLE_TABLES } from "./finance-receivables-mapping.ts";
import { APPLICATION_ID_PATTERN, CLIENT_CREDIT_ID_PATTERN, CLIENT_ID_PATTERN, INVOICE_ID_PATTERN, PAYMENT_ID_PATTERN } from "./finance-receivables.ts";

const field = (name: string) => `{${name}}`;
const inOrg = (r: Row, orgRec: string) => Array.isArray(r.fields?.[FR.org]) && r.fields[FR.org].length === 1 && r.fields[FR.org][0] === orgRec;

async function byExact(config: AirtableConfig, orgRec: string, table: string, name: string, value: string, pattern: RegExp): Promise<Row[]> {
  if (!RECORD_ID_RE.test(orgRec) || !pattern.test(value)) throw new Error(`Finance lookup refused: ${name} is malformed`);
  const rows = await listByFormula(config, table, `${field(name)}='${value}'`);
  return rows.filter((r) => r.fields[name] === value && inOrg(r, orgRec));
}

const T = RECEIVABLE_TABLES;
export const listPaymentRowsForInvoice = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, T.payments, FR.payment.invoiceId, invoiceId, INVOICE_ID_PATTERN);
export const findPaymentRows = (c: AirtableConfig, org: string, paymentId: string) => byExact(c, org, T.payments, FR.payment.id, paymentId, PAYMENT_ID_PATTERN);
export const findClientCreditRows = (c: AirtableConfig, org: string, creditId: string) => byExact(c, org, T.credits, FR.credit.id, creditId, CLIENT_CREDIT_ID_PATTERN);
export const listClientCreditRowsByClient = (c: AirtableConfig, org: string, clientId: string) => byExact(c, org, T.credits, FR.credit.clientId, clientId, CLIENT_ID_PATTERN);
export const listClientCreditRowsBySourceInvoice = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, T.credits, FR.credit.sourceInvoiceId, invoiceId, INVOICE_ID_PATTERN);
export const listApplicationRowsForInvoice = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, T.applications, FR.application.invoiceId, invoiceId, INVOICE_ID_PATTERN);
export const listApplicationRowsForCredit = (c: AirtableConfig, org: string, creditId: string) => byExact(c, org, T.applications, FR.application.creditId, creditId, CLIENT_CREDIT_ID_PATTERN);
export const listApplicationRowsByClient = (c: AirtableConfig, org: string, clientId: string) => byExact(c, org, T.applications, FR.application.clientId, clientId, CLIENT_ID_PATTERN);
export const findApplicationRows = (c: AirtableConfig, org: string, applicationId: string) => byExact(c, org, T.applications, FR.application.id, applicationId, APPLICATION_ID_PATTERN);
export const listDueChangeRowsForInvoice = (c: AirtableConfig, org: string, invoiceId: string) => byExact(c, org, T.dueChanges, FR.due.invoiceId, invoiceId, INVOICE_ID_PATTERN);

/** Everything the organisation-wide receivables read needs (6 reads, in parallel). */
export async function loadOrganisationReceivableRows(c: AirtableConfig, org: string): Promise<{ invoices: Row[]; notes: Row[]; payments: Row[]; credits: Row[]; applications: Row[]; dueChanges: Row[] }> {
  const [invoices, notes, payments, credits, applications, dueChanges] = await Promise.all([
    listForOrganisation(c, ISSUE_TABLES.invoices, org),
    listForOrganisation(c, ISSUE_TABLES.creditNotes, org),
    listForOrganisation(c, T.payments, org),
    listForOrganisation(c, T.credits, org),
    listForOrganisation(c, T.applications, org),
    listForOrganisation(c, T.dueChanges, org),
  ]);
  return { invoices, notes, payments, credits, applications, dueChanges };
}
