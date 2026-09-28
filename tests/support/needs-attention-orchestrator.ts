/**
 * Test-suite copy of the canonical needs-attention/orchestrator.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Needs Attention orchestrator (see TEST-ENV.md "Needs Attention
 * Foundation - Slice 2"). Composes the read-only request:
 *
 *   1. load the five config tables once (Rules, Settings, Exceptions,
 *      Feature Controls, Organisation & Branding);
 *   2. resolve exactly one organisation from the CALLER'S PROFILE
 *      organisation_id (fail closed on none / several);
 *   3. plan: which catalogue rules run (registry + status + module +
 *      inherited Settings), and the union of domain sources they need;
 *   4. load those sources once each (none at all if nothing runs);
 *   5. run evaluators, build Case Keys, compute severity, apply
 *      exceptions, summarise, order and shape the payload.
 *
 * GET never writes. An evaluator that throws marks the result
 * incomplete (complete: false + configIssue) rather than failing the
 * whole queue or silently dropping the problem.
 *
 * Slice 5 adds the Management exception write path (createException /
 * revokeException). Both reuse the SAME evaluation as GET (evaluate()),
 * take every identity fact from the caller's profile and the re-evaluated
 * case (pure policy in exceptions.ts), and serialise per Organisation +
 * Case Key through the needs_attention_exception_locks lock. The only
 * writes are one Exceptions row create or one Exceptions row patch.
 */
import {
  ENGINE_VERSION,
  buildCatalogue,
  materialiseCases,
  organisationView,
  parseCaseKey,
  parseException,
  planEvaluation,
  resolveOrganisation,
  settingsForOrganisation,
  sortCases,
  summarise,
  matchException,
  type ConfigIssue,
  type EvaluatorRegistration,
  type ExceptionRow,
  type NeedsAttentionCase,
  type OrganisationContext,
  type Plan,
  type SuppressedCase,
} from "./needs-attention-engine.ts";
import {
  actorFromProfile,
  buildCreateFields,
  buildExceptionId,
  buildRevokeFields,
  contextLinksFromCase,
  decideCreate,
  exceptionLockKey,
  exceptionView,
  findOwnedException,
  inForceFor,
  parseCreateBody,
  parseRevokeBody,
} from "./needs-attention-exceptions.ts";
import type { LockClient } from "./needs-attention-lock-client.ts";
import { type AirtableConfig, type Reader, CONFIG_TABLES, createExceptionRecord, createReader, loadConfig, updateExceptionRecord } from "./needs-attention-repository.ts";

export interface Deps {
  airtable: AirtableConfig;
  registry: readonly EvaluatorRegistration[];
  /** Required only by the exception write routes (Slice 5). */
  lock?: LockClient;
}

export interface Caller {
  userId: string;
  role: string;
  active: boolean;
  /** From the authenticated Supabase profile ONLY. */
  organisationId: string | null;
  /** Profile display name / account email - used only for audit name snapshots. */
  displayName?: string | null;
  email?: string | null;
}

export interface CasesQuery {
  view?: string | null;
  caseKey?: string | null;
  debug?: boolean;
}

export type Rejected = { status: "rejected"; httpStatus: number; code: string; error: string };
export type CasesOutcome = { status: "ok"; body: Record<string, unknown> } | Rejected;

function reject(httpStatus: number, code: string, error: string): Rejected {
  return { status: "rejected", httpStatus, code, error };
}

export interface Evaluation {
  status: "ok";
  organisation: OrganisationContext;
  catalogue: ReturnType<typeof buildCatalogue>;
  plan: Plan;
  reader: Reader;
  exceptionRows: ExceptionRow[];
  active: NeedsAttentionCase[];
  suppressed: SuppressedCase[];
  issues: ConfigIssue[];
  evaluated: { ruleKey: string; candidates: number; active: number; suppressed: number }[];
  complete: boolean;
}

/**
 * One evaluation of the caller's organisation (optionally a single rule):
 * config tables once, runnable sources once, evaluators, identity,
 * severity and exception matching. Shared by GET /cases and the exception
 * write routes so "does this case exist / is it suppressed" is always
 * answered by exactly the code that builds the queue.
 */
