/**
 * Test-suite copy of the canonical needs-attention/compliance.ts, kept in sync
 * by hand exactly like every other deployed copy. Only import paths adjusted:
 * ./needs-attention|repository|registry|staffing|cover|compliance|coach-schedule|exceptions|lock-client.ts become needs-attention-*.ts.
 */
/**
 * Compliance evaluators for Needs Attention Slice 6 (see TEST-ENV.md "Needs
 * Attention Foundation - Slice 6"): coach_compliance_expiry (ATT-011),
 * compliance_verification_pending (ATT-042, Management-facing name
 * "Compliance needs Management review") and non_compliant_coach_assigned
 * (ATT-031).
 *
 * Source of truth is the Coaches Slice 8 compliance domain. The block
 * between the two COPIED markers is extracted VERBATIM from
 * coach-compliance/coach-compliance.ts (requirements, verification, the
 * status precedence and summarizeCompliance); tests assert every chunk
 * still appears byte-for-byte there and in coach-cover's copy, so there is
 * exactly one interpretation of "what is this coach's compliance status".
 * Nothing below the block re-derives a status - it only maps the resolved
 * status of each REQUIRED item to a rule:
 *
 *   Current                      -> nothing
 *   Review Soon                  -> coach_compliance_expiry, state severity Warning
 *   Expired                      -> coach_compliance_expiry, state severity Urgent
 *   Needs Review (every reason)  -> compliance_verification_pending, reason in the payload
 *   Missing                      -> nothing at coach level (locked Slice 6 decision)
 *   Missing / Expired / Needs Review on a coach who is ASSIGNED to an
 *     eligible occurrence in the 14-day window -> non_compliant_coach_assigned
 *     (the same blocking set coach-cover's suitability check uses), one case
 *     per occurrence x coach listing every failing requirement.
 *
 * Coach-level rules resolve compliance as of today (Europe/London, exactly
 * like the coach-compliance endpoint). The assignment rule resolves it as
 * of the OCCURRENCE date, exactly like coach-cover's suitability check, so a
 * document that will have expired by the session is already blocking.
 * Only Active Coaches are evaluated. There is no non-expiring requirement
 * and no Rejected state in the domain: neither is invented here.
 *
 * One shared compliance pass per request (memoised), one shared staffing
 * pass (staffing.ts) for assignments; no per-coach, per-document or
 * per-occurrence queries. No attachment data ever enters a case.
 */
import type { AirtableRecord, CandidateCase, ConfigIssue, EvaluatorContext, EvaluatorRegistration, Severity } from "./needs-attention-engine.ts";
import { STAFFING_SOURCES, formatLocal, localDateIso, sharedStaffingPass, type StaffMember, type StaffingAnalysis, type StaffingPass } from "./needs-attention-staffing.ts";

// ===== COPIED FROM coach-compliance/coach-compliance.ts - DO NOT EDIT HERE =====
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DOCUMENT_TYPES = ["Enhanced DBS", "Safeguarding Certificate", "First Aid", "School Induction", "Other"] as const;
export const COMPLIANCE_STATUSES = ["Current", "Review Soon", "Needs Review", "Expired", "Missing"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export interface ComplianceProblem {
  recordId: string;
  table: "Coach Documents" | "Coach Document Requirements";
  issue: string;
}

export interface DocumentView {
  id: string;
  issueDate: string | null;
  expiryDate: string | null;
  /** Whole days from today (Europe/London) to the expiry date; negative once expired. */
  daysUntilExpiry: number | null;
  verified: boolean;
  verifiedBy: { userId: string; name: string | null } | null;
  verifiedAt: string | null;
  /** Presence only - never a URL, filename or any other attachment metadata. */
  hasAttachment: boolean;
}

export interface ComplianceItem {
  documentType: string;
  required: boolean;
  reviewLeadDays: number | null;
  status: ComplianceStatus;
  reason: string;
  /** Ready-made signal for the later Needs Attention foundation. Only required items can raise it. */
  needsAttention: boolean;
  record: DocumentView | null;
  conflictingRecordIds: string[];
  historicalRecordCount: number;
}

export interface ComplianceSummary {
  coachId: string;
  asOfDate: string;
  items: ComplianceItem[];
  otherDocuments: ComplianceItem[];
  problems: ComplianceProblem[];
  schoolScopedRequirementsNotEvaluated: number;
  needsAttention: boolean;
  counts: Record<ComplianceStatus, number>;
}

function selectName(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return v.name || "";
}

function linkIds(v: any): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : x?.id)).filter((x): x is string => typeof x === "string");
}

