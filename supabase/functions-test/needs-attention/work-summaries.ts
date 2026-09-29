/**
 * Work Summary + coach-outcome evaluators for Needs Attention Slice 8 (see
 * TEST-ENV.md "Needs Attention Foundation - Slice 8"):
 *
 *   coach_outcome_pending (ATT-043), work_summary_queried (ATT-044),
 *   work_summary_ready_to_finalise (ATT-045), work_summary_blocked (ATT-046).
 *
 * Source of truth is the Coaches Slice 6 / Slice 10 domain. This file
 * never re-decides it:
 *  - The Work Summary rules are the domain's own pure functions and its own
 *    classification loop, COPIED VERBATIM below from
 *    coach-work-summaries/work-summaries.ts and
 *    coach-work-summaries/orchestrator.ts (drift-tested chunk by chunk).
 *  - Stored Work Summary Status can be stale (only prepare/refresh/finalise
 *    rewrite it), so the EFFECTIVE status is recomputed exactly as
 *    applyRefresh() would (NA2.6 contract): Finalised stays Finalised,
 *    Queried stays Queried, anything else is openStatusFor(pending, period,
 *    today). Nothing is ever written back.
 *  - The coach outcome lives on the Coach Allocation (Slice 6). The test is
 *    classifyAllocation's own two lines: Session Occurrence Status Cancelled
 *    or Postponed and Coach Outcome not Paid / Partial / Unpaid. Parent and
 *    Venue outcomes (Occurrence Financial Outcomes) are Finance, never read.
 *
 * Read-only. One shared Work Summary pass and one shared coach-outcome pass
 * per request (memoised); no per-summary / per-coach / per-occurrence reads.
 */
import type { CandidateCase, ConfigIssue, EvaluatorContext, EvaluatorRegistration } from "./needs-attention.ts";
import { formatLocal } from "./staffing.ts";

// ===== COPIED FROM coach-work-summaries/work-summaries.ts - DO NOT EDIT HERE =====
export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

/** Production `Coach Work Summaries.Status` choices, exactly. */
export const SUMMARY_STATUSES = ["Not ready", "Needs review", "Finalised", "Queried"] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

/** Coach Allocations.Cost Status values that mean "the cost has been confirmed" (Draft can still change). */
export const ELIGIBLE_COST_STATUSES = ["Confirmed", "Exported"] as const;
/** Occurrence statuses whose coach cost depends on a Slice 6 Coach Outcome decision. */
export const OUTCOME_REQUIRED_STATUSES = ["Cancelled", "Postponed"] as const;
export const COACH_OUTCOMES = ["Paid", "Partial", "Unpaid"] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Europe/London calendar date for an instant (same implementation as coach-compliance's ukToday). */
export function ukToday(now: Date): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function selectName(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.name === "string") return v.name;
  return null;
}

export function linkIds(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x?.id)).filter((x): x is string => typeof x === "string");
}

export function firstLink(fields: Record<string, any>, name: string): string | null {
  return linkIds(fields[name])[0] ?? null;
}

export function toPence(v: number): number {
  return Math.round(v * 100);
}

export function roundCurrency(v: number): number {
  return toPence(v) / 100;
}

