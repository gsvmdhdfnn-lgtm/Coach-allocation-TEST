/**
 * Test-suite copy of the canonical coach-work-summaries/orchestrator.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./work-summaries|repository|lock-client.ts become coach-work-summaries-*.ts.
 */
/**
 * Composition layer for Coaches Slice 10 work summaries (see TEST-ENV.md).
 * Loads rows, calls the pure decisions in work-summaries.ts and executes
 * the returned plans. No rule is decided here. Every write runs inside the
 * Coach's `work_summary_locks` lock and re-reads everything after
 * acquiring it, so two concurrent prepares cannot create two summaries for
 * one coach/period and two concurrent finalisations cannot duplicate lines.
 *
 * Nothing here pays, invoices, exports, emails or deletes anything.
 */
import {
  buildReceipt,
  canFinalise,
  canQuery,
  canRefresh,
  canReopen,
  classifyAllocation,
  detectDrift,
  finaliseEventType,
  finaliseNote,
  firstLink,
  formatMoney,
  grandTotal,
  historyFields,
  historyIdFor,
  isActive,
  isFrozen,
  isValidRecordId,
  linkIds,
  lineFields,
  openStatusFor,
  periodsOverlap,
  planLines,
  readStoredLine,
  reconcileLines,
  sortStoredLines,
  summaryPeriod,
  summaryStatus,
  ukToday,
  validateNote,
  validatePeriod,
  workSummaryIdFor,
  type Actor,
  type AirtableRecord,
  type EligibleItem,
  type HistoryEventType,
  type PendingItem,
  type Period,
  type StoredLine,
} from "./coach-work-summaries-rules.ts";
import { type LockClient } from "./coach-work-summaries-lock-client.ts";
import { type AirtableConfig, type World, TABLES, createRecord, getRecord, loadWorld, patchRecord } from "./coach-work-summaries-repository.ts";

export interface Deps {
  airtable: AirtableConfig;
  lock: LockClient;
}

export interface LockRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

const DEFAULT_LOCK_MAX_ATTEMPTS = 150;
const DEFAULT_LOCK_RETRY_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same bounded acquire/retry/always-release shape as coach-cover's withLock. */
async function withLock<T>(lock: LockClient, key: string, fn: () => Promise<T>, opts: LockRetryOptions = {}): Promise<T | { status: "lock_unavailable" }> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_LOCK_MAX_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  let token: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    token = await lock.acquire(key);
    if (token) break;
    if (attempt < maxAttempts - 1) await sleep(retryDelayMs);
  }
  if (!token) return { status: "lock_unavailable" };
  try {
    return await fn();
  } finally {
    await lock.release(key, token);
  }
}

export type Rejected = { status: "rejected"; httpStatus: 400 | 403 | 404 | 409; code: string; error: string; [k: string]: unknown };
const reject = (httpStatus: Rejected["httpStatus"], code: string, error: string, extra: Record<string, unknown> = {}): Rejected => ({ status: "rejected", httpStatus, code, error, ...extra });

// ---------------------------------------------------------------------
// Views over one consistent world read
// ---------------------------------------------------------------------

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

function coachKey(coach: AirtableRecord): string {
  const k = coach.fields["Coach ID"];
  return typeof k === "string" && k.trim() ? k.trim() : coach.id;
}

function workSummaryIdOf(summary: AirtableRecord): string {
  const v = summary.fields["Work Summary ID"];
  return typeof v === "string" && v ? v : summary.id;
}

function linesOf(world: World, summaryId: string): StoredLine[] {
  return sortStoredLines(world.lines.filter((l) => linkIds(l.fields["Work Summary"]).includes(summaryId)).map(readStoredLine));
}

function historyOf(world: World, summaryId: string): AirtableRecord[] {
  return world.history
    .filter((h) => linkIds(h.fields["Work Summary"]).includes(summaryId))
    .sort((a, b) => String(a.fields["Changed At"] ?? "").localeCompare(String(b.fields["Changed At"] ?? "")) || a.id.localeCompare(b.id));
}

