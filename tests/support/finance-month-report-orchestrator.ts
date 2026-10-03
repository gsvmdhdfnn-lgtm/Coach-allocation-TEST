/**
 * Test-suite copy of the canonical finance/finance-month-report-orchestrator.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). Only import paths adjusted:
 * ./orchestrator.ts -> ./finance-orchestrator.ts; ./repository.ts -> ./finance-repository.ts.
 */
/**
 * Month Report + Finance Overview - orchestration (Finance Foundation F18; see
 * TEST-ENV.md "Finance Foundation - F18"). Every route authorises through F1's
 * authorizeFinance() first ("read": Finance View or Manage). READ ONLY - no
 * write, no audit row, no stored report.
 *
 *   GET /month-report?month=YYYY-MM&mode=actual|expected   management accounts for one month (default Actual)
 *   GET /overview?month=YYYY-MM                            compact ACTUAL-only operating summary
 *
 * Each source family is loaded ONCE per request through its owning slice's
 * repository (F2 settings, F3 snapshot, F4 sessions / occurrences / overrides,
 * F5 draft lines, F6 / F7 invoices + lines + receivables, F12 work + Coach
 * Months, F13 / F14 / F15 ledgers) for the selected month AND the previous
 * month (one window), then normalised and aggregated by the pure engine
 * (finance-month-report.ts). Finance routes are never called over HTTP.
 *
 * Outside Finance: the Overview makes ONE call to the needs-attention function
 * with the caller's own Authorization (never a service key) and only keeps its
 * counts; a failure there marks needsAttention unavailable and never fails the
 * financial figures. The optional cash summary is F17's own engine over the
 * same loaded ledgers (never recalculated here). Stripe is read through F10's
 * own route function only to show the EXCLUDED parent revenue amount.
 *
 * F20 reporting boundary: Finance Settings are read FIRST. A month before the
 * organisation's Finance Reporting Start Month loads no Finance source at all
 * and returns a "history unavailable" state (never a 0.00 report); for the
 * start month itself the previous-month comparison is unavailable. From the
 * start month on, every figure is F18's, unchanged (finance-reporting-boundary.ts).
 */
import type { FinanceCaller, OrganisationContext } from "./finance-access.ts";
import { authorizeFinance } from "./finance-orchestrator.ts";
import { type CommercialDeps, loadWorld } from "./finance-commercial-orchestrator.ts";
import { todayIn } from "./finance-commercial.ts";
import type { Row, World } from "./finance-commercial-mapping.ts";
import { type FinanceSettings, fromStoredRow, overviewCashSummaryShown } from "./finance-settings.ts";
import { HISTORY_UNAVAILABLE_CODE, REPORTING_STATE_CANONICAL, boundaryOf, comparisonUnavailable, historyUnavailable, previousMonthBeforeStart, startMessage } from "./finance-reporting-boundary.ts";
import { loadSettingsRows } from "./finance-settings-repository.ts";
import { resolveOccurrenceBilling } from "./finance-billing.ts";
import { FB, buildOverrides, occurrenceFacts } from "./finance-billing-mapping.ts";
import { listOverrideRows } from "./finance-billing-repository.ts";
import { serviceFinder } from "./finance-billing-orchestrator.ts";
import { buildLines } from "./finance-invoicing-mapping.ts";
import { listOccurrencesForSessions, listSessionsForServices } from "./finance-invoicing-repository.ts";
import { buildCreditNotes, buildInvoiceLines, buildInvoices, invoiceMatchesLines } from "./finance-issue-mapping.ts";
import { isIssued, publicNumbering } from "./finance-issue.ts";
import { loadOrganisationReceivableRows } from "./finance-receivables-repository.ts";
import { receivablesOf } from "./finance-cash-flow-orchestrator.ts";
import { CashFlowDataError, buildCashFlow, cashFlowView, coachMonthInputs, coachWorkMonths, latestBalance, rangeEnd } from "./finance-cash-flow.ts";
import { loadBalances } from "./finance-cash-flow-repository.ts";
import { type CostWorld, F as COST_F, monthBounds, monthStatus, workItemsOf, workersOf } from "./finance-coach-costs.ts";
import { type MonthLedger, loadCostWorld, loadMonthLedger } from "./finance-coach-costs-repository.ts";
import { type SupplierLedger, loadSupplierLedger } from "./finance-suppliers-repository.ts";
import { allocationSuperseded, remainingOf, stateOf } from "./finance-suppliers.ts";
import { adjustmentRows } from "./finance-supplier-credits.ts";
import { type OverheadLedger, loadOverheadLedger } from "./finance-overheads-repository.ts";
import { ESTIMATE_LABEL, asInstalment, assignmentOf, chainOf, monthLine } from "./finance-overheads.ts";
import { type StripeDeps, listStripePayments } from "./finance-stripe-orchestrator.ts";
import { listIncludedDraftLineRowsInWindow, listInvoiceLineRowsForInvoices, listInvoiceLineRowsInWindow } from "./finance-month-report-repository.ts";
import {
  type BillingInput,
  type CoachInput,
  type MonthReportInputs,
  type ParentRevenueInput,
  type ReportMode,
  MONTH_REPORT_CONTRACT,
  MonthReportDataError,
  OVERVIEW_CONTRACT,
  buildFacts,
  buildMonthReport,
  monthEnd,
  previousMonth,
  upcomingPayments,
} from "./finance-month-report.ts";

