/**
 * Test-suite copy of the canonical finance/finance-lifecycle.ts, kept in sync by hand
 * exactly like every other deployed copy (drift-checked in
 * the finance *.test.ts files). No changes.
 */
/**
 * Finance Client Service lifecycle - PURE (Finance Foundation F4; see
 * TEST-ENV.md "Finance Foundation - F4"). No HTTP, Airtable, Supabase or Deno
 * code.
 *
 * Why this exists: F3 kept a Service's Active / Paused / Ended status as
 * current state only, with transitions visible in the audit trail as
 * decision timestamps. Billing an occurrence needs the BUSINESS answer to
 * "was this Service commercially operating on date X?" - a decision time is
 * not a business date (a Service ended on 5 July may have stopped on 30
 * June, and several changes can land on one day). So the lifecycle is kept
 * as effective-dated periods, under exactly the F3 commercial-terms rules
 * (locked: "changes apply from a chosen date onward; do not rewrite previous
 * sessions"):
 *   - a change applies from a chosen date, today or later - never backdated;
 *   - it closes the current period the day before and opens a new one;
 *   - a change dated the same day as a period that has not started yet (or
 *     starts today) supersedes that period - the superseded row is kept;
 *   - the first period may be open at the start ("from the beginning"): a
 *     Service's record-creation time is not a business date, its commercial
 *     terms say when there is anything to bill;
 *   - only Active is commercially operating; Paused and Ended are not.
 * The current status (what F3 shows) is simply the period covering today.
 */
import { type EffectiveDated, entryError, findOverlaps, isIsoDate, resolveEffective } from "./finance-effective-dating.ts";
import { type ServiceStatus, SERVICE_STATUSES, dayBefore } from "./finance-commercial.ts";

export const ENTITY_LIFECYCLE = "finance_client_service_lifecycle";

/** Internal stand-in for "from the beginning" so the F2 effective-dating helpers apply unchanged. Never stored or returned. */
const START = "0001-01-01";

export interface LifecyclePeriod {
  lifecycleId: string;
  serviceId: string;
  status: ServiceStatus;
  /** null = from the Service's beginning. */
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  /** Set when a same-day change replaced this period before it applied to any past date. Superseded periods never resolve. */
  supersededBy: string | null;
  reason: string | null;
}

export function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const asDated = (p: LifecyclePeriod): EffectiveDated<LifecyclePeriod> => ({ effectiveFrom: p.effectiveFrom ?? START, effectiveUntil: p.effectiveUntil, value: p });

export type LifecycleCheck = { ok: true; history: LifecyclePeriod[] } | { ok: false; code: "service_lifecycle_invalid"; error: string };

/**
 * The periods that apply (superseded ones excluded), sorted. Valid means: at
 * least one; only the first may start "from the beginning"; well-formed;
 * contiguous (each period starts the day after the previous one ends - a
 * gap would leave dates with no answer); only the latest is open-ended.
 */
export function checkLifecycle(periods: readonly LifecyclePeriod[]): LifecycleCheck {
  const bad = (error: string): LifecycleCheck => ({ ok: false, code: "service_lifecycle_invalid", error });
  const live = periods.filter((p) => p.supersededBy === null);
  if (!live.length) return bad("The service has no lifecycle history");
  for (const p of live) {
    if (!(SERVICE_STATUSES as readonly string[]).includes(p.status)) return bad(`Lifecycle ${p.lifecycleId}: unknown status`);
    if (p.effectiveFrom !== null && !isIsoDate(p.effectiveFrom)) return bad(`Lifecycle ${p.lifecycleId}: invalid effective from`);
    const e = entryError(asDated(p));
    if (e) return bad(`Lifecycle ${p.lifecycleId}: ${e}`);
  }
  const sorted = [...live].sort((a, b) => (a.effectiveFrom ?? START).localeCompare(b.effectiveFrom ?? START));
  if (sorted.slice(1).some((p) => p.effectiveFrom === null)) return bad("Only the first lifecycle period may start from the beginning");
  if (findOverlaps(sorted.map(asDated)).length) return bad("Lifecycle periods overlap");
  for (let i = 0; i < sorted.length - 1; i++) {
    const until = sorted[i].effectiveUntil;
    if (until === null) return bad(`Lifecycle ${sorted[i].lifecycleId} is open-ended but is not the latest`);
    if (dayAfter(until) !== sorted[i + 1].effectiveFrom) return bad(`Lifecycle has a gap after ${until}`);
  }
  return { ok: true, history: sorted };
}