/** Append-only, retry-safe: a History row is keyed by (summary, event, time); if the row already exists it is reused, never duplicated. */
async function ensureHistory(deps: Deps, world: World, summary: AirtableRecord, eventType: HistoryEventType, changedAt: string, note: string, actor: Actor): Promise<AirtableRecord> {
  const wsId = workSummaryIdOf(summary);
  const hid = historyIdFor(wsId, eventType, changedAt);
  const existing = world.history.find((h) => h.fields["Work Summary History ID"] === hid);
  if (existing) return existing;
  const rec = await createRecord(deps.airtable, TABLES.history, historyFields({ workSummaryId: wsId, summaryRecordId: summary.id, eventType, note, actor, changedAt }));
  world.history.push(rec);
  return rec;
}

export interface SummaryView {
  summaryId: string;
  workSummaryId: string;
  coachId: string | null;
  coachName: string | null;
  period: Period | null;
  status: string | null;
  active: boolean;
  frozen: boolean;
  grandTotal: number | null;
  summaryDate: string | null;
  queryOrReopenNote: string | null;
  queriedAt: string | null;
  finalisedAt: string | null;
  finalisedByName: string | null;
  reopenedAt: string | null;
  reopenedByName: string | null;
  linesSource: "frozen" | "preview";
  lines: any[];
  pending: PendingItem[];
  history: any[];
  receipt: ReturnType<typeof buildReceipt> | null;
  management?: {
    finalisedByUserId: string | null;
    reopenedByUserId: string | null;
    undatedAllocations: { allocationId: string; allocationLabel: string }[];
    drift: ReturnType<typeof detectDrift>;
    storedLines: StoredLine[];
  };
}

function buildView(world: World, summary: AirtableRecord, actor: Actor, today: string): SummaryView {
  const f = summary.fields;
  const coachId = firstLink(f, "Coach");
  const coach = world.coaches.find((c) => c.id === coachId) ?? null;
  const coachName = typeof coach?.fields["Coach Name"] === "string" ? coach.fields["Coach Name"] : null;
  const period = summaryPeriod(summary);
  const frozen = isFrozen(summary);
  const stored = linesOf(world, summary.id);
  const ev = coachId && period ? evaluate(world, coachId, period, today) : { eligible: [], pending: [], undated: [] };
  const wsId = workSummaryIdOf(summary);
  const lines = frozen
    ? stored.map((l) => ({ lineId: l.lineId, recordId: l.recordId, allocationId: l.allocationId, groupLabel: l.groupLabel, groupSortOrder: l.groupSortOrder, lineSortOrder: l.lineSortOrder, workDate: l.workDate, sessionName: l.sessionName, rateType: l.rateType, paidUnits: l.paidUnits, rateAmount: l.rateAmount, finalCost: l.finalCost }))
    : planLines(ev.eligible, wsId).map((l) => ({ ...l, recordId: null }));
  const isMgmt = actor.kind === "management";
  const outLines = isMgmt ? lines : lines.map(({ recordId: _r, allocationId: _a, ...rest }: any) => rest);
  const history = historyOf(world, summary.id).map((h) => ({
    eventType: h.fields["Event Type"] ?? null,
    note: h.fields["Reason / Note"] ?? null,
    changedAt: h.fields["Changed At"] ?? null,
    changedByName: h.fields["Changed By Name Snapshot"] ?? null,
    ...(isMgmt ? { changedByUserId: h.fields["Changed By User ID"] ?? null, historyId: h.fields["Work Summary History ID"] ?? null } : {}),
  }));
  const view: SummaryView = {
    summaryId: summary.id,
    workSummaryId: wsId,
    coachId,
    coachName,
    period,
    status: summaryStatus(summary),
    active: isActive(summary),
    frozen,
    grandTotal: typeof f["Grand Total"] === "number" ? f["Grand Total"] : null,
    summaryDate: f["Summary Date"] ?? null,
    queryOrReopenNote: f["Query / Reopen Note"] ?? null,
    queriedAt: f["Queried At"] ?? null,
    finalisedAt: f["Finalised At"] ?? null,
    finalisedByName: f["Finalised By Name Snapshot"] ?? null,
    reopenedAt: f["Reopened At"] ?? null,
    reopenedByName: f["Reopened By Name Snapshot"] ?? null,
    linesSource: frozen ? "frozen" : "preview",
    lines: outLines,
    pending: frozen ? [] : isMgmt ? ev.pending : ev.pending.map(({ allocationId: _a, ...rest }) => rest as PendingItem),
    history,
    receipt: period ? buildReceipt({ coachName, period, status: summaryStatus(summary), frozen, lines: lines as any }) : null,
  };
  if (isMgmt) {
    view.management = {
      finalisedByUserId: f["Finalised By User ID"] ?? null,
      reopenedByUserId: f["Reopened By User ID"] ?? null,
      undatedAllocations: ev.undated,
      drift: frozen ? detectDrift(stored, ev.eligible) : [],
      storedLines: stored,
    };
  }
  return view;
}

