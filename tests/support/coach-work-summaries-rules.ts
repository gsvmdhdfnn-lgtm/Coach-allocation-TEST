/**
 * Test-suite copy of the canonical coach-work-summaries/work-summaries.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./work-summaries|repository|lock-client.ts become coach-work-summaries-*.ts.
 */
/**
 * Pure rules for Coaches Slice 10 - Coach Work Summaries (see TEST-ENV.md).
 * No I/O here: eligibility, period inclusion, line snapshots, Grand Total,
 * status transitions, History rows and the receipt shape are all decided
 * by plain functions so every rule is directly unit-testable.
 *
 * A Work Summary tells a self-employed coach "this is the work the Hub
 * believes you completed in this period and the amount attached to each
 * item". It is NOT an invoice, payslip or payment, and nothing in this
 * function pays, invoices, exports or emails anyone.
 *
 * Ownership model:
 *   Coach Allocation      - the financial truth (Final Coach Cost).
 *   Coach Work Summary    - a period grouping of one Coach's allocations.
 *   Work Summary Line     - a frozen copy of one allocation, written at
 *                           finalisation.
 *   Work Summary History  - the append-only workflow audit trail.
 */

export interface AirtableRecord {
  id: string;
  fields: Record<string, any>;
  createdTime?: string;
}

/** Production `Coach Work Summaries.Status` choices, exactly. */
export const SUMMARY_STATUSES = ["Not ready", "Needs review", "Finalised", "Queried"] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

/** Production `Work Summary History.Event Type` choices, exactly. */
export const HISTORY_EVENT_TYPES = ["Needs Review", "Finalised", "Queried", "Reopened", "Re-finalised"] as const;
export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number];

/** Coach Allocations.Cost Status values that mean "the cost has been confirmed" (Draft can still change). */
export const ELIGIBLE_COST_STATUSES = ["Confirmed", "Exported"] as const;
/** Occurrence statuses whose coach cost depends on a Slice 6 Coach Outcome decision. */
export const OUTCOME_REQUIRED_STATUSES = ["Cancelled", "Postponed"] as const;
export const COACH_OUTCOMES = ["Paid", "Partial", "Unpaid"] as const;

export const MAX_PERIOD_DAYS = 366;
export const MAX_NOTE_LENGTH = 2000;

export const RECEIPT_DISCLAIMER = "This is a Work Summary of completed work and the amount attached to each item. It is not an invoice, payslip or payment.";

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidRecordId(v: unknown): v is string {
  return typeof v === "string" && RECORD_ID_RE.test(v);
}

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

// ---------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------

export type Actor =
  | { kind: "management"; userId: string; displayName: string | null }
  | { kind: "coach"; userId: string; displayName: string | null; coachId: string };

/** Management, or an active Coach whose profile is linked to a Coaches record. Parents and everyone else: null (403). */
export function resolveActor(caller: { role: string; active: boolean; userId: string; displayName: string | null; airtablePersonId: string | null } | null): Actor | null {
  if (!caller || caller.active !== true) return null;
  if (caller.role === "management") return { kind: "management", userId: caller.userId, displayName: caller.displayName };
  if (caller.role === "coach" && isValidRecordId(caller.airtablePersonId)) {
    return { kind: "coach", userId: caller.userId, displayName: caller.displayName, coachId: caller.airtablePersonId };
  }
  return null;
}

// ---------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------

export function toPence(v: number): number {
  return Math.round(v * 100);
}

export function roundCurrency(v: number): number {
  return toPence(v) / 100;
}

export function isValidCost(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Grand Total = sum of the lines' Final Cost Snapshots, added in whole pence so float drift can never creep in. */
export function grandTotal(lines: { finalCost: number }[]): number {
  return lines.reduce((acc, l) => acc + toPence(l.finalCost), 0) / 100;
}

// ---------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------

export interface Period {
  start: string;
  end: string;
}

/** Period Start/End are explicit inclusive ISO dates - any range, never an assumed calendar month. */
export function validatePeriod(start: unknown, end: unknown): { period: Period } | { error: string } {
  if (!isIsoDate(start)) return { error: "periodStart must be a real YYYY-MM-DD date" };
  if (!isIsoDate(end)) return { error: "periodEnd must be a real YYYY-MM-DD date" };
  if (start > end) return { error: "periodStart must be on or before periodEnd" };
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_PERIOD_DAYS) return { error: `A work summary period may cover at most ${MAX_PERIOD_DAYS} days` };
  return { period: { start, end } };
}

