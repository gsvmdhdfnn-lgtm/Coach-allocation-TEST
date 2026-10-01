/**
 * Test-suite copy of the canonical finance/finance-coach-costs.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Coach cost READ + Finance month finalisation - pure logic (Finance
 * Foundation F12; see TEST-ENV.md "Finance Foundation - F12").
 *
 * "Coach" is the organisation's current label for a person doing paid work.
 * The model is generic: a WORKER performs WORK ITEMS (allocations), each with
 * a frozen historical cost; Finance groups them by worker + calendar work
 * month. Nothing here is specific to football.
 *
 * Domains (unchanged by F12):
 *   - Coaches owns the worker profile, normal rates (Rate Profiles) and the
 *     Work Summary (the worker-facing statement: query / reopen /
 *     re-finalise, ATT-045 / ATT-046).
 *   - Schedule owns occurrences and their status.
 *   - The Coach Allocation is the historical cost authority: rate snapshot,
 *     units, override, Slice 6 work outcome, Final Coach Cost, Cost Basis.
 *   - Finance (here) only READS those, and owns the Finance Coach Month: one
 *     immutable snapshot per organisation + worker + calendar work month,
 *     plus explicit additive corrections. No Finance reopen.
 *
 * Historical cost is NEVER recalculated from a current rate: Finance reads
 * the allocation's own frozen Rate Amount Snapshot / Paid Units / Final Coach
 * Cost, and only uses the snapshot x units product to CHECK that the stored
 * cost is consistent (it never replaces it).
 *
 * Cost Basis: Paid (needs a valid historical rate + cost), Salaried / Volunteer
 * (an intentional 0.00 direct cost). A missing cost is never 0.00.
 *
 * Money is integer pence (GBP). Nothing here pays anyone, builds a coach
 * invoice, moves cash or writes a Cash Flow event.
 */
import { REASON_MAX, auditEvent } from "./finance-commercial.ts";
import { divRoundHalfAwayFromZero, formatMinor, isMinor, parseMoney } from "./finance-money.ts";
import { resolveCoachPaymentDate } from "./finance-settings.ts";

export const COACH_COST_CONTRACT = "finance-coach-costs-v1";

/** The worker's Hub id (Coaches.Coach ID). */
export const WORKER_REF_PATTERN = /^COACH-[A-Za-z0-9-]{1,48}$/;
export const MONTH_ID_PATTERN = /^FCM-[0-9A-F]{12}$/;
export const CORRECTION_ID_PATTERN = /^FCX-[0-9A-F]{12}$/;
export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TENANT_ERROR = "The organisation is taken from your profile and cannot be chosen in the request";
export const MAX_RANGE_MONTHS = 12;

// ---------------------------------------------------------------------
// The operational vocabulary Finance reads (owned by Coaches / Schedule).
// These mirror coach-work-summaries/work-summaries.ts exactly (drift-checked).
// ---------------------------------------------------------------------
export const ELIGIBLE_COST_STATUSES = ["Confirmed", "Exported"] as const;
export const OUTCOME_REQUIRED_STATUSES = ["Cancelled", "Postponed"] as const;
export const WORK_OUTCOMES = ["Paid", "Partial", "Unpaid"] as const;
export const SUMMARY_STATUSES = ["Not ready", "Needs review", "Finalised", "Queried"] as const;

export const COST_BASES = ["paid", "salaried", "volunteer"] as const;
export type CostBasis = (typeof COST_BASES)[number];
/** The Coach Allocations "Cost Basis" choices. Blank = Paid (every allocation made by Coaches' rate resolution is paid work); Paid must still prove a valid rate and cost. */
export const COST_BASIS_CHOICES: Record<CostBasis, string> = {
  paid: "Paid",
  salaried: "Salaried — no direct session cost",
  volunteer: "Volunteer — no direct session cost",
};

export const TABLES = {
  allocations: "Coach Allocations",
  occurrences: "Session Occurrences",
  sessions: "Sessions",
  workers: "Coaches",
  lines: "Work Summary Lines",
  summaries: "Coach Work Summaries",
} as const;
export const F = {
  allocation: {
    id: "Allocation ID",
    occurrence: "Session Occurrence",
    worker: "Coach",
    rateProfile: "Rate Profile",
    rateType: "Rate Type Snapshot",
    payUnit: "Pay Unit Snapshot",
    units: "Paid Units",
    rate: "Rate Amount Snapshot",
    override: "Cost Override",
    overrideReason: "Override Reason",
    finalCost: "Final Coach Cost",
    costStatus: "Cost Status",
    costBasis: "Cost Basis",
    outcome: "Coach Outcome",
    outcomeBy: "Coach Outcome Decided By Name Snapshot",
    outcomeAt: "Coach Outcome Decided At",
    lines: "Work Summary Lines",
  },
  occurrence: { id: "Occurrence ID", name: "Occurrence Name", date: "Date", status: "Status", session: "Session", allocations: "Coach Allocations", start: "Start Date & Time" },
  session: { name: "Session Name", programme: "Programme", serviceId: "Finance Service ID" },
  worker: { name: "Coach Name", ref: "Coach ID", active: "Active" },
  line: { id: "Work Summary Line ID", summary: "Work Summary", allocation: "Coach Allocation", finalCost: "Final Cost Snapshot" },
  summary: { id: "Work Summary ID", status: "Status", active: "Active", worker: "Coach", start: "Period Start", end: "Period End" },
} as const;

