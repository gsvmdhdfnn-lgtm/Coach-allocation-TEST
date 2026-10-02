// Unit + integration tests for Finance Foundation F17 - the cash-risk rule in
// Needs Attention (see TEST-ENV.md "Finance Foundation - F17"):
//
//   CR   cash_balance_below_threshold (ATT-054): derived from the F17 Cash Flow
//        projection; no threshold / no balance = no case; breach = one case with
//        projected low, threshold, first breach date, range (brief 52)
//   RS   resolving the forecast clears the case (brief 53)
//   AC   Finance access filtering on the case: none / View / Manage / module off
//        (brief 54) + snooze = exact-case exception only
//   PAR  parity: the Needs Attention pass == Finance's own normalisation (F7
//        receivablesOf + F12 window world) through the SAME engine
//   PF   bounded reads (each source once, one pass, F16 + F17 together)
//   DQ   malformed Finance data -> loud + incomplete
//   DR   drift: copied blocks verbatim, registry / catalogue, allowlisted reads
//
// Request-level behaviour runs through the REAL orchestrator + the deployed
// registry against an in-memory Airtable (writes ONLY to Exceptions) and an
// in-memory Supabase REST (GET only). Finance rows are produced by Finance's OWN
// row builders. NOW = Thu 15 Oct 2026 10:00 BST.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AirtableRecord } from "./needs-attention-engine.ts";
import { createException, getCases, type Caller, type Deps } from "./needs-attention-orchestrator.ts";
import { IMPLEMENTED_EVALUATORS } from "./needs-attention-registry.ts";
import { CONFIG_TABLES, FINANCE_SOURCES, RETRY_DELAYS_MS } from "./needs-attention-repository.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import type { FinanceAccess } from "./needs-attention-finance.ts";
import { CASH_FLOW_SUPABASE, CASH_RISK_RULE, CASH_RISK_SOURCES, cashFlowPassStats, runCashFlowPass } from "./needs-attention-cash-flow.ts";
import { MONEY_OUT_RULES } from "./needs-attention-money-out.ts";
import { type Instalment, type Payment, type Supplier } from "./finance-suppliers.ts";
import { instalmentRow, paymentRow, supplierRow } from "./finance-suppliers-repository.ts";
import type { EmploymentItem, EmploymentVersion } from "./finance-overheads.ts";
import { itemRow, versionRow } from "./finance-overheads-repository.ts";
import { type CostWorld, type FinanceMonth, F as COST_F, TABLES as COST_TABLES } from "./finance-coach-costs.ts";
import { monthRow } from "./finance-coach-costs-repository.ts";
import { type BankBalance, buildCashFlow, coachMonthInputs, coachWorkMonths, latestBalance, rangeEnd } from "./finance-cash-flow.ts";
import { balanceRow } from "./finance-cash-flow-repository.ts";
import { receivablesOf } from "./finance-cash-flow-orchestrator.ts";
import { EMPTY_SETTINGS, SETTINGS_KEYS, SETTINGS_TABLE, toStoredFields } from "./finance-settings.ts";
import type { Invoice } from "./finance-issue.ts";
import { invoiceCreateFields } from "./finance-issue-mapping.ts";
import { clientCreditCreateFields, paymentCreateFields } from "./finance-receivables-mapping.ts";

const R: [string, string, string][] = [];
let failed = false;
function ck(name: string, cond: boolean, extra?: string) {
  R.push([cond ? "PASS" : "FAIL", name, extra || ""]);
  if (!cond) failed = true;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCS = join(HERE, "..", "..", "supabase", "functions-test");
const canon = (p: string) => readFileSync(join(FUNCS, p), "utf8");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const rid = (tag: string) => "rec" + (tag + "00000000000000").slice(0, 14);
const ORG = rid("OrgTest1");
const ORG2 = rid("OrgOther");
const ORG_ID = "ORG-TEST-001";
const ORG2_ID = "ORG-TEST-999";
const TZ = "Europe/London";
const NOW = new Date("2026-10-15T09:00:00.000Z");
const MGR = "285f819e-e0d4-4257-8121-5f16781e97ba";
const T0 = "2026-09-01T09:00:00.000Z";
const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, "0");