/** Inclusive at both ends; plain ISO-date string comparison (the work date is a calendar date, not an instant). */
export function isWithinPeriod(workDate: string, period: Period): boolean {
  return workDate >= period.start && workDate <= period.end;
}

export function periodsOverlap(a: Period, b: Period): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export function summaryPeriod(summary: AirtableRecord): Period | null {
  const start = summary.fields["Period Start"];
  const end = summary.fields["Period End"];
  return isIsoDate(start) && isIsoDate(end) ? { start, end } : null;
}

// ---------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------

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

// ---------------------------------------------------------------------
// Lines (planned from eligible items)
// ---------------------------------------------------------------------

export interface PlannedLine {
  allocationId: string;
  lineId: string;
  groupLabel: string;
  groupSortOrder: number;
  lineSortOrder: number;
  workDate: string;
  sessionName: string;
  rateType: string | null;
  paidUnits: number | null;
  rateAmount: number | null;
  finalCost: number;
}

export function workSummaryIdFor(coachKey: string, period: Period): string {
  return `WS-${coachKey}-${period.start.replace(/-/g, "")}-${period.end.replace(/-/g, "")}`;
}

export function lineIdFor(workSummaryId: string, allocationLabel: string): string {
  return `WSL-${workSummaryId}-${allocationLabel}`;
}

/** Groups sorted by label; lines by (group, date, start, description, allocation) - deterministic, so a refresh never reshuffles. */
export function planLines(items: EligibleItem[], workSummaryId: string): PlannedLine[] {
  const groups = [...new Set(items.map((i) => i.groupLabel))].sort((a, b) => a.localeCompare(b));
  const sorted = [...items].sort(
    (a, b) =>
      groups.indexOf(a.groupLabel) - groups.indexOf(b.groupLabel) ||
      a.workDate.localeCompare(b.workDate) ||
      (a.startTime ?? "").localeCompare(b.startTime ?? "") ||
      a.sessionName.localeCompare(b.sessionName) ||
      a.allocationLabel.localeCompare(b.allocationLabel)
  );
  return sorted.map((i, idx) => ({
    allocationId: i.allocationId,
    lineId: lineIdFor(workSummaryId, i.allocationLabel),
    groupLabel: i.groupLabel,
    groupSortOrder: groups.indexOf(i.groupLabel) + 1,
    lineSortOrder: idx + 1,
    workDate: i.workDate,
    sessionName: i.sessionName,
    rateType: i.rateType,
    paidUnits: i.paidUnits,
    rateAmount: i.rateAmount,
    finalCost: i.finalCost,
  }));
}

/** Exact production field names of Work Summary Lines. */
export function lineFields(line: PlannedLine, summaryRecordId: string): Record<string, unknown> {
  return {
    "Work Summary Line ID": line.lineId,
    "Work Summary": [summaryRecordId],
    "Coach Allocation": [line.allocationId],
    "Group Label Snapshot": line.groupLabel,
    "Work Date Snapshot": line.workDate,
    "Session Name Snapshot": line.sessionName,
    "Rate Type Snapshot": line.rateType,
    "Paid Units Snapshot": line.paidUnits,
    "Rate Amount Snapshot": line.rateAmount,
    "Final Cost Snapshot": line.finalCost,
    "Group Sort Order": line.groupSortOrder,
    "Line Sort Order": line.lineSortOrder,
  };
}

export interface StoredLine {
  recordId: string;
  allocationId: string | null;
  lineId: string;
  groupLabel: string;
  groupSortOrder: number | null;
  lineSortOrder: number | null;
  workDate: string | null;
  sessionName: string;
  rateType: string | null;
  paidUnits: number | null;
  rateAmount: number | null;
  finalCost: number;
}

export function readStoredLine(r: AirtableRecord): StoredLine {
  const f = r.fields;
  return {
    recordId: r.id,
    allocationId: firstLink(f, "Coach Allocation"),
    lineId: typeof f["Work Summary Line ID"] === "string" ? f["Work Summary Line ID"] : "",
    groupLabel: typeof f["Group Label Snapshot"] === "string" ? f["Group Label Snapshot"] : "",
    groupSortOrder: numOrNull(f["Group Sort Order"]),
    lineSortOrder: numOrNull(f["Line Sort Order"]),
    workDate: isIsoDate(f["Work Date Snapshot"]) ? f["Work Date Snapshot"] : null,
    sessionName: typeof f["Session Name Snapshot"] === "string" ? f["Session Name Snapshot"] : "",
    rateType: typeof f["Rate Type Snapshot"] === "string" ? f["Rate Type Snapshot"] : null,
    paidUnits: numOrNull(f["Paid Units Snapshot"]),
    rateAmount: numOrNull(f["Rate Amount Snapshot"]),
    finalCost: numOrNull(f["Final Cost Snapshot"]) ?? 0,
  };
}