const ALL_TABLES = Object.keys(TABLES) as (keyof typeof TABLES)[];

// ---------------------------------------------------------------------
// Prepare / refresh
// ---------------------------------------------------------------------

async function applyRefresh(deps: Deps, world: World, summary: AirtableRecord, actor: Actor, today: string, now: Date): Promise<AirtableRecord> {
  const coachId = firstLink(summary.fields, "Coach")!;
  const period = summaryPeriod(summary)!;
  const ev = evaluate(world, coachId, period, today);
  const previewTotal = grandTotal(ev.eligible);
  const prev = summaryStatus(summary);
  const next = prev === "Queried" ? "Queried" : openStatusFor(ev.pending.length, period, today);
  let updated = summary;
  if (prev !== next || summary.fields["Grand Total"] !== previewTotal) {
    updated = await patchRecord(deps.airtable, TABLES.summaries, summary.id, { "Status": next, "Grand Total": previewTotal });
    const i = world.summaries.findIndex((s) => s.id === summary.id);
    if (i >= 0) world.summaries[i] = updated;
  }
  if (next === "Needs review" && prev !== "Needs review") {
    await ensureHistory(deps, world, updated, "Needs Review", now.toISOString(), `Ready for review: ${ev.eligible.length} line(s), preview total ${formatMoney(previewTotal)}.`, actor);
  }
  return updated;
}

export type PrepareResult = { status: "created" | "reused"; summary: SummaryView } | Rejected | { status: "lock_unavailable" };

export async function prepareSummary(deps: Deps, actor: Actor, input: { coachId: unknown; periodStart: unknown; periodEnd: unknown }, now = new Date(), lockOpts?: LockRetryOptions): Promise<PrepareResult> {
  if (actor.kind !== "management") return reject(403, "management_only", "Only Management can prepare work summaries");
  if (!isValidRecordId(input.coachId)) return reject(400, "invalid_coach", "coachId must be a valid Airtable record ID");
  const p = validatePeriod(input.periodStart, input.periodEnd);
  if ("error" in p) return reject(400, "invalid_period", p.error);
  const coachId = input.coachId;
  const period = p.period;
  return withLock(
    deps.lock,
    coachId,
    async (): Promise<PrepareResult> => {
      const today = ukToday(now);
      const world = await loadWorld(deps.airtable, ALL_TABLES);
      const coach = world.coaches.find((c) => c.id === coachId);
      if (!coach) return reject(404, "coach_not_found", `No Coach found for id ${coachId}`);
      const active = world.summaries.filter((s) => isActive(s) && firstLink(s.fields, "Coach") === coachId);
      const exact = active.find((s) => {
        const sp = summaryPeriod(s);
        return sp && sp.start === period.start && sp.end === period.end;
      });
      if (exact) {
        const st = summaryStatus(exact);
        const refreshed = !isFrozen(exact) && (st === "Not ready" || st === "Needs review") ? await applyRefresh(deps, world, exact, actor, today, now) : exact;
        return { status: "reused", summary: buildView(world, refreshed, actor, today) };
      }
      const overlap = active.find((s) => {
        const sp = summaryPeriod(s);
        return sp && periodsOverlap(sp, period);
      });
      if (overlap) {
        return reject(409, "overlapping_summary", "This coach already has an active work summary overlapping that period - the same work must never be summarised twice", { conflictingSummaryId: overlap.id, conflictingPeriod: summaryPeriod(overlap) });
      }
      const ev = evaluate(world, coachId, period, today);
      const status = openStatusFor(ev.pending.length, period, today);
      const previewTotal = grandTotal(ev.eligible);
      const summary = await createRecord(deps.airtable, TABLES.summaries, {
        "Work Summary ID": workSummaryIdFor(coachKey(coach), period),
        "Coach": [coachId],
        "Period Start": period.start,
        "Period End": period.end,
        "Summary Date": today,
        "Status": status,
        "Grand Total": previewTotal,
        "Active": true,
      });
      world.summaries.push(summary);
      if (status === "Needs review") {
        await ensureHistory(deps, world, summary, "Needs Review", now.toISOString(), `Prepared: ${ev.eligible.length} line(s), preview total ${formatMoney(previewTotal)}.`, actor);
      }
      return { status: "created", summary: buildView(world, summary, actor, today) };
    },
    lockOpts
  );
}