export type MonthReportDeps = CommercialDeps & Partial<StripeDeps>;
export type MRFail = { status: "error"; httpStatus: 400 | 403 | 404 | 409 | 503; code: string; error: string; details?: Record<string, unknown> };
export type Ok = { status: "ok"; httpStatus: 200; body: Record<string, unknown> };
/** The one Needs Attention call the Overview makes (built per request in index.ts with the caller's own Authorization). */
export type NeedsAttentionSummary = () => Promise<{ status: "ok"; state: string; total: number; counts: Record<string, number>; suppressed: number; complete: boolean } | { status: "unavailable"; reason: string }>;

const fail = (httpStatus: MRFail["httpStatus"], code: string, error: string, details?: Record<string, unknown>): MRFail => ({ status: "error", httpStatus, code, error, ...(details ? { details } : {}) });
const isFail = (x: unknown): x is MRFail => !!x && typeof x === "object" && (x as any).status === "error";
const now = (deps: MonthReportDeps) => (deps.clock ?? (() => new Date()))();
const unavailable = () => fail(503, "month_report_unavailable", "The Month Report could not be loaded just now - try again");
const minorOf = (s: unknown) => (typeof s === "string" && /^-?\d+\.\d{2}$/.test(s) ? Math.round(Number(s) * 100) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

async function settingsOf(deps: MonthReportDeps, org: OrganisationContext): Promise<FinanceSettings | null | MRFail> {
  const rows = await loadSettingsRows(deps.airtable, org.recordId);
  if (rows.length > 1) return fail(409, "finance_settings_invalid", "More than one Finance Settings record exists for the organisation - fix that first");
  if (rows.length === 0) return null;
  const p = fromStoredRow(rows[0]);
  if (!p.ok) return fail(409, "finance_settings_invalid", `Stored Finance Settings are not valid (${p.problems.join(", ")})`);
  return p.state.settings;
}

interface Loaded {
  settings: FinanceSettings | null;
  rec: Awaited<ReturnType<typeof loadOrganisationReceivableRows>>;
  world: World;
  suppliers: SupplierLedger;
  overheads: OverheadLedger;
  months: MonthLedger;
  costWorld: CostWorld;
  invoiceLineRows: Row[];
  draftLineRows: Row[];
  sessions: Row[];
  occurrences: Row[];
  overrideRows: Row[];
}

/** F20: Finance Settings first (the reporting boundary decides whether any Finance source is read at all). */
async function boundarySettings(deps: MonthReportDeps, org: OrganisationContext): Promise<FinanceSettings | null | MRFail> {
  try {
    return await settingsOf(deps, org);
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}

/** F20: the reporting boundary for one month of an already-authorised organisation (used by F19 before it records a run). */
export async function reportingBoundaryFor(deps: MonthReportDeps, org: OrganisationContext, month: string) {
  const settings = await boundarySettings(deps, org);
  if (isFail(settings)) return settings;
  return boundaryOf(settings?.reportingStartMonth ?? null, month);
}

/** Every source for [first day of the previous month .. last day of `month`], each family once (settings already read by the caller). */
async function loadSources(deps: MonthReportDeps, org: OrganisationContext, month: string, today: string, settings: FinanceSettings | null): Promise<Loaded | MRFail> {
  const from = `${previousMonth(month)}-01`;
  const to = monthEnd(month);
  try {
    const [rec, w, suppliers, overheads, months, costWorld, windowLines, draftLineRows] = await Promise.all([
      loadOrganisationReceivableRows(deps.airtable, org.recordId),
      loadWorld(deps, org, today),
      loadSupplierLedger(deps.grants, org.organisationId),
      loadOverheadLedger(deps.grants, org.organisationId),
      loadMonthLedger(deps.grants, org.organisationId),
      loadCostWorld(deps.airtable, from, to),
      listInvoiceLineRowsInWindow(deps.airtable, org.recordId, from, to),
      listIncludedDraftLineRowsInWindow(deps.airtable, org.recordId, from, to),
    ]);
    if ("status" in w) return fail(w.httpStatus === 503 ? 503 : 409, w.code, w.error);
    const invoiceIds = [...new Set(windowLines.map((r) => String(r.fields["Invoice ID"] ?? "")).filter((x) => x))];
    const serviceIds = w.world.services.map((s) => s.value.serviceId);
    const [invoiceLineRows, sessions] = await Promise.all([listInvoiceLineRowsForInvoices(deps.airtable, org.recordId, invoiceIds), serviceIds.length ? listSessionsForServices(deps.airtable, serviceIds) : Promise.resolve([] as Row[])]);
    const refs = sessions.map((s) => ({ recordId: s.id, sessionId: typeof s.fields[FB.session.id] === "string" ? s.fields[FB.session.id] : "" })).filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s.sessionId));
    const occurrences = refs.length ? await listOccurrencesForSessions(deps.airtable, refs, from, to) : [];
    const occIds = occurrences.map((o) => String(o.fields[FB.occurrence.id] ?? "")).filter((x) => x);
    const overrideRows = occIds.length ? await listOverrideRows(deps.airtable, org.recordId, occIds) : [];
    return { settings, rec, world: w.world, suppliers, overheads, months, costWorld, invoiceLineRows, draftLineRows, sessions, occurrences, overrideRows };
  } catch (e) {
    console.error(e);
    return unavailable();
  }
}