export async function evaluate(deps: Deps, caller: Caller, opts: { onlyRuleKey: string | null; now: Date }): Promise<Evaluation | Rejected> {
  const now = opts.now;
  const reader = createReader(deps.airtable);
  const cfg = await loadConfig(reader);

  const org = resolveOrganisation(caller.organisationId, cfg.organisations);
  if (!org.ok) return reject(409, org.code, org.error);
  const organisation = org.organisation;

  const catalogue = buildCatalogue(cfg.rules);
  const settings = settingsForOrganisation(cfg.settings, organisation.recordId);
  const plan = planEvaluation({
    catalogue,
    settings: settings.byRuleRecordId,
    featureRecords: cfg.features,
    registry: deps.registry,
    onlyRuleKey: opts.onlyRuleKey,
  });
  const issues: ConfigIssue[] = [...catalogue.issues, ...settings.issues, ...plan.issues];
  const exceptions = cfg.exceptions.map(parseException);

  const sources = plan.sourcesToLoad.length ? await reader.listMany(plan.sourcesToLoad) : {};

  let complete = true;
  const active: NeedsAttentionCase[] = [];
  const suppressed: SuppressedCase[] = [];
  const evaluated: { ruleKey: string; candidates: number; active: number; suppressed: number }[] = [];
  // Evaluator-reported data issues: identical reports (same code, record and detail) are kept once.
  const reportedIssueKeys = new Set<string>();
  const reportIssue = (issue: ConfigIssue) => {
    const key = `${issue.code}|${issue.recordId ?? ""}|${issue.detail}`;
    if (reportedIssueKeys.has(key)) return;
    reportedIssueKeys.add(key);
    issues.push({ ...issue });
  };
  for (const entry of plan.entries) {
    if (!entry.run) continue;
    const ev = entry.evaluator!;
    const ctxSources: Record<string, readonly any[]> = {};
    for (const s of ev.sources) ctxSources[s] = sources[s] ?? [];
    try {
      const candidates = ev.evaluate({ now, organisation, sources: Object.freeze(ctxSources), reportIssue });
      const m = materialiseCases(entry, candidates, { organisation, exceptions, now });
      active.push(...m.active);
      suppressed.push(...m.suppressed);
      issues.push(...m.issues);
      evaluated.push({ ruleKey: entry.rule.ruleKey!, candidates: candidates.length, active: m.active.length, suppressed: m.suppressed.length });
    } catch (e) {
      complete = false;
      issues.push({ code: "evaluator_error", detail: e instanceof Error ? e.message : String(e), ruleKey: entry.rule.ruleKey! });
    }
  }

  return { status: "ok", organisation, catalogue, plan, reader, exceptionRows: exceptions, active, suppressed, issues, evaluated, complete };
}

export async function getCases(deps: Deps, caller: Caller, query: CasesQuery, now = new Date()): Promise<CasesOutcome> {
  if (!caller.active || caller.role !== "management") return reject(403, "management_only", "Needs Attention is available to active Management only");
  const view = query.view ?? "full";
  if (view !== "full" && view !== "summary") return reject(400, "invalid_view", "view must be 'summary' or omitted");
  const lookup = query.caseKey != null ? parseCaseKey(query.caseKey) : null;
  if (query.caseKey != null && !lookup) return reject(400, "invalid_case_key", "caseKey must look like ruleKey|type:id[|type:id...]");
  if (lookup && view === "summary") return reject(400, "invalid_query", "Use either view=summary or caseKey, not both");

  const ev = await evaluate(deps, caller, { onlyRuleKey: lookup?.ruleKey ?? null, now });
  if (ev.status === "rejected") return ev;
  const { organisation, catalogue, plan, reader, active, suppressed, issues, evaluated, complete } = ev;
  const sortOrder = new Map(catalogue.rules.filter((r) => r.ruleKey).map((r) => [r.ruleKey!, r.sortOrder]));
  const cases = sortCases(active, sortOrder);
  const summary = summarise(cases, suppressed.length);
  const base = { engine: ENGINE_VERSION, organisation: organisationView(organisation), generatedAt: now.toISOString(), complete };

  const diagnostics = query.debug
    ? {
        diagnostics: {
          rulesInCatalogue: catalogue.rules.length,
          evaluated,
          skipped: plan.entries.filter((e) => !e.run).map((e) => ({ ruleKey: e.rule.ruleKey, ruleId: e.rule.ruleId, reason: e.skipReason, detail: e.skipDetail })),
          sourcesLoaded: plan.sourcesToLoad,
          reads: reader.stats(),
          suppressedCases: suppressed.map((s) => ({ caseKey: s.case.caseKey, ruleKey: s.case.ruleKey, exceptionId: s.exceptionId, exceptionRecordId: s.exceptionRecordId, effectiveUntil: s.effectiveUntil })),
        },
      }
    : {};

  if (lookup) {
    const found = cases.find((c) => c.caseKey === query.caseKey) ?? null;
    const sup = suppressed.find((s) => s.case.caseKey === query.caseKey) ?? null;
    const entry = plan.entries.find((e) => e.rule.ruleKey === lookup.ruleKey) ?? null;
    return {
      status: "ok",
      body: {
        ...base,
        caseKey: query.caseKey,
        exists: !!found,
        suppressed: !!sup,
        case: found,
        rule: entry
          ? { ruleKey: entry.rule.ruleKey, ruleId: entry.rule.ruleId, evaluated: entry.run, skipReason: entry.skipReason }
          : { ruleKey: lookup.ruleKey, ruleId: null, evaluated: false, skipReason: "unknown_rule" },
        configIssues: issues,
        ...diagnostics,
      },
    };
  }
  if (view === "summary") return { status: "ok", body: { ...base, summary, ...diagnostics } };
  return { status: "ok", body: { ...base, summary, cases, configIssues: issues, ...diagnostics } };
}

