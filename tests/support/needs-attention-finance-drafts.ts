/**
 * Test-suite copy of the canonical needs-attention/finance-drafts.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client|work-summaries|finance|finance-drafts.ts become needs-attention-*.ts.
 */
/**
 * Finance invoice-draft evaluator for Needs Attention (Finance Foundation
 * F8b; see TEST-ENV.md "Finance Foundation - F8b"):
 *
 *   invoice_draft_blocked (ATT-048): an OPEN Finance invoice draft (F5,
 *   status Draft, never issued) whose F5 review has one or more BLOCKERS -
 *   anything that stops Management marking it Ready for issue.
 *
 * Source of truth is the F5 review itself, not a second blocker model:
 *  - The blocker / warning decision is F5's own reviewDraft(), and every
 *    input it needs is built exactly as F5's loadClientWork() builds it: the
 *    F3 snapshot (buildWorld + today's service lifecycle), Finance Settings,
 *    the client's Sessions and their occurrences in the draft period, F4
 *    overrides, F4's resolveOccurrenceBilling() per occurrence, every claim
 *    (Included draft lines + issued invoice lines), the replacement-draft
 *    correction scope and classifyWork().
 *  - Those Finance modules are IMPORTED from ../finance (pure code only: no
 *    fetch, no Deno, no writes) and bundled into this function's single
 *    deployed index.js by scripts/build-needs-attention-bundle.mjs, which
 *    allows exactly these files and records their hashes - there is no
 *    runtime import of another Edge Function and nothing to drift.
 *  - The two small helpers that live in Finance orchestrator files (which
 *    also hold fetch code) are COPIED VERBATIM below and drift-tested:
 *    serviceFinder (F4) and lifecycleHistory (F3).
 *  - Finance's repositories re-check every row in code (their Airtable
 *    formulas only narrow); this file applies the same in-code checks to
 *    the full table lists the engine loads once per request.
 *
 * One bounded pass per request: eleven tables, each listed once by the
 * engine (Sessions / Session Occurrences are shared with the staffing
 * rules); every open draft is then reviewed in memory against shared
 * indexes. No per-draft read, no Finance API call, no F4 call per draft,
 * no write. A malformed Finance row of this organisation fails the whole
 * pass loudly (complete:false + evaluator_error), as in F8a.
 *
 * Access: the F8a Finance capability filter applies unchanged (this rule's
 * catalogue module is module_finance).
 */
import type { CandidateCase, EvaluatorContext, EvaluatorRegistration } from "./needs-attention-engine.ts";
import { FinanceDataError } from "./needs-attention-finance.ts";
import { type Claim, type Draft, type Line, applyCorrectionScope, classifyWork, reviewDraft } from "./finance-invoicing.ts";
import { type Resolution, type ServiceContext, OCCURRENCE_ID_PATTERN, resolveOccurrenceBilling } from "./finance-billing.ts";
import { BILLING_TABLES, FB, buildOverrides, occurrenceFacts } from "./finance-billing-mapping.ts";
import { type Row, type World, TABLES as COMMERCIAL_TABLES, buildWorld } from "./finance-commercial-mapping.ts";
import { checkHistory, todayIn } from "./finance-commercial.ts";
import { type LifecyclePeriod, checkLifecycle, lifecycleOn } from "./finance-lifecycle.ts";
import { FI, INVOICING_TABLES, buildDrafts, buildLines } from "./finance-invoicing-mapping.ts";
import { FV, ISSUE_TABLES, buildInvoiceLines } from "./finance-issue-mapping.ts";
import { SETTINGS_TABLE, STORED as SETTINGS_FIELDS, fromStoredRow } from "./finance-settings.ts";
import { formatMinor } from "./finance-money.ts";

// ===== COPIED FROM finance/finance-commercial-orchestrator.ts - DO NOT EDIT HERE =====
/** The applying (non-superseded) lifecycle periods of a service, sorted; validated by buildWorld. */
export function lifecycleHistory(world: World, serviceId: string): LifecyclePeriod[] {
  const h = checkLifecycle(world.lifecycle.filter((l) => l.value.serviceId === serviceId).map((l) => l.value));
  return h.ok ? h.history : [];
}
// ===== END COPIED BLOCK =====