export type LifecycleOnDate = { status: "resolved"; period: LifecyclePeriod } | { status: "none" } | { status: "invalid"; error: string };

/** Which lifecycle period governs `dateIso` (history must come from checkLifecycle). */
export function lifecycleOn(history: readonly LifecyclePeriod[], dateIso: string): LifecycleOnDate {
  const r = resolveEffective(history.filter((p) => p.supersededBy === null).map(asDated), dateIso);
  if (r.status === "resolved") return { status: "resolved", period: r.entry.value };
  if (r.status === "none") return { status: "none" };
  return { status: "invalid", error: r.status === "invalid" ? r.error : "Lifecycle periods overlap on this date" };
}

export const isCommerciallyOperating = (s: ServiceStatus) => s === "active";

export type LifecyclePlan =
  | { ok: true; kind: "noop" }
  | { ok: true; kind: "append"; close: LifecyclePeriod; closedUntil: string; next: { status: ServiceStatus; effectiveFrom: string } }
  | { ok: true; kind: "supersede"; replace: LifecyclePeriod; next: { status: ServiceStatus; effectiveFrom: string } }
  | { ok: false; httpStatus: 409; code: string; error: string };

/**
 * Plans a lifecycle change to `status` from `effectiveFrom` (history must
 * come from checkLifecycle; `today` is the organisation's calendar date).
 */
export function planLifecycleChange(history: readonly LifecyclePeriod[], status: ServiceStatus, effectiveFrom: string, today: string): LifecyclePlan {
  const fail = (code: string, error: string): LifecyclePlan => ({ ok: false, httpStatus: 409, code, error });
  if (!history.length) return fail("service_lifecycle_invalid", "The service has no lifecycle history");
  const latest = history[history.length - 1];
  if (effectiveFrom < today) return fail("backdated_change_not_allowed", `A change cannot apply from ${effectiveFrom}: changes apply from today (${today}) onward and never rewrite earlier periods`);
  if (latest.effectiveFrom !== null && effectiveFrom < latest.effectiveFrom) {
    return fail("lifecycle_change_before_scheduled_change", `A lifecycle change is already scheduled from ${latest.effectiveFrom} - a new change must start on or after that date`);
  }
  if (latest.status === status) return { ok: true, kind: "noop" };
  if (latest.effectiveFrom !== null && effectiveFrom === latest.effectiveFrom) return { ok: true, kind: "supersede", replace: latest, next: { status, effectiveFrom } };
  return { ok: true, kind: "append", close: latest, closedUntil: dayBefore(effectiveFrom), next: { status, effectiveFrom } };
}

/** Public shape - no storage ids. */
export function publicLifecycle(history: readonly LifecyclePeriod[], today: string) {
  const period = (p: LifecyclePeriod) => ({
    lifecycleId: p.lifecycleId,
    status: p.status,
    effectiveFrom: p.effectiveFrom,
    effectiveUntil: p.effectiveUntil,
    period: p.effectiveFrom !== null && p.effectiveFrom > today ? "upcoming" : p.effectiveUntil !== null && p.effectiveUntil < today ? "past" : "current",
    reason: p.reason,
  });
  const cur = lifecycleOn(history, today);
  return {
    current: cur.status === "resolved" ? period(cur.period) : null,
    history: history.filter((p) => p.supersededBy === null).map(period),
  };
}