// ---------------------------------------------------------------------
// Exception write path (Slice 5). Management-only; exact-case only.
// ---------------------------------------------------------------------

export interface LockRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

// One create/revoke re-evaluates one rule (~1-2s of Airtable reads), so a
// waiter needs a budget of several operations.
const DEFAULT_LOCK_MAX_ATTEMPTS = 100;
const DEFAULT_LOCK_RETRY_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Same bounded acquire/retry/always-release shape as coach-cover's withLock (copied, not shared). */
async function withLock<T>(lock: LockClient, key: string, fn: (token: string) => Promise<T>, opts: LockRetryOptions = {}): Promise<T | { status: "lock_unavailable" }> {
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
    return await fn(token);
  } finally {
    await lock.release(key, token);
  }
}

export type WriteOutcome = { status: "ok"; httpStatus: 200 | 201; body: Record<string, unknown> } | (Rejected & { body?: Record<string, unknown> });

const LOCK_BUSY: Rejected = { status: "rejected", httpStatus: 409, code: "lock_busy", error: "This case's exception is being changed by another request - please retry" };

function managementGuard(caller: Caller): Rejected | null {
  if (!caller.active || caller.role !== "management") return reject(403, "management_only", "Only active Management can approve or revoke Needs Attention exceptions");
  const org = (caller.organisationId ?? "").trim();
  if (!org) return reject(409, "organisation_not_found", "Your profile has no organisation");
  return null;
}

/**
 * POST /exceptions. Body: { caseKey, reason, effectiveUntil? } only.
 * Under the per-case lock: re-evaluate the case's rule for the caller's
 * organisation, require the case to exist now and be overrideable, refuse
 * a duplicate, then write exactly one Exceptions row whose organisation,
 * rule, context links and approver are all server-derived.
 */
export async function createException(deps: Deps, caller: Caller, body: unknown, now = new Date(), lockOpts?: LockRetryOptions): Promise<WriteOutcome> {
  const denied = managementGuard(caller);
  if (denied) return denied;
  const parsed = parseCreateBody(body, now);
  if (!parsed.ok) return reject(parsed.httpStatus, parsed.code, parsed.error);
  const req = parsed.value;
  if (!deps.lock) throw new Error("createException needs a lock client");
  const approver = actorFromProfile({ userId: caller.userId, displayName: caller.displayName, email: caller.email });
  const lockKey = exceptionLockKey(caller.organisationId!.trim(), req.caseKey);

  const out = await withLock(
    deps.lock,
    lockKey,
    async (token): Promise<WriteOutcome> => {
      const ev = await evaluate(deps, caller, { onlyRuleKey: req.ruleKey, now });
      if (ev.status === "rejected") return ev;
      const entry = ev.plan.entries.find((e) => e.rule.ruleKey === req.ruleKey) ?? null;
      const inForce = inForceFor(ev.exceptionRows, ev.organisation.recordId, req.caseKey, now);
      const decision = decideCreate({ caseKey: req.caseKey, ruleKey: req.ruleKey, entry, complete: ev.complete, active: ev.active, suppressed: ev.suppressed, inForce });
      if (decision.kind === "rejected") {
        return {
          ...reject(decision.httpStatus, decision.code, decision.error),
          ...(decision.existing ? { body: { exception: exceptionView(decision.existing, { ruleKey: req.ruleKey, organisationId: ev.organisation.organisationId }) } } : {}),
        };
      }
      const fields = buildCreateFields({
        exceptionId: buildExceptionId(now, token),
        organisationRecordId: ev.organisation.recordId,
        ruleRecordId: decision.entry.rule.recordId,
        caseKey: req.caseKey,
        links: contextLinksFromCase(decision.case),
        reason: req.reason,
        approver,
        now,
        effectiveUntil: req.effectiveUntil,
      });
      const rec = await createExceptionRecord(deps.airtable, fields);
      const row = parseException(rec);
      // Suppression state of the written row, via the SAME matcher the queue uses.
      const suppressedNow = !!matchException([row], {
        organisationRecordId: ev.organisation.recordId,
        rule: decision.entry.rule,
        caseKey: req.caseKey,
        overrideAllowed: decision.entry.config.overrideAllowed,
        now,
      });
      return {
        status: "ok",
        httpStatus: 201,
        body: {
          created: true,
          exception: exceptionView(row, { ruleKey: req.ruleKey, organisationId: ev.organisation.organisationId }),
          case: { caseKey: req.caseKey, ruleKey: req.ruleKey, ruleId: decision.entry.rule.ruleId, title: decision.case.title, suppressed: suppressedNow },
          reads: ev.reader.stats(),
          writes: 1,
        },
      };
    },
    lockOpts
  );
  return "status" in out && out.status === "lock_unavailable" ? LOCK_BUSY : (out as WriteOutcome);
}

