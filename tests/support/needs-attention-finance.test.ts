// Unit + integration tests for Finance Foundation F8a - Finance in Needs
// Attention (see TEST-ENV.md "Finance Foundation - F8a"):
//
//   OV   invoice_overdue (ATT-047): issued + outstanding + past due only; paid /
//        credited / future / due today / awaiting never; due-date moves; partial;
//        calendar days in the organisation's time zone (F7 truth)
//   SET  catalogue Active + Default Enabled off; Settings enable / disable
//   EX   exact-case exceptions: Manage only, one case only, Finance never written,
//        stale exceptions never fake a resolved Finance state
//   AC   Finance access: none -> hidden completely (cases, counts, titles,
//        amounts, lookups, suppressed list, no Finance read); View -> read only;
//        Manage -> exceptions; grant lookup failure fails closed
//   TN   tenant isolation
//   AR   auto-resolution (payment received, due date moved)
//   PF   bounded reads (each Finance table once, no per-invoice read, one pass)
//   DQ   malformed Finance data -> loud, incomplete, never a guess
//   PAR  parity with Finance's own strict parsers + receivableOf over the SAME rows
//   DR   drift: copied blocks verbatim; field / table names = the F6 / F7 mappings
//
// Request-level behaviour runs through the REAL orchestrator + the deployed
// registry against an in-memory Airtable that REJECTS every write except
// exception rows. Finance rows are produced by Finance's OWN create-field
// builders, so they are exactly what F6 / F7 store.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, revokeException, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, RETRY_DELAYS_MS, loadFinanceGrants } from "./needs-attention-repository.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import {
  FF,
  FINANCE_TABLES,
  INVOICE_OVERDUE_SOURCES,
  type FinanceAccess,
  receivablePassStats,
  resolveFinanceAccess,
} from "./needs-attention-finance.ts";
import { FV, ISSUE_TABLES, buildCreditNotes, buildInvoices, creditNoteCreateFields, invoiceCreateFields } from "./finance-issue-mapping.ts";
import {
  FR,
  RECEIVABLE_TABLES,
  applicationCreateFields,
  applicationReversalCreateFields,
  buildApplicationEntries,
  buildClientCredits,
  buildDueChanges,
  buildPaymentEntries,
  clientCreditCreateFields,
  dueChangeCreateFields,
  paymentCreateFields,
  paymentReversalCreateFields,
} from "./finance-receivables-mapping.ts";
import { receivableOf } from "./finance-receivables.ts";
import type { CreditNote, Invoice } from "./finance-issue.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const id = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = id("OrgTest1");
const ORG2 = id("OrgOther");
const TZ = "Europe/London";
const NOW = new Date("2026-11-02T10:00:00.000Z"); // Mon 2 Nov 2026, 10:00 GMT
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const CLIENT = "FCL-AAAAAAAAAAAA";
const CLIENT2 = "FCL-BBBBBBBBBBBB";
const T0 = "2026-09-30T12:00:00.000Z";
const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, "0");
const FIV = (n: number) => `FIV-${hex(n)}`;

let seq = 1000;
function invoice(n: number, o: { gross: number; invoiceDate?: string | null; dueDate?: string | null; xero?: boolean; clientId?: string; clientName?: string; status?: Invoice["status"] }): Invoice {
  const xero = !!o.xero;
  const s = ++seq;
  return {
    invoiceId: FIV(n),
    sourceDraftId: `FID-${hex(n)}`,
    clientId: o.clientId ?? CLIENT,
    clientName: o.clientName ?? "TEST Parkside",
    billingContactName: null,
    billingEmail: "billing@parkside.test",
    billingCcEmails: [],
    invoiceDate: xero ? null : o.invoiceDate ?? "2026-10-01",
    dueDate: xero ? null : o.dueDate ?? "2026-10-31",
    periodFrom: "2026-09-01",
    periodTo: "2026-09-30",
    paymentTermsDays: 30,
    paymentTermsSource: "client",
    poRequired: false,
    poNumber: null,
    poOverrideReason: null,
    netMinor: o.gross,
    vatMinor: 0,
    grossMinor: o.gross,
    currency: "GBP",
    lineCount: 1,
    status: o.status ?? (xero ? "awaiting_external_issue" : "issued"),
    issueAuthority: xero ? "external_accounting" : "hub",
    numberAuthority: xero ? "xero" : "hub",
    hubInvoiceNumber: xero ? null : `TEST-INV-00${s}`,
    hubInvoiceSequence: xero ? null : s,
    externalProvider: null,
    externalInvoiceId: null,
    externalInvoiceNumber: null,
    replacesInvoiceId: null,
    correctionId: null,
    approvedOmissions: [],
    reviewSnapshot: "{}",
    issuer: { organisationId: "ORG-TEST-001", organisationName: "Test Org", legalName: "Test Org Ltd", address: "1 Test Street", companyNumber: null, vatRegistered: false, vatNumber: null },
    frozenBy: MGR,
    frozenAt: T0,
    issuedBy: xero ? null : MGR,
    issuedAt: xero ? null : T0,
    revision: 1,
    updatedBy: MGR,
    updatedAt: T0,
  };
}
function creditNote(n: number, inv: Invoice, gross: number): CreditNote {
  return {
    creditNoteId: `FCN-${hex(n)}`,
    invoiceId: inv.invoiceId,
    clientId: inv.clientId,
    clientName: inv.clientName,
    creditDate: "2026-10-05",
    reason: "TEST correction",
    lines: [{ invoiceLineId: `FVL-${hex(n)}`, occurrenceId: `recOcc${n}:2026-09-10`, netMinor: gross, vatMinor: 0, grossMinor: gross }],
    netMinor: gross,
    vatMinor: 0,
    grossMinor: gross,
    currency: "GBP",
    status: "issued",
    issueAuthority: "hub",
    externalProvider: null,
    externalCreditNoteId: null,
    externalCreditNoteNumber: null,
    createdBy: MGR,
    createdAt: "2026-10-05T09:00:00.000Z",
  };
}
const payment = (n: number, inv: Invoice, amountMinor: number, receivedDate = "2026-10-20") => ({
  paymentId: `FPY-${hex(n)}`, invoiceId: inv.invoiceId, clientId: inv.clientId, clientName: inv.clientName, amountMinor, currency: "GBP" as const, receivedDate,
  method: "bank_transfer" as const, reference: null, source: "manual" as const, externalProvider: null, externalPaymentId: null, reason: null, recordedBy: MGR, recordedAt: `${receivedDate}T12:00:00.000Z`,
});
const paymentReversal = (n: number, p: ReturnType<typeof payment>) => ({ reversalId: `FPR-${hex(n)}`, paymentId: p.paymentId, invoiceId: p.invoiceId, clientId: p.clientId, amountMinor: p.amountMinor, reason: "entered by mistake", recordedBy: MGR, recordedAt: "2026-10-21T12:00:00.000Z" });
const clientCredit = (n: number, o: { sourceInvoiceId: string; sourceCreditNoteId: string; original: number; remaining: number }) => ({
  creditId: `FCC-${hex(n)}`, clientId: CLIENT, clientName: "TEST Parkside", source: "credit_note" as const, sourceInvoiceId: o.sourceInvoiceId, sourceCreditNoteId: o.sourceCreditNoteId, sourcePaymentId: null, receivedDate: null,
  originalMinor: o.original, remainingMinor: o.remaining, currency: "GBP" as const, status: (o.remaining === 0 ? "used" : "available") as "used" | "available", reason: "kept", voidReason: null, voidedBy: null, voidedAt: null,
  createdBy: MGR, createdAt: "2026-10-06T09:00:00.000Z", revision: 2, updatedBy: MGR, updatedAt: "2026-10-06T09:00:00.000Z",
});
const application = (n: number, creditId: string, inv: Invoice, amountMinor: number) => ({ applicationId: `FCA-${hex(n)}`, creditId, invoiceId: inv.invoiceId, clientId: inv.clientId, amountMinor, reason: null, recordedBy: MGR, recordedAt: "2026-10-07T09:00:00.000Z" });
const dueChange = (n: number, inv: Invoice, previousDueDate: string, newDueDate: string, at = "2026-10-15T09:00:00.000Z") => ({ changeId: `FDD-${hex(n)}`, invoiceId: inv.invoiceId, previousDueDate, newDueDate, reason: "agreed extension", changedBy: MGR, changedAt: at });