// ===== COPIED FROM finance/finance-billing-orchestrator.ts - DO NOT EDIT HERE =====
/** Looks a Finance Service up in THIS organisation's snapshot only. */
export function serviceFinder(w: World): (serviceId: string) => ServiceContext | null {
  return (serviceId) => {
    const s = w.services.find((x) => x.value.serviceId === serviceId);
    if (!s) return null;
    const c = w.clients.find((x) => x.value.clientId === s.value.clientId);
    if (!c) return null;
    const h = checkHistory(w.terms.filter((t) => t.value.serviceId === serviceId).map((t) => t.value));
    return { service: s.value, client: c.value, terms: h.ok ? { ok: true, history: h.history } : { ok: false, error: h.error }, lifecycle: lifecycleHistory(w, serviceId) };
  };
}
// ===== END COPIED BLOCK =====

/** Exactly the tables invoice_draft_blocked reads (each listed once per request by the engine). */
export const DRAFT_BLOCKED_SOURCES: readonly string[] = [
  COMMERCIAL_TABLES.clients,
  COMMERCIAL_TABLES.services,
  COMMERCIAL_TABLES.terms,
  COMMERCIAL_TABLES.lifecycle,
  SETTINGS_TABLE,
  BILLING_TABLES.sessions,
  BILLING_TABLES.occurrences,
  BILLING_TABLES.overrides,
  INVOICING_TABLES.drafts,
  INVOICING_TABLES.lines,
  ISSUE_TABLES.lines,
];

/**
 * Plain Management wording for every F5 review BLOCKER code (the detailed
 * F5 messages stay on the draft review). A blocker code F5 adds later
 * without a label here still raises the case, as "Needs review" (and the
 * drift test fails until it is named).
 */
export const BLOCKER_LABELS: Readonly<Record<string, string>> = {
  no_included_lines: "Nothing to invoice on this draft",
  client_not_found: "Client record is missing",
  manual_billing_client: "Client is now billed manually",
  billing_email_missing: "Missing billing information",
  po_missing: "PO required",
  payment_terms_missing: "Payment terms missing",
  source_changed: "Source work has changed",
  duplicate_claim: "Work is already on another invoice",
  unresolved_configuration: "Billing setup needs fixing",
  totals_do_not_reconcile: "Invoice totals need review",
  missing_commercial_terms: "Commercial terms need attention",
};
export const blockerLabel = (code: string): string => BLOCKER_LABELS[code] ?? "Needs review";

// ---------------------------------------------------------------------
// One review pass per request (memoised on the shared sources object)
// ---------------------------------------------------------------------

type Rows = readonly Row[];

export interface DraftFinding {
  draft: Draft;
  /** F5 blocker codes in F5's review order. */
  blockers: string[];
  warnings: number;
}

export interface DraftReviewPass {
  today: string;
  /** Drafts of this organisation (any state) / open drafts reviewed. */
  drafts: number;
  open: number;
  blocked: DraftFinding[];
}

const passCache = new WeakMap<object, DraftReviewPass>();
let passRuns = 0;
/** Test hook: how many review passes actually ran (memoisation proof). */
export function draftReviewPassStats() {
  return { runs: passRuns };
}

const inOrg = (r: Row, org: string, field: string) => Array.isArray(r.fields?.[field]) && r.fields[field].includes(org);
const SESSION_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

function built<T>(b: { ok: true } & T | { ok: false; error: string }, what: string): T {
  if (!b.ok) throw new FinanceDataError(`${what}: ${(b as { error: string }).error}`);
  return b as T;
}

