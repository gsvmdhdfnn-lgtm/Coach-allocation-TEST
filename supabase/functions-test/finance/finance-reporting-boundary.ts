/**
 * Finance Reporting Start Month - the management-reporting boundary - PURE
 * (Finance Foundation F20; see TEST-ENV.md "Finance Foundation - F20").
 *
 * The F20 audit found NO authoritative pre-Hub Finance history (the legacy
 * P&L workbook is a run-rate model, its "archive" a mutable 4-week estimate),
 * so nothing is imported. Instead each organisation may set the first
 * calendar month for which the Hub's canonical Finance engine (F18) is the
 * authoritative reporting record:
 *   - month <  start: there is no Hub Finance report for it. The Month
 *     Report / Overview return a "history unavailable" state (never a 0.00
 *     report) and the F19 Sheets writer refuses to export it;
 *   - month >= start: F18 exactly as before (this module never touches a
 *     figure). For the start month itself the previous-month comparison is
 *     unavailable (that month lies outside Hub Finance);
 *   - no start month set: no boundary - every month behaves as before.
 * A reporting boundary only: it never hides, filters or deletes operational
 * records (Money In / Money Out / Coach Costs / Cash Flow are unaffected).
 * YYYY-MM strings compare correctly as text (4-digit year, 2-digit month).
 */

export const REPORTING_STATE_CANONICAL = "canonical";
export const REPORTING_STATE_UNAVAILABLE = "history_unavailable";
export const SOURCE_PRE_HUB = "pre_hub";
export const REASON_NOT_AUTHORITATIVE = "hub_finance_not_authoritative_for_period";
export const REASON_PREVIOUS_BEFORE_START = "previous_month_before_reporting_start";
export const HISTORY_UNAVAILABLE_CODE = "reporting_history_unavailable";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" -> "September 2026" (plain wording for Management, no technical terms). */
export function monthLabel(month: string): string {
  const y = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12 ? `${MONTH_NAMES[m - 1]} ${y}` : month;
}

/** The calendar month before `month` (YYYY-MM). */
export function monthBefore(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${String(y - 1).padStart(4, "0")}-12` : `${String(y).padStart(4, "0")}-${String(m - 1).padStart(2, "0")}`;
}

export type ReportingBoundary =
  | { state: typeof REPORTING_STATE_CANONICAL; financeReportingStartMonth: string | null }
  | { state: typeof REPORTING_STATE_UNAVAILABLE; financeReportingStartMonth: string };

/** Is `month` authoritative Hub Finance reporting for an organisation whose start month is `startMonth` (null = no boundary)? */
export function boundaryOf(startMonth: string | null, month: string): ReportingBoundary {
  if (startMonth !== null && month < startMonth) return { state: REPORTING_STATE_UNAVAILABLE, financeReportingStartMonth: startMonth };
  return { state: REPORTING_STATE_CANONICAL, financeReportingStartMonth: startMonth };
}

/** The plain-language sentence for a month before the start month. */
export function startMessage(startMonth: string): string {
  return `Hub Finance records start from ${monthLabel(startMonth)}.`;
}

/** The deterministic non-report for a month before the start month - no figures of any kind (never 0.00). */
export function historyUnavailable(month: string, startMonth: string) {
  return {
    month,
    reportingState: REPORTING_STATE_UNAVAILABLE,
    source: SOURCE_PRE_HUB,
    financeReportingStartMonth: startMonth,
    reason: REASON_NOT_AUTHORITATIVE,
    message: `${startMessage(startMonth)} There is no Hub Finance report for ${monthLabel(month)}.`,
    figures: null,
  };
}

/** True when the month before `month` lies before the start month (so a previous-month comparison would cross out of Hub Finance). */
export function previousMonthBeforeStart(startMonth: string | null, month: string): boolean {
  return startMonth !== null && monthBefore(month) < startMonth;
}

/** Replaces the previous-month comparison for the start month: unavailable, never compared with anything outside Hub Finance. */
export function comparisonUnavailable(month: string, mode: string, startMonth: string) {
  return {
    available: false,
    previousMonth: monthBefore(month),
    mode,
    reason: REASON_PREVIOUS_BEFORE_START,
    financeReportingStartMonth: startMonth,
    message: `No previous-month comparison: ${startMessage(startMonth)}`,
  };
}
