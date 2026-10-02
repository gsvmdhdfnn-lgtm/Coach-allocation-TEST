/**
 * Month Report + Finance Overview - repository (Finance Foundation F18; see
 * TEST-ENV.md "Finance Foundation - F18"). READ ONLY: nothing here writes.
 *
 * The only new reads (everything else is loaded through its owning slice's
 * repository, once per request):
 *   - F6 invoice lines whose Occurrence Date is in the report window
 *     (1 date-windowed read), then every line of the invoices they belong to
 *     (1 read per 40 invoices) - a receipt is spread over the WHOLE invoice;
 *   - F5 Included draft lines whose Occurrence Date is in the window
 *     (1 date-windowed read).
 * Formulas only narrow; every row is re-checked in code (organisation link,
 * exact ids, date window). Values placed in a formula are pattern-checked first.
 */
import type { AirtableConfig } from "./repository.ts";
import type { Row } from "./finance-commercial-mapping.ts";
import { RECORD_ID_RE } from "./finance-commercial-repository.ts";
import { dayBefore } from "./finance-commercial.ts";
import { dayAfter } from "./finance-lifecycle.ts";
import { isIsoDate } from "./finance-effective-dating.ts";
import { INVOICE_ID_PATTERN } from "./finance-invoicing.ts";
import { FI, INVOICING_TABLES } from "./finance-invoicing-mapping.ts";
import { CLAIM_READ_CHUNK, chunk, listByFormula } from "./finance-invoicing-repository.ts";
import { FV, ISSUE_TABLES } from "./finance-issue-mapping.ts";

const field = (name: string) => `{${name}}`;
const inOrg = (r: Row, org: string, key: string) => Array.isArray(r.fields?.[key]) && r.fields[key].length === 1 && r.fields[key][0] === org;
const sel = (v: unknown) => (v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : v);
function check(org: string, from: string, to: string) {
  if (!RECORD_ID_RE.test(org)) throw new Error("Month report read refused: organisation record id is malformed");
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error("Month report read refused: dates are malformed");
}
const windowFormula = (dateField: string, from: string, to: string) => `AND(IS_AFTER(${field(dateField)},'${dayBefore(from)}'),IS_BEFORE(${field(dateField)},'${dayAfter(to)}'))`;
const inWindow = (v: unknown, from: string, to: string) => typeof v === "string" && v >= from && v <= to;

/** F6 invoice lines (this organisation) for occurrences dated from..to. */
export async function listInvoiceLineRowsInWindow(config: AirtableConfig, org: string, from: string, to: string): Promise<Row[]> {
  check(org, from, to);
  const rows = await listByFormula(config, ISSUE_TABLES.lines, windowFormula(FV.line.date, from, to));
  return rows.filter((r) => inOrg(r, org, FV.org) && inWindow(r.fields[FV.line.date], from, to));
}

/** Every F6 invoice line of these invoices (this organisation). */
export async function listInvoiceLineRowsForInvoices(config: AirtableConfig, org: string, invoiceIds: readonly string[]): Promise<Row[]> {
  if (!RECORD_ID_RE.test(org)) throw new Error("Month report read refused: organisation record id is malformed");
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.some((id) => !INVOICE_ID_PATTERN.test(id))) throw new Error("Month report read refused: invoice id is malformed");
  if (!ids.length) return [];
  const results = await Promise.all(chunk(ids, CLAIM_READ_CHUNK).map((c) => listByFormula(config, ISSUE_TABLES.lines, `OR(${c.map((id) => `${field(FV.line.invoiceId)}='${id}'`).join(",")})`)));
  const seen = new Set<string>();
  return results.flat().filter((r) => inOrg(r, org, FV.org) && ids.includes(r.fields[FV.line.invoiceId]) && !seen.has(r.id) && !!seen.add(r.id));
}

/** F5 Included draft lines (this organisation, any live draft) for occurrences dated from..to. */
export async function listIncludedDraftLineRowsInWindow(config: AirtableConfig, org: string, from: string, to: string): Promise<Row[]> {
  check(org, from, to);
  const rows = await listByFormula(config, INVOICING_TABLES.lines, `AND(${field(FI.line.status)}='Included',${windowFormula(FI.line.date, from, to).slice(4, -1)})`);
  return rows.filter((r) => inOrg(r, org, FI.org) && sel(r.fields[FI.line.status]) === "Included" && inWindow(r.fields[FI.line.date], from, to));
}