/** D2: Stripe / parent revenue is never in the totals; F10's own read gives the informational excluded amount (by charge date). */
async function parentRevenueOf(deps: MonthReportDeps, caller: FinanceCaller, month: string): Promise<ParentRevenueInput> {
  if (!deps.stripe) return { status: "not_connected", grossMinor: null, receipts: null, detail: null };
  try {
    const r = await listStripePayments(deps as StripeDeps, caller, { from: `${month}-01`, to: monthEnd(month) });
    if (r.status !== "ok") return r.code === "stripe_not_connected" ? { status: "not_connected", grossMinor: null, receipts: null, detail: null } : { status: "unavailable", grossMinor: null, receipts: null, detail: r.code };
    const rows = ((r.body as any).payments ?? []).filter((p: any) => p.receipt === true && p.currency === "GBP");
    return { status: "excluded", grossMinor: rows.reduce((a: number, p: any) => a + minorOf(p.gross), 0), receipts: rows.length, detail: null };
  } catch (e) {
    console.error(e);
    return { status: "unavailable", grossMinor: null, receipts: null, detail: "stripe_read_failed" };
  }
}

/** Normalises the loaded rows into the engine's inputs (each through its owning slice's builders / pure functions). */
export function inputsOf(L: Loaded, org: OrganisationContext, month: string, today: string, at: Date, parentRevenue: ParentRevenueInput): MonthReportInputs {
  const prev = previousMonth(month);
  const from = `${prev}-01`;
  const to = monthEnd(month);
  const inWindow = (d: string) => d >= from && d <= to;
  const months = new Set([prev, month]);
  const orgRec = org.recordId;
  // ----- F6 / F7: invoices, lines, credit notes, settlement -----
  const iv = buildInvoices(L.rec.invoices, orgRec);
  if (!iv.ok) throw new MonthReportDataError(iv.error);
  const ns = buildCreditNotes(L.rec.notes, orgRec);
  if (!ns.ok) throw new MonthReportDataError(ns.error);
  const il = buildInvoiceLines(L.invoiceLineRows, orgRec);
  if (!il.ok) throw new MonthReportDataError(il.error);
  const rec = receivablesOf(L.rec, orgRec, today);
  const settlement = new Map(rec.receivables.map((r) => [r.invoiceId, r]));
  const creditedBy = new Map<string, { creditNoteId: string; creditDate: string }>();
  for (const n of ns.notes) for (const l of n.value.lines) creditedBy.set(l.invoiceLineId, { creditNoteId: n.value.creditNoteId, creditDate: n.value.creditDate });
  const lines = il.lines.map((x) => x.value);
  const touched = new Set(lines.map((l) => l.invoiceId));
  const invoices = iv.invoices.map((x) => x.value).filter((i) => touched.has(i.invoiceId));
  for (const inv of invoices) {
    if (!invoiceMatchesLines(inv, lines.filter((l) => l.invoiceId === inv.invoiceId))) throw new MonthReportDataError(`${inv.invoiceId} does not equal its stored lines (count / totals)`);
  }
  // ----- F5: Included draft lines -----
  const dl = buildLines(L.draftLineRows, orgRec);
  if (!dl.ok) throw new MonthReportDataError(dl.error);
  // ----- F4: expected billing for the client-paid services' sessions -----
  const ov = buildOverrides(L.overrideRows, orgRec);
  if (!ov.ok) throw new MonthReportDataError(ov.error);
  const overrides = ov.overrides.map((o) => o.value);
  const byRecord = new Map(L.sessions.map((s) => [s.id, s]));
  const find = serviceFinder(L.world);
  const clients = new Map(L.world.clients.map((c) => [c.value.clientId, c.value]));
  const billing: BillingInput[] = L.occurrences.map((occ) => {
    const link = links(occ.fields[FB.occurrence.session]);
    const session = link.length === 1 ? byRecord.get(link[0]) ?? null : null;
    const r = resolveOccurrenceBilling({ occurrence: occurrenceFacts(occ, session), findService: find, overrides, now: at, today });
    const client = r.service ? clients.get(r.service.client.clientId) ?? r.service.client : null;
    return {
      occurrenceId: r.occurrence.occurrenceId,
      occurrenceDate: r.occurrence.date,
      sessionId: r.occurrence.sessionId ?? null,
      sessionName: r.occurrence.sessionName ?? null,
      serviceId: r.service?.service.serviceId ?? r.occurrence.financeServiceRef ?? null,
      serviceName: r.service?.service.name ?? null,
      clientId: client?.clientId ?? null,
      clientName: client?.name ?? null,
      billingMethod: client ? (client.billingMethod ?? "hub") : null,
      outcome: r.outcome,
      eligibilityStatus: r.eligibility.status,
      deferral: r.deferral,
      detail: r.detail,
      expected: r.expected ? { netMinor: r.expected.netMinor, vatMinor: r.expected.vatMinor, grossMinor: r.expected.grossMinor } : null,
    };
  });
  // ----- occurrences with no Finance Service ID (from the F12 window read: every occurrence in the window) -----
  const unlinkedOccurrences = [...L.costWorld.occurrences.values()]
    .filter((o) => {
      const st = typeof o.fields[COST_F.occurrence.status] === "string" ? o.fields[COST_F.occurrence.status] : (o.fields[COST_F.occurrence.status] as any)?.name;
      if (st === "Cancelled" || st === "Postponed") return false;
      const s = L.costWorld.sessions.get(links(o.fields[COST_F.occurrence.session])[0] ?? "");
      return !s || !str(s.fields[COST_F.session.serviceId]);
    })
    .map((o) => ({ occurrenceId: String(o.fields[COST_F.occurrence.id] ?? o.id), date: String(o.fields[COST_F.occurrence.date]), sessionName: str(L.costWorld.sessions.get(links(o.fields[COST_F.occurrence.session])[0] ?? "")?.fields[COST_F.session.name]) }));
  // ----- F12: finalised Coach Months (frozen items + corrections) and open months' live work -----
  const coach: CoachInput[] = [];
  const coachMonthsNeedingCorrection: MonthReportInputs["coachMonthsNeedingCorrection"] = [];
  const workers = workersOf(L.costWorld.workers);
  const finalised = L.months.months.filter((fm) => months.has(fm.workMonth));
  for (const fm of finalised) {
    const b = monthBounds(fm.workMonth);
    const frozen = L.months.items.filter((i) => i.month_id === fm.monthId);
    const corrections = L.months.corrections.filter((c) => c.monthId === fm.monthId);
    const live = workItemsOf(L.costWorld, fm.workerRecordId, b.from, b.to, today);
    const st = monthStatus(fm, frozen, corrections, live);
    const who = { ref: fm.workerRef || null, name: fm.workerName ?? fm.workerRef };
    if (st.correctionRequired) coachMonthsNeedingCorrection.push({ monthId: fm.monthId, coach: who.name, workMonth: fm.workMonth });
    for (const f of frozen) coach.push({ kind: "frozen_item", workMonth: fm.workMonth, workDate: f.work_date, coach: who, monthId: fm.monthId, monthState: st.state, correctionId: null, allocation: f.allocation_label, occurrenceId: f.occurrence_ref, sessionName: f.session_name, serviceId: f.finance_service_id, programmeLabel: f.programme_label, costBasis: f.cost_basis, amountMinor: f.final_cost_minor });
    for (const c of corrections) coach.push({ kind: "correction", workMonth: fm.workMonth, workDate: null, coach: who, monthId: fm.monthId, monthState: st.state, correctionId: c.correctionId, allocation: null, occurrenceId: null, sessionName: null, serviceId: null, programmeLabel: null, costBasis: null, amountMinor: c.amountMinor });
  }
  const isFinalised = new Set(finalised.map((fm) => `${fm.workerRecordId}|${fm.workMonth}`));
  for (const w of workers) {
    for (const mo of months) {
      if (isFinalised.has(`${w.recordId}|${mo}`)) continue;
      const b = monthBounds(mo);
      for (const i of workItemsOf(L.costWorld, w.recordId, b.from, b.to, today)) {
        coach.push({ kind: "live_item", workMonth: mo, workDate: i.workDate, coach: { ref: w.ref || null, name: w.name }, monthId: null, monthState: "open", correctionId: null, allocation: i.allocationLabel, occurrenceId: i.occurrenceRef, sessionName: i.sessionName, serviceId: i.financeServiceId, programmeLabel: i.programmeLabel, costBasis: i.costBasis, amountMinor: i.finalCostMinor });
      }
    }
  }
  // ----- F13 / F14 / F15 -----
  const S = L.suppliers;
  const supplier = new Map(S.suppliers.map((s) => [s.supplierId, s]));
  const agreement = new Map(S.agreements.map((a) => [a.agreementId, a]));
  const successorOf = (id: string) => S.agreements.find((x) => x.supersedesAgreementId === id) ?? null;
  const category = (id: string | null) => {
    const c = id ? L.overheads.categories.find((x) => x.categoryId === id) : undefined;
    return c ? { categoryId: c.categoryId, name: c.name } : null;
  };
  const agreementCategory = (agreementId: string) => category(assignmentOf(L.overheads.assignments, agreementId)?.categoryId ?? null);
  const directShares = S.agreements
    .filter((a) => a.classification === "direct" && a.linkState === "linked")
    .flatMap((a) => {
      const succ = successorOf(a.agreementId);
      const s = supplier.get(a.supplierId);
      return S.allocations
        .filter((x) => x.agreementId === a.agreementId && inWindow(x.occurrenceDate) && !allocationSuperseded(x, succ))
        .map((x) => ({ agreementId: a.agreementId, agreementName: a.name, supplierId: a.supplierId, supplierName: s?.name ?? a.supplierId, supplierType: s?.supplierType ?? "other", occurrenceDate: x.occurrenceDate, occurrenceRef: x.occurrenceRef, sessionId: x.sessionId, sessionName: x.sessionName, serviceId: x.financeServiceId, programmeLabel: x.programmeLabel, amountMinor: x.allocatedMinor, estimated: a.amountIsEstimate }));
    });
  const unresolvedDirectAgreements = S.agreements
    .filter((a) => a.classification === "direct" && a.linkState === "unresolved" && a.effectiveFrom <= to && (a.effectiveUntil === null || a.effectiveUntil >= from))
    .map((a) => ({ agreementId: a.agreementId, agreementName: a.name, supplierName: supplier.get(a.supplierId)?.name ?? a.supplierId, totalMinor: a.totalPlannedMinor }));
  const supplierCredits = S.credits
    .filter((c) => !c.voidedAt && inWindow(c.creditDate))
    .map((c) => {
      const a = c.agreementId ? agreement.get(c.agreementId) ?? null : null;
      const s = supplier.get(c.supplierId);
      return {
        creditId: c.creditId,
        supplierId: c.supplierId,
        supplierName: s?.name ?? c.supplierId,
        supplierType: s?.supplierType ?? "other",
        agreementId: c.agreementId,
        agreementName: a?.name ?? null,
        classification: a ? a.classification : null,
        category: a && a.classification === "general" ? agreementCategory(a.agreementId) : null,
        creditDate: c.creditDate,
        scope: c.scope,
        amountMinor: c.amountMinor,
        rows: adjustmentRows(c, S.creditSessions).map((r) => ({ serviceId: r.financeServiceId, programmeLabel: r.label, amountMinor: r.amountMinor, sessionId: r.sessionId, sessionDate: r.sessionDate })),
      };
    });
  const general = new Map(S.agreements.filter((a) => a.classification === "general").map((a) => [a.agreementId, a]));
  const overheadInstalments = S.instalments
    .filter((i) => !i.cancelledAt && general.has(i.agreementId) && inWindow(i.dueDate))
    .map((i) => {
      const a = general.get(i.agreementId)!;
      const s = supplier.get(a.supplierId);
      return { agreementId: a.agreementId, agreementName: a.name, instalmentId: i.instalmentId, supplierId: a.supplierId, supplierName: s?.name ?? a.supplierId, vatTreatment: s?.vatTreatment ?? null, category: agreementCategory(a.agreementId), dueDate: i.dueDate, amountMinor: i.amountDueMinor, state: stateOf(i) };
    });
  const employment = [...new Set(L.overheads.versions.map((v) => v.employmentId))].sort().flatMap((id) => {
    const chain = chainOf(L.overheads.versions, id);
    return [...months].flatMap((mo) => {
      const l = monthLine(chain, L.overheads.items, mo);
      if (!l) return [];
      const i = asInstalment(org.organisationId, l);
      return [{ employmentId: id, versionId: l.version.versionId, itemId: l.item?.itemId ?? null, person: { ref: l.version.personRef, name: l.version.personName }, category: category(l.version.categoryId), month: mo, amountMinor: i.amountDueMinor, state: stateOf(i), estimateLabel: ESTIMATE_LABEL }];
    });
  });
  const serviceLabels = Object.fromEntries(L.world.services.map((s) => [s.value.serviceId, s.value.name]));
  return {
    organisationId: org.organisationId,
    today,
    month,
    invoices: invoices.map((inv) => {
      const s = settlement.get(inv.invoiceId);
      const issued = isIssued(inv) && !!s;
      return { invoiceId: inv.invoiceId, officialNumber: publicNumbering(inv).officialNumber, clientId: inv.clientId, clientName: inv.clientName, issued, grossMinor: inv.grossMinor, creditNotesMinor: issued ? s!.creditNotesMinor : 0, cashReceivedMinor: issued ? s!.cashReceivedMinor : 0, creditAppliedMinor: issued ? s!.creditAppliedMinor : 0 };
    }),
    invoiceLines: lines.map((l) => ({ invoiceId: l.invoiceId, lineId: l.lineId, occurrenceId: l.occurrenceId, occurrenceDate: l.occurrenceDate, sessionId: l.sessionId, sessionName: l.sessionName, serviceId: l.serviceId, serviceName: l.serviceName, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor, creditNote: creditedBy.get(l.lineId) ?? null })),
    draftLines: dl.lines
      .map((x) => x.value)
      .filter((l) => l.status === "included" && inWindow(l.occurrenceDate))
      .map((l) => ({ draftId: l.draftId, lineId: l.lineId, clientId: null, clientName: null, occurrenceId: l.occurrenceId, occurrenceDate: l.occurrenceDate, sessionId: l.sessionId, sessionName: l.sessionName, serviceId: l.serviceId, serviceName: l.serviceName, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor })),
    billing,
    unlinkedOccurrences,
    coach,
    directShares,
    unresolvedDirectAgreements,
    supplierCredits,
    overheadInstalments,
    employment,
    serviceLabels,
    coachMonthsNeedingCorrection,
    parentRevenue,
  };
}

