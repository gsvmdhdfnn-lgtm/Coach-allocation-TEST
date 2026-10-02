/**
 * Needs Attention - Finance F17 cash-risk rule (see TEST-ENV.md "Finance
 * Foundation - F17"):
 *
 *   cash_balance_below_threshold (ATT-054)  the 3-month projected bank balance
 *                                           falls below the organisation's cash
 *                                           safety threshold
 *
 * Derived on every read from F17 truth: the SAME pure Cash Flow engine Finance
 * uses (finance/finance-cash-flow.ts, bundled at build time) over the same
 * sources - F7 receivables (this module's F8a receivable pass), F13 / F14
 * instalments + payments, F15 employment months, F12 Coach Months (stored +
 * open, F12's own workItemsOf), the Management-entered bank balance and the F2
 * threshold. One case per organisation at most; no stored case, no second task
 * system. When the projection no longer breaches (balance recorded, threshold
 * changed, money received, payment moved...) the case disappears by itself.
 *
 * No threshold, or no recorded balance: no case (nothing to compare). The
 * case never claims bank truth: the balance is Management-entered.
 *
 * Read-only and bounded: every source is loaded once per request by the engine
 * (organisation-scoped Supabase reads are paged and fail loudly when too
 * large); a malformed row fails the pass loudly (complete:false +
 * evaluator_error), never a guess. Access: the F8a Finance filter applies
 * unchanged - no Finance grant = no source is read and no case, count or
 * amount is shown; only Finance Manage may snooze it.
 */
import type { CandidateCase, EvaluatorContext, EvaluatorRegistration } from "./needs-attention.ts";
import { FINANCE_TABLES, FinanceDataError, officialNumber, pounds, runReceivablePass } from "./finance.ts";
import { localMidnightIso } from "./work-summaries.ts";
import { instalmentFromRow, itemFromRow, supplierFromRow, versionFromRow } from "./money-out.ts";
import { type Payment } from "../finance/finance-suppliers.ts";
import { type Correction, type CostWorld, type FinanceMonth, TABLES as COST_TABLES } from "../finance/finance-coach-costs.ts";
import { SETTINGS_TABLE, STORED as SETTINGS_FIELDS, fromStoredRow } from "../finance/finance-settings.ts";
import { todayIn } from "../finance/finance-commercial.ts";
import {
  type BankBalance,
  type CashFlow,
  type CashRange,
  CashFlowDataError,
  buildCashFlow,
  cashReceipts,
  coachMonthInputs,
  coachWorkMonths,
  latestBalance,
  rangeEnd,
} from "../finance/finance-cash-flow.ts";