// Rows exactly as Finance stores them (its own create-field builders), plus the Airtable REST shape.
let rowN = 0;
const row = (fields: Record<string, unknown>, org = ORG): AirtableRecord => ({ id: id("Fin" + String(++rowN).padStart(5, "0")), fields: { ...fields, Organisation: [org] } });

interface FinWorld {
  invoices: Invoice[];
  notes?: CreditNote[];
  payments?: ReturnType<typeof payment>[];
  reversals?: ReturnType<typeof paymentReversal>[];
  credits?: ReturnType<typeof clientCredit>[];
  applications?: ReturnType<typeof application>[];
  dueChanges?: ReturnType<typeof dueChange>[];
  foreign?: Invoice[];
}
function finRows(w: FinWorld): Record<string, AirtableRecord[]> {
  return {
    [FINANCE_TABLES.invoices]: [...w.invoices.map((i) => row(invoiceCreateFields(i, ORG))), ...(w.foreign ?? []).map((i) => row(invoiceCreateFields(i, ORG2), ORG2))],
    [FINANCE_TABLES.creditNotes]: (w.notes ?? []).map((n) => row(creditNoteCreateFields(n, ORG))),
    [FINANCE_TABLES.payments]: [...(w.payments ?? []).map((p) => row(paymentCreateFields(p as any, ORG))), ...(w.reversals ?? []).map((r) => row(paymentReversalCreateFields(r as any, ORG)))],
    [FINANCE_TABLES.credits]: (w.credits ?? []).map((c) => row(clientCreditCreateFields(c as any, ORG))),
    [FINANCE_TABLES.applications]: (w.applications ?? []).map((a) => row(applicationCreateFields(a as any, ORG))),
    [FINANCE_TABLES.dueChanges]: (w.dueChanges ?? []).map((d) => row(dueChangeCreateFields(d as any, ORG))),
  };
}

// The standard world (NOW = 2026-11-02 London).
const I1 = invoice(1, { gross: 13500, dueDate: "2026-10-31" }); // overdue 2 days, unpaid
const I2 = invoice(2, { gross: 16200, dueDate: "2026-10-15" }); // partially paid, overdue 18
const I3 = invoice(3, { gross: 6000, dueDate: "2026-10-10" }); // paid in full
const I4 = invoice(4, { gross: 6000, dueDate: "2026-10-10", status: "credited" }); // credited in full, never paid
const I5 = invoice(5, { gross: 6000, dueDate: "2026-11-20" }); // future
const I6 = invoice(6, { gross: 6000, dueDate: "2026-11-02" }); // due today
const I7 = invoice(7, { gross: 114300, xero: true }); // awaiting external issue (Xero)
const I8 = invoice(8, { gross: 6000, dueDate: "2026-10-20" }); // due moved to 2026-11-30
const I9 = invoice(9, { gross: 6000, dueDate: "2026-10-25" }); // client credit applied 20.00
const I10 = invoice(10, { gross: 3000, dueDate: "2026-10-28" }); // payment reversed
const I11 = invoice(11, { gross: 16200, dueDate: "2026-10-01", status: "credited" }); // paid, then credited: excess, never overdue
const IX = invoice(99, { gross: 50000, dueDate: "2026-10-01", clientId: CLIENT2, clientName: "Other Org Client" }); // another organisation's overdue invoice
const P2 = payment(2, I2, 5000);
const P3 = payment(3, I3, 6000);
const P10 = payment(10, I10, 3000);
const P11 = payment(11, I11, 16200, "2026-09-30");
const N4 = creditNote(4, I4, 6000);
const N11 = creditNote(11, I11, 16200);
const C11 = clientCredit(11, { sourceInvoiceId: I11.invoiceId, sourceCreditNoteId: N11.creditNoteId, original: 16200, remaining: 14200 });
const A9 = application(9, C11.creditId, I9, 2000);
const D8 = dueChange(8, I8, "2026-10-20", "2026-11-30");
const STD: FinWorld = { invoices: [I1, I2, I3, I4, I5, I6, I7, I8, I9, I10, I11], notes: [N4, N11], payments: [P2, P3, P10, P11], reversals: [paymentReversal(10, P10)], credits: [C11], applications: [A9], dueChanges: [D8], foreign: [IX] };
const EXPECTED_OVERDUE = [I1, I2, I9, I10].map((i) => i.invoiceId).sort();