function dataFail(e: unknown): MRFail | null {
  if (e instanceof MonthReportDataError || e instanceof CashFlowDataError) return fail(409, "month_report_data_invalid", `The Month Report cannot be built from the stored Finance data: ${e.message}`);
  return null;
}

// ---------------------------------------------------------------------
// GET /month-report
// ---------------------------------------------------------------------
export async function readMonthReport(deps: MonthReportDeps, caller: FinanceCaller, q: { month?: string; mode: ReportMode }): Promise<Ok | MRFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  const month = q.month ?? today.slice(0, 7);
  const settings = await boundarySettings(deps, org);
  if (isFail(settings)) return settings;
  const startMonth = settings?.reportingStartMonth ?? null;
  const head = { contract: MONTH_REPORT_CONTRACT, organisation: { organisationId: org.organisationId, name: org.name, timezone: org.timezone }, access: auth.access, currency: "GBP", today };
  const boundary = boundaryOf(startMonth, month);
  if (boundary.state !== REPORTING_STATE_CANONICAL) return { status: "ok", httpStatus: 200, body: { ...head, mode: q.mode, ...historyUnavailable(month, boundary.financeReportingStartMonth) } };
  const [L, parent] = await Promise.all([loadSources(deps, org, month, today, settings), parentRevenueOf(deps, caller, month)]);
  if (isFail(L)) return L;
  try {
    const report = buildMonthReport(inputsOf(L, org, month, today, at, parent), q.mode, { generatedAt: at.toISOString(), organisationName: org.name });
    const { _figures, ...body } = report;
    const comparison = startMonth !== null && previousMonthBeforeStart(startMonth, month) ? comparisonUnavailable(month, q.mode, startMonth) : body.comparison;
    return { status: "ok", httpStatus: 200, body: { ...head, reportingState: REPORTING_STATE_CANONICAL, financeReportingStartMonth: startMonth, ...body, comparison } };
  } catch (e) {
    const df = dataFail(e);
    if (df) return df;
    throw e;
  }
}