const S1: Supplier = { organisationId: ORG_ID, supplierId: `FSU-${hex(1)}`, name: "ZZTEST F17 Venue", supplierType: "venue", active: true, contactName: null, contactEmail: null, contactPhone: null, vatTreatment: null, notes: null, venueRecordId: null, revision: 1, createdAt: T0, createdBy: MGR, updatedAt: T0, updatedBy: MGR } as Supplier;
const SX: Supplier = { ...S1, organisationId: ORG2_ID, supplierId: `FSU-${hex(99)}`, name: "Other Org Supplier" } as Supplier;
let iN = 0;
const inst = (o: { due: string; amount: number; state?: "estimated" | "confirmed"; paid?: number; s?: Supplier }): Instalment => {
  const n = ++iN;
  const s = o.s ?? S1;
  return { organisationId: s.organisationId, instalmentId: `FSI-${hex(n)}`, agreementId: `FSA-${hex(1)}`, supplierId: s.supplierId, sequence: n, originalDueDate: o.due, dueDate: o.due, plannedMinor: o.amount, amountDueMinor: o.amount, amountState: o.state ?? "confirmed", paidMinor: o.paid ?? 0, creditedMinor: 0, splitFromInstalmentId: null, note: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdAt: T0, createdBy: MGR };
};
const IA = inst({ due: "2026-10-05", amount: 80000 }); // overdue 10 days: a requirement today
const IB = inst({ due: "2026-10-20", amount: 100000, paid: 20000 }); // 200.00 paid on 10-12 (after the balance date): 800.00 left
const IC = inst({ due: "2026-10-28", amount: 30000, state: "estimated" });
const IX = inst({ due: "2026-09-01", amount: 999900, s: SX });
const PB: Payment = { organisationId: ORG_ID, paymentId: `FSP-${hex(1)}`, instalmentId: IB.instalmentId, agreementId: IB.agreementId, supplierId: S1.supplierId, amountMinor: 20000, paidDate: "2026-10-12", method: "bank_transfer", reference: null, note: null, remainingAfterMinor: 80000, recordedAt: "2026-10-12T12:00:00.000Z", recordedBy: MGR } as Payment;
const V1: EmploymentVersion = { organisationId: ORG_ID, versionId: `FEV-${hex(1)}`, employmentId: `FEM-${hex(1)}`, supersedesVersionId: null, personRef: null, personName: "ZZTEST F17 Office Manager", categoryId: "FOC-000000000001", annualSalaryMinor: 2400000, payDay: 25, startDate: "2026-10-01", endDate: null, effectiveFromMonth: "2026-10", pensionEstimateMinor: null, niPayeEstimateMinor: null, notes: null, reason: null, createdAt: T0, createdBy: MGR };
const FM_SEP: FinanceMonth = { organisationId: ORG_ID, monthId: `FCM-${hex(1)}`, workerRecordId: rid("CoachF17"), workerRef: "COACH-F17", workerName: "ZZTEST F17 Coach", workMonth: "2026-09", finalisedTotalMinor: 30000, itemCount: 6, paymentDay: 20, expectedPaymentDate: "2026-10-20", snapshotHash: "0".repeat(64), finalisedAt: "2026-10-03T09:00:00.000Z", finalisedBy: MGR, reason: null };
const bal = (n: number, amountMinor: number, asAtDate: string, org = ORG_ID): BankBalance => ({ organisationId: org, balanceId: `FBB-${hex(n)}`, sequence: n, amountMinor, asAtDate, note: null, recordedAt: `${asAtDate}T17:00:00.000Z`, recordedBy: MGR });
const B1 = bal(1, 500000, "2026-10-10");
const BX = bal(9, 1, "2026-10-14", ORG2_ID);

let invS = 0;
function invoice(n: number, gross: number, dueDate: string): Invoice {
  const s = ++invS;
  return {
    invoiceId: `FIV-${hex(n)}`, sourceDraftId: `FID-${hex(n)}`, clientId: "FCL-AAAAAAAAAAAA", clientName: "ZZTEST F17 School", billingContactName: null, billingEmail: "b@test.invalid", billingCcEmails: [],
    invoiceDate: "2026-09-30", dueDate, periodFrom: "2026-09-01", periodTo: "2026-09-30", paymentTermsDays: 30, paymentTermsSource: "client", poRequired: false, poNumber: null, poOverrideReason: null,
    netMinor: gross, vatMinor: 0, grossMinor: gross, currency: "GBP", lineCount: 1, status: "issued", issueAuthority: "hub", numberAuthority: "hub", hubInvoiceNumber: `TEST-INV-${s}`, hubInvoiceSequence: s,
    externalProvider: null, externalInvoiceId: null, externalInvoiceNumber: null, replacesInvoiceId: null, correctionId: null, approvedOmissions: [], reviewSnapshot: "{}",
    issuer: { organisationId: ORG_ID, organisationName: "Test Org", legalName: "Test Org Ltd", address: "1 Test Street", companyNumber: null, vatRegistered: false, vatNumber: null },
    frozenBy: MGR, frozenAt: T0, issuedBy: MGR, issuedAt: T0, revision: 1, updatedBy: MGR, updatedAt: T0,
  } as Invoice;
}
const INV1 = invoice(1, 150000, "2026-10-30");
const INV2 = invoice(2, 60000, "2026-10-02"); // overdue incoming: never in the projection