export function sortStoredLines(lines: StoredLine[]): StoredLine[] {
  return [...lines].sort((a, b) => (a.lineSortOrder ?? 1e9) - (b.lineSortOrder ?? 1e9) || a.lineId.localeCompare(b.lineId));
}

const SNAPSHOT_KEYS = ["lineId", "groupLabel", "groupSortOrder", "lineSortOrder", "workDate", "sessionName", "rateType", "paidUnits", "rateAmount", "finalCost"] as const;

export interface LineReconciliation {
  create: PlannedLine[];
  update: { recordId: string; line: PlannedLine; previous: StoredLine }[];
  unchanged: { recordId: string; line: PlannedLine }[];
  /** Lines of this summary whose allocation is no longer eligible (or duplicates): unlinked from the summary, never deleted. */
  detach: StoredLine[];
}

/**
 * At most one line per allocation per summary: an existing line for the
 * allocation is reused (patched only if a snapshot value differs), extra
 * duplicates and lines for no-longer-eligible allocations are detached.
 */
export function reconcileLines(planned: PlannedLine[], existing: StoredLine[]): LineReconciliation {
  const out: LineReconciliation = { create: [], update: [], unchanged: [], detach: [] };
  const byAlloc = new Map<string, StoredLine>();
  for (const l of sortStoredLines(existing)) {
    if (!l.allocationId || byAlloc.has(l.allocationId)) out.detach.push(l);
    else byAlloc.set(l.allocationId, l);
  }
  const wanted = new Set(planned.map((p) => p.allocationId));
  for (const [allocId, l] of byAlloc) if (!wanted.has(allocId)) out.detach.push(l);
  for (const p of planned) {
    const prev = byAlloc.get(p.allocationId);
    if (!prev) out.create.push(p);
    else if (SNAPSHOT_KEYS.some((k) => (prev as any)[k] !== (p as any)[k])) out.update.push({ recordId: prev.recordId, line: p, previous: prev });
    else out.unchanged.push({ recordId: prev.recordId, line: p });
  }
  return out;
}

// ---------------------------------------------------------------------
// Status / lifecycle
// ---------------------------------------------------------------------

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

export type Transition = { ok: true } | { ok: false; httpStatus: 409; code: string; error: string };

const conflict = (code: string, error: string): Transition => ({ ok: false, httpStatus: 409, code, error });

export function canRefresh(summary: AirtableRecord): Transition {
  if (isFrozen(summary)) return conflict("summary_finalised", "A finalised summary is a historical snapshot - Management must reopen it before it can be refreshed");
  return { ok: true };
}

export function canQuery(summary: AirtableRecord): Transition {
  const s = summaryStatus(summary);
  if (s === "Needs review" || s === "Finalised") return { ok: true };
  if (s === "Queried") return conflict("already_queried", "This summary already has an open query");
  return conflict("not_ready", "This summary is still being prepared and cannot be queried yet");
}

export function canReopen(summary: AirtableRecord): Transition {
  if (isFrozen(summary)) return { ok: true };
  return conflict("not_finalised", "Only a finalised summary can be reopened");
}

/** Finalise is allowed from Needs review or Queried; Finalised is an idempotent no-op; Not ready is refused. Pending items and the period end are checked by the caller against fresh data. */
export function canFinalise(summary: AirtableRecord): Transition | { ok: true; alreadyFinalised: true } {
  const s = summaryStatus(summary);
  if (s === "Finalised") return { ok: true, alreadyFinalised: true };
  if (s === "Needs review" || s === "Queried" || s === "Not ready") return { ok: true };
  return conflict("unknown_status", "Summary has no recognised Status");
}

export function finaliseEventType(summary: AirtableRecord): HistoryEventType {
  return summary.fields["Finalised At"] ? "Re-finalised" : "Finalised";
}

export function validateNote(v: unknown, what: string): { note: string } | { error: string } {
  if (typeof v !== "string" || !v.trim()) return { error: `${what} is required` };
  if (v.length > MAX_NOTE_LENGTH) return { error: `${what} must be at most ${MAX_NOTE_LENGTH} characters` };
  return { note: v.trim() };
}

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------

/** Deterministic ID, so a retried write can find the row it already made instead of appending a duplicate. */
export function historyIdFor(workSummaryId: string, eventType: HistoryEventType, changedAt: string): string {
  return `WSH-${workSummaryId}-${eventType.replace(/\s+/g, "")}-${changedAt}`;
}