export const COST_EVENTS = {
  monthFinalised: "finance_work_cost.month_finalised",
  correctionCreated: "finance_work_cost.correction_created",
} as const;
export const ENTITY = { month: "finance_worker_cost_month", correction: "finance_worker_cost_correction" } as const;

// ---------------------------------------------------------------------
// Blockers (one item, or the month)
// ---------------------------------------------------------------------
export const ITEM_BLOCKERS = {
  multiple_people: "The allocation names more than one person - one allocation is one person's work",
  duplicate_allocation: "The same person has more than one allocation for this occurrence",
  cost_not_confirmed: "Cost Status is not Confirmed (Draft costs can still change)",
  outcome_undecided: "The occurrence was cancelled / postponed and no work outcome (Paid / Partial / Unpaid) has been recorded",
  not_yet_worked: "The work date has not passed yet",
  invalid_cost_basis: "Cost Basis is not one of Paid / Salaried / Volunteer",
  missing_historical_rate: "No frozen historical rate (Rate Profile, Rate Type, Pay Unit and Rate Amount snapshots are required) - the current rate is never used instead",
  invalid_units: "Paid Units is missing, not more than 0, or has more than 2 decimals",
  paid_zero_rate: "Paid work with a 0.00 rate - record the work as Salaried / Volunteer, or record the outcome, instead of a 0.00 rate",
  missing_final_cost: "Final Coach Cost is missing - a missing cost is never treated as 0.00",
  invalid_final_cost: "Final Coach Cost is negative or not a whole number of pence",
  override_unexplained: "The cost was overridden without a reason or a recorded work outcome",
  cost_mismatch: "Final Coach Cost does not match the frozen rate x units (or the recorded override) - it was changed by hand",
  no_cost_basis_with_cost: "A Salaried / Volunteer allocation must carry a 0.00 Final Coach Cost and no override",
  work_summary_missing: "Not covered by a Work Summary yet",
  work_summary_queried: "Its Work Summary is Queried - the query must be resolved first",
  work_summary_not_finalised: "Its Work Summary is not Finalised (Needs review / Not ready, e.g. reopened)",
  work_summary_stale: "Its Work Summary line shows a different amount than the allocation now holds",
  work_summary_ambiguous: "More than one active Work Summary covers it",
} as const;
export type ItemBlockerCode = keyof typeof ITEM_BLOCKERS;
/** Blockers about the Work Summary review process (not the cost itself). */
export const REVIEW_BLOCKERS: readonly ItemBlockerCode[] = ["work_summary_missing", "work_summary_queried", "work_summary_not_finalised", "work_summary_stale", "work_summary_ambiguous"];

export const MONTH_BLOCKERS = {
  month_not_ended: "The work month has not ended yet",
  payment_day_not_configured: "Coach Payment Day is not configured in Finance Settings",
  nothing_to_finalise: "There is no work for this person in this month",
} as const;
export type MonthBlockerCode = keyof typeof MONTH_BLOCKERS;
export type Blocker = { code: string; detail: string };

// ---------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------
export type Row = { id: string; fields: Record<string, any> };
export interface CostWorld {
  allocations: Row[];
  occurrences: Map<string, Row>;
  sessions: Map<string, Row>;
  workers: Row[];
  lines: Map<string, Row>;
  summaries: Map<string, Row>;
}
export interface Worker {
  recordId: string;
  ref: string;
  name: string;
  active: boolean;
}
export interface WorkItem {
  allocationRecordId: string;
  allocationLabel: string;
  occurrenceRecordId: string;
  occurrenceRef: string | null;
  workDate: string;
  occurrenceStatus: string | null;
  sessionRecordId: string | null;
  sessionName: string;
  financeServiceId: string | null;
  programmeLabel: string | null;
  costBasis: CostBasis | null;
  costBasisRecorded: boolean;
  costStatus: string | null;
  rateProfileRecordId: string | null;
  rateType: string | null;
  payUnit: string | null;
  paidUnits: string | null;
  rateAmountMinor: number | null;
  standardCostMinor: number | null;
  overrideMinor: number | null;
  overrideReason: string | null;
  workOutcome: string | null;
  outcomeDecidedBy: string | null;
  outcomeDecidedAt: string | null;
  finalCostMinor: number | null;
  workSummary: { ref: string | null; status: string | null; lineFinalMinor: number | null } | null;
  blockers: Blocker[];
}
/** A stored Finance Coach Month (finalised; immutable). */
export interface FinanceMonth {
  organisationId: string;
  monthId: string;
  workerRecordId: string;
  workerRef: string;
  workerName: string | null;
  workMonth: string;
  finalisedTotalMinor: number;
  itemCount: number;
  paymentDay: number;
  expectedPaymentDate: string;
  snapshotHash: string;
  finalisedAt: string;
  finalisedBy: string;
  reason: string | null;
}
export interface FrozenItem {
  allocation_record_id: string;
  allocation_label: string;
  occurrence_record_id: string;
  occurrence_ref: string | null;
  work_date: string;
  session_record_id: string | null;
  session_name: string;
  finance_service_id: string | null;
  programme_label: string | null;
  cost_basis: CostBasis;
  rate_type: string | null;
  pay_unit: string | null;
  paid_units: string | null;
  rate_amount_minor: number | null;
  override_minor: number | null;
  override_reason: string | null;
  work_outcome: string | null;
  final_cost_minor: number;
  work_summary_ref: string | null;
}
export interface Correction {
  organisationId: string;
  correctionId: string;
  monthId: string;
  amountMinor: number;
  allocationRecordId: string | null;
  reason: string;
  resultingTotalMinor: number;
  createdAt: string;
  createdBy: string;
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
export const m = (minor: number) => formatMinor(minor);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const sel = (v: unknown): string | null => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as any).name === "string" ? (v as any).name : null);
const links = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v);