export function isValidCost(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export interface Period {
  start: string;
  end: string;
}

/** Inclusive at both ends; plain ISO-date string comparison (the work date is a calendar date, not an instant). */
export function isWithinPeriod(workDate: string, period: Period): boolean {
  return workDate >= period.start && workDate <= period.end;
}

export function summaryPeriod(summary: AirtableRecord): Period | null {
  const start = summary.fields["Period Start"];
  const end = summary.fields["Period End"];
  return isIsoDate(start) && isIsoDate(end) ? { start, end } : null;
}

export type PendingReason =
  | "cost_not_confirmed"
  | "invalid_final_cost"
  | "coach_outcome_undecided"
  | "not_yet_worked"
  | "multiple_coaches";

export const PENDING_REASON_TEXT: Record<PendingReason, string> = {
  cost_not_confirmed: "Cost Status is not Confirmed/Exported yet (Draft can still change)",
  invalid_final_cost: "Final Coach Cost is missing or invalid",
  coach_outcome_undecided: "Occurrence was cancelled/postponed and no Coach Outcome (Paid/Partial/Unpaid) has been decided",
  not_yet_worked: "Work date has not happened yet",
  multiple_coaches: "Allocation links more than one Coach",
};

export interface AllocationContext {
  allocation: AirtableRecord;
  occurrence: AirtableRecord | null;
  session: AirtableRecord | null;
}

export interface EligibleItem {
  allocationId: string;
  allocationLabel: string;
  occurrenceId: string;
  workDate: string;
  startTime: string | null;
  occurrenceStatus: string | null;
  coachOutcome: string | null;
  sessionName: string;
  groupLabel: string;
  rateType: string | null;
  paidUnits: number | null;
  rateAmount: number | null;
  finalCost: number;
}

export interface PendingItem {
  allocationId: string;
  allocationLabel: string;
  workDate: string;
  reason: PendingReason;
  detail: string;
}

export type Classification =
  | { kind: "not_mine" }
  | { kind: "undated"; allocationId: string; allocationLabel: string }
  | { kind: "out_of_period" }
  | { kind: "pending"; item: PendingItem }
  | { kind: "eligible"; item: EligibleItem };

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Description used in the frozen line; a cancelled/postponed item says so, so a £0 Unpaid line is self-explanatory. */
export function describeWork(sessionName: string, occurrenceStatus: string | null, coachOutcome: string | null): string {
  if (occurrenceStatus && (OUTCOME_REQUIRED_STATUSES as readonly string[]).includes(occurrenceStatus) && coachOutcome) {
    return `${sessionName} - ${occurrenceStatus} (Coach outcome: ${coachOutcome})`;
  }
  return sessionName;
}

export function groupLabelFor(session: AirtableRecord | null, rateType: string | null): string {
  const f = session?.fields ?? {};
  for (const k of ["Programme", "Category"]) {
    if (typeof f[k] === "string" && f[k].trim()) return f[k].trim();
  }
  return rateType || "Other";
}

/**
 * The eligibility rule, derived from the real schema (see TEST-ENV.md):
 * belongs to the coach; work date (the occurrence Date, never the
 * allocation's created time) inside the inclusive period; Cost Status
 * Confirmed/Exported; valid Final Coach Cost; a cancelled/postponed
 * occurrence needs a Slice 6 Coach Outcome; the work date has passed.
 * Anything in the period that fails a check is PENDING (reported, blocks
 * finalisation) - never silently dropped.
 */
export function classifyAllocation(ctx: AllocationContext, coachId: string, period: Period, today: string): Classification {
  const a = ctx.allocation;
  const coaches = linkIds(a.fields["Coach"]);
  if (!coaches.includes(coachId)) return { kind: "not_mine" };
  const label = typeof a.fields["Allocation ID"] === "string" && a.fields["Allocation ID"] ? a.fields["Allocation ID"] : a.id;
  const occ = ctx.occurrence;
  const workDate = occ?.fields["Date"];
  if (!occ || !isIsoDate(workDate)) return { kind: "undated", allocationId: a.id, allocationLabel: label };
  if (!isWithinPeriod(workDate, period)) return { kind: "out_of_period" };

  const pending = (reason: PendingReason): Classification => ({
    kind: "pending",
    item: { allocationId: a.id, allocationLabel: label, workDate, reason, detail: PENDING_REASON_TEXT[reason] },
  });
  if (coaches.length > 1) return pending("multiple_coaches");
  const costStatus = selectName(a.fields["Cost Status"]);
  if (!costStatus || !(ELIGIBLE_COST_STATUSES as readonly string[]).includes(costStatus)) return pending("cost_not_confirmed");
  const finalCost = a.fields["Final Coach Cost"];
  if (!isValidCost(finalCost)) return pending("invalid_final_cost");
  const occStatus = selectName(occ.fields["Status"]);
  const outcome = selectName(a.fields["Coach Outcome"]);
  const needsOutcome = !!occStatus && (OUTCOME_REQUIRED_STATUSES as readonly string[]).includes(occStatus);
  if (needsOutcome && !(outcome && (COACH_OUTCOMES as readonly string[]).includes(outcome))) return pending("coach_outcome_undecided");
  if (!needsOutcome && workDate >= today && occStatus !== "Completed") return pending("not_yet_worked");

  const rateType = selectName(a.fields["Rate Type Snapshot"]);
  const sessionName = (typeof ctx.session?.fields["Session Name"] === "string" && ctx.session.fields["Session Name"]) || (typeof occ.fields["Occurrence Name"] === "string" && occ.fields["Occurrence Name"]) || "Session";
  return {
    kind: "eligible",
    item: {
      allocationId: a.id,
      allocationLabel: label,
      occurrenceId: occ.id,
      workDate,
      startTime: typeof occ.fields["Start Date & Time"] === "string" ? occ.fields["Start Date & Time"] : null,
      occurrenceStatus: occStatus,
      coachOutcome: needsOutcome ? outcome : null,
      sessionName: describeWork(sessionName, occStatus, needsOutcome ? outcome : null),
      groupLabel: groupLabelFor(ctx.session, rateType),
      rateType,
      paidUnits: numOrNull(a.fields["Paid Units"]),
      rateAmount: numOrNull(a.fields["Rate Amount Snapshot"]),
      finalCost: roundCurrency(finalCost),
    },
  };
}

export function summaryStatus(summary: AirtableRecord): SummaryStatus | null {
  const s = selectName(summary.fields["Status"]);
  return s && (SUMMARY_STATUSES as readonly string[]).includes(s) ? (s as SummaryStatus) : null;
}

/**
 * Lines are frozen while the latest finalisation has not been undone by a
 * later reopen: Status Finalised, or Queried after being finalised (the
 * coach queried the frozen summary; it stays frozen until Management
 * reopens or re-finalises).
 */
export function isFrozen(summary: AirtableRecord): boolean {
  const status = summaryStatus(summary);
  if (status === "Finalised") return true;
  if (status !== "Queried") return false;
  const fin = Date.parse(summary.fields["Finalised At"] ?? "");
  if (Number.isNaN(fin)) return false;
  const reo = Date.parse(summary.fields["Reopened At"] ?? "");
  return Number.isNaN(reo) || reo < fin;
}

export function isActive(summary: AirtableRecord): boolean {
  return summary.fields["Active"] === true;
}

/** The status an OPEN summary should carry: Not ready while anything is pending or the period is not over yet. */
export function openStatusFor(pendingCount: number, period: Period, today: string): "Not ready" | "Needs review" {
  return pendingCount > 0 || period.end >= today ? "Not ready" : "Needs review";
}
// ===== END COPIED BLOCK =====

// ===== COPIED FROM coach-work-summaries/orchestrator.ts - DO NOT EDIT HERE =====
interface Evaluation {
  eligible: EligibleItem[];
  pending: PendingItem[];
  undated: { allocationId: string; allocationLabel: string }[];
}

function evaluate(world: World, coachId: string, period: Period, today: string): Evaluation {
  const occById = new Map(world.occurrences.map((o) => [o.id, o]));
  const sessionById = new Map(world.sessions.map((s) => [s.id, s]));
  const out: Evaluation = { eligible: [], pending: [], undated: [] };
  for (const a of world.allocations) {
    const occ = occById.get(firstLink(a.fields, "Session Occurrence") ?? "") ?? null;
    const session = occ ? sessionById.get(firstLink(occ.fields, "Session") ?? "") ?? null : null;
    const c = classifyAllocation({ allocation: a, occurrence: occ, session }, coachId, period, today);
    if (c.kind === "eligible") out.eligible.push(c.item);
    else if (c.kind === "pending") out.pending.push(c.item);
    else if (c.kind === "undated") out.undated.push({ allocationId: c.allocationId, allocationLabel: c.allocationLabel });
  }
  return out;
}
// ===== END COPIED BLOCK =====

/** The three tables the copied evaluate() loop reads (coach-work-summaries' World, narrowed). */
type World = { allocations: AirtableRecord[]; occurrences: AirtableRecord[]; sessions: AirtableRecord[] };

// ---------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------

export const WORK_SUMMARY_TABLES = {
  summaries: "Coach Work Summaries",
  allocations: "Coach Allocations",
  occurrences: "Session Occurrences",
  sessions: "Sessions",
  coaches: "Coaches",
} as const;
/** Session Occurrences / Sessions / Coaches are shared with the staffing rules, so the engine loads each only once. */
export const WORK_SUMMARY_SOURCES: readonly string[] = Object.values(WORK_SUMMARY_TABLES);
/** coach_outcome_pending needs no Work Summary table - and never Occurrence Financial Outcomes (Parent/Venue = Finance). */
export const COACH_OUTCOME_SOURCES: readonly string[] = [WORK_SUMMARY_TABLES.allocations, WORK_SUMMARY_TABLES.occurrences, WORK_SUMMARY_TABLES.sessions, WORK_SUMMARY_TABLES.coaches];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const QUERY_NOTE_MAX = 280;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "30 Sep 2026" - fixed month names so the text is identical on every runtime/ICU version. */
export function formatDate(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The calendar date (YYYY-MM-DD) an instant falls on in `timeZone`; null when unparseable. */
export function localDateOf(instant: string | null, timeZone: string): string | null {
  const t = instant ? Date.parse(instant) : NaN;
  if (Number.isNaN(t)) return null;
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** The instant a calendar date starts in `timeZone` (00:00 local), e.g. 2026-10-01 London = 2026-09-30T23:00:00.000Z. */
export function localMidnightIso(dateIso: string, timeZone: string): string | null {
  if (!isIsoDate(dateIso)) return null;
  const [y, m, d] = dateIso.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const offsetAt = (t: number) => {
    const p: Record<string, string> = {};
    for (const x of new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = target - offsetAt(target);
  t = target - offsetAt(t);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------
// Work Summary effective status -> rule (the NA2.6 contract)
// ---------------------------------------------------------------------

export type EffectiveStatus = SummaryStatus;
export type SummaryRuleKey = "work_summary_queried" | "work_summary_ready_to_finalise" | "work_summary_blocked";

/**
 * Mirrors applyRefresh() line for line: Finalised and Queried are workflow
 * states the refresh never moves; every other stored status is recomputed
 * from the current allocations (stale Not ready / Needs review corrected).
 */
export function effectiveStatus(stored: SummaryStatus, pendingCount: number, period: Period, today: string): EffectiveStatus {
  if (stored === "Finalised") return "Finalised";
  if (stored === "Queried") return "Queried";
  return openStatusFor(pendingCount, period, today);
}

/**
 * Exactly one rule per effective status, so one summary can never produce
 * two contradictory cases:
 *   Queried                                  -> work_summary_queried
 *   Needs review                             -> work_summary_ready_to_finalise
 *   Not ready AND the period has ended       -> work_summary_blocked
 *   Not ready while the period is still open -> nothing (work in progress)
 *   Finalised                                -> nothing
 */
export function summaryRuleFor(effective: EffectiveStatus, period: Period, today: string): SummaryRuleKey | null {
  if (effective === "Queried") return "work_summary_queried";
  if (effective === "Needs review") return "work_summary_ready_to_finalise";
  if (effective === "Not ready" && period.end < today) return "work_summary_blocked";
  return null;
}

export interface SummaryAnalysis {
  summaryId: string;
  workSummaryId: string;
  coachId: string;
  coachName: string | null;
  coachFound: boolean;
  coachActive: boolean;
  period: Period;
  storedStatus: SummaryStatus;
  effectiveStatus: EffectiveStatus;
  rule: SummaryRuleKey;
  frozen: boolean;
  pending: PendingItem[];
  eligibleCount: number;
  undated: { allocationId: string; allocationLabel: string }[];
  queriedAt: string | null;
  /** Calendar date of Queried At in the organisation timezone (for the case text). */
  queriedOn: string | null;
  queryNote: string | null;
  finalisedAt: string | null;
  reopenedAt: string | null;
  /** Midnight (organisation timezone) after the inclusive Period End - the ready / blocked overdue anchor. */
  periodEndedAt: string | null;
  today: string;
}

export interface WorkSummaryPass {
  analyses: SummaryAnalysis[];
  skipped: Record<string, number>;
  issues: ConfigIssue[];
  today: string;
}

export const workSummaryPassStats = { passes: 0 };

export function runWorkSummaryPass(sources: Readonly<Record<string, readonly AirtableRecord[]>>, now: Date, timeZone: string): WorkSummaryPass {
  workSummaryPassStats.passes++;
  const T = WORK_SUMMARY_TABLES;
  const today = ukToday(now);
  const coachById = new Map((sources[T.coaches] ?? []).map((c) => [c.id, c]));
  // Index allocations by EVERY linked coach - identical results to the domain's full scan (anything else is not_mine).
  const allocationsByCoach = new Map<string, AirtableRecord[]>();
  for (const a of sources[T.allocations] ?? []) {
    for (const c of linkIds(a.fields["Coach"])) allocationsByCoach.set(c, [...(allocationsByCoach.get(c) ?? []), a]);
  }
  const occurrences = [...(sources[T.occurrences] ?? [])];
  const sessions = [...(sources[T.sessions] ?? [])];

  const analyses: SummaryAnalysis[] = [];
  const skipped: Record<string, number> = {};
  const issues: ConfigIssue[] = [];
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

  for (const s of sources[T.summaries] ?? []) {
    if (!isActive(s)) {
      skip("inactive");
      continue;
    }
    const stored = summaryStatus(s);
    const period = summaryPeriod(s);
    const coachId = firstLink(s.fields, "Coach");
    if (!stored || !period || !coachId) {
      skip("invalid");
      const what = [!coachId ? "no Coach" : null, !period ? "no valid Period Start/End" : null, !stored ? `unrecognised Status ${JSON.stringify(selectName(s.fields["Status"]))}` : null].filter(Boolean).join(", ");
      issues.push({ code: "work_summary_invalid", recordId: s.id, detail: `Active Coach Work Summary ${s.id} cannot be evaluated (${what}); no case is raised for it.` });
      continue;
    }
    if (stored === "Finalised") {
      skip("finalised");
      continue;
    }
    const ev = evaluate({ allocations: allocationsByCoach.get(coachId) ?? [], occurrences, sessions }, coachId, period, today);
    const effective = effectiveStatus(stored, ev.pending.length, period, today);
    const rule = summaryRuleFor(effective, period, today);
    if (!rule) {
      skip("period_in_progress");
      continue;
    }
    const coach = coachById.get(coachId) ?? null;
    if (!coach) issues.push({ code: "work_summary_coach_missing", recordId: s.id, detail: `Coach Work Summary ${s.id} links Coach ${coachId}, which is not in the Coaches table. The case is still shown.` });
    const note = str(s.fields["Query / Reopen Note"]);
    analyses.push({
      summaryId: s.id,
      workSummaryId: str(s.fields["Work Summary ID"]) ?? s.id,
      coachId,
      coachName: coach ? str(coach.fields["Coach Name"]) : null,
      coachFound: !!coach,
      coachActive: coach?.fields["Active"] === true,
      period,
      storedStatus: stored,
      effectiveStatus: effective,
      rule,
      frozen: isFrozen(s),
      pending: ev.pending,
      eligibleCount: ev.eligible.length,
      undated: ev.undated,
      queriedAt: str(s.fields["Queried At"]),
      queriedOn: localDateOf(str(s.fields["Queried At"]), timeZone),
      queryNote: note && note.length > QUERY_NOTE_MAX ? `${note.slice(0, QUERY_NOTE_MAX - 1)}…` : note,
      finalisedAt: str(s.fields["Finalised At"]),
      reopenedAt: str(s.fields["Reopened At"]),
      periodEndedAt: localMidnightIso(addDaysIso(period.end, 1), timeZone),
      today,
    });
    if (rule === "work_summary_queried" && !str(s.fields["Queried At"])) {
      issues.push({ code: "work_summary_query_time_unknown", recordId: s.id, detail: `Queried Coach Work Summary ${s.id} has no Queried At, so the 3-day overdue Warning cannot apply.` });
    }
  }
  return { analyses, skipped, issues, today };
}

const summaryPassCache = new WeakMap<object, { key: string; pass: WorkSummaryPass }>();

/** One shared Work Summary pass per request (memoised on the loaded summaries array identity). */
export function sharedWorkSummaryPass(ctx: EvaluatorContext): WorkSummaryPass {
  const summaries = ctx.sources[WORK_SUMMARY_TABLES.summaries] ?? [];
  const key = `${ctx.now.getTime()}|${ctx.organisation.timezone}|${WORK_SUMMARY_SOURCES.map((t) => (ctx.sources[t] ?? []).length).join(",")}`;
  const hit = summaryPassCache.get(summaries);
  if (hit && hit.key === key) return hit.pass;
  const pass = runWorkSummaryPass(ctx.sources, ctx.now, ctx.organisation.timezone);
  summaryPassCache.set(summaries, { key, pass });
  return pass;
}

const PENDING_KEYS: Record<PendingReason, string> = {
  cost_not_confirmed: "pendingCostNotConfirmed",
  invalid_final_cost: "pendingInvalidFinalCost",
  coach_outcome_undecided: "pendingCoachOutcomeUndecided",
  not_yet_worked: "pendingNotYetWorked",
  multiple_coaches: "pendingMultipleCoaches",
};
const PENDING_PHRASE: Record<PendingReason, string> = {
  cost_not_confirmed: "cost not confirmed",
  invalid_final_cost: "missing or invalid final cost",
  coach_outcome_undecided: "coach outcome not decided",
  not_yet_worked: "not yet worked",
  multiple_coaches: "linked to more than one coach",
};

function pendingBreakdown(pending: PendingItem[]): { counts: Record<string, number>; text: string } {
  const counts: Record<string, number> = {};
  for (const k of Object.values(PENDING_KEYS)) counts[k] = 0;
  const byReason = new Map<PendingReason, number>();
  for (const p of pending) {
    counts[PENDING_KEYS[p.reason]]++;
    byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1);
  }
  const text = (Object.keys(PENDING_KEYS) as PendingReason[]).filter((r) => byReason.has(r)).map((r) => `${byReason.get(r)} ${PENDING_PHRASE[r]}`).join(", ");
  return { counts, text };
}

function items(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

export function workSummaryCase(a: SummaryAnalysis): CandidateCase {
  const who = a.coachName ?? "Coach";
  const periodText = `${formatDate(a.period.start)} - ${formatDate(a.period.end)}`;
  const pb = pendingBreakdown(a.pending);
  const stale = a.storedStatus !== a.effectiveStatus;
  const canFinaliseNow = a.period.end < a.today && a.pending.length === 0;
  let title: string;
  let detail: string;
  let since: string | null;
  if (a.rule === "work_summary_queried") {
    title = `Work summary queried - ${who}`;
    const when = a.queriedOn ? ` on ${formatDate(a.queriedOn)}` : "";
    const quote = a.queryNote ? `: "${a.queryNote}".` : ".";
    const next = canFinaliseNow ? "Review the query, then finalise (or reopen) the summary." : a.pending.length ? `Review the query; ${items(a.pending.length)} still pending (${pb.text}) before it can be finalised.` : "Review the query; the period has not ended yet.";
    detail = `${who} queried the work summary for ${periodText}${when}${quote} ${next}`;
    since = a.queriedAt;
  } else if (a.rule === "work_summary_ready_to_finalise") {
    title = `Work summary ready to finalise - ${who}`;
    detail = `The ${periodText} period has ended and ${a.eligibleCount === 0 ? "nothing is pending" : a.eligibleCount === 1 ? "its 1 item of work is resolved" : `all ${a.eligibleCount} items of work are resolved`}. Review and finalise the summary.${stale ? ` (Stored status "${a.storedStatus}" is out of date.)` : ""}`;
    since = a.periodEndedAt;
  } else {
    title = `Work summary blocked - ${who}`;
    detail = `The ${periodText} period ended on ${formatDate(a.period.end)}, but ${items(a.pending.length)} still pending (${pb.text}). Resolve them before the summary can be finalised.${stale ? ` (Stored status "${a.storedStatus}" is out of date.)` : ""}`;
    since = a.periodEndedAt;
  }
  return {
    subjects: [{ type: "summary", id: a.summaryId }],
    title,
    detail,
    anchors: { outstandingSince: since },
    anchorTime: since,
    destination: { route: "coaches/work-summary", params: { summaryId: a.summaryId, coachId: a.coachId } },
    targetIds: { summaryId: a.summaryId, coachId: a.coachId },
    relatedIds: {
      pendingAllocationIds: a.pending.map((p) => p.allocationId),
      undatedAllocationIds: a.undated.map((u) => u.allocationId),
    },
    context: {
      summaryId: a.summaryId,
      workSummaryId: a.workSummaryId,
      coachId: a.coachId,
      coachName: a.coachName,
      coachActive: a.coachActive,
      periodStart: a.period.start,
      periodEnd: a.period.end,
      periodEndedAt: a.periodEndedAt,
      storedStatus: a.storedStatus,
      effectiveStatus: a.effectiveStatus,
      storedStatusStale: stale,
      frozen: a.frozen,
      previouslyFinalised: !!a.finalisedAt,
      finalisedAt: a.finalisedAt,
      reopenedAt: a.reopenedAt,
      queriedAt: a.rule === "work_summary_queried" ? a.queriedAt : null,
      queryNote: a.rule === "work_summary_queried" ? a.queryNote : null,
      pendingCount: a.pending.length,
      ...pb.counts,
      eligibleCount: a.eligibleCount,
      undatedCount: a.undated.length,
      canFinaliseNow,
      evaluatedAsOf: a.today,
    },
  };
}

function summaryEvaluator(ruleKey: SummaryRuleKey, ruleId: string): EvaluatorRegistration {
  return {
    ruleKey,
    ruleId,
    sources: WORK_SUMMARY_SOURCES,
    evaluate(ctx: EvaluatorContext): CandidateCase[] {
      const pass = sharedWorkSummaryPass(ctx);
      for (const issue of pass.issues) ctx.reportIssue?.(issue);
      return pass.analyses.filter((a) => a.rule === ruleKey).map(workSummaryCase);
    },
  };
}

// ---------------------------------------------------------------------
// coach_outcome_pending
// ---------------------------------------------------------------------

/**
 * classifyAllocation's own outcome test, line for line (drift-tested): the
 * occurrence Status is Cancelled / Postponed and the allocation's Coach
 * Outcome is not one of Paid / Partial / Unpaid. A Rescheduled Schedule
 * Change State alone is not an outcome trigger (the occurrence still runs).
 */
export function needsCoachOutcome(allocation: AirtableRecord, occ: AirtableRecord): boolean {
  const occStatus = selectName(occ.fields["Status"]);
  const outcome = selectName(allocation.fields["Coach Outcome"]);
  const needsOutcome = !!occStatus && (OUTCOME_REQUIRED_STATUSES as readonly string[]).includes(occStatus);
  return needsOutcome && !(outcome && (COACH_OUTCOMES as readonly string[]).includes(outcome));
}

export interface CoachOutcomeAnalysis {
  occurrenceId: string;
  coachId: string;
  allocationIds: string[];
  coachName: string | null;
  coachActive: boolean;
  occurrenceName: string | null;
  occurrenceStatus: string;
  scheduleChangeState: string | null;
  replacementOccurrenceId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  dateIso: string | null;
  startIso: string | null;
  /** Unrecognised stored Coach Outcome text (blank = null). */
  currentOutcome: string | null;
  costStatus: string | null;
  finalCoachCost: number | null;
  /** Occurrence start (or 00:00 local on its date) - the 48h overdue anchor. */
  outstandingSince: string | null;
}

export interface CoachOutcomePass {
  analyses: CoachOutcomeAnalysis[];
  issues: ConfigIssue[];
}

export const coachOutcomePassStats = { passes: 0 };

export function runCoachOutcomePass(sources: Readonly<Record<string, readonly AirtableRecord[]>>, timeZone: string): CoachOutcomePass {
  coachOutcomePassStats.passes++;
  const T = WORK_SUMMARY_TABLES;
  const occById = new Map((sources[T.occurrences] ?? []).map((o) => [o.id, o]));
  const sessionById = new Map((sources[T.sessions] ?? []).map((s) => [s.id, s]));
  const coachById = new Map((sources[T.coaches] ?? []).map((c) => [c.id, c]));
  const groups = new Map<string, { occ: AirtableRecord; coachId: string; allocations: AirtableRecord[] }>();
  const issues: ConfigIssue[] = [];

  for (const a of sources[T.allocations] ?? []) {
    const occ = occById.get(firstLink(a.fields, "Session Occurrence") ?? "") ?? null;
    if (!occ || !needsCoachOutcome(a, occ)) continue;
    const coaches = linkIds(a.fields["Coach"]);
    if (coaches.length === 0) {
      issues.push({ code: "coach_outcome_allocation_no_coach", recordId: a.id, detail: `Coach Allocation ${a.id} on ${selectName(occ.fields["Status"])} occurrence ${occ.id} has no Coach, so no coach outcome case can be raised.` });
      continue;
    }
    if (coaches.length > 1) {
      issues.push({ code: "coach_outcome_allocation_multiple_coaches", recordId: a.id, detail: `Coach Allocation ${a.id} links ${coaches.length} coaches; one coach outcome case is raised per linked coach.` });
    }
    for (const c of coaches) {
      const k = `${occ.id}|${c}`;
      const g = groups.get(k) ?? { occ, coachId: c, allocations: [] };
      g.allocations.push(a);
      groups.set(k, g);
    }
  }

  const analyses: CoachOutcomeAnalysis[] = [];
  for (const g of groups.values()) {
    const { occ, coachId } = g;
    const allocations = [...g.allocations].sort((x, y) => x.id.localeCompare(y.id));
    if (allocations.length > 1) {
      issues.push({ code: "coach_outcome_duplicate_allocations", recordId: occ.id, detail: `${allocations.length} undecided Coach Allocations for coach ${coachId} on occurrence ${occ.id} (${allocations.map((x) => x.id).join(", ")}); shown as one case.` });
    }
    const session = sessionById.get(firstLink(occ.fields, "Session") ?? "") ?? null;
    const coach = coachById.get(coachId) ?? null;
    const only = allocations.length === 1 ? allocations[0] : null;
    const raw = only ? selectName(only.fields["Coach Outcome"]) : null;
    const dateIso = isIsoDate(occ.fields["Date"]) ? (occ.fields["Date"] as string) : null;
    const startIso = str(occ.fields["Start Date & Time"]);
    const cost = only?.fields["Final Coach Cost"];
    analyses.push({
      occurrenceId: occ.id,
      coachId,
      allocationIds: allocations.map((x) => x.id),
      coachName: coach ? str(coach.fields["Coach Name"]) : null,
      coachActive: coach?.fields["Active"] === true,
      occurrenceName: str(occ.fields["Occurrence Name"]),
      occurrenceStatus: selectName(occ.fields["Status"]) ?? "",
      scheduleChangeState: selectName(occ.fields["Schedule Change State"]),
      replacementOccurrenceId: firstLink(occ.fields, "Replacement Occurrence"),
      sessionId: session?.id ?? null,
      sessionName: session ? str(session.fields["Session Name"]) : null,
      dateIso,
      startIso,
      currentOutcome: raw && raw.trim() ? raw.trim() : null,
      costStatus: only ? selectName(only.fields["Cost Status"]) : null,
      finalCoachCost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      outstandingSince: startIso ?? (dateIso ? localMidnightIso(dateIso, timeZone) : null),
    });
  }
  analyses.sort((x, y) => x.occurrenceId.localeCompare(y.occurrenceId) || x.coachId.localeCompare(y.coachId));
  return { analyses, issues };
}

const outcomePassCache = new WeakMap<object, { key: string; pass: CoachOutcomePass }>();

export function sharedCoachOutcomePass(ctx: EvaluatorContext): CoachOutcomePass {
  const allocations = ctx.sources[WORK_SUMMARY_TABLES.allocations] ?? [];
  const key = `${ctx.organisation.timezone}|${COACH_OUTCOME_SOURCES.map((t) => (ctx.sources[t] ?? []).length).join(",")}`;
  const hit = outcomePassCache.get(allocations);
  if (hit && hit.key === key) return hit.pass;
  const pass = runCoachOutcomePass(ctx.sources, ctx.organisation.timezone);
  outcomePassCache.set(allocations, { key, pass });
  return pass;
}

export function coachOutcomeCase(a: CoachOutcomeAnalysis, timeZone: string): CandidateCase {
  const who = a.coachName ?? "the coach";
  const what = a.sessionName ?? a.occurrenceName ?? "A session";
  const when = formatLocal(a.startIso, a.dateIso, timeZone);
  const change = a.occurrenceStatus.toLowerCase();
  const moved = a.replacementOccurrenceId ? " It has a replacement occurrence, but this date's coach cost still needs a decision." : "";
  const current = a.currentOutcome ? ` The stored Coach Outcome "${a.currentOutcome}" is not recognised.` : "";
  const params: Record<string, string> = { occurrenceId: a.occurrenceId, coachId: a.coachId };
  if (a.allocationIds.length === 1) params.allocationId = a.allocationIds[0];
  const targetIds: Record<string, string> = { occurrenceId: a.occurrenceId, coachId: a.coachId };
  if (a.sessionId) targetIds.sessionId = a.sessionId;
  if (a.allocationIds.length === 1) targetIds.allocationId = a.allocationIds[0];
  return {
    subjects: [{ type: "occurrence", id: a.occurrenceId }, { type: "coach", id: a.coachId }],
    title: `Coach outcome needed - ${a.coachName ?? "Coach"}`,
    detail: `${what} on ${when} was ${change}. Decide ${who}'s coach outcome (Paid, Partial or Unpaid).${moved}${current}`,
    anchors: { outstandingSince: a.outstandingSince },
    anchorTime: a.outstandingSince,
    destination: { route: "coaches/occurrence-financial-outcome", params },
    targetIds,
    relatedIds: { allocationIds: a.allocationIds },
    context: {
      occurrenceId: a.occurrenceId,
      occurrenceName: a.occurrenceName,
      occurrenceStatus: a.occurrenceStatus,
      scheduleChangeState: a.scheduleChangeState,
      replacementOccurrenceId: a.replacementOccurrenceId,
      sessionId: a.sessionId,
      sessionName: a.sessionName,
      coachId: a.coachId,
      coachName: a.coachName,
      coachActive: a.coachActive,
      date: a.dateIso,
      start: a.startIso,
      startLocal: when,
      allocationId: a.allocationIds.length === 1 ? a.allocationIds[0] : null,
      allocationCount: a.allocationIds.length,
      currentCoachOutcome: a.currentOutcome,
      outcomeOptions: COACH_OUTCOMES.join(", "),
      costStatus: a.costStatus,
      finalCoachCost: a.finalCoachCost,
    },
  };
}

export const COACH_OUTCOME_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "coach_outcome_pending",
  ruleId: "ATT-043",
  sources: COACH_OUTCOME_SOURCES,
  evaluate(ctx: EvaluatorContext): CandidateCase[] {
    const pass = sharedCoachOutcomePass(ctx);
    for (const issue of pass.issues) ctx.reportIssue?.(issue);
    return pass.analyses.map((a) => coachOutcomeCase(a, ctx.organisation.timezone));
  },
};

/** The four Slice 8 registrations - Rule IDs must match the TEST catalogue (drift-tested). */
export const WORK_SUMMARY_EVALUATORS: readonly EvaluatorRegistration[] = [
  COACH_OUTCOME_EVALUATOR,
  summaryEvaluator("work_summary_queried", "ATT-044"),
  summaryEvaluator("work_summary_ready_to_finalise", "ATT-045"),
  summaryEvaluator("work_summary_blocked", "ATT-046"),
];