export function historyFields(input: { workSummaryId: string; summaryRecordId: string; eventType: HistoryEventType; note: string; actor: Actor; changedAt: string }): Record<string, unknown> {
  return {
    "Work Summary History ID": historyIdFor(input.workSummaryId, input.eventType, input.changedAt),
    "Work Summary": [input.summaryRecordId],
    "Event Type": input.eventType,
    "Reason / Note": input.note,
    "Changed By User ID": input.actor.userId,
    "Changed By Name Snapshot": input.actor.displayName,
    "Changed At": input.changedAt,
  };
}

export function formatMoney(v: number): string {
  return `£${roundCurrency(v).toFixed(2)}`;
}

/** Human-readable audit of what a (re-)finalisation froze and what it changed versus the previous frozen lines. */
export function finaliseNote(total: number, rec: LineReconciliation): string {
  const lines = [`Grand Total ${formatMoney(total)} across ${rec.create.length + rec.update.length + rec.unchanged.length} line(s).`];
  for (const u of rec.update) {
    lines.push(`Changed ${u.line.lineId}: final ${formatMoney(u.previous.finalCost)} -> ${formatMoney(u.line.finalCost)}, rate ${u.previous.rateAmount ?? "-"} -> ${u.line.rateAmount ?? "-"}, units ${u.previous.paidUnits ?? "-"} -> ${u.line.paidUnits ?? "-"}.`);
  }
  for (const d of rec.detach) lines.push(`Removed ${d.lineId || d.recordId} (was ${formatMoney(d.finalCost)}): allocation no longer eligible; line record kept, unlinked.`);
  for (const c of rec.create) if (rec.update.length || rec.detach.length || rec.unchanged.length) lines.push(`Added ${c.lineId}: ${formatMoney(c.finalCost)}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Drift (Management visibility: never silently alters a finalised summary)
// ---------------------------------------------------------------------

export interface DriftItem {
  allocationId: string;
  kind: "changed" | "no_longer_eligible" | "newly_eligible";
  frozenFinalCost: number | null;
  currentFinalCost: number | null;
}

export function detectDrift(frozen: StoredLine[], currentEligible: EligibleItem[]): DriftItem[] {
  const out: DriftItem[] = [];
  const cur = new Map(currentEligible.map((i) => [i.allocationId, i]));
  const seen = new Set<string>();
  for (const l of frozen) {
    if (!l.allocationId) continue;
    seen.add(l.allocationId);
    const c = cur.get(l.allocationId);
    if (!c) out.push({ allocationId: l.allocationId, kind: "no_longer_eligible", frozenFinalCost: l.finalCost, currentFinalCost: null });
    else if (toPence(c.finalCost) !== toPence(l.finalCost) || c.rateAmount !== l.rateAmount || c.paidUnits !== l.paidUnits) {
      out.push({ allocationId: l.allocationId, kind: "changed", frozenFinalCost: l.finalCost, currentFinalCost: c.finalCost });
    }
  }
  for (const c of currentEligible) if (!seen.has(c.allocationId)) out.push({ allocationId: c.allocationId, kind: "newly_eligible", frozenFinalCost: null, currentFinalCost: c.finalCost });
  return out;
}

// ---------------------------------------------------------------------
// Receipt (serialised shape only - no PDF, no UI)
// ---------------------------------------------------------------------

export interface ReceiptLineInput {
  groupLabel: string;
  workDate: string | null;
  sessionName: string;
  rateType: string | null;
  paidUnits: number | null;
  rateAmount: number | null;
  finalCost: number;
}

export function buildReceipt(input: { coachName: string | null; period: Period; status: string | null; frozen: boolean; lines: ReceiptLineInput[] }) {
  const groups: { label: string; items: any[]; subtotal: number }[] = [];
  for (const l of input.lines) {
    let g = groups.find((x) => x.label === l.groupLabel);
    if (!g) groups.push((g = { label: l.groupLabel, items: [], subtotal: 0 }));
    g.items.push({ date: l.workDate, description: l.sessionName, rateType: l.rateType, paidUnits: l.paidUnits, rateAmount: l.rateAmount, finalAmount: l.finalCost });
  }
  for (const g of groups) g.subtotal = grandTotal(g.items.map((i) => ({ finalCost: i.finalAmount })));
  return {
    documentType: "Coach Work Summary",
    disclaimer: RECEIPT_DISCLAIMER,
    coachName: input.coachName,
    period: input.period,
    status: input.status,
    frozen: input.frozen,
    groups,
    grandTotal: grandTotal(input.lines),
  };
}