interface Db { suppliers: Supplier[]; instalments: Instalment[]; payments: Payment[]; versions: EmploymentVersion[]; items: EmploymentItem[]; months: FinanceMonth[]; corrections: Record<string, any>[]; balances: BankBalance[] }
const STD = (): Db => ({ suppliers: [S1, SX], instalments: [IA, IB, IC, IX].map((i) => ({ ...i })), payments: [PB], versions: [V1], items: [], months: [FM_SEP], corrections: [], balances: [B1, BX] });
let db: Db = STD();
const SB_ROWS: Record<string, (d: Db) => Record<string, any>[]> = {
  finance_suppliers: (d) => d.suppliers.map(supplierRow),
  finance_supplier_instalments: (d) => d.instalments.map(instalmentRow),
  finance_supplier_payments: (d) => d.payments.map(paymentRow),
  finance_employment_versions: (d) => d.versions.map(versionRow),
  finance_employment_items: (d) => d.items.map(itemRow),
  finance_worker_cost_months: (d) => d.months.map((m) => monthRow(m) as Record<string, any>),
  finance_worker_cost_corrections: (d) => d.corrections,
  finance_bank_balances: (d) => d.balances.map(balanceRow),
};

// Catalogue: ATT-054 exactly as created in TEST + the F16 rules (to prove shared reads).
const SNAP = JSON.parse(readFileSync(join(HERE, "needs-attention-catalogue.snapshot.json"), "utf8")).records as AirtableRecord[];
const RULE54 = SNAP.find((r) => r.fields["Rule ID"] === "ATT-054")!;
const F16_RULES = SNAP.filter((r) => /^ATT-049|^ATT-05[0-3]/.test(r.fields["Rule ID"]));
const enable = (r: AirtableRecord): AirtableRecord => ({ id: rid("Set" + r.fields["Rule ID"].slice(4)), fields: { Organisation: [ORG], Rule: [r.id], Enabled: true, "Allow Override": true } });
const finSettings = (thresholdMinor: number | null, paymentDay: number | null = 20): AirtableRecord[] => [
  { id: rid("FinSetT1"), fields: Object.fromEntries(Object.entries({ "Finance Settings ID": `FINSET-${ORG_ID}`, Organisation: [ORG], ...toStoredFields({ ...EMPTY_SETTINGS, cashSafetyThresholdMinor: thresholdMinor, coachPaymentDayOfFollowingMonth: paymentDay }, SETTINGS_KEYS), Revision: 1 }).filter(([, v]) => v !== null && v !== undefined)) },
];
const finRow = (fields: Record<string, unknown>, n: number): AirtableRecord => ({ id: rid("Fin" + String(n).padStart(5, "0")), fields });
const F7_ROWS = (payments: ReturnType<typeof clientPay>[] = []) => ({
  "Finance Invoices": [INV1, INV2].map((i, k) => finRow(invoiceCreateFields(i, ORG), 10 + k)),
  "Finance Credit Notes": [],
  "Finance Payments": payments.map((p, k) => finRow(paymentCreateFields(p as any, ORG), 20 + k)),
  "Finance Client Credits": [],
  "Finance Client Credit Applications": [],
  "Finance Invoice Due Date Changes": [],
});
const clientPay = (n: number, inv: Invoice, amountMinor: number, receivedDate: string) => ({ paymentId: `FPY-${hex(n)}`, invoiceId: inv.invoiceId, clientId: inv.clientId, clientName: inv.clientName, amountMinor, currency: "GBP" as const, receivedDate, method: "bank_transfer" as const, reference: null, source: "manual" as const, externalProvider: null, externalPaymentId: null, reason: null, recordedBy: MGR, recordedAt: `${receivedDate}T12:00:00.000Z` });
// F12 coach work: one open October allocation (paid 2026-11-20) - in the 3-month range.
const OCC_OCT = { id: rid("OccCoachOct"), fields: { "Occurrence ID": "OCC-CO:2026-10-08", Date: "2026-10-08", Status: "Completed", Session: [rid("SessCoach")], "Coach Allocations": [rid("AllocCoachOct")] } };
const ALLOC_OCT = { id: rid("AllocCoachOct"), fields: { "Allocation ID": "ALLOC-CO", "Session Occurrence": [OCC_OCT.id], Coach: [FM_SEP.workerRecordId], "Rate Profile": [rid("RateProf")], "Rate Type Snapshot": "Per Session", "Pay Unit Snapshot": "Session", "Paid Units": 1, "Rate Amount Snapshot": 40, "Final Coach Cost": 40, "Cost Status": "Confirmed" } };
const COACH_ROWS = () => ({
  [COST_TABLES.allocations]: [ALLOC_OCT],
  [COST_TABLES.occurrences]: [OCC_OCT],
  [COST_TABLES.sessions]: [{ id: rid("SessCoach"), fields: { "Session Name": "ZZTEST F17 Session", Programme: "Academy" } }],
  [COST_TABLES.workers]: [{ id: FM_SEP.workerRecordId, fields: { "Coach ID": "COACH-F17", "Coach Name": "ZZTEST F17 Coach", Active: true } }],
  [COST_TABLES.lines]: [],
  [COST_TABLES.summaries]: [],
});