/** Reads the summary once without a lock only to learn which Coach's lock to take; everything is re-read after acquiring it. */
async function withSummaryLock<T>(deps: Deps, summaryId: unknown, fn: (coachId: string) => Promise<T>, lockOpts?: LockRetryOptions): Promise<T | Rejected | { status: "lock_unavailable" }> {
  if (!isValidRecordId(summaryId)) return reject(400, "invalid_summary", "summaryId must be a valid Airtable record ID");
  const s = await getRecord(deps.airtable, TABLES.summaries, summaryId);
  const coachId = s ? firstLink(s.fields, "Coach") : null;
  if (!s || !coachId) return reject(404, "summary_not_found", "Work summary not found");
  return withLock(deps.lock, coachId, () => fn(coachId), lockOpts);
}

function findSummary(world: World, summaryId: string): AirtableRecord | null {
  return world.summaries.find((s) => s.id === summaryId) ?? null;
}

export type ActionResult = { status: string; summary: SummaryView; [k: string]: unknown } | Rejected | { status: "lock_unavailable" };

export async function refreshSummary(deps: Deps, actor: Actor, summaryId: unknown, now = new Date(), lockOpts?: LockRetryOptions): Promise<ActionResult> {
  if (actor.kind !== "management") return reject(403, "management_only", "Only Management can refresh work summaries");
  return withSummaryLock(
    deps,
    summaryId,
    async (): Promise<ActionResult> => {
      const today = ukToday(now);
      const world = await loadWorld(deps.airtable, ALL_TABLES);
      const summary = findSummary(world, summaryId as string);
      if (!summary) return reject(404, "summary_not_found", "Work summary not found");
      const t = canRefresh(summary);
      if (!t.ok) return reject(t.httpStatus, t.code, t.error);
      const updated = await applyRefresh(deps, world, summary, actor, today, now);
      return { status: "refreshed", summary: buildView(world, updated, actor, today) };
    },
    lockOpts
  );
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export async function readSummary(deps: Deps, actor: Actor, summaryId: unknown, now = new Date()): Promise<{ status: "ok"; summary: SummaryView } | Rejected> {
  if (!isValidRecordId(summaryId)) return reject(400, "invalid_summary", "summaryId must be a valid Airtable record ID");
  const world = await loadWorld(deps.airtable, ALL_TABLES);
  const summary = findSummary(world, summaryId);
  // A coach asking for someone else's summary gets the same 404 as a missing one - existence is not leaked.
  if (!summary || (actor.kind === "coach" && firstLink(summary.fields, "Coach") !== actor.coachId)) return reject(404, "summary_not_found", "Work summary not found");
  return { status: "ok", summary: buildView(world, summary, actor, ukToday(now)) };
}

export async function listSummaries(deps: Deps, actor: Actor, filter: { coachId?: unknown } = {}): Promise<{ status: "ok"; summaries: any[] } | Rejected> {
  if (filter.coachId != null && !isValidRecordId(filter.coachId)) return reject(400, "invalid_coach", "coachId must be a valid Airtable record ID");
  const world = await loadWorld(deps.airtable, ["summaries", "coaches"]);
  const coachFilter = actor.kind === "coach" ? actor.coachId : (filter.coachId as string | undefined);
  const names = new Map(world.coaches.map((c) => [c.id, c.fields["Coach Name"] ?? null]));
  const rows = world.summaries
    .filter((s) => !coachFilter || firstLink(s.fields, "Coach") === coachFilter)
    .map((s) => ({
      summaryId: s.id,
      workSummaryId: workSummaryIdOf(s),
      coachId: firstLink(s.fields, "Coach"),
      coachName: names.get(firstLink(s.fields, "Coach") ?? "") ?? null,
      period: summaryPeriod(s),
      status: summaryStatus(s),
      active: isActive(s),
      frozen: isFrozen(s),
      grandTotal: typeof s.fields["Grand Total"] === "number" ? s.fields["Grand Total"] : null,
    }))
    .sort((a, b) => String(b.period?.start ?? "").localeCompare(String(a.period?.start ?? "")) || a.summaryId.localeCompare(b.summaryId));
  return { status: "ok", summaries: rows };
}

// ---------------------------------------------------------------------
// Coach query
// ---------------------------------------------------------------------

export async function querySummary(deps: Deps, actor: Actor, input: { summaryId: unknown; note: unknown }, now = new Date(), lockOpts?: LockRetryOptions): Promise<ActionResult> {
  if (actor.kind !== "coach") return reject(403, "coach_only", "Only the coach a summary belongs to can raise a query");
  const n = validateNote(input.note, "note");
  if ("error" in n) return reject(400, "invalid_note", n.error);
  return withSummaryLock(
    deps,
    input.summaryId,
    async (coachId): Promise<ActionResult> => {
      if (coachId !== actor.coachId) return reject(404, "summary_not_found", "Work summary not found");
      const today = ukToday(now);
      const world = await loadWorld(deps.airtable, ALL_TABLES);
      const summary = findSummary(world, input.summaryId as string);
      if (!summary || firstLink(summary.fields, "Coach") !== actor.coachId) return reject(404, "summary_not_found", "Work summary not found");
      const t = canQuery(summary);
      if (!t.ok) return reject(t.httpStatus, t.code, t.error);
      const at = now.toISOString();
      // Only workflow fields change - never a value, rate or line.
      const updated = await patchRecord(deps.airtable, TABLES.summaries, summary.id, { "Status": "Queried", "Query / Reopen Note": n.note, "Queried At": at });
      world.summaries[world.summaries.findIndex((s) => s.id === summary.id)] = updated;
      await ensureHistory(deps, world, updated, "Queried", at, n.note, actor);
      return { status: "queried", summary: buildView(world, updated, actor, today) };
    },
    lockOpts
  );
}

// ---------------------------------------------------------------------
// Management finalise / reopen
// ---------------------------------------------------------------------

export async function finaliseSummary(deps: Deps, actor: Actor, summaryId: unknown, now = new Date(), lockOpts?: LockRetryOptions): Promise<ActionResult> {
  if (actor.kind !== "management") return reject(403, "management_only", "Only Management can finalise work summaries");
  return withSummaryLock(
    deps,
    summaryId,
    async (coachId): Promise<ActionResult> => {
      const today = ukToday(now);
      const world = await loadWorld(deps.airtable, ALL_TABLES);
      const summary = findSummary(world, summaryId as string);
      if (!summary) return reject(404, "summary_not_found", "Work summary not found");
      if (!isActive(summary)) return reject(409, "inactive_summary", "This summary is not active");
      if (!world.coaches.some((c) => c.id === coachId)) return reject(409, "coach_not_found", "The summary's Coach no longer exists");
      const period = summaryPeriod(summary);
      if (!period) return reject(409, "invalid_period", "The summary has no valid Period Start/End");
      const t = canFinalise(summary);
      if (!t.ok) return reject(t.httpStatus, t.code, t.error);
      if ("alreadyFinalised" in t) {
        // Idempotent retry: nothing is recalculated or rewritten. Only a History row lost to an earlier crash is repaired.
        const at = summary.fields["Finalised At"];
        if (typeof at === "string") {
          const hasEvent = (["Finalised", "Re-finalised"] as HistoryEventType[]).some((e) => world.history.some((h) => h.fields["Work Summary History ID"] === historyIdFor(workSummaryIdOf(summary), e, at)));
          if (!hasEvent) {
            const priorFinal = historyOf(world, summary.id).some((h) => h.fields["Event Type"] === "Finalised");
            await ensureHistory(deps, world, summary, priorFinal ? "Re-finalised" : "Finalised", at, `Grand Total ${formatMoney(summary.fields["Grand Total"] ?? 0)} (history row repaired on retry).`, actor);
          }
        }
        return { status: "already_finalised", summary: buildView(world, summary, actor, today) };
      }
      if (period.end >= today) return reject(409, "period_not_ended", `The period ends ${period.end}; a summary can only be finalised after its period is over`);
      const ev = evaluate(world, coachId, period, today);
      if (ev.pending.length) return reject(409, "pending_items", "Some work in this period is not ready to be summarised", { pending: ev.pending });

      const wsId = workSummaryIdOf(summary);
      const planned = planLines(ev.eligible, wsId);
      const rec = reconcileLines(planned, linesOf(world, summary.id));
      const written: AirtableRecord[] = [];
      for (const c of rec.create) {
        const r = await createRecord(deps.airtable, TABLES.lines, lineFields(c, summary.id));
        world.lines.push(r);
        written.push(r);
      }
      for (const u of rec.update) {
        const r = await patchRecord(deps.airtable, TABLES.lines, u.recordId, lineFields(u.line, summary.id));
        world.lines[world.lines.findIndex((l) => l.id === r.id)] = r;
        written.push(r);
      }
      for (const u of rec.unchanged) written.push(world.lines.find((l) => l.id === u.recordId)!);
      for (const d of rec.detach) {
        const r = await patchRecord(deps.airtable, TABLES.lines, d.recordId, { "Work Summary": linkIds(world.lines.find((l) => l.id === d.recordId)?.fields["Work Summary"]).filter((x) => x !== summary.id) });
        world.lines[world.lines.findIndex((l) => l.id === r.id)] = r;
      }
      // Grand Total is the sum of the Final Cost Snapshots actually stored on the frozen lines.
      const total = grandTotal(written.map(readStoredLine));
      const eventType = finaliseEventType(summary);
      const at = now.toISOString();
      const wasQuery = summaryStatus(summary) === "Queried";
      const updated = await patchRecord(deps.airtable, TABLES.summaries, summary.id, {
        "Status": "Finalised",
        "Grand Total": total,
        "Summary Date": today,
        "Finalised By User ID": actor.userId,
        "Finalised By Name Snapshot": actor.displayName,
        "Finalised At": at,
      });
      world.summaries[world.summaries.findIndex((s) => s.id === summary.id)] = updated;
      const note = finaliseNote(total, rec) + (wasQuery ? `\nResolves query: ${summary.fields["Query / Reopen Note"] ?? ""}` : "");
      await ensureHistory(deps, world, updated, eventType, at, note, actor);
      return {
        status: "finalised",
        eventType,
        lineChanges: { created: rec.create.length, updated: rec.update.length, unchanged: rec.unchanged.length, detached: rec.detach.length },
        summary: buildView(world, updated, actor, today),
      };
    },
    lockOpts
  );
}

export async function reopenSummary(deps: Deps, actor: Actor, input: { summaryId: unknown; reason: unknown }, now = new Date(), lockOpts?: LockRetryOptions): Promise<ActionResult> {
  if (actor.kind !== "management") return reject(403, "management_only", "Only Management can reopen work summaries");
  const r = validateNote(input.reason, "reason");
  if ("error" in r) return reject(400, "invalid_reason", r.error);
  return withSummaryLock(
    deps,
    input.summaryId,
    async (coachId): Promise<ActionResult> => {
      const today = ukToday(now);
      const world = await loadWorld(deps.airtable, ALL_TABLES);
      const summary = findSummary(world, input.summaryId as string);
      if (!summary) return reject(404, "summary_not_found", "Work summary not found");
      const t = canReopen(summary);
      if (!t.ok) return reject(t.httpStatus, t.code, t.error);
      const period = summaryPeriod(summary)!;
      const ev = evaluate(world, coachId, period, today);
      const frozenLines = linesOf(world, summary.id);
      const at = now.toISOString();
      // Finalised By/At and the frozen lines are left in place: the reopen is recorded alongside them, never over them.
      const updated = await patchRecord(deps.airtable, TABLES.summaries, summary.id, {
        "Status": openStatusFor(ev.pending.length, period, today),
        "Query / Reopen Note": r.note,
        "Reopened By User ID": actor.userId,
        "Reopened By Name Snapshot": actor.displayName,
        "Reopened At": at,
      });
      world.summaries[world.summaries.findIndex((s) => s.id === summary.id)] = updated;
      const note = `${r.note}\nPrevious finalisation: Grand Total ${formatMoney(summary.fields["Grand Total"] ?? 0)} across ${frozenLines.length} line(s), finalised ${summary.fields["Finalised At"] ?? "-"} by ${summary.fields["Finalised By Name Snapshot"] ?? "-"}.`;
      await ensureHistory(deps, world, updated, "Reopened", at, note, actor);
      return { status: "reopened", summary: buildView(world, updated, actor, today) };
    },
    lockOpts
  );
}