// Catalogue: the real ATT-047 row + one non-Finance rule (to prove it is unaffected).
const RULE_OVERDUE: AirtableRecord = {
  id: "recC80hmlglLibk7I",
  fields: { "Rule Name": "Invoice overdue", "Rule ID": "ATT-047", "Rule Key": "invoice_overdue", Category: "Finance & Billing", "Default Base Severity": "Warning", "Client Customisable": true, "Required Module": "module_finance", "Evaluation Status": "Active", "Sort Order": 47, Active: true, "Action Label": "Review Receivable", "Destination Area": "Finance", "Supports Override": true },
};
const RULE_WSQ: AirtableRecord = {
  id: id("RuleATT044"),
  fields: { "Rule Name": "Work summary queried", "Rule ID": "ATT-044", "Rule Key": "work_summary_queried", Category: "Coaches & Compliance", "Default Enabled": true, "Default Base Severity": "Normal", "Client Customisable": true, "Required Module": "module_coaches", "Evaluation Status": "Active", "Sort Order": 44, Active: true, "Action Label": "Review Query", "Destination Area": "Coaches", "Supports Warning Threshold": true, "Default Warning Threshold": 3, "Default Warning Timing": "Days Overdue" },
};
const enableOverdue = (on = true, allowOverride = true): AirtableRecord => ({ id: id("SetOverdue"), fields: { Organisation: [ORG], Rule: [RULE_OVERDUE.id], ...(on ? { Enabled: true } : {}), ...(allowOverride ? { "Allow Override": true } : {}) } });