// ===== COPIED FROM finance/finance-suppliers-repository.ts - DO NOT EDIT HERE =====
const int = (v: unknown, what: string): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`${what}: not an integer`);
  return n;
};
const intOrNull = (v: unknown, what: string) => (v === null || v === undefined ? null : int(v, what));
const dateOf = (v: unknown) => String(v).slice(0, 10);
const iso = (v: unknown) => new Date(String(v)).toISOString();
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-suppliers-repository.ts - DO NOT EDIT HERE =====
export const paymentFromRow = (r: Record<string, any>): Payment => ({
  organisationId: r.organisation_id,
  paymentId: r.payment_id,
  instalmentId: r.instalment_id,
  agreementId: r.agreement_id,
  supplierId: r.supplier_id,
  amountMinor: int(r.amount_minor, "amount_minor"),
  paidDate: dateOf(r.paid_date),
  method: r.method ?? null,
  reference: r.reference ?? null,
  note: r.note ?? null,
  remainingAfterMinor: int(r.remaining_after_minor, "remaining_after_minor"),
  recordedAt: iso(r.recorded_at),
  recordedBy: r.recorded_by,
});
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-coach-costs-repository.ts - DO NOT EDIT HERE =====
export const monthFromRow = (r: Record<string, any>): FinanceMonth => ({
  organisationId: r.organisation_id,
  monthId: r.month_id,
  workerRecordId: r.worker_record_id,
  workerRef: r.worker_ref,
  workerName: r.worker_name ?? null,
  workMonth: dateOf(r.work_month).slice(0, 7),
  finalisedTotalMinor: int(r.finalised_total_minor, "finalised_total_minor"),
  itemCount: int(r.item_count, "item_count"),
  paymentDay: int(r.payment_day, "payment_day"),
  expectedPaymentDate: dateOf(r.expected_payment_date),
  snapshotHash: r.snapshot_hash,
  finalisedAt: new Date(r.finalised_at).toISOString(),
  finalisedBy: r.finalised_by,
  reason: r.reason ?? null,
});
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-coach-costs-repository.ts - DO NOT EDIT HERE =====
export const correctionFromRow = (r: Record<string, any>): Correction => ({
  organisationId: r.organisation_id,
  correctionId: r.correction_id,
  monthId: r.month_id,
  amountMinor: int(r.amount_minor, "amount_minor"),
  allocationRecordId: r.allocation_record_id ?? null,
  reason: r.reason,
  resultingTotalMinor: int(r.resulting_total_minor, "resulting_total_minor"),
  createdAt: new Date(r.created_at).toISOString(),
  createdBy: r.created_by,
});
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-cash-flow-repository.ts - DO NOT EDIT HERE =====
export const balanceFromRow = (r: Record<string, any>): BankBalance => ({
  organisationId: r.organisation_id,
  balanceId: r.balance_id,
  sequence: int(r.sequence, "sequence"),
  amountMinor: int(r.amount_minor, "amount_minor"),
  asAtDate: String(r.as_at_date).slice(0, 10),
  note: r.note ?? null,
  recordedAt: new Date(String(r.recorded_at)).toISOString(),
  recordedBy: r.recorded_by,
});
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Rule, sources
// ---------------------------------------------------------------------
export const CASH_RISK_RULE = { ruleKey: "cash_balance_below_threshold", ruleId: "ATT-054" } as const;
/** The forecast the rule checks: the longest standard Cash Flow range, so any breach Cash Flow can show raises it. */
export const CASH_RISK_RANGE: CashRange = "3m";
export const CASH_FLOW_SUPABASE = {
  suppliers: "supabase:finance_suppliers",
  instalments: "supabase:finance_supplier_instalments",
  payments: "supabase:finance_supplier_payments",
  versions: "supabase:finance_employment_versions",
  items: "supabase:finance_employment_items",
  months: "supabase:finance_worker_cost_months",
  corrections: "supabase:finance_worker_cost_corrections",
  balances: "supabase:finance_bank_balances",
} as const;
/** Every source ATT-054 reads (each loaded once per request by the engine). */
export const CASH_RISK_SOURCES: readonly string[] = [
  ...Object.values(FINANCE_TABLES),
  SETTINGS_TABLE,
  COST_TABLES.allocations,
  COST_TABLES.occurrences,
  COST_TABLES.sessions,
  COST_TABLES.workers,
  COST_TABLES.lines,
  COST_TABLES.summaries,
  ...Object.values(CASH_FLOW_SUPABASE),
];

type Raw = Record<string, any>;
function rows(ctx: EvaluatorContext, source: string, organisationId: string): Raw[] {
  const out = (ctx.sources[source] ?? []) as unknown as Raw[];
  for (const r of out) if (!r || r.organisation_id !== organisationId) throw new FinanceDataError(`${source}: a row of another organisation was returned`);
  return out;
}
function strict<T>(source: string, r: Raw, map: (r: Raw) => T): T {
  try {
    return map(r);
  } catch (e) {
    throw new FinanceDataError(`${source}: unreadable row (${e instanceof Error ? e.message : String(e)})`);
  }
}
const airtable = (ctx: EvaluatorContext, table: string) => (ctx.sources[table] ?? []) as unknown as { id: string; fields: Record<string, any> }[];

// ---------------------------------------------------------------------
// The pass: one Cash Flow per request (memoised on this evaluator's sources)
// ---------------------------------------------------------------------
const passCache = new WeakMap<object, { key: string; cf: CashFlow }>();
let passRuns = 0;
/** Test hook: how many Cash Flow passes actually ran. */
export function cashFlowPassStats() {
  return { runs: passRuns };
}