// ---------------------------------------------------------------------
// F19 reporting writer input - the canonical F18 result, never recalculated
// ---------------------------------------------------------------------
/**
 * One month in BOTH modes from ONE source load (the same inputs both F18
 * reports and their facts are built from). The caller has already
 * authorised `org`; the F19 reporting writer only transforms this.
 */
export async function loadCanonicalMonth(deps: MonthReportDeps, caller: FinanceCaller, org: OrganisationContext, month: string) {
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  const settings = await boundarySettings(deps, org);
  if (isFail(settings)) return settings;
  const boundary = boundaryOf(settings?.reportingStartMonth ?? null, month);
  if (boundary.state !== REPORTING_STATE_CANONICAL) return fail(409, HISTORY_UNAVAILABLE_CODE, `${startMessage(boundary.financeReportingStartMonth)} ${month} is before it, so there is no Hub Finance report to export`, historyUnavailable(month, boundary.financeReportingStartMonth));
  const [L, parent] = await Promise.all([loadSources(deps, org, month, today, settings), parentRevenueOf(deps, caller, month)]);
  if (isFail(L)) return L;
  try {
    const inputs = inputsOf(L, org, month, today, at, parent);
    const meta = { generatedAt: at.toISOString(), organisationName: org.name };
    return { status: "ok" as const, at, today, actual: buildMonthReport(inputs, "actual", meta), expected: buildMonthReport(inputs, "expected", meta), facts: buildFacts(inputs).facts, serviceLabels: inputs.serviceLabels };
  } catch (e) {
    const df = dataFail(e);
    if (df) return df;
    throw e;
  }
}