export function runDraftReviewPass(ctx: EvaluatorContext): DraftReviewPass {
  const cached = passCache.get(ctx.sources);
  if (cached) return cached;
  passRuns++;
  const org = ctx.organisation.recordId;
  const at = ctx.now;
  const today = todayIn(ctx.organisation.timezone, at);
  const src = (t: string) => (ctx.sources[t] ?? []) as Rows;

  // Drafts + their lines (F5 findDraftRows / listDraftLineRows: rows of this organisation).
  const drafts = built(buildDrafts(src(INVOICING_TABLES.drafts).filter((r) => inOrg(r, org, FI.org)), org), "Finance Invoice Drafts").drafts.map((d) => d.value);
  const open = drafts.filter((d) => d.status === "draft" && d.issuedInvoiceId === null);
  const result: DraftReviewPass = { today, drafts: drafts.length, open: open.length, blocked: [] };
  if (!open.length) {
    passCache.set(ctx.sources, result);
    return result;
  }
  const allLines = built(buildLines(src(INVOICING_TABLES.lines).filter((r) => inOrg(r, org, FI.org)), org), "Finance Invoice Draft Lines").lines.map((l) => l.value);
  const linesOf = new Map<string, Line[]>();
  for (const l of allLines) linesOf.set(l.draftId, [...(linesOf.get(l.draftId) ?? []), l]);

  // F3 snapshot (loadWorld): every service must have a lifecycle period covering today.
  const raw = {
    clients: src(COMMERCIAL_TABLES.clients).filter((r) => inOrg(r, org, "Organisation")),
    services: src(COMMERCIAL_TABLES.services).filter((r) => inOrg(r, org, "Organisation")),
    terms: src(COMMERCIAL_TABLES.terms).filter((r) => inOrg(r, org, "Organisation")),
    lifecycle: src(COMMERCIAL_TABLES.lifecycle).filter((r) => inOrg(r, org, "Organisation")),
  };
  const w0 = built(buildWorld(raw), "Finance clients / services / terms").world;
  const services = [];
  for (const s of w0.services) {
    const cur = lifecycleOn(lifecycleHistory(w0, s.value.serviceId), today);
    if (cur.status !== "resolved") throw new FinanceDataError(`Service ${s.value.serviceId} has no lifecycle period covering ${today}`);
    services.push({ recordId: s.recordId, value: { ...s.value, status: cur.period.status } });
  }
  const world: World = { ...w0, services };

  // Finance Settings (F5 loadSettings): none is fine, several or invalid is not.
  const settingsRows = src(SETTINGS_TABLE).filter((r) => inOrg(r, org, SETTINGS_FIELDS.organisation));
  if (settingsRows.length > 1) throw new FinanceDataError("More than one Finance Settings record exists for the organisation");
  if (settingsRows.length === 1) {
    const p = fromStoredRow(settingsRows[0] as any);
    if (!p.ok) throw new FinanceDataError(`Stored Finance Settings are not valid (${p.problems.join(", ")})`);
  }

  // F4 overrides, claims (Included draft lines + issued invoice lines) - built once, filtered per draft.
  const overrides = built(buildOverrides(src(BILLING_TABLES.overrides).filter((r) => inOrg(r, org, FB.org)) as Row[], org), "Finance billing overrides").overrides.map((o) => o.value);
  const issuedLines = built(buildInvoiceLines(src(ISSUE_TABLES.lines).filter((r) => inOrg(r, org, FV.org)) as Row[], org), "Finance Invoice Lines").lines.map((l) => l.value);
  const includedClaims: Claim[] = allLines.filter((l) => l.status === "included").map((l) => ({ lineId: l.lineId, draftId: l.draftId, occurrenceId: l.occurrenceId }));
  const issuedClaims: Claim[] = issuedLines.map((l) => ({ lineId: l.lineId, draftId: l.sourceDraftId, occurrenceId: l.occurrenceId, invoiceId: l.invoiceId }));

  // Schedule indexes (Sessions have no organisation link: a Session is this organisation's through its Finance Service ID).
  const sessionsByService = new Map<string, Row[]>();
  for (const s of src(BILLING_TABLES.sessions)) {
    const v = s.fields?.[FB.session.financeServiceId];
    const id = typeof v === "string" ? v.trim() : "";
    if (id) sessionsByService.set(id, [...(sessionsByService.get(id) ?? []), s]);
  }
  const occurrencesBySession = new Map<string, Row[]>();
  for (const o of src(BILLING_TABLES.occurrences)) {
    const link = o.fields?.[FB.occurrence.session];
    if (!Array.isArray(link)) continue;
    for (const recId of new Set(link)) if (typeof recId === "string") occurrencesBySession.set(recId, [...(occurrencesBySession.get(recId) ?? []), o]);
  }
  const find = serviceFinder(world);

  for (const draft of open) {
    const lines = linesOf.get(draft.draftId) ?? [];
    // F5 loadClientWork(clientId, periodFrom, periodTo, at, today, the draft's line occurrences, correction scope).
    const client = world.clients.find((c) => c.value.clientId === draft.clientId) ?? null;
    const serviceIds = client ? world.services.filter((s) => s.value.clientId === draft.clientId).map((s) => s.value.serviceId) : [];
    const sessions = [...new Set(serviceIds)].flatMap((id) => sessionsByService.get(id) ?? []);
    const refs = sessions.filter((s) => SESSION_REF_RE.test(typeof s.fields[FB.session.id] === "string" ? s.fields[FB.session.id] : ""));
    const recs = new Set(refs.map((s) => s.id));
    const seen = new Set<string>();
    const occRows: Row[] = [];
    for (const recId of recs) {
      for (const r of occurrencesBySession.get(recId) ?? []) {
        const date = r.fields[FB.occurrence.date];
        if (typeof date === "string" && date >= draft.periodFrom && date <= draft.periodTo && !seen.has(r.id)) {
          seen.add(r.id);
          occRows.push(r);
        }
      }
    }
    const occIds = occRows.map((o) => String(o.fields[FB.occurrence.id] ?? "")).filter((id) => OCCURRENCE_ID_PATTERN.test(id));
    const occIdSet = new Set(occIds);
    const claimIds = new Set([...occIds, ...lines.map((l) => l.occurrenceId)]);
    const byRecord = new Map(sessions.map((s) => [s.id, s]));
    const rs: Resolution[] = occRows.map((occ) => {
      const link = Array.isArray(occ.fields[FB.occurrence.session]) ? occ.fields[FB.occurrence.session] : [];
      const session = link.length === 1 ? byRecord.get(link[0]) ?? null : null;
      return resolveOccurrenceBilling({ occurrence: occurrenceFacts(occ, session), findService: find, overrides: overrides.filter((o) => occIdSet.has(o.occurrenceId)), now: at, today });
    });
    const allClaims = [...includedClaims, ...issuedClaims].filter((c) => claimIds.has(c.occurrenceId));
    const scoped = applyCorrectionScope(rs, allClaims, draft.correctionScope);
    const current = new Map(scoped.rs.map((r) => [r.occurrence.occurrenceId, r]));
    const work = classifyWork(scoped.rs, scoped.claims);
    const review = reviewDraft({ draft, lines, client: client?.value ?? null, current, work, claims: scoped.claims });
    if (review.blockers.length) result.blocked.push({ draft, blockers: review.blockers.map((b) => b.code), warnings: review.warnings.length });
  }
  passCache.set(ctx.sources, result);
  return result;
}