export function runCashFlowPass(ctx: EvaluatorContext): CashFlow {
  const key = `${ctx.now.getTime()}|${ctx.organisation.organisationId}|${ctx.organisation.timezone}`;
  const hit = passCache.get(ctx.sources);
  if (hit && hit.key === key) return hit.cf;
  passRuns++;
  const orgId = ctx.organisation.organisationId;
  const orgRecord = ctx.organisation.recordId;
  const today = todayIn(ctx.organisation.timezone, ctx.now);
  const end = rangeEnd(today, CASH_RISK_RANGE);

  // F2: the threshold + the Coach payment day (none = no threshold; several or unreadable = a data error).
  const settingsRows = airtable(ctx, SETTINGS_TABLE).filter((r) => Array.isArray(r.fields?.[SETTINGS_FIELDS.organisation]) && r.fields[SETTINGS_FIELDS.organisation].includes(orgRecord));
  if (settingsRows.length > 1) throw new FinanceDataError("More than one Finance Settings record exists for the organisation");
  let thresholdMinor: number | null = null;
  let paymentDay: number | null = null;
  if (settingsRows.length === 1) {
    const p = fromStoredRow(settingsRows[0] as any);
    if (!p.ok) throw new FinanceDataError(`Stored Finance Settings are not valid (${p.problems.join(", ")})`);
    thresholdMinor = p.state.settings.cashSafetyThresholdMinor;
    paymentDay = p.state.settings.coachPaymentDayOfFollowingMonth;
  }

  // F7 (the F8a pass over the same rows): every issued invoice's receivable + receipts.
  const rp = runReceivablePass(ctx);
  const receivables = rp.receivables.map(({ invoice, rec }) => ({
    invoiceId: invoice.invoiceId,
    clientId: invoice.clientId,
    clientName: invoice.clientName,
    officialNumber: officialNumber(invoice),
    grossMinor: rec.grossMinor,
    outstandingMinor: rec.outstandingMinor,
    cashReceivedMinor: rec.cashReceivedMinor,
    creditAppliedMinor: rec.creditAppliedMinor,
    creditNotesMinor: rec.creditNotesMinor,
    dueDate: rec.dueDate,
    originalDueDate: rec.originalDueDate,
  }));

  const S = CASH_FLOW_SUPABASE;
  const suppliers = rows(ctx, S.suppliers, orgId).map((r) => strict(S.suppliers, r, supplierFromRow));
  const instalments = rows(ctx, S.instalments, orgId).map((r) => strict(S.instalments, r, instalmentFromRow));
  const payments = rows(ctx, S.payments, orgId).map((r) => strict(S.payments, r, paymentFromRow));
  const versions = rows(ctx, S.versions, orgId).map((r) => strict(S.versions, r, versionFromRow));
  const items = rows(ctx, S.items, orgId).map((r) => strict(S.items, r, itemFromRow));
  const months = rows(ctx, S.months, orgId).map((r) => strict(S.months, r, monthFromRow));
  const corrections = rows(ctx, S.corrections, orgId).map((r) => strict(S.corrections, r, correctionFromRow));
  const balances = rows(ctx, S.balances, orgId).map((r) => strict(S.balances, r, balanceFromRow));

  // F12: the same CostWorld shape Finance loads (here the whole tables; workItemsOf keeps only each month's work).
  const byId = (t: string) => new Map(airtable(ctx, t).map((r) => [r.id, r]));
  const world: CostWorld = {
    allocations: airtable(ctx, COST_TABLES.allocations),
    occurrences: byId(COST_TABLES.occurrences),
    sessions: byId(COST_TABLES.sessions),
    workers: airtable(ctx, COST_TABLES.workers),
    lines: byId(COST_TABLES.lines),
    summaries: byId(COST_TABLES.summaries),
  };

  let cf: CashFlow;
  try {
    cf = buildCashFlow({
      organisationId: orgId,
      today,
      range: CASH_RISK_RANGE,
      balance: latestBalance(balances),
      thresholdMinor,
      receivables,
      receipts: cashReceipts(rp.payments, rp.paymentReversals, rp.credits),
      awaitingIssue: { count: rp.awaitingExternalIssue, grossMinor: rp.awaitingExternalIssueGrossMinor },
      suppliers,
      instalments,
      supplierPayments: payments,
      employmentVersions: versions,
      employmentItems: items,
      coachMonths: coachMonthInputs(world, { months, corrections }, coachWorkMonths(today, end), today, paymentDay),
      coachPaymentDayConfigured: paymentDay !== null,
    });
  } catch (e) {
    if (e instanceof CashFlowDataError) throw new FinanceDataError(`Cash Flow cannot be built from the stored Finance data: ${e.message}`);
    throw e;
  }
  passCache.set(ctx.sources, { key, cf });
  return cf;
}