/**
 * POST /exceptions/revoke. Body: { exceptionId, reason } only. Finds the
 * caller-organisation-owned exception, then under the same per-case lock
 * re-reads the Exceptions table, sets Active = false and records the
 * revoke audit fields (never deletes, never edits the approval snapshot).
 * Finally re-evaluates the rule to report whether the case is visible again.
 */
export async function revokeException(deps: Deps, caller: Caller, body: unknown, now = new Date(), lockOpts?: LockRetryOptions): Promise<WriteOutcome> {
  const denied = managementGuard(caller);
  if (denied) return denied;
  const parsed = parseRevokeBody(body);
  if (!parsed.ok) return reject(parsed.httpStatus, parsed.code, parsed.error);
  const req = parsed.value;
  if (!deps.lock) throw new Error("revokeException needs a lock client");
  const revoker = actorFromProfile({ userId: caller.userId, displayName: caller.displayName, email: caller.email });

  // Locate: only the two tables needed to resolve the tenant and the row.
  const pre = await createReader(deps.airtable).listMany([CONFIG_TABLES.organisations, CONFIG_TABLES.exceptions]);
  const org = resolveOrganisation(caller.organisationId, pre[CONFIG_TABLES.organisations]);
  if (!org.ok) return reject(409, org.code, org.error);
  const organisation = org.organisation;
  const target = findOwnedException(pre[CONFIG_TABLES.exceptions].map(parseException), organisation.recordId, req.exceptionRef);
  if (!target) return reject(404, "exception_not_found", "No exception with that id belongs to your organisation");
  const caseKey = target.caseKey ?? `invalid-key:${target.recordId}`;
  const ruleKey = target.caseKey ? parseCaseKey(target.caseKey)?.ruleKey ?? null : null;

  const out = await withLock(
    deps.lock,
    exceptionLockKey(caller.organisationId!.trim(), caseKey),
    async (): Promise<WriteOutcome> => {
      // Fresh read under the lock: the row may have been revoked meanwhile.
      const fresh = findOwnedException((await createReader(deps.airtable).list(CONFIG_TABLES.exceptions)).map(parseException), organisation.recordId, target.recordId);
      if (!fresh) return reject(404, "exception_not_found", "No exception with that id belongs to your organisation");
      if (!fresh.active) {
        return { ...reject(409, "already_revoked", "This exception is already inactive - nothing was changed"), body: { exception: exceptionView(fresh, { ruleKey, organisationId: organisation.organisationId }) } };
      }
      const rec = await updateExceptionRecord(deps.airtable, fresh.recordId, buildRevokeFields({ revoker, now, reason: req.reason }));
      return { status: "ok", httpStatus: 200, body: { exception: exceptionView(parseException(rec), { ruleKey, organisationId: organisation.organisationId }) } };
    },
    lockOpts
  );
  if ("status" in out && out.status === "lock_unavailable") return LOCK_BUSY;
  const result = out as WriteOutcome;
  if (result.status !== "ok") return result;

  // Re-evaluation (outside the lock; read-only): is the case visible again?
  let caseState: Record<string, unknown> = { caseKey: target.caseKey, visibleAgain: null, reason: "not_evaluated" };
  if (ruleKey && target.caseKey) {
    const ev = await evaluate(deps, caller, { onlyRuleKey: ruleKey, now });
    if (ev.status === "ok") {
      const visible = ev.active.some((c) => c.caseKey === target.caseKey);
      const stillSuppressed = ev.suppressed.some((s) => s.case.caseKey === target.caseKey);
      caseState = {
        caseKey: target.caseKey,
        visibleAgain: visible,
        suppressedByAnotherException: stillSuppressed,
        reason: visible ? "problem_still_present" : stillSuppressed ? "another_exception_in_force" : "problem_no_longer_present",
      };
    }
  }
  return { ...result, body: { revoked: true, ...result.body, case: caseState, writes: 1 } };
}