// ---------------------------------------------------------------------
// invoice_draft_blocked (ATT-048)
// ---------------------------------------------------------------------

export function draftBlockedCase(f: DraftFinding): CandidateCase {
  const d = f.draft;
  const n = f.blockers.length;
  const labels = [...new Set(f.blockers.map(blockerLabel))];
  return {
    subjects: [{ type: "draft", id: d.draftId }],
    title: `Invoice draft for ${d.clientName} has ${n} issue${n === 1 ? "" : "s"} to resolve`,
    detail: `${d.periodFrom} to ${d.periodTo}: ${labels.join("; ")}`,
    anchorTime: d.createdAt,
    destination: { route: "finance/invoice-draft", params: { draftId: d.draftId } },
    targetIds: { draftId: d.draftId, clientId: d.clientId },
    context: {
      draftId: d.draftId,
      clientId: d.clientId,
      clientName: d.clientName,
      periodFrom: d.periodFrom,
      periodTo: d.periodTo,
      blockerCount: n,
      blockerSummary: labels.join("; "),
      blockerCodes: f.blockers.join(","),
      warningCount: f.warnings,
      includedLines: d.includedLines,
      gross: formatMinor(d.grossMinor),
      replacement: d.replacesInvoiceId !== null,
      revision: d.revision,
      sourceApi: `GET /finance/invoice-drafts/${d.draftId}`,
    },
  };
}

export const INVOICE_DRAFT_BLOCKED_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "invoice_draft_blocked",
  ruleId: "ATT-048",
  sources: DRAFT_BLOCKED_SOURCES,
  evaluate(ctx) {
    return runDraftReviewPass(ctx).blocked.map(draftBlockedCase);
  },
};