// ---------------------------------------------------------------------
// The case
// ---------------------------------------------------------------------
export function cashRiskCase(cf: CashFlow, timeZone: string): CandidateCase | null {
  if (!cf.balance || cf.thresholdMinor === null || cf.projectedLowMinor === null || !cf.thresholdBreached || !cf.firstBreachDate) return null;
  const low = cf.projectedLowMinor;
  const t = cf.thresholdMinor;
  const below = t - low;
  const breachStart = localMidnightIso(cf.firstBreachDate, timeZone);
  return {
    subjects: [{ type: "cash_position", id: cf.organisationId }],
    title: "Projected bank balance below the cash safety threshold",
    detail: `Projected low ${low < 0 ? "-" : ""}£${pounds(Math.abs(low))} on ${cf.projectedLowDate} - £${pounds(below)} below the £${pounds(t)} cash safety threshold; first below it on ${cf.firstBreachDate}. 3-month forecast from the Management-entered bank balance of ${cf.balance.amountMinor < 0 ? "-" : ""}£${pounds(Math.abs(cf.balance.amountMinor))} as at ${cf.balance.asAtDate} (not bank verified; Stripe not included).`,
    anchors: { event: breachStart },
    anchorTime: breachStart,
    destination: { route: "finance/cash-flow", params: { range: CASH_RISK_RANGE, view: "position" } },
    targetIds: { organisationId: cf.organisationId },
    context: {
      sourceType: "cash_position",
      sourceLabel: "Cash Position",
      sourceAction: "Review Cash Flow",
      currency: "GBP",
      projectedLow: `${low < 0 ? "-" : ""}${pounds(Math.abs(low))}`,
      projectedLowDate: cf.projectedLowDate,
      safetyThreshold: pounds(t),
      belowThresholdBy: pounds(below),
      firstBreachDate: cf.firstBreachDate,
      balance: `${cf.balance.amountMinor < 0 ? "-" : ""}${pounds(Math.abs(cf.balance.amountMinor))}`,
      balanceAsAt: cf.balance.asAtDate,
      balanceId: cf.balance.balanceId,
      balanceLabel: "Management-entered bank balance",
      range: cf.range,
      rangeStart: cf.rangeStart,
      rangeEnd: cf.rangeEnd,
      projectedEndBalance: cf.projectedEndMinor === null ? null : `${cf.projectedEndMinor < 0 ? "-" : ""}${pounds(Math.abs(cf.projectedEndMinor))}`,
      stripeIncluded: false,
      asOf: cf.today,
      sourceApi: `GET /finance/cash-flow?range=${CASH_RISK_RANGE}&view=position`,
    },
  };
}

export const CASH_RISK_EVALUATOR: EvaluatorRegistration = {
  ruleKey: CASH_RISK_RULE.ruleKey,
  ruleId: CASH_RISK_RULE.ruleId,
  sources: CASH_RISK_SOURCES,
  evaluate(ctx) {
    const c = cashRiskCase(runCashFlowPass(ctx), ctx.organisation.timezone);
    return c ? [c] : [];
  },
};
export const CASH_FLOW_EVALUATORS: readonly EvaluatorRegistration[] = [CASH_RISK_EVALUATOR];