/** FCM- / FCX- + 12 upper-case hex. */
export function newId(prefix: "FCM" | "FCX", random: () => string = () => crypto.randomUUID()): string {
  return `${prefix}-${random().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

/** An Airtable currency value (pounds) as exact pence, or null if it is not a whole number of pence. */
export function poundsToMinor(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const x = v * 100;
  const r = Math.round(x);
  if (Math.abs(x - r) > 1e-6 || !isMinor(r)) return null;
  return r;
}
/** Units with at most 2 decimals, as hundredths; null if missing / not > 0 / too precise. */
export function unitsToHundredths(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const x = v * 100;
  const r = Math.round(x);
  if (Math.abs(x - r) > 1e-6 || !Number.isSafeInteger(r)) return null;
  return r;
}
const unitsText = (h: number) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, "0")}`;

/**
 * The frozen rate x frozen units, in pence. Two roundings are accepted because
 * Coaches stored the product with float rounding (roundCurrency): exact
 * half-away-from-zero and the float result. Used only to CHECK a stored cost.
 */
export function standardCostCandidates(rateMinor: number, unitsHundredths: number): number[] {
  const exact = Number(divRoundHalfAwayFromZero(BigInt(rateMinor) * BigInt(unitsHundredths), 100n));
  const asFloat = Math.round(((rateMinor / 100) * (unitsHundredths / 100) + Number.EPSILON) * 100);
  return [...new Set([exact, asFloat])];
}

// ---------------------------------------------------------------------
// Months + payment timing
// ---------------------------------------------------------------------
export function monthBounds(month: string): { from: string; to: string; year: number; month: number } {
  const mm = MONTH_PATTERN.exec(month);
  if (!mm) throw new Error(`monthBounds: not a YYYY-MM month: ${month}`);
  const y = Number(mm[1]);
  const mo = Number(mm[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}`, year: y, month: mo };
}
export const monthOf = (date: string) => date.slice(0, 7);
export function addMonths(month: string, n: number): string {
  const b = monthBounds(month);
  const idx = b.year * 12 + (b.month - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let x = from; x <= to; x = addMonths(x, 1)) out.push(x);
  return out;
}
/** Expected payment date = the configured day in the month AFTER the work month (F2's shorter-month fallback). */
export function expectedPaymentDate(workMonth: string, configuredDay: unknown): { ok: true; date: string; day: number } | { ok: false; error: string } {
  const next = monthBounds(addMonths(workMonth, 1));
  return resolveCoachPaymentDate(configuredDay, next.year, next.month);
}

// ---------------------------------------------------------------------
// Reading the operational records (no inference, nothing recalculated)
// ---------------------------------------------------------------------
export function workersOf(rows: Row[]): Worker[] {
  return rows.map((r) => ({ recordId: r.id, ref: str(r.fields[F.worker.ref]) ?? "", name: str(r.fields[F.worker.name]) ?? "(no name)", active: r.fields[F.worker.active] === true }));
}
export function workerByRef(workers: Worker[], ref: string): { ok: true; worker: Worker } | { ok: false; httpStatus: 404 | 409; code: string; error: string } {
  const hits = workers.filter((w) => w.ref === ref);
  if (hits.length === 0) return { ok: false, httpStatus: 404, code: "coach_not_found", error: `No coach with Coach ID ${ref}` };
  if (hits.length > 1) return { ok: false, httpStatus: 409, code: "coach_id_ambiguous", error: `More than one coach record has Coach ID ${ref} - fix the duplicate first` };
  return { ok: true, worker: hits[0] };
}

function costBasisOf(v: unknown): { basis: CostBasis | null; recorded: boolean } {
  const s = sel(v);
  if (s === null || s === "") return { basis: "paid", recorded: false };
  const hit = (Object.entries(COST_BASIS_CHOICES) as [CostBasis, string][]).find(([, label]) => label === s);
  return hit ? { basis: hit[0], recorded: true } : { basis: null, recorded: true };
}

function coverageOf(world: CostWorld, a: Row, finalMinor: number | null): { view: WorkItem["workSummary"]; blocker: ItemBlockerCode | null } {
  const covering = links(a.fields[F.allocation.lines])
    .map((id) => world.lines.get(id))
    .filter((l): l is Row => !!l && links(l.fields[F.line.allocation]).includes(a.id))
    .map((l) => ({ line: l, summary: links(l.fields[F.line.summary]).map((s) => world.summaries.get(s)).find((s) => !!s && s.fields[F.summary.active] === true) }))
    .filter((x) => !!x.summary);
  if (covering.length === 0) return { view: null, blocker: "work_summary_missing" };
  const ids = new Set(covering.map((x) => x.summary!.id));
  const first = covering[0];
  const view = { ref: str(first.summary!.fields[F.summary.id]), status: sel(first.summary!.fields[F.summary.status]), lineFinalMinor: poundsToMinor(first.line.fields[F.line.finalCost]) };
  if (ids.size > 1) return { view, blocker: "work_summary_ambiguous" };
  if (view.status === "Queried") return { view, blocker: "work_summary_queried" };
  if (view.status !== "Finalised") return { view, blocker: "work_summary_not_finalised" };
  if (view.lineFinalMinor === null || finalMinor === null || view.lineFinalMinor !== finalMinor) return { view, blocker: "work_summary_stale" };
  return { view, blocker: null };
}

/**
 * Every work item of `worker` whose occurrence date is inside [from, to], each
 * with its blockers. Reads the allocation's frozen values only.
 */
export function workItemsOf(world: CostWorld, workerRecordId: string, from: string, to: string, today: string): WorkItem[] {
  const out: WorkItem[] = [];
  const mine = world.allocations.filter((a) => links(a.fields[F.allocation.worker]).includes(workerRecordId));
  const perOccurrence = new Map<string, number>();
  for (const a of mine) for (const o of links(a.fields[F.allocation.occurrence])) perOccurrence.set(o, (perOccurrence.get(o) ?? 0) + 1);
  for (const a of mine) {
    const occId = links(a.fields[F.allocation.occurrence])[0];
    const occ = occId ? world.occurrences.get(occId) : undefined;
    const workDate = occ?.fields[F.occurrence.date];
    if (!occ || !isDate(workDate) || workDate < from || workDate > to) continue;
    const blockers: Blocker[] = [];
    const add = (c: ItemBlockerCode) => blockers.push({ code: c, detail: ITEM_BLOCKERS[c] });
    const session = links(occ.fields[F.occurrence.session]).map((s) => world.sessions.get(s)).find((s) => !!s) ?? null;
    if (links(a.fields[F.allocation.worker]).length > 1) add("multiple_people");
    if ((perOccurrence.get(occ.id) ?? 0) > 1 || links(a.fields[F.allocation.occurrence]).length > 1) add("duplicate_allocation");
    const costStatus = sel(a.fields[F.allocation.costStatus]);
    if (!costStatus || !(ELIGIBLE_COST_STATUSES as readonly string[]).includes(costStatus)) add("cost_not_confirmed");
    const occStatus = sel(occ.fields[F.occurrence.status]);
    const outcome = sel(a.fields[F.allocation.outcome]);
    const validOutcome = outcome && (WORK_OUTCOMES as readonly string[]).includes(outcome) ? outcome : null;
    const needsOutcome = !!occStatus && (OUTCOME_REQUIRED_STATUSES as readonly string[]).includes(occStatus);
    if (needsOutcome && !validOutcome) add("outcome_undecided");
    if (!needsOutcome && workDate >= today && occStatus !== "Completed") add("not_yet_worked");

    const cb = costBasisOf(a.fields[F.allocation.costBasis]);
    const rawFinal = a.fields[F.allocation.finalCost];
    const finalMinor = rawFinal === undefined || rawFinal === null ? null : poundsToMinor(rawFinal);
    const rateMinor = a.fields[F.allocation.rate] === undefined || a.fields[F.allocation.rate] === null ? null : poundsToMinor(a.fields[F.allocation.rate]);
    const uh = unitsToHundredths(a.fields[F.allocation.units]);
    const rawOverride = a.fields[F.allocation.override];
    const overrideMinor = rawOverride === undefined || rawOverride === null ? null : poundsToMinor(rawOverride);
    const overrideReason = str(a.fields[F.allocation.overrideReason]);
    const rateType = sel(a.fields[F.allocation.rateType]);
    const payUnit = sel(a.fields[F.allocation.payUnit]);
    const rateProfile = links(a.fields[F.allocation.rateProfile])[0] ?? null;
    let standard: number | null = null;

    if (cb.basis === null) add("invalid_cost_basis");
    else if (cb.basis === "paid") {
      if (!rateProfile || !rateType || !payUnit || rateMinor === null || rateMinor < 0) add("missing_historical_rate");
      if (uh === null) add("invalid_units");
      if (rateMinor === 0) add("paid_zero_rate");
      if (rawFinal === undefined || rawFinal === null) add("missing_final_cost");
      else if (finalMinor === null || finalMinor < 0) add("invalid_final_cost");
      if (rawOverride !== undefined && rawOverride !== null && (overrideMinor === null || overrideMinor < 0)) add("invalid_final_cost");
      if (overrideMinor !== null && !overrideReason && !validOutcome) add("override_unexplained");
      if (rateMinor !== null && rateMinor > 0 && uh !== null) {
        const cands = standardCostCandidates(rateMinor, uh);
        standard = cands[0];
        if (finalMinor !== null && finalMinor >= 0) {
          const ok = overrideMinor !== null ? finalMinor === overrideMinor : cands.includes(finalMinor);
          if (!ok) add("cost_mismatch");
        }
      }
    } else {
      if (rawFinal === undefined || rawFinal === null) add("missing_final_cost");
      else if (finalMinor === null || finalMinor !== 0 || (overrideMinor !== null && overrideMinor !== 0)) add("no_cost_basis_with_cost");
    }

    const cov = coverageOf(world, a, finalMinor);
    if (cov.blocker) add(cov.blocker);

    out.push({
      allocationRecordId: a.id,
      allocationLabel: str(a.fields[F.allocation.id]) ?? a.id,
      occurrenceRecordId: occ.id,
      occurrenceRef: str(occ.fields[F.occurrence.id]),
      workDate,
      occurrenceStatus: occStatus,
      sessionRecordId: session?.id ?? null,
      sessionName: str(session?.fields[F.session.name]) ?? str(occ.fields[F.occurrence.name]) ?? "Session",
      financeServiceId: str(session?.fields[F.session.serviceId]),
      programmeLabel: str(session?.fields[F.session.programme]),
      costBasis: cb.basis,
      costBasisRecorded: cb.recorded,
      costStatus,
      rateProfileRecordId: rateProfile,
      rateType,
      payUnit,
      paidUnits: uh === null ? null : unitsText(uh),
      rateAmountMinor: rateMinor,
      standardCostMinor: standard,
      overrideMinor,
      overrideReason,
      workOutcome: validOutcome,
      outcomeDecidedBy: str(a.fields[F.allocation.outcomeBy]),
      outcomeDecidedAt: str(a.fields[F.allocation.outcomeAt]),
      finalCostMinor: cb.basis === "paid" || cb.basis === null ? (finalMinor !== null && finalMinor >= 0 ? finalMinor : null) : finalMinor === 0 ? 0 : null,
      workSummary: cov.view,
      blockers,
    });
  }
  return out.sort((x, y) => (x.workDate < y.workDate ? -1 : x.workDate > y.workDate ? 1 : x.allocationRecordId < y.allocationRecordId ? -1 : 1));
}

/** Blockers that stop finalising a worker's month (items + month level). */
export function finaliseBlockers(items: WorkItem[], month: string, today: string, paymentDay: unknown): Blocker[] {
  const out: Blocker[] = [];
  const b = monthBounds(month);
  if (b.to >= today) out.push({ code: "month_not_ended", detail: MONTH_BLOCKERS.month_not_ended });
  if (!expectedPaymentDate(month, paymentDay).ok) out.push({ code: "payment_day_not_configured", detail: MONTH_BLOCKERS.payment_day_not_configured });
  if (items.length === 0) out.push({ code: "nothing_to_finalise", detail: MONTH_BLOCKERS.nothing_to_finalise });
  return out;
}
export const itemBlockerCount = (items: WorkItem[]) => sum(items.map((i) => i.blockers.length));

export function freezeItem(i: WorkItem): FrozenItem {
  if (i.blockers.length || i.costBasis === null || i.finalCostMinor === null) throw new Error("freezeItem: only an unblocked item can be frozen");
  return {
    allocation_record_id: i.allocationRecordId,
    allocation_label: i.allocationLabel,
    occurrence_record_id: i.occurrenceRecordId,
    occurrence_ref: i.occurrenceRef,
    work_date: i.workDate,
    session_record_id: i.sessionRecordId,
    session_name: i.sessionName,
    finance_service_id: i.financeServiceId,
    programme_label: i.programmeLabel,
    cost_basis: i.costBasis,
    rate_type: i.rateType,
    pay_unit: i.payUnit,
    paid_units: i.paidUnits,
    rate_amount_minor: i.rateAmountMinor,
    override_minor: i.overrideMinor,
    override_reason: i.overrideReason,
    work_outcome: i.workOutcome,
    final_cost_minor: i.finalCostMinor,
    work_summary_ref: i.workSummary?.ref ?? null,
  };
}
export const FROZEN_KEYS: readonly (keyof FrozenItem)[] = [
  "allocation_record_id",
  "allocation_label",
  "occurrence_record_id",
  "occurrence_ref",
  "work_date",
  "session_record_id",
  "session_name",
  "finance_service_id",
  "programme_label",
  "cost_basis",
  "rate_type",
  "pay_unit",
  "paid_units",
  "rate_amount_minor",
  "override_minor",
  "override_reason",
  "work_outcome",
  "final_cost_minor",
  "work_summary_ref",
];

/** Canonical text of a month snapshot (sorted items, fixed key order); its sha256 is the integrity basis. */
export function snapshotText(workerRecordId: string, workMonth: string, totalMinor: number, items: FrozenItem[]): string {
  const sorted = [...items].sort((x, y) => (x.allocation_record_id < y.allocation_record_id ? -1 : 1));
  return JSON.stringify({ v: 1, worker: workerRecordId, month: workMonth, total: totalMinor, items: sorted.map((i) => FROZEN_KEYS.map((k) => i[k] ?? null)) });
}
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------
// Month state: Open / Finalised / Correction Required / Corrected
// ---------------------------------------------------------------------
export type MonthState = "open" | "finalised" | "correction_required" | "corrected";
export const MONTH_STATE_LABELS: Record<MonthState, string> = { open: "Open", finalised: "Finalised", correction_required: "Correction Required", corrected: "Corrected" };

export interface DriftEntry {
  kind: "changed" | "added" | "removed" | "unresolved";
  allocationLabel: string;
  workDate: string | null;
  frozen: string | null;
  now: string | null;
  allocationRecordId: string;
}
export interface MonthStatus {
  state: MonthState;
  liveTotalMinor: number;
  finalisedTotalMinor: number | null;
  correctionsTotalMinor: number;
  correctedTotalMinor: number | null;
  correctionRequired: boolean;
  drift: DriftEntry[];
}

/**
 * For a finalised month, compare the frozen snapshot with today's allocations.
 * Correction Required = the live cost total differs from the corrected total
 * (finalised + corrections), or a live item's COST is unresolved. Work Summary
 * review state alone (e.g. a reopened summary with unchanged costs) never
 * triggers it. Nothing is ever rewritten.
 */
export function monthStatus(month: FinanceMonth | null, frozen: FrozenItem[], corrections: Correction[], live: WorkItem[]): MonthStatus {
  const liveTotal = sum(live.map((i) => i.finalCostMinor ?? 0));
  if (!month) return { state: "open", liveTotalMinor: liveTotal, finalisedTotalMinor: null, correctionsTotalMinor: 0, correctedTotalMinor: null, correctionRequired: false, drift: [] };
  const corr = sum(corrections.map((c) => c.amountMinor));
  const corrected = month.finalisedTotalMinor + corr;
  const drift: DriftEntry[] = [];
  const liveBy = new Map(live.map((i) => [i.allocationRecordId, i]));
  for (const f of frozen) {
    const l = liveBy.get(f.allocation_record_id);
    if (!l) drift.push({ kind: "removed", allocationLabel: f.allocation_label, workDate: f.work_date, frozen: m(f.final_cost_minor), now: null, allocationRecordId: f.allocation_record_id });
    else if (l.finalCostMinor !== f.final_cost_minor) drift.push({ kind: "changed", allocationLabel: f.allocation_label, workDate: f.work_date, frozen: m(f.final_cost_minor), now: l.finalCostMinor === null ? null : m(l.finalCostMinor), allocationRecordId: f.allocation_record_id });
  }
  const frozenIds = new Set(frozen.map((f) => f.allocation_record_id));
  for (const l of live) if (!frozenIds.has(l.allocationRecordId)) drift.push({ kind: "added", allocationLabel: l.allocationLabel, workDate: l.workDate, frozen: null, now: l.finalCostMinor === null ? null : m(l.finalCostMinor), allocationRecordId: l.allocationRecordId });
  const costUnresolved = live.filter((i) => i.blockers.some((b) => !(REVIEW_BLOCKERS as readonly string[]).includes(b.code) && b.code !== "not_yet_worked"));
  for (const l of costUnresolved) if (!drift.some((d) => d.allocationRecordId === l.allocationRecordId)) drift.push({ kind: "unresolved", allocationLabel: l.allocationLabel, workDate: l.workDate, frozen: null, now: null, allocationRecordId: l.allocationRecordId });
  const required = liveTotal !== corrected || costUnresolved.length > 0;
  const state: MonthState = required ? "correction_required" : corrections.length ? "corrected" : "finalised";
  return { state, liveTotalMinor: liveTotal, finalisedTotalMinor: month.finalisedTotalMinor, correctionsTotalMinor: corr, correctedTotalMinor: corrected, correctionRequired: required, drift };
}

// ---------------------------------------------------------------------
// Views (technical ids only under `technical`)
// ---------------------------------------------------------------------
const programmeOf = (serviceId: string | null, label: string | null) => ({ financeServiceId: serviceId, label, resolved: !!serviceId });
const basisLabel = (b: CostBasis | null) => (b ? COST_BASIS_CHOICES[b] : null);

export function liveItemView(i: WorkItem) {
  return {
    date: i.workDate,
    session: i.sessionName,
    occurrenceStatus: i.occurrenceStatus,
    programme: programmeOf(i.financeServiceId, i.programmeLabel),
    costBasis: basisLabel(i.costBasis),
    costBasisRecorded: i.costBasisRecorded,
    rateType: i.rateType,
    payUnit: i.payUnit,
    units: i.paidUnits,
    rate: i.rateAmountMinor === null ? null : m(i.rateAmountMinor),
    amount: i.finalCostMinor === null ? null : m(i.finalCostMinor),
    override: overrideView(i.standardCostMinor, i.overrideMinor, i.overrideReason, i.workOutcome, i.outcomeDecidedBy, i.outcomeDecidedAt, i.finalCostMinor),
    workSummary: i.workSummary ? { ref: i.workSummary.ref, status: i.workSummary.status, lineAmount: i.workSummary.lineFinalMinor === null ? null : m(i.workSummary.lineFinalMinor) } : null,
    blockers: i.blockers,
    technical: { allocationRecordId: i.allocationRecordId, allocationId: i.allocationLabel, occurrenceRecordId: i.occurrenceRecordId, occurrenceId: i.occurrenceRef, rateProfileRecordId: i.rateProfileRecordId },
  };
}
export function frozenItemView(f: FrozenItem) {
  const standard = f.rate_amount_minor !== null && f.paid_units !== null ? standardCostCandidates(f.rate_amount_minor, Math.round(Number(f.paid_units) * 100))[0] : null;
  return {
    date: f.work_date,
    session: f.session_name,
    programme: programmeOf(f.finance_service_id, f.programme_label),
    costBasis: COST_BASIS_CHOICES[f.cost_basis],
    rateType: f.rate_type,
    payUnit: f.pay_unit,
    units: f.paid_units,
    rate: f.rate_amount_minor === null ? null : m(f.rate_amount_minor),
    amount: m(f.final_cost_minor),
    override: overrideView(standard, f.override_minor, f.override_reason, f.work_outcome, null, null, f.final_cost_minor),
    workSummaryRef: f.work_summary_ref,
    technical: { allocationRecordId: f.allocation_record_id, allocationId: f.allocation_label, occurrenceRecordId: f.occurrence_record_id, occurrenceId: f.occurrence_ref },
  };
}
function overrideView(standard: number | null, override: number | null, reason: string | null, outcome: string | null, by: string | null, at: string | null, final: number | null) {
  const applied = override !== null || (outcome !== null && outcome !== "Paid");
  return {
    applied,
    /** The frozen rate x units, for comparison only - never the paid amount when an override applies. */
    standardAmount: standard === null ? null : m(standard),
    amount: override === null ? null : m(override),
    reason,
    workOutcome: outcome,
    decidedBy: by,
    decidedAt: at,
    /** Coaches stores no approver on a /allocate override - only its reason. */
    approverRecorded: !!by,
    finalAmount: final === null ? null : m(final),
  };
}
export function monthView(fm: FinanceMonth) {
  return {
    monthId: fm.monthId,
    coach: { coachId: fm.workerRef, name: fm.workerName },
    workMonth: fm.workMonth,
    finalisedTotal: m(fm.finalisedTotalMinor),
    itemCount: fm.itemCount,
    finalisedAt: fm.finalisedAt,
    finalisedBy: fm.finalisedBy,
    reason: fm.reason,
    payment: paymentView(fm.workMonth, fm.paymentDay, fm.expectedPaymentDate),
    integrity: { snapshotSha256: fm.snapshotHash },
  };
}
export function paymentView(workMonth: string, day: number | null, date: string | null) {
  return {
    configuredDay: day,
    expectedPaymentDate: date,
    /** No reliable payment source exists yet: never "paid" just because it is finalised. Cash Flow is not built. */
    paymentState: "not_tracked",
    workMonth,
  };
}
export function correctionView(c: Correction) {
  return { correctionId: c.correctionId, amount: m(c.amountMinor), reason: c.reason, resultingTotal: m(c.resultingTotalMinor), createdAt: c.createdAt, createdBy: c.createdBy, technical: { allocationRecordId: c.allocationRecordId } };
}
export function statusView(s: MonthStatus) {
  return {
    state: s.state,
    stateLabel: MONTH_STATE_LABELS[s.state],
    liveTotal: m(s.liveTotalMinor),
    finalisedTotal: s.finalisedTotalMinor === null ? null : m(s.finalisedTotalMinor),
    corrections: m(s.correctionsTotalMinor),
    correctedTotal: s.correctedTotalMinor === null ? null : m(s.correctedTotalMinor),
    correctionRequired: s.correctionRequired,
    drift: s.drift.map((d) => ({ kind: d.kind, allocation: d.allocationLabel, date: d.workDate, frozen: d.frozen, now: d.now })),
  };
}

/** Totals per stable Finance Service ID; sessions without one are "unresolved" (never guessed from the person or venue). */
export function byProgramme(items: { financeServiceId: string | null; programmeLabel: string | null; amountMinor: number | null }[]) {
  const groups = new Map<string, { financeServiceId: string | null; labels: Set<string>; totalMinor: number; count: number; unpriced: number }>();
  for (const i of items) {
    const key = i.financeServiceId ?? "unresolved";
    const g = groups.get(key) ?? { financeServiceId: i.financeServiceId, labels: new Set<string>(), totalMinor: 0, count: 0, unpriced: 0 };
    if (i.programmeLabel) g.labels.add(i.programmeLabel);
    g.count++;
    if (i.amountMinor === null) g.unpriced++;
    else g.totalMinor += i.amountMinor;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((x, y) => (x.financeServiceId === null ? 1 : y.financeServiceId === null ? -1 : x.financeServiceId < y.financeServiceId ? -1 : 1))
    .map((g) => ({ financeServiceId: g.financeServiceId, resolved: g.financeServiceId !== null, labels: [...g.labels].sort(), total: m(g.totalMinor), workItems: g.count, unresolvedCost: g.unpriced }));
}

export function costAudit(a: { organisationId: string; actorUserId: string; eventType: string; entityType: string; recordId: string; before: Record<string, unknown> | null; after: Record<string, unknown>; reason: string | null; route: string }) {
  const e = auditEvent(a);
  return { ...e, context: { ...e.context, contract: COACH_COST_CONTRACT } };
}

// ---------------------------------------------------------------------
// Routes + requests
// ---------------------------------------------------------------------
export type CostRoute =
  | { name: "costs.month"; params: Record<string, never> }
  | { name: "costs.worker"; params: { workerRef: string } }
  | { name: "costs.workerMonth"; params: { workerRef: string; month: string } }
  | { name: "costs.finalise"; params: { workerRef: string; month: string } }
  | { name: "costs.facts"; params: Record<string, never> }
  | { name: "summaries.list"; params: Record<string, never> }
  | { name: "summaries.one"; params: { monthId: string } }
  | { name: "summaries.correct"; params: { monthId: string } };
export type CostMatch = { status: "match"; route: CostRoute } | { status: "method"; allowed: string[] } | { status: "not_found" } | null;
const ROOTS = ["coach-costs", "coach-summaries", "coach-cost-facts"];

/** F12 owns these paths. There is deliberately no payment, payroll, coach-invoice or reopen route. */
export function matchCoachCostRoute(path: string, method: string): CostMatch {
  const seg = path.split("/");
  if (!ROOTS.includes(seg[0])) return null;
  const mt = (allowed: string[], route: CostRoute): CostMatch => (allowed.includes(method) ? { status: "match", route } : { status: "method", allowed });
  if (seg.length === 1 && seg[0] === "coach-costs") return mt(["GET"], { name: "costs.month", params: {} });
  if (seg[0] === "coach-costs" && seg.length >= 2 && WORKER_REF_PATTERN.test(seg[1])) {
    if (seg.length === 2) return mt(["GET"], { name: "costs.worker", params: { workerRef: seg[1] } });
    if (MONTH_PATTERN.test(seg[2] ?? "")) {
      if (seg.length === 3) return mt(["GET"], { name: "costs.workerMonth", params: { workerRef: seg[1], month: seg[2] } });
      if (seg.length === 4 && seg[3] === "finalise") return mt(["POST"], { name: "costs.finalise", params: { workerRef: seg[1], month: seg[2] } });
    }
  }
  if (seg.length === 1 && seg[0] === "coach-cost-facts") return mt(["GET"], { name: "costs.facts", params: {} });
  if (seg.length === 1 && seg[0] === "coach-summaries") return mt(["GET"], { name: "summaries.list", params: {} });
  if (seg[0] === "coach-summaries" && seg.length >= 2 && MONTH_ID_PATTERN.test(seg[1])) {
    if (seg.length === 2) return mt(["GET"], { name: "summaries.one", params: { monthId: seg[1] } });
    if (seg.length === 3 && seg[2] === "corrections") return mt(["POST"], { name: "summaries.correct", params: { monthId: seg[1] } });
  }
  return { status: "not_found" };
}

export type Invalid = { ok: false; httpStatus: 400; code: string; error: string; fields?: Record<string, string> };
const invalid = (code: string, error: string, fields?: Record<string, string>): Invalid => ({ ok: false, httpStatus: 400, code, error, ...(fields ? { fields } : {}) });
export const LIST_STATES: readonly MonthState[] = ["finalised", "correction_required", "corrected"];

export type CostQuery = { ok: true; month?: string; from?: string; to?: string; state?: MonthState };
export function parseCostQuery(route: CostRoute["name"], q: URLSearchParams, isTenantKey: (k: string) => boolean): CostQuery | Invalid {
  const keys = [...q.keys()];
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const allowed: Partial<Record<CostRoute["name"], string[]>> = { "costs.month": ["month"], "costs.worker": ["from", "to"], "costs.facts": ["from", "to"], "summaries.list": ["month", "state"] };
  const ok = allowed[route] ?? [];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) return invalid("unexpected_parameter", `Unexpected query parameter(s): ${[...new Set(bad)].join(", ")}`);
  if (new Set(keys).size !== keys.length) return invalid("unexpected_parameter", "A query parameter is repeated");
  const out: CostQuery = { ok: true };
  for (const k of ["month", "from", "to"] as const) {
    const v = q.get(k);
    if (v === null) continue;
    if (!MONTH_PATTERN.test(v)) return invalid("invalid_query", `${k} must be a month YYYY-MM`);
    out[k] = v;
  }
  const s = q.get("state");
  if (s !== null) {
    if (!(LIST_STATES as readonly string[]).includes(s)) return invalid("invalid_query", `state must be one of ${LIST_STATES.join(", ")}`);
    out.state = s as MonthState;
  }
  return out;
}
/** Inclusive month range (default: the 6 months ending `current`), at most MAX_RANGE_MONTHS. */
export function monthRange(from: string | undefined, to: string | undefined, current: string): { ok: true; from: string; to: string } | Invalid {
  const t = to ?? current;
  const f = from ?? addMonths(t, -5);
  if (f > t) return invalid("invalid_query", "from must be on or before to");
  if (monthsBetween(f, t).length > MAX_RANGE_MONTHS) return invalid("invalid_query", `The range may be at most ${MAX_RANGE_MONTHS} months`);
  return { ok: true, from: f, to: t };
}

function jsonObject(raw: string, allowed: readonly string[], isTenantKey: (k: string) => boolean, emptyOk: boolean): { ok: true; body: Record<string, unknown> } | Invalid {
  if (!raw.trim()) return emptyOk ? { ok: true, body: {} } : invalid("invalid_body", "Body must be a JSON object");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return invalid("invalid_body", "Body must be valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("invalid_body", "Body must be a JSON object");
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some(isTenantKey)) return invalid("tenant_param_rejected", TENANT_ERROR);
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (unknown.length) return invalid("unexpected_field", `Unexpected field(s): ${unknown.join(", ")}`);
  return { ok: true, body: body as Record<string, unknown> };
}
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
function text(v: unknown, required: boolean): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be text" };
  const t = v.trim();
  if (!t) return required ? { ok: false, error: "is required" } : { ok: true, value: null };
  if (t.length > REASON_MAX) return { ok: false, error: `must be at most ${REASON_MAX} characters` };
  if (CONTROL_RE.test(t)) return { ok: false, error: "contains control characters" };
  return { ok: true, value: t };
}

/** POST /coach-costs/{coach}/{month}/finalise { reason? } */
export function parseFinalise(raw: string, isTenantKey: (k: string) => boolean): { ok: true; reason: string | null } | Invalid {
  const b = jsonObject(raw, ["reason"], isTenantKey, true);
  if (!b.ok) return b;
  const r = text(b.body.reason, false);
  if (!r.ok) return invalid("invalid_input", "Some fields are not valid - nothing was finalised", { reason: r.error });
  return { ok: true, reason: r.value };
}
/** POST /coach-summaries/{FCM}/corrections { amount (signed, not 0), reason, allocationId? } */
export function parseCorrection(raw: string, isTenantKey: (k: string) => boolean): { ok: true; amountMinor: number; reason: string; allocationRecordId: string | null } | Invalid {
  const b = jsonObject(raw, ["amount", "reason", "allocationId"], isTenantKey, false);
  if (!b.ok) return b;
  const f: Record<string, string> = {};
  let amountMinor = 0;
  const a = b.body.amount;
  if (a === undefined || a === null) f.amount = "is required";
  else {
    const p = parseMoney(a);
    if (!p.ok) f.amount = p.error;
    else if (p.minor === 0) f.amount = "must not be 0.00";
    else amountMinor = p.minor;
  }
  const r = text(b.body.reason, true);
  if (!r.ok) f.reason = r.error;
  let alloc: string | null = null;
  const al = b.body.allocationId;
  if (al !== undefined && al !== null) {
    if (typeof al !== "string" || !RECORD_ID_RE.test(al)) f.allocationId = "must be an allocation record id (rec...)";
    else alloc = al;
  }
  if (Object.keys(f).length) return invalid("invalid_input", "Some fields are not valid - no correction was recorded", f);
  return { ok: true, amountMinor, reason: (r as { value: string }).value, allocationRecordId: alloc };
}
