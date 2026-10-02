/**
 * Finance Foundation F18 - Month Report + Finance Overview.
 * Run: node --experimental-strip-types tests/support/finance-month-report.test.ts
 *
 *   SO  audit / source ownership                                         brief 1-3
 *   OA  overall Actual (locked structure)                                brief 4-12
 *   EX  Expected + Actual (supersession, no double count, state labels)  brief 13-17
 *   PG  programmes by stable Finance Service ID                          brief 18-27
 *   OH  overheads by category                                            brief 28-34
 *   RC  revenue corrections                                              brief 35-37
 *   PM  previous month comparison                                        brief 38-42
 *   RE  reconciliation (no balancing line)                               brief 43-47
 *   OV  Finance Overview (Actual only)                                   brief 48-57
 *   MD  month / date                                                     brief 58-60
 *   AC  access                                                           brief 61-67
 *   AU  audit / performance                                              brief 68-70
 *   D   locked decisions D1-D12 (receipt allocation, Stripe, coach, venue, overheads, ...)
 *   Z   drift (mirrors == canonical, routes, F2 setting wiring)
 *
 * Part 1 drives the PURE engine with a hand-computed October 2026 scenario
 * (every figure below is worked by hand in the comments). Part 2 drives the
 * REAL orchestrator through the in-memory world (finance-cash-flow-world.ts):
 * F3 / F5 / F6 / F7 rows come from those slices' OWN create-field builders,
 * suppliers / credits / employment from the REAL F13 / F14 / F15 routes, F12
 * Coach Months as stored rows. NOW = 2026-10-15 (London).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTenantKey } from "./finance-access.ts";
import { EMPTY_SETTINGS, FIELD_NAMES, FIELD_VALIDATORS, SETTINGS_KEYS, overviewCashSummaryShown, parseUpdateBody, requiredKeys, toStoredFields } from "./finance-settings.ts";
import { TABLES as F3_TABLES, clientFields, lifecycleCreateFields, serviceFields, termsCreateFields } from "./finance-commercial-mapping.ts";
import { INVOICING_TABLES, lineCreateFields } from "./finance-invoicing-mapping.ts";
import { ISSUE_TABLES, invoiceLineCreateFields } from "./finance-issue-mapping.ts";
import type { CreditNote, Invoice, InvoiceLine } from "./finance-issue.ts";
import type { Line } from "./finance-invoicing.ts";
import { matchCashFlowRoute } from "./finance-cash-flow.ts";
import {
  type BillingInput,
  type CoachInput,
  type InvoiceInput,
  type InvoiceLineInput,
  type MonthReportInputs,
  MonthReportDataError,
  addMonths,
  allocateProportionally,
  buildMonthReport,
  marginOf,
  matchMonthReportRoute,
  monthEnd,
  parseMonthReportQuery,
  previousMonth,
  proportionOfLine,
  stateLabel,
  upcomingPayments,
} from "./finance-month-report.ts";
import { type NeedsAttentionSummary, readFinanceOverview, readMonthReport } from "./finance-month-report-orchestrator.ts";
import {
  CLIENT,
  COACH_F17,
  MGR,
  ORG,
  ORG_REC,
  R,
  SA,
  SESS_COACH,
  T_,
  VENUE_BODY,
  agreementNew,
  allocation,
  balanceNew,
  cashFlow,
  cfFetchLog,
  application,
  catNew,
  categorise,
  ck,
  coach,
  coachOcc,
  correctionRow,
  creditNew,
  creditNote,
  deps,
  empNew,
  failed,
  financeMonthRow,
  invoice,
  mgr,
  monthAct,
  nogrant,
  noteCredit,
  occ,
  parent,
  pay,
  payment,
  reset,
  setF7,
  supplierNew,
  viewer,
  world,
} from "./finance-cash-flow-world.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test");
const pence = (s: string | null | undefined) => (s === null || s === undefined ? null : Math.round(Number(s) * 100));
const J = (x: unknown) => JSON.stringify(x);

// =====================================================================
// Part 1 - pure engine inputs (October 2026; previous month September)
// =====================================================================
const A = "FSV-AAAAAAAAAAAA";
const B = "FSV-BBBBBBBBBBBB";
const SW = { categoryId: "FOC-000000000001", name: "Software" };
const SAL = { categoryId: "FOC-000000000002", name: "Salaries" };
const inv = (id: string, o: Partial<InvoiceInput>): InvoiceInput => ({ invoiceId: id, officialNumber: `TEST-${id}`, clientId: "FCL-1", clientName: "ZZTEST School", issued: true, grossMinor: 0, creditNotesMinor: 0, cashReceivedMinor: 0, creditAppliedMinor: 0, ...o });
const ln = (invoiceId: string, lineId: string, date: string, serviceId: string, gross: number, vat = 0, o: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({ invoiceId, lineId, occurrenceId: `OCC-${lineId}`, occurrenceDate: date, sessionId: "S1", sessionName: "ZZTEST Session", serviceId, serviceName: serviceId, netMinor: gross - vat, vatMinor: vat, grossMinor: gross, creditNote: null, ...o });
const bill = (occurrenceId: string, date: string, serviceId: string | null, o: Partial<BillingInput>): BillingInput => ({ occurrenceId, occurrenceDate: date, sessionId: "S2", sessionName: "ZZTEST Billing", serviceId, serviceName: serviceId, clientId: "FCL-1", clientName: "ZZTEST School", billingMethod: "hub", outcome: "eligible", eligibilityStatus: "confirmed", deferral: null, detail: null, expected: null, ...o });
const val = (gross: number, vat = 0) => ({ netMinor: gross - vat, vatMinor: vat, grossMinor: gross });
const coachIn = (kind: CoachInput["kind"], workMonth: string, o: Partial<CoachInput>): CoachInput => ({ kind, workMonth, workDate: null, coach: { ref: "COACH-1", name: "ZZTEST Coach" }, monthId: kind === "live_item" ? null : `FCM-${workMonth}`, monthState: kind === "live_item" ? "open" : "finalised", correctionId: null, allocation: null, occurrenceId: null, sessionName: null, serviceId: null, programmeLabel: null, costBasis: "paid", amountMinor: 0, ...o });
const share = (id: string, date: string, serviceId: string | null, amount: number, o: { venue?: boolean; estimated?: boolean } = {}) => ({ agreementId: o.venue === false ? "FSA-OTHER" : "FSA-VENUE", agreementName: o.venue === false ? "ZZTEST kit hire" : "ZZTEST hall hire", supplierId: o.venue === false ? "FSU-KIT" : "FSU-HALL", supplierName: o.venue === false ? "ZZTEST Kit" : "ZZTEST Hall", supplierType: o.venue === false ? "other" : "venue", occurrenceDate: date, occurrenceRef: id, sessionId: "S3", sessionName: "ZZTEST Hall Session", serviceId, programmeLabel: "Academy", amountMinor: amount, estimated: !!o.estimated });

function pureInputs(): MonthReportInputs {
  return {
    organisationId: ORG,
    today: "2026-10-15",
    month: "2026-10",
    invoices: [
      // INV-1 paid in full; it spans September (L1) and October (L2): a receipt never moves a line's month.
      inv("INV-1", { grossMinor: 18000, cashReceivedMinor: 18000 }),
      // INV-2 300.00, 100.00 received: spread 2:1 over L3 / L4 by gross.
      inv("INV-2", { grossMinor: 30000, cashReceivedMinor: 10000 }),
      // INV-3: L5 credited (credit note in NOVEMBER - still corrects October); L6 paid.
      inv("INV-3", { grossMinor: 9000, creditNotesMinor: 5000, cashReceivedMinor: 4000 }),
      // INV-4 awaiting issue in Xero: nothing on it can be Actual.
      inv("INV-4", { grossMinor: 7000, issued: false }),
    ],
    invoiceLines: [
      ln("INV-1", "FVL-1", "2026-09-10", A, 6000, 1000),
      ln("INV-1", "FVL-2", "2026-10-01", A, 12000, 2000),
      ln("INV-2", "FVL-3", "2026-10-05", B, 20000, 3333),
      ln("INV-2", "FVL-4", "2026-10-06", A, 10000),
      ln("INV-3", "FVL-5", "2026-10-07", B, 5000, 0, { creditNote: { creditNoteId: "FCN-1", creditDate: "2026-11-02" } }),
      ln("INV-3", "FVL-6", "2026-10-08", B, 4000),
      ln("INV-4", "FVL-7", "2026-10-12", A, 7000),
    ],
    draftLines: [
      { draftId: "FID-1", lineId: "FIL-1", clientId: null, clientName: null, occurrenceId: "OCC-D1", occurrenceDate: "2026-10-13", sessionId: "S1", sessionName: "ZZTEST", serviceId: B, serviceName: B, ...val(3000) },
      // a draft line for an occurrence already on an invoice line - superseded by the invoice, never counted
      { draftId: "FID-2", lineId: "FIL-2", clientId: null, clientName: null, occurrenceId: "OCC-FVL-2", occurrenceDate: "2026-10-01", sessionId: "S1", sessionName: "ZZTEST", serviceId: A, serviceName: A, ...val(99999) },
      // a draft line for the CREDITED occurrence - the correction is not revived from a lower layer
      { draftId: "FID-3", lineId: "FIL-3", clientId: null, clientName: null, occurrenceId: "OCC-FVL-5", occurrenceDate: "2026-10-07", sessionId: "S1", sessionName: "ZZTEST", serviceId: B, serviceName: B, ...val(5000) },
    ],
    billing: [
      bill("OCC-B1", "2026-10-10", A, { expected: val(2500) }),
      bill("OCC-B2", "2026-10-20", B, { outcome: "not_eligible", eligibilityStatus: "not_yet_delivered", expected: val(1500) }),
      bill("OCC-B9", "2026-10-11", A, { billingMethod: "manual", expected: val(3500) }),
      bill("OCC-FVL-2", "2026-10-01", A, { expected: val(12000, 2000) }), // claimed by an invoice line
      bill("OCC-D1", "2026-10-13", B, { expected: val(3000) }), // claimed by a draft line
      bill("OCC-X1", "2026-10-14", A, { outcome: "not_eligible", eligibilityStatus: "cancelled", expected: val(2500) }),
      bill("OCC-X2", "2026-10-14", A, { outcome: "not_billable", expected: null }),
      bill("OCC-X3", "2026-10-16", A, { outcome: "missing_terms", eligibilityStatus: null, detail: "no commercial terms on the date", expected: null }),
      bill("OCC-X4", "2026-10-17", A, { expected: null }), // eligible but no trustworthy value
      bill("OCC-X5", "2026-10-18", null, { outcome: "deferred_revenue_model", deferral: "parent_paid", expected: null }),
      bill("OCC-S1", "2026-09-20", A, { expected: val(1000) }),
    ],
    unlinkedOccurrences: [{ occurrenceId: "OCC-N1", date: "2026-10-05", sessionName: "ZZTEST No Service" }],
    coach: [
      coachIn("frozen_item", "2026-10", { workDate: "2026-10-05", allocation: "ALLOC-1", serviceId: A, programmeLabel: "Academy", amountMinor: 4500 }),
      coachIn("frozen_item", "2026-10", { workDate: "2026-10-06", allocation: "ALLOC-2", serviceId: B, programmeLabel: "After School", amountMinor: 3000 }),
      coachIn("correction", "2026-10", { correctionId: "FCX-1", amountMinor: 500 }),
      coachIn("frozen_item", "2026-09", { workDate: "2026-09-15", allocation: "ALLOC-0", serviceId: A, programmeLabel: "Academy", amountMinor: 4000 }),
      coachIn("live_item", "2026-10", { coach: { ref: "COACH-2", name: "ZZTEST Open Coach" }, workDate: "2026-10-22", allocation: "ALLOC-3", serviceId: A, amountMinor: 2000 }),
      coachIn("live_item", "2026-10", { coach: { ref: "COACH-2", name: "ZZTEST Open Coach" }, workDate: "2026-10-29", allocation: "ALLOC-4", serviceId: A, amountMinor: null }),
      coachIn("frozen_item", "2026-10", { workDate: "2026-10-07", allocation: "ALLOC-5", serviceId: A, costBasis: "salaried", amountMinor: 0 }),
    ],
    directShares: [
      share("OCC-V1", "2026-10-05", A, 10000),
      share("OCC-V2", "2026-10-20", A, 10000),
      share("OCC-V3", "2026-10-06", B, 5000, { estimated: true }),
      share("OCC-K1", "2026-10-07", B, 2000, { venue: false }),
    ],
    unresolvedDirectAgreements: [],
    supplierCredits: [
      { creditId: "FSC-1", supplierId: "FSU-HALL", supplierName: "ZZTEST Hall", supplierType: "venue", agreementId: "FSA-VENUE", agreementName: "ZZTEST hall hire", classification: "direct", category: null, creditDate: "2026-10-09", scope: "sessions", amountMinor: 3000, rows: [{ serviceId: A, programmeLabel: "Academy", amountMinor: 3000, sessionId: "S3", sessionDate: "2026-10-05" }] },
      { creditId: "FSC-2", supplierId: "FSU-KIT", supplierName: "ZZTEST Kit", supplierType: "other", agreementId: "FSA-OTHER", agreementName: "ZZTEST kit hire", classification: "direct", category: null, creditDate: "2026-10-10", scope: "agreement", amountMinor: 1000, rows: [{ serviceId: null, programmeLabel: null, amountMinor: 1000, sessionId: null, sessionDate: null }] },
      { creditId: "FSC-3", supplierId: "FSU-SOFT", supplierName: "ZZTEST Software", supplierType: "software_service", agreementId: "FSA-SOFT", agreementName: "ZZTEST licence", classification: "general", category: SW, creditDate: "2026-10-11", scope: "agreement", amountMinor: 1500, rows: [] },
      { creditId: "FSC-4", supplierId: "FSU-SOFT", supplierName: "ZZTEST Software", supplierType: "software_service", agreementId: null, agreementName: null, classification: null, category: null, creditDate: "2026-10-12", scope: "supplier", amountMinor: 500, rows: [] },
    ],
    overheadInstalments: [
      { agreementId: "FSA-SOFT", agreementName: "ZZTEST licence", instalmentId: "FSI-1", supplierId: "FSU-SOFT", supplierName: "ZZTEST Software", vatTreatment: "plus_vat", category: SW, dueDate: "2026-10-03", amountMinor: 5000, state: "confirmed" },
      { agreementId: "FSA-SOFT", agreementName: "ZZTEST licence", instalmentId: "FSI-2", supplierId: "FSU-SOFT", supplierName: "ZZTEST Software", vatTreatment: "plus_vat", category: SW, dueDate: "2026-10-25", amountMinor: 4000, state: "estimated" },
      { agreementId: "FSA-MISC", agreementName: "ZZTEST misc", instalmentId: "FSI-3", supplierId: "FSU-MISC", supplierName: "ZZTEST Misc", vatTreatment: null, category: null, dueDate: "2026-10-04", amountMinor: 10000, state: "paid" },
      { agreementId: "FSA-MISC", agreementName: "ZZTEST misc", instalmentId: "FSI-4", supplierId: "FSU-MISC", supplierName: "ZZTEST Misc", vatTreatment: null, category: null, dueDate: "2026-11-05", amountMinor: 7000, state: "confirmed" },
    ],
    employment: [
      { employmentId: "FEM-1", versionId: "FEV-1", itemId: "FEI-1", person: { ref: null, name: "ZZTEST Office Manager" }, category: SAL, month: "2026-10", amountMinor: 200000, state: "confirmed", estimateLabel: null },
      { employmentId: "FEM-2", versionId: "FEV-2", itemId: null, person: { ref: null, name: "ZZTEST Groundsman" }, category: SAL, month: "2026-10", amountMinor: 100000, state: "estimated", estimateLabel: "Estimate" },
      { employmentId: "FEM-1", versionId: "FEV-1", itemId: "FEI-0", person: { ref: null, name: "ZZTEST Office Manager" }, category: SAL, month: "2026-09", amountMinor: 200000, state: "paid", estimateLabel: null },
    ],
    serviceLabels: { [A]: "ZZTEST Academy", [B]: "ZZTEST After School" },
    coachMonthsNeedingCorrection: [],
    parentRevenue: { status: "not_connected", grossMinor: null, receipts: null, detail: null },
  };
}
const meta = { generatedAt: "2026-10-15T12:00:00.000Z", organisationName: "Test Org" };
const prog = (r: any, id: string) => r.programmes.find((p: any) => p.financeServiceId === id);
const cat = (r: any, id: string) => r.overheads.categories.find((c: any) => c.categoryId === id);
const comp = (r: any, code: string) => r.completeness.items.find((i: any) => i.code === code);

async function pure() {
  const inp = pureInputs();
  const act = buildMonthReport(inp, "actual", meta) as any;
  const exp = buildMonthReport(inp, "expected", meta) as any;
  const o = act.overall;

  // ----- OA. Overall Actual (brief 4-12) -----
  // revenue Actual: L2 120.00 (VAT 20.00) + INV-2 received 100.00 (L3 66.67 VAT 11.11 + L4 33.33) + L6 40.00 = 260.00 / 31.11 / 228.89
  ck("OA4. Gross Revenue (Actual) = received portions only: 120.00 + 66.67 + 33.33 + 40.00 = 260.00", o.grossRevenue === "260.00", o.grossRevenue);
  ck("OA5. VAT = 20.00 + 11.11 (the received share of L3's 33.33 VAT) = 31.11", o.vat === "31.11", o.vat);
  ck("OA6. Net Revenue = Gross - VAT = 228.89 (net is what the business keeps)", o.netRevenue === "228.89", o.netRevenue);
  // direct Actual: coach 45 + 30 + 5 (correction) + 0 (salaried); venue 100 - 30 credit; other 20 - 10 credit = 160.00
  ck("OA7. Direct Costs (Actual) = coach 80.00 (finalised items + correction) + venue 70.00 (100.00 - 30.00 credit) + other 10.00 (20.00 - 10.00 credit) = 160.00", o.directCosts === "160.00", o.directCosts);
  ck("OA8. Programme Contribution = 228.89 - 160.00 = 68.89", o.programmeContribution === "68.89");
  // overheads Actual: software 50 confirmed + misc 100 paid - 15 credit - 5 supplier-wide credit + salary 2000 confirmed = 2130.00
  ck("OA9. Overheads (Actual) = 50.00 + 100.00 - 15.00 - 5.00 + 2000.00 = 2130.00 (estimated 40.00 / 1000.00 and the November instalment excluded)", o.overheads === "2130.00", o.overheads);
  ck("OA10. Final Business Profit = 228.89 - 160.00 - 2130.00 = -2061.11", o.finalBusinessProfit === "-2061.11", o.finalBusinessProfit);
  ck("OA11. Final Margin = profit / net revenue = -206111 / 22889 = -900.48% (2 dp, half away from zero)", o.finalMargin.percent === "-900.48" && o.finalMargin.reason === null, J(o.finalMargin));
  const empty = buildMonthReport({ ...inp, month: "2027-03" }, "actual", meta) as any;
  ck("OA12. Zero revenue: margin is null with reason no_net_revenue (never divide by zero, never 0%); negative revenue -> net_revenue_negative", empty.overall.finalMargin.percent === null && empty.overall.finalMargin.reason === "no_net_revenue" && marginOf(-100, -50).reason === "net_revenue_negative" && marginOf(1, 3).percent === "33.33" && marginOf(2, 3).percent === "66.67" && marginOf(-1, 8).percent === "-12.50");
  ck("OA-S. Locked structure, in order: Gross Revenue, VAT, Net Revenue, Direct Costs, Programme Contribution, Overheads, Final Business Profit, Final Margin", Object.keys(o).join() === "grossRevenue,vat,netRevenue,directCosts,programmeContribution,overheads,finalBusinessProfit,finalMargin");

  // ----- EX. Expected + Actual (brief 13-17) -----
  const e = exp.overall;
  // + L3 unpaid 133.33 (VAT 22.22) + L4 unpaid 66.67 + L7 70.00 + draft 30.00 + F4 25.00 + 15.00 + Manual 35.00 = 635.00 gross; VAT 53.33; net 581.67
  ck("EX13. Expected revenue where authoritative: unpaid invoice portions (133.33 + 66.67), awaiting-issue invoice (70.00), Included draft (30.00), F4 delivered-not-invoiced (25.00), scheduled (15.00), Manual Billing (35.00) -> gross 635.00, VAT 53.33, net 581.67", e.grossRevenue === "635.00" && e.vat === "53.33" && e.netRevenue === "581.67", J(e));
  // + open-month live coach 20.00 + future venue share 100.00 + estimated venue share 50.00 = 330.00
  ck("EX14. Expected direct cost: open Coach Month live cost (20.00; the unpriced item is NOT 0.00, it is surfaced), future venue share (100.00), estimated-agreement share (50.00) -> 330.00", e.directCosts === "330.00" && comp(exp, "coach_cost_unpriced")?.count === 1 && comp(exp, "coach_cost_unpriced")?.severity === "incomplete", e.directCosts);
  ck("EX15. Expected overheads: estimated instalment 40.00 + estimated employment month 1000.00 -> 3170.00", e.overheads === "3170.00", e.overheads);
  const keys = (r: any) => [...r.programmes.flatMap((p: any) => p.detail.revenueSources.map((s: any) => s.occurrenceId))];
  const occs = keys(exp);
  ck("EX16. One economic item per occurrence: the draft for an invoiced occurrence (999.99) and F4 for invoiced / drafted occurrences are never added; a partly paid line is ONE line split into received + not-yet-received", !occs.includes("OCC-FIL-2") && occs.filter((x: string) => x === "OCC-FVL-2").length === 1 && occs.filter((x: string) => x === "OCC-D1").length === 1 && occs.filter((x: string) => x === "OCC-FVL-3").length === 2 && !J(exp).includes("999.99"));
  ck("EX17. State labels: Actual report 'Actual'; Expected + Actual report 'Mixed'; programme FSV-B in expected mode 'Mixed'; a month with nothing 'None'", act.state === "Actual" && exp.state === "Mixed" && prog(exp, B).state === "Mixed" && empty.state === "None" && stateLabel(["expected"]) === "Expected" && act.modeLabel === "Actual" && exp.modeLabel === "Expected + Actual");
  ck("EX17b. Every revenue / cost detail row carries its own state (actual / expected)", [...exp.programmes, exp.unattributed].every((p: any) => [...p.detail.revenueSources, ...p.detail.coachCosts, ...p.detail.venueCosts, ...p.detail.otherDirectCosts].every((d: any) => d.state === "actual" || d.state === "expected")));

  // ----- PG. Programmes (brief 18-27) -----
  ck("PG18. Programmes grouped by stable Finance Service ID (sorted), labelled from F3 - never by name", act.programmes.map((p: any) => p.financeServiceId).join() === `${A},${B}` && prog(act, A).label === "ZZTEST Academy" && prog(act, A).resolved === true);
  ck("PG19. Revenue by programme: FSV-A net 133.33 (100.00 + 33.33); FSV-B net 95.56 (55.56 + 40.00)", prog(act, A).revenue.net === "133.33" && prog(act, B).revenue.net === "95.56" && prog(act, B).revenue.vat === "11.11");
  ck("PG20. Coach Costs by programme from the frozen Coach Month items: FSV-A 45.00 (+ salaried 0.00), FSV-B 30.00", prog(act, A).directCosts.coach === "45.00" && prog(act, B).directCosts.coach === "30.00");
  ck("PG21. Venue cost by programme from frozen F13 profitability shares: FSV-A 100.00 gross", prog(act, A).directCosts.venue.gross === "100.00" && prog(act, B).directCosts.venue.gross === "0.00");
  ck("PG22. F14 credit adjusts the programme it is attributed to: FSV-A venue 100.00 - 30.00 = 70.00 net (gross kept, adjustment separate)", prog(act, A).directCosts.venue.creditAdjustment === "30.00" && prog(act, A).directCosts.venue.net === "70.00");
  ck("PG23. Other direct supplier cost: FSV-B 20.00", prog(act, B).directCosts.otherDirect.net === "20.00" && prog(act, B).directCosts.total === "50.00");
  ck("PG24. Contribution per programme: FSV-A 133.33 - 115.00 = 18.33; FSV-B 95.56 - 50.00 = 45.56", prog(act, A).contribution === "18.33" && prog(act, B).contribution === "45.56");
  ck("PG25. Margin per programme: FSV-A 18.33 / 133.33 = 13.75%; FSV-B 45.56 / 95.56 = 47.68%", prog(act, A).margin.percent === "13.75" && prog(act, B).margin.percent === "47.68", `${prog(act, A).margin.percent} ${prog(act, B).margin.percent}`);
  ck("PG26. Unresolved attribution is never guessed: the coach correction (5.00) and the agreement-level credit (-10.00) are Unattributed (-5.00) with the reason", act.unattributed.financeServiceId === null && act.unattributed.resolved === false && act.unattributed.directCosts.total === "-5.00" && act.unattributed.directCosts.coach === "5.00" && act.unattributed.directCosts.otherDirect.creditAdjustment === "10.00" && /never guessed/.test(act.unattributed.reason));
  const src = prog(act, A).detail;
  ck("PG27. Source traceability: each row names its source (invoice + line + client; Coach Month + allocation; agreement + occurrence; credit)", src.revenueSources.every((s: any) => s.source.type === "invoice_line" && s.source.invoiceId && s.source.lineId) && src.coachCosts.every((c: any) => c.source.type === "coach_finalised_item" && c.source.monthId && c.source.allocation) && src.venueCosts.some((c: any) => c.source.type === "supplier_profitability_share" && c.source.agreementId === "FSA-VENUE" && c.source.occurrence === "OCC-V1") && src.venueCosts.some((c: any) => c.source.type === "supplier_credit" && c.source.creditId === "FSC-1" && c.effect === "credit_adjustment"));

  // ----- OH. Overheads (brief 28-34) -----
  ck("OH28. Overheads grouped by category id: Salaries, Software (+ Uncategorised separately)", act.overheads.categories.map((c: any) => c.name).join() === "Software,Salaries" && act.overheads.categories.map((c: any) => c.categoryId).join() === `${SW.categoryId},${SAL.categoryId}`);
  ck("OH29. Supplier general cost by its instalment due month: Software 50.00 confirmed (estimated 40.00 only in expected mode)", cat(act, SW.categoryId).gross === "50.00" && cat(exp, SW.categoryId).gross === "90.00");
  ck("OH30. Employment cost in its own month: Salaries 2000.00 Actual (Confirmed), + 1000.00 estimated only in expected mode", cat(act, SAL.categoryId).net === "2000.00" && cat(exp, SAL.categoryId).net === "3000.00" && cat(exp, SAL.categoryId).state === "Mixed");
  ck("OH31. Credit adjustment on its category in its credit month: Software credit 15.00", cat(act, SW.categoryId).creditAdjustment === "15.00");
  ck("OH32. Gross / adjustment / net shown separately: Software 50.00 / 15.00 / 35.00", cat(act, SW.categoryId).gross === "50.00" && cat(act, SW.categoryId).net === "35.00");
  ck("OH33. Uncategorised exposed with reasons (uncategorised agreement 100.00; supplier-wide credit -5.00 = 95.00 net)", act.overheads.uncategorised.net === "95.00" && act.overheads.uncategorised.reasons.length === 2 && comp(act, "overhead_uncategorised")?.count === 2);
  ck("OH34. Salary never allocated to a programme: no employment row in any programme, only in Salaries", !J(act.programmes).includes("employment") && cat(act, SAL.categoryId).items.every((i: any) => i.source.type === "employment_month" && /never allocated to programmes/.test(i.source.note)));

  // ----- RC. Revenue corrections (brief 35-37, D12) -----
  ck("RC35. A credit note is a revenue correction in the ORIGINAL month (October line, credited in November): it contributes 0 to revenue and never appears as an overhead", act.revenueCorrections.length === 1 && act.revenueCorrections[0].occurrenceDate === "2026-10-07" && act.revenueCorrections[0].creditDate === "2026-11-02" && act.revenueCorrections[0].gross === "50.00" && !J(act.overheads).includes("FCN-1") && comp(act, "revenue_corrections")?.count === 1);
  ck("RC36. The credited line is not revived from a lower layer (its draft line / F4 value are ignored) - revenue is reduced where the credit note is authoritative", !occs.includes("OCC-FVL-5"));
  const nov = buildMonthReport({ ...inp, month: "2026-11" }, "actual", meta) as any;
  ck("RC37. No fake cash dependency: the November report (the credit-note month) has no revenue effect from it; no cash / receipt date is an engine input", nov.revenueCorrections.length === 0 && nov.overall.grossRevenue === "0.00" && !/\b(receivedDate|paidDate|cashDate)\b/.test(readFileSync(join(CANON, "finance", "finance-month-report.ts"), "utf8").split("// Upcoming Payments")[0]));

  // ----- PM. Previous month (brief 38-42) -----
  const c = act.comparison;
  ck("PM38. Revenue comparison (Actual vs September Actual 50.00): +178.89, +357.78%", c.previousMonth === "2026-09" && c.netRevenue.previous === "50.00" && c.netRevenue.change === "178.89" && c.netRevenue.changePercent === "357.78", J(c.netRevenue));
  ck("PM39. Profit comparison: September 50.00 - 40.00 coach - 2000.00 salary = -1990.00; change -71.11 (-3.57% of |previous|)", c.finalBusinessProfit.previous === "-1990.00" && c.finalBusinessProfit.change === "-71.11" && c.finalBusinessProfit.changePercent === "-3.57", J(c.finalBusinessProfit));
  ck("PM40. Margin comparison in percentage points: -900.48 vs -3980.00 -> +3079.52 pp", c.finalMargin.current === "-900.48" && c.finalMargin.previous === "-3980.00" && c.finalMargin.changePercentagePoints === "3079.52", J(c.finalMargin));
  const firstMonth = buildMonthReport({ ...inp, month: "2026-08" }, "actual", meta) as any;
  const octZeroPrev = buildMonthReport({ ...inp, invoiceLines: inp.invoiceLines.filter((l) => l.lineId !== "FVL-1"), invoices: inp.invoices.map((i) => (i.invoiceId === "INV-1" ? { ...i, grossMinor: 12000, cashReceivedMinor: 12000 } : i)) }, "actual", meta) as any;
  ck("PM41. Zero previous denominator: change % null with previous_month_zero; margin change null with previous_no_net_revenue", octZeroPrev.comparison.netRevenue.changePercent === null && octZeroPrev.comparison.netRevenue.changePercentReason === "previous_month_zero" && octZeroPrev.comparison.finalMargin.changePercentagePoints === null && octZeroPrev.comparison.finalMargin.reason === "previous_no_net_revenue" && firstMonth.comparison.finalMargin.reason === "current_no_net_revenue");
  ck("PM42. No generated narrative (narrative: null)", c.narrative === null && exp.comparison.narrative === null);
  ck("PM-M. Comparison is in the report's mode: expected mode compares Expected + Actual September (50.00 + 10.00 expected F4)", exp.comparison.mode === "expected" && exp.comparison.netRevenue.previous === "60.00");

  // ----- RE. Reconciliation (brief 43-47) -----
  const eqs = act.reconciliation.equations;
  ck("RE43. Programme revenue (net, gross, VAT) + unattributed = overall", eqs.slice(0, 4).every((x: any) => x.holds) && pence(prog(act, A).revenue.net)! + pence(prog(act, B).revenue.net)! === pence(o.netRevenue));
  ck("RE44. Programme direct costs + unattributed = overall Direct Costs (115.00 + 50.00 - 5.00 = 160.00)", eqs[4].holds && eqs[4].left === "160.00");
  ck("RE45. Overhead categories + uncategorised = overall Overheads (35.00 + 2000.00 + 95.00 = 2130.00)", eqs[5].holds && eqs[5].left === "2130.00");
  ck("RE46. Profit formula exact: Net Revenue - Direct Costs - Overheads = Final Business Profit (both modes)", eqs[7].holds && exp.reconciliation.equations.every((x: any) => x.holds) && pence(e.netRevenue)! - pence(e.directCosts)! - pence(e.overheads)! === pence(e.finalBusinessProfit));
  ck("RE47. No hidden balancing line: every total is summed from facts, groups summed separately; no 'balancing' / 'other' / 'rounding' row exists", act.reconciliation.allHold && /no balancing line/.test(act.reconciliation.rule) && !/balancing|rounding adjustment/i.test(J({ p: act.programmes, u: act.unattributed, oh: act.overheads })));

  // ----- D1. Receipt allocation (locked) -----
  const l3a = prog(exp, B).detail.revenueSources.filter((s: any) => s.occurrenceId === "OCC-FVL-3");
  const l3 = Object.fromEntries(l3a.map((s: any) => [s.state, s]));
  ck("D1-1. Partial receipt spread over the invoice's current lines by gross: 100.00 of 300.00 -> L3 66.67 / L4 33.33 (largest remainder)", l3.actual.gross === "66.67" && prog(act, A).detail.revenueSources.find((s: any) => s.occurrenceId === "OCC-FVL-4").gross === "33.33");
  ck("D1-2. The same proportion applies to VAT / net, and Actual + Expected = the line exactly (66.67 + 133.33 = 200.00; VAT 11.11 + 22.22 = 33.33; net 55.56 + 111.11 = 166.67)", l3.actual.vat === "11.11" && l3.actual.net === "55.56" && l3.expected.gross === "133.33" && l3.expected.vat === "22.22" && l3.expected.net === "111.11");
  const tie = allocateProportionally(1, [{ id: "FVL-B", weight: 100 }, { id: "FVL-A", weight: 100 }]);
  const tie3 = allocateProportionally(2, [{ id: "FVL-C", weight: 1 }, { id: "FVL-A", weight: 1 }, { id: "FVL-B", weight: 1 }]);
  ck("D1-3. Penny-exact, deterministic: equal remainders go to the lower line id; parts always sum to the total", tie.get("FVL-A") === 1 && tie.get("FVL-B") === 0 && tie3.get("FVL-A") === 1 && tie3.get("FVL-B") === 1 && tie3.get("FVL-C") === 0);
  const half = proportionOfLine({ netMinor: 1667, vatMinor: 333, grossMinor: 2000 }, 1000);
  ck("D1-4. Line proportion: VAT rounded half away from zero, net = remainder (gross 10.00 of 20.00 -> VAT 1.67, net 8.33)", half.vatMinor === 167 && half.netMinor === 833);
  const creditOnly = buildMonthReport({ ...inp, invoices: inp.invoices.map((i) => (i.invoiceId === "INV-2" ? { ...i, cashReceivedMinor: 0, creditAppliedMinor: 30000 } : i)) }, "actual", meta) as any;
  ck("D1-5. Applied client credit counts as a trusted receipt (F7 creates it only from cash already paid / a paid credit note's excess): INV-2 fully settled by credit -> fully Actual", creditOnly.overall.grossRevenue === "460.00");
  const over = buildMonthReport({ ...inp, invoices: inp.invoices.map((i) => (i.invoiceId === "INV-3" ? { ...i, cashReceivedMinor: 9000 } : i)) }, "actual", meta) as any;
  ck("D1-6. A receipt above the post-credit value is capped at it (overpayment is client credit, not revenue)", over.overall.grossRevenue === "260.00");
  ck("D1-7. A receipt changes the line's STATE, never its month: INV-1 (paid) still puts L1 in September and L2 in October", act.comparison.netRevenue.previous === "50.00" && prog(act, A).detail.revenueSources.some((s: any) => s.occurrenceId === "OCC-FVL-2" && s.date === "2026-10-01" && s.state === "actual"));
  ck("D1-8. Manual Billing delivered value is Expected only, never promoted, and the limitation is exposed", prog(exp, A).detail.revenueSources.find((s: any) => s.occurrenceId === "OCC-B9")?.state === "expected" && prog(exp, A).detail.revenueSources.find((s: any) => s.occurrenceId === "OCC-B9")?.source.manualBilling === true && !keys(act).includes("OCC-B9") && comp(exp, "manual_billing_expected_only")?.amount === "35.00" && comp(act, "manual_billing_expected_only")?.severity === "info");
  let bad1 = "";
  try {
    buildMonthReport({ ...inp, invoices: inp.invoices.map((i) => (i.invoiceId === "INV-2" ? { ...i, grossMinor: 29999 } : i)) }, "actual", meta);
  } catch (x) {
    bad1 = x instanceof MonthReportDataError ? x.message : "";
  }
  let bad2 = "";
  try {
    buildMonthReport({ ...inp, invoiceLines: [...inp.invoiceLines, ln("INV-4", "FVL-8", "2026-10-01", A, 1, 0, { occurrenceId: "OCC-FVL-2" })] }, "actual", meta);
  } catch (x) {
    bad2 = x instanceof MonthReportDataError ? x.message : "";
  }
  ck("D1-9. Inconsistent stored data fails loudly (lines != invoice less credit notes; one occurrence on two live invoice lines) - never forced to balance", /do not equal/.test(bad1) && /two live invoice lines/.test(bad2));
  // ----- D2. Stripe -----
  const stripe = (s: MonthReportInputs["parentRevenue"]) => buildMonthReport({ ...inp, parentRevenue: s }, "actual", meta) as any;
  const sEx = stripe({ status: "excluded", grossMinor: 12345, receipts: 3, detail: null });
  const sNone = stripe({ status: "excluded", grossMinor: 0, receipts: 0, detail: null });
  const sDown = stripe({ status: "unavailable", grossMinor: null, receipts: null, detail: "stripe_read_failed" });
  ck("D2-1. Parent / Stripe revenue is never in the totals: 'Parent / Stripe revenue: Not included in report totals' with the informational excluded gross (123.45, 3 receipts)", sEx.overall.grossRevenue === "260.00" && sEx.excluded.parentStripeRevenue.label === "Parent / Stripe revenue: Not included in report totals" && sEx.excluded.parentStripeRevenue.includedInTotals === false && sEx.excluded.parentStripeRevenue.grossReceived === "123.45" && sEx.excluded.parentStripeRevenue.receipts === 3);
  ck("D2-2. The report is NOT complete while excluded Stripe revenue exists (or cannot be read); zero excluded / not connected leaves it complete", sEx.completeness.complete === false && comp(sEx, "parent_stripe_revenue_excluded")?.severity === "incomplete" && sDown.completeness.complete === false && sNone.completeness.complete === true && act.completeness.complete === true && comp(act, "parent_stripe_revenue_not_included")?.severity === "info");
  // ----- D3 / D4 -----
  ck("D3. Coach: finalised Coach Month + corrections = Actual; open month live cost = Expected; Salaried = 0.00 (shown, never priced); payment state irrelevant", prog(act, A).detail.coachCosts.some((x: any) => x.source.costBasis === "salaried" && x.amount === "0.00") && prog(exp, A).detail.coachCosts.some((x: any) => x.state === "expected" && x.amount === "20.00" && x.source.type === "coach_live_allocation") && !prog(act, A).detail.coachCosts.some((x: any) => x.state === "expected"));
  ck("D4. Venue / direct supplier share: Actual only when confirmed AND its date has passed; estimated or future = Expected; frozen amounts never redistributed", prog(exp, A).detail.venueCosts.find((x: any) => x.source.occurrence === "OCC-V2").state === "expected" && prog(exp, B).detail.venueCosts.find((x: any) => x.source.occurrence === "OCC-V3").state === "expected" && /estimated/.test(prog(exp, B).detail.venueCosts.find((x: any) => x.source.occurrence === "OCC-V3").source.why));
  const partial = buildMonthReport({ ...inp, supplierCredits: [{ creditId: "FSC-9", supplierId: "FSU-HALL", supplierName: "ZZTEST Hall", supplierType: "venue", agreementId: "FSA-VENUE", agreementName: "ZZTEST hall hire", classification: "direct", category: null, creditDate: "2026-10-09", scope: "sessions", amountMinor: 1000, rows: [{ serviceId: A, programmeLabel: "Academy", amountMinor: 600, sessionId: "S3", sessionDate: "2026-10-05" }] }] }, "actual", meta) as any;
  ck("D5b. A direct credit only partly attributed to sessions: the attributed 6.00 reduces FSV-A venue cost, the remaining 4.00 is an Unattributed venue credit (never dropped, never guessed); the total still reconciles", prog(partial, A).directCosts.venue.creditAdjustment === "6.00" && partial.unattributed.directCosts.venue.creditAdjustment === "4.00" && partial.reconciliation.allHold && /not fully attributed/.test(J(partial.unattributed.detail.venueCosts)));
  ck("D6. VAT on costs: recorded amount, no input-VAT recovery (stated)", comp(act, "cost_vat_basis")?.severity === "info" && cat(act, SW.categoryId).items.some((i: any) => /no input-VAT recovery/.test(i.source.vatNote)));
  ck("D10. F4: cancelled / not billable / parent-paid excluded with reasons; missing terms / no value surfaced as unresolved (never guessed); unresolved is incomplete only in expected mode", comp(exp, "revenue_excluded_by_rule")?.count === 3 && comp(exp, "revenue_unresolved")?.count === 2 && comp(exp, "revenue_unresolved")?.severity === "incomplete" && comp(act, "revenue_unresolved")?.severity === "info");
  ck("D11. No Management Notes storage; export-ready metadata only (title, month, state label, organisation, sections; PDF later work)", act.exportMetadata.managementNotes.supported === false && act.exportMetadata.pdf.generated === false && act.exportMetadata.stateLabel === "Actual" && act.exportMetadata.title === "Month Report - 2026-10");
  ck("SO2. Unsupported sources excluded / surfaced: sessions without a Finance Service ID counted (no revenue invented for them)", comp(act, "sessions_without_finance_service")?.count === 1);
  ck("SO3. Cash dates never attribute: basis states it, and the engine's reporting part reads no cash / paid / received date", /never used for reporting attribution/i.test(act.basis.cashDates) && !/\b(receivedDate|paidDate|cashDate|expectedPaymentDate)\b/.test(readFileSync(join(CANON, "finance", "finance-month-report.ts"), "utf8").split("// Upcoming Payments")[0]));

  // ----- Upcoming Payments (pure, D8) -----
  const up = upcomingPayments({
    today: "2026-10-15",
    instalments: [
      { instalmentId: "FSI-O", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-09-30", state: "confirmed", remainingMinor: 5000, cancelled: false },
      { instalmentId: "FSI-P", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-10-20", state: "partially_paid", remainingMinor: 2500, cancelled: false },
      { instalmentId: "FSI-E", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-10-20", state: "estimated", remainingMinor: 9999, cancelled: false },
      { instalmentId: "FSI-L", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-10-29", state: "confirmed", remainingMinor: 9999, cancelled: false },
      { instalmentId: "FSI-L2", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-10-28", state: "confirmed", remainingMinor: 100, cancelled: false },
      { instalmentId: "FSI-X", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-10-16", state: "confirmed", remainingMinor: 9999, cancelled: true },
      { instalmentId: "FSI-Z", agreementId: "a", supplierId: "s", supplierName: "Hall", dueDate: "2026-10-16", state: "paid", remainingMinor: 0, cancelled: false },
    ],
    employment: [
      { employmentId: "FEM-1", month: "2026-10", person: "P1", expectedPaymentDate: "2026-10-25", state: "confirmed", amountDueMinor: 200000, paidMinor: 0 },
      { employmentId: "FEM-2", month: "2026-10", person: "P2", expectedPaymentDate: "2026-10-12", state: "confirmed", amountDueMinor: 100000, paidMinor: 100000 },
    ],
    coachMonths: [
      { monthId: "FCM-1", coach: "C1", workMonth: "2026-09", expectedPaymentDate: "2026-10-20", amountMinor: 17500 },
      { monthId: "FCM-0", coach: "C1", workMonth: "2026-08", expectedPaymentDate: "2026-09-20", amountMinor: 21000 },
    ],
  });
  ck("OV55-P. Upcoming Payments window: overdue confirmed outgoing + confirmed due today..today+13 (10-15..10-28); remaining payable only; estimated / cancelled / paid / later excluded; past Coach Months never overdue", up.window.to === "2026-10-28" && up.overdue.count === 1 && up.overdue.total === "50.00" && up.upcoming.count === 4 && up.upcoming.total === "2201.00" && up.items.map((i: any) => i.sourceId).join() === "FSI-O,FCM-1,FSI-P,FEM-1/2026-10,FSI-L2", J(up.items.map((i: any) => `${i.dueDate}:${i.sourceId}`)));
  ck("OV55-P2. Each upcoming item exposes its source type, id and route (no new ledger)", up.items.every((i: any) => i.route.startsWith("GET /finance/") && i.sourceType && i.sourceId && i.amount));
}

// =====================================================================
// Part 2 - REAL orchestrator on the in-memory world
// =====================================================================
const T0 = "2026-09-01T09:00:00.000Z";
const hex = (n: number) => n.toString(16).toUpperCase().padStart(12, "0");
let rowN = 0;
const rowOf = (fields: Record<string, unknown>) => ({ id: `recF18${String(++rowN).padStart(11, "0")}`, fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)) });
function settingsRow(extra: Record<string, unknown> = {}) {
  const s = { ...EMPTY_SETTINGS, coachPaymentDayOfFollowingMonth: 20, ...extra };
  world.at["Finance Settings"] = [{ id: "recFinSettings001", fields: Object.fromEntries(Object.entries({ "Finance Settings ID": `FINSET-${ORG}`, Organisation: [ORG_REC], ...toStoredFields(s as any, SETTINGS_KEYS), Revision: 1 }).filter(([, v]) => v !== null && v !== undefined)) }];
}
function f3() {
  const client = { clientId: CLIENT, name: "ZZTEST F18 School", status: "active", billingContactName: null, billingEmail: "billing@school.test", billingCcEmails: [], paymentTermsDaysOverride: null, poRequired: false, billingMethod: "hub", revision: 1, updatedAt: T0 } as any;
  const cRow = rowOf(clientFields(client, { userId: MGR, at: T0 }, ORG_REC));
  const svc = { serviceId: "FSV-AAAAAAAAAAAA", clientId: CLIENT, name: "ZZTEST F18 Academy", status: "active", revision: 1, updatedAt: T0 } as any;
  const sRow = rowOf(serviceFields(svc, { userId: MGR, at: T0 }, { orgRecordId: ORG_REC, clientRecordId: cRow.id }));
  const terms = { termsId: "FCT-AAAAAAAAAAAA", serviceId: svc.serviceId, effectiveFrom: "2026-01-01", effectiveUntil: null, payer: "client", chargeType: "fixed_per_session", amountMinor: 2500, vatTreatment: "no_vat", vatRateBasisPoints: 0, defaultBillableQuantity: null, subscriptionFrequency: null, otherDescription: null } as any;
  const tRow = rowOf(termsCreateFields(terms, { orgRecordId: ORG_REC, serviceRecordId: sRow.id, userId: MGR, at: T0 }));
  const lRow = rowOf(lifecycleCreateFields({ lifecycleId: "FSL-AAAAAAAAAAAA", serviceId: svc.serviceId, status: "active", effectiveFrom: null, effectiveUntil: null, supersededBy: null, reason: null }, { orgRecordId: ORG_REC, serviceRecordId: sRow.id, userId: MGR, at: T0 }));
  world.at[F3_TABLES.clients] = [cRow];
  world.at[F3_TABLES.services] = [sRow];
  world.at[F3_TABLES.terms] = [tRow];
  world.at[F3_TABLES.lifecycle] = [lRow];
}
const vline = (n: number, invoiceId: string, draftId: string, seq: number, occurrenceId: string, date: string, gross: number): InvoiceLine =>
  ({
    lineId: `FVL-${hex(n)}`, invoiceId, sequence: seq, sourceDraftId: draftId, sourceDraftLineId: `FIL-${hex(n)}`, occurrenceId, occurrenceDate: date, sessionId: "ZZ-VENUE-A", sessionName: "ZZTEST Venue A Academy",
    serviceId: "FSV-AAAAAAAAAAAA", serviceName: "ZZTEST F18 Academy", termsId: "FCT-AAAAAAAAAAAA", chargeType: "fixed_per_session", description: `ZZTEST session ${date}`, quantity: 1, quantitySource: "per_session", unitAmountMinor: gross,
    unitAmountSource: "commercial_terms", amountMinor: gross, vatTreatment: "no_vat", vatRateBasisPoints: 0, netMinor: gross, vatMinor: 0, grossMinor: gross, overrideIds: [], snapshot: "{}", createdBy: MGR, createdAt: T0,
  }) as InvoiceLine;
const draftLine = (n: number, occurrenceId: string, date: string, gross: number): Line =>
  ({
    lineId: `FIL-${hex(n)}`, draftId: `FID-${hex(n)}`, status: "included", occurrenceId, occurrenceDate: date, sessionId: "ZZ-VENUE-A", sessionName: "ZZTEST Venue A Academy", serviceId: "FSV-AAAAAAAAAAAA", serviceName: "ZZTEST F18 Academy", termsId: "FCT-AAAAAAAAAAAA",
    chargeType: "fixed_per_session", description: `ZZTEST session ${date}`, quantity: 1, quantitySource: "per_session", unitAmountMinor: gross, unitAmountSource: "commercial_terms", amountMinor: gross, vatTreatment: "no_vat", vatRateBasisPoints: 0,
    netMinor: gross, vatMinor: 0, grossMinor: gross, overrideIds: [], snapshot: "{}", statusReason: null, statusChangedBy: null, statusChangedAt: null, supersededBy: null, createdBy: MGR, createdAt: T0,
  }) as Line;
const occId = (key: string, date: string) => `OCC-${key}:${date}`;
const report = (q: Record<string, string> = {}, caller: any = mgr, d: any = deps): Promise<any> => {
  const p = parseMonthReportQuery("month.report", new URLSearchParams(q), isTenantKey);
  return p.ok ? readMonthReport(d, caller, { month: p.month, mode: p.mode }) : Promise.resolve({ status: "error", ...p });
};
const overview = (q: Record<string, string> = {}, na?: NeedsAttentionSummary, caller: any = mgr, d: any = deps): Promise<any> => {
  const p = parseMonthReportQuery("finance.overview", new URLSearchParams(q), isTenantKey);
  return p.ok ? readFinanceOverview(d, caller, { month: p.month }, na) : Promise.resolve({ status: "error", ...p });
};
const NA_OK: NeedsAttentionSummary = async () => ({ status: "ok", state: "Urgent", total: 4, counts: { Normal: 1, Warning: 2, Urgent: 1 }, suppressed: 1, complete: true });

async function live() {
  reset();
  settingsRow();
  f3();
  // ----- F12: a finalised September Coach Month (frozen 40.00 + 5.00 correction) and October open work -----
  const occSep = coachOcc("OccCSep1", "2026-09-16", "Completed", ["recAllocSep100000"]);
  const occOct1 = coachOcc("OccCOct1", "2026-10-05", "Completed", ["recAllocOct100000"]);
  const occOct2 = coachOcc("OccCOct2", "2026-10-22", "Scheduled", ["recAllocOct200000"]);
  const occSepA = occ("OccAS", "2026-09-24", SA, "Completed");
  world.at["Session Occurrences"].push(occSep, occOct1, occOct2, occSepA);
  world.at["Coach Allocations"] = [allocation("AllocSep1", occSep.id, 40), allocation("AllocOct1", occOct1.id, 45), allocation("AllocOct2", occOct2.id, 30)];
  const FM_SEP = financeMonthRow(1, { workMonth: "2026-09", totalMinor: 4000, payDate: "2026-10-20", items: 1 });
  T_("finance_worker_cost_months").push(FM_SEP);
  T_("finance_worker_cost_items").push({ organisation_id: ORG, month_id: FM_SEP.month_id, allocation_record_id: "recAllocSep100000", allocation_label: "ALLOC-AllocSep1", occurrence_record_id: occSep.id, occurrence_ref: occSep.fields["Occurrence ID"], work_date: "2026-09-16", session_record_id: SESS_COACH, session_name: "ZZTEST F17 Coached Session", finance_service_id: "FSV-AAAAAAAAAAAA", programme_label: "Academy", cost_basis: "paid", rate_type: "Per Session", pay_unit: "Session", paid_units: 1, rate_amount_minor: 4500, override_minor: null, override_reason: null, work_outcome: "Completed", final_cost_minor: 4000, work_summary_ref: null });
  T_("finance_worker_cost_corrections").push(correctionRow(1, FM_SEP.month_id, 500, 4500));
  // ----- F13 / F14 / F15 through their real routes -----
  const VEN = (await supplierNew({ name: "ZZTEST F18 Hall", type: "venue" })).body.supplier.supplierId as string;
  const SOFT = (await supplierNew({ name: "ZZTEST F18 Software", type: "software_service" })).body.supplier.supplierId as string;
  const ven = await agreementNew(VENUE_BODY(VEN));
  const VAG = ven.body.agreement.agreementId as string;
  const V_OCT = (ven.body.schedule as any[]).find((i) => i.dueDate === "2026-10-20").instalmentId as string;
  const lic = await agreementNew({ supplierId: SOFT, name: "ZZTEST F18 licence", costType: "custom_dates", classification: "general", effectiveFrom: "2026-09-01", instalments: [{ dueDate: "2026-09-05", amount: "50.00" }, { dueDate: "2026-10-03", amount: "50.00" }, { dueDate: "2026-10-25", amount: "40.00", estimated: true }, { dueDate: "2026-11-05", amount: "70.00" }] });
  const LAG = lic.body.agreement.agreementId as string;
  const SWC = (await catNew({ name: "Software" })).body.category.categoryId as string;
  const SALC = (await catNew({ name: "Salaries" })).body.category.categoryId as string;
  const catd = await categorise({ agreementId: LAG, categoryId: SWC, reason: "ZZTEST licence is software" });
  const lInst = (d: string) => (lic.body.schedule as any[]).find((i) => i.dueDate === d).instalmentId as string;
  const pSep = await pay(lInst("2026-09-05"), "50.00", "2026-09-06");
  const vCredit = await creditNew({ supplierId: VEN, scope: "agreement", agreementId: VAG, amount: "30.00", creditDate: "2026-10-09", sourceType: "credit_note", sourceReference: "ZZ-F18-CN", reason: "ZZTEST hall unavailable" });
  const gCredit = await creditNew({ supplierId: SOFT, scope: "agreement", agreementId: LAG, amount: "15.00", creditDate: "2026-10-11", sourceType: "credit_note", sourceReference: "ZZ-F18-SW", reason: "ZZTEST outage credit" });
  const E1 = (await empNew({ name: "ZZTEST F18 Office Manager", categoryId: SALC, annualSalary: "24000.00", payDay: 25, startDate: "2026-09-01" })).body.employment.employmentId as string;
  const E2 = (await empNew({ name: "ZZTEST F18 Groundsman", categoryId: SALC, annualSalary: "12000.00", payDay: 28, startDate: "2026-10-01" })).body.employment.employmentId as string;
  await monthAct(E1, "2026-09", "confirm-estimate", { useEstimate: true });
  await monthAct(E1, "2026-09", "payment", { amount: "2000.00", paidDate: "2026-09-25" });
  const e1Oct = await monthAct(E1, "2026-10", "confirm-estimate", { useEstimate: true });
  // ----- F5 / F6 / F7 -----
  // INV-R1 (issued) 50.00: the September session (OccAS) + 1 Oct (OccA0) 25.00 each; 25.00 received on 10-14 -> 12.50 Actual on each line, in each line's OWN month.
  const INV1 = { ...invoice(1, { gross: 5000 }), lineCount: 2, sourceDraftId: `FID-${hex(901)}` } as Invoice;
  // INV-R2 (issued) 25.00 for 8 Oct (OccA1), fully credited by a credit note on 10-12 -> a revenue correction in October.
  const INV2 = { ...invoice(2, { gross: 2500 }), sourceDraftId: `FID-${hex(902)}` } as Invoice;
  const L1 = vline(11, INV1.invoiceId, INV1.sourceDraftId, 1, occId("OccAS", "2026-09-24"), "2026-09-24", 2500);
  const L2 = vline(12, INV1.invoiceId, INV1.sourceDraftId, 2, occId("OccA0", "2026-10-01"), "2026-10-01", 2500);
  const L3 = vline(21, INV2.invoiceId, INV2.sourceDraftId, 1, occId("OccA1", "2026-10-08"), "2026-10-08", 2500);
  const CN2 = { ...creditNote(2, INV2, 2500, "2026-10-12"), lines: [{ invoiceLineId: L3.lineId, occurrenceId: L3.occurrenceId, netMinor: 2500, vatMinor: 0, grossMinor: 2500 }] } as CreditNote;
  const PAY1 = payment(1, INV1, 2500, "2026-10-14");
  const F7 = { invoices: [INV1, INV2], notes: [CN2], payments: [PAY1] };
  setF7(F7);
  world.at[ISSUE_TABLES.lines] = [L1, L2, L3].map((l) => rowOf(invoiceLineCreateFields(l, ORG_REC)));
  // F5: 15 Oct (OccA2) is on an Included draft line (25.00 Expected).
  world.at[INVOICING_TABLES.lines] = [rowOf(lineCreateFields(draftLine(31, occId("OccA2", "2026-10-15"), "2026-10-15", 2500), ORG_REC))];
  ck(
    "FX. Fixtures: F3 client/service/terms/lifecycle rows (F3 builders), 2 invoices + 3 lines + 1 credit note + 1 payment (F6/F7 builders), 1 draft line (F5 builder), venue + licence agreements, 2 F14 credits, 2 categories + 1 categorised agreement, 2 employments, 1 finalised Coach Month + correction",
    [ven, lic, vCredit, gCredit, catd].every((x) => x.httpStatus === 201) && pSep.httpStatus === 201 && e1Oct.httpStatus === 200 && !!E2,
    J([ven, lic, vCredit, gCredit, catd, pSep, e1Oct].map((x) => `${x.httpStatus}:${x.code ?? ""}`)),
  );

  // ----- A / B / C: Month Report -----
  const a0 = world.audit.length;
  const r0 = world.airtableReads.length;
  const f0 = cfFetchLog.filter((u) => /\/rest\/v1\//.test(u)).length;
  const oct = await report({ month: "2026-10" });
  const rb = oct.body;
  ck("RD. GET /month-report?month=2026-10 (default mode Actual): 200, contract finance-month-report-v1, month / previous month / today, GBP", oct.httpStatus === 200 && rb.contract === "finance-month-report-v1" && rb.mode === "actual" && rb.month === "2026-10" && rb.previousMonth === "2026-09" && rb.today === "2026-10-15" && rb.currency === "GBP" && !("_figures" in rb), J(oct).slice(0, 600));
  const readsOne = world.airtableReads.slice(r0);
  const restOne = cfFetchLog.filter((u) => /\/rest\/v1\//.test(u)).length - f0;
  const o = rb.overall;
  // Actual October: revenue = INV-R1's received 25.00 spread 12.50 / 12.50 -> the 1 Oct line's 12.50; INV-R2 credited (correction);
  // direct = venue shares 1, 8, 15 Oct (100.00 each; confirmed, date passed) - 30.00 F14 credit = 270.00 (October Coach Month still open -> 0.00 Actual);
  // overheads = licence 50.00 (confirmed, due 10-03) - 15.00 credit + salary 2000.00 (confirmed) = 2035.00.
  ck("A. Current-month Actual report: Gross 12.50, VAT 0.00, Net 12.50, Direct 270.00, Contribution -257.50, Overheads 2035.00, Profit -2292.50, Margin -18340.00%", o.grossRevenue === "12.50" && o.vat === "0.00" && o.netRevenue === "12.50" && o.directCosts === "270.00" && o.programmeContribution === "-257.50" && o.overheads === "2035.00" && o.finalBusinessProfit === "-2292.50" && o.finalMargin.percent === "-18340.00", J(o));
  const sepR = await report({ month: "2026-09" });
  const sp = sepR.body;
  // September: the September line's 12.50 (received on 10-14 - the cash date does not move it); coach 40.00 finalised + 5.00 correction; licence 50.00 (paid) + salary 2000.00 (paid)
  ck("B. Previous-month Actual report (2026-09): Net 12.50 (its half of the 10-14 receipt stays in September), Direct 45.00 (finalised 40.00 + 5.00 correction), Overheads 2050.00, Profit -2082.50", sepR.httpStatus === 200 && sp.overall.netRevenue === "12.50" && sp.overall.directCosts === "45.00" && sp.overall.overheads === "2050.00" && sp.overall.finalBusinessProfit === "-2082.50", J(sp.overall));
  const expR = await report({ month: "2026-10", mode: "expected" });
  const eb = expR.body;
  // Expected + Actual: + 12.50 unpaid half of 1 Oct + 25.00 draft (15 Oct) + F4 25.00 x 4 (22 / 29 Oct venue sessions, 5 / 22 Oct coached sessions) = 150.00;
  // direct + open October coach live cost 45.00 + 30.00 + future venue shares 22 / 29 Oct 200.00 = 545.00; overheads + estimated licence 40.00 + estimated salary 1000.00 = 3075.00
  ck("C. Expected + Actual report: Net 150.00, Direct 545.00, Overheads 3075.00, Profit -3470.00; mode label 'Expected + Actual'; state Mixed", expR.httpStatus === 200 && eb.mode === "expected" && eb.modeLabel === "Expected + Actual" && eb.state === "Mixed" && eb.overall.netRevenue === "150.00" && eb.overall.directCosts === "545.00" && eb.overall.overheads === "3075.00" && eb.overall.finalBusinessProfit === "-3470.00", J(eb.overall));
  const pa = prog(rb, "FSV-AAAAAAAAAAAA");
  ck("L/M/N/O. Programme FSV-AAAAAAAAAAAA (F3 label 'ZZTEST F18 Academy'): revenue 12.50, Coach Cost 0.00 Actual (open month), venue 300.00 gross - 30.00 F14 credit = 270.00", rb.programmes.length === 1 && pa.label === "ZZTEST F18 Academy" && pa.revenue.net === "12.50" && pa.directCosts.coach === "0.00" && pa.directCosts.venue.gross === "300.00" && pa.directCosts.venue.creditAdjustment === "30.00" && pa.directCosts.venue.net === "270.00", J(pa.directCosts));
  const pe = prog(eb, "FSV-AAAAAAAAAAAA");
  ck("M2. Coach Cost Expected = the open month's live allocation cost (45.00 + 30.00) - never Actual until the Coach Month is finalised", pe.directCosts.coach === "75.00" && pe.detail.coachCosts.every((c: any) => c.state === "expected" && c.source.type === "coach_live_allocation"));
  ck("Q. Programme contribution / margin: -257.50 / null-safe margin (-2060.00%)", pa.contribution === "-257.50" && pa.margin.percent === "-2060.00", `${pa.contribution} ${pa.margin.percent}`);
  ck("R. Unresolved attribution: the F12 correction (5.00) stays Unattributed in September - never guessed onto a programme", sp.unattributed.directCosts.coach === "5.00" && sp.unattributed.directCosts.total === "5.00" && prog(sp, "FSV-AAAAAAAAAAAA").directCosts.coach === "40.00");
  const swc = rb.overheads.categories.find((c: any) => c.name === "Software");
  const salc = rb.overheads.categories.find((c: any) => c.name === "Salaries");
  ck("S/T/V. Overhead category Software (F15 category of the F13 general agreement): 50.00 gross, 15.00 F14 credit, 35.00 net; the estimated 40.00 is Expected only", swc.categoryId === SWC && swc.gross === "50.00" && swc.creditAdjustment === "15.00" && swc.net === "35.00" && eb.overheads.categories.find((c: any) => c.name === "Software").gross === "90.00");
  ck("U/W. Employment cost: Salaries 2000.00 (Confirmed) in October; the Groundsman's estimate (1000.00) only in Expected; salary is never in a programme", salc.net === "2000.00" && eb.overheads.categories.find((c: any) => c.name === "Salaries").net === "3000.00" && !J(rb.programmes).includes("employment") && !J(eb.programmes).includes("employment"));
  const occsE = eb.programmes.flatMap((p: any) => p.detail.revenueSources.map((s: any) => `${s.occurrenceId}|${s.state}|${s.layer}`));
  ck("X. Actual / Expected supersession: invoice line > draft > F4 - 1 Oct is ONE invoice line (12.50 received + 12.50 not yet); 15 Oct is the draft line only; 8 Oct (credited) is not revived from F4", occsE.filter((x: string) => x.startsWith(`${occId("OccA0", "2026-10-01")}|`)).join() === `${occId("OccA0", "2026-10-01")}|actual|invoice,${occId("OccA0", "2026-10-01")}|expected|invoice` && occsE.filter((x: string) => x.startsWith(occId("OccA2", "2026-10-15"))).join() === `${occId("OccA2", "2026-10-15")}|expected|draft` && !occsE.some((x: string) => x.startsWith(occId("OccA1", "2026-10-08"))), J(occsE));
  ck("Y. No double count: every occurrence appears in exactly one layer; Expected + Actual revenue = 150.00 = sum of the distinct items", new Set(eb.programmes.flatMap((p: any) => p.detail.revenueSources.map((s: any) => `${s.occurrenceId}|${s.layer}`))).size === 6 && eb.programmes.flatMap((p: any) => p.detail.revenueSources).reduce((a: number, s: any) => a + pence(s.gross)!, 0) === 15000);
  ck("Z. Revenue correction: INV-R2's 8 Oct line credited on 10-12 -> 25.00 correction in October (the original month), never an overhead", rb.revenueCorrections.length === 1 && rb.revenueCorrections[0].occurrenceDate === "2026-10-08" && rb.revenueCorrections[0].gross === "25.00" && rb.revenueCorrections[0].creditNoteId === CN2.creditNoteId && !J(rb.overheads).includes(CN2.creditNoteId));
  ck("AA. Refund: F11 Refund Due has no reporting effect (no authoritative revenue fact) - revenue is corrected by the credit note only, proven by the unchanged 12.50", !J(rb).includes("refund") && o.netRevenue === "12.50");
  const c = rb.comparison;
  ck("AB. Revenue comparison vs September: 12.50 vs 12.50 -> 0.00 (0.00%)", c.previousMonth === "2026-09" && c.netRevenue.previous === "12.50" && c.netRevenue.change === "0.00" && c.netRevenue.changePercent === "0.00", J(c.netRevenue));
  ck("AC. Profit comparison: -2292.50 vs -2082.50 -> -210.00 (-10.08%)", c.finalBusinessProfit.change === "-210.00" && c.finalBusinessProfit.changePercent === "-10.08", J(c.finalBusinessProfit));
  ck("AD. Margin comparison: -18340.00% vs -16660.00% -> -1680.00 pp; no narrative", c.finalMargin.current === "-18340.00" && c.finalMargin.previous === "-16660.00" && c.finalMargin.changePercentagePoints === "-1680.00" && c.narrative === null, J(c.finalMargin));
  ck("AE. Reconciliation equations exact in all three reports (8 equations each)", [rb, sp, eb].every((r: any) => r.reconciliation.allHold && r.reconciliation.equations.length === 8));
  const types = new Set([...eb.programmes, eb.unattributed, ...[sp.unattributed]].flatMap((p: any) => [...p.detail.revenueSources, ...p.detail.coachCosts, ...p.detail.venueCosts, ...p.detail.otherDirectCosts].map((d: any) => d.source.type)));
  const ohTypes = new Set([...eb.overheads.categories, eb.overheads.uncategorised].flatMap((cc: any) => cc.items.map((i: any) => i.source.type)));
  ck("SO1. Every included figure comes from its owning slice's authoritative record: F6 invoice line / F5 draft line / F4 expected billing; F12 finalised item / correction / live allocation; F13 share; F14 credit; F13 instalment; F15 employment month", [...types].every((t) => ["invoice_line", "draft_line", "expected_billing", "coach_finalised_item", "coach_correction", "coach_live_allocation", "supplier_profitability_share", "supplier_credit"].includes(t)) && [...ohTypes].every((t) => ["supplier_overhead_instalment", "employment_month", "supplier_credit"].includes(t)) && types.size >= 5, J([...types, ...ohTypes]));
  ck("SO2b. Not connected Stripe: 'Parent / Stripe revenue: Not included in report totals', status not_connected (info); sessions without a Finance Service ID surfaced (2 in October)", rb.excluded.parentStripeRevenue.status === "not_connected" && rb.excluded.parentStripeRevenue.includedInTotals === false && comp(rb, "sessions_without_finance_service")?.count === 2 && rb.completeness.complete === true);
  const stripeDown = await report({ month: "2026-10" }, mgr, { ...deps, stripe: { broken: true } });
  ck("D2-3. Stripe cannot be read: the report still returns, Stripe is 'unavailable' and the report is marked incomplete (never silently complete)", stripeDown.httpStatus === 200 && stripeDown.body.excluded.parentStripeRevenue.status === "unavailable" && stripeDown.body.completeness.complete === false && stripeDown.body.overall.netRevenue === "12.50", J(stripeDown.body?.excluded ?? stripeDown));

  const INV3 = { ...invoice(3, { gross: 2500, xero: true }), sourceDraftId: `FID-${hex(903)}` } as Invoice;
  setF7({ ...F7, invoices: [...F7.invoices, INV3] });
  world.at[ISSUE_TABLES.lines].push(rowOf(invoiceLineCreateFields(vline(41, INV3.invoiceId, INV3.sourceDraftId, 1, occId("OccA3", "2026-10-22"), "2026-10-22", 2500), ORG_REC)));
  const xa = (await report({ month: "2026-10" })).body;
  const xe = (await report({ month: "2026-10", mode: "expected" })).body;
  const a3 = xe.programmes.flatMap((p: any) => p.detail.revenueSources).filter((s: any) => s.occurrenceId === occId("OccA3", "2026-10-22"));
  world.at[ISSUE_TABLES.lines].pop();
  setF7(F7);
  ck("X2. An invoice awaiting issue in Xero is never Actual: its 22 Oct line replaces the F4 value as ONE Expected invoice item ('awaiting external issue'); Actual unchanged, Expected unchanged (150.00)", xa.overall.netRevenue === "12.50" && xe.overall.netRevenue === "150.00" && a3.length === 1 && a3[0].layer === "invoice" && a3[0].state === "expected" && a3[0].source.portion === "awaiting external issue", J(a3));
  ck("D3b. A finalised Coach Month whose live work now differs (September: live 40.00 vs finalised 40.00 + 5.00 correction) is flagged - the report keeps the finalised snapshot + correction", comp(sp, "coach_month_correction_required")?.count === 1 && sp.overall.directCosts === "45.00");

  // ----- Finance Overview (brief 48-57) -----
  const bal = await balanceNew({ amount: "3000.00", asAtDate: "2026-10-14" });
  settingsRow({ cashSafetyThresholdMinor: 250000 });
  const aOv = world.audit.length;
  const ov = await overview({}, NA_OK);
  const ob = ov.body;
  ck("OV48. Finance Overview: 200, contract finance-overview-v1, basis 'Actual only'", ov.httpStatus === 200 && ob.contract === "finance-overview-v1" && /^Actual only/.test(ob.basis) && ob.month === "2026-10" && bal.httpStatus === 201, J(ov).slice(0, 400));
  ck("OV49. Expected facts excluded: the metrics equal the ACTUAL report exactly (not the Expected + Actual 150.00 / 545.00 / 3075.00)", ob.metrics.netRevenue === o.netRevenue && ob.metrics.directCosts === o.directCosts && ob.metrics.overheads === o.overheads && ob.metrics.profit === o.finalBusinessProfit && ob.metrics.state === "Actual" && ob.metrics.netRevenue !== eb.overall.netRevenue);
  ck("OV50-53. Net Revenue 12.50, Direct Costs 270.00, Overheads 2035.00, Profit -2292.50 (+ margin)", ob.metrics.netRevenue === "12.50" && ob.metrics.directCosts === "270.00" && ob.metrics.overheads === "2035.00" && ob.metrics.profit === "-2292.50" && ob.metrics.margin.percent === "-18340.00");
  ck("OV54. Needs Attention summary from ONE call with the caller's own access: compact counts only (state, total, severity counts, suppressed) + route", ob.needsAttention.status === "ok" && ob.needsAttention.total === 4 && ob.needsAttention.state === "Urgent" && J(ob.needsAttention.counts) === J({ Normal: 1, Warning: 2, Urgent: 1 }) && !("cases" in ob.needsAttention) && ob.needsAttention.route === "GET /needs-attention/cases");
  const up = ob.upcomingPayments;
  ck("OV55. Upcoming Payments: overdue confirmed licence 50.00 (due 10-03); due 10-15..10-28: Coach Month Sep 45.00 (10-20), venue 500.00 (10-20), salary 2000.00 (10-25); estimated licence 40.00 not included", up.overdue.count === 1 && up.overdue.total === "50.00" && up.upcoming.count === 3 && up.upcoming.total === "2545.00" && up.items.map((i: any) => `${i.dueDate}:${i.sourceType}:${i.amount}`).join() === "2026-10-03:supplier_instalment:50.00,2026-10-20:coach_month:45.00,2026-10-20:supplier_instalment:500.00,2026-10-25:employment_month:2000.00" && up.items.some((i: any) => i.sourceId === V_OCT), J(up.items));
  const f17 = (await cashFlow({ range: "3m", view: "position" })).body.summary;
  const cs = ob.cashSummary;
  ck("OV56. Cash summary (setting default ON) is F17's own Cash Position (3m) - balance, projected low + date, threshold, breach identical to GET /cash-flow", cs.shown === true && cs.status === "ok" && cs.currentBalance === "3000.00" && cs.currentBalance === f17.currentBalance && cs.projectedLow === f17.projectedLow && cs.projectedLowDate === f17.projectedLowDate && cs.safetyThreshold === "2500.00" && cs.thresholdBreached === f17.thresholdBreached && cs.firstBreachDate === f17.firstBreachDate && cs.balanceLabel === "Management-entered bank balance", J({ cs, f17 }));
  ck("OV57. Overview does not duplicate the Month Report: no programmes / overhead detail / reconciliation - a route to the report instead", !("programmes" in ob) && !("overheads" in ob) && !("reconciliation" in ob) && ob.routes.monthReport === "GET /finance/month-report?month=2026-10&mode=actual");
  const naDown = await overview({}, async () => {
    throw new Error("network");
  });
  const naBad = await overview({}, async () => ({ status: "unavailable", reason: "needs_attention_http_503" }));
  ck("OV54b. Needs Attention failure: needsAttention.status 'unavailable' with the reason - the financial metrics still load (never fail the figures)", naDown.httpStatus === 200 && naDown.body.needsAttention.status === "unavailable" && naDown.body.metrics.netRevenue === "12.50" && naBad.body.needsAttention.reason === "needs_attention_http_503");
  settingsRow({ cashSafetyThresholdMinor: 250000, overviewCashSummaryVisible: false });
  const hid = await overview({}, NA_OK);
  ck("OV56b. 'Show Cash Summary on Finance Overview' = Hidden: no cash figures at all", hid.body.cashSummary.shown === false && !("currentBalance" in hid.body.cashSummary) && hid.body.metrics.netRevenue === "12.50");
  settingsRow({ cashSafetyThresholdMinor: 250000 });
  const ovMode = parseMonthReportQuery("finance.overview", new URLSearchParams({ mode: "expected" }), isTenantKey);
  ck("OV48b. The Overview cannot be asked for Expected values (mode is refused: 400 unexpected_query, 'Finance Overview is Actual only')", !ovMode.ok && ovMode.code === "unexpected_query" && /Actual only/.test(ovMode.error));
  ck("AR. Reads never audit (3 Month Reports + 4 Overviews + the comparison reads): no audit row added", world.audit.length === aOv && aOv === a0 + 1);

  // ----- Month / date (brief 58-60) -----
  const bad = ["2026-13", "26-10", "2026-1", "1999-12", "2026-10-01"].map((mm) => parseMonthReportQuery("month.report", new URLSearchParams({ month: mm }), isTenantKey));
  const badMode = parseMonthReportQuery("month.report", new URLSearchParams({ mode: "forecast" }), isTenantKey);
  ck("MD58. Explicit YYYY-MM month (2000-2100); anything else 400 invalid_query; mode only actual | expected; unknown parameters 400", bad.every((x) => !x.ok && x.code === "invalid_query") && !badMode.ok && !parseMonthReportQuery("month.report", new URLSearchParams({ from: "2026-10-01" }), isTenantKey).ok && parseMonthReportQuery("month.report", new URLSearchParams({ month: "2026-10", mode: "expected" }), isTenantKey).ok);
  const midnight = await report({}, mgr, { ...deps, clock: () => new Date("2026-09-30T23:30:00.000Z") });
  ck("MD59. Organisation-local boundary: 23:30 UTC on 30 Sep is 00:30 on 1 Oct in London -> default month 2026-10, today 2026-10-01 (a venue share dated 10-01 is now Actual; 10-08 not yet)", midnight.body.month === "2026-10" && midnight.body.today === "2026-10-01" && prog(midnight.body, "FSV-AAAAAAAAAAAA").directCosts.venue.gross === "100.00", `${midnight.body?.month} ${midnight.body?.today} ${J(prog(midnight.body, "FSV-AAAAAAAAAAAA")?.directCosts)}`);
  const jan = await report({ month: "2027-01" });
  ck("MD60. Previous calendar month (Jan -> Dec of the year before; month ends incl. leap years)", jan.body.previousMonth === "2026-12" && previousMonth("2026-01") === "2025-12" && monthEnd("2028-02") === "2028-02-29" && monthEnd("2026-02") === "2026-02-28" && monthEnd("2026-12") === "2026-12-31" && addMonths("2026-11", 3) === "2027-02");

  // ----- Access (brief 61-67) -----
  const v = await report({}, viewer);
  const vo = await overview({}, NA_OK, viewer);
  ck("AC61. Finance View reads the Month Report and the Overview (access: view)", v.httpStatus === 200 && v.body.access === "view" && vo.httpStatus === 200 && vo.body.access === "view");
  ck("AC62. Finance Manage reads both (access: manage)", oct.body.access === "manage" && ob.access === "manage");
  const ng = await report({}, nogrant);
  const ngo = await overview({}, NA_OK, nogrant);
  ck("AC63. No Finance grant: 403 finance_access_denied, no figures", ng.httpStatus === 403 && ng.code === "finance_access_denied" && !ng.body && ngo.code === "finance_access_denied");
  const co = await report({}, coach);
  const pr = await overview({}, NA_OK, parent);
  ck("AC64. Coach / Parent: 403 management_required", co.httpStatus === 403 && co.code === "management_required" && pr.code === "management_required");
  world.moduleOn = false;
  const off = await report();
  const offO = await overview({}, NA_OK);
  world.moduleOn = true;
  ck("AC65. Finance module off: 403 finance_module_disabled", off.code === "finance_module_disabled" && offO.code === "finance_module_disabled");
  const t1 = parseMonthReportQuery("month.report", new URLSearchParams({ organisationId: "ORG-OTHER" }), isTenantKey);
  const t2 = parseMonthReportQuery("finance.overview", new URLSearchParams({ org: "x", month: "2026-10" }), isTenantKey);
  ck("AC66. Tenant override rejected (400 tenant_param_rejected) on both routes - the organisation comes from the caller's profile", !t1.ok && t1.code === "tenant_param_rejected" && !t2.ok && t2.code === "tenant_param_rejected");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => (decodeURIComponent(String(input)).includes("/Finance Invoice Lines") ? new Response("{}", { status: 500 }) : realFetch(input, init))) as typeof fetch;
  const down = await report();
  const downO = await overview({}, NA_OK);
  globalThis.fetch = realFetch;
  ck("AC67. A source read failure fails closed: 503 month_report_unavailable, no partial figures (report and Overview)", down.httpStatus === 503 && down.code === "month_report_unavailable" && !down.body && downO.httpStatus === 503);
  const brokenInv = { ...invoice(9, { gross: 5000 }), lineCount: 2, sourceDraftId: `FID-${hex(909)}` } as Invoice;
  setF7({ ...F7, invoices: [...F7.invoices, brokenInv] });
  world.at[ISSUE_TABLES.lines].push(rowOf(invoiceLineCreateFields(vline(91, brokenInv.invoiceId, brokenInv.sourceDraftId, 1, occId("OccA3", "2026-10-22"), "2026-10-22", 2500), ORG_REC)));
  const inconsistent = await report();
  world.at[ISSUE_TABLES.lines].pop();
  setF7(F7);
  ck("AC67b. Inconsistent stored data (an invoice whose stored lines do not match it) is refused: 409 month_report_data_invalid naming the invoice - never forced", inconsistent.httpStatus === 409 && inconsistent.code === "month_report_data_invalid" && inconsistent.error.includes(brokenInv.invoiceId), J(inconsistent).slice(0, 300));

  // ----- Audit / performance (brief 68-70) -----
  ck("AU68. Reads create no audit (every read above, including refused ones): only the one bank balance write is audited", world.audit.length === a0 + 1 && world.audit[world.audit.length - 1].event_type === "finance_bank_balance.recorded");
  const byTable = (xs: string[]) => xs.reduce((m: Record<string, number>, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
  const extra: Invoice[] = [];
  const extraLines: InvoiceLine[] = [];
  for (let k = 0; k < 30; k++) {
    const iv = { ...invoice(100 + k, { gross: 1000 }), sourceDraftId: `FID-${hex(1000 + k)}` } as Invoice;
    extra.push(iv);
    extraLines.push(vline(2000 + k, iv.invoiceId, iv.sourceDraftId, 1, `OCC-SYN${k}:2026-10-0${1 + (k % 9)}`, `2026-10-0${1 + (k % 9)}`, 1000));
  }
  setF7({ ...F7, invoices: [...F7.invoices, ...extra], payments: [...F7.payments, ...extra.map((iv, k) => payment(100 + k, iv, 1000, "2026-10-14"))] });
  world.at[ISSUE_TABLES.lines].push(...extraLines.map((l) => rowOf(invoiceLineCreateFields(l, ORG_REC))));
  const r1 = world.airtableReads.length;
  const f1 = cfFetchLog.filter((u) => /\/rest\/v1\//.test(u)).length;
  const big = await report({ month: "2026-10" });
  const readsBig = world.airtableReads.slice(r1);
  const restBig = cfFetchLog.filter((u) => /\/rest\/v1\//.test(u)).length - f1;
  ck("AU69. No N+1: 31 more invoices (+ lines + payments) cost ZERO extra reads - every table is read the same number of times (each source family once per request)", big.httpStatus === 200 && big.body.overall.netRevenue === "312.50" && J(byTable(readsBig)) === J(byTable(readsOne)) && restBig === restOne, J({ one: byTable(readsOne), big: byTable(readsBig), restOne, restBig }));
  const maxPerTable = Math.max(...Object.values(byTable(readsBig)));
  const repo = readFileSync(join(CANON, "finance", "finance-month-report-repository.ts"), "utf8");
  ck("AU70. Bounded reads: each Airtable table at most twice per report; invoice lines / draft lines read only for the two-month window (date-bounded formula) + touched invoices in chunks of 40; every row re-checked in code", maxPerTable <= 2 && /IS_AFTER\(\$\{field\(dateField\)\}/.test(repo) && /chunk\(ids, CLAIM_READ_CHUNK\)/.test(repo) && readsBig.length <= 25, J(byTable(readsBig)));
  setF7(F7);
  world.at[ISSUE_TABLES.lines] = world.at[ISSUE_TABLES.lines].slice(0, 3);
  void [E2, sepR];
}

async function drift() {
  const mirror = (f: string) => {
    const canon = readFileSync(join(CANON, "finance", f), "utf8").replace(/from "\.\/orchestrator\.ts"/g, 'from "./finance-orchestrator.ts"').replace(/from "\.\/repository\.ts"/g, 'from "./finance-repository.ts"');
    const copy = readFileSync(join(HERE, f), "utf8");
    return copy.slice(copy.indexOf("/**", 3)) === canon || copy === canon;
  };
  ck("Z1. Test copies == canonical (finance-month-report.ts, -repository.ts, -orchestrator.ts, finance-settings.ts; only import paths adjusted)", ["finance-month-report.ts", "finance-month-report-repository.ts", "finance-month-report-orchestrator.ts", "finance-settings.ts"].every(mirror));
  const idx = readFileSync(join(CANON, "finance", "index.ts"), "utf8");
  const na = idx.slice(idx.indexOf("function needsAttentionSummary"), idx.indexOf("async function handleMonthReport"));
  ck("Z2. index.ts routes month-report / overview first (before F17 cash-flow), GET only; the Overview's Needs Attention call forwards the caller's own Authorization with the anon key - never the service key", idx.indexOf("matchMonthReportRoute(route") > 0 && idx.indexOf("matchMonthReportRoute(route") < idx.indexOf("matchCashFlowRoute(route") && /Authorization: authHeader, apikey: SUPABASE_ANON_KEY/.test(na) && !/SERVICE_ROLE|serviceRoleKey/.test(na) && /needs-attention\/cases/.test(na));
  const orch = readFileSync(join(CANON, "finance", "finance-month-report-orchestrator.ts"), "utf8");
  const repo = readFileSync(join(CANON, "finance", "finance-month-report-repository.ts"), "utf8");
  ck("Z3. Read only: the orchestrator / repository write nothing (no create / patch / rpc / audit) and store no report", !/(create\w*Row|patch\w*Row|insertAuditEvent|method: "POST"|method: "PATCH"|recordBalance|rpc\()/.test(orch + repo));
  ck("AT. No Cash Flow logic duplicated: the cash summary is F17's buildCashFlow + cashFlowView over the same ledgers; no balance / projection arithmetic in F18", /buildCashFlow\(/.test(orch) && /cashFlowView\(cf, "position"\)/.test(orch) && !/projectedLow\w*\s*=|balanceAfter|thresholdBreached\s*=/.test(orch.replace(/cashSummary = \{[\s\S]*?\};/g, "")));
  const files = readFileSync(join(CANON, "finance", "index.ts"), "utf8");
  ck("AU/AV. F18 stays free of reporting outputs: the F19 Sheets writer lives only in its own reporting modules (F18's orchestrator / repository never mention Sheets; F19 only calls loadCanonicalMonth); no F20 Legacy Finance History route, module or import", !/legacy[-_ ]finance|finance-legacy/i.test(files) && !/sheets|spreadsheet|legacy/i.test(orch + repo) && /from "\.\/finance-reporting-sheets-orchestrator\.ts"/.test(files));
  ck("Z4. Routes: GET month-report, GET overview (path /finance/overview - a route starting with 'finance' would be swallowed by the shared path prefix rule); wrong method 405; other paths are not F18's (cash-flow stays F17's)", matchMonthReportRoute("month-report", "GET")?.status === "ok" && matchMonthReportRoute("overview", "POST")?.status === "method" && matchMonthReportRoute("overview", "GET")?.status === "ok" && matchMonthReportRoute("finance-overview", "GET") === null && "/functions/v1/finance/overview".replace(/^.*\/finance\/?/, "") === "overview" && matchMonthReportRoute("month-reports", "GET") === null && matchMonthReportRoute("cash-flow", "GET") === null && matchCashFlowRoute("month-report", "GET") === null);
  const s1 = parseUpdateBody(JSON.stringify({ settings: { overviewCashSummaryVisible: false } }), isTenantKey);
  const s2 = parseUpdateBody(JSON.stringify({ settings: { overviewCashSummaryVisible: "no" } }), isTenantKey);
  const st = toStoredFields({ ...EMPTY_SETTINGS, overviewCashSummaryVisible: false } as any, ["overviewCashSummaryVisible"] as any);
  ck("D9. F2 setting 'Show Cash Summary on Finance Overview' (Shown / Hidden), default ON when blank, not part of setup completeness; true / false / null accepted, anything else refused", SETTINGS_KEYS.includes("overviewCashSummaryVisible" as any) && FIELD_NAMES.overviewCashSummaryVisible === "Show Cash Summary on Finance Overview" && ![...requiredKeys(EMPTY_SETTINGS), ...requiredKeys({ ...EMPTY_SETTINGS, vatRegistered: true } as any)].includes("overviewCashSummaryVisible" as any) && overviewCashSummaryShown(null) && overviewCashSummaryShown({ overviewCashSummaryVisible: null }) && !overviewCashSummaryShown({ overviewCashSummaryVisible: false }) && s1.ok && !s2.ok && FIELD_VALIDATORS.overviewCashSummaryVisible(true).ok && st["Show Cash Summary on Finance Overview"] === "Hidden");
}

async function main() {
  await pure();
  await live();
  await drift();
}

main()
  .then(() => {
    for (const [s, n, x] of R) console.log(`${s}  ${n}${s === "FAIL" && x ? `  -- ${x}` : ""}`);
    const passed = R.filter((r) => r[0] === "PASS").length;
    console.log(`\n${passed}/${R.length} checks passed`);
    if (failed) process.exit(1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
