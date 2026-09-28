/**
 * Test-suite copy of the canonical needs-attention/orchestrator.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry.ts become needs-attention-*.ts.
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
 * Nothing is written anywhere. An evaluator that throws marks the result
 * incomplete (complete: false + configIssue) rather than failing the
 * whole queue or silently dropping the problem.
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
  type ConfigIssue,
  type EvaluatorRegistration,
  type NeedsAttentionCase,
  type SuppressedCase,
} from "./needs-attention-engine.ts";
import { type AirtableConfig, createReader, loadConfig } from "./needs-attention-repository.ts";

export interface Deps {
  airtable: AirtableConfig;
  registry: readonly EvaluatorRegistration[];
}

export interface Caller {
  userId: string;
  role: string;
  active: boolean;
  /** From the authenticated Supabase profile ONLY. */
  organisationId: string | null;
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

export async function getCases(deps: Deps, caller: Caller, query: CasesQuery, now = new Date()): Promise<CasesOutcome> {
  if (!caller.active || caller.role !== "management") return reject(403, "management_only", "Needs Attention is available to active Management only");
  const view = query.view ?? "full";
  if (view !== "full" && view !== "summary") return reject(400, "invalid_view", "view must be 'summary' or omitted");
  const lookup = query.caseKey != null ? parseCaseKey(query.caseKey) : null;
  if (query.caseKey != null && !lookup) return reject(400, "invalid_case_key", "caseKey must look like ruleKey|type:id[|type:id...]");
  if (lookup && view === "summary") return reject(400, "invalid_query", "Use either view=summary or caseKey, not both");

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
    onlyRuleKey: lookup?.ruleKey ?? null,
  });
  const issues: ConfigIssue[] = [...catalogue.issues, ...settings.issues, ...plan.issues];
  const exceptions = cfg.exceptions.map(parseException);

  const sources = plan.sourcesToLoad.length ? await reader.listMany(plan.sourcesToLoad) : {};

  let complete = true;
  const active: NeedsAttentionCase[] = [];
  const suppressed: SuppressedCase[] = [];
  const evaluated: { ruleKey: string; candidates: number; active: number; suppressed: number }[] = [];
  for (const entry of plan.entries) {
    if (!entry.run) continue;
    const ev = entry.evaluator!;
    const ctxSources: Record<string, readonly any[]> = {};
    for (const s of ev.sources) ctxSources[s] = sources[s] ?? [];
    try {
      const candidates = ev.evaluate({ now, organisation, sources: Object.freeze(ctxSources) });
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
