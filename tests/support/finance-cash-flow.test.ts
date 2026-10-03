/**
 * Finance Foundation F17 - Cash Position / Cash Flow forecast.
 * Run: node --experimental-strip-types tests/support/finance-cash-flow.test.ts
 *
 *   SO  audit / source ownership (authoritative amount + date; unsupported excluded)   brief 1-2
 *   BA  Management-entered balance + append-only history + concurrency                 brief 3-7
 *   TL  timeline arithmetic, ordering, end / low                                       brief 8-13
 *   RG  ranges + organisation-local date + overdue visibility                          brief 14-17
 *   MI  Money In (receivables, receipts, pre-invoice, overdue, Stripe, credit, refunds) brief 18-26
 *   MO  Money Out (suppliers, credit, overdue, employment, overheads)                   brief 27-37
 *   CO  Coach Months (F12, no Paid lifecycle)                                           brief 38-40
 *   DD  dedupe / supersession / stable identity                                        brief 41-44
 *   VW  views (one timeline, filtered; totals reconcile)                               brief 45-48
 *   TH  safety threshold + first breach (ATT-054 is in needs-attention-cash-flow)      brief 49-51
 *   AC  access + audit                                                                 brief 55-63
 *   DB  database backstops + parsing
 *   Z   drift (mirrors == canonical, F2 setting wiring)
 *
 * The REAL F17 orchestrator and the F2 / F7 / F12 / F13 / F15 repositories run
 * against the in-memory world (finance-cash-flow-world.ts). Supplier, credit and
 * employment fixtures are made through the REAL F13 / F14 / F15 routes; F7 rows
 * through F6 / F7's own create-field builders. NOW = 2026-10-15 (London).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isTenantKey } from "./finance-access.ts";
import {
  BALANCE_EVENT,
  BALANCE_LABEL,
  NOT_INCLUDED,
  addCalendarMonths,
  buildCashFlow,
  cashFlowView,
  compareEvents,
  latestBalance,
  matchCashFlowRoute,
  parseBalance,
  parseCashQuery,
  rangeEnd,
  totalsOf,
  type BankBalance,
} from "./finance-cash-flow.ts";
import { FIELD_NAMES, FIELD_VALIDATORS, SETTINGS_KEYS, parseUpdateBody } from "./finance-settings.ts";
import {
  COACH_F17,
  MGR,
  ORG,
  R,
  T_,
  VENUE_BODY,
  act,
  agreementNew,
  allocation,
  application,
  balanceHistory,
  balanceNew,
  balanceRpc,
  catNew,
  cashFlow,
  cfFake,
  cfFetchLog,
  ck,
  coach,
  coachOcc,
  correctionRow,
  creditDo,
  creditNew,
  creditNote,
  directBalanceWrite,
  dueChange,
  empNew,
  failed,
  financeMonthRow,
  invoice,
  mgr,
  monthAct,
  nogrant,
  noteCredit,
  overpaymentCredit,
  parent,
  pay,
  payment,
  paymentReversal,
  reset,
  setF7,
  setSettings,
  supplierNew,
  viewer,
  world,
} from "./finance-cash-flow-world.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANON = join(HERE, "..", "..", "supabase", "functions-test");
const added = async (fn: () => Promise<any>) => {
  const n = world.audit.length;
  const r = await fn();
  return { r, ev: world.audit.slice(n) };
};
const ev = (b: any, key: string) => (b.timeline ?? []).find((e: any) => e.key === key);
const keyOf = (b: any, pred: (e: any) => boolean) => (b.timeline ?? []).filter(pred);
const pence = (s: string | null) => (s === null ? null : Math.round(Number(s) * 100));

async function main() {
  // =================================================================
  // Fixtures (through the real F13 / F14 / F15 routes; F7 rows via F6 / F7 builders)
  // =================================================================
  reset();
  setSettings({ paymentDay: 20 });
  const BUS = (await supplierNew({ name: "ZZTEST F17 Coach Hire", type: "other" })).body.supplier.supplierId as string;
  const VEN = (await supplierNew({ name: "ZZTEST F17 Hall", type: "venue" })).body.supplier.supplierId as string;
  const ag = await agreementNew({
    supplierId: BUS,
    name: "ZZTEST F17 transport",
    costType: "custom_dates",
    classification: "general",
    effectiveFrom: "2026-10-01",
    instalments: [
      { dueDate: "2026-10-05", amount: "300.00" },
      { dueDate: "2026-10-12", amount: "400.00" },
      { dueDate: "2026-10-20", amount: "200.00", estimated: true },
      { dueDate: "2026-10-28", amount: "600.00" },
      { dueDate: "2026-11-30", amount: "700.00" },
      { dueDate: "2026-10-22", amount: "250.00" },
      { dueDate: "2026-10-09", amount: "120.00" },
      { dueDate: "2026-10-14", amount: "80.00" },
    ],
  });
  const AG = ag.body.agreement.agreementId as string;
  const at = (d: string) => (ag.body.schedule as any[]).find((i) => i.dueDate === d).instalmentId as string;
  const I1 = at("2026-10-05"), I2 = at("2026-10-12"), I3 = at("2026-10-20"), I4 = at("2026-10-28"), I5 = at("2026-11-30"), I6 = at("2026-10-22"), I7 = at("2026-10-09"), I8 = at("2026-10-14");
  const p2 = await pay(I2, "150.00", "2026-10-11");
  const p7 = await pay(I7, "120.00", "2026-10-09");
  const p8 = await pay(I8, "80.00", "2026-10-13");
  const c6 = await act(I6, "cancel", { reason: "ZZTEST trip cancelled" });
  const cr = await creditNew({ supplierId: BUS, scope: "agreement", agreementId: AG, amount: "100.00", creditDate: "2026-10-10", sourceType: "credit_note", sourceReference: "ZZ-F17-CN", reason: "ZZTEST late bus" });
  const CR = cr.body.credit.creditId as string;
  const crApply = await creditDo(CR, "apply", { instalmentId: I4, amount: "100.00" });
  const ven = await agreementNew(VENUE_BODY(VEN));
  const V_OCT = (ven.body.schedule as any[]).find((i) => i.dueDate === "2026-10-20").instalmentId as string;
  const V_NOV = (ven.body.schedule as any[]).find((i) => i.dueDate === "2026-11-20").instalmentId as string;
  const SAL = (await catNew({ name: "Salaries" })).body.category.categoryId as string;
  const E1 = (await empNew({ name: "ZZTEST F17 Office Manager", categoryId: SAL, annualSalary: "24000.00", payDay: 25, startDate: "2026-09-01" })).body.employment.employmentId as string;
  const E2 = (await empNew({ name: "ZZTEST F17 Groundsman", categoryId: SAL, annualSalary: "12000.00", payDay: 12, startDate: "2026-09-01" })).body.employment.employmentId as string;
  for (const [e, m, d] of [[E1, "2026-09", "2026-09-25"], [E2, "2026-09", "2026-09-12"]] as const) {
    await monthAct(e, m, "confirm-estimate", { useEstimate: true });
    await monthAct(e, m, "payment", { amount: e === E1 ? "2000.00" : "1000.00", paidDate: d });
  }
  const e2Oct = await monthAct(E2, "2026-10", "confirm-estimate", { useEstimate: true });
  // F7: INV1 1200 due 10-25 with 100.00 client credit applied (from INV3's credit note); INV2 800 due 10-01, 300 received 10-12;
  // INV3 600 due 10-20 paid in full 10-08, then credited 100 (kept as client credit); INV4 awaiting Xero; INV5 400 due 10-30, credit note 100.
  const INV1 = invoice(1, { gross: 120000, dueDate: "2026-10-25" });
  const INV2 = invoice(2, { gross: 80000, dueDate: "2026-10-01" });
  const INV3 = invoice(3, { gross: 60000, dueDate: "2026-10-20" });
  const INV4 = invoice(4, { gross: 114300, xero: true });
  const INV5 = invoice(5, { gross: 40000, dueDate: "2026-10-30" });
  const CN3 = creditNote(3, INV3, 10000);
  const CN5 = creditNote(5, INV5, 10000);
  const PAY2 = payment(2, INV2, 30000, "2026-10-12");
  const PAY3 = payment(3, INV3, 60000, "2026-10-08");
  const CC3 = noteCredit(3, { sourceInvoiceId: INV3.invoiceId, sourceCreditNoteId: CN3.creditNoteId, original: 10000, remaining: 0 });
  const APP1 = application(1, CC3.creditId, INV1, 10000);
  const F7 = { invoices: [INV1, INV2, INV3, INV4, INV5], notes: [CN3, CN5], payments: [PAY2, PAY3], credits: [CC3], applications: [APP1] };
  setF7(F7);
  // F12: Sep finalised 170.00 (+5.00 correction) paid 2026-10-20; Aug finalised 210.00 paid 2026-09-20 (past);
  // Jul open (never finalised) 45.00 paid 2026-08-20 (past); Oct open: 45.00 + 45.00 (+ one unpriced) paid 2026-11-20.
  const occJul = coachOcc("OccCJul1", "2026-07-08", "Completed", ["recAllocJul100000"]);
  const occOct1 = coachOcc("OccCOct1", "2026-10-05", "Completed", ["recAllocOct100000"]);
  const occOct2 = coachOcc("OccCOct2", "2026-10-22", "Scheduled", ["recAllocOct200000"]);
  const occOct3 = coachOcc("OccCOct3", "2026-10-29", "Scheduled", ["recAllocOct300000"]);
  world.at["Session Occurrences"].push(occJul, occOct1, occOct2, occOct3);
  world.at["Coach Allocations"] = [
    allocation("AllocJul1", occJul.id, 45),
    allocation("AllocOct1", occOct1.id, 45),
    allocation("AllocOct2", occOct2.id, 45),
    allocation("AllocOct3", occOct3.id, null),
  ];
  const FM_SEP = financeMonthRow(1, { workMonth: "2026-09", totalMinor: 17000, payDate: "2026-10-20" });
  const FM_AUG = financeMonthRow(2, { workMonth: "2026-08", totalMinor: 21000, payDate: "2026-09-20" });
  T_("finance_worker_cost_months").push(FM_SEP, FM_AUG);
  T_("finance_worker_cost_corrections").push(correctionRow(1, FM_SEP.month_id, 500, 17500));
  ck(
    "FX. Fixtures through F13 / F14 / F15 routes + F6 / F7 builders + F12 rows: 8 transport instalments (1 estimated), venue 2 x 500, 3 supplier payments, 1 cancel, 1 credit applied; 2 employees (Sep paid); 5 invoices; 2 Finance Coach Months + 1 correction; 4 coach allocations",
    [ag, ven].every((x) => x.httpStatus === 201) && [p2, p7, p8, c6, crApply, e2Oct].every((x) => x.httpStatus === 200 || x.httpStatus === 201) && cr.httpStatus === 201 && T_("finance_supplier_payments").length === 3,
  );

  // =================================================================
  // BA. Balance (brief 3-7) - before any balance, the projection cannot start
  // =================================================================
  const none = await cashFlow();
  ck("BA0. No balance recorded: the timeline is still built and traceable, but every projected figure is null with a clear message (no invented starting point)", none.httpStatus === 200 && none.body.summary.balanceRecorded === false && none.body.summary.currentBalance === null && none.body.summary.projectedLow === null && none.body.timeline.every((e: any) => e.projectedBalanceAfter === null || !e.includedInProjection) && /Record the current bank balance/.test(none.body.summary.message) && none.body.timeline.every((e: any) => e.state !== "actual"));
  const { r: b1, ev: b1Ev } = await added(() => balanceNew({ amount: "10000.00", asAtDate: "2026-10-10", note: "ZZTEST bank statement 10 Oct" }));
  ck("BA3. Record the current bank balance: 201, amount, as-at date, who + when recorded, labelled 'Management-entered bank balance' (never bank verified)", b1.httpStatus === 201 && b1.body.balance.amount === "10000.00" && b1.body.balance.asAtDate === "2026-10-10" && b1.body.balance.recordedBy === MGR && b1.body.balance.recordedAt === "2026-10-15T12:00:00.000Z" && b1.body.balance.label === BALANCE_LABEL && /not bank verified/.test(b1.body.balance.verification) && /^FBB-[0-9A-F]{12}$/.test(b1.body.balance.balanceId), JSON.stringify(b1.body));
  ck("BA4. The optional note is stored (and may be left out)", b1.body.balance.note === "ZZTEST bank statement 10 Oct" && T_("finance_bank_balances")[0].note === "ZZTEST bank statement 10 Oct");
  ck("BA62. A balance write is audited: exactly one finance_bank_balance.recorded row (record id, after amount + as-at, no previous)", b1Ev.length === 1 && b1Ev[0].event_type === BALANCE_EVENT && b1Ev[0].record_id === b1.body.balance.balanceId && b1Ev[0].after.amountMinor === 1000000 && b1Ev[0].after.asAtDate === "2026-10-10" && b1Ev[0].before === null);

  // =================================================================
  // TL / MI / MO / CO on the 30-day Cash Position (balance 10,000.00 as at 10 Oct)
  // =================================================================
  const a0 = world.audit.length;
  const p = await cashFlow({ range: "30d", view: "position" });
  const pb = p.body;
  ck("RD. GET /cash-flow (default 30d Cash Position): 200, contract finance-cash-flow-v1, today 2026-10-15, range 2026-10-15..2026-11-13", p.httpStatus === 200 && pb.contract === "finance-cash-flow-v1" && pb.today === "2026-10-15" && pb.rangeStart === "2026-10-15" && pb.rangeEnd === "2026-11-13" && pb.view === "position", JSON.stringify(pb).slice(0, 400));
  // ---- actuals after the as-at date ----
  const actuals = keyOf(pb, (e: any) => e.state === "actual").map((e: any) => `${e.direction}:${e.sourceType}:${e.amount}:${e.cashDate}`);
  ck("BA5/MI. Actual cash after the balance as-at date is applied (supplier payment 150.00 on 10-11, client receipt 300.00 on 10-12, supplier payment 80.00 on 10-13); anything on / before 10-10 is assumed in the balance (the 120.00 paid 10-09, the 600.00 received 10-08)", actuals.join("|") === "out:supplier_payment:150.00:2026-10-11|in:client_receipt:300.00:2026-10-12|out:supplier_payment:80.00:2026-10-13" && pb.summary.balanceToday === "10070.00", actuals.join("|"));
  // ---- Money In ----
  const inv1 = ev(pb, `in:receivable:${INV1.invoiceId}`);
  ck("MI18. Unpaid issued invoice: Confirmed IN on its real due date for what is still outstanding (1200.00 - 100.00 client credit applied = 1100.00)", !!inv1 && inv1.state === "confirmed" && inv1.amount === "1100.00" && inv1.cashDate === "2026-10-25" && inv1.includedInProjection && inv1.context.clientCreditApplied === "100.00" && inv1.source.api === `GET /finance/invoices/${INV1.invoiceId}/receivable` && inv1.source.destination.route === "finance/invoice");
  const inv2 = ev(pb, `in:receivable:${INV2.invoiceId}`);
  ck("MI19. Partially received: only the remainder is forecast (800.00 - 300.00 = 500.00); the 300.00 received is an Actual", !!inv2 && inv2.amount === "500.00" && inv2.context.cashReceived === "300.00");
  ck("MI23. Overdue incoming (due 10-01, 14 days): visible as Overdue at its REAL due date, NOT in the projected balance (never treated as received)", !!inv2 && inv2.state === "overdue" && inv2.daysOverdue === 14 && inv2.dueDate === "2026-10-01" && inv2.cashDate === "2026-10-01" && inv2.includedInProjection === false && inv2.projectedBalanceAfter === null && /never counted as available/.test(inv2.notIncludedReason) && pb.totals.overdueIn === "500.00");
  ck("MI20. Fully received (INV3 paid 600.00 on 10-08, then credited 100.00 kept as client credit): no expected movement left for it", !ev(pb, `in:receivable:${INV3.invoiceId}`) && !keyOf(pb, (e: any) => e.sourceId === INV3.invoiceId || e.context?.invoiceId === INV3.invoiceId).length);
  const inv5 = ev(pb, `in:receivable:${INV5.invoiceId}`);
  ck("MI18b. A credit note reduces what is expected (INV5 400.00 - 100.00 credit note = 300.00 on 10-30)", !!inv5 && inv5.amount === "300.00" && inv5.cashDate === "2026-10-30" && inv5.context.creditNotes === "100.00");
  ck("MI21. Pre-invoice expected revenue is NOT forecast (no billing schedule gives a cash date) - stated, never guessed", pb.notIncluded.preInvoiceRevenue.included === false && /no truthful cash date/.test(pb.notIncluded.preInvoiceRevenue.reason) && !keyOf(pb, (e: any) => e.sourceType !== "receivable" && e.sourceType !== "client_receipt" && e.direction === "in").length);
  ck("MI1b. Invoice awaiting issue in Xero: not forecast (no due date) - counted under Not included (1, 1143.00)", !ev(pb, `in:receivable:${INV4.invoiceId}`) && pb.notIncluded.awaitingIssue.count === 1 && pb.notIncluded.awaitingIssue.gross === "1143.00");
  ck("MI24. Stripe: 'Stripe forecast: Not included' - 'Stripe bank payout timing is not currently available.' (structured metadata, not an error); no Stripe event exists", pb.notIncluded.stripe.included === false && pb.notIncluded.stripe.label === "Stripe forecast: Not included" && pb.notIncluded.stripe.reason === "Stripe bank payout timing is not currently available." && !keyOf(pb, (e: any) => /stripe/i.test(e.sourceType)).length && !cfFetchLog.some((u) => /api\.stripe\.com|stripe-sandbox/i.test(u)));
  ck("MI25. Client credit is not cash: the 100.00 credit kept from INV3 and applied to INV1 creates no movement - it only reduced INV1's outstanding", !keyOf(pb, (e: any) => /FCC-|FCA-/.test(e.sourceId)).length && pb.notIncluded.clientCredit.cash === false);
  ck("MI26. Parent card refunds (F11 Refund Due / F21 Stripe refunds) are never in the bank projection: stated as settling through Stripe payouts (no guessed bank date), information only", pb.notIncluded.refundDue.included === false && /Stripe payouts/.test(pb.notIncluded.refundDue.reason) && /never change the projected bank balance/.test(pb.notIncluded.refundDue.reason) && pb.notIncluded.refundDue.awaitingRefundAction.count === 0 && !keyOf(pb, (e: any) => /refund/i.test(e.sourceType)).length);
  {
    // F21 (locked decision D1): Refund Due, a pending Stripe refund and a SUCCEEDED Stripe refund change nothing in the projection.
    const dec = (id: string, card: number, state: string, refundId: string | null = null) => ({ organisation_id: ORG, decision_id: id, family_parent_id: "PARENT-TEST-001", source_ref: "ch_ZZTESTcf", stripe_charge_id: "ch_ZZTESTcf", stripe_customer_id: "cus_ZZTESTa", currency: "GBP", return_minor: card + 2000, card_refund_minor: card, credit_restored_minor: 2000, card_to_credit_minor: 0, refund_state: state, stripe_refund_id: refundId, reversed_at: null });
    world.sb.finance_refund_decisions = [dec("FRD-00000000CF01", 3000, "awaiting_refund_action"), dec("FRD-00000000CF02", 4000, "refund_processing"), dec("FRD-00000000CF03", 5000, "refunded", "re_ZZTESTcf3")];
    world.sb.finance_stripe_refund_executions = [
      { organisation_id: ORG, execution_id: "FRX-00000000CF02", decision_id: "FRD-00000000CF02", version: 1, stripe_charge_id: "ch_ZZTESTcf", amount_minor: 4000, currency: "GBP", idempotency_key: `f21:${ORG}:FRD-00000000CF02:v1`, status: "processing", provider_status: "pending", stripe_refund_id: "re_ZZTESTcf2", stripe_refund_created_at: "2026-10-14T10:00:00Z", failure_kind: null, failure_code: null, failure_message: null, attempts: 1, started_at: "2026-10-14T10:00:00Z", started_by: MGR, last_attempt_at: "2026-10-14T10:00:00Z", last_checked_at: null, last_checked_by: null, succeeded_at: null, failed_at: null },
      { organisation_id: ORG, execution_id: "FRX-00000000CF03", decision_id: "FRD-00000000CF03", version: 1, stripe_charge_id: "ch_ZZTESTcf", amount_minor: 5000, currency: "GBP", idempotency_key: `f21:${ORG}:FRD-00000000CF03:v1`, status: "succeeded", provider_status: "succeeded", stripe_refund_id: "re_ZZTESTcf3", stripe_refund_created_at: "2026-10-12T23:30:00Z", failure_kind: null, failure_code: null, failure_message: null, attempts: 1, started_at: "2026-10-12T23:30:00Z", started_by: MGR, last_attempt_at: "2026-10-12T23:30:00Z", last_checked_at: null, last_checked_by: null, succeeded_at: "2026-10-12T23:30:01Z", failed_at: null },
    ];
    const p2 = await cashFlow({ range: "30d", view: "position" });
    const r = p2.body.notIncluded.refundDue;
    const strip = (b: any) => JSON.stringify({ ...b, notIncluded: { ...b.notIncluded, refundDue: null } });
    ck("MI26b. F21 refunds are information only: Refund Due 30.00 / processing 40.00 / refunded via Stripe 50.00 (on 2026-10-13 London, 'settles through Stripe payouts') - the timeline, totals and projected balance are byte-identical to the run without them", p2.httpStatus === 200 && strip(p2.body) === strip(pb) && r.included === false && r.awaitingRefundAction.amount === "30.00" && r.processingInStripe.amount === "40.00" && r.refundedViaStripe.count === 1 && r.refundedViaStripe.refunds[0].refundedOn === "2026-10-13" && r.refundedViaStripe.refunds[0].bankProjection === false && /settles through Stripe payouts/.test(r.refundedViaStripe.refunds[0].note) && !keyOf(p2.body, (e: any) => /refund/i.test(e.sourceType)).length, JSON.stringify(r).slice(0, 300));
    world.sb.finance_refund_decisions = [];
    world.sb.finance_stripe_refund_executions = [];
  }
  // ---- Money Out ----
  const i1 = ev(pb, `out:supplier_instalment:${I1}`);
  ck("MO33. Overdue outgoing (due 10-05, 10 days): still owed - keeps its real due date + days overdue and counts as a requirement TODAY in the projection", !!i1 && i1.state === "overdue" && i1.daysOverdue === 10 && i1.dueDate === "2026-10-05" && i1.cashDate === "2026-10-15" && i1.includedInProjection && i1.amount === "300.00");
  const i2 = ev(pb, `out:supplier_instalment:${I2}`);
  ck("MO29. Supplier partial cash payment leaves only the remainder (400.00 - 150.00 = 250.00, overdue 3 days)", !!i2 && i2.amount === "250.00" && i2.context.cashPaid === "150.00" && i2.state === "overdue" && i2.daysOverdue === 3);
  const i3 = ev(pb, `out:supplier_instalment:${I3}`);
  ck("MO28. Supplier estimated instalment: Estimated OUT on its due date (200.00, 10-20)", !!i3 && i3.state === "estimated" && i3.amountIsEstimate && i3.amount === "200.00" && i3.cashDate === "2026-10-20");
  const i4 = ev(pb, `out:supplier_instalment:${I4}`);
  ck("MO30. Supplier credit reduces the remaining cash requirement (600.00 - 100.00 credit = 500.00 Confirmed OUT on 10-28)", !!i4 && i4.state === "confirmed" && i4.amount === "500.00" && i4.context.supplierCreditApplied === "100.00" && i4.cashDate === "2026-10-28");
  ck("MO31. Supplier credit creates no money in: no IN event from F14, and the credit itself is never an event", !keyOf(pb, (e: any) => e.direction === "in" && /supplier/.test(e.sourceType)).length && !keyOf(pb, (e: any) => e.sourceId === CR).length && pb.notIncluded.supplierCredit.cash === false);
  ck("MO32. Settled (paid before the balance date) and cancelled instalments have no future OUT", !ev(pb, `out:supplier_instalment:${I7}`) && !ev(pb, `out:supplier_instalment:${I6}`) && !ev(pb, `out:supplier_instalment:${I8}`));
  ck("MO27. Supplier / venue Confirmed future OUT on the instalment payment date (venue 500.00 on 10-20); beyond the range is not listed (11-20, 11-30)", ev(pb, `out:supplier_instalment:${V_OCT}`)?.state === "confirmed" && ev(pb, `out:supplier_instalment:${V_OCT}`)?.amount === "500.00" && !ev(pb, `out:supplier_instalment:${V_NOV}`) && !ev(pb, `out:supplier_instalment:${I5}`));
  const e1 = ev(pb, `out:employment_cost:${E1}|month:2026-10`);
  ck("MO34. Employment Estimated: the month's estimate on its expected pay date (2000.00 on 10-25)", !!e1 && e1.state === "estimated" && e1.amount === "2000.00" && e1.cashDate === "2026-10-25" && e1.source.api === `GET /finance/employment-costs/${E1}?from=2026-10&to=2026-10`);
  const e2 = ev(pb, `out:employment_cost:${E2}|month:2026-10`);
  ck("MO35. Employment Confirmed (not paid by its 10-12 pay date): Overdue OUT 1000.00 counted today; the Nov estimate is Estimated on 11-12", !!e2 && e2.state === "overdue" && e2.amountIsEstimate === false && e2.daysOverdue === 3 && e2.cashDate === "2026-10-15" && ev(pb, `out:employment_cost:${E2}|month:2026-11`)?.state === "estimated");
  ck("MO36. Paid employment months (Sep, paid before the balance date) have no future duplicate", !ev(pb, `out:employment_cost:${E1}|month:2026-09`) && !ev(pb, `out:employment_cost:${E2}|month:2026-09`) && !keyOf(pb, (e: any) => e.sourceType === "employment_payment").length);
  ck("MO37. Overheads / contractors come only from the F13 schedule (the transport agreement is a general F13 agreement); there is no separate Cash Flow overhead record or table", keyOf(pb, (e: any) => e.context?.agreementId === AG).length === 4 && !Object.keys(world.sb).some((t) => /cash_flow|forecast/.test(t)));
  ck("MO-TAX. VAT / PAYE liabilities are not included (no structured source); employer NI / PAYE estimates stay inside the employment month on its pay date", pb.notIncluded.taxLiabilities.included === false && /not the real HMRC payment date/.test(pb.notIncluded.taxLiabilities.reason) && /HMRC/.test(e1.context.note));
  // ---- Coach Months ----
  const sep = ev(pb, `out:coach_month:${COACH_F17}|month:2026-09`);
  ck("CO38. Finalised Coach Month with a future payment date: Confirmed OUT of the finalised total + corrections (170.00 + 5.00 = 175.00) on the F12 expected payment date 10-20", !!sep && sep.state === "confirmed" && sep.amount === "175.00" && sep.cashDate === "2026-10-20" && sep.sourceId === FM_SEP.month_id && sep.source.api === `GET /finance/coach-summaries/${FM_SEP.month_id}`);
  const nt = pb.paymentNotTracked;
  ck("CO40. Past payment date: never Overdue, never projected - listed under 'Payment not tracked' with Coach Month, coach, amount, expected payment date and the F12 explanation (Aug finalised 210.00 + Jul open 45.00)", nt.label === "Payment not tracked" && nt.affectsProjection === false && /does not currently track whether a Coach Month was paid/.test(nt.explanation) && nt.months.length === 2 && nt.months.map((x: any) => `${x.workMonth}:${x.amount}:${x.expectedPaymentDate}:${x.finalised}`).join("|") === "2026-07:45.00:2026-08-20:false|2026-08:210.00:2026-09-20:true" && nt.months[1].monthId === FM_AUG.month_id && nt.months[1].coach === "ZZTEST F17 Coach" && !keyOf(pb, (e: any) => e.sourceType === "coach_month" && e.state === "overdue").length, JSON.stringify(nt));
  ck("CO39. No Coach Paid state is invented: no coach event is Actual, no route / table / field records a coach payment", !keyOf(pb, (e: any) => e.sourceType === "coach_month" && e.state === "actual").length && !T_("finance_worker_cost_months").some((m: any) => "paid" in m || "paid_at" in m));

  // ---- projection arithmetic, ordering, end, low (brief 8-13) ----
  const incl = (pb.timeline as any[]).filter((e) => e.includedInProjection);
  let run = 1000000;
  let ok = true;
  for (const e of incl) {
    run += (e.direction === "in" ? 1 : -1) * (pence(e.amount) as number);
    if (pence(e.projectedBalanceAfter) !== run) ok = false;
  }
  ck("TL8/TL9. Every included event shows the projected balance AFTER it: IN adds, OUT subtracts, from the Management-entered balance", ok && incl.length > 10);
  const dates = (pb.timeline as any[]).map((e) => e.cashDate);
  const sorted = [...(pb.timeline as any[])].sort((x, y) => compareEvents({ ...x, sourceId: x.sourceId, key: x.key }, { ...y, sourceId: y.sourceId, key: y.key }));
  const today = (pb.timeline as any[]).filter((e) => e.cashDate === "2026-10-15").map((e) => e.sourceType);
  ck("TL10. Same-date order is deterministic: date, OUT before IN, source type, source id (today: employment_cost before supplier_instalment x2)", dates.join() === [...dates].sort().join() && sorted.every((e, k) => e.key === pb.timeline[k].key) && today.join() === "employment_cost,supplier_instalment,supplier_instalment" && /money out before money in/.test(pb.ordering));
  ck("TL11. Projected end balance = 10070.00 - OUT 5925.00 + IN 1400.00 = 5545.00", pb.summary.projectedEndBalance === "5545.00", pb.summary.projectedEndBalance);
  ck("TL12/TL13. Projected low = 5545.00 on 2026-11-12 (after the November employment estimate)", pb.summary.projectedLow === "5545.00" && pb.summary.projectedLowDate === "2026-11-12", `${pb.summary.projectedLow} ${pb.summary.projectedLowDate}`);
  ck("AU63. Reads are never audited (Cash Flow + balance history)", world.audit.length === a0 && (await balanceHistory()).httpStatus === 200 && world.audit.length === a0);

  // =================================================================
  // RG. Ranges + organisation-local date (brief 14-17)
  // =================================================================
  const m3 = await cashFlow({ range: "3m" });
  ck("RG15. 3 months = today .. the day before the same date three calendar months later (2026-10-15 -> 2027-01-14); more events (venue Nov, transport 11-30, coach Oct open, Dec / Jan employment)", m3.body.rangeEnd === "2027-01-14" && !!ev(m3.body, `out:supplier_instalment:${V_NOV}`) && !!ev(m3.body, `out:supplier_instalment:${I5}`) && !!ev(m3.body, `out:employment_cost:${E2}|month:2027-01`) && !ev(m3.body, `out:employment_cost:${E1}|month:2027-01`));
  ck("RG14. 30 days = today .. today + 29 (2026-10-15 -> 2026-11-13); calendar arithmetic incl. month ends", rangeEnd("2026-10-15", "30d") === "2026-11-13" && rangeEnd("2026-11-30", "3m") === "2027-02-27" && rangeEnd("2026-10-02", "3m") === "2027-01-01" && rangeEnd("2027-01-31", "3m") === "2027-04-29" && addCalendarMonths("2026-01-31", 1) === "2026-02-28");
  const coachOct = ev(m3.body, `out:coach_month:${COACH_F17}|month:2026-10`);
  ck("CO38b. Open (not finalised) Coach Month with a future payment date: Estimated OUT of the CURRENT live allocation cost (45.00 + 45.00; one item not priced yet) on 11-20, flagged 'may change until the month is finalised'", !!coachOct && coachOct.state === "estimated" && coachOct.amount === "90.00" && coachOct.cashDate === "2026-11-20" && coachOct.context.unpricedItems === 1 && coachOct.context.finalised === false && /may change until the month is finalised/.test(coachOct.context.note) && coachOct.source.api === "GET /finance/coach-costs/COACH-F17/2026-10");
  const oldNow = world as any;
  void oldNow;
  ck("RG17. Unresolved overdue items stay visible whatever the range (INV2 due 10-01 and transport due 10-05 are before the range start)", !!ev(m3.body, `in:receivable:${INV2.invoiceId}`) && !!ev(m3.body, `out:supplier_instalment:${I1}`) && !!ev(pb, `in:receivable:${INV2.invoiceId}`));
  // organisation-local date: London 2026-10-15 00:30 BST is 2026-10-14 23:30 UTC
  const lateNight = buildCashFlow({ ...baseInputs(), today: "2026-10-14" });
  const pureToday = buildCashFlow({ ...baseInputs(), today: "2026-10-15" });
  ck("RG16. Organisation-local date decides today: the pure engine shifts overdue / due-today by the organisation's calendar day, and the orchestrator uses todayIn(timezone) (UTC 23:30 on 10-14 is already 10-15 in London)", lateNight.events.find((e) => e.key === "out:supplier_instalment:FSI-T1")!.daysOverdue === 9 && pureToday.events.find((e) => e.key === "out:supplier_instalment:FSI-T1")!.daysOverdue === 10 && /todayIn\(org\.timezone, now\(deps\)\)/.test(readFileSync(join(CANON, "finance", "finance-cash-flow-orchestrator.ts"), "utf8")));

  // MB. Boundaries pinned by the mutation pass (pure engine)
  {
    const rcpt = (id: string, date: string, amount: number) => ({ kind: "invoice_payment" as const, receiptId: id, invoiceId: "INV-T", clientId: "CLI-T", clientName: "T", amountMinor: amount, receivedDate: date });
    const recv = (id: string, due: string, amount: number) => ({ invoiceId: id, clientId: "CLI-T", clientName: "T", officialNumber: id, grossMinor: amount, outstandingMinor: amount, cashReceivedMinor: 0, creditAppliedMinor: 0, creditNotesMinor: 0, dueDate: due, originalDueDate: due });
    const onAsAt = buildCashFlow({ ...baseInputs(), instalments: [], receipts: [rcpt("PAY-ASAT", "2026-10-01", 50000), rcpt("PAY-AFTER", "2026-10-02", 20000)] });
    ck("MB1. A movement dated ON the balance as-at date is assumed to be in that balance (never applied twice); the day after is applied", onAsAt.balanceTodayMinor === 120000 && !onAsAt.events.some((e) => e.sourceId === "PAY-ASAT") && onAsAt.events.some((e) => e.sourceId === "PAY-AFTER" && e.state === "actual"), String(onAsAt.balanceTodayMinor));
    const upOnly = buildCashFlow({ ...baseInputs(), instalments: [], receivables: [recv("INV-UP", "2026-10-20", 50000)], thresholdMinor: 100000 });
    ck("MB2. Today's position counts: when only money comes in, the projected low is today's balance (on today), and a low EXACTLY at the threshold is not a breach", upOnly.projectedLowMinor === 100000 && upOnly.projectedLowDate === "2026-10-15" && upOnly.thresholdBreached === false && upOnly.firstBreachDate === null && upOnly.projectedEndMinor === 150000, `${upOnly.projectedLowMinor}/${upOnly.projectedLowDate}/${upOnly.thresholdBreached}`);
    const inst = baseInputs().instalments[0];
    const down = (t: number) => buildCashFlow({ ...baseInputs(), instalments: [{ ...inst, instalmentId: "FSI-T9", dueDate: "2026-10-20", originalDueDate: "2026-10-20", plannedMinor: 30000, amountDueMinor: 30000 }], thresholdMinor: t });
    const eq = down(70000), below = down(70001);
    ck("MB3. Threshold boundary: projected low 700.00 on 10-20 with threshold 700.00 -> not breached, no breach date; threshold 700.01 -> breached, first breach 10-20", eq.projectedLowMinor === 70000 && eq.thresholdBreached === false && eq.firstBreachDate === null && below.thresholdBreached === true && below.firstBreachDate === "2026-10-20", `${eq.thresholdBreached}/${eq.firstBreachDate}/${below.firstBreachDate}`);
  }

  // D1. Today only: Actual movements first, then today's forecasts (approved 2026-10-02)
  {
    const T = "2026-10-15", Y = "2026-10-14";
    const inst0 = baseInputs().instalments[0];
    const inst = (id: string, due: string, amount: number, paid = 0) => ({ ...inst0, instalmentId: id, dueDate: due, originalDueDate: due, plannedMinor: amount, amountDueMinor: amount, paidMinor: paid });
    const pay = (id: string, instalmentId: string, amount: number, date: string) => ({ organisationId: ORG, paymentId: id, instalmentId, supplierId: "FSU-T", amountMinor: amount, paidDate: date, method: null, reference: null, note: null, createdAt: "", createdBy: MGR });
    const rcpt = (id: string, date: string, amount: number) => ({ kind: "invoice_payment" as const, receiptId: id, invoiceId: "INV-T", clientId: "CLI-T", clientName: "T", amountMinor: amount, receivedDate: date });
    const recv = (id: string, due: string, amount: number) => ({ invoiceId: id, clientId: "CLI-T", clientName: "T", officialNumber: id, grossMinor: amount, outstandingMinor: amount, cashReceivedMinor: 0, creditAppliedMinor: 0, creditNotesMinor: 0, dueDate: due, originalDueDate: due });
    const d1 = (o: Record<string, unknown>) => buildCashFlow({ ...baseInputs(), today: T, balance: { ...baseInputs().balance, amountMinor: 100000, asAtDate: Y }, instalments: [], ...o } as any);
    const row = (cf: any, key: string) => cf.events.find((e: any) => e.key === key);
    const todayKeys = (cf: any) => cf.events.filter((e: any) => e.cashDate === T).map((e: any) => `${e.state}:${e.key}`);
    const actualFirst = (cf: any) => { const st = cf.events.filter((e: any) => e.cashDate === T).map((e: any) => e.state === "actual"); return st.indexOf(false) === -1 || st.slice(st.indexOf(false)).every((a: boolean) => !a); };

    // The approved example: 1000.00 as at yesterday, Actual OUT 300.00 today, Confirmed OUT 100.00 due today, threshold 601.00
    const ex = d1({ thresholdMinor: 60100, instalments: [inst("FSI-PAID", T, 30000, 30000), inst("FSI-DUE", T, 10000)], supplierPayments: [pay("FSP-T1", "FSI-PAID", 30000, T)] });
    const exView = cashFlowView(ex, "position") as any;
    ck("D1-1. Actual OUT today + forecast OUT today (the approved example): after the Actual 700.00, after the due-today OUT 600.00; low 600.00; breached; 1.00 below", row(ex, "out:supplier_payment:FSP-T1").balanceAfterMinor === 70000 && row(ex, "out:supplier_instalment:FSI-DUE").balanceAfterMinor === 60000 && ex.balanceTodayMinor === 70000 && ex.projectedLowMinor === 60000 && ex.projectedLowDate === T && ex.thresholdBreached === true && exView.summary.belowThresholdBy === "1.00" && todayKeys(ex).join() === "actual:out:supplier_payment:FSP-T1,confirmed:out:supplier_instalment:FSI-DUE", todayKeys(ex).join() + ` low=${ex.projectedLowMinor}`);
    ck("D1-2. The breach exists only after the forecast movement: today's position 700.00 is above 601.00, the forecast takes it to 600.00 -> first breach today", ex.balanceTodayMinor! >= 60100 && ex.firstBreachDate === T);
    ck("D1-3. The projected low sees the end-of-day balance (= the last row of today, = the projected end here)", ex.projectedLowMinor === ex.events.filter((e: any) => e.cashDate === T).slice(-1)[0].balanceAfterMinor && ex.projectedEndMinor === 60000);

    const inOut = d1({ thresholdMinor: 105000, receipts: [rcpt("FPY-T1", T, 20000)], instalments: [inst("FSI-DUE", T, 10000)] });
    ck("D1-4. Actual IN today + forecast OUT today: the receipt is applied first (1200.00), then the OUT (1100.00); low 1100.00, not an understated 900.00; threshold 1050.00 not breached", todayKeys(inOut).join() === "actual:in:client_receipt:FPY-T1,confirmed:out:supplier_instalment:FSI-DUE" && row(inOut, "in:client_receipt:FPY-T1").balanceAfterMinor === 120000 && row(inOut, "out:supplier_instalment:FSI-DUE").balanceAfterMinor === 110000 && inOut.projectedLowMinor === 110000 && inOut.thresholdBreached === false, `${todayKeys(inOut)} low=${inOut.projectedLowMinor}`);

    const outIn = d1({ thresholdMinor: 70000, instalments: [inst("FSI-PAID", T, 30000, 30000)], supplierPayments: [pay("FSP-T1", "FSI-PAID", 30000, T)], receivables: [recv("FIV-T1", T, 5000)] });
    ck("D1-5. Actual OUT today + forecast IN today: Actual first (700.00), then the IN (750.00); low = today's position 700.00; threshold 700.00 not breached", todayKeys(outIn).join() === "actual:out:supplier_payment:FSP-T1,confirmed:in:receivable:FIV-T1" && row(outIn, "in:receivable:FIV-T1").balanceAfterMinor === 75000 && outIn.projectedLowMinor === 70000 && outIn.projectedLowDate === T && outIn.thresholdBreached === false, `${todayKeys(outIn)} low=${outIn.projectedLowMinor}`);

    const multi = d1({ thresholdMinor: 66000, instalments: [inst("FSI-PA", T, 10000, 10000), inst("FSI-PB", T, 20000, 20000), inst("FSI-DUE", T, 10000)], supplierPayments: [pay("FSP-T2", "FSI-PB", 20000, T), pay("FSP-T1", "FSI-PA", 10000, T)], receipts: [rcpt("FPY-T1", T, 5000)], receivables: [recv("FIV-T1", T, 2000)] });
    ck("D1-6. Several Actual movements today: all Actuals first (in their own OUT-before-IN / source order), then today's forecasts (OUT before IN); today's position 750.00; end of today 670.00; low 650.00 after the forecast OUT; threshold 660.00 breached today", actualFirst(multi) && todayKeys(multi).join() === "actual:out:supplier_payment:FSP-T1,actual:out:supplier_payment:FSP-T2,actual:in:client_receipt:FPY-T1,confirmed:out:supplier_instalment:FSI-DUE,confirmed:in:receivable:FIV-T1" && multi.balanceTodayMinor === 75000 && multi.projectedLowMinor === 65000 && multi.projectedEndMinor === 67000 && multi.firstBreachDate === T, `${todayKeys(multi)} today=${multi.balanceTodayMinor} low=${multi.projectedLowMinor}`);

    const fut = "2026-10-20";
    ck("D1-7. Future dates keep the approved order exactly (OUT before IN, source type, source id): the Actual rule applies to today only", compareEvents({ cashDate: fut, direction: "in", sourceType: "client_receipt", sourceId: "A", key: "a", state: "actual" }, { cashDate: fut, direction: "out", sourceType: "supplier_instalment", sourceId: "B", key: "b", state: "confirmed" }, T) > 0 && compareEvents({ cashDate: T, direction: "in", sourceType: "client_receipt", sourceId: "A", key: "a", state: "actual" }, { cashDate: T, direction: "out", sourceType: "supplier_instalment", sourceId: "B", key: "b", state: "confirmed" }, T) < 0 && compareEvents({ cashDate: T, direction: "in", sourceType: "receivable", sourceId: "A", key: "a", state: "confirmed" }, { cashDate: T, direction: "out", sourceType: "supplier_instalment", sourceId: "B", key: "b", state: "overdue" }, T) > 0);
    ck("D1-8. No date is rewritten: every Actual keeps its own cash date; overdue OUT still keeps its true due date", row(ex, "out:supplier_payment:FSP-T1").cashDate === T && row(multi, "in:client_receipt:FPY-T1").cashDate === T && /Today only: cash that has already moved/.test(exView.ordering));
  }

  // =================================================================
  // VW. Views (brief 45-48)
  // =================================================================
  const mi = (await cashFlow({ view: "money-in" })).body;
  const mo = (await cashFlow({ view: "money-out" })).body;
  ck("VW45. Cash Position = every event (in + out) of the one timeline", pb.timeline.length === mi.timeline.length + mo.timeline.length && pb.timeline.some((e: any) => e.direction === "in") && pb.timeline.some((e: any) => e.direction === "out"));
  ck("VW46. Money In = the same timeline filtered IN (same keys, same projected balances)", mi.timeline.every((e: any) => e.direction === "in") && mi.timeline.every((e: any) => JSON.stringify(e) === JSON.stringify(ev(pb, e.key))));
  ck("VW47. Money Out = the same timeline filtered OUT (same keys, same projected balances); Payment not tracked is shown with Money Out, not Money In", mo.timeline.every((e: any) => e.direction === "out") && mo.timeline.every((e: any) => JSON.stringify(e) === JSON.stringify(ev(pb, e.key))) && mo.paymentNotTracked !== null && mi.paymentNotTracked === null);
  const sum = (a: string, b: string) => ((pence(a) as number) + (pence(b) as number)) / 100;
  ck("VW48. Totals reconcile: Position = Money In + Money Out for every total; the summary (projected balance) is identical in every view", ["actualIn", "actualOut", "expectedIn", "expectedOut", "overdueIn", "overdueOut", "includedIn", "includedOut"].every((k) => (pence(pb.totals[k]) as number) / 100 === sum(mi.totals[k], mo.totals[k])) && pb.reconciliation.reconciles && JSON.stringify(mi.summary) === JSON.stringify(pb.summary) && JSON.stringify(mo.summary) === JSON.stringify(pb.summary));

  // =================================================================
  // TH. Threshold (brief 49-51)
  // =================================================================
  ck("TH49. No threshold: no breach, no warning (thresholdBreached null, message says no cash-risk warning)", pb.summary.safetyThreshold === null && pb.summary.thresholdBreached === null && pb.summary.firstBreachDate === null && /No cash safety threshold/.test(pb.summary.message));
  setSettings({ paymentDay: 20, thresholdMinor: 600000 });
  const th = (await cashFlow()).body;
  ck("TH50. Threshold 6000.00 above the projected low 5545.00: breached, 455.00 below", th.summary.safetyThreshold === "6000.00" && th.summary.thresholdBreached === true && th.summary.belowThresholdBy === "455.00");
  ck("TH51. First breach date = 2026-10-25: the employment OUT is applied before the invoice IN on the same day (the cautious low), so the balance first dips below 6000.00 then", th.summary.firstBreachDate === "2026-10-25" && /below the cash safety threshold on 2026-10-25/.test(th.summary.message));
  setSettings({ paymentDay: 20, thresholdMinor: 500000 });
  const th2 = (await cashFlow()).body;
  ck("TH50b. Threshold 5000.00 below the low: not breached; headroom 545.00", th2.summary.thresholdBreached === false && th2.summary.firstBreachDate === null && th2.summary.headroomAboveThreshold === "545.00");
  setSettings({ paymentDay: 20 });

  // =================================================================
  // DD. Dedupe / supersession / identity (brief 41-44)
  // =================================================================
  const before = (await cashFlow()).body;
  const c1 = await monthAct(E1, "2026-10", "confirm-estimate", { amount: "1950.00", reason: "ZZTEST unpaid day" });
  const after = (await cashFlow()).body;
  const e1b = ev(after, `out:employment_cost:${E1}|month:2026-10`);
  ck("DD41. Estimate -> confirmed stays ONE economic event: same key, state Confirmed, new amount 1950.00 - never an extra event", c1.httpStatus === 200 && !!e1b && e1b.state === "confirmed" && e1b.amount === "1950.00" && after.timeline.length === before.timeline.length && keyOf(after, (e: any) => e.key.startsWith(`out:employment_cost:${E1}|month:2026-10`)).length === 1);
  const PAY1 = payment(11, INV1, 110000, "2026-10-15");
  setF7({ ...F7, payments: [PAY2, PAY3, PAY1] });
  const rec1 = (await cashFlow()).body;
  ck("DD42. Invoice -> receipt: once INV1 is received in full (10-15, after the balance date) its expected IN disappears and the receipt is ONE Actual IN - never both", !ev(rec1, `in:receivable:${INV1.invoiceId}`) && ev(rec1, `in:client_receipt:${PAY1.paymentId}`)?.state === "actual" && ev(rec1, `in:client_receipt:${PAY1.paymentId}`)?.amount === "1100.00" && rec1.summary.projectedEndBalance === after.summary.projectedEndBalance);
  ck("DD43. Supplier credit has no duplicate cash effect: exactly one OUT for the instalment (500.00), no IN, and the projection subtracts 500.00 once", keyOf(rec1, (e: any) => e.sourceId === I4).length === 1 && keyOf(rec1, (e: any) => e.context?.instalmentId === I4 || e.sourceId === CR).length === 0);
  const rev1 = paymentReversal(11, PAY1);
  setF7({ ...F7, payments: [PAY2, PAY3, PAY1], reversals: [rev1] });
  const revd = (await cashFlow()).body;
  ck("DD42b. A payment reversed (recorded in error) is not cash: the Actual disappears and the invoice is expected again", !ev(revd, `in:client_receipt:${PAY1.paymentId}`) && ev(revd, `in:receivable:${INV1.invoiceId}`)?.amount === "1100.00");
  const OVP = overpaymentCredit(12, { sourceInvoiceId: INV5.invoiceId, sourcePaymentId: "FPY-000000000099", original: 2500, receivedDate: "2026-10-14" });
  setF7({ ...F7, credits: [CC3, OVP] });
  const ovp = (await cashFlow()).body;
  ck("MI25b. Cash kept as client credit from an overpayment WAS cash received (Actual IN on its received date) - the credit itself is not a further movement", ev(ovp, `in:client_receipt:${OVP.creditId}`)?.state === "actual" && ev(ovp, `in:client_receipt:${OVP.creditId}`)?.amount === "25.00");
  setF7({ ...F7, dueChanges: [dueChange(1, INV1, "2026-10-25", "2026-11-05")] });
  const moved = (await cashFlow()).body;
  ck("DD44. Stable identity: moving INV1's due date (F7's own due-date change record) keeps ONE event with the same key on the new date - no stale duplicate; the original date is kept", keyOf(moved, (e: any) => e.sourceId === INV1.invoiceId).length === 1 && ev(moved, `in:receivable:${INV1.invoiceId}`).cashDate === "2026-11-05" && ev(moved, `in:receivable:${INV1.invoiceId}`).originalDueDate === "2026-10-25" && ev(moved, `in:receivable:${INV1.invoiceId}`).context.dueDateMoved === true);
  const again = (await cashFlow()).body;
  ck("DD44b. Deterministic: two reads of unchanged data give byte-identical timelines (no storage-order or clock dependence)", JSON.stringify(again.timeline) === JSON.stringify(moved.timeline));
  setF7(F7);
  const pE2 = await monthAct(E2, "2026-10", "payment", { amount: "1000.00", paidDate: "2026-10-15" });
  const paid = (await cashFlow()).body;
  ck("MO36b. Employment paid after the balance date: ONE Actual OUT (1000.00 on 10-15) replaces the overdue requirement - never both", pE2.httpStatus === 201 && !ev(paid, `out:employment_cost:${E2}|month:2026-10`) && keyOf(paid, (e: any) => e.sourceType === "employment_payment" && e.amount === "1000.00" && e.cashDate === "2026-10-15").length === 1, JSON.stringify({ s: pE2.httpStatus, c: pE2.code, e: pE2.error, ev: keyOf(paid, (e: any) => /employment/.test(e.sourceType)).map((e: any) => e.key + " " + e.state + " " + e.amount + " " + e.cashDate) }));

  // =================================================================
  // SO. Source ownership (brief 1-2)
  // =================================================================
  const types = new Set((m3.body.timeline as any[]).map((e) => e.sourceType));
  ck("SO1. Every included source has an authoritative amount + cash date: F7 receivable (due date), F7 receipt (received date), F13 instalment / payment, F15 month / payment, F12 Coach Month (expected payment date) - each event names its source type, id and API", [...types].every((t) => ["receivable", "client_receipt", "supplier_instalment", "supplier_payment", "employment_cost", "employment_payment", "coach_month"].includes(t)) && (m3.body.timeline as any[]).every((e) => e.source.type === e.sourceType && e.source.id && /^GET \/finance\//.test(e.source.api) && /^\d{4}-\d{2}-\d{2}$/.test(e.cashDate)));
  ck("SO2. Unsupported sources are excluded, never guessed: Stripe, pre-invoice revenue, awaiting-issue invoices, Refund Due, VAT / PAYE each listed under notIncluded with the reason", ["stripe", "preInvoiceRevenue", "awaitingIssue", "refundDue", "taxLiabilities"].every((k) => m3.body.notIncluded[k].included === false && m3.body.notIncluded[k].reason) && NOT_INCLUDED.stripe.reason === "Stripe bank payout timing is not currently available.");

  // =================================================================
  // BA6 / BA5 / BA7. History + latest + concurrency
  // =================================================================
  const { r: b2, ev: b2Ev } = await added(() => balanceNew({ amount: "9500.00", asAtDate: "2026-10-14" }));
  const h = await balanceHistory();
  ck("BA5. Append-only history: the earlier balance is kept, never overwritten (2 rows, sequence 1, 2); note optional (none here)", b2.httpStatus === 201 && h.body.history.length === 2 && h.body.history[0].amount === "10000.00" && h.body.history[1].amount === "9500.00" && h.body.history.map((x: any) => x.sequence).join() === "1,2" && b2.body.balance.note === null && b2Ev[0].before.amountMinor === 1000000);
  ck("BA6. The latest valid balance (latest as-at date) is the projection starting point", h.body.current.amount === "9500.00" && h.body.current.isProjectionStart && (await cashFlow()).body.summary.currentBalance === "9500.00");
  const back = await balanceNew({ amount: "1.00", asAtDate: "2026-10-01", note: "ZZTEST back-filled older statement" });
  ck("BA6b. A back-filled OLDER statement is kept in history but does not replace the start (latest as-at date wins; same date -> latest entry)", back.httpStatus === 201 && /later as-at date remains/.test(back.body.note) && (await cashFlow()).body.summary.currentBalance === "9500.00" && latestBalance([{ asAtDate: "2026-10-14", sequence: 2 } as BankBalance, { asAtDate: "2026-10-14", sequence: 5 } as BankBalance])!.sequence === 5);
  const fut = await balanceNew({ amount: "1.00", asAtDate: "2026-10-16" });
  ck("BA3b. The as-at date may not be after the organisation's today (409 as_at_in_future, nothing written, not audited)", fut.httpStatus === 409 && fut.code === "as_at_in_future" && T_("finance_bank_balances").length === 3);
  const n0 = T_("finance_bank_balances").length;
  const a1 = world.audit.length;
  const [x1, x2] = await Promise.all([balanceNew({ amount: "100.00", asAtDate: "2026-10-15" }), balanceNew({ amount: "200.00", asAtDate: "2026-10-15" })]);
  ck("BA7. Concurrent balance updates: the shared Finance write lock lets exactly one through (201) and refuses the other (409 finance_commercial_busy); one row, one audit row - no ambiguous latest", [x1, x2].filter((x) => x.httpStatus === 201).length === 1 && [x1, x2].some((x) => x.code === "finance_commercial_busy") && T_("finance_bank_balances").length === n0 + 1 && world.audit.length === a1 + 1);
  cfFake.staleExpected = true;
  const stale = await balanceNew({ amount: "300.00", asAtDate: "2026-10-15" });
  cfFake.staleExpected = false;
  ck("BA7b. Database backstop: a write planned on a stale latest sequence is refused (f17:balance_changed -> 409), nothing written", stale.httpStatus === 409 && stale.code === "balance_changed" && T_("finance_bank_balances").length === n0 + 1);
  ck("DB1. History is append-only at the database: UPDATE / DELETE refused (f17:history_is_append_only)", directBalanceWrite().message === "f17:history_is_append_only");
  let dupSeq = false;
  try {
    balanceRpc({ p_balance: { ...T_("finance_bank_balances")[0], balance_id: "FBB-ABCDEF000000" }, p_expected_sequence: T_("finance_bank_balances").length, p_events: [{}] });
  } catch (e) {
    dupSeq = /balance_changed/.test(String(e));
  }
  ck("DB2. One row per sequence per organisation (a re-used sequence is refused)", dupSeq);
  cfFake.balanceRpcFail = true;
  const down = await balanceNew({ amount: "1.00", asAtDate: "2026-10-15" });
  cfFake.balanceRpcFail = false;
  ck("DB3. A database failure writes nothing and says so (503, nothing saved)", down.httpStatus === 503 && /nothing was saved/.test(down.error));

  // =================================================================
  // AC. Access (brief 55-61)
  // =================================================================
  const v = await cashFlow({}, viewer);
  const vh = await balanceHistory(viewer);
  ck("AC55. Finance View reads Cash Flow and the balance history", v.httpStatus === 200 && v.body.access === "view" && vh.httpStatus === 200);
  const vw = await balanceNew({ amount: "1.00", asAtDate: "2026-10-15" }, viewer);
  ck("AC56. Finance View cannot record a balance (403 finance_manage_required, nothing written)", vw.httpStatus === 403 && vw.code === "finance_manage_required");
  ck("AC57. Finance Manage records a balance (201 above) and reads", b1.httpStatus === 201 && b1.body.access === "manage");
  const ng = await cashFlow({}, nogrant);
  const ngh = await balanceHistory(nogrant);
  ck("AC58. No Finance grant: 403 finance_access_denied - no amount or balance is exposed", ng.httpStatus === 403 && ng.code === "finance_access_denied" && !ng.body && ngh.code === "finance_access_denied");
  const co = await cashFlow({}, coach);
  const pa = await balanceNew({ amount: "1.00", asAtDate: "2026-10-15" }, parent);
  ck("AC59. Coach / Parent: 403 management_required", co.code === "management_required" && pa.code === "management_required");
  world.moduleOn = false;
  const off = await cashFlow();
  const offW = await balanceNew({ amount: "1.00", asAtDate: "2026-10-15" });
  world.moduleOn = true;
  ck("AC60. Finance module off: 403 finance_module_disabled for reads and writes", off.code === "finance_module_disabled" && offW.code === "finance_module_disabled");
  const t1 = parseCashQuery("cash.read", new URLSearchParams({ organisationId: "ORG-OTHER" }), isTenantKey);
  const t2 = parseBalance(JSON.stringify({ amount: "1.00", asAtDate: "2026-10-15", organisation_id: "ORG-OTHER" }), isTenantKey);
  const t3 = parseCashQuery("balance.history", new URLSearchParams({ org: "x" }), isTenantKey);
  ck("AC61. Tenant override rejected (400 tenant_param_rejected) in the query and the body", !t1.ok && t1.code === "tenant_param_rejected" && !t2.ok && t2.code === "tenant_param_rejected" && !t3.ok);
  const audits = world.audit.filter((e: any) => e.event_type === BALANCE_EVENT).length;
  ck("AU62b. Exactly one audit row per recorded balance (4 recorded -> 4 rows); refusals / reads add none", audits === T_("finance_bank_balances").length && audits === 4);

  // =================================================================
  // Parsing + routes
  // =================================================================
  const q1 = parseCashQuery("cash.read", new URLSearchParams({ range: "90d" }), isTenantKey);
  const q2 = parseCashQuery("cash.read", new URLSearchParams({ view: "all" }), isTenantKey);
  const q3 = parseCashQuery("cash.read", new URLSearchParams({ from: "2026-10-01" }), isTenantKey);
  ck("PR1. Query: range 30d | 3m, view position | money-in | money-out; anything else 400", !q1.ok && !q2.ok && !q3.ok && q3.code === "unexpected_query");
  const bb = [parseBalance("{}", isTenantKey), parseBalance(JSON.stringify({ amount: "abc", asAtDate: "2026-10-15" }), isTenantKey), parseBalance(JSON.stringify({ amount: "1.00", asAtDate: "2026-02-30" }), isTenantKey), parseBalance(JSON.stringify({ amount: "1.00", asAtDate: "2026-10-15", note: "x".repeat(501) }), isTenantKey), parseBalance(JSON.stringify({ amount: "1.00", asAtDate: "2026-10-15", extra: 1 }), isTenantKey)];
  const neg = parseBalance(JSON.stringify({ amount: "-250.50", asAtDate: "2026-10-15" }), isTenantKey);
  ck("PR2. Balance body: amount + real date required, note <= 500, no extra fields; an overdrawn (negative) balance is allowed", bb.every((x) => !x.ok) && neg.ok && neg.req.amountMinor === -25050);
  ck("PR3. Routes: GET cash-flow, GET cash-flow/balance-history, POST cash-flow/balance; wrong method 405; other paths are not F17's", matchCashFlowRoute("cash-flow", "GET")?.status === "ok" && matchCashFlowRoute("cash-flow/balance", "GET")?.status === "method" && matchCashFlowRoute("cash-flow/balance-history", "POST")?.status === "method" && matchCashFlowRoute("cash-flows", "GET") === null && matchCashFlowRoute("supplier-instalments", "GET") === null);

  // =================================================================
  // F2 threshold setting + drift
  // =================================================================
  const s1 = parseUpdateBody(JSON.stringify({ settings: { cashSafetyThresholdMinor: 500000 } }), isTenantKey);
  const s2 = parseUpdateBody(JSON.stringify({ settings: { cashSafetyThresholdMinor: -1 } }), isTenantKey);
  const s3 = parseUpdateBody(JSON.stringify({ settings: { cashSafetyThresholdMinor: null } }), isTenantKey);
  ck("TH-SET. Cash Safety Threshold is an optional F2 Finance Setting in pence (POST /settings, audited there as finance_settings.updated); null clears it; negative refused", SETTINGS_KEYS.includes("cashSafetyThresholdMinor") && FIELD_NAMES.cashSafetyThresholdMinor === "Cash Safety Threshold (Pence)" && s1.ok && !s2.ok && s3.ok && FIELD_VALIDATORS.cashSafetyThresholdMinor(12.5).ok === false);
  const mirror = (f: string) => {
    const canon = readFileSync(join(CANON, "finance", f), "utf8").replace(/from "\.\/orchestrator\.ts"/g, 'from "./finance-orchestrator.ts"').replace(/from "\.\/repository\.ts"/g, 'from "./finance-repository.ts"');
    const copy = readFileSync(join(HERE, f), "utf8");
    return copy.slice(copy.indexOf("/**", 3)) === canon;
  };
  ck("Z1. Test copies == canonical (finance-cash-flow.ts, -repository.ts, -orchestrator.ts, finance-settings.ts; only import paths adjusted)", ["finance-cash-flow.ts", "finance-cash-flow-repository.ts", "finance-cash-flow-orchestrator.ts", "finance-settings.ts"].every(mirror));
  const idx = readFileSync(join(CANON, "finance", "index.ts"), "utf8");
  const orch = readFileSync(join(CANON, "finance", "finance-cash-flow-orchestrator.ts"), "utf8");
  // F21's refund facts come through its pure rule + database reader only (never a Stripe provider or orchestrator).
  const orchImports = orch.split("\n").filter((l) => /^import|^\} from/.test(l) && !/^import \{ refundCashInfo \} from "\.\/finance-stripe-refunds\.ts";$|^import \{ loadRefundCashFacts \} from "\.\/finance-stripe-refunds-repository\.ts";$/.test(l)).join("\n");
  ck("Z2. index.ts routes cash-flow first (before F13) through handleCashFlow; the orchestrator imports no Stripe module and no source write - its only write is recordBalance (the F17 balance function)", /const cashFlow = matchCashFlowRoute\(route, req\.method\);/.test(idx) && idx.indexOf("matchCashFlowRoute(route") < idx.indexOf("matchSupplierRoute(route") && !/stripe|xero|family/i.test(orchImports) && !/finance-stripe-(provider|refund-provider|orchestrator|refunds-orchestrator)/.test(orch) && !/(changeInstalment|recordAgreement|changeItem|finaliseMonth|correctMonth|create\w*Row|patch\w*Row|insertAuditEvent)/.test(orch));
  const engine = readFileSync(join(CANON, "finance", "finance-cash-flow.ts"), "utf8");
  ck("Z3. The engine never uses profitability dates (work dates, occurrence dates, billing periods): only invoice due dates, received / paid dates, instalment due dates, expected pay dates and F12 expected payment dates", !/workDate|occurrenceDate|periodFrom|periodTo|work_date/.test(engine));
  ck("Z4. Month Report is not F17's: cash-flow never matches month-report (F18 owns it, routed before F17) and F17 reads no reporting month", matchCashFlowRoute("month-report", "GET") === null && idx.indexOf("matchMonthReportRoute(route") < idx.indexOf("matchCashFlowRoute(route"));

  // totals helper sanity
  ck("TL-T. totalsOf: actual / expected / estimated / overdue / included are disjoint where they should be", (() => {
    const t = totalsOf(pb.timeline.map((e: any) => ({ ...e, amountMinor: pence(e.amount), included: e.includedInProjection })) as any);
    return t.includedOut === (pence(pb.totals.includedOut) as number) && t.overdueIn === 50000;
  })());
  void cashFlowView;
}

/** A small hand-built input set for the pure engine (organisation-local date check). */
function baseInputs() {
  const inst = (id: string, due: string, amount: number) => ({ organisationId: ORG, instalmentId: id, agreementId: "FSA-T", supplierId: "FSU-T", sequence: 1, originalDueDate: due, dueDate: due, plannedMinor: amount, amountDueMinor: amount, amountState: "confirmed" as const, paidMinor: 0, creditedMinor: 0, splitFromInstalmentId: null, note: null, cancelledAt: null, cancelledBy: null, cancelReason: null, createdAt: "", createdBy: "" });
  return {
    organisationId: ORG,
    today: "2026-10-15",
    range: "30d" as const,
    balance: { organisationId: ORG, balanceId: "FBB-000000000001", sequence: 1, amountMinor: 100000, asAtDate: "2026-10-01", note: null, recordedAt: "", recordedBy: MGR },
    thresholdMinor: null,
    receivables: [],
    receipts: [],
    awaitingIssue: { count: 0, grossMinor: 0 },
    suppliers: [{ supplierId: "FSU-T", name: "T", supplierType: "other" as const }],
    instalments: [inst("FSI-T1", "2026-10-05", 1000)],
    supplierPayments: [],
    employmentVersions: [],
    employmentItems: [],
    coachMonths: [],
    coachPaymentDayConfigured: true,
  };
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