// ---------------------------------------------------------------------
// In-memory Airtable (writes ONLY to Exceptions) + Supabase REST (GET only)
// ---------------------------------------------------------------------
let tables: Record<string, AirtableRecord[]> = {};
let requests: { method: string; table: string }[] = [];
let sbRequests: { method: string; table: string; params: URLSearchParams }[] = [];
let sbFail: Record<string, number> = {};
let excN = 0;
const EXC = CONFIG_TABLES.exceptions;
(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const u = new URL(url);
  if (u.hostname !== "api.airtable.com") {
    const table = u.pathname.split("/").pop()!;
    sbRequests.push({ method, table, params: u.searchParams });
    if (method !== "GET") throw new Error(`Illegal Supabase ${method} ${table}`);
    if (sbFail[table]) return new Response("boom", { status: sbFail[table] });
    const org = (u.searchParams.get("organisation_id") ?? "").replace(/^eq\./, "");
    let rows = (SB_ROWS[table] ?? (() => { throw new Error(`unexpected table ${table}`); }))(db).filter((r) => r.organisation_id === org);
    if (u.searchParams.get("cancelled_at") === "is.null") rows = rows.filter((r) => r.cancelled_at === null);
    const off = Number(u.searchParams.get("offset") ?? 0), lim = Number(u.searchParams.get("limit") ?? 1e9);
    return new Response(JSON.stringify(rows.slice(off, off + lim)), { status: 200 });
  }
  const table = decodeURIComponent(u.pathname.split("/")[3]);
  requests.push({ method, table });
  if (method === "GET") return new Response(JSON.stringify({ records: (tables[table] ?? []).map((r) => ({ id: r.id, fields: r.fields })) }), { status: 200 });
  if (table !== EXC || (method !== "POST" && method !== "PATCH")) throw new Error(`Illegal write ${method} ${table}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const fields = Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== false && v !== null && v !== ""));
  const rec = { id: rid("Exc" + String(++excN).padStart(4, "0")), fields };
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
interface World { financeOn?: boolean; rules?: AirtableRecord[]; settings?: AirtableRecord[]; finSettings?: AirtableRecord[]; payments?: ReturnType<typeof clientPay>[] }
function world(o: World = {}) {
  tables = {
    [CONFIG_TABLES.rules]: o.rules ?? [RULE54],
    [CONFIG_TABLES.settings]: o.settings ?? [enable(RULE54)],
    [EXC]: [],
    [CONFIG_TABLES.features]: [{ id: rid("FeatFin"), fields: o.financeOn === false ? { "Feature Key": "module_finance" } : { "Feature Key": "module_finance", Enabled: true } }],
    [CONFIG_TABLES.organisations]: [
      { id: ORG, fields: { "Organisation ID": ORG_ID, Active: true, Timezone: TZ, "Organisation Name": "Test Org" } },
      { id: ORG2, fields: { "Organisation ID": ORG2_ID, Active: true, Timezone: TZ, "Organisation Name": "Other Org" } },
    ],
    [SETTINGS_TABLE]: o.finSettings ?? finSettings(100000),
    ...F7_ROWS(o.payments),
    ...COACH_ROWS(),
  };
  requests = [];
  sbRequests = [];
  sbFail = {};
}
const MANAGER: Caller = { userId: MGR, role: "management", active: true, organisationId: ORG_ID, displayName: "Test Manager" };
const STORE = { supabaseUrl: "https://test.supabase.example", serviceRoleKey: "service-role-test" };
const deps = (access: FinanceAccess | "throw"): Deps => ({
  airtable: { baseId: "appQktredAuGa1X7e", token: "t" },
  registry: IMPLEMENTED_EVALUATORS,
  lock: fakeLock,
  financeAccess: async () => {
    if (access === "throw") throw new Error("grant store down");
    return access;
  },
  financeStore: STORE,
});
async function run(access: FinanceAccess | "throw" = "manage", q: { caseKey?: string; debug?: boolean } = { debug: true }, now = NOW) {
  requests = [];
  sbRequests = [];
  const out = await getCases(deps(access), MANAGER, q, now);
  return out.status === "ok" ? (out.body as any) : (out as any);
}
const cr = (b: any) => (b.cases ?? []).filter((c: any) => c.ruleKey === CASH_RISK_RULE.ruleKey);
const KEY = `${CASH_RISK_RULE.ruleKey}|cash_position:${ORG_ID}`;

async function main() {
  // ===== CR: the cash-risk case (brief 52) =====
  {
    db = STD();
    world();
    const b = await run();
    const c = cr(b)[0];
    // 3m: 5000.00 - 200.00 (actual 10-12) - 800.00 (overdue today) - 300.00 coach Sep - 800.00 venue - 2000.00 Oct pay - 300.00 est
    //     + 1500.00 INV1 - 40.00 coach Oct (11-20) - 2000.00 Nov - 2000.00 Dec = -1940.00 on 12-25; first below 1000.00 on 10-25 (900.00)
    ck("CR52. Threshold 1000.00, projected low below it -> ONE ATT-054 cash_balance_below_threshold case (Warning, Review Cash Flow) keyed to the organisation", cr(b).length === 1 && c.ruleKey === "cash_balance_below_threshold" && c.ruleId === "ATT-054" && c.severity === "Warning" && c.actionLabel === "Review Cash Flow" && c.caseKey === KEY, JSON.stringify(c));
    ck("CR52b. The case exposes the projected low (-1940.00 on 2026-12-25), the threshold (1000.00), the first breach date (2026-10-25, cautious same-day order), how far below (2940.00) and the range (3m to 2027-01-14)", c.context.projectedLow === "-1940.00" && c.context.projectedLowDate === "2026-12-25" && c.context.safetyThreshold === "1000.00" && c.context.firstBreachDate === "2026-10-25" && c.context.belowThresholdBy === "2940.00" && c.context.range === "3m" && c.context.rangeEnd === "2027-01-14", JSON.stringify(c.context));
    ck("CR52c. Traceable to the Cash Flow it came from (finance/cash-flow, 3m Cash Position; GET /finance/cash-flow?range=3m&view=position); the balance is labelled Management-entered; Stripe not included", c.destination?.route === "finance/cash-flow" && c.destination?.params?.range === "3m" && c.context.sourceApi === "GET /finance/cash-flow?range=3m&view=position" && c.context.balanceLabel === "Management-entered bank balance" && c.context.balance === "5000.00" && c.context.balanceAsAt === "2026-10-10" && c.context.stripeIncluded === false && /not bank verified; Stripe not included/.test(c.detail));
    world({ finSettings: finSettings(null) });
    ck("CR49. No threshold set -> no case (nothing to compare)", cr(await run()).length === 0);
    db = STD();
    db.balances = [BX];
    world();
    ck("CR3. No Management-entered balance -> no case (the projection cannot start; never a guessed balance)", cr(await run()).length === 0);
    db = STD();
    world({ finSettings: finSettings(-1 as any) });
    const badSet = await run();
    ck("DQ1. Unreadable Finance Settings (negative threshold) -> loud: complete false, evaluator_error, no case", badSet.complete === false && cr(badSet).length === 0 && JSON.stringify(badSet.configIssues).includes("evaluator_error"));
  }

  // ===== RS: the forecast resolving clears the case (brief 53) =====
  {
    db = STD();
    db.balances = [B1, bal(2, 2000000, "2026-10-14"), BX];
    world();
    ck("RS53. A new Management-entered balance (20000.00 as at 10-14) lifts the projection above the threshold -> the case disappears by itself (no stored case)", cr(await run()).length === 0);
    db = STD();
    world({ finSettings: finSettings(-0 + 0) });
    ck("RS53b. Lowering the threshold to 0.00 -> still breached (low -1940.00 < 0.00): the rule compares strictly", cr(await run()).length === 1);
    db = STD();
    db.instalments = db.instalments.map((i) => (i.instalmentId === IA.instalmentId ? { ...i, cancelledAt: "2026-10-14T09:00:00.000Z", cancelledBy: MGR, cancelReason: "x" } : i));
    world({ finSettings: finSettings(-1 + 1, 20) });
    const less = cr(await run())[0];
    ck("RS53c. Cancelling the overdue venue payment changes the projection immediately (low -1140.00): derived from live truth every read", !!less && less.context.projectedLow === "-1140.00");
  }

  // ===== AC: access (brief 54) =====
  {
    db = STD();
    world();
    const none = await run("none");
    ck("AC54a. No Finance grant: no cash-risk case, count or amount, and NO Finance source is read", cr(none).length === 0 && sbRequests.length === 0 && !requests.some((r) => r.table === "Finance Invoices" || r.table === SETTINGS_TABLE) && none.summary.total === 0);
    const view = await run("view");
    ck("AC54b. Finance View sees the case but may not snooze it (exceptionAllowed false)", cr(view).length === 1 && cr(view)[0].exceptionAllowed === false);
    const mgr = await run("manage");
    ck("AC54c. Finance Manage sees it and may snooze it", cr(mgr).length === 1 && cr(mgr)[0].exceptionAllowed === true);
    const thrown = await run("throw");
    ck("AC54d. Grant lookup failure fails closed: no cash-risk case", cr(thrown).length === 0);
    world({ financeOn: false });
    ck("AC54e. Finance module off: no case, no Finance read", cr(await run()).length === 0 && sbRequests.length === 0);
    world();
    const ex = await createException(deps("manage"), MANAGER, { caseKey: KEY, reason: "ZZTEST transfer arranged", effectiveUntil: "2026-10-16T09:00:00.000Z" }, NOW);
    const snoozed = await run("manage");
    ck("SN. Snooze = the existing exact-case exception: the case is hidden until the exception ends; the forecast itself is untouched", ex.status === "ok" && cr(snoozed).length === 0 && snoozed.summary.suppressed === 1 && JSON.stringify(runCashFlowPass({ now: NOW, organisation: { recordId: ORG, organisationId: ORG_ID, name: "Test Org", timezone: TZ } as any, sources: ctxSources() }).projectedLowMinor) === "-194000", JSON.stringify({ ex: ex.status, err: (ex as any).error ?? (ex as any).code, n: cr(snoozed).length, sup: snoozed.summary?.suppressed }));
  }

  // ===== PAR: parity with Finance's own normalisation =====
  {
    db = STD();
    world({ payments: [clientPay(5, INV1, 50000, "2026-10-13")] });
    // Cash kept as client credit from an overpayment (received 10-14): an Actual IN on both sides.
    tables["Finance Client Credits"] = [finRow(clientCreditCreateFields({ creditId: `FCC-${hex(7)}`, clientId: INV2.clientId, clientName: INV2.clientName, source: "overpayment", sourceInvoiceId: INV2.invoiceId, sourceCreditNoteId: null, sourcePaymentId: `FPY-${hex(6)}`, receivedDate: "2026-10-14", originalMinor: 2500, remainingMinor: 2500, currency: "GBP", status: "available", reason: "kept", voidReason: null, voidedBy: null, voidedAt: null, createdBy: MGR, createdAt: "2026-10-14T12:00:00.000Z", revision: 1, updatedBy: MGR, updatedAt: "2026-10-14T12:00:00.000Z" } as any, ORG), 40)];
    const na = runCashFlowPass({ now: NOW, organisation: { recordId: ORG, organisationId: ORG_ID, name: "Test Org", timezone: TZ } as any, sources: ctxSources() });
    const today = "2026-10-15";
    const end = rangeEnd(today, "3m");
    const wm = coachWorkMonths(today, end);
    const r = receivablesOf({ invoices: tables["Finance Invoices"], notes: [], payments: tables["Finance Payments"], credits: tables["Finance Client Credits"], applications: [], dueChanges: [] } as any, ORG, today);
    // Finance's loadCostWorld: only occurrences in the work-month window + the allocations / sessions they link.
    const from = `${wm[0]}-01`, to = `${wm[wm.length - 1]}-31`;
    const occs = tables[COST_TABLES.occurrences].filter((o) => o.fields.Date >= from && o.fields.Date <= to);
    const allocIds = occs.flatMap((o) => o.fields[COST_F.occurrence.allocations] ?? []);
    const finWorld: CostWorld = { allocations: tables[COST_TABLES.allocations].filter((a) => allocIds.includes(a.id)), occurrences: new Map(occs.map((o) => [o.id, o])), sessions: new Map(tables[COST_TABLES.sessions].map((s) => [s.id, s])), workers: tables[COST_TABLES.workers], lines: new Map(), summaries: new Map() };
    const fin = buildCashFlow({
      organisationId: ORG_ID, today, range: "3m", balance: latestBalance(db.balances.filter((b) => b.organisationId === ORG_ID)), thresholdMinor: 100000,
      receivables: r.receivables, receipts: r.receipts, awaitingIssue: r.awaitingIssue, suppliers: [S1], instalments: db.instalments.filter((i) => i.organisationId === ORG_ID && !i.cancelledAt), supplierPayments: db.payments,
      employmentVersions: db.versions, employmentItems: db.items, coachMonths: coachMonthInputs(finWorld, { months: db.months, corrections: [] }, wm, today, 20), coachPaymentDayConfigured: true,
    });
    ck("PAR1. The Needs Attention pass and Finance's own normalisation (F7 receivablesOf, F12 window world, F13 / F15 rows) give the SAME timeline, balances, low and first breach through the one engine", JSON.stringify(na.events) === JSON.stringify(fin.events) && na.projectedLowMinor === fin.projectedLowMinor && na.firstBreachDate === fin.firstBreachDate && na.projectedEndMinor === fin.projectedEndMinor && na.events.some((e) => e.key === `in:client_receipt:FPY-${hex(5)}`) && na.events.some((e) => e.key === `in:client_receipt:FCC-${hex(7)}` && e.amountMinor === 2500 && e.counterparty === "ZZTEST F17 School"), JSON.stringify({ diff: na.events.map((e, k) => [JSON.stringify(e), JSON.stringify(fin.events[k])]).filter(([a, b]) => a !== b).slice(0, 2), end: [na.projectedEndMinor, fin.projectedEndMinor], fb: [na.firstBreachDate, fin.firstBreachDate] }));
    ck("PAR2. Other organisations never contribute (their instalment / balance rows are never returned to this organisation's read)", !na.events.some((e) => e.sourceId === IX.instalmentId) && na.balance?.balanceId === B1.balanceId);
  }

  // ===== D1: on TODAY, Actual cash first, then today's forecasts (approved 2026-10-02) =====
  {
    // Opening 1000.00 as at yesterday; Actual OUT today 300.00 (paid in full); Confirmed OUT due today 100.00; threshold 601.00.
    const ID1 = { ...inst({ due: "2026-10-15", amount: 30000, paid: 30000 }) };
    const ID2 = inst({ due: "2026-10-15", amount: 10000 });
    const PD1: Payment = { ...PB, paymentId: `FSP-${hex(41)}`, instalmentId: ID1.instalmentId, amountMinor: 30000, paidDate: "2026-10-15", remainingAfterMinor: 0, recordedAt: "2026-10-15T08:00:00.000Z" };
    db = { suppliers: [S1], instalments: [ID1, ID2], payments: [PD1], versions: [], items: [], months: [], corrections: [], balances: [bal(1, 100000, "2026-10-14")] };
    world({ finSettings: finSettings(60100) });
    const c = cr(await run())[0];
    const na = runCashFlowPass({ now: NOW, organisation: { recordId: ORG, organisationId: ORG_ID, name: "Test Org", timezone: TZ } as any, sources: ctxSources() });
    const today = "2026-10-15";
    const wm = coachWorkMonths(today, rangeEnd(today, "3m"));
    const r = receivablesOf({ invoices: tables["Finance Invoices"], notes: [], payments: [], credits: [], applications: [], dueChanges: [] } as any, ORG, today);
    const from = `${wm[0]}-01`, to = `${wm[wm.length - 1]}-31`;
    const occs = tables[COST_TABLES.occurrences].filter((o) => o.fields.Date >= from && o.fields.Date <= to);
    const allocIds = occs.flatMap((o) => o.fields[COST_F.occurrence.allocations] ?? []);
    const finWorld: CostWorld = { allocations: tables[COST_TABLES.allocations].filter((a) => allocIds.includes(a.id)), occurrences: new Map(occs.map((o) => [o.id, o])), sessions: new Map(tables[COST_TABLES.sessions].map((s) => [s.id, s])), workers: tables[COST_TABLES.workers], lines: new Map(), summaries: new Map() };
    const fin = buildCashFlow({
      organisationId: ORG_ID, today, range: "3m", balance: latestBalance(db.balances), thresholdMinor: 60100,
      receivables: r.receivables, receipts: r.receipts, awaitingIssue: r.awaitingIssue, suppliers: [S1], instalments: db.instalments, supplierPayments: db.payments,
      employmentVersions: [], employmentItems: [], coachMonths: coachMonthInputs(finWorld, { months: [], corrections: [] }, wm, today, 20), coachPaymentDayConfigured: true,
    });
    const todays = fin.events.filter((e) => e.included && e.cashDate === today);
    ck("D1a. Finance: today's Actual OUT 300.00 comes first (700.00), then the Confirmed OUT 100.00 (600.00); low 600.00 today; threshold 601.00 breached today", todays.map((e) => `${e.state}:${e.balanceAfterMinor}`).join(",") === "actual:70000,confirmed:60000" && fin.balanceTodayMinor === 70000 && fin.projectedLowMinor === 60000 && fin.projectedLowDate === today && fin.firstBreachDate === today && fin.thresholdBreached === true, JSON.stringify({ t: todays.map((e) => [e.state, e.balanceAfterMinor]), low: fin.projectedLowMinor, fb: fin.firstBreachDate }));
    ck("D1b. ATT-054 raises the case with the SAME corrected result: low 600.00 on 2026-10-15, threshold 601.00, first breach 2026-10-15, 1.00 below", !!c && c.context.projectedLow === "600.00" && c.context.projectedLowDate === today && c.context.safetyThreshold === "601.00" && c.context.firstBreachDate === today && c.context.belowThresholdBy === "1.00", JSON.stringify(c?.context));
    ck("D1c. Parity: the Needs Attention pass and Finance give the same timeline, low, first breach and end through the one engine", JSON.stringify(na.events) === JSON.stringify(fin.events) && na.projectedLowMinor === fin.projectedLowMinor && na.firstBreachDate === fin.firstBreachDate && na.projectedEndMinor === fin.projectedEndMinor);
  }

  // ===== PF: bounded reads =====
  {
    db = STD();
    world({ rules: [RULE54, ...F16_RULES], settings: [enable(RULE54), ...F16_RULES.map(enable)] });
    const s0 = cashFlowPassStats().runs;
    const b = await run();
    const lists = b.diagnostics.reads.lists;
    ck("PF1. Every source is listed exactly once per request (F16 Money Out + F17 cash risk share the Supabase reads); one Cash Flow pass", Object.values(CASH_FLOW_SUPABASE).every((s) => lists[s] === 1) && CASH_RISK_SOURCES.filter((s) => !s.startsWith("supabase:")).every((t) => lists[t] === 1) && cashFlowPassStats().runs - s0 === 1 && b.complete === true, JSON.stringify(lists));
    ck("PF2. Supabase reads are organisation-scoped, paged, GET only, from the allowlist", sbRequests.length > 0 && sbRequests.every((r) => r.method === "GET" && r.params.get("organisation_id") === `eq.${ORG_ID}` && r.params.get("limit") === "1000" && Object.values(FINANCE_SOURCES).some((f) => f.table === r.table)));
    ck("PF3. Money Out rules keep working alongside (shared sources, unchanged)", (b.cases ?? []).some((c: any) => Object.values(MONEY_OUT_RULES).map((x) => x.ruleKey).includes(c.ruleKey)));
    sbFail["finance_bank_balances"] = 500;
    world();
    sbFail["finance_bank_balances"] = 500;
    const down = await run();
    ck("DQ2. A Finance source that cannot be read -> the rule is incomplete (evaluator_error), no case, never a guessed balance", down.complete === false && cr(down).length === 0);
  }

  // ===== DR: drift =====
  {
    const src = canon("needs-attention/cash-flow.ts");
    const blocks = [...src.matchAll(/\/\/ ===== COPIED FROM finance\/([a-z-]+\.ts) - DO NOT EDIT HERE =====\n([^]*?)\n\/\/ ===== END COPIED BLOCK =====/g)];
    ck("DR1. Every copied row reader is verbatim from its canonical Finance repository (5 blocks: helpers, supplier payment, Coach Month, correction, bank balance)", blocks.length === 5 && blocks.every((m) => canon(`finance/${m[1]}`).includes(m[2])));
    ck("DR2. Registry has ATT-054 matching its catalogue row (Active, module_finance, Default Enabled off, Review Cash Flow)", IMPLEMENTED_EVALUATORS.some((e) => e.ruleKey === "cash_balance_below_threshold" && e.ruleId === "ATT-054") && RULE54.fields["Evaluation Status"] === "Active" && RULE54.fields["Required Module"] === "module_finance" && !RULE54.fields["Default Enabled"] && RULE54.fields["Action Label"] === "Review Cash Flow");
    ck("DR3. The rule uses Finance's own engine (bundled), never a copy of its logic; no Finance write and no Stripe read", /from "\.\.\/finance\/finance-cash-flow\.ts"/.test(src) && !/fetch\(|stripe/i.test(src.replace(/Stripe not included/g, "").replace(/stripeIncluded/g, "")));
    const mirror = readFileSync(join(HERE, "needs-attention-cash-flow.ts"), "utf8");
    const expect = src.replace(/from "\.\/(needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client|work-summaries|finance|finance-drafts|money-out|orchestrator|cash-flow)\.ts"/g, (_m, n) => `from "./${n === "needs-attention" ? "needs-attention-engine" : "needs-attention-" + n}.ts"`).replace(/from "\.\.\/finance\/([a-z-]+\.ts)"/g, 'from "./$1"');
    ck("DR4. Test copy == canonical needs-attention/cash-flow.ts (only import paths adjusted)", mirror.slice(mirror.indexOf("/**", 3)) === expect);
    ck("DR5. FINANCE_SOURCES gains exactly the four F17 tables (supplier payments, Coach Months, corrections, bank balances), each organisation-scoped and ordered by key", ["finance_supplier_payments", "finance_worker_cost_months", "finance_worker_cost_corrections", "finance_bank_balances"].every((t) => FINANCE_SOURCES[`supabase:${t}`]?.table === t) && Object.keys(FINANCE_SOURCES).length === 8);
  }
}

function ctxSources(): Record<string, readonly AirtableRecord[]> {
  const out: Record<string, any> = {};
  for (const t of CASH_RISK_SOURCES) {
    if (t.startsWith("supabase:")) out[t] = SB_ROWS[FINANCE_SOURCES[t].table](db).filter((r) => r.organisation_id === ORG_ID && (t !== "supabase:finance_supplier_instalments" || r.cancelled_at === null));
    else out[t] = tables[t] ?? [];
  }
  return out;
}

main()
  .then(() => {
    for (const [s, n, x] of R) console.log(`${s}  ${n}${s === "FAIL" && x ? `  -- ${x}` : ""}`);
    const passed = R.filter((r) => r[0] === "PASS").length;
    console.log(`\nneeds-attention-cash-flow: ${passed}/${R.length} checks passed`);
    if (failed) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