// ---------------------------------------------------------------------
// In-memory Airtable (+ Supabase grants): GET lists; writes ONLY to Exceptions.
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: { method: string; table: string }[] = [];
let supabaseRequests: string[] = [];
let excN = 0;
const EXC = CONFIG_TABLES.exceptions;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const u = new URL(url);
  if (u.hostname !== "api.airtable.com") {
    supabaseRequests.push(`${method} ${u.pathname}?${u.searchParams.toString()} key=${(init?.headers as any)?.apikey}`);
    return new Response(JSON.stringify([{ organisation_id: "ORG-TEST-001", access_level: "view", revoked_at: null }]), { status: 200 });
  }
  const parts = u.pathname.split("/");
  const table = decodeURIComponent(parts[3]);
  requests.push({ method, table });
  if (method === "GET") return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields })) }), { status: 200 });
  if (table !== EXC || (method !== "POST" && method !== "PATCH")) throw new Error(`Illegal write ${method} ${table}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const fields = Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== false && v !== null && v !== ""));
  if (method === "PATCH") {
    const rid = parts[4];
    const rec = tables[EXC].find((r) => r.id === rid)!;
    rec.fields = { ...Object.fromEntries(Object.entries(rec.fields).filter(([k]) => !(k in body.fields))), ...fields };
    return new Response(JSON.stringify(rec), { status: 200 });
  }
  const rec = { id: id("Exc" + String(++excN).padStart(4, "0")), fields };
  tables[EXC] = [...(tables[EXC] ?? []), rec];
  return new Response(JSON.stringify(rec), { status: 200 });
};
RETRY_DELAYS_MS.length = 0;
let tokN = 0;
const held = new Map<string, string>();
const fakeLock: LockClient = {
  async acquire(key) {
    if (held.has(key)) return null;
    const t = `${String(++tokN).padStart(8, "0")}-aaaa-4000-8000-000000000000`;
    held.set(key, t);
    return t;
  },
  async release(key, token) {
    if (held.get(key) !== token) return false;
    held.delete(key);
    return true;
  },
};

interface World { fin?: FinWorld; settings?: AirtableRecord[]; financeOn?: boolean; rules?: AirtableRecord[]; tz?: string; exceptions?: AirtableRecord[]; extraFinance?: Record<string, AirtableRecord[]> }
function world(o: World = {}) {
  const fin = finRows(o.fin ?? STD);
  for (const [t, rows] of Object.entries(o.extraFinance ?? {})) fin[t] = [...fin[t], ...rows];
  tables = {
    [CONFIG_TABLES.rules]: o.rules ?? [RULE_OVERDUE, RULE_WSQ],
    [CONFIG_TABLES.settings]: o.settings ?? [enableOverdue()],
    [EXC]: o.exceptions ?? [],
    [CONFIG_TABLES.features]: [
      { id: id("FeatCoach"), fields: { "Feature Key": "module_coaches", Enabled: true } },
      { id: id("FeatFin"), fields: o.financeOn === false ? { "Feature Key": "module_finance" } : { "Feature Key": "module_finance", Enabled: true } },
    ],
    [CONFIG_TABLES.organisations]: [
      { id: ORG, fields: { "Organisation ID": "ORG-TEST-001", Active: true, Timezone: o.tz ?? TZ, "Organisation Name": "Test Org" } },
      { id: ORG2, fields: { "Organisation ID": "ORG-TEST-999", Active: true, Timezone: TZ, "Organisation Name": "Other Org" } },
    ],
    ...fin,
  };
  requests = [];
  supabaseRequests = [];
}

const MANAGER: Caller = { userId: MGR, role: "management", active: true, organisationId: "ORG-TEST-001", displayName: "Test Manager" };
let accessCalls = 0;
function deps(access: FinanceAccess | "throw"): Deps {
  return {
    airtable: { baseId: "appQktredAuGa1X7e", token: "t" },
    registry: IMPLEMENTED_EVALUATORS,
    lock: fakeLock,
    financeAccess: async () => {
      accessCalls++;
      if (access === "throw") throw new Error("grant store down");
      return access;
    },
  };
}
async function run(access: FinanceAccess | "throw" = "manage", q: { view?: string; caseKey?: string; debug?: boolean } = { debug: true }, now = NOW) {
  accessCalls = 0;
  requests = [];
  const out = await getCases(deps(access), MANAGER, q, now);
  if (out.status !== "ok") throw new Error(`getCases rejected: ${JSON.stringify(out)}`);
  return out.body as any;
}
const overdueCases = (b: any) => (b.cases ?? []).filter((c: any) => c.ruleKey === "invoice_overdue");
const byInvoice = (b: any, inv: Invoice) => overdueCases(b).find((c: any) => c.targetIds.invoiceId === inv.invoiceId);
const keyOf = (inv: Invoice) => `invoice_overdue|invoice:${inv.invoiceId}`;
const lists = (t: string) => requests.filter((r) => r.method === "GET" && r.table === t).length;
const financeReads = () => Object.values(FINANCE_TABLES).reduce((a, t) => a + lists(t), 0);
const writes = () => requests.filter((r) => r.method !== "GET");

async function main() {
  // ===== OV: invoice_overdue semantics =====
  {
    world();
    const b = await run();
    const got = overdueCases(b).map((c: any) => c.targetIds.invoiceId).sort();
    ck("OV1. Issued + outstanding + past due -> exactly one case per such invoice (I1 unpaid, I2 partial, I9 credit-applied, I10 reversed payment)", JSON.stringify(got) === JSON.stringify(EXPECTED_OVERDUE), JSON.stringify(got));
    const c1 = byInvoice(b, I1);
    ck("OV1b. Case identity = invoice_overdue|invoice:<FIV>; rule / severity / action / destination from the catalogue; base Warning (no escalation)", c1?.caseKey === keyOf(I1) && c1.ruleId === "ATT-047" && c1.severity === "Warning" && c1.actionLabel === "Review Receivable" && c1.destination.area === "Finance" && c1.destination.route === "finance/invoice-receivable" && c1.destination.params.invoiceId === I1.invoiceId && c1.module === "module_finance" && c1.category === "Finance & Billing");
    ck("OV1c. Plain context: client, official number, outstanding, due date, days overdue, source API route", c1?.context.clientName === "TEST Parkside" && c1.context.invoiceNumber === I1.hubInvoiceNumber && c1.context.outstanding === "135.00" && c1.context.dueDate === "2026-10-31" && c1.context.daysOverdue === 2 && c1.context.sourceApi === `GET /finance/invoices/${I1.invoiceId}/receivable` && /135\.00 outstanding/.test(c1.detail) && c1.title.includes(I1.hubInvoiceNumber!));
    ck("OV2. Issued + paid in full -> no case", !byInvoice(b, I3));
    ck("OV3. Fully credited (never paid) -> no case; paid-then-credited (credit excess) -> no case", !byInvoice(b, I4) && !byInvoice(b, I11));
    ck("OV4. Future due -> no case; due TODAY -> no case (no due-today rule)", !byInvoice(b, I5) && !byInvoice(b, I6) && !(b.cases ?? []).some((c: any) => /due_today/.test(c.ruleKey)));
    ck("OV5. Awaiting external issue (Xero) -> never a case, even with a large gross", !byInvoice(b, I7) && !JSON.stringify(b).includes(I7.invoiceId));
    ck("OV6. Due date moved later (2026-10-20 -> 2026-11-30) -> no case against the old date", !byInvoice(b, I8));
    const c2 = byInvoice(b, I2);
    ck("OV7. Partial payment -> the case shows the REMAINING balance (112.00 of 162.00), not the gross", c2?.context.outstanding === "112.00" && c2.context.gross === "162.00" && c2.context.cashReceived === "50.00" && c2.context.settlement === "partially_paid" && /112\.00 outstanding \(of £162\.00\)/.test(c2.detail));
    const c9 = byInvoice(b, I9), c10 = byInvoice(b, I10);
    ck("OV7b. Client credit applied reduces the outstanding (40.00 of 60.00, credit not cash); a reversed payment owes again (30.00)", c9?.context.outstanding === "40.00" && c9.context.clientCreditApplied === "20.00" && c9.context.cashReceived === "0.00" && c10?.context.outstanding === "30.00" && c10.context.cashReceived === "0.00");
    ck("OV8. Days overdue = F7 calendar days (2 Nov - 31 Oct = 2; 2 Nov - 15 Oct = 18)", c1?.context.daysOverdue === 2 && c2?.context.daysOverdue === 18 && c1.context.asOf === "2026-11-02");
    // Organisation-local calendar day, never UTC / elapsed hours.
    const one = { invoices: [invoice(20, { gross: 1000, dueDate: "2026-11-02" })] };
    world({ fin: one });
    const late = await run("manage", { debug: true }, new Date("2026-11-02T23:59:00.000Z"));
    world({ fin: one });
    const next = await run("manage", { debug: true }, new Date("2026-11-03T00:00:30.000Z"));
    ck("OV8b. London: 23:59 on the due date -> due today (no case); 00:00:30 next day -> overdue by 1", overdueCases(late).length === 0 && overdueCases(next).length === 1 && overdueCases(next)[0].context.daysOverdue === 1);
    world({ fin: one, tz: "Asia/Tokyo" });
    const tokyo = await run("manage", { debug: true }, new Date("2026-11-02T16:00:00.000Z")); // 3 Nov 01:00 in Tokyo
    ck("OV8c. The ORGANISATION's time zone decides the day (Tokyo is already 3 Nov -> overdue 1 while London is still 2 Nov)", overdueCases(tokyo).length === 1 && overdueCases(tokyo)[0].context.asOf === "2026-11-03");
    const moved = { invoices: [invoice(21, { gross: 1000, dueDate: "2026-10-31" })], dueChanges: [] as ReturnType<typeof dueChange>[] };
    moved.dueChanges = [dueChange(21, moved.invoices[0], "2026-10-31", "2026-10-25")];
    world({ fin: moved });
    const m = overdueCases(await run())[0];
    ck("OV6b. Due date moved EARLIER -> overdue against the new date (8 days), original kept in context", m?.context.dueDate === "2026-10-25" && m.context.daysOverdue === 8 && m.context.originalDueDate === "2026-10-31" && m.context.dueDateMoved === true);
  }

  // ===== SET: catalogue / Settings =====
  {
    world({ settings: [] });
    const b = await run();
    ck("SET17. Catalogue Active but Default Enabled off and no Settings row -> no Finance case, rule skipped 'disabled'", overdueCases(b).length === 0 && b.diagnostics.skipped.find((s: any) => s.ruleKey === "invoice_overdue")?.reason === "disabled");
    ck("SET17b. ...and nothing Finance is read or looked up (no grant lookup, no Finance table)", accessCalls === 0 && financeReads() === 0 && b.diagnostics.financeAccess === "not_checked");
    world();
    const on = await run();
    ck("SET18. Organisation Settings enable the rule -> the cases appear", overdueCases(on).length === 4 && on.diagnostics.evaluated.some((e: any) => e.ruleKey === "invoice_overdue"));
    world({ settings: [enableOverdue(false)] });
    const off = await run();
    ck("SET19. Disabled again -> the cases disappear without any Finance change (settings_disabled; no write anywhere)", overdueCases(off).length === 0 && off.diagnostics.skipped.find((s: any) => s.ruleKey === "invoice_overdue")?.reason === "settings_disabled" && writes().length === 0);
    world({ financeOn: false });
    const mod = await run();
    ck("SET19b. module_finance off -> skipped module_off, no grant lookup, no Finance read", overdueCases(mod).length === 0 && mod.diagnostics.skipped.find((s: any) => s.ruleKey === "invoice_overdue")?.reason === "module_off" && accessCalls === 0 && financeReads() === 0);
    world();
    const all = await run();
    ck("SET20. Non-Finance rules are unaffected (work_summary_queried still evaluated alongside)", all.diagnostics.evaluated.some((e: any) => e.ruleKey === "work_summary_queried"));
  }

  // ===== EX: exact-case exceptions (snooze) =====
  {
    world();
    const until = "2026-11-09T09:00:00.000Z";
    const created = await createException(deps("manage"), MANAGER, { caseKey: keyOf(I1), reason: "Client promised payment Friday", effectiveUntil: until }, NOW);
    ck("EX20. Finance Manage creates an exact-case exception (201, one Exceptions row, exact Case Key)", created.status === "ok" && created.httpStatus === 201 && (tables[EXC] ?? []).length === 1 && tables[EXC][0].fields["Case Key"] === keyOf(I1));
    ck("EX21. The only write was that one Exceptions POST - Finance tables never written", writes().length === 1 && writes()[0].table === EXC && writes()[0].method === "POST");
    const b = await run();
    ck("EX20b. Suppresses ONLY that case; the other overdue invoices stay visible; summary.suppressed = 1", !byInvoice(b, I1) && overdueCases(b).length === 3 && b.summary.suppressed === 1 && b.diagnostics.suppressedCases[0]?.caseKey === keyOf(I1));
    const later = await run("manage", { debug: true }, new Date("2026-11-10T10:00:00.000Z"));
    const i1Later = byInvoice(later, I1);
    ck("EX21b. Snooze never changes Finance: after expiry the case returns with the SAME due date and the true (later) day count", i1Later?.context.dueDate === "2026-10-31" && i1Later.context.daysOverdue === 10 && i1Later.context.outstanding === "135.00");
    const dup = await createException(deps("manage"), MANAGER, { caseKey: keyOf(I1), reason: "again" }, NOW);
    ck("EX20c. A second exception on the same case is refused (409 exception_exists)", dup.status === "rejected" && dup.httpStatus === 409 && (dup as any).code === "exception_exists");
    // Stale exception: the invoice gets paid -> no case, and the exception fakes nothing.
    world({ fin: { ...STD, payments: [...STD.payments!, payment(51, I1, 13500, "2026-11-01")] }, exceptions: tables[EXC] });
    const paid = await run();
    ck("EX22. Stale exception (source fixed: paid) -> no active AND no suppressed case; nothing claims it is 'resolved' by the exception", !byInvoice(paid, I1) && paid.summary.suppressed === 0 && !paid.diagnostics.suppressedCases.some((s: any) => s.caseKey === keyOf(I1)));
    const gone = await createException(deps("manage"), MANAGER, { caseKey: keyOf(I3), reason: "x" }, NOW);
    ck("EX22b. An exception cannot be made for a case that does not exist (paid invoice -> 404 case_not_found)", gone.status === "rejected" && gone.httpStatus === 404 && (gone as any).code === "case_not_found");
    world();
    const created2 = await createException(deps("manage"), MANAGER, { caseKey: keyOf(I2), reason: "chasing" }, NOW);
    const exId = (created2 as any).body?.exception?.exceptionId;
    const rv = await revokeException(deps("manage"), MANAGER, { exceptionId: exId, reason: "no longer agreed" }, NOW);
    ck("EX23. Finance Manage can revoke it: the case is visible again (problem_still_present)", rv.status === "ok" && (rv as any).body.case.visibleAgain === true && (rv as any).body.case.reason === "problem_still_present");
  }

  // ===== AC: Finance access =====
  {
    world();
    const view = await run("view");
    ck("AC23. Finance View sees the Finance cases (read) ...", overdueCases(view).length === 4);
    ck("AC23b. ... but exceptionAllowed = false on every Finance case (View may not snooze)", overdueCases(view).every((c: any) => c.exceptionAllowed === false));
    const manage = await run("manage");
    ck("AC23c. Finance Manage sees them with exceptionAllowed = true", overdueCases(manage).every((c: any) => c.exceptionAllowed === true));
    const vCreate = await createException(deps("view"), MANAGER, { caseKey: keyOf(I1), reason: "x" }, NOW);
    ck("AC23d. Finance View creating an exception -> 403 finance_manage_required, nothing written", vCreate.status === "rejected" && vCreate.httpStatus === 403 && (vCreate as any).code === "finance_manage_required" && writes().length === 0);
    await createException(deps("manage"), MANAGER, { caseKey: keyOf(I1), reason: "snooze" }, NOW);
    const exRow = tables[EXC][0];
    requests = [];
    const vRevoke = await revokeException(deps("view"), MANAGER, { exceptionId: exRow.fields["Exception ID"], reason: "x" }, NOW);
    ck("AC23e. Finance View revoking a Finance exception -> 403 finance_manage_required, nothing written", vRevoke.status === "rejected" && vRevoke.httpStatus === 403 && (vRevoke as any).code === "finance_manage_required" && writes().length === 0);
    const nRevoke = await revokeException(deps("none"), MANAGER, { exceptionId: exRow.fields["Exception ID"], reason: "x" }, NOW);
    ck("AC24a. No Finance access revoking it -> 404 exception_not_found (existence not revealed), nothing written", nRevoke.status === "rejected" && nRevoke.httpStatus === 404 && (nRevoke as any).code === "exception_not_found" && writes().length === 0);

    world({ exceptions: tables[EXC] });
    const none = await run("none");
    const text = JSON.stringify(none);
    ck("AC24. No Finance grant -> NO Finance case, count or suppressed Finance case (summary excludes them)", overdueCases(none).length === 0 && none.summary.total === 0 && none.summary.suppressed === 0 && none.diagnostics.suppressedCases.length === 0);
    ck("AC24b. ...no Finance-derived detail anywhere in the payload (no invoice id, number, client or amount)", ![I1, I2, I9, I10].some((i) => text.includes(i.invoiceId) || text.includes(i.hubInvoiceNumber!)) && !text.includes("135.00") && !text.includes("TEST Parkside"));
    ck("AC24c. ...skipped as finance_access_required BEFORE any Finance table is read (grant looked up once)", none.diagnostics.skipped.find((s: any) => s.ruleKey === "invoice_overdue")?.reason === "finance_access_required" && financeReads() === 0 && accessCalls === 1 && none.diagnostics.financeAccess === "none");
    const summaryNone = await run("none", { view: "summary" });
    world();
    const summaryManage = await run("manage", { view: "summary" });
    ck("AC24d. Home / summary counts: 0 for no-grant Management, 4 Warning for Finance Manage", summaryNone.summary.total === 0 && summaryNone.summary.state === "Clear" && summaryManage.summary.total === 4 && summaryManage.summary.counts.Warning === 4);
    const lookup = await run("none", { caseKey: keyOf(I1) });
    ck("AC24e. caseKey lookup without Finance access -> exists:false, case null, rule skipped finance_access_required (whether it is overdue is not revealed)", lookup.exists === false && lookup.case === null && lookup.rule.skipReason === "finance_access_required" && !JSON.stringify(lookup).includes("135.00"));
    const nCreate = await createException(deps("none"), MANAGER, { caseKey: keyOf(I1), reason: "x" }, NOW);
    ck("AC24f. No Finance access creating an exception -> 404 case_not_found (never confirms the case), nothing written", nCreate.status === "rejected" && nCreate.httpStatus === 404 && (nCreate as any).code === "case_not_found" && writes().length === 0);
    world();
    const broken = await run("throw");
    ck("AC24g. Grant lookup failure -> fail closed: no Finance case / read, complete:false + finance_access_unavailable issue; other rules still run", overdueCases(broken).length === 0 && financeReads() === 0 && broken.complete === false && broken.configIssues.some((i: any) => i.code === "finance_access_unavailable") && broken.diagnostics.evaluated.some((e: any) => e.ruleKey === "work_summary_queried"));
    world({ settings: [enableOverdue(true, false)] });
    const noOverride = await createException(deps("manage"), MANAGER, { caseKey: keyOf(I1), reason: "x" }, NOW);
    ck("AC23f. Organisation Settings can still switch exceptions off for the rule (403 override_disabled_by_settings, even for Manage)", noOverride.status === "rejected" && (noOverride as any).code === "override_disabled_by_settings");
    // Copied F1 resolver.
    const c = { userId: MGR, role: "management", active: true, organisationId: "ORG-TEST-001" };
    const g = (level: string, org = "ORG-TEST-001", revoked: string | null = null) => ({ organisation_id: org, access_level: level, revoked_at: revoked });
    ck("AC25a. F1 resolver (copied): view / manage for the profile org; revoked, other-org, ambiguous, invalid, non-management -> none", resolveFinanceAccess(c, [g("view")]).access === "view" && resolveFinanceAccess(c, [g("manage")]).access === "manage" && resolveFinanceAccess(c, [g("manage", "ORG-TEST-001", "2026-01-01")]).access === "none" && resolveFinanceAccess(c, [g("manage", "ORG-TEST-999")]).access === "none" && resolveFinanceAccess(c, [g("view"), g("manage")]).access === "none" && resolveFinanceAccess(c, [g("owner")]).access === "none" && resolveFinanceAccess({ ...c, role: "coach" }, [g("manage")]).access === "none" && resolveFinanceAccess({ ...c, active: false }, [g("manage")]).access === "none");
    supabaseRequests = [];
    const rows = await loadFinanceGrants({ supabaseUrl: "https://dkqubldmfyeuudecxmvh.supabase.co", serviceRoleKey: "svc" }, MGR);
    let refused = false;
    try { await loadFinanceGrants({ supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc" }, "not-a-uuid"); } catch { refused = true; }
    ck("AC25b. Grant lookup = one GET of the caller's own rows (user_id=eq.<uuid>, 3 columns); a non-UUID caller id is refused", rows.length === 1 && supabaseRequests.length === 1 && supabaseRequests[0].startsWith("GET /rest/v1/finance_access_grants?") && supabaseRequests[0].includes(`user_id=eq.${MGR}`) && supabaseRequests[0].includes("select=organisation_id%2Caccess_level%2Crevoked_at") && refused);
  }

  // ===== TN: tenant isolation =====
  {
    world();
    const b = await run();
    ck("TN25. Another organisation's overdue invoice (same tables) never becomes a case", !byInvoice(b, IX) && !JSON.stringify(b).includes(IX.invoiceId));
    world({ extraFinance: { [FINANCE_TABLES.payments]: [{ id: id("FinShared1"), fields: { ...paymentCreateFields(payment(60, I1, 100) as any, ORG), Organisation: [ORG, ORG2] } }] } });
    const shared = await run();
    ck("TN25b. A Finance row linked to two organisations fails the pass loudly (complete:false, evaluator_error) - never shared, never guessed", overdueCases(shared).length === 0 && shared.complete === false && shared.configIssues.some((i: any) => i.code === "evaluator_error" && /more than one organisation/.test(i.detail)));
  }

  // ===== AR: auto-resolution =====
  {
    world();
    const before = await run();
    world({ fin: { ...STD, payments: [...STD.payments!, payment(70, I2, 11200, "2026-11-01")] } });
    const after = await run();
    ck("AR26. Remaining balance received -> the overdue case disappears on re-check (no 'mark done')", !!byInvoice(before, I2) && !byInvoice(after, I2) && overdueCases(after).length === 3);
    world({ fin: { ...STD, dueChanges: [...STD.dueChanges!, dueChange(71, I1, "2026-10-31", "2026-11-30")] } });
    const movedOut = await run();
    ck("AR27. Due date deliberately moved into the future -> the old overdue case disappears", !byInvoice(movedOut, I1));
    world({ fin: { ...STD, notes: [...STD.notes!, creditNote(72, I10, 3000)] } });
    const credited = await run();
    ck("AR27b. Fully credited after issue -> the case disappears (nothing due)", !byInvoice(credited, I10));
  }

  // ===== PF: bounded reads =====
  {
    world();
    const b = await run();
    ck("PF29. Each Finance table listed exactly once per request (6 lists), config tables once each", Object.values(FINANCE_TABLES).every((t) => lists(t) === 1) && Object.values(CONFIG_TABLES).every((t) => lists(t) === 1) && b.diagnostics.sourcesLoaded.filter((s: string) => Object.values(FINANCE_TABLES).includes(s as any)).length === 6);
    const many: FinWorld = { invoices: Array.from({ length: 120 }, (_, k) => invoice(200 + k, { gross: 1000 + k, dueDate: "2026-10-15" })) };
    world({ fin: many });
    const r0 = receivablePassStats().runs;
    const big = await run();
    ck("PF29b. 120 overdue invoices -> 120 cases, still 6 Finance lists (no per-invoice read) and ONE receivable pass", overdueCases(big).length === 120 && financeReads() === 6 && receivablePassStats().runs === r0 + 1);
    ck("PF29c. Declared sources = exactly the six F6 / F7 tables", JSON.stringify([...INVOICE_OVERDUE_SOURCES].sort()) === JSON.stringify([ISSUE_TABLES.invoices, ISSUE_TABLES.creditNotes, ...Object.values(RECEIVABLE_TABLES)].sort()));
    ck("PF29d. No Finance API / HTTP call per invoice: only Airtable GETs (+ none to Supabase in these runs)", requests.every((r) => r.method === "GET") && supabaseRequests.length === 0);
  }

  // ===== DQ: malformed Finance data =====
  {
    world({ extraFinance: { [FINANCE_TABLES.invoices]: [{ id: id("FinBad1"), fields: { "Invoice ID": "FIV-BAD", Organisation: [ORG] } }] } });
    const bad = await run();
    ck("DQ1. A malformed Finance row of this organisation -> complete:false + evaluator_error, and no partial Finance case list", overdueCases(bad).length === 0 && bad.complete === false && bad.configIssues.some((i: any) => i.code === "evaluator_error" && i.ruleKey === "invoice_overdue"));
    world({ extraFinance: { [FINANCE_TABLES.payments]: [row(paymentCreateFields(payment(80, I1, 99999) as any, ORG))] } });
    const over = await run();
    ck("DQ2. History that does not add up (cash beyond the invoice) -> loud evaluator_error, never a negative or guessed balance", overdueCases(over).length === 0 && over.complete === false && over.configIssues.some((i: any) => /does not add up/.test(i.detail)));
  }

  // ===== PAR: parity with Finance's own strict read path =====
  {
    world();
    const b = await run();
    const org = ORG;
    // Finance's repository filters its list by Organisation before its parsers run
    // (the parsers then reject any foreign row); hand them the same scoped rows.
    const own = (t: string) => (tables[t] as any[]).filter((r) => Array.isArray(r.fields[FF.org]) && r.fields[FF.org].includes(org));
    const inv = buildInvoices(own(FINANCE_TABLES.invoices) as any, org);
    const notes = buildCreditNotes(own(FINANCE_TABLES.creditNotes) as any, org);
    const pays = buildPaymentEntries(own(FINANCE_TABLES.payments) as any, org);
    const creds = buildClientCredits(own(FINANCE_TABLES.credits) as any, org);
    const apps = buildApplicationEntries(own(FINANCE_TABLES.applications) as any, org);
    const dues = buildDueChanges(own(FINANCE_TABLES.dueChanges) as any, org);
    const allOk = inv.ok && notes.ok && pays.ok && creds.ok && apps.ok && dues.ok;
    ck("PAR1. The fixture rows are valid for Finance's OWN strict parsers (they are exactly what F6 / F7 store)", allOk, JSON.stringify([inv, notes, pays, creds, apps, dues].filter((x: any) => !x.ok)));
    if (allOk) {
      const financeOverdue: { id: string; outstanding: number; days: number | null }[] = [];
      for (const { value: i } of (inv as any).invoices) {
        const rec = receivableOf(
          i,
          {
            notes: (notes as any).notes.map((n: any) => n.value).filter((n: any) => n.invoiceId === i.invoiceId),
            payments: (pays as any).payments.filter((p: any) => p.invoiceId === i.invoiceId),
            paymentReversals: (pays as any).reversals.filter((p: any) => p.invoiceId === i.invoiceId),
            applications: (apps as any).applications.filter((a: any) => a.invoiceId === i.invoiceId),
            applicationReversals: (apps as any).reversals.filter((a: any) => a.invoiceId === i.invoiceId),
            creditsFromNotes: (creds as any).credits.map((c: any) => c.value).filter((c: any) => c.source === "credit_note" && c.sourceInvoiceId === i.invoiceId),
            dueChanges: (dues as any).changes.filter((d: any) => d.invoiceId === i.invoiceId),
          },
          "2026-11-02"
        );
        if (rec.receivable && rec.dueState === "overdue") financeOverdue.push({ id: i.invoiceId, outstanding: rec.outstandingMinor, days: rec.daysOverdue });
      }
      const na = overdueCases(b).map((c: any) => ({ id: c.targetIds.invoiceId, outstanding: Math.round(Number(c.context.outstanding) * 100), days: c.context.daysOverdue }));
      const sort = (xs: any[]) => JSON.stringify([...xs].sort((a, b) => a.id.localeCompare(b.id)));
      ck("PAR2. Needs Attention's overdue set, outstanding and days overdue EQUAL Finance's own receivableOf over the same rows", sort(na) === sort(financeOverdue), `${sort(na)} vs ${sort(financeOverdue)}`);
    }
  }

  // ===== DR: drift =====
  {
    const na = readFileSync(join(FUNCS, "needs-attention", "finance.ts"), "utf8");
    const repo = readFileSync(join(FUNCS, "needs-attention", "repository.ts"), "utf8");
    const blocksOf = (s: string) => s.split(/\/\/ ===== COPIED FROM ([^ ]+) - DO NOT EDIT HERE =====\n/).slice(1);
    const chunks = (s: string) => s.split(/\n\n+/).map((c) => c.trim()).filter(Boolean);
    const verify = (s: string) => {
      const parts = blocksOf(s);
      const out: { file: string; missing: string[]; n: number }[] = [];
      for (let k = 0; k < parts.length; k += 2) {
        const file = parts[k];
        const body = parts[k + 1].slice(0, parts[k + 1].indexOf("// ===== END COPIED BLOCK ====="));
        const canon = readFileSync(join(FUNCS, file), "utf8");
        out.push({ file, n: chunks(body).length, missing: chunks(body).filter((c) => !canon.includes(c)) });
      }
      return out;
    };
    const fin = verify(na);
    ck("DR1. finance.ts carries 4 copied blocks (F2 isIsoDate, F6 isIssued, F7 receivables, F1 access) and every chunk appears verbatim in its canonical file", fin.length === 4 && fin.map((b) => b.file).join(",") === "finance/finance-effective-dating.ts,finance/finance-issue.ts,finance/finance-receivables.ts,finance/finance-access.ts" && fin.every((b) => b.missing.length === 0 && b.n > 0), JSON.stringify(fin.map((b) => [b.file, b.missing.map((m) => m.slice(0, 50))])));
    ck("DR1b. The F7 block contains the real derivation (receivableOf, orderedDueChanges, daysBetween) and the F1 block the real resolver", ["export function receivableOf(", "export function orderedDueChanges(", "export function daysBetween(", "export function resolveFinanceAccess(", "export const isIssued"].every((f) => na.includes(f)));
    const rp = verify(repo);
    ck("DR2. repository.ts's grant lookup is a verbatim copy of finance/repository.ts (loadFinanceGrants)", rp.length === 1 && rp[0].file === "finance/repository.ts" && rp[0].missing.length === 0 && rp[0].n >= 4);
    const same = (a: Record<string, string>, b: Record<string, string>) => Object.entries(a).every(([k, v]) => (b as any)[k] === v);
    ck("DR3. Field names = the F6 / F7 mapping constants (Finance renames can never silently blind the evaluator)", FF.org === FV.org && FF.org === FR.org && same(FF.invoice as any, FV.invoice as any) && same(FF.credit as any, FV.credit as any) && same(FF.payment as any, FR.payment as any) && same(FF.clientCredit as any, FR.credit as any) && same(FF.application as any, FR.application as any) && same(FF.due as any, FR.due as any));
    ck("DR4. Table names = ISSUE_TABLES / RECEIVABLE_TABLES", FINANCE_TABLES.invoices === ISSUE_TABLES.invoices && FINANCE_TABLES.creditNotes === ISSUE_TABLES.creditNotes && FINANCE_TABLES.payments === RECEIVABLE_TABLES.payments && FINANCE_TABLES.credits === RECEIVABLE_TABLES.credits && FINANCE_TABLES.applications === RECEIVABLE_TABLES.applications && FINANCE_TABLES.dueChanges === RECEIVABLE_TABLES.dueChanges);
    const code = na.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ck("DR5. finance.ts is read-only: no fetch, no write method, no Finance route call, no Deno / Supabase", !/fetch\(|method:\s*["'`](POST|PATCH|PUT|DELETE)|Deno\.|createClient|\/rest\/v1/.test(code) && !/\bmethod:\s*["'`]/.test(code));
    ck("DR6. Finance rules implemented: invoice_overdue (F8a) + invoice_draft_blocked (F8b) only (ATT-024/025/026/034 and any due-today rule stay unregistered)", IMPLEMENTED_EVALUATORS.filter((e) => /^ATT-0(2[456]|34|47|48)$/.test(e.ruleId)).map((e) => e.ruleKey).sort().join(",") === "invoice_draft_blocked,invoice_overdue");
  }

  for (const [s, n, e] of R) console.log(`${s}  ${n}${e && s === "FAIL" ? "  " + e : ""}`);
  const pass = R.filter((r) => r[0] === "PASS").length;
  console.log(`\nneeds-attention-finance: ${pass}/${R.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