function isBlank(v: any): boolean {
  return v == null || String(v).trim() === "";
}

/** Strict "YYYY-MM-DD" that is also a real calendar date. */
export function isValidIsoDate(s: any): s is string {
  const m = DATE_RE.exec(String(s ?? ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function isoToUtcMs(iso: string): number {
  const m = DATE_RE.exec(iso)!;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

/** Whole calendar days from `fromIso` to `toIso` (both plain dates) - host-timezone independent. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((isoToUtcMs(toIso) - isoToUtcMs(fromIso)) / DAY_MS);
}

/** Today's Europe/London calendar date as "YYYY-MM-DD" for a given instant. */
export function ukToday(now: Date): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ---------------------------------------------------------------------
// Verification. There is no dedicated boolean in the schema; "verified /
// seen" is derived from the server-written audit fields. Both Verified At
// (a real timestamp) and Verified By User ID must be present - exactly one
// of them is an incomplete record, never treated as verified.
// ---------------------------------------------------------------------

export type VerificationState =
  | { state: "verified"; userId: string; name: string | null; at: string }
  | { state: "unverified" }
  | { state: "incomplete"; issue: string };

export function readVerification(fields: Record<string, any>): VerificationState {
  const userId = fields["Verified By User ID"];
  const at = fields["Verified At"];
  const hasUser = !isBlank(userId);
  const hasAt = !isBlank(at);
  if (!hasUser && !hasAt) return { state: "unverified" };
  if (hasUser && hasAt && !isNaN(new Date(String(at)).getTime())) {
    const name = fields["Verified By Name Snapshot"];
    return { state: "verified", userId: String(userId).trim(), name: isBlank(name) ? null : String(name), at: String(at) };
  }
  return { state: "incomplete", issue: "Verified By User ID and Verified At must both be present (and Verified At a valid timestamp)" };
}

// ---------------------------------------------------------------------
// Requirements (organisation-level only - see TEST-ENV.md).
// ---------------------------------------------------------------------

interface ResolvedRequirement {
  reviewLeadDays: number | null;
  /** Set when the requirement rows for this type are themselves unusable. */
  configIssue: string | null;
  requirementIds: string[];
}

export function resolveRequirements(requirementRecords: AirtableRecord[]): {
  byType: Map<string, ResolvedRequirement>;
  problems: ComplianceProblem[];
  schoolScoped: number;
} {
  const byType = new Map<string, ResolvedRequirement>();
  const leadDaysSeen = new Map<string, Set<string>>();
  const problems: ComplianceProblem[] = [];
  let schoolScoped = 0;

  for (const r of requirementRecords) {
    if (r.fields["Active"] !== true || r.fields["Required"] !== true) continue;
    // Production scopes rows to a Client / School. Only rows with NO such
    // scope are organisation-level; school-scoped rows are out of this
    // slice and never silently widened into an org-wide requirement.
    if (linkIds(r.fields["Client / School"]).length > 0) {
      schoolScoped++;
      continue;
    }
    const type = selectName(r.fields["Document Type"]);
    if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) {
      problems.push({ recordId: r.id, table: "Coach Document Requirements", issue: "Required requirement has a blank or unrecognised Document Type" });
      continue;
    }
    const raw = r.fields["Review Lead Days"];
    let lead: number | null = null;
    let issue: string | null = null;
    if (raw != null && raw !== "") {
      if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) lead = raw;
      else issue = `Review Lead Days "${raw}" is not a whole number >= 0`;
    }
    const existing = byType.get(type) ?? { reviewLeadDays: lead, configIssue: null, requirementIds: [] };
    existing.requirementIds.push(r.id);
    if (issue) {
      existing.configIssue = issue;
      problems.push({ recordId: r.id, table: "Coach Document Requirements", issue });
    }
    const seen = leadDaysSeen.get(type) ?? new Set<string>();
    seen.add(issue ? "invalid" : String(lead));
    leadDaysSeen.set(type, seen);
    if (seen.size > 1 && !existing.configIssue) {
      existing.configIssue = "Multiple active requirement rows for this Document Type disagree on Review Lead Days";
      for (const id of existing.requirementIds) problems.push({ recordId: id, table: "Coach Document Requirements", issue: existing.configIssue });
    }
    existing.reviewLeadDays = existing.configIssue ? null : lead;
    byType.set(type, existing);
  }
  return { byType, problems, schoolScoped };
}

// ---------------------------------------------------------------------
// Status resolution for one document type.
// ---------------------------------------------------------------------

function toView(doc: AirtableRecord, todayIso: string): DocumentView {
  const v = readVerification(doc.fields);
  const expiry = isValidIsoDate(doc.fields["Expiry / Review Date"]) ? doc.fields["Expiry / Review Date"] : null;
  const issue = isValidIsoDate(doc.fields["Issue Date"]) ? doc.fields["Issue Date"] : null;
  const att = doc.fields["Attachment"];
  return {
    id: doc.id,
    issueDate: issue,
    expiryDate: expiry,
    daysUntilExpiry: expiry ? daysBetween(todayIso, expiry) : null,
    verified: v.state === "verified",
    verifiedBy: v.state === "verified" ? { userId: v.userId, name: v.name } : null,
    verifiedAt: v.state === "verified" ? v.at : null,
    hasAttachment: Array.isArray(att) && att.length > 0,
  };
}

/**
 * Precedence (first match wins):
 *  1. no active record                        -> Missing
 *  2. more than one active record             -> Needs Review (never a guess)
 *  3. requirement config unusable             -> Needs Review
 *  4. expiry date passed                      -> Expired (valid THROUGH the expiry date)
 *  5. malformed dates / incomplete verification -> Needs Review
 *  6. not verified                            -> Needs Review
 *  7. stored Status manually "Needs Review"   -> Needs Review
 *  8. no Expiry / Review Date                 -> Needs Review (never invented)
 *  9. within Review Lead Days of expiry       -> Review Soon
 * 10. otherwise                               -> Current
 */
export function resolveDocumentType(
  documentType: string,
  activeDocs: AirtableRecord[],
  historicalCount: number,
  requirement: ResolvedRequirement | null,
  todayIso: string
): ComplianceItem {
  const required = requirement != null;
  const base = {
    documentType,
    required,
    reviewLeadDays: requirement?.reviewLeadDays ?? null,
    historicalRecordCount: historicalCount,
  };
  const make = (status: ComplianceStatus, reason: string, record: DocumentView | null, conflictingRecordIds: string[] = []): ComplianceItem => ({
    ...base,
    status,
    reason,
    record,
    conflictingRecordIds,
    needsAttention: required && status !== "Current",
  });

  if (activeDocs.length === 0) return make("Missing", "no_active_record", null);
  if (activeDocs.length > 1) return make("Needs Review", "conflicting_active_records", null, activeDocs.map((d) => d.id));

  const doc = activeDocs[0];
  const view = toView(doc, todayIso);
  if (requirement?.configIssue) return make("Needs Review", "invalid_requirement_config", view);

  const rawExpiry = doc.fields["Expiry / Review Date"];
  const rawIssue = doc.fields["Issue Date"];
  if (view.expiryDate && view.daysUntilExpiry! < 0) return make("Expired", "expiry_date_passed", view);

  if ((!isBlank(rawExpiry) && !view.expiryDate) || (!isBlank(rawIssue) && !view.issueDate)) return make("Needs Review", "malformed_dates", view);
  if (view.issueDate && view.expiryDate && view.issueDate > view.expiryDate) return make("Needs Review", "issue_date_after_expiry", view);

  const verification = readVerification(doc.fields);
  if (verification.state === "incomplete") return make("Needs Review", "incomplete_verification", view);
  if (verification.state === "unverified") return make("Needs Review", "not_verified", view);
  if (selectName(doc.fields["Status"]) === "Needs Review") return make("Needs Review", "manual_review_flag", view);
  if (!view.expiryDate) return make("Needs Review", "missing_expiry_date", view);

  const lead = requirement?.reviewLeadDays ?? null;
  if (lead != null && view.daysUntilExpiry! <= lead) return make("Review Soon", "within_review_lead_days", view);
  return make("Current", "verified_and_in_date", view);
}

/**
 * The whole compliance summary for one coach. Only rows linked to THIS
 * coach are ever read into the result. Active rows are the operational
 * records; inactive rows are history (counted, never current, never
 * deleted).
 */
export function summarizeCompliance(coachId: string, documentRecords: AirtableRecord[], requirementRecords: AirtableRecord[], todayIso: string): ComplianceSummary {
  const { byType, problems, schoolScoped } = resolveRequirements(requirementRecords);

  const mine = documentRecords.filter((d) => linkIds(d.fields["Coach"]).includes(coachId));
  const activeByType = new Map<string, AirtableRecord[]>();
  const historicalByType = new Map<string, number>();
  for (const d of mine) {
    const type = selectName(d.fields["Document Type"]);
    const active = d.fields["Active"] === true;
    if (!(DOCUMENT_TYPES as readonly string[]).includes(type)) {
      if (active) problems.push({ recordId: d.id, table: "Coach Documents", issue: "Active Coach Document has a blank or unrecognised Document Type" });
      continue;
    }
    if (active) activeByType.set(type, [...(activeByType.get(type) ?? []), d]);
    else historicalByType.set(type, (historicalByType.get(type) ?? 0) + 1);
  }

  const items: ComplianceItem[] = [];
  const otherDocuments: ComplianceItem[] = [];
  for (const type of DOCUMENT_TYPES) {
    const req = byType.get(type) ?? null;
    const active = activeByType.get(type) ?? [];
    const hist = historicalByType.get(type) ?? 0;
    if (req) items.push(resolveDocumentType(type, active, hist, req, todayIso));
    else if (active.length) otherDocuments.push(resolveDocumentType(type, active, hist, null, todayIso));
  }

  const counts = Object.fromEntries(COMPLIANCE_STATUSES.map((s) => [s, 0])) as Record<ComplianceStatus, number>;
  for (const i of items) counts[i.status]++;

  return {
    coachId,
    asOfDate: todayIso,
    items,
    otherDocuments,
    problems,
    schoolScopedRequirementsNotEvaluated: schoolScoped,
    needsAttention: items.some((i) => i.needsAttention) || problems.length > 0,
    counts,
  };
}
// ===== END COPIED BLOCK =====

// ---------------------------------------------------------------------
// Needs Attention compliance analysis (Slice 6). Built ON the copied
// resolver above - it never re-derives a status.
// ---------------------------------------------------------------------

export const COMPLIANCE_TABLES = {
  documents: "Coach Documents",
  requirements: "Coach Document Requirements",
  /** Shared with the staffing / cover rules (Active flag + Coach Name). */
  coaches: "Coaches",
} as const;
/** The two coach-level rules declare the same sources, so the engine loads each table once and they share one pass. */
export const COMPLIANCE_SOURCES: readonly string[] = Object.values(COMPLIANCE_TABLES);
/** non_compliant_coach_assigned needs the staffing tables too; the engine loads the union once each. */
export const ASSIGNMENT_SOURCES: readonly string[] = [...new Set([...STAFFING_SOURCES, ...COMPLIANCE_SOURCES])];

// The exact blocking set of coach-cover's evaluateSuitability (drift-tested against cover-workflow.ts).
const BLOCKING_COMPLIANCE = new Set(["Missing", "Expired", "Needs Review"]);
export function isBlockingStatus(status: string): boolean {
  return BLOCKING_COMPLIANCE.has(status);
}

/** Fixed, state-based severity for coach_compliance_expiry - no second timing system on top of Review Lead Days. */
export const EXPIRY_STATE_SEVERITY: Readonly<Record<string, Severity>> = { "Review Soon": "Warning", Expired: "Urgent" };

export const COMPLIANCE_RULE_KEYS = ["coach_compliance_expiry", "compliance_verification_pending", "non_compliant_coach_assigned"] as const;
export type CoachLevelRuleKey = "coach_compliance_expiry" | "compliance_verification_pending";

/** The one coach-level rule a resolved item raises (an item has exactly one status, so never two). */
export function coachLevelRule(item: ComplianceItem): CoachLevelRuleKey | null {
  if (!item.required) return null;
  if (item.status === "Review Soon" || item.status === "Expired") return "coach_compliance_expiry";
  if (item.status === "Needs Review") return "compliance_verification_pending";
  return null; // Current: nothing to do. Missing: only via non_compliant_coach_assigned, when assigned.
}

/** Management-facing wording for every reason the resolver can return (unknown codes fall back to the code itself). */
export function reasonText(item: Pick<ComplianceItem, "reason" | "record" | "conflictingRecordIds">): string {
  const r = item.record;
  const days = r?.daysUntilExpiry;
  switch (item.reason) {
    case "no_active_record":
      return "no active document on file";
    case "conflicting_active_records":
      return `${item.conflictingRecordIds.length} active records exist for this document type - only one may be active`;
    case "invalid_requirement_config":
      return "the requirement for this document type is misconfigured (see configIssues)";
    case "expiry_date_passed":
      return `expired on ${r?.expiryDate}${days != null ? ` (${-days} day${days === -1 ? "" : "s"} ago)` : ""}`;
    case "malformed_dates":
      return "Issue Date or Expiry / Review Date is not a valid date";
    case "issue_date_after_expiry":
      return `Issue Date ${r?.issueDate} is after the Expiry / Review Date ${r?.expiryDate}`;
    case "incomplete_verification":
      return "verification is incomplete (Verified By and Verified At must both be recorded)";
    case "not_verified":
      return "submitted and awaiting Management verification";
    case "manual_review_flag":
      return "flagged for Management review";
    case "missing_expiry_date":
      return "no Expiry / Review Date recorded";
    case "within_review_lead_days":
      return `expires on ${r?.expiryDate}${days != null ? ` (${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`})` : ""}`;
    case "verified_and_in_date":
      return "verified and in date";
    default:
      return item.reason;
  }
}

/** verified | not_verified | incomplete, or null when there is no single record (missing / conflicting). */
export function verificationState(item: Pick<ComplianceItem, "reason" | "record">): string | null {
  if (item.reason === "incomplete_verification") return "incomplete";
  if (!item.record) return null;
  return item.record.verified ? "verified" : "not_verified";
}

export interface CoachItem {
  coachId: string;
  coachName: string | null;
  /** The case-key segment: the lowest active REQUIRED requirement record id for this Document Type (deterministic). */
  requirementId: string;
  requirementIds: string[];
  item: ComplianceItem;
}

export interface CompliancePass {
  /** Europe/London calendar date the coach-level items were resolved against. */
  asOfDate: string;
  activeCoachIds: string[];
  /** Every REQUIRED item of every Active coach, as of asOfDate. */
  items: CoachItem[];
  requirementIdsByType: Map<string, string[]>;
  coachNames: Map<string, string | null>;
  skipped: Record<string, number>;
  issues: ConfigIssue[];
  /** A coach's summary as of any date, memoised per (coach, date) - pure, in memory. */
  summaryFor(coachId: string, dateIso: string): ComplianceSummary;
}

/** Diagnostics: tests assert one compliance pass per request. */
export const compliancePassStats = { passes: 0, summaries: 0 };

function nameOf(rec: AirtableRecord | undefined): string | null {
  const n = rec?.fields["Coach Name"];
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

export function runCompliancePass(sources: Readonly<Record<string, readonly AirtableRecord[]>>, now: Date): CompliancePass {
  compliancePassStats.passes++;
  const T = COMPLIANCE_TABLES;
  const requirementRecords = [...(sources[T.requirements] ?? [])];
  const reqs = resolveRequirements(requirementRecords);
  const requirementIdsByType = new Map<string, string[]>();
  for (const [type, r] of reqs.byType) requirementIdsByType.set(type, [...r.requirementIds].sort());

  const docsByCoach = new Map<string, AirtableRecord[]>();
  for (const d of sources[T.documents] ?? []) {
    for (const c of new Set(linkIds(d.fields["Coach"]))) docsByCoach.set(c, [...(docsByCoach.get(c) ?? []), d]);
  }
  const memo = new Map<string, ComplianceSummary>();
  const summaryFor = (coachId: string, dateIso: string): ComplianceSummary => {
    const key = `${coachId}|${dateIso}`;
    let s = memo.get(key);
    if (!s) {
      compliancePassStats.summaries++;
      s = summarizeCompliance(coachId, docsByCoach.get(coachId) ?? [], requirementRecords, dateIso);
      memo.set(key, s);
    }
    return s;
  };

  const issues: ConfigIssue[] = [];
  for (const p of reqs.problems) {
    issues.push({ code: "compliance_requirement_invalid", recordId: p.recordId, detail: `Coach Document Requirements ${p.recordId}: ${p.issue}.` });
  }
  if (reqs.schoolScoped > 0) {
    issues.push({
      code: "compliance_school_requirements_not_evaluated",
      detail: `${reqs.schoolScoped} active required Coach Document Requirements row(s) are scoped to a Client / School. School-level requirements are not evaluated (same as the coach-compliance endpoint), so they raise no case.`,
    });
  }

  const asOfDate = ukToday(now);
  const coachNames = new Map<string, string | null>();
  const activeCoachIds: string[] = [];
  const skipped: Record<string, number> = {};
  const items: CoachItem[] = [];
  const coaches = [...(sources[T.coaches] ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of coaches) {
    coachNames.set(c.id, nameOf(c));
    if (c.fields["Active"] !== true) {
      skipped.inactive_coach = (skipped.inactive_coach ?? 0) + 1;
      continue;
    }
    activeCoachIds.push(c.id);
    const summary = summaryFor(c.id, asOfDate);
    for (const p of summary.problems) {
      if (p.table !== "Coach Documents") continue; // requirement problems are reported once, above
      issues.push({ code: "compliance_document_invalid", recordId: p.recordId, detail: `Coach Documents ${p.recordId} (coach ${c.id}): ${p.issue}. It is ignored for compliance.` });
    }
    for (const item of summary.items) {
      if (!(COMPLIANCE_STATUSES as readonly string[]).includes(item.status)) {
        // Fail visible, never forced into a rule: a status this slice does not know.
        issues.push({ code: "compliance_status_unmapped", recordId: c.id, detail: `Coach ${c.id} ${item.documentType}: unrecognised compliance status ${JSON.stringify(item.status)} - no case raised.` });
        continue;
      }
      const ids = requirementIdsByType.get(item.documentType) ?? [];
      if (!ids.length) continue; // cannot happen for a required item; never key a case on nothing
      items.push({ coachId: c.id, coachName: nameOf(c), requirementId: ids[0], requirementIds: ids, item });
    }
  }
  return { asOfDate, activeCoachIds, items, requirementIdsByType, coachNames, skipped, issues, summaryFor };
}

// One shared compliance pass per request, memoised on the loaded Coach
// Documents array identity (+ now + source sizes). Nothing outlives the
// request's own arrays (WeakMap) - this is not a cache.
const passCache = new WeakMap<object, { key: string; pass: CompliancePass }>();

export function sharedCompliancePass(ctx: EvaluatorContext): CompliancePass {
  const docs = ctx.sources[COMPLIANCE_TABLES.documents] ?? [];
  const key = `${ctx.now.getTime()}|${COMPLIANCE_SOURCES.map((t) => (ctx.sources[t] ?? []).length).join(",")}`;
  const hit = passCache.get(docs);
  if (hit && hit.key === key) return hit.pass;
  const pass = runCompliancePass(ctx.sources, ctx.now);
  passCache.set(docs, { key, pass });
  return pass;
}

// ---------------------------------------------------------------------
// Coach-level cases (ATT-011 / ATT-042): one per active coach x requirement
// ---------------------------------------------------------------------

const COMPLIANCE_ROUTE = "coaches/compliance"; // placeholder UI route (no Management compliance screen yet) - see TEST-ENV.md

export function complianceCase(rule: CoachLevelRuleKey, ci: CoachItem, asOfDate: string): CandidateCase {
  const it = ci.item;
  const who = ci.coachName ?? "Coach";
  const doc = it.record;
  const why = reasonText(it);
  const title =
    rule === "coach_compliance_expiry"
      ? `${it.documentType} ${it.status === "Expired" ? "expired" : "due for renewal"} - ${who}`
      : `${it.documentType} needs Management review - ${who}`;
  const params: Record<string, string> = { coachId: ci.coachId, requirementId: ci.requirementId, documentType: it.documentType };
  if (doc) params.documentId = doc.id;
  const targetIds: Record<string, string> = { coachId: ci.coachId, requirementId: ci.requirementId };
  if (doc) targetIds.documentId = doc.id;
  return {
    subjects: [
      { type: "coach", id: ci.coachId },
      { type: "requirement", id: ci.requirementId },
    ],
    title,
    detail: `${who}: ${it.documentType} - ${why}.`,
    stateSeverity: rule === "coach_compliance_expiry" ? EXPIRY_STATE_SEVERITY[it.status] ?? null : null,
    anchorTime: rule === "coach_compliance_expiry" ? doc?.expiryDate ?? null : null,
    destination: { route: COMPLIANCE_ROUTE, params },
    targetIds,
    relatedIds: {
      requirementIds: ci.requirementIds,
      ...(it.conflictingRecordIds.length ? { conflictingDocumentIds: it.conflictingRecordIds } : {}),
    },
    context: {
      coachId: ci.coachId,
      coachName: ci.coachName,
      documentType: it.documentType,
      requirementId: ci.requirementId,
      complianceStatus: it.status,
      reviewReason: it.reason,
      reviewReasonText: why,
      documentId: doc?.id ?? null,
      issueDate: doc?.issueDate ?? null,
      expiryDate: doc?.expiryDate ?? null,
      daysUntilExpiry: doc?.daysUntilExpiry ?? null,
      reviewLeadDays: it.reviewLeadDays,
      verificationState: verificationState(it),
      verifiedAt: doc?.verifiedAt ?? null,
      conflictingRecords: it.conflictingRecordIds.length,
      historicalRecords: it.historicalRecordCount,
      complianceAsOf: asOfDate,
    },
  };
}

function coachLevelEvaluator(rule: CoachLevelRuleKey, ruleId: string): EvaluatorRegistration {
  return {
    ruleKey: rule,
    ruleId,
    sources: COMPLIANCE_SOURCES,
    evaluate(ctx: EvaluatorContext): CandidateCase[] {
      const pass = sharedCompliancePass(ctx);
      for (const issue of pass.issues) ctx.reportIssue?.(issue);
      return pass.items.filter((ci) => coachLevelRule(ci.item) === rule).map((ci) => complianceCase(rule, ci, pass.asOfDate));
    },
  };
}

// ---------------------------------------------------------------------
// Assignment cases (ATT-031): one per eligible occurrence x assigned coach
// ---------------------------------------------------------------------

export interface AssignmentFinding {
  analysis: StaffingAnalysis;
  member: StaffMember;
  coachName: string | null;
  /** The occurrence's own date - compliance is resolved as of the session, like coach-cover. */
  asOfDate: string;
  failing: { item: ComplianceItem; requirementId: string }[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Who is assigned comes ONLY from the shared staffing pass (Session Staff
 * effective dates + Occurrence Staff merge + Cover replacement, eligible
 * occurrences inside the 14-day window). Only coaches with an Active Coach
 * record count: inactive coaches and missing Coach records are excluded
 * (the latter is already a staffing configIssue). An active coach whose
 * role is unrecognised is still physically assigned, so is still checked.
 */
export function assignmentFindings(staffing: StaffingPass, pass: CompliancePass, timeZone: string): AssignmentFinding[] {
  const out: AssignmentFinding[] = [];
  for (const a of staffing.analyses) {
    const asOfDate = a.dateIso && ISO_DATE_RE.test(a.dateIso) ? a.dateIso : a.startIso ? localDateIso(new Date(a.startIso), timeZone) : null;
    if (!asOfDate) continue;
    for (const m of a.staff) {
      if (m.status !== "valid" && m.status !== "unknown_role") continue;
      const summary = pass.summaryFor(m.coachId, asOfDate);
      const failing = summary.items
        .filter((i) => isBlockingStatus(i.status))
        .map((i) => ({ item: i, requirementId: (pass.requirementIdsByType.get(i.documentType) ?? [])[0] ?? "" }))
        .filter((f) => f.requirementId);
      if (failing.length) out.push({ analysis: a, member: m, coachName: pass.coachNames.get(m.coachId) ?? null, asOfDate, failing });
    }
  }
  return out;
}

export function assignmentCase(f: AssignmentFinding, timeZone: string): CandidateCase {
  const a = f.analysis;
  const when = formatLocal(a.startIso, a.dateIso, timeZone);
  const who = f.coachName ?? "A coach";
  const list = f.failing.map((x) => `${x.item.documentType}: ${x.item.status}`).join("; ");
  const n = (s: string) => f.failing.filter((x) => x.item.status === s).length;
  const docIds = [...new Set(f.failing.flatMap((x) => (x.item.record ? [x.item.record.id] : x.item.conflictingRecordIds)))];
  return {
    subjects: [
      { type: "occurrence", id: a.occurrenceId },
      { type: "coach", id: f.member.coachId },
    ],
    title: `Non-compliant coach assigned - ${who} - ${a.sessionName ?? "Session"}`,
    detail: `${when} - ${who} is assigned${f.member.roleName ? ` as ${f.member.roleName}` : ""} but ${f.failing.length} required compliance item${f.failing.length === 1 ? "" : "s"} block${f.failing.length === 1 ? "s" : ""} the assignment (as of the session date): ${list}.`,
    anchors: { event: a.startIso },
    anchorTime: a.startIso ?? a.dateIso,
    destination: { route: COMPLIANCE_ROUTE, params: { coachId: f.member.coachId, occurrenceId: a.occurrenceId, sessionId: a.sessionId } },
    targetIds: { occurrenceId: a.occurrenceId, sessionId: a.sessionId, coachId: f.member.coachId },
    relatedIds: {
      failingRequirementIds: f.failing.map((x) => x.requirementId),
      ...(docIds.length ? { failingDocumentIds: docIds } : {}),
    },
    context: {
      coachId: f.member.coachId,
      coachName: f.coachName,
      coachRole: f.member.roleName,
      assignedVia: f.member.fromOccurrenceStaff ? "Occurrence Staff" : "Session Staff",
      sessionId: a.sessionId,
      sessionName: a.sessionName,
      occurrenceId: a.occurrenceId,
      occurrenceName: a.occurrenceName,
      date: a.dateIso,
      start: a.startIso,
      end: a.endIso,
      startLocal: when,
      complianceAsOf: f.asOfDate,
      failingRequirements: f.failing.length,
      missing: n("Missing"),
      expired: n("Expired"),
      needsReview: n("Needs Review"),
      failingSummary: f.failing.map((x) => `${x.item.documentType}: ${x.item.status} (${reasonText(x.item)})`).join("; "),
    },
  };
}

export const ASSIGNMENT_EVALUATOR: EvaluatorRegistration = {
  ruleKey: "non_compliant_coach_assigned",
  ruleId: "ATT-031",
  sources: ASSIGNMENT_SOURCES,
  evaluate(ctx: EvaluatorContext): CandidateCase[] {
    const staffing = sharedStaffingPass(ctx);
    for (const issue of staffing.issues) ctx.reportIssue?.(issue);
    const pass = sharedCompliancePass(ctx);
    for (const issue of pass.issues) ctx.reportIssue?.(issue);
    return assignmentFindings(staffing, pass, ctx.organisation.timezone).map((f) => assignmentCase(f, ctx.organisation.timezone));
  },
};

/** The three Slice 6 registrations - Rule IDs must match the TEST catalogue (drift-tested). */
export const COMPLIANCE_EVALUATORS: readonly EvaluatorRegistration[] = [
  coachLevelEvaluator("coach_compliance_expiry", "ATT-011"),
  coachLevelEvaluator("compliance_verification_pending", "ATT-042"),
  ASSIGNMENT_EVALUATOR,
];