// ---------------------------------------------------------------------
// GET /overview - Finance Overview (ACTUAL only)
// ---------------------------------------------------------------------
export async function readFinanceOverview(deps: MonthReportDeps, caller: FinanceCaller, q: { month?: string }, needsAttention?: NeedsAttentionSummary): Promise<Ok | MRFail> {
  const auth = await authorizeFinance(deps, caller, "read");
  if (auth.status !== "ok") return fail(auth.httpStatus, auth.code, auth.error);
  const org = auth.organisation;
  const at = now(deps);
  const today = todayIn(org.timezone, at);
  const month = q.month ?? today.slice(0, 7);
  const settings = await boundarySettings(deps, org);
  if (isFail(settings)) return settings;
  const boundary = boundaryOf(settings?.reportingStartMonth ?? null, month);
  if (boundary.state !== REPORTING_STATE_CANONICAL) {
    return {
      status: "ok",
      httpStatus: 200,
      body: {
        contract: OVERVIEW_CONTRACT,
        organisation: { organisationId: org.organisationId, name: org.name, timezone: org.timezone },
        access: auth.access,
        currency: "GBP",
        today,
        ...historyUnavailable(month, boundary.financeReportingStartMonth),
        metrics: null,
        routes: { cashFlow: "GET /finance/cash-flow?range=3m&view=position", needsAttention: "GET /needs-attention/cases" },
      },
    };
  }
  const naPromise = (async () => {
    if (!needsAttention) return { status: "unavailable" as const, reason: "not_requested" };
    try {
      return await needsAttention();
    } catch (e) {
      console.error(e);
      return { status: "unavailable" as const, reason: "needs_attention_call_failed" };
    }
  })();
  const [L, parent] = await Promise.all([loadSources(deps, org, month, today, settings), parentRevenueOf(deps, caller, month)]);
  if (isFail(L)) return L;
  const showCash = overviewCashSummaryShown(L.settings);
  // F17's cash summary: its own engine over the same ledgers; only the coach work window (today .. 3 months) is an extra read.
  let cashSummary: Record<string, unknown> = { shown: false, reason: "Hidden in Finance Settings (Show Cash Summary on Finance Overview)" };
  let cashWorld: CostWorld | null = null;
  let balances: Awaited<ReturnType<typeof loadBalances>> = [];
  const cfMonths = coachWorkMonths(today, rangeEnd(today, "3m"));
  if (showCash) {
    try {
      [cashWorld, balances] = await Promise.all([loadCostWorld(deps.airtable, monthBounds(cfMonths[0]).from, monthBounds(cfMonths[cfMonths.length - 1]).to), loadBalances(deps.grants, org.organisationId)]);
    } catch (e) {
      console.error(e);
      cashSummary = { shown: true, status: "unavailable", reason: "Cash Flow could not be loaded just now" };
    }
  }
  try {
    const inputs = inputsOf(L, org, month, today, at, parent);
    const report = buildMonthReport(inputs, "actual", { generatedAt: at.toISOString(), organisationName: org.name });
    if (showCash && cashWorld) {
      const r = receivablesOf(L.rec, org.recordId, today);
      const cf = buildCashFlow({
        organisationId: org.organisationId,
        today,
        range: "3m",
        balance: latestBalance(balances),
        thresholdMinor: L.settings?.cashSafetyThresholdMinor ?? null,
        receivables: r.receivables,
        receipts: r.receipts,
        awaitingIssue: r.awaitingIssue,
        suppliers: L.suppliers.suppliers,
        instalments: L.suppliers.instalments,
        supplierPayments: L.suppliers.payments,
        employmentVersions: L.overheads.versions,
        employmentItems: L.overheads.items,
        coachMonths: coachMonthInputs(cashWorld, L.months, cfMonths, today, L.settings?.coachPaymentDayOfFollowingMonth ?? null),
        coachPaymentDayConfigured: (L.settings?.coachPaymentDayOfFollowingMonth ?? null) !== null,
      });
      const s = cashFlowView(cf, "position").summary as Record<string, unknown>;
      cashSummary = {
        shown: true,
        status: "ok",
        source: "F17 Cash Position (GET /finance/cash-flow?range=3m&view=position)",
        currentBalance: s.currentBalance,
        balanceAsAt: s.balanceAsAt,
        balanceLabel: "Management-entered bank balance",
        projectedLow: s.projectedLow,
        projectedLowDate: s.projectedLowDate,
        safetyThreshold: s.safetyThreshold,
        thresholdBreached: s.thresholdBreached,
        firstBreachDate: s.firstBreachDate,
        range: "3m",
      };
    }
    const supName = new Map(L.suppliers.suppliers.map((s) => [s.supplierId, s.name]));
    const person = new Map(L.overheads.versions.map((v) => [v.employmentId, v.personName]));
    const up = upcomingPayments({
      today,
      instalments: L.suppliers.instalments.map((i) => ({ instalmentId: i.instalmentId, agreementId: i.agreementId, supplierId: i.supplierId, supplierName: supName.get(i.supplierId) ?? i.supplierId, dueDate: i.dueDate, state: stateOf(i), remainingMinor: remainingOf(i), cancelled: !!i.cancelledAt })),
      employment: L.overheads.items.map((i) => ({ employmentId: i.employmentId, month: i.month, person: person.get(i.employmentId) ?? i.employmentId, expectedPaymentDate: i.expectedPaymentDate, state: i.paidMinor > 0 ? "paid" : "confirmed", amountDueMinor: i.amountDueMinor, paidMinor: i.paidMinor })),
      coachMonths: L.months.months.map((fm) => ({ monthId: fm.monthId, coach: fm.workerName ?? fm.workerRef, workMonth: fm.workMonth, expectedPaymentDate: fm.expectedPaymentDate, amountMinor: fm.finalisedTotalMinor + L.months.corrections.filter((c) => c.monthId === fm.monthId).reduce((a, c) => a + c.amountMinor, 0) })),
    });
    const na = await naPromise;
    return {
      status: "ok",
      httpStatus: 200,
      body: {
        contract: OVERVIEW_CONTRACT,
        organisation: { organisationId: org.organisationId, name: org.name, timezone: org.timezone },
        access: auth.access,
        currency: "GBP",
        today,
        month,
        reportingState: REPORTING_STATE_CANONICAL,
        financeReportingStartMonth: boundary.financeReportingStartMonth,
        basis: "Actual only - Expected / forecast figures live in Month Report (Expected + Actual) and Cash Flow",
        metrics: {
          netRevenue: report.overall.netRevenue,
          directCosts: report.overall.directCosts,
          overheads: report.overall.overheads,
          profit: report.overall.finalBusinessProfit,
          margin: report.overall.finalMargin,
          state: report.state,
          profitRule: "Net Revenue - Direct Costs - Overheads",
          vatNote: "Revenue is net of VAT; VAT is not revenue the business keeps",
        },
        completeness: { complete: report.completeness.complete, incompleteItems: report.completeness.items.filter((i) => i.severity === "incomplete").map((i) => ({ code: i.code, message: i.message, amount: i.amount ?? null })) },
        needsAttention: na.status === "ok" ? { status: "ok", state: na.state, total: na.total, counts: na.counts, suppressed: na.suppressed, complete: na.complete, route: "GET /needs-attention/cases" } : { status: "unavailable", reason: na.reason, route: "GET /needs-attention/cases" },
        upcomingPayments: up,
        cashSummary,
        routes: { monthReport: `GET /finance/month-report?month=${month}&mode=actual`, cashFlow: "GET /finance/cash-flow?range=3m&view=position", needsAttention: "GET /needs-attention/cases" },
      },
    };
  } catch (e) {
    const df = dataFail(e);
    if (df) return df;
    throw e;
  }
}
